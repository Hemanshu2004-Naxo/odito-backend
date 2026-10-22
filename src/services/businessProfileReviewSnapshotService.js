import mongoose from 'mongoose';
import BusinessProfileReview from '../modules/app_user/model/BusinessProfileReview.js';
import BusinessProfileMetadata from '../modules/app_user/model/BusinessProfileMetadata.js';
import BusinessProfileReviewSnapshot from '../modules/app_user/model/BusinessProfileReviewSnapshot.js';
import {
  localDateKey, zonedMidnightUtc, addDays, isValidTimezone, summarizeRow, METRIC_RULES_VERSION,
} from './businessProfileReviewMetrics.js';
import { reviewMetricAccumulators } from './businessProfileReviewAnalyticsService.js';
import { LoggerUtil } from '../utils/LoggerUtil.js';

/**
 * Historical review snapshots (one row per project + location + local day).
 *
 * Cost per snapshot: ONE aggregation over the stored reviews (counted by the
 * exact accumulators the live dashboard uses), ONE small metadata read (Google's
 * last-synced totals, for the known-vs-Google gap), ONE upsert. No Google
 * call, no review is loaded into Node, and no GoogleConnection is ever read
 * for its tokens or written - a snapshot failure is an analytics failure, not
 * an OAuth failure.
 *
 * Idempotent: the unique (project, location, day) index + upsert means running
 * twice, late, concurrently or after a restart yields exactly one row for the day.
 */

const SERVICE = 'BusinessProfileReviewSnapshot';
export const SNAPSHOT_SOURCE = 'gbp_reviews';

/**
 * Timezone the snapshot day is cut in: the project owner's saved timezone,
 * else REVIEW_SNAPSHOT_DEFAULT_TIMEZONE, else UTC. (There is no per-project or
 * per-location timezone in Odito today.) The zone used is stored on the row.
 */
export function resolveSnapshotTimezone(userTimezone, fallback = process.env.REVIEW_SNAPSHOT_DEFAULT_TIMEZONE) {
  if (isValidTimezone(userTimezone)) return userTimezone;
  if (isValidTimezone(fallback)) return fallback;
  return 'UTC';
}

/** Local calendar day containing `now` in `timezone`, plus its UTC boundaries. */
export function snapshotWindow(now, timezone) {
  const snapshotDate = localDateKey(now, timezone);
  return {
    snapshotDate,
    timezone,
    periodStart: zonedMidnightUtc(snapshotDate, timezone),
    periodEnd: zonedMidnightUtc(addDays(snapshotDate, 1), timezone),
  };
}

/**
 * The single aggregation: current (non-deleted) reviews of this project +
 * location counted with the shared accumulators, and Odito's own soft-deleted
 * count, in one pass over the project's reviews.
 * @returns {Promise<{ current: object|undefined, softDeleted: number }>}
 */
export async function aggregateSnapshotRows({ projectId, locationId }) {
  const [result] = await BusinessProfileReview.aggregate([
    {
      $match: {
        project_id: new mongoose.Types.ObjectId(String(projectId)), // aggregate() does not auto-cast
        business_location_id: locationId,
      },
    },
    {
      $facet: {
        current: [
          { $match: { is_deleted: false } },
          { $group: { _id: null, ...reviewMetricAccumulators() } },
        ],
        softDeleted: [
          { $match: { is_deleted: true } },
          { $count: 'n' },
        ],
      },
    },
  ]);

  return { current: result?.current?.[0], softDeleted: result?.softDeleted?.[0]?.n || 0 };
}

/** Pure: shape aggregation output into the stored document fields. */
export function buildSnapshotFields({ rows, metadata, window, now }) {
  const m = summarizeRow(rows.current);
  return {
    timezone: window.timezone,
    period_start: window.periodStart,
    period_end: window.periodEnd,
    captured_at: now,
    metrics: {
      total_reviews: m.totalReviews,
      average_rating: m.averageRating,
      rating_distribution: m.ratingDistribution,
      with_text: m.withText,
      without_text: m.withoutText,
      responded: m.responded,
      not_responded: m.notResponded,
      response_rate: m.responseRate,
      sentiment: m.sentiment,
      sentiment_stored_labels: m.storedSentimentLabels,
      soft_deleted_reviews: rows.softDeleted,
    },
    google: {
      reported_review_count: metadata?.total_review_count ?? null,
      reported_average_rating: metadata?.average_rating ?? null,
      reviews_last_synced_at: metadata?.reviews_last_synced_at ?? null,
    },
    source: SNAPSHOT_SOURCE,
    metric_rules_version: METRIC_RULES_VERSION,
  };
}

const isDuplicateKey = (e) => e?.code === 11000;

/**
 * Capture (create or refresh) today's snapshot for ONE project + location.
 * The caller is responsible for authorising projectId/locationId (the manual
 * endpoint validates the stored connection; the scheduler reads them from it).
 *
 * @param {object} p
 * @param {string} p.projectId
 * @param {string} p.locationId
 * @param {string} p.userId       project owner
 * @param {string} [p.connectionId]
 * @param {string} [p.accountId]
 * @param {string} [p.timezone]   IANA; resolved via resolveSnapshotTimezone() by callers
 * @param {Date}   [p.now]
 * @returns {Promise<{ snapshot: object, created: boolean }>}
 */
export async function captureReviewSnapshot({ projectId, locationId, userId, connectionId = null, accountId = null, timezone = 'UTC', now = new Date() }) {
  const startedAt = Date.now();
  const window = snapshotWindow(now, timezone);

  try {
    // Aggregate FIRST: if it fails nothing has been written (no partial row).
    const [rows, metadata] = await Promise.all([
      aggregateSnapshotRows({ projectId, locationId }),
      BusinessProfileMetadata.findOne({ project_id: projectId })
        .select('total_review_count average_rating reviews_last_synced_at').lean(),
    ]);
    const fields = buildSnapshotFields({ rows, metadata, window, now });

    const filter = { project_id: projectId, business_location_id: locationId, snapshot_date: window.snapshotDate };
    const update = {
      $set: { ...fields, user_id: userId, connection_id: connectionId, business_account_id: accountId },
      $setOnInsert: { first_captured_at: now },
    };
    const options = { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true };

    let snapshot;
    try {
      snapshot = await BusinessProfileReviewSnapshot.findOneAndUpdate(filter, update, options).lean();
    } catch (error) {
      // Two writers raced on the unique key: the row now exists, so this retry is a plain update.
      if (!isDuplicateKey(error)) throw error;
      snapshot = await BusinessProfileReviewSnapshot.findOneAndUpdate(filter, update, options).lean();
    }

    const created = +snapshot.first_captured_at === +now;
    LoggerUtil.service(SERVICE, 'capture', created ? 'created' : 'updated', {
      projectId: String(projectId), locationId, snapshotDate: window.snapshotDate, timezone,
      totalReviews: fields.metrics.total_reviews, durationMs: Date.now() - startedAt,
    });
    return { snapshot, created };

  } catch (error) {
    LoggerUtil.error(`${SERVICE}: capture failed`, error, {
      projectId: String(projectId), locationId, snapshotDate: window.snapshotDate,
    });
    throw error;
  }
}

export default { captureReviewSnapshot, aggregateSnapshotRows, buildSnapshotFields, snapshotWindow, resolveSnapshotTimezone, SNAPSHOT_SOURCE };
