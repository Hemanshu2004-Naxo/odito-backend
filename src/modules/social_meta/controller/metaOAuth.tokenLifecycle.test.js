import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import crypto from 'crypto';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import SocialAccount from '../model/SocialAccount.js';
import PendingMetaConnection from '../model/PendingMetaConnection.js';
import metaApiService from '../service/metaApiService.js';
import { mintState } from '../testSupport/metaState.js';
import { handleMetaCallback, selectMetaPage } from './metaOAuthController.js';
import { debugTokenResponse } from '../testSupport/metaDebugTokenStub.js';

/**
 * Meta token LIFECYCLE regression tests (P0 #1): authorization code ->
 * short-lived token -> LONG-LIVED exchange -> Pages -> Page token + real
 * expiry persisted. The real controllers run against real MongoDB; only the
 * Graph layer (metaApiService) is substituted, recording every call so the
 * exact requests Odito sends to Meta can be asserted.
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
after(async () => { if (mongoAvailable) await mongoose.connection.close(); });

const SHORT = 'SHORT-LIVED-USER-TOKEN-aaaa1111';
const LONG = 'LONG-LIVED-USER-TOKEN-bbbb2222';

function mockRes() {
  return {
    statusCode: null, body: null, redirectedTo: null,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    redirect(u) { this.redirectedTo = u; return this; },
    send(t) { this.sent = t; return this; },
  };
}

async function captureLogs(fn) {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try { await fn(); } finally { Object.assign(console, orig); }
  return lines.join('\n');
}

/** Substitutes BOTH Graph entry points, recording calls. */
async function withGraph({ absolute, request }, fn) {
  const origAbs = metaApiService.requestAbsolute;
  const origReq = metaApiService.request;
  const calls = { absolute: [], request: [] };
  metaApiService.requestAbsolute = async (o) => { calls.absolute.push(o); return absolute(o, calls.absolute.length); };
  metaApiService.request = async (o) => { calls.request.push(o); return request(o); };
  try { return await fn(calls); } finally {
    metaApiService.requestAbsolute = origAbs;
    metaApiService.request = origReq;
  }
}

const GRANTED = { success: true, status: 200, data: { data: [{ permission: 'pages_show_list', status: 'granted' }, { permission: 'pages_manage_posts', status: 'granted' }] } };

describe('handleMetaCallback — long-lived user token exchange', () => {
  let userId, project;
  beforeEach(async () => {
    if (!mongoAvailable) return;
    userId = new mongoose.Types.ObjectId();
    project = await SeoProject.create({ user_id: userId, project_name: `Meta Lifecycle ${Date.now()}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'] });
  });
  afterEach(async () => {
    if (!mongoAvailable) return;
    await SeoProject.deleteOne({ _id: project._id });
    await PendingMetaConnection.deleteMany({ project_id: project._id });
  });

  const stateFor = () => mintState({ userId, projectId: project._id });

  test('1+2: exchanges the code, THEN exchanges the short-lived token for a long-lived one, and stores ONLY the long-lived token with its real ~60 day expiry', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = mockRes();
    await withGraph({
      absolute: (o, n) => (n === 1
        ? { success: true, status: 200, data: { access_token: SHORT, expires_in: 3600 } }
        : { success: true, status: 200, data: { access_token: LONG, expires_in: 5184000 } }),
      request: () => GRANTED,
    }, async (calls) => {
      await handleMetaCallback({ query: { code: 'auth-code-1', state: await stateFor() } }, res);

      // call 1: the authorization-code exchange
      assert.equal(calls.absolute[0].params.code, 'auth-code-1');
      assert.equal(calls.absolute[0].params.grant_type, undefined);
      // call 2: the long-lived exchange, built from call 1's token
      assert.equal(calls.absolute.length, 2);
      assert.match(calls.absolute[1].url, /\/oauth\/access_token$/);
      assert.equal(calls.absolute[1].params.grant_type, 'fb_exchange_token');
      assert.equal(calls.absolute[1].params.fb_exchange_token, SHORT);
      assert.equal(calls.absolute[1].params.client_id, process.env.META_APP_ID);
      assert.ok(calls.absolute[1].params.client_secret, 'client secret is attached server-side');
      // honors the configured Graph version
      assert.ok(calls.absolute[1].url.includes(`/${process.env.META_GRAPH_API_VERSION || 'v21.0'}/`));
      // permissions are then fetched with the LONG-lived token, not the short one
      assert.equal(calls.request[0].path, '/me/permissions');
      assert.equal(calls.request[0].accessToken, LONG);
    });

    assert.ok(res.redirectedTo.includes('meta_connected=1'));
    const pending = await PendingMetaConnection.findOne({ project_id: project._id, user_id: userId });
    assert.equal(pending.userAccessToken, LONG, 'the long-lived token is the one persisted');
    assert.notEqual(pending.userAccessToken, SHORT);
    const secondsAhead = (pending.tokenExpiresAt.getTime() - Date.now()) / 1000;
    assert.ok(secondsAhead > 5184000 - 30 && secondsAhead <= 5184000, `expiry comes from the long-lived response (~60d), got ${secondsAhead}s`);
    // encrypted at rest
    const raw = await mongoose.connection.db.collection('pendingmetaconnections').findOne({ _id: pending._id });
    assert.ok(raw.userAccessToken.startsWith('enc:v1:'));
    assert.ok(!JSON.stringify(raw).includes(LONG) && !JSON.stringify(raw).includes(SHORT));
  });

  test('5: if the long-lived exchange FAILS the connection fails — it never silently continues with the short-lived token', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = mockRes();
    await withGraph({
      absolute: (o, n) => (n === 1
        ? { success: true, status: 200, data: { access_token: SHORT, expires_in: 3600 } }
        : { success: false, kind: 'http', status: 400, data: { error: { code: 190, message: 'bad' } }, message: 'bad' }),
      request: () => { throw new Error('permissions must not be fetched after a failed exchange'); },
    }, async () => { await handleMetaCallback({ query: { code: 'c', state: await stateFor() } }, res); });

    assert.ok(res.redirectedTo.includes('meta_error=connection_failed'));
    assert.ok(!res.redirectedTo.includes('meta_connected'));
    assert.equal(await PendingMetaConnection.countDocuments({ project_id: project._id }), 0, 'nothing persisted');
  });

  test('5b: a 200 response WITHOUT an access_token is treated as a failed exchange, never persisted as an empty token', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = mockRes();
    await withGraph({
      absolute: (o, n) => (n === 1 ? { success: true, status: 200, data: { access_token: SHORT, expires_in: 3600 } } : { success: true, status: 200, data: {} }),
      request: () => GRANTED,
    }, async () => { await handleMetaCallback({ query: { code: 'c', state: await stateFor() } }, res); });
    assert.ok(res.redirectedTo.includes('meta_error=connection_failed'));
    assert.equal(await PendingMetaConnection.countDocuments({ project_id: project._id }), 0);
  });

  test('5c: if the FIRST (code) exchange fails, the long-lived exchange is never attempted', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = mockRes();
    let attempts = 0;
    await withGraph({
      absolute: () => { attempts += 1; return { success: false, kind: 'http', status: 400, data: { error: { code: 100, message: 'bad code' } }, message: 'bad code' }; },
      request: () => GRANTED,
    }, async () => { await handleMetaCallback({ query: { code: 'bad', state: await stateFor() } }, res); });
    assert.equal(attempts, 1);
    assert.ok(res.redirectedTo.includes('meta_error=connection_failed'));
  });

  test('7+8: neither the short- nor long-lived token (nor the code/secret) appears in the redirect URL or in ANY log line', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = mockRes();
    const logs = await captureLogs(async () => {
      await withGraph({
        absolute: (o, n) => (n === 1
          ? { success: true, status: 200, data: { access_token: SHORT, expires_in: 3600 } }
          : { success: true, status: 200, data: { access_token: LONG, expires_in: 5184000 } }),
        request: () => GRANTED,
      }, async () => { await handleMetaCallback({ query: { code: 'secret-auth-code-zzz', state: await stateFor() } }, res); });
    });
    for (const secret of [SHORT, LONG, 'secret-auth-code-zzz', String(process.env.META_APP_SECRET)]) {
      assert.ok(!res.redirectedTo.includes(secret), 'redirect URL must not carry a secret');
      assert.ok(!logs.includes(secret), 'logs must not carry a secret');
    }
  });

  test('6: an invalid state is rejected before ANY Meta call is made', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = mockRes();
    await withGraph({ absolute: () => { throw new Error('no Meta call expected'); }, request: () => { throw new Error('no Meta call expected'); } },
      async (calls) => {
        await handleMetaCallback({ query: { code: 'c', state: 'tampered' } }, res);
        assert.equal(calls.absolute.length, 0);
      });
    assert.ok(res.redirectedTo.includes('meta_error=expired_or_invalid_request'));
  });
});

describe('selectMetaPage — Page token persistence + real expiry', () => {
  let userId, project;
  const PAGE_A = { id: 'pg_A', name: 'Page A', category: 'Biz', picture: null, accessToken: 'PAGE-TOKEN-A-secret', tasks: ['MANAGE'] };
  const PAGE_B = { id: 'pg_B', name: 'Page B', category: 'Biz', picture: null, accessToken: 'PAGE-TOKEN-B-secret', tasks: ['MANAGE'] };

  beforeEach(async () => {
    if (!mongoAvailable) return;
    userId = new mongoose.Types.ObjectId();
    project = await SeoProject.create({ user_id: userId, project_name: `Meta Select ${Date.now()}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'] });
    await PendingMetaConnection.create({
      user_id: userId, project_id: project._id, userAccessToken: LONG, tokenExpiresAt: new Date(Date.now() + 5e9),
      scopes: ['pages_show_list', 'pages_manage_posts'], pages: [PAGE_A, PAGE_B], expiresAt: new Date(Date.now() + 600_000),
    });
  });
  afterEach(async () => {
    if (!mongoAvailable) return;
    await SeoProject.deleteOne({ _id: project._id });
    await PendingMetaConnection.deleteMany({ project_id: project._id });
    await SocialAccount.deleteMany({ project_id: project._id });
  });

  /** Graph stub: debug_token per `debug`, no Instagram link unless `ig` is given. */
  function graph({ debug, ig = null }) {
    return (o) => {
      if (o.path === '/debug_token') return debug(o);
      if (ig && o.path === `/${PAGE_A.id}`) return { success: true, status: 200, data: { instagram_business_account: { id: ig.id } } };
      if (ig && o.path === `/${ig.id}`) return { success: true, status: 200, data: { id: ig.id, username: ig.username } };
      return { success: true, status: 200, data: {} };
    };
  }
  const select = async (pageId) => {
    const res = mockRes();
    await selectMetaPage({ user: { _id: userId }, projectId: project._id.toString(), params: { pageId } }, res);
    return res;
  };

  test('3+4: persists the selected Page token (encrypted) and the REAL expiry facts Meta reports (never-expires => null, data-access window stored)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const dataAccess = Math.floor(Date.now() / 1000) + 85 * 86400;
    let res;
    await withGraph({ absolute: () => { throw new Error('n/a'); }, request: graph({ debug: () => debugTokenResponse({ expiresAtSeconds: 0, dataAccessExpiresAtSeconds: dataAccess }) }) },
      async (calls) => {
        res = await select(PAGE_A.id);
        const dbg = calls.request.filter((c) => c.path === '/debug_token');
        assert.equal(dbg.length, 1, 'exactly one extra Meta call: the selected Page token');
        assert.equal(dbg[0].params.input_token, PAGE_A.accessToken);
      });

    assert.equal(res.statusCode, null);
    assert.equal(res.body.success, true);
    const a = await SocialAccount.findOne({ project_id: project._id, platformAccountId: PAGE_A.id });
    assert.equal(a.accessToken, PAGE_A.accessToken, 'the PAGE token (not the user token) is stored');
    assert.equal(a.tokenExpiresAt, null, 'Meta said expires_at:0 (never) — stored as null, not invented');
    assert.equal(a.dataAccessExpiresAt.getTime(), dataAccess * 1000);
    assert.ok(a.lastVerifiedAt instanceof Date);
    assert.equal(a.status, 'active');
    assert.equal(a.statusReason, null);
    const raw = await mongoose.connection.db.collection('socialaccounts').findOne({ _id: a._id });
    assert.ok(raw.accessToken.startsWith('enc:v1:'));
  });

  test('4b: a Page token that DOES carry an expiry stores that exact date', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const exp = Math.floor(Date.now() / 1000) + 7200;
    await withGraph({ absolute: () => ({}), request: graph({ debug: () => debugTokenResponse({ expiresAtSeconds: exp }) }) }, async () => { await select(PAGE_A.id); });
    const a = await SocialAccount.findOne({ project_id: project._id, platformAccountId: PAGE_A.id });
    assert.equal(a.tokenExpiresAt.getTime(), exp * 1000);
  });

  test('multi-page behavior preserved: every Page is persisted, only the selected one is active + verified, the others are stored unverified', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await withGraph({ absolute: () => ({}), request: graph({ debug: () => debugTokenResponse() }) }, async () => { await select(PAGE_A.id); });
    const a = await SocialAccount.findOne({ project_id: project._id, platformAccountId: PAGE_A.id });
    const b = await SocialAccount.findOne({ project_id: project._id, platformAccountId: PAGE_B.id });
    assert.equal(a.isActive, true);
    assert.equal(b.isActive, false);
    assert.equal(b.status, 'active');
    assert.equal(b.accessToken, PAGE_B.accessToken);
    assert.equal(b.lastVerifiedAt, null, 'not asked about -> not claimed verified');
    assert.equal(b.tokenExpiresAt, null);
    assert.ok(b.dataAccessExpiresAt, 'shares the same user grant, so the same data-access window');
  });

  test('6: a Page token Meta says is INVALID is refused — 502, nothing persisted, the pending connection is kept', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    let res;
    await withGraph({ absolute: () => ({}), request: graph({ debug: () => debugTokenResponse({ valid: false }) }) }, async () => { res = await select(PAGE_A.id); });
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.details.code, 'META_PAGE_ACCESS_DENIED');
    assert.equal(await SocialAccount.countDocuments({ project_id: project._id }), 0);
    assert.equal(await PendingMetaConnection.countDocuments({ project_id: project._id }), 1);
  });

  test('if the debug_token check itself cannot complete (Meta unreachable) the connection still succeeds, unverified', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    let res;
    await withGraph({ absolute: () => ({}), request: graph({ debug: () => ({ success: false, kind: 'timeout', status: null, data: null }) }) }, async () => { res = await select(PAGE_A.id); });
    assert.equal(res.body.success, true);
    const a = await SocialAccount.findOne({ project_id: project._id, platformAccountId: PAGE_A.id });
    assert.equal(a.status, 'active');
    assert.equal(a.lastVerifiedAt, null);
  });

  test('7+8: no token (page, user) in the API response or in any log line', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    let res;
    const logs = await captureLogs(async () => {
      await withGraph({ absolute: () => ({}), request: graph({ debug: () => debugTokenResponse() }) }, async () => { res = await select(PAGE_A.id); });
    });
    const body = JSON.stringify(res.body);
    for (const secret of [PAGE_A.accessToken, PAGE_B.accessToken, LONG]) {
      assert.ok(!body.includes(secret), 'API response must not contain a token');
      assert.ok(!logs.includes(secret), 'logs must not contain a token');
    }
    assert.ok(!logs.includes(String(process.env.META_APP_SECRET)));
  });

  test('reconnect: an EXPIRED Page and its Instagram row come back active with the NEW token and a cleared statusReason', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const base = { user_id: userId, project_id: project._id, accessToken: 'OLD-DEAD-TOKEN', scopes: [], status: 'expired', statusReason: 'META_TOKEN_INVALID' };
    await SocialAccount.create({ ...base, platform: 'facebook', platformAccountId: PAGE_A.id, pageId: PAGE_A.id, accountType: 'page', isActive: true });
    await SocialAccount.create({ ...base, platform: 'instagram', platformAccountId: 'ig_77', pageId: PAGE_A.id, instagramBusinessAccountId: 'ig_77', accountType: 'business' });

    await withGraph({ absolute: () => ({}), request: graph({ debug: () => debugTokenResponse(), ig: { id: 'ig_77', username: 'brand' } }) }, async () => { await select(PAGE_A.id); });

    const fb = await SocialAccount.findOne({ project_id: project._id, platform: 'facebook', platformAccountId: PAGE_A.id });
    const ig = await SocialAccount.findOne({ project_id: project._id, platform: 'instagram', platformAccountId: 'ig_77' });
    assert.equal(fb.status, 'active');
    assert.equal(fb.statusReason, null);
    assert.equal(fb.accessToken, PAGE_A.accessToken);
    assert.equal(ig.status, 'active');
    assert.equal(ig.accessToken, PAGE_A.accessToken, 'Instagram row must not keep the old dead token');
  });
});
