import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import express from 'express';

dotenv.config();
delete process.env.SEO_DB_FIRST_READS; // the default: database-first
// The real transport is replaced for EVERY section in before(); these only satisfy the credentials check.
process.env.DATAFORSEO_LOGIN = 'test-login';
process.env.DATAFORSEO_PASSWORD = 'test-password';

import User from '../../../user/model/User.js';
import SeoProject from '../../../app_user/model/SeoProject.js';
import { signAuthToken } from '../../../user/service/tokenService.js';
import DataForSeoCacheEntry from '../../shared/DataForSeoCacheEntry.js';
import { cacheKey, __resetInFlightForTests } from '../../shared/apiCache.js';
import SeoSnapshot from '../model/SeoSnapshot.js';
import SeoScanRun from '../model/SeoScanRun.js';
import domainOverviewRoutes from '../../domain_overview/routes/domainOverviewRoutes.js';
import seoScanRoutes from '../routes/seoScanRoutes.js';
import { __setTransportForTests } from '../../domain_overview/provider/domainOverviewProvider.js';
import { SECTION_NAMES } from '../../domain_overview/config.js';
import { startScan } from '../service/seoScanService.js';
import { createScanWorker } from '../worker/seoScanWorker.js';
import { mongoRunStore } from '../service/scanRunStore.js';
import { envelope, rankOverviewResult, historyResult, historyItem, rankedKeywordsResult, competitorsResult, competitorItem, backlinksResult } from '../../domain_overview/tests/fixtures.js';

/**
 * Database-first behaviour through the REAL routers and a REAL MongoDB (MONGO_URI; skipped when unreachable). The provider transport is
 * replaced for every section: a section nobody stubbed THROWS and is counted, so no test can make a real (paid) request.
 */

const MARK = `seo-data-first-${Date.now()}`;
const HOUR = 3_600_000;
let mongoAvailable = false;
let server; let baseUrl; let calls; let failures;
let userA; let userB; let tokenA; let tokenB; let projectA; let domain; let seq = 0;
let worker;

const STUBS = {
  'rank-overview': () => envelope(rankOverviewResult()),
  'history': () => envelope(historyResult([historyItem(2026, 10, 1000, 100)]), { cost: 0.13 }),
  'ranked-keywords': () => envelope(rankedKeywordsResult()),
  'competitors': (body) => envelope(competitorsResult([competitorItem(body.target), competitorItem('rival.com')])),
  'backlinks': () => envelope(backlinksResult()),
};

before(async () => {
  const transport = {};
  for (const section of SECTION_NAMES) {
    transport[section] = async (body) => {
      calls.push({ section, body });
      if (failures[section]) throw failures[section];
      if (!STUBS[section]) throw new Error(`UNSTUBBED provider call: ${section}`);
      return STUBS[section](body);
    };
  }
  __setTransportForTests(transport);
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch {
    return;
  }
  await Promise.all([DataForSeoCacheEntry.init(), SeoSnapshot.init(), SeoScanRun.init()]);
  const app = express();
  app.use(express.json());
  app.use('/api/projects', domainOverviewRoutes);
  app.use('/api/projects', seoScanRoutes);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/projects`;
  // The API only queues scans; this worker (as in production) claims and runs them.
  worker = createScanWorker({ pollMs: 40, run: { retry: { attempts: 1, baseMs: 0 }, heartbeatMs: 500 } });
  worker.start();
});

after(async () => {
  await worker?.stop({ timeoutMs: 3000 });
  __setTransportForTests(null);
  if (mongoAvailable) {
    const re = new RegExp(MARK);
    await DataForSeoCacheEntry.deleteMany({ target: re });
    await SeoSnapshot.deleteMany({ domain: re });
    await SeoScanRun.deleteMany({ domain: re });
    for (const name of ['SeoKeywordRanking', 'SeoBacklink', 'SeoReferringDomain']) await (await import(`../model/${name}.js`)).default.deleteMany({ domain: re });
    await (await import('../model/SeoProviderRequest.js')).default.deleteMany({ target: re });
    await SeoProject.deleteMany({ project_name: re });
    await User.deleteMany({ email: re });
    await mongoose.connection.close();
  }
  if (server) await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  calls = []; failures = {};
  __resetInFlightForTests();
  if (!mongoAvailable) return;
  seq += 1;
  domain = `s${seq}-${MARK}.example.com`;
  userA = await User.create({ firstName: 'Ann', lastName: 'Owner', email: `a${seq}-${MARK}@example.com`, password: 'Passw0rd!long', roleId: 5 });
  userB = await User.create({ firstName: 'Bob', lastName: 'Other', email: `b${seq}-${MARK}@example.com`, password: 'Passw0rd!long', roleId: 5 });
  tokenA = signAuthToken(userA); tokenB = signAuthToken(userB);
  projectA = await SeoProject.create({ user_id: userA._id, project_name: `${MARK}-A${seq}`, main_url: `https://www.${domain}/`, seo_scope: 'local', keywords: ['k'], country: 'IN', language: 'en' });
});

async function call(path, { token = tokenA, method = 'GET', body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}
const section = (name, q = '') => call(`/${projectA._id}/domain-overview/${name}${q}`);

const ENDPOINTS = { 'rank-overview': 'labs/domain_rank_overview', 'history': 'labs/historical_rank_overview/v2', 'backlinks': 'backlinks/summary/v2' };
/** Seeds a stored answer the way a past purchase would have left it. */
async function seed(name, { payload, ageMs = 0, ttlMs = 24 * HOUR, variant = '' }) {
  const fetchedAt = new Date(Date.now() - ageMs);
  const args = { endpoint: ENDPOINTS[name], target: domain, location: name === 'backlinks' ? '' : 'India', language: name === 'backlinks' ? '' : 'English', variant };
  await DataForSeoCacheEntry.create({ ...args, key: cacheKey(args), payload, cost: 0.01, fetchedAt, expiresAt: new Date(fetchedAt.getTime() + ttlMs) });
  return args;
}
const entryOf = (args) => DataForSeoCacheEntry.findOne({ key: cacheKey(args) }).lean();

describe('database-first page reads (real routers, real MongoDB, stubbed provider)', () => {
  test('A/B: opening a page with stored data, again and again, makes ZERO provider requests', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await seed('rank-overview', { payload: { organic: { etv: 42 } } });
    for (let i = 0; i < 4; i += 1) {
      const res = await section('rank-overview');
      assert.equal(res.status, 200);
      assert.deepEqual([res.json.data.cached, res.json.data.stale, res.json.data.missing], [true, false, false]);
      assert.equal(res.json.data.result.organic.etv, 42);
    }
    assert.equal(calls.length, 0);
  });

  test('C: an EXPIRED entry is still returned (flagged stale, with its age) and costs nothing', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const args = await seed('rank-overview', { payload: { organic: { etv: 7 } }, ageMs: 3 * 24 * HOUR });
    const res = await section('rank-overview');
    assert.equal(res.status, 200);
    assert.deepEqual([res.json.data.stale, res.json.data.missing], [true, false]);
    assert.equal(res.json.data.result.organic.etv, 7);
    assert.ok(Date.parse(res.json.data.expiresAt) < Date.now());
    assert.equal(calls.length, 0);
    assert.ok(await entryOf(args), 'viewing never deletes or rewrites it');
  });

  test('nothing stored: a clear missing state, no provider request, nothing created', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    for (const name of ['history', 'ranked-keywords', 'competitors', 'backlinks', 'backlinks-list', 'anchors', 'referring-domains', 'rd-last-30', 'tp-counts', 'top-pages-traffic']) {
      const res = await section(name);
      assert.equal(res.status, 200, name);
      assert.deepEqual([res.json.data.missing, res.json.data.result, res.json.data.fetchedAt], [true, null, null], name);
    }
    assert.equal(calls.length, 0);
    assert.equal(await DataForSeoCacheEntry.countDocuments({ target: domain }), 0);
  });

  test('Top Pages with nothing stored: no rows, no provider request (the traffic join does not buy either)', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const res = await section('domain-pages');
    assert.equal(res.status, 200);
    assert.deepEqual([res.json.data.missing, res.json.data.result], [true, null]);
    assert.equal(calls.length, 0);
  });

  test('pagination, sorting and filtering of an uncollected view never buy: they report missing', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const filters = encodeURIComponent(JSON.stringify(['keyword_data.keyword', 'like', '%x%']));
    for (const q of ['?limit=100&offset=100', '?order_by=keyword_data.keyword,asc', `?filters=${filters}`]) {
      const res = await section('ranked-keywords', q);
      assert.equal(res.json.data.missing, true, q);
    }
    assert.equal(calls.length, 0);
  });

  test('an explicit refresh is the one read-path purchase: it replaces the entry, appends a snapshot, and a repeat inside a minute is throttled', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const args = await seed('rank-overview', { payload: { organic: { etv: 1 } }, ageMs: 2 * 24 * HOUR });
    const res = await section('rank-overview', '?refresh=1');
    assert.equal(res.status, 200);
    assert.equal(res.json.data.cached, false);
    assert.equal(calls.length, 1);
    assert.equal((await entryOf(args)).payload.organic.etv, 100412.4);
    const snaps = await SeoSnapshot.find({ domain }).lean();
    assert.equal(snaps.length, 1);
    assert.deepEqual([snaps[0].datasetType, snaps[0].part, snaps[0].source, String(snaps[0].projectId)], ['domain_overview', 'rank-overview', 'refresh', String(projectA._id)]);
    const again = await section('rank-overview', '?refresh=1');
    assert.equal(again.json.data.refreshThrottled, true);
    assert.equal(calls.length, 1, 'no second purchase');
    assert.equal(await SeoSnapshot.countDocuments({ domain }), 1, 'a cache answer never creates a snapshot');
  });

  test('J: a FAILED refresh keeps the previous successful data, which stays readable', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const args = await seed('rank-overview', { payload: { organic: { etv: 99 } }, ageMs: 2 * 24 * HOUR });
    failures['rank-overview'] = Object.assign(new Error('boom'), { code: 'ECONNRESET' });
    const bad = await section('rank-overview', '?refresh=1');
    assert.ok(bad.status >= 500, `status ${bad.status}`);
    const row = await entryOf(args);
    assert.equal(row.payload.organic.etv, 99, 'the good payload is untouched');
    assert.ok(row.lastErrorCode, 'the failed attempt is noted');
    assert.equal(await SeoSnapshot.countDocuments({ domain }), 0, 'a failure is never a historical record');
    failures = {};
    const after = await section('rank-overview');
    assert.deepEqual([after.json.data.result.organic.etv, after.json.data.stale], [99, true]);
    assert.equal(calls.length, 1, 'only the one failed refresh reached the provider');
  });

  test('the schema declares no TTL index, so nothing can delete an expired entry', () => {
    const ttl = DataForSeoCacheEntry.schema.indexes().filter(([, opts]) => opts && opts.expireAfterSeconds !== undefined);
    assert.deepEqual(ttl, []);
  });

  test('SEO_DB_FIRST_READS=false restores the old read-through behaviour (a plain GET buys on a miss)', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    process.env.SEO_DB_FIRST_READS = 'false';
    try {
      const res = await section('rank-overview');
      assert.equal(res.status, 200);
      assert.equal(calls.length, 1);
    } finally { delete process.env.SEO_DB_FIRST_READS; }
  });
});

describe('explicit scans (real routers, real MongoDB, stubbed provider)', () => {
  const FIVE = ['rank-overview', 'history', 'ranked-keywords-top5', 'competitors', 'backlinks'];
  const waitFor = async (get) => {
    for (let i = 0; i < 100; i += 1) { const scan = (await get()).json.data.scan; if (scan && !['pending', 'queued', 'running'].includes(scan.status)) return scan; await new Promise((r) => setTimeout(r, 50)); }
    throw new Error('scan did not finish');
  };

  test('D: a scan collects exactly its datasets (5 requests), after which every page reads them with ZERO more requests, and 5 snapshots exist', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const res = await call(`/${projectA._id}/seo-scans`, { method: 'POST', body: { scope: 'dataset', datasets: FIVE } });
    assert.equal(res.status, 202);
    assert.equal(res.json.data.deduped, false);
    const scan = await waitFor(() => call(`/${projectA._id}/seo-scans/latest`));
    assert.equal(scan.status, 'completed');
    assert.equal(scan.providerRequestsCount, 5);
    assert.deepEqual(calls.map((c) => c.section).sort(), ['backlinks', 'competitors', 'history', 'rank-overview', 'ranked-keywords']);
    assert.equal(JSON.stringify(scan).includes('test-password'), false);

    calls = [];
    for (const name of ['rank-overview', 'history', 'ranked-keywords', 'competitors', 'backlinks']) {
      const page = await section(name);
      assert.equal(page.json.data.missing, false, name);
      assert.equal(page.json.data.stale, false, name);
    }
    assert.equal(calls.length, 0, 'opening all five pages after a scan costs nothing');

    const snaps = await SeoSnapshot.find({ domain }).lean();
    assert.deepEqual(snaps.map((s) => s.datasetType).sort(), ['backlink_summary', 'competitor_summary', 'domain_overview', 'organic_keyword_summary', 'traffic']);
    assert.ok(snaps.every((s) => String(s.scanId) === scan.id && s.source === 'scan'));

    // the history endpoints read MongoDB only
    const list = await call(`/${projectA._id}/seo-snapshots?datasetType=offpage_overview`);
    assert.equal(list.json.data.snapshots.length, 1, 'offpage_overview is the backlink summary');
    const cmp = await call(`/${projectA._id}/seo-snapshots/comparison?datasetType=domain_overview&part=rank-overview&period=week`);
    assert.equal(cmp.status, 200);
    assert.equal(cmp.json.data.previous, null, 'one snapshot is not a week of history');
    assert.equal(calls.length, 0);
  });

  test('a second identical scan request while one runs returns the running scan; once done, a scan reuses fresh data (0 requests)', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const body = { scope: 'dataset', datasets: ['rank-overview', 'history'] };
    const [a, b] = await Promise.all([call(`/${projectA._id}/seo-scans`, { method: 'POST', body }), call(`/${projectA._id}/seo-scans`, { method: 'POST', body })]);
    assert.deepEqual([a.status, b.status], [202, 202]);
    assert.equal(a.json.data.scan.id, b.json.data.scan.id);
    assert.deepEqual([a.json.data.deduped, b.json.data.deduped].sort(), [false, true]);
    await waitFor(() => call(`/${projectA._id}/seo-scans/latest`));
    assert.equal(calls.length, 2);
    calls = [];
    await call(`/${projectA._id}/seo-scans`, { method: 'POST', body });
    const scan = await waitFor(() => call(`/${projectA._id}/seo-scans/latest`));
    assert.equal(scan.providerRequestsCount, 0);
    assert.equal(calls.length, 0, 'fresh stored data is not bought again without force');
  });

  test('F: a failed dataset gives partially_completed; the others stay readable; a retry re-requests only the failed one', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    failures.history = Object.assign(new Error('x'), { code: 'ECONNRESET' });
    await call(`/${projectA._id}/seo-scans`, { method: 'POST', body: { scope: 'dataset', datasets: ['rank-overview', 'history', 'backlinks'] } });
    const scan = await waitFor(() => call(`/${projectA._id}/seo-scans/latest`));
    assert.equal(scan.status, 'partially_completed');
    assert.deepEqual([scan.datasetsCompleted, scan.datasetsFailed], [2, 1]);
    assert.equal((await section('rank-overview')).json.data.missing, false);
    assert.equal((await section('history')).json.data.missing, true);

    failures = {}; calls = [];
    const retry = await call(`/${projectA._id}/seo-scans`, { method: 'POST', body: { retryOf: scan.id } });
    assert.equal(retry.status, 202);
    const done = await waitFor(() => call(`/${projectA._id}/seo-scans/latest`));
    assert.equal(done.status, 'completed');
    assert.deepEqual(calls.map((c) => c.section), ['history']);
  });

  test('validation: unknown scope / dataset / bad retry id are 400; nothing reaches the provider', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    for (const body of [{ scope: 'everything' }, { scope: 'dataset', datasets: ['x'] }, { scope: 'overview', force: 'yes' }, { retryOf: 'nope' }, {}]) {
      assert.equal((await call(`/${projectA._id}/seo-scans`, { method: 'POST', body })).status, 400, JSON.stringify(body));
    }
    assert.equal(calls.length, 0);
  });

  test('another user cannot start, read or list scans / snapshots of a project they do not own; unauthenticated is 401', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const id = projectA._id;
    for (const [method, path, body] of [['POST', `/${id}/seo-scans`, { scope: 'overview' }], ['GET', `/${id}/seo-scans/latest`], ['GET', `/${id}/seo-scans`], ['GET', `/${id}/seo-snapshots?datasetType=traffic`]]) {
      assert.equal((await call(path, { method, body, token: tokenB })).status, 403, path);
      assert.equal((await call(path, { method, body, token: null })).status, 401, path);
    }
    assert.equal(calls.length, 0);
    assert.equal(await SeoScanRun.countDocuments({ domain }), 0);
  });

  test("a scan id of another project is a 404, not a leak", async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await call(`/${projectA._id}/seo-scans`, { method: 'POST', body: { scope: 'dataset', datasets: ['rank-overview'] } });
    const scan = await waitFor(() => call(`/${projectA._id}/seo-scans/latest`));
    const projectB = await SeoProject.create({ user_id: userB._id, project_name: `${MARK}-B${seq}`, main_url: `https://b-${domain}`, seo_scope: 'local', keywords: ['k'] });
    assert.equal((await call(`/${projectB._id}/seo-scans/${scan.id}`, { token: tokenB })).status, 404);
    assert.equal((await call(`/${projectA._id}/seo-scans/${scan.id}`)).status, 200);
  });
});

describe('the scan queue and lock on a real MongoDB', () => {
  const okFetch = async ({ section: s }) => ({ section: s, result: {}, cached: false, cost: null, fetchedAt: new Date() });
  const fast = { retry: { attempts: 1, baseMs: 0 } };

  test('E/I: many concurrent starts produce exactly one queued scan; workers racing for it process it exactly once', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await worker.stop({ timeoutMs: 3000 }); // this test drives its own workers
    try {
      const attempts = await Promise.all(Array.from({ length: 8 }, () => startScan(
        { project: projectA, userId: String(userA._id), scope: 'dataset', datasets: ['rank-overview', 'history'] },
      ).catch((e) => ({ error: e }))));
      const winners = attempts.filter((a) => a.run && !a.deduped);
      assert.equal(winners.length, 1);
      assert.ok(attempts.every((a) => a === winners[0] || a.deduped || a.error), 'everyone else was deduplicated or refused');
      assert.equal(winners[0].run.status, 'queued');
      assert.equal(await SeoScanRun.countDocuments({ projectId: projectA._id }), 1);

      let executions = 0;
      const counting = async (args) => { executions += 1; await new Promise((r) => setTimeout(r, 30)); return okFetch(args); };
      const mk = (workerId) => createScanWorker({ workerId, pollMs: 20, run: { fetchSection: counting, ...fast } });
      await Promise.all([mk('w1').drain(), mk('w2').drain(), mk('w3').drain()]);
      assert.equal(executions, 2, 'two datasets, bought once each, however many workers raced');
      const stored = await SeoScanRun.findById(winners[0].run._id).lean();
      assert.equal(stored.lockKey, undefined, 'finished: the lock field is gone, so the unique index is free');
      assert.equal(stored.status, 'completed');
      assert.equal(stored.attempts, 1, 'claimed exactly once');
    } finally { worker.start(); }
  });

  test('a crashed worker: once its lease expired another worker claims the scan and CONTINUES with what was not completed', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await worker.stop({ timeoutMs: 3000 });
    try {
      const { run } = await startScan({ project: projectA, userId: String(userA._id), scope: 'dataset', datasets: ['rank-overview', 'history', 'backlinks'] });
      const claimed = await mongoRunStore.claimNext({ workerId: 'dead-worker', now: new Date(), leaseMs: 60_000 });
      assert.equal(String(claimed._id), String(run._id));
      assert.equal(claimed.attempts, 1);
      await mongoRunStore.updateDataset(run._id, 'rank-overview', { status: 'completed', cached: false }, { datasetsCompleted: 1, providerRequestsCount: 1 });
      await mongoRunStore.updateDataset(run._id, 'history', { status: 'running' });
      assert.equal(await mongoRunStore.claimNext({ workerId: 'other', now: new Date(), leaseMs: 60_000 }), null, 'a live lease cannot be taken');
      assert.equal(await mongoRunStore.heartbeat(run._id, 'someone-else', new Date(Date.now() + 1000)), false, 'only the owner extends the lease');
      await SeoScanRun.updateOne({ _id: run._id }, { $set: { leaseUntil: new Date(Date.now() - 1000) } });

      const bought = [];
      const w = createScanWorker({ workerId: 'rescuer', pollMs: 20, run: { fetchSection: async (a) => { bought.push(a.section); return okFetch(a); }, ...fast } });
      await w.drain();
      assert.deepEqual(bought.sort(), ['backlinks', 'history'], 'the completed dataset is not bought again');
      const after = await SeoScanRun.findById(run._id).lean();
      assert.equal(after.status, 'completed');
      assert.equal(after.attempts, 2);
      assert.equal(after.datasetsCompleted, 3);
      assert.equal(after.lockKey, undefined);
    } finally { worker.start(); }
  });

  test('a graceful stop hands an unfinished scan back to the queue with its lock and completed datasets intact', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await worker.stop({ timeoutMs: 3000 });
    try {
      const { run } = await startScan({ project: projectA, userId: String(userA._id), scope: 'dataset', datasets: ['rank-overview', 'history', 'backlinks'] });
      let release; const gate = new Promise((r) => { release = r; });
      let n = 0;
      const w = createScanWorker({ workerId: 'stopper', pollMs: 20, run: { concurrency: 1, ...fast, fetchSection: async (a) => { n += 1; await gate; return okFetch(a); } } });
      await w.tick();
      for (let i = 0; i < 100 && n === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
      const stopping = w.stop({ timeoutMs: 5000 });
      release();
      await stopping;
      const mid = await SeoScanRun.findById(run._id).lean();
      assert.equal(mid.status, 'queued');
      assert.equal(mid.lockKey, String(projectA._id), 'still locked: no second scan can start meanwhile');
      assert.equal(mid.datasets.filter((d) => d.status === 'completed').length, 1);
      assert.equal(n, 1);
      await assert.rejects(startScan({ project: projectA, userId: String(userA._id), scope: 'dataset', datasets: ['competitors'] }), { code: 'SCAN_IN_PROGRESS' });
      const bought = [];
      await createScanWorker({ pollMs: 20, run: { fetchSection: async (a) => { bought.push(a.section); return okFetch(a); }, ...fast } }).drain();
      assert.equal(bought.length, 2);
      assert.equal((await SeoScanRun.findById(run._id).lean()).status, 'completed');
    } finally { worker.start(); }
  });
});

describe('provider cost protection and accounting (real routers, real MongoDB, stubbed provider)', () => {
  const FIVE = ['rank-overview', 'history', 'ranked-keywords-top5', 'competitors', 'backlinks'];
  const idle = async () => {
    for (let i = 0; i < 200; i += 1) {
      const s = (await call(`/${projectA._id}/seo-scans/latest`)).json.data.scan;
      if (s && !['pending', 'queued', 'running'].includes(s.status)) return s;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('scan did not finish');
  };

  test('every real request of a scan is recorded (no cache hits), with the costs the provider reported; the summary adds only known costs', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const SeoProviderRequest = (await import('../model/SeoProviderRequest.js')).default;
    await call(`/${projectA._id}/seo-scans`, { method: 'POST', body: { scope: 'dataset', datasets: FIVE } });
    const scan = await idle();
    const rows = await SeoProviderRequest.find({ projectId: projectA._id }).lean();
    assert.equal(rows.length, 5);
    assert.equal(rows.every((r) => String(r.scanId) === scan.id && r.trigger === 'scan' && r.success === true), true);
    assert.deepEqual(rows.map((r) => r.dataset).sort(), ['backlinks', 'competitors', 'history', 'rank-overview', 'ranked-keywords']);
    const kw = rows.find((r) => r.dataset === 'ranked-keywords');
    assert.ok(kw.durationMs >= 0 && kw.returnedRecords >= 1 && kw.requestedRecords === 5);
    // nothing sensitive is stored
    assert.deepEqual(Object.keys(rows[0]).sort(), ['__v', '_id', 'cost', 'createdAt', 'dataset', 'durationMs', 'endpoint', 'errorCode', 'projectId', 'requestedRecords', 'retryCount', 'returnedRecords', 'scanId', 'startedAt', 'success', 'target', 'trigger']);
    assert.equal(JSON.stringify(rows).includes('test-password'), false);

    const mark = calls.length;
    const usage = (await call(`/${projectA._id}/seo-usage?scanId=${scan.id}`)).json.data;
    assert.equal(usage.total.requests, 5);
    assert.equal(usage.total.failures, 0);
    assert.equal(usage.total.costComplete, true);
    assert.ok(Math.abs(usage.total.reportedCost - 0.1844) < 1e-9);
    assert.equal(usage.byDataset.length, 5);
    assert.equal(usage.byTrigger[0].trigger, 'scan');
    const project = (await call(`/${projectA._id}/seo-usage?days=7`)).json.data;
    assert.equal(project.total.requests, 5);
    // reading never writes to the ledger and never buys
    for (const name of ['rank-overview', 'history', 'ranked-keywords', 'competitors', 'backlinks']) await call(`/${projectA._id}/domain-overview/${name}`);
    assert.equal(await SeoProviderRequest.countDocuments({ projectId: projectA._id }), 5);
    assert.equal(calls.length, mark);
    assert.equal((await call(`/${projectA._id}/seo-usage?scanId=nope`)).status, 400);
    assert.equal((await call(`/${projectA._id}/seo-usage`, { token: tokenB })).status, 403);
  });

  test('a failed provider request is recorded as a failure with a code only; a user refresh is recorded as a refresh', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const SeoProviderRequest = (await import('../model/SeoProviderRequest.js')).default;
    failures.history = Object.assign(new Error('secret provider body'), { code: 'ECONNRESET' });
    const bad = await call(`/${projectA._id}/domain-overview/history?refresh=1`);
    assert.ok(bad.status >= 500);
    failures = {};
    const ok = await call(`/${projectA._id}/domain-overview/rank-overview?refresh=1`);
    assert.equal(ok.status, 200);
    const rows = await SeoProviderRequest.find({ projectId: projectA._id }).sort({ startedAt: 1 }).lean();
    assert.deepEqual(rows.map((r) => [r.dataset, r.trigger, r.success]), [['history', 'refresh', false], ['rank-overview', 'refresh', true]]);
    assert.ok(rows[0].errorCode && !JSON.stringify(rows[0]).includes('secret'));
    const usage = (await call(`/${projectA._id}/seo-usage`)).json.data;
    assert.deepEqual([usage.total.requests, usage.total.failures], [2, 1]);
    assert.equal(usage.recentFailures[0].dataset, 'history');
  });

  test('a page Refresh is refused while a scan is collecting for the project (no double purchase), and allowed again afterwards', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await worker.stop({ timeoutMs: 3000 });
    try {
      const started = await call(`/${projectA._id}/seo-scans`, { method: 'POST', body: { scope: 'dataset', datasets: ['rank-overview'] } });
      assert.equal(started.status, 202);
      assert.equal(started.json.data.scan.status, 'queued', 'the request only queued it');
      assert.equal(calls.length, 0, 'and bought nothing');
      const refused = await call(`/${projectA._id}/domain-overview/rank-overview?refresh=1`);
      assert.equal(refused.status, 409);
      assert.equal(refused.json.code, 'SCAN_IN_PROGRESS');
      // a plain read is never refused
      assert.equal((await call(`/${projectA._id}/domain-overview/rank-overview`)).status, 200);
      assert.equal(calls.length, 0);
    } finally { worker.start(); }
    await idle();
    assert.equal(calls.length, 1);
    assert.equal((await call(`/${projectA._id}/domain-overview/rank-overview?refresh=1`)).status, 200);
  });

  test('EVERY page section: opening, paging, sorting, filtering and searching make ZERO provider requests - empty database, after a scan, and with stale data', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const sections = SECTION_NAMES.filter((s) => s !== 'bulk-traffic' && s !== 'head-to-head');
    const f = (...c) => `filters=${encodeURIComponent(JSON.stringify(c.length === 1 ? c[0] : c.flatMap((x, i) => (i ? ['and', x] : [x]))))}`;
    const variants = (name) => {
      const base = ['', '?limit=25&offset=25'];
      if (name === 'ranked-keywords') return [...base, `?${f(['keyword_data.keyword', 'like', '%a%'])}`, '?order_by=keyword_data.keyword,asc'];
      if (name === 'backlinks-list') return [...base, `?${f(['url_from', 'like', '%a%'])}`, '?status=lost', '?mode=one_per_domain', '?order_by=first_seen,desc'];
      if (name === 'referring-domains') return [...base, `?${f(['domain', 'like', '%a%'])}`, '?status=lost', '?dofollow=1', '?order_by=backlinks,asc'];
      if (name === 'anchors') return [...base, `?${f(['anchor', 'like', '%a%'])}`, '?status=lost', '?order_by=backlinks,asc'];
      if (name === 'domain-pages') return [...base, `?${f(['page', 'like', '%a%'])}`, '?order_by=page_summary.backlinks,asc'];
      if (name === 'competitors') return [...base, '?order_by=avg_position,asc', '?exclude_top_domains=0'];
      if (name === 'backlinks') return ['', '?status=lost', '?dofollow=1'];
      if (name === 'history') return ['', '?months=6', '?months=24'];
      return [''];
    };
    const sweep = async (label) => {
      const before = calls.length;
      let n = 0;
      for (const name of sections) {
        for (const q of variants(name)) {
          const r = await call(`/${projectA._id}/domain-overview/${name}${q}`);
          assert.ok([200, 400].includes(r.status), `${label} ${name}${q} -> ${r.status}`);
          n += 1;
        }
      }
      assert.equal(calls.length, before, `${label}: ${n} reads, provider requests made`);
      return n;
    };
    const first = await sweep('empty database');
    assert.ok(first > 40);
    await call(`/${projectA._id}/seo-scans`, { method: 'POST', body: { scope: 'dataset', datasets: ['rank-overview', 'history', 'backlinks', 'competitors', 'keywords-dataset', 'backlinks-dataset-live', 'referring-domains-dataset-live'] } });
    await idle().catch(() => null);
    calls.length = 0;
    await sweep('after a scan');
    // stale: age every stored answer of this project past its deadline
    const DataForSeoCache = (await import('../../shared/DataForSeoCacheEntry.js')).default;
    await DataForSeoCache.updateMany({ target: domain }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await SeoSnapshot.updateMany({ projectId: projectA._id, part: /^dataset:/ }, { $set: { capturedAt: new Date(Date.now() - 5 * 86_400_000) } });
    await sweep('stale data');
    // the history and freshness endpoints
    const mark = calls.length;
    for (const p of [`/seo-datasets`, `/seo-datasets/freshness`, `/seo-datasets/changes?dataset=keywords`, `/seo-datasets/changes?dataset=backlinks&period=week`, `/seo-datasets/keywords`, `/seo-datasets/backlinks`, `/seo-datasets/referring-domains`, `/seo-datasets/anchors`, `/seo-datasets/pages`, `/seo-snapshots?datasetType=traffic`, `/seo-snapshots/comparison?datasetType=domain_overview&part=rank-overview&period=week`, `/seo-scans`, `/seo-scans/latest`, `/seo-usage`]) {
      const r = await call(`/${projectA._id}${p}`);
      assert.equal(r.status, 200, p);
    }
    assert.equal(calls.length, mark, 'history, comparison, freshness and usage read MongoDB only');
  });
});
