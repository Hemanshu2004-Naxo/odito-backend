import { DataForSeoService } from '../../../ranking/services/DataForSeoService.js';
import {
  DataForSeoApiError, DATAFORSEO_ERROR, classifyProviderError, hasCredentials, requireOkTask,
} from '../../shared/providerErrors.js';
import { buildHistoryRange } from '../validator/domainOverviewValidation.js';
import { toProviderFilters } from '../validator/rankedKeywordsQuery.js';
import { toProviderFilters as toCompetitorFilters } from '../validator/competitorsQuery.js';
import { toProviderFilters as toListFilters } from '../validator/filterConditions.js';
import {
  RANKED_KEYWORDS_LIMIT, RANKED_KEYWORDS_QUERY, COMPETITORS_QUERY, BULK_TRAFFIC, BACKLINKS_QUERY, BACKLINKS_LIST_QUERY, ANCHORS_QUERY, ANCHOR_PROFILE,
  REFERRING_DOMAINS_QUERY, RANK_BUCKETS, TOXIC_SPAM_ABOVE, DOMAIN_PAGES_QUERY, DOMAIN_PAGES_BASE_FILTER, TOP_PAGES_FIX_FIRST, RD_LAST_30,
} from '../config.js';
import { windowStartDay } from '../../shared/dates.js';
import { getStatusGroup, normalizePageUrl, suggestFix } from './pageMetrics.js';
import { classifyDomainQuality, dofollowPercent, isSitewide, topKey } from './referringDomainMetrics.js';

/**
 * The five DataForSEO calls behind Domain Overview: the request each one sends, and a tolerant parser that keeps ONLY the
 * fields the page uses (see ../types.js). A missing or non-numeric value becomes null — never 0 — so the page can show "—".
 * One attempt per call: every call is billed, and the user's Retry button is the retry policy.
 *
 * Response envelope (all five): { status_code, tasks: [{ status_code, cost, result: [ { ...endpoint specific } ] }] }.
 */

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v) => (Number.isInteger(v) ? v : null);
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

function pick(obj, fields) {
  if (!obj || typeof obj !== 'object') return null;
  return Object.fromEntries(fields.map((f) => [f, num(obj[f])]));
}

// ── request bodies ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The single task object each endpoint takes. Pure. */
export function buildRequest(section, { target, market = {}, now = new Date(), months, query, excludeDomains = [] }) {
  const base = { target, location_name: market.location_name, language_name: market.language_name };
  switch (section) {
    case 'rank-overview': return base;
    case 'history': return { ...base, ...buildHistoryRange(now, months) };
    case 'ranked-keywords': {
      // `query` is the validator's canonical { limit, offset, orderBy, filters }; without it this is the dashboard's top-5 call.
      const { limit, offset, orderBy, filters } = query ?? {};
      const providerFilters = toProviderFilters(filters ?? []);
      return {
        ...base,
        limit: limit ?? RANKED_KEYWORDS_LIMIT,
        ...(offset ? { offset } : {}),
        order_by: [orderBy ?? RANKED_KEYWORDS_QUERY.defaultOrderBy],
        ...(providerFilters ? { filters: providerFilters } : {}),
      };
    }
    case 'competitors': {
      // `query` is the validator's canonical form; without it this is the default view (the dashboard card and the page share it).
      const q = query ?? {};
      const filters = toCompetitorFilters(q.filters ?? []);
      return {
        ...base,
        limit: q.limit ?? COMPETITORS_QUERY.defaultLimit,
        ...(q.offset ? { offset: q.offset } : {}),
        // Always explicit (the default is "intersections,desc", which is what the provider does when it is omitted).
        order_by: [q.orderBy ?? COMPETITORS_QUERY.defaultOrderBy],
        ...(filters ? { filters } : {}),
        exclude_top_domains: q.excludeTopDomains ?? COMPETITORS_QUERY.defaultExcludeTopDomains,
        // The project's own list (read from the project by the service, never from the browser).
        ...(excludeDomains.length ? { exclude_domains: excludeDomains } : {}),
        max_rank_group: q.maxRankGroup ?? COMPETITORS_QUERY.defaultMaxRankGroup,
      };
    }
    case 'backlinks-list': {
      // Individual backlinks. `query` is the validator's canonical form. Either offset (while offset + limit <= 20,000) or the previous
      // response's search_after_token continues a listing — never both. The tab's own filter (is_new / is_broken) is part of `filters`.
      const q = query ?? {};
      const filters = toListFilters(q.filters ?? []);
      return {
        target,
        include_subdomains: BACKLINKS_LIST_QUERY.includeSubdomains,
        backlinks_status_type: q.status ?? BACKLINKS_LIST_QUERY.defaultStatus,
        mode: q.mode ?? BACKLINKS_LIST_QUERY.defaultMode,
        limit: q.limit ?? BACKLINKS_LIST_QUERY.defaultLimit,
        ...(q.token ? { search_after_token: q.token } : q.offset ? { offset: q.offset } : {}),
        order_by: q.orderBy ?? [...BACKLINKS_LIST_QUERY.defaultOrderBy],
        ...(filters ? { filters } : {}),
      };
    }
    case 'anchors': {
      // One page of anchors. `query` is the validator's canonical form; without it this is the default view (live, 50, referring domains desc).
      const q = query ?? {};
      const filters = toListFilters(q.filters ?? []);
      return {
        target,
        include_subdomains: ANCHORS_QUERY.includeSubdomains,
        backlinks_status_type: q.status ?? ANCHORS_QUERY.defaultStatus,
        internal_list_limit: ANCHORS_QUERY.internalListLimit,
        limit: q.limit ?? ANCHORS_QUERY.defaultLimit,
        ...(q.offset ? { offset: q.offset } : {}),
        order_by: [q.orderBy ?? ANCHORS_QUERY.defaultOrderBy],
        ...(filters ? { filters } : {}),
      };
    }
    case 'anchor-profile': {
      // Fixed: the top 1,000 live anchors by referring domains, no filters (the page classifies them itself).
      return {
        target,
        include_subdomains: ANCHOR_PROFILE.includeSubdomains,
        backlinks_status_type: ANCHOR_PROFILE.status,
        internal_list_limit: ANCHOR_PROFILE.internalListLimit,
        limit: ANCHOR_PROFILE.limit,
        order_by: [ANCHOR_PROFILE.orderBy],
      };
    }
    case 'referring-domains': {
      // One page of referring domains. `query` is the validator's canonical form. "Dofollow only" is the request's backlinks_filters (the
      // provider then recounts each domain's links using dofollow links only), never one of `filters`.
      const q = query ?? {};
      const filters = toListFilters(q.filters ?? []);
      return {
        target,
        include_subdomains: REFERRING_DOMAINS_QUERY.includeSubdomains,
        backlinks_status_type: q.status ?? REFERRING_DOMAINS_QUERY.defaultStatus,
        ...(q.dofollow ? { backlinks_filters: ['dofollow', '=', true] } : {}),
        internal_list_limit: REFERRING_DOMAINS_QUERY.internalListLimit,
        limit: q.limit ?? REFERRING_DOMAINS_QUERY.defaultLimit,
        ...(q.offset ? { offset: q.offset } : {}),
        order_by: [q.orderBy ?? REFERRING_DOMAINS_QUERY.defaultOrderBy],
        ...(filters ? { filters } : {}),
      };
    }
    case 'domain-pages': {
      // One page of pages. `query` is the validator's canonical form; only LIVE links are asked for. The base condition (backlinks >= 1) is part
      // of `filters`, put there by the page, so it is counted against the 8-condition limit like any other.
      const q = query ?? {};
      const filters = toListFilters(q.filters ?? []);
      return {
        target,
        include_subdomains: DOMAIN_PAGES_QUERY.includeSubdomains,
        backlinks_status_type: DOMAIN_PAGES_QUERY.status,
        internal_list_limit: DOMAIN_PAGES_QUERY.internalListLimit,
        limit: q.limit ?? DOMAIN_PAGES_QUERY.defaultLimit,
        ...(q.offset ? { offset: q.offset } : {}),
        order_by: [q.orderBy ?? DOMAIN_PAGES_QUERY.defaultOrderBy],
        ...(filters ? { filters } : {}),
      };
    }
    case 'tp-counts':
      // THREE count-only requests (an ARRAY of bodies, sent in parallel): every page with backlinks, the error pages with backlinks, the
      // redirects with backlinks. Profile-level: live links, nothing the user filters can change them.
      return [
        pagesCountBody(target, DOMAIN_PAGES_BASE_FILTER),
        pagesCountBody(target, [['status_code', '>=', 400], 'and', DOMAIN_PAGES_BASE_FILTER]),
        pagesCountBody(target, [['status_code', '>=', 300], 'and', ['status_code', '<', 400], 'and', DOMAIN_PAGES_BASE_FILTER]),
      ];
    case 'tp-fix-first':
      // The few error pages (404, 5xx and the blocked 403s) with the most backlinks.
      return {
        ...pagesCountBody(target, [['status_code', '>=', 400], 'and', DOMAIN_PAGES_BASE_FILTER]),
        internal_list_limit: DOMAIN_PAGES_QUERY.internalListLimit,
        limit: TOP_PAGES_FIX_FIRST.limit,
        order_by: [TOP_PAGES_FIX_FIRST.orderBy],
      };
    case 'rd-rank-buckets':
      // ONE count-only request per bucket (an ARRAY of bodies: fetchSection sends them in parallel). Profile-level: live links, no filters
      // besides the rank range, no backlinks_filters — the Dofollow toggle and the table's filters never change them.
      return RANK_BUCKETS.map((b) => countBody(target, b.max === null ? ['rank', '>=', b.min] : [['rank', '>=', b.min], 'and', ['rank', '<=', b.max]]));
    case 'rd-toxic-count':
      return countBody(target, ['backlinks_spam_score', '>', TOXIC_SPAM_ABOVE]);
    case 'rd-last-30': {
      // TWO count-only requests (an ARRAY of bodies, sent in parallel): domains first seen since the window start (live links), and domains whose
      // links were lost since then. The window starts on a Monday so the answer — and its 7-day cache entry — is the same all week.
      const since = windowStartDay(now, RD_LAST_30.days);
      return [countBody(target, ['first_seen', '>=', since]), countBody(target, ['lost_date', '>=', since], 'lost')];
    }
    case 'bulk-traffic': {
      // The project first, then the competitors (the provider answers in a different order: rows are matched by `target`).
      return { targets: query.targets, location_name: market.location_name, language_name: market.language_name, item_types: [...BULK_TRAFFIC.itemTypes] };
    }
    case 'backlinks': {
      // Not market-specific. `query` is the validator's canonical form; without it this is the default view (live, no filter): the
      // dashboard's three cards and the Backlink Overview page both send exactly this, so they share one cache entry.
      const { status, dofollow } = query ?? {};
      return {
        target,
        include_subdomains: BACKLINKS_QUERY.includeSubdomains,
        internal_list_limit: BACKLINKS_QUERY.internalListLimit,
        backlinks_status_type: status ?? BACKLINKS_QUERY.defaultStatus,
        // Only when "Dofollow only" is on; otherwise the field is omitted.
        ...(dofollow ? { backlinks_filters: [...BACKLINKS_QUERY.dofollowFilter] } : {}),
      };
    }
    default: throw new Error(`Unknown section: ${section}`);
  }
}

// ── parsers: provider result -> the slim payload that is cached and sent to the browser ────────────────────────────────

const POSITION_FIELDS = ['pos_1', 'pos_2_3', 'pos_4_10', 'pos_11_20', 'pos_21_30', 'pos_31_40', 'pos_41_50', 'pos_51_60', 'pos_61_70', 'pos_71_80', 'pos_81_90', 'pos_91_100'];
const ORGANIC_FIELDS = ['etv', 'count', 'estimated_paid_traffic_cost', ...POSITION_FIELDS, 'is_new', 'is_up', 'is_down', 'is_lost'];
const PAID_FIELDS = ['etv', 'count', 'estimated_paid_traffic_cost'];

/** result[0].items[0].metrics.{organic, paid}. A domain DataForSEO has no data for gives items: null -> { organic: null, paid: null }. */
export function parseRankOverview(result) {
  const item = Array.isArray(result?.items) ? result.items[0] : null;
  return { organic: pick(item?.metrics?.organic, ORGANIC_FIELDS), paid: pick(item?.metrics?.paid, PAID_FIELDS) };
}

/**
 * result[0].items[] -> one entry per month, in the order the provider sent them (newest first). The month's ORGANIC metrics are
 * flat on the entry (etv, count, estimated_paid_traffic_cost, the 12 pos_* fields, is_new / is_up / is_down / is_lost) — so a
 * consumer that only wants { etv, count } is unaffected — and `paid` carries the paid metrics. A month the provider sent no
 * metrics for keeps its place with every figure null: a gap in the data is not a month of zeros.
 */
export function parseHistory(result) {
  const items = Array.isArray(result?.items) ? result.items : [];
  return {
    items: items
      .map((i) => ({
        year: int(i?.year),
        month: int(i?.month),
        ...(pick(i?.metrics?.organic, ORGANIC_FIELDS) ?? Object.fromEntries(ORGANIC_FIELDS.map((f) => [f, null]))),
        paid: pick(i?.metrics?.paid, PAID_FIELDS),
      }))
      .filter((i) => i.year !== null && i.month !== null && i.month >= 1 && i.month <= 12),
  };
}

/**
 * previous_position: the keyword's previous rank (null = it was not ranking before, i.e. NEW). `rank_changes_known` is false when
 * the provider sent no rank_changes block at all — then nothing is claimed about movement.
 */
export function parseRankedKeyword(item) {
  const keyword = str(item?.keyword_data?.keyword);
  if (!keyword) return null;
  const serp = item?.ranked_serp_element?.serp_item;
  const changes = serp?.rank_changes;
  const known = Boolean(changes && typeof changes === 'object');
  const info = item?.keyword_data?.keyword_info;
  return {
    keyword,
    search_volume: num(info?.search_volume),
    keyword_difficulty: num(item?.keyword_data?.keyword_properties?.keyword_difficulty),
    position: num(serp?.rank_group),
    // rank_group is the position DataForSEO shows; the provider only reports the PREVIOUS rank as an absolute rank, so movement has to be
    // measured absolute-to-absolute (rank_group vs previous_rank_absolute would invent moves for keywords that did not move).
    position_absolute: num(serp?.rank_absolute),
    previous_position: known ? num(changes.previous_rank_absolute) : null,
    rank_changes_known: known,
    etv: num(serp?.etv),
    relative_url: str(serp?.relative_url),
    // ── the rest feeds the Organic Keywords page (the dashboard card ignores it) ──
    type: str(serp?.type),
    // The provider's own movement flags. Null when it sent none: absence is not "no change".
    is_new: known && typeof changes.is_new === 'boolean' ? changes.is_new : null,
    is_up: known && typeof changes.is_up === 'boolean' ? changes.is_up : null,
    is_down: known && typeof changes.is_down === 'boolean' ? changes.is_down : null,
    intent: str(item?.keyword_data?.search_intent_info?.main_intent),
    cpc: num(info?.cpc),
    competition_level: str(info?.competition_level),
    low_top_of_page_bid: num(info?.low_top_of_page_bid),
    high_top_of_page_bid: num(info?.high_top_of_page_bid),
    monthly_searches: parseMonthlySearches(info?.monthly_searches),
    estimated_paid_traffic_cost: num(serp?.estimated_paid_traffic_cost),
    url: str(serp?.url),
    title: str(serp?.title),
    serp_features: Array.isArray(item?.keyword_data?.serp_info?.serp_item_types)
      ? item.keyword_data.serp_info.serp_item_types.filter((t) => typeof t === 'string' && t)
      : [],
    check_url: str(item?.keyword_data?.serp_info?.check_url),
    referring_domains: num(serp?.backlinks_info?.referring_domains),
    backlinks: num(serp?.backlinks_info?.backlinks),
    last_updated_time: str(item?.ranked_serp_element?.last_updated_time),
  };
}

/** keyword_info.monthly_searches -> [{ year, month, search_volume }], months with an unusable year/month dropped, volume null when absent. */
function parseMonthlySearches(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((m) => ({ year: int(m?.year), month: int(m?.month), search_volume: num(m?.search_volume) }))
    .filter((m) => m.year !== null && m.month !== null && m.month >= 1 && m.month <= 12);
}

const KEYWORD_TOTAL_FIELDS = ['count', 'etv', 'pos_1', 'pos_2_3', 'pos_4_10', 'is_new', 'is_up', 'is_down'];

/**
 * `totalCount` = rows matching the request's filters (drives pagination). A filter that matches nothing comes back as
 * `total_count: null, items: null, metrics: null` inside a result: that is 0 matches, not "unknown".
 * `metrics` = organic totals OF THE MATCHING ROWS (live check: with a filter, metrics.count equals the filtered total_count), so they
 * are whole-domain totals only for an unfiltered request; null when the provider sent none.
 */
export function parseRankedKeywords(result) {
  const items = Array.isArray(result?.items) ? result.items : [];
  const total = num(result?.total_count);
  return {
    totalCount: total ?? (result && items.length === 0 ? 0 : null),
    metrics: pick(result?.metrics?.organic, KEYWORD_TOTAL_FIELDS),
    items: items.map(parseRankedKeyword).filter(Boolean),
  };
}

export const normalizeDomain = (d) => String(d || '').trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '');

const SHARED_FIELDS = ['etv', 'pos_1', 'pos_2_3', 'pos_4_10'];
const SITE_TOTAL_FIELDS = ['count', 'etv', 'estimated_paid_traffic_cost'];

/**
 * One row of the competitors list. DataForSEO's names are easy to mix up, so this is the ONE place they are translated:
 *   full_domain_metrics.organic  ->  total              the COMPETITOR's whole site (keywords, traffic, traffic value)
 *   metrics.organic              ->  project_shared     the PROJECT's numbers on the keywords both rank for (live-checked: the
 *                                                       project's own row repeats its totals here)
 *   competitor_metrics.organic   ->  competitor_shared  the COMPETITOR's numbers on those same shared keywords
 * intersections = shared keywords; avg_position = the competitor's average position on them.
 */
function parseCompetitorRow(i) {
  const domain = str(i?.domain);
  if (!domain) return null;
  return {
    domain: normalizeDomain(domain),
    intersections: num(i?.intersections),
    avg_position: num(i?.avg_position),
    total: pick(i?.full_domain_metrics?.organic, SITE_TOTAL_FIELDS),
    project_shared: pick(i?.metrics?.organic, SHARED_FIELDS),
    competitor_shared: pick(i?.competitor_metrics?.organic, SHARED_FIELDS),
  };
}

/**
 * result -> { totalCount, self, items }. The provider returns the project itself as a row (its own totals): it is taken OUT of `items`
 * and handed back as `self`, which the page uses for "You" in the chart and the head-to-head. `totalCount` is the provider's own
 * `total_count` (it counts that row too); a filter that matches nothing arrives as `total_count: null, items: null` = 0, not unknown.
 */
export function parseCompetitors(result, { target }) {
  const list = Array.isArray(result?.items) ? result.items : [];
  const me = normalizeDomain(target);
  const total = num(result?.total_count);
  let self = null;
  const items = [];
  for (const raw of list) {
    const row = parseCompetitorRow(raw);
    if (!row) continue;
    if (row.domain === me) { self ??= row; continue; }
    items.push(row);
  }
  return { totalCount: total ?? (result && list.length === 0 ? 0 : null), self, items };
}

const etvAndCount = (obj) => pick(obj, ['etv', 'count']);

/**
 * Bulk traffic estimation: one entry per target the provider answered, in ITS order (not the request's) — callers match by `target`.
 * Each of organic / paid / featured_snippet / local_pack is { etv, count } or null when the provider has nothing for it.
 */
export function parseBulkTraffic(result) {
  const list = Array.isArray(result?.items) ? result.items : [];
  return {
    items: list
      .map((i) => {
        const target = str(i?.target);
        return target && {
          target: normalizeDomain(target),
          organic: etvAndCount(i?.metrics?.organic),
          paid: etvAndCount(i?.metrics?.paid),
          featured_snippet: etvAndCount(i?.metrics?.featured_snippet),
          local_pack: etvAndCount(i?.metrics?.local_pack),
        };
      })
      .filter(Boolean),
  };
}

const BACKLINK_COUNT_FIELDS = [
  'rank', 'backlinks', 'backlinks_spam_score', 'broken_backlinks', 'broken_pages',
  'referring_domains', 'referring_domains_nofollow', 'referring_main_domains', 'referring_main_domains_nofollow',
  'referring_pages', 'referring_pages_nofollow', 'referring_ips', 'referring_subnets',
  'crawled_pages', 'internal_links_count', 'external_links_count',
];
const BACKLINK_BREAKDOWNS = [
  'referring_links_tld', 'referring_links_types', 'referring_links_attributes', 'referring_links_platform_types',
  'referring_links_semantic_locations', 'referring_links_countries',
];

/** A { key: count } breakdown -> the same with only finite counts; null when the provider sent none (absent is not "empty"). */
function parseBreakdown(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (num(v) !== null) out[k] = v;
  return out;
}

/**
 * Backlinks Summary: the whole profile. Field names are the provider's own (this payload is the one place they are read), counts are
 * numbers or null (never 0 for "unknown"), and each breakdown is a { key: count } object — the empty-string key means "unknown" and
 * "WW" means worldwide; those are labelled by the page. The entries are the provider's top `internal_list_limit` ones, so a
 * breakdown's entries may add up to less than the total.
 */
const bool = (v) => (typeof v === 'boolean' ? v : null);
const clip = (v, n) => { const t = str(v); return t && t.length > n ? `${t.slice(0, n - 1)}…` : t; };
/** Text around a link: clipped, but NOT trimmed — the space between the anchor and the next word is the sentence. null when blank. */
const around = (v, n) => (typeof v === 'string' && v.trim() ? (v.length > n ? `${v.slice(0, n - 1)}…` : v) : null);
const strList = (v, max = 20) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x).slice(0, max) : []);

/** indirect_link_path: the chain of URLs a link passes through (strings, or objects with a url). Anything else is dropped. */
function parseIndirectPath(v) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 10).map((p) => (typeof p === 'string' ? p : str(p?.url) ?? str(p?.url_to) ?? str(p?.url_from))).filter(Boolean);
}

/**
 * One individual backlink. Provider field names are kept (this payload is the only place they are read — the page's mapBacklink turns
 * them into a clean row). Missing values are null, never 0 or ""; the text around the link is clipped so a page of 100 stays small.
 */
export function parseBacklink(i) {
  const urlFrom = str(i?.url_from);
  const domainFrom = str(i?.domain_from);
  if (!urlFrom && !domainFrom) return null;
  return {
    domain_from: domainFrom, url_from: urlFrom, page_from_title: clip(i?.page_from_title, 300),
    page_from_language: str(i?.page_from_language), domain_from_country: str(i?.domain_from_country),
    domain_from_platform_type: strList(i?.domain_from_platform_type), tld_from: str(i?.tld_from), domain_from_ip: str(i?.domain_from_ip),
    url_to: str(i?.url_to), url_to_status_code: int(i?.url_to_status_code), url_to_redirect_target: str(i?.url_to_redirect_target),
    url_to_spam_score: num(i?.url_to_spam_score),
    anchor: clip(i?.anchor, 300), item_type: str(i?.item_type), alt: clip(i?.alt, 300), image_url: str(i?.image_url),
    dofollow: bool(i?.dofollow), attributes: strList(i?.attributes), semantic_location: str(i?.semantic_location),
    text_pre: around(i?.text_pre, 300), text_post: around(i?.text_post, 300), links_count: num(i?.links_count), original: bool(i?.original),
    is_indirect_link: bool(i?.is_indirect_link), indirect_link_path: parseIndirectPath(i?.indirect_link_path),
    rank: num(i?.rank), page_from_rank: num(i?.page_from_rank), domain_from_rank: num(i?.domain_from_rank),
    backlink_spam_score: num(i?.backlink_spam_score),
    page_from_external_links: num(i?.page_from_external_links), page_from_internal_links: num(i?.page_from_internal_links),
    first_seen: str(i?.first_seen), prev_seen: str(i?.prev_seen), last_seen: str(i?.last_seen),
    is_new: bool(i?.is_new), is_lost: bool(i?.is_lost), is_broken: bool(i?.is_broken),
  };
}

/**
 * result -> { totalCount, nextToken, items }. `totalCount` = the links matching the tab and filters (drives the pagination and the
 * tab's count); a filter that matches nothing arrives as `total_count: null, items: null` = 0, not unknown. `nextToken` is the
 * provider's search_after_token for the next batch (null when there is none).
 */
export function parseBacklinksList(result) {
  const list = Array.isArray(result?.items) ? result.items : [];
  const total = num(result?.total_count);
  return {
    totalCount: total ?? (result && list.length === 0 ? 0 : null),
    nextToken: str(result?.search_after_token),
    items: list.map(parseBacklink).filter(Boolean),
  };
}

// ── domain pages (API 10) ──

/** A count-only request: limit 1, live links, the given filter. Only `total_count` is read. */
function pagesCountBody(target, filters) {
  return {
    target,
    include_subdomains: DOMAIN_PAGES_QUERY.includeSubdomains,
    backlinks_status_type: DOMAIN_PAGES_QUERY.status,
    internal_list_limit: 1,
    limit: 1,
    order_by: [DOMAIN_PAGES_QUERY.defaultOrderBy],
    filters,
  };
}

const PAGE_COUNTS = [
  'rank', 'backlinks', 'backlinks_spam_score', 'broken_backlinks', 'broken_pages', 'referring_domains', 'referring_domains_nofollow',
  'referring_main_domains', 'referring_pages', 'referring_pages_nofollow', 'referring_ips', 'referring_subnets',
];
const PAGE_BREAKDOWNS = [
  'referring_links_types', 'referring_links_attributes', 'referring_links_platform_types', 'referring_links_semantic_locations',
  'referring_links_countries', 'referring_links_tld',
];

/** meta.technologies is { category: name | [names] }: its values, as a short list of names. */
function technologyNames(t) {
  if (Array.isArray(t)) return strList(t, 15);
  if (!t || typeof t !== 'object') return [];
  const out = [];
  for (const v of Object.values(t)) for (const name of (Array.isArray(v) ? v : [v])) if (typeof name === 'string' && name && !out.includes(name)) out.push(name);
  return out.slice(0, 15);
}

/**
 * One page (API 10). Provider fields are kept (this payload is the only place they are read); the values the page and the CSV need are
 * computed ONCE, here, and cached with the row: `normalized_url`, `status_group`, `dofollow_pct`, `suggested_fix` (for error and blocked pages).
 * The traffic and the opportunity flags are NOT here: they come from a separate cache and are joined when a response is built.
 * meta is often empty for redirects and errors: every missing value is null, never 0 or "".
 */
export function parseDomainPage(i) {
  const url = str(i?.page);
  if (!url) return null;
  const meta = i?.meta && typeof i.meta === 'object' ? i.meta : {};
  const ps = i?.page_summary && typeof i.page_summary === 'object' ? i.page_summary : {};
  const statusCode = int(i?.status_code);
  const statusGroup = getStatusGroup(statusCode);
  return {
    url,
    domain: str(i?.domain),
    status_code: statusCode,
    location: str(i?.location),
    media_type: str(i?.media_type),
    server: str(i?.server),
    fetch_time: str(i?.fetch_time),
    first_visited: str(i?.first_visited),
    prev_visited: str(i?.prev_visited),
    title: clip(meta.title, 300),
    canonical: str(meta.canonical),
    h1: strList(meta.h1, 3).map((h) => (h.length > 200 ? `${h.slice(0, 199)}…` : h)),
    language: str(meta.language),
    words_count: num(meta.words_count),
    internal_links_count: num(meta.internal_links_count),
    external_links_count: num(meta.external_links_count),
    images_count: num(meta.images_count),
    page_spam_score: num(meta.page_spam_score),
    technologies: technologyNames(meta.technologies),
    ...Object.fromEntries(PAGE_COUNTS.map((f) => [f, num(ps[f])])),
    first_seen: str(ps.first_seen),
    lost_date: str(ps.lost_date),
    ...Object.fromEntries(PAGE_BREAKDOWNS.map((f) => [f, parseBreakdown(ps[f])])),
    normalized_url: normalizePageUrl(url),
    // The page names another URL as its canonical (the same page found as http / www / a trailing slash is NOT another URL). null when it names none.
    canonical_differs: str(meta.canonical) ? normalizePageUrl(meta.canonical) !== normalizePageUrl(url) : null,
    status_group: statusGroup,
    dofollow_pct: dofollowFromDomains(ps),
    suggested_fix: statusGroup === 'error' || statusGroup === 'blocked' ? suggestFix(statusCode) : null,
  };
}

/** Referring domains that follow ÷ referring domains, 0–100. null when either figure is unknown or there are none. */
function dofollowFromDomains(ps) {
  const rd = num(ps.referring_domains);
  const nofollow = num(ps.referring_domains_nofollow);
  if (rd === null || nofollow === null || rd <= 0) return null;
  return Math.min(100, Math.max(0, ((rd - nofollow) / rd) * 100));
}

/** result -> { totalCount, items }. A filter that matches nothing arrives as total_count: null, items: null = 0, not unknown. */
export function parseDomainPages(result) {
  const list = Array.isArray(result?.items) ? result.items : [];
  const total = num(result?.total_count);
  return { totalCount: total ?? (result && list.length === 0 ? 0 : null), items: list.map(parseDomainPage).filter(Boolean) };
}

// ── referring domains (API 9) ──

/** A count-only request: limit 1, live links, the given filter. Only `total_count` is read. */
function countBody(target, filters, status = 'live') {
  return {
    target,
    include_subdomains: REFERRING_DOMAINS_QUERY.includeSubdomains,
    backlinks_status_type: status,
    internal_list_limit: 1,
    limit: 1,
    order_by: [REFERRING_DOMAINS_QUERY.defaultOrderBy],
    filters,
  };
}

const RD_COUNTS = [
  'rank', 'backlinks', 'backlinks_spam_score', 'broken_backlinks', 'broken_pages', 'referring_pages', 'referring_pages_nofollow',
  'referring_ips', 'referring_subnets',
];
const RD_BREAKDOWNS = [
  'referring_links_types', 'referring_links_attributes', 'referring_links_platform_types', 'referring_links_semantic_locations',
  'referring_links_countries', 'referring_links_tld',
];

/**
 * One referring domain, with the values the page and the CSV need computed ONCE, here (cached with the row): `quality`,
 * `dofollow_pct`, `is_sitewide`, `top_country`, `main_placement`. Counts are numbers or null — never 0 for "unknown".
 */
export function parseReferringDomain(i) {
  const domain = typeof i?.domain === 'string' && i.domain.trim() ? i.domain.trim().toLowerCase() : null;
  if (!domain) return null;
  const row = {
    domain,
    ...Object.fromEntries(RD_COUNTS.map((f) => [f, num(i[f])])),
    first_seen: str(i.first_seen),
    lost_date: str(i.lost_date),
    ...Object.fromEntries(RD_BREAKDOWNS.map((f) => [f, parseBreakdown(i[f])])),
  };
  const dofollowPct = dofollowPercent(row.referring_pages, row.referring_pages_nofollow);
  return {
    ...row,
    dofollow_pct: dofollowPct,
    quality: classifyDomainQuality({ rank: row.rank, spamScore: row.backlinks_spam_score, backlinks: row.backlinks, dofollowPct }),
    is_sitewide: isSitewide(row.referring_pages, row.referring_links_semantic_locations),
    top_country: topKey(row.referring_links_countries),
    main_placement: topKey(row.referring_links_semantic_locations),
  };
}

/** result -> { totalCount, items }. A filter that matches nothing arrives as total_count: null, items: null = 0, not unknown. */
export function parseReferringDomains(result) {
  const list = Array.isArray(result?.items) ? result.items : [];
  const total = num(result?.total_count);
  return { totalCount: total ?? (result && list.length === 0 ? 0 : null), items: list.map(parseReferringDomain).filter(Boolean) };
}

/** A count-only answer: total_count (null with no items = 0). null when the provider said nothing at all. */
export function parseCountResult(result) {
  const total = num(result?.total_count);
  return total ?? (result ? 0 : null);
}

// ── anchors (API 8) ──

/** The anchor text as the provider sent it: NOT trimmed (an exact-match filter must find it again), null when absent or blank. */
const anchorText = (v) => (typeof v === 'string' && v.trim() ? v.slice(0, 1000) : null);

const ANCHOR_COUNTS = [
  'rank', 'backlinks', 'backlinks_spam_score', 'broken_backlinks', 'broken_pages', 'referring_domains', 'referring_domains_nofollow',
  'referring_main_domains', 'referring_pages', 'referring_pages_nofollow', 'referring_ips', 'referring_subnets',
];
const ANCHOR_BREAKDOWNS = [
  'referring_links_types', 'referring_links_attributes', 'referring_links_platform_types', 'referring_links_semantic_locations',
  'referring_links_countries', 'referring_links_tld',
];

/** One anchor row. `anchor` is null for links without text (image links). Counts are numbers or null — never 0 for "unknown". */
export function parseAnchor(i, { slim = false } = {}) {
  if (!i || typeof i !== 'object') return null;
  const row = {
    anchor: anchorText(i.anchor),
    ...Object.fromEntries(ANCHOR_COUNTS.map((f) => [f, num(i[f])])),
    first_seen: str(i.first_seen),
    lost_date: str(i.lost_date),
  };
  if (slim) {
    // The profile keeps only what the distribution, the cards and the CSV need (1,000 rows with breakdowns would be ~0.7 MB).
    return {
      anchor: row.anchor, rank: row.rank, backlinks: row.backlinks, backlinks_spam_score: row.backlinks_spam_score,
      broken_backlinks: row.broken_backlinks, referring_domains: row.referring_domains, referring_domains_nofollow: row.referring_domains_nofollow,
      first_seen: row.first_seen,
    };
  }
  return { ...row, ...Object.fromEntries(ANCHOR_BREAKDOWNS.map((f) => [f, parseBreakdown(i[f])])) };
}

/** result -> { totalCount, items }. A filter that matches nothing arrives as total_count: null, items: null = 0, not unknown. */
export function parseAnchors(result, opts = {}) {
  const list = Array.isArray(result?.items) ? result.items : [];
  const total = num(result?.total_count);
  return {
    totalCount: total ?? (result && list.length === 0 ? 0 : null),
    items: list.map((i) => parseAnchor(i, opts)).filter(Boolean),
  };
}

export const parseAnchorProfile = (result) => parseAnchors(result, { slim: true });

export function parseBacklinksSummary(result) {
  const info = result?.info;
  return {
    ...Object.fromEntries(BACKLINK_COUNT_FIELDS.map((f) => [f, num(result?.[f])])),
    first_seen: str(result?.first_seen),
    lost_date: str(result?.lost_date),
    info: {
      cms: str(info?.cms),
      server: str(info?.server),
      ip_address: str(info?.ip_address),
      country: str(info?.country),
      platform_type: Array.isArray(info?.platform_type) ? info.platform_type.filter((t) => typeof t === 'string' && t) : [],
      target_spam_score: num(info?.target_spam_score),
    },
    ...Object.fromEntries(BACKLINK_BREAKDOWNS.map((f) => [f, parseBreakdown(result?.[f])])),
  };
}

const PARSERS = {
  'rank-overview': parseRankOverview,
  'history': parseHistory,
  'ranked-keywords': parseRankedKeywords,
  'competitors': parseCompetitors,
  'backlinks': parseBacklinksSummary,
  'bulk-traffic': parseBulkTraffic,
  'backlinks-list': parseBacklinksList,
  'anchors': (result) => parseAnchors(result),
  'referring-domains': parseReferringDomains,
  'rd-toxic-count': (result) => ({ count: parseCountResult(result), spamAbove: TOXIC_SPAM_ABOVE }),
  'domain-pages': parseDomainPages,
  'tp-fix-first': parseDomainPages,
  'anchor-profile': parseAnchorProfile,
};

/**
 * Validate a full provider response and reduce it to the slim payload. status_code must be 20000 at the top level AND on the
 * task; anything else throws a DataForSeoApiError. `result: []` is a real "nothing found" (empty payload); a non-array
 * `result` is malformed.
 */
export function parseSectionResponse(section, data, { target }) {
  const task = requireOkTask(data);
  if (!Array.isArray(task.result)) throw new DataForSeoApiError(DATAFORSEO_ERROR.MALFORMED_RESPONSE);
  const result = task.result[0] ?? null;
  if (result !== null && typeof result !== 'object') throw new DataForSeoApiError(DATAFORSEO_ERROR.MALFORMED_RESPONSE);
  return { payload: PARSERS[section](result, { target }), cost: num(task.cost) ?? num(data.cost) };
}

// ── transport ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const defaultTransport = {
  'rank-overview': (body, opts) => DataForSeoService.postDomainRankOverview(body, opts),
  'history': (body, opts) => DataForSeoService.postHistoricalRankOverview(body, opts),
  'ranked-keywords': (body, opts) => DataForSeoService.postRankedKeywords(body, opts),
  'competitors': (body, opts) => DataForSeoService.postCompetitorsDomain(body, opts),
  'bulk-traffic': (body, opts) => DataForSeoService.postBulkTrafficEstimation(body, opts),
  'backlinks-list': (body, opts) => DataForSeoService.postBacklinksList(body, opts),
  'anchors': (body, opts) => DataForSeoService.postBacklinksAnchors(body, opts),
  'referring-domains': (body, opts) => DataForSeoService.postBacklinksReferringDomains(body, opts),
  'rd-rank-buckets': (body, opts) => DataForSeoService.postBacklinksReferringDomains(body, opts),
  'domain-pages': (body, opts) => DataForSeoService.postBacklinksDomainPages(body, opts),
  'tp-counts': (body, opts) => DataForSeoService.postBacklinksDomainPages(body, opts),
  'tp-fix-first': (body, opts) => DataForSeoService.postBacklinksDomainPages(body, opts),
  'rd-toxic-count': (body, opts) => DataForSeoService.postBacklinksReferringDomains(body, opts),
  'rd-last-30': (body, opts) => DataForSeoService.postBacklinksReferringDomains(body, opts),
  'anchor-profile': (body, opts) => DataForSeoService.postBacklinksAnchors(body, opts),
  'backlinks': (body, opts) => DataForSeoService.postBacklinksSummary(body, opts),
};
let transport = defaultTransport;

/** Replace the HTTP call (per section, partial overrides allowed). Tests only: no real credits are spent by the test suite. */
export function __setTransportForTests(overrides) {
  transport = overrides ? { ...defaultTransport, ...overrides } : defaultTransport;
}

export const PROVIDER_TIMEOUT_MS = Number.parseInt(process.env.DATAFORSEO_DOMAIN_OVERVIEW_TIMEOUT_MS, 10) || 60_000;

/** One billed call. Resolves to { payload, cost }; rejects with a DataForSeoApiError only. */
export async function fetchSection(section, { target, market, now = new Date(), months, query, excludeDomains }) {
  if (!hasCredentials()) throw new DataForSeoApiError(DATAFORSEO_ERROR.NOT_CONFIGURED);
  if (section === 'rd-rank-buckets') return fetchRankBuckets(target);
  if (section === 'tp-counts') return fetchPageCounts(target);
  if (section === 'rd-last-30') return fetchLast30(target, now);
  let data;
  try {
    data = await transport[section](buildRequest(section, { target, market, now, months, query, excludeDomains }), { timeoutMs: PROVIDER_TIMEOUT_MS });
  } catch (err) {
    throw classifyProviderError(err);
  }
  return parseSectionResponse(section, data, { target });
}

/**
 * The rank distribution: one count-only call per bucket, in PARALLEL. All five must succeed (a distribution with a missing bar would be a
 * wrong picture), and the cost is their sum. Resolves to { payload: { buckets: [{ key, min, max, count }] }, cost }.
 */
async function fetchRankBuckets(target) {
  const bodies = buildRequest('rd-rank-buckets', { target });
  let responses;
  try {
    responses = await Promise.all(bodies.map((body) => transport['rd-rank-buckets'](body, { timeoutMs: PROVIDER_TIMEOUT_MS })));
  } catch (err) {
    throw classifyProviderError(err);
  }
  let cost = 0;
  const buckets = responses.map((data, i) => {
    const task = requireOkTask(data);
    if (!Array.isArray(task.result)) throw new DataForSeoApiError(DATAFORSEO_ERROR.MALFORMED_RESPONSE);
    cost += num(task.cost) ?? num(data.cost) ?? 0;
    const count = parseCountResult(task.result[0] ?? null);
    if (count === null) throw new DataForSeoApiError(DATAFORSEO_ERROR.MALFORMED_RESPONSE);
    return { key: RANK_BUCKETS[i].key, min: RANK_BUCKETS[i].min, max: RANK_BUCKETS[i].max, count };
  });
  return { payload: { buckets }, cost };
}

/**
 * "Referring domains - last 30 days": two count-only calls, in PARALLEL (new, lost). Both must succeed. Resolves to
 * { payload: { since, days, new, lost }, cost } - `since` is the Monday the window starts on.
 */
async function fetchLast30(target, now) {
  const bodies = buildRequest('rd-last-30', { target, now });
  let responses;
  try {
    responses = await Promise.all(bodies.map((body) => transport['rd-last-30'](body, { timeoutMs: PROVIDER_TIMEOUT_MS })));
  } catch (err) {
    throw classifyProviderError(err);
  }
  let cost = 0;
  const counts = responses.map((data) => {
    const task = requireOkTask(data);
    if (!Array.isArray(task.result)) throw new DataForSeoApiError(DATAFORSEO_ERROR.MALFORMED_RESPONSE);
    cost += num(task.cost) ?? num(data.cost) ?? 0;
    const count = parseCountResult(task.result[0] ?? null);
    if (count === null) throw new DataForSeoApiError(DATAFORSEO_ERROR.MALFORMED_RESPONSE);
    return count;
  });
  return { payload: { since: windowStartDay(now, RD_LAST_30.days), days: RD_LAST_30.days, new: counts[0], lost: counts[1] }, cost };
}

/**
 * The Top Pages headline counts: three count-only calls, in PARALLEL. All three must succeed (a card with a made-up zero would be wrong).
 * Resolves to { payload: { pages, errors, redirects }, cost }.
 */
async function fetchPageCounts(target) {
  const bodies = buildRequest('tp-counts', { target });
  let responses;
  try {
    responses = await Promise.all(bodies.map((body) => transport['tp-counts'](body, { timeoutMs: PROVIDER_TIMEOUT_MS })));
  } catch (err) {
    throw classifyProviderError(err);
  }
  let cost = 0;
  const counts = responses.map((data) => {
    const task = requireOkTask(data);
    if (!Array.isArray(task.result)) throw new DataForSeoApiError(DATAFORSEO_ERROR.MALFORMED_RESPONSE);
    cost += num(task.cost) ?? num(data.cost) ?? 0;
    const count = parseCountResult(task.result[0] ?? null);
    if (count === null) throw new DataForSeoApiError(DATAFORSEO_ERROR.MALFORMED_RESPONSE);
    return count;
  });
  return { payload: { pages: counts[0], errors: counts[1], redirects: counts[2] }, cost };
}
