import { PAGE_DATASETS, AUTO } from '../config.js';
import { mongoRunStore } from './scanRunStore.js';
import { getDatasetFreshness } from './freshnessService.js';
import { freshMsOf } from './freshnessPolicy.js';
import { startScan, ScanConflict, toPublicRun } from './seoScanService.js';
import { hasCredentials, DATAFORSEO_ERROR } from '../../shared/providerErrors.js';
import { ValidationFailure } from '../../shared/targetDomain.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';

/**
 * AUTOMATIC dataset collection: the one coordinator behind "opening a page keeps its data fresh by itself".
 *
 *   ensurePageData   (web request, cheap, MongoDB only) reads what the page needs, decides per dataset (fresh / stale / missing, already being
 *                    collected, cooling down, not needed) and, if something is due, QUEUES one scan of exactly those datasets and returns.
 *                    It never calls the provider and never waits for one: a worker runs the scan (worker/seoScanWorker.js).
 *   refreshPage      the optional, rate-limited manual "refresh now" (same queue, same lock, same worker).
 *
 * Why this cannot create a purchase loop:
 *   - ONE active scan per project is guaranteed by a unique index (scanRunStore), so any number of requests, pages, tabs, users or backend
 *     instances share the scan that is already running; a second `ensure` only reports it.
 *   - A dataset the running scan will collect is never queued again; datasets it does not cover wait until it ends (the next `ensure` queues them).
 *   - Every dataset has a cooldown derived from the persisted scan history (no extra state to lose): after a failure it waits
 *     base * 2^(failures-1) up to a cap (a credentials / credits / rejected-request failure waits at least hours); after an attempt that
 *     completed but left it stale it waits `incompleteRetryMs`; a dependent dataset the scan skipped on purpose counts as satisfied.
 *   - Pagination, search, sorting and filtering are not "opening a page": they never call this at all (they are MongoDB reads).
 *   - A fresh dataset is never collected, so a page whose datasets are all fresh causes no write and no purchase.
 *
 * The previous successful data is never touched here (a scan only adds a newer dataset when it completes).
 */

const PERMANENT = new Set([
  DATAFORSEO_ERROR.NOT_CONFIGURED, DATAFORSEO_ERROR.AUTH, DATAFORSEO_ERROR.INSUFFICIENT_CREDITS, DATAFORSEO_ERROR.ACCOUNT_RESTRICTED,
  DATAFORSEO_ERROR.REQUEST_REJECTED, DATAFORSEO_ERROR.MALFORMED_RESPONSE, 'PROJECT_NOT_FOUND', 'SCAN_ATTEMPTS_EXHAUSTED',
]);
const FINISHED_RUN = new Set(['completed', 'partially_completed', 'failed', 'cancelled']);
const ts = (d) => (d ? new Date(d).getTime() : 0);

/**
 * What happened to ONE dataset in the recent scans, newest first: [{ at, status: 'completed'|'failed'|'skipped', errorCode, scanId }].
 * A dataset still pending / running is not an attempt (the active scan is handled separately). In a scan that already ENDED, a dataset that
 * never ran (the scan failed as a whole) counts as a failed attempt.
 */
export function attemptsOf(datasetId, runs) {
  const out = [];
  for (const run of runs) {
    const d = run.datasets?.find((x) => x.id === datasetId);
    if (!d) continue;
    const ended = FINISHED_RUN.has(run.status);
    if (d.status === 'completed' || d.status === 'skipped') out.push({ at: d.finishedAt ?? run.finishedAt ?? run.createdAt, status: d.status, errorCode: null, scanId: String(run._id) });
    else if (d.status === 'failed') out.push({ at: d.finishedAt ?? run.finishedAt ?? run.createdAt, status: 'failed', errorCode: d.errorCode ?? 'UNKNOWN', scanId: String(run._id) });
    else if (ended) out.push({ at: run.finishedAt ?? run.createdAt, status: 'failed', errorCode: run.error?.code ?? 'SCAN_ABORTED', scanId: String(run._id) });
  }
  return out.sort((a, b) => ts(b.at) - ts(a.at));
}

/** The earliest time a stale / missing dataset may be queued again, from its attempts (null = no restriction). Pure. */
export function nextAllowedAt(datasetId, attempts, { policy = AUTO } = {}) {
  const last = attempts[0];
  if (!last) return null;
  if (last.status === 'skipped') return new Date(ts(last.at) + freshMsOf(datasetId)); // not needed: re-decided when the dependency is refreshed
  if (last.status === 'completed') return new Date(ts(last.at) + policy.incompleteRetryMs);
  let failures = 0;
  for (const a of attempts) { if (a.status !== 'failed') break; failures += 1; }
  const exp = Math.min(policy.failureBackoffMaxMs, policy.failureBackoffBaseMs * 2 ** Math.min(failures - 1, 20));
  const wait = PERMANENT.has(last.errorCode) ? Math.max(exp, policy.permanentFailureMinMs) : exp;
  return new Date(ts(last.at) + Math.min(wait, policy.failureBackoffMaxMs));
}

/** Datasets an ACTIVE scan will still collect (or is collecting right now). */
const coveredBy = (active) => new Set((active?.datasets ?? []).filter((d) => d.status === 'pending' || d.status === 'running').map((d) => d.id));

export function assertPage(page) {
  if (typeof page !== 'string' || !Object.hasOwn(PAGE_DATASETS, page)) {
    throw new ValidationFailure('page', `page must be one of ${Object.keys(PAGE_DATASETS).join(', ')}`);
  }
  return page;
}

/**
 * @param {{ project: object, userId?: string|null, page: string, now?: Date }} input
 * @param {{ store?: object, describe?: Function, start?: Function, canBuy?: () => boolean, policy?: object }} [deps]
 * @returns {Promise<object>} the page's data state (see `summarise`); never throws for provider reasons
 */
export async function ensurePageData({ project, userId = null, page, now = new Date() }, deps = {}) {
  const { store = mongoRunStore, describe = getDatasetFreshness, start = startScan, canBuy = hasCredentials, policy = AUTO } = deps;
  assertPage(page);
  const ids = PAGE_DATASETS[page];
  const runs = await store.list(project._id, 20);
  const [{ datasets }, active0] = await Promise.all([describe({ project, userId, ids: [...ids], runs, now }), store.findActive(project._id)]);
  let active = active0;

  const covered = coveredBy(active);
  const rows = datasets.map((d) => {
    const attempts = attemptsOf(d.id, runs);
    const base = { id: d.id, state: d.state, lastSuccessfulAt: d.lastSuccessfulAt, lastError: d.lastError, truncated: d.truncated, rows: d.rows };
    if (d.state === 'fresh') return { ...base, action: 'none', retryAt: null };
    if (covered.has(d.id)) return { ...base, action: 'collecting', retryAt: null };
    const retryAt = nextAllowedAt(d.id, attempts, { policy });
    const skipped = attempts[0]?.status === 'skipped' && retryAt && retryAt > now;
    if (skipped) return { ...base, state: 'fresh', action: 'not_needed', retryAt: null };
    if (retryAt && retryAt > now) return { ...base, action: 'cooldown', retryAt };
    return { ...base, action: 'due', retryAt: null };
  });

  const due = rows.filter((r) => r.action === 'due').map((r) => r.id);
  let enqueued = null;
  let deduped = false;
  const unavailable = due.length > 0 && !canBuy();
  if (due.length && policy.enabled && !unavailable) {
    if (!active) {
      try {
        const res = await start({ project, userId: userId ? String(userId) : '', scope: 'dataset', datasets: due, force: false, triggerType: 'auto' });
        active = res.run;
        deduped = res.deduped;
        enqueued = { scanId: String(res.run._id), datasets: due, deduped };
        if (!deduped) LoggerUtil.info('SEO auto-collect queued', { page, scanId: String(res.run._id), datasets: due.length });
      } catch (err) {
        // Another request / instance took the project's lock a moment ago: share its scan. Anything else is a real error.
        if (!(err instanceof ScanConflict)) throw err;
        active = err.active;
      }
      if (active) for (const r of rows) if (r.action === 'due' && coveredBy(active).has(r.id)) r.action = 'collecting';
    }
  }
  // Due but not covered by the scan that is running: it waits for that scan to end (the next ensure queues it).
  for (const r of rows) if (r.action === 'due') r.action = !policy.enabled ? 'disabled' : unavailable ? 'unavailable' : 'waiting';

  return summarise({ page, rows, active, enqueued, now, enabled: policy.enabled });
}

/** The page-level answer. `state` is what is stored; `activity` is what is happening about it. */
export function summarise({ page, rows, active, enqueued, now = new Date(), enabled = true }) {
  const needed = rows.filter((r) => r.action !== 'not_needed');
  const have = needed.filter((r) => r.state !== 'missing');
  const state = needed.some((r) => r.state === 'missing') ? 'missing' : needed.some((r) => r.state === 'stale') ? 'stale' : 'fresh';
  const collecting = rows.some((r) => r.action === 'collecting');
  const waiting = rows.some((r) => r.action === 'waiting');
  const cooling = rows.filter((r) => r.action === 'cooldown');
  const activity = collecting ? (active?.status === 'queued' ? 'queued' : 'collecting')
    : waiting ? 'waiting'
      : rows.some((r) => r.action === 'unavailable') ? 'unavailable'
        : cooling.length ? 'cooldown' : rows.some((r) => r.action === 'disabled') ? 'disabled' : 'idle';
  // A failure that is newer than the last success of a dataset that is not fresh: the page keeps showing what it has.
  const failed = needed.find((r) => r.state !== 'fresh' && r.lastError);
  const oldest = have.map((r) => r.lastSuccessfulAt).filter(Boolean).sort((a, b) => ts(a) - ts(b))[0] ?? null;
  const retryTimes = cooling.map((r) => ts(r.retryAt)).filter(Boolean);
  return {
    page,
    enabled,
    state,
    activity,
    // The oldest successful collection among the datasets the page shows (the honest "data updated" time); null = nothing yet.
    lastUpdatedAt: oldest,
    hasData: have.length > 0,
    lastError: failed ? { code: failed.lastError.code, at: failed.lastError.at, datasetId: failed.id } : null,
    nextAttemptAt: retryTimes.length ? new Date(Math.min(...retryTimes)) : null,
    enqueued,
    scan: active ? toPublicRun(active, { now }) : null,
    datasets: rows.map((r) => ({ id: r.id, state: r.state, action: r.action, lastSuccessfulAt: r.lastSuccessfulAt ?? null, retryAt: r.retryAt ?? null, rows: r.rows ?? null, truncated: r.truncated ?? null })),
  };
}

/**
 * The optional manual refresh of ONE page's datasets: it buys them again even if they are fresh, so it is limited to one per project per
 * window (and refused while a scan is active). Returns { accepted, reason?, retryAt?, scan? }.
 */
export async function refreshPage({ project, userId, page, now = new Date() }, deps = {}) {
  const { store = mongoRunStore, start = startScan, canBuy = hasCredentials, policy = AUTO } = deps;
  assertPage(page);
  if (!canBuy()) return { accepted: false, reason: 'UNAVAILABLE' };
  const active = await store.findActive(project._id);
  if (active) return { accepted: false, reason: 'SCAN_IN_PROGRESS', scan: toPublicRun(active, { now }) };
  const runs = await store.list(project._id, 20);
  const lastForced = runs.find((r) => r.force === true && r.triggerType === 'manual' && r.status !== 'cancelled');
  if (lastForced) {
    const retryAt = new Date(ts(lastForced.createdAt) + policy.manualRefreshCooldownMs);
    if (retryAt > now) return { accepted: false, reason: 'COOLDOWN', retryAt };
  }
  try {
    const { run } = await start({ project, userId: String(userId || ''), scope: 'dataset', datasets: [...PAGE_DATASETS[page]], force: true, triggerType: 'manual' });
    return { accepted: true, scan: toPublicRun(run, { now }) };
  } catch (err) {
    if (err instanceof ScanConflict) return { accepted: false, reason: 'SCAN_IN_PROGRESS', scan: toPublicRun(err.active, { now }) };
    throw err;
  }
}

