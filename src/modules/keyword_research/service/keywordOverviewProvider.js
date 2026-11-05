import { DataForSeoService } from '../../ranking/services/DataForSeoService.js';
import {
  DataForSeoApiError, DATAFORSEO_ERROR, classifyProviderError, hasCredentials, requireOkTask,
} from '../../dataforseo-api/shared/providerErrors.js';

/**
 * The ONE DataForSEO call behind a tracked keyword's details: Labs keyword_overview for a single keyword in the project's market
 * (~$0.01). It carries the keyword's global-to-market search volume, its 12 monthly volumes, KD, intent, CPC, competition, the
 * top-of-page bid range and the SERP features. A missing or non-numeric value becomes null - never 0 - so the page can show "—".
 * One attempt per call: every call is billed, and the user's next expand is the retry.
 */

export const KEYWORD_OVERVIEW_TIMEOUT_MS = Number.parseInt(process.env.DATAFORSEO_KEYWORD_OVERVIEW_TIMEOUT_MS, 10) || 30_000;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v) => (Number.isInteger(v) ? v : null);
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function buildKeywordOverviewRequest({ keyword, market }) {
  return {
    keywords: [keyword],
    location_name: market.location_name,
    language_name: market.language_name,
    include_serp_info: true,
  };
}

/** keyword_info.monthly_searches -> [{ year, month, search_volume }], unusable months dropped, volume null when absent. */
function parseMonthly(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((m) => ({ year: int(m?.year), month: int(m?.month), search_volume: num(m?.search_volume) }))
    .filter((m) => m.year !== null && m.month !== null && m.month >= 1 && m.month <= 12);
}

/**
 * result -> the slim, cacheable payload, or { found: false } when the provider has no data for this keyword (an empty `items`, or an
 * item without keyword_info). "No data" is NOT a zero volume.
 */
export function parseKeywordOverview(result) {
  const item = Array.isArray(result?.items) ? result.items[0] : null;
  const info = item?.keyword_info;
  if (!item || !info || typeof info !== 'object') return { found: false };
  return {
    found: true,
    search_volume: num(info.search_volume),
    cpc: num(info.cpc),
    competition_level: str(info.competition_level),
    low_top_of_page_bid: num(info.low_top_of_page_bid),
    high_top_of_page_bid: num(info.high_top_of_page_bid),
    monthly_searches: parseMonthly(info.monthly_searches),
    keyword_difficulty: num(item.keyword_properties?.keyword_difficulty),
    intent: str(item.search_intent_info?.main_intent),
    serp_features: Array.isArray(item.serp_info?.serp_item_types) ? item.serp_info.serp_item_types.filter((t) => typeof t === 'string' && t) : [],
    check_url: str(item.serp_info?.check_url),
  };
}

let transport = (body, opts) => DataForSeoService.postKeywordOverview(body, opts);

/** Replace the HTTP call. Tests only: no real credits are spent by the test suite. */
export function __setKeywordOverviewTransportForTests(fn) {
  transport = fn ?? ((body, opts) => DataForSeoService.postKeywordOverview(body, opts));
}

/** One billed call. Resolves to { payload, cost }; rejects with a DataForSeoApiError only. */
export async function fetchKeywordOverview({ keyword, market }) {
  if (!hasCredentials()) throw new DataForSeoApiError(DATAFORSEO_ERROR.NOT_CONFIGURED);
  let data;
  try {
    data = await transport(buildKeywordOverviewRequest({ keyword, market }), { timeoutMs: KEYWORD_OVERVIEW_TIMEOUT_MS });
  } catch (err) {
    throw classifyProviderError(err);
  }
  const task = requireOkTask(data);
  if (!Array.isArray(task.result)) throw new DataForSeoApiError(DATAFORSEO_ERROR.MALFORMED_RESPONSE);
  return { payload: parseKeywordOverview(task.result[0] ?? null), cost: num(task.cost) ?? num(data.cost) };
}
