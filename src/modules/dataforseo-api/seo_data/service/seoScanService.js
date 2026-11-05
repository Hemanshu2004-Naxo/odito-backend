import { mongoRunStore } from './scanRunStore.js';
import { emitScanEvent } from './scanEvents.js';
import { collectDataset } from '../datasets/datasetCollector.js';
import { DATASETS, SCOPES, SCOPE_NAMES, SCAN_CONCURRENCY, SCAN_LEASE_MS, SCAN_HEARTBEAT_MS, SCAN_MAX_ATTEMPTS, SCAN_RETRY, PROVIDER_CONCURRENCY } from '../config.js';
import { getDomainOverviewSection } from '../../domain_overview/service/domainOverviewService.js';
import { parseSectionQuery } from '../../domain_overview/service/sectionQuery.js';
import { normalizeTargetDomain, ValidationFailure } from '../../shared/targetDomain.js';
import { resolveMarket } from '../../domain_overview/validator/domainOverviewValidation.js';
import { DATAFORSEO_ERROR } from '../../shared/providerErrors.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';

/**
 * Explicit, deduplicated SEO data collection. This is the ONLY door (besides a user's own "refresh" click) through which provider data is
 * bought for the pages; opening a page never gets here.
 *
 *   startScan   (web request) validates the scope -> takes the project's lock with ONE insert -> the scan is `queued` and the request returns.
 *               An identical scan already active is returned (`deduped`); a different scope gets a 409 naming the active scan.
 *   executeRun  (worker) works through the datasets with bounded concurrency. One failing dataset never stops or loses the others
 *               (-> partially_completed); a transient provider error is retried with backoff, a permanent one is not; a retry (retryOf)
 *               re-runs ONLY the datasets that did not complete. If the worker dies, another worker claims the scan when its lease expires and
 *               continues with the datasets not yet completed (completed ones are never bought again).
 *
 * By default only missing / stale data is bought (a fresh stored answer is reused); `force` buys everything again.
 */

export class ScanConflict extends Error {
  constructor(active) {
    super('Another SEO scan is already running for this project.');
    this.name = 'ScanConflict';
    this.code = 'SCAN_IN_PROGRESS';
    this.active = active;
  }
}

/** A tiny concurrency limiter: at most `n` of the given async tasks in flight; a task is not even started once `shouldStop()` is true. */
async function runLimited(tasks, n, shouldStop = () => false) {
  let next = 0;
  const worker = async () => { while (next < tasks.length && !shouldStop()) { const i = next; next += 1; await tasks[i](); } };
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
}

/** A counting semaphore: the provider is never asked more than `n` things at once by this process, however many scans are running. */
export function createGate(n) {
  let free = n;
  const waiting = [];
  const release = () => { const w = waiting.shift(); if (w) w(); else free += 1; };
  return async (fn) => {
    if (free > 0) free -= 1; else await new Promise((resolve) => waiting.push(resolve));
    try { return await fn(); } finally { release(); }
  };
}
const defaultGate = createGate(PROVIDER_CONCURRENCY);

/** Provider failures worth trying again: the network, a timeout, the provider being down or busy. Credentials, credits and rejected requests are not. */
const TRANSIENT = new Set([DATAFORSEO_ERROR.NETWORK, DATAFORSEO_ERROR.TIMEOUT, DATAFORSEO_ERROR.UNAVAILABLE, DATAFORSEO_ERROR.RATE_LIMITED]);
export const isTransientError = (err) => TRANSIENT.has(String(err?.code));

const sleepReal = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** fn() with retries on transient errors only: `attempts` tries in all, delays baseMs, 2x, 4x ... Resolves { value, tries } or throws the last error (with `.tries`). */
export async function withRetries(fn, { attempts = 1, baseMs = 0, sleep = sleepReal } = {}) {
  let tries = 0;
  for (;;) {
    tries += 1;
    try {
      return { value: await fn(), tries };
    } catch (err) {
      if (tries >= attempts || !isTransientError(err)) { err.tries = tries; throw err; }
      // eslint-disable-next-line no-await-in-loop
      await sleep(baseMs * 2 ** (tries - 1));
    }
  }
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
 * Validates and ENQUEUES a scan. Nothing is bought here and the request does not wait for any provider call: a worker picks the scan up.
 * @param {{ project: object, userId: string, scope: string, datasets?: string[], force?: boolean, retryOf?: string|null }} input
 * @param {{ store?: typeof mongoRunStore, now?: () => Date }} [deps]
 * @returns {Promise<{ run: object, deduped: boolean }>}
 */
export async function startScan({ project, userId, scope, datasets, force = false, retryOf = null }, deps = {}) {
  const { store = mongoRunStore, now = () => new Date() } = deps;
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

  const createdAt = now();
  const doc = {
    projectId: project._id, domain: target, market: { location: market.location_name, language: market.language_name },
    scope: retryOf ? 'dataset' : scope, triggerType: retryOf ? 'retry' : 'manual', requestedBy: userId || null,
    force: Boolean(force), retryOf: retryOf || null, retryCount, datasetsRequested: ids,
    datasets: ids.map((id) => ({ id, section: DATASETS[id].section, status: 'pending' })), attempts: 0, nextAttemptAt: null,
  };
  const run = await store.tryAcquire(doc);
  if (!run) {
    const active = await store.findActive(project._id);
    // The lock may have been released between the failed insert and this read: one more try, then give up honestly.
    if (!active) {
      const again = await store.tryAcquire(doc);
      if (again) return { run: again, deduped: false };
      throw new ScanConflict(null);
    }
    const same = active.scope === doc.scope && JSON.stringify(active.datasetsRequested) === JSON.stringify(ids);
    if (same) return { run: active, deduped: true };
    throw new ScanConflict(active);
  }
  LoggerUtil.info('SEO scan queued', { scanId: String(run._id), scope: doc.scope, datasets: ids.length, at: createdAt.toISOString() });
  return { run, deduped: false };
}

/**
 * Works through a CLAIMED run (see worker/seoScanWorker.js). Never throws; always leaves the run in a defined state:
 *   finished (completed | partially_completed | failed, lock freed), requeued (graceful stop / unexpected error with attempts left), or
 *   abandoned (this worker lost the lease to another one: it stops and writes nothing more).
 * @returns {Promise<'finished'|'requeued'|'lost'>}
 */
export async function executeRun(run, ctx) {
  const {
    project, userId = null, store = mongoRunStore, fetchSection = getDomainOverviewSection, now = () => new Date(), workerId = 'local',
    concurrency = SCAN_CONCURRENCY, leaseMs = SCAN_LEASE_MS, heartbeatMs = SCAN_HEARTBEAT_MS, maxAttempts = SCAN_MAX_ATTEMPTS,
    retry = SCAN_RETRY, sleep = sleepReal, gate = defaultGate, isStopping = () => false,
  } = ctx;
  let owned = true;
  const results = new Map();
  const live = { ...run, status: 'running' };
  const gated = (args) => gate(() => fetchSection(args));

  const timer = setInterval(() => {
    store.heartbeat(run._id, workerId, new Date(now().getTime() + leaseMs)).then((ok) => { if (!ok) owned = false; }, () => {});
  }, heartbeatMs);
  timer.unref?.();
  const shouldStop = () => !owned || isStopping();

  const fetchDataset = async (def) => (def.collector
    ? collectDataset({ kind: def.collector, status: def.status, project, scanId: run._id, userId, force: run.force, skipIfFresh: run.triggerType !== 'retry', fetchSection: gated, now })
    : gated({ project, section: def.section, query: parseSectionQuery(def.section, def.params ?? {}, project), refresh: Boolean(run.force), userId, scanId: run._id, providerAllowed: true }));

  const runOne = (ds) => async () => {
    const def = DATASETS[ds.id];
    const t0 = Date.now();
    await store.updateDataset(run._id, ds.id, { status: 'running', startedAt: now() });
    try {
      const { value: out, tries } = await withRetries(() => fetchDataset(def), { ...retry, sleep });
      results.set(ds.id, out.result);
      // Provider requests this dataset really made: a collector says how many pages it bought; a section is one request unless it was a cache hit.
      const requests = def.collector ? out.requests : (out.cached ? 0 : 1);
      const cost = requests > 0 && typeof out.cost === 'number' ? out.cost : null;
      await store.updateDataset(run._id, ds.id,
        { status: 'completed', cached: Boolean(out.cached), fetchedAt: out.fetchedAt ? new Date(out.fetchedAt) : null, cost, durationMs: Date.now() - t0, errorCode: null, attempts: tries, finishedAt: now() },
        { datasetsCompleted: 1, providerRequestsCount: requests, reportedCost: cost ?? 0 });
      live.datasetsCompleted = (live.datasetsCompleted ?? 0) + 1;
      emitScanEvent('dataset_completed', live, { datasetId: ds.id });
      emitScanEvent('progress', live);
    } catch (err) {
      const code = errorCodeOf(err);
      LoggerUtil.warn('SEO scan: dataset failed', { scanId: String(run._id), dataset: ds.id, code, tries: err.tries ?? 1 });
      await store.updateDataset(run._id, ds.id, { status: 'failed', errorCode: code, attempts: err.tries ?? 1, durationMs: Date.now() - t0, finishedAt: now() }, { datasetsFailed: 1 });
      live.datasetsFailed = (live.datasetsFailed ?? 0) + 1;
      emitScanEvent('dataset_failed', live, { datasetId: ds.id, errorCode: code });
      emitScanEvent('progress', live);
    }
  };

  /** The result a dependent dataset decides on: this attempt's, or (resumed scan) the stored answer of the earlier attempt - never a new purchase. */
  const dependencyResult = async (depId) => {
    if (results.has(depId)) return results.get(depId);
    const dep = run.datasets.find((d) => d.id === depId);
    if (dep?.status !== 'completed') return undefined;
    const def = DATASETS[depId];
    const stored = await fetchSection({ project, section: def.section, query: parseSectionQuery(def.section, def.params ?? {}, project), providerAllowed: false, userId });
    return stored.missing ? undefined : stored.result;
  };

  try {
    if ((run.attempts ?? 1) <= 1) emitScanEvent('started', live);
    const todo = run.datasets.filter((d) => d.status === 'pending');
    const independent = todo.filter((d) => !DATASETS[d.id].dependsOn);
    const dependent = todo.filter((d) => DATASETS[d.id].dependsOn);
    await runLimited(independent.map(runOne), concurrency, shouldStop);

    // A dependent dataset runs only when the one it depends on completed AND says it is worth buying.
    const wave = [];
    if (!shouldStop()) {
      for (const ds of dependent) {
        const def = DATASETS[ds.id];
        const depResult = await dependencyResult(def.dependsOn);
        if (depResult !== undefined && def.when(depResult)) wave.push(runOne(ds));
        else await store.updateDataset(run._id, ds.id, { status: 'skipped', finishedAt: now() });
      }
    }
    await runLimited(wave, concurrency, shouldStop);

    if (!owned) return 'lost';
    const after = await store.getById(run._id);
    const left = after.datasets.some((d) => d.status === 'pending');
    if (left) {
      // Stopped early (graceful shutdown): hand the scan back; the next claim continues with what is left.
      await store.requeue(run._id, workerId, { nextAttemptAt: now() });
      return 'requeued';
    }
    const completed = after.datasets.filter((d) => d.status === 'completed').length;
    const failed = after.datasets.filter((d) => d.status === 'failed').length;
    const status = failed === 0 ? 'completed' : completed === 0 ? 'failed' : 'partially_completed';
    const ended = await store.finish(run._id, { status, error: status === 'failed' ? { code: 'ALL_DATASETS_FAILED' } : null, now: now() });
    emitScanEvent(status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'partial', { ...(ended ?? after), status });
    return 'finished';
  } catch (err) {
    LoggerUtil.error('SEO scan: unexpected failure', err, { scanId: String(run._id), attempt: run.attempts });
    if (!owned) return 'lost';
    if ((run.attempts ?? 1) < maxAttempts) {
      const delay = Math.min(5 * 60_000, 15_000 * 2 ** ((run.attempts ?? 1) - 1));
      await store.requeue(run._id, workerId, { nextAttemptAt: new Date(now().getTime() + delay) }).catch(() => {});
      return 'requeued';
    }
    const ended = await store.finish(run._id, { status: 'failed', error: { code: 'SCAN_INTERNAL' }, now: now() }).catch(() => null);
    emitScanEvent('failed', { ...(ended ?? run), status: 'failed' });
    return 'finished';
  } finally {
    clearInterval(timer);
  }
}

const ACTIVE = ['pending', 'queued', 'running'];
/** A queued scan nobody has claimed for this long, or a running one whose lease lapsed, has no live worker: the browser is told. */
const QUEUE_STALL_MS = 2 * 60_000;

/** A run for the browser: counts, per-dataset state and codes. No user ids, no lock internals. */
export function toPublicRun(run, { now = new Date() } = {}) {
  if (!run) return null;
  const active = ACTIVE.includes(run.status);
  const stalled = active && (run.status === 'running'
    ? Boolean(run.leaseUntil) && new Date(run.leaseUntil) < now
    : now.getTime() - new Date(run.nextAttemptAt ?? run.createdAt ?? now).getTime() > QUEUE_STALL_MS);
  return {
    id: String(run._id),
    scope: run.scope,
    status: run.status,
    // true = nothing is working on this scan right now (no worker alive); a worker that starts will continue it.
    stalled,
    triggerType: run.triggerType,
    force: Boolean(run.force),
    retryOf: run.retryOf ? String(run.retryOf) : null,
    attempts: run.attempts ?? 0,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    createdAt: run.createdAt ?? null,
    datasetsCompleted: run.datasetsCompleted ?? 0,
    datasetsFailed: run.datasetsFailed ?? 0,
    totalDatasets: run.datasets?.length ?? 0,
    providerRequestsCount: run.providerRequestsCount ?? 0,
    reportedCost: run.reportedCost ?? 0,
    error: run.error ?? null,
    datasets: (run.datasets ?? []).map((d) => ({
      id: d.id, section: d.section, status: d.status, cached: d.cached ?? null, fetchedAt: d.fetchedAt ?? null, errorCode: d.errorCode ?? null, attempts: d.attempts ?? 0,
    })),
  };
}
