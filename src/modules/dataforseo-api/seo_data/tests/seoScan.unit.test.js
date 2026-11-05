import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startScan, planDatasets, ScanConflict, toPublicRun } from '../service/seoScanService.js';
import { DATASETS, SCOPES } from '../config.js';
import { parseSectionQuery } from '../../domain_overview/service/sectionQuery.js';
import { parseDomainPagesQuery } from '../../domain_overview/validator/domainPagesQuery.js';
import { recordSectionSnapshot, compareToPrevious } from '../service/snapshotService.js';

/**
 * Scan logic against an in-memory store that honours the same atomic contract as the MongoDB one (one active scan per project, lease
 * take-over). No network, no MongoDB: the provider is a counting fake function.
 */

function memoryRunStore() {
  const runs = new Map();
  let seq = 0;
  const activeFor = (projectId) => [...runs.values()].find((r) => String(r.projectId) === String(projectId) && r.lockKey);
  return {
    runs,
    async tryAcquire(doc) {
      await Promise.resolve(); // a real insert is asynchronous: let concurrent callers interleave
      if (activeFor(doc.projectId)) return null;
      seq += 1;
      const run = structuredClone({ ...doc, _id: `run${seq}`, lockKey: String(doc.projectId), createdAt: new Date() });
      runs.set(run._id, run);
      return structuredClone(run);
    },
    async findActive(projectId) { const r = activeFor(projectId); return r ? structuredClone(r) : null; },
    async expireStale(projectId, now) {
      const r = activeFor(projectId);
      if (!r || !(r.leaseUntil < now)) return null;
      Object.assign(r, { status: 'failed', error: { code: 'SCAN_LEASE_EXPIRED' }, finishedAt: now });
      delete r.lockKey;
      return structuredClone(r);
    },
    async heartbeat(id, leaseUntil) { const r = runs.get(id); if (!r?.lockKey) return false; r.leaseUntil = leaseUntil; return true; },
    async setStarted(id, now) { Object.assign(runs.get(id), { status: 'running', startedAt: now }); },
    async updateDataset(id, dsId, patch) { Object.assign(runs.get(id).datasets.find((d) => d.id === dsId), patch); },
    async addCounters(id, { completed = 0, failed = 0, requests = 0, cost = 0 }) {
      const r = runs.get(id);
      r.datasetsCompleted = (r.datasetsCompleted ?? 0) + completed; r.datasetsFailed = (r.datasetsFailed ?? 0) + failed;
      r.providerRequestsCount = (r.providerRequestsCount ?? 0) + requests; r.reportedCost = (r.reportedCost ?? 0) + cost;
    },
    async finish(id, { status, error, now }) { const r = runs.get(id); Object.assign(r, { status, error, finishedAt: now }); delete r.lockKey; return structuredClone(r); },
    async get(projectId, id) { const r = runs.get(id); return r && String(r.projectId) === String(projectId) ? structuredClone(r) : null; },
  };
}

const project = { _id: 'p1', main_url: 'https://www.example.com/clinic', country: 'IN', language: 'en' };
const other = { _id: 'p2', main_url: 'https://other.com', country: 'IN', language: 'en' };
let store; let calls; let behaviour;

/** A fake of getDomainOverviewSection: counts every request, can fail named sections, answers `tp-counts` with errors. */
const fakeFetch = async ({ section, refresh }) => {
  calls.push({ section, refresh });
  await new Promise((r) => setTimeout(r, 2));
  if (behaviour.fail?.has(section)) throw Object.assign(new Error('provider'), { code: 'PROVIDER_UNAVAILABLE' });
  return { section, result: section === 'tp-counts' ? { errors: behaviour.errors ?? 0 } : { ok: true }, cached: behaviour.cached?.has(section) ?? false, cost: 0.01, fetchedAt: new Date() };
};
const deps = (over = {}) => ({ store, fetchSection: fakeFetch, heartbeatMs: 10_000, ...over });
const start = (input, over) => startScan({ project, userId: 'u1', ...input }, deps(over));

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

describe('scan execution', () => {
  test('D: a manual scan makes exactly one request per required dataset, records them, and frees the lock', async () => {
    const { run, deduped, done } = await start({ scope: 'dataset', datasets: ['rank-overview', 'backlinks'] });
    assert.equal(deduped, false);
    const ended = await done;
    assert.deepEqual(calls.map((c) => c.section).sort(), ['backlinks', 'rank-overview']);
    assert.equal(ended.status, 'completed');
    assert.equal(ended.providerRequestsCount, 2);
    assert.equal(ended.datasetsCompleted, 2);
    assert.equal(ended.lockKey, undefined, 'the lock is released');
    assert.equal(store.runs.get(run._id).datasets.every((d) => d.status === 'completed' && d.cached === false), true);
    assert.ok(calls.every((c) => c.refresh === false), 'without force, fresh stored data is reused, not re-bought');
  });

  test('cache hits are recorded but are not provider requests', async () => {
    behaviour.cached = new Set(['rank-overview']);
    const { done } = await start({ scope: 'dataset', datasets: ['rank-overview', 'backlinks'] });
    const ended = await done;
    assert.equal(ended.providerRequestsCount, 1);
  });

  test('force asks every dataset to skip fresh stored data', async () => {
    const { done } = await start({ scope: 'dataset', datasets: ['rank-overview'], force: true });
    await done;
    assert.deepEqual(calls.map((c) => c.refresh), [true]);
  });

  test('E/I: two identical scans started together (two instances sharing one store) run once', async () => {
    const [a, b] = await Promise.all([start({ scope: 'dataset', datasets: ['rank-overview', 'history'] }), start({ scope: 'dataset', datasets: ['rank-overview', 'history'] })]);
    assert.deepEqual([a.deduped, b.deduped].sort(), [false, true]);
    assert.equal(a.run._id, b.run._id);
    await Promise.all([a.done, b.done].filter(Boolean));
    assert.equal(calls.length, 2, 'one execution: one request per dataset, not two');
    assert.equal(store.runs.size, 1);
  });

  test('a different scope while one runs is refused with the running scan; another project is unaffected', async () => {
    const first = await start({ scope: 'dataset', datasets: ['rank-overview'] });
    await assert.rejects(start({ scope: 'dataset', datasets: ['history'] }), (e) => e instanceof ScanConflict && e.active._id === first.run._id);
    const second = await startScan({ project: other, userId: 'u2', scope: 'dataset', datasets: ['history'] }, deps());
    assert.equal(second.deduped, false);
    await Promise.all([first.done, second.done]);
    // once finished, the project can scan again
    const again = await start({ scope: 'dataset', datasets: ['history'] });
    assert.equal(again.deduped, false);
    await again.done;
  });

  test('F: one failing dataset does not lose the others (partially_completed); a retry re-runs only the failed one', async () => {
    behaviour.fail = new Set(['history']);
    const first = await start({ scope: 'dataset', datasets: ['rank-overview', 'history', 'backlinks'] });
    const ended = await first.done;
    assert.equal(ended.status, 'partially_completed');
    assert.deepEqual([ended.datasetsCompleted, ended.datasetsFailed], [2, 1]);
    const failed = store.runs.get(first.run._id).datasets.find((d) => d.id === 'history');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.errorCode, 'PROVIDER_UNAVAILABLE', 'a code, never a provider message');

    calls = []; behaviour.fail = new Set();
    const retry = await start({ scope: 'dataset', retryOf: first.run._id });
    await retry.done;
    assert.deepEqual(calls.map((c) => c.section), ['history'], 'only the failed dataset is re-requested');
    assert.equal(store.runs.get(retry.run._id).triggerType, 'retry');
    assert.equal(store.runs.get(retry.run._id).retryCount, 1);
  });

  test('retrying a scan whose datasets all completed (or another project\'s scan) is refused', async () => {
    const first = await start({ scope: 'dataset', datasets: ['rank-overview'] });
    await first.done;
    await assert.rejects(start({ scope: 'dataset', retryOf: first.run._id }), { field: 'retryOf' });
    await assert.rejects(startScan({ project: other, userId: 'u2', scope: 'dataset', retryOf: first.run._id }, deps()), { field: 'retryOf' });
  });

  test('every dataset failing ends the scan as failed, still freeing the lock', async () => {
    behaviour.fail = new Set(['rank-overview']);
    const { done } = await start({ scope: 'dataset', datasets: ['rank-overview'] });
    const ended = await done;
    assert.equal(ended.status, 'failed');
    assert.equal(ended.lockKey, undefined);
  });

  test('a dependent dataset (Fix first) is bought only when the counts say there are error pages', async () => {
    behaviour.errors = 0;
    await (await start({ scope: 'dataset', datasets: ['tp-fix-first'] })).done;
    assert.deepEqual(calls.map((c) => c.section), ['tp-counts']);
    calls = []; behaviour.errors = 7;
    await (await start({ scope: 'dataset', datasets: ['tp-fix-first'] })).done;
    assert.deepEqual(calls.map((c) => c.section).sort(), ['tp-counts', 'tp-fix-first']);
  });

  test('concurrency is bounded', async () => {
    let live = 0; let peak = 0;
    const slow = async (args) => { live += 1; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 8)); live -= 1; return fakeFetch(args); };
    const { done } = await start({ scope: 'overview' }, { fetchSection: slow, concurrency: 2 });
    await done;
    assert.equal(peak, 2);
  });

  test('a crashed worker: once its lease expired the next start ends the dead scan as failed and takes the lock', async () => {
    const dead = await store.tryAcquire({ projectId: project._id, scope: 'overview', datasetsRequested: [], datasets: [], leaseUntil: new Date(Date.now() - 1000) });
    assert.ok(dead);
    const { run, deduped, done } = await start({ scope: 'dataset', datasets: ['history'] });
    assert.equal(deduped, false);
    assert.equal(store.runs.get(dead._id).status, 'failed');
    assert.equal(store.runs.get(dead._id).error.code, 'SCAN_LEASE_EXPIRED');
    await done;
    assert.ok(run);
  });

  test('a running scan whose lease expired is reported as failed to the browser', () => {
    const view = toPublicRun({ _id: 'x', status: 'running', leaseUntil: new Date(Date.now() - 5000), datasets: [] });
    assert.equal(view.status, 'failed');
    assert.equal(view.error.code, 'SCAN_LEASE_EXPIRED');
    assert.equal('lockKey' in view || 'requestedBy' in view, false);
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
