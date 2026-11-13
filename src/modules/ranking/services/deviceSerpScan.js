/**
 * Device-aware organic SERP scanning for one keyword.
 *
 * Desktop and mobile are requested independently and concurrently; each device
 * reports its own outcome, so one device failing never changes the other's
 * result. Failures are carried as `scan_error` — they are never converted into
 * a "no ranking" result (see rankingHistoryService.buildKeywordUpdate).
 */

import { DataForSeoService } from './DataForSeoService.js';
import { RankingParserService } from './RankingParserService.js';
import { isMobileRankingEnabled } from './serpDevices.js';
import { ORGANIC_OUTCOMES } from './serpResponseOutcome.js';

/**
 * Request one device's organic SERP. Never throws: a provider failure is
 * returned as { serpData: null, serpError }.
 */
export async function scanDeviceSerp({ keyword, locationCode, languageCode, device, serpFetcher, context, cleanDomain = null, matchOptions = {} }) {
  const fetcher = serpFetcher || ((kw, loc, lang, opts) => DataForSeoService.getSerpOrganic(kw, loc, lang, opts));
  const fetchOnce = () => fetcher(keyword, locationCode, languageCode, context ? { device, context } : { device });
  try {
    let serpData = await fetchOnce();
    let attempts = serpData?.dfsAttempts ?? 1;
    // A partial (40106) answer that does not contain the site is retried ONCE: the missing pages may come back. Only when the caller says which
    // site to look for, and only on Live (a Standard task already got the provider's own extra retries and is shared by identical requests).
    if (cleanDomain && serpData?.dfsSerpMeta?.outcome === ORGANIC_OUTCOMES.PARTIAL && serpData?.dfsProvider !== 'standard'
        && RankingParserService.parseOrganic(serpData, cleanDomain, matchOptions).best_rank === null) {
      console.warn(`[SERP_PARTIAL_RETRY] device=${device} | keyword="${keyword}" | partial result without the site: one retry`);
      try {
        const again = await fetchOnce();
        attempts += again?.dfsAttempts ?? 1;
        const found = RankingParserService.parseOrganic(again, cleanDomain, matchOptions).best_rank !== null;
        const better = again?.dfsSerpMeta?.outcome !== ORGANIC_OUTCOMES.PARTIAL || (again?.dfsSerpMeta?.returned_results ?? 0) > (serpData.dfsSerpMeta.returned_results ?? 0);
        if (found || better) serpData = again;
      } catch (retryErr) {
        attempts += retryErr.attempts ?? 1; // the first (partial) answer stands
        console.warn(`[SERP_PARTIAL_RETRY] device=${device} | the retry failed (${retryErr.message}); keeping the partial answer`);
      }
    }
    return {
      device, serpData, serpError: null, attempts, serpMeta: serpData?.dfsSerpMeta ?? null,
      scanned_at: new Date(),
    };
  } catch (err) {
    console.error(`[SERP] Failed | device=${device} | keyword="${keyword}" | ${err.message}`);
    return {
      device, serpData: null, serpError: err.message || 'unknown error', attempts: err.attempts ?? 1,
      serpMeta: err.serpMeta ?? null, scanned_at: new Date(),
    };
  }
}


/**
 * Turn one device's raw scan into the normalised per-device result.
 *   scan_error set   -> the check failed (rank unknown)
 *   scan_error null  -> the check succeeded; empty ranking_urls means "not found
 *                       within tracked_depth" (tracked_depth null if the
 *                       response carried no organic items to prove a range)
 *
 * Partial results (40106, `serp.outcome === 'partial'`):
 *   site found     -> a real observation: the rank is recorded (scan status partial_success downstream)
 *   site not found -> NOT "not ranked": the site may be on a page that was not returned, so it is a scan_error and the
 *                     previous rank is preserved. Missing positions are never invented.
 * `serp` ({ outcome, provider_code, requested_depth, returned_results }) is carried whenever the provider reported it.
 */
export function buildDeviceResult(scan, cleanDomain, matchOptions = {}) {
  if (!scan) return null;
  const serp = scan.serpMeta ?? null;
  const failed = (scanError, serpOverride) => ({
    ranking_urls:  [],
    best_rank:     null,
    maps_rank:     null,
    ranking_status: 'unknown',
    rank_state:     'scan_error',
    unreadable_count: 0,
    completeness:   serp?.outcome === ORGANIC_OUTCOMES.PARTIAL ? 'partial' : 'failed',
    tracked_depth: null,
    scan_error:    scanError,
    attempts:      scan.attempts ?? 1,
    scanned_at:    scan.scanned_at,
    ...((serpOverride ?? serp) ? { serp: serpOverride ?? serp } : {}),
  });
  if (scan.serpError || !scan.serpData) return failed(scan.serpError || 'no response');

  const parsed = RankingParserService.parseOrganic(scan.serpData, cleanDomain, matchOptions);
  const depth  = RankingParserService.observedOrganicDepth(scan.serpData);
  // Counts and the verdict only — no SERP content. Without this line only the
  // desktop scan was ever visible in logs.
  console.log(
    `[DEVICE_SCAN_RESULT] device=${scan.device} | target="${cleanDomain}" | deepestOrganicRank=${depth ?? 'null'} | ` +
    `requestedDepth=${serp?.requested_depth ?? 'null'} | coverage=${serp?.result_completeness ?? 'unknown'} | coverageComplete=${serp?.coverage_complete ?? 'null'} | ` +
    `outcome=${serp?.outcome ?? 'complete'} | returned=${serp?.returned_results ?? 'null'} | ` +
    `matched=${parsed.best_rank !== null} | rank=${parsed.best_rank ?? 'null'} | matchedUrls=${parsed.ranking_urls.length}`
  );
  const stats = parsed.resolution_stats;
  const unreadable = stats.unresolvedOrganic + stats.matchedWithoutRank;
  // The check RAN and produced a verdict about what it saw. These are three kinds of "not found", each said as exactly what it is:
  //   not_ranked_partial    40106: some result pages were not returned (the retry, if any, did not bring them) - "Not in top N (partial)"
  //   not_ranked_uncertain  complete answer, but X results had no readable website (they could be the site) - "Not in top N (X unreadable)"
  //   not_ranked            complete answer, every result read - "Not in top N"
  // None is a provider failure (scan_error is reserved for a check that returned nothing usable), and none keeps the old rank.
  const verdict = (rank_state, extra = {}) => {
    const reason = rank_state === 'not_ranked_partial' ? 'provider_partial' : rank_state === 'not_ranked_uncertain' ? 'unreadable_results' : (serp?.coverage_complete === false ? 'all_resolved_coverage_short' : 'all_resolved_coverage_complete');
    console.log(`[RANKING_STATUS] device=${scan.device} | target="${cleanDomain}" | status=${rank_state} reason=${reason} | N=${serp?.returned_results ?? depth ?? 'null'} | unreadable=${unreadable}`);
    return {
      ranking_urls: [], best_rank: null, maps_rank: parsed.maps_rank, absolute_rank: null, local_pack_rank: parsed.local_pack_rank,
      ranking_status: rank_state === 'not_ranked' ? 'not_found' : 'unknown', rank_state, unreadable_count: unreadable,
      completeness: rank_state === 'not_ranked_partial' ? 'partial' : 'complete', tracked_depth: depth,
      scan_error: null, attempts: scan.attempts ?? 1, scanned_at: scan.scanned_at,
      ...((serp || unreadable) ? { serp: { ...(serp ?? {}), ...(unreadable ? { unresolved_candidates: unreadable } : {}) } } : {}), ...extra,
    };
  };
  if (parsed.best_rank === null) {
    if (serp?.outcome === ORGANIC_OUTCOMES.PARTIAL) return verdict('not_ranked_partial');
    if (unreadable > 0 || parsed.ranking_status === 'unknown') return verdict('not_ranked_uncertain');
    return verdict('not_ranked');
  }
  console.log(`[RANKING_STATUS] device=${scan.device} | target="${cleanDomain}" | status=ranked reason=${parsed.match_basis ?? 'domain'}_match confidence=${parsed.match_confidence ?? 'high'} rank=${parsed.best_rank}`);

  return {
    ranking_urls:  parsed.ranking_urls,
    best_rank:     parsed.best_rank,
    maps_rank:     parsed.maps_rank,
    // Additive (in-memory) explicit status; a failed device scan is { ranking_status: 'unknown' } via `failed` above.
    absolute_rank:   parsed.absolute_rank,
    local_pack_rank: parsed.local_pack_rank,
    ranking_status:  parsed.ranking_status,
    rank_state:      'ranked',
    unreadable_count: unreadable,
    match_confidence: parsed.match_confidence,
    match_basis:     parsed.match_basis,
    completeness:    serp?.outcome === ORGANIC_OUTCOMES.PARTIAL ? 'partial' : 'complete',
    better_rank_possible: parsed.better_rank_possible,
    tracked_depth: depth,
    scan_error:    null,
    attempts:      scan.attempts ?? 1,
    scanned_at:    scan.scanned_at,
    ...(serp ? { serp } : {}),
  };
}

/**
 * Scan desktop (always) and mobile (unless disabled) concurrently.
 * @returns {Promise<{ desktop: object, mobile: object|null }>} raw scans
 */
export async function scanKeywordDevices({
  keyword, locationCode, languageCode, serpFetcher, mobileEnabled = isMobileRankingEnabled(), context, cleanDomain = null, matchOptions = {},
}) {
  const base = { keyword, locationCode, languageCode, serpFetcher, context, cleanDomain, matchOptions };
  const [desktop, mobile] = await Promise.all([
    scanDeviceSerp({ ...base, device: 'desktop' }),
    mobileEnabled ? scanDeviceSerp({ ...base, device: 'mobile' }) : Promise.resolve(null),
  ]);
  return { desktop, mobile };
}
