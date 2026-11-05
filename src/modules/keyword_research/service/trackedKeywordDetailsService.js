import mongoose from 'mongoose';
import SeoRankingCurrent from '../../app_user/model/SeoRankingCurrent.js';
import SeoProject from '../../app_user/model/SeoProject.js';
import KeywordRankingHistory from '../../app_user/model/KeywordRankingHistory.js';
import DataForSeoCacheEntry from '../../dataforseo-api/shared/DataForSeoCacheEntry.js';
import { getOrFetch } from '../../dataforseo-api/shared/apiCache.js';
import { normalizeTargetDomain } from '../../dataforseo-api/shared/targetDomain.js';
import { DataForSeoApiError, DATAFORSEO_ERROR, hasCredentials } from '../../dataforseo-api/shared/providerErrors.js';
import { resolveMarket } from '../../dataforseo-api/domain_overview/validator/domainOverviewValidation.js';
import { takeProviderCalls } from '../../dataforseo-api/domain_overview/service/providerBudget.js';
import { SECTIONS } from '../../dataforseo-api/domain_overview/config.js';
import { deriveHistoricalRanks, deriveKeywordStatus, deriveMobileStatus } from '../../../services/rankingHistoryService.js';
import { resolveSerpDepth } from '../../ranking/services/serpDevices.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { fetchKeywordOverview } from './keywordOverviewProvider.js';

/**
 * Everything one tracked keyword's expanded row shows, in one normalized answer. Sources, in order of cost:
 *  - the project's canonical ranking document (desktop + mobile rank, URLs, Maps) and keyword_ranking_history (the rank charts): our own data;
 *  - DataForSEO Labs keyword_overview: ONE ~$0.01 call per keyword and market, cached KEYWORD_OVERVIEW.ttlMs in the shared DataForSEO
 *    cache, so a second expand (or another user tracking the same keyword in the same market) buys nothing;
 *  - the ranking page's referring domains / backlinks: read from an Organic Keywords response that is ALREADY cached, never bought here.
 * An optional source failing never fails the answer: it is reported in `metadata.dataAvailability` and its figures are null.
 */

export const KEYWORD_OVERVIEW = Object.freeze({
  endpoint: 'labs/keyword_overview',
  // Search volumes are monthly figures; two weeks keeps a new month visible without re-buying the same answer on every visit.
  ttlMs: 14 * 24 * 60 * 60 * 1000,
  variant: 'serp-v1',
  budget: Object.freeze({ bucket: 'tracked-keyword-details', windowMs: 15 * 60 * 1000, maxProviderCalls: 30 }),
});

/** Chart window and cap for each device's rank history (the TTL keeps a year; a chart needs far fewer points). */
export const HISTORY_WINDOW_DAYS = 180;
export const HISTORY_MAX_POINTS = 200;

/** How many cached Organic Keywords responses are searched for the ranking page's backlinks. */
const BACKLINK_CACHE_ENTRIES = 4;

export class TrackedKeywordNotFound extends Error {
  constructor(message = 'Tracked keyword not found') {
    super(message);
    this.name = 'TrackedKeywordNotFound';
    this.code = 'KEYWORD_NOT_FOUND';
  }
}

const normalize = (kw) => String(kw || '').toLowerCase().trim();
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const iso = (d) => (d ? new Date(d).toISOString() : null);
const nz = (v) => (v === undefined ? null : v);

// ── rankings ───────────────────────────────────────────────────────────────────────────────────────────────────────────

function rankingUrlsOf(list) {
  return (Array.isArray(list) ? list : []).map((u) => ({ rank: u.rank, url: u.url, type: u.type === 'homepage' ? 'homepage' : 'internal_page' }));
}

/**
 * One device's current state. `status` keeps four cases apart, and none of them is a position of zero:
 *   ranked | not_ranked (scan succeeded, not found within `trackedDepth`) | scan_error (last scan failed; `position` is the last good one, if any) | not_collected
 */
export function buildDeviceRanking({ status, doc, prevWeek, prevMonth, trackedDepth }) {
  return {
    status,
    position: nz(doc?.current_rank),
    previousPosition: nz(doc?.prev_scan_rank),
    bestPosition: nz(doc?.best_rank),
    benchmarkPosition: nz(doc?.benchmark_rank),
    prevWeekPosition: nz(prevWeek),
    prevMonthPosition: nz(prevMonth),
    rankingUrl: rankingUrlsOf(doc?.ranking_urls).sort((a, b) => a.rank - b.rank)[0]?.url ?? null,
    rankingUrls: rankingUrlsOf(doc?.ranking_urls),
    trackedDepth: status === 'not_ranked' ? trackedDepth : null,
    scanCount: doc?.scan_count ?? 0,
    lastScannedAt: iso(doc?.last_scanned_at ?? doc?.last_rescanned_at),
    scanError: status === 'scan_error' ? (doc?.last_scan_error ?? null) : null,
  };
}

function desktopStatus(kw) {
  // A keyword is only on the document after a scan, but a legacy / placeholder one with no scan at all is "not collected", not "not ranked".
  if (!kw.scan_count && !kw.last_rescanned_at && kw.last_scan_status !== 'error') return 'not_collected';
  return deriveKeywordStatus(kw);
}

// ── history ────────────────────────────────────────────────────────────────────────────────────────────────────────────

async function loadHistory(projectId, keywordNormalized, device, now) {
  const since = new Date(now.getTime() - HISTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await KeywordRankingHistory.find({
    project_id: projectId,
    keyword_normalized: keywordNormalized,
    ...(device === 'mobile' ? { device: 'mobile' } : { device: { $ne: 'mobile' } }),
    scanned_at: { $gte: since },
  })
    .sort({ scanned_at: -1, _id: -1 })
    .limit(HISTORY_MAX_POINTS)
    .select('scanned_at current_rank maps_rank scan_source')
    .lean();
  // Oldest first for the chart. Rows are only written for scans that succeeded, so a null rank is "not found", never a failed scan.
  return rows.reverse().map((r) => ({ at: iso(r.scanned_at), position: nz(r.current_rank), source: r.scan_source ?? null }));
}

// ── keyword metrics (the one billed call) ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves to { status, payload, fetchedAt, cached, error }. status: ok | no_data | not_configured | rate_limited | error.
 * Never throws: the caller treats it as an optional section.
 */
export async function loadKeywordMetrics({ keyword, market, userId, refresh = false }) {
  if (!hasCredentials()) return { status: 'not_configured', payload: null, fetchedAt: null, cached: false, error: null };
  try {
    const result = await getOrFetch({
      endpoint: KEYWORD_OVERVIEW.endpoint,
      target: normalize(keyword),
      location: market.location_name,
      language: market.language_name,
      variant: KEYWORD_OVERVIEW.variant,
      ttlMs: KEYWORD_OVERVIEW.ttlMs,
      refresh,
      // Runs only when a REAL call is about to be bought (never on a cache hit), which is where the budget is spent.
      fetcher: async () => {
        takeProviderCalls(userId, 1, KEYWORD_OVERVIEW.budget);
        const out = await fetchKeywordOverview({ keyword: normalize(keyword), market });
        LoggerUtil.info('Tracked keyword details: provider call completed', { cost: out.cost, found: out.payload.found });
        return out;
      },
    });
    const found = result.payload?.found === true;
    return { status: found ? 'ok' : 'no_data', payload: found ? result.payload : null, fetchedAt: result.fetchedAt, cached: result.cached, error: null };
  } catch (err) {
    const code = err instanceof DataForSeoApiError ? err.code : (err?.code ?? 'UNKNOWN');
    LoggerUtil.warn('Tracked keyword details: keyword metrics unavailable', { code, message: err instanceof DataForSeoApiError ? undefined : err?.message });
    if (code === 'RATE_LIMITED' || code === DATAFORSEO_ERROR.RATE_LIMITED) return { status: 'rate_limited', payload: null, fetchedAt: null, cached: false, error: code };
    if (code === DATAFORSEO_ERROR.NOT_CONFIGURED) return { status: 'not_configured', payload: null, fetchedAt: null, cached: false, error: code };
    return { status: 'error', payload: null, fetchedAt: null, cached: false, error: code };
  }
}

// ── the ranking page's backlinks, from data we already paid for ───────────────────────────────────────────────────────

/**
 * Looks for this keyword in the project's CACHED Organic Keywords responses (the same ranked-keywords entries the Domain Overview pages
 * wrote) and returns the ranking page's referring domains and backlinks. Buys nothing: a miss is "unavailable", not zero.
 */
export async function peekPageBacklinks({ domain, market, keyword, now = new Date() }) {
  const prefix = `${SECTIONS['ranked-keywords'].endpoint}|${domain}|${market.location_name}|${market.language_name}|`.toLowerCase();
  let entries;
  try {
    entries = await DataForSeoCacheEntry.find({ key: { $regex: `^${escapeRegExp(prefix)}` }, expiresAt: { $gt: now } })
      .sort({ fetchedAt: -1 })
      .limit(BACKLINK_CACHE_ENTRIES)
      .select('payload.items fetchedAt')
      .lean();
  } catch (err) {
    LoggerUtil.warn('Tracked keyword details: backlink cache lookup failed', { error: err?.message });
    return { status: 'error', referringDomains: null, backlinks: null, pageUrl: null, fetchedAt: null };
  }
  const wanted = normalize(keyword);
  for (const entry of entries) {
    const item = (Array.isArray(entry.payload?.items) ? entry.payload.items : []).find((i) => normalize(i?.keyword) === wanted);
    if (!item) continue;
    const rd = typeof item.referring_domains === 'number' ? item.referring_domains : null;
    const bl = typeof item.backlinks === 'number' ? item.backlinks : null;
    if (rd === null && bl === null) continue;
    return { status: 'ok', referringDomains: rd, backlinks: bl, pageUrl: typeof item.url === 'string' ? item.url : null, fetchedAt: iso(entry.fetchedAt) };
  }
  return { status: 'unavailable', referringDomains: null, backlinks: null, pageUrl: null, fetchedAt: null };
}

// ── the answer ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ projectId: string, keywordId: string, userId: string, refresh?: boolean, now?: Date }} args
 * @throws TrackedKeywordNotFound when the project is not the user's, or the keyword is not tracked in it (one answer for both: nothing leaks)
 */
export async function getTrackedKeywordDetails({ projectId, keywordId, userId, refresh = false, now = new Date() }) {
  if (!mongoose.Types.ObjectId.isValid(projectId) || !mongoose.Types.ObjectId.isValid(keywordId)) throw new TrackedKeywordNotFound();

  // Ownership is decided here from the session user, never from the request: both documents must belong to userId.
  const [project, canonical] = await Promise.all([
    SeoProject.findOne({ _id: projectId, user_id: userId }).select('main_url country language').lean(),
    SeoRankingCurrent.findOne({ project_id: projectId, user_id: userId, 'keywords._id': keywordId })
      .select('domain location location_code country language seo_scope last_scanned_at keywords.$')
      .lean(),
  ]);
  const kw = canonical?.keywords?.[0];
  if (!project || !kw) throw new TrackedKeywordNotFound();

  const normalized = normalize(kw.keyword);
  const market = resolveMarket(project);
  let domain = null;
  try { domain = normalizeTargetDomain(project.main_url); } catch { domain = null; }
  const hasMobile = Boolean(kw.mobile && kw.mobile.last_scan_status);

  const [metrics, backlinks, desktopHistory, mobileHistory, desktopPrev, mobilePrev] = await Promise.all([
    loadKeywordMetrics({ keyword: kw.keyword, market, userId, refresh }),
    domain ? peekPageBacklinks({ domain, market, keyword: kw.keyword, now }) : Promise.resolve({ status: 'unavailable', referringDomains: null, backlinks: null, pageUrl: null, fetchedAt: null }),
    loadHistory(projectId, normalized, 'desktop', now).catch((err) => { LoggerUtil.warn('Tracked keyword details: desktop history failed', { error: err?.message }); return null; }),
    hasMobile ? loadHistory(projectId, normalized, 'mobile', now).catch((err) => { LoggerUtil.warn('Tracked keyword details: mobile history failed', { error: err?.message }); return null; }) : Promise.resolve([]),
    deriveHistoricalRanks(projectId, kw.keyword, 'desktop').catch(() => ({ prev_week_rank: null, prev_month_rank: null })),
    hasMobile ? deriveHistoricalRanks(projectId, kw.keyword, 'mobile').catch(() => ({ prev_week_rank: null, prev_month_rank: null })) : Promise.resolve({ prev_week_rank: null, prev_month_rank: null }),
  ]);

  const m = metrics.payload;
  const maps = {
    position: nz(kw.maps_rank),
    listing: kw.maps_listing?.title ? { title: kw.maps_listing.title, rating: nz(kw.maps_listing.rating), reviews: nz(kw.maps_listing.reviews), address: nz(kw.maps_listing.address) } : null,
  };
  const serpFeatures = [...(m?.serp_features ?? [])];
  // A Maps listing we found ourselves is the local pack, even if the keyword-overview call is unavailable.
  if ((maps.position !== null || maps.listing) && !serpFeatures.includes('local_pack')) serpFeatures.push('local_pack');

  return {
    keywordId: String(kw._id),
    keyword: kw.keyword,
    overview: {
      searchVolume: nz(m?.search_volume),
      keywordDifficulty: nz(m?.keyword_difficulty),
      searchIntent: nz(m?.intent),
      cpc: nz(m?.cpc),
      competition: nz(m?.competition_level),
      lowTopOfPageBid: nz(m?.low_top_of_page_bid),
      highTopOfPageBid: nz(m?.high_top_of_page_bid),
    },
    rankings: {
      desktop: buildDeviceRanking({ status: desktopStatus(kw), doc: kw, prevWeek: desktopPrev.prev_week_rank, prevMonth: desktopPrev.prev_month_rank, trackedDepth: resolveSerpDepth() }),
      mobile: buildDeviceRanking({ status: deriveMobileStatus(kw.mobile), doc: kw.mobile, prevWeek: mobilePrev.prev_week_rank, prevMonth: mobilePrev.prev_month_rank, trackedDepth: kw.mobile?.tracked_depth ?? null }),
      maps,
    },
    history: {
      volume: m?.monthly_searches ?? [],
      desktop: desktopHistory ?? [],
      mobile: mobileHistory ?? [],
      windowDays: HISTORY_WINDOW_DAYS,
    },
    serpFeatures,
    googleUrl: nz(m?.check_url),
    backlinks: { referringDomains: backlinks.referringDomains, totalBacklinks: backlinks.backlinks, pageUrl: backlinks.pageUrl },
    metadata: {
      lastScannedAt: iso(kw.last_rescanned_at ?? kw.mobile?.last_scanned_at ?? canonical.last_scanned_at),
      market: { location: market.location_name, language: market.language_name },
      projectLocation: canonical.location ?? null,
      metricsFetchedAt: iso(metrics.fetchedAt),
      metricsCached: metrics.cached,
      backlinksFetchedAt: backlinks.fetchedAt,
      dataAvailability: {
        keywordMetrics: metrics.status,
        volumeHistory: m ? (m.monthly_searches.some((x) => x.search_volume !== null) ? 'ok' : 'no_data') : metrics.status,
        rankHistory: desktopHistory === null || mobileHistory === null ? 'error' : 'ok',
        backlinks: backlinks.status,
      },
    },
  };
}
