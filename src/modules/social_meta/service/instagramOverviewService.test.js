import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import crypto from 'crypto';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import SocialAccount from '../model/SocialAccount.js';
import SocialPost from '../model/SocialPost.js';
import instagramMediaService from './instagramMediaService.js';
import { getInstagramOverview } from './instagramOverviewService.js';

/**
 * Root-cause coverage for the reported bug ("Instagram metrics never
 * update, every account shows the same numbers"): the Instagram Overview
 * card was rendering entirely from frontend/lib/socialMediaDummyData.js
 * static values, never fetched from anywhere. These tests prove the real
 * replacement — getInstagramOverview — is genuinely account-scoped,
 * project-isolated, and never fabricates a value.
 *
 * Same conventions as facebookOverview.test.js: real service, real Mongo,
 * Graph calls substituted via instagramMediaService's default-exported
 * object, always restored in a finally.
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

async function withMockedInstagramData({ getInstagramAccountInfo, getInstagramInsights }, fn) {
  const original = {
    getInstagramAccountInfo: instagramMediaService.getInstagramAccountInfo,
    getInstagramInsights: instagramMediaService.getInstagramInsights,
  };
  if (getInstagramAccountInfo) instagramMediaService.getInstagramAccountInfo = getInstagramAccountInfo;
  if (getInstagramInsights) instagramMediaService.getInstagramInsights = getInstagramInsights;
  try {
    return await fn();
  } finally {
    instagramMediaService.getInstagramAccountInfo = original.getInstagramAccountInfo;
    instagramMediaService.getInstagramInsights = original.getInstagramInsights;
  }
}

function insightsMock(perMetricResponses) {
  return async (igAccountId, token, { metric, metricType }) => {
    const key = `${metric}:${metricType || 'series'}`;
    return perMetricResponses[key] || { success: true, values: [], totalValue: null, error: null };
  };
}

const HAPPY_ACCOUNT_INFO = async () => ({
  success: true,
  account: { id: 'ig_test_account', username: 'test_biz', name: 'Test Biz', mediaCount: 42, followersCount: 999, followsCount: 5, profilePictureUrl: 'https://example.com/pic.jpg' },
  error: null,
});
const HAPPY_INSIGHTS = insightsMock({
  'follower_count:series': { success: true, values: [{ date: '2026-08-01', value: 5 }], totalValue: null, error: null },
  'accounts_engaged:total_value': { success: true, values: [], totalValue: 100, error: null },
  'likes:total_value': { success: true, values: [], totalValue: 50, error: null },
});

describe('getInstagramOverview — real service + real Mongo, mocked Graph responses', () => {
  let projectA;
  const realToken = `real-page-token-${crypto.randomBytes(8).toString('hex')}`;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    projectA = await SeoProject.create({
      user_id: new mongoose.Types.ObjectId(),
      project_name: `Instagram Overview Test Project ${Date.now()}`,
      main_url: 'https://example.com',
      seo_scope: 'local',
      keywords: ['instagram overview test'],
    });
    // The FACEBOOK Page this Instagram account is linked to — required
    // now that getInstagramOverview resolves via the active Facebook Page
    // (see instagramOverviewService.js's root-cause header comment) rather
    // than an unscoped Instagram-only lookup.
    await SocialAccount.create({
      user_id: projectA.user_id,
      project_id: projectA._id,
      platform: 'facebook',
      platformAccountId: 'pg_test',
      pageId: 'pg_test',
      platformAccountName: 'Test Page',
      accountType: 'page',
      accessToken: 'fb-page-token',
      status: 'active',
    });
    await SocialAccount.create({
      user_id: projectA.user_id,
      project_id: projectA._id,
      platform: 'instagram',
      platformAccountId: 'ig_test_account',
      instagramBusinessAccountId: 'ig_test_account',
      pageId: 'pg_test',
      accountType: 'business',
      accessToken: realToken,
      status: 'active',
    });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    await SeoProject.deleteOne({ _id: projectA._id });
    await SocialAccount.deleteMany({ project_id: projectA._id });
    await SocialPost.deleteMany({ project_id: projectA._id });
  });

  test('1: no connected Instagram account returns connected:false, not an error', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await getInstagramOverview({ projectId: new mongoose.Types.ObjectId().toString() });
    assert.equal(result.connected, false);
  });

  test('2: a real successful fetch is normalized correctly — real values, not the old dummy 356/251/3/209', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await withMockedInstagramData(
      { getInstagramAccountInfo: HAPPY_ACCOUNT_INFO, getInstagramInsights: HAPPY_INSIGHTS },
      () => getInstagramOverview({ projectId: projectA._id.toString() }),
    );
    assert.equal(result.connected, true);
    assert.equal(result.account.username, 'test_biz');
    assert.equal(result.metrics.posts, 42);
    assert.equal(result.metrics.engagements, 100);
    assert.equal(result.metrics.followersGained, 5);
    assert.equal(result.metrics.likes, 50);
    assert.notEqual(result.metrics.posts, 356, 'must never be the old hardcoded dummy value');
    assert.equal(result.postsUnavailableReason, null);
    assert.equal(result.engagementsUnavailableReason, null);
    assert.equal(result.followersGainedUnavailableReason, null);
    assert.equal(result.likesUnavailableReason, null);
  });

  test('3: an invalid/expired token reports connected:false, reason:TOKEN_EXPIRED — never fake zero metrics', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await withMockedInstagramData(
      { getInstagramAccountInfo: async () => ({ success: false, account: null, error: { code: 'INSTAGRAM_TOKEN_INVALID', message: 'simulated' } }) },
      () => getInstagramOverview({ projectId: projectA._id.toString() }),
    );
    assert.equal(result.connected, false);
    assert.equal(result.reason, 'TOKEN_EXPIRED');
    assert.ok(!('metrics' in result));
  });

  test('4: an unavailable insights metric reports null with a reason, other metrics still succeed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await withMockedInstagramData(
      {
        getInstagramAccountInfo: HAPPY_ACCOUNT_INFO,
        getInstagramInsights: insightsMock({
          'follower_count:series': { success: false, values: [], totalValue: null, error: { code: 'INSTAGRAM_INSIGHTS_UNAVAILABLE', message: 'simulated' } },
          'accounts_engaged:total_value': { success: true, values: [], totalValue: 100, error: null },
          'likes:total_value': { success: true, values: [], totalValue: 50, error: null },
        }),
      },
      () => getInstagramOverview({ projectId: projectA._id.toString() }),
    );
    assert.equal(result.metrics.followersGained, null);
    assert.equal(result.followersGainedUnavailableReason, 'INSTAGRAM_INSIGHTS_UNAVAILABLE');
    assert.equal(result.metrics.engagements, 100, 'engagements must still succeed independently');
  });

  test('5: the comments-vs-likes chart is built from real, already-synced SocialPost documents, grouped by real publish day', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    // The service charts the last 30 days (dateRangeUtil: DEFAULT_RANGE = month) and that window is NOT changed here. The fixture days are therefore
    // taken relative to "now" (10 and 9 days ago, at UTC day boundaries) instead of being hard-coded dates that age out of the window.
    const firstDay = new Date(Date.now() - 10 * 86_400_000);
    firstDay.setUTCHours(0, 0, 0, 0);
    const secondDay = new Date(firstDay.getTime() + 86_400_000);
    const isoDay = (d) => d.toISOString().slice(0, 10);
    const socialAccount = await SocialAccount.findOne({ project_id: projectA._id, platform: 'instagram' });
    await SocialPost.insertMany([
      { project_id: projectA._id, social_account_id: socialAccount._id, platform: 'instagram', externalPostId: 'p1', accountId: 'ig_test_account', status: 'published', publishedAt: new Date(firstDay.getTime()), metrics: { likes: 10, comments: 2, shares: null, views: null } },
      { project_id: projectA._id, social_account_id: socialAccount._id, platform: 'instagram', externalPostId: 'p2', accountId: 'ig_test_account', status: 'published', publishedAt: new Date(firstDay.getTime() + 12 * 3_600_000), metrics: { likes: 5, comments: 1, shares: null, views: null } },
      { project_id: projectA._id, social_account_id: socialAccount._id, platform: 'instagram', externalPostId: 'p3', accountId: 'ig_test_account', status: 'published', publishedAt: new Date(secondDay.getTime()), metrics: { likes: 3, comments: 0, shares: null, views: null } },
    ]);

    const result = await withMockedInstagramData(
      { getInstagramAccountInfo: HAPPY_ACCOUNT_INFO, getInstagramInsights: HAPPY_INSIGHTS },
      () => getInstagramOverview({ projectId: projectA._id.toString() }),
    );

    assert.equal(result.chart.length, 2, 'two distinct real publish days');
    const day1 = result.chart.find((d) => d.date === isoDay(firstDay));
    assert.equal(day1.likes, 15, 'real sum of both posts published on the first day');
    assert.equal(day1.comments, 3);
  });

  test('6: with no synced posts, the chart is honestly empty — never fabricated data points', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await withMockedInstagramData(
      { getInstagramAccountInfo: HAPPY_ACCOUNT_INFO, getInstagramInsights: HAPPY_INSIGHTS },
      () => getInstagramOverview({ projectId: projectA._id.toString() }),
    );
    assert.deepEqual(result.chart, []);
  });

  test('7: a project with a DIFFERENT connected Instagram account never receives this project\'s account or posts (project isolation)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const otherProject = await SeoProject.create({ user_id: projectA.user_id, project_name: `Other IG ${Date.now()}`, main_url: 'https://other.example.com', seo_scope: 'local', keywords: ['other'] });
    await SocialAccount.create({
      user_id: projectA.user_id, project_id: otherProject._id, platform: 'instagram', platformAccountId: 'ig_other',
      instagramBusinessAccountId: 'ig_other', pageId: 'pg_other', accountType: 'business', accessToken: 'other-token', status: 'active',
    });

    let capturedIgId = null;
    await withMockedInstagramData(
      {
        getInstagramAccountInfo: async (igId) => { capturedIgId = igId; return HAPPY_ACCOUNT_INFO(); },
        getInstagramInsights: HAPPY_INSIGHTS,
      },
      () => getInstagramOverview({ projectId: projectA._id.toString() }),
    );

    assert.equal(capturedIgId, 'ig_test_account', 'must resolve THIS project\'s own Instagram account, never the other project\'s');

    await SocialAccount.deleteMany({ project_id: otherProject._id });
    await SeoProject.deleteOne({ _id: otherProject._id });
  });

  test('8b: range="day"/"week"/"month" changes the actual since/until window sent to Meta — root-cause fix for the Day/Week selector doing nothing', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const capturedWindows = [];
    await withMockedInstagramData(
      {
        getInstagramAccountInfo: HAPPY_ACCOUNT_INFO,
        getInstagramInsights: async (igAccountId, token, { since, until }) => {
          capturedWindows.push({ since, until });
          return { success: true, values: [], totalValue: 0, error: null };
        },
      },
      async () => {
        await getInstagramOverview({ projectId: projectA._id.toString(), range: 'day' });
        await getInstagramOverview({ projectId: projectA._id.toString(), range: 'week' });
        await getInstagramOverview({ projectId: projectA._id.toString(), range: 'month' });
      },
    );
    const spans = capturedWindows.map((w) => Math.round((w.until - w.since) / 86400));
    // Three isolated metric calls per fetch (follower_count, accounts_engaged, likes).
    assert.equal(spans[0], 1, 'day range must request roughly a 1-day window');
    assert.equal(spans[3], 7, 'week range must request roughly a 7-day window');
    assert.equal(spans[6], 30, 'month range must request roughly a 30-day window');
  });

  test('8c: an omitted range defaults to month (30 days), and the response echoes the resolved range/since/until, never a hardcoded label', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await withMockedInstagramData(
      { getInstagramAccountInfo: HAPPY_ACCOUNT_INFO, getInstagramInsights: HAPPY_INSIGHTS },
      () => getInstagramOverview({ projectId: projectA._id.toString() }),
    );
    assert.equal(result.range, 'month');
    assert.ok(result.since && !Number.isNaN(Date.parse(result.since)));
    assert.ok(result.until && !Number.isNaN(Date.parse(result.until)));
    assert.equal(Math.round((Date.parse(result.until) - Date.parse(result.since)) / 86400000), 30);
  });

  // Root-cause regression coverage: getInstagramOverview used to resolve
  // the Instagram account with an unscoped `{project_id, platform:
  // 'instagram', status:'active'}` findOne — no pageId filter. With TWO
  // Facebook Pages connected, each with its own linked Instagram account,
  // that query always returned the SAME Instagram row regardless of which
  // Page was actually active, so switching Pages via "Switch Account"
  // never changed what Instagram Overview showed. This proves the fixed
  // resolution (via the active Facebook Page's own pageId) is correct.
  test('9: with two Facebook Pages each linked to a different Instagram account, Overview resolves the ACTIVE Page\'s own Instagram account, never the other Page\'s', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    // projectA's beforeEach already created Page "pg_test" (active by the
    // single-Page fallback) linked to ig_test_account. Add a SECOND Page
    // with its own, different Instagram account and make IT active.
    await SocialAccount.create({
      user_id: projectA.user_id, project_id: projectA._id, platform: 'facebook',
      platformAccountId: 'pg_second', pageId: 'pg_second', platformAccountName: 'Second Page',
      accountType: 'page', accessToken: 'fb-page-token-2', status: 'active', isActive: true,
    });
    await SocialAccount.updateOne({ project_id: projectA._id, platform: 'facebook', platformAccountId: 'pg_test' }, { $set: { isActive: false } });
    await SocialAccount.create({
      user_id: projectA.user_id, project_id: projectA._id, platform: 'instagram',
      platformAccountId: 'ig_second_account', instagramBusinessAccountId: 'ig_second_account', pageId: 'pg_second',
      accountType: 'business', accessToken: 'ig-token-2', status: 'active',
    });

    let capturedIgId = null;
    const result = await withMockedInstagramData(
      {
        getInstagramAccountInfo: async (igId) => { capturedIgId = igId; return { success: true, account: { id: igId, username: 'second_account_biz', name: 'Second', mediaCount: 5, followersCount: 1, followsCount: 1, profilePictureUrl: null }, error: null }; },
        getInstagramInsights: HAPPY_INSIGHTS,
      },
      () => getInstagramOverview({ projectId: projectA._id.toString() }),
    );

    assert.equal(capturedIgId, 'ig_second_account', 'must resolve the ACTIVE Page\'s own linked Instagram account');
    assert.notEqual(capturedIgId, 'ig_test_account', 'must never keep returning the first-connected Page\'s Instagram account');
    assert.equal(result.account.username, 'second_account_biz');
  });

  test('9b: the active Facebook Page has no linked Instagram account at all — reported honestly, never falls back to another Page\'s account', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    // A second Page with NO Instagram row, made active — the first Page
    // (with ig_test_account) is now inactive.
    await SocialAccount.create({
      user_id: projectA.user_id, project_id: projectA._id, platform: 'facebook',
      platformAccountId: 'pg_no_ig', pageId: 'pg_no_ig', platformAccountName: 'No IG Page',
      accountType: 'page', accessToken: 'fb-page-token-3', status: 'active', isActive: true,
    });
    await SocialAccount.updateOne({ project_id: projectA._id, platform: 'facebook', platformAccountId: 'pg_test' }, { $set: { isActive: false } });

    const result = await getInstagramOverview({ projectId: projectA._id.toString() });
    assert.equal(result.connected, false);
    assert.equal(result.reason, 'NOT_LINKED_TO_ACTIVE_PAGE');
  });

  test('8: the access token never appears anywhere in the overview response', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await withMockedInstagramData(
      { getInstagramAccountInfo: HAPPY_ACCOUNT_INFO, getInstagramInsights: HAPPY_INSIGHTS },
      () => getInstagramOverview({ projectId: projectA._id.toString() }),
    );
    assert.ok(!JSON.stringify(result).includes(realToken));
  });
});
