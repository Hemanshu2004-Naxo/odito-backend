import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import express from 'express';

dotenv.config();
delete process.env.SEO_DB_FIRST_READS;
delete process.env.SEO_AUTO_COLLECT;
process.env.DATAFORSEO_LOGIN = 'test-login';
process.env.DATAFORSEO_PASSWORD = 'test-password';

import User from '../../../user/model/User.js';
import SeoProject from '../../../app_user/model/SeoProject.js';
import { signAuthToken } from '../../../user/service/tokenService.js';
import DataForSeoCacheEntry from '../../shared/DataForSeoCacheEntry.js';
import { __resetInFlightForTests } from '../../shared/apiCache.js';
import SeoSnapshot from '../model/SeoSnapshot.js';
import SeoScanRun from '../model/SeoScanRun.js';
import SeoKeywordRanking from '../model/SeoKeywordRanking.js';
import SeoBacklink from '../model/SeoBacklink.js';
import SeoReferringDomain from '../model/SeoReferringDomain.js';
import SeoProviderRequest from '../model/SeoProviderRequest.js';
import domainOverviewRoutes from '../../domain_overview/routes/domainOverviewRoutes.js';
import seoScanRoutes from '../routes/seoScanRoutes.js';
import { __setTransportForTests } from '../../domain_overview/provider/domainOverviewProvider.js';
import { SECTION_NAMES } from '../../domain_overview/config.js';
import { createScanWorker } from '../worker/seoScanWorker.js';
import { envelope, historyResult, historyItem, rankOverviewResult, competitorsResult, competitorItem, rankedKeywordItem } from '../../domain_overview/tests/fixtures.js';

/**
 * Automatic collection through the REAL routers, the REAL queue / lock / worker and a REAL MongoDB (skipped when unreachable). Only the
 * provider transport is replaced - for EVERY section - and every call is counted: an endpoint nobody stubbed throws, so no test can buy anything.
 */

const MARK = `seo-auto-${Date.now()}`;
let mongoAvailable = false;
let server; let baseUrl; let calls; let seq = 0;
let userA; let userB; let tokenA; let tokenB; let project; let domain;
let workers = [];

const KW_TOTAL = 120;
const STUBS = {
  'rank-overview': () => envelope(rankOverviewResult()),
  'history': () => envelope(historyResult([historyItem(2026, 10, 1000, 100)]), { cost: 0.13 }),
  'competitors': (body) => envelope(competitorsResult([competitorItem(body.target), competitorItem('rival.com')])),
  'ranked-keywords': (body) => {
    const start = body.offset ?? 0;
    const count = Math.max(0, Math.min(body.limit, KW_TOTAL - start));
    const items = Array.from({ length: count }, (_, i) => rankedKeywordItem({
      keyword_data: { keyword: `Keyword ${start + i}`, keyword_info: { search_volume: 100 + i, cpc: 1 }, keyword_properties: { keyword_difficulty: i % 100 }, search_intent_info: { main_intent: 'informational' }, serp_info: { serp_item_types: ['organic'] } },
      ranked_serp_element: { last_updated_time: '2026-11-01 00:00:00 +00:00', serp_item: { type: 'organic', rank_group: ((start + i) % 20) + 1, rank_absolute: ((start + i) % 20) + 1, etv: 500 - (start + i), relative_url: '/p/', url: `https://www.${domain}/p/`, rank_changes: { previous_rank_absolute: 9 } } },
    }));
    return envelope({ total_count: KW_TOTAL, items_count: count, items: count ? items : null, metrics: { organic: { count: KW_TOTAL, etv: 5000, pos_1: 5, pos_2_3: 6, pos_4_10: 7, is_new: 1, is_up: 2, is_down: 3 } } });
  },
};

before(async () => {
  const transport = {};
  for (const section of SECTION_NAMES) {
    transport[section] = async (body) => {
      calls.push({ section, body });
      if (!STUBS[section]) throw new Error(`UNSTUBBED provider call: ${section}`);
      return STUBS[section](body);
    };
  }
  __setTransportForTests(transport);
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch { return; }
  await Promise.all([DataForSeoCacheEntry, SeoSnapshot, SeoScanRun, SeoKeywordRanking, SeoBacklink, SeoReferringDomain].map((m) => m.init()));
  const app = express();
  app.use(express.json());
  app.use('/api/projects', domainOverviewRoutes);
  app.use('/api/projects', seoScanRoutes);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/projects`;
});

after(async () => {
  await Promise.all(workers.map((w) => w.stop({ timeoutMs: 3000 })));
  __setTransportForTests(null);
  if (mongoAvailable) {
    const re = new RegExp(MARK);
    await DataForSeoCacheEntry.deleteMany({ target: re });
    await SeoSnapshot.deleteMany({ domain: re });
    await SeoScanRun.deleteMany({ domain: re });
    for (const m of [SeoKeywordRanking, SeoBacklink, SeoReferringDomain]) await m.deleteMany({ domain: re });
    await SeoProviderRequest.deleteMany({ target: re });
    await SeoProject.deleteMany({ project_name: re });
    await User.deleteMany({ email: re });
    await mongoose.connection.close();
  }
  if (server) await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  calls = [];
  __resetInFlightForTests();
  await Promise.all(workers.map((w) => w.stop({ timeoutMs: 3000 })));
  workers = [];
  if (!mongoAvailable) return;
  seq += 1;
  domain = `s${seq}-${MARK}.example.com`;
  userA = await User.create({ firstName: 'Ann', lastName: 'Owner', email: `a${seq}-${MARK}@example.com`, password: 'Passw0rd!long', roleId: 5 });
  userB = await User.create({ firstName: 'Bob', lastName: 'Other', email: `b${seq}-${MARK}@example.com`, password: 'Passw0rd!long', roleId: 5 });
  tokenA = signAuthToken(userA); tokenB = signAuthToken(userB);
  project = await SeoProject.create({ user_id: userA._id, project_name: `${MARK}-A${seq}`, main_url: `https://www.${domain}/`, seo_scope: 'local', keywords: ['k'], country: 'IN', language: 'en' });
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
const ensure = (page, opts) => call(`/${project._id}/seo-data/ensure`, { method: 'POST', body: { page }, ...opts });
const section = (name, q = '') => call(`/${project._id}/domain-overview/${name}${q}`);
const startWorker = (id) => { const w = createScanWorker({ workerId: id, pollMs: 30, run: { retry: { attempts: 1, baseMs: 0 }, heartbeatMs: 500 } }); w.start(); workers.push(w); return w; };
const settle = async () => {
  for (let i = 0; i < 200; i += 1) {
    if (!(await SeoScanRun.exists({ projectId: project._id, status: { $in: ['queued', 'running'] } }))) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('scan did not finish');
};
/** Makes everything collected so far `ms` older: the stored answers' deadlines AND the history of the scans that collected them (as real time would). */
async function ageEverything(ms) {
  const shift = (d) => new Date(new Date(d).getTime() - ms);
  for (const e of await DataForSeoCacheEntry.find({ target: domain }).lean()) {
    await DataForSeoCacheEntry.updateOne({ _id: e._id }, { $set: { fetchedAt: shift(e.fetchedAt), expiresAt: shift(e.expiresAt) } });
  }
  for (const r of await SeoScanRun.find({ projectId: project._id }).lean()) {
    await SeoScanRun.updateOne({ _id: r._id }, { $set: { createdAt: shift(r.createdAt), finishedAt: r.finishedAt ? shift(r.finishedAt) : null, datasets: r.datasets.map((d) => ({ ...d, finishedAt: d.finishedAt ? shift(d.finishedAt) : null, fetchedAt: d.fetchedAt ? shift(d.fetchedAt) : null })) } }, { timestamps: false });
  }
}
const scanCount = () => SeoScanRun.countDocuments({ projectId: project._id });

describe('automatic collection (real routers + worker + MongoDB, stubbed provider)', () => {
  test('missing page: the page read answers at once (missing, no provider call); ensure queues; the worker buys; the page then reads from MongoDB', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const read0 = await section('history');
    assert.equal(read0.status, 200);
    assert.equal(read0.json.data.missing, true);
    assert.equal(calls.length, 0);

    const e1 = await ensure('traffic');
    assert.equal(e1.status, 200);
    assert.equal(e1.json.data.state, 'missing');
    assert.equal(e1.json.data.activity, 'queued');
    assert.deepEqual(e1.json.data.enqueued.datasets, ['history']);
    assert.equal(calls.length, 0, 'the request returned without any provider call');
    assert.equal(await scanCount(), 1);

    startWorker('w1');
    await settle();
    assert.equal(calls.filter((c) => c.section === 'history').length, 1);

    const read1 = await section('history');
    assert.equal(read1.json.data.missing, false);
    assert.equal(read1.json.data.stale, false);
    const e2 = await ensure('traffic');
    assert.equal(e2.json.data.state, 'fresh');
    assert.equal(e2.json.data.activity, 'idle');
    assert.ok(e2.json.data.lastUpdatedAt);
    assert.equal(calls.length, 1);
    assert.equal(await scanCount(), 1);
    const scan = await SeoScanRun.findOne({ projectId: project._id }).lean();
    assert.equal(scan.triggerType, 'auto');
    assert.equal(scan.force, false);
  });

  test('stale page: the old data is returned immediately, a background refresh is queued, the old data stays until the new one is stored', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await ensure('traffic'); startWorker('w1'); await settle();
    await ageEverything(8 * 24 * 3_600_000); // past the 7 day freshness of history
    const read = await section('history');
    assert.equal(read.json.data.stale, true);
    assert.ok(read.json.data.result, 'the stale data is still served');
    assert.equal(calls.length, 1, 'reading it bought nothing');

    const e = await ensure('traffic');
    assert.equal(e.json.data.state, 'stale');
    assert.equal(e.json.data.hasData, true);
    assert.equal(e.json.data.activity, 'queued');
    assert.equal(calls.length, 1, 'ensure itself bought nothing');
    await settle();
    assert.equal(calls.filter((c) => c.section === 'history').length, 2, 'exactly one refresh purchase');
    assert.equal((await ensure('traffic')).json.data.state, 'fresh');
  });

  test('simultaneous opens (tabs / instances) create ONE scan document and ONE purchase per dataset', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const results = await Promise.all(Array.from({ length: 20 }, () => ensure('competitors')));
    assert.ok(results.every((r) => r.status === 200));
    assert.equal(await scanCount(), 1);
    assert.equal(new Set(results.map((r) => r.json.data.scan.id)).size, 1);
    // Two backend instances' workers race for it.
    startWorker('instance-1'); startWorker('instance-2'); startWorker('instance-3');
    await settle();
    assert.deepEqual(calls.map((c) => c.section).sort(), ['competitors', 'rank-overview']);
    assert.equal(await scanCount(), 1);
  });

  test('a page the running scan does not cover waits; it is queued once, after the scan ends', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await ensure('traffic');
    const other = await ensure('competitors');
    assert.equal(other.json.data.activity, 'waiting');
    assert.equal(await scanCount(), 1);
    startWorker('w1'); await settle();
    const again = await ensure('competitors');
    assert.equal(again.json.data.activity, 'queued');
    assert.equal(await scanCount(), 2);
    await settle();
    assert.equal(calls.filter((c) => c.section === 'history').length, 1);
  });

  test('Organic Keywords: after the automatic collection, paging / searching / sorting / filtering are MongoDB reads (ZERO provider calls)', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const e = await ensure('organic-keywords');
    assert.deepEqual(e.json.data.enqueued.datasets, ['keywords-dataset']);
    startWorker('w1'); await settle();
    const bought = calls.length;
    assert.ok(bought >= 1);
    const filters = encodeURIComponent(JSON.stringify(['keyword_data.keyword', 'like', '%keyword 1%']));
    const reads = [
      section('ranked-keywords'),
      section('ranked-keywords', '?limit=25'),
      section('ranked-keywords', '?limit=25&offset=25'),
      section('ranked-keywords', '?limit=25&offset=50&order_by=ranked_serp_element.serp_item.rank_group,asc'),
      section('ranked-keywords', `?limit=50&filters=${filters}`),
    ];
    const done = await Promise.all(reads);
    for (const r of done) { assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.data.missing, false); }
    assert.ok(done[0].json.data.result.metrics, JSON.stringify(Object.keys(done[0].json.data.result)));
    assert.equal(done[0].json.data.result.totalCount, KW_TOTAL, 'the totals come from the stored set too');
    assert.equal(done[2].json.data.result.items.length, 25);
    assert.equal(calls.length, bought, 'no read bought anything');
    // Opening the page over and over: still nothing.
    for (let i = 0; i < 5; i += 1) { assert.equal((await ensure('organic-keywords')).json.data.state, 'fresh'); await section('ranked-keywords'); }
    assert.equal(calls.length, bought);
    assert.equal(await scanCount(), 1);
  });

  test('a failed refresh keeps the stored data, is recorded, and does not retry on every open', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await ensure('traffic'); startWorker('w1'); await settle();
    await ageEverything(8 * 24 * 3_600_000);
    const before = await DataForSeoCacheEntry.findOne({ target: domain, endpoint: 'labs/historical_rank_overview/v2' }).lean();
    const original = STUBS.history;
    STUBS.history = () => { throw Object.assign(new Error('down'), { code: 'PROVIDER_UNAVAILABLE' }); };
    try {
      assert.equal((await ensure('traffic')).json.data.activity, 'queued');
      await settle();
    } finally { STUBS.history = original; }
    const after = await DataForSeoCacheEntry.findOne({ target: domain, endpoint: 'labs/historical_rank_overview/v2' }).lean();
    assert.deepEqual(after.payload, before.payload, 'the stored payload was not replaced or emptied');
    const bought = calls.length;
    const e = await ensure('traffic');
    assert.equal(e.json.data.state, 'stale');
    assert.equal(e.json.data.hasData, true);
    assert.equal(e.json.data.activity, 'cooldown');
    assert.ok(e.json.data.lastError);
    for (let i = 0; i < 10; i += 1) await ensure('traffic');
    assert.equal(calls.length, bought);
    assert.equal(await scanCount(), 2, 'no further scan was queued');
    const read = await section('history');
    assert.ok(read.json.data.result, 'the page still shows the previous data');
  });

  test('access control: another user cannot ensure, refresh or observe this project; an unknown page is a 400', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const denied = await ensure('traffic', { token: tokenB });
    assert.ok([403, 404].includes(denied.status), `status ${denied.status}`);
    assert.equal((await call(`/${project._id}/seo-data/refresh`, { token: tokenB, method: 'POST', body: { page: 'traffic' } })).status, denied.status);
    assert.equal(await scanCount(), 0);
    const bad = await ensure('not-a-page');
    assert.equal(bad.status, 400);
    assert.equal((await call(`/${project._id}/seo-data/ensure`, { token: null, method: 'POST', body: { page: 'traffic' } })).status, 401);
    assert.equal(calls.length, 0);
  });

  test('manual refresh: queues a forced scan of that page, then is limited to once per window', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await ensure('traffic'); startWorker('w1'); await settle();
    const r1 = await call(`/${project._id}/seo-data/refresh`, { method: 'POST', body: { page: 'traffic' } });
    assert.equal(r1.status, 202);
    assert.equal(r1.json.data.accepted, true);
    await settle();
    // (A forced buy inside the provider's 60 s refresh floor is throttled by the existing floor, so the purchase count is not asserted here.)
    assert.equal((await SeoScanRun.findById(r1.json.data.scan.id).lean()).force, true);
    assert.equal((await SeoScanRun.findById(r1.json.data.scan.id).lean()).triggerType, 'manual');
    const r2 = await call(`/${project._id}/seo-data/refresh`, { method: 'POST', body: { page: 'traffic' } });
    assert.equal(r2.status, 409);
    assert.equal(r2.json.code, 'COOLDOWN');
  });
});
