import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import mongoose from 'mongoose';

/**
 * Local Competitors against a REAL MongoDB (local throwaway server in COMPETITORS_TEST_MONGO_URI, never MONGO_URI; own database, dropped
 * at the end). Google is a fake FUNCTION: no network, no money. The budget, the "already added" lookup, the project's own data and the
 * routes run for real.
 */

const URI = process.env.COMPETITORS_TEST_MONGO_URI;
if (!URI && process.env.COMPETITORS_REQUIRE_DB_TESTS === '1') throw new Error('COMPETITORS_REQUIRE_DB_TESTS=1 but COMPETITORS_TEST_MONGO_URI is not set: the database tests would be skipped.');
const SKIP = URI ? false : 'set COMPETITORS_TEST_MONGO_URI to a local throwaway MongoDB to run the database tests';
if (URI) {
  const host = /^mongodb:\/\/(\[[^\]]+\]|[^/@,?:]+)(?::\d+)?\//.exec(URI)?.[1];
  const approved = process.env.COMPETITORS_TEST_MONGO_APPROVED_HOST;
  if (!host || !(['127.0.0.1', 'localhost', '[::1]'].includes(host) || (approved && host === approved))) {
    throw new Error('COMPETITORS_TEST_MONGO_URI must point at localhost (or exactly the host named in COMPETITORS_TEST_MONGO_APPROVED_HOST): these tests write and drop data.');
  }
}
process.env.JWT_SECRET ||= 'competitors-test-secret';

const DB_NAME = `odito_competitors_local_test_${Date.now()}_${process.pid}`;
const oid = () => new mongoose.Types.ObjectId();
let Usage; let ProjectCompetitor; let local; let PLACES; let myService; let User; let SeoProject; let signAuthToken; let server; let base;

// Krishna Eye Centre, Nashik.
const HERE = { lat: 19.9975, lng: 73.7898 };
const offsetKm = (km, bearing = 'n') => ({ lat: HERE.lat + (bearing === 'n' ? km / 111.2 : 0), lng: HERE.lng + (bearing === 'e' ? km / (111.2 * Math.cos((HERE.lat * Math.PI) / 180)) : 0) });
const place = (id, name, km, over = {}) => ({ placeId: id, name, address: `${name} address`, ...offsetKm(km), types: ['hospital'], primaryType: 'hospital', primaryTypeLabel: 'Hospital', businessStatus: 'OPERATIONAL', website: null, phone: null, rating: 4.2, reviewCount: 120, mapsUrl: `https://maps.google.com/?cid=${id}`, ...over });

/** A fake Google: answers per call from a script, records every call. */
function fakeGoogle(script) {
  const calls = [];
  const fn = async (args) => { calls.push(args); const r = typeof script === 'function' ? script(args, calls.length) : script; if (r instanceof Error) throw r; return r; };
  fn.calls = calls;
  return fn;
}
const found = (places, capped = false) => ({ places, capped });

async function ownerWithProject(over = {}) {
  const userId = oid(); const projectId = oid();
  await User.collection.insertOne({ _id: userId, firstName: 'T', lastName: 'U', email: `${userId}@example.test`, isActive: true, roleId: 2 });
  await SeoProject.collection.insertOne({
    _id: projectId, user_id: userId, main_url: 'https://www.krishnaeyecentre.com/', country: 'IN', language: 'en', is_deleted: false,
    industry: 'healthcare', sub_industry: 'eye hospital', seo_scope: 'local', target_city: 'Nashik', target_state: 'Maharashtra',
    verified_business: { placeId: 'OWN_PLACE', name: 'Krishna Eye Centre', address: 'Gangapur Rd, Nashik', location: HERE, countryCode: 'IN' },
    ...over,
  });
  return { userId, projectId, projectIdStr: String(projectId), token: signAuthToken({ _id: userId, roleId: 2 }) };
}
const cfg = (over = {}) => ({ enabled: true, projectDailyPlacesCalls: 40, maxResults: 100, ...over });
async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe('Local Competitors (real MongoDB, fake Google)', { skip: SKIP }, () => {
  before(async () => {
    await mongoose.connect(URI, { dbName: DB_NAME, autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 5000 });
    ({ default: Usage } = await import('../model/CompetitorLocalUsage.js'));
    ({ default: ProjectCompetitor } = await import('../model/ProjectCompetitor.js'));
    local = await import('../service/localDiscoveryService.js');
    PLACES = await import('../../../services/googlePlacesService.js');
    myService = await import('../service/myCompetitorsService.js');
    ({ default: User } = await import('../../user/model/User.js'));
    ({ default: SeoProject } = await import('../../app_user/model/SeoProject.js'));
    ({ signAuthToken } = await import('../../user/service/tokenService.js'));
    await Usage.createIndexes();
    myService.__resetIndexStateForTests({ retryMs: 0 });
    await myService.ensureIndexes();
    const { default: routes } = await import('../routes/localRoutes.js');
    const app = express(); app.use(express.json()); app.use('/api/projects', routes);
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}/api/projects`;
  });
  after(async () => {
    await new Promise((r) => (server ? server.close(r) : r()));
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(async () => { await Usage.collection.deleteMany({}); await ProjectCompetitor.collection.deleteMany({}); });

  describe('options (no Google request)', () => {
    test('radii with 5 km as the default, the centre from the verified business, and the suggested categories', async () => {
      const { projectId } = await ownerWithProject();
      const o = await local.getLocalOptions({ projectId });
      assert.deepEqual(o.radiiKm, [1, 3, 5, 10, 15, 25]);
      assert.equal(o.defaultRadiusKm, 5);
      assert.deepEqual(o.center, { lat: HERE.lat, lng: HERE.lng, source: 'verified_business' });
      assert.equal(o.centerIssue, null);
      assert.equal(o.categories.specificity, 'specific');
      assert.deepEqual(o.categories.queries, ['eye hospital']);
      assert.ok(o.categories.allowedTypes.includes('hospital'));
    });
    test('no saved position: an address means "needs confirmation", no address means "location required"', async () => {
      const a = await ownerWithProject({ verified_business: { address: 'Gangapur Rd, Nashik' } });
      assert.deepEqual([(await local.getLocalOptions({ projectId: a.projectId })).center, (await local.getLocalOptions({ projectId: a.projectId })).centerIssue], [null, 'LOCATION_NEEDS_CONFIRMATION']);
      const b = await ownerWithProject({ verified_business: {} });
      assert.equal((await local.getLocalOptions({ projectId: b.projectId })).centerIssue, 'LOCATION_REQUIRED');
    });
  });

  describe('a search', () => {
    test('the default radius is 5 km: it uses the project\'s coordinates, one Nearby + one Text request, and returns only businesses within the circle, nearest first', async () => {
      const { projectId } = await ownerWithProject();
      const google = fakeGoogle((args) => (args.types
        ? found([place('P_NEAR', 'Near Eye Hospital', 1.2), place('P_FAR', 'Far Hospital', 9)])
        : found([place('P_NEAR', 'Near Eye Hospital', 1.2), place('P_MID', 'Mid Eye Clinic', 4.4)])));
      const r = await local.searchLocal({ projectId }, { searchAround: google, config: cfg() });
      assert.equal(r.radiusKm, 5);
      assert.deepEqual(r.center, { lat: HERE.lat, lng: HERE.lng, source: 'verified_business' });
      assert.equal(google.calls.length, 2);
      assert.ok(google.calls.every((c) => c.lat === HERE.lat && c.lng === HERE.lng && c.radiusMeters === 5000));
      assert.deepEqual(google.calls.map((c) => (c.types ? 'nearby' : c.query)), ['nearby', 'eye hospital']);
      assert.deepEqual(r.results.map((x) => x.placeId), ['P_NEAR', 'P_MID'], 'the business 9 km away is outside 5 km, and a place found twice appears once');
      assert.ok(r.results[0].distanceMeters > 1000 && r.results[0].distanceMeters < 1400);
      assert.equal(r.meta.dropped.outsideRadius, 1);
      assert.equal(r.meta.googleRequests, 2);
    });

    test('a different radius widens the circle and is passed to Google; only the allowed radii are accepted', async () => {
      const { projectId } = await ownerWithProject();
      const google = fakeGoogle(found([place('A', 'A', 8)]));
      const r = await local.searchLocal({ projectId, radiusKm: 10 }, { searchAround: google, config: cfg() });
      assert.equal(google.calls[0].radiusMeters, 10_000);
      assert.equal(r.results.length, 1);
      for (const bad of [0, 2, 7, 50, '5km', -5, 999]) await assert.rejects(local.searchLocal({ projectId, radiusKm: bad }, { searchAround: google, config: cfg() }), (e) => e.code === 'INVALID_RADIUS' && e.httpStatus === 400);
    });

    test('Google returns a place without coordinates, or one permanently closed, or the project\'s own business, or its own website: none are listed, and each is counted', async () => {
      const { projectId } = await ownerWithProject();
      const google = fakeGoogle(found([
        place('OK', 'Real Rival', 2),
        place('NOCOORD', 'No Coords', 1, { lat: null, lng: null }),
        place('CLOSED', 'Closed For Good', 1, { businessStatus: 'CLOSED_PERMANENTLY' }),
        place('TEMP', 'Temporarily Closed', 1.5, { businessStatus: 'CLOSED_TEMPORARILY' }),
        place('OWN_PLACE', 'Krishna Eye Centre', 0.05),
        place('OWN_SITE', 'Krishna (other listing)', 0.3, { website: 'https://www.krishnaeyecentre.com/contact' }),
      ]));
      const r = await local.searchLocal({ projectId }, { searchAround: google, config: cfg() });
      assert.deepEqual(r.results.map((x) => x.placeId).sort(), ['OK', 'TEMP']);
      assert.equal(r.results.find((x) => x.placeId === 'TEMP').businessStatus, 'CLOSED_TEMPORARILY', 'temporarily closed is shown, and said');
      assert.deepEqual(r.meta.dropped, { noCoordinates: 1, outsideRadius: 0, permanentlyClosed: 1, yourOwnBusiness: 2 });
    });

    test('each result carries its distance, rating, reviews, website domain and category relevance; nothing is invented', async () => {
      const { projectId } = await ownerWithProject();
      const google = fakeGoogle(found([
        place('D1', 'Dhanvantari Eye Hospital', 1, { website: 'https://www.dhanvantari-eye.in/', primaryTypeLabel: 'Eye hospital', rating: 4.6, reviewCount: 800 }),
        place('R1', 'City General Hospital', 2, { primaryTypeLabel: 'Hospital', rating: null, reviewCount: null }),
        place('U1', 'State Bank', 1.5, { types: ['bank'], primaryType: 'bank', primaryTypeLabel: 'Bank' }),
      ]));
      const r = await local.searchLocal({ projectId }, { searchAround: google, config: cfg() });
      const by = Object.fromEntries(r.results.map((x) => [x.placeId, x]));
      assert.deepEqual([by.D1.relevance, by.R1.relevance, by.U1.relevance], ['direct', 'related', 'unclassified']);
      assert.equal(by.D1.websiteDomain, 'dhanvantari-eye.in');
      assert.deepEqual([by.D1.rating, by.D1.reviewCount], [4.6, 800]);
      assert.deepEqual([by.R1.rating, by.R1.reviewCount, by.R1.websiteDomain], [null, null, null]);
    });

    test('businesses already in My competitors (by Google place, or by website) are marked, with their record id', async () => {
      const { projectId } = await ownerWithProject();
      const saved = await myService.addDiscovered({ projectId, candidate: { name: 'Dhanvantari', domain: 'dhanvantari-eye.in', address: '1 Main Rd', place_id: 'D1', lat: 20, lng: 73.8, source: 'local' } });
      const google = fakeGoogle(found([
        place('D1', 'Dhanvantari Eye Hospital', 1),
        place('D2', 'Dhanvantari (second branch)', 2, { website: 'https://dhanvantari-eye.in' }),
        place('N1', 'New Rival', 3),
      ]));
      const r = await local.searchLocal({ projectId }, { searchAround: google, config: cfg() });
      const by = Object.fromEntries(r.results.map((x) => [x.placeId, x.addedCompetitorId]));
      assert.deepEqual(by, { D1: saved.competitor.id, D2: saved.competitor.id, N1: null });
    });

    test('two branches of one brand with different place ids both appear (never merged on a name)', async () => {
      const { projectId } = await ownerWithProject();
      const google = fakeGoogle(found([place('B1', 'Lotus Eye Care', 1), place('B2', 'Lotus Eye Care', 3)]));
      const r = await local.searchLocal({ projectId }, { searchAround: google, config: cfg() });
      assert.deepEqual(r.results.map((x) => x.placeId), ['B1', 'B2']);
    });

    test('Google\'s result cap is reported so nobody thinks the list is complete; a broad category is said to be broad', async () => {
      const { projectId } = await ownerWithProject();
      const r = await local.searchLocal({ projectId }, { searchAround: fakeGoogle(found([place('A', 'A', 1)], true)), config: cfg() });
      assert.ok(r.meta.warnings.includes('RESULT_CAP'));
      const broad = await ownerWithProject({ sub_industry: null });
      const rb = await local.searchLocal({ projectId: broad.projectId }, { searchAround: fakeGoogle(found([])), config: cfg() });
      assert.equal(rb.categories.specificity, 'broad');
      assert.ok(rb.meta.warnings.includes('BROAD_CATEGORY'));
    });

    test('the results are the response only: nothing from Google is stored by a search', async () => {
      const { projectId } = await ownerWithProject();
      await local.searchLocal({ projectId }, { searchAround: fakeGoogle(found([place('A', 'A Hospital', 1, { website: 'https://a.example', rating: 5 })])), config: cfg() });
      assert.equal(await ProjectCompetitor.countDocuments({}), 0);
      const names = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name);
      assert.ok(!names.some((n) => /place|local_result|google/i.test(n.replace('competitor_local_usage', ''))), names.join());
      assert.equal((await Usage.findOne({ project_id: projectId })).calls, 2, 'only a count of requests is kept');
    });
  });

  describe('the user\'s corrections', () => {
    test('their own category words and allowed types are used; invalid types never reach Google', async () => {
      const { projectId } = await ownerWithProject();
      const google = fakeGoogle(found([]));
      const r = await local.searchLocal({ projectId, queries: ['dental clinic'], types: ['dentist', 'not_a_type'] }, { searchAround: google, config: cfg() });
      assert.deepEqual(google.calls.map((c) => c.types ?? c.query), [['dentist'], 'dental clinic']);
      assert.equal(r.categories.corrected, true);
    });
    test('a project whose business cannot be mapped must be told what to search for (it does not search everything nearby)', async () => {
      const { projectId } = await ownerWithProject({ industry: null, sub_industry: null });
      const google = fakeGoogle(found([]));
      await assert.rejects(local.searchLocal({ projectId }, { searchAround: google, config: cfg() }), (e) => e.code === 'CATEGORY_REQUIRED' && e.httpStatus === 422);
      assert.equal(google.calls.length, 0);
      const ok = await local.searchLocal({ projectId, queries: ['bakery'] }, { searchAround: google, config: cfg() });
      assert.equal(ok.categories.queries[0], 'bakery');
    });
  });

  describe('location', () => {
    test('no saved position and no address: LOCATION_REQUIRED, nothing is sent to Google, and no other location is substituted', async () => {
      const { projectId } = await ownerWithProject({ verified_business: {} });
      const google = fakeGoogle(found([]));
      await assert.rejects(local.searchLocal({ projectId }, { searchAround: google, config: cfg() }), (e) => e.code === 'LOCATION_REQUIRED' && e.httpStatus === 422);
      assert.equal(google.calls.length, 0);
    });
    test('an address without a position needs the user\'s confirmation; once confirmed it costs one lookup and the centre says where it came from', async () => {
      const { projectId } = await ownerWithProject({ verified_business: { address: 'Gangapur Rd, Nashik' } });
      const google = fakeGoogle(found([place('A', 'A', 1)]));
      let lookedUp = null;
      const deps = { searchAround: google, config: cfg(), geocode: async (text) => { lookedUp = text; return { lat: HERE.lat, lng: HERE.lng }; } };
      await assert.rejects(local.searchLocal({ projectId }, deps), (e) => e.code === 'LOCATION_NEEDS_CONFIRMATION' && e.address === 'Gangapur Rd, Nashik');
      assert.equal(lookedUp, null);
      const r = await local.searchLocal({ projectId, geocode: true }, deps);
      assert.equal(lookedUp, 'Gangapur Rd, Nashik');
      assert.equal(r.center.source, 'address_geocoded');
      assert.equal(r.meta.googleRequests, 3);
      assert.equal((await Usage.findOne({ project_id: projectId })).calls, 3, 'the lookup counted against the budget too');
    });
    test('an address Google cannot find is LOCATION_REQUIRED', async () => {
      const { projectId } = await ownerWithProject({ verified_business: { address: 'Nowhere' } });
      await assert.rejects(local.searchLocal({ projectId, geocode: true }, { searchAround: fakeGoogle(found([])), config: cfg(), geocode: async () => null }), (e) => e.code === 'LOCATION_REQUIRED');
    });
  });

  describe('cost control and failures', () => {
    test('the daily budget is reserved BEFORE each Google request and stops the search: nothing past the limit is requested', async () => {
      const { projectId } = await ownerWithProject();
      const google = fakeGoogle(found([place('A', 'A', 1)]));
      const deps = { searchAround: google, config: cfg({ projectDailyPlacesCalls: 3 }) };
      await local.searchLocal({ projectId }, deps); // uses 2 of 3
      await assert.rejects(local.searchLocal({ projectId }, deps), (e) => e.code === 'LOCAL_BUDGET_EXCEEDED' && e.httpStatus === 429);
      assert.equal(google.calls.length, 3, 'the third request was allowed, the fourth was never made');
      assert.equal((await Usage.findOne({ project_id: projectId })).calls, 3);
    });
    test('20 simultaneous searches against a budget of 10 requests: exactly 10 are made in total', async () => {
      const { projectId } = await ownerWithProject();
      const google = fakeGoogle(found([]));
      const deps = { searchAround: google, config: cfg({ projectDailyPlacesCalls: 10 }) };
      const results = await Promise.all(Array.from({ length: 20 }, () => local.searchLocal({ projectId }, deps).then(() => 'ok', (e) => e.code)));
      assert.equal(google.calls.length, 10, JSON.stringify(results));
      assert.ok((await Usage.findOne({ project_id: projectId })).calls <= 10);
    });
    test('one project\'s budget never uses another\'s', async () => {
      const a = await ownerWithProject(); const b = await ownerWithProject();
      const deps = { searchAround: fakeGoogle(found([])), config: cfg({ projectDailyPlacesCalls: 2 }) };
      await local.searchLocal({ projectId: a.projectId }, deps);
      await assert.rejects(local.searchLocal({ projectId: a.projectId }, deps), (e) => e.code === 'LOCAL_BUDGET_EXCEEDED');
      await local.searchLocal({ projectId: b.projectId }, deps);
    });
    test('the kill switch stops everything before Google', async () => {
      const { projectId } = await ownerWithProject();
      const google = fakeGoogle(found([]));
      await assert.rejects(local.searchLocal({ projectId }, { searchAround: google, config: cfg({ enabled: false }) }), (e) => e.code === 'LOCAL_DISABLED' && e.httpStatus === 503);
      assert.equal(google.calls.length, 0);
    });
    test('every Google failure becomes a safe code; the raw Google message is never returned', async () => {
      const { projectId } = await ownerWithProject();
      const cases = [
        [PLACES.PLACES_ERROR.NOT_CONFIGURED, 503], [PLACES.PLACES_ERROR.KEY_INVALID, 503], [PLACES.PLACES_ERROR.ACCESS_DENIED, 503], [PLACES.PLACES_ERROR.BILLING_REQUIRED, 503],
        [PLACES.PLACES_ERROR.RATE_LIMITED, 429], [PLACES.PLACES_ERROR.TIMEOUT, 504], [PLACES.PLACES_ERROR.UNAVAILABLE, 502], [PLACES.PLACES_ERROR.BAD_RESPONSE, 502],
      ];
      for (const [code, status] of cases) {
        const err = await local.searchLocal({ projectId }, { searchAround: fakeGoogle(new PLACES.PlacesError(code, 'Google said: key AIza-SECRET-123 is not allowed', { upstreamStatus: 403 })), config: cfg({ projectDailyPlacesCalls: 99 }) }).catch((e) => e);
        assert.deepEqual([err.code, err.httpStatus], [code, status]);
        assert.ok(!/AIza|SECRET|Google said/.test(err.message), `${code}: ${err.message}`);
      }
    });
    test('if one of the searches fails the others still answer, with a warning; if all fail, it is an error', async () => {
      const { projectId } = await ownerWithProject();
      const partial = fakeGoogle((args) => (args.types ? new PLACES.PlacesError(PLACES.PLACES_ERROR.TIMEOUT, 'x') : found([place('A', 'A', 1)])));
      const r = await local.searchLocal({ projectId }, { searchAround: partial, config: cfg() });
      assert.equal(r.results.length, 1);
      assert.ok(r.meta.warnings.includes('SOME_SEARCHES_FAILED'));
      const dead = fakeGoogle(new PLACES.PlacesError(PLACES.PLACES_ERROR.UNAVAILABLE, 'x'));
      await assert.rejects(local.searchLocal({ projectId }, { searchAround: dead, config: cfg() }), (e) => e.code === PLACES.PLACES_ERROR.UNAVAILABLE);
    });
  });

  describe('routes', () => {
    test('authentication, ownership and validation (real middleware)', async () => {
      const a = await ownerWithProject(); const b = await ownerWithProject();
      const p = `/${a.projectIdStr}/local-competitors`;
      assert.equal((await call('GET', `${p}/options`)).status, 401);
      assert.equal((await call('GET', `${p}/options`, { token: b.token })).status, 403);
      assert.equal((await call('POST', `${p}/search`, { token: b.token, body: {} })).status, 403);
      assert.equal((await call('GET', `/${oid()}/local-competitors/options`, { token: a.token })).status, 404);
      assert.equal((await call('GET', '/not-an-id/local-competitors/options', { token: a.token })).status, 400);
      const opts = await call('GET', `${p}/options`, { token: a.token });
      assert.equal(opts.status, 200);
      assert.equal(opts.body.data.defaultRadiusKm, 5);
      const bad = await call('POST', `${p}/search`, { token: a.token, body: { radiusKm: 7 } });
      assert.deepEqual([bad.status, bad.body.code], [400, 'INVALID_RADIUS']);
    });
    test('without a Google key the search answers a clear 503, and the response never contains a key or Google\'s message', async () => {
      const saved = process.env.GOOGLE_PLACES_API_KEY; delete process.env.GOOGLE_PLACES_API_KEY;
      try {
        const a = await ownerWithProject();
        const r = await call('POST', `/${a.projectIdStr}/local-competitors/search`, { token: a.token, body: {} });
        assert.deepEqual([r.status, r.body.code], [503, PLACES.PLACES_ERROR.NOT_CONFIGURED]);
        assert.ok(!JSON.stringify(r.body).includes('GOOGLE_PLACES_API_KEY'));
      } finally { if (saved !== undefined) process.env.GOOGLE_PLACES_API_KEY = saved; }
    });
    test('the project\'s location always comes from the project: a body cannot move the search centre', async () => {
      const a = await ownerWithProject();
      const seen = [];
      // The route uses the real searchPlacesAround; with no key it fails before any request, so assert via the service contract instead:
      const google = fakeGoogle((args) => { seen.push(args); return found([]); });
      await local.searchLocal({ projectId: a.projectId, radiusKm: 5, lat: 0, lng: 0, center: { lat: 1, lng: 1 } }, { searchAround: google, config: cfg() });
      assert.ok(seen.every((s) => s.lat === HERE.lat && s.lng === HERE.lng));
    });
  });
});
