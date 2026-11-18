import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import SocialAccount from '../model/SocialAccount.js';
import { installDebugTokenStub, debugTokenResponse } from '../testSupport/metaDebugTokenStub.js';
import {
  persistDiscoveredFacebookPages, REASON_PAGE_NOT_ACCESSIBLE, resetStatusVerifyThrottle, STATUS_VERIFY_MAX_AGE_MS,
} from '../service/facebookAccountService.js';
import { getSocialAccountsStatus } from './socialAccountController.js';

/**
 * Real incident (Nov 2026): the Sapphire projects' active Facebook Page
 * stopped being returned by /me/accounts and Meta rejected its stored token
 * ("This Page access token belongs to a Page that is not accessible", code
 * 190) — yet Odito kept it status:'active' and the status API said
 * "connected". Two fixes are covered here:
 *   1. a reconnect checks every still-active Page Meta did NOT return and
 *      expires it only when Meta confirms its token is dead;
 *   2. the status endpoint re-verifies the active Page when its last check
 *      is stale, so a dead token reports "reconnect required".
 * Real MongoDB, real functions; only Meta's /debug_token is stubbed, keyed
 * by the (fake) token so each Page can answer differently.
 */

let mongoAvailable = false;
// token -> 'valid' | 'invalid' | 'outage'
const tokenMode = new Map();
let stub = () => {};

before(async () => {
  stub = installDebugTokenStub({
    respond: (opts) => {
      const mode = tokenMode.get(opts.params?.input_token) || 'valid';
      if (mode === 'outage') return { success: false, status: 503, kind: 'http', data: null, message: 'unavailable' };
      return debugTokenResponse({ valid: mode === 'valid' });
    },
  });
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch {
    mongoAvailable = false;
  }
});

after(async () => {
  stub();
  if (mongoAvailable) await mongoose.connection.close();
});

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

const page = (id, token) => ({ id, name: `Page ${id}`, category: 'Business', picture: null, accessToken: token, tasks: ['MANAGE'] });

describe('reconnect reconciles Pages Meta no longer returns', () => {
  let userId, project;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    tokenMode.clear();
    stub.calls.length = 0;
    userId = new mongoose.Types.ObjectId();
    project = await SeoProject.create({ user_id: userId, project_name: `Reconcile Test ${Date.now()}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['reconcile'] });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    await SeoProject.deleteOne({ _id: project._id });
    await SocialAccount.deleteMany({ project_id: project._id });
  });

  test('1: a Page missing from the new grant whose token Meta rejects is expired, together with its Instagram copy', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = project._id.toString();
    await persistDiscoveredFacebookPages({ userId, projectId, pages: [page('pg_lost', 'tok_lost'), page('pg_kept', 'tok_kept_1')], selectedPageId: 'pg_lost', scopes: [] });
    await SocialAccount.create({ user_id: userId, project_id: project._id, platform: 'instagram', platformAccountId: 'ig_lost', platformAccountName: 'lost_ig', pageId: 'pg_lost', accountType: 'business', accessToken: 'tok_lost', status: 'active' });

    tokenMode.set('tok_lost', 'invalid');
    const result = await persistDiscoveredFacebookPages({ userId, projectId, pages: [page('pg_kept', 'tok_kept_2')], selectedPageId: 'pg_kept', scopes: [] });

    assert.equal(result.expiredCount, 1);
    const lost = await SocialAccount.findOne({ project_id: project._id, platform: 'facebook', platformAccountId: 'pg_lost' });
    assert.equal(lost.status, 'expired');
    assert.equal(lost.statusReason, REASON_PAGE_NOT_ACCESSIBLE);
    assert.equal(lost.isActive, false, 'the newly selected Page takes over as active');
    const ig = await SocialAccount.findOne({ project_id: project._id, platform: 'instagram', pageId: 'pg_lost' });
    assert.equal(ig.status, 'expired', 'the Instagram row shares the dead Page token');
    const kept = await SocialAccount.findOne({ project_id: project._id, platform: 'facebook', platformAccountId: 'pg_kept' });
    assert.equal(kept.status, 'active');
    assert.equal(kept.isActive, true);
  });

  test('2: a missing Page whose token is still valid (another Facebook login\'s Page) stays connected and gets verified', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = project._id.toString();
    await persistDiscoveredFacebookPages({ userId, projectId, pages: [page('pg_other_login', 'tok_other')], selectedPageId: 'pg_other_login', scopes: [] });
    const result = await persistDiscoveredFacebookPages({ userId, projectId, pages: [page('pg_this_login', 'tok_this')], selectedPageId: 'pg_this_login', scopes: [] });

    assert.equal(result.expiredCount, 0);
    const other = await SocialAccount.findOne({ project_id: project._id, platformAccountId: 'pg_other_login' });
    assert.equal(other.status, 'active', 'union, not replace: still-valid Pages survive');
    assert.ok(other.lastVerifiedAt, 'the check that ran is recorded');
  });

  test('3: when Meta cannot be reached, a missing Page is left exactly as it was — an outage never expires a connection', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = project._id.toString();
    await persistDiscoveredFacebookPages({ userId, projectId, pages: [page('pg_unknown', 'tok_unknown')], selectedPageId: 'pg_unknown', scopes: [] });
    tokenMode.set('tok_unknown', 'outage');
    const result = await persistDiscoveredFacebookPages({ userId, projectId, pages: [page('pg_new', 'tok_new')], selectedPageId: 'pg_new', scopes: [] });

    assert.equal(result.expiredCount, 0);
    const unknown = await SocialAccount.findOne({ project_id: project._id, platformAccountId: 'pg_unknown' });
    assert.equal(unknown.status, 'active');
  });

  test('4: Pages Meta DID return are never sent to debug_token by the reconcile step', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const projectId = project._id.toString();
    await persistDiscoveredFacebookPages({ userId, projectId, pages: [page('pg_1', 'tok_1a'), page('pg_2', 'tok_2a')], selectedPageId: 'pg_1', scopes: [] });
    stub.calls.length = 0;
    await persistDiscoveredFacebookPages({ userId, projectId, pages: [page('pg_1', 'tok_1b'), page('pg_2', 'tok_2b')], selectedPageId: 'pg_2', scopes: [] });
    assert.equal(stub.calls.length, 0);
  });
});

describe('status endpoint re-verifies a stale active Page', () => {
  let userId, project;
  const stale = () => new Date(Date.now() - STATUS_VERIFY_MAX_AGE_MS - 60_000);

  beforeEach(async () => {
    if (!mongoAvailable) return;
    tokenMode.clear();
    stub.calls.length = 0;
    resetStatusVerifyThrottle();
    userId = new mongoose.Types.ObjectId();
    project = await SeoProject.create({ user_id: userId, project_name: `Status Verify Test ${Date.now()}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['status verify'] });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    await SeoProject.deleteOne({ _id: project._id });
    await SocialAccount.deleteMany({ project_id: project._id });
  });

  const createActive = (token, lastVerifiedAt) => SocialAccount.create({
    user_id: userId, project_id: project._id, platform: 'facebook', platformAccountId: 'pg_status', platformAccountName: 'Status Page',
    pageId: 'pg_status', accountType: 'page', accessToken: token, status: 'active', isActive: true, lastVerifiedAt,
  });
  const status = async () => {
    const res = mockRes();
    await getSocialAccountsStatus({ user: { _id: userId }, projectId: project._id.toString() }, res);
    return res.body.data;
  };

  test('1: a stale active Page whose token Meta rejects is reported "reconnect required", not connected', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await createActive('tok_dead', stale());
    tokenMode.set('tok_dead', 'invalid');

    const data = await status();
    assert.equal(data.facebook.connected, false);
    assert.equal(data.facebook.status, 'expired');
    assert.equal(data.facebook.requiresReconnect, true);
    assert.equal(data.facebook.accountName, 'Status Page');
  });

  test('2: a recently verified Page is not re-checked', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await createActive('tok_fresh', new Date());
    const data = await status();
    assert.equal(data.facebook.connected, true);
    assert.equal(stub.calls.length, 0);
  });

  test('3: an outage keeps the Page connected, and a second status load in the same window does not call Meta again', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await createActive('tok_outage', null);
    tokenMode.set('tok_outage', 'outage');

    assert.equal((await status()).facebook.connected, true);
    assert.equal((await status()).facebook.connected, true);
    assert.equal(stub.calls.length, 1, 'one attempt per window, even when it failed');
  });

  test('4: a stale but valid Page stays connected and its lastVerifiedAt moves forward', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const before = stale();
    await createActive('tok_ok', before);
    const data = await status();
    assert.equal(data.facebook.connected, true);
    assert.ok(new Date(data.facebook.lastVerifiedAt).getTime() > before.getTime());
  });

  test('5: SOCIAL_STATUS_VERIFY=off skips the check', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await createActive('tok_dead_2', stale());
    tokenMode.set('tok_dead_2', 'invalid');
    process.env.SOCIAL_STATUS_VERIFY = 'off';
    try {
      assert.equal((await status()).facebook.connected, true);
      assert.equal(stub.calls.length, 0);
    } finally {
      delete process.env.SOCIAL_STATUS_VERIFY;
    }
  });
});
