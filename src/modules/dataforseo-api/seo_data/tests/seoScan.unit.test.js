import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startScan, planDatasets, ScanConflict, toPublicRun, withRetries, createGate, isTransientError } from '../service/seoScanService.js';
import { createScanWorker } from '../worker/seoScanWorker.js';
import { DATASETS, SCOPES } from '../config.js';
import { parseSectionQuery } from '../../domain_overview/service/sectionQuery.js';
import { parseDomainPagesQuery } from '../../domain_overview/validator/domainPagesQuery.js';
import { recordSectionSnapshot, compareToPrevious } from '../service/snapshotService.js';

/**
 * Queue + worker logic against an in-memory store that honours the same atomic contract as the MongoDB one (one active scan per project,
 * one claim per scan, lease take-over). No network, no MongoDB: the provider is a counting fake function. The real MongoDB behaviour of
 * the same contract is covered in seoDataFirst.db.test.js.
 */

function memoryRunStore() {
  const runs = new Map();
  let seq = 0;
  const activeFor = (projectId) => [...runs.values()].find((r) => String(r.projectId) === String(projectId) && r.lockKey);
  const clone = (r) => structuredClone(r);
  return {
    runs,
    async tryAcquire(doc) {
      await Promise.resolve(); // a real insert is asynchronous: let concurrent callers interleave
      if (activeFor(doc.projectId)) return null;
      seq += 1;
      const run = clone({ ...doc, _id: `run${seq}`, status: 'queued', lockKey: String(doc.projectId), createdAt: new Date(Date.now() + seq), datasetsCompleted: 0, datasetsFailed: 0, providerRequestsCount: 0, reportedCost: 0 });
      runs.set(run._id, run);
      return clone(run);
    },
    async findActive(projectId) { const r = activeFor(projectId); return r ? clone(r) : null; },
    async claimNext({ workerId, now, leaseMs }) {
      await Promise.resolve();
      const due = [...runs.values()]
        .filter((r) => r.lockKey && ((r.status === 'queued' && (!r.nextAttemptAt || r.nextAttemptAt <= now)) || (r.status === 'running' && r.leaseUntil < now)))
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!due) return null;
      Object.assign(due, { status: 'running', workerId, leaseUntil: new Date(now.getTime() + leaseMs), startedAt: due.startedAt ?? now, attempts: (due.attempts ?? 0) + 1 });
      due.datasets.forEach((d) => { if (d.status === 'running') d.status = 'pending'; });
      return clone(due);
    },
    async heartbeat(id, workerId, leaseUntil) { const r = runs.get(id); if (!r?.lockKey || r.workerId !== workerId || r.status !== 'running') return false; r.leaseUntil = leaseUntil; return true; },
    async requeue(id, workerId, { nextAttemptAt }) { const r = runs.get(id); if (!r || r.workerId !== workerId || r.status !== 'running') return false; Object.assign(r, { status: 'queued', nextAttemptAt, leaseUntil: null }); delete r.workerId; return true; },
    async updateDataset(id, dsId, patch, inc = {}) {
      const r = runs.get(id);
      Object.assign(r.datasets.find((d) => d.id === dsId), patch);
      for (const [k, v] of Object.entries(inc)) r[k] = (r[k] ?? 0) + v;
    },
    async finish(id, { status, error, now }) { const r = runs.get(id); Object.assign(r, { status, error, finishedAt: now, leaseUntil: null }); delete r.lockKey; delete r.workerId; return clone(r); },
    async get(projectId, id) { const r = runs.get(id); return r && String(r.projectId) === String(projectId) ? clone(r) : null; },
    async getById(id) { const r = runs.get(id); return r ? clone(r) : null; },
  };
}

const project = { _id: 'p1', main_url: 'https://www.example.com/clinic', country: 'IN', language: 'en' };
const other = { _id: 'p2', main_url: 'https://other.com', country: 'IN', language: 'en' };
let store; let calls; let behaviour;

/** A fake of getDomainOverviewSection: counts every request, can fail named sections, answers `tp-counts` with errors. */
const fakeFetch = async ({ section, refresh, providerAllowed }) => {
  if (providerAllowed === false) return { section, missing: false, result: section === 'tp-counts' ? { errors: behaviour.errors ?? 0 } : { ok: true }, cached: true };
  calls.push({ section, refresh });
  await new Promise((r) => setTimeout(r, behaviour.delayMs ?? 2));
  if (behaviour.block) await behaviour.block;
  const failure = behaviour.failWith?.(section, calls.filter((c) => c.section === section).length);
  if (failure) throw Object.assign(new Error('provider'), { code: failure });
  if (behaviour.fail?.has(section)) throw Object.assign(new Error('provider'), { code: 'PROVIDER_REQUEST_REJECTED' });
  return { section, result: section === 'tp-counts' ? { errors: behaviour.errors ?? 0 } : { ok: true }, cached: behaviour.cached?.has(section) ?? false, cost: 0.01, fetchedAt: new Date() };
};
const runOptions = (over = {}) => ({ fetchSection: fakeFetch, retry: { attempts: 1, baseMs: 0 }, sleep: async () => {}, heartbeatMs: 10_000, ...over });
const makeWorker = (over = {}, workerOver = {}) => createScanWorker({ store, loadProject: async (id) => (id === 'p2' ? other : project), pollMs: 10, run: runOptions(over), ...workerOver });
const enqueue = (input, deps) => startScan({ project, userId: 'u1', ...input }, { store, ...deps });
const scanAndRun = async (input, over, workerOver) => {
  const queued = await enqueue(input);
  const worker = makeWorker(over, workerOver);
  await worker.drain();
  return { queued, run: store.runs.get(queued.run._id), worker };
};

beforeEach(() => { store = memoryRunStore(); calls = []; behaviour = {}; });

describe('scan planning', () => {
  test('every scope lists known datasets, and every dataset parses to a canonical query through the page validators', () => {
    for (const [scope, ids] of Object.entries(SCOPES)) for (const id of ids) assert.ok(DATASETS[id], `${scope}: ${id}`);
    for (const [id, def] of Object.entries(DATASETS)) {
      assert.doesNotThrow(() => parseSectionQuery(def.section, def.params ?? {}, project), id);
    }
  });

  test('the Top Pages datasets match the request the pages build (tab filters + base backlinks >= 1)', () => {
    const all = parseSectionQuery('domain-pages', DATASETS['domain-pages-all'].params, project);
    const ok = parseSectionQuery('domain-pages', DATASETS['domain-pages-ok'].params, project);
    assert.equal(all.filters.length, 1);
    assert.equal(ok.filters.length, 3);
    assert.notEqual(all.variant, ok.variant);
    assert.notEqual(all.variant, parseDomainPagesQuery({}).variant, 'the page always sends its backlinks >= 1 base filter');
  });

  test('unknown scopes and datasets are rejected; a dependent dataset pulls in what it needs; datasets only with the dataset scope', () => {
    assert.throws(() => planDatasets({ scope: 'everything' }), { field: 'scope' });
    assert.throws(() => planDatasets({ scope: 'dataset', datasets: ['nope'] }), { field: 'datasets' });
    assert.throws(() => planDatasets({ scope: 'dataset', datasets: [] }), { field: 'datasets' });
    assert.throws(() => planDatasets({ scope: 'overview', datasets: ['history'] }), { field: 'datasets' });
    assert.deepEqual(planDatasets({ scope: 'dataset', datasets: ['tp-fix-first'] }), ['tp-counts', 'tp-fix-first']);
  });

  test('the overview scope has no duplicated dataset', () => {
    const ids = planDatasets({ scope: 'overview' });
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe('the web request only queues', () => {
  test('starting a scan makes ZERO provider requests and returns a queued scan; nothing runs until a worker claims it', async () => {
    const { run, deduped } = await enqueue({ scope: 'overview' });
    assert.equal(run.status, 'queued');
    assert.equal(deduped, false);
    assert.equal(calls.length, 0);
    assert.equal(store.runs.get(run._id).datasets.every((d) => d.status === 'pending'), true);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.length, 0, 'still nothing without a worker');
    assert.equal(toPublicRun(store.runs.get(run._id)).stalled, false, 'a fresh queued scan is not stalled yet');
    assert.equal(toPublicRun({ ...store.runs.get(run._id), createdAt: new Date(Date.now() - 5 * 60_000) }).stalled, true, 'queued for minutes with no worker: the browser is told');
  });

  test('two identical start requests give one scan; a different scope is refused with the active scan', async () => {
    const [a, b] = await Promise.all([enqueue({ scope: 'dataset', datasets: ['rank-overview', 'history'] }), enqueue({ scope: 'dataset', datasets: ['rank-overview', 'history'] })]);
    assert.deepEqual([a.deduped, b.deduped].sort(), [false, true]);
    assert.equal(a.run._id, b.run._id);
    assert.equal(store.runs.size, 1);
    await assert.rejects(enqueue({ scope: 'dataset', datasets: ['backlinks'] }), (e) => e instanceof ScanConflict && e.active._id === a.run._id);
    const second = await startScan({ project: other, userId: 'u2', scope: 'dataset', datasets: ['history'] }, { store });
    assert.equal(second.deduped, false, 'another project is unaffected');
  });
});

describe('worker execution', () => {
  test('D: a worker makes exactly one request per required dataset, records them, and frees the lock', async () => {
    const { run } = await scanAndRun({ scope: 'dataset', datasets: ['rank-overview', 'backlinks'] });
    assert.deepEqual(calls.map((c) => c.section).sort(), ['backlinks', 'rank-overview']);
    assert.equal(run.status, 'completed');
    assert.equal(run.providerRequestsCount, 2);
    assert.equal(run.datasetsCompleted, 2);
    assert.equal(run.lockKey, undefined, 'the lock is released');
    assert.equal(run.attempts, 1);
    assert.equal(run.datasets.every((d) => d.status === 'completed' && d.cached === false && d.attempts === 1), true);
    assert.ok(calls.every((c) => c.refresh === false), 'without force, fresh stored data is reused, not re-bought');
  });

  test('cache hits are recorded but are not provider requests; force asks to skip fresh stored data', async () => {
    behaviour.cached = new Set(['rank-overview']);
    const { run } = await scanAndRun({ scope: 'dataset', datasets: ['rank-overview', 'backlinks'] });
    assert.equal(run.providerRequestsCount, 1);
    calls = [];
    await scanAndRun({ scope: 'dataset', datasets: ['rank-overview'], force: true });
    assert.deepEqual(calls.map((c) => c.refresh), [true]);
  });

  test('E/I: several workers polling the same queue process a scan exactly once', async () => {
    const queued = await enqueue({ scope: 'dataset', datasets: ['rank-overview', 'history', 'backlinks'] });
    const workers = [makeWorker({}, { workerId: 'w1' }), makeWorker({}, { workerId: 'w2' }), makeWorker({}, { workerId: 'w3' })];
    await Promise.all(workers.map((w) => w.drain()));
    assert.equal(calls.length, 3, 'one request per dataset, not one per worker');
    const run = store.runs.get(queued.run._id);
    assert.equal(run.status, 'completed');
    assert.equal(run.attempts, 1, 'claimed once');
  });

  test('F: one failing dataset does not lose the others (partially_completed); a retry re-runs only the failed one', async () => {
    behaviour.fail = new Set(['history']);
    const { queued, run } = await scanAndRun({ scope: 'dataset', datasets: ['rank-overview', 'history', 'backlinks'] });
    assert.equal(run.status, 'partially_completed');
    assert.deepEqual([run.datasetsCompleted, run.datasetsFailed], [2, 1]);
    const failed = run.datasets.find((d) => d.id === 'history');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.errorCode, 'PROVIDER_REQUEST_REJECTED', 'a code, never a provider message');

    calls = []; behaviour.fail = new Set();
    const retry = await enqueue({ scope: 'dataset', retryOf: queued.run._id });
    await makeWorker().drain();
    assert.deepEqual(calls.map((c) => c.section), ['history'], 'only the failed dataset is re-requested');
    assert.equal(store.runs.get(retry.run._id).triggerType, 'retry');
    assert.equal(store.runs.get(retry.run._id).retryCount, 1);
  });

  test('retrying a scan whose datasets all completed (or another project\'s scan) is refused', async () => {
    const { queued } = await scanAndRun({ scope: 'dataset', datasets: ['rank-overview'] });
    await assert.rejects(enqueue({ scope: 'dataset', retryOf: queued.run._id }), { field: 'retryOf' });
    await assert.rejects(startScan({ project: other, userId: 'u2', scope: 'dataset', retryOf: queued.run._id }, { store }), { field: 'retryOf' });
  });

  test('every dataset failing ends the scan as failed, still freeing the lock', async () => {
    behaviour.fail = new Set(['rank-overview']);
    const { run } = await scanAndRun({ scope: 'dataset', datasets: ['rank-overview'] });
    assert.equal(run.status, 'failed');
    assert.equal(run.lockKey, undefined);
  });

  test('a dependent dataset (Fix first) is bought only when the counts say there are error pages', async () => {
    behaviour.errors = 0;
    await scanAndRun({ scope: 'dataset', datasets: ['tp-fix-first'] });
    assert.deepEqual(calls.map((c) => c.section), ['tp-counts']);
    calls = []; behaviour.errors = 7;
    await scanAndRun({ scope: 'dataset', datasets: ['tp-fix-first'] });
    assert.deepEqual(calls.map((c) => c.section).sort(), ['tp-counts', 'tp-fix-first']);
  });

  test('dataset concurrency is bounded', async () => {
    let live = 0; let peak = 0;
    const slow = async (args) => { live += 1; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 8)); live -= 1; return fakeFetch(args); };
    await scanAndRun({ scope: 'overview' }, { fetchSection: slow, concurrency: 2, gate: createGate(10) });
    assert.equal(peak, 2);
  });

  test('the provider gate bounds provider requests across scans of one process', async () => {
    let live = 0; let peak = 0;
    const slow = async (args) => { live += 1; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 8)); live -= 1; return fakeFetch(args); };
    await enqueue({ scope: 'overview' });
    await startScan({ project: other, userId: 'u2', scope: 'overview' }, { store });
    await makeWorker({ fetchSection: slow, concurrency: 6, gate: createGate(3) }, { scans: 2 }).drain();
    assert.equal(peak, 3);
  });
});

describe('retries and backoff', () => {
  test('transient provider errors are retried with growing delays and then succeed; the tries are recorded', async () => {
    const delays = [];
    behaviour.failWith = (section, n) => (n <= 2 ? 'PROVIDER_UNAVAILABLE' : null);
    const { run } = await scanAndRun({ scope: 'dataset', datasets: ['rank-overview'] }, { retry: { attempts: 3, baseMs: 100 }, sleep: async (ms) => { delays.push(ms); } });
    assert.equal(run.status, 'completed');
    assert.equal(run.datasets[0].attempts, 3);
    assert.deepEqual(delays, [100, 200]);
    assert.equal(calls.length, 3);
  });

  test('a permanent error (credentials, credits, rejected request) is never retried', async () => {
    for (const code of ['PROVIDER_AUTH_FAILED', 'PROVIDER_INSUFFICIENT_CREDITS', 'PROVIDER_REQUEST_REJECTED', 'DATAFORSEO_NOT_CONFIGURED']) {
      calls = []; store = memoryRunStore();
      behaviour.failWith = () => code;
      const { run } = await scanAndRun({ scope: 'dataset', datasets: ['rank-overview'] }, { retry: { attempts: 4, baseMs: 0 } });
      assert.equal(calls.length, 1, code);
      assert.equal(run.status, 'failed');
      assert.equal(run.datasets[0].errorCode, code);
    }
  });

  test('withRetries stops at the last attempt and classifies', async () => {
    assert.equal(isTransientError({ code: 'PROVIDER_TIMEOUT' }), true);
    assert.equal(isTransientError({ code: 'RATE_LIMITED' }), false, 'our own budget: waiting a few seconds will not help');
    let n = 0;
    await assert.rejects(withRetries(async () => { n += 1; throw Object.assign(new Error('x'), { code: 'PROVIDER_NETWORK_ERROR' }); }, { attempts: 3, baseMs: 0 }), (e) => e.tries === 3);
    assert.equal(n, 3);
  });
});

describe('worker recovery', () => {
  test('a crashed worker: its scan is claimed again once the lease expired and CONTINUES - completed datasets are not bought again', async () => {
    const queued = await enqueue({ scope: 'dataset', datasets: ['rank-overview', 'history', 'backlinks'] });
    // worker A claimed it, finished one dataset, was in the middle of another, then died
    const claimed = await store.claimNext({ workerId: 'A', now: new Date(), leaseMs: 60_000 });
    assert.equal(claimed.attempts, 1);
    await store.updateDataset(claimed._id, 'rank-overview', { status: 'completed', cached: false }, { datasetsCompleted: 1, providerRequestsCount: 1 });
    await store.updateDataset(claimed._id, 'history', { status: 'running' });
    // lease still valid: another worker must not take it
    assert.equal(await store.claimNext({ workerId: 'B', now: new Date(), leaseMs: 60_000 }), null);
    store.runs.get(claimed._id).leaseUntil = new Date(Date.now() - 1000);
    await makeWorker({}, { workerId: 'B' }).drain();
    const run = store.runs.get(queued.run._id);
    assert.deepEqual(calls.map((c) => c.section).sort(), ['backlinks', 'history'], 'only what was not completed');
    assert.equal(run.status, 'completed');
    assert.equal(run.attempts, 2);
    assert.equal(run.providerRequestsCount, 3);
    assert.equal(run.datasetsCompleted, 3);
  });

  test('a scan that has been claimed too often ends as failed instead of looping forever', async () => {
    const queued = await enqueue({ scope: 'dataset', datasets: ['rank-overview'] });
    store.runs.get(queued.run._id).attempts = 3;
    await makeWorker({}, { maxAttempts: 3 }).drain();
    const run = store.runs.get(queued.run._id);
    assert.equal(run.status, 'failed');
    assert.equal(run.error.code, 'SCAN_ATTEMPTS_EXHAUSTED');
    assert.equal(run.lockKey, undefined);
    assert.equal(calls.length, 0);
  });

  test('an unexpected error requeues the scan with a backoff; it cannot be claimed before it is due', async () => {
    const queued = await enqueue({ scope: 'dataset', datasets: ['rank-overview'] });
    const flaky = { ...store, updateDataset: async (...a) => { if (!flaky.thrown) { flaky.thrown = true; throw new Error('database hiccup'); } return store.updateDataset(...a); } };
    const worker = createScanWorker({ store: flaky, loadProject: async () => project, run: runOptions() });
    await worker.drain();
    const run = store.runs.get(queued.run._id);
    assert.equal(run.status, 'queued');
    assert.ok(run.nextAttemptAt > new Date(), 'delayed');
    assert.equal(await store.claimNext({ workerId: 'x', now: new Date(), leaseMs: 1000 }), null);
    run.nextAttemptAt = new Date(Date.now() - 1);
    await makeWorker().drain();
    assert.equal(store.runs.get(queued.run._id).status, 'completed');
    assert.equal(store.runs.get(queued.run._id).attempts, 2);
  });

  test('graceful shutdown: running datasets finish, no new one starts, the scan goes back to the queue and another worker finishes it without repeats', async () => {
    const queued = await enqueue({ scope: 'dataset', datasets: ['rank-overview', 'history', 'backlinks', 'competitors'] });
    let release; behaviour.block = new Promise((r) => { release = r; });
    const worker = makeWorker({ concurrency: 1 });
    await worker.tick();
    for (let i = 0; i < 100 && calls.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    const stopping = worker.stop({ timeoutMs: 5000 });
    release();
    await stopping;
    const mid = store.runs.get(queued.run._id);
    assert.equal(mid.status, 'queued', 'handed back, not failed');
    assert.equal(mid.lockKey, String('p1'), 'the project lock is kept');
    assert.equal(calls.length, 1, 'no further dataset was started after the stop');
    assert.equal(mid.datasets.filter((d) => d.status === 'completed').length, 1);
    behaviour.block = null;
    await makeWorker().drain();
    assert.equal(store.runs.get(queued.run._id).status, 'completed');
    assert.equal(calls.length, 4, 'every dataset bought exactly once overall');
  });

  test('a worker that lost its lease stops and writes nothing more', async () => {
    const queued = await enqueue({ scope: 'dataset', datasets: ['rank-overview', 'history', 'backlinks'] });
    behaviour.delayMs = 40;
    // another worker took the scan over: this worker's heartbeat is refused
    const hijack = { ...store, heartbeat: async () => false };
    const worker = createScanWorker({ store: hijack, loadProject: async () => project, run: runOptions({ heartbeatMs: 5, concurrency: 1 }) });
    await worker.drain();
    const run = store.runs.get(queued.run._id);
    assert.notEqual(run.status, 'completed');
    assert.notEqual(run.status, 'failed');
    assert.ok(calls.length < 3, 'it stopped starting datasets');
  });

  test('a deleted project fails the scan instead of looping', async () => {
    const queued = await enqueue({ scope: 'dataset', datasets: ['rank-overview'] });
    await createScanWorker({ store, loadProject: async () => null, run: runOptions() }).drain();
    assert.equal(store.runs.get(queued.run._id).error.code, 'PROJECT_NOT_FOUND');
  });
});

describe('public run', () => {
  test('no user ids or lock internals; a lapsed lease is reported as stalled, not as failed', () => {
    const view = toPublicRun({ _id: 'x', status: 'running', leaseUntil: new Date(Date.now() - 5000), datasets: [], requestedBy: 'u1', lockKey: 'p1', workerId: 'w' });
    assert.equal(view.status, 'running');
    assert.equal(view.stalled, true);
    for (const k of ['lockKey', 'requestedBy', 'workerId', 'leaseUntil']) assert.equal(k in view, false, k);
  });
});

describe('snapshots', () => {
  const fakeModel = () => { const rows = []; return { rows, create: async (d) => { rows.push(d); return { _id: `s${rows.length}` }; } }; };
  const common = { project: { _id: 'p1' }, target: 'example.com', market: { location_name: 'India', language_name: 'English' }, fetchedAt: new Date('2026-11-01T10:00:00Z') };

  test('a real purchase of a summary section creates a timestamped snapshot with the provider time', async () => {
    const model = fakeModel();
    await recordSectionSnapshot({ ...common, section: 'rank-overview', payload: { organic: { etv: 5 } }, cost: 0.013 }, { model });
    assert.equal(model.rows.length, 1);
    assert.equal(model.rows[0].datasetType, 'domain_overview');
    assert.equal(model.rows[0].capturedAt.toISOString(), '2026-11-01T10:00:00.000Z');
    assert.equal(model.rows[0].source, 'refresh');
    await recordSectionSnapshot({ ...common, section: 'rd-last-30', payload: { a: 1 }, scanId: 'scan1' }, { model });
    assert.equal(model.rows[1].source, 'scan');
  });

  test('list-like sections are snapshotted for their default view only; unknown sections and empty payloads never', async () => {
    const model = fakeModel();
    await recordSectionSnapshot({ ...common, section: 'ranked-keywords', payload: { items: [] }, isDefaultView: false }, { model });
    await recordSectionSnapshot({ ...common, section: 'backlinks-list', payload: { items: [] } }, { model });
    await recordSectionSnapshot({ ...common, section: 'rank-overview', payload: null }, { model });
    assert.equal(model.rows.length, 0);
    await recordSectionSnapshot({ ...common, section: 'ranked-keywords', payload: { items: [] }, isDefaultView: true }, { model });
    assert.equal(model.rows.length, 1);
  });

  test('a payload too large for one document is skipped, and a failing database never throws into the answer that was bought', async () => {
    const model = fakeModel();
    assert.equal(await recordSectionSnapshot({ ...common, section: 'rank-overview', payload: { blob: 'x'.repeat(1_600_000) } }, { model }), null);
    assert.equal(model.rows.length, 0);
    const broken = { create: async () => { throw new Error('db down'); } };
    assert.equal(await recordSectionSnapshot({ ...common, section: 'rank-overview', payload: { a: 1 } }, { model: broken }), null);
  });

  test('G: week comparison picks the newest snapshot at least 7 days older, and says "no previous" instead of inventing one', async () => {
    const day = (d, h = 0) => new Date(Date.UTC(2026, 10, d, h));
    const rows = [day(1), day(3), day(8), day(10, 6)].map((capturedAt, i) => ({ _id: `s${i}`, capturedAt, data: { n: i } }));
    const model = {
      findOne: (filter) => ({
        sort: () => ({ select: () => ({ lean: async () => {
          const pool = rows.filter((r) => !filter.capturedAt || r.capturedAt <= filter.capturedAt.$lte).sort((a, b) => b.capturedAt - a.capturedAt);
          return pool[0] ?? null;
        } }) }),
      }),
    };
    const { latest, previous } = await compareToPrevious({ projectId: 'p1', datasetType: 'domain_overview', part: 'rank-overview', period: 'week' }, { model });
    assert.equal(latest._id, 's3');
    assert.equal(previous._id, 's1', '10 Nov 06:00 minus 7 days = 3 Nov 06:00: the 3 Nov 00:00 snapshot');
    const none = await compareToPrevious({ projectId: 'p1', datasetType: 'offpage_overview', part: 'backlinks', period: 'month' }, { model: { findOne: () => ({ sort: () => ({ select: () => ({ lean: async () => null }) }) }) } });
    assert.deepEqual([none.latest, none.previous], [null, null]);
    await assert.rejects(compareToPrevious({ projectId: 'p1', datasetType: 'domain_overview', part: 'x', period: 'year' }, { model }), RangeError);
  });
});
