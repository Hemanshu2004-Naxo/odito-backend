import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ensurePageData, refreshPage, nextAllowedAt, attemptsOf, assertPage } from '../service/autoCollectService.js';
import { startScan } from '../service/seoScanService.js';
import { lastErrorOf } from '../service/freshnessService.js';
import { freshMsOf, freshnessPolicy } from '../service/freshnessPolicy.js';
import { createScanWorker } from '../worker/seoScanWorker.js';
import { PAGE_DATASETS, PAGE_NAMES, DATASETS, AUTO } from '../config.js';

/**
 * AUTOMATIC collection against a small simulated world: an in-memory scan queue with the same atomic contract as the MongoDB one, and a fake
 * "stored data + provider". Every provider purchase is counted, so the cost rules can be asserted exactly:
 *   fresh page -> 0 purchases; missing / stale page -> exactly one coordinated scan; a failure keeps the old data and backs off.
 * (Real MongoDB + HTTP behaviour is covered in autoCollect.db.test.js.)
 */

const HOUR = 3_600_000;
const MIN = 60_000;

function memoryRunStore() {
  const runs = new Map();
  let seq = 0;
  const activeFor = (projectId) => [...runs.values()].find((r) => String(r.projectId) === String(projectId) && r.lockKey);
  const clone = (r) => structuredClone(r);
  return {
    runs,
    async tryAcquire(doc) {
      await Promise.resolve();
      if (activeFor(doc.projectId)) return null;
      seq += 1;
      const run = clone({ ...doc, _id: `run${seq}`, status: 'queued', lockKey: String(doc.projectId), createdAt: new Date(clock.getTime() + seq), datasetsCompleted: 0, datasetsFailed: 0, providerRequestsCount: 0, reportedCost: 0 });
      runs.set(run._id, run);
      return clone(run);
    },
    async findActive(projectId) { const r = activeFor(projectId); return r ? clone(r) : null; },
    async claimNext({ workerId, now, leaseMs }) {
      await Promise.resolve();
      const due = [...runs.values()].filter((r) => r.lockKey && ((r.status === 'queued' && (!r.nextAttemptAt || r.nextAttemptAt <= now)) || (r.status === 'running' && r.leaseUntil < now))).sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!due) return null;
      Object.assign(due, { status: 'running', workerId, leaseUntil: new Date(now.getTime() + leaseMs), startedAt: due.startedAt ?? now, attempts: (due.attempts ?? 0) + 1 });
      due.datasets.forEach((d) => { if (d.status === 'running') d.status = 'pending'; });
      return clone(due);
    },
    async heartbeat(id, workerId, leaseUntil) { const r = runs.get(id); if (!r?.lockKey || r.workerId !== workerId || r.status !== 'running') return false; r.leaseUntil = leaseUntil; return true; },
    async requeue(id, workerId, { nextAttemptAt }) { const r = runs.get(id); if (!r || r.workerId !== workerId || r.status !== 'running') return false; Object.assign(r, { status: 'queued', nextAttemptAt, leaseUntil: null }); delete r.workerId; return true; },
    async updateDataset(id, dsId, patch, inc = {}) { const r = runs.get(id); Object.assign(r.datasets.find((d) => d.id === dsId), patch); for (const [k, v] of Object.entries(inc)) r[k] = (r[k] ?? 0) + v; },
    async finish(id, { status, error, now }) { const r = runs.get(id); Object.assign(r, { status, error, finishedAt: now, leaseUntil: null }); delete r.lockKey; delete r.workerId; return clone(r); },
    async get(projectId, id) { const r = runs.get(id); return r && String(r.projectId) === String(projectId) ? clone(r) : null; },
    async getById(id) { const r = runs.get(id); return r ? clone(r) : null; },
    async list(projectId, limit = 10) { return [...runs.values()].filter((r) => String(r.projectId) === String(projectId)).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).map(clone); },
  };
}

const project = { _id: 'p1', main_url: 'https://www.example.com', country: 'IN', language: 'en' };
const other = { _id: 'p2', main_url: 'https://other.com', country: 'IN', language: 'en' };
let store; let clock; let stored; let purchases; let behaviour;

/** The simulated provider + database: `stored` maps `${projectId}:${datasetId}` -> fetchedAt of the stored answer. */
const worldKey = (projectId, id) => `${projectId}:${id}`;
const sectionToIds = (section) => Object.entries(DATASETS).filter(([, d]) => d.section === section && !d.collector).map(([id]) => id);

/** Stand-in for getDomainOverviewSection: a read-only call never buys; a purchase writes the stored answer unless the provider fails. */
const fakeFetch = async ({ project: p, section, providerAllowed, query, refresh }) => {
  if (providerAllowed === false) return { section, missing: false, result: section === 'tp-counts' ? { errors: behaviour.errors ?? 0 } : { ok: true }, cached: true };
  // Which dataset this request stands for: the scan passes the dataset's own section (+ params); match by section (datasets sharing a section are bought separately).
  purchases.push({ project: p._id, section, refresh: Boolean(refresh), variant: query?.variant ?? '' });
  await new Promise((r) => setTimeout(r, 1));
  const failure = behaviour.failWith?.(section);
  if (failure) throw Object.assign(new Error('provider'), { code: failure });
  for (const id of sectionToIds(section)) stored.set(worldKey(p._id, id), new Date(clock));
  return { section, result: section === 'tp-counts' ? { errors: behaviour.errors ?? 0 } : { ok: true }, cached: false, cost: 0.01, fetchedAt: new Date(clock) };
};

/** getDatasetFreshness, but over the simulated world (same shape; fresh/stale from the dataset's own policy). */
const describe_ = async ({ project: p, ids, runs, now }) => ({
  datasets: ids.map((id) => {
    const at = stored.get(worldKey(p._id, id)) ?? null;
    const state = !at ? 'missing' : now.getTime() - at.getTime() >= freshMsOf(id) ? 'stale' : 'fresh';
    return { id, section: DATASETS[id].section, kind: 'section', state, lastSuccessfulAt: at, rows: null, truncated: null, lastError: lastErrorOf(id, runs, at) };
  }),
});

const deps = (over = {}) => ({ store, describe: describe_, canBuy: () => true, policy: { ...AUTO, enabled: true }, start: (input) => startScan(input, { store, now: () => clock }), ...over });
const ensure = (page, p = project, over = {}) => ensurePageData({ project: p, userId: 'u1', page, now: clock }, deps(over));
const makeWorker = (over = {}) => createScanWorker({ store, loadProject: async (id) => (id === 'p2' ? other : project), pollMs: 10, now: () => clock, run: { fetchSection: fakeFetch, retry: { attempts: 1, baseMs: 0 }, sleep: async () => {}, heartbeatMs: 10_000, ...over } });
const drain = async (w = makeWorker()) => { await w.drain(); };
const advance = (ms) => { clock = new Date(clock.getTime() + ms); };
// Pages without a row-level (Mongo-backed) dataset can run end to end in memory.
const SECTION_PAGES = PAGE_NAMES.filter((pg) => PAGE_DATASETS[pg].every((id) => !DATASETS[id].collector));

beforeEach(() => { store = memoryRunStore(); clock = new Date('2026-11-05T10:00:00Z'); stored = new Map(); purchases = []; behaviour = {}; });

describe('page requirements', () => {
  test('every page lists known datasets, once each, and the freshness policy covers all of them', () => {
    assert.deepEqual([...PAGE_NAMES].sort(), ['anchors', 'backlinks', 'competitors', 'domain-overview', 'offpage-overview', 'organic-keywords', 'referring-domains', 'top-pages', 'traffic']);
    for (const [page, ids] of Object.entries(PAGE_DATASETS)) {
      assert.equal(new Set(ids).size, ids.length, page);
      for (const id of ids) assert.ok(DATASETS[id], `${page}: ${id}`);
    }
    const policy = freshnessPolicy();
    for (const id of Object.keys(DATASETS)) assert.ok(policy[id] > 0, id);
  });

  test('freshness is per dataset, not one TTL (history 7 days, competitors 24 hours, stored sets 24 hours)', () => {
    assert.equal(freshMsOf('history'), 7 * 24 * HOUR);
    assert.equal(freshMsOf('competitors'), 24 * HOUR);
    assert.equal(freshMsOf('rd-last-30'), 7 * 24 * HOUR);
    assert.equal(freshMsOf('keywords-dataset'), 24 * HOUR);
    assert.notEqual(freshMsOf('history'), freshMsOf('rank-overview'));
  });

  test('a page only ever asks for its own datasets (smallest scope): Traffic = history; Organic Keywords = the stored keyword set', () => {
    assert.deepEqual([...PAGE_DATASETS.traffic], ['history']);
    assert.deepEqual([...PAGE_DATASETS['organic-keywords']], ['keywords-dataset']);
    assert.ok(!PAGE_DATASETS.traffic.includes('backlinks'));
    assert.throws(() => assertPage('nope'), { field: 'page' });
    assert.throws(() => assertPage(undefined), { field: 'page' });
  });

  test('every one of the nine pages: a missing page queues exactly its own datasets in ONE scan, with zero provider calls on the request', async () => {
    for (const page of PAGE_NAMES) {
      store = memoryRunStore();
      const out = await ensure(page);
      assert.equal(out.state, 'missing', page);
      assert.equal(out.activity, 'queued', page);
      assert.equal(out.hasData, false, page);
      assert.equal(store.runs.size, 1, page);
      const run = [...store.runs.values()][0];
      const expected = new Set(PAGE_DATASETS[page]);
      for (const id of PAGE_DATASETS[page]) if (DATASETS[id].dependsOn) expected.add(DATASETS[id].dependsOn);
      assert.deepEqual(new Set(run.datasets.map((d) => d.id)), expected, page);
      assert.equal(run.triggerType, 'auto', page);
      assert.equal(run.force, false, page);
      assert.equal(purchases.length, 0, `${page}: the request itself must never reach the provider`);
    }
  });
});

describe('fresh / missing / stale', () => {
  test('1. a fresh page causes ZERO provider calls and ZERO scans', async () => {
    await ensure('traffic'); await drain();
    const before = purchases.length;
    store.runs.clear(); // nothing is queued or recent
    const out = await ensure('traffic');
    assert.equal(out.state, 'fresh');
    assert.equal(out.activity, 'idle');
    assert.equal(out.scan, null);
    assert.equal(out.enqueued, null);
    assert.equal(store.runs.size, 0, 'no scan row was even written');
    assert.equal(purchases.length, before);
  });

  test('2. a missing page automatically queues a collection; the worker (not the request) buys it, once per dataset', async () => {
    const out = await ensure('competitors');
    assert.equal(out.state, 'missing');
    assert.equal(out.enqueued.datasets.length, 2);
    assert.equal(purchases.length, 0);
    await drain();
    assert.deepEqual(purchases.map((p) => p.section).sort(), ['competitors', 'rank-overview']);
    const after = await ensure('competitors');
    assert.equal(after.state, 'fresh');
    assert.equal(after.lastUpdatedAt.toISOString(), clock.toISOString());
    assert.equal(purchases.length, 2, 'opening it again buys nothing');
  });

  test('3. a stale page returns the OLD data immediately and queues a refresh (the old data is never cleared first)', async () => {
    await ensure('traffic'); await drain();
    const collectedAt = new Date(clock);
    advance(8 * 24 * HOUR); // history is fresh for 7 days
    const out = await ensure('traffic');
    assert.equal(out.state, 'stale');
    assert.equal(out.hasData, true, 'the stored data is still there to show');
    assert.equal(out.lastUpdatedAt.toISOString(), collectedAt.toISOString());
    assert.equal(out.activity, 'queued');
    assert.equal(stored.get(worldKey('p1', 'history')).toISOString(), collectedAt.toISOString(), 'nothing was removed or replaced by the request');
    assert.equal(out.enqueued.datasets[0], 'history');
    await drain();
    const after = await ensure('traffic');
    assert.equal(after.state, 'fresh');
    assert.ok(after.lastUpdatedAt > collectedAt);
  });

  test('a dataset is stale by ITS OWN policy: 25 hours old competitors are stale, a 25 hour old history is not', async () => {
    await ensure('domain-overview'); await drain();
    purchases.length = 0;
    advance(25 * HOUR);
    const out = await ensure('domain-overview');
    const by = Object.fromEntries(out.datasets.map((d) => [d.id, d.state]));
    assert.equal(by.history, 'fresh');
    assert.equal(by.competitors, 'stale');
    assert.equal(by['rd-last-30'], 'fresh');
    // The refresh asks only for what is stale.
    assert.ok(out.enqueued.datasets.includes('competitors'));
    assert.ok(!out.enqueued.datasets.includes('history'));
    assert.ok(!out.enqueued.datasets.includes('rd-last-30'));
    await drain();
    assert.ok(purchases.every((p) => p.section !== 'history'), 'history was not bought again');
  });

  test('disabled switch: nothing is queued, the state is still reported', async () => {
    const out = await ensure('traffic', project, { policy: { ...AUTO, enabled: false } });
    assert.equal(out.state, 'missing');
    assert.equal(out.activity, 'disabled');
    assert.equal(out.enabled, false);
    assert.equal(store.runs.size, 0);
  });

  test('provider not configured: reported as unavailable, no scan row is created', async () => {
    const out = await ensure('traffic', project, { canBuy: () => false });
    assert.equal(out.activity, 'unavailable');
    assert.equal(store.runs.size, 0);
  });
});

describe('no duplicate scans, no duplicate purchases', () => {
  test('4. many simultaneous page opens (tabs, users, instances) create exactly ONE scan', async () => {
    const results = await Promise.all(Array.from({ length: 25 }, () => ensure('domain-overview')));
    assert.equal(store.runs.size, 1);
    assert.equal(new Set(results.map((r) => r.scan.id)).size, 1, 'all of them observe the same scan');
    assert.equal(results.filter((r) => r.enqueued && !r.enqueued.deduped).length, 1, 'exactly one request created it');
    await drain();
    const sections = purchases.map((p) => `${p.section}:${p.variant}`);
    assert.equal(new Set(sections).size, sections.length, 'no dataset was bought twice');
  });

  test('5. two pages share the collection: Traffic opened while Domain Overview collects reuses its scan and buys history once', async () => {
    const overview = await ensure('domain-overview');
    const traffic = await ensure('traffic');
    assert.equal(store.runs.size, 1);
    assert.equal(traffic.scan.id, overview.scan.id);
    assert.equal(traffic.activity, 'queued');
    assert.equal(traffic.enqueued, null, 'it did not queue anything of its own');
    await drain();
    assert.equal(purchases.filter((p) => p.section === 'history').length, 1);
    const after = await ensure('traffic');
    assert.equal(after.state, 'fresh');
    assert.equal(purchases.filter((p) => p.section === 'history').length, 1);
  });

  test('a page whose datasets the running scan does NOT cover waits (no second scan), then is queued once the scan has ended', async () => {
    const first = await ensure('traffic');
    const second = await ensure('competitors');
    assert.equal(store.runs.size, 1, 'the project lock allows one active scan');
    assert.equal(second.activity, 'waiting');
    assert.equal(second.enqueued, null);
    assert.equal(first.scan.id, second.scan.id);
    await drain();
    const third = await ensure('competitors');
    assert.equal(store.runs.size, 2);
    assert.equal(third.activity, 'queued');
    await drain();
    assert.equal((await ensure('competitors')).state, 'fresh');
  });

  test('another project has its own scan (the lock is per project)', async () => {
    await ensure('traffic');
    const b = await ensure('traffic', other);
    assert.equal(store.runs.size, 2);
    assert.equal(b.activity, 'queued');
  });

  test('7. repeated navigation across every page buys nothing after the first collection', async () => {
    for (const page of SECTION_PAGES) { await ensure(page); await drain(); }
    const bought = purchases.length;
    assert.ok(bought > 0);
    const runsBefore = store.runs.size;
    for (let round = 0; round < 6; round += 1) for (const page of SECTION_PAGES) {
      const out = await ensure(page);
      assert.equal(out.state, 'fresh', page);
      assert.equal(out.enqueued, null, page);
    }
    assert.equal(purchases.length, bought);
    assert.equal(store.runs.size, runsBefore, 'not even a scan row');
  });

  test('10. two workers (two backend instances) never buy the same dataset concurrently', async () => {
    await ensure('domain-overview');
    const w1 = makeWorker(); const w2 = makeWorker();
    await Promise.all([w1.drain(), w2.drain()]);
    const keys = purchases.map((p) => `${p.section}:${p.variant}`);
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(store.runs.size, 1);
  });
});

describe('failures keep the old data and back off', () => {
  test('6. a failed refresh preserves the stored data, records the error and is NOT retried on every request', async () => {
    await ensure('traffic'); await drain();
    const collectedAt = new Date(stored.get(worldKey('p1', 'history')));
    advance(8 * 24 * HOUR);
    behaviour.failWith = () => 'PROVIDER_UNAVAILABLE';
    const queued = await ensure('traffic');
    assert.equal(queued.activity, 'queued');
    await drain();
    assert.equal(stored.get(worldKey('p1', 'history')).toISOString(), collectedAt.toISOString(), 'the previous dataset is untouched');
    const bought = purchases.length;
    const after = await ensure('traffic');
    assert.equal(after.state, 'stale');
    assert.equal(after.hasData, true);
    assert.equal(after.lastError.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(after.activity, 'cooldown');
    assert.ok(after.nextAttemptAt > clock);
    for (let i = 0; i < 20; i += 1) await ensure('traffic');
    assert.equal(purchases.length, bought, 'twenty more opens bought nothing');
    assert.equal(store.runs.size, 2, 'and queued nothing');
  });

  test('11. retries wait with exponential backoff, capped, and recover on a later attempt', async () => {
    behaviour.failWith = () => 'PROVIDER_UNAVAILABLE';
    const waits = [];
    for (let i = 0; i < 6; i += 1) {
      const out = await ensure('traffic');
      assert.equal(out.activity, 'queued', `attempt ${i + 1} is allowed`);
      await drain();
      const cooling = await ensure('traffic');
      assert.equal(cooling.activity, 'cooldown');
      waits.push(cooling.nextAttemptAt.getTime() - clock.getTime() + 0);
      // one millisecond before the end of the wait: still blocked; at the end: allowed
      advance(cooling.nextAttemptAt.getTime() - clock.getTime() - 1);
      assert.equal((await ensure('traffic')).activity, 'cooldown');
      advance(1);
    }
    const mins = waits.map((w) => Math.round(w / MIN));
    assert.ok(mins[1] > mins[0] && mins[2] > mins[1] && mins[3] > mins[2], `growing: ${mins}`);
    assert.ok(mins.every((m) => m * MIN <= AUTO.failureBackoffMaxMs));
    behaviour.failWith = null;
    const ok = await ensure('traffic');
    assert.equal(ok.activity, 'queued');
    await drain();
    assert.equal((await ensure('traffic')).state, 'fresh', 'a later attempt recovers');
  });

  test('a failure that retrying cannot fix (credentials, credits) waits for hours', () => {
    const at = new Date('2026-11-05T10:00:00Z');
    const wait = (code) => nextAllowedAt('history', [{ at, status: 'failed', errorCode: code, scanId: 'a' }]).getTime() - at.getTime();
    assert.ok(wait('PROVIDER_INSUFFICIENT_CREDITS') >= AUTO.permanentFailureMinMs);
    assert.ok(wait('PROVIDER_AUTH_FAILED') >= AUTO.permanentFailureMinMs);
    assert.ok(wait('PROVIDER_TIMEOUT') < AUTO.permanentFailureMinMs);
  });

  test('backoff doubles per consecutive failure and never exceeds the cap; one success resets it', () => {
    const at = new Date('2026-11-05T10:00:00Z');
    const fail = (n) => Array.from({ length: n }, (_, i) => ({ at: new Date(at.getTime() - i * HOUR), status: 'failed', errorCode: 'PROVIDER_TIMEOUT', scanId: `s${i}` }));
    const wait = (attempts) => nextAllowedAt('history', attempts).getTime() - new Date(attempts[0].at).getTime();
    assert.equal(wait(fail(1)), AUTO.failureBackoffBaseMs);
    assert.equal(wait(fail(2)), AUTO.failureBackoffBaseMs * 2);
    assert.equal(wait(fail(3)), AUTO.failureBackoffBaseMs * 4);
    assert.equal(wait(fail(60)), AUTO.failureBackoffMaxMs);
    const reset = [{ at, status: 'failed', errorCode: 'PROVIDER_TIMEOUT' }, { at: new Date(at.getTime() - HOUR), status: 'completed' }, ...fail(5).map((f) => ({ ...f, at: new Date(at.getTime() - 2 * HOUR) }))];
    assert.equal(wait(reset), AUTO.failureBackoffBaseMs, 'a success in between resets the count');
  });

  test('a scan that completed but left the dataset stale (provider floor, empty answer) is not retried for the incomplete-retry window', async () => {
    await ensure('traffic'); await drain();
    advance(8 * 24 * HOUR);
    // The "provider" returns without storing anything new (as the 60 s refresh floor would).
    const w = makeWorker({ fetchSection: async ({ section, providerAllowed }) => (providerAllowed === false ? { section, missing: false, result: {}, cached: true } : { section, result: {}, cached: true, fetchedAt: new Date(clock) }) });
    await ensure('traffic'); await w.drain();
    const out = await ensure('traffic');
    assert.equal(out.state, 'stale');
    assert.equal(out.activity, 'cooldown');
    advance(AUTO.incompleteRetryMs + 1);
    assert.equal((await ensure('traffic')).activity, 'queued');
  });

  test('a partial scan does not mark everything fresh: only the datasets that completed are', async () => {
    behaviour.failWith = (section) => (section === 'competitors' ? 'PROVIDER_REQUEST_REJECTED' : null);
    await ensure('domain-overview'); await drain();
    const out = await ensure('domain-overview');
    const by = Object.fromEntries(out.datasets.map((d) => [d.id, d]));
    assert.equal(by.competitors.state, 'missing');
    assert.equal(by.competitors.action, 'cooldown');
    assert.equal(by.history.state, 'fresh');
    assert.equal(out.state, 'missing');
    assert.equal(out.hasData, true);
    assert.equal(out.lastError.code, 'PROVIDER_REQUEST_REJECTED');
  });

  test('the dependent dataset the scan skipped on purpose (no error pages) is "not needed", not missing, and not re-queued', async () => {
    behaviour.errors = 0;
    await ensure('top-pages', project, {});
    // top-pages has collector datasets; run only the section datasets in memory by dropping them from the plan.
    store.runs.clear();
    const queued = await startScan({ project, userId: 'u1', scope: 'dataset', datasets: ['tp-fix-first'], triggerType: 'auto' }, { store, now: () => clock });
    assert.deepEqual(queued.run.datasets.map((d) => d.id), ['tp-counts', 'tp-fix-first']);
    await drain();
    assert.equal(store.runs.get(queued.run._id).datasets.find((d) => d.id === 'tp-fix-first').status, 'skipped');
    const attempts = attemptsOf('tp-fix-first', await store.list('p1'));
    assert.equal(attempts[0].status, 'skipped');
    assert.ok(nextAllowedAt('tp-fix-first', attempts) > clock);
  });

  test('a scan that ended without running a dataset (the whole scan failed) counts as a failed attempt', async () => {
    const q = await startScan({ project, userId: 'u1', scope: 'dataset', datasets: ['history'], triggerType: 'auto' }, { store, now: () => clock });
    await store.finish(q.run._id, { status: 'failed', error: { code: 'SCAN_ATTEMPTS_EXHAUSTED' }, now: clock });
    const attempts = attemptsOf('history', await store.list('p1'));
    assert.equal(attempts[0].status, 'failed');
    assert.equal(attempts[0].errorCode, 'SCAN_ATTEMPTS_EXHAUSTED');
    const out = await ensure('traffic');
    assert.equal(out.activity, 'cooldown');
  });
});

describe('optional manual refresh', () => {
  const refresh = (page = 'traffic', over = {}) => refreshPage({ project, userId: 'u1', page, now: clock }, deps(over));

  test('it queues a forced scan of ONE page only, through the same queue and lock', async () => {
    const out = await refresh('traffic');
    assert.equal(out.accepted, true);
    const run = store.runs.get(out.scan.id);
    assert.equal(run.force, true);
    assert.deepEqual(run.datasets.map((d) => d.id), ['history']);
    assert.equal(purchases.length, 0, 'the request itself buys nothing');
  });

  test('it is refused while a scan is active, and limited to one per cooldown window', async () => {
    const first = await refresh('traffic');
    assert.equal((await refresh('competitors')).reason, 'SCAN_IN_PROGRESS');
    await drain();
    const limited = await refresh('competitors');
    assert.equal(limited.accepted, false);
    assert.equal(limited.reason, 'COOLDOWN');
    assert.ok(limited.retryAt > clock);
    advance(AUTO.manualRefreshCooldownMs + 1000);
    assert.equal((await refresh('competitors')).accepted, true);
    assert.ok(first.accepted);
  });

  test('an automatic scan does not use up the manual refresh allowance', async () => {
    await ensure('traffic'); await drain();
    assert.equal((await refresh('traffic')).accepted, true);
  });

  test('not configured: refused, nothing queued', async () => {
    const out = await refresh('traffic', { canBuy: () => false });
    assert.equal(out.accepted, false);
    assert.equal(store.runs.size, 0);
  });
});
