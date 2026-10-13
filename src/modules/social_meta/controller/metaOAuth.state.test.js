import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import MetaOAuthState from '../model/MetaOAuthState.js';
import PendingMetaConnection from '../model/PendingMetaConnection.js';
import metaApiService from '../service/metaApiService.js';
import {
  issueMetaOAuthState, consumeMetaOAuthState, signMetaStateToken, verifyMetaStateToken, getStateSecret, readCookie, BINDING_COOKIE,
} from '../service/metaOAuthStateService.js';
import { startMetaConnection, handleMetaCallback } from './metaOAuthController.js';
import { mintStateWith } from '../testSupport/metaState.js';

/**
 * Meta OAuth `state`: dedicated key, one-time use, replay protection, browser binding, expiry, and an allow-listed return target.
 * Real MongoDB; the Meta HTTP layer is replaced, so "the code was exchanged" is observable.
 */

let mongoAvailable = false;
before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
    await MetaOAuthState.init();
  } catch { mongoAvailable = false; }
});
after(async () => { if (mongoAvailable) await mongoose.connection.close(); });

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const mockRes = () => {
  const res = { statusCode: null, body: null, redirectedTo: null, cookies: [], cleared: [] };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.redirect = (u) => { res.redirectedTo = u; return res; };
  res.cookie = (name, value, options) => { res.cookies.push({ name, value, options }); return res; };
  res.clearCookie = (name, options) => { res.cleared.push({ name, options }); return res; };
  res.send = (b) => { res.body = b; return res; };
  return res;
};

describe('Meta OAuth state', () => {
  let userId; let project; let exchanged;
  let originalAbsolute; let originalRequest;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    userId = new mongoose.Types.ObjectId();
    project = await SeoProject.create({ user_id: userId, project_name: `OAuth state ${Date.now()} ${Math.random().toString(36).slice(2, 7)}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'] });
    exchanged = 0;
    originalAbsolute = metaApiService.requestAbsolute;
    originalRequest = metaApiService.request;
    metaApiService.requestAbsolute = async () => { exchanged += 1; return { success: true, status: 200, data: { access_token: 'tok', expires_in: 5184000 } }; };
    metaApiService.request = async () => ({ success: true, status: 200, data: { data: [{ permission: 'pages_show_list', status: 'granted' }] } });
  });
  afterEach(async () => {
    metaApiService.requestAbsolute = originalAbsolute;
    metaApiService.request = originalRequest;
    delete process.env.META_OAUTH_REQUIRE_BROWSER_BINDING;
    delete process.env.META_OAUTH_STATE_SECRET;
    if (!mongoAvailable) return;
    await SeoProject.deleteOne({ _id: project._id });
    await PendingMetaConnection.deleteMany({ project_id: project._id });
    await MetaOAuthState.deleteMany({ project_id: project._id });
  });

  test('1: the signing key is NOT the session key: a state is no login token, a login token is no state, and one signed the old way is refused', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    assert.notEqual(getStateSecret(), process.env.JWT_SECRET);
    const { state } = await issueMetaOAuthState({ userId, projectId: project._id });
    assert.throws(() => jwt.verify(state, process.env.JWT_SECRET), 'the session key cannot verify a state');
    const session = jwt.sign({ id: String(userId) }, process.env.JWT_SECRET, { expiresIn: '1h' });
    assert.throws(() => verifyMetaStateToken(session), 'a session token is not a state');
    const oldStyle = jwt.sign({ provider: 'meta', purpose: 'social_meta', projectId: String(project._id), userId: String(userId) }, process.env.JWT_SECRET, { expiresIn: '10m' });
    assert.equal((await consumeMetaOAuthState(oldStyle)).reason, 'invalid');
    // a token with the right key but the wrong audience / type is refused too
    const wrongAudience = jwt.sign({ typ: 'meta_oauth_state', provider: 'meta', purpose: 'social_meta', nonce: 'x'.repeat(43) }, getStateSecret(), { audience: 'someone-else', issuer: 'odito', expiresIn: '10m' });
    assert.equal((await consumeMetaOAuthState(wrongAudience)).reason, 'invalid');
  });

  test('2: META_OAUTH_STATE_SECRET, when set, replaces the derived key (and changing it invalidates outstanding states)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const derived = getStateSecret();
    process.env.META_OAUTH_STATE_SECRET = 'a-dedicated-secret-of-at-least-32-characters-long';
    assert.equal(getStateSecret(), process.env.META_OAUTH_STATE_SECRET);
    const { state } = await issueMetaOAuthState({ userId, projectId: project._id });
    assert.equal((await consumeMetaOAuthState(state)).ok, true);
    const second = (await issueMetaOAuthState({ userId, projectId: project._id })).state;
    process.env.META_OAUTH_STATE_SECRET = 'another-dedicated-secret-of-32-characters-or-more';
    assert.equal((await consumeMetaOAuthState(second)).reason, 'invalid');
    process.env.META_OAUTH_STATE_SECRET = 'too-short';
    assert.equal(getStateSecret(), derived, 'a weak value is ignored, not used');
  });

  test('3: the token reveals nothing - no user, no project, no return target - and the database holds only HASHES of the nonce and the binding secret', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { state, bindingSecret } = await issueMetaOAuthState({ userId, projectId: project._id, returnTo: 'social-media' });
    const decoded = verifyMetaStateToken(state);
    assert.deepEqual(Object.keys(decoded).sort(), ['aud', 'exp', 'iat', 'iss', 'nonce', 'provider', 'purpose', 'typ']);
    assert.ok(decoded.nonce.length >= 43, 'a 256-bit random nonce');
    const record = await MetaOAuthState.findOne({ nonce_hash: sha256(decoded.nonce) }).lean();
    assert.ok(record);
    assert.equal(JSON.stringify(record).includes(decoded.nonce), false);
    assert.equal(JSON.stringify(record).includes(bindingSecret), false);
    assert.equal(record.binding_hash, sha256(bindingSecret));
    assert.ok(record.expiresAt > new Date() && record.expiresAt < new Date(Date.now() + 11 * 60 * 1000));
  });

  test('4: a state works ONCE: the replay is refused, and five simultaneous attempts produce exactly one success', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { state } = await issueMetaOAuthState({ userId, projectId: project._id });
    const first = await consumeMetaOAuthState(state);
    assert.equal(first.ok, true);
    assert.equal(first.userId, String(userId));
    assert.equal(first.projectId, String(project._id));
    assert.equal((await consumeMetaOAuthState(state)).reason, 'replayed');

    const again = (await issueMetaOAuthState({ userId, projectId: project._id })).state;
    const results = await Promise.all(Array.from({ length: 5 }, () => consumeMetaOAuthState(again)));
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.ok(results.filter((r) => !r.ok).every((r) => r.reason === 'replayed'));
  });

  test('5: expiry: an expired token, an expired record and an unknown nonce are each refused with their own reason', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const expiredToken = await mintStateWith({ userId, projectId: project._id, expiresIn: '-1s' });
    assert.equal((await consumeMetaOAuthState(expiredToken)).reason, 'expired');
    const { state } = await issueMetaOAuthState({ userId, projectId: project._id, now: new Date(Date.now() - 11 * 60 * 1000) });
    assert.equal((await consumeMetaOAuthState(state)).reason, 'expired', 'the record expired even though a token with a long life was minted');
    const unknown = signMetaStateToken({ nonce: crypto.randomBytes(32).toString('base64url') });
    assert.equal((await consumeMetaOAuthState(unknown)).reason, 'unknown');
    assert.equal((await consumeMetaOAuthState('garbage')).reason, 'invalid');
    assert.equal((await consumeMetaOAuthState(undefined)).reason, 'invalid');
  });

  test('6: browser binding: the cookie secret must match when the browser sends it; a wrong one is refused WITHOUT burning the state; none is allowed unless binding is required', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { state, bindingSecret } = await issueMetaOAuthState({ userId, projectId: project._id });
    assert.equal((await consumeMetaOAuthState(state, { bindingSecret: 'someone-elses-browser' })).reason, 'binding_mismatch');
    const ok = await consumeMetaOAuthState(state, { bindingSecret });
    assert.equal(ok.ok, true, 'the real browser can still finish: the mismatch did not consume the state');
    assert.equal(ok.bindingChecked, true);

    const noCookie = (await issueMetaOAuthState({ userId, projectId: project._id })).state;
    const lenient = await consumeMetaOAuthState(noCookie);
    assert.equal(lenient.ok, true, 'a deployment whose browsers refuse the cookie still works by default');
    assert.equal(lenient.bindingChecked, false);

    process.env.META_OAUTH_REQUIRE_BROWSER_BINDING = 'true';
    const strict = (await issueMetaOAuthState({ userId, projectId: project._id })).state;
    assert.equal((await consumeMetaOAuthState(strict)).reason, 'binding_missing');
    assert.equal((await consumeMetaOAuthState(strict, { bindingSecret: 'x' })).reason, 'binding_mismatch');
  });

  test('7: /start sets an httpOnly, SameSite=Lax binding cookie scoped to the Meta routes (Secure in production) and never puts the secret in the URL or the body', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const req = { query: { returnTo: 'social-media' }, projectId: String(project._id), user: { _id: String(userId) } };
    const res = mockRes();
    await startMetaConnection(req, res);
    assert.equal(res.cookies.length, 1);
    const cookie = res.cookies[0];
    assert.equal(cookie.name, BINDING_COOKIE);
    assert.deepEqual([cookie.options.httpOnly, cookie.options.sameSite, cookie.options.path], [true, 'lax', '/api/social/meta']);
    assert.equal(cookie.options.maxAge, 10 * 60 * 1000);
    assert.equal(cookie.options.secure, process.env.NODE_ENV === 'production');
    assert.equal(JSON.stringify(res.body).includes(cookie.value), false);
    const state = new URL(res.body.data.url).searchParams.get('state');
    assert.equal((await consumeMetaOAuthState(state, { bindingSecret: cookie.value })).ok, true);

    const prod = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const r2 = mockRes();
      await startMetaConnection(req, r2);
      assert.equal(r2.cookies[0].options.secure, true);
    } finally { process.env.NODE_ENV = prod; }
  });

  test('8: the callback consumes the state before exchanging the code: a replay is refused and Meta is called only for the first; the binding cookie is cleared', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const startRes = mockRes();
    await startMetaConnection({ query: {}, projectId: String(project._id), user: { _id: String(userId) } }, startRes);
    const state = new URL(startRes.body.data.url).searchParams.get('state');
    const cookieHeader = `${BINDING_COOKIE}=${encodeURIComponent(startRes.cookies[0].value)}`;

    const res1 = mockRes();
    await handleMetaCallback({ query: { code: 'c1', state }, headers: { cookie: cookieHeader } }, res1);
    assert.ok(res1.redirectedTo.includes('meta_connected=1'), res1.redirectedTo);
    assert.equal(exchanged, 2, 'the code, then the long-lived token: two exchanges for ONE successful callback');
    assert.equal(res1.cleared[0].name, BINDING_COOKIE);

    const res2 = mockRes();
    await handleMetaCallback({ query: { code: 'c1', state }, headers: { cookie: cookieHeader } }, res2);
    assert.ok(res2.redirectedTo.includes('meta_error=expired_or_invalid_request'));
    assert.equal(exchanged, 2, 'the replay never reached Meta');
  });

  test('9: a callback from a DIFFERENT browser (wrong binding cookie) is refused before any code exchange', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const startRes = mockRes();
    await startMetaConnection({ query: {}, projectId: String(project._id), user: { _id: String(userId) } }, startRes);
    const state = new URL(startRes.body.data.url).searchParams.get('state');
    const res = mockRes();
    await handleMetaCallback({ query: { code: 'c', state }, headers: { cookie: `${BINDING_COOKIE}=not-the-secret; other=1` } }, res);
    assert.ok(res.redirectedTo.includes('meta_error=invalid_request'));
    assert.equal(exchanged, 0);
    // the person's own browser can still finish
    const ok = mockRes();
    await handleMetaCallback({ query: { code: 'c', state }, headers: { cookie: `${BINDING_COOKIE}=${encodeURIComponent(startRes.cookies[0].value)}` } }, ok);
    assert.ok(ok.redirectedTo.includes('meta_connected=1'));
  });

  test('10: the return target is an ALLOW-LIST key: an arbitrary returnTo is dropped, never stored, never followed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    for (const bad of ['https://evil.example', '//evil.example', '/app/../admin', 'x'.repeat(200), 'constructor', '__proto__']) {
      const res = mockRes();
      await startMetaConnection({ query: { returnTo: bad }, projectId: String(project._id), user: { _id: String(userId) } }, res);
      const state = new URL(res.body.data.url).searchParams.get('state');
      const record = await MetaOAuthState.findOne({ nonce_hash: sha256(verifyMetaStateToken(state).nonce) }).lean();
      assert.equal(record.returnTo, null, bad);
    }
    const ok = mockRes();
    await startMetaConnection({ query: { returnTo: 'social-media' }, projectId: String(project._id), user: { _id: String(userId) } }, ok);
    const record = await MetaOAuthState.findOne({ nonce_hash: sha256(verifyMetaStateToken(new URL(ok.body.data.url).searchParams.get('state')).nonce) }).lean();
    assert.equal(record.returnTo, 'social-media');
  });

  test('11: readCookie reads only the named cookie and tolerates junk', () => {
    assert.equal(readCookie({ headers: { cookie: 'a=1; odito_meta_oauth=abc%20def; b=2' } }, 'odito_meta_oauth'), 'abc def');
    assert.equal(readCookie({ headers: { cookie: 'a=1' } }, 'odito_meta_oauth'), null);
    assert.equal(readCookie({ headers: {} }, 'odito_meta_oauth'), null);
    assert.equal(readCookie({}, 'odito_meta_oauth'), null);
    assert.equal(readCookie({ headers: { cookie: '=x; ;;odito_meta_oauth' } }, 'odito_meta_oauth'), null);
  });
});
