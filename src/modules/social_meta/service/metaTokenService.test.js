import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SocialAccount from '../model/SocialAccount.js';
import metaApiService from './metaApiService.js';
import { inspectToken, markAccountExpired, applyInspection, verifyAccount, verifyProjectAccounts } from './metaTokenService.js';
import { debugTokenResponse } from '../testSupport/metaDebugTokenStub.js';

/**
 * metaTokenService — token health via Meta's debug_token endpoint. Real
 * MongoDB; only metaApiService.request (the Graph call) is substituted, in
 * the same way every other test in this module does.
 */

let mongoAvailable = false;
const SECRET_TOKEN = 'EAAB-this-token-must-never-appear-anywhere';

before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch {
    mongoAvailable = false;
  }
});
after(async () => { if (mongoAvailable) await mongoose.connection.close(); });

async function withRequest(handler, fn) {
  const original = metaApiService.request;
  const calls = [];
  metaApiService.request = async (opts) => { calls.push(opts); return handler(opts); };
  try { return await fn(calls); } finally { metaApiService.request = original; }
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

describe('inspectToken (debug_token)', () => {
  test('a valid never-expiring Page token: valid, neverExpires, data-access expiry, scopes, app id', async () => {
    const dataAccess = Math.floor(Date.now() / 1000) + 90 * 86400;
    const r = await withRequest(async () => debugTokenResponse({ expiresAtSeconds: 0, dataAccessExpiresAtSeconds: dataAccess }), () => inspectToken(SECRET_TOKEN));
    assert.equal(r.success, true);
    assert.equal(r.valid, true);
    assert.equal(r.neverExpires, true);
    assert.equal(r.expiresAt, null);
    assert.equal(r.dataAccessExpiresAt.getTime(), dataAccess * 1000);
    assert.ok(r.scopes.includes('pages_manage_posts'));
    assert.equal(r.appId, String(process.env.META_APP_ID));
  });

  test('a token with a real expiry reports that date', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const r = await withRequest(async () => debugTokenResponse({ expiresAtSeconds: exp }), () => inspectToken(SECRET_TOKEN));
    assert.equal(r.valid, true);
    assert.equal(r.neverExpires, false);
    assert.equal(r.expiresAt.getTime(), exp * 1000);
  });

  test('is_valid:false is a CONFIRMED invalid token', async () => {
    const r = await withRequest(async () => debugTokenResponse({ valid: false }), () => inspectToken(SECRET_TOKEN));
    assert.equal(r.success, true);
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'META_TOKEN_INVALID');
  });

  test('an expires_at already in the past is invalid even if Meta still says is_valid', async () => {
    const r = await withRequest(async () => debugTokenResponse({ expiresAtSeconds: Math.floor(Date.now() / 1000) - 60 }), () => inspectToken(SECRET_TOKEN));
    assert.equal(r.valid, false);
  });

  test('a lapsed data-access window is invalid', async () => {
    const r = await withRequest(async () => debugTokenResponse({ dataAccessExpiresAtSeconds: Math.floor(Date.now() / 1000) - 60 }), () => inspectToken(SECRET_TOKEN));
    assert.equal(r.valid, false);
  });

  test('a token that belongs to a DIFFERENT app is invalid for this app', async () => {
    const r = await withRequest(async () => debugTokenResponse({ appId: '999999999' }), () => inspectToken(SECRET_TOKEN));
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'APP_MISMATCH');
  });

  test('Meta answering HTTP 400 code 190 for the input token is a definitive "invalid", not an outage', async () => {
    const r = await withRequest(async () => ({ success: false, kind: 'http', status: 400, data: { error: { code: 190, message: 'x' } } }), () => inspectToken(SECRET_TOKEN));
    assert.equal(r.success, true);
    assert.equal(r.valid, false);
  });

  test('a network failure / 5xx means the check FAILED — it must never be reported as invalid', async () => {
    for (const result of [
      { success: false, kind: 'timeout', status: null, data: null },
      { success: false, kind: 'http', status: 503, data: null },
    ]) {
      const r = await withRequest(async () => result, () => inspectToken(SECRET_TOKEN));
      assert.equal(r.success, false);
      assert.equal(r.valid, undefined);
    }
  });

  test('a malformed response (no is_valid) is a failed check, not a verdict', async () => {
    const r = await withRequest(async () => ({ success: true, status: 200, data: { data: {} } }), () => inspectToken(SECRET_TOKEN));
    assert.equal(r.success, false);
  });

  test('no token => invalid without calling Meta', async () => {
    const r = await withRequest(async () => { throw new Error('must not be called'); }, () => inspectToken(''));
    assert.equal(r.valid, false);
  });

  test('it asks Meta with the APP token (app_id|secret) and passes the input token as a param — never logs either', async () => {
    let logs;
    await withRequest(async () => debugTokenResponse(), async (calls) => {
      logs = await captureLogs(() => inspectToken(SECRET_TOKEN));
      assert.equal(calls[0].path, '/debug_token');
      assert.equal(calls[0].params.input_token, SECRET_TOKEN);
      assert.equal(calls[0].accessToken, `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`);
    });
    assert.ok(!logs.includes(SECRET_TOKEN), 'input token must not be logged');
    assert.ok(!logs.includes(String(process.env.META_APP_SECRET)), 'app secret must not be logged');
  });
});

describe('account status via token health', () => {
  let project, fb, ig, otherIg;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    project = new mongoose.Types.ObjectId();
    const base = { user_id: new mongoose.Types.ObjectId(), project_id: project, accessToken: SECRET_TOKEN, scopes: ['pages_manage_posts', 'instagram_content_publish'], status: 'active' };
    fb = await SocialAccount.create({ ...base, platform: 'facebook', platformAccountId: 'pg_1', pageId: 'pg_1', accountType: 'page', isActive: true });
    ig = await SocialAccount.create({ ...base, platform: 'instagram', platformAccountId: 'ig_1', pageId: 'pg_1', instagramBusinessAccountId: 'ig_1', accountType: 'business' });
    otherIg = await SocialAccount.create({ ...base, platform: 'instagram', platformAccountId: 'ig_2', pageId: 'pg_other', instagramBusinessAccountId: 'ig_2', accountType: 'business' });
  });
  afterEach(async () => { if (mongoAvailable) await SocialAccount.deleteMany({ project_id: project }); });

  test('verifyAccount on a valid token persists expiry + lastVerifiedAt on the account AND the Instagram row sharing its token', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const dataAccess = Math.floor(Date.now() / 1000) + 80 * 86400;
    const health = await withRequest(async () => debugTokenResponse({ expiresAtSeconds: 0, dataAccessExpiresAtSeconds: dataAccess }), () => verifyAccount(fb));

    assert.equal(health.status, 'active');
    assert.equal(health.valid, true);
    assert.equal(health.requiresReconnect, false);
    const fbDoc = await SocialAccount.findById(fb._id);
    const igDoc = await SocialAccount.findById(ig._id);
    const unrelated = await SocialAccount.findById(otherIg._id);
    assert.ok(fbDoc.lastVerifiedAt instanceof Date);
    assert.equal(fbDoc.tokenExpiresAt, null, 'Meta said it never expires — stored as null, not invented');
    assert.equal(fbDoc.dataAccessExpiresAt.getTime(), dataAccess * 1000);
    assert.ok(igDoc.lastVerifiedAt instanceof Date, 'the linked Instagram row shares the token, so shares the verification');
    assert.equal(unrelated.lastVerifiedAt, null, 'a different Page\'s Instagram row is untouched');
  });

  test('an invalid token marks the account expired with a reason — and expires the linked Instagram row too, but nothing unrelated', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const health = await withRequest(async () => debugTokenResponse({ valid: false }), () => verifyAccount(fb));

    assert.equal(health.status, 'expired');
    assert.equal(health.requiresReconnect, true);
    assert.equal((await SocialAccount.findById(fb._id)).status, 'expired');
    assert.equal((await SocialAccount.findById(fb._id)).statusReason, 'META_TOKEN_INVALID');
    assert.equal((await SocialAccount.findById(ig._id)).status, 'expired');
    assert.equal((await SocialAccount.findById(otherIg._id)).status, 'active');
  });

  test('a failed check (Meta unreachable) changes NOTHING — status stays active and lastVerifiedAt stays null', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const health = await withRequest(async () => ({ success: false, kind: 'timeout', status: null, data: null }), () => verifyAccount(fb));
    assert.equal(health.valid, null, 'unverifiable is reported as null, not false');
    const doc = await SocialAccount.findById(fb._id);
    assert.equal(doc.status, 'active');
    assert.equal(doc.lastVerifiedAt, null);
  });

  test('markAccountExpired never resurrects or touches a user-REVOKED row', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialAccount.updateOne({ _id: ig._id }, { $set: { status: 'revoked' } });
    await markAccountExpired(fb);
    assert.equal((await SocialAccount.findById(ig._id)).status, 'revoked');
    assert.equal((await SocialAccount.findById(fb._id)).status, 'expired');
  });

  test('marking an Instagram account expired also expires the Facebook Page whose token it shares', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await markAccountExpired(await SocialAccount.findById(ig._id));
    assert.equal((await SocialAccount.findById(fb._id)).status, 'expired');
    assert.equal((await SocialAccount.findById(ig._id)).status, 'expired');
  });

  test('verifyProjectAccounts makes ONE Meta call per distinct token (Page + its Instagram share one) and returns token-free health', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const out = await withRequest(async () => debugTokenResponse(), async (calls) => {
      const result = await verifyProjectAccounts(project);
      // fb + ig(pg_1) share a token; ig(pg_other) is its own group => 2 calls for 3 accounts.
      assert.equal(calls.length, 2);
      return result;
    });
    assert.equal(out.length, 3);
    assert.ok(out.every((a) => a.valid === true && a.status === 'active'));
    assert.ok(!JSON.stringify(out).includes(SECRET_TOKEN), 'health output must never contain a token');
    assert.ok(!('accessToken' in out[0]));
  });

  test('applyInspection with an expired verdict is idempotent and safe to repeat', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const bad = { success: true, valid: false, reason: 'META_TOKEN_INVALID' };
    await applyInspection(fb, bad);
    const again = await applyInspection(await SocialAccount.findById(fb._id), bad);
    assert.equal(again.status, 'expired');
  });
});
