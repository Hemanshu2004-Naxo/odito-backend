import { mongoRunStore } from './scanRunStore.js';
import { emitScanEvent } from './scanEvents.js';
import { collectDataset } from '../datasets/datasetCollector.js';
import { DATASETS, SCOPES, SCOPE_NAMES, SCAN_CONCURRENCY, SCAN_LEASE_MS, SCAN_HEARTBEAT_MS } from '../config.js';
import { getDomainOverviewSection } from '../../domain_overview/service/domainOverviewService.js';
import { parseSectionQuery } from '../../domain_overview/service/sectionQuery.js';
import { normalizeTargetDomain, ValidationFailure } from '../../shared/targetDomain.js';
import { resolveMarket } from '../../domain_overview/validator/domainOverviewValidation.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';

/**
 * Explicit, deduplicated SEO data collection. This is the ONLY door (besides a user's own "refresh" click) through which provider data is
 * bought for the pages; opening a page never gets here.
 *
 *   startScan  validates the scope -> takes the project's lock (one atomic insert) -> returns the run immediately (202) and works in the background
 *   - an identical scan already running is returned, not duplicated (`deduped`); a different scope gets a 409 naming the running scan;
 *   - datasets run with bounded concurrency; one failing never stops or loses the others (-> partially_completed);
 *   - a retry (retryOf) re-runs ONLY the datasets that did not complete;
 *   - by default only missing / stale data is bought (a fresh stored answer is reused); `force` buys everything again.
 *
 * The scan runs inside the process that accepted the request, protected by a lease: if that process dies, the lease expires and the next
 * start / status read ends the scan as failed and frees the lock. (There is no separate worker process or queue yet.)
 */

export class ScanConflict extends Error {
  constructor(active) {
    super('Another SEO scan is already running for this project.');
    this.name = 'ScanConflict';
    this.code = 'SCAN_IN_PROGRESS';
    this.active = active;
  }
}

/** A tiny concurrency limiter: at most `n` of the given async tasks in flight. */
async function runLimited(tasks, n) {
  let next = 0;
  const worker = async () => { while (next < tasks.length) { const i = next; next += 1; await tasks[i](); } };
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
}

/** The datasets a request asks for, as ids in catalogue order. Throws ValidationFailure for anything unknown. */
export function planDatasets({ scope, datasets }) {
  if (!SCOPE_NAMES.includes(scope)) throw new ValidationFailure('scope', `scope must be one of ${SCOPE_NAMES.join(', ')}`);
  let ids;
  if (scope === 'dataset') {
    if (!Array.isArray(datasets) || datasets.length === 0 || datasets.length > 20) throw new ValidationFailure('datasets', 'datasets must list 1 to 20 dataset ids');
    ids = datasets.map(String);
    const unknown = ids.filter((id) => !Object.hasOwn(DATASETS, id));
    if (unknown.length) throw new ValidationFailure('datasets', `unknown dataset: ${unknown[0].slice(0, 40)}`);
  } else {
    if (datasets !== undefined) throw new ValidationFailure('datasets', 'datasets applies to the "dataset" scope only');
    ids = [...SCOPES[scope]];
  }
  const set = new Set(ids);
  // A dependent dataset needs the one it depends on, in the same scan.
  for (const id of set) { const dep = DATASETS[id].dependsOn; if (dep) set.add(dep); }
  return Object.keys(DATASETS).filter((id) => set.has(id));
}

const errorCodeOf = (err) => String(err?.code ?? 'UNKNOWN').slice(0, 60);

/**
 * @param {{ project: object, userId: string, scope: string, datasets?: string[], force?: boolean, retryOf?: string|null }} input
 * @param {{ store?: typeof mongoRunStore, fetchSection?: Function, now?: () => Date, concurrency?: number, leaseMs?: number, heartbeatMs?: number }} [deps]
 * @returns {Promise<{ run: object, deduped: boolean, done: Promise<object>|null }>} `done` settles when the background work has ended (tests await it)
 */
export async function startScan({ project, userId, scope, datasets, force = false, retryOf = null }, deps = {}) {
  const {
    store = mongoRunStore, fetchSection = getDomainOverviewSection, now = () => new Date(),
    concurrency = SCAN_CONCURRENCY, leaseMs = SCAN_LEASE_MS, heartbeatMs = SCAN_HEARTBEAT_MS,
  } = deps;
  const target = normalizeTargetDomain(project.main_url);
  const market = resolveMarket(project);

  let ids = retryOf ? [] : planDatasets({ scope, datasets });
  let retryCount = 0;
  if (retryOf) {
    // Retry = only what did not complete in that scan (scope and datasets of the original, minus its successes).
    const original = await store.get(project._id, retryOf);
    if (!original) throw new ValidationFailure('retryOf', 'That scan was not found for this project.');
    const done = new Set(original.datasets.filter((d) => d.status === 'completed').map((d) => d.id));
    ids = original.datasets.map((d) => d.id).filter((id) => !done.has(id) && Object.hasOwn(DATASETS, id));
    if (!ids.length) throw new ValidationFailure('retryOf', 'Every dataset of that scan already completed.');
    retryCount = (original.retryCount ?? 0) + 1;
  }

  const startedAt = now();
  await store.expireStale(project._id, startedAt);
  const doc = {
    projectId: project._id, domain: target, market: { location: market.location_name, language: market.language_name },
    scope: retryOf ? 'dataset' : scope, status: 'pending', triggerType: retryOf ? 'retry' : 'manual', requestedBy: userId || null,
    force: Boolean(force), retryOf: retryOf || null, retryCount, datasetsRequested: ids,
    datasets: ids.map((id) => ({ id, section: DATASETS[id].section, status: 'pending' })), leaseUntil: new Date(startedAt.getTime() + leaseMs),
  };
  const run = await store.tryAcquire(doc);
  if (!run) {
    const active = await store.findActive(project._id);
    // The lock may have been released between the failed insert and this read: one more try, then give up honestly.
    if (!active) {
      const again = await store.tryAcquire(doc);
      if (again) return { run: again, deduped: false, done: execute(again, { project, userId, store, fetchSection, now, concurrency, leaseMs, heartbeatMs }) };
      throw new ScanConflict(null);
    }
    const same = active.scope === doc.scope && JSON.stringify(active.datasetsRequested) === JSON.stringify(ids);
    if (same) return { run: active, deduped: true, done: null };
    throw new ScanConflict(active);
  }
  return { run, deduped: false, done: execute(run, { project, userId, store, fetchSection, now, concurrency, leaseMs, heartbeatMs }) };
}

/** Runs the plan of an acquired run. Never throws; always ends the run (which frees the lock). */
function execute(run, ctx) {
  const { project, userId, store, fetchSection, now, concurrency, leaseMs, heartbeatMs } = ctx;
  const counters = { completed: 0, failed: 0 };
  const results = new Map();

  const work = async () => {
    await store.setStarted(run._id, now());
    emitScanEvent('started', { ...run, status: 'running' });
    const live = { ...run, status: 'running', datasetsCompleted: 0, datasetsFailed: 0 };

    const runOne = (ds) => async () => {
      const def = DATASETS[ds.id];
      const t0 = Date.now();
      await store.updateDataset(run._id, ds.id, { status: 'running', startedAt: now() });
      try {
        // A row-level dataset is collected page by page and persisted; every other dataset is one section answer.
        const out = def.collector
          ? await collectDataset({ kind: def.collector, status: def.status, project, scanId: run._id, userId, force: run.force, skipIfFresh: run.triggerType !== 'retry', fetchSection, now })
          : await fetchSection({ project, section: def.section, query: parseSectionQuery(def.section, def.params ?? {}, project), refresh: Boolean(run.force), userId, scanId: run._id, providerAllowed: true });
        results.set(ds.id, out.result);
        // Provider requests this dataset really made: a collector says how many pages it bought; a section is one request unless it was a cache hit.
        const requests = def.collector ? out.requests : (out.cached ? 0 : 1);
        const bought = requests > 0;
        const cost = bought && typeof out.cost === 'number' ? out.cost : null;
        await store.updateDataset(run._id, ds.id, { status: 'completed', cached: Boolean(out.cached), fetchedAt: out.fetchedAt ? new Date(out.fetchedAt) : null, cost, durationMs: Date.now() - t0, finishedAt: now() });
        await store.addCounters(run._id, { completed: 1, requests, cost: cost ?? 0 });
        counters.completed += 1; live.datasetsCompleted = counters.completed;
        emitScanEvent('dataset_completed', live, { datasetId: ds.id });
        emitScanEvent('progress', live);
      } catch (err) {
        const code = errorCodeOf(err);
        LoggerUtil.warn('SEO scan: dataset failed', { scanId: String(run._id), dataset: ds.id, code });
        await store.updateDataset(run._id, ds.id, { status: 'failed', errorCode: code, durationMs: Date.now() - t0, finishedAt: now() });
        await store.addCounters(run._id, { failed: 1 });
        counters.failed += 1; live.datasetsFailed = counters.failed;
        emitScanEvent('dataset_failed', live, { datasetId: ds.id, errorCode: code });
        emitScanEvent('progress', live);
      }
    };
    const skip = async (ds) => { await store.updateDataset(run._id, ds.id, { status: 'skipped', finishedAt: now() }); };

    const independent = run.datasets.filter((d) => !DATASETS[d.id].dependsOn);
    const dependent = run.datasets.filter((d) => DATASETS[d.id].dependsOn);
    await runLimited(independent.map(runOne), concurrency);
    // A dependent dataset runs only when the one it depends on completed AND says it is worth buying.
    const wave = [];
    for (const ds of dependent) {
      const def = DATASETS[ds.id];
      if (results.has(def.dependsOn) && def.when(results.get(def.dependsOn))) wave.push(runOne(ds));
      else await skip(ds);
    }
    await runLimited(wave, concurrency);

    const status = counters.failed === 0 ? 'completed' : counters.completed === 0 ? 'failed' : 'partially_completed';
    const ended = await store.finish(run._id, { status, error: status === 'failed' ? { code: 'ALL_DATASETS_FAILED' } : null, now: now() });
    emitScanEvent(status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'partial', { ...(ended ?? run), status });
    return ended;
  };

  // The lease is extended while work goes on; a dead process stops extending it.
  const timer = setInterval(() => { store.heartbeat(run._id, new Date(now().getTime() + leaseMs)).catch(() => {}); }, heartbeatMs);
  timer.unref?.();
  return work()
    .catch(async (err) => {
      LoggerUtil.error('SEO scan: unexpected failure', err, { scanId: String(run._id) });
      const ended = await store.finish(run._id, { status: 'failed', error: { code: 'SCAN_INTERNAL' }, now: now() }).catch(() => null);
      emitScanEvent('failed', { ...(ended ?? run), status: 'failed' });
      return ended;
    })
    .finally(() => clearInterval(timer));
}

/** A run for the browser: counts, per-dataset state and codes. No user ids, no lock internals. */
export function toPublicRun(run, { now = new Date() } = {}) {
  if (!run) return null;
  const expired = ['pending', 'queued', 'running'].includes(run.status) && run.leaseUntil && new Date(run.leaseUntil) < now;
  return {
    id: String(run._id),
    scope: run.scope,
    status: expired ? 'failed' : run.status,
    triggerType: run.triggerType,
    force: Boolean(run.force),
    retryOf: run.retryOf ? String(run.retryOf) : null,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    createdAt: run.createdAt ?? null,
    datasetsCompleted: run.datasetsCompleted ?? 0,
    datasetsFailed: run.datasetsFailed ?? 0,
    totalDatasets: run.datasets?.length ?? 0,
    providerRequestsCount: run.providerRequestsCount ?? 0,
    reportedCost: run.reportedCost ?? 0,
    error: expired ? { code: 'SCAN_LEASE_EXPIRED' } : run.error ?? null,
    datasets: (run.datasets ?? []).map((d) => ({
      id: d.id, section: d.section, status: d.status, cached: d.cached ?? null, fetchedAt: d.fetchedAt ?? null, errorCode: d.errorCode ?? null,
    })),
  };
}
