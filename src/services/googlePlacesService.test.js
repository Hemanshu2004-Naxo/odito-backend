import { describe, test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

import {
  searchBusinesses,
  classifyPlacesError,
  clearPlacesCache,
  PlacesError,
  PLACES_ERROR
} from './googlePlacesService.js';

/**
 * Places API (New) Text Search: result normalization and error classification.
 * The Google HTTP client is mocked - NO request ever leaves the process.
 */

const FAKE_KEY = 'AIzaFAKE_TEST_KEY_must_never_be_logged_0123';

let posts;       // recorded { url, body, headers }
let postImpl;    // (url, body, config) => Promise
let logged;      // every console line emitted during a test

const googleError = (status, errBody, extra = {}) => {
  const e = new Error(`Request failed with status code ${status}`);
  e.response = { status, data: errBody };
  Object.assign(e, extra);
  return e;
};

beforeEach(() => {
  process.env.GOOGLE_PLACES_API_KEY = FAKE_KEY;
  clearPlacesCache();
  posts = [];
  postImpl = async () => ({ status: 200, data: {} });
  mock.method(axios, 'create', () => ({
    post: (url, body, config) => {
      posts.push({ url, body, headers: config?.headers });
      return postImpl(url, body, config);
    }
  }));
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error']) {
    mock.method(console, level, (...args) => { logged.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); });
  }
});

afterEach(() => {
  mock.restoreAll();
});

const place = (id, name, over = {}) => ({
  id,
  name: `places/${id}`,
  displayName: { text: name, languageCode: 'en' },
  formattedAddress: '1 Main St, Nashik, Maharashtra, India',
  location: { latitude: 19.99, longitude: 73.78 },
  businessStatus: 'OPERATIONAL',
  addressComponents: [
    { types: ['locality'], longText: 'Nashik', shortText: 'Nashik' },
    { types: ['administrative_area_level_1'], longText: 'Maharashtra', shortText: 'MH' },
    { types: ['country'], longText: 'India', shortText: 'in' }
  ],
  ...over
});

describe('searchBusinesses - success paths', () => {
  test('normalizes a Places API (New) response into the stable schema', async () => {
    postImpl = async () => ({ status: 200, data: { places: [place('ChIJabc', 'Sapphire Digital Agency', { websiteUri: 'https://x.test', internationalPhoneNumber: '+91 1' })] } });

    const out = await searchBusinesses('sapphire digital agency');

    assert.equal(out.length, 1);
    assert.deepEqual(
      { placeId: out[0].placeId, name: out[0].name, address: out[0].address, lat: out[0].lat, lng: out[0].lng, businessStatus: out[0].businessStatus, city: out[0].city, countryCode: out[0].countryCode },
      { placeId: 'ChIJabc', name: 'Sapphire Digital Agency', address: '1 Main St, Nashik, Maharashtra, India', lat: 19.99, lng: 73.78, businessStatus: 'OPERATIONAL', city: 'Nashik', countryCode: 'IN' }
    );
  });

  test('sends the text query, field mask and API key header Places API (New) requires', async () => {
    await searchBusinesses('sapphire', 'Nashik');

    assert.equal(posts[0].url, 'places:searchText');
    assert.equal(posts[0].body.textQuery, 'sapphire in Nashik');
    assert.match(posts[0].headers['X-Goog-FieldMask'], /places\.id/);
    assert.match(posts[0].headers['X-Goog-FieldMask'], /places\.displayName/);
    assert.match(posts[0].headers['X-Goog-FieldMask'], /places\.businessStatus/);
  });

  test('a valid query with zero matches resolves to an empty array (Google returns {})', async () => {
    postImpl = async () => ({ status: 200, data: {} });
    assert.deepEqual(await searchBusinesses('zzzz no such business'), []);
  });

  test('deduplicates results by place ID', async () => {
    postImpl = async () => ({ status: 200, data: { places: [place('ChIJ1', 'A'), place('ChIJ1', 'A again'), place('ChIJ2', 'B')] } });
    const out = await searchBusinesses('dup');
    assert.deepEqual(out.map(r => r.placeId), ['ChIJ1', 'ChIJ2']);
  });

  test('keeps a legitimate business that has no formatted address (service-area business)', async () => {
    postImpl = async () => ({ status: 200, data: { places: [place('ChIJsab', 'Service Area Co', { formattedAddress: undefined })] } });
    const out = await searchBusinesses('service area');
    assert.equal(out.length, 1);
    assert.equal(out[0].address, '');
  });

  test('falls back to the resource name when Google omits places.id', async () => {
    postImpl = async () => ({ status: 200, data: { places: [place(undefined, 'No Id Co', { name: 'places/ChIJfromName' })] } });
    const out = await searchBusinesses('no id');
    assert.equal(out[0].placeId, 'ChIJfromName');
  });

  test('serves a repeated query from cache (no second Google call)', async () => {
    postImpl = async () => ({ status: 200, data: { places: [place('ChIJc', 'Cached Co')] } });
    await searchBusinesses('cached co');
    await searchBusinesses('Cached Co');
    assert.equal(posts.length, 1);
  });
});

describe('searchBusinesses - failures are errors, never empty results', () => {
  test('missing API key -> PLACES_NOT_CONFIGURED, no request sent', async () => {
    delete process.env.GOOGLE_PLACES_API_KEY;
    await assert.rejects(() => searchBusinesses('anything'), (e) => e instanceof PlacesError && e.code === PLACES_ERROR.NOT_CONFIGURED);
    assert.equal(posts.length, 0);
  });

  test('bare 403 PERMISSION_DENIED (the Odito production symptom) -> PLACES_ACCESS_DENIED', async () => {
    postImpl = async () => { throw googleError(403, { error: { code: 403, message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } }); };
    await assert.rejects(() => searchBusinesses('sapphire digital agency'), (e) =>
      e.code === PLACES_ERROR.ACCESS_DENIED && e.upstreamStatus === 403 && e.upstreamReason === 'PERMISSION_DENIED' && /API key/.test(e.message));
  });

  test('invalid API key (400 API_KEY_INVALID) -> PLACES_KEY_INVALID', async () => {
    postImpl = async () => { throw googleError(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }); };
    await assert.rejects(() => searchBusinesses('x1'), (e) => e.code === PLACES_ERROR.KEY_INVALID);
  });

  test('billing disabled -> PLACES_BILLING_REQUIRED', async () => {
    postImpl = async () => { throw googleError(403, { error: { code: 403, message: 'This API method requires billing to be enabled.', status: 'PERMISSION_DENIED', details: [{ reason: 'BILLING_DISABLED' }] } }); };
    await assert.rejects(() => searchBusinesses('x2'), (e) => e.code === PLACES_ERROR.BILLING_REQUIRED);
  });

  test('API disabled / key restriction (403 SERVICE_DISABLED) -> PLACES_ACCESS_DENIED with reason kept for logs', async () => {
    postImpl = async () => { throw googleError(403, { error: { code: 403, message: 'Places API (New) has not been used in project 123 before or it is disabled.', status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] } }); };
    await assert.rejects(() => searchBusinesses('x3'), (e) => e.code === PLACES_ERROR.ACCESS_DENIED && e.upstreamReason === 'SERVICE_DISABLED');
  });

  test('other 400 -> PLACES_INVALID_REQUEST with the legacy "Invalid search request" text', async () => {
    postImpl = async () => { throw googleError(400, { error: { code: 400, message: 'Bad textQuery', status: 'INVALID_ARGUMENT' } }); };
    await assert.rejects(() => searchBusinesses('x4'), (e) => e.code === PLACES_ERROR.INVALID_REQUEST && /Invalid search request/.test(e.message));
  });

  test('429 is retried for transient errors then surfaces as PLACES_RATE_LIMITED with the real status', async () => {
    let n = 0;
    postImpl = async () => { n++; throw googleError(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota' } }); };
    await assert.rejects(
      () => searchBusinesses('x5', '', { retries: 2, retryDelayMs: 1 }),
      (e) => e.code === PLACES_ERROR.RATE_LIMITED && e.upstreamStatus === 429 && /quota exceeded/.test(e.message)
    );
    assert.equal(n, 2);
  });

  test('a transient 503 followed by success is retried and succeeds', async () => {
    let n = 0;
    postImpl = async () => {
      n++;
      if (n === 1) throw googleError(503, { error: { code: 503, status: 'UNAVAILABLE', message: 'try later' } });
      return { status: 200, data: { places: [place('ChIJr', 'Recovered Co')] } };
    };
    const out = await searchBusinesses('recover', '', { retries: 2, retryDelayMs: 1 });
    assert.equal(out[0].name, 'Recovered Co');
    assert.equal(n, 2);
  });

  test('non-transient errors are NOT retried', async () => {
    let n = 0;
    postImpl = async () => { n++; throw googleError(403, { error: { status: 'PERMISSION_DENIED', message: 'no' } }); };
    await assert.rejects(() => searchBusinesses('x6', '', { retries: 3, retryDelayMs: 1 }));
    assert.equal(n, 1);
  });

  test('upstream timeout (ECONNABORTED) -> PLACES_TIMEOUT', async () => {
    postImpl = async () => { const e = new Error('timeout of 8000ms exceeded'); e.code = 'ECONNABORTED'; throw e; };
    await assert.rejects(() => searchBusinesses('x7'), (e) => e.code === PLACES_ERROR.TIMEOUT);
  });

  test('network failure with no response -> PLACES_UNAVAILABLE', async () => {
    postImpl = async () => { const e = new Error('getaddrinfo ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; };
    await assert.rejects(() => searchBusinesses('x8'), (e) => e.code === PLACES_ERROR.UNAVAILABLE);
  });

  test('malformed Google response (places is not an array) -> PLACES_BAD_RESPONSE, not an empty list', async () => {
    postImpl = async () => ({ status: 200, data: { places: 'nope' } });
    await assert.rejects(() => searchBusinesses('x9'), (e) => e.code === PLACES_ERROR.BAD_RESPONSE);
  });

  test('non-object Google response body -> PLACES_BAD_RESPONSE', async () => {
    postImpl = async () => ({ status: 200, data: '<html>' });
    await assert.rejects(() => searchBusinesses('x10'), (e) => e.code === PLACES_ERROR.BAD_RESPONSE);
  });

  test('errors are not cached: a later success is not masked by an earlier failure', async () => {
    postImpl = async () => { throw googleError(403, { error: { status: 'PERMISSION_DENIED' } }); };
    await assert.rejects(() => searchBusinesses('flaky'));
    postImpl = async () => ({ status: 200, data: { places: [place('ChIJok', 'Now Works')] } });
    assert.equal((await searchBusinesses('flaky'))[0].name, 'Now Works');
  });
});

describe('searchBusinesses - safe logging', () => {
  test('logs correlation id, status, duration and candidate count - never the key or the query text', async () => {
    postImpl = async () => ({ status: 200, data: { places: [place('ChIJl', 'Log Co')] } });
    await searchBusinesses('super secret business name', '', { requestId: 'req-123' });

    const out = logged.join('\n');
    assert.match(out, /req-123/);
    assert.match(out, /"candidates":1/);
    assert.match(out, /"durationMs":\d+/);
    assert.match(out, /"credentialsConfigured":true/);
    assert.ok(!out.includes(FAKE_KEY), 'API key leaked into logs');
    assert.ok(!out.includes('super secret business name'), 'raw query leaked into logs');
  });

  test('failure logs carry the error code and upstream status but not the key', async () => {
    postImpl = async () => { throw googleError(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } }, { config: { headers: { 'X-Goog-Api-Key': FAKE_KEY } } }); };
    await assert.rejects(() => searchBusinesses('hidden query', '', { requestId: 'req-err' }));

    const out = logged.join('\n');
    assert.match(out, /req-err/);
    assert.match(out, /PLACES_ACCESS_DENIED/);
    assert.match(out, /"upstreamStatus":403/);
    assert.ok(!out.includes(FAKE_KEY), 'API key leaked into logs');
    assert.ok(!out.includes('hidden query'), 'raw query leaked into logs');
  });

  test('missing-key log reports credentialsConfigured:false without any secret', async () => {
    delete process.env.GOOGLE_PLACES_API_KEY;
    await assert.rejects(() => searchBusinesses('x'.repeat(5), '', { requestId: 'req-nokey' }));
    assert.match(logged.join('\n'), /"credentialsConfigured":false/);
  });
});

describe('classifyPlacesError', () => {
  test('passes an existing PlacesError through unchanged', () => {
    const e = new PlacesError(PLACES_ERROR.TIMEOUT, 'x');
    assert.equal(classifyPlacesError(e), e);
  });
});
