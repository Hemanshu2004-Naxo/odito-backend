import mongoose from 'mongoose';
import BusinessProfileReview from '../modules/app_user/model/BusinessProfileReview.js';
import BusinessProfileMetadata from '../modules/app_user/model/BusinessProfileMetadata.js';
import { resolveRange, buildAnalytics, DEFAULT_RANGE, RANGE_PRESETS } from './businessProfileReviewMetrics.js';
import { sentimentLabelExpr } from './businessProfileReviewSentimentService.js';
import { getReviewTextInsights } from './businessProfileReviewTextInsightsService.js';
import { getReviewComparison } from './businessProfileReviewComparisonService.js';
import { LoggerUtil } from '../utils/LoggerUtil.js';

/**
 * Review analytics: ONE MongoDB aggregation ($facet) over the already-synced
 * reviews, then pure JS shaping (businessProfileReviewMetrics.js). No review is
 * loaded into Node and nothing is fetched from Google here.
 *
 *   lifetime : one row over every stored review of the location
 *   daily    : one row per local day inside the selected range (<= 366 rows)
 *   recent   : fixed last-7 / last-30-day sentiment counts (independent of range)
 *
 * Uses the existing project_reviews_timeline index
 * (project_id, is_deleted, review_create_time) for the range / recent matches.
 */

export { DEFAULT_RANGE, RANGE_PRESETS };

const HAS_TEXT = { $gt: [{ $strLenCP: { $trim: { input: { $ifNull: ['$comment', ''] } } } }, 0] };
const HAS_REPLY = { $gt: [{ $strLenCP: { $ifNull: ['$reply.comment', ''] } }, 0] };
const count = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });

/**
 * The ONE definition of how a group of reviews is counted (text / reply /
 * sentiment / rating buckets). Exported so the historical snapshot service
 * aggregates with the identical rules instead of re-implementing them.
 */
export function reviewMetricAccumulators() {
  const sentiment = sentimentLabelExpr();
  return {
    total: { $sum: 1 },
    ratingSum: { $sum: '$star_rating' },
    r1: count({ $eq: ['$star_rating', 1] }),
    r2: count({ $eq: ['$star_rating', 2] }),
    r3: count({ $eq: ['$star_rating', 3] }),
    r4: count({ $eq: ['$star_rating', 4] }),
    r5: count({ $eq: ['$star_rating', 5] }),
    withText: count(HAS_TEXT),
    responded: count(HAS_REPLY),
    positive: count({ $eq: [sentiment, 'positive'] }),
    neutral: count({ $eq: [sentiment, 'neutral'] }),
    negative: count({ $eq: [sentiment, 'negative'] }),
    storedSentiment: count({ $ne: [{ $ifNull: ['$sentiment_label', null] }, null] }),
  };
}

function recentAccumulators(start7) {
  const sentiment = sentimentLabelExpr();
  const in7 = { $gte: ['$review_create_time', start7] };
  return {
    tot30: { $sum: 1 },
    pos30: count({ $eq: [sentiment, 'positive'] }),
    neu30: count({ $eq: [sentiment, 'neutral'] }),
    neg30: count({ $eq: [sentiment, 'negative'] }),
    tot7: count(in7),
    pos7: count({ $and: [in7, { $eq: [sentiment, 'positive'] }] }),
    neu7: count({ $and: [in7, { $eq: [sentiment, 'neutral'] }] }),
    neg7: count({ $and: [in7, { $eq: [sentiment, 'negative'] }] }),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Raw aggregation (exported for verification against the real data).
 * @returns {{ lifetime: object|undefined, daily: Array, recent: object|undefined }}
 */
export async function aggregateReviewRows({ projectId, locationId, range, now = new Date() }) {
  const start30 = new Date(now.getTime() - 30 * DAY_MS);
  const start7 = new Date(now.getTime() - 7 * DAY_MS);

  const [result] = await BusinessProfileReview.aggregate([
    {
      $match: {
        project_id: new mongoose.Types.ObjectId(String(projectId)), // aggregate() does not auto-cast
        business_location_id: locationId,
        is_deleted: false,
      },
    },
    {
      $facet: {
        lifetime: [{ $group: { _id: null, ...reviewMetricAccumulators() } }],
        daily: [
          { $match: { review_create_time: { $gte: range.start, $lte: range.end } } },
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m-%d', date: '$review_create_time', timezone: range.timezone } },
              ...reviewMetricAccumulators(),
            },
          },
        ],
        recent: [
          { $match: { review_create_time: { $gte: start30, $lte: now } } },
          { $group: { _id: null, ...recentAccumulators(start7) } },
        ],
      },
    },
  ]);

  return { lifetime: result?.lifetime?.[0], daily: result?.daily || [], recent: result?.recent?.[0] };
}

/**
 * @param {object} p
 * @param {string} p.projectId
 * @param {string} p.locationId  the connected location (already authorised by the caller)
 * @param {string} [p.rangeKey]
 * @param {string} [p.timezone]          viewer timezone: cuts the CHARTS' days
 * @param {string} [p.snapshotTimezone]  the zone the historical snapshots are cut in (owner zone -> env default -> UTC); used ONLY by the MoM/YoY comparison so it never mixes day boundaries
 */
export async function getReviewAnalytics({ projectId, locationId, rangeKey = DEFAULT_RANGE, timezone = 'UTC', snapshotTimezone = 'UTC', now = new Date() }) {
  const range = resolveRange(rangeKey, now, timezone);
  const [rows, metadata] = await Promise.all([
    aggregateReviewRows({ projectId, locationId, range, now }),
    BusinessProfileMetadata.findOne({ project_id: projectId }).lean(),
  ]);

  // Keywords + themes (text analytics). Isolated: if they fail, the eight
  // numeric modules still load and the two text modules report `null`.
  // MoM / YoY comparison (snapshot-based, no raw review scan) is isolated the same way:
  // `comparison: null` on failure, everything else unaffected. Both run concurrently.
  const [textInsights, comparison] = await Promise.all([
    getReviewTextInsights({
      projectId, locationId, range, businessName: metadata?.business_name || null,
      version: metadata?.reviews_last_synced_at ? new Date(metadata.reviews_last_synced_at).getTime() : 0,
    }).catch((error) => {
      LoggerUtil.error('Review text insights failed (numeric analytics unaffected)', error, { projectId: String(projectId), rangeKey });
      return null;
    }),
    getReviewComparison({ projectId, locationId, rangeKey, snapshotTimezone, now }).catch((error) => {
      LoggerUtil.error('Review comparison failed (other analytics unaffected)', error, { projectId: String(projectId), rangeKey });
      return null;
    }),
  ]);

  const analytics = buildAnalytics({
    range,
    lifetime: rows.lifetime,
    daily: rows.daily,
    recent: rows.recent,
    google: {
      averageRating: metadata?.average_rating ?? null,
      totalReviewCount: metadata?.total_review_count ?? null,
      lastSyncedAt: metadata?.reviews_last_synced_at ?? null,
    },
    now,
  });

  // Additive: nothing above is changed by these keys.
  analytics.keywords = textInsights?.keywords ?? null;
  analytics.themes = textInsights?.themes ?? null;
  analytics.comparison = comparison;
  return analytics;
}

export default { getReviewAnalytics, aggregateReviewRows, DEFAULT_RANGE, RANGE_PRESETS };
