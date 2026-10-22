import mongoose from 'mongoose';

/**
 * Google Ads Conversion Action Model
 *
 * One row per (project, customer, conversion action) — the backing model
 * for Attribution reporting. Honest scope note (see googleAdsService.js's
 * doc comment on getGoogleAdsConversionActionsForSync): the standard Google
 * Ads API does NOT expose multi-touch "conversion path" or "assist
 * conversion" data via any GAQL-queryable resource - there is no such
 * resource in this codebase's own field registry, confirmed by inspection
 * before writing this model. What IS real and synced here: each
 * conversion action's configured attribution model
 * (conversion_action.attribution_model_settings), and click-attributed vs
 * view-through conversion counts (metrics.conversions vs
 * metrics.view_through_conversions) - which together answer "Attribution
 * Model" and "Click Attribution / View Attribution", and (ranked by
 * conversions) "Top Conversion Sources". `assist_conversions` and
 * `conversion_paths` are schema-present but always null - see the
 * Production Hardening section of the Phase 6.5 report for why this isn't
 * silently fabricated.
 */

const googleAdsConversionActionSchema = new mongoose.Schema({
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

  conversion_action_id: { type: String, required: [true, 'Conversion action ID is required'], trim: true },
  name: { type: String, required: [true, 'Conversion action name is required'] },
  category: { type: String, default: 'UNKNOWN' },
  status: { type: String, default: 'UNKNOWN' },

  attribution_model: { type: String, default: 'UNKNOWN' },        // e.g. GOOGLE_ADS_LAST_CLICK, GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN
  data_driven_model_status: { type: String, default: null },       // AVAILABLE | STALE | EXPIRED | NEVER_GENERATED, null if not data-driven

  metrics: {
    conversions: { type: Number, default: 0 },              // click-attributed
    conversions_value: { type: Number, default: 0 },
    view_through_conversions: { type: Number, default: 0 }, // view-attributed (no click)
    all_conversions: { type: Number, default: 0 }
  },

  // Schema-ready, always null in this phase - see file-level doc comment.
  assist_conversions: { type: Number, default: null },
  conversion_paths_available: { type: Boolean, default: false },

  date_range_start: { type: Date, default: null },
  date_range_end: { type: Date, default: null },

  is_removed: { type: Boolean, default: false, index: true },
  removed_at: { type: Date, default: null },

  first_synced_at: { type: Date, default: Date.now },
  last_synced_at: { type: Date, default: Date.now }

}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'google_ads_conversion_actions'
});

googleAdsConversionActionSchema.index(
  { project_id: 1, google_ads_customer_id: 1, conversion_action_id: 1 },
  { unique: true, name: 'unique_project_customer_conversion_action' }
);

/** Bulk upsert one sync run's worth of conversion action rows. */
googleAdsConversionActionSchema.statics.bulkUpsertConversionActions = async function (rows, userId, projectId, customerId) {
  if (!rows.length) return { inserted: 0, updated: 0 };

  const now = new Date();
  const bulkOps = rows.map((row) => ({
    updateOne: {
      filter: { project_id: projectId, google_ads_customer_id: customerId, conversion_action_id: row.conversionActionId },
      update: {
        $set: {
          user_id: userId,
          name: row.name,
          category: row.category,
          status: row.status,
          attribution_model: row.attributionModel,
          data_driven_model_status: row.dataDrivenModelStatus,
          metrics: row.metrics,
          date_range_start: row.dateRangeStart,
          date_range_end: row.dateRangeEnd,
          is_removed: false,
          removed_at: null,
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

googleAdsConversionActionSchema.statics.markMissingAsRemoved = async function (projectId, customerId, seenIds) {
  const result = await this.updateMany(
    { project_id: projectId, google_ads_customer_id: customerId, conversion_action_id: { $nin: seenIds }, is_removed: false },
    { $set: { is_removed: true, removed_at: new Date() } }
  );
  return result.modifiedCount || 0;
};

/** Every active conversion action, ranked by conversions desc - "Top Conversion Sources". */
googleAdsConversionActionSchema.statics.getTopSources = async function (projectId, customerId, limit = 10) {
  return this.find({ project_id: new mongoose.Types.ObjectId(projectId), google_ads_customer_id: customerId, is_removed: false })
    .sort({ 'metrics.conversions': -1 })
    .limit(Math.min(Math.max(Number(limit) || 10, 1), 50))
    .lean();
};

/** Account-wide click vs view-through conversion totals - "Click Attribution / View Attribution". */
googleAdsConversionActionSchema.statics.getAttributionSplit = async function (projectId, customerId) {
  const result = await this.aggregate([
    { $match: { project_id: new mongoose.Types.ObjectId(projectId), google_ads_customer_id: customerId, is_removed: false } },
    {
      $group: {
        _id: null,
        clickConversions: { $sum: '$metrics.conversions' },
        viewThroughConversions: { $sum: '$metrics.view_through_conversions' },
        totalConversionsValue: { $sum: '$metrics.conversions_value' }
      }
    }
  ]);

  const totals = result[0] || { clickConversions: 0, viewThroughConversions: 0, totalConversionsValue: 0 };
  const total = totals.clickConversions + totals.viewThroughConversions;

  return {
    clickConversions: totals.clickConversions,
    viewThroughConversions: totals.viewThroughConversions,
    totalConversionsValue: totals.totalConversionsValue,
    clickAttributionPct: total > 0 ? Math.round((totals.clickConversions / total) * 1000) / 10 : 0,
    viewAttributionPct: total > 0 ? Math.round((totals.viewThroughConversions / total) * 1000) / 10 : 0
  };
};

googleAdsConversionActionSchema.set('toJSON', { virtuals: true, transform: (doc, ret) => { delete ret.__v; return ret; } });
googleAdsConversionActionSchema.set('toObject', { virtuals: true });

const GoogleAdsConversionAction = mongoose.model('GoogleAdsConversionAction', googleAdsConversionActionSchema);
export default GoogleAdsConversionAction;
