import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import crypto from 'crypto';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import { installDebugTokenStub } from '../testSupport/metaDebugTokenStub.js';
import SocialAccount from '../model/SocialAccount.js';
import metaPageService from '../service/metaPageService.js';
import { discoverInstagramForPage } from '../service/metaInstagramService.js';
import { selectMetaPage, retryInstagramDiscovery } from './metaOAuthController.js';
import PendingMetaConnection, { PENDING_TTL_MS } from '../model/PendingMetaConnection.js';

/**
 * Phase 3 — Facebook Page -> Instagram Business/Professional Account
 * discovery. Same conventions as Phase 1/2: real functions, mock req/res,
 * real MongoDB, no mocking library.
 *
 * Meta will never return a genuine "this Page has a linked Instagram
 * account" (or "here is its profile") payload for a fake/garbage token, and
 * this repo has no HTTP mocking library — so the success-path cases
 * (linked account exists, profile retrieved, duplicate prevention via a
 * real discovery run, reconnect via a real discovery run) are tested by
 * temporarily substituting metaPageService.getPageInstagramAccount /
 * getInstagramProfile on the shared default-exported object
 * (metaInstagramService.js calls through that object specifically so this
 * is possible — see its own header comment), always restored in a
 * `finally`, same discipline as Phase 1's console.log-capture technique.
 * Error-path tests that don't need a specific Meta response (page has no
 * SocialAccount, page belongs to another project) need no substitution at
 * all — they short-circuit before any network call. One test deliberately
 * uses a genuinely fake stored Page token to hit the REAL Meta API and
 * prove the live error-handling path end-to-end (see "8: a real,
 * unparsable Page token...").
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

/** Substitutes metaPageService's two Instagram Graph methods for the duration of `fn`, always restoring originals. */
async function withMockedInstagramGraph({ getPageInstagramAccount, getInstagramProfile }, fn) {
  const originalLink = metaPageService.getPageInstagramAccount;
  const originalProfile = metaPageService.getInstagramProfile;
  if (getPageInstagramAccount) metaPageService.getPageInstagramAccount = getPageInstagramAccount;
  if (getInstagramProfile) metaPageService.getInstagramProfile = getInstagramProfile;
  try {
    return await fn();
  } finally {
    metaPageService.getPageInstagramAccount = originalLink;
    metaPageService.getInstagramProfile = originalProfile;
  }
}

function fakeLinkedResult(instagramBusinessAccountId) {
  return async () => ({ success: true, instagramBusinessAccountId, error: null });
}

function fakeProfileResult(profile) {
  return async () => ({ success: true, profile, error: null });
}

describe('discoverInstagramForPage — real service + real Mongo, mocked Graph responses', () => {
  let userA, projectA, projectB, fbAccount;
  const realPageToken = `real-page-token-${crypto.randomBytes(8).toString('hex')}`;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    userA = new mongoose.Types.ObjectId();
    projectA = await SeoProject.create({
      user_id: userA,
      project_name: `Meta Phase 3 Test Project A ${Date.now()}`,
      main_url: 'https://example.com',
      seo_scope: 'local',
      keywords: ['meta phase 3 test'],
    });
    projectB = await SeoProject.create({
      user_id: new mongoose.Types.ObjectId(),
      project_name: `Meta Phase 3 Test Project B ${Date.now()}`,
      main_url: 'https://example.org',
      seo_scope: 'local',
      keywords: ['meta phase 3 test b'],
    });
    fbAccount = await SocialAccount.create({
      user_id: userA,
      project_id: projectA._id,
      platform: 'facebook',
      platformAccountId: 'pg_ig_discovery_test',
      pageId: 'pg_ig_discovery_test',
      accountType: 'page',
      accessToken: realPageToken,
      status: 'active',
    });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    await SeoProject.deleteMany({ _id: { $in: [projectA._id, projectB._id] } });
    await SocialAccount.deleteMany({ project_id: { $in: [projectA._id, projectB._id] } });
  });

  test('1: Page WITH a linked Instagram account is discovered and persisted', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await withMockedInstagramGraph(
      {
        getPageInstagramAccount: fakeLinkedResult('ig_12345'),
        getInstagramProfile: fakeProfileResult({ id: 'ig_12345', username: 'sapphire.agency', name: 'Sapphire Agency', profilePictureUrl: 'https://example.com/pic.jpg' }),
      },
      () => discoverInstagramForPage({ projectId: projectA._id.toString(), pageId: 'pg_ig_discovery_test' }),
    );
    assert.equal(result.connected, true);
    assert.equal(result.accountId, 'ig_12345');
    assert.equal(result.username, 'sapphire.agency');

    const igAccount = await SocialAccount.findOne({ project_id: projectA._id, platform: 'instagram', platformAccountId: 'ig_12345' });
    assert.ok(igAccount);
    assert.equal(igAccount.pageId, 'pg_ig_discovery_test');
    assert.equal(igAccount.instagramBusinessAccountId, 'ig_12345');
    assert.equal(igAccount.status, 'active');
  });

  test('2: Page WITHOUT a linked Instagram account is a normal, non-error result', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await withMockedInstagramGraph(
      { getPageInstagramAccount: fakeLinkedResult(null) },
      () => discoverInstagramForPage({ projectId: projectA._id.toString(), pageId: 'pg_ig_discovery_test' }),
    );
    assert.equal(result.connected, false);
    assert.equal(result.reason, 'NOT_CONNECTED');
    const igAccount = await SocialAccount.findOne({ project_id: projectA._id, platform: 'instagram' });
    assert.equal(igAccount, null, 'no Instagram SocialAccount should be created when none is linked');
  });

  test('3: Instagram profile fields (username/name/picture) are correctly persisted into metadata', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await withMockedInstagramGraph(
      {
        getPageInstagramAccount: fakeLinkedResult('ig_profile_check'),
        getInstagramProfile: fakeProfileResult({ id: 'ig_profile_check', username: 'sdaco', name: 'SDA Co', profilePictureUrl: 'https://example.com/sda.jpg' }),
      },
      () => discoverInstagramForPage({ projectId: projectA._id.toString(), pageId: 'pg_ig_discovery_test' }),
    );
    const igAccount = await SocialAccount.findOne({ project_id: projectA._id, platform: 'instagram', platformAccountId: 'ig_profile_check' });
    assert.equal(igAccount.platformAccountName, 'sdaco');
    assert.equal(igAccount.metadata.username, 'sdaco');
    assert.equal(igAccount.metadata.name, 'SDA Co');
    assert.equal(igAccount.metadata.profilePicture, 'https://example.com/sda.jpg');
  });

  test('4: a Meta API error during link lookup is a stable, non-crashing failure (mocked)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await withMockedInstagramGraph(
      { getPageInstagramAccount: async () => ({ success: false, instagramBusinessAccountId: null, error: { code: 'META_INSTAGRAM_DISCOVERY_FAILED', message: 'simulated Meta 500' } }) },
      () => discoverInstagramForPage({ projectId: projectA._id.toString(), pageId: 'pg_ig_discovery_test' }),
    );
    assert.equal(result.connected, false);
    assert.equal(result.reason, 'DISCOVERY_FAILED');
  });

  test('5: an expired/revoked Page token (401/403-classified) maps to ACCESS_DENIED, not a crash', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await withMockedInstagramGraph(
      { getPageInstagramAccount: async () => ({ success: false, instagramBusinessAccountId: null, error: { code: 'META_INSTAGRAM_ACCESS_DENIED', message: 'simulated expired token' } }) },
      () => discoverInstagramForPage({ projectId: projectA._id.toString(), pageId: 'pg_ig_discovery_test' }),
    );
    assert.equal(result.connected, false);
    assert.equal(result.reason, 'ACCESS_DENIED');
  });

  test('6: a Page with no Facebook SocialAccount in this project is rejected (unauthorized Page), no network call made', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    let called = false;
    const result = await withMockedInstagramGraph(
      { getPageInstagramAccount: async () => { called = true; return { success: true, instagramBusinessAccountId: null, error: null }; } },
      () => discoverInstagramForPage({ projectId: projectA._id.toString(), pageId: 'pg_never_connected' }),
    );
    assert.equal(result.connected, false);
    assert.equal(result.reason, 'INVALID_PAGE_CONNECTION');
    assert.equal(called, false, 'discovery must short-circuit before any Graph API call when the Page is not this project\'s own connection');
  });

  test('7: a Page belonging to ANOTHER project\'s SocialAccount is rejected the same way (cross-project isolation)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    // fbAccount above belongs to projectA; asking on behalf of projectB for
    // that exact pageId must be rejected, never silently discover projectA's data.
    const result = await discoverInstagramForPage({ projectId: projectB._id.toString(), pageId: 'pg_ig_discovery_test' });
    assert.equal(result.connected, false);
    assert.equal(result.reason, 'INVALID_PAGE_CONNECTION');
  });

  test('8: a real, unparsable Page token hits the REAL Meta API and is classified as a stable failure (live, no mock)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    // No mocking here at all — this is a genuine network call to
    // graph.facebook.com with a token Meta cannot possibly parse, proving
    // the real end-to-end error path (metaApiService -> metaPageService's
    // normalizeInstagramLinkFailure -> metaInstagramService's reason
    // mapping) works against Meta's real API, not just simulated shapes.
    const result = await discoverInstagramForPage({ projectId: projectA._id.toString(), pageId: 'pg_ig_discovery_test' });
    assert.equal(result.connected, false);
    assert.ok(['DISCOVERY_FAILED', 'ACCESS_DENIED'].includes(result.reason), `expected a stable failure reason, got: ${result.reason}`);
  });

  test('9: selecting/discovering the same linked Instagram account twice never creates a duplicate row', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const mocks = {
      getPageInstagramAccount: fakeLinkedResult('ig_dup_check'),
      getInstagramProfile: fakeProfileResult({ id: 'ig_dup_check', username: 'dup_test', name: null, profilePictureUrl: null }),
    };
    await withMockedInstagramGraph(mocks, () => discoverInstagramForPage({ projectId: projectA._id.toString(), pageId: 'pg_ig_discovery_test' }));
    await withMockedInstagramGraph(mocks, () => discoverInstagramForPage({ projectId: projectA._id.toString(), pageId: 'pg_ig_discovery_test' }));

    const matches = await SocialAccount.find({ project_id: projectA._id, platform: 'instagram', platformAccountId: 'ig_dup_check' });
    assert.equal(matches.length, 1, 'the same Instagram account discovered twice must update one row, never create a duplicate');
  });

  test('10: reconnect lifecycle — account changes to a new Instagram account, then changes back', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    // First connection: ig_first.
    await withMockedInstagramGraph(
      { getPageInstagramAccount: fakeLinkedResult('ig_first'), getInstagramProfile: fakeProfileResult({ id: 'ig_first', username: 'first', name: null, profilePictureUrl: null }) },
      () => discoverInstagramForPage({ projectId: projectA._id.toString(), pageId: 'pg_ig_discovery_test' }),
    );
    let first = await SocialAccount.findOne({ project_id: projectA._id, platform: 'instagram', platformAccountId: 'ig_first' });
    assert.equal(first.status, 'active');

    // The Page's linked Instagram account changes to ig_second.
    await withMockedInstagramGraph(
      { getPageInstagramAccount: fakeLinkedResult('ig_second'), getInstagramProfile: fakeProfileResult({ id: 'ig_second', username: 'second', name: null, profilePictureUrl: null }) },
      () => discoverInstagramForPage({ projectId: projectA._id.toString(), pageId: 'pg_ig_discovery_test' }),
    );
    first = await SocialAccount.findOne({ project_id: projectA._id, platform: 'instagram', platformAccountId: 'ig_first' });
    let second = await SocialAccount.findOne({ project_id: projectA._id, platform: 'instagram', platformAccountId: 'ig_second' });
    assert.equal(first.status, 'revoked', 'the previously-linked Instagram account must be revoked, not left active');
    assert.equal(second.status, 'active');

    // Reconnect: the Page's linked account reverts back to ig_first.
    await withMockedInstagramGraph(
      { getPageInstagramAccount: fakeLinkedResult('ig_first'), getInstagramProfile: fakeProfileResult({ id: 'ig_first', username: 'first', name: null, profilePictureUrl: null }) },
      () => discoverInstagramForPage({ projectId: projectA._id.toString(), pageId: 'pg_ig_discovery_test' }),
    );
    first = await SocialAccount.findOne({ project_id: projectA._id, platform: 'instagram', platformAccountId: 'ig_first' });
    second = await SocialAccount.findOne({ project_id: projectA._id, platform: 'instagram', platformAccountId: 'ig_second' });
    assert.equal(first.status, 'active', 'reconnecting a previously-revoked Instagram account must reactivate it');
    assert.equal(second.status, 'revoked');
  });

  test('11: a client-supplied fake token in the request body is never used — the DB-stored Page token is what reaches the Graph layer', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    let tokenSeenByGraphLayer = null;
    await withMockedInstagramGraph(
      {
        getPageInstagramAccount: async (pageId, pageAccessToken) => { tokenSeenByGraphLayer = pageAccessToken; return { success: true, instagramBusinessAccountId: null, error: null }; },
      },
      async () => {
        const req = {
          user: { _id: userA },
          projectId: projectA._id.toString(),
          params: { pageId: 'pg_ig_discovery_test' },
          // discoverInstagramForPage's signature has no token parameter at
          // all — this body is what a malicious client would try to send.
          body: { projectId: projectA._id.toString(), accessToken: 'FAKE-1', instagramAccessToken: 'FAKE-2', userAccessToken: 'FAKE-3' },
        };
        await retryInstagramDiscovery(req, mockRes());
      },
    );
    assert.equal(tokenSeenByGraphLayer, realPageToken, 'only the DB-stored Page token may ever reach the Graph API layer');
    assert.notEqual(tokenSeenByGraphLayer, 'FAKE-1');
  });

  test('12: token never appears in the retryInstagramDiscovery response body', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = mockRes();
    await withMockedInstagramGraph(
      {
        getPageInstagramAccount: fakeLinkedResult('ig_response_check'),
        getInstagramProfile: fakeProfileResult({ id: 'ig_response_check', username: 'resp_check', name: null, profilePictureUrl: null }),
      },
      () => retryInstagramDiscovery({ user: { _id: userA }, projectId: projectA._id.toString(), params: { pageId: 'pg_ig_discovery_test' }, body: { projectId: projectA._id.toString() } }, res),
    );
    assert.ok(!JSON.stringify(res.body).includes(realPageToken));
    assert.ok(!('accessToken' in (res.body.data.instagram || {})));
  });

  test('13: token never appears in logs during a full select + discovery run', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const pending = await PendingMetaConnection.create({
      user_id: userA,
      project_id: projectA._id,
      userAccessToken: `user-token-${crypto.randomBytes(6).toString('hex')}`,
      pages: [{
        id: 'pg_log_check_ig',
        name: 'Log Check Page',
        category: 'Business',
        picture: null,
        accessToken: `secret-page-token-${crypto.randomBytes(8).toString('hex')}`,
        tasks: [],
      }],
      expiresAt: new Date(Date.now() + PENDING_TTL_MS),
    });

    const originalLog = console.log;
    const originalError = console.error;
    const captured = [];
    console.log = (...args) => { captured.push(args.join(' ')); };
    console.error = (...args) => { captured.push(args.join(' ')); };

    try {
      await withMockedInstagramGraph(
        {
          getPageInstagramAccount: fakeLinkedResult('ig_log_check'),
          getInstagramProfile: fakeProfileResult({ id: 'ig_log_check', username: 'log_check', name: null, profilePictureUrl: null }),
        },
        () => selectMetaPage(
          { user: { _id: userA }, projectId: projectA._id.toString(), params: { pageId: 'pg_log_check_ig' }, body: { projectId: projectA._id.toString() } },
          mockRes(),
        ),
      );
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    const logText = captured.join('\n');
    const storedIgAccount = await SocialAccount.findOne({ project_id: projectA._id, platform: 'instagram', platformAccountId: 'ig_log_check' });
    assert.ok(storedIgAccount, 'sanity check: the Instagram account was actually persisted');
    assert.ok(!logText.includes(pending.pages[0].accessToken), 'the Page token must never be logged');
    await SocialAccount.deleteOne({ _id: storedIgAccount._id });
    await SocialAccount.deleteOne({ project_id: projectA._id, platform: 'facebook', pageId: 'pg_log_check_ig' });
  });
});
