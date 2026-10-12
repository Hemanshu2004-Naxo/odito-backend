import { describe, test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import axios from 'axios';
import { OAuth2Client } from 'google-auth-library';

dotenv.config();

import SeoProject from '../model/SeoProject.js';
import GoogleConnection from '../model/GoogleConnection.js';
import {
  getBusinessProfileAccountsController,
  getBusinessProfileLocationsController,
  gbpDiscoveryErrorResponse
} from './businessProfileController.js';

/**
 * Authenticated GBP account/location discovery (separate from public Places
 * discovery): connection gating, token refresh, pagination, and error codes.
 * Models, the OAuth refresh and the Google HTTP client are mocked - NO
 * database and NO request to Google.
 */

const USER = 'user-1';
const PROJECT = 'project-1';
const SECRET_TOKEN = 'ya29.SECRET_ACCESS_TOKEN_never_logged';
const NEW_TOKEN = 'ya29.REFRESHED_TOKEN';

const mockRes = () => ({
  statusCode: 200, body: null,
  status(c) { this.statusCode = c; return this; },
  json(p) { this.body = p; return this; }
});

let seq = 0;
let connection;
let clientCalls;   // { baseURL, authorization } per axios.create
let getImpl;       // (url, config) => Promise
let dbWrites;      // GoogleConnection.findByIdAndUpdate payloads
let refreshImpl;
let refreshCalls;
let logged;
let savedGbpDebug;

const makeConnection = (over = {}) => ({
  _id: `conn-${++seq}`,                 // unique per test: the service caches by connection id
  refresh_token: 'refresh-xyz',
  access_token: SECRET_TOKEN,
  token_expires_at: new Date(Date.now() + 60 * 60 * 1000),
  status: 'active',
  ...over
});

const googleError = (status, body, config) => {
  const e = new Error(`Request failed with status code ${status}`);
  e.response = { status, data: body };
  if (config) e.config = config;
  return e;
};

beforeEach(() => {
  connection = makeConnection();
  clientCalls = [];
  dbWrites = [];
  refreshCalls = 0;
  getImpl = async () => ({ status: 200, data: {} });
  refreshImpl = async () => ({ credentials: { access_token: NEW_TOKEN, expiry_date: Date.now() + 3600_000 } });

  // A developer's .env may set GBP_DEBUG=true, which makes the service call
  // Google's tokeninfo endpoint with axios.get. Force it off AND make any
  // un-mocked axios.get fail loudly, so this suite can never reach Google.
  savedGbpDebug = process.env.GBP_DEBUG;
  process.env.GBP_DEBUG = 'false';
  mock.method(axios, 'get', async (url) => { throw new Error(`unexpected live axios.get in test: ${url}`); });

  mock.method(SeoProject, 'findById', async () => ({ user_id: USER }));
  mock.method(GoogleConnection, 'findActiveConnection', async () => connection);
  mock.method(GoogleConnection, 'findByIdAndUpdate', async (id, update) => { dbWrites.push({ id, update }); return { _id: id }; });
  mock.method(OAuth2Client.prototype, 'refreshAccessToken', async () => { refreshCalls++; return refreshImpl(); });
  mock.method(axios, 'create', (cfg) => {
    const entry = { baseURL: cfg.baseURL, authorization: cfg.headers?.Authorization };
    clientCalls.push(entry);
    return { get: (url, config) => getImpl(url, config, entry) };
  });

  logged = [];
  for (const level of ['log', 'info', 'warn', 'error']) {
    mock.method(console, level, (...args) => { logged.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); });
  }
});

afterEach(() => {
  mock.restoreAll();
  if (savedGbpDebug === undefined) delete process.env.GBP_DEBUG; else process.env.GBP_DEBUG = savedGbpDebug;
});

const req = (extra = {}) => ({ params: { projectId: PROJECT }, query: {}, user: { _id: USER }, ...extra });
const accounts = async () => { const res = mockRes(); await getBusinessProfileAccountsController(req(), res); return res; };
const locations = async (accountId = 'acc-1') => { const res = mockRes(); await getBusinessProfileLocationsController(req({ query: { accountId } }), res); return res; };

describe('GBP discovery - connection gating', () => {
  test('no GBP connection: accounts -> 400 GBP_CONNECTION_REQUIRED, Google never called', async () => {
    GoogleConnection.findActiveConnection.mock.mockImplementation(async () => null);
    const res = await accounts();
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'GBP_CONNECTION_REQUIRED');
    assert.equal(clientCalls.length, 0);
  });

  test('no GBP connection: locations -> 400 GBP_CONNECTION_REQUIRED', async () => {
    GoogleConnection.findActiveConnection.mock.mockImplementation(async () => null);
    const res = await locations();
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'GBP_CONNECTION_REQUIRED');
  });

  test('a project owned by someone else is rejected before any Google call', async () => {
    SeoProject.findById.mock.mockImplementation(async () => ({ user_id: 'someone-else' }));
    const res = await accounts();
    assert.equal(res.statusCode, 403);
    assert.equal(clientCalls.length, 0);
  });
});

describe('GBP discovery - pagination', () => {
  test('accounts: follows nextPageToken until exhausted', async () => {
    const seen = [];
    getImpl = async (_url, config) => {
      seen.push(config.params.pageToken);
      return config.params.pageToken === undefined
        ? { status: 200, data: { accounts: [{ name: 'accounts/1', displayName: 'One' }, { name: 'accounts/2', displayName: 'Two' }], nextPageToken: 'P2' } }
        : { status: 200, data: { accounts: [{ name: 'accounts/3', accountName: 'x' }] } };
    };
    const res = await accounts();
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data.map(a => a.accountId), ['1', '2', '3']);
    assert.deepEqual(seen, [undefined, 'P2']);
  });

  test('locations: requests pageSize 100 + readMask and follows every page', async () => {
    const calls = [];
    getImpl = async (url, config) => {
      calls.push({ url, ...config.params });
      const page = (n, token) => ({
        status: 200,
        data: {
          locations: Array.from({ length: 2 }, (_, i) => ({ name: `locations/${n}${i}`, title: `Loc ${n}${i}`, storefrontAddress: { addressLines: ['1 St'] }, websiteUri: 'https://x.test' })),
          ...(token ? { nextPageToken: token } : {})
        }
      });
      if (!config.params.pageToken) return page(1, 'T2');
      if (config.params.pageToken === 'T2') return page(2, 'T3');
      return page(3);
    };
    const res = await locations('acc-9');

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.length, 6, 'locations beyond the first page must not be dropped');
    assert.deepEqual(res.body.data.map(l => l.locationId), ['10', '11', '20', '21', '30', '31']);
    assert.equal(calls[0].url, '/accounts/acc-9/locations');
    assert.equal(calls[0].pageSize, 100);
    assert.ok(calls[0].readMask.includes('storefrontAddress'));
    assert.equal(calls.length, 3);
  });

  test('locations: an empty account is an empty list, not an error', async () => {
    getImpl = async () => ({ status: 200, data: {} });
    const res = await locations();
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data, []);
  });

  test('locations: stops at the page ceiling if Google keeps returning a token', async () => {
    let n = 0;
    getImpl = async () => { n++; return { status: 200, data: { locations: [{ name: `locations/${n}`, title: 't' }], nextPageToken: 'again' } }; };
    const res = await locations();
    assert.equal(res.statusCode, 200);
    assert.equal(n, 50);
  });
});

describe('GBP discovery - OAuth token handling', () => {
  test('a valid access token is used as-is (no refresh)', async () => {
    await accounts();
    assert.equal(refreshCalls, 0);
    assert.equal(clientCalls[0].authorization, `Bearer ${SECRET_TOKEN}`);
  });

  test('an expired access token is refreshed, persisted, and the NEW token is used', async () => {
    connection = makeConnection({ token_expires_at: new Date(Date.now() - 60_000) });
    getImpl = async () => ({ status: 200, data: { accounts: [{ name: 'accounts/1', displayName: 'One' }] } });

    const res = await accounts();

    assert.equal(res.statusCode, 200);
    assert.equal(refreshCalls, 1);
    assert.equal(clientCalls[0].authorization, `Bearer ${NEW_TOKEN}`);
    const write = dbWrites.find(w => w.update.$set?.token_expires_at);
    assert.ok(write, 'refreshed token expiry must be persisted');
  });

  test('refresh failure (revoked/invalid_grant) -> 401 GBP_RECONNECT_REQUIRED and connection marked expired', async () => {
    connection = makeConnection({ token_expires_at: new Date(Date.now() - 60_000) });
    refreshImpl = async () => { throw new Error('invalid_grant'); };

    const res = await accounts();

    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, 'GBP_RECONNECT_REQUIRED');
    assert.equal(clientCalls.length, 0, 'no Google call after a failed refresh');
    assert.ok(dbWrites.some(w => w.update.$set?.status === 'expired'));
  });

  test('a connection with no refresh token -> 401 GBP_RECONNECT_REQUIRED', async () => {
    connection = makeConnection({ refresh_token: null });
    const res = await locations();
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, 'GBP_RECONNECT_REQUIRED');
  });

  test('Google 401 on the API call -> 401 GBP_RECONNECT_REQUIRED', async () => {
    getImpl = async () => { throw googleError(401, { error: { status: 'UNAUTHENTICATED' } }); };
    const res = await accounts();
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, 'GBP_RECONNECT_REQUIRED');
  });
});

describe('GBP discovery - authorization failures', () => {
  test('403 on accounts -> 403 GBP_PERMISSION_DENIED', async () => {
    getImpl = async () => { throw googleError(403, { error: { status: 'PERMISSION_DENIED', message: 'no access' } }); };
    const res = await accounts();
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'GBP_PERMISSION_DENIED');
  });

  test('403 on locations is no longer flattened to a generic 500', async () => {
    getImpl = async () => { throw googleError(403, { error: { status: 'PERMISSION_DENIED' } }); };
    const res = await locations();
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'GBP_PERMISSION_DENIED');
  });

  test('403 SERVICE_DISABLED (Business Profile API not enabled in Cloud project) -> 503 GBP_API_NOT_ENABLED', async () => {
    getImpl = async () => { throw googleError(403, { error: { status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] } }); };
    const res = await locations();
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, 'GBP_API_NOT_ENABLED');
  });

  test('403 ACCESS_TOKEN_SCOPE_INSUFFICIENT -> 403 GBP_SCOPE_MISSING', async () => {
    getImpl = async () => { throw googleError(403, { error: { status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }); };
    const res = await accounts();
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'GBP_SCOPE_MISSING');
  });

  test('429 maps to 429 GBP_RATE_LIMITED; unknown failures stay 500 GBP_ERROR', () => {
    const limited = gbpDiscoveryErrorResponse({ response: { status: 429, data: {} } }, 'x');
    assert.equal(limited.httpStatus, 429);
    assert.equal(limited.body.code, 'GBP_RATE_LIMITED');
    const other = gbpDiscoveryErrorResponse(new Error('boom'), 'fallback msg');
    assert.equal(other.httpStatus, 500);
    assert.equal(other.body.message, 'fallback msg');
  });

  test('error bodies never include tokens or Google internals', async () => {
    getImpl = async () => { throw googleError(403, { error: { status: 'PERMISSION_DENIED', message: `denied ${SECRET_TOKEN}` } }); };
    const res = await accounts();
    assert.ok(!JSON.stringify(res.body).includes(SECRET_TOKEN));
  });
});

describe('GBP discovery - safe logging', () => {
  test('the Authorization header on a failed Google call is redacted in logs', async () => {
    getImpl = async () => {
      throw googleError(403, { error: { status: 'PERMISSION_DENIED' } }, {
        url: '/accounts', method: 'get', headers: { Authorization: `Bearer ${SECRET_TOKEN}` }
      });
    };
    await accounts();
    const out = logged.join('\n');
    assert.ok(out.length > 0);
    assert.ok(!out.includes(SECRET_TOKEN), 'access token leaked into logs');
  });

  test('refresh flow logs never contain the access or refresh token', async () => {
    connection = makeConnection({ token_expires_at: new Date(Date.now() - 60_000) });
    await accounts();
    const out = logged.join('\n');
    assert.ok(!out.includes(NEW_TOKEN), 'refreshed token leaked into logs');
    assert.ok(!out.includes('refresh-xyz'), 'refresh token leaked into logs');
  });
});
