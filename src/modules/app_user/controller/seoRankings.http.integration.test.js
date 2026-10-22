/**
 * HTTP integration tests for the desktop + mobile keyword ranking endpoints.
 *
 * Real: Express routing, auth middleware + JWTs, validateProjectAccess, controllers, services, Mongoose models, MongoDB
 * (isolated database odito_rankings_test — the shared harness refuses any other name).
 * Mocked: the DataForSEO HTTP call (axios.post). No paid API request is ever made.
 *
 * Run from backend/:
 *   INVESTIGATION_IT_DB=odito_rankings_test node --test --test-concurrency=1 \
 *     src/modules/app_user/controller/seoRankings.http.integration.test.js
 */
process.env.INVESTIGATION_IT_DB ??= 'odito_rankings_test';
process.env.DATAFORSEO_LOGIN ||= 'test-login';
process.env.DATAFORSEO_PASSWORD ||= 'test-password';

import { describe, test, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';
import axios from 'axios';

const { connectTestDb, seedTenant, apiClient, cleanupTenant } = await import('../../ai-investigation/integration/harness.mjs');
const { default: SeoRankingCurrent } = await import('../model/SeoRankingCurrent.js');
const { default: SeoRanking } = await import('../model/SeoRanking.js');
const { default: KeywordRankingHistory } = await import('../model/KeywordRankingHistory.js');
const { default: User } = await import('../../user/model/User.js');
const { saveCanonicalRanking } = await import('../../../services/rankingHistoryService.js');
const { MapsRankingService } = await import('../../ranking/services/MapsRankingService.js');
const { default: seoOnboardingRoutes } = await import('../routes/seoOnboardingRoutes.js');
const { default: keywordResearchRoutes } = await import('../../keyword_research/routes/keywordResearchRoutes.js');

const DOMAIN = 'site.example';
let mongoOk = false, server, apiA, apiB, apiAnon, A, B;

/** SERP with `count` organic results; DOMAIN appears at `rank` (null = absent). */
const serp = (count, rank) => ({
  data: {
    status_code: 20000,
    tasks: [{
      status_code: 20000,
      result: [{
        items: Array.from({ length: count }, (_, i) => {
          const pos = i + 1;
          const domain = pos === rank ? DOMAIN : `other${pos}.example`;
          return { type: 'organic', rank_group: pos, rank_absolute: pos, domain, url: `https://${domain}/p${pos}` };
        }),
      }],
    }],
  },
});

/** provider(device) -> { rank, count } | Error */
let provider;
let calls;
const installProvider = () => {
  calls = [];
  mock.method(axios, 'post', async (url, payload) => {
    const p = payload[0];
    calls.push({ url, device: p.device, os: p.os, keyword: p.keyword, depth: p.depth, location_code: p.location_code });
    const r = provider(p.device, p.keyword);
    if (r instanceof Error) throw r;
    return serp(r.count ?? 90, r.rank ?? null);
  });
};

const seedCanonical = async (tenant, keywords, scanSource = 'onboarding') => {
  await User.updateOne({ _id: tenant.user._id }, { $set: { 'subscription.status': 'active', 'subscription.plan': 'premium' } });
  await saveCanonicalRanking({
    projectId: tenant.project._id, userId: tenant.user._id, domain: DOMAIN, location: 'US', locationCode: 2840,
    country: 'US', language: 'en', seoScope: 'national', keywords, scanSource,
  });
};
const urls = (rank) => (rank == null ? [] : [{ rank, url: `https://${DOMAIN}/p${rank}`, type: 'internal_page' }]);
const mobileOk = (rank) => ({ ranking_urls: urls(rank), best_rank: rank, tracked_depth: 55, scan_error: null });
const canonicalOf = (tenant) => SeoRankingCurrent.findOne({ project_id: tenant.project._id }).lean();
const oldRescan = (tenant, keyword) => SeoRankingCurrent.collection.updateOne(
  { project_id: tenant.project._id },
  { $set: { 'keywords.$[k].last_rescanned_at': new Date(Date.now() - 3 * 3600 * 1000) } },
  { arrayFilters: [{ 'k.keyword': keyword }] },
);

before(async () => {
  try { await connectTestDb(); mongoOk = true; } catch { mongoOk = false; return; }
  await Promise.all([SeoRankingCurrent.init(), KeywordRankingHistory.init()]);
  A = await seedTenant({ label: 'rankA', siteUrl: `https://${DOMAIN}/` });
  B = await seedTenant({ label: 'rankB', siteUrl: 'https://other-tenant.example/' });
  const app = express();
  app.use(express.json());
  app.use('/api/seo', seoOnboardingRoutes);
  app.use('/api/keywords', keywordResearchRoutes);
  server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  apiA = apiClient(base, A.token); apiB = apiClient(base, B.token); apiAnon = apiClient(base, null);
});

after(async () => {
  if (!mongoOk) return;
  await new Promise((r) => server.close(r));
  await Promise.all([A, B].map(async (t) => {
    await Promise.all([
      SeoRankingCurrent.deleteMany({ project_id: t.project._id }), SeoRanking.deleteMany({ project_id: t.project._id }),
      KeywordRankingHistory.deleteMany({ project_id: t.project._id }),
    ]);
  }));
  await cleanupTenant(A, B);
  await mongoose.disconnect();
});

beforeEach(async () => {
  if (!mongoOk) return;
  delete process.env.KEYWORD_MOBILE_RANKING_ENABLED;
  await Promise.all([A, B].map((t) => Promise.all([
    SeoRankingCurrent.deleteMany({ project_id: t.project._id }), SeoRanking.deleteMany({ project_id: t.project._id }),
    KeywordRankingHistory.deleteMany({ project_id: t.project._id }),
  ])));
  provider = () => ({ rank: 4, count: 90 });
  installProvider();
});
afterEach(() => { mock.restoreAll(); delete process.env.KEYWORD_MOBILE_RANKING_ENABLED; });

const it = (name, fn) => test(name, async (t) => { if (!mongoOk) return t.skip('MongoDB not reachable'); await fn(t); });

describe('POST /seo/keywords/:projectId (add keyword → processKeyword)', () => {
  it('scans desktop and mobile with their own device/os and returns both, independently', async () => {
    await seedCanonical(A, [{ keyword: 'seed', ranking_urls: urls(2), mobile: mobileOk(3) }]);
    provider = (device) => (device === 'desktop' ? { rank: 8, count: 93 } : { rank: 11, count: 55 });

    const r = await apiA('POST', `/seo/keywords/${A.projectId}`, { keyword: 'new term' });
    assert.equal(r.status, 201, JSON.stringify(r.json));

    assert.deepEqual(calls.map((c) => `${c.device}/${c.os}`).sort(), ['desktop/windows', 'mobile/android']);
    for (const c of calls) { assert.equal(c.depth, 100); assert.equal(c.location_code, 2840); }

    const kw = r.json.data.keyword;
    assert.equal(kw.current_rank, 8);
    assert.equal(kw.status, 'ranked');
    assert.equal(kw.mobile.current_rank, 11);
    assert.equal(kw.mobile.status, 'ranked');
    assert.equal(kw.mobile.tracked_depth, 55);
    assert.equal(kw.mobile.prev_scan_rank, null);
  });

  it('desktop succeeds while mobile fails: 201, desktop ranked, mobile scan_error with no rank', async () => {
    await seedCanonical(A, [{ keyword: 'seed', ranking_urls: urls(2) }]);
    provider = (device) => (device === 'mobile' ? Object.assign(new Error('bad request'), { response: { status: 400 } }) : { rank: 6 });

    const r = await apiA('POST', `/seo/keywords/${A.projectId}`, { keyword: 'new term' });
    assert.equal(r.status, 201);
    assert.equal(r.json.data.keyword.status, 'ranked');
    assert.equal(r.json.data.keyword.last_scan_status, 'ok');
    assert.equal(r.json.data.keyword.mobile.status, 'scan_error');
    assert.equal(r.json.data.keyword.mobile.current_rank, null);
    assert.ok(r.json.data.keyword.mobile.last_scan_error);
    assert.ok(!/bad request|dataforseo/i.test(r.json.data.keyword.mobile.last_scan_error), 'vendor detail must not reach the client');
  });

  it('mobile switched off: only desktop is requested and no mobile object is invented', async () => {
    process.env.KEYWORD_MOBILE_RANKING_ENABLED = 'false';
    await seedCanonical(A, [{ keyword: 'seed', ranking_urls: urls(2) }]);
    const r = await apiA('POST', `/seo/keywords/${A.projectId}`, { keyword: 'new term' });
    assert.equal(r.status, 201);
    assert.deepEqual(calls.map((c) => c.device), ['desktop']);
    assert.deepEqual(r.json.data.keyword.mobile, { status: 'not_collected' });
  });

  it('another tenant cannot add a keyword to this project, and no provider request is made', async () => {
    await seedCanonical(A, [{ keyword: 'seed', ranking_urls: urls(2) }]);
    const r = await apiB('POST', `/seo/keywords/${A.projectId}`, { keyword: 'intruder' });
    assert.ok([403, 404].includes(r.status), `got ${r.status}`);
    assert.equal(calls.length, 0);
    assert.equal((await canonicalOf(A)).keywords.length, 1);
  });

  it('rejects anonymous callers', async () => {
    assert.equal((await apiAnon('POST', `/seo/keywords/${A.projectId}`, { keyword: 'x' })).status, 401);
  });
});

describe('POST /seo/keywords/:projectId/rescan', () => {
  it('rescans both devices; each device keeps its own previous scan rank', async () => {
    await seedCanonical(A, [{ keyword: 'alpha', ranking_urls: urls(8), mobile: mobileOk(11) }]);
    await oldRescan(A, 'alpha');
    provider = (device) => (device === 'desktop' ? { rank: 5 } : { rank: 9, count: 55 });

    const r = await apiA('POST', `/seo/keywords/${A.projectId}/rescan`, { keyword: 'alpha' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const kw = r.json.data.keyword;
    assert.equal(kw.current_rank, 5);
    assert.equal(kw.prev_scan_rank, 8);
    assert.equal(kw.mobile.current_rank, 9);
    assert.equal(kw.mobile.prev_scan_rank, 11);
    assert.equal(kw.mobile.status, 'ranked');
  });

  it('ROLLOUT: an existing desktop-only keyword gets its first mobile data on rescan, with desktop history and rank intact', async () => {
    await seedCanonical(A, [{ keyword: 'legacy kw', ranking_urls: urls(8) }]);
    const before = (await canonicalOf(A)).keywords[0];
    assert.equal(before.mobile, undefined);
    await oldRescan(A, 'legacy kw');
    provider = (device) => (device === 'desktop' ? { rank: 6 } : { rank: 14, count: 55 });

    const r = await apiA('POST', `/seo/keywords/${A.projectId}/rescan`, { keyword: 'legacy kw' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const kw = (await canonicalOf(A)).keywords[0];
    assert.equal(kw.current_rank, 6);
    assert.equal(kw.prev_scan_rank, 8);
    assert.equal(kw.benchmark_rank, before.benchmark_rank);
    assert.equal(kw.mobile.current_rank, 14);
    assert.equal(kw.mobile.prev_scan_rank, null, 'no fabricated previous mobile rank');
    assert.equal(kw.mobile.scan_count, 1);
    assert.equal(kw.mobile.last_scan_status, 'ok');
    assert.equal(kw.scan_count, before.scan_count + 1);
    const hist = await KeywordRankingHistory.find({ project_id: A.project._id }).lean();
    assert.equal(hist.filter((h) => h.device === 'mobile').length, 1);
    assert.equal(hist.filter((h) => h.device !== 'mobile').length, 2, 'desktop history continues (seed + rescan)');
  });

  it('ROLLOUT: first-ever mobile failure on a legacy keyword leaves desktop untouched and mobile = scan_error', async () => {
    await seedCanonical(A, [{ keyword: 'legacy kw', ranking_urls: urls(8) }]);
    await oldRescan(A, 'legacy kw');
    provider = (device) => (device === 'mobile' ? Object.assign(new Error('boom'), { response: { status: 400 } }) : { rank: 8 });
    const r = await apiA('POST', `/seo/keywords/${A.projectId}/rescan`, { keyword: 'legacy kw' });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.keyword.mobile.status, 'scan_error');
    const kw = (await canonicalOf(A)).keywords[0];
    assert.equal(kw.mobile.current_rank, null);
    assert.equal(kw.current_rank, 8);
    assert.equal((await KeywordRankingHistory.countDocuments({ project_id: A.project._id, device: 'mobile' })), 0);
  });

  it('a mobile failure keeps the last known mobile rank and still updates desktop; response is still 200', async () => {
    await seedCanonical(A, [{ keyword: 'alpha', ranking_urls: urls(8), mobile: mobileOk(11) }]);
    await oldRescan(A, 'alpha');
    provider = (device) => (device === 'mobile' ? Object.assign(new Error('boom'), { response: { status: 400 } }) : { rank: 7 });

    const r = await apiA('POST', `/seo/keywords/${A.projectId}/rescan`, { keyword: 'alpha' });
    assert.equal(r.status, 200);
    const kw = r.json.data.keyword;
    assert.equal(kw.current_rank, 7);
    assert.equal(kw.mobile.current_rank, 11);
    assert.equal(kw.mobile.status, 'scan_error');
    const stored = (await canonicalOf(A)).keywords[0];
    assert.equal(stored.mobile.current_rank, 11);
    assert.equal(stored.mobile.last_scan_status, 'error');
  });

  it('desktop failure keeps the desktop rank while mobile updates', async () => {
    await seedCanonical(A, [{ keyword: 'alpha', ranking_urls: urls(8), mobile: mobileOk(11) }]);
    await oldRescan(A, 'alpha');
    provider = (device) => (device === 'desktop' ? Object.assign(new Error('boom'), { response: { status: 400 } }) : { rank: 6, count: 55 });

    const r = await apiA('POST', `/seo/keywords/${A.projectId}/rescan`, { keyword: 'alpha' });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.keyword.current_rank, 8);
    assert.equal(r.json.data.keyword.status, 'scan_error');
    assert.equal(r.json.data.keyword.mobile.current_rank, 6);
    assert.equal(r.json.data.keyword.mobile.status, 'ranked');
  });

  it('a successful mobile scan that does not find the domain is not_ranked with the observed depth', async () => {
    await seedCanonical(A, [{ keyword: 'alpha', ranking_urls: urls(8), mobile: mobileOk(11) }]);
    await oldRescan(A, 'alpha');
    provider = (device) => (device === 'desktop' ? { rank: 8 } : { rank: null, count: 55 });
    const r = await apiA('POST', `/seo/keywords/${A.projectId}/rescan`, { keyword: 'alpha' });
    const m = r.json.data.keyword.mobile;
    assert.equal(m.status, 'not_ranked');
    assert.equal(m.current_rank, null);
    assert.equal(m.tracked_depth, 55);
  });

  it('the 30-minute per-keyword cooldown still applies and makes no provider request', async () => {
    await seedCanonical(A, [{ keyword: 'alpha', ranking_urls: urls(8), mobile: mobileOk(11) }]);
    const r = await apiA('POST', `/seo/keywords/${A.projectId}/rescan`, { keyword: 'alpha' });
    assert.equal(r.status, 429);
    assert.equal(calls.length, 0);
  });

  it('another tenant cannot rescan this project (404) and no provider request is made', async () => {
    await seedCanonical(A, [{ keyword: 'alpha', ranking_urls: urls(8) }]);
    await oldRescan(A, 'alpha');
    const r = await apiB('POST', `/seo/keywords/${A.projectId}/rescan`, { keyword: 'alpha' });
    assert.equal(r.status, 404);
    assert.equal(calls.length, 0);
  });
});

describe('GET /seo/rankings/:projectId', () => {
  it('returns legacy desktop fields unchanged plus an independent mobile object per keyword', async () => {
    await seedCanonical(A, [
      { keyword: 'both', ranking_urls: urls(8), mobile: mobileOk(11) },
      { keyword: 'legacy', ranking_urls: urls(3) },
    ]);
    const r = await apiA('GET', `/seo/rankings/${A.projectId}`);
    assert.equal(r.status, 200);
    const [doc] = r.json.data;
    const both = doc.keywords.find((k) => k.keyword === 'both');
    const legacy = doc.keywords.find((k) => k.keyword === 'legacy');
    assert.equal(both.current_rank, 8);
    assert.equal(both.mobile.current_rank, 11);
    assert.equal(both.mobile.status, 'ranked');
    assert.equal(legacy.current_rank, 3);
    assert.deepEqual(legacy.mobile, { status: 'not_collected' });
    for (const f of ['prev_week_rank', 'prev_month_rank', 'last_scan_rank', 'status', 'ranking_urls']) assert.ok(f in both, `legacy field ${f} missing`);
  });

  it('mobile previous week/month come from mobile history only', async () => {
    await seedCanonical(A, [{ keyword: 'both', ranking_urls: urls(8), mobile: mobileOk(11) }]);
    const old = new Date(Date.now() - 10 * 24 * 3600 * 1000);
    const base = { project_id: A.project._id, user_id: A.user._id, domain: DOMAIN, keyword: 'both', keyword_normalized: 'both', scanned_at: old, ranking_urls: [] };
    await KeywordRankingHistory.collection.insertMany([
      { ...base, device: 'mobile', current_rank: 15 },
      { ...base, current_rank: 4 }, // legacy row, no device => desktop
    ]);
    const kw = (await apiA('GET', `/seo/rankings/${A.projectId}`)).json.data[0].keywords[0];
    assert.equal(kw.prev_week_rank, 4);
    assert.equal(kw.mobile.prev_week_rank, 15);
  });

  it("does not expose another tenant's rankings", async () => {
    await seedCanonical(A, [{ keyword: 'secret term', ranking_urls: urls(8), mobile: mobileOk(11) }]);
    const r = await apiB('GET', `/seo/rankings/${A.projectId}`);
    assert.ok(!JSON.stringify(r.json).includes('secret term'));
  });

  it('rejects anonymous callers', async () => {
    assert.equal((await apiAnon('GET', `/seo/rankings/${A.projectId}`)).status, 401);
  });
});

describe('POST /seo/check-ranking + /seo/save-ranking (onboarding round-trip)', () => {
  it('check-ranking returns a per-device result and save-ranking persists the mobile part', async () => {
    provider = (device) => (device === 'desktop' ? { rank: 8, count: 93 } : { rank: 11, count: 55 });
    const c = await apiA('POST', '/seo/check-ranking', { domain: DOMAIN, keywords: ['one', 'two'], country: 'US', language: 'en', seoScope: 'national' });
    assert.equal(c.status, 200, JSON.stringify(c.json));
    assert.equal(calls.length, 4, '2 keywords x 2 devices');
    const [r1] = c.json.data.results;
    assert.equal(r1.best_rank, 8);
    assert.equal(r1.mobile.best_rank, 11);
    assert.equal(r1.mobile.tracked_depth, 55);

    const s = await apiA('POST', '/seo/save-ranking', {
      projectId: A.projectId, domain: DOMAIN, location: 'US', keywords: c.json.data.results,
      locationCode: c.json.data.location_code, country: 'US', language: 'en', seoScope: 'national',
    });
    assert.equal(s.status, 201, JSON.stringify(s.json));
    const kw = (await canonicalOf(A)).keywords.find((k) => k.keyword === 'one');
    assert.equal(kw.current_rank, 8);
    assert.equal(kw.mobile.current_rank, 11);
    assert.equal(kw.mobile.last_scan_status, 'ok');
  });

  it('a mobile failure in check-ranking is carried as scan_error through save-ranking, not stored as "not ranked"', async () => {
    provider = (device) => (device === 'mobile' ? Object.assign(new Error('boom'), { response: { status: 400 } }) : { rank: 8 });
    const c = await apiA('POST', '/seo/check-ranking', { domain: DOMAIN, keywords: ['one'], country: 'US', language: 'en', seoScope: 'national' });
    assert.ok(c.json.data.results[0].mobile.scan_error);
    await apiA('POST', '/seo/save-ranking', {
      projectId: A.projectId, domain: DOMAIN, location: 'US', keywords: c.json.data.results,
      locationCode: c.json.data.location_code, country: 'US', language: 'en', seoScope: 'national',
    });
    const kw = (await canonicalOf(A)).keywords[0];
    assert.equal(kw.mobile.last_scan_status, 'error');
    assert.equal(kw.mobile.current_rank, null);
  });

  it('save-ranking succeeds and keeps everything when a keyword has a Maps rank above 20 (archive + canonical + history)', async () => {
    const s = await apiA('POST', '/seo/save-ranking', {
      projectId: A.projectId, domain: DOMAIN, location: 'US', locationCode: 2840, country: 'US', language: 'en', seoScope: 'local',
      keywords: [{ keyword: 'far maps', ranking_urls: [], maps_rank: 23, maps_listing: { title: 'Biz' }, mobile: { ranking_urls: [], tracked_depth: 55, scan_error: null } }],
    });
    assert.equal(s.status, 201, JSON.stringify(s.json));
    assert.equal((await SeoRanking.findOne({ project_id: A.project._id }).lean()).keywords[0].maps_rank, 23);
    const kw = (await canonicalOf(A)).keywords[0];
    assert.equal(kw.maps_rank, 23);
    assert.equal(kw.mobile.last_scan_status, 'ok');
    assert.equal(await KeywordRankingHistory.countDocuments({ project_id: A.project._id, device: 'desktop' }), 1);
  });

  it('add keyword with a Maps rank above 20 writes the desktop history row', async () => {
    await seedCanonical(A, [{ keyword: 'seed', ranking_urls: urls(2) }]);
    provider = () => ({ rank: null, count: 90 });
    mock.method(MapsRankingService, 'fetchMapsRank', async () => ({ maps_rank: 23, maps_listing: { title: 'Biz', rating: 4.8, reviews: 196, address: 'x' } }));
    await mongoose.model('SeoProject').updateOne({ _id: A.project._id }, { $set: { 'verified_business.name': 'Biz' } });
    await SeoRankingCurrent.updateOne({ project_id: A.project._id }, { $set: { seo_scope: 'local' } });

    const r = await apiA('POST', `/seo/keywords/${A.projectId}`, { keyword: 'maps far' });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.data.keyword.maps_rank, 23);
    const rows = await KeywordRankingHistory.find({ project_id: A.project._id, keyword_normalized: 'maps far', device: { $ne: 'mobile' } }).lean();
    assert.equal(rows.length, 1, 'history row dropped');
    assert.equal(rows[0].maps_rank, 23);
  });

  it("save-ranking cannot overwrite or take over another tenant's project ranking document", async () => {
    await seedCanonical(A, [{ keyword: 'alpha', ranking_urls: urls(8), mobile: mobileOk(11) }]);
    const r = await apiB('POST', '/seo/save-ranking', {
      projectId: A.projectId, domain: 'attacker.example', location: 'US',
      keywords: [{ keyword: 'pwned', ranking_urls: [], maps_rank: null }], locationCode: 2840, country: 'US', language: 'en', seoScope: 'national',
    });
    const doc = await canonicalOf(A);
    assert.equal(String(doc.user_id), A.userId, `ownership changed (HTTP ${r.status})`);
    assert.deepEqual(doc.keywords.map((k) => k.keyword), ['alpha']);
    assert.ok([403, 404].includes(r.status), `expected 403/404, got ${r.status}`);
  });
});

describe('/keywords/rankings/* (legacy ranking-check path)', () => {
  it('check scans both devices and archives mobile_rank / scan failure distinctly', async () => {
    await User.updateOne({ _id: A.user._id }, { $set: { 'subscription.status': 'active', 'subscription.plan': 'premium' } });
    await SeoRankingCurrent.deleteMany({ project_id: A.project._id });
    await mongoose.model('SeoProject').updateOne({ _id: A.project._id }, { $set: { country: 'US', seo_scope: 'national' } });
    provider = (device, kw) => (device === 'mobile' ? (kw === 'bad' ? Object.assign(new Error('boom'), { response: { status: 400 } }) : { rank: 12, count: 55 }) : { rank: 5 });

    const r = await apiA('POST', '/keywords/rankings/check', { userId: A.userId, projectId: A.projectId, domain: DOMAIN, keywords: ['good', 'bad'] });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const doc = await SeoRanking.findOne({ project_id: A.project._id }).lean();
    const good = doc.keywords.find((k) => k.keyword === 'good');
    const bad = doc.keywords.find((k) => k.keyword === 'bad');
    assert.equal(good.rank, 5); assert.equal(good.mobile_rank, 12); assert.equal(good.mobile_status, 'ok');
    assert.equal(bad.rank, 5); assert.equal(bad.mobile_rank, null); assert.equal(bad.mobile_status, 'error');
  });

  it("check refuses to scan another tenant's project and makes no provider request", async () => {
    const r = await apiB('POST', '/keywords/rankings/check', { userId: A.userId, projectId: A.projectId, domain: DOMAIN, keywords: ['x'] });
    assert.ok([401, 403, 404].includes(r.status), `expected 401/403/404, got ${r.status}`);
    assert.equal(calls.length, 0, 'a billed scan ran for a project the caller does not own');
  });

  it("summary/history/project reads refuse another tenant's project", async () => {
    await SeoRanking.create({ project_id: A.project._id, user_id: A.user._id, domain: DOMAIN, keywords: [{ keyword: 'secret term', rank: 3 }] });
    for (const path of ['summary', 'history', 'project']) {
      const r = await apiB('GET', `/keywords/rankings/${path}/${A.projectId}`);
      assert.ok(!JSON.stringify(r.json).includes('secret term'), `${path} leaked another tenant's data (HTTP ${r.status})`);
      assert.ok([401, 403, 404].includes(r.status), `${path}: expected 401/403/404, got ${r.status}`);
    }
  });

  it('test endpoint caps the number of keywords so a single call cannot trigger an unbounded billed scan', async () => {
    const r = await apiA('POST', '/keywords/rankings/test', { domain: DOMAIN, keywords: Array.from({ length: 100 }, (_, i) => `kw${i}`) });
    assert.equal(r.status, 400, `got ${r.status}`);
    assert.equal(calls.length, 0);
  });

  it('rejects anonymous callers', async () => {
    assert.equal((await apiAnon('POST', '/keywords/rankings/test', { domain: DOMAIN, keywords: ['a'] })).status, 401);
  });
});

describe('POST /seo/keywords/:projectId — project with no ranking document yet (bootstrap)', () => {
  const setProject = (tenant, fields) => mongoose.model('SeoProject').updateOne({ _id: tenant.project._id }, { $set: fields });
  const activate = (tenant) => User.updateOne({ _id: tenant.user._id }, { $set: { 'subscription.status': 'active', 'subscription.plan': 'premium' } });

  it('creates the ranking document from the saved project location, then tracks the keyword (desktop + mobile)', async () => {
    await activate(A);
    await setProject(A, { country: 'US', seo_scope: 'national', language: 'en' });
    assert.equal(await canonicalOf(A), null);
    provider = (device) => (device === 'desktop' ? { rank: 8 } : { rank: 11, count: 55 });

    const r = await apiA('POST', `/seo/keywords/${A.projectId}`, { keyword: 'first keyword' });
    assert.equal(r.status, 201, JSON.stringify(r.json));

    const doc = await canonicalOf(A);
    assert.equal(String(doc.user_id), A.userId);
    assert.equal(doc.location_code, 2840);
    assert.equal(doc.country, 'US');
    assert.equal(doc.seo_scope, 'national');
    assert.equal(doc.domain, `https://${DOMAIN}/`);
    assert.equal(doc.keywords.length, 1);
    assert.equal(doc.keywords[0].current_rank, 8);
    assert.equal(doc.keywords[0].mobile.current_rank, 11);
    assert.equal(r.json.data.usage.used, 1);
    assert.deepEqual(calls.map((c) => c.location_code), [2840, 2840], 'both devices use the project location');

    // and it shows up on the rankings page request
    const g = await apiA('GET', `/seo/rankings/${A.projectId}`);
    assert.equal(g.json.data[0].keywords[0].keyword, 'first keyword');
    assert.equal(g.json.data[0].location_code, 2840);
  });

  it('a project whose location cannot be determined gets a clear 422 and no billed request', async () => {
    await activate(A);
    await setProject(A, { country: null, seo_scope: 'national' });
    const r = await apiA('POST', `/seo/keywords/${A.projectId}`, { keyword: 'some keyword' });
    assert.equal(r.status, 422, JSON.stringify(r.json));
    assert.equal(r.json.code, 'LOCATION_UNRESOLVED');
    assert.equal(calls.length, 0);
    assert.equal(await canonicalOf(A), null, 'no half-created document');
  });

  it("never creates a document or scans for a project the caller does not own", async () => {
    await activate(B);
    await setProject(A, { country: 'US', seo_scope: 'national' });
    const r = await apiB('POST', `/seo/keywords/${A.projectId}`, { keyword: 'intruder' });
    assert.equal(r.status, 404);
    assert.equal(calls.length, 0);
    assert.equal(await canonicalOf(A), null);
  });

  it('rejects a soft-deleted project', async () => {
    await activate(A);
    await setProject(A, { country: 'US', seo_scope: 'national', is_deleted: true });
    try {
      const r = await apiA('POST', `/seo/keywords/${A.projectId}`, { keyword: 'some keyword' });
      assert.equal(r.status, 404);
      assert.equal(calls.length, 0);
    } finally { await setProject(A, { is_deleted: false }); }
  });

  it('two simultaneous first adds create exactly one document and keep both keywords', async () => {
    await activate(A);
    await setProject(A, { country: 'US', seo_scope: 'national' });
    const [r1, r2] = await Promise.all([
      apiA('POST', `/seo/keywords/${A.projectId}`, { keyword: 'kw one' }),
      apiA('POST', `/seo/keywords/${A.projectId}`, { keyword: 'kw two' }),
    ]);
    assert.deepEqual([r1.status, r2.status], [201, 201], JSON.stringify([r1.json, r2.json]));
    assert.equal(await SeoRankingCurrent.countDocuments({ project_id: A.project._id }), 1);
    assert.deepEqual((await canonicalOf(A)).keywords.map((k) => k.keyword).sort(), ['kw one', 'kw two']);
  });

  it('an existing document is left exactly as it was (bootstrap only runs when none exists)', async () => {
    await activate(A);
    await setProject(A, { country: 'IN', seo_scope: 'national' }); // differs from the seeded doc on purpose
    await seedCanonical(A, [{ keyword: 'seed', ranking_urls: urls(2) }]);
    const before = await canonicalOf(A);
    const r = await apiA('POST', `/seo/keywords/${A.projectId}`, { keyword: 'second' });
    assert.equal(r.status, 201);
    const after = await canonicalOf(A);
    assert.equal(after.location_code, before.location_code);
    assert.equal(after.country, before.country);
    assert.equal(after.keywords.length, 2);
  });
});
