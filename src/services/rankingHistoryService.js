import mongoose from 'mongoose';
import SeoRankingCurrent from '../modules/app_user/model/SeoRankingCurrent.js';
import KeywordRankingHistory from '../modules/app_user/model/KeywordRankingHistory.js';
import { LoggerUtil } from '../utils/LoggerUtil.js';
import { getKeywordLimit } from '../config/plans.js';

// ─── Invariant helpers ───────────────────────────────────────────────────────

/**
 * Enforce: current_rank === Math.min(...ranking_urls[].rank)
 * Never accept current_rank as a caller-supplied value.
 */
function computeCurrentRank(rankingUrls) {
  if (!Array.isArray(rankingUrls) || rankingUrls.length === 0) return null;
  return Math.min(...rankingUrls.map(u => u.rank));
}

function normalizeKeyword(kw) {
  return (kw || '').toLowerCase().trim();
}

/**
 * Maps a raw upstream error (DataForSEO's own message, a network error,
 * etc.) to a short, generic, customer-safe message. The RAW message is
 * still logged via LoggerUtil.warn wherever this is called from — full
 * detail for support/debugging never disappears — but last_scan_error is
 * a database field returned verbatim by getProjectRankings/rescanKeyword/
 * addKeywordController's JSON responses, so whatever lands here must never
 * name the vendor, an account status, a support email, or any other
 * internal infrastructure detail a customer shouldn't see over the wire.
 */
function sanitizeScanErrorForStorage(rawError) {
  const msg = String(rawError || '');
  // \bNNN\b (word-boundary), never a bare substring match — "402" must not
  // accidentally match inside an unrelated code like "40201" (DataForSEO's
  // account-pause code), which has no digit boundary around "402" at all.
  if (/rate limit|too many requests|\b429\b/i.test(msg)) {
    return 'Ranking check temporarily rate-limited. Please try again shortly.';
  }
  if (/unusual activity|account.*paused|paused.*account|\b40201\b/i.test(msg)) {
    return 'Ranking check temporarily unavailable — the search data provider has paused API access. Please try again later.';
  }
  if (/timed?\s*out|timeout|ETIMEDOUT|ECONNABORTED/i.test(msg)) {
    return 'Ranking check timed out. Please try again.';
  }
  if (/authentication failed|insufficient credits|\b401\b|\b402\b/i.test(msg)) {
    return 'Ranking check is temporarily unavailable. Please try again later.';
  }
  return 'Ranking check temporarily unavailable — the search data provider could not be reached. Please try again shortly.';
}

/**
 * Explicit, additive per-keyword status derived from fields already on
 * the document (last_scan_status + current_rank) — Section E of the
 * UX/state-handling audit. Existing response fields are unchanged; this is
 * a convenience on top of them, not a replacement, so no consumer relying
 * on the current shape breaks.
 *
 * 'scan_error'  — the last scan's organic request/parse itself failed;
 *                 current_rank (if present) is a stale-but-still-valid
 *                 prior result, not a fresh "not ranked".
 * 'ranked'      — a real scan succeeded and found the target domain.
 * 'not_ranked'  — a real scan succeeded and did NOT find it.
 */
export function deriveKeywordStatus(kw) {
  if (!kw) return null;
  if (kw.last_scan_status === 'error') return 'scan_error';
  return kw.current_rank != null ? 'ranked' : 'not_ranked';
}

/**
 * Per-device status for the mobile ranking (additive; desktop keeps
 * deriveKeywordStatus). Four distinct states:
 *   'not_collected' — mobile was never scanned (legacy keyword, or mobile
 *                     tracking switched off). Says nothing about the ranking.
 *   'scan_error'    — the last mobile check failed; current_rank (if any) is a
 *                     stale-but-valid earlier result.
 *   'ranked'        — a mobile scan succeeded and found the domain.
 *   'not_ranked'    — a mobile scan succeeded and did NOT find the domain
 *                     within mobile.tracked_depth.
 */
export function deriveMobileStatus(mobile) {
  if (!mobile || !mobile.last_scan_status) return 'not_collected';
  if (mobile.last_scan_status === 'error') return 'scan_error';
  return mobile.current_rank != null ? 'ranked' : 'not_ranked';
}

/**
 * Adds the explicit `status` (desktop) and `mobile.status` to an API keyword.
 * A keyword with no mobile data yields `mobile: { status: 'not_collected' }` —
 * never a fabricated position and never desktop data.
 */
export function withDeviceStatuses(kw) {
  if (!kw) return kw;
  const mobile = kw.mobile && typeof kw.mobile === 'object' ? kw.mobile : null;
  return {
    ...kw,
    status: deriveKeywordStatus(kw),
    mobile: { ...(mobile || {}), status: deriveMobileStatus(mobile) },
  };
}

const DEVICES = ['desktop', 'mobile'];

/** Mongo filter for one device. Legacy history rows have no `device` and are desktop. */
function deviceFilter(device) {
  return device === 'mobile' ? { device: 'mobile' } : { device: { $ne: 'mobile' } };
}

function cleanRankingUrls(rawUrls) {
  if (!Array.isArray(rawUrls)) {
    LoggerUtil.warn('[cleanRankingUrls] received non-array', { type: typeof rawUrls, value: String(rawUrls).slice(0, 200) });
    return [];
  }
  const cleaned = rawUrls
    .filter(u => u.rank != null && u.url)
    .map(u => ({
      rank: parseInt(u.rank, 10),
      url:  u.url.trim(),
      type: u.type === 'homepage' ? 'homepage' : 'internal_page'
    }))
    .filter(u => Number.isFinite(u.rank) && u.rank >= 1 && u.rank <= 100);
  if (rawUrls.length > 0 && cleaned.length === 0) {
    LoggerUtil.warn('[cleanRankingUrls] all URLs were filtered out', { rawUrls: JSON.stringify(rawUrls).slice(0, 400) });
  }
  return cleaned;
}

// ─── History append ──────────────────────────────────────────────────────────

const HISTORY_DEDUPE_WINDOW_MS = 60 * 1000;

/**
 * Append one scan event to keyword_ranking_history.
 * Called once per keyword per scan (fire-and-forget safe; errors are logged, not thrown).
 */
export async function appendHistory({
  projectId, userId, domain, keyword,
  currentRank, mapsRank, rankingUrls, scanSource, device = 'desktop'
}) {
  try {
    if (!DEVICES.includes(device)) throw new Error(`Unsupported history device "${device}"`);
    const keywordNormalized = normalizeKeyword(keyword);
    const source = scanSource || 'onboarding';

    // Idempotency: a repeated job/double-submit delivering the identical result
    // as the LATEST entry for this keyword+device, within a minute, must not add
    // a duplicate row. Compared against the latest entry only — an equal rank
    // further back (5 -> 6 -> 5) is a real change and must still be recorded.
    // Best-effort: two truly simultaneous identical calls can both pass this read.
    const latest = await KeywordRankingHistory.findOne({
      project_id:         projectId,
      keyword_normalized: keywordNormalized,
      ...deviceFilter(device)
    })
      .sort({ scanned_at: -1, _id: -1 })
      .select('current_rank scan_source scanned_at')
      .lean();
    if (
      latest &&
      latest.scan_source === source &&
      (latest.current_rank ?? null) === (currentRank ?? null) &&
      Date.now() - new Date(latest.scanned_at).getTime() < HISTORY_DEDUPE_WINDOW_MS
    ) {
      return;
    }

    const entry = new KeywordRankingHistory({
      project_id:         projectId,
      user_id:            userId,
      domain:             domain.toLowerCase(),
      keyword,
      keyword_normalized: keywordNormalized,
      device,
      scanned_at:         new Date(),
      current_rank:       currentRank ?? null,
      maps_rank:          mapsRank    ?? null,
      scan_source:        source,
      ranking_urls:       rankingUrls || []
    });
    await entry.save();
  } catch (err) {
    LoggerUtil.error('appendHistory failed', {
      keyword,
      device,
      err:    err.message,
      errors: err.errors
        ? Object.entries(err.errors).map(([f, e]) => `${f}: ${e.message}`)
        : undefined
    });
  }
}

/**
 * Append mobile history for a keyword — only when a mobile scan was actually
 * performed AND succeeded. A failed mobile check is not an observation, so it
 * never creates a history row (mobile history starts at the first success).
 */
async function appendMobileHistoryIfObserved({ projectId, userId, domain, keyword, incomingMobile, mobileDoc, scanSource }) {
  if (!incomingMobile || incomingMobile.scan_error || !mobileDoc) return;
  await appendHistory({
    projectId, userId, domain, keyword,
    currentRank: mobileDoc.current_rank,
    mapsRank:    null,
    rankingUrls: mobileDoc.ranking_urls,
    scanSource,
    device:      'mobile'
  });
}

// ─── History derivation ──────────────────────────────────────────────────────

/**
 * Find the most recent rank entry at or before targetDate for a keyword —
 * no lower bound on how far back that scan may be.
 *
 * A prior version of this function only accepted scans within a fixed
 * tolerance window (3 days for "previous week", 7 for "previous month") of
 * the target date, on the theory that a scan from months ago isn't a
 * reasonable stand-in for "previous week". That reasoning breaks down for
 * manual-tracking projects, which don't scan on a fixed cadence: two scans
 * 18 days apart (e.g. Jul 17 -> Aug 4) leaves the week-ago target (Jul 28)
 * with nothing inside a 3-day tolerance, so a real, valid prior scan (Jul 17)
 * got reported as "no data" ("—") even though it's the correct comparison
 * point. The dev seed script (seedRankingHistory.js) always places scans on
 * exact 7/14/21/30-day boundaries, which is why this never surfaced there.
 *
 * "Nearest snapshot at or before the target date" is the correct semantics
 * per product spec — the 365-day TTL index on keyword_ranking_history is
 * what actually bounds how far back a lookup can reach; a gap larger than
 * that resolves to null because the data is gone, not because of an
 * arbitrary tolerance window.
 *
 * Secondary sort by _id breaks ties deterministically when two scans share
 * an identical scanned_at timestamp.
 *
 * Uses the compound index { project_id, keyword_normalized, scanned_at }.
 */
async function findRankAtDate(projectId, keywordNormalized, targetDate, device = 'desktop') {
  const entry = await KeywordRankingHistory.findOne({
    project_id:         projectId,
    keyword_normalized: keywordNormalized,
    ...deviceFilter(device),
    scanned_at:         { $lte: targetDate }
  })
    .sort({ scanned_at: -1, _id: -1 })
    .select('current_rank')
    .lean();
  return entry?.current_rank ?? null;
}

/**
 * Derive prev_week_rank and prev_month_rank from keyword_ranking_history.
 * Queries run in parallel against the compound index — no collection scans.
 */
export async function deriveHistoricalRanks(projectId, keyword, device = 'desktop') {
  const normalized = normalizeKeyword(keyword);
  const now        = Date.now();
  const weekAgo    = new Date(now - 7  * 24 * 60 * 60 * 1000);
  const monthAgo   = new Date(now - 30 * 24 * 60 * 60 * 1000);

  const [prev_week_rank, prev_month_rank] = await Promise.all([
    findRankAtDate(projectId, normalized, weekAgo, device),
    findRankAtDate(projectId, normalized, monthAgo, device)
  ]);

  return { prev_week_rank, prev_month_rank };
}

/**
 * Derive prev_week_rank / prev_month_rank for EVERY keyword in a project in
 * exactly 2 queries (not 2×N), for the read path (GET rankings).
 *
 * The write-time cache in buildKeywordUpdate only refreshes on the NEXT scan,
 * so for infrequently-scanned ("manual tracking") projects the cached values
 * go stale the moment more than a week/month elapses since the last scan —
 * the window is anchored to scan time, not to "now". Recomputing here at
 * read time keeps the displayed values correct regardless of scan cadence,
 * per the "nearest available scan in the window, not an exact date match"
 * requirement — same $lte-then-most-recent semantics as findRankAtDate.
 */
export async function deriveHistoricalRanksForProject(projectId, device = 'desktop') {
  const now      = Date.now();
  const weekAgo   = new Date(now - 7  * 24 * 60 * 60 * 1000);
  const monthAgo  = new Date(now - 30 * 24 * 60 * 60 * 1000);
  const projectOid = new mongoose.Types.ObjectId(projectId);

  // Same unbounded "nearest scan at or before target date" semantics as
  // findRankAtDate() above — no tolerance window. See that function's doc
  // comment for why a fixed tolerance is wrong for manual-tracking projects.
  const nearestAtOrBefore = (targetDate) => KeywordRankingHistory.aggregate([
    { $match: {
        project_id:  projectOid,
        ...deviceFilter(device),
        scanned_at:  { $lte: targetDate }
    } },
    { $sort:  { keyword_normalized: 1, scanned_at: -1, _id: -1 } },
    { $group: { _id: '$keyword_normalized', rank: { $first: '$current_rank' } } }
  ]);

  const [weekRows, monthRows] = await Promise.all([
    nearestAtOrBefore(weekAgo),
    nearestAtOrBefore(monthAgo)
  ]);

  return {
    weekByKeyword:  new Map(weekRows.map(r => [r._id, r.rank])),
    monthByKeyword: new Map(monthRows.map(r => [r._id, r.rank]))
  };
}

// ─── Keyword merge ───────────────────────────────────────────────────────────

/**
 * Build the merged keyword state for a single keyword given:
 *  - existingKw  : the current keyword subdoc from seo_rankings_current (may be undefined)
 *  - incomingResult : { keyword, ranking_urls, maps_rank } from the Python worker
 *
 * Handles all invariants:
 *   - current_rank derived from ranking_urls (never from caller)
 *   - best_rank never increases
 *   - benchmark_rank frozen once set
 *   - history cache refreshed when stale (>1 hour)
 */
async function buildDesktopKeywordUpdate({ existingKw, projectId, incomingResult, now, scanSource }) {
  // incomingResult.scan_error is set by processKeyword() (seoOnboardingController.js)
  // only when the organic SERP request/parse itself failed (DataForSEO task-level
  // error, timeout, etc.) — NOT when the request succeeded and simply found no
  // match. On a genuine failure we have zero new information about this
  // keyword's ranking: falling through to the normal path would derive
  // current_rank from an empty ranking_urls array and overwrite whatever was
  // previously known with null, turning an infrastructure failure into a false
  // "Not ranked". So every rank-derived field is preserved verbatim from the
  // existing document, and only last_scan_status/last_scan_error change —
  // enough for the UI to show a distinct "scan error" state instead of
  // conflating it with "confirmed not ranked" (see UserAddedKeywords.jsx).
  if (incomingResult.scan_error) {
    LoggerUtil.warn('[buildKeywordUpdate] scan failed — preserving existing rank state', {
      keyword:    incomingResult.keyword,
      scan_error: incomingResult.scan_error
    });

    return {
      keyword:            incomingResult.keyword,
      current_rank:       existingKw?.current_rank    ?? null,
      rank:               existingKw?.current_rank    ?? null,
      best_rank:          existingKw?.best_rank        ?? null,
      benchmark_rank:     existingKw?.benchmark_rank   ?? null,
      prev_scan_rank:     existingKw?.prev_scan_rank   ?? null,
      prev_week_rank:     existingKw?.prev_week_rank   ?? null,
      prev_month_rank:    existingKw?.prev_month_rank  ?? null,
      history_derived_at: existingKw?.history_derived_at ?? null,
      // maps_rank/maps_listing come from a completely independent API call
      // (MapsRankingService, not DataForSeoService.getSerpOrganic) — an
      // organic scan_error must never suppress a maps result this same run
      // legitimately produced.
      maps_rank:          incomingResult.maps_rank    ?? existingKw?.maps_rank    ?? null,
      maps_listing:       incomingResult.maps_listing ?? existingKw?.maps_listing ?? null,
      ranking_urls:       existingKw?.ranking_urls    ?? [],
      last_rescanned_at:  now,
      last_scan_source:   scanSource || 'onboarding',
      scan_count:         (existingKw?.scan_count ?? 0) + 1,
      last_scan_status:   'error',
      last_scan_error:    sanitizeScanErrorForStorage(incomingResult.scan_error)
    };
  }

  const rankingUrls      = cleanRankingUrls(incomingResult.ranking_urls);
  const incomingCurrent  = computeCurrentRank(rankingUrls);  // enforces invariant

  LoggerUtil.info('[buildKeywordUpdate]', {
    keyword:          incomingResult.keyword,
    raw_urls_count:   Array.isArray(incomingResult.ranking_urls) ? incomingResult.ranking_urls.length : 'non-array',
    cleaned_count:    rankingUrls.length,
    derived_rank:     incomingCurrent,
    raw_urls:         JSON.stringify(incomingResult.ranking_urls).slice(0, 300)
  });

  // best_rank: rolling minimum — never let it increase
  let bestRank = existingKw?.best_rank ?? null;
  if (incomingCurrent !== null) {
    bestRank = bestRank === null ? incomingCurrent : Math.min(bestRank, incomingCurrent);
  }

  // benchmark_rank: set once on first detection, frozen forever
  const benchmarkRank = existingKw?.benchmark_rank ??
    (incomingCurrent !== null ? incomingCurrent : null);

  // prev_scan_rank: snapshot the current_rank before overwriting it
  const prevScanRank = existingKw?.current_rank ?? null;

  // History-derived ranks — refresh when stale (>1 hour) or missing
  const CACHE_TTL_MS  = 60 * 60 * 1000;
  const historyAge    = existingKw?.history_derived_at
    ? now.getTime() - new Date(existingKw.history_derived_at).getTime()
    : Infinity;

  let prevWeekRank      = existingKw?.prev_week_rank  ?? null;
  let prevMonthRank     = existingKw?.prev_month_rank ?? null;
  let historyDerivedAt  = existingKw?.history_derived_at ?? null;

  if (historyAge > CACHE_TTL_MS) {
    const derived   = await deriveHistoricalRanks(projectId, incomingResult.keyword);
    prevWeekRank    = derived.prev_week_rank;
    prevMonthRank   = derived.prev_month_rank;
    historyDerivedAt = now;
  }

  return {
    keyword:            incomingResult.keyword,
    current_rank:       incomingCurrent,
    rank:               incomingCurrent,          // backward-compat alias
    best_rank:          bestRank,
    benchmark_rank:     benchmarkRank,
    prev_scan_rank:     prevScanRank,
    prev_week_rank:     prevWeekRank,
    prev_month_rank:    prevMonthRank,
    history_derived_at: historyDerivedAt,
    maps_rank:          incomingResult.maps_rank    ?? null,
    maps_listing:       incomingResult.maps_listing ?? null,
    ranking_urls:       rankingUrls,
    last_rescanned_at:  now,
    last_scan_source:   scanSource || 'onboarding',
    scan_count:         (existingKw?.scan_count ?? 0) + 1,
    // Clears any error left by a previous failed scan (see the scan_error
    // branch above) now that a scan has actually succeeded.
    last_scan_status:   'ok',
    last_scan_error:    null
  };
}

// ─── Mobile merge ────────────────────────────────────────────────────────────

function sanitizeTrackedDepth(depth) {
  const n = parseInt(depth, 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 100) : null;
}

/**
 * Merge a mobile scan into the keyword's `mobile` sub-object.
 *
 *   incomingMobile absent (mobile not scanned, e.g. flag off)
 *                   -> existing mobile returned untouched (undefined for a
 *                      legacy keyword: "not collected", never defaulted)
 *   incomingMobile.scan_error
 *                   -> every rank field is preserved; only the error state and
 *                      attempt time change (a failure is not "not ranked")
 *   success         -> ranks derived from ranking_urls; previous values come
 *                      from MOBILE history only (never desktop); a keyword with
 *                      no earlier mobile scan gets null previous ranks
 *
 * @returns {Promise<object|undefined>}
 */
async function buildMobileUpdate({ existingMobile, incomingMobile, projectId, keyword, now }) {
  if (!incomingMobile || typeof incomingMobile !== 'object') {
    return existingMobile ?? undefined;
  }

  const scannedAt = incomingMobile.scanned_at ? new Date(incomingMobile.scanned_at) : now;

  if (incomingMobile.scan_error) {
    LoggerUtil.warn('[buildMobileUpdate] mobile scan failed — preserving existing mobile rank state', {
      keyword, scan_error: incomingMobile.scan_error
    });
    return {
      current_rank:       existingMobile?.current_rank       ?? null,
      best_rank:          existingMobile?.best_rank          ?? null,
      benchmark_rank:     existingMobile?.benchmark_rank     ?? null,
      prev_scan_rank:     existingMobile?.prev_scan_rank     ?? null,
      prev_week_rank:     existingMobile?.prev_week_rank     ?? null,
      prev_month_rank:    existingMobile?.prev_month_rank    ?? null,
      history_derived_at: existingMobile?.history_derived_at ?? null,
      ranking_urls:       existingMobile?.ranking_urls       ?? [],
      tracked_depth:      existingMobile?.tracked_depth      ?? null,
      scan_count:         (existingMobile?.scan_count ?? 0) + 1,
      last_scanned_at:    scannedAt,
      last_scan_status:   'error',
      last_scan_error:    sanitizeScanErrorForStorage(incomingMobile.scan_error)
    };
  }

  const rankingUrls = cleanRankingUrls(incomingMobile.ranking_urls);
  const current     = computeCurrentRank(rankingUrls);

  let bestRank = existingMobile?.best_rank ?? null;
  if (current !== null) bestRank = bestRank === null ? current : Math.min(bestRank, current);
  const benchmarkRank = existingMobile?.benchmark_rank ?? current;

  const derived = await deriveHistoricalRanks(projectId, keyword, 'mobile');

  return {
    current_rank:       current,
    best_rank:          bestRank,
    benchmark_rank:     benchmarkRank,
    prev_scan_rank:     existingMobile?.current_rank ?? null,
    prev_week_rank:     derived.prev_week_rank,
    prev_month_rank:    derived.prev_month_rank,
    history_derived_at: now,
    ranking_urls:       rankingUrls,
    tracked_depth:      sanitizeTrackedDepth(incomingMobile.tracked_depth),
    scan_count:         (existingMobile?.scan_count ?? 0) + 1,
    last_scanned_at:    scannedAt,
    last_scan_status:   'ok',
    last_scan_error:    null
  };
}

/**
 * Full keyword state = desktop fields (unchanged legacy logic) + `mobile`.
 * Desktop and mobile are merged independently, so neither device's result can
 * alter the other's.
 */
async function buildKeywordUpdate(args) {
  const desktop = await buildDesktopKeywordUpdate(args);
  const mobile  = await buildMobileUpdate({
    existingMobile: args.existingKw?.mobile,
    incomingMobile: args.incomingResult.mobile,
    projectId:      args.projectId,
    keyword:        args.incomingResult.keyword,
    now:            args.now
  });
  if (mobile !== undefined) desktop.mobile = mobile;
  return desktop;
}

// ─── Full project save ───────────────────────────────────────────────────────

/**
 * Upsert seo_rankings_current and append keyword_ranking_history for every keyword.
 * Called from saveRanking (onboarding and scheduled scans).
 *
 * @param {Object} opts
 * @param {string}  opts.projectId
 * @param {string}  opts.userId
 * @param {string}  opts.domain
 * @param {string}  opts.location
 * @param {number}  opts.locationCode
 * @param {string}  opts.country
 * @param {string}  opts.language
 * @param {string}  opts.seoScope
 * @param {Array}   opts.keywords  — [{ keyword, ranking_urls, maps_rank }]
 * @param {string}  opts.scanSource — 'onboarding' | 'manual_rescan' | 'scheduled'
 */
export async function saveCanonicalRanking({
  projectId, userId, domain, location, locationCode,
  country, language, seoScope, keywords, scanSource
}) {
  const now = new Date();

  // Load existing doc once — all keyword merges share it
  const existing = await SeoRankingCurrent.findOne({ project_id: projectId }).lean();

  // Build merged keyword objects (runs in parallel; history queries batched inside)
  const mergedKeywords = await Promise.all(
    keywords.map(kw => buildKeywordUpdate({
      existingKw:     existing?.keywords?.find(
        e => normalizeKeyword(e.keyword) === normalizeKeyword(kw.keyword)
      ),
      projectId,
      incomingResult: kw,
      now,
      scanSource
    }))
  );

  // Append history for all keywords (errors swallowed per-entry, non-blocking)
  await Promise.all(
    mergedKeywords.map(kw =>
      appendHistory({
        projectId,
        userId,
        domain,
        keyword:      kw.keyword,
        currentRank:  kw.current_rank,
        mapsRank:     kw.maps_rank,
        rankingUrls:  kw.ranking_urls,
        scanSource
      })
    )
  );

  await Promise.all(
    mergedKeywords.map((kw, i) => appendMobileHistoryIfObserved({
      projectId, userId, domain,
      keyword:        kw.keyword,
      incomingMobile: keywords[i]?.mobile,
      mobileDoc:      kw.mobile,
      scanSource
    }))
  );

  const docScanCount = (existing?.scan_count ?? 0) + 1;

  const result = await SeoRankingCurrent.findOneAndUpdate(
    { project_id: projectId },
    {
      $set: {
        user_id:          userId,
        domain:           domain.toLowerCase(),
        location:         location         || null,
        location_code:    locationCode     ?? null,
        country:          country?.toUpperCase() || null,
        language:         language?.toLowerCase() || 'en',
        seo_scope:        seoScope         || null,
        last_scanned_at:  now,
        last_scan_source: scanSource       || 'onboarding',
        scan_count:       docScanCount,
        keywords:         mergedKeywords
      }
    },
    { upsert: true, new: true }
  );

  LoggerUtil.info('saveCanonicalRanking complete', {
    projectId,
    docScanCount,
    keywordsCount: mergedKeywords.length
  });

  return result;
}

// ─── Single-keyword rescan ───────────────────────────────────────────────────

/**
 * Merge one keyword's fresh scan result into the canonical document.
 * Called from rescanKeyword (manual per-keyword re-scans from the UI).
 *
 * @param {Object} opts
 * @param {string}  opts.projectId
 * @param {string}  opts.userId
 * @param {string}  opts.domain
 * @param {Object}  opts.keywordResult  — { keyword, ranking_urls, maps_rank }
 * @param {string}  opts.scanSource
 */
export async function mergeSingleKeywordRescan({
  projectId, userId, domain, keywordResult, scanSource
}) {
  const now = new Date();

  const existing = await SeoRankingCurrent.findOne({ project_id: projectId }).lean();
  if (!existing) {
    throw new Error(`No canonical ranking document found for project ${projectId}. Run a full scan first.`);
  }

  const existingKw = existing.keywords?.find(
    e => normalizeKeyword(e.keyword) === normalizeKeyword(keywordResult.keyword)
  );

  const updatedKw = await buildKeywordUpdate({
    existingKw,
    projectId,
    incomingResult: keywordResult,
    now,
    scanSource
  });

  // Targeted, per-device writes instead of replacing the whole keywords array.
  // Replacing the array (the previous approach) let two overlapping rescans —
  // or a rescan of a different keyword — silently erase each other's fields.
  // Here each device only touches its own fields, a failed scan touches only
  // its status fields (never the last known good rank), and a result that is
  // older than what is already stored is ignored (ordering rule below).
  if (existingKw) {
    const stored = existingKw.keyword;
    const projectOid = new mongoose.Types.ObjectId(String(projectId));
    const desktopAt = keywordResult.scanned_at ? new Date(keywordResult.scanned_at) : now;
    const kwPath = (f) => `keywords.$[k].${f}`;

    // ── Desktop ──
    const desktopFields = keywordResult.scan_error
      ? ['maps_rank', 'maps_listing', 'last_scan_status', 'last_scan_error', 'last_rescanned_at', 'last_scan_source']
      : ['current_rank', 'rank', 'best_rank', 'benchmark_rank', 'prev_scan_rank', 'prev_week_rank',
         'prev_month_rank', 'history_derived_at', 'maps_rank', 'maps_listing', 'ranking_urls',
         'last_rescanned_at', 'last_scan_source', 'last_scan_status', 'last_scan_error'];
    const desktopSet = {};
    for (const f of desktopFields) desktopSet[kwPath(f)] = updatedKw[f] ?? null;
    desktopSet[kwPath('last_rescanned_at')] = desktopAt;
    // Ordering rule: apply only if no newer desktop result is already stored.
    // Native collection write: Mongoose's update casting rejects arrayFilters
    // that combine a field match with $or, and the values here are already
    // sanitised by buildKeywordUpdate.
    await SeoRankingCurrent.collection.updateOne(
      { project_id: projectOid },
      {
        $set: { ...desktopSet, last_scanned_at: now, last_scan_source: scanSource || 'manual_rescan' },
        $inc: { [kwPath('scan_count')]: 1, scan_count: 1 }
      },
      {
        arrayFilters: [{
          'k.keyword': stored,
          $or: [{ 'k.last_rescanned_at': null }, { 'k.last_rescanned_at': { $lte: desktopAt } }]
        }]
      }
    );

    // ── Mobile (only when a mobile scan ran) ──
    if (keywordResult.mobile && updatedKw.mobile) {
      const mobileAt = updatedKw.mobile.last_scanned_at;
      const mobileFields = keywordResult.mobile.scan_error
        ? ['last_scan_status', 'last_scan_error', 'last_scanned_at']
        : ['current_rank', 'best_rank', 'benchmark_rank', 'prev_scan_rank', 'prev_week_rank', 'prev_month_rank',
           'history_derived_at', 'ranking_urls', 'tracked_depth', 'last_scanned_at', 'last_scan_status', 'last_scan_error'];
      const mobileSet = {};
      for (const f of mobileFields) mobileSet[kwPath(`mobile.${f}`)] = updatedKw.mobile[f] ?? null;
      await SeoRankingCurrent.collection.updateOne(
        { project_id: projectOid },
        { $set: mobileSet, $inc: { [kwPath('mobile.scan_count')]: 1 } },
        {
          arrayFilters: [{
            'k.keyword': stored,
            $or: [{ 'k.mobile.last_scanned_at': null }, { 'k.mobile.last_scanned_at': { $lte: mobileAt } }]
          }]
        }
      );

      // A failed FIRST mobile scan only wrote status fields above. Give the new
      // sub-object the same explicit-null shape as every other write path, but
      // only where the rank fields are still absent, so a good result written
      // concurrently by another scan can never be overwritten with nulls.
      if (keywordResult.mobile.scan_error) {
        await SeoRankingCurrent.collection.updateOne(
          { project_id: projectOid },
          { $set: {
              [kwPath('mobile.current_rank')]: null, [kwPath('mobile.best_rank')]: null, [kwPath('mobile.benchmark_rank')]: null,
              [kwPath('mobile.prev_scan_rank')]: null, [kwPath('mobile.prev_week_rank')]: null, [kwPath('mobile.prev_month_rank')]: null,
              [kwPath('mobile.tracked_depth')]: null, [kwPath('mobile.ranking_urls')]: []
          } },
          { arrayFilters: [{ 'k.keyword': stored, 'k.mobile.current_rank': { $exists: false } }] }
        );
      }
    }
  }

  const result = await SeoRankingCurrent.findOne({ project_id: projectId });

  // Append to history (non-blocking)
  await appendHistory({
    projectId,
    userId,
    domain,
    keyword:     updatedKw.keyword,
    currentRank: updatedKw.current_rank,
    mapsRank:    updatedKw.maps_rank,
    rankingUrls: updatedKw.ranking_urls,
    scanSource
  });
  await appendMobileHistoryIfObserved({
    projectId, userId, domain,
    keyword:        updatedKw.keyword,
    incomingMobile: keywordResult.mobile,
    mobileDoc:      updatedKw.mobile,
    scanSource
  });

  LoggerUtil.info('mergeSingleKeywordRescan complete', {
    projectId,
    keyword:    updatedKw.keyword,
    newRank:    updatedKw.current_rank,
    scanCount:  updatedKw.scan_count
  });

  return result;
}

/**
 * Create the project's canonical ranking document if it does not exist yet
 * (an empty keyword list + the project's tracking location). Used by Add
 * Keyword so a project can start tracking without going through onboarding
 * again (e.g. after its ranking data was cleared).
 *
 * $setOnInsert only: an existing document is never modified, and two
 * concurrent callers cannot create two documents (unique project_id index —
 * the loser's duplicate-key error is treated as "already created").
 *
 * @returns {Promise<{ created: boolean }>}
 */
export async function ensureCanonicalRanking({ projectId, userId, domain, location, locationCode, country, language, seoScope }) {
  const projectOid = new mongoose.Types.ObjectId(String(projectId));
  try {
    const res = await SeoRankingCurrent.collection.updateOne(
      { project_id: projectOid },
      {
        $setOnInsert: {
          project_id:       projectOid,
          user_id:          new mongoose.Types.ObjectId(String(userId)),
          domain:           String(domain || '').toLowerCase(),
          location:         location || null,
          location_code:    locationCode ?? null,
          country:          country ? String(country).toUpperCase() : null,
          language:         (language || 'en').toLowerCase(),
          seo_scope:        seoScope || null,
          scan_count:       0,
          last_scan_source: 'onboarding',
          last_scanned_at:  null,
          created_at:       new Date(),
          keywords:         []
        }
      },
      { upsert: true }
    );
    return { created: res.upsertedCount > 0 };
  } catch (err) {
    if (err?.code === 11000) return { created: false };
    throw err;
  }
}

// ─── Manual Add / Delete Keyword ─────────────────────────────────────────────
// New functions only — saveCanonicalRanking(), mergeSingleKeywordRescan(), and
// buildKeywordUpdate() above are all untouched. addKeyword() below reuses
// buildKeywordUpdate() directly (same internal function mergeSingleKeywordRescan
// already trusts), calling it with existingKw: undefined — the exact case it
// already handles correctly for "this keyword has never been scanned before":
// current/best/benchmark all derive from this one scan, prev_scan_rank stays
// null (nothing to snapshot), prev_week/month resolve to null via
// deriveHistoricalRanks() finding no history yet. No merge logic is
// reimplemented here.

/**
 * Escapes regex metacharacters so a keyword string can be safely embedded in
 * a $regex filter — standard technique (MDN's own recommended pattern),
 * needed for deleteKeyword()'s case-insensitive exact match below.
 */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Add one new keyword to a project's tracked list. Atomic: the duplicate
 * check and the quota check are both evaluated inside the same
 * findOneAndUpdate's $expr filter as the insert itself — there is no
 * separate read-then-decide-then-write gap for either condition to race
 * through, unlike saveCanonicalRanking()'s read-then-write pattern (which
 * is fine for its own single-caller use case, but deliberately not reused
 * here).
 *
 * Both guard conditions are evaluated against the raw `keyword` field
 * on-the-fly (Mongo's own $toLower/$trim), not a separately stored
 * "keyword_normalized" field — this means the guard works uniformly for
 * every existing keyword regardless of when it was added, with no backfill
 * needed. It intentionally matches only case+whitespace-trim, not the
 * stricter whitespace-collapse/Unicode normalization isDuplicateKeyword()
 * (the caller's pre-check) applies — that stronger check already runs
 * before this function is ever called (see addKeywordController), so this
 * atomic guard only needs to catch the narrow concurrent-request race, not
 * carry the full UX-facing duplicate detection on its own.
 *
 * @param {Object} opts
 * @param {string} opts.projectId
 * @param {string} opts.userId
 * @param {string} opts.domain
 * @param {Object} opts.keywordResult — { keyword, ranking_urls, maps_rank, maps_listing }
 * @param {string} opts.planId — for the quota guard, via getKeywordLimit()
 * @param {string} [opts.scanSource='manual_add']
 * @returns {Promise<Object>} the updated SeoRankingCurrent document
 * @throws {Error} code one of PROJECT_NOT_FOUND, DUPLICATE_KEYWORD, KEYWORD_LIMIT_REACHED
 */
export async function addKeyword({ projectId, userId, domain, keywordResult, planId, scanSource = 'manual_add' }) {
  const now = new Date();

  const newKw = await buildKeywordUpdate({
    existingKw: undefined,
    projectId,
    incomingResult: keywordResult,
    now,
    scanSource
  });

  const normalizedNew = normalizeKeyword(newKw.keyword);
  const limit = getKeywordLimit(planId);

  const exprConditions = [
    {
      $not: {
        $in: [
          normalizedNew,
          {
            $map: {
              input: '$keywords',
              as:    'k',
              in:    { $trim: { input: { $toLower: '$$k.keyword' } } }
            }
          }
        ]
      }
    }
  ];
  if (limit !== null) {
    exprConditions.push({ $lt: [{ $size: '$keywords' }, limit] });
  }

  const result = await SeoRankingCurrent.findOneAndUpdate(
    {
      project_id: projectId,
      user_id:    userId,
      $expr:      exprConditions.length === 1 ? exprConditions[0] : { $and: exprConditions }
    },
    {
      $push: { keywords: newKw },
      $set:  { last_scanned_at: now, last_scan_source: scanSource },
      $inc:  { scan_count: 1 }
    },
    { new: true }
  );

  if (!result) {
    // The atomic write was rejected — could be ownership (project missing/
    // wrong owner), the duplicate guard, or the quota guard. A plain findOne
    // here is NOT part of the atomicity guarantee (that already happened
    // above); it only exists to produce an accurate error code. Safe even
    // under a race, since by this point the write attempt has already
    // failed — there's nothing left to protect.
    const diagnostic = await SeoRankingCurrent.findOne({ project_id: projectId, user_id: userId }).lean();

    if (!diagnostic) {
      const error = new Error(`No canonical ranking document found for project ${projectId}. Run onboarding first.`);
      error.code = 'PROJECT_NOT_FOUND';
      throw error;
    }

    const alreadyExists = (diagnostic.keywords || []).some(
      (k) => normalizeKeyword(k.keyword) === normalizedNew
    );
    if (alreadyExists) {
      const error = new Error(`"${newKw.keyword}" is already tracked for this project.`);
      error.code = 'DUPLICATE_KEYWORD';
      throw error;
    }

    const error = new Error(`Your plan allows tracking up to ${limit} keyword${limit === 1 ? '' : 's'}.`);
    error.code = 'KEYWORD_LIMIT_REACHED';
    throw error;
  }

  // Same non-blocking history append every other write path already uses.
  await appendHistory({
    projectId,
    userId,
    domain,
    keyword:     newKw.keyword,
    currentRank: newKw.current_rank,
    mapsRank:    newKw.maps_rank,
    rankingUrls: newKw.ranking_urls,
    scanSource
  });
  await appendMobileHistoryIfObserved({
    projectId, userId, domain,
    keyword:        newKw.keyword,
    incomingMobile: keywordResult.mobile,
    mobileDoc:      newKw.mobile,
    scanSource
  });

  LoggerUtil.info('addKeyword complete', {
    projectId,
    keyword:      newKw.keyword,
    currentRank:  newKw.current_rank,
    keywordCount: result.keywords.length
  });

  return result;
}

/**
 * Remove one keyword from active tracking. Does NOT touch
 * keyword_ranking_history — that stays intact so a deleted-then-re-added
 * keyword shows its prior history rather than starting cold, and so the
 * append-only audit trail this collection is documented to be never loses
 * data on a tracking-list change.
 *
 * $pull is naturally idempotent: deleting an already-absent keyword matches
 * zero array elements and succeeds as a no-op rather than erroring — no
 * separate "does it exist" check is needed before the write.
 *
 * @param {Object} opts
 * @param {string} opts.projectId
 * @param {string} opts.userId
 * @param {string} opts.keyword — exact display string as shown in the UI
 * @returns {Promise<Object>} the updated SeoRankingCurrent document
 * @throws {Error} code PROJECT_NOT_FOUND
 */
export async function deleteKeyword({ projectId, userId, keyword }) {
  const trimmed = (keyword || '').trim();
  const escaped = escapeRegExp(trimmed);

  const result = await SeoRankingCurrent.findOneAndUpdate(
    { project_id: projectId, user_id: userId },
    { $pull: { keywords: { keyword: { $regex: `^${escaped}$`, $options: 'i' } } } },
    { new: true }
  );

  if (!result) {
    const error = new Error(`No canonical ranking document found for project ${projectId}.`);
    error.code = 'PROJECT_NOT_FOUND';
    throw error;
  }

  LoggerUtil.info('deleteKeyword complete', {
    projectId,
    keyword:      trimmed,
    keywordCount: result.keywords.length
  });

  return result;
}
