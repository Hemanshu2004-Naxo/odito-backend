import SeoSnapshot from '../model/SeoSnapshot.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';

/**
 * Append-only history of summary datasets. Written only when Odito REALLY bought fresh provider data (domainOverviewService calls
 * recordSectionSnapshot on a non-cached answer); read by the history / comparison endpoints, which never reach the provider.
 */

/** domain-overview section -> the snapshot it feeds. `onlyDefault`: list-like sections are snapshotted for their default view only. */
export const SNAPSHOT_RULES = Object.freeze({
  'rank-overview': { datasetType: 'domain_overview' },
  'history': { datasetType: 'traffic' },
  'ranked-keywords': { datasetType: 'organic_keyword_summary', onlyDefault: true },
  'competitors': { datasetType: 'competitor_summary', onlyDefault: true },
  'backlinks': { datasetType: 'backlink_summary', onlyDefault: true },
  'anchor-profile': { datasetType: 'anchor_summary' },
  'rd-rank-buckets': { datasetType: 'referring_domain_summary' },
  'rd-toxic-count': { datasetType: 'referring_domain_summary' },
  'rd-last-30': { datasetType: 'referring_domain_summary' },
  'tp-counts': { datasetType: 'top_linked_pages_summary' },
  // Dataset-state snapshots (written by datasets/datasetStore.js, never by recordSectionSnapshot): which scan is the latest COMPLETE row set.
  'dataset:keywords': { datasetType: 'organic_keyword_dataset', stateOnly: true },
  'dataset:backlinks': { datasetType: 'backlink_dataset', stateOnly: true },
  'dataset:referring-domains': { datasetType: 'referring_domain_dataset', stateOnly: true },
});

/** The Off-Page Overview page shows the backlink summary: one dataset, two names. */
export const DATASET_ALIASES = Object.freeze({ offpage_overview: 'backlink_summary' });
export const DATASET_TYPES = Object.freeze([...new Set(Object.values(SNAPSHOT_RULES).map((r) => r.datasetType))]);

/** A snapshot is one document: keep well under MongoDB's 16 MB limit (a summary is a few KB; anything this big is not a summary). */
export const MAX_SNAPSHOT_BYTES = 1_500_000;
const SCHEMA_VERSION = 1;

/**
 * Never throws and never blocks the answer that was just bought. Returns the snapshot id, or null when the section has none / it was skipped.
 */
export async function recordSectionSnapshot({
  project, section, target, market, variant = '', payload, fetchedAt, cost = null, scanId = null, isDefaultView = true,
}, { model = SeoSnapshot } = {}) {
  const rule = SNAPSHOT_RULES[section];
  if (!rule || rule.stateOnly || (rule.onlyDefault && !isDefaultView) || payload == null) return null;
  try {
    const size = Buffer.byteLength(JSON.stringify(payload));
    if (size > MAX_SNAPSHOT_BYTES) {
      LoggerUtil.warn('SEO snapshot skipped: payload too large for a summary snapshot', { section, size });
      return null;
    }
    const doc = await model.create({
      projectId: project._id,
      domain: target,
      scanId,
      datasetType: rule.datasetType,
      part: section,
      variant,
      market: market ? { location: market.location_name, language: market.language_name } : null,
      data: payload,
      cost: typeof cost === 'number' && Number.isFinite(cost) ? cost : null,
      capturedAt: fetchedAt instanceof Date ? fetchedAt : new Date(fetchedAt),
      source: scanId ? 'scan' : 'refresh',
      schemaVersion: SCHEMA_VERSION,
    });
    return doc._id;
  } catch (err) {
    LoggerUtil.warn('SEO snapshot could not be saved (the answer is still returned)', { section, error: err?.message });
    return null;
  }
}

const resolveType = (datasetType) => DATASET_ALIASES[datasetType] ?? datasetType;

/**
 * Snapshots of one dataset for a project, newest first, bounded. `from` / `to` are UTC instants (inclusive / exclusive).
 * Reads MongoDB only.
 */
export async function listSnapshots({ projectId, datasetType, part = null, from = null, to = null, limit = 50 }, { model = SeoSnapshot } = {}) {
  const filter = { projectId, datasetType: resolveType(datasetType) };
  if (part) filter.part = part;
  if (from || to) filter.capturedAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lt: to } : {}) };
  return model.find(filter).sort({ capturedAt: -1 }).limit(Math.min(Math.max(1, limit), 200)).select('-__v').lean();
}

/** The most recent snapshot of a dataset part, or null. */
export async function latestSnapshot({ projectId, datasetType, part }, { model = SeoSnapshot } = {}) {
  const [row] = await listSnapshots({ projectId, datasetType, part, limit: 1 }, { model });
  return row ?? null;
}

const PERIOD_DAYS = Object.freeze({ week: 7, month: 30 });
/** previous = the snapshot before the newest; week / month = the newest one at least that old. */
export const COMPARISON_PERIODS = Object.freeze(['previous', ...Object.keys(PERIOD_DAYS)]);

/**
 * The newest snapshot and the one to compare it with: the newest snapshot captured at least `period` before it (UTC, to the instant — two
 * scans on one day are two snapshots). `previous: null` when Odito has no snapshot that old: the caller shows "not enough history",
 * never a zero. Reads MongoDB only.
 */
export async function compareToPrevious({ projectId, datasetType, part, period }, { model = SeoSnapshot } = {}) {
  const days = PERIOD_DAYS[period];
  if (period !== 'previous' && !days) throw new RangeError(`period must be one of ${COMPARISON_PERIODS.join(', ')}`);
  const type = resolveType(datasetType);
  const latest = await model.findOne({ projectId, datasetType: type, part }).sort({ capturedAt: -1 }).select('-__v').lean();
  if (!latest) return { latest: null, previous: null, period };
  // previous: strictly older than the newest; week / month: at least that much older.
  const bound = period === 'previous' ? { $lt: new Date(latest.capturedAt) } : { $lte: new Date(new Date(latest.capturedAt).getTime() - days * 86_400_000) };
  const previous = await model.findOne({ projectId, datasetType: type, part, capturedAt: bound }).sort({ capturedAt: -1 }).select('-__v').lean();
  return { latest, previous: previous ?? null, period };
}
