import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import mongoose from 'mongoose';

/**
 * Tracked keyword details (GET /api/seo/keywords/:projectId/:keywordId/details).
 *
 * The pure parts (provider request / parser) always run. The rest runs against a REAL throwaway MongoDB named in
 * KEYWORD_DETAILS_TEST_MONGO_URI (localhost only - these tests write and drop data; never MONGO_URI). The provider is a fake FUNCTION: no
 * network, no money. Every state a request causes is read back through the real router, auth middleware and database.
 */

const URI = process.env.KEYWORD_DETAILS_TEST_MONGO_URI;
if (!URI && process.env.KEYWORD_DETAILS_REQUIRE_DB_TESTS === '1') throw new Error('KEYWORD_DETAILS_REQUIRE_DB_TESTS=1 but KEYWORD_DETAILS_TEST_MONGO_URI is not set.');
const SKIP = URI ? false : 'set KEYWORD_DETAILS_TEST_MONGO_URI to a local throwaway MongoDB to run the database tests';
if (URI) {
  const host = /^mongodb:\/\/(\[[^\]]+\]|[^/@,?:]+)(?::\d+)?\//.exec(URI)?.[1];
  if (!host || !['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new Error('KEYWORD_DETAILS_TEST_MONGO_URI must point at localhost.');
}
process.env.JWT_SECRET ||= 'keyword-details-test-secret';
// A fake transport is installed, so these only make `hasCredentials()` true; nothing is ever sent.
process.env.DATAFORSEO_LOGIN ||= 'test-login';
process.env.DATAFORSEO_PASSWORD ||= 'test-password';

const providerModule = await import('../service/keywordOverviewProvider.js');
const { parseKeywordOverview, buildKeywordOverviewRequest } = providerModule;

const FULL_ITEM = {
  keyword: 'best eye center near me',
  keyword_info: {
    search_volume: 1900, cpc: 1.25, competition: 0.3, competition_level: 'LOW', low_top_of_page_bid: 0.4, high_top_of_page_bid: 2.1,
    monthly_searches: [{ year: 2026, month: 9, search_volume: 1600 }, { year: 2026, month: 8, search_volume: 1900 }, { year: 2026, month: 7, search_volume: null }],
  },
  keyword_properties: { keyword_difficulty: 42 },
  search_intent_info: { main_intent: 'commercial' },
  serp_info: { serp_item_types: ['organic', 'local_pack', 'people_also_ask'], check_url: 'https://www.google.com/search?q=best+eye+center+near+me' },
};

describe('keyword_overview request and parser', () => {
  test('the request asks for one keyword in the project market, with SERP info', () => {
    assert.deepEqual(buildKeywordOverviewRequest({ keyword: 'a b', market: { location_name: 'India', language_name: 'English' } }), {
      keywords: ['a b'], location_name: 'India', language_name: 'English', include_serp_info: true,
    });
  });

  test('every figure is read; a month without a figure keeps its place as null', () => {
    const p = parseKeywordOverview({ items: [FULL_ITEM] });
    assert.equal(p.found, true);
    assert.equal(p.search_volume, 1900);
    assert.equal(p.keyword_difficulty, 42);
    assert.equal(p.intent, 'commercial');
    assert.equal(p.cpc, 1.25);
    assert.equal(p.competition_level, 'LOW');
    assert.equal(p.low_top_of_page_bid, 0.4);
    assert.equal(p.high_top_of_page_bid, 2.1);
    assert.deepEqual(p.serp_features, ['organic', 'local_pack', 'people_also_ask']);
    assert.deepEqual(p.monthly_searches.map((m) => m.search_volume), [1600, 1900, null]);
  });

  test('no items, or an item with no keyword_info, is "not found" - never a volume of 0', () => {
    assert.deepEqual(parseKeywordOverview({ items: [] }), { found: false });
    assert.deepEqual(parseKeywordOverview({ items: null }), { found: false });
    assert.deepEqual(parseKeywordOverview(null), { found: false });
    assert.deepEqual(parseKeywordOverview({ items: [{ keyword: 'x', keyword_info: null }] }), { found: false });
  });

  test('missing parts become null, not 0 or empty strings', () => {
    const p = parseKeywordOverview({ items: [{ keyword_info: { search_volume: 10, cpc: null, competition_level: '' } }] });
    assert.equal(p.search_volume, 10);
    assert.equal(p.cpc, null);
    assert.equal(p.competition_level, null);
    assert.equal(p.keyword_difficulty, null);
    assert.equal(p.intent, null);
    assert.deepEqual(p.monthly_searches, []);
    assert.deepEqual(p.serp_features, []);
  });
});

const oid = () => new mongoose.Types.ObjectId();
const DB_NAME = `odito_kw_details_test_${Date.now()}_${process.pid}`;
let svc; let User; let SeoProject; let SeoRankingCurrent; let History; let CacheEntry; let signAuthToken; let DataForSeoApiError; let budget; let server; let base;
let calls = [];
let providerBehavior;

const DAY = 24 * 3600 * 1000;
const ago = (days) => new Date(Date.now() - days * DAY);

async function seed({ keyword = {}, mobile, location = 'Mumbai, Maharashtra, India' } = {}) {
  const userId = oid(); const projectId = oid(); const keywordId = oid();
  await User.collection.insertOne({ _id: userId, firstName: 'T', lastName: 'U', email: `${userId}@example.test`, isActive: true, roleId: 2 });
  await SeoProject.collection.insertOne({ _id: projectId, user_id: userId, main_url: 'https://www.own-site.com/', country: 'IN', language: 'en', is_deleted: false });
  await SeoRankingCurrent.collection.insertOne({
    _id: oid(), project_id: projectId, user_id: userId, domain: 'own-site.com', location, country: 'IN', language: 'en', last_scanned_at: ago(1),
    keywords: [{
      _id: keywordId, keyword: 'Best Eye Center near me', current_rank: 7, best_rank: 4, benchmark_rank: 12, prev_scan_rank: 9, scan_count: 3,
      last_scan_status: 'ok', last_rescanned_at: ago(1), ranking_urls: [{ rank: 7, url: 'https://own-site.com/eye', type: 'internal_page' }, { rank: 30, url: 'https://own-site.com/', type: 'homepage' }],
      maps_rank: 3, maps_listing: { title: 'Own Site Eye Care', rating: 4.6, reviews: 120, address: '1 Main Rd' },
      ...(mobile ? { mobile } : {}),
      ...keyword,
    }],
  });
  return { userId, projectId, keywordId, token: signAuthToken({ _id: userId, roleId: 2 }) };
}
async function details(s, { projectId = s.projectId, keywordId = s.keywordId, token = s.token } = {}) {
  const res = await fetch(`${base}/keywords/${projectId}/${keywordId}/details`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const hist = (s, rows) => History.collection.insertMany(rows.map((r) => ({
  _id: oid(), project_id: s.projectId, user_id: s.userId, domain: 'own-site.com', keyword: 'Best Eye Center near me', keyword_normalized: 'best eye center near me',
  scan_source: 'manual_rescan', ranking_urls: [], ...r,
})));

describe('tracked keyword details (real MongoDB)', { skip: SKIP }, () => {
  before(async () => {
    await mongoose.connect(URI, { dbName: DB_NAME, autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 5000 });
    svc = await import('../service/trackedKeywordDetailsService.js');
    ({ default: User } = await import('../../user/model/User.js'));
    ({ default: SeoProject } = await import('../../app_user/model/SeoProject.js'));
    ({ default: SeoRankingCurrent } = await import('../../app_user/model/SeoRankingCurrent.js'));
    ({ default: History } = await import('../../app_user/model/KeywordRankingHistory.js'));
    ({ default: CacheEntry } = await import('../../dataforseo-api/shared/DataForSeoCacheEntry.js'));
    ({ signAuthToken } = await import('../../user/service/tokenService.js'));
    ({ DataForSeoApiError } = await import('../../dataforseo-api/shared/providerErrors.js'));
    budget = await import('../../dataforseo-api/domain_overview/service/providerBudget.js');
    const { default: routes } = await import('../../app_user/routes/seoOnboardingRoutes.js');
    const app = express(); app.use(express.json()); app.use('/api/seo', routes);
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}/api/seo`;
  });
  after(async () => {
    providerModule.__setKeywordOverviewTransportForTests(null);
    await new Promise((r) => (server ? server.close(r) : r()));
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    for (const c of [User, SeoProject, SeoRankingCurrent, History, CacheEntry]) await c.collection.deleteMany({});
    budget.__resetProviderBudgetForTests();
    calls = [];
    providerBehavior = () => ({ status_code: 20000, cost: 0.0101, tasks: [{ status_code: 20000, cost: 0.0101, result: [{ items: [FULL_ITEM] }] }] });
    providerModule.__setKeywordOverviewTransportForTests(async (body) => { calls.push(body); return providerBehavior(body); });
  });

  describe('authorization', () => {
    test('no token is 401; a malformed id is 400', async () => {
      const s = await seed();
      assert.equal((await details(s, { token: null })).status, 401);
      assert.equal((await details(s, { keywordId: 'nope' })).status, 400);
      assert.equal((await details(s, { projectId: 'nope' })).status, 400);
    });

    test("another user's project and a keyword from another project are both 404, and the provider is never called", async () => {
      const mine = await seed(); const theirs = await seed();
      assert.equal((await details(mine, { projectId: theirs.projectId, keywordId: theirs.keywordId })).status, 404);
      assert.equal((await details(mine, { projectId: mine.projectId, keywordId: theirs.keywordId })).status, 404);
      assert.equal((await details(mine, { keywordId: oid() })).status, 404);
      assert.equal(calls.length, 0);
    });

    test('a keyword of the same user in a different project is 404', async () => {
      const a = await seed();
      const otherProject = oid();
      await SeoProject.collection.insertOne({ _id: otherProject, user_id: a.userId, main_url: 'https://other.com', is_deleted: false });
      assert.equal((await details(a, { projectId: otherProject })).status, 404);
    });
  });

  describe('the answer', () => {
    test('overview, rankings, SERP features and the market come from the stored data and the one provider call', async () => {
      const s = await seed();
      const { status, body } = await details(s);
      assert.equal(status, 200);
      const d = body.data;
      assert.equal(d.keyword, 'Best Eye Center near me');
      assert.equal(d.overview.searchVolume, 1900);
      assert.equal(d.overview.keywordDifficulty, 42);
      assert.equal(d.overview.searchIntent, 'commercial');
      assert.equal(d.overview.lowTopOfPageBid, 0.4);
      assert.equal(d.rankings.desktop.status, 'ranked');
      assert.equal(d.rankings.desktop.position, 7);
      assert.equal(d.rankings.desktop.bestPosition, 4);
      assert.equal(d.rankings.desktop.previousPosition, 9);
      assert.equal(d.rankings.desktop.rankingUrl, 'https://own-site.com/eye');
      assert.equal(d.rankings.maps.position, 3);
      assert.deepEqual(d.serpFeatures, ['organic', 'local_pack', 'people_also_ask']);
      assert.deepEqual(d.metadata.market, { location: 'India', language: 'English' });
      assert.equal(d.metadata.dataAvailability.keywordMetrics, 'ok');
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].keywords, ['best eye center near me']);
      assert.equal(JSON.stringify(body).includes('test-password'), false);
    });

    test('a second request (and a second user in the same market) is answered from the cache: no second provider call', async () => {
      const s = await seed();
      assert.equal((await details(s)).body.data.metadata.metricsCached, false);
      const again = await details(s);
      assert.equal(again.body.data.metadata.metricsCached, true);
      assert.equal(again.body.data.overview.searchVolume, 1900);
      const other = await seed();
      assert.equal((await details(other)).body.data.overview.searchVolume, 1900);
      assert.equal(calls.length, 1);
    });

    test('concurrent expands share ONE provider call', async () => {
      const s = await seed();
      providerModule.__setKeywordOverviewTransportForTests(async (body) => { calls.push(body); await new Promise((r) => setTimeout(r, 60)); return providerBehavior(body); });
      const rs = await Promise.all([details(s), details(s), details(s)]);
      assert.deepEqual(rs.map((r) => r.status), [200, 200, 200]);
      assert.equal(calls.length, 1);
    });

    test('rank history: oldest first, per device, only inside the window; a null position is "not found", never 0', async () => {
      const s = await seed({ mobile: { current_rank: 11, last_scan_status: 'ok', last_scanned_at: ago(1), scan_count: 1, tracked_depth: 100 } });
      await hist(s, [
        { scanned_at: ago(10), current_rank: 9 },
        { scanned_at: ago(3), current_rank: null },
        { scanned_at: ago(400), current_rank: 2 },
        { scanned_at: ago(2), current_rank: 12, device: 'mobile' },
      ]);
      const d = (await details(s)).body.data;
      assert.deepEqual(d.history.desktop.map((p) => p.position), [9, null]);
      assert.ok(new Date(d.history.desktop[0].at) < new Date(d.history.desktop[1].at));
      assert.deepEqual(d.history.mobile.map((p) => p.position), [12]);
      assert.equal(d.rankings.desktop.prevWeekPosition, 9);
    });

    test('history is capped at HISTORY_MAX_POINTS (the newest ones)', async () => {
      const s = await seed();
      await hist(s, Array.from({ length: svc.HISTORY_MAX_POINTS + 15 }, (_, i) => ({ scanned_at: new Date(Date.now() - (i + 1) * 3600 * 1000), current_rank: (i % 50) + 1 })));
      const d = (await details(s)).body.data;
      assert.equal(d.history.desktop.length, svc.HISTORY_MAX_POINTS);
    });
  });

  describe('rank states are never confused', () => {
    test('desktop not ranked: null position + how deep it looked; mobile never scanned: not_collected with no position', async () => {
      const s = await seed({ keyword: { current_rank: null, best_rank: null, prev_scan_rank: null, ranking_urls: [] } });
      const d = (await details(s)).body.data;
      assert.equal(d.rankings.desktop.status, 'not_ranked');
      assert.equal(d.rankings.desktop.position, null);
      assert.equal(d.rankings.desktop.trackedDepth, 100);
      assert.equal(d.rankings.desktop.rankingUrl, null);
      assert.equal(d.rankings.mobile.status, 'not_collected');
      assert.equal(d.rankings.mobile.position, null);
      assert.equal(d.rankings.mobile.trackedDepth, null);
      assert.equal(d.history.mobile.length, 0);
    });

    test('a failed last scan is scan_error and keeps the last good position, with its (sanitized) message', async () => {
      const s = await seed({ keyword: { last_scan_status: 'error', last_scan_error: 'Ranking check timed out. Please try again.' } });
      const d = (await details(s)).body.data;
      assert.equal(d.rankings.desktop.status, 'scan_error');
      assert.equal(d.rankings.desktop.position, 7);
      assert.equal(d.rankings.desktop.scanError, 'Ranking check timed out. Please try again.');
    });

    test('mobile ranked on its own, independent of desktop; mobile not found carries its own depth', async () => {
      const ranked = (await details(await seed({ mobile: { current_rank: 5, best_rank: 3, last_scan_status: 'ok', last_scanned_at: ago(1), scan_count: 2, tracked_depth: 100, ranking_urls: [{ rank: 5, url: 'https://own-site.com/m', type: 'internal_page' }] } }))).body.data;
      assert.equal(ranked.rankings.mobile.status, 'ranked');
      assert.equal(ranked.rankings.mobile.position, 5);
      assert.equal(ranked.rankings.mobile.rankingUrl, 'https://own-site.com/m');
      assert.equal(ranked.rankings.desktop.position, 7);
      const notFound = (await details(await seed({ mobile: { current_rank: null, last_scan_status: 'ok', last_scanned_at: ago(1), scan_count: 1, tracked_depth: 50 } }))).body.data;
      assert.equal(notFound.rankings.mobile.status, 'not_ranked');
      assert.equal(notFound.rankings.mobile.position, null);
      assert.equal(notFound.rankings.mobile.trackedDepth, 50);
    });

    test('a keyword with no scan at all is not_collected, not "not ranked"', async () => {
      const s = await seed({ keyword: { current_rank: null, best_rank: null, scan_count: 0, last_rescanned_at: null, last_scan_status: undefined, ranking_urls: [], maps_rank: null, maps_listing: null } });
      const d = (await details(s)).body.data;
      assert.equal(d.rankings.desktop.status, 'not_collected');
      assert.equal(d.rankings.maps.position, null);
      assert.equal(d.rankings.maps.listing, null);
      assert.equal(d.serpFeatures.includes('local_pack'), true, 'FULL_ITEM carries local_pack from the provider');
    });
  });

  describe('optional data never blocks the answer', () => {
    test('provider failure: ranking data is still returned, metrics are null and the section says why', async () => {
      const s = await seed();
      providerBehavior = () => { throw new DataForSeoApiError('PROVIDER_TIMEOUT'); };
      const { status, body } = await details(s);
      assert.equal(status, 200);
      const d = body.data;
      assert.equal(d.rankings.desktop.position, 7);
      assert.equal(d.overview.searchVolume, null);
      assert.equal(d.overview.keywordDifficulty, null);
      assert.deepEqual(d.history.volume, []);
      assert.equal(d.metadata.dataAvailability.keywordMetrics, 'error');
      assert.equal(d.metadata.dataAvailability.volumeHistory, 'error');
      assert.equal(d.serpFeatures.includes('local_pack'), true, 'our own Maps listing still shows the local pack');
      assert.equal(await CacheEntry.countDocuments(), 0, 'a failure is never cached');
    });

    test('the provider has no data for the keyword: no_data (null, not 0), and that answer is cached', async () => {
      const s = await seed();
      providerBehavior = () => ({ status_code: 20000, cost: 0.0101, tasks: [{ status_code: 20000, cost: 0.0101, result: [{ items: [] }] }] });
      const d = (await details(s)).body.data;
      assert.equal(d.overview.searchVolume, null);
      assert.equal(d.metadata.dataAvailability.keywordMetrics, 'no_data');
      await details(s);
      assert.equal(calls.length, 1);
    });

    test('monthly volume with every month empty is no_data for the chart', async () => {
      const s = await seed();
      providerBehavior = () => ({ status_code: 20000, tasks: [{ status_code: 20000, result: [{ items: [{ keyword_info: { search_volume: 50, monthly_searches: [{ year: 2026, month: 9, search_volume: null }] } }] }] }] });
      const d = (await details(s)).body.data;
      assert.equal(d.overview.searchVolume, 50);
      assert.equal(d.metadata.dataAvailability.volumeHistory, 'no_data');
    });

    test('credentials missing: not_configured, still 200, no provider call', async () => {
      const s = await seed();
      const saved = [process.env.DATAFORSEO_LOGIN, process.env.DATAFORSEO_PASSWORD];
      delete process.env.DATAFORSEO_LOGIN; delete process.env.DATAFORSEO_PASSWORD;
      try {
        const { status, body } = await details(s);
        assert.equal(status, 200);
        assert.equal(body.data.metadata.dataAvailability.keywordMetrics, 'not_configured');
        assert.equal(calls.length, 0);
      } finally { [process.env.DATAFORSEO_LOGIN, process.env.DATAFORSEO_PASSWORD] = saved; }
    });

    test('the per-user budget caps REAL calls only: past it the metrics say rate_limited, cached keywords still answer', async () => {
      const s = await seed();
      const { KEYWORD_OVERVIEW } = svc;
      budget.takeProviderCalls(String(s.userId), KEYWORD_OVERVIEW.budget.maxProviderCalls, KEYWORD_OVERVIEW.budget);
      const d = (await details(s)).body.data;
      assert.equal(d.metadata.dataAvailability.keywordMetrics, 'rate_limited');
      assert.equal(d.rankings.desktop.position, 7);
      assert.equal(calls.length, 0);
    });
  });

  describe('backlinks come from data already cached, never from a purchase', () => {
    const rankedEntry = (items) => CacheEntry.collection.insertOne({
      key: 'labs/ranked_keywords/v2|own-site.com|india|english|limit:1000', endpoint: 'labs/ranked_keywords/v2', target: 'own-site.com', location: 'India', language: 'English',
      variant: 'x', payload: { totalCount: items.length, metrics: null, items }, cost: null, fetchedAt: new Date(), expiresAt: new Date(Date.now() + DAY),
    });

    test('found in a cached Organic Keywords response: the ranking page referring domains and backlinks', async () => {
      const s = await seed();
      await rankedEntry([{ keyword: 'something else', referring_domains: 1, backlinks: 1 }, { keyword: 'best eye center near me', referring_domains: 77, backlinks: 1234, url: 'https://own-site.com/eye' }]);
      const d = (await details(s)).body.data;
      assert.equal(d.backlinks.referringDomains, 77);
      assert.equal(d.backlinks.totalBacklinks, 1234);
      assert.equal(d.metadata.dataAvailability.backlinks, 'ok');
    });

    test('not cached anywhere: unavailable (null), and no backlinks call is made', async () => {
      const s = await seed();
      const d = (await details(s)).body.data;
      assert.equal(d.backlinks.referringDomains, null);
      assert.equal(d.backlinks.totalBacklinks, null);
      assert.equal(d.metadata.dataAvailability.backlinks, 'unavailable');
      assert.equal(calls.length, 1, 'only the keyword overview call');
    });

    test('an expired entry or another project domain is never used', async () => {
      const s = await seed();
      await CacheEntry.collection.insertOne({ key: 'labs/ranked_keywords/v2|own-site.com|india|english|old', endpoint: 'labs/ranked_keywords/v2', target: 'own-site.com', location: 'India', language: 'English', variant: 'old', payload: { items: [{ keyword: 'best eye center near me', referring_domains: 5, backlinks: 5 }] }, fetchedAt: ago(9), expiresAt: ago(1) });
      await CacheEntry.collection.insertOne({ key: 'labs/ranked_keywords/v2|rival.com|india|english|x', endpoint: 'labs/ranked_keywords/v2', target: 'rival.com', location: 'India', language: 'English', variant: 'x', payload: { items: [{ keyword: 'best eye center near me', referring_domains: 9, backlinks: 9 }] }, fetchedAt: new Date(), expiresAt: new Date(Date.now() + DAY) });
      const d = (await details(s)).body.data;
      assert.equal(d.backlinks.referringDomains, null);
    });
  });
});

describe('tracked location follows the saved business location (real MongoDB)', { skip: SKIP }, () => {
  let sync; let oidFn = () => new mongoose.Types.ObjectId();
  before(async () => {
    await mongoose.connect(URI, { dbName: `${DB_NAME}_sync`, autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 5000 });
    sync = await import('../service/trackedLocationSync.js');
    ({ default: SeoProject } = await import('../../app_user/model/SeoProject.js'));
    ({ default: SeoRankingCurrent } = await import('../../app_user/model/SeoRankingCurrent.js'));
  });
  after(async () => { if (mongoose.connection.readyState === 1) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); } });
  async function seedSync({ scope = 'local', address = 'Parel East, Mumbai, Maharashtra 400012, India', canonical = true } = {}) {
    const userId = oidFn(); const projectId = oidFn();
    await SeoProject.collection.insertOne({ _id: projectId, user_id: userId, main_url: 'https://x.com', country: 'IN', seo_scope: scope, verified_business: address ? { address, city: 'Mumbai' } : {}, is_deleted: false });
    if (canonical) await SeoRankingCurrent.collection.insertOne({ project_id: projectId, user_id: userId, domain: 'x.com', location: 'mumbai', location_code: 1007770, country: null, keywords: [] });
    return { userId, projectId };
  }
  const doc = (s) => SeoRankingCurrent.collection.findOne({ project_id: s.projectId });

  test('updates location, location_code and country, and says it changed', async () => {
    const s = await seedSync();
    const r = await sync.syncTrackedLocation(s.projectId, s.userId, { resolve: async () => ({ locationCode: 9040178, resolvedCountry: 'in' }) });
    assert.deepEqual([r.synced, r.changed], [true, true]);
    const d = await doc(s);
    assert.equal(d.location, 'Parel East, Mumbai, Maharashtra 400012, India');
    assert.equal(d.location_code, 9040178);
    assert.equal(d.country, 'IN');
  });
  test('the same location again changes nothing', async () => {
    const s = await seedSync();
    const resolve = async () => ({ locationCode: 9040178, resolvedCountry: 'IN' });
    await sync.syncTrackedLocation(s.projectId, s.userId, { resolve });
    assert.equal((await sync.syncTrackedLocation(s.projectId, s.userId, { resolve })).changed, false);
  });
  test('an unresolvable location leaves the tracked location exactly as it was', async () => {
    const s = await seedSync();
    const r = await sync.syncTrackedLocation(s.projectId, s.userId, { resolve: async () => { throw new Error('lookup down'); } });
    assert.deepEqual([r.synced, r.reason], [false, 'LOCATION_UNRESOLVED']);
    const d = await doc(s);
    assert.deepEqual([d.location, d.location_code], ['mumbai', 1007770]);
  });
  test('national projects, projects without tracked keywords and other users are not touched', async () => {
    const resolve = async () => ({ locationCode: 1, resolvedCountry: 'IN' });
    const nat = await seedSync({ scope: 'national' });
    assert.equal((await sync.syncTrackedLocation(nat.projectId, nat.userId, { resolve })).reason, 'NOT_LOCAL_SCOPE');
    const none = await seedSync({ canonical: false });
    assert.equal((await sync.syncTrackedLocation(none.projectId, none.userId, { resolve })).reason, 'NO_TRACKED_KEYWORDS');
    const mine = await seedSync();
    assert.equal((await sync.syncTrackedLocation(mine.projectId, oidFn(), { resolve })).reason, 'PROJECT_NOT_FOUND');
    assert.equal((await doc(mine)).location_code, 1007770);
  });
});
