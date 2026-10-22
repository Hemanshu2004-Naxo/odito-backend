import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import PendingMetaConnection from '../model/PendingMetaConnection.js';
import crypto from 'crypto';
import { signOAuthState, verifyOAuthState } from '../../../utils/oauthState.js';
import MetaOAuthState from '../model/MetaOAuthState.js';
import { verifyMetaStateToken } from '../service/metaOAuthStateService.js';
import { mintState, mintStateWith } from '../testSupport/metaState.js';
import { startMetaConnection, handleMetaCallback } from './metaOAuthController.js';
import { buildAuthorizationUrl, META_OAUTH_SCOPES } from '../service/metaOAuthService.js';
import metaApiService, { graphApiBaseUrl, oauthDialogBaseUrl } from '../service/metaApiService.js';

/**
 * Phase 1 — Meta OAuth foundation. Real controller functions (the actual
 * production code the real Express routes dispatch to), mock req/res
 * objects standing in for Express — same established convention as
 * taskAuthorization.e2e.test.js ("no supertest/HTTP layer exists anywhere
 * in this repo"). Real MongoDB for project-ownership fixtures.
 *
 * NOT covered here (verified live instead, against the real running
 * server and Meta's real API, documented in the Phase 1 report): the
 * unauthenticated/missing-projectId/unauthorized-projectId HTTP-level
 * rejections (that's validateProjectAccess()'s own, already-established
 * behavior — re-tested at the route level via curl, not re-proven here),
 * and the "invalid code" token-exchange path (requires a real network
 * call to Meta — undesirable in an automated suite; verified live and
 * captured in the report instead).
 */

let mongoAvailable = false;

before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch {
    mongoAvailable = false;
  }
});

after(async () => {
  if (mongoAvailable) await mongoose.connection.close();
});

function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    redirectedTo: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    redirect(url) { this.redirectedTo = url; return this; },
  };
  return res;
}

describe('oauthState — signOAuthState / verifyOAuthState (pure functions, provider-agnostic)', () => {
  test('valid round-trip preserves the payload', () => {
    const state = signOAuthState({ provider: 'meta', purpose: 'social_meta', projectId: 'abc', userId: 'def' });
    const decoded = verifyOAuthState(state);
    assert.equal(decoded.provider, 'meta');
    assert.equal(decoded.purpose, 'social_meta');
    assert.equal(decoded.projectId, 'abc');
    assert.equal(decoded.userId, 'def');
  });

  test('malformed state throws', () => {
    assert.throws(() => verifyOAuthState('not-a-real-jwt-at-all'));
  });

  test('tampered signature throws', () => {
    const state = signOAuthState({ provider: 'meta', purpose: 'social_meta', projectId: 'abc', userId: 'def' });
    assert.throws(() => verifyOAuthState(state + 'tampered'));
  });

  test('expired state throws', () => {
    const state = jwt.sign({ provider: 'meta', purpose: 'social_meta' }, process.env.JWT_SECRET, { expiresIn: '-1s' });
    assert.throws(() => verifyOAuthState(state));
  });

  test('Google\'s existing state signing still works unchanged (regression)', async () => {
    const { signGoogleVisibilityState, verifyGoogleVisibilityState } = await import('../../../utils/oauthState.js');
    const state = signGoogleVisibilityState({ purpose: 'google_visibility', projectId: 'x', userId: 'y' });
    const decoded = verifyGoogleVisibilityState(state);
    assert.equal(decoded.purpose, 'google_visibility');
  });
});

describe('startMetaConnection — real controller, mock req/res', () => {
  test('returns a Meta authorization URL with correctly-shaped signed state', async () => {
    const req = {
      query: {},
      projectId: '6a5870ee2f64598f841afdb7',
      user: { _id: '6a55e67900d0dc76c8169db5' },
    };
    const res = mockRes();

    await startMetaConnection(req, res);

    assert.equal(res.statusCode, null); // res.json() path, no explicit status = 200 default
    assert.equal(res.body.success, true);
    // Meta OAuth URL fix: the authorization DIALOG lives on
    // www.facebook.com, never graph.facebook.com (that host has no
    // /dialog/oauth resource — see metaApiService.js's oauthDialogBaseUrl
    // comment for the real Meta error this produced before the fix).
    assert.ok(res.body.data.url.startsWith('https://www.facebook.com/'));
    assert.ok(!res.body.data.url.startsWith('https://graph.facebook.com/'));
    assert.ok(res.body.data.url.includes('/dialog/oauth'));

    const url = new URL(res.body.data.url);
    const token = url.searchParams.get('state');
    const decoded = verifyMetaStateToken(token);
    assert.equal(decoded.provider, 'meta');
    assert.equal(decoded.purpose, 'social_meta');
    // the URL (and anyone who reads it) learns neither the user nor the project: only an unpredictable nonce is in it
    assert.equal('projectId' in decoded, false);
    assert.equal('userId' in decoded, false);
    assert.ok(!token.includes(req.projectId) && !JSON.stringify(decoded).includes(req.user._id));
    const record = await MetaOAuthState.findOne({ nonce_hash: crypto.createHash('sha256').update(decoded.nonce).digest('hex') }).lean();
    assert.equal(String(record.project_id), req.projectId);
    assert.equal(String(record.user_id), req.user._id);
    assert.equal(record.usedAt, null);
    await MetaOAuthState.deleteOne({ _id: record._id });

    // Never the app secret, anywhere in this response.
    assert.ok(!res.body.data.url.includes(process.env.META_APP_SECRET));
    assert.ok(!JSON.stringify(res.body).includes(process.env.META_APP_SECRET));
    // Never an access token — this URL is built before any consent/exchange happens.
    assert.ok(!res.body.data.url.includes('access_token'));
  });

  test('no reconnect query param -> no auth_type on the generated URL (ordinary Connect never forces re-consent)', async () => {
    const req = { query: {}, projectId: '6a5870ee2f64598f841afdb7', user: { _id: '6a55e67900d0dc76c8169db5' } };
    const res = mockRes();
    await startMetaConnection(req, res);
    const url = new URL(res.body.data.url);
    assert.equal(url.searchParams.has('auth_type'), false);
  });

  test('?reconnect=true -> the generated URL includes auth_type=rerequest, forcing Meta to re-show the permissions dialog', async () => {
    const req = { query: { reconnect: 'true' }, projectId: '6a5870ee2f64598f841afdb7', user: { _id: '6a55e67900d0dc76c8169db5' } };
    const res = mockRes();
    await startMetaConnection(req, res);
    const url = new URL(res.body.data.url);
    assert.equal(url.searchParams.get('auth_type'), 'rerequest');
  });

  test('a truthy-looking but non-"true" reconnect value is NOT treated as reconnect (strict comparison, no accidental forced re-consent)', async () => {
    const req = { query: { reconnect: '1' }, projectId: '6a5870ee2f64598f841afdb7', user: { _id: '6a55e67900d0dc76c8169db5' } };
    const res = mockRes();
    await startMetaConnection(req, res);
    const url = new URL(res.body.data.url);
    assert.equal(url.searchParams.has('auth_type'), false);
  });
});

describe('Meta OAuth authorization URL construction (www.facebook.com vs graph.facebook.com fix)', () => {
  const testUrl = buildAuthorizationUrl({ redirectUri: process.env.META_REDIRECT_URI, state: 'test-state-value' });
  const parsed = new URL(testUrl);
  const expectedVersion = process.env.META_GRAPH_API_VERSION || 'v21.0';

  test('1: authorization URL uses https://www.facebook.com/{version}/dialog/oauth', () => {
    assert.equal(parsed.origin, 'https://www.facebook.com');
    assert.equal(parsed.pathname, `/${expectedVersion}/dialog/oauth`);
  });

  test('2: authorization URL does NOT use graph.facebook.com', () => {
    assert.ok(!testUrl.includes('graph.facebook.com'));
  });

  test('3: client_id is correct', () => {
    assert.equal(parsed.searchParams.get('client_id'), process.env.META_APP_ID);
  });

  test('4: redirect_uri is correctly encoded/decoded (round-trips to the exact configured value)', () => {
    assert.equal(parsed.searchParams.get('redirect_uri'), process.env.META_REDIRECT_URI);
    // The raw query string must contain the URL-encoded form, not a bare "://".
    assert.ok(testUrl.includes(encodeURIComponent(process.env.META_REDIRECT_URI)));
  });

  test('5: response_type=code', () => {
    assert.equal(parsed.searchParams.get('response_type'), 'code');
  });

  test('6: state is passed through unchanged (this function does not re-sign or mutate it)', () => {
    assert.equal(parsed.searchParams.get('state'), 'test-state-value');
  });

  test('7: scopes are exactly the correct namespace for the Facebook-Login flow this app uses', () => {
    const requestedScopes = parsed.searchParams.get('scope').split(',');
    assert.deepEqual(requestedScopes, META_OAUTH_SCOPES);
    assert.deepEqual(requestedScopes, [
      'pages_show_list',
      'pages_read_engagement',
      'pages_manage_posts',
      'business_management',
      'instagram_basic',
      'instagram_manage_insights',
      'instagram_content_publish',
    ]);
    // instagram_business_* is the Instagram-LOGIN namespace
    // (www.instagram.com/oauth/authorize) — confirmed via Meta's own docs
    // to be invalid on www.facebook.com/dialog/oauth, which is the host
    // this app's OAuth flow actually uses. Meta rejected these outright
    // ("Invalid Scopes: instagram_business_basic,
    // instagram_business_manage_insights") when they were requested here.
    assert.ok(!requestedScopes.includes('instagram_business_basic'));
    assert.ok(!requestedScopes.includes('instagram_business_manage_insights'));
    // read_insights does not appear in Meta's documented scope list for
    // this flow — must not be requested.
    assert.ok(!requestedScopes.includes('read_insights'));
  });

  test('8: META_APP_SECRET never appears in the generated URL', () => {
    assert.ok(!testUrl.includes(process.env.META_APP_SECRET));
  });

  test('9: access_token never appears in the generated URL', () => {
    assert.ok(!testUrl.includes('access_token'));
  });

  test('10: META_GRAPH_API_VERSION is the single version source for BOTH base URLs', () => {
    assert.ok(oauthDialogBaseUrl().includes(expectedVersion));
    assert.ok(graphApiBaseUrl().includes(expectedVersion));
    // Same version substring in both — proves neither hardcodes a second, independent literal.
    const oauthVersion = new URL(oauthDialogBaseUrl()).pathname.replace('/', '');
    const graphVersion = new URL(graphApiBaseUrl()).pathname.replace('/', '');
    assert.equal(oauthVersion, graphVersion);
  });

  test('11: existing Graph API calls still use https://graph.facebook.com/{version} (unchanged)', () => {
    assert.equal(graphApiBaseUrl(), `https://graph.facebook.com/${expectedVersion}`);
  });
});

describe('handleMetaCallback — real controller + real Mongo project fixtures', () => {
  let userA, userB, projectA;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    userA = new mongoose.Types.ObjectId();
    userB = new mongoose.Types.ObjectId();
    projectA = await SeoProject.create({
      user_id: userA,
      project_name: `Meta Phase 1 Test Project ${Date.now()}`,
      main_url: 'https://example.com',
      seo_scope: 'local',
      keywords: ['meta phase 1 test'],
    });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    await SeoProject.deleteOne({ _id: projectA._id });
    await PendingMetaConnection.deleteMany({ project_id: projectA._id });
  });

  // Root-cause regression coverage: PendingMetaConnection.scopes used to
  // be set to META_OAUTH_SCOPES (the REQUESTED list) unconditionally,
  // regardless of what Meta actually granted — this is why every Page
  // connected before pages_manage_posts existed still lacks it: the app
  // never even checked, so nothing could ever detect or surface the gap.
  // metaApiService.requestAbsolute (token exchange) and metaApiService.request
  // (/me/permissions) are substituted for one real, full run of the real
  // handleMetaCallback — same technique metaPageService.test.js/
  // facebookAdapter.test.js already use — proving the REAL persisted
  // value, not an assumption.
  test('a successful callback persists the scopes Meta ACTUALLY granted, never blindly the full requested META_OAUTH_SCOPES list', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const state = await mintState({ userId: userA, projectId: projectA._id });
    const req = { query: { code: 'fake-real-looking-code', state } };
    const res = mockRes();

    const originalRequestAbsolute = metaApiService.requestAbsolute;
    const originalRequest = metaApiService.request;
    metaApiService.requestAbsolute = async () => ({ success: true, status: 200, data: { access_token: 'fake_user_token_for_test', expires_in: 5184000 } });
    // Meta granted only the read/analytics permissions — explicitly
    // WITHOUT pages_manage_posts, simulating exactly the real-world
    // situation this fix targets.
    metaApiService.request = async () => ({
      success: true, status: 200,
      data: { data: [
        { permission: 'pages_show_list', status: 'granted' },
        { permission: 'pages_read_engagement', status: 'granted' },
        { permission: 'pages_manage_posts', status: 'declined' },
      ] },
    });

    try {
      await handleMetaCallback(req, res);
    } finally {
      metaApiService.requestAbsolute = originalRequestAbsolute;
      metaApiService.request = originalRequest;
    }

    assert.ok(res.redirectedTo.includes('meta_connected=1'));

    const pending = await PendingMetaConnection.findOne({ project_id: projectA._id, user_id: userA });
    assert.ok(pending, 'a pending connection must have been persisted');
    assert.deepEqual(pending.scopes, ['pages_show_list', 'pages_read_engagement']);
    assert.equal(pending.scopes.includes('pages_manage_posts'), false);
    // And explicitly NOT the full requested list — this is the exact bug being fixed.
    assert.notDeepEqual(pending.scopes, META_OAUTH_SCOPES);
  });

  test('Meta consent denial redirects with a stable error code, never the raw Meta message', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const req = { query: { error: 'access_denied', error_reason: 'user_denied', error_description: 'The user denied your request' } };
    const res = mockRes();
    await handleMetaCallback(req, res);
    assert.ok(res.redirectedTo.includes('meta_error=access_denied'));
    assert.ok(!res.redirectedTo.includes('denied your request'));
  });

  test('missing code and state is rejected', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const req = { query: {} };
    const res = mockRes();
    await handleMetaCallback(req, res);
    assert.ok(res.redirectedTo.includes('meta_error=invalid_request'));
  });

  test('malformed state is rejected', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const req = { query: { code: 'fake', state: 'not-a-real-jwt' } };
    const res = mockRes();
    await handleMetaCallback(req, res);
    assert.ok(res.redirectedTo.includes('meta_error=expired_or_invalid_request'));
  });

  test('expired state is rejected', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const state = await mintStateWith({ userId: userA, projectId: projectA._id, expiresIn: '-1s' });
    const req = { query: { code: 'fake', state } };
    const res = mockRes();
    await handleMetaCallback(req, res);
    assert.ok(res.redirectedTo.includes('meta_error=expired_or_invalid_request'));
  });

  test('wrong provider in state is rejected', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const state = await mintStateWith({ userId: userA, projectId: projectA._id, provider: 'google' });
    const req = { query: { code: 'fake', state } };
    const res = mockRes();
    await handleMetaCallback(req, res);
    assert.ok(res.redirectedTo.includes('meta_error=invalid_request'));
  });

  test('wrong purpose in state is rejected', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const state = await mintStateWith({ userId: userA, projectId: projectA._id, purpose: 'google_visibility' });
    const req = { query: { code: 'fake', state } };
    const res = mockRes();
    await handleMetaCallback(req, res);
    assert.ok(res.redirectedTo.includes('meta_error=invalid_request'));
  });

  test('valid state but a DIFFERENT user\'s project is rejected (ownership re-check at callback time)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    // State says userB, but the project actually belongs to userA — this is
    // exactly the "client-controlled project ownership" attack the spec
    // calls out; the signature is valid (state itself isn't forged), but
    // the claimed relationship between userId and projectId is false.
    const state = await mintState({ userId: userB, projectId: projectA._id });
    const req = { query: { code: 'fake', state } };
    const res = mockRes();
    await handleMetaCallback(req, res);
    assert.ok(res.redirectedTo.includes('meta_error=access_denied'));
  });

  test('CASE A: valid state but a NONEXISTENT project is rejected', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const state = await mintState({ userId: userA, projectId: new mongoose.Types.ObjectId() });
    const req = { query: { code: 'fake', state } };
    const res = mockRes();
    await handleMetaCallback(req, res);
    assert.ok(res.redirectedTo.includes('meta_error=access_denied'));
  });

  test('CASE B: valid state but a SOFT-DELETED project is rejected, BEFORE any token exchange is attempted', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    // 1 & 2: a REAL project, genuinely persisted with is_deleted: true — not
    // a nonexistent ID (that's CASE A above). This is the exact security
    // fix under test: SeoProject.findById(projectId) (the old code) would
    // have found this document and let it through; AuthUtil.validateProjectAccess()
    // (the fix) must not.
    const softDeletedProject = await SeoProject.create({
      user_id: userA,
      project_name: `Meta Phase 1 Soft-Delete Test ${Date.now()}`,
      main_url: 'https://example.com',
      seo_scope: 'local',
      keywords: ['meta phase 1 soft delete test'],
      is_deleted: true,
    });

    try {
      // 3: a genuinely valid, correctly-signed state for this real project/user.
      const state = await mintState({ userId: userA, projectId: softDeletedProject._id });
      const req = { query: { code: 'fake-code-should-never-be-used', state } };
      const res = mockRes();

      // 5 (in spirit): this codebase has no mocking library anywhere (grep-
      // confirmed) and its own convention is real code / real Mongo, never
      // mocks — so rather than introduce a first-ever mock, this captures
      // real console output (what LoggerUtil actually writes to) to prove
      // metaOAuthService.exchangeCodeForToken() — which unconditionally
      // logs "MetaOAuth.token_exchange started" as its very first line,
      // before any HTTP call — was never entered at all. This is a
      // stronger assertion than "the HTTP call didn't happen": it proves
      // the function body was never reached.
      const originalLog = console.log;
      const originalError = console.error;
      const captured = [];
      console.log = (...args) => { captured.push(args.join(' ')); };
      console.error = (...args) => { captured.push(args.join(' ')); };

      // 4: call the real callback. console.log/error restoration is in its
      // own finally so a genuinely unexpected throw here can never leave
      // console permanently overridden for the rest of the test run.
      try {
        await handleMetaCallback(req, res);
      } finally {
        console.log = originalLog;
        console.error = originalError;
      }

      const logText = captured.join('\n');

      // 6: rejected.
      assert.ok(res.redirectedTo, 'callback must redirect');
      // 8: stable internal error code, not exposed Meta detail.
      assert.ok(res.redirectedTo.includes('meta_error=access_denied'), `expected meta_error=access_denied, got: ${res.redirectedTo}`);

      // 7: token exchange was NEVER entered.
      assert.ok(!logText.includes('MetaOAuth.token_exchange'), 'exchangeCodeForToken must never be invoked for a soft-deleted project');
      assert.ok(!logText.includes('meta_token_exchange'), 'no Graph API call context for a soft-deleted project');

      // 9: no token/secret/code anywhere in the response or in what was logged.
      assert.equal(res.body, null, 'callback must never return a JSON body containing token data');
      assert.ok(!res.redirectedTo.includes('access_token'), 'redirect URL must never contain a token');
      assert.ok(!logText.includes(process.env.META_APP_SECRET), 'app secret must never be logged');
      assert.ok(!logText.includes('fake-code-should-never-be-used'), 'the authorization code must never be logged');
    } finally {
      await SeoProject.deleteOne({ _id: softDeletedProject._id });
    }
  });

  // CASE C (wrong-user project) is covered above by
  // "valid state but a DIFFERENT user's project is rejected".
});
