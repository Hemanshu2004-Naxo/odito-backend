import { KINDS, SECTION_TO_KIND } from './definitions.js';
import { latestDatasetState } from './datasetCollector.js';
import { conditionsToMongo, fromCanonical, toMongoSort } from './mongoQuery.js';
import { DATASET_FRESH_MS } from '../config.js';
import { readDerivedSection } from './derived.js';

/**
 * Answers the pages' existing section requests (ranked-keywords, backlinks-list, referring-domains) from the stored row sets in
 * MongoDB, in the SAME payload shape the provider path produces, so the frontend does not change. Paging, sorting, filtering and search all
 * run as MongoDB queries (skip/limit on an indexed, stable sort); nothing here can reach the provider.
 *
 * Returns null when the request cannot be answered from stored data (no dataset yet, or a request shape the stored set cannot represent,
 * like a provider search_after_token); the caller then falls back to what the cache holds, or reports "not collected".
 */

const MAX_GROUP_ROWS = 20000;

function ordersOf(kind, query) {
  if (kind === 'backlinks') return query.orderBy;
  return [query.orderBy];
}

const sumIf = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });

/** Organic totals of the MATCHING rows, shaped like the provider's `metrics.organic` (null when there are no matches). */
async function keywordMetrics(model, filter) {
  const [g] = await model.aggregate([
    { $match: filter },
    { $group: {
      _id: null,
      count: { $sum: 1 },
      etv: { $sum: '$trafficEstimate' },
      etvKnown: sumIf({ $isNumber: '$trafficEstimate' }),
      pos_1: sumIf({ $eq: ['$position', 1] }),
      pos_2_3: sumIf({ $and: [{ $gte: ['$position', 2] }, { $lte: ['$position', 3] }] }),
      pos_4_10: sumIf({ $and: [{ $gte: ['$position', 4] }, { $lte: ['$position', 10] }] }),
      is_new: sumIf({ $eq: ['$isNewRanking', true] }),
      is_up: sumIf({ $eq: ['$isUp', true] }),
      is_down: sumIf({ $eq: ['$isDown', true] }),
    } },
  ]).allowDiskUse(true);
  if (!g) return null;
  const { _id, etvKnown, ...rest } = g;
  return { ...rest, etv: etvKnown ? g.etv : null };
}

/** One row per source domain (or per anchor): the first by the requested sort. Bounded by the stored set. */
async function groupedBacklinks(model, filter, sort, key, skip, limit) {
  const base = [{ $match: filter }, { $sort: sort }, { $group: { _id: key, doc: { $first: '$$ROOT' } } }, { $replaceRoot: { newRoot: '$doc' } }];
  const [rows, counted] = await Promise.all([
    model.aggregate([...base, { $sort: sort }, { $skip: skip }, { $limit: limit }, { $project: { row: 1 } }]).allowDiskUse(true),
    model.aggregate([...base, { $limit: MAX_GROUP_ROWS }, { $count: 'n' }]).allowDiskUse(true),
  ]);
  return { rows, total: counted[0]?.n ?? 0 };
}

/**
 * @param {{ project: { _id: any }, section: string, query: object, extraConditions?: object[], now?: Date }} input `query` is the validator's canonical query
 * @returns {Promise<null | { payload: object, capturedAt: Date, expiresAt: Date, stale: boolean, dataset: object }>}
 */
export async function readFromDatabase({ project, section, query, extraConditions = [], now = new Date() }) {
  // Anchors and Top Pages are rolled up from the stored backlinks.
  if (section === 'anchors' || section === 'anchor-profile' || section === 'domain-pages') return readDerivedSection({ project, section, query, now });
  const kind = SECTION_TO_KIND[section];
  if (!kind || !query) return null;
  const def = KINDS[kind];
  const status = kind === 'keywords' ? null : query.status;
  if (kind === 'backlinks' && (query.token || !['live', 'lost'].includes(status))) return null;
  if (kind === 'referringDomains' && !['live', 'lost'].includes(status)) return null;

  const state = await latestDatasetState({ projectId: project._id, kind, status });
  if (!state) return null;

  const conditions = fromCanonical(query.filters ?? [], def.fieldMap);
  // "Dofollow only" on referring domains: the domains that have at least one dofollow page. (The provider re-counts every figure on dofollow
  // links only; stored rows keep their all-links figures, so the counts shown are the domain's totals.)
  if (kind === 'referringDomains' && query.dofollow) conditions.push({ path: 'followCount', op: '>', value: 0 });
  // Extra conditions are built by our own controllers on stored fields (location, device, country, date ranges), never from request text.
  conditions.push(...extraConditions);
  const matched = conditionsToMongo(conditions);
  const hasFilter = Object.keys(matched).length > 0;
  const filter = { projectId: project._id, scanId: state.scanId, ...(status ? { status } : {}), ...(hasFilter ? { $and: [matched] } : {}) };
  const sort = toMongoSort(ordersOf(kind, query), def.orderMap);
  const skip = query.offset ?? 0;
  const limit = query.limit;
  const { model } = def;

  let payload;
  if (kind === 'backlinks' && query.mode !== 'as_is') {
    const key = query.mode === 'one_per_domain' ? '$sourceDomain' : '$anchor';
    const { rows, total } = await groupedBacklinks(model, filter, sort, key, skip, limit);
    payload = { totalCount: total, nextToken: null, items: rows.map((r) => r.row) };
  } else {
    const [totalCount, rows] = await Promise.all([
      model.countDocuments(filter),
      model.find(filter).sort(sort).skip(skip).limit(limit).select('row').lean(),
    ]);
    const items = rows.map((r) => r.row);
    if (kind === 'keywords') {
      // Unfiltered: the provider's whole-domain totals from the collection (the stored rows may be capped). Filtered: the matching rows' own.
      const metrics = hasFilter ? await keywordMetrics(model, filter) : (state.data?.metrics ?? await keywordMetrics(model, filter));
      payload = { totalCount, metrics, items };
    } else if (kind === 'backlinks') payload = { totalCount, nextToken: null, items };
    else payload = { totalCount, items };
  }

  const capturedAt = new Date(state.capturedAt);
  const expiresAt = new Date(capturedAt.getTime() + DATASET_FRESH_MS[kind]);
  return {
    payload,
    capturedAt,
    expiresAt,
    stale: expiresAt.getTime() <= now.getTime(),
    dataset: { source: 'database', scanId: String(state.scanId), rows: state.data?.rows ?? null, totalCount: state.data?.totalCount ?? null, truncated: Boolean(state.data?.truncated) },
  };
}

export { MAX_GROUP_ROWS };
