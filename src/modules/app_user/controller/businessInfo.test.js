import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import mongoose from 'mongoose';
import { parseIdentity, parseLocation, buildVerifiedBusiness, toBusinessInfoDto } from './businessInfoController.js';
import { autocompletePlaces, classifyPlacesError, getPlaceForLocation, normalizeLocationPlace, PlacesError, PLACES_ERROR } from '../../../services/googlePlacesService.js';

/**
 * Business Information: pure rules, the Places calls with a fake HTTP client (no network, no money), and - when COMPETITORS_TEST_MONGO_URI
 * points at a local throwaway MongoDB - the routes against a real database, including "a saved location is what Local Competitors uses".
 */

const GOOD = { confirmed: true, address: 'Gangapur Rd, Nashik 422013, India', lat: 19.9975, lng: 73.7898, city: 'Nashik', state: 'Maharashtra', country: 'India', countryCode: 'in' };
const TOKEN = 'abcdefghijklmnopqrstuv0123456789';

describe('parseIdentity', () => {
  test('only the keys that were sent end up in the update', () => {
    assert.deepEqual(parseIdentity({ subIndustry: ' eye   hospital ' }), { sub_industry: 'eye hospital' });
    assert.deepEqual(parseIdentity({}), {});
  });
  test('industry must come from the taxonomy; empty clears; unknown is refused', () => {
    assert.equal(parseIdentity({ industry: 'healthcare' }).industry, 'healthcare');
    assert.equal(parseIdentity({ industry: '' }).industry, null);
    assert.throws(() => parseIdentity({ industry: 'wizardry' }), /Choose an industry/);
  });
  test('services and categories are trimmed, de-duplicated (case-insensitively) and limited', () => {
    const s = parseIdentity({ services: [' Cataract ', 'cataract', 'LASIK', ''], secondaryCategories: ['A', 'a'] });
    assert.deepEqual(s['visibility_profile.services'], ['Cataract', 'LASIK']);
    assert.deepEqual(s.secondary_categories, ['A']);
    assert.ok(s['visibility_profile.updated_at'] instanceof Date);
    assert.throws(() => parseIdentity({ services: Array.from({ length: 31 }, (_, i) => `s${i}`) }), /at most 30/);
    assert.throws(() => parseIdentity({ services: ['x'.repeat(101)] }), /at most 100/);
    assert.throws(() => parseIdentity({ services: 'nope' }), /must be a list/);
  });
  test('fields that are not in the list are ignored, never written (no ownership / status / billing fields)', () => {
    const s = parseIdentity({ businessName: 'Krishna', user_id: 'x', status: 'deleted', plan: 'pro', is_deleted: true, 'verified_business.placeId': 'z' });
    assert.deepEqual(Object.keys(s), ['business_name']);
  });
  test('wrong types are refused', () => {
    assert.throws(() => parseIdentity({ businessName: 5 }), /must be text/);
    assert.throws(() => parseIdentity('x'), /must be an object/);
    assert.throws(() => parseIdentity({ businessName: 'x'.repeat(201) }), /longer than 200/);
  });
});

describe('parseLocation', () => {
  test('a confirmed, complete location is accepted and cleaned', () => {
    const l = parseLocation(GOOD);
    assert.equal(l.countryCode, 'IN');
    assert.equal(l.lat, 19.9975);
    assert.equal(l.placeId, null);
    assert.equal(l.coordinatesAdjusted, false);
  });
  test('without an explicit confirmation nothing is accepted', () => {
    for (const c of [undefined, false, 'true', 1]) assert.throws(() => parseLocation({ ...GOOD, confirmed: c }), /confirm/);
  });
  test('coordinates must be real numbers in range - never strings, NaN, out of range or (0, 0)', () => {
    for (const bad of [{ lat: '19.9' }, { lat: NaN }, { lat: Infinity }, { lat: 90.1 }, { lat: -91 }, { lng: 180.5 }, { lng: -181 }, { lat: null }, { lat: 0, lng: 0 }]) {
      assert.throws(() => parseLocation({ ...GOOD, ...bad }), /atitude|ongitude|real business/, JSON.stringify(bad));
    }
    assert.doesNotThrow(() => parseLocation({ ...GOOD, lat: -90, lng: 180 }));
  });
  test('address, country code and place id are validated', () => {
    assert.throws(() => parseLocation({ ...GOOD, address: '  ' }), /needs an address/);
    assert.throws(() => parseLocation({ ...GOOD, countryCode: 'IND' }), /Country code/);
    assert.throws(() => parseLocation({ ...GOOD, countryCode: '12' }), /two letters/);
    assert.throws(() => parseLocation({ ...GOOD, placeId: 'bad id with spaces' }), /Place ID/);
    assert.equal(parseLocation({ ...GOOD, placeId: 'ChIJ_valid-Place123' }).placeId, 'ChIJ_valid-Place123');
  });
});

describe('buildVerifiedBusiness', () => {
  const now = new Date('2026-11-02T00:00:00Z');
  test('a Places selection records the place, the time, and that the USER confirmed it (not a Business Profile verification)', () => {
    const vb = buildVerifiedBusiness(undefined, parseLocation({ ...GOOD, placeId: 'ChIJ_valid-Place123', name: 'Krishna Eye Centre' }), now);
    assert.equal(vb.placeId, 'ChIJ_valid-Place123');
    assert.equal(vb.confirmedByUser, true);
    assert.deepEqual(vb.verifiedAt, now);
    assert.deepEqual(vb.location, { lat: 19.9975, lng: 73.7898 });
  });
  test('a manual location has no place id and no verifiedAt', () => {
    const vb = buildVerifiedBusiness({ placeId: 'OLD_PLACE_1234', phone: '123', rating: 4.5 }, parseLocation(GOOD), now);
    assert.equal(vb.placeId, undefined);
    assert.equal(vb.verifiedAt, undefined);
    assert.equal(vb.phone, undefined);
    assert.equal(vb.rating, undefined);
  });
  test('the same place: details the new input leaves out are kept (an incomplete result does not erase what is known)', () => {
    const existing = { placeId: 'ChIJ_valid-Place123', postalCode: '422013', phone: '+91 1', rating: 4.8, name: 'Krishna Eye Centre', website: 'https://k.example' };
    const vb = buildVerifiedBusiness(existing, parseLocation({ ...GOOD, placeId: 'ChIJ_valid-Place123' }), now);
    assert.equal(vb.postalCode, '422013');
    assert.equal(vb.phone, '+91 1');
    assert.equal(vb.rating, 4.8);
    assert.equal(vb.name, 'Krishna Eye Centre');
  });
  test('a different place starts clean: another listing\'s phone, rating, city or name are not carried over', () => {
    const existing = { placeId: 'ChIJ_old-Place1234', city: 'Pune', phone: '+91 1', rating: 4.8, name: 'Old name' };
    const vb = buildVerifiedBusiness(existing, parseLocation({ ...GOOD, city: '', placeId: 'ChIJ_new-Place1234' }), now);
    assert.equal(vb.city, undefined);
    assert.equal(vb.phone, undefined);
    assert.equal(vb.name, undefined);
  });
});

describe('toBusinessInfoDto', () => {
  test('no coordinates -> missing; onboarding coordinates -> unconfirmed; user-confirmed -> confirmed', () => {
    assert.equal(toBusinessInfoDto({}).verification.status, 'missing');
    assert.equal(toBusinessInfoDto({ verified_business: { address: 'x' } }).verification.status, 'missing');
    const onboarding = toBusinessInfoDto({ verified_business: { placeId: 'P', address: 'x', location: { lat: 1, lng: 2 }, verifiedAt: new Date() } });
    assert.equal(onboarding.verification.status, 'unconfirmed');
    assert.equal(onboarding.location.lat, 1);
    const confirmed = toBusinessInfoDto({ verified_business: { address: 'x', location: { lat: 1, lng: 2 }, confirmedByUser: true, confirmedAt: new Date() } });
    assert.equal(confirmed.verification.status, 'confirmed');
    assert.equal(confirmed.verification.source, 'manual');
  });
  test('choosing a place never makes the Google Business Profile "connected"', () => {
    const vb = { placeId: 'P', address: 'x', location: { lat: 1, lng: 2 }, confirmedByUser: true };
    assert.equal(toBusinessInfoDto({ verified_business: vb }, false).verification.googleBusinessProfileConnected, false);
    assert.equal(toBusinessInfoDto({ verified_business: vb }, true).verification.googleBusinessProfileConnected, true);
  });
  test('an old project with nothing set returns a safe shape; target city stays separate from the business address', () => {
    const d = toBusinessInfoDto({ target_city: 'Mumbai', verified_business: { address: 'a', city: 'Nashik', location: { lat: 1, lng: 2 } } });
    assert.deepEqual(d.identity.services, []);
    assert.equal(d.targetLocation.city, 'Mumbai');
    assert.equal(d.location.city, 'Nashik');
  });
});

describe('Places calls (fake HTTP client)', () => {
  const fake = (response, record = []) => ({
    post: async (url, body, cfg) => { record.push({ url, body, cfg }); if (response instanceof Error) throw response; return { status: 200, data: response }; },
    get: async (url, cfg) => { record.push({ url, cfg }); if (response instanceof Error) throw response; return { status: 200, data: response }; },
  });
  test('autocomplete sends the session token and a field mask, and returns at most five trimmed suggestions', async () => {
    const rec = [];
    const suggestions = Array.from({ length: 7 }, (_, i) => ({ placePrediction: { placeId: `P${i}`, text: { text: `Place ${i}, City` }, structuredFormat: { mainText: { text: `Place ${i}` }, secondaryText: { text: 'City' } } } }));
    const out = await autocompletePlaces({ input: ' gangapur road ', sessionToken: TOKEN, regionCode: 'in', client: fake({ suggestions }, rec) });
    assert.equal(out.length, 5);
    assert.deepEqual(out[0], { placeId: 'P0', text: 'Place 0, City', primary: 'Place 0', secondary: 'City' });
    assert.equal(rec[0].url, 'places:autocomplete');
    assert.equal(rec[0].body.sessionToken, TOKEN);
    assert.equal(rec[0].body.input, 'gangapur road');
    assert.equal(rec[0].body.regionCode, 'IN');
    assert.match(rec[0].cfg.headers['X-Goog-FieldMask'], /suggestions\.placePrediction\.placeId/);
  });
  test('no results is an empty list, not an error', async () => {
    assert.deepEqual(await autocompletePlaces({ input: 'zzzzzz', sessionToken: TOKEN, client: fake({}) }), []);
  });
  test('too-short input, a missing or malformed token are refused before any request', async () => {
    const rec = [];
    await assert.rejects(autocompletePlaces({ input: 'ab', sessionToken: TOKEN, client: fake({}, rec) }), (e) => e instanceof PlacesError && e.code === PLACES_ERROR.INVALID_REQUEST);
    await assert.rejects(autocompletePlaces({ input: 'abc def', sessionToken: 'x', client: fake({}, rec) }), PlacesError);
    await assert.rejects(autocompletePlaces({ input: 'abc def', sessionToken: undefined, client: fake({}, rec) }), PlacesError);
    assert.equal(rec.length, 0);
  });
  test('an unexpected response shape is a typed error', async () => {
    await assert.rejects(autocompletePlaces({ input: 'abc def', sessionToken: TOKEN, client: fake({ suggestions: 'x' }) }), (e) => e.code === PLACES_ERROR.BAD_RESPONSE);
  });
  test('place details use a narrow field mask and the same session token, and split the address into parts', async () => {
    const rec = [];
    const raw = {
      id: 'ChIJ_valid-Place123', displayName: { text: 'Krishna Eye Centre' }, formattedAddress: '12 Gangapur Rd, Nashik 422013, India', websiteUri: 'https://k.example',
      location: { latitude: 19.9975, longitude: 73.7898 },
      addressComponents: [
        { types: ['street_number'], longText: '12' }, { types: ['route'], longText: 'Gangapur Rd' }, { types: ['locality'], longText: 'Nashik' },
        { types: ['administrative_area_level_1'], longText: 'Maharashtra' }, { types: ['country'], longText: 'India', shortText: 'IN' }, { types: ['postal_code'], longText: '422013' },
      ],
    };
    const p = await getPlaceForLocation({ placeId: 'ChIJ_valid-Place123', sessionToken: TOKEN, client: fake(raw, rec) });
    assert.deepEqual(p, { placeId: 'ChIJ_valid-Place123', name: 'Krishna Eye Centre', address: '12 Gangapur Rd, Nashik 422013, India', addressLine: '12 Gangapur Rd', city: 'Nashik', state: 'Maharashtra', country: 'India', countryCode: 'IN', postalCode: '422013', website: 'https://k.example', location: { lat: 19.9975, lng: 73.7898 } });
    assert.equal(rec[0].url, 'places/ChIJ_valid-Place123');
    assert.equal(rec[0].cfg.params.sessionToken, TOKEN);
    assert.ok(!/reviews|photos|rating|phone/i.test(rec[0].cfg.headers['X-Goog-FieldMask']));
  });
  test('a place without coordinates is never usable; a place id with path tricks is refused', async () => {
    assert.equal(normalizeLocationPlace({ id: 'x', formattedAddress: 'a' }), null);
    await assert.rejects(getPlaceForLocation({ placeId: 'x', sessionToken: TOKEN, client: fake({}) }), PlacesError);
    await assert.rejects(getPlaceForLocation({ placeId: '../../places:searchText', sessionToken: TOKEN, client: fake({}) }), PlacesError);
    await assert.rejects(getPlaceForLocation({ placeId: 'ChIJ_valid-Place123', sessionToken: TOKEN, client: fake({ id: 'ChIJ_valid-Place123' }) }), (e) => e.code === PLACES_ERROR.BAD_RESPONSE);
  });
  test('Google failures are classified (invalid key, quota, billing, timeout) - the key is never in the message', async () => {
    const err = (status, body) => Object.assign(new Error('x'), { isAxiosError: true, response: { status, data: body } });
    const cases = [[403, { error: { status: 'PERMISSION_DENIED', message: 'API key not valid', details: [{ reason: 'API_KEY_INVALID' }] } }], [429, { error: { status: 'RESOURCE_EXHAUSTED' } }]];
    for (const [status, body] of cases) {
      await assert.rejects(autocompletePlaces({ input: 'abc def', sessionToken: TOKEN, client: fake(err(status, body)) }), (e) => e instanceof PlacesError && !/AIza/.test(e.message));
    }
  });
});


describe('why Google refused (the real causes behind "not available right now")', () => {
  const err = (status, error) => Object.assign(new Error('x'), { isAxiosError: true, response: { status, data: { error } } });
  test('a bare 403 PERMISSION_DENIED means Places API (New) is not enabled for the Cloud project behind the key', () => {
    const e = classifyPlacesError(err(403, { status: 'PERMISSION_DENIED', message: 'The caller does not have permission' }));
    assert.equal(e.code, PLACES_ERROR.ACCESS_DENIED);
    assert.equal(e.hint, 'api_not_enabled');
  });
  test('an API / referrer / IP restriction is reported as a restricted key', () => {
    for (const reason of ['API_KEY_SERVICE_BLOCKED', 'API_KEY_HTTP_REFERRER_BLOCKED', 'API_KEY_IP_ADDRESS_BLOCKED']) {
      const e = classifyPlacesError(err(403, { status: 'PERMISSION_DENIED', message: 'blocked', details: [{ reason }] }));
      assert.equal(e.hint, 'key_restricted', reason);
    }
  });
  test('billing, quota, invalid key and network failures keep their own codes', () => {
    assert.equal(classifyPlacesError(err(403, { status: 'PERMISSION_DENIED', message: 'x', details: [{ reason: 'BILLING_DISABLED' }] })).code, PLACES_ERROR.BILLING_REQUIRED);
    assert.equal(classifyPlacesError(err(429, { status: 'RESOURCE_EXHAUSTED' })).code, PLACES_ERROR.RATE_LIMITED);
    assert.equal(classifyPlacesError(err(400, { status: 'INVALID_ARGUMENT', message: 'API key not valid', details: [{ reason: 'API_KEY_INVALID' }] })).code, PLACES_ERROR.KEY_INVALID);
    assert.equal(classifyPlacesError(Object.assign(new Error('boom'), { code: 'ECONNRESET' })).code, PLACES_ERROR.UNAVAILABLE);
  });
});

// ── Real MongoDB ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const URI = process.env.COMPETITORS_TEST_MONGO_URI;
const SKIP = URI ? false : 'set COMPETITORS_TEST_MONGO_URI to a local throwaway MongoDB to run the database tests';
if (URI) {
  const host = /^mongodb:\/\/(\[[^\]]+\]|[^/@,?:]+)(?::\d+)?\//.exec(URI)?.[1];
  if (!host || !['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new Error('COMPETITORS_TEST_MONGO_URI must point at localhost: these tests write and drop data.');
}
process.env.JWT_SECRET ||= 'business-info-test-secret';
const DB_NAME = `odito_business_info_test_${Date.now()}_${process.pid}`;
const oid = () => new mongoose.Types.ObjectId();

describe('Business Information routes (real MongoDB)', { skip: SKIP }, () => {
  let SeoProject; let User; let Meta; let signAuthToken; let server; let base; let local; let ProjectCompetitor; let Usage;
  before(async () => {
    await mongoose.connect(URI, { dbName: DB_NAME, autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 5000 });
    ({ default: SeoProject } = await import('../model/SeoProject.js'));
    ({ default: User } = await import('../../user/model/User.js'));
    ({ default: Meta } = await import('../model/BusinessProfileMetadata.js'));
    ({ signAuthToken } = await import('../../user/service/tokenService.js'));
    local = await import('../../competitors/service/localDiscoveryService.js');
    ({ default: ProjectCompetitor } = await import('../../competitors/model/ProjectCompetitor.js'));
    ({ default: Usage } = await import('../../competitors/model/CompetitorLocalUsage.js'));
    const { default: routes } = await import('../routes/businessInfoRoutes.js');
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
  beforeEach(async () => { await SeoProject.collection.deleteMany({}); await User.collection.deleteMany({}); await Meta.collection.deleteMany({}); });

  async function owner(over = {}) {
    const userId = oid(); const projectId = oid();
    await User.collection.insertOne({ _id: userId, firstName: 'T', lastName: 'U', email: `${userId}@example.test`, isActive: true, roleId: 2 });
    await SeoProject.collection.insertOne({ _id: projectId, user_id: userId, main_url: 'https://www.krishnaeyecentre.com/', language: 'en', is_deleted: false, status: 'active', ...over });
    return { userId, projectId, id: String(projectId), token: signAuthToken({ _id: userId, roleId: 2 }) };
  }
  async function call(method, path, { token, body } = {}) {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  const raw = (projectId) => SeoProject.collection.findOne({ _id: projectId });

  test('needs a signed-in owner: no token 401, someone else\'s project is refused and untouched', async () => {
    const a = await owner(); const b = await owner();
    assert.equal((await call('GET', `/${a.id}/business-info`)).status, 401);
    const r = await call('PUT', `/${a.id}/business-info`, { token: b.token, body: { identity: { businessName: 'Hijack' } } });
    assert.ok([403, 404].includes(r.status), `status ${r.status}`);
    assert.equal((await raw(a.projectId)).business_name, undefined);
    assert.equal((await call('GET', `/not-an-id/business-info`, { token: a.token })).status, 400);
  });

  test('an existing project with nothing set reads back safely (missing), and an onboarding location reads back as NOT confirmed', async () => {
    const empty = await owner();
    const r = await call('GET', `/${empty.id}/business-info`, { token: empty.token });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.verification.status, 'missing');
    assert.equal(r.body.data.location, null);
    const onb = await owner({ industry: 'healthcare', verified_business: { placeId: 'ChIJ_valid-Place123', name: 'KEC', address: 'Gangapur Rd', location: { lat: 19.9975, lng: 73.7898 }, verifiedAt: new Date() } });
    const o = await call('GET', `/${onb.id}/business-info`, { token: onb.token });
    assert.equal(o.body.data.verification.status, 'unconfirmed');
    assert.equal(o.body.data.identity.industry, 'healthcare');
    assert.equal(o.body.data.verification.googleBusinessProfileConnected, false);
  });

  test('identity saves are partial: omitted fields are preserved, services go to visibility_profile', async () => {
    const p = await owner({ industry: 'healthcare', sub_industry: 'eye hospital', target_city: 'Nashik', business_type: 'clinic' });
    const r = await call('PUT', `/${p.id}/business-info`, { token: p.token, body: { identity: { businessName: 'Krishna Eye Centre', services: ['Cataract', 'LASIK'], secondaryCategories: ['Eye clinic'] } } });
    assert.equal(r.status, 200);
    const d = await raw(p.projectId);
    assert.equal(d.business_name, 'Krishna Eye Centre');
    assert.deepEqual(d.visibility_profile.services, ['Cataract', 'LASIK']);
    assert.deepEqual(d.secondary_categories, ['Eye clinic']);
    assert.equal(d.industry, 'healthcare');
    assert.equal(d.sub_industry, 'eye hospital');
    assert.equal(d.business_type, 'clinic');
    assert.equal(d.target_city, 'Nashik');
    assert.equal(d.main_url, 'https://www.krishnaeyecentre.com/');
  });

  test('protected fields cannot be changed through this endpoint', async () => {
    const p = await owner(); const other = oid();
    const r = await call('PUT', `/${p.id}/business-info`, { token: p.token, body: { identity: { businessName: 'X', user_id: String(other), status: 'deleted', is_deleted: true, main_url: 'https://evil.example', plan: 'pro' }, user_id: String(other), project_id: String(other) } });
    assert.equal(r.status, 200);
    const d = await raw(p.projectId);
    assert.deepEqual([String(d.user_id), d.status, d.is_deleted, d.main_url, d.plan], [String(p.userId), 'active', false, 'https://www.krishnaeyecentre.com/', undefined]);
  });

  test('a location needs explicit confirmation and valid coordinates; bad requests change nothing', async () => {
    const p = await owner({ verified_business: { name: 'Keep me', address: 'old', location: { lat: 1, lng: 2 } } });
    const put = (location) => call('PUT', `/${p.id}/business-info`, { token: p.token, body: { location } });
    assert.equal((await put({ ...GOOD, confirmed: false })).status, 400);
    assert.equal((await put({ ...GOOD, lat: 200 })).status, 400);
    assert.equal((await put({ ...GOOD, lng: 'x' })).status, 400);
    assert.equal((await call('PUT', `/${p.id}/business-info`, { token: p.token, body: {} })).status, 400);
    const d = await raw(p.projectId);
    assert.equal(d.verified_business.name, 'Keep me');
    assert.deepEqual(d.verified_business.location, { lat: 1, lng: 2 });
  });

  test('a confirmed location is saved where Local Competitors reads it, with a truthful source, and does not touch the target city', async () => {
    const p = await owner({ target_city: 'Mumbai', seo_scope: 'local' });
    const r = await call('PUT', `/${p.id}/business-info`, { token: p.token, body: { location: { ...GOOD, placeId: 'ChIJ_valid-Place123', name: 'Krishna Eye Centre', coordinatesAdjusted: true } } });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.verification.status, 'confirmed');
    assert.equal(r.body.data.verification.source, 'google_places');
    assert.equal(r.body.data.verification.googleBusinessProfileConnected, false);
    const d = await raw(p.projectId);
    assert.deepEqual(d.verified_business.location, { lat: 19.9975, lng: 73.7898 });
    assert.equal(d.verified_business.countryCode, 'IN');
    assert.equal(d.country, 'IN');
    assert.equal(d.location_source, 'google_places');
    assert.equal(d.target_city, 'Mumbai');
    assert.equal(d.verified_business.confirmedByUser, true);
    assert.equal(d.verified_business.coordinatesAdjusted, true);
  });

  test('a connected Business Profile is reported separately from the chosen location', async () => {
    const p = await owner({ verified_business: { address: 'x', location: { lat: 1, lng: 2 } } });
    await Meta.collection.insertOne({ project_id: p.projectId, user_id: p.userId, business_account_id: 'a', business_location_id: 'l' });
    const r = await call('GET', `/${p.id}/business-info`, { token: p.token });
    assert.equal(r.body.data.verification.googleBusinessProfileConnected, true);
    assert.equal(r.body.data.verification.status, 'unconfirmed');
  });

  test('Places endpoints validate input before any provider call (this server has no key here, so a valid call is a clean 503)', async () => {
    const p = await owner();
    const saved = process.env.GOOGLE_PLACES_API_KEY; delete process.env.GOOGLE_PLACES_API_KEY;
    try {
      assert.equal((await call('POST', `/${p.id}/business-info/places/autocomplete`, { token: p.token, body: { input: 'ab', sessionToken: TOKEN } })).status, 400);
      assert.equal((await call('POST', `/${p.id}/business-info/places/autocomplete`, { token: p.token, body: { input: 'abc def' } })).status, 400);
      const r = await call('POST', `/${p.id}/business-info/places/autocomplete`, { token: p.token, body: { input: 'abc def', sessionToken: TOKEN } });
      assert.equal(r.status, 503);
      assert.equal(r.body.code, PLACES_ERROR.NOT_CONFIGURED);
      assert.equal((await call('POST', `/${p.id}/business-info/places/details`, { token: p.token, body: { placeId: '../x', sessionToken: TOKEN } })).status, 400);
      assert.equal((await call('POST', `/${p.id}/business-info/places/autocomplete`, { body: { input: 'abc def', sessionToken: TOKEN } })).status, 401);
    } finally { if (saved !== undefined) process.env.GOOGLE_PLACES_API_KEY = saved; }
  });

  test('INTEGRATION: no location -> Local Competitors has no centre; save a location in settings -> the same project searches around THOSE coordinates; change it -> the next search follows', async () => {
    const p = await owner({ industry: 'healthcare', sub_industry: 'eye hospital', seo_scope: 'local', country: 'IN' });
    await Usage.createIndexes(); await ProjectCompetitor.createIndexes().catch(() => {});
    const before = await local.getLocalOptions({ projectId: p.projectId });
    assert.equal(before.center, null);
    assert.equal(before.centerIssue, 'LOCATION_REQUIRED');

    await call('PUT', `/${p.id}/business-info`, { token: p.token, body: { location: { ...GOOD, placeId: 'ChIJ_valid-Place123' } } });
    const after1 = await local.getLocalOptions({ projectId: p.projectId });
    assert.deepEqual(after1.center, { lat: 19.9975, lng: 73.7898, source: 'verified_business' });
    assert.equal(after1.centerIssue, null);

    await call('PUT', `/${p.id}/business-info`, { token: p.token, body: { location: { ...GOOD, lat: 18.5204, lng: 73.8567, city: 'Pune', address: 'FC Road, Pune' } } });
    const after2 = await local.getLocalOptions({ projectId: p.projectId });
    assert.deepEqual(after2.center, { lat: 18.5204, lng: 73.8567, source: 'verified_business' });
  });
});
