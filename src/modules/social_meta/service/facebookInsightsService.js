import facebookPageDataService from './facebookPageDataService.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * FacebookInsightsService — the ONLY place a Meta Page Insights metric
 * NAME is written down. facebookOverviewService.js calls this and never
 * sees a raw metric string; facebookPageDataService.js (the layer below
 * this one) stays generic (any metric list in, raw per-metric series
 * out) and has no opinion about which metrics mean what.
 *
 * The metric map below was NOT assumed from documentation — every entry,
 * and every deprecated metric it deliberately does NOT include, was
 * confirmed live against a real connected Page (934617193060229,
 * "Nashik City Guide") on the configured META_GRAPH_API_VERSION:
 *
 *   INVALID (confirmed live, "(#100) The value must be a valid insights
 *   metric"): page_impressions, page_impressions_unique,
 *   page_impressions_paid, page_impressions_organic_unique,
 *   page_fan_adds, page_fans, page_content_activity — Meta's Page
 *   Insights deprecation wave removed every page-level organic
 *   impressions/reach metric and the old fan-count metrics; there is no
 *   surviving replacement with the same meaning, so "Page Impressions"
 *   is retired rather than silently mapped onto a differently-meaning
 *   number.
 *
 *   VALID (confirmed live, 200 OK): page_views_total — the current,
 *   supported metric for visits to the Page's own profile. This is what
 *   "Page Views" below actually measures — genuinely NOT the same thing
 *   "Page Impressions" used to measure (content reach), which is why the
 *   UI label changes too (see facebookOverviewService.js).
 *   page_daily_follows — already in use for "New Fans" before this
 *   change and reconfirmed still valid; not migrated, nothing was wrong
 *   with it.
 */
export const FACEBOOK_INSIGHT_METRICS = {
  pageViews: 'page_views_total',
  newFollowers: 'page_daily_follows',
};

/**
 * One metric, one independent Graph API call — deliberately NOT batched
 * into a single `metric=a,b` request. Confirmed live in an earlier
 * investigation: Meta rejects the ENTIRE insights call if even one
 * requested metric is invalid, which would let one future metric
 * deprecation take down every other metric with it. Isolating each call
 * means pageViews and newFollowers are independently available/
 * unavailable, exactly as required.
 */
async function fetchOneMetric(pageId, pageAccessToken, metricName, { since, until }) {
  const result = await facebookPageDataService.getPageInsights(pageId, pageAccessToken, {
    metrics: [metricName], since, until, period: 'day',
  });

  if (!result.success) {
    return { metric: metricName, value: null, series: [], unavailableReason: result.error?.code || 'FACEBOOK_INSIGHTS_UNAVAILABLE' };
  }

  const points = result.metrics[metricName] || [];
  // A successful call with an EMPTY values array is a genuine 0 (Meta
  // simply omits days with no activity from a `period=day` series,
  // confirmed live — this Page's real page_views_total/page_daily_follows
  // both come back as an empty array precisely because it had zero
  // recorded activity in the window, not because the metric failed).
  // Only a FAILED call means "unavailable" — conflating the two would be
  // exactly the "0 vs unavailable" mistake this file exists to prevent.
  const value = points.reduce((sum, v) => sum + (v.value || 0), 0);
  return { metric: metricName, value, series: points, unavailableReason: null };
}

/**
 * Fetches every mapped Facebook Insights metric for one Page,
 * independently. Never throws — a metric-level failure is captured in
 * that metric's own `unavailableReason`, never as null/0 leaking into a
 * sibling metric's result.
 */
export async function getFacebookInsights({ projectId, pageId, pageAccessToken, since, until }) {
  const apiVersion = process.env.META_GRAPH_API_VERSION || 'v21.0';
  const metricNames = Object.values(FACEBOOK_INSIGHT_METRICS);

  LoggerUtil.info('FACEBOOK_INSIGHTS_REQUEST', { projectId, pageId, metrics: metricNames, apiVersion });

  const [pageViews, newFollowers] = await Promise.all([
    fetchOneMetric(pageId, pageAccessToken, FACEBOOK_INSIGHT_METRICS.pageViews, { since, until }),
    fetchOneMetric(pageId, pageAccessToken, FACEBOOK_INSIGHT_METRICS.newFollowers, { since, until }),
  ]);

  const results = { pageViews, newFollowers };
  LoggerUtil.info('FACEBOOK_INSIGHTS_RESULT', {
    projectId,
    pageId,
    success: Object.values(results).every((r) => r.unavailableReason === null),
    metricsReturned: Object.values(results).filter((r) => r.unavailableReason === null).map((r) => r.metric),
    unavailableMetrics: Object.values(results).filter((r) => r.unavailableReason !== null).map((r) => r.metric),
  });

  return results;
}

export default { getFacebookInsights, FACEBOOK_INSIGHT_METRICS };
