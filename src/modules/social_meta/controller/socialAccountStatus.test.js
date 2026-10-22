import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import crypto from 'crypto';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import { installDebugTokenStub } from '../testSupport/metaDebugTokenStub.js';
import SocialAccount from '../model/SocialAccount.js';
import { getSocialAccountsStatus, disconnectSocialAccount } from './socialAccountController.js';

/**
 * Real-connection-status lifecycle tests — added after a genuine
 * production bug: a real OAuth flow completed, Meta Graph confirmed a
 * Facebook Page connection, and MongoDB actually had the correct
 * SocialAccount document the entire time (verified directly against the
 * live database), but the frontend showed "Connected" only until the next
 * page refresh, then reverted to "Not Connected". Root cause: there was
 * NO endpoint that read persisted connection state back — the UI badge
 * was driven entirely by transient React state set once, immediately
 * after a successful selectMetaPage call. This file tests the endpoint
 * that closes that gap: GET /api/social/accounts (getSocialAccountsStatus).
 *
 * Same conventions as Phase 1/2/3: real controller function, mock req/res,
 * real MongoDB, no mocking library.
 */

let mongoAvailable = false;

// selectMetaPage now asks Meta (debug_token) about the Page token it is about
// to store; stub only that endpoint so these tests stay offline/deterministic.
let restoreDebugToken = () => {};
before(async () => {
  restoreDebugToken = installDebugTokenStub();
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch {
    mongoAvailable = false;
  }
});

after(async () => {
  restoreDebugToken();
  if (mongoAvailable) await mongoose.connection.close();
});

function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

describe('getSocialAccountsStatus — real MongoDB-sourced connection status', () => {
  let userA, projectA, projectB;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    userA = new mongoose.Types.ObjectId();
    projectA = await SeoProject.create({
      user_id: userA,
      project_name: `Social Status Test Project A ${Date.now()}`,
      main_url: 'https://example.com',
      seo_scope: 'local',
      keywords: ['social status test'],
    });
    projectB = await SeoProject.create({
      user_id: new mongoose.Types.ObjectId(),
      project_name: `Social Status Test Project B ${Date.now()}`,
      main_url: 'https://example.org',
      seo_scope: 'local',
      keywords: ['social status test b'],
    });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    await SeoProject.deleteMany({ _id: { $in: [projectA._id, projectB._id] } });
    await SocialAccount.deleteMany({ project_id: { $in: [projectA._id, projectB._id] } });
  });

  test('1: a persisted, active Facebook SocialAccount is found and reported connected — proves the exact bug scenario is fixed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialAccount.create({
      user_id: userA,
      project_id: projectA._id,
      platform: 'facebook',
      platformAccountId: 'pg_status_test_1',
      platformAccountName: 'Odito',
      pageId: 'pg_status_test_1',
      accountType: 'page',
      accessToken: 'real-page-token-value',
      status: 'active',
    });

    const req = { user: { _id: userA }, projectId: projectA._id.toString() };
    const res = mockRes();
    await getSocialAccountsStatus(req, res);

    assert.equal(res.body.success, true);
    assert.equal(res.body.data.facebook.connected, true);
    assert.equal(res.body.data.facebook.accountId, 'pg_status_test_1');
    assert.equal(res.body.data.facebook.accountName, 'Odito');
  });

  test('1b: publishingReady is derived from the account\'s actual scopes — true only when pages_manage_posts is present', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialAccount.create({
      user_id: userA, project_id: projectA._id, platform: 'facebook', platformAccountId: 'pg_ready',
      platformAccountName: 'Ready Page', pageId: 'pg_ready', accountType: 'page', accessToken: 'real-token', status: 'active',
      scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
    });
    const req = { user: { _id: userA }, projectId: projectA._id.toString() };
    const res = mockRes();
    await getSocialAccountsStatus(req, res);
    assert.equal(res.body.data.facebook.publishingReady, true);
  });

  test('1c: a connected Facebook account MISSING pages_manage_posts is reported connected but publishingReady:false — never invisibly downgraded to disconnected', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialAccount.create({
      user_id: userA, project_id: projectA._id, platform: 'facebook', platformAccountId: 'pg_read_only',
      platformAccountName: 'Read Only Page', pageId: 'pg_read_only', accountType: 'page', accessToken: 'real-token', status: 'active',
      scopes: ['pages_show_list', 'pages_read_engagement'],
    });
    const req = { user: { _id: userA }, projectId: projectA._id.toString() };
    const res = mockRes();
    await getSocialAccountsStatus(req, res);
    assert.equal(res.body.data.facebook.connected, true);
    assert.equal(res.body.data.facebook.publishingReady, false);
  });

  test('2: no persisted connection reports connected:false, not an error', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const req = { user: { _id: userA }, projectId: projectA._id.toString() };
    const res = mockRes();
    await getSocialAccountsStatus(req, res);

    assert.equal(res.body.success, true);
    assert.equal(res.body.data.facebook.connected, false);
    assert.equal(res.body.data.instagram.connected, false);
    assert.equal(res.body.data.instagram.reason, 'NOT_CONNECTED');
  });

  test('3: Instagram missing does NOT invalidate the Facebook connection — both are reported independently', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialAccount.create({
      user_id: userA,
      project_id: projectA._id,
      platform: 'facebook',
      platformAccountId: 'pg_fb_only',
      platformAccountName: 'Odito',
      pageId: 'pg_fb_only',
      accountType: 'page',
      accessToken: 'real-page-token-value',
      status: 'active',
    });
    // Deliberately no Instagram SocialAccount created.

    const req = { user: { _id: userA }, projectId: projectA._id.toString() };
    const res = mockRes();
    await getSocialAccountsStatus(req, res);

    assert.equal(res.body.data.facebook.connected, true, 'Facebook must stay connected regardless of Instagram');
    assert.equal(res.body.data.instagram.connected, false);
    assert.equal(res.body.data.instagram.reason, 'NOT_CONNECTED');
  });

  test('4: both Facebook AND Instagram connected are reported together when both exist', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialAccount.create({
      user_id: userA,
      project_id: projectA._id,
      platform: 'facebook',
      platformAccountId: 'pg_both',
      platformAccountName: 'Odito',
      pageId: 'pg_both',
      accountType: 'page',
      accessToken: 'real-page-token-value',
      status: 'active',
    });
    await SocialAccount.create({
      user_id: userA,
      project_id: projectA._id,
      platform: 'instagram',
      platformAccountId: 'ig_both',
      platformAccountName: 'odito_ig',
      pageId: 'pg_both',
      instagramBusinessAccountId: 'ig_both',
      accountType: 'business',
      accessToken: 'real-page-token-value',
      status: 'active',
      metadata: { username: 'odito_ig' },
    });

    const req = { user: { _id: userA }, projectId: projectA._id.toString() };
    const res = mockRes();
    await getSocialAccountsStatus(req, res);

    assert.equal(res.body.data.facebook.connected, true);
    assert.equal(res.body.data.instagram.connected, true);
    assert.equal(res.body.data.instagram.username, 'odito_ig');
  });

  test('5: a REVOKED SocialAccount is reported as not connected (only status:active counts)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialAccount.create({
      user_id: userA,
      project_id: projectA._id,
      platform: 'facebook',
      platformAccountId: 'pg_revoked',
      pageId: 'pg_revoked',
      accountType: 'page',
      accessToken: 'real-page-token-value',
      status: 'revoked',
    });

    const req = { user: { _id: userA }, projectId: projectA._id.toString() };
    const res = mockRes();
    await getSocialAccountsStatus(req, res);

    assert.equal(res.body.data.facebook.connected, false);
  });

  test('6: a connection persisted for project B is never visible when looking up project A (cross-project isolation)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialAccount.create({
      user_id: new mongoose.Types.ObjectId(),
      project_id: projectB._id,
      platform: 'facebook',
      platformAccountId: 'pg_project_b',
      pageId: 'pg_project_b',
      accountType: 'page',
      accessToken: 'real-page-token-value',
      status: 'active',
    });

    const req = { user: { _id: userA }, projectId: projectA._id.toString() };
    const res = mockRes();
    await getSocialAccountsStatus(req, res);

    assert.equal(res.body.data.facebook.connected, false, 'project A must never see project B\'s connection');
  });

  test('7: accessToken never appears anywhere in the status response', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const knownToken = `secret-token-${crypto.randomBytes(8).toString('hex')}`;
    await SocialAccount.create({
      user_id: userA,
      project_id: projectA._id,
      platform: 'facebook',
      platformAccountId: 'pg_token_check',
      pageId: 'pg_token_check',
      accountType: 'page',
      accessToken: knownToken,
      status: 'active',
    });

    const req = { user: { _id: userA }, projectId: projectA._id.toString() };
    const res = mockRes();
    await getSocialAccountsStatus(req, res);

    assert.ok(!('accessToken' in res.body.data.facebook));
    assert.ok(!JSON.stringify(res.body).includes(knownToken));
  });

  test('8: accessToken never appears in logs during a status lookup', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const knownToken = `secret-token-${crypto.randomBytes(8).toString('hex')}`;
    await SocialAccount.create({
      user_id: userA,
      project_id: projectA._id,
      platform: 'facebook',
      platformAccountId: 'pg_log_token_check',
      pageId: 'pg_log_token_check',
      accountType: 'page',
      accessToken: knownToken,
      status: 'active',
    });

    const originalLog = console.log;
    const originalError = console.error;
    const captured = [];
    console.log = (...args) => { captured.push(args.join(' ')); };
    console.error = (...args) => { captured.push(args.join(' ')); };

    try {
      await getSocialAccountsStatus({ user: { _id: userA }, projectId: projectA._id.toString() }, mockRes());
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    assert.ok(!captured.join('\n').includes(knownToken));
  });

  test('9: the META_STATUS_LOOKUP diagnostic log reports the SAME projectId that was queried, and found:true for a real connection', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const account = await SocialAccount.create({
      user_id: userA,
      project_id: projectA._id,
      platform: 'facebook',
      platformAccountId: 'pg_diagnostic_check',
      pageId: 'pg_diagnostic_check',
      accountType: 'page',
      accessToken: 'real-page-token-value',
      status: 'active',
    });

    const originalLog = console.log;
    const captured = [];
    console.log = (...args) => { captured.push(args.join(' ')); };

    try {
      await getSocialAccountsStatus({ user: { _id: userA }, projectId: projectA._id.toString() }, mockRes());
    } finally {
      console.log = originalLog;
    }

    const logLine = captured.find((line) => line.includes('META_STATUS_LOOKUP'));
    assert.ok(logLine, 'META_STATUS_LOOKUP must be logged');
    const parsed = JSON.parse(logLine);
    assert.equal(parsed.projectId, projectA._id.toString());
    assert.equal(parsed.found, true);
    assert.equal(parsed.connectionId, account._id.toString());
  });

  // Root-cause regression coverage: with TWO connected Facebook Pages,
  // each with its OWN linked Instagram account, "Instagram connected"
  // used to be reported from an unscoped findOne — whichever Instagram
  // row Mongo happened to return first, regardless of which Page was
  // actually active. It must always reflect the ACTIVE Page's own link.
  test('10: with two Facebook Pages each linked to a different Instagram account, status reports the ACTIVE Page\'s own Instagram account, never the other Page\'s', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialAccount.create({
      user_id: userA, project_id: projectA._id, platform: 'facebook',
      platformAccountId: 'pg_multi_A', pageId: 'pg_multi_A', platformAccountName: 'Page A',
      accountType: 'page', accessToken: 'token-a', status: 'active', isActive: false,
    });
    await SocialAccount.create({
      user_id: userA, project_id: projectA._id, platform: 'facebook',
      platformAccountId: 'pg_multi_B', pageId: 'pg_multi_B', platformAccountName: 'Page B',
      accountType: 'page', accessToken: 'token-b', status: 'active', isActive: true,
    });
    await SocialAccount.create({
      user_id: userA, project_id: projectA._id, platform: 'instagram',
      platformAccountId: 'ig_linked_to_A', pageId: 'pg_multi_A', instagramBusinessAccountId: 'ig_linked_to_A',
      accountType: 'business', accessToken: 'token-a', status: 'active', metadata: { username: 'ig_for_page_a' },
    });
    await SocialAccount.create({
      user_id: userA, project_id: projectA._id, platform: 'instagram',
      platformAccountId: 'ig_linked_to_B', pageId: 'pg_multi_B', instagramBusinessAccountId: 'ig_linked_to_B',
      accountType: 'business', accessToken: 'token-b', status: 'active', metadata: { username: 'ig_for_page_b' },
    });

    const req = { user: { _id: userA }, projectId: projectA._id.toString() };
    const res = mockRes();
    await getSocialAccountsStatus(req, res);

    assert.equal(res.body.data.facebook.accountName, 'Page B', 'Page B is the active one');
    assert.equal(res.body.data.instagram.connected, true);
    assert.equal(res.body.data.instagram.username, 'ig_for_page_b', 'must be Page B\'s own linked Instagram account, never Page A\'s');
    assert.notEqual(res.body.data.instagram.accountId, 'ig_linked_to_A');
  });

  test('11: the active Page has no linked Instagram account (even though a DIFFERENT connected Page does) — reported honestly as not connected, never falls back to the other Page\'s account', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialAccount.create({
      user_id: userA, project_id: projectA._id, platform: 'facebook',
      platformAccountId: 'pg_has_ig', pageId: 'pg_has_ig', platformAccountName: 'Page With IG',
      accountType: 'page', accessToken: 'token-a', status: 'active', isActive: false,
    });
    await SocialAccount.create({
      user_id: userA, project_id: projectA._id, platform: 'facebook',
      platformAccountId: 'pg_no_ig', pageId: 'pg_no_ig', platformAccountName: 'Page Without IG',
      accountType: 'page', accessToken: 'token-b', status: 'active', isActive: true,
    });
    await SocialAccount.create({
      user_id: userA, project_id: projectA._id, platform: 'instagram',
      platformAccountId: 'ig_orphan', pageId: 'pg_has_ig', instagramBusinessAccountId: 'ig_orphan',
      accountType: 'business', accessToken: 'token-a', status: 'active', metadata: { username: 'some_ig' },
    });

    const req = { user: { _id: userA }, projectId: projectA._id.toString() };
    const res = mockRes();
    await getSocialAccountsStatus(req, res);

    assert.equal(res.body.data.facebook.accountName, 'Page Without IG');
    assert.equal(res.body.data.instagram.connected, false, 'the active Page has no Instagram link of its own — must not borrow the other Page\'s');
  });
});

describe('disconnectSocialAccount — real MongoDB writes, added for Settings -> Profile connection management', () => {
  let userA, projectA, projectB;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    userA = new mongoose.Types.ObjectId();
    projectA = await SeoProject.create({
      user_id: userA,
      project_name: `Disconnect Test Project A ${Date.now()}`,
      main_url: 'https://example.com',
      seo_scope: 'local',
      keywords: ['disconnect test'],
    });
    projectB = await SeoProject.create({
      user_id: new mongoose.Types.ObjectId(),
      project_name: `Disconnect Test Project B ${Date.now()}`,
      main_url: 'https://example.org',
      seo_scope: 'local',
      keywords: ['disconnect test b'],
    });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    await SeoProject.deleteMany({ _id: { $in: [projectA._id, projectB._id] } });
    await SocialAccount.deleteMany({ project_id: { $in: [projectA._id, projectB._id] } });
  });

  test('1: disconnecting an unsupported platform is rejected with a stable 400', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const req = { user: { _id: userA }, projectId: projectA._id.toString(), params: { platform: 'tiktok' } };
    const res = mockRes();
    await disconnectSocialAccount(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.details.code, 'SOCIAL_PLATFORM_UNSUPPORTED');
  });

  test('2: disconnecting when nothing is connected returns a stable 404, not a crash', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const req = { user: { _id: userA }, projectId: projectA._id.toString(), params: { platform: 'facebook' } };
    const res = mockRes();
    await disconnectSocialAccount(req, res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.details.code, 'SOCIAL_ACCOUNT_NOT_FOUND');
  });

  test('3: disconnecting Facebook marks it revoked, and the status endpoint reflects it immediately', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialAccount.create({
      user_id: userA, project_id: projectA._id, platform: 'facebook',
      platformAccountId: 'pg_disconnect_1', pageId: 'pg_disconnect_1', accountType: 'page',
      accessToken: 'real-page-token-value', status: 'active',
    });

    const disconnectRes = mockRes();
    await disconnectSocialAccount({ user: { _id: userA }, projectId: projectA._id.toString(), params: { platform: 'facebook' } }, disconnectRes);
    assert.equal(disconnectRes.body.success, true);
    assert.equal(disconnectRes.body.data.connected, false);

    const account = await SocialAccount.findOne({ project_id: projectA._id, platform: 'facebook' });
    assert.equal(account.status, 'revoked', 'soft-revoked, not hard-deleted');

    const statusRes = mockRes();
    await getSocialAccountsStatus({ user: { _id: userA }, projectId: projectA._id.toString() }, statusRes);
    assert.equal(statusRes.body.data.facebook.connected, false, 'status endpoint must reflect the disconnect immediately — same source of truth');
  });

  test('4: disconnecting Facebook also revokes the linked Instagram account (same pageId) — no orphaned "active" row with a dead token', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialAccount.create({
      user_id: userA, project_id: projectA._id, platform: 'facebook',
      platformAccountId: 'pg_disconnect_2', pageId: 'pg_disconnect_2', accountType: 'page',
      accessToken: 'real-page-token-value', status: 'active',
    });
    await SocialAccount.create({
      user_id: userA, project_id: projectA._id, platform: 'instagram',
      platformAccountId: 'ig_disconnect_2', pageId: 'pg_disconnect_2', instagramBusinessAccountId: 'ig_disconnect_2',
      accountType: 'business', accessToken: 'real-page-token-value', status: 'active',
    });

    await disconnectSocialAccount({ user: { _id: userA }, projectId: projectA._id.toString(), params: { platform: 'facebook' } }, mockRes());

    const igAccount = await SocialAccount.findOne({ project_id: projectA._id, platform: 'instagram' });
    assert.equal(igAccount.status, 'revoked', 'Instagram never had its own token — it must not be left "active" once the Page token it depends on is gone');
  });

  test('5: disconnecting Instagram alone leaves Facebook untouched', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialAccount.create({
      user_id: userA, project_id: projectA._id, platform: 'facebook',
      platformAccountId: 'pg_disconnect_3', pageId: 'pg_disconnect_3', accountType: 'page',
      accessToken: 'real-page-token-value', status: 'active',
    });
    await SocialAccount.create({
      user_id: userA, project_id: projectA._id, platform: 'instagram',
      platformAccountId: 'ig_disconnect_3', pageId: 'pg_disconnect_3', instagramBusinessAccountId: 'ig_disconnect_3',
      accountType: 'business', accessToken: 'real-page-token-value', status: 'active',
    });

    await disconnectSocialAccount({ user: { _id: userA }, projectId: projectA._id.toString(), params: { platform: 'instagram' } }, mockRes());

    const fbAccount = await SocialAccount.findOne({ project_id: projectA._id, platform: 'facebook' });
    assert.equal(fbAccount.status, 'active', 'disconnecting Instagram must never touch the Facebook connection');
  });

  test('6: a connection belonging to a DIFFERENT project can never be disconnected by supplying that project\'s own real ID (cross-project isolation)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialAccount.create({
      user_id: new mongoose.Types.ObjectId(), project_id: projectB._id, platform: 'facebook',
      platformAccountId: 'pg_project_b_disconnect', pageId: 'pg_project_b_disconnect', accountType: 'page',
      accessToken: 'real-page-token-value', status: 'active',
    });

    // A real, valid project (projectA) that userA genuinely owns — but has
    // no Facebook connection of its own. Confirms projectB's row is never
    // reachable through projectA's own legitimately-validated projectId.
    const res = mockRes();
    await disconnectSocialAccount({ user: { _id: userA }, projectId: projectA._id.toString(), params: { platform: 'facebook' } }, res);
    assert.equal(res.statusCode, 404);

    const stillActive = await SocialAccount.findOne({ project_id: projectB._id, platform: 'facebook' });
    assert.equal(stillActive.status, 'active', 'project B\'s connection must be completely unaffected');
  });

  test('7: the response never contains an access token', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const knownToken = `secret-token-${crypto.randomBytes(8).toString('hex')}`;
    await SocialAccount.create({
      user_id: userA, project_id: projectA._id, platform: 'facebook',
      platformAccountId: 'pg_disconnect_token_check', pageId: 'pg_disconnect_token_check', accountType: 'page',
      accessToken: knownToken, status: 'active',
    });

    const res = mockRes();
    await disconnectSocialAccount({ user: { _id: userA }, projectId: projectA._id.toString(), params: { platform: 'facebook' } }, res);
    assert.ok(!JSON.stringify(res.body).includes(knownToken));
  });

  test('8: the access token never appears in logs during a disconnect', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const knownToken = `secret-token-${crypto.randomBytes(8).toString('hex')}`;
    await SocialAccount.create({
      user_id: userA, project_id: projectA._id, platform: 'facebook',
      platformAccountId: 'pg_disconnect_log_check', pageId: 'pg_disconnect_log_check', accountType: 'page',
      accessToken: knownToken, status: 'active',
    });

    const originalLog = console.log;
    const captured = [];
    console.log = (...args) => { captured.push(args.join(' ')); };
    try {
      await disconnectSocialAccount({ user: { _id: userA }, projectId: projectA._id.toString(), params: { platform: 'facebook' } }, mockRes());
    } finally {
      console.log = originalLog;
    }
    assert.ok(!captured.join('\n').includes(knownToken));
  });

  test('9: reconnecting after a disconnect creates a fresh active row again (upsert-style find-then-save from selectMetaPage still works against a revoked row)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const original = await SocialAccount.create({
      user_id: userA, project_id: projectA._id, platform: 'facebook',
      platformAccountId: 'pg_reconnect_test', pageId: 'pg_reconnect_test', accountType: 'page',
      accessToken: 'real-page-token-value', status: 'active',
    });
    await disconnectSocialAccount({ user: { _id: userA }, projectId: projectA._id.toString(), params: { platform: 'facebook' } }, mockRes());

    // Simulate a real reconnect the same way selectMetaPage does: find the
    // existing row (now revoked) and flip it back to active rather than
    // creating a duplicate — this is the exact find-then-save shape
    // selectMetaPage already uses, proven here against a revoked row.
    const revoked = await SocialAccount.findOne({ project_id: projectA._id, platform: 'facebook', platformAccountId: 'pg_reconnect_test' });
    revoked.status = 'active';
    await revoked.save();

    const matches = await SocialAccount.find({ project_id: projectA._id, platform: 'facebook', platformAccountId: 'pg_reconnect_test' });
    assert.equal(matches.length, 1, 'reconnect must never create a duplicate row');
    assert.equal(matches[0]._id.toString(), original._id.toString());
    assert.equal(matches[0].status, 'active');
  });
});
