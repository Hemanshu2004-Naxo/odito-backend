import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import facebookPageDataService from './facebookPageDataService.js';
import { getFacebookInsights, FACEBOOK_INSIGHT_METRICS } from './facebookInsightsService.js';

/**
 * Added while migrating the Facebook Overview "Page Impressions" card off
 * Meta's deprecated impressions metrics. FACEBOOK_INSIGHT_METRICS is the
 * ONE place a Meta metric name is written for this flow — every entry was
 * confirmed live against a real connected Page (934617193060229), not
 * assumed from documentation: page_impressions and every impressions
 * variant still return Meta's real "(#100) The value must be a valid
 * insights metric" error; page_views_total (the "Page Views" replacement)
 * and page_daily_follows ("New Fans", unchanged/already valid) both
 * return 200 OK.
 *
 * No mocking library exists in this repo — facebookPageDataService's
 * getPageInsights is substituted on its shared default-exported object
 * for the duration of each test, always restored in a finally.
 */

async function withMockedGetPageInsights(implementation, fn) {
  const original = facebookPageDataService.getPageInsights;
  facebookPageDataService.getPageInsights = implementation;
  try {
    return await fn();
  } finally {
    facebookPageDataService.getPageInsights = original;
  }
}

function insightsMock(perMetricResponses) {
  return async (pageId, token, { metrics }) => {
    const metric = metrics[0];
    return perMetricResponses[metric] || { success: true, metrics: {}, error: null };
  };
}

describe('getFacebookInsights', () => {
  test('1: the metric map requests the currently-supported page_views_total, never the deprecated page_impressions', () => {
    assert.equal(FACEBOOK_INSIGHT_METRICS.pageViews, 'page_views_total');
    assert.notEqual(FACEBOOK_INSIGHT_METRICS.pageViews, 'page_impressions');
    assert.ok(!Object.values(FACEBOOK_INSIGHT_METRICS).includes('page_impressions'));
    assert.ok(!Object.values(FACEBOOK_INSIGHT_METRICS).includes('page_impressions_unique'));
    assert.ok(!Object.values(FACEBOOK_INSIGHT_METRICS).includes('page_fan_adds'));
  });

  test('2: a real successful response is normalized into a summed value and the raw series', async () => {
    const capturedRequests = [];
    const result = await withMockedGetPageInsights(async (pageId, token, opts) => {
      capturedRequests.push(opts.metrics[0]);
      return insightsMock({
        page_views_total: { success: true, metrics: { page_views_total: [{ date: '2026-08-01', value: 5 }, { date: '2026-08-02', value: 7 }] }, error: null },
        page_daily_follows: { success: true, metrics: { page_daily_follows: [{ date: '2026-08-01', value: 1 }] }, error: null },
      })(pageId, token, opts);
    }, () => getFacebookInsights({ projectId: 'proj-1', pageId: 'pg-1', pageAccessToken: 'token', since: 1, until: 2 }));

    assert.equal(result.pageViews.value, 12);
    assert.equal(result.pageViews.unavailableReason, null);
    assert.deepEqual(result.pageViews.series, [{ date: '2026-08-01', value: 5 }, { date: '2026-08-02', value: 7 }]);
    assert.equal(result.newFollowers.value, 1);
    assert.ok(capturedRequests.includes('page_views_total'));
    assert.ok(capturedRequests.includes('page_daily_follows'));
    assert.ok(!capturedRequests.includes('page_impressions'), 'the deprecated metric must never be requested');
  });

  test('3: each metric is requested as its OWN independent Graph API call, never batched together', async () => {
    const calls = [];
    await withMockedGetPageInsights(async (pageId, token, opts) => {
      calls.push(opts.metrics);
      return { success: true, metrics: {}, error: null };
    }, () => getFacebookInsights({ projectId: 'proj-1', pageId: 'pg-1', pageAccessToken: 'token', since: 1, until: 2 }));

    assert.equal(calls.length, 2, 'two independent calls, not one batched call');
    assert.ok(calls.every((m) => m.length === 1), 'each call must request exactly one metric — batching is what let one bad metric take down every metric');
  });

  test('4: a successful call with an EMPTY series is a genuine 0, never null', async () => {
    const result = await withMockedGetPageInsights(
      insightsMock({
        page_views_total: { success: true, metrics: { page_views_total: [] }, error: null },
        page_daily_follows: { success: true, metrics: { page_daily_follows: [] }, error: null },
      }),
      () => getFacebookInsights({ projectId: 'proj-1', pageId: 'pg-1', pageAccessToken: 'token', since: 1, until: 2 }),
    );
    assert.equal(result.pageViews.value, 0);
    assert.equal(result.pageViews.unavailableReason, null);
    assert.equal(result.newFollowers.value, 0);
  });

  test('5: a failed call reports value:null with a reason, never a fabricated 0', async () => {
    const result = await withMockedGetPageInsights(
      insightsMock({
        page_views_total: { success: false, metrics: {}, error: { code: 'FACEBOOK_REQUEST_TOO_LARGE', message: 'too much data' } },
        page_daily_follows: { success: true, metrics: { page_daily_follows: [{ date: '2026-08-01', value: 2 }] }, error: null },
      }),
      () => getFacebookInsights({ projectId: 'proj-1', pageId: 'pg-1', pageAccessToken: 'token', since: 1, until: 2 }),
    );
    assert.equal(result.pageViews.value, null);
    assert.equal(result.pageViews.unavailableReason, 'FACEBOOK_REQUEST_TOO_LARGE');
  });

  test('6: Page Views failing does not affect New Fans, and vice versa — one unavailable metric never destroys the others', async () => {
    const result = await withMockedGetPageInsights(
      insightsMock({
        page_views_total: { success: false, metrics: {}, error: { code: 'FACEBOOK_INSIGHTS_UNAVAILABLE', message: 'simulated' } },
        page_daily_follows: { success: true, metrics: { page_daily_follows: [{ date: '2026-08-01', value: 9 }] }, error: null },
      }),
      () => getFacebookInsights({ projectId: 'proj-1', pageId: 'pg-1', pageAccessToken: 'token', since: 1, until: 2 }),
    );
    assert.equal(result.pageViews.unavailableReason, 'FACEBOOK_INSIGHTS_UNAVAILABLE');
    assert.equal(result.newFollowers.value, 9, 'New Fans must succeed independently even though Page Views failed');
    assert.equal(result.newFollowers.unavailableReason, null);
  });

  test('7: the access token never appears anywhere in the returned result', async () => {
    const result = await withMockedGetPageInsights(
      insightsMock({
        page_views_total: { success: true, metrics: { page_views_total: [{ date: '2026-08-01', value: 1 }] }, error: null },
        page_daily_follows: { success: true, metrics: { page_daily_follows: [] }, error: null },
      }),
      () => getFacebookInsights({ projectId: 'proj-1', pageId: 'pg-1', pageAccessToken: 'super-secret-real-token-value', since: 1, until: 2 }),
    );
    assert.ok(!JSON.stringify(result).includes('super-secret-real-token-value'));
  });

  test('8: FACEBOOK_INSIGHTS_REQUEST/RESULT are logged with safe fields only, never a token', async () => {
    const originalLog = console.log;
    const captured = [];
    console.log = (...args) => { captured.push(args.join(' ')); };
    try {
      await withMockedGetPageInsights(
        insightsMock({
          page_views_total: { success: true, metrics: { page_views_total: [] }, error: null },
          page_daily_follows: { success: true, metrics: { page_daily_follows: [] }, error: null },
        }),
        () => getFacebookInsights({ projectId: 'proj-1', pageId: 'pg-1', pageAccessToken: 'super-secret-real-token-value', since: 1, until: 2 }),
      );
    } finally {
      console.log = originalLog;
    }
    const logText = captured.join('\n');
    assert.ok(logText.includes('FACEBOOK_INSIGHTS_REQUEST'));
    assert.ok(logText.includes('FACEBOOK_INSIGHTS_RESULT'));
    assert.ok(logText.includes('page_views_total'), 'the requested metric names are safe to log');
    assert.ok(!logText.includes('super-secret-real-token-value'));
  });
});
