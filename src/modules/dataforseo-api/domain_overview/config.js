/**
 * Domain Overview (+ Traffic History, Organic Keywords, Competitors): the DataForSEO calls behind the pages, how long each response is
 * cached, and what the browser may ask of the paged sections. The competitor exclude list is NOT here: it is saved per project
 * (SeoProject.excluded_competitors). Edit this file (not the code that uses it) to change any of these numbers.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * section (the URL segment the browser asks for) -> the DataForSEO endpoint it reads and its cache lifetime.
 * `endpoint` is the cache namespace; the historical overview costs ~$0.14 per call, hence 7 days.
 */
export const SECTIONS = Object.freeze({
  'rank-overview':   { endpoint: 'labs/domain_rank_overview',      ttlMs: 24 * HOUR },
  // "/v2": the cached payload carries every monthly metric (Traffic History), not just etv + count. Entries cached under the old,
  // slimmer name are simply never read again and expire on their own TTL.
  'history':         { endpoint: 'labs/historical_rank_overview/v2', ttlMs: 7 * DAY },
  // "/v2": rows now carry everything the Organic Keywords page shows (intent, CPC, monthly volume, SERP features, URL ...) plus the
  // whole-domain totals. Entries cached under the old, slim name are never read again and expire on their own TTL.
  'ranked-keywords': { endpoint: 'labs/ranked_keywords/v2',       ttlMs: 24 * HOUR },
  // "/v2": rows now carry the project's and the competitor's numbers on the shared keywords, and a page of results can be asked for
  // (paging / sorting / filtering / the exclusion list), so the old top-20 entries are never read again and expire on their own TTL.
  'competitors':     { endpoint: 'labs/competitors_domain/v2',     ttlMs: 24 * HOUR },
  // "/v2": the payload now carries the whole profile (breakdowns, broken links, site info) and the request body is the Backlink
  // Overview page's default view, so the old slim entries are never read again and expire on their own TTL.
  'backlinks':       { endpoint: 'backlinks/summary/v2',           ttlMs: 24 * HOUR },
  // The Backlinks page: individual links (API 7). Each page of rows / sort / filter is its own entry.
  'backlinks-list':  { endpoint: 'backlinks/backlinks',          ttlMs: 24 * HOUR },
  // The Anchors page (API 8): one page of anchors (24 h), and the whole-profile call behind the distribution (7 days).
  'anchors':         { endpoint: 'backlinks/anchors',            ttlMs: 24 * HOUR },
  'anchor-profile':  { endpoint: 'backlinks/anchors/profile',    ttlMs: 7 * DAY },
  // The Referring Domains page (API 9): one page of domains (24 h), and two PROFILE-LEVEL count cards (7 days): the rank distribution
  // (five count-only calls, cached together) and the number of toxic (spam > 30) domains. Both always describe the live profile.
  'referring-domains': { endpoint: 'backlinks/referring_domains',                ttlMs: 24 * HOUR },
  'rd-rank-buckets':   { endpoint: 'backlinks/referring_domains/rank-buckets',   ttlMs: 7 * DAY },
  'rd-toxic-count':    { endpoint: 'backlinks/referring_domains/toxic-count',    ttlMs: 7 * DAY },
  // The Top Pages page (API 10): one page of pages (24 h), and three PROFILE-LEVEL pieces (7 days): the three headline counts, the "Fix first"
  // list, and the traffic per page joined from the Organic Keywords data (one ranked-keywords call of up to 1,000 rows).
  'domain-pages':      { endpoint: 'backlinks/domain_pages',                 ttlMs: 24 * HOUR },
  'tp-counts':         { endpoint: 'backlinks/domain_pages/counts',          ttlMs: 7 * DAY },
  'tp-fix-first':      { endpoint: 'backlinks/domain_pages/fix-first',       ttlMs: 7 * DAY },
  'top-pages-traffic': { endpoint: 'backlinks/domain_pages/traffic',         ttlMs: 7 * DAY },
  // The Competitors page's Compare section (API 5). Not on the dashboard.
  'bulk-traffic':    { endpoint: 'labs/bulk_traffic_estimation',   ttlMs: 24 * HOUR },
  // The Domain Overview's "Referring domains - last 30 days": two count-only calls (new, lost). The window starts on a Monday, so the key is stable for 7 days.
  'rd-last-30':      { endpoint: 'backlinks/referring_domains/last-30', ttlMs: 7 * DAY },
});

/** The "last 30 days" window of the Domain Overview's referring-domains tiles: today minus `days`, rounded DOWN to the Monday of that ISO week. */
export const RD_LAST_30 = Object.freeze({ days: 30 });
/** Sections that can be PEEKED (`?peek=1`): answered from the cache only, never with a provider call. */
export const PEEKABLE_SECTIONS = Object.freeze(['anchor-profile', 'bulk-traffic']);

export const SECTION_NAMES = Object.freeze(Object.keys(SECTIONS));

/** Used when the project has no usable country / language. */
export const DEFAULT_MARKET = Object.freeze({ location_name: 'India', language_name: 'English' });

/** Months of history requested by default (the Domain Overview's chart, and the Traffic History page until the user asks for more). */
export const HISTORY_MONTHS = 12;
/**
 * Windows the browser may ask for. The provider charges ~$0.01 per month of data, so 24 months (~$0.26) is only bought when the
 * user picks it; 6 is accepted but the Traffic History page serves it by slicing the 12-month response instead.
 */
export const HISTORY_MONTH_OPTIONS = Object.freeze([6, 12, 24]);
export const RANKED_KEYWORDS_LIMIT = 5;

/**
 * What the browser may ask of the ranked-keywords section (Organic Keywords page). Everything the browser sends is checked against
 * these lists before a billed call can happen — the provider is paid per request and per row, so nothing is passed through as-is.
 * Paths are DataForSEO's own field paths.
 */
const ROW = 'ranked_serp_element.serp_item';
export const RANKED_KEYWORDS_QUERY = Object.freeze({
  /** Rows per request: the dashboard card (5), the page sizes (25 / 50 / 100) and "export all" (1000, the provider's maximum). */
  limits: Object.freeze([RANKED_KEYWORDS_LIMIT, 25, 50, 100, 1000]),
  /** Provider cap on `offset`. */
  maxOffset: 9999,
  /** Provider cap on conditions in one `filters` array. */
  maxFilterConditions: 8,
  defaultOrderBy: `${ROW}.etv,desc`,
  /** Sortable fields (DataForSEO paths). */
  orderFields: Object.freeze([
    `${ROW}.etv`, `${ROW}.rank_group`, 'keyword_data.keyword_info.search_volume',
    'keyword_data.keyword_properties.keyword_difficulty', 'keyword_data.keyword_info.cpc', 'keyword_data.keyword',
  ]),
  intents: Object.freeze(['informational', 'navigational', 'commercial', 'transactional']),
  /** Filterable fields: allowed operators and the kind/range of value each takes. `like` patterns must be `%text%`. */
  /** The Domain Overview's Brand keywords: up to this many brand terms joined with "or" (every term counts toward maxFilterConditions). */
  orGroups: Object.freeze({ fields: Object.freeze(['keyword_data.keyword']), op: 'like', maxItems: 6 }),
  filterFields: Object.freeze({
    'keyword_data.keyword': { ops: ['like', 'not_like'], kind: 'pattern' },
    [`${ROW}.relative_url`]: { ops: ['like'], kind: 'pattern' },
    [`${ROW}.rank_group`]: { ops: ['<=', '>='], kind: 'number', min: 1, max: 100, integer: true },
    'keyword_data.keyword_info.search_volume': { ops: ['<=', '>='], kind: 'number', min: 0, max: 1e9, integer: true },
    'keyword_data.keyword_properties.keyword_difficulty': { ops: ['<=', '>='], kind: 'number', min: 0, max: 100, integer: true },
    'keyword_data.search_intent_info.main_intent': { ops: ['in'], kind: 'intents' },
    [`${ROW}.rank_changes.is_new`]: { ops: ['='], kind: 'true' },
    [`${ROW}.rank_changes.is_up`]: { ops: ['='], kind: 'true' },
    [`${ROW}.rank_changes.is_down`]: { ops: ['='], kind: 'true' },
  }),
  patternMaxLength: 100,
});

/** Ranked-keywords requests that are not the dashboard's default call (paging / sorting / filtering), per user per window. Cache hits count too. */
export const RANKED_KEYWORDS_QUERY_LIMIT = Object.freeze({ windowMs: 15 * 60 * 1000, max: 300 });
/**
 * What the browser may ask of the competitors section (Domain Overview card + Competitors page): ONE request shape, so the card and
 * the page's default view share a cache entry. The default is the page's default view: 50 rows from the first, by relevance, the
 * world's largest sites hidden by the provider (`exclude_top_domains`), domains ranking anywhere in the top 100.
 * The project's own exclude list (`exclude_domains`) is never sent by the browser: the server reads it from the project.
 */
export const COMPETITORS_QUERY = Object.freeze({
  limits: Object.freeze([25, 50, 100]),
  defaultLimit: 50,
  /** Provider cap on `offset` (the same conservative cap as the keywords). */
  maxOffset: 9999,
  maxFilterConditions: 8,
  /**
   * "Relevance" = most shared keywords first: the provider's own default order (live-checked: `relevance` is not a field, and an
   * omitted order_by returns exactly the `intersections,desc` order).
   */
  defaultOrderBy: 'intersections,desc',
  /**
   * Sortable fields (DataForSEO paths). Live-checked 2026-10-27: the provider REJECTS `full_domain_metrics.organic.*` ("Invalid Field:
   * 'order_by'"), so the competitor's whole-site keywords / traffic cannot be sorted on the server. `competitor_metrics.organic.etv`
   * is the competitor's traffic on the keywords both rank for.
   */
  orderFields: Object.freeze(['intersections', 'avg_position', 'competitor_metrics.organic.etv']),
  /** "Top 10 competitors only" sends 10; otherwise 100. */
  maxRankGroups: Object.freeze([10, 100]),
  defaultMaxRankGroup: 100,
  defaultExcludeTopDomains: true,
  /**
   * Filterable fields: allowed operators and the range of value each takes. Live-checked: like sorting, the provider REJECTS
   * `full_domain_metrics.organic.*` as a filter ("Invalid Field: 'filters'"), so only the shared-keyword fields are offered.
   */
  filterFields: Object.freeze({
    intersections: { ops: ['>=', '<='], kind: 'number', min: 0, max: 1e9, integer: true },
    avg_position: { ops: ['>=', '<='], kind: 'number', min: 1, max: 100 },
  }),
  /** The project's saved lists (competitor settings). */
  maxExcludedDomains: 1000,
  maxTrackedDomains: 10,
});

/** Competitors requests that are not the default view (paging / sorting / filtering / toggles), per user per window. Cache hits count too. */
export const COMPETITORS_QUERY_LIMIT = Object.freeze({ windowMs: 15 * 60 * 1000, max: 300 });

/** Compare section (API 5): up to this many domains besides the project itself, and what is asked about each. */
export const BULK_TRAFFIC = Object.freeze({
  maxExtraTargets: COMPETITORS_QUERY.maxTrackedDomains,
  itemTypes: Object.freeze(['organic', 'paid', 'featured_snippet', 'local_pack']),
});
/** Every distinct set of targets is a distinct paid call, so these get their own, tighter limit. */
export const BULK_TRAFFIC_LIMIT = Object.freeze({ windowMs: 15 * 60 * 1000, max: 60 });

/**
 * What the browser may ask of the backlinks section (Domain Overview's three cards + the Backlink Overview page): ONE request shape.
 * The default is the page's default view, so the dashboard and the page share a cache entry. `include_subdomains` and
 * `internal_list_limit` are fixed (not browser choices) but are part of the cache key, so a change here can never be answered from
 * an entry computed with other values.
 */
export const BACKLINKS_QUERY = Object.freeze({
  statuses: Object.freeze(['live', 'lost', 'all']),
  defaultStatus: 'live',
  includeSubdomains: true,
  /** Entries returned in each referring_links_* breakdown (the provider's default is 10, max 1000). */
  internalListLimit: 20,
  /** The only backlinks_filters value the page offers ("Dofollow only"). */
  dofollowFilter: Object.freeze(['dofollow', '=', true]),
});
/** Non-default backlinks requests (Lost / All / Dofollow only), per user per window. At most 6 combinations exist and each is cached. */
export const BACKLINKS_QUERY_LIMIT = Object.freeze({ windowMs: 15 * 60 * 1000, max: 120 });

/**
 * What the browser may ask of the anchors section (the Anchors page, API 8). Field names are DataForSEO's own and were live-checked
 * (note the spam field is `backlinks_spam_score` here, but `backlink_spam_score` on the individual-backlinks endpoint).
 */
export const ANCHORS_QUERY = Object.freeze({
  statuses: Object.freeze(['live', 'lost', 'all']),
  defaultStatus: 'live',
  includeSubdomains: true,
  /** Entries returned in each referring_links_* breakdown (what the expanded row charts). */
  internalListLimit: 10,
  limits: Object.freeze([25, 50, 100]),
  defaultLimit: 50,
  /** offset + limit may not pass this (the provider's window). */
  maxOffsetWindow: 20000,
  /** The ONE sort rule ("<field>,<asc|desc>"): ranks anchors by how many different sites use them. */
  defaultOrderBy: 'referring_domains,desc',
  orderFields: Object.freeze(['backlinks', 'referring_domains', 'rank', 'backlinks_spam_score', 'broken_backlinks', 'first_seen']),
  maxFilterConditions: 8,
  patternMaxLength: 100,
  filterFields: Object.freeze({
    // like / not_like = contains (%text%); "=" = exactly this anchor, "" meaning links with no anchor text (live-checked).
    anchor: { ops: ['like', 'not_like', '='], kind: 'patternOrText', maxLength: 1000 },
    referring_domains: { ops: ['>='], kind: 'number', min: 0, max: 100000000, integer: true },
    backlinks: { ops: ['>='], kind: 'number', min: 0, max: 1000000000, integer: true },
    backlinks_spam_score: { ops: ['<='], kind: 'number', min: 0, max: 100, integer: true },
    // "Has broken links" is exactly broken_backlinks > 0.
    broken_backlinks: { ops: ['>'], kind: 'number', min: 0, max: 0, integer: true },
    first_seen: { ops: ['>='], kind: 'date' },
  }),
});

/**
 * The anchor profile (the distribution, the summary cards, "Export all anchors"): ONE fixed request, never a browser choice. Breakdowns
 * are not used, so `internalListLimit` is 1 (and the cached payload keeps no breakdowns). The cache entry lives 7 days.
 */
export const ANCHOR_PROFILE = Object.freeze({
  status: 'live',
  limit: 1000,
  orderBy: 'referring_domains,desc',
  internalListLimit: 1,
  includeSubdomains: true,
});

/** Anchors requests (every page / sort / filter / status is a distinct paid call), per user per window. Cache hits count too. */
export const ANCHORS_QUERY_LIMIT = Object.freeze({ windowMs: 15 * 60 * 1000, max: 200 });

/** The project's saved brand terms and target keywords (SeoProject.anchor_*): how many, and how long each may be. */
export const ANCHOR_SETTINGS = Object.freeze({ maxBrandTerms: 20, maxTargetKeywords: 100, maxTermLength: 80 });
export const ANCHOR_SETTINGS_WRITE_LIMIT = Object.freeze({ windowMs: 15 * 60 * 1000, max: 120 });

/**
 * What the browser may ask of the referring-domains section (the Referring Domains page, API 9). Field names are DataForSEO's own and
 * were live-checked. `dofollow` is NOT a filter: it is the request's `backlinks_filters` (the provider then counts each domain's links
 * using dofollow links only).
 */
export const REFERRING_DOMAINS_QUERY = Object.freeze({
  statuses: Object.freeze(['live', 'lost']),
  defaultStatus: 'live',
  includeSubdomains: true,
  /** Entries returned in each referring_links_* breakdown (what the expanded row charts). */
  internalListLimit: 10,
  limits: Object.freeze([25, 50, 100, 1000]),
  defaultLimit: 50,
  /** offset + limit may not pass this (the provider's window). */
  maxOffsetWindow: 20000,
  /** The ONE sort rule ("<field>,<asc|desc>"): the strongest domains first. */
  defaultOrderBy: 'rank,desc',
  orderFields: Object.freeze(['rank', 'backlinks', 'referring_pages', 'backlinks_spam_score', 'broken_backlinks', 'first_seen']),
  maxFilterConditions: 8,
  patternMaxLength: 100,
  /** The Disavowed tab asks for its page of the saved list with domain "in" [...]: at most this many per request. */
  maxInDomains: 100,
  filterFields: Object.freeze({
    domain: { ops: ['like', 'not_like', 'in'], kind: 'domainOrPattern', maxItems: 100 },
    rank: { ops: ['>=', '<='], kind: 'number', min: 0, max: 1000, integer: true },
    backlinks_spam_score: { ops: ['<=', '>'], kind: 'number', min: 0, max: 100, integer: true },
    backlinks: { ops: ['>='], kind: 'number', min: 0, max: 1000000000, integer: true },
    // "Has broken links" is exactly broken_backlinks > 0.
    broken_backlinks: { ops: ['>'], kind: 'number', min: 0, max: 0, integer: true },
    first_seen: { ops: ['>='], kind: 'date' },
  }),
});

/**
 * Domain quality, decided ON THE SERVER (one place) and sent with every row as `quality`. Percentages are 0–100.
 *  high:   rank >= 300 and spam <= 10        medium: rank >= 150 and spam <= 30
 *  toxic:  spam > 30, OR (rank < 50 and backlinks >= 100 and dofollow share < 10%)
 *  low:    everything else with a known rank and spam score
 * A row is "sitewide" when it has at least `sitewide.pages` referring pages, or when footer links are at least `sitewide.footerShare` of them.
 */
export const DOMAIN_QUALITY = Object.freeze({
  high: Object.freeze({ minRank: 300, maxSpam: 10 }),
  medium: Object.freeze({ minRank: 150, maxSpam: 30 }),
  toxic: Object.freeze({ spamAbove: 30, lowRank: Object.freeze({ rankBelow: 50, minBacklinks: 100, dofollowPercentBelow: 10 }) }),
  sitewide: Object.freeze({ pages: 50, footerShare: 0.8 }),
});

/** The rank-distribution buckets (inclusive). `max: null` = no upper limit. Each is one count-only provider call. */
export const RANK_BUCKETS = Object.freeze([
  Object.freeze({ key: '0-99', min: 0, max: 99 }),
  Object.freeze({ key: '100-199', min: 100, max: 199 }),
  Object.freeze({ key: '200-299', min: 200, max: 299 }),
  Object.freeze({ key: '300-499', min: 300, max: 499 }),
  Object.freeze({ key: '500+', min: 500, max: null }),
]);

/** The toxic-domains card counts domains with a spam score above this. */
export const TOXIC_SPAM_ABOVE = 30;

/** Referring-domains page requests (every page / status / sort / filter is a distinct paid call; cache hits count too). */
export const REFERRING_DOMAINS_QUERY_LIMIT = Object.freeze({ windowMs: 15 * 60 * 1000, max: 200 });

/**
 * The two profile-level count cards are limited by REAL provider calls only: a cache hit is free and costs the user nothing, so it is
 * never counted. The rank buckets are five calls, the toxic count one. Per user per window.
 */
export const RD_COUNT_BUDGET = Object.freeze({ windowMs: 15 * 60 * 1000, maxProviderCalls: 20 });

/** "Export with current filters" for referring domains: batches of 1,000 by offset, up to a cap. Cost is an ESTIMATE shown before it starts. */
export const REFERRING_DOMAINS_EXPORT = Object.freeze({
  maxRows: 10000,
  batch: 1000,
  cost: Object.freeze({ perCall: 0.02, perRow: 0.00002 }),
});
export const REFERRING_DOMAINS_EXPORT_LIMIT = Object.freeze({ windowMs: 15 * 60 * 1000, max: 6 });

/** The project's disavow / reviewed lists (SeoProject.disavowed_domains / reviewed_domains): the size of each, and one change's size. */
export const DOMAIN_LISTS = Object.freeze({ maxPerList: 10000, maxPerChange: 1000 });
export const DOMAIN_LISTS_WRITE_LIMIT = Object.freeze({ windowMs: 15 * 60 * 1000, max: 200 });

/**
 * What the browser may ask of the domain-pages section (the Top Pages page, API 10). Paths are DataForSEO's own and were live-checked on
 * 2026-10-28 (every one of them, as a filter and as a sort field). Only LIVE links are asked for.
 *
 * API 10 lists every page the crawler knows, with or without backlinks (live: 6,762 pages, of which only 518 have a backlink), so the page
 * always sends `page_summary.backlinks >= 1` (the user's "Min backlinks" replaces it, so it never costs a second condition).
 */
export const DOMAIN_PAGES_QUERY = Object.freeze({
  status: 'live',
  includeSubdomains: true,
  /** Entries returned in each referring_links_* breakdown (what the expanded row charts). */
  internalListLimit: 10,
  limits: Object.freeze([25, 50, 100, 1000]),
  defaultLimit: 50,
  /** offset + limit may not pass this (the provider's window). */
  maxOffsetWindow: 20000,
  /** The ONE sort rule: the pages that most sites link to first. */
  defaultOrderBy: 'page_summary.referring_domains,desc',
  orderFields: Object.freeze([
    'page_summary.referring_domains', 'page_summary.backlinks', 'page_summary.rank', 'page_summary.broken_backlinks', 'page_summary.first_seen',
  ]),
  maxFilterConditions: 8,
  patternMaxLength: 100,
  filterFields: Object.freeze({
    page: { ops: ['like', 'not_like'], kind: 'pattern' },
    status_code: { ops: ['>=', '<'], kind: 'number', min: 0, max: 999, integer: true },
    'page_summary.referring_domains': { ops: ['>='], kind: 'number', min: 0, max: 100000000, integer: true },
    'page_summary.backlinks': { ops: ['>='], kind: 'number', min: 0, max: 1000000000, integer: true },
    // "Has broken backlinks" is exactly broken_backlinks > 0.
    'page_summary.broken_backlinks': { ops: ['>'], kind: 'number', min: 0, max: 0, integer: true },
    'page_summary.first_seen': { ops: ['>='], kind: 'date' },
  }),
});

/** The base condition of every Top Pages request (see above). */
export const DOMAIN_PAGES_BASE_FILTER = Object.freeze(['page_summary.backlinks', '>=', 1]);

/**
 * The opportunity flags, decided on the SERVER (one place) from a page's status group, link counts and estimated traffic.
 *  wasted_links:     an error / blocked page that has backlinks
 *  redirected_links: a redirect with at least `redirected.minReferringDomains` referring domains
 *  links_no_traffic: an OK page with at least `noTraffic.minReferringDomains` referring domains and NO estimated traffic
 *  traffic_few_links: an OK page with at least `fewLinks.minTraffic` estimated traffic and fewer than `fewLinks.belowReferringDomains` referring domains
 */
export const PAGE_FLAGS = Object.freeze({
  wastedLinks: Object.freeze({ minBacklinks: 1 }),
  redirected: Object.freeze({ minReferringDomains: 10 }),
  noTraffic: Object.freeze({ minReferringDomains: 20 }),
  fewLinks: Object.freeze({ minTraffic: 500, belowReferringDomains: 5 }),
});

/** The traffic join: ONE ranked-keywords call, the biggest page the provider allows, the keywords that bring the most traffic first. */
export const TOP_PAGES_TRAFFIC = Object.freeze({ limit: 1000, orderBy: 'ranked_serp_element.serp_item.etv,desc' });

/** The "Fix first" card: the top error pages by backlinks. */
export const TOP_PAGES_FIX_FIRST = Object.freeze({ limit: 5, orderBy: 'page_summary.backlinks,desc' });

/** Top Pages table requests (every page / sort / filter is a distinct paid call; cache hits count too), per user per window. */
export const DOMAIN_PAGES_QUERY_LIMIT = Object.freeze({ windowMs: 15 * 60 * 1000, max: 200 });
/** The profile pieces are limited by REAL provider calls only (service/providerBudget.js): a cache hit never counts. */
export const TP_PROFILE_BUDGET = Object.freeze({ windowMs: 15 * 60 * 1000, maxProviderCalls: 20 });

/** "Export with current filters" for Top Pages: batches of 1,000 by offset, up to a cap. Cost is an ESTIMATE shown before it starts. */
export const TOP_PAGES_EXPORT = Object.freeze({ maxRows: 10000, batch: 1000, cost: Object.freeze({ perCall: 0.02, perRow: 0.00002 }) });
export const TOP_PAGES_EXPORT_LIMIT = Object.freeze({ windowMs: 15 * 60 * 1000, max: 6 });

/** Saving the tracked / excluded lists: cheap, but not unbounded. */
export const COMPETITOR_SETTINGS_WRITE_LIMIT = Object.freeze({ windowMs: 15 * 60 * 1000, max: 200 });

/** Language names DataForSEO uses that differ from what Intl produces for the same code. */
export const LANGUAGE_NAME_OVERRIDES = Object.freeze({ zh: 'Chinese (Simplified)' });
/** Location names DataForSEO uses that differ from what Intl produces for the same ISO country code. */
export const LOCATION_NAME_OVERRIDES = Object.freeze({ TR: 'Turkey', HK: 'Hong Kong', TW: 'Taiwan' });

/** Refresh (cache-skipping) requests per user per window. A page refresh is up to 5 requests, so 30 = 6 full refreshes. */
export const REFRESH_LIMIT = Object.freeze({ windowMs: 15 * 60 * 1000, max: 30 });

/**
 * What the browser may ask of the backlinks-list section (the Backlinks page). Everything is checked against these lists before a billed
 * call can happen. Field names are DataForSEO's own. Sort and filter fields were live-checked against the provider (see the notes).
 */
export const BACKLINKS_LIST_QUERY = Object.freeze({
  statuses: Object.freeze(['live', 'lost']),
  defaultStatus: 'live',
  modes: Object.freeze(['as_is', 'one_per_domain', 'one_per_anchor']),
  defaultMode: 'as_is',
  includeSubdomains: true,
  /** Page sizes (25 / 50 / 100) and the export batch (1,000, the provider's per-request maximum). */
  limits: Object.freeze([25, 50, 100, 1000]),
  defaultLimit: 50,
  /** `offset` may only be used while offset + limit stays within this; beyond it the provider needs a search_after_token. */
  maxOffsetWindow: 20000,
  maxOrderRules: 3,
  maxFilterConditions: 8,
  defaultOrderBy: Object.freeze(['rank,desc']),
  orderFields: Object.freeze(['rank', 'domain_from_rank', 'page_from_rank', 'backlink_spam_score', 'first_seen', 'last_seen']),
  filterFields: Object.freeze({
    url_from: { ops: ['like'], kind: 'pattern' },
    // "like" = contains (%text%); "=" = exactly this anchor, "" meaning links with no anchor text (the Anchors page's "View these backlinks").
    anchor: { ops: ['like', '='], kind: 'patternOrText', maxLength: 1000 },
    // like = contains (%text%); "=" = exactly this target URL (the Top Pages page's "View backlinks"; live-checked).
    url_to: { ops: ['like', '='], kind: 'patternOrText', maxLength: 2000 },
    domain_from: { ops: ['='], kind: 'domain' },
    dofollow: { ops: ['='], kind: 'bool' },
    item_type: { ops: ['in'], kind: 'enumList', maxItems: 12 },
    semantic_location: { ops: ['in'], kind: 'enumList', maxItems: 20 },
    domain_from_country: { ops: ['in'], kind: 'enumList', itemPattern: /^[A-Z]{2}$/, maxItems: 50 },
    domain_from_rank: { ops: ['>='], kind: 'number', min: 0, max: 1000, integer: true },
    backlink_spam_score: { ops: ['<=', '<'], kind: 'number', min: 0, max: 100, integer: true },
    first_seen: { ops: ['>='], kind: 'date' },
    is_new: { ops: ['='], kind: 'true' },
    is_broken: { ops: ['='], kind: 'true' },
  }),
  patternMaxLength: 100,
  /** search_after_token: opaque; only a sane length and characters are checked. */
  tokenMaxLength: 4000,
});

/** Backlinks-list requests (every page / sort / filter / tab is its own paid call), per user per window. Cache hits count too. */
export const BACKLINKS_LIST_LIMIT = Object.freeze({ windowMs: 15 * 60 * 1000, max: 300 });

/**
 * "Export with current filters" (backend): batches of 1,000 following search_after_token, up to a cap. The cost is an ESTIMATE shown
 * before the export starts: each call costs `perCall` plus `perRow` for every row it returns. Keep in step with the frontend's copy
 * (components/dashboard/backlinks/constants.js) — the frontend shows it, this is what the server enforces (the cap).
 */
export const BACKLINKS_EXPORT = Object.freeze({
  maxRows: 10000,
  batch: 1000,
  cost: Object.freeze({ perCall: 0.02, perRow: 0.00002 }),
});
/** Starting a large export is expensive: a small separate limit. */
export const BACKLINKS_EXPORT_LIMIT = Object.freeze({ windowMs: 15 * 60 * 1000, max: 6 });
