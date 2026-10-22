import mongoose from 'mongoose';

/**
 * Business Profile Review Snapshot - one row per (project, location, local day).
 *
 * WHAT A ROW IS: the review analytics headline metrics of the dataset Odito
 * KNEW at `captured_at` (stored, non-deleted reviews of the connected
 * location), counted with the SAME rules as the live analytics dashboard
 * (businessProfileReviewMetrics.summarizeRow + the shared Mongo accumulators).
 * It is a point-in-time state, NOT a regrouping of current reviews by date, so
 * it is only ever written going forward - history is never reconstructed or
 * back-filled from today's data (that would give historically wrong totals).
 *
 * DAY SEMANTICS: `snapshot_date` is a plain 'YYYY-MM-DD' calendar date (a
 * string on purpose - it carries no timezone, so it can never silently become
 * "tomorrow" in UTC). It is the local date in `timezone` at capture time;
 * `period_start` / `period_end` are the UTC instants of that local day's
 * midnight (inclusive) and the next local midnight (exclusive). Re-running the
 * same day updates the row (idempotent) - it never adds a second one.
 *
 * FUTURE USE (not implemented here): MoM / YoY / growth read these rows;
 * deleted-review detection can compare consecutive rows (total_reviews,
 * soft_deleted_reviews, google.reported_review_count).
 */

const ratingBucket = { type: Number, default: 0, min: 0 };

const businessProfileReviewSnapshotSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  project_id: { type: mongoose.Schema.Types.ObjectId, ref: 'SeoProject', required: true },
  connection_id: { type: mongoose.Schema.Types.ObjectId, ref: 'GoogleConnection', default: null },
  business_account_id: { type: String, default: null },
  business_location_id: { type: String, required: true },

  snapshot_date: {
    type: String,
    required: true,
    match: [/^\d{4}-\d{2}-\d{2}$/, 'snapshot_date must be YYYY-MM-DD']
  },
  timezone: { type: String, required: true }, // IANA zone snapshot_date was cut in
  period_start: { type: Date, required: true }, // local midnight (UTC instant), inclusive
  period_end: { type: Date, required: true },   // next local midnight (UTC instant), exclusive
  captured_at: { type: Date, required: true },        // latest capture for this day
  first_captured_at: { type: Date, required: true },  // first capture for this day

  metrics: {
    total_reviews: { type: Number, default: 0, min: 0 }, // reviews KNOWN to Odito, not Google's count
    average_rating: { type: Number, default: null, min: 1, max: 5 }, // null when there are no reviews
    rating_distribution: { one: ratingBucket, two: ratingBucket, three: ratingBucket, four: ratingBucket, five: ratingBucket },
    with_text: { type: Number, default: 0, min: 0 },
    without_text: { type: Number, default: 0, min: 0 },
    responded: { type: Number, default: 0, min: 0 },
    not_responded: { type: Number, default: 0, min: 0 },
    response_rate: { type: Number, default: 0, min: 0, max: 100 },
    sentiment: {
      positive: { type: Number, default: 0, min: 0 },
      neutral: { type: Number, default: 0, min: 0 },
      negative: { type: Number, default: 0, min: 0 }
    },
    // How many reviews carry a stored (analysed) sentiment label vs derived from stars.
    sentiment_stored_labels: { type: Number, default: 0, min: 0 },
    // Reviews Odito itself had already flagged deleted (is_deleted) at capture time.
    soft_deleted_reviews: { type: Number, default: 0, min: 0 }
  },

  // What Google reported at the last review sync (already in our data - no
  // Google call is made for a snapshot). Kept separate so the known-vs-Google
  // gap (e.g. 1,052 vs 1,053) stays visible instead of being papered over.
  google: {
    reported_review_count: { type: Number, default: null },
    reported_average_rating: { type: Number, default: null },
    reviews_last_synced_at: { type: Date, default: null }
  },

  source: { type: String, default: 'gbp_reviews' },
  metric_rules_version: { type: Number, required: true }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'business_profile_review_snapshots'
});

// Idempotency + the only lookup we need: one row per project/location/day.
// Ascending also serves "latest N snapshots" / date-range reads (an index can
// be walked in reverse), so no second index is needed for future history queries.
businessProfileReviewSnapshotSchema.index(
  { project_id: 1, business_location_id: 1, snapshot_date: 1 },
  { unique: true, name: 'unique_project_location_day' }
);

const BusinessProfileReviewSnapshot = mongoose.model('BusinessProfileReviewSnapshot', businessProfileReviewSnapshotSchema);
export default BusinessProfileReviewSnapshot;
