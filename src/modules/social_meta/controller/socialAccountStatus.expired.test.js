import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SocialAccount from '../model/SocialAccount.js';
import { getSocialAccountsStatus, disconnectSocialAccount, verifySocialAccounts } from './socialAccountController.js';
import { markAccountExpired } from '../service/metaTokenService.js';
import { installDebugTokenStub } from '../testSupport/metaDebugTokenStub.js';

/**
 * Status API for an EXPIRED connection (P0 #2/#4): the UI must be able to
 * tell "Reconnect required" apart from "never connected", and the response
 * must never carry a token.
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

const TOKEN = 'STATUS-API-SECRET-TOKEN-9f9f';

function mockRes() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; } };
}

describe('GET /social/accounts — expired connections', () => {
  let userId, projectId;
  const make = (over) => SocialAccount.create({
    user_id: userId, project_id: projectId, accessToken: TOKEN, scopes: ['pages_manage_posts', 'instagram_content_publish'], status: 'active', ...over,
  });
  const status = async () => {
    const res = mockRes();
    await getSocialAccountsStatus({ user: { _id: userId }, projectId: projectId.toString() }, res);
    return res.body.data;
  };

  beforeEach(() => { userId = new mongoose.Types.ObjectId(); projectId = new mongoose.Types.ObjectId(); });
  afterEach(async () => { if (mongoAvailable) await SocialAccount.deleteMany({ project_id: projectId }); });

  test('an ACTIVE connection reports status:"active", requiresReconnect:false and lastVerifiedAt', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const verified = new Date();
    await make({ platform: 'facebook', platformAccountId: 'pg_1', pageId: 'pg_1', accountType: 'page', isActive: true, lastVerifiedAt: verified });
    const d = await status();
    assert.equal(d.facebook.connected, true);
    assert.equal(d.facebook.status, 'active');
    assert.equal(d.facebook.requiresReconnect, false);
    assert.equal(new Date(d.facebook.lastVerifiedAt).getTime(), verified.getTime());
  });

  test('an EXPIRED Page reports { connected:false, status:"expired", requiresReconnect:true } — distinguishable from never-connected', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const fb = await make({ platform: 'facebook', platformAccountId: 'pg_1', platformAccountName: 'Acme Page', pageId: 'pg_1', accountType: 'page', isActive: true });
    await markAccountExpired(fb);
    const d = await status();
    assert.equal(d.facebook.connected, false);
    assert.equal(d.facebook.status, 'expired');
    assert.equal(d.facebook.requiresReconnect, true);
    assert.equal(d.facebook.accountName, 'Acme Page', 'tells the user WHICH account needs reconnecting');
    assert.equal(d.facebook.socialAccountId, undefined, 'an expired account is not offered for publishing');
  });

  test('never-connected is unchanged: { connected:false } (no status, no requiresReconnect)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const d = await status();
    assert.deepEqual(d.facebook, { connected: false });
    assert.deepEqual(d.instagram, { connected: false, reason: 'NOT_CONNECTED' });
  });

  test('expiring a Page expires its linked Instagram too, and BOTH report requiresReconnect', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const fb = await make({ platform: 'facebook', platformAccountId: 'pg_1', pageId: 'pg_1', accountType: 'page', isActive: true });
    await make({ platform: 'instagram', platformAccountId: 'ig_1', pageId: 'pg_1', instagramBusinessAccountId: 'ig_1', platformAccountName: 'brand_ig', accountType: 'business' });
    await markAccountExpired(fb);
    const d = await status();
    assert.equal(d.facebook.requiresReconnect, true);
    assert.equal(d.instagram.connected, false);
    assert.equal(d.instagram.status, 'expired');
    assert.equal(d.instagram.requiresReconnect, true);
  });

  test('if the explicitly-ACTIVE Page expired, that is reported — another still-active Page is not silently promoted', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const active = await make({ platform: 'facebook', platformAccountId: 'pg_main', pageId: 'pg_main', accountType: 'page', isActive: true });
    await make({ platform: 'facebook', platformAccountId: 'pg_other', pageId: 'pg_other', accountType: 'page', isActive: false });
    await markAccountExpired(active); // only pg_main's token is dead
    const d = await status();
    assert.equal(d.facebook.status, 'expired');
    assert.equal(d.facebook.accountId, 'pg_main');
  });

  test('no token of any kind appears anywhere in the status response (active or expired)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const fb = await make({ platform: 'facebook', platformAccountId: 'pg_1', pageId: 'pg_1', accountType: 'page', isActive: true });
    await make({ platform: 'instagram', platformAccountId: 'ig_1', pageId: 'pg_1', instagramBusinessAccountId: 'ig_1', accountType: 'business' });
    assert.ok(!JSON.stringify(await status()).includes(TOKEN));
    await markAccountExpired(fb);
    assert.ok(!JSON.stringify(await status()).includes(TOKEN));
  });

  test('a user-DISCONNECTED (revoked) account is NOT shown as "expired / reconnect required"', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await make({ platform: 'facebook', platformAccountId: 'pg_1', pageId: 'pg_1', accountType: 'page', isActive: true });
    const res = mockRes();
    await disconnectSocialAccount({ user: { _id: userId }, projectId: projectId.toString(), params: { platform: 'facebook' } }, res);
    const d = await status();
    assert.deepEqual(d.facebook, { connected: false });
    const row = await SocialAccount.findOne({ project_id: projectId, platform: 'facebook' });
    assert.equal(row.statusReason, 'USER_DISCONNECTED');
  });
});

describe('POST /social/accounts/verify', () => {
  let userId, projectId;
  beforeEach(() => { userId = new mongoose.Types.ObjectId(); projectId = new mongoose.Types.ObjectId(); });
  afterEach(async () => { if (mongoAvailable) await SocialAccount.deleteMany({ project_id: projectId }); });

  test('verifies live with Meta, flips a confirmed-dead connection to expired, and returns token-free health', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialAccount.create({ user_id: userId, project_id: projectId, platform: 'facebook', platformAccountId: 'pg_1', pageId: 'pg_1', accountType: 'page', accessToken: TOKEN, isActive: true, status: 'active' });
    const restore = installDebugTokenStub({ valid: false });
    try {
      const res = mockRes();
      await verifySocialAccounts({ user: { _id: userId }, projectId: projectId.toString() }, res);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.accounts[0].status, 'expired');
      assert.equal(res.body.data.accounts[0].requiresReconnect, true);
      assert.ok(!JSON.stringify(res.body).includes(TOKEN));
    } finally { restore(); }
    assert.equal((await SocialAccount.findOne({ project_id: projectId })).status, 'expired');
  });
});
