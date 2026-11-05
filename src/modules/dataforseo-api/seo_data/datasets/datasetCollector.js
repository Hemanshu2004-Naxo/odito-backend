import SeoSnapshot from '../model/SeoSnapshot.js';
import { KINDS, STATE_PART, STATE_TYPE } from './definitions.js';
import { COLLECT_BATCH, DATASET_CAPS, DATASET_FRESH_MS } from '../config.js';
import { parseSectionQuery } from '../../domain_overview/service/sectionQuery.js';
import { resolveMarket } from '../../domain_overview/validator/domainOverviewValidation.js';
import { normalizeTargetDomain } from '../../shared/targetDomain.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';

/**
 * Collects one row-level dataset through the EXISTING section code (so the provider integration, its cache, its budgets and its error
 * handling are reused, not copied), and persists every batch the moment it arrives:
 *
 *   - rows go in with bulkWrite upserts keyed by the dataset's natural key within the scan ($setOnInsert only), so a batch that overlaps
 *     the previous one, or a batch written twice, creates no duplicate and changes nothing;
 *   - the dataset only becomes the LATEST one (a state snapshot in seo_snapshots) after every batch succeeded. A scan that fails halfway
 *     leaves rows under its own scanId that nothing reads; the previous complete dataset keeps serving the pages;
 *   - a dataset that is still fresh is not collected again without `force`, so a second scan does not re-store the same rows.
 */

const KIND_CONFIG = {
  keywords: { fresh: DATASET_FRESH_MS.keywords, cap: () => DATASET_CAPS.keywords, paging: 'offset' },
  backlinks: { fresh: DATASET_FRESH_MS.backlinks, cap: (status) => (status === 'lost' ? DATASET_CAPS.backlinksLost : DATASET_CAPS.backlinksLive), paging: 'token' },
  referringDomains: { fresh: DATASET_FRESH_MS.referringDomains, cap: (status) => (status === 'lost' ? DATASET_CAPS.referringDomainsLost : DATASET_CAPS.referringDomainsLive), paging: 'offset' },
};

/** The state variant of a dataset: the keywords have one, links and domains one per status. */
export const variantOf = (kind, status) => (kind === 'keywords' ? '' : status);

/** The newest complete dataset of a kind (and status) for a project, or null. Reads MongoDB only. */
export async function latestDatasetState({ projectId, kind, status = null }, { snapshots = SeoSnapshot } = {}) {
  return snapshots.findOne({ projectId, datasetType: STATE_TYPE[kind], part: STATE_PART[kind], variant: variantOf(kind, status) })
    .sort({ capturedAt: -1 }).select('-__v').lean();
}

/** Idempotent bulk write of one batch. Returns how many NEW rows it stored. */
export async function persistRows(kind, rows, { project, scanId, status, market, domain, capturedAt }, { model = KINDS[kind].model } = {}) {
  const def = KINDS[kind];
  const ctx = { market, status };
  const ops = [];
  for (const row of rows) {
    const nk = def.naturalKey(row, ctx);
    const doc = {
      ...def.toDoc(row, ctx), projectId: project._id, domain, scanId, row, capturedAt,
      ...(kind === 'referringDomains' ? {} : { nk }),
    };
    const key = kind === 'referringDomains'
      ? { projectId: project._id, scanId, status, referringDomain: doc.referringDomain }
      : { projectId: project._id, scanId, nk };
    ops.push({ updateOne: { filter: key, update: { $setOnInsert: doc }, upsert: true } });
  }
  if (!ops.length) return 0;
  let inserted = 0;
  for (let i = 0; i < ops.length; i += 500) {
    // eslint-disable-next-line no-await-in-loop
    const res = await model.bulkWrite(ops.slice(i, i + 500), { ordered: false });
    inserted += res.upsertedCount ?? 0;
  }
  return inserted;
}

/**
 * @param {{ kind: 'keywords'|'backlinks'|'referringDomains', status?: 'live'|'lost'|null, project: object, scanId: any, userId?: string|null,
 *           force?: boolean, skipIfFresh?: boolean, fetchSection: Function, now?: () => Date }} input
 * @returns {Promise<{ cached: boolean, skipped: boolean, requests: number, cost: number|null, fetchedAt: Date, rows: number }>}
 */
export async function collectDataset({ kind, status = null, project, scanId, userId = null, force = false, skipIfFresh = true, fetchSection, now = () => new Date() }, deps = {}) {
  const cfg = KIND_CONFIG[kind];
  const def = KINDS[kind];
  const stateStore = deps.snapshots ?? SeoSnapshot;
  const started = now();

  const previous = await latestDatasetState({ projectId: project._id, kind, status }, { snapshots: stateStore });
  const skippedResult = { cached: true, skipped: true, requests: 0, cost: null, fetchedAt: previous ? new Date(previous.capturedAt) : started, rows: previous?.data?.rows ?? 0 };
  if (!force && skipIfFresh && previous && started.getTime() - new Date(previous.capturedAt).getTime() < cfg.fresh) return skippedResult;

  const domain = normalizeTargetDomain(project.main_url);
  const market = { location_name: resolveMarket(project).location_name, language_name: resolveMarket(project).language_name };
  const cap = cfg.cap(status);
  const common = { project, scanId, status, market, domain, capturedAt: started };

  let stored = 0; let seen = 0; let requests = 0; let cost = 0; let providerTotal = null; let metrics = null; let token = null;
  const maxBatches = Math.ceil(cap / COLLECT_BATCH) + 2;
  for (let batch = 0; batch < maxBatches && stored < cap; batch += 1) {
    const params = { limit: String(COLLECT_BATCH) };
    if (kind === 'keywords') params.offset = String(seen);
    if (kind === 'referringDomains') { params.offset = String(seen); params.status = status; }
    if (kind === 'backlinks') { params.status = status; if (token) params.token = token; }
    const query = parseSectionQuery(def.section, params, project);
    // eslint-disable-next-line no-await-in-loop
    const out = await fetchSection({ project, section: def.section, query, refresh: Boolean(force), userId, scanId, providerAllowed: true });
    // A forced scan inside the provider-refresh floor (see apiCache MIN_REFRESH_INTERVAL_MS) is answered from the entry it would replace: that is
    // not new data, so it must not become a new stored set / history point under a new scan id.
    if (batch === 0 && force && out.cached && out.refreshThrottled && previous) return skippedResult;
    if (!out.cached) requests += 1;
    if (typeof out.cost === 'number') cost += out.cost;
    const result = out.result ?? {};
    const items = Array.isArray(result.items) ? result.items : [];
    if (batch === 0) { providerTotal = typeof result.totalCount === 'number' ? result.totalCount : null; metrics = result.metrics ?? null; }
    const room = cap - stored;
    // eslint-disable-next-line no-await-in-loop
    stored += await persistRows(kind, items.slice(0, room), common, deps.model ? { model: deps.model } : {});
    seen += items.length;
    token = result.nextToken ?? null;
    if (items.length === 0) break;
    if (cfg.paging === 'token' ? !token : (providerTotal !== null && seen >= providerTotal)) break;
  }

  // Only a fully collected dataset becomes the one the pages read.
  await stateStore.create({
    projectId: project._id, domain, scanId, datasetType: STATE_TYPE[kind], part: STATE_PART[kind], variant: variantOf(kind, status),
    market: { location: market.location_name, language: market.language_name },
    data: { scanId: String(scanId), rows: stored, totalCount: providerTotal, truncated: providerTotal === null ? stored >= cap : providerTotal > stored, cap, metrics, requests },
    cost: requests ? cost : null, capturedAt: started, source: 'scan', schemaVersion: 1,
  });
  LoggerUtil.info('SEO dataset collected', { kind, status, scanId: String(scanId), rows: stored, providerTotal, requests });
  return { cached: requests === 0, skipped: false, requests, cost: requests ? cost : null, fetchedAt: started, rows: stored };
}
