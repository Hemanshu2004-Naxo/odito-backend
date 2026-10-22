import mongoose from 'mongoose';

/**
 * Google Ads Optimization History Model
 *
 * One row per (project, customer, day) — account-level optimization score
 * + weight, snapshotted daily. Same daily-grain "never overwrite an older
 * day" design as GoogleAdsCampaignMetrics, just much simpler (a single
 * account-wide number per day rather than one row per campaign): a sync
 * only ever upserts TODAY's row, so historical days are untouched and
 * "Optimization Trends" reads a real day-by-day series, not a
 * recomputed-on-read approximation.
 */

const googleAdsOptimizationHistorySchema = new mongoose.Schema({
  project_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SeoProject',
    required: [true, 'Project ID is required'],
    index: true
  },

  google_ads_customer_id: {
    type: String,
    required: [true, 'Google Ads customer ID is required'],
    trim: true
  },

  // UTC midnight for the calendar day this snapshot represents.
  date: { type: Date, required: [true, 'Date is required'], index: true },

  // Google returns optimization_score as a 0.0–1.0 fraction - both the raw
  // fraction and a frontend-ready 0-100 percentage are stored so no
  // consumer has to remember to multiply by 100.
  optimization_score: { type: Number, default: null, min: 0, max: 1 },
  optimization_score_percent: { type: Number, default: null, min: 0, max: 100 },
  optimization_score_weight: { type: Number, default: null },

  fetched_at: { type: Date, default: Date.now }

}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'google_ads_optimization_history'
});

googleAdsOptimizationHistorySchema.index(
  { project_id: 1, google_ads_customer_id: 1, date: 1 },
  { unique: true, name: 'unique_project_customer_date' }
);

/** Upsert today's (or any given day's) optimization score snapshot. */
googleAdsOptimizationHistorySchema.statics.upsertScore = async function (projectId, customerId, date, score, weight) {
  const now = new Date();
  const percent = typeof score === 'number' ? Math.round(score * 1000) / 10 : null; // 2-decimal-safe rounding

  await this.updateOne(
    { project_id: projectId, google_ads_customer_id: customerId, date },
    {
      $set: {
        optimization_score: score,
        optimization_score_percent: percent,
        optimization_score_weight: weight,
        fetched_at: now,
        updated_at: now
      },
      $setOnInsert: { created_at: now }
    },
    { upsert: true }
  );
};

/** Most recent snapshot (current score for the Optimization Score widget). */
googleAdsOptimizationHistorySchema.statics.getLatest = async function (projectId, customerId) {
  return this.findOne({ project_id: new mongoose.Types.ObjectId(projectId), google_ads_customer_id: customerId })
    .sort({ date: -1 })
    .lean();
};

/** Day-by-day trend series for the Optimization Trends chart. */
googleAdsOptimizationHistorySchema.statics.getTrend = async function (projectId, customerId, startDate, endDate) {
  return this.find({
    project_id: new mongoose.Types.ObjectId(projectId),
    google_ads_customer_id: customerId,
    date: { $gte: startDate, $lte: endDate }
  }).sort({ date: 1 }).lean();
};

googleAdsOptimizationHistorySchema.set('toJSON', { virtuals: true, transform: (doc, ret) => { delete ret.__v; return ret; } });
googleAdsOptimizationHistorySchema.set('toObject', { virtuals: true });

const GoogleAdsOptimizationHistory = mongoose.model('GoogleAdsOptimizationHistory', googleAdsOptimizationHistorySchema);
export default GoogleAdsOptimizationHistory;
