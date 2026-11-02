import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNearbyPlace, searchPlacesAround, PLACES_MAX_RADIUS_M, PlacesError, PLACES_ERROR } from '../../../services/googlePlacesService.js';

/** A fake HTTP client: records every request and answers from a queue. Nothing here reaches Google. */
const fakeClient = (...answers) => {
  const calls = [];
  const post = async (url, body, config) => {
    calls.push({ url, body, headers: config?.headers });
    const a = answers.length > 1 ? answers.shift() : answers[0];
    if (a instanceof Error) throw a;
    return { status: 200, data: typeof a === 'function' ? a() : a };
  };
  return { post, calls };
};
const google = (over = {}) => ({ id: 'ChIJ_1', displayName: { text: 'ASG Eye Hospital' }, formattedAddress: '1 Main Rd, Nashik', location: { latitude: 20.0, longitude: 73.78 }, types: ['hospital'], primaryType: 'hospital', primaryTypeDisplayName: { text: 'Hospital' }, businessStatus: 'OPERATIONAL', websiteUri: 'https://asg.example/', nationalPhoneNumber: '0253 1', rating: 4.4, userRatingCount: 321, googleMapsUri: 'https://maps.google.com/?cid=1', ...over });
const httpError = (status, body) => Object.assign(new Error('boom'), { response: { status, data: body } });
const base = { lat: 20, lng: 73.78, radiusMeters: 5000 };

describe('the requests sent to Google', () => {
  test('Nearby Search: a hard circle around the business, the allowed types, 20 results, and ONLY the fields Odito uses', async () => {
    const c = fakeClient({ places: [google()] });
    const r = await searchPlacesAround({ ...base, types: ['hospital', 'doctor'], client: c });
    assert.equal(c.calls.length, 1);
    assert.equal(c.calls[0].url, 'places:searchNearby');
    assert.deepEqual(c.calls[0].body, { includedTypes: ['hospital', 'doctor'], maxResultCount: 20, languageCode: 'en', locationRestriction: { circle: { center: { latitude: 20, longitude: 73.78 }, radius: 5000 } } });
    const mask = c.calls[0].headers['X-Goog-FieldMask'].split(',');
    for (const f of ['places.id', 'places.displayName', 'places.location', 'places.types', 'places.websiteUri', 'places.rating', 'places.userRatingCount', 'places.businessStatus', 'places.googleMapsUri']) assert.ok(mask.includes(f), f);
    assert.ok(!mask.some((f) => /photo|review|editorial|opening/i.test(f)), 'no photos, reviews or hours: they cost more and are not used');
    assert.equal(r.places.length, 1);
  });

  test('Text Search: the project\'s own words, a circle the results are BIASED towards (not restricted)', async () => {
    const c = fakeClient({ places: [] });
    await searchPlacesAround({ ...base, query: 'eye hospital', client: c });
    assert.equal(c.calls[0].url, 'places:searchText');
    assert.deepEqual(c.calls[0].body, { textQuery: 'eye hospital', maxResultCount: 20, languageCode: 'en', locationBias: { circle: { center: { latitude: 20, longitude: 73.78 }, radius: 5000 } } });
    assert.ok(!('locationRestriction' in c.calls[0].body));
  });

  test('a bad request is refused BEFORE anything is sent', async () => {
    const c = fakeClient({ places: [] });
    for (const args of [
      { ...base, types: ['hospital'], radiusMeters: 0 }, { ...base, types: ['hospital'], radiusMeters: PLACES_MAX_RADIUS_M + 1 }, { ...base, types: ['hospital'], radiusMeters: NaN },
      { ...base, types: ['hospital'], lat: 91 }, { ...base, types: ['hospital'], lng: 'x' }, { ...base }, { ...base, types: [] },
    ]) {
      const err = await searchPlacesAround({ ...args, client: c }).catch((e) => e);
      assert.equal(err.code, PLACES_ERROR.INVALID_REQUEST, JSON.stringify(args));
    }
    assert.equal(c.calls.length, 0);
  });
});

describe('what comes back', () => {
  test('normalized: only what Google returned, missing things are null (never a made-up website, rating or category)', async () => {
    const c = fakeClient({ places: [google(), { id: 'ChIJ_2', displayName: { text: 'Bare Clinic' } }] });
    const { places } = await searchPlacesAround({ ...base, types: ['doctor'], client: c });
    assert.deepEqual([places[0].placeId, places[0].website, places[0].rating, places[0].reviewCount, places[0].primaryTypeLabel, places[0].mapsUrl], ['ChIJ_1', 'https://asg.example/', 4.4, 321, 'Hospital', 'https://maps.google.com/?cid=1']);
    assert.deepEqual(places[1], { placeId: 'ChIJ_2', name: 'Bare Clinic', address: null, lat: null, lng: null, types: [], primaryType: null, primaryTypeLabel: null, businessStatus: null, website: null, phone: null, rating: null, reviewCount: null, mapsUrl: null });
  });
  test('a place with no id or no name is dropped; duplicates inside one answer are merged', () => {
    assert.equal(normalizeNearbyPlace({ displayName: { text: 'x' } }), null);
    assert.equal(normalizeNearbyPlace({ id: 'a' }), null);
  });
  test('an empty answer ({}) is "no results", not an error; exactly 20 means "there may be more"', async () => {
    assert.deepEqual(await searchPlacesAround({ ...base, types: ['doctor'], client: fakeClient({}) }), { places: [], capped: false });
    const twenty = Array.from({ length: 20 }, (_, i) => google({ id: `P${i}` }));
    assert.equal((await searchPlacesAround({ ...base, types: ['doctor'], client: fakeClient({ places: twenty }) })).capped, true);
    const nineteen = twenty.slice(0, 19);
    assert.equal((await searchPlacesAround({ ...base, types: ['doctor'], client: fakeClient({ places: nineteen }) })).capped, false);
  });
  test('a malformed answer is BAD_RESPONSE', async () => {
    for (const data of [{ places: 'x' }, [], 'nope']) {
      const err = await searchPlacesAround({ ...base, types: ['doctor'], client: fakeClient(data) }).catch((e) => e);
      assert.equal(err.code, PLACES_ERROR.BAD_RESPONSE);
    }
  });
});

describe('failures become typed errors (nothing raw)', () => {
  const code = async (e) => (await searchPlacesAround({ ...base, types: ['doctor'], client: fakeClient(e) }).catch((x) => x)).code;
  test('invalid key, disabled API / blocked key, billing, quota', async () => {
    assert.equal(await code(httpError(400, { error: { status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }], message: 'API key not valid' } })), PLACES_ERROR.KEY_INVALID);
    assert.equal(await code(httpError(403, { error: { status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }], message: 'Places API (New) has not been used' } })), PLACES_ERROR.ACCESS_DENIED);
    assert.equal(await code(httpError(403, { error: { details: [{ reason: 'BILLING_DISABLED' }], message: 'billing' } })), PLACES_ERROR.BILLING_REQUIRED);
    assert.equal(await code(httpError(429, { error: { status: 'RESOURCE_EXHAUSTED' } })), PLACES_ERROR.RATE_LIMITED);
  });
  test('an unreachable network is UNAVAILABLE; a timeout is TIMEOUT', async () => {
    assert.equal(await code(Object.assign(new Error('x'), { code: 'ENOTFOUND' })), PLACES_ERROR.UNAVAILABLE);
    assert.equal(await code(Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ECONNABORTED' })), PLACES_ERROR.TIMEOUT);
  });
  test('a missing key is NOT_CONFIGURED and says nothing about the key', async () => {
    const saved = process.env.GOOGLE_PLACES_API_KEY; delete process.env.GOOGLE_PLACES_API_KEY;
    try {
      const err = await searchPlacesAround({ ...base, types: ['doctor'] }).catch((e) => e);
      assert.ok(err instanceof PlacesError);
      assert.equal(err.code, PLACES_ERROR.NOT_CONFIGURED);
    } finally { if (saved !== undefined) process.env.GOOGLE_PLACES_API_KEY = saved; }
  });
});

describe('no result cache (Google\'s terms), only sharing of simultaneous identical calls', () => {
  test('two identical calls in flight make ONE request; a later identical call asks Google again', async () => {
    let n = 0;
    const slow = { post: async () => { n += 1; await new Promise((r) => setTimeout(r, 30)); return { status: 200, data: { places: [google()] } }; } };
    const [a, b] = await Promise.all([searchPlacesAround({ ...base, types: ['doctor'], client: slow }), searchPlacesAround({ ...base, types: ['doctor'], client: slow })]);
    assert.equal(n, 1);
    assert.equal(a, b);
    await searchPlacesAround({ ...base, types: ['doctor'], client: slow });
    assert.equal(n, 2, 'nothing was kept from the first answer');
  });
});
