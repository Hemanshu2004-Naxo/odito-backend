import mongoose from 'mongoose';

/**
 * Google Ads Campaign Snapshot Model (weekly / monthly rollups)
 *
 * Pre-aggregated rollups derived FROM GoogleAdsCampaignMetrics (never
 * fetched from Google directly) — this is what keeps weekly/monthly trend
 * reads cheap and Google-API-request-free. One row per
 * (project, customer, campaign_id-or-null, period_type, period_start):
 * campaign_id is null for the account-wide rollup (all campaigns combined,
 * used by the Campaign Trends API's weekly/monthly views) and set for a
 * single campaign's rollup.
 *
 * Upserted by period key, so recomputing a period (e.g. the current week,
 * which is still accumulating) only refreshes THAT row — every other
 * period's row is untouched, satisfying "do not overwrite previous values"
 * at the period level.
 */

const googleAdsCampaignSnapshotSchema = new mongoose.Schema({
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

  // null = account-level rollup across every campaign.
  campaign_id: {
    type: String,
    default: null
  },

  period_type: {
    type: String,
    enum: ['weekly', 'monthly'],
    required: [true, 'Period type is required']
  },

  period_start: { type: Date, required: [true, 'Period start is required'] },
  period_end: { type: Date, required: [true, 'Period end is required'] },

  impressions: { type: Number, default: 0 },
  clicks: { type: Number, default: 0 },
  cost_micros: { type: Number, default: 0 },
  cost: { type: Number, default: 0 },
  conversions: { type: Number, default: 0 },
  conversions_value: { type: Number, default: 0 },
  ctr: { type: Number, default: 0 },
  avg_cpc: { type: Number, default: 0 },
  cost_per_conversion: { type: Number, default: 0 },
  roas: { type: Number, default: 0 },

  generated_at: { type: Date, default: Date.now }

}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'google_ads_campaign_snapshots'
});

googleAdsCampaignSnapshotSchema.index(
  { project_id: 1, google_ads_customer_id: 1, campaign_id: 1, period_type: 1, period_start: 1 },
  { unique: true, name: 'unique_snapshot_period' }
);

googleAdsCampaignSnapshotSchema.index(
  { project_id: 1, google_ads_customer_id: 1, period_type: 1, period_start: -1 },
  { name: 'project_customer_period_trend' }
);

/**
 * Bulk upsert one sync run's worth of snapshot rows (typically the current +
 * previous period, so a mid-period sync keeps that period's rollup current).
 */
googleAdsCampaignSnapshotSchema.statics.bulkUpsertSnapshots = async function (rows) {
  if (!rows.length) return { inserted: 0, updated: 0 };

  const now = new Date();
  const bulkOps = rows.map((row) => ({
    updateOne: {
      filter: {
        project_id: row.projectId,
        google_ads_customer_id: row.customerId,
        campaign_id: row.campaignId ?? null,
        period_type: row.periodType,
        period_start: row.periodStart
      },
      update: {
        $set: {
          period_end: row.periodEnd,
          impressions: row.impressions,
          clicks: row.clicks,
          cost_micros: row.costMicros,
          cost: row.cost,
          conversions: row.conversions,
          conversions_value: row.conversionsValue,
          ctr: row.ctr,
          avg_cpc: row.avgCpc,
          cost_per_conversion: row.costPerConversion,
          roas: row.roas,
          generated_at: now,
          updated_at: now
        },
        $setOnInsert: { created_at: now }
      },
      upsert: true
    }
  }));

  const result = await this.bulkWrite(bulkOps, { ordered: false });
  return { inserted: result.upsertedCount || 0, updated: result.modifiedCount || 0 };
};

/**
 * Weekly or monthly trend series, most-recent `limit` periods, returned in
 * chronological order. campaignId=null returns the account-wide rollup.
 */
googleAdsCampaignSnapshotSchema.statics.getTrend = async function (projectId, customerId, periodType, { campaignId = null, limit = 12 } = {}) {
  const rows = await this.find({
    project_id: new mongoose.Types.ObjectId(projectId),
    google_ads_customer_id: customerId,
    campaign_id: campaignId,
    period_type: periodType
  })
    .sort({ period_start: -1 })
    .limit(Math.min(Math.max(Number(limit) || 12, 1), 104))
    .lean();

  return rows.reverse();
};

googleAdsCampaignSnapshotSchema.set('toJSON', { virtuals: true, transform: (doc, ret) => { delete ret.__v; return ret; } });
googleAdsCampaignSnapshotSchema.set('toObject', { virtuals: true });

const GoogleAdsCampaignSnapshot = mongoose.model('GoogleAdsCampaignSnapshot', googleAdsCampaignSnapshotSchema);
export default GoogleAdsCampaignSnapshot;
