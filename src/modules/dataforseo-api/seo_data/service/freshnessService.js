import { DATASETS, PAGE_DATASETS, DATASET_FRESH_MS } from '../config.js';
import { latestDatasetState } from '../datasets/datasetCollector.js';
import { mongoRunStore } from './scanRunStore.js';
import { getDomainOverviewSection } from '../../domain_overview/service/domainOverviewService.js';
import { parseSectionQuery } from '../../domain_overview/service/sectionQuery.js';

/**
 * Freshness of EACH dataset on its own. A scan of one dataset says nothing about the others, so this never looks at "the last scan":
 *   - a row-level dataset (keywords, backlinks, referring domains) is described by its newest COMPLETE collection (its state snapshot);
 *   - every other dataset by the stored answer the pages read for it (fresh / stale by its own freshness deadline, or missing).
 * `lastError` is the most recent failure of that dataset in a recent scan, shown only while it is newer than the last success. Nothing here
 * can reach the provider (the section reads are read-only).
 *
 * state: 'fresh' | 'stale' | 'missing'. A stale dataset is still served; a failed refresh never turned a good dataset into a missing one.
 */

const KIND_FRESH = { keywords: DATASET_FRESH_MS.keywords, backlinks: DATASET_FRESH_MS.backlinks, referringDomains: DATASET_FRESH_MS.referringDomains };

async function describeOne(id, { project, userId, now }) {
  const def = DATASETS[id];
  if (def.collector) {
    const state = await latestDatasetState({ projectId: project._id, kind: def.collector, status: def.status });
    if (!state) return { id, section: def.section, kind: 'rows', state: 'missing', lastSuccessfulAt: null, lastSuccessfulScanId: null, expiresAt: null, rows: null, providerTotal: null, truncated: null };
    const expiresAt = new Date(new Date(state.capturedAt).getTime() + KIND_FRESH[def.collector]);
    return {
      id, section: def.section, kind: 'rows', state: expiresAt <= now ? 'stale' : 'fresh', lastSuccessfulAt: state.capturedAt, lastSuccessfulScanId: String(state.scanId), expiresAt,
      rows: state.data?.rows ?? null, providerTotal: state.data?.totalCount ?? null, truncated: Boolean(state.data?.truncated),
    };
  }
  const out = await getDomainOverviewSection({
    project, section: def.section, query: parseSectionQuery(def.section, def.params ?? {}, project), providerAllowed: false, userId, now,
  });
  if (out.missing) return { id, section: def.section, kind: 'section', state: 'missing', lastSuccessfulAt: null, lastSuccessfulScanId: null, expiresAt: null, rows: null, providerTotal: null, truncated: null };
  return {
    id, section: def.section, kind: 'section', state: out.stale ? 'stale' : 'fresh', lastSuccessfulAt: out.fetchedAt, lastSuccessfulScanId: out.dataset?.scanId ?? null, expiresAt: out.expiresAt,
    rows: out.dataset?.rows ?? (Array.isArray(out.result?.items) ? out.result.items.length : null), providerTotal: out.result?.totalCount ?? null, truncated: out.dataset ? Boolean(out.dataset.truncated) : null,
  };
}

/** The newest failure of a dataset among recent scans that is later than its last success. */
function lastErrorOf(id, runs, lastSuccessfulAt) {
  for (const run of runs) {
    const d = run.datasets?.find((x) => x.id === id);
    if (!d || d.status !== 'failed' || !d.errorCode) continue;
    const at = d.finishedAt ?? run.finishedAt;
    if (!lastSuccessfulAt || (at && new Date(at) > new Date(lastSuccessfulAt))) return { code: d.errorCode, at: at ?? null, scanId: String(run._id) };
    return null; // the newest failure is older than the last success
  }
  return null;
}

/**
 * @param {{ project: object, userId?: string|null, page?: string|null, now?: Date }} input `page` narrows to the datasets that page shows
 * @returns {Promise<{ datasets: object[] }>}
 */
export async function getDatasetFreshness({ project, userId = null, page = null, now = new Date() }, { store = mongoRunStore } = {}) {
  const ids = page ? PAGE_DATASETS[page] : Object.keys(DATASETS);
  const [described, runs] = await Promise.all([
    Promise.all(ids.map((id) => describeOne(id, { project, userId, now }))),
    store.list(project._id, 20),
  ]);
  return { datasets: described.map((d) => ({ ...d, lastError: lastErrorOf(d.id, runs, d.lastSuccessfulAt) })) };
}
