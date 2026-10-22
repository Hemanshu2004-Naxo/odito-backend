import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import crypto from 'crypto';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import SocialAccount from '../model/SocialAccount.js';
import facebookPageDataService from '../service/facebookPageDataService.js';
import { getFacebookOverview } from '../service/facebookOverviewService.js';
import { getFacebookOverviewHandler } from './facebookController.js';

/**
 * Facebook dashboard data — added after a real production discovery: live
 * testing against an actual connected Facebook Page (a real OAuth
 * connection, real Meta API calls, made during this exact investigation)
 * found that Meta's classic Page Insights metrics (page_impressions,
 * page_impressions_unique, page_fan_adds) are genuinely INVALID under the
 * current API version for real Pages — confirmed via Meta's own error
 * "(#100) The value must be a valid insights metric", not assumed from
 * documentation. page_daily_follows was found to be the real, valid
 * replacement for "new fans"; no valid replacement exists for
 * "impressions" at all. These tests encode that real, verified behavior.
 *
 * Same conventions as the rest of this module: real controller/service
 * functions, mock req/res, real MongoDB, no mocking library — Meta Graph
 * calls are substituted via facebookPageDataService's default-exported
 * object for the success-path cases (see that file's own comment), always
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

function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

/**
 * getFacebookInsights (facebookInsightsService.js) now calls
 * getPageInsights ONCE PER METRIC, independently — this mock inspects
 * which single metric was requested and returns that metric's own
 * canned response, so a test can make page_views_total and
 * page_daily_follows behave completely differently in the same test.
 */
function insightsMock(perMetricResponses) {
  return async (pageId, token, { metrics }) => {
    const metric = metrics[0];
    return perMetricResponses[metric] || { success: true, metrics: {}, error: null };
  };
}

async function withMockedFacebookData({ getPageInfo, getPagePosts, getPageInsights }, fn) {
  const original = {
    getPageInfo: facebookPageDataService.getPageInfo,
    getPagePosts: facebookPageDataService.getPagePosts,
    getPageInsights: facebookPageDataService.getPageInsights,
  };
  if (getPageInfo) facebookPageDataService.getPageInfo = getPageInfo;
  if (getPagePosts) facebookPageDataService.getPagePosts = getPagePosts;
  if (getPageInsights) facebookPageDataService.getPageInsights = getPageInsights;
  try {
    return await fn();
  } finally {
    facebookPageDataService.getPageInfo = original.getPageInfo;
    facebookPageDataService.getPagePosts = original.getPagePosts;
    facebookPageDataService.getPageInsights = original.getPageInsights;
  }
}

describe('getFacebookOverview — real service + real Mongo, mocked Graph responses', () => {
  let projectA;
  const realPageToken = `real-page-token-${crypto.randomBytes(8).toString('hex')}`;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    projectA = await SeoProject.create({
      user_id: new mongoose.Types.ObjectId(),
      project_name: `Facebook Overview Test Project ${Date.now()}`,
      main_url: 'https://example.com',
      seo_scope: 'local',
      keywords: ['facebook overview test'],
    });
    await SocialAccount.create({
      user_id: projectA.user_id,
      project_id: projectA._id,
      platform: 'facebook',
      platformAccountId: 'pg_fb_overview_test',
      pageId: 'pg_fb_overview_test',
      accountType: 'page',
      accessToken: realPageToken,
      status: 'active',
    });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    await SeoProject.deleteOne({ _id: projectA._id });
    await SocialAccount.deleteMany({ project_id: projectA._id });
  });

  test('1: no connected Page returns connected:false, not an error', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await getFacebookOverview({ projectId: new mongoose.Types.ObjectId().toString() });
    assert.equal(result.connected, false);
  });

  test('2: a real page_info + posts + insights success is normalized correctly — Page Views (page_views_total) has replaced the retired Page Impressions', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await withMockedFacebookData(
      {
        getPageInfo: async () => ({ success: true, page: { id: 'pg_fb_overview_test', name: 'Odito', picture: 'https://example.com/pic.jpg' }, error: null }),
        getPagePosts: async () => ({ success: true, posts: [{ id: 'post_1', message: 'hi', createdTime: new Date().toISOString(), permalink: 'https://facebook.com/post_1' }], error: null }),
        getPageInsights: insightsMock({
          page_views_total: { success: true, metrics: { page_views_total: [{ date: '2026-08-01', value: 12 }, { date: '2026-08-02', value: 30 }] }, error: null },
          page_daily_follows: { success: true, metrics: { page_daily_follows: [{ date: '2026-08-01', value: 3 }, { date: '2026-08-02', value: 2 }] }, error: null },
        }),
      },
      () => getFacebookOverview({ projectId: projectA._id.toString() }),
    );

    assert.equal(result.connected, true);
    assert.equal(result.page.name, 'Odito');
    assert.equal(result.metrics.recentPosts, 1);
    assert.equal(result.metrics.newFans, 5);
    assert.equal(result.metrics.pageViews, 42, 'real page_views_total value (12+30), not fabricated/null');
    assert.equal(result.pageViewsUnavailableReason, null);
    assert.equal(result.newFansUnavailableReason, null);
    assert.deepEqual(result.chart, [{ date: '2026-08-01', value: 12 }, { date: '2026-08-02', value: 30 }], 'chart must use the real page_views_total series, not a fabricated one');
    assert.ok(!('pageImpressions' in result.metrics), 'the retired field name must not still appear in the response');
  });

  test('3: a successful insights call with an EMPTY series is a genuine 0, not null (Page Views and New Fans independently)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await withMockedFacebookData(
      {
        getPageInfo: async () => ({ success: true, page: { id: 'pg_fb_overview_test', name: 'Odito', picture: null }, error: null }),
        getPagePosts: async () => ({ success: true, posts: [], error: null }),
        getPageInsights: insightsMock({
          page_views_total: { success: true, metrics: { page_views_total: [] }, error: null },
          page_daily_follows: { success: true, metrics: { page_daily_follows: [] }, error: null },
        }),
      },
      () => getFacebookOverview({ projectId: projectA._id.toString() }),
    );
    assert.equal(result.metrics.pageViews, 0, 'a real zero — the call succeeded with no recorded page views, that is not "unavailable"');
    assert.equal(result.metrics.newFans, 0, 'a real zero, not null — the call succeeded with no events, that is not "unavailable"');
    assert.equal(result.pageViewsUnavailableReason, null);
  });

  test('4: a failed insights call reports pageViews/newFans:null with a reason, never a fake 0', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await withMockedFacebookData(
      {
        getPageInfo: async () => ({ success: true, page: { id: 'pg_fb_overview_test', name: 'Odito', picture: null }, error: null }),
        getPagePosts: async () => ({ success: true, posts: [], error: null }),
        getPageInsights: insightsMock({
          page_views_total: { success: false, metrics: {}, error: { code: 'FACEBOOK_INSIGHTS_UNAVAILABLE', message: 'simulated' } },
          page_daily_follows: { success: false, metrics: {}, error: { code: 'FACEBOOK_INSIGHTS_UNAVAILABLE', message: 'simulated' } },
        }),
      },
      () => getFacebookOverview({ projectId: projectA._id.toString() }),
    );
    assert.equal(result.metrics.pageViews, null);
    assert.equal(result.metrics.newFans, null);
    assert.equal(result.pageViewsUnavailableReason, 'FACEBOOK_INSIGHTS_UNAVAILABLE');
    assert.equal(result.newFansUnavailableReason, 'FACEBOOK_INSIGHTS_UNAVAILABLE');
  });

  test('4b: Page Views failing does NOT break New Fans, and vice versa — one unavailable metric never destroys the others', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await withMockedFacebookData(
      {
        getPageInfo: async () => ({ success: true, page: { id: 'pg_fb_overview_test', name: 'Odito', picture: null }, error: null }),
        getPagePosts: async () => ({ success: true, posts: [], error: null }),
        getPageInsights: insightsMock({
          page_views_total: { success: false, metrics: {}, error: { code: 'FACEBOOK_REQUEST_TOO_LARGE', message: 'simulated: too much data' } },
          page_daily_follows: { success: true, metrics: { page_daily_follows: [{ date: '2026-08-01', value: 4 }] }, error: null },
        }),
      },
      () => getFacebookOverview({ projectId: projectA._id.toString() }),
    );
    assert.equal(result.metrics.pageViews, null);
    assert.equal(result.pageViewsUnavailableReason, 'FACEBOOK_REQUEST_TOO_LARGE');
    assert.equal(result.metrics.newFans, 4, 'New Fans must still succeed independently even though Page Views failed');
    assert.equal(result.newFansUnavailableReason, null);
  });

  test('5: an invalid/expired token on the Page-info call reports connected:false, reason:TOKEN_EXPIRED — never fake zero metrics', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await withMockedFacebookData(
      { getPageInfo: async () => ({ success: false, page: null, error: { code: 'FACEBOOK_TOKEN_INVALID', message: 'simulated' } }) },
      () => getFacebookOverview({ projectId: projectA._id.toString() }),
    );
    assert.equal(result.connected, false);
    assert.equal(result.reason, 'TOKEN_EXPIRED');
    assert.ok(!('metrics' in result), 'must not return a metrics object with fake values when the connection itself is broken');
  });

  test('6: a real, unparsable Page token hits the REAL Meta API and is classified as a stable failure (live, no mock)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await getFacebookOverview({ projectId: projectA._id.toString() });
    // The stored token is genuinely fake — Meta will reject it for real.
    assert.equal(result.connected, false);
    assert.ok(['TOKEN_EXPIRED', 'FETCH_FAILED'].includes(result.reason));
  });

  test('7: the Page access token never appears in the overview response', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await withMockedFacebookData(
      {
        getPageInfo: async () => ({ success: true, page: { id: 'pg_fb_overview_test', name: 'Odito', picture: null }, error: null }),
        getPagePosts: async () => ({ success: true, posts: [], error: null }),
        getPageInsights: async () => ({ success: true, metrics: { page_daily_follows: [] }, error: null }),
      },
      () => getFacebookOverview({ projectId: projectA._id.toString() }),
    );
    assert.ok(!JSON.stringify(result).includes(realPageToken));
  });

  test('8: the Page access token never appears in logs during a full overview fetch', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const originalLog = console.log;
    const originalError = console.error;
    const captured = [];
    console.log = (...args) => { captured.push(args.join(' ')); };
    console.error = (...args) => { captured.push(args.join(' ')); };

    try {
      await withMockedFacebookData(
        {
          getPageInfo: async () => ({ success: true, page: { id: 'pg_fb_overview_test', name: 'Odito', picture: null }, error: null }),
          getPagePosts: async () => ({ success: true, posts: [], error: null }),
          getPageInsights: async () => ({ success: true, metrics: { page_daily_follows: [] }, error: null }),
        },
        () => getFacebookOverview({ projectId: projectA._id.toString() }),
      );
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    assert.ok(!captured.join('\n').includes(realPageToken));
  });

  test('10: range="day"/"week"/"month" changes the actual since/until window sent to Meta — root-cause fix for the Day/Week selector doing nothing', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const capturedWindows = [];
    await withMockedFacebookData(
      {
        getPageInfo: async () => ({ success: true, page: { id: 'pg_fb_overview_test', name: 'Odito', picture: null }, error: null }),
        getPagePosts: async () => ({ success: true, posts: [], error: null }),
        getPageInsights: async (pageId, token, { since, until }) => {
          capturedWindows.push({ since, until });
          return { success: true, metrics: { page_views_total: [], page_daily_follows: [] }, error: null };
        },
      },
      async () => {
        await getFacebookOverview({ projectId: projectA._id.toString(), range: 'day' });
        await getFacebookOverview({ projectId: projectA._id.toString(), range: 'week' });
        await getFacebookOverview({ projectId: projectA._id.toString(), range: 'month' });
      },
    );
    const spans = capturedWindows.map((w) => Math.round((w.until - w.since) / 86400));
    // Two isolated calls per fetch (page_views_total + page_daily_follows) — every pair for one fetch shares the same window.
    assert.equal(spans[0], 1, 'day range must request roughly a 1-day window');
    assert.equal(spans[2], 7, 'week range must request roughly a 7-day window');
    assert.equal(spans[4], 30, 'month range must request roughly a 30-day window');
  });

  test('11: an omitted range defaults to month (30 days) — unchanged behavior for every existing caller', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    let capturedWindow = null;
    await withMockedFacebookData(
      {
        getPageInfo: async () => ({ success: true, page: { id: 'pg_fb_overview_test', name: 'Odito', picture: null }, error: null }),
        getPagePosts: async () => ({ success: true, posts: [], error: null }),
        getPageInsights: async (pageId, token, { since, until }) => {
          if (!capturedWindow) capturedWindow = { since, until };
          return { success: true, metrics: { page_views_total: [], page_daily_follows: [] }, error: null };
        },
      },
      () => getFacebookOverview({ projectId: projectA._id.toString() }),
    );
    assert.equal(Math.round((capturedWindow.until - capturedWindow.since) / 86400), 30);
  });

  test('12: the response echoes the resolved range and real since/until, never a hardcoded date label', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await withMockedFacebookData(
      {
        getPageInfo: async () => ({ success: true, page: { id: 'pg_fb_overview_test', name: 'Odito', picture: null }, error: null }),
        getPagePosts: async () => ({ success: true, posts: [], error: null }),
        getPageInsights: async () => ({ success: true, metrics: { page_views_total: [], page_daily_follows: [] }, error: null }),
      },
      () => getFacebookOverview({ projectId: projectA._id.toString(), range: 'week' }),
    );
    assert.equal(result.range, 'week');
    assert.ok(result.since && !Number.isNaN(Date.parse(result.since)));
    assert.ok(result.until && !Number.isNaN(Date.parse(result.until)));
  });

  test('13: an invalid range value falls back to month instead of throwing or requesting an unbounded window', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await withMockedFacebookData(
      {
        getPageInfo: async () => ({ success: true, page: { id: 'pg_fb_overview_test', name: 'Odito', picture: null }, error: null }),
        getPagePosts: async () => ({ success: true, posts: [], error: null }),
        getPageInsights: async () => ({ success: true, metrics: { page_views_total: [], page_daily_follows: [] }, error: null }),
      },
      () => getFacebookOverview({ projectId: projectA._id.toString(), range: 'not-a-real-range' }),
    );
    assert.equal(result.range, 'month');
  });

  test('9: the HTTP handler never leaks a token in its response even on failure', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const req = { projectId: projectA._id.toString() };
    const res = mockRes();
    await getFacebookOverviewHandler(req, res);
    assert.ok(!JSON.stringify(res.body).includes(realPageToken));
  });
});
