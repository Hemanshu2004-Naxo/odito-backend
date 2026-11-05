import SeoBacklink from '../model/SeoBacklink.js';
import { latestDatasetState } from './datasetCollector.js';

/**
 * Anchors and top linked pages computed FROM the stored backlink rows with MongoDB aggregation, so these views cost nothing to open.
 *
 * What this is and is not: the figures are exact for the links Odito stored. When the stored set is capped (`complete: false`) they are
 * counts over the stored part only, and the response says so. The provider's own anchor / page endpoints also return fields that cannot be
 * rebuilt from backlink rows (per-anchor rank, spam score, the referring-link breakdowns), so the existing Anchors and Top Pages pages keep
 * their provider-shaped data; these derived views are additional, not a replacement.
 */

const SORTS = Object.freeze({
  anchors: { backlinks: 'backlinks', referringDomains: 'referringDomains', follow: 'follow', nofollow: 'nofollow', firstSeen: 'firstSeen', lastSeen: 'lastSeen' },
  pages: { backlinks: 'backlinks', referringDomains: 'referringDomains', follow: 'follow', nofollow: 'nofollow' },
});
export const DERIVED_SORTS = Object.freeze({ anchors: Object.keys(SORTS.anchors), pages: Object.keys(SORTS.pages) });

const sumIf = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });

async function run(pipeline, { skip, limit }) {
  const [r] = await SeoBacklink.aggregate([...pipeline, { $facet: { n: [{ $count: 'n' }], items: [{ $skip: skip }, { $limit: limit }] } }]).allowDiskUse(true);
  return { totalCount: r?.n?.[0]?.n ?? 0, items: r?.items ?? [] };
}

/**
 * @param {{ project: { _id: any }, view: 'anchors'|'pages', status?: 'live'|'lost', sort?: string, dir?: 'asc'|'desc', skip?: number, limit?: number }} input
 * @returns {Promise<null | { totalCount: number, items: object[], complete: boolean, dataset: object }>} null = no stored backlinks yet
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
        follow: sumIf({ $eq: ['$isFollow', true] }), nofollow: sumIf({ $eq: ['$isFollow', false] }), firstSeen: { $min: '$firstSeen' }, lastSeen: { $max: '$lastSeen' },
      } },
      { $project: { _id: 0, anchor: '$_id', backlinks: 1, referringDomains: { $size: '$domains' }, follow: 1, nofollow: 1, firstSeen: 1, lastSeen: 1 } },
      { $sort: order },
    ];
  } else {
    // First per (page, source domain), then per page: the referring domains of a page are the number of such pairs.
    pipeline = [
      match,
      { $group: { _id: { t: '$targetUrl', d: '$sourceDomain' }, n: { $sum: 1 }, follow: sumIf({ $eq: ['$isFollow', true] }), nofollow: sumIf({ $eq: ['$isFollow', false] }) } },
      { $group: { _id: '$_id.t', backlinks: { $sum: '$n' }, referringDomains: { $sum: 1 }, follow: { $sum: '$follow' }, nofollow: { $sum: '$nofollow' } } },
      { $project: { _id: 0, targetUrl: '$_id', backlinks: 1, referringDomains: 1, follow: 1, nofollow: 1 } },
      { $sort: order },
    ];
  }
  const out = await run(pipeline, { skip, limit });
  return {
    ...out,
    complete: !state.data?.truncated,
    dataset: { source: 'database', scanId: String(state.scanId), capturedAt: state.capturedAt, rows: state.data?.rows ?? null, totalCount: state.data?.totalCount ?? null, truncated: Boolean(state.data?.truncated) },
  };
}
