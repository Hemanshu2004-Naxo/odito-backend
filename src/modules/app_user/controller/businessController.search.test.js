import { describe, test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

import { searchBusiness } from './businessController.js';
import { clearPlacesCache } from '../../../services/googlePlacesService.js';

/**
 * POST /api/app_user/business/search - the endpoint behind the onboarding chat.
 *
 * Regression guarded here: every Places failure used to surface as
 * "Service temporarily unavailable" (or a bare 500) with no way for the UI to
 * tell a rate limit from a permission problem from a timeout - and the chat
 * answered all of them by re-asking for the business name. Google is mocked at
 * the axios layer; no live request is made.
 */

const FAKE_KEY = 'AIzaFAKE_ONBOARDING_KEY_never_in_responses';

const mockRes = () => ({
  statusCode: 200, body: null, headers: {},
  status(c) { this.statusCode = c; return this; },
  json(p) { this.body = p; return this; },
  set(k, v) { this.headers[k] = v; return this; }
});

let postImpl;
let logged;

const googleError = (status, body) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data: body } });
const place = (id, name) => ({ id, name: `places/${id}`, displayName: { text: name }, formattedAddress: '1 Main St, Nashik, India', location: { latitude: 19.9, longitude: 73.7 } });

const run = async (body) => {
  const res = mockRes();
  await searchBusiness({ body }, res);
  return res;
};

beforeEach(() => {
  process.env.GOOGLE_PLACES_API_KEY = FAKE_KEY;
  clearPlacesCache();
  postImpl = async () => ({ status: 200, data: {} });
  mock.method(axios, 'create', () => ({ post: (...a) => postImpl(...a) }));
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error']) {
    mock.method(console, level, (...args) => { logged.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); });
  }
});

afterEach(() => mock.restoreAll());

describe('searchBusiness (onboarding) - success paths', () => {
  test('returns ranked results', async () => {
    postImpl = async () => ({ status: 200, data: { places: [place('ChIJ1', 'Sapphire Digital Agency')] } });
    const res = await run({ businessName: 'Sapphire Digital Agency', businessLocation: 'Nashik' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.results.length, 1);
    assert.equal(res.body.data.results[0].name, 'Sapphire Digital Agency');
    assert.equal(res.body.data.results[0].placeId, 'ChIJ1');
    assert.ok(res.headers['X-Request-Id']);
  });

  test('a genuine zero-match search is 200 with an empty list (the ONLY case that may look like "no results")', async () => {
    const res = await run({ businessName: 'Zzyzx Nonexistent Co', businessLocation: 'Nashik' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data.results, []);
    assert.equal(res.body.data.hasResults, false);
  });
});

describe('searchBusiness (onboarding) - failures are distinguishable and never look like "no results"', () => {
  const cases = [
    ['403 permission denied', () => googleError(403, { error: { status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } }), 503, 'PLACES_ACCESS_DENIED', 'API_CONFIGURATION_ERROR'],
    ['invalid API key', () => googleError(400, { error: { status: 'INVALID_ARGUMENT', message: 'API key not valid', details: [{ reason: 'API_KEY_INVALID' }] } }), 503, 'PLACES_KEY_INVALID', 'API_CONFIGURATION_ERROR'],
    ['billing disabled', () => googleError(403, { error: { status: 'PERMISSION_DENIED', message: 'requires billing', details: [{ reason: 'BILLING_DISABLED' }] } }), 503, 'PLACES_BILLING_REQUIRED', 'API_CONFIGURATION_ERROR'],
    ['429 rate limited', () => googleError(429, { error: { status: 'RESOURCE_EXHAUSTED' } }), 429, 'PLACES_RATE_LIMITED', 'RATE_LIMIT_EXCEEDED'],
    ['500 upstream', () => googleError(500, { error: { status: 'INTERNAL' } }), 502, 'PLACES_UNAVAILABLE', 'SEARCH_UNAVAILABLE'],
    ['timeout', () => Object.assign(new Error('timeout of 8000ms exceeded'), { code: 'ECONNABORTED' }), 504, 'PLACES_TIMEOUT', 'SEARCH_TIMEOUT'],
    ['network failure', () => Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }), 502, 'PLACES_UNAVAILABLE', 'SEARCH_UNAVAILABLE'],
  ];

  for (const [label, makeErr, status, code, legacyKey] of cases) {
    test(`${label} -> HTTP ${status} ${code}`, async () => {
      postImpl = async () => { throw makeErr(); };
      const res = await run({ businessName: 'Sapphire Digital Agency', businessLocation: 'Nashik' });
      assert.equal(res.statusCode, status);
      assert.equal(res.body.success, false);
      assert.equal(res.body.code, code);
      assert.equal(res.body.error, legacyKey);
      assert.equal('data' in res.body, false, 'a failure must not carry a results array');
    });
  }

  test('missing API key -> 503 PLACES_NOT_CONFIGURED', async () => {
    delete process.env.GOOGLE_PLACES_API_KEY;
    const res = await run({ businessName: 'Sapphire Digital Agency', businessLocation: 'Nashik' });
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, 'PLACES_NOT_CONFIGURED');
  });

  test('malformed Google response -> 502, not an empty list', async () => {
    postImpl = async () => ({ status: 200, data: { places: 'nope' } });
    const res = await run({ businessName: 'Sapphire Digital Agency', businessLocation: 'Nashik' });
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.success, false);
  });

  test('an unexpected (non-Places) exception is a generic 500 without internals', async () => {
    postImpl = async () => { throw new TypeError('Cannot read properties of undefined (reading "secret")'); };
    // classifyPlacesError turns this into PLACES_UNAVAILABLE; still must not leak the message
    const res = await run({ businessName: 'Sapphire Digital Agency', businessLocation: 'Nashik' });
    assert.ok(res.statusCode >= 500);
    assert.ok(!JSON.stringify(res.body).includes('secret'));
  });

  test('responses and logs expose no API key, upstream message, project id or stack', async () => {
    postImpl = async () => { throw googleError(403, { error: { status: 'PERMISSION_DENIED', message: `project 1234567 denied key ${FAKE_KEY}` } }); };
    const res = await run({ businessName: 'Sapphire Digital Agency', businessLocation: 'Nashik' });
    const wire = JSON.stringify(res.body);
    assert.ok(!wire.includes(FAKE_KEY));
    assert.ok(!wire.includes('1234567'));
    assert.ok(!/API key/i.test(wire), 'old copy leaked "API key" wording to end users');
    assert.ok(!/Service temporarily unavailable/.test(wire), 'old catch-all copy must be gone');
    assert.deepEqual(Object.keys(res.body).sort(), ['code', 'error', 'message', 'success']);
    const logs = logged.join('\n');
    assert.ok(!logs.includes(FAKE_KEY), 'API key leaked into logs');
    assert.ok(!logs.includes('Sapphire Digital Agency'), 'raw query leaked into logs');
  });
});

describe('searchBusiness (onboarding) - validation', () => {
  test('requires a name and a location', async () => {
    assert.equal((await run({ businessLocation: 'Nashik' })).statusCode, 400);
    assert.equal((await run({ businessName: 'x', businessLocation: '  ' })).statusCode, 400);
    assert.equal((await run(undefined)).statusCode, 400);
  });

  test('rejects non-string input (object injection) without calling Google', async () => {
    let called = false;
    postImpl = async () => { called = true; return { status: 200, data: {} }; };
    assert.equal((await run({ businessName: { $ne: '' }, businessLocation: 'Nashik' })).statusCode, 400);
    assert.equal(called, false);
  });

  test('rejects over-long input without calling Google', async () => {
    let called = false;
    postImpl = async () => { called = true; return { status: 200, data: {} }; };
    const res = await run({ businessName: 'x'.repeat(500), businessLocation: 'Nashik' });
    assert.equal(res.statusCode, 400);
    assert.equal(called, false);
  });
});
