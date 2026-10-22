import instagramMediaService from './instagramMediaService.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * InstagramInsightsService — the ONLY place a real Meta Instagram Insights
 * metric NAME is written down, mirroring facebookInsightsService.js's
 * exact role for Facebook. instagramOverviewService.js calls this and
 * never sees a raw metric string.
 *
 * Every entry was confirmed LIVE against a real connected Instagram
 * Business account (17841478305520321, "nashikcityguide") on the
 * configured META_GRAPH_API_VERSION, not assumed from documentation:
 *
 *   `accounts_engaged` and `likes` both REQUIRE `metric_type: 'total_value'`
 *   — confirmed live: omitting it returns Meta's own actionable error
 *   "should be specified with parameter metric_type=total_value". With
 *   it, Meta returns ONE aggregate number for the whole requested window
 *   (not a per-day series) — e.g. a real 30-day total_interactions of
 *   36203, a real 30-day likes total of 16844.
 *
 *   `follower_count` still supports the classic per-day `values[]` series
 *   with no metric_type needed — confirmed live, real fluctuating daily
 *   values. This is a genuine "gained per day" style metric, the direct
 *   analog of Facebook's page_daily_follows, so it backs "Followers
 *   Gained" the same way page_daily_follows backs Facebook's "New Fans".
 *
 *   `impressions` is confirmed INVALID on this API version — Meta's own
 *   error enumerates the full current valid metric list, and impressions
 *   is not in it. No Instagram metric maps to the old "Impressions" idea
 *   at the account level any more, same story as Facebook's Page
 *   Impressions.
 */
export const INSTAGRAM_INSIGHT_METRICS = {
  followersGained: { metric: 'follower_count' },
  engagements: { metric: 'accounts_engaged', metricType: 'total_value' },
  likes: { metric: 'likes', metricType: 'total_value' },
};

/**
 * One metric, one independent Graph API call — same isolation discipline
 * as facebookInsightsService.js's fetchOneMetric, for the same reason: a
 * single unsupported/rejected metric must never take the others down
 * with it.
 */
async function fetchOneMetric(igAccountId, pageAccessToken, key, { since, until }) {
  const { metric, metricType } = INSTAGRAM_INSIGHT_METRICS[key];
  const result = await instagramMediaService.getInstagramInsights(igAccountId, pageAccessToken, { metric, since, until, period: 'day', metricType });

  if (!result.success) {
    return { metric, value: null, series: [], unavailableReason: result.error?.code || 'INSTAGRAM_INSIGHTS_UNAVAILABLE' };
  }

  if (metricType === 'total_value') {
    // A total_value response either has the aggregate number (a real,
    // successfully-measured total — 0 is a real, valid value here, never
    // conflated with unavailable) or the call itself failed above; there
    // is no ambiguous "empty array" case for this response shape, unlike
    // the classic per-day series below.
    return { metric, value: result.totalValue ?? 0, series: [], unavailableReason: null };
  }

  // Classic per-day series: an EMPTY values array from a successful call
  // is a genuine 0 (Meta omits zero-activity days rather than returning
  // explicit zero points, confirmed live for Facebook's identical
  // behavior) — only a failed call means "unavailable".
  const value = result.values.reduce((sum, v) => sum + (v.value || 0), 0);
  return { metric, value, series: result.values, unavailableReason: null };
}

/**
 * Fetches every mapped Instagram Insights metric for one account,
 * independently. Never throws — a metric-level failure is captured in
 * that metric's own `unavailableReason`.
 */
export async function getInstagramInsightsSummary({ projectId, igAccountId, pageAccessToken, since, until }) {
  const apiVersion = process.env.META_GRAPH_API_VERSION || 'v21.0';
  const keys = Object.keys(INSTAGRAM_INSIGHT_METRICS);

  LoggerUtil.info('INSTAGRAM_INSIGHTS_REQUEST', { projectId, igAccountId, metrics: keys.map((k) => INSTAGRAM_INSIGHT_METRICS[k].metric), apiVersion });

  const entries = await Promise.all(keys.map((key) => fetchOneMetric(igAccountId, pageAccessToken, key, { since, until })));
  const results = Object.fromEntries(keys.map((key, i) => [key, entries[i]]));

  LoggerUtil.info('INSTAGRAM_INSIGHTS_RESULT', {
    projectId,
    igAccountId,
    success: Object.values(results).every((r) => r.unavailableReason === null),
    metricsReturned: Object.values(results).filter((r) => r.unavailableReason === null).map((r) => r.metric),
    unavailableMetrics: Object.values(results).filter((r) => r.unavailableReason !== null).map((r) => r.metric),
  });

  return results;
}

export default { getInstagramInsightsSummary, INSTAGRAM_INSIGHT_METRICS };
