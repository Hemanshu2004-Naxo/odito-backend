import SeoSnapshot from '../model/SeoSnapshot.js';
import SeoKeywordRanking from '../model/SeoKeywordRanking.js';
import SeoReferringDomain from '../model/SeoReferringDomain.js';
import { KINDS, STATE_PART, STATE_TYPE } from './definitions.js';
import { variantOf } from './datasetCollector.js';

/**
 * History from what Odito itself stored: every comparison is between two complete row sets (two scans), found through the dataset-state
 * snapshots. Nothing here reads the provider or the cache, and nothing is inferred from cache timestamps. With only one scan there is
 * nothing to compare with, and the answer says so (`reference: null`) instead of reporting zero changes.
 */

const PERIOD_DAYS = Object.freeze({ week: 7, month: 30 });
export const PERIODS = Object.freeze(['previous', ...Object.keys(PERIOD_DAYS)]);
const SAMPLE = 50;

const idFieldOf = (kind) => (kind === 'referringDomains' ? 'referringDomain' : 'nk');

/** The complete scans of a dataset, newest first (bounded). */
export async function listDatasetStates({ projectId, kind, status = null, limit = 60 }, { snapshots = SeoSnapshot } = {}) {
  return snapshots.find({ projectId, datasetType: STATE_TYPE[kind], part: STATE_PART[kind], variant: variantOf(kind, status) })
    .sort({ capturedAt: -1 }).limit(limit).select('-__v').lean();
}

/** The scan to compare the newest one with: the one before it, or the newest at least a week / month older. null = none exists. */
export function pickReference(states, period) {
  const [latest, ...older] = states;
  if (!latest) return { latest: null, reference: null };
  if (period === 'previous') return { latest, reference: older[0] ?? null };
  const cutoff = new Date(latest.capturedAt).getTime() - PERIOD_DAYS[period] * 86_400_000;
  return { latest, reference: older.find((s) => new Date(s.capturedAt).getTime() <= cutoff) ?? null };
}

const describe = (s) => (s ? { scanId: String(s.scanId), capturedAt: s.capturedAt, rows: s.data?.rows ?? null, truncated: Boolean(s.data?.truncated) } : null);

/** Rows of scan A with no counterpart in scan B (same natural key): a count plus a bounded, sorted sample. */
async function onlyIn({ model, kind, projectId, status, from, against, sort }) {
  const idField = idFieldOf(kind);
  const statusMatch = status ? { status } : {};
  const [r] = await model.aggregate([
    { $match: { projectId, scanId: from, ...statusMatch } },
    { $lookup: {
      from: model.collection.name,
      let: { k: `$${idField}` },
      pipeline: [
        { $match: { $expr: { $and: [{ $eq: ['$projectId', projectId] }, { $eq: ['$scanId', against] }, { $eq: [`$${idField}`, '$$k'] }, ...(status ? [{ $eq: ['$status', status] }] : [])] } } },
        { $limit: 1 }, { $project: { _id: 1 } },
      ],
      as: 'other',
    } },
    { $match: { other: { $size: 0 } } },
    { $facet: { count: [{ $count: 'n' }], items: [{ $sort: sort }, { $limit: SAMPLE }, { $project: { row: 1 } }] } },
  ]).allowDiskUse(true);
  return { count: r?.count?.[0]?.n ?? 0, items: (r?.items ?? []).map((x) => x.row) };
}

/** Keywords present in both scans whose position changed: improved (smaller number) and declined. */
async function keywordMovement({ projectId, from, against }) {
  const [r] = await SeoKeywordRanking.aggregate([
    { $match: { projectId, scanId: from, position: { $ne: null } } },
    { $lookup: {
      from: SeoKeywordRanking.collection.name,
      let: { k: '$nk' },
      pipeline: [
        { $match: { $expr: { $and: [{ $eq: ['$projectId', projectId] }, { $eq: ['$scanId', against] }, { $eq: ['$nk', '$$k'] }] } } },
        { $limit: 1 }, { $project: { position: 1, trafficEstimate: 1, searchVolume: 1 } },
      ],
      as: 'prev',
    } },
    { $match: { prev: { $size: 1 } } },
    { $addFields: {
      change: { $subtract: [{ $arrayElemAt: ['$prev.position', 0] }, '$position'] },
      trafficChange: { $subtract: ['$trafficEstimate', { $arrayElemAt: ['$prev.trafficEstimate', 0] }] },
      volumeChange: { $subtract: ['$searchVolume', { $arrayElemAt: ['$prev.searchVolume', 0] }] },
    } },
    { $facet: {
      improvedN: [{ $match: { change: { $gt: 0 } } }, { $count: 'n' }],
      improved: [{ $match: { change: { $gt: 0 } } }, { $sort: { change: -1 } }, { $limit: SAMPLE }, { $project: { row: 1, change: 1, trafficChange: 1, volumeChange: 1 } }],
      declinedN: [{ $match: { change: { $lt: 0 } } }, { $count: 'n' }],
      declined: [{ $match: { change: { $lt: 0 } } }, { $sort: { change: 1 } }, { $limit: SAMPLE }, { $project: { row: 1, change: 1, trafficChange: 1, volumeChange: 1 } }],
    } },
  ]).allowDiskUse(true);
  // position_change > 0 = moved up that many places. traffic / volume changes are null when either scan had no figure (never 0).
  const shape = (n, items) => ({ count: n?.[0]?.n ?? 0, items: (items ?? []).map((i) => ({ ...i.row, position_change: i.change, traffic_change: i.trafficChange ?? null, search_volume_change: i.volumeChange ?? null })) });
  return { improved: shape(r?.improvedN, r?.improved), declined: shape(r?.declinedN, r?.declined) };
}

/** Referring domains present in both scans whose domain rank or backlink count changed (change = now - before; null when either scan had no figure). */
async function domainMovement({ projectId, status, from, against }) {
  const [r] = await SeoReferringDomain.aggregate([
    { $match: { projectId, scanId: from, status } },
    { $lookup: {
      from: SeoReferringDomain.collection.name,
      let: { d: '$referringDomain' },
      pipeline: [
        { $match: { $expr: { $and: [{ $eq: ['$projectId', projectId] }, { $eq: ['$scanId', against] }, { $eq: ['$status', status] }, { $eq: ['$referringDomain', '$$d'] }] } } },
        { $limit: 1 }, { $project: { domainRank: 1, backlinksCount: 1 } },
      ],
      as: 'prev',
    } },
    { $match: { prev: { $size: 1 } } },
    { $addFields: {
      rankChange: { $subtract: ['$domainRank', { $arrayElemAt: ['$prev.domainRank', 0] }] },
      backlinksChange: { $subtract: ['$backlinksCount', { $arrayElemAt: ['$prev.backlinksCount', 0] }] },
    } },
    { $facet: {
      rankUpN: [{ $match: { rankChange: { $gt: 0 } } }, { $count: 'n' }],
      rankUp: [{ $match: { rankChange: { $gt: 0 } } }, { $sort: { rankChange: -1 } }, { $limit: SAMPLE }, { $project: { row: 1, rankChange: 1, backlinksChange: 1 } }],
      rankDownN: [{ $match: { rankChange: { $lt: 0 } } }, { $count: 'n' }],
      rankDown: [{ $match: { rankChange: { $lt: 0 } } }, { $sort: { rankChange: 1 } }, { $limit: SAMPLE }, { $project: { row: 1, rankChange: 1, backlinksChange: 1 } }],
      backlinksUpN: [{ $match: { backlinksChange: { $gt: 0 } } }, { $count: 'n' }],
      backlinksDownN: [{ $match: { backlinksChange: { $lt: 0 } } }, { $count: 'n' }],
    } },
  ]).allowDiskUse(true);
  const shape = (n, items) => ({ count: n?.[0]?.n ?? 0, items: (items ?? []).map((i) => ({ ...i.row, rank_change: i.rankChange ?? null, backlinks_change: i.backlinksChange ?? null })) });
  return {
    rankUp: shape(r?.rankUpN, r?.rankUp), rankDown: shape(r?.rankDownN, r?.rankDown),
    backlinksUp: { count: r?.backlinksUpN?.[0]?.n ?? 0 }, backlinksDown: { count: r?.backlinksDownN?.[0]?.n ?? 0 },
  };
}

/**
 * New and lost rows (and, for keywords, movement) between the newest scan and a reference scan.
 * @returns {Promise<object>} `hasData: false` (nothing collected), `reference: null` (nothing to compare with yet), or the differences
 */
export async function compareDatasets({ projectId, kind, status = null, period = 'previous' }, deps = {}) {
  const states = await listDatasetStates({ projectId, kind, status }, deps);
  const { latest, reference } = pickReference(states, period);
  const base = { kind, status, period };
  if (!latest) return { ...base, hasData: false, latest: null, reference: null };
  if (!reference) {
    const note = period === 'previous'
      ? 'No earlier Odito scan of this dataset exists yet, so there is nothing to compare with.'
      : `No scan of this dataset is ${period === 'week' ? 'a week' : 'a month'} old yet, so there is nothing to compare with.`;
    return { ...base, hasData: true, latest: describe(latest), reference: null, note };
  }
  const { model } = KINDS[kind];
  const sort = { _id: 1 };
  const args = { model, kind, projectId, status };
  const [added, lost] = await Promise.all([
    onlyIn({ ...args, from: latest.scanId, against: reference.scanId, sort }),
    onlyIn({ ...args, from: reference.scanId, against: latest.scanId, sort }),
  ]);
  const movement = kind === 'keywords' ? await keywordMovement({ projectId, from: latest.scanId, against: reference.scanId })
    : kind === 'referringDomains' ? await domainMovement({ projectId, status, from: latest.scanId, against: reference.scanId }) : {};
  // The provider's whole-domain totals stored with each scan (keywords: count, traffic, position buckets): the headline "before / after".
  const totals = kind === 'keywords' ? { totals: { latest: latest.data?.metrics ?? null, reference: reference.data?.metrics ?? null } } : {};
  // A capped set can only be compared with a capped set: rows beyond the cap are not "lost", they are simply not stored.
  const caveat = latest.data?.truncated || reference.data?.truncated
    ? 'At least one of these scans stored only part of the provider\'s data (a row cap), so new / lost counts compare the stored parts.' : null;
  return { ...base, hasData: true, latest: describe(latest), reference: describe(reference), new: added, lost, ...movement, ...totals, ...(caveat ? { caveat } : {}) };
}

/** One keyword over time (every stored scan, newest first) and its best position. */
export async function keywordHistory({ projectId, keyword, limit = 100 }) {
  const normalized = String(keyword).trim().toLowerCase();
  const rows = await SeoKeywordRanking.find({ projectId, normalizedKeyword: normalized })
    .sort({ capturedAt: -1 }).limit(Math.min(limit, 200)).select('scanId capturedAt position previousPosition rankingUrl searchVolume trafficEstimate').lean();
  const known = rows.map((r) => r.position).filter((p) => typeof p === 'number');
  return { keyword: normalized, points: rows, bestPosition: known.length ? Math.min(...known) : null };
}
