import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import SocialAccount from '../model/SocialAccount.js';
import SocialPost from '../model/SocialPost.js';
import facebookPageDataService from './facebookPageDataService.js';
import instagramMediaService from './instagramMediaService.js';
import { syncProjectSocialFeeds } from './socialSyncService.js';
import { getActiveFacebookAccount } from './facebookAccountService.js';

/**
 * Real MongoDB, no mocking library — same conventions as every other test
 * in this module. facebookPageDataService.getPagePosts /
 * instagramMediaService.getInstagramMedia are substituted on their
 * default-exported objects for the duration of each test (Meta can't be
 * made to deterministically return a fixture for a fake token), always
 * restored in a finally.
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

async function withMockedProviders({ getPagePosts, getInstagramMedia }, fn) {
  const original = { getPagePosts: facebookPageDataService.getPagePosts, getInstagramMedia: instagramMediaService.getInstagramMedia };
  if (getPagePosts) facebookPageDataService.getPagePosts = getPagePosts;
  if (getInstagramMedia) instagramMediaService.getInstagramMedia = getInstagramMedia;
  try {
    return await fn();
  } finally {
    facebookPageDataService.getPagePosts = original.getPagePosts;
    instagramMediaService.getInstagramMedia = original.getInstagramMedia;
  }
}

function fbPost(overrides = {}) {
  return {
    id: overrides.id || 'post_default',
    message: overrides.message ?? 'Hello',
    createdTime: overrides.createdTime ?? '2026-08-01T00:00:00+0000',
    permalink: overrides.permalink ?? null,
    attachmentType: overrides.attachmentType ?? null,
    mediaUrl: overrides.mediaUrl ?? null,
    likesCount: overrides.likesCount ?? 5,
    commentsCount: overrides.commentsCount ?? 1,
    sharesCount: overrides.sharesCount ?? 0,
  };
}

function igMedia(overrides = {}) {
  return {
    id: overrides.id || 'media_default',
    caption: overrides.caption ?? 'Caption',
    mediaType: overrides.mediaType ?? 'IMAGE',
    mediaUrl: overrides.mediaUrl ?? 'https://example.com/x.jpg',
    thumbnailUrl: overrides.thumbnailUrl ?? null,
    permalink: overrides.permalink ?? null,
    timestamp: overrides.timestamp ?? '2026-08-01T00:00:00+0000',
    likeCount: overrides.likeCount ?? 10,
    commentsCount: overrides.commentsCount ?? 2,
  };
}

describe('syncProjectSocialFeeds', () => {
  let project;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    project = await SeoProject.create({
      user_id: new mongoose.Types.ObjectId(),
      project_name: `Social Sync Test Project ${Date.now()}`,
      main_url: 'https://example.com',
      seo_scope: 'local',
      keywords: ['social sync test'],
    });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    await SocialAccount.deleteMany({ project_id: project._id });
    await SocialPost.deleteMany({ project_id: project._id });
    await SeoProject.deleteOne({ _id: project._id });
  });

  test('1: real Facebook posts are fetched, normalized, and upserted into SocialPost', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const account = await SocialAccount.create({
      user_id: project.user_id, project_id: project._id, platform: 'facebook',
      platformAccountId: 'pg_1', platformAccountName: 'My Page', accountType: 'page',
      pageId: 'pg_1', accessToken: 'real-token', status: 'active', isActive: true,
    });

    await withMockedProviders({
      getPagePosts: async () => ({ success: true, posts: [fbPost({ id: 'p1' }), fbPost({ id: 'p2' })], error: null, nextCursor: null }),
    }, () => syncProjectSocialFeeds(project._id));

    const stored = await SocialPost.find({ project_id: project._id, platform: 'facebook' }).sort({ externalPostId: 1 });
    assert.equal(stored.length, 2);
    assert.deepEqual(stored.map((p) => p.externalPostId), ['p1', 'p2']);
    assert.equal(stored[0].social_account_id.toString(), account._id.toString());
    assert.equal(stored[0].accountName, 'My Page');
  });

  test('2: real Instagram media is fetched, normalized, and upserted into SocialPost', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    // Instagram is only ever synced as the active Facebook Page's OWN
    // linked account (see syncProjectSocialFeeds's scopeToActiveAccounts
    // default) — a real Facebook Page must exist and be active first.
    await SocialAccount.create({
      user_id: project.user_id, project_id: project._id, platform: 'facebook',
      platformAccountId: 'pg_1', platformAccountName: 'My Page', accountType: 'page',
      pageId: 'pg_1', accessToken: 'real-token', status: 'active', isActive: true,
    });
    await SocialAccount.create({
      user_id: project.user_id, project_id: project._id, platform: 'instagram',
      platformAccountId: 'ig_1', platformAccountName: 'My IG', accountType: 'business',
      pageId: 'pg_1', instagramBusinessAccountId: 'ig_1', accessToken: 'real-token', status: 'active',
      metadata: { username: 'my_ig' },
    });

    await withMockedProviders({
      getInstagramMedia: async () => ({ success: true, media: [igMedia({ id: 'm1' })], error: null, nextCursor: null }),
    }, () => syncProjectSocialFeeds(project._id));

    const stored = await SocialPost.find({ project_id: project._id, platform: 'instagram' });
    assert.equal(stored.length, 1);
    assert.equal(stored[0].externalPostId, 'm1');
    assert.equal(stored[0].username, 'my_ig');
  });

  test('3: re-syncing the same posts never creates duplicates (upsert on platform+social_account_id+externalPostId)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialAccount.create({
      user_id: project.user_id, project_id: project._id, platform: 'facebook',
      platformAccountId: 'pg_2', platformAccountName: 'Page Two', accountType: 'page',
      pageId: 'pg_2', accessToken: 'real-token', status: 'active', isActive: true,
    });

    await withMockedProviders({ getPagePosts: async () => ({ success: true, posts: [fbPost({ id: 'dup1', likesCount: 5 })], error: null, nextCursor: null }) },
      () => syncProjectSocialFeeds(project._id));
    await withMockedProviders({ getPagePosts: async () => ({ success: true, posts: [fbPost({ id: 'dup1', likesCount: 99 })], error: null, nextCursor: null }) },
      () => syncProjectSocialFeeds(project._id));

    const stored = await SocialPost.find({ project_id: project._id, externalPostId: 'dup1' });
    assert.equal(stored.length, 1, 'must not duplicate on re-sync');
    assert.equal(stored[0].metrics.likes, 99, 'the second sync\'s fresher metrics must win');
  });

  test('4: a token-invalid (401) response marks the account "expired" (needs reauthorization), and never crashes the sync', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const account = await SocialAccount.create({
      user_id: project.user_id, project_id: project._id, platform: 'facebook',
      platformAccountId: 'pg_3', platformAccountName: 'Page Three', accountType: 'page',
      pageId: 'pg_3', accessToken: 'real-token', status: 'active', isActive: true,
    });

    const result = await withMockedProviders({
      getPagePosts: async () => ({ success: false, posts: [], error: { code: 'FACEBOOK_TOKEN_INVALID', message: 'denied' }, nextCursor: null }),
    }, () => syncProjectSocialFeeds(project._id));

    assert.equal(result.accounts[0].success, false);
    const reloaded = await SocialAccount.findById(account._id);
    assert.equal(reloaded.status, 'expired');
  });

  test('5: one account failing does not stop other accounts in the same project from syncing', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialAccount.create({
      user_id: project.user_id, project_id: project._id, platform: 'facebook',
      platformAccountId: 'pg_fail', platformAccountName: 'Failing Page', accountType: 'page',
      pageId: 'pg_fail', accessToken: 'real-token', status: 'active', isActive: true,
    });
    // pageId matches the active Page above ('pg_fail') — Instagram is
    // only ever synced as THAT Page's own linked account.
    await SocialAccount.create({
      user_id: project.user_id, project_id: project._id, platform: 'instagram',
      platformAccountId: 'ig_ok', platformAccountName: 'Working IG', accountType: 'business',
      pageId: 'pg_fail', instagramBusinessAccountId: 'ig_ok', accessToken: 'real-token', status: 'active',
    });

    let call = 0;
    const result = await withMockedProviders({
      getPagePosts: async () => { call += 1; throw new Error('unexpected Meta network error'); },
      getInstagramMedia: async () => ({ success: true, media: [igMedia({ id: 'ok1' })], error: null, nextCursor: null }),
    }, () => syncProjectSocialFeeds(project._id));

    assert.equal(call, 1);
    assert.equal(result.accounts.length, 2);
    const fbResult = result.accounts.find((a) => a.platform === 'facebook');
    const igResult = result.accounts.find((a) => a.platform === 'instagram');
    assert.equal(fbResult.success, false);
    assert.equal(igResult.success, true);
    const igStored = await SocialPost.find({ project_id: project._id, platform: 'instagram' });
    assert.equal(igStored.length, 1, 'the Instagram account must still sync despite the Facebook account throwing');
  });

  test('6: only THIS project\'s connected accounts are ever synced (project isolation)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const otherProject = await SeoProject.create({
      user_id: project.user_id, project_name: `Other Project ${Date.now()}`, main_url: 'https://other.example.com',
      seo_scope: 'local', keywords: ['other'],
    });
    await SocialAccount.create({
      user_id: project.user_id, project_id: otherProject._id, platform: 'facebook',
      platformAccountId: 'pg_other', platformAccountName: 'Other Page', accountType: 'page',
      pageId: 'pg_other', accessToken: 'real-token', status: 'active', isActive: true,
    });

    let calls = 0;
    const result = await withMockedProviders({
      getPagePosts: async () => { calls += 1; return { success: true, posts: [fbPost({ id: 'x1' })], error: null, nextCursor: null }; },
    }, () => syncProjectSocialFeeds(project._id));

    assert.equal(calls, 0, 'a project with zero connected accounts must never call Meta or touch another project\'s accounts');
    assert.equal(result.accounts.length, 0);
    await SocialAccount.deleteMany({ project_id: otherProject._id });
    await SeoProject.deleteOne({ _id: otherProject._id });
  });

  test('7: a revoked/inactive SocialAccount is never synced', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialAccount.create({
      user_id: project.user_id, project_id: project._id, platform: 'facebook',
      platformAccountId: 'pg_revoked', platformAccountName: 'Revoked Page', accountType: 'page',
      pageId: 'pg_revoked', accessToken: 'real-token', status: 'revoked',
    });

    let calls = 0;
    const result = await withMockedProviders({
      getPagePosts: async () => { calls += 1; return { success: true, posts: [], error: null, nextCursor: null }; },
    }, () => syncProjectSocialFeeds(project._id));

    assert.equal(calls, 0);
    assert.equal(result.accounts.length, 0);
  });

  // Added while debugging a real report: Facebook posts weren't appearing
  // in the Feeds page while Instagram synced fine. Traced live: a single
  // request at the old SYNC_BATCH_LIMIT (50) with this module's post
  // field expansion made Meta reject the WHOLE request (error code 1,
  // "Please reduce the amount of data you're asking for"); the fix pages
  // Facebook in smaller FACEBOOK_PAGE_FETCH_LIMIT (25) chunks. Instagram
  // is untouched — these tests prove Facebook's new pagination loop
  // behaves correctly without changing syncInstagramAccount at all.
  describe('Facebook pagination (the actual fix for "Facebook posts not syncing")', () => {
    test('22: Facebook posts are fetched across multiple smaller pages and all upserted, when the total exceeds one page', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      await SocialAccount.create({
        user_id: project.user_id, project_id: project._id, platform: 'facebook',
        platformAccountId: 'pg_page1', platformAccountName: 'Paginated Page', accountType: 'page',
        pageId: 'pg_page1', accessToken: 'real-token', status: 'active', isActive: true,
      });

      let calls = 0;
      const capturedLimits = [];
      const result = await withMockedProviders({
        getPagePosts: async (pageId, token, { limit, after }) => {
          calls += 1;
          capturedLimits.push(limit);
          if (!after) return { success: true, posts: [fbPost({ id: 'p1' }), fbPost({ id: 'p2' })], error: null, nextCursor: 'CURSOR_1' };
          return { success: true, posts: [fbPost({ id: 'p3' })], error: null, nextCursor: null };
        },
      }, () => syncProjectSocialFeeds(project._id));

      assert.equal(calls, 2, 'must follow the cursor into a second, smaller page rather than one large request');
      assert.ok(capturedLimits.every((l) => l <= 25), 'every individual Facebook request must stay at or under the safe per-page limit');
      assert.equal(result.accounts[0].postsSynced, 3);
      const stored = await SocialPost.find({ project_id: project._id, platform: 'facebook' });
      assert.equal(stored.length, 3, 'all posts across both pages must be persisted, not just the first page');
    });

    test('23: a FACEBOOK_REQUEST_TOO_LARGE failure on the FIRST page still reports a real failure — never silently zero posts reported as success', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      await SocialAccount.create({
        user_id: project.user_id, project_id: project._id, platform: 'facebook',
        platformAccountId: 'pg_toolarge', platformAccountName: 'Too Large Page', accountType: 'page',
        pageId: 'pg_toolarge', accessToken: 'real-token', status: 'active', isActive: true,
      });

      const result = await withMockedProviders({
        getPagePosts: async () => ({ success: false, posts: [], error: { code: 'FACEBOOK_REQUEST_TOO_LARGE', message: 'Meta rejected this request for asking for too much data in one call.' }, nextCursor: null }),
      }, () => syncProjectSocialFeeds(project._id));

      assert.equal(result.accounts[0].success, false);
      assert.equal(result.accounts[0].errorCode, 'FACEBOOK_REQUEST_TOO_LARGE');
      assert.equal(result.accounts[0].postsSynced, 0);
      const stored = await SocialPost.find({ project_id: project._id, platform: 'facebook' });
      assert.equal(stored.length, 0);
    });

    test('24: a failure on a LATER page keeps the posts already fetched from earlier pages rather than discarding them', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      await SocialAccount.create({
        user_id: project.user_id, project_id: project._id, platform: 'facebook',
        platformAccountId: 'pg_partial', platformAccountName: 'Partial Page', accountType: 'page',
        pageId: 'pg_partial', accessToken: 'real-token', status: 'active', isActive: true,
      });

      let calls = 0;
      const result = await withMockedProviders({
        getPagePosts: async () => {
          calls += 1;
          if (calls === 1) return { success: true, posts: [fbPost({ id: 'first_page_post' })], error: null, nextCursor: 'CURSOR_1' };
          return { success: false, posts: [], error: { code: 'FACEBOOK_REQUEST_TOO_LARGE', message: 'too much data' }, nextCursor: null };
        },
      }, () => syncProjectSocialFeeds(project._id));

      assert.equal(result.accounts[0].success, true, 'partial success from earlier pages must still count as a real, successful sync');
      assert.equal(result.accounts[0].postsSynced, 1);
      const stored = await SocialPost.find({ project_id: project._id, platform: 'facebook' });
      assert.equal(stored.length, 1);
      assert.equal(stored[0].externalPostId, 'first_page_post');
    });

    test('25: a Facebook FACEBOOK_REQUEST_TOO_LARGE failure never affects Instagram in the same sync run', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      await SocialAccount.create({
        user_id: project.user_id, project_id: project._id, platform: 'facebook',
        platformAccountId: 'pg_fb_fail', platformAccountName: 'FB Fail Page', accountType: 'page',
        pageId: 'pg_fb_fail', accessToken: 'real-token', status: 'active', isActive: true,
      });
      await SocialAccount.create({
        user_id: project.user_id, project_id: project._id, platform: 'instagram',
        platformAccountId: 'ig_ok_2', platformAccountName: 'Working IG 2', accountType: 'business',
        pageId: 'pg_fb_fail', instagramBusinessAccountId: 'ig_ok_2', accessToken: 'real-token', status: 'active',
      });

      const result = await withMockedProviders({
        getPagePosts: async () => ({ success: false, posts: [], error: { code: 'FACEBOOK_REQUEST_TOO_LARGE', message: 'too much data' }, nextCursor: null }),
        getInstagramMedia: async () => ({ success: true, media: [igMedia({ id: 'ig1' }), igMedia({ id: 'ig2' })], error: null, nextCursor: null }),
      }, () => syncProjectSocialFeeds(project._id));

      const fbResult = result.accounts.find((a) => a.platform === 'facebook');
      const igResult = result.accounts.find((a) => a.platform === 'instagram');
      assert.equal(fbResult.success, false);
      assert.equal(igResult.success, true);
      assert.equal(igResult.postsSynced, 2);
      const igStored = await SocialPost.find({ project_id: project._id, platform: 'instagram' });
      assert.equal(igStored.length, 2, 'Instagram must sync completely normally while Facebook fails');
    });
  });

  // Added while debugging a real report of "Overview shows 6 Facebook
  // posts but Feeds shows 0" — proves the Feeds sync path
  // (syncProjectSocialFeeds's own SocialAccount.find) and the Overview
  // path (facebookAccountService.getActiveFacebookAccount) never
  // disagree about which real, connected Facebook Page to use. They are
  // deliberately DIFFERENT queries (sync includes every connected Page
  // for multi-Page aggregation; Overview follows only the one currently
  // "active" Page) — this test proves that difference is intentional and
  // safe, not a bug: the active Page Overview shows is always also one of
  // the accounts the Feeds sync processes.
  test('26: the Page Overview treats as "active" is always included in the set of accounts the Feeds sync processes', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialAccount.create({
      user_id: project.user_id, project_id: project._id, platform: 'facebook',
      platformAccountId: 'pg_consistency', platformAccountName: 'Consistency Page', accountType: 'page',
      pageId: 'pg_consistency', accessToken: 'real-token', status: 'active', isActive: true,
    });

    const overviewAccount = await getActiveFacebookAccount(project._id);
    const result = await withMockedProviders({
      getPagePosts: async () => ({ success: true, posts: [fbPost({ id: 'consistency_post' })], error: null, nextCursor: null }),
    }, () => syncProjectSocialFeeds(project._id));

    const syncedFacebookAccountIds = result.accounts.filter((a) => a.platform === 'facebook').map((a) => a.socialAccountId);
    assert.ok(syncedFacebookAccountIds.includes(overviewAccount._id.toString()), 'Overview\'s active Page must always be one of the Pages Feeds actually synced');
  });

  // Root-cause regression coverage: a real report — an Instagram account
  // with 112 real posts on Meta stayed permanently capped at 50 in our
  // database because syncInstagramAccount made exactly ONE call and never
  // followed Meta's own pagination cursor beyond that, unlike Facebook's
  // sync (which already looped). These prove Instagram now follows the
  // cursor the same way, and that the per-account cap is a generous safety
  // ceiling (not a target tuned to any one account's real numbers).
  describe('Instagram pagination (the fix for accounts permanently capped at one page)', () => {
    test('27: Instagram media is fetched across multiple pages and all upserted, when the total exceeds one page', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      await SocialAccount.create({
        user_id: project.user_id, project_id: project._id, platform: 'facebook',
        platformAccountId: 'pg_ig_paginated', platformAccountName: 'Page', accountType: 'page',
        pageId: 'pg_ig_paginated', accessToken: 'real-token', status: 'active', isActive: true,
      });
      await SocialAccount.create({
        user_id: project.user_id, project_id: project._id, platform: 'instagram',
        platformAccountId: 'ig_paginated', platformAccountName: 'Paginated IG', accountType: 'business',
        pageId: 'pg_ig_paginated', instagramBusinessAccountId: 'ig_paginated', accessToken: 'real-token', status: 'active',
      });

      let calls = 0;
      const capturedLimits = [];
      const result = await withMockedProviders({
        getPagePosts: async () => ({ success: true, posts: [], error: null, nextCursor: null }),
        getInstagramMedia: async (id, token, { limit, after }) => {
          calls += 1;
          capturedLimits.push(limit);
          if (!after) return { success: true, media: [igMedia({ id: 'm1' }), igMedia({ id: 'm2' })], error: null, nextCursor: 'CURSOR_1' };
          return { success: true, media: [igMedia({ id: 'm3' })], error: null, nextCursor: null };
        },
      }, () => syncProjectSocialFeeds(project._id));

      assert.equal(calls, 2, 'must follow the cursor into a second page rather than stopping after one call');
      assert.ok(capturedLimits.every((l) => l <= 25), 'every individual Instagram request must stay at or under the shared safe per-page limit');
      const igResult = result.accounts.find((a) => a.platform === 'instagram');
      assert.equal(igResult.postsSynced, 3);
      const stored = await SocialPost.find({ project_id: project._id, platform: 'instagram' });
      assert.equal(stored.length, 3, 'all media across both pages must be persisted, not just the first page');
    });

    test('28: an account with more real media than the old 50-item cap (e.g. 112) is fully synced across enough pages, never stuck at 50', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      await SocialAccount.create({
        user_id: project.user_id, project_id: project._id, platform: 'facebook',
        platformAccountId: 'pg_ig_112', platformAccountName: 'Page', accountType: 'page',
        pageId: 'pg_ig_112', accessToken: 'real-token', status: 'active', isActive: true,
      });
      await SocialAccount.create({
        user_id: project.user_id, project_id: project._id, platform: 'instagram',
        platformAccountId: 'ig_112', platformAccountName: 'IG 112', accountType: 'business',
        pageId: 'pg_ig_112', instagramBusinessAccountId: 'ig_112', accessToken: 'real-token', status: 'active',
      });

      const TOTAL_REAL_MEDIA = 112;
      let served = 0;
      const result = await withMockedProviders({
        getPagePosts: async () => ({ success: true, posts: [], error: null, nextCursor: null }),
        getInstagramMedia: async (id, token, { limit }) => {
          const batch = Array.from({ length: Math.min(limit, TOTAL_REAL_MEDIA - served) }, (_, i) => igMedia({ id: `real_${served + i}` }));
          served += batch.length;
          return { success: true, media: batch, error: null, nextCursor: served < TOTAL_REAL_MEDIA ? `CURSOR_${served}` : null };
        },
      }, () => syncProjectSocialFeeds(project._id));

      const igResult = result.accounts.find((a) => a.platform === 'instagram');
      assert.equal(igResult.postsSynced, TOTAL_REAL_MEDIA, 'must reach the account\'s real total (112), not stop at the old 50-item cap');
      const stored = await SocialPost.find({ project_id: project._id, platform: 'instagram' });
      assert.equal(stored.length, TOTAL_REAL_MEDIA);
    });

    test('29: a later-page Instagram failure keeps the media already fetched from earlier pages rather than discarding them', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      await SocialAccount.create({
        user_id: project.user_id, project_id: project._id, platform: 'facebook',
        platformAccountId: 'pg_ig_partial', platformAccountName: 'Page', accountType: 'page',
        pageId: 'pg_ig_partial', accessToken: 'real-token', status: 'active', isActive: true,
      });
      await SocialAccount.create({
        user_id: project.user_id, project_id: project._id, platform: 'instagram',
        platformAccountId: 'ig_partial', platformAccountName: 'Partial IG', accountType: 'business',
        pageId: 'pg_ig_partial', instagramBusinessAccountId: 'ig_partial', accessToken: 'real-token', status: 'active',
      });

      let calls = 0;
      const result = await withMockedProviders({
        getPagePosts: async () => ({ success: true, posts: [], error: null, nextCursor: null }),
        getInstagramMedia: async () => {
          calls += 1;
          if (calls === 1) return { success: true, media: [igMedia({ id: 'first_page_media' })], error: null, nextCursor: 'CURSOR_1' };
          return { success: false, media: [], error: { code: 'INSTAGRAM_DATA_FETCH_FAILED', message: 'simulated' }, nextCursor: null };
        },
      }, () => syncProjectSocialFeeds(project._id));

      const igResult = result.accounts.find((a) => a.platform === 'instagram');
      assert.equal(igResult.success, true, 'partial success from earlier pages must still count as a real, successful sync');
      assert.equal(igResult.postsSynced, 1);
      const stored = await SocialPost.find({ project_id: project._id, platform: 'instagram' });
      assert.equal(stored.length, 1);
      assert.equal(stored[0].externalPostId, 'first_page_media');
    });
  });

  // Root-cause regression coverage for a real, LIVE-confirmed performance
  // problem: with per-account sync depth raised (SYNC_BATCH_LIMIT), a real
  // Refresh click against a project with ~19 connected Facebook Pages
  // (syncing every one of them unconditionally) exceeded 3 minutes and had
  // to be aborted. Scoping sync to the active account(s) by default is
  // what makes the deeper per-account limit production-safe.
  describe('Account-scoped sync (the fix for a Refresh syncing every connected Page)', () => {
    test('30: by default, only the ACTIVE Facebook Page (and its own linked Instagram) is synced, never every connected Page', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      await SocialAccount.create({
        user_id: project.user_id, project_id: project._id, platform: 'facebook',
        platformAccountId: 'pg_scoped_active', platformAccountName: 'Active Page', accountType: 'page',
        pageId: 'pg_scoped_active', accessToken: 'token-active', status: 'active', isActive: true,
      });
      await SocialAccount.create({
        user_id: project.user_id, project_id: project._id, platform: 'facebook',
        platformAccountId: 'pg_scoped_inactive', platformAccountName: 'Inactive Page', accountType: 'page',
        pageId: 'pg_scoped_inactive', accessToken: 'token-inactive', status: 'active', isActive: false,
      });

      const requestedPageIds = [];
      const result = await withMockedProviders({
        getPagePosts: async (pageId) => { requestedPageIds.push(pageId); return { success: true, posts: [], error: null, nextCursor: null }; },
      }, () => syncProjectSocialFeeds(project._id));

      assert.equal(result.accounts.length, 1, 'only the active Page, never the inactive one');
      assert.deepEqual(requestedPageIds, ['pg_scoped_active']);
    });

    test('31: scopeToActiveAccounts:false restores the original "every connected account" behavior', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      await SocialAccount.create({
        user_id: project.user_id, project_id: project._id, platform: 'facebook',
        platformAccountId: 'pg_all_a', platformAccountName: 'Page A', accountType: 'page',
        pageId: 'pg_all_a', accessToken: 'token-a', status: 'active', isActive: true,
      });
      await SocialAccount.create({
        user_id: project.user_id, project_id: project._id, platform: 'facebook',
        platformAccountId: 'pg_all_b', platformAccountName: 'Page B', accountType: 'page',
        pageId: 'pg_all_b', accessToken: 'token-b', status: 'active', isActive: false,
      });

      const requestedPageIds = [];
      const result = await withMockedProviders({
        getPagePosts: async (pageId) => { requestedPageIds.push(pageId); return { success: true, posts: [], error: null, nextCursor: null }; },
      }, () => syncProjectSocialFeeds(project._id, { scopeToActiveAccounts: false }));

      assert.equal(result.accounts.length, 2);
      assert.deepEqual(requestedPageIds.sort(), ['pg_all_a', 'pg_all_b']);
    });
  });
});
