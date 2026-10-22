import mongoose from 'mongoose';

/**
 * Google Ads Audience Performance Model
 *
 * One row per (project, customer, dimension_type, dimension_value) — a
 * rolling-window snapshot, same design as GoogleAdsGeoPerformance. A single
 * unified model with a `dimension_type` discriminator rather than 6 near-
 * identical models (age/gender/household_income/affinity/in_market/
 * audience_segment) - they share the exact same shape (a labeled bucket +
 * metrics for a window) and only differ in what `dimension_value` means,
 * which `label` already makes human-readable regardless of type.
 */

const googleAdsAudiencePerformanceSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'User ID is required'],
    index: true
  },

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

  dimension_type: {
    type: String,
    enum: ['age', 'gender', 'household_income', 'affinity', 'in_market', 'audience_segment'],
    required: [true, 'Dimension type is required']
  },

  // Stable key within (customer, dimension_type) - the enum name for
  // age/gender/household_income (e.g. "AGE_RANGE_25_34"), or the criterion
  // resource name for affinity/in_market/audience_segment.
  dimension_value: { type: String, required: [true, 'Dimension value is required'], trim: true },

  // Human-readable label - the decoded enum name for demographic
  // dimensions, or a best-effort resolved category name for
  // affinity/in_market/audience_segment (see googleAdsService.js's
  // resolveAudienceCategoryNames; falls back to dimension_value itself if
  // resolution isn't available).
  label: { type: String, required: [true, 'Label is required'] },

  metrics: {
    impressions: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
    cost_micros: { type: Number, default: 0 },
    cost: { type: Number, default: 0 },
    conversions: { type: Number, default: 0 },
    conversions_value: { type: Number, default: 0 },
    ctr: { type: Number, default: 0 }
  },

  date_range_start: { type: Date, default: null },
  date_range_end: { type: Date, default: null },

  first_synced_at: { type: Date, default: Date.now },
  last_synced_at: { type: Date, default: Date.now }

}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'google_ads_audience_performance'
});

googleAdsAudiencePerformanceSchema.index(
  { project_id: 1, google_ads_customer_id: 1, dimension_type: 1, dimension_value: 1 },
  { unique: true, name: 'unique_project_customer_dimension' }
);

/** Bulk upsert one sync run's worth of rows for a single dimension_type. */
googleAdsAudiencePerformanceSchema.statics.bulkUpsertAudiencePerformance = async function (rows, userId, projectId, customerId) {
  if (!rows.length) return { inserted: 0, updated: 0 };

  const now = new Date();
  const bulkOps = rows.map((row) => ({
    updateOne: {
      filter: { project_id: projectId, google_ads_customer_id: customerId, dimension_type: row.dimensionType, dimension_value: row.dimensionValue },
      update: {
        $set: {
          user_id: userId,
          label: row.label,
          metrics: row.metrics,
          date_range_start: row.dateRangeStart,
          date_range_end: row.dateRangeEnd,
          last_synced_at: now,
          updated_at: now
        },
        $setOnInsert: { first_synced_at: now, created_at: now }
      },
      upsert: true
    }
  }));

  const result = await this.bulkWrite(bulkOps, { ordered: false });
  return { inserted: result.upsertedCount || 0, updated: result.modifiedCount || 0 };
};

/** Every row for one dimension type, sorted by cost desc (used by the Audience Performance widget, which shows all buckets at once - no pagination needed for a bounded set like age/gender). */
googleAdsAudiencePerformanceSchema.statics.getByDimensionType = async function (projectId, customerId, dimensionType) {
  return this.find({ project_id: new mongoose.Types.ObjectId(projectId), google_ads_customer_id: customerId, dimension_type: dimensionType })
    .sort({ 'metrics.cost': -1 })
    .lean();
};

googleAdsAudiencePerformanceSchema.set('toJSON', { virtuals: true, transform: (doc, ret) => { delete ret.__v; return ret; } });
googleAdsAudiencePerformanceSchema.set('toObject', { virtuals: true });

const GoogleAdsAudiencePerformance = mongoose.model('GoogleAdsAudiencePerformance', googleAdsAudiencePerformanceSchema);
export default GoogleAdsAudiencePerformance;
