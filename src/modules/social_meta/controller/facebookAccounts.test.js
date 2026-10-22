import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import crypto from 'crypto';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import SocialAccount from '../model/SocialAccount.js';
import { listFacebookAccounts, getActiveFacebookAccount, setActiveFacebookAccount, persistDiscoveredFacebookPages } from '../service/facebookAccountService.js';
import { getFacebookAccountsHandler, switchFacebookAccountHandler } from './facebookController.js';
import metaInstagramService from '../service/metaInstagramService.js';

/**
 * Switch Account feature — added after a real report that only one of
 * several actually-connected Facebook Pages was ever available/shown.
 * The schema always allowed multiple Pages per project (unique index was
 * project+platform+platformAccountId, never project+platform alone); what
 * was missing was (a) persisting every discovered Page, not just the one
 * clicked, and (b) an explicit "which one is active" concept, since
 * getSocialAccountsStatus/getFacebookOverview both previously assumed
 * there was only ever one. These tests cover both halves.
 *
 * Same conventions as the rest of this module: real functions, mock
 * req/res where an HTTP layer is exercised, real MongoDB, no mocking
 * library.
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
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

function fakePendingPage(overrides = {}) {
  return {
    id: overrides.id || `pg_${new mongoose.Types.ObjectId().toString()}`,
    name: overrides.name ?? 'Test Page',
    category: overrides.category ?? 'Business',
    picture: overrides.picture ?? null,
    accessToken: overrides.accessToken || `real-page-token-${crypto.randomBytes(6).toString('hex')}`,
    tasks: overrides.tasks || ['MANAGE'],
  };
}

describe('persistDiscoveredFacebookPages — multi-Page persistence from a single OAuth grant', () => {
  let userA, projectA;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    userA = new mongoose.Types.ObjectId();
    projectA = await SeoProject.create({
      user_id: userA,
      project_name: `Switch Account Test Project ${Date.now()}`,
      main_url: 'https://example.com',
      seo_scope: 'local',
      keywords: ['switch account test'],
    });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    await SeoProject.deleteOne({ _id: projectA._id });
    await SocialAccount.deleteMany({ project_id: projectA._id });
  });

  test('1: all discovered Pages are persisted, not just the one selected', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pages = [fakePendingPage({ id: 'pg_a', name: 'Nashik City Guide' }), fakePendingPage({ id: 'pg_b', name: 'Jethwa Eye Hospital' }), fakePendingPage({ id: 'pg_c', name: 'Krishna Eye Centre' })];
    const result = await persistDiscoveredFacebookPages({ userId: userA, projectId: projectA._id.toString(), pages, selectedPageId: 'pg_a', scopes: ['pages_show_list'] });

    assert.equal(result.savedCount, 3, 'all 3 Pages must be persisted, not just the selected one');
    const stored = await SocialAccount.find({ project_id: projectA._id, platform: 'facebook' });
    assert.equal(stored.length, 3);
    assert.deepEqual(stored.map((a) => a.platformAccountId).sort(), ['pg_a', 'pg_b', 'pg_c']);
  });

  test('2: only the selected Page becomes active; the others are connected but inactive', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pages = [fakePendingPage({ id: 'pg_x' }), fakePendingPage({ id: 'pg_y' }), fakePendingPage({ id: 'pg_z' })];
    await persistDiscoveredFacebookPages({ userId: userA, projectId: projectA._id.toString(), pages, selectedPageId: 'pg_y', scopes: [] });

    const stored = await SocialAccount.find({ project_id: projectA._id, platform: 'facebook' });
    const active = stored.filter((a) => a.isActive);
    assert.equal(active.length, 1, 'exactly one Page must be active');
    assert.equal(active[0].platformAccountId, 'pg_y');
    assert.equal(stored.find((a) => a.platformAccountId === 'pg_x').isActive, false);
    assert.equal(stored.find((a) => a.platformAccountId === 'pg_z').isActive, false);
    // All three remain genuinely connected — inactive is not the same as revoked.
    assert.ok(stored.every((a) => a.status === 'active'));
  });

  test('3: a later, separate connection with a DIFFERENT selected Page preserves the earlier Pages (union, not replace)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await persistDiscoveredFacebookPages({ userId: userA, projectId: projectA._id.toString(), pages: [fakePendingPage({ id: 'pg_first' })], selectedPageId: 'pg_first', scopes: [] });
    await persistDiscoveredFacebookPages({ userId: userA, projectId: projectA._id.toString(), pages: [fakePendingPage({ id: 'pg_second' })], selectedPageId: 'pg_second', scopes: [] });

    const stored = await SocialAccount.find({ project_id: projectA._id, platform: 'facebook' });
    assert.equal(stored.length, 2, 'the first Page must still exist after a second, separate connection');
    assert.equal(stored.find((a) => a.platformAccountId === 'pg_first').isActive, false, 'the newly selected Page takes over as active');
    assert.equal(stored.find((a) => a.platformAccountId === 'pg_second').isActive, true);
  });

  test('4: re-selecting an already-persisted Page updates it in place, never duplicates', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await persistDiscoveredFacebookPages({ userId: userA, projectId: projectA._id.toString(), pages: [fakePendingPage({ id: 'pg_repeat', name: 'Old Name' })], selectedPageId: 'pg_repeat', scopes: [] });
    await persistDiscoveredFacebookPages({ userId: userA, projectId: projectA._id.toString(), pages: [fakePendingPage({ id: 'pg_repeat', name: 'New Name' })], selectedPageId: 'pg_repeat', scopes: [] });

    const stored = await SocialAccount.find({ project_id: projectA._id, platform: 'facebook', platformAccountId: 'pg_repeat' });
    assert.equal(stored.length, 1);
    assert.equal(stored[0].platformAccountName, 'New Name');
  });
});

describe('getActiveFacebookAccount — fallback behavior for pre-feature connections', () => {
  let projectA;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    projectA = await SeoProject.create({
      user_id: new mongoose.Types.ObjectId(),
      project_name: `Active Fallback Test ${Date.now()}`,
      main_url: 'https://example.com',
      seo_scope: 'local',
      keywords: ['active fallback test'],
    });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    await SeoProject.deleteOne({ _id: projectA._id });
    await SocialAccount.deleteMany({ project_id: projectA._id });
  });

  test('1: no connected Pages returns null, not an error', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await getActiveFacebookAccount(projectA._id.toString());
    assert.equal(result, null);
  });

  test('2: exactly one connected Page, none explicitly flagged active, is treated as active (backward compatibility)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialAccount.create({ user_id: new mongoose.Types.ObjectId(), project_id: projectA._id, platform: 'facebook', platformAccountId: 'pg_only', accountType: 'page', accessToken: 'token', status: 'active' });
    const result = await getActiveFacebookAccount(projectA._id.toString());
    assert.ok(result);
    assert.equal(result.platformAccountId, 'pg_only');
  });

  test('3: an explicitly-flagged active Page is always preferred, even among several connected Pages', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const userId = new mongoose.Types.ObjectId();
    await SocialAccount.create({ user_id: userId, project_id: projectA._id, platform: 'facebook', platformAccountId: 'pg_1', accountType: 'page', accessToken: 'token', status: 'active', isActive: false });
    await SocialAccount.create({ user_id: userId, project_id: projectA._id, platform: 'facebook', platformAccountId: 'pg_2', accountType: 'page', accessToken: 'token', status: 'active', isActive: true });
    const result = await getActiveFacebookAccount(projectA._id.toString());
    assert.equal(result.platformAccountId, 'pg_2');
  });

  test('4: "refresh" (a second, independent call) returns the SAME active account — persisted, not session state', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialAccount.create({ user_id: new mongoose.Types.ObjectId(), project_id: projectA._id, platform: 'facebook', platformAccountId: 'pg_stable', accountType: 'page', accessToken: 'token', status: 'active', isActive: true });
    const first = await getActiveFacebookAccount(projectA._id.toString());
    const second = await getActiveFacebookAccount(projectA._id.toString());
    assert.equal(first.platformAccountId, second.platformAccountId);
    assert.equal(first._id.toString(), second._id.toString());
  });
});

describe('setActiveFacebookAccount / switchFacebookAccountHandler — switching', () => {
  let userA, projectA, projectB, pageOne, pageTwo;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    userA = new mongoose.Types.ObjectId();
    projectA = await SeoProject.create({ user_id: userA, project_name: `Switch Test A ${Date.now()}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['switch test a'] });
    projectB = await SeoProject.create({ user_id: new mongoose.Types.ObjectId(), project_name: `Switch Test B ${Date.now()}`, main_url: 'https://example.org', seo_scope: 'local', keywords: ['switch test b'] });
    pageOne = await SocialAccount.create({ user_id: userA, project_id: projectA._id, platform: 'facebook', platformAccountId: 'pg_one', platformAccountName: 'Page One', accountType: 'page', accessToken: 'token-1', status: 'active', isActive: true });
    pageTwo = await SocialAccount.create({ user_id: userA, project_id: projectA._id, platform: 'facebook', platformAccountId: 'pg_two', platformAccountName: 'Page Two', accountType: 'page', accessToken: 'token-2', status: 'active', isActive: false });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    await SeoProject.deleteMany({ _id: { $in: [projectA._id, projectB._id] } });
    await SocialAccount.deleteMany({ project_id: { $in: [projectA._id, projectB._id] } });
  });

  test('1: successful switch activates the target and deactivates the previous one', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await setActiveFacebookAccount({ projectId: projectA._id.toString(), socialAccountId: pageTwo._id.toString() });
    assert.equal(result.success, true);
    assert.equal(result.account.isActive, true);
    assert.equal(result.account.providerAccountId, 'pg_two');

    const refreshedOne = await SocialAccount.findById(pageOne._id);
    const refreshedTwo = await SocialAccount.findById(pageTwo._id);
    assert.equal(refreshedOne.isActive, false);
    assert.equal(refreshedTwo.isActive, true);
  });

  test('2: switching to the already-active account is a harmless no-op success', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await setActiveFacebookAccount({ projectId: projectA._id.toString(), socialAccountId: pageOne._id.toString() });
    assert.equal(result.success, true);
    assert.equal(result.account.isActive, true);
  });

  test('3: switching to another project\'s account is rejected — never leaks that the ID exists', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const otherProjectPage = await SocialAccount.create({ user_id: new mongoose.Types.ObjectId(), project_id: projectB._id, platform: 'facebook', platformAccountId: 'pg_other_project', accountType: 'page', accessToken: 'token', status: 'active' });
    const result = await setActiveFacebookAccount({ projectId: projectA._id.toString(), socialAccountId: otherProjectPage._id.toString() });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'SOCIAL_ACCOUNT_NOT_FOUND');

    // Confirm nothing in project A changed.
    const refreshedOne = await SocialAccount.findById(pageOne._id);
    assert.equal(refreshedOne.isActive, true);
  });

  test('4: switching to a nonexistent socialAccountId is rejected the same way as a wrong-project one', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await setActiveFacebookAccount({ projectId: projectA._id.toString(), socialAccountId: new mongoose.Types.ObjectId().toString() });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'SOCIAL_ACCOUNT_NOT_FOUND');
  });

  test('5: switching to a malformed socialAccountId is rejected, not a crash', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await setActiveFacebookAccount({ projectId: projectA._id.toString(), socialAccountId: 'not-a-real-object-id' });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'SOCIAL_ACCOUNT_NOT_FOUND');
  });

  test('6: switching to a REVOKED (disconnected) account is rejected', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const revoked = await SocialAccount.create({ user_id: userA, project_id: projectA._id, platform: 'facebook', platformAccountId: 'pg_revoked', accountType: 'page', accessToken: 'token', status: 'revoked' });
    const result = await setActiveFacebookAccount({ projectId: projectA._id.toString(), socialAccountId: revoked._id.toString() });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'SOCIAL_ACCOUNT_NOT_CONNECTED');
  });

  test('7: an Instagram socialAccountId is rejected — this endpoint is Facebook-only', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const igAccount = await SocialAccount.create({ user_id: userA, project_id: projectA._id, platform: 'instagram', platformAccountId: 'ig_test', instagramBusinessAccountId: 'ig_test', accountType: 'business', accessToken: 'token', status: 'active' });
    const result = await setActiveFacebookAccount({ projectId: projectA._id.toString(), socialAccountId: igAccount._id.toString() });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'SOCIAL_PLATFORM_UNSUPPORTED');
  });

  test('8: the switch response never contains an access token', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await setActiveFacebookAccount({ projectId: projectA._id.toString(), socialAccountId: pageTwo._id.toString() });
    assert.ok(!('accessToken' in result.account));
    assert.ok(!JSON.stringify(result).includes('token-2'));
  });

  test('9: switchFacebookAccountHandler — missing socialAccountId is a stable 400', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const req = { projectId: projectA._id.toString(), body: {} };
    const res = mockRes();
    await switchFacebookAccountHandler(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.details.code, 'SOCIAL_ACCOUNT_ID_REQUIRED');
  });

  test('10: switchFacebookAccountHandler — successful switch returns 200 with safe account info', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const req = { projectId: projectA._id.toString(), body: { socialAccountId: pageTwo._id.toString() } };
    const res = mockRes();
    await switchFacebookAccountHandler(req, res);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.account.providerAccountId, 'pg_two');
    assert.equal(res.body.data.account.isActive, true);
  });

  test('11: switchFacebookAccountHandler — wrong-project account maps to 404', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const otherProjectPage = await SocialAccount.create({ user_id: new mongoose.Types.ObjectId(), project_id: projectB._id, platform: 'facebook', platformAccountId: 'pg_wrong_project', accountType: 'page', accessToken: 'token', status: 'active' });
    const req = { projectId: projectA._id.toString(), body: { socialAccountId: otherProjectPage._id.toString() } };
    const res = mockRes();
    await switchFacebookAccountHandler(req, res);
    assert.equal(res.statusCode, 404);
  });

  // Root-cause regression coverage: discoverInstagramForPage previously
  // only ran for the ONE Page selected at initial connect — switching to
  // any OTHER already-connected Page never attempted discovery for it,
  // even when that Page genuinely has a linked Instagram account on
  // Meta's side (confirmed live against a real account: 13 of 19
  // connected Pages had a real link our database had never recorded).
  test('12: switchFacebookAccountHandler triggers Instagram discovery for the NEWLY active Page, not the previous one', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    let capturedArgs = null;
    const original = metaInstagramService.discoverInstagramForPage;
    metaInstagramService.discoverInstagramForPage = async (args) => { capturedArgs = args; return { connected: true, accountId: 'ig_discovered', username: 'discovered_biz' }; };
    try {
      const req = { projectId: projectA._id.toString(), body: { socialAccountId: pageTwo._id.toString() } };
      const res = mockRes();
      await switchFacebookAccountHandler(req, res);
      assert.equal(res.body.success, true);
      assert.deepEqual(capturedArgs, { projectId: projectA._id.toString(), pageId: 'pg_two' });
    } finally {
      metaInstagramService.discoverInstagramForPage = original;
    }
  });

  test('13: a discovery failure never fails the switch itself — the Facebook switch is already real and already persisted', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const original = metaInstagramService.discoverInstagramForPage;
    metaInstagramService.discoverInstagramForPage = async () => { throw new Error('simulated Meta outage'); };
    try {
      const req = { projectId: projectA._id.toString(), body: { socialAccountId: pageTwo._id.toString() } };
      const res = mockRes();
      await switchFacebookAccountHandler(req, res);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.account.providerAccountId, 'pg_two');

      const refreshedTwo = await SocialAccount.findById(pageTwo._id);
      assert.equal(refreshedTwo.isActive, true, 'the switch must have actually persisted despite the discovery failure');
    } finally {
      metaInstagramService.discoverInstagramForPage = original;
    }
  });
});

describe('getFacebookAccountsHandler — the list endpoint', () => {
  let userA, projectA;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    userA = new mongoose.Types.ObjectId();
    projectA = await SeoProject.create({ user_id: userA, project_name: `Accounts List Test ${Date.now()}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['accounts list test'] });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    await SeoProject.deleteOne({ _id: projectA._id });
    await SocialAccount.deleteMany({ project_id: projectA._id });
  });

  test('1: no connected Pages returns an empty array, not an error', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = mockRes();
    await getFacebookAccountsHandler({ projectId: projectA._id.toString() }, res);
    assert.equal(res.body.success, true);
    assert.deepEqual(res.body.data.accounts, []);
  });

  test('2: multiple connected Pages are all returned with safe fields, and the active one is flagged', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const knownToken = `secret-${crypto.randomBytes(6).toString('hex')}`;
    await SocialAccount.create({ user_id: userA, project_id: projectA._id, platform: 'facebook', platformAccountId: 'pg_a', platformAccountName: 'Nashik City Guide', accountType: 'page', accessToken: knownToken, status: 'active', isActive: true });
    await SocialAccount.create({ user_id: userA, project_id: projectA._id, platform: 'facebook', platformAccountId: 'pg_b', platformAccountName: 'Jethwa Eye Hospital', accountType: 'page', accessToken: 'token-b', status: 'active', isActive: false });
    await SocialAccount.create({ user_id: userA, project_id: projectA._id, platform: 'facebook', platformAccountId: 'pg_c', platformAccountName: 'Krishna Eye Centre', accountType: 'page', accessToken: 'token-c', status: 'active', isActive: false });

    const res = mockRes();
    await getFacebookAccountsHandler({ projectId: projectA._id.toString() }, res);
    assert.equal(res.body.data.accounts.length, 3);
    const active = res.body.data.accounts.filter((a) => a.isActive);
    assert.equal(active.length, 1);
    assert.equal(active[0].name, 'Nashik City Guide');
    assert.ok(!JSON.stringify(res.body).includes(knownToken), 'no Page token may ever appear in the accounts list response');
    for (const a of res.body.data.accounts) {
      assert.ok(!('accessToken' in a));
      assert.equal(a.provider, 'facebook');
    }
  });

  test('3: a disconnected (revoked) Page is not included in the list', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialAccount.create({ user_id: userA, project_id: projectA._id, platform: 'facebook', platformAccountId: 'pg_revoked', accountType: 'page', accessToken: 'token', status: 'revoked' });
    const res = mockRes();
    await getFacebookAccountsHandler({ projectId: projectA._id.toString() }, res);
    assert.deepEqual(res.body.data.accounts, []);
  });
});

describe('getActiveFacebookAccount after switching — the exact lookup getFacebookOverview uses internally', () => {
  let userA, projectA;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    userA = new mongoose.Types.ObjectId();
    projectA = await SeoProject.create({ user_id: userA, project_name: `Overview Switch Test ${Date.now()}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['overview switch test'] });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    await SeoProject.deleteOne({ _id: projectA._id });
    await SocialAccount.deleteMany({ project_id: projectA._id });
  });

  test('1: switching the active Page changes which pageId the overview service loads (real, unmocked — proves the wiring, not just the fallback)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pageOne = await SocialAccount.create({ user_id: userA, project_id: projectA._id, platform: 'facebook', platformAccountId: 'pg_overview_1', pageId: 'pg_overview_1', accountType: 'page', accessToken: 'fake-token-1', status: 'active', isActive: true });
    await SocialAccount.create({ user_id: userA, project_id: projectA._id, platform: 'facebook', platformAccountId: 'pg_overview_2', pageId: 'pg_overview_2', accountType: 'page', accessToken: 'fake-token-2', status: 'active', isActive: false });

    const before = await getActiveFacebookAccount(projectA._id.toString());
    assert.equal(before.platformAccountId, 'pg_overview_1');

    await setActiveFacebookAccount({ projectId: projectA._id.toString(), socialAccountId: (await SocialAccount.findOne({ project_id: projectA._id, platformAccountId: 'pg_overview_2' }))._id.toString() });

    const after = await getActiveFacebookAccount(projectA._id.toString());
    assert.equal(after.platformAccountId, 'pg_overview_2', 'the overview service\'s own account lookup must now resolve to the newly active Page');
    void pageOne;
  });
});
