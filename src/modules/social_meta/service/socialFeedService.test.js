import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import SocialAccount from '../model/SocialAccount.js';
import SocialPost from '../model/SocialPost.js';
import { getProjectFeeds } from './socialFeedService.js';

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

function post(overrides = {}) {
  return {
    project_id: overrides.project_id,
    social_account_id: overrides.social_account_id || new mongoose.Types.ObjectId(),
    platform: overrides.platform || 'facebook',
    externalPostId: overrides.externalPostId || `p_${Math.random().toString(36).slice(2)}`,
    accountId: 'acct-1',
    accountName: 'Test Account',
    type: 'post',
    text: overrides.text ?? 'Default text',
    status: 'published',
    publishedAt: overrides.publishedAt || new Date('2026-08-01T00:00:00Z'),
    metrics: { likes: 1, comments: 1, shares: 1, views: null },
    syncedAt: new Date(),
  };
}

describe('getProjectFeeds', () => {
  let project;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    project = await SeoProject.create({
      user_id: new mongoose.Types.ObjectId(),
      project_name: `Social Feed Test Project ${Date.now()}`,
      main_url: 'https://example.com',
      seo_scope: 'local',
      keywords: ['social feed test'],
    });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    await SocialPost.deleteMany({ project_id: project._id });
    await SeoProject.deleteOne({ _id: project._id });
  });

  test('1: returns real posts for the project with correct pagination', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const docs = Array.from({ length: 25 }, (_, i) => post({
      project_id: project._id,
      externalPostId: `page1_${i}`,
      publishedAt: new Date(Date.UTC(2026, 7, 1, 0, 0, i)),
    }));
    await SocialPost.insertMany(docs);

    const result = await getProjectFeeds(project._id.toString(), { scopeToActiveAccounts: false, page: 1, limit: 10 });
    assert.equal(result.data.length, 10);
    assert.equal(result.pagination.total, 25);
    assert.equal(result.pagination.totalPages, 3);
    assert.equal(result.pagination.page, 1);
  });

  test('2: platform filter narrows both data and pagination.total, but not summary', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialPost.insertMany([
      post({ project_id: project._id, platform: 'facebook', externalPostId: 'fb1' }),
      post({ project_id: project._id, platform: 'facebook', externalPostId: 'fb2' }),
      post({ project_id: project._id, platform: 'instagram', externalPostId: 'ig1' }),
    ]);

    const result = await getProjectFeeds(project._id.toString(), { scopeToActiveAccounts: false, platform: 'facebook' });
    assert.equal(result.data.length, 2);
    assert.equal(result.pagination.total, 2);
    assert.ok(result.data.every((p) => p.platform === 'facebook'));
    // The summary tiles must still show the FULL project count regardless of the active filter.
    assert.equal(result.summary.all, 3);
    assert.equal(result.summary.facebook, 2);
    assert.equal(result.summary.instagram, 1);
  });

  test('3: unintegrated platforms always report a real 0, never a fabricated number', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialPost.insertMany([post({ project_id: project._id, platform: 'facebook' })]);
    const result = await getProjectFeeds(project._id.toString(), { scopeToActiveAccounts: false,});
    assert.equal(result.summary.x, 0);
    assert.equal(result.summary.linkedin, 0);
    assert.equal(result.summary.tiktok, 0);
  });

  test('4: search matches post text case-insensitively, and treats regex special characters as literal', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialPost.insertMany([
      post({ project_id: project._id, externalPostId: 's1', text: 'Grand Opening (10% off)!' }),
      post({ project_id: project._id, externalPostId: 's2', text: 'Unrelated post' }),
    ]);

    const result = await getProjectFeeds(project._id.toString(), { scopeToActiveAccounts: false, search: 'opening (10%' });
    assert.equal(result.data.length, 1);
    assert.equal(result.data[0].externalPostId, 's1');
  });

  test('5: date range (from/to) filters by publishedAt', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialPost.insertMany([
      post({ project_id: project._id, externalPostId: 'd1', publishedAt: new Date('2026-07-01T00:00:00Z') }),
      post({ project_id: project._id, externalPostId: 'd2', publishedAt: new Date('2026-08-01T00:00:00Z') }),
      post({ project_id: project._id, externalPostId: 'd3', publishedAt: new Date('2026-09-01T00:00:00Z') }),
    ]);

    const result = await getProjectFeeds(project._id.toString(), { scopeToActiveAccounts: false, from: '2026-07-15', to: '2026-08-15' });
    assert.equal(result.data.length, 1);
    assert.equal(result.data[0].externalPostId, 'd2');
  });

  test('6: sort "oldest" reverses the default "newest" order', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialPost.insertMany([
      post({ project_id: project._id, externalPostId: 'old', publishedAt: new Date('2026-01-01T00:00:00Z') }),
      post({ project_id: project._id, externalPostId: 'new', publishedAt: new Date('2026-06-01T00:00:00Z') }),
    ]);

    const newest = await getProjectFeeds(project._id.toString(), { scopeToActiveAccounts: false, sort: 'newest' });
    assert.equal(newest.data[0].externalPostId, 'new');
    const oldest = await getProjectFeeds(project._id.toString(), { scopeToActiveAccounts: false, sort: 'oldest' });
    assert.equal(oldest.data[0].externalPostId, 'old');
  });

  test('7: never returns another project\'s posts (project isolation)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const otherProject = await SeoProject.create({
      user_id: project.user_id, project_name: `Other Feed Project ${Date.now()}`, main_url: 'https://other.example.com',
      seo_scope: 'local', keywords: ['other'],
    });
    await SocialPost.insertMany([
      post({ project_id: project._id, externalPostId: 'mine' }),
      post({ project_id: otherProject._id, externalPostId: 'theirs' }),
    ]);

    const result = await getProjectFeeds(project._id.toString(), { scopeToActiveAccounts: false,});
    assert.equal(result.data.length, 1);
    assert.equal(result.data[0].externalPostId, 'mine');
    assert.equal(result.summary.all, 1);

    await SocialPost.deleteMany({ project_id: otherProject._id });
    await SeoProject.deleteOne({ _id: otherProject._id });
  });

  test('8: a project with zero posts returns an empty array and zeroed summary, never an error', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await getProjectFeeds(project._id.toString(), { scopeToActiveAccounts: false,});
    assert.deepEqual(result.data, []);
    assert.equal(result.pagination.total, 0);
    assert.deepEqual(result.summary, { all: 0, facebook: 0, instagram: 0, x: 0, linkedin: 0, tiktok: 0 });
  });

  test('9: limit is capped at the maximum page size (100) regardless of what is requested', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialPost.insertMany(Array.from({ length: 5 }, (_, i) => post({ project_id: project._id, externalPostId: `cap_${i}` })));
    const result = await getProjectFeeds(project._id.toString(), { scopeToActiveAccounts: false, limit: 5000 });
    assert.equal(result.pagination.limit, 100);
  });

  test('10: limit=100 (the largest frontend page-size option) is honored, not silently clamped to a smaller value', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialPost.insertMany(Array.from({ length: 120 }, (_, i) => post({ project_id: project._id, externalPostId: `hundred_${i}` })));
    const result = await getProjectFeeds(project._id.toString(), { scopeToActiveAccounts: false, page: 1, limit: 100 });
    assert.equal(result.data.length, 100, 'a user picking "100 per page" must actually get 100 results, not a silently smaller page');
    assert.equal(result.pagination.limit, 100);
    assert.equal(result.pagination.total, 120);
    assert.equal(result.pagination.totalPages, 2);
  });

  test('11: hasNextPage/hasPreviousPage are correct at the start, middle, and end of the result set', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialPost.insertMany(Array.from({ length: 25 }, (_, i) => post({ project_id: project._id, externalPostId: `nav_${i}` })));

    const page1 = await getProjectFeeds(project._id.toString(), { scopeToActiveAccounts: false, page: 1, limit: 10 });
    assert.equal(page1.pagination.hasPreviousPage, false);
    assert.equal(page1.pagination.hasNextPage, true);

    const page2 = await getProjectFeeds(project._id.toString(), { scopeToActiveAccounts: false, page: 2, limit: 10 });
    assert.equal(page2.pagination.hasPreviousPage, true);
    assert.equal(page2.pagination.hasNextPage, true);

    const page3 = await getProjectFeeds(project._id.toString(), { scopeToActiveAccounts: false, page: 3, limit: 10 });
    assert.equal(page3.pagination.hasPreviousPage, true);
    assert.equal(page3.pagination.hasNextPage, false, 'page 3 has only 5 of the 25 posts — there is no page 4');
  });

  test('12: changing page size while filters stay the same still scopes total/totalPages to the SAME filtered set, not the whole project', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialPost.insertMany([
      ...Array.from({ length: 8 }, (_, i) => post({ project_id: project._id, platform: 'instagram', externalPostId: `ig_${i}` })),
      ...Array.from({ length: 30 }, (_, i) => post({ project_id: project._id, platform: 'facebook', externalPostId: `fb_${i}` })),
    ]);

    const at10 = await getProjectFeeds(project._id.toString(), { scopeToActiveAccounts: false, platform: 'instagram', page: 1, limit: 10 });
    const at20 = await getProjectFeeds(project._id.toString(), { scopeToActiveAccounts: false, platform: 'instagram', page: 1, limit: 20 });
    assert.equal(at10.pagination.total, 8);
    assert.equal(at20.pagination.total, 8, 'the Instagram-filtered total must not change just because the page size changed');
    assert.equal(at10.data.length, 8);
    assert.equal(at20.data.length, 8);
  });
});

// Root-cause regression coverage: getProjectFeeds used to pool posts from
// EVERY connected account of a platform, unscoped by which Page/Instagram
// account is actually active — switching Facebook Pages via Switch
// Account never changed what Feeds showed. These tests lock in the new
// default (scopeToActiveAccounts: true) and its explicit opt-out.
describe('getProjectFeeds — account scoping (default: active account(s) only)', () => {
  let project, pageA, pageB, igForA;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    project = await SeoProject.create({
      user_id: new mongoose.Types.ObjectId(), project_name: `Feed Scope Test ${Date.now()}`,
      main_url: 'https://example.com', seo_scope: 'local', keywords: ['feed scope test'],
    });
    pageA = await SocialAccount.create({
      user_id: project.user_id, project_id: project._id, platform: 'facebook',
      platformAccountId: 'pg_scope_a', pageId: 'pg_scope_a', platformAccountName: 'Page A',
      accountType: 'page', accessToken: 'token-a', status: 'active', isActive: true,
    });
    pageB = await SocialAccount.create({
      user_id: project.user_id, project_id: project._id, platform: 'facebook',
      platformAccountId: 'pg_scope_b', pageId: 'pg_scope_b', platformAccountName: 'Page B',
      accountType: 'page', accessToken: 'token-b', status: 'active', isActive: false,
    });
    igForA = await SocialAccount.create({
      user_id: project.user_id, project_id: project._id, platform: 'instagram',
      platformAccountId: 'ig_scope_a', pageId: 'pg_scope_a', instagramBusinessAccountId: 'ig_scope_a',
      accountType: 'business', accessToken: 'token-a', status: 'active',
    });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    await SocialPost.deleteMany({ project_id: project._id });
    await SocialAccount.deleteMany({ project_id: project._id });
    await SeoProject.deleteOne({ _id: project._id });
  });

  test('1: by default, Feeds shows ONLY the active Facebook Page\'s posts and the active Instagram account\'s posts — not Page B\'s', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialPost.insertMany([
      post({ project_id: project._id, social_account_id: pageA._id, platform: 'facebook', externalPostId: 'a1' }),
      post({ project_id: project._id, social_account_id: pageA._id, platform: 'facebook', externalPostId: 'a2' }),
      post({ project_id: project._id, social_account_id: pageB._id, platform: 'facebook', externalPostId: 'b1' }),
      post({ project_id: project._id, social_account_id: igForA._id, platform: 'instagram', externalPostId: 'ig1' }),
    ]);

    const result = await getProjectFeeds(project._id.toString(), {});
    assert.equal(result.data.length, 3, 'Page A (2) + Instagram (1), never Page B\'s post');
    assert.ok(!result.data.some((p) => p.externalPostId === 'b1'), 'Page B is connected but not active — its posts must not appear');
    assert.equal(result.summary.all, 3);
    assert.equal(result.summary.facebook, 2, 'summary must also be scoped, not the full pooled 3');
    assert.equal(result.summary.instagram, 1);
  });

  test('2: switching the active Page changes what Feeds shows — Page B\'s posts appear, Page A\'s disappear', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialPost.insertMany([
      post({ project_id: project._id, social_account_id: pageA._id, platform: 'facebook', externalPostId: 'a1' }),
      post({ project_id: project._id, social_account_id: pageB._id, platform: 'facebook', externalPostId: 'b1' }),
    ]);

    const beforeSwitch = await getProjectFeeds(project._id.toString(), {});
    assert.deepEqual(beforeSwitch.data.map((p) => p.externalPostId).sort(), ['a1']);

    await SocialAccount.updateOne({ _id: pageA._id }, { $set: { isActive: false } });
    await SocialAccount.updateOne({ _id: pageB._id }, { $set: { isActive: true } });

    const afterSwitch = await getProjectFeeds(project._id.toString(), {});
    assert.deepEqual(afterSwitch.data.map((p) => p.externalPostId).sort(), ['b1']);
  });

  test('3: platform=facebook narrows to the active Facebook Page only, never every connected Page', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialPost.insertMany([
      post({ project_id: project._id, social_account_id: pageA._id, platform: 'facebook', externalPostId: 'a1' }),
      post({ project_id: project._id, social_account_id: pageB._id, platform: 'facebook', externalPostId: 'b1' }),
    ]);
    const result = await getProjectFeeds(project._id.toString(), { platform: 'facebook' });
    assert.deepEqual(result.data.map((p) => p.externalPostId), ['a1']);
  });

  test('4: scopeToActiveAccounts:false (the "All Feeds" explicit choice) restores the full pooled view across every connected account', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialPost.insertMany([
      post({ project_id: project._id, social_account_id: pageA._id, platform: 'facebook', externalPostId: 'a1' }),
      post({ project_id: project._id, social_account_id: pageB._id, platform: 'facebook', externalPostId: 'b1' }),
      post({ project_id: project._id, social_account_id: igForA._id, platform: 'instagram', externalPostId: 'ig1' }),
    ]);
    const result = await getProjectFeeds(project._id.toString(), { scopeToActiveAccounts: false });
    assert.equal(result.data.length, 3);
    assert.equal(result.summary.all, 3);
  });

  test('5: with no connected Facebook Page at all, scoped Feeds is honestly empty, never someone else\'s posts', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    // getActiveFacebookAccount falls back to "most recently connected"
    // when >1 exist and none is flagged isActive — so a genuine "no
    // active Page" state requires no CONNECTED (status:'active') Page at
    // all, not just isActive:false on existing ones.
    await SocialAccount.updateMany({ project_id: project._id, platform: 'facebook' }, { $set: { status: 'revoked', isActive: false } });
    await SocialPost.insertMany([
      post({ project_id: project._id, social_account_id: pageA._id, platform: 'facebook', externalPostId: 'a1' }),
    ]);
    const result = await getProjectFeeds(project._id.toString(), {});
    assert.deepEqual(result.data, []);
    assert.deepEqual(result.summary, { all: 0, facebook: 0, instagram: 0, x: 0, linkedin: 0, tiktok: 0 });
  });
});
