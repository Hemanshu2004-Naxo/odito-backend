import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import instagramMediaService from './instagramMediaService.js';
import { getInstagramInsightsSummary, INSTAGRAM_INSIGHT_METRICS } from './instagramInsightsService.js';

/**
 * Added while building real Instagram Overview analytics (root cause of
 * the reported bug: Instagram's KPIs/chart were 100% static dummy data,
 * never fetched from anywhere — see instagramOverviewService.js's own
 * header comment). Every metric in INSTAGRAM_INSIGHT_METRICS was
 * confirmed LIVE against a real connected Instagram Business account
 * (17841478305520321), not assumed: accounts_engaged/likes require
 * metric_type=total_value (Meta's own error otherwise), follower_count
 * supports the classic per-day series, impressions is confirmed invalid.
 *
 * No mocking library exists in this repo — instagramMediaService's
 * getInstagramInsights is substituted on its shared default-exported
 * object for the duration of each test, always restored in a finally.
 */

async function withMockedGetInstagramInsights(implementation, fn) {
  const original = instagramMediaService.getInstagramInsights;
  instagramMediaService.getInstagramInsights = implementation;
  try {
    return await fn();
  } finally {
    instagramMediaService.getInstagramInsights = original;
  }
}

function insightsMock(perMetricResponses) {
  return async (igAccountId, token, { metric, metricType }) => {
    const key = `${metric}:${metricType || 'series'}`;
    return perMetricResponses[key] || { success: true, values: [], totalValue: null, error: null };
  };
}

describe('getInstagramInsightsSummary', () => {
  test('1: the metric map uses the live-confirmed current metrics, never the invalid "impressions"', () => {
    assert.equal(INSTAGRAM_INSIGHT_METRICS.followersGained.metric, 'follower_count');
    assert.equal(INSTAGRAM_INSIGHT_METRICS.engagements.metric, 'accounts_engaged');
    assert.equal(INSTAGRAM_INSIGHT_METRICS.engagements.metricType, 'total_value');
    assert.equal(INSTAGRAM_INSIGHT_METRICS.likes.metric, 'likes');
    assert.equal(INSTAGRAM_INSIGHT_METRICS.likes.metricType, 'total_value');
    const allMetrics = Object.values(INSTAGRAM_INSIGHT_METRICS).map((m) => m.metric);
    assert.ok(!allMetrics.includes('impressions'), 'the deprecated/invalid metric must never be requested');
  });

  test('2: a total_value metric normalizes to its single aggregate value, real 0 included', async () => {
    const result = await withMockedGetInstagramInsights(
      insightsMock({
        'accounts_engaged:total_value': { success: true, values: [], totalValue: 16932, error: null },
        'likes:total_value': { success: true, values: [], totalValue: 0, error: null },
        'follower_count:series': { success: true, values: [], totalValue: null, error: null },
      }),
      () => getInstagramInsightsSummary({ projectId: 'proj-1', igAccountId: 'ig-1', pageAccessToken: 'token', since: 1, until: 2 }),
    );
    assert.equal(result.engagements.value, 16932);
    assert.equal(result.likes.value, 0, 'a real, measured zero from Meta must render as 0, not null');
    assert.equal(result.likes.unavailableReason, null);
  });

  test('3: a per-day series metric sums its values, an empty series is a genuine 0', async () => {
    const result = await withMockedGetInstagramInsights(
      insightsMock({
        'follower_count:series': { success: true, values: [{ date: '2026-08-01', value: 4 }, { date: '2026-08-02', value: 6 }], totalValue: null, error: null },
        'accounts_engaged:total_value': { success: true, values: [], totalValue: 0, error: null },
        'likes:total_value': { success: true, values: [], totalValue: 0, error: null },
      }),
      () => getInstagramInsightsSummary({ projectId: 'proj-1', igAccountId: 'ig-1', pageAccessToken: 'token', since: 1, until: 2 }),
    );
    assert.equal(result.followersGained.value, 10);
  });

  test('4: a failed metric reports value:null with a reason, never a fabricated 0', async () => {
    const result = await withMockedGetInstagramInsights(
      insightsMock({
        'follower_count:series': { success: false, values: [], totalValue: null, error: { code: 'INSTAGRAM_INSIGHTS_UNAVAILABLE', message: 'simulated' } },
        'accounts_engaged:total_value': { success: true, values: [], totalValue: 5, error: null },
        'likes:total_value': { success: true, values: [], totalValue: 5, error: null },
      }),
      () => getInstagramInsightsSummary({ projectId: 'proj-1', igAccountId: 'ig-1', pageAccessToken: 'token', since: 1, until: 2 }),
    );
    assert.equal(result.followersGained.value, null);
    assert.equal(result.followersGained.unavailableReason, 'INSTAGRAM_INSIGHTS_UNAVAILABLE');
  });

  test('5: one metric failing does not affect the others — isolation', async () => {
    const result = await withMockedGetInstagramInsights(
      insightsMock({
        'accounts_engaged:total_value': { success: false, values: [], totalValue: null, error: { code: 'INSTAGRAM_TOKEN_INVALID', message: 'simulated' } },
        'follower_count:series': { success: true, values: [{ date: '2026-08-01', value: 3 }], totalValue: null, error: null },
        'likes:total_value': { success: true, values: [], totalValue: 20, error: null },
      }),
      () => getInstagramInsightsSummary({ projectId: 'proj-1', igAccountId: 'ig-1', pageAccessToken: 'token', since: 1, until: 2 }),
    );
    assert.equal(result.engagements.unavailableReason, 'INSTAGRAM_TOKEN_INVALID');
    assert.equal(result.followersGained.value, 3, 'followersGained must succeed independently');
    assert.equal(result.likes.value, 20, 'likes must succeed independently');
  });

  test('6: the access token never appears anywhere in the returned result or logs', async () => {
    const originalLog = console.log;
    const captured = [];
    console.log = (...args) => { captured.push(args.join(' ')); };
    let result;
    try {
      result = await withMockedGetInstagramInsights(
        insightsMock({
          'follower_count:series': { success: true, values: [], totalValue: null, error: null },
          'accounts_engaged:total_value': { success: true, values: [], totalValue: 1, error: null },
          'likes:total_value': { success: true, values: [], totalValue: 1, error: null },
        }),
        () => getInstagramInsightsSummary({ projectId: 'proj-1', igAccountId: 'ig-1', pageAccessToken: 'super-secret-real-token-value', since: 1, until: 2 }),
      );
    } finally {
      console.log = originalLog;
    }
    assert.ok(!JSON.stringify(result).includes('super-secret-real-token-value'));
    assert.ok(!captured.join('\n').includes('super-secret-real-token-value'));
    assert.ok(captured.join('\n').includes('INSTAGRAM_INSIGHTS_REQUEST'));
    assert.ok(captured.join('\n').includes('INSTAGRAM_INSIGHTS_RESULT'));
  });
});
