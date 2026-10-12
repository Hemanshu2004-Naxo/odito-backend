import { describe, test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

import { searchBusinessCandidatesController, toBusinessCandidate } from './externalController.js';
import { clearPlacesCache } from '../../../services/googlePlacesService.js';

/**
 * POST /external/search-businesses contract: validation, the stable response
 * schema, and - the regression this guards - upstream failures must come back
 * as non-2xx with a code, never as `200 { data: [] }`.
 * Google is mocked at the axios layer; NO live request is made.
 */

const FAKE_KEY = 'AIzaFAKE_CONTROLLER_KEY_never_in_responses';

const mockRes = () => ({
  statusCode: 200, body: null, headers: {},
  status(c) { this.statusCode = c; return this; },
  json(p) { this.body = p; return this; },
  set(k, v) { this.headers[k] = v; return this; }
});

let postImpl;
let logged;

const googleError = (status, body) => {
  const e = new Error(`Request failed with status code ${status}`);
  e.response = { status, data: body };
  return e;
};

const run = async (body) => {
  const res = mockRes();
  await searchBusinessCandidatesController({ body }, res);
  return res;
};

beforeEach(() => {
  process.env.GOOGLE_PLACES_API_KEY = FAKE_KEY;
  clearPlacesCache();
  postImpl = async () => ({ status: 200, data: {} });
  mock.method(axios, 'create', () => ({ post: (...a) => postImpl(...a) }));
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error']) {
    mock.method(console, level, (...args) => { logged.push(args.join(' ')); });
  }
});

afterEach(() => mock.restoreAll());

describe('searchBusinessCandidatesController - input validation', () => {
  test('rejects a missing query', async () => {
    const res = await run({});
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'INVALID_QUERY');
  });

  test('rejects a too-short query', async () => {
    assert.equal((await run({ query: ' a ' })).statusCode, 400);
  });

  test('rejects a non-string query (object injection)', async () => {
    assert.equal((await run({ query: { $ne: '' } })).statusCode, 400);
  });

  test('rejects an over-long query without calling Google', async () => {
    let called = false;
    postImpl = async () => { called = true; return { status: 200, data: {} }; };
    const res = await run({ query: 'x'.repeat(500) });
    assert.equal(res.statusCode, 400);
    assert.equal(called, false);
  });

  test('trims and collapses whitespace before searching', async () => {
    let sent;
    postImpl = async (_u, body) => { sent = body.textQuery; return { status: 200, data: {} }; };
    await run({ query: '  sapphire   digital  agency ' });
    assert.equal(sent, 'sapphire digital agency');
  });
});

describe('searchBusinessCandidatesController - success', () => {
  test('returns the stable schema, not the raw Google payload', async () => {
    postImpl = async () => ({
      status: 200,
      data: {
        places: [{
          id: 'ChIJabc', name: 'places/ChIJabc',
          displayName: { text: 'Sapphire Digital Agency' },
          formattedAddress: '1 Main St, Nashik',
          location: { latitude: 19.9, longitude: 73.7 },
          businessStatus: 'OPERATIONAL',
          websiteUri: 'https://www.sapphiredigitalagency.com/',
          internationalPhoneNumber: '+91 99',
          somethingInternal: { secret: 'raw' }
        }]
      }
    });

    const res = await run({ query: 'sapphire digital agency' });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.deepEqual(res.body.data[0], {
      placeId: 'ChIJabc',
      name: 'Sapphire Digital Agency',
      formattedAddress: '1 Main St, Nashik',
      address: '1 Main St, Nashik',
      location: { latitude: 19.9, longitude: 73.7 },
      businessStatus: 'OPERATIONAL',
      website: 'https://www.sapphiredigitalagency.com/',
      phone: '+91 99',
      source: 'google_places'
    });
    assert.equal('requiresGoogleConnection' in res.body.data[0], false, 'public Places discovery must not require a Google connection');
    assert.ok(!JSON.stringify(res.body).includes('somethingInternal'));
    assert.ok(res.headers['X-Request-Id']);
  });

  test('a successful search with zero matches is 200 with an empty list', async () => {
    const res = await run({ query: 'no such business anywhere' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data, []);
    assert.equal(res.body.meta.count, 0);
  });

  test('caps results at 4 and never auto-selects', async () => {
    postImpl = async () => ({
      status: 200,
      data: { places: Array.from({ length: 5 }, (_, i) => ({ id: `ChIJ${i}`, name: `places/ChIJ${i}`, displayName: { text: `Biz ${i}` }, formattedAddress: 'addr' })) }
    });
    const res = await run({ query: 'biz' });
    assert.equal(res.body.data.length, 4);
    assert.equal('selected' in res.body, false);
  });

  test('location is null (not invented) when Google gives no coordinates', () => {
    assert.equal(toBusinessCandidate({ placeId: 'p', name: 'n', address: '', lat: null, lng: null }).location, null);
  });
});

describe('searchBusinessCandidatesController - upstream failures are never "no results"', () => {
  const cases = [
    ['403 PERMISSION_DENIED (the observed Odito failure)', () => googleError(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } }), 503, 'PLACES_ACCESS_DENIED'],
    ['invalid API key', () => googleError(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid', details: [{ reason: 'API_KEY_INVALID' }] } }), 503, 'PLACES_KEY_INVALID'],
    ['billing disabled', () => googleError(403, { error: { status: 'PERMISSION_DENIED', message: 'requires billing', details: [{ reason: 'BILLING_DISABLED' }] } }), 503, 'PLACES_BILLING_REQUIRED'],
    ['rate limited', () => googleError(429, { error: { status: 'RESOURCE_EXHAUSTED' } }), 429, 'PLACES_RATE_LIMITED'],
    ['upstream 500', () => googleError(500, { error: { status: 'INTERNAL' } }), 502, 'PLACES_UNAVAILABLE'],
    ['timeout', () => Object.assign(new Error('timeout of 8000ms exceeded'), { code: 'ECONNABORTED' }), 504, 'PLACES_TIMEOUT']
  ];

  for (const [label, makeErr, status, code] of cases) {
    test(`${label} -> HTTP ${status} ${code}`, async () => {
      postImpl = async () => { throw makeErr(); };
      const res = await run({ query: 'sapphire digital agency' });
      assert.equal(res.statusCode, status);
      assert.equal(res.body.success, false);
      assert.equal(res.body.code, code);
      assert.equal('data' in res.body, false, 'a failure must not carry a results array');
    });
  }

  test('missing API key -> 503 PLACES_NOT_CONFIGURED', async () => {
    delete process.env.GOOGLE_PLACES_API_KEY;
    const res = await run({ query: 'sapphire digital agency' });
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, 'PLACES_NOT_CONFIGURED');
  });

  test('malformed Google response -> 502 PLACES_BAD_RESPONSE', async () => {
    postImpl = async () => ({ status: 200, data: { places: {} } });
    const res = await run({ query: 'sapphire digital agency' });
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.code, 'PLACES_BAD_RESPONSE');
  });

  test('error responses expose no keys, upstream messages or stack traces; logs hold no key', async () => {
    postImpl = async () => { throw googleError(403, { error: { status: 'PERMISSION_DENIED', message: `project 1234567 denied key ${FAKE_KEY}` } }); };
    const res = await run({ query: 'sapphire digital agency' });

    const wire = JSON.stringify(res.body);
    assert.ok(!wire.includes(FAKE_KEY));
    assert.ok(!wire.includes('1234567'));
    assert.ok(!/stack|at .*\.js/i.test(wire));
    assert.deepEqual(Object.keys(res.body).sort(), ['code', 'message', 'success']);
    assert.ok(!logged.join('\n').includes(FAKE_KEY), 'API key leaked into logs');
  });
});
