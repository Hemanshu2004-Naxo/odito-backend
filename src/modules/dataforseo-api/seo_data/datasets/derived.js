import SeoBacklink from '../model/SeoBacklink.js';
import { latestDatasetState } from './datasetCollector.js';
import { conditionsToMongo, fromCanonical, toMongoSort } from './mongoQuery.js';
import { DATASET_FRESH_MS } from '../config.js';
import { parseAnchor, parseDomainPage } from '../../domain_overview/provider/domainOverviewProvider.js';
import { ANCHOR_PROFILE } from '../../domain_overview/config.js';

/**
 * Anchors and top linked pages computed FROM the stored backlink rows with MongoDB aggregation, so these views cost nothing to open, page,
 * sort or filter.
 *
 * What the figures are: exact for the links Odito stored. When the stored set is capped (`complete: false`) they are counts over the
 * stored part only (the strongest links first), and every response says so. Distinct counts (referring domains / pages) are exact within
 * the stored links. A link with an unknown follow status counts as neither follow nor nofollow.
 *
 * What they are not: the provider's anchor / page endpoints also return values that cannot be rebuilt from backlink rows (rank, spam
 * score, the referring-link breakdowns). Those stay null here ("—" on the page), and a request that sorts or filters on one of them is NOT
 * answered from here (the caller falls back to the provider-shaped stored answer, or reports it as not collected).
 *
 * Anchor text is grouped exactly as the provider gives it (no case folding or trimming): the provider's own anchor rows are per exact text.
 */

const sumIf = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });
const nonNull = (field) => ({ $size: { $filter: { input: field, cond: { $ne: ['$$this', null] } } } });
/** "2025-10-10 00:00:00 +00:00": the provider's date format, which the pages' mappers read. */
export const toProviderTime = (d) => (d instanceof Date && !Number.isNaN(d.getTime()) ? `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)} +00:00` : null);

// ── anchors ──
const ANCHOR_FIELDS = { anchor: { path: 'anchor' }, referring_domains: { path: 'referring_domains' }, backlinks: { path: 'backlinks' }, broken_backlinks: { path: 'broken' }, first_seen: { path: 'firstSeen', kind: 'date' } };
const ANCHOR_ORDER = { referring_domains: 'referring_domains', backlinks: 'backlinks', broken_backlinks: 'broken', first_seen: 'firstSeen' };

// ── pages ──
const PAGE_FIELDS = {
  page: { path: '_id' }, status_code: { path: 'status' }, 'page_summary.referring_domains': { path: 'referring_domains' },
  'page_summary.backlinks': { path: 'backlinks' }, 'page_summary.broken_backlinks': { path: 'broken' }, 'page_summary.first_seen': { path: 'firstSeen', kind: 'date' },
};
const PAGE_ORDER = { 'page_summary.referring_domains': 'referring_domains', 'page_summary.backlinks': 'backlinks', 'page_summary.broken_backlinks': 'broken', 'page_summary.first_seen': 'firstSeen' };

function groupPipeline(view, match) {
  const common = {
    backlinks: { $sum: 1 },
    domains: { $addToSet: '$sourceDomain' },
    pages: { $addToSet: '$sourceUrl' },
    nofollowDomains: { $addToSet: { $cond: [{ $eq: ['$isFollow', false] }, '$sourceDomain', null] } },
    nofollowPages: { $addToSet: { $cond: [{ $eq: ['$isFollow', false] }, '$sourceUrl', null] } },
    broken: sumIf({ $eq: ['$isBroken', true] }),
    firstSeen: { $min: '$firstSeen' },
  };
  const project = {
    backlinks: 1, broken: 1, firstSeen: 1,
    referring_domains: nonNull('$domains'), referring_pages: nonNull('$pages'),
    referring_domains_nofollow: nonNull('$nofollowDomains'), referring_pages_nofollow: nonNull('$nofollowPages'),
  };
  if (view === 'anchors') return [{ $match: match }, { $group: { _id: '$anchor', ...common } }, { $project: { anchor: '$_id', ...project } }];
  return [
    { $match: match },
    { $group: { _id: '$targetUrl', ...common, status: { $max: '$row.url_to_status_code' } } },
    { $match: { _id: { $ne: null } } },
    { $project: { ...project, status: 1 } },
  ];
}

/** The provider-shaped raw item the existing parsers turn into the contract row the page reads. Unknowable values are simply absent (-> null). */
const rawAnchor = (g) => ({
  anchor: g.anchor ?? '', backlinks: g.backlinks, referring_domains: g.referring_domains, referring_domains_nofollow: g.referring_domains_nofollow,
  referring_pages: g.referring_pages, referring_pages_nofollow: g.referring_pages_nofollow, broken_backlinks: g.broken, first_seen: toProviderTime(g.firstSeen),
});
const rawPage = (g) => ({
  page: g._id, status_code: g.status ?? null,
  page_summary: {
    backlinks: g.backlinks, referring_domains: g.referring_domains, referring_domains_nofollow: g.referring_domains_nofollow,
    referring_pages: g.referring_pages, referring_pages_nofollow: g.referring_pages_nofollow, broken_backlinks: g.broken, first_seen: toProviderTime(g.firstSeen),
  },
});

const completeness = (state) => ({
  source: 'database',
  derived: true,
  scanId: String(state.scanId),
  // How many backlinks the figures are computed from, and how many exist at the provider.
  rows: state.data?.rows ?? null,
  sourceDatasetCount: state.data?.rows ?? null,
  totalCount: state.data?.totalCount ?? null,
  truncated: Boolean(state.data?.truncated),
  complete: !state.data?.truncated,
  lastUpdatedAt: state.capturedAt,
});

/**
 * One page of grouped rows, with the total number of groups. Group-level filters/sorts run after the grouping, on its output.
 * @returns {Promise<{ totalCount: number, rows: object[] }>}
 */
async function runGrouped({ view, match, conditions, sort, skip, limit }) {
  const post = conditionsToMongo(conditions);
  const pipeline = [...groupPipeline(view, match), ...(Object.keys(post).length ? [{ $match: post }] : []), { $sort: sort },
    { $facet: { n: [{ $count: 'n' }], rows: [{ $skip: skip }, { $limit: limit }] } }];
  const [r] = await SeoBacklink.aggregate(pipeline).allowDiskUse(true);
  return { totalCount: r?.n?.[0]?.n ?? 0, rows: r?.rows ?? [] };
}

/**
 * A section of the Anchors / Top Pages pages (anchors, anchor-profile, domain-pages) from the stored backlinks, in the exact payload shape of
 * the provider path. null = cannot be answered from stored backlinks (no dataset, or a sort / filter that needs provider-only values).
 * @param {{ project: { _id: any }, section: 'anchors'|'anchor-profile'|'domain-pages', query: object|null, now?: Date }} input
 */
export async function readDerivedSection({ project, section, query, now = new Date() }) {
  const view = section === 'domain-pages' ? 'pages' : 'anchors';
  // The anchor profile is one fixed request: the live anchors with the most referring domains.
  const q = section === 'anchor-profile'
    ? { status: 'live', limit: ANCHOR_PROFILE.limit, offset: 0, orderBy: ANCHOR_PROFILE.orderBy, filters: [] }
    : query;
  if (!q) return null;
  const status = view === 'pages' ? 'live' : q.status;
  if (!['live', 'lost'].includes(status)) return null; // 'all' would need both statuses merged: not representable

  const state = await latestDatasetState({ projectId: project._id, kind: 'backlinks', status });
  if (!state) return null;

  const conditions = fromCanonical(q.filters ?? [], view === 'anchors' ? ANCHOR_FIELDS : PAGE_FIELDS);
  const sort = toMongoSort([q.orderBy], view === 'anchors' ? ANCHOR_ORDER : PAGE_ORDER);
  const { totalCount, rows } = await runGrouped({
    view, match: { projectId: project._id, scanId: state.scanId, status }, conditions, sort, skip: q.offset ?? 0, limit: q.limit,
  });
  const parsed = view === 'anchors' ? rows.map((g) => parseAnchor(rawAnchor(g), { slim: section === 'anchor-profile' })) : rows.map((g) => parseDomainPage(rawPage(g)));
  const capturedAt = new Date(state.capturedAt);
  const expiresAt = new Date(capturedAt.getTime() + DATASET_FRESH_MS.backlinks);
  return {
    payload: { totalCount, items: parsed.filter(Boolean) },
    capturedAt,
    expiresAt,
    stale: expiresAt <= now,
    dataset: completeness(state),
    derived: true,
    // A provider-shaped stored answer collected in the same scan carries values these rows cannot (rank, spam, breakdowns): it is preferred
    // unless it is clearly older than this dataset.
    preferCacheWithinMs: 10 * 60_000,
  };
}

// ── the /seo-datasets/anchors and /pages endpoints (any sort that can be computed here) ──
const SORTS = Object.freeze({
  anchors: { backlinks: 'backlinks', referringDomains: 'referring_domains', follow: 'follow', nofollow: 'nofollow', firstSeen: 'firstSeen', lastSeen: 'lastSeen' },
  pages: { backlinks: 'backlinks', referringDomains: 'referringDomains', follow: 'follow', nofollow: 'nofollow' },
});
export const DERIVED_SORTS = Object.freeze({ anchors: Object.keys(SORTS.anchors), pages: Object.keys(SORTS.pages) });

async function run(pipeline, { skip, limit }) {
  const [r] = await SeoBacklink.aggregate([...pipeline, { $facet: { n: [{ $count: 'n' }], items: [{ $skip: skip }, { $limit: limit }] } }]).allowDiskUse(true);
  return { totalCount: r?.n?.[0]?.n ?? 0, items: r?.items ?? [] };
}

/**
 * Anchor / page rollups with follow / nofollow / unknown breakdown, for the dedicated endpoints.
 * @returns {Promise<null | { totalCount: number, items: object[], complete: boolean, truncated: boolean, scanId: string, lastUpdatedAt: Date, sourceDatasetCount: number|null, dataset: object }>}
 */
export async function deriveFromBacklinks({ project, view, status = 'live', sort = 'backlinks', dir = 'desc', skip = 0, limit = 50 }) {
  const state = await latestDatasetState({ projectId: project._id, kind: 'backlinks', status });
  if (!state) return null;
  const field = SORTS[view][sort];
  if (!field) throw new RangeError('unsupported sort');
  const order = { [field]: dir === 'asc' ? 1 : -1, _id: 1 };
  const match = { $match: { projectId: project._id, scanId: state.scanId, status } };

  let pipeline;
  if (view === 'anchors') {
    pipeline = [
      match,
      { $group: {
        _id: '$anchor', backlinks: { $sum: 1 }, domains: { $addToSet: '$sourceDomain' },
        follow: sumIf({ $eq: ['$isFollow', true] }), nofollow: sumIf({ $eq: ['$isFollow', false] }), unknownFollow: sumIf({ $eq: [{ $type: '$isFollow' }, 'null'] }),
        firstSeen: { $min: '$firstSeen' }, lastSeen: { $max: '$lastSeen' },
      } },
      { $project: { _id: 0, anchor: '$_id', backlinks: 1, referring_domains: nonNull('$domains'), follow: 1, nofollow: 1, unknownFollow: 1, firstSeen: 1, lastSeen: 1 } },
      { $sort: order },
    ];
  } else {
    // First per (page, source domain), then per page: the referring domains of a page are the number of such pairs.
    pipeline = [
      match,
      { $group: { _id: { t: '$targetUrl', d: '$sourceDomain' }, n: { $sum: 1 }, follow: sumIf({ $eq: ['$isFollow', true] }), nofollow: sumIf({ $eq: ['$isFollow', false] }), unknownFollow: sumIf({ $eq: [{ $type: '$isFollow' }, 'null'] }) } },
      { $group: { _id: '$_id.t', backlinks: { $sum: '$n' }, referringDomains: { $sum: 1 }, follow: { $sum: '$follow' }, nofollow: { $sum: '$nofollow' }, unknownFollow: { $sum: '$unknownFollow' } } },
      { $project: { _id: 0, targetUrl: '$_id', backlinks: 1, referringDomains: 1, follow: 1, nofollow: 1, unknownFollow: 1 } },
      { $sort: order },
    ];
  }
  const out = await run(pipeline, { skip, limit });
  const meta = completeness(state);
  return { ...out, complete: meta.complete, truncated: meta.truncated, scanId: meta.scanId, lastUpdatedAt: meta.lastUpdatedAt, sourceDatasetCount: meta.sourceDatasetCount, dataset: meta };
}
