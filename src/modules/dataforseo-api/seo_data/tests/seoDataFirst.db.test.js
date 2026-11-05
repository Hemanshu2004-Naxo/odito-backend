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
});

after(async () => {
  __setTransportForTests(null);
  if (mongoAvailable) {
    const re = new RegExp(MARK);
    await DataForSeoCacheEntry.deleteMany({ target: re });
    await SeoSnapshot.deleteMany({ domain: re });
    await SeoScanRun.deleteMany({ domain: re });
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

describe('the scan lock on a real MongoDB unique index', () => {
  test('E/I: many concurrent starts from "different instances" produce exactly one execution', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    let executions = 0;
    const slowFetch = async ({ section: s }) => { executions += 1; await new Promise((r) => setTimeout(r, 60)); return { section: s, result: {}, cached: false, cost: null, fetchedAt: new Date() }; };
    const attempts = await Promise.all(Array.from({ length: 8 }, () => startScan(
      { project: projectA, userId: String(userA._id), scope: 'dataset', datasets: ['rank-overview'] }, { fetchSection: slowFetch },
    ).catch((e) => ({ error: e }))));
    const winners = attempts.filter((a) => a.run && !a.deduped);
    assert.equal(winners.length, 1);
    assert.ok(attempts.every((a) => a.deduped || a === winners[0] || a.error), 'everyone else was deduplicated or refused');
    await winners[0].done;
    assert.equal(executions, 1);
    assert.equal(await SeoScanRun.countDocuments({ projectId: projectA._id }), 1);
    const stored = await SeoScanRun.findById(winners[0].run._id).lean();
    assert.equal(stored.lockKey, undefined, 'finished: the lock field is gone, so the unique index is free');
    assert.equal(stored.status, 'completed');
  });

  test('a crashed scan (lease expired) is ended as failed by the next start, which then gets the lock', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const dead = await mongoRunStore.tryAcquire({ projectId: projectA._id, domain, scope: 'overview', datasetsRequested: [], datasets: [], leaseUntil: new Date(Date.now() - 5000) });
    assert.ok(dead);
    assert.equal(await mongoRunStore.tryAcquire({ projectId: projectA._id, domain, scope: 'overview', datasets: [] }), null, 'the index refuses a second active scan');
    const { done } = await startScan({ project: projectA, userId: String(userA._id), scope: 'dataset', datasets: ['rank-overview'] }, {
      fetchSection: async ({ section: s }) => ({ section: s, result: {}, cached: false, cost: null, fetchedAt: new Date() }),
    });
    await done;
    const old = await SeoScanRun.findById(dead._id).lean();
    assert.deepEqual([old.status, old.error.code, old.lockKey], ['failed', 'SCAN_LEASE_EXPIRED', undefined]);
  });
});
