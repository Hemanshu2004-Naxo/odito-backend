/**
 * What a scan can collect. Every dataset is one domain-overview section with the EXACT query a page opens with, so a scan fills precisely
 * the stored entries the pages read (same canonical query -> same cache key). `params` are the raw query-string values the page sends;
 * they go through the same validator the HTTP route uses (domain_overview/service/sectionQuery.js).
 *
 * Page-open alignment (checked against the frontend request builders):
 *  - Organic Keywords opens with limit 25, default order, no filters.
 *  - Competitors / Backlinks / Anchors / Referring Domains / Backlinks list open parameter-free (their defaults).
 *  - Top Pages "All" tab = backlinks >= 1; the Domain Overview card uses the "OK" tab = status 200..299 and backlinks >= 1.
 */

const BACKLINKS_AT_LEAST_1 = ['page_summary.backlinks', '>=', 1];
const OK_TAB = [['status_code', '>=', 200], 'and', ['status_code', '<', 300], 'and', BACKLINKS_AT_LEAST_1];

/** @type {Record<string, { section: string, params?: Record<string,string>, dependsOn?: string, when?: (dep: any) => boolean }>} */
export const DATASETS = Object.freeze({
  'rank-overview': { section: 'rank-overview' },
  'history': { section: 'history' },
  'ranked-keywords-top5': { section: 'ranked-keywords' },
  'ranked-keywords-page': { section: 'ranked-keywords', params: { limit: '25' } },
  'competitors': { section: 'competitors' },
  'backlinks': { section: 'backlinks' },
  'backlinks-list': { section: 'backlinks-list' },
  'anchors': { section: 'anchors' },
  'anchor-profile': { section: 'anchor-profile' },
  'referring-domains': { section: 'referring-domains' },
  'rd-rank-buckets': { section: 'rd-rank-buckets' },
  'rd-toxic-count': { section: 'rd-toxic-count' },
  'rd-last-30': { section: 'rd-last-30' },
  'tp-counts': { section: 'tp-counts' },
  // The five worst error pages are only worth buying when the counts say there are error pages.
  'tp-fix-first': { section: 'tp-fix-first', dependsOn: 'tp-counts', when: (counts) => Number(counts?.errors) > 0 },
  'domain-pages-all': { section: 'domain-pages', params: { limit: '50', filters: JSON.stringify(BACKLINKS_AT_LEAST_1) } },
  'domain-pages-ok': { section: 'domain-pages', params: { limit: '50', filters: JSON.stringify(OK_TAB) } },
  // The traffic joined onto the Top Pages rows (one Organic Keywords call of 1,000 rows, shared with the keyword export).
  'top-pages-traffic': { section: 'top-pages-traffic' },
  // ── permanent row-level datasets (seo_keyword_rankings, seo_backlinks, seo_referring_domains_v2): collected page by page, persisted, then served by MongoDB ──
  'keywords-dataset': { section: 'ranked-keywords', collector: 'keywords', status: null },
  'backlinks-dataset-live': { section: 'backlinks-list', collector: 'backlinks', status: 'live' },
  'backlinks-dataset-lost': { section: 'backlinks-list', collector: 'backlinks', status: 'lost' },
  'referring-domains-dataset-live': { section: 'referring-domains', collector: 'referringDomains', status: 'live' },
  'referring-domains-dataset-lost': { section: 'referring-domains', collector: 'referringDomains', status: 'lost' },
});

const OVERVIEW = ['rank-overview', 'history', 'ranked-keywords-top5', 'competitors', 'backlinks', 'tp-counts', 'tp-fix-first', 'domain-pages-ok', 'top-pages-traffic', 'rd-toxic-count', 'rd-last-30'];
const ORGANIC = ['rank-overview', 'history', 'ranked-keywords-top5', 'ranked-keywords-page', 'competitors', 'keywords-dataset'];
const OFFPAGE = ['backlinks', 'backlinks-list', 'anchors', 'anchor-profile', 'referring-domains', 'rd-rank-buckets', 'rd-toxic-count', 'rd-last-30', 'tp-counts', 'tp-fix-first', 'domain-pages-all', 'domain-pages-ok', 'top-pages-traffic', 'backlinks-dataset-live', 'backlinks-dataset-lost', 'referring-domains-dataset-live', 'referring-domains-dataset-lost'];

/** scope -> dataset ids. `dataset` is the caller's own list (a dataset refresh). Shared datasets are listed once in `full`. */
export const SCOPES = Object.freeze({
  overview: OVERVIEW,
  organic: ORGANIC,
  competitors: ['competitors'],
  offpage: OFFPAGE,
  full: [...new Set([...OVERVIEW, ...ORGANIC, ...OFFPAGE])],
});
export const SCOPE_NAMES = Object.freeze([...Object.keys(SCOPES), 'dataset']);

/** How many datasets of one scan run at once. The provider's own budgets (providerBudget.js) still apply inside each. */
export const SCAN_CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.SEO_SCAN_CONCURRENCY) || 3));
/** A scan that stops extending its lease for this long is considered dead (its process crashed). */
export const SCAN_LEASE_MS = 3 * 60_000;
export const SCAN_HEARTBEAT_MS = 30_000;
/** Starting scans, per user per window. */
export const SCAN_START_LIMIT = Object.freeze({ windowMs: 15 * 60 * 1000, max: 10 });

const envInt = (name, fallback, max) => { const n = Number.parseInt(process.env[name], 10); return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback; };

/**
 * How many rows of each dataset one scan stores at most (the provider is paid per row, and a stored set must stay a bounded query). The
 * provider's real total is kept next to the stored count, so a capped set is reported as capped ("1,000 of 13,591"), never as complete.
 * Overridable per deployment; the hard maximum is the provider's offset window.
 */
export const DATASET_CAPS = Object.freeze({
  keywords: envInt('SEO_KEYWORDS_CAP', 3000, 9000),
  backlinksLive: envInt('SEO_BACKLINKS_CAP', 5000, 20000),
  backlinksLost: envInt('SEO_BACKLINKS_LOST_CAP', 2000, 20000),
  referringDomainsLive: envInt('SEO_REFERRING_DOMAINS_CAP', 5000, 20000),
  referringDomainsLost: envInt('SEO_REFERRING_DOMAINS_LOST_CAP', 2000, 20000),
});
/** Rows per provider request while collecting (the provider's per-request maximum). */
export const COLLECT_BATCH = 1000;
/** How long a stored dataset counts as fresh (a scan without `force` does not collect a fresh one again). Independent of retention: nothing is deleted when it passes. */
export const DATASET_FRESH_MS = Object.freeze({ keywords: 24 * 3_600_000, backlinks: 24 * 3_600_000, referringDomains: 24 * 3_600_000 });
