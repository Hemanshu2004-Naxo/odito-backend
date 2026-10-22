import mongoose from 'mongoose';

/**
 * Google Ads Campaign Metrics Model (daily grain)
 *
 * One row per (project, campaign, calendar day) — this collection IS the
 * "Daily" historical snapshot: rows are only ever upserted for the specific
 * date they represent, and a sync run never touches a date outside the
 * window it was asked to (re)fetch, so older days are never overwritten.
 * Weekly/monthly rollups (GoogleAdsCampaignSnapshot) are derived FROM this
 * collection rather than fetched from Google a second time.
 *
 * Design Principles (mirrors BusinessProfileData.js):
 * - Normalized values only (money converted from micros, rates computed
 *   from raw counts) — no raw Google Ads API objects stored.
 * - Duplicate prevention through a unique (project, campaign, date) index.
 * - Rate metrics (ctr/avg_cpc/cost_per_conversion/roas) are stored
 *   pre-computed per row for fast reads, but account-level aggregation
 *   ALWAYS re-derives rates from summed raw counts (see getAccountAggregate
 *   below) rather than averaging per-day rates, which would be
 *   mathematically wrong (average-of-ratios != ratio-of-sums).
 */

const googleAdsCampaignMetricsSchema = new mongoose.Schema({
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

  campaign_id: {
    type: String,
    required: [true, 'Campaign ID is required'],
    trim: true
  },

  // UTC midnight for the calendar day this row represents (matches GAQL's
  // segments.date, which is always the account's own timezone date, stored
  // here as a Date at 00:00:00 UTC for that calendar day).
  date: {
    type: Date,
    required: [true, 'Date is required'],
    index: true
  },

  impressions: { type: Number, default: 0, min: 0 },
  clicks: { type: Number, default: 0, min: 0 },
  cost_micros: { type: Number, default: 0, min: 0 },
  cost: { type: Number, default: 0, min: 0 },                       // cost_micros / 1_000_000
  conversions: { type: Number, default: 0, min: 0 },
  conversions_value: { type: Number, default: 0, min: 0 },

  // Pre-computed per-row rates (percentage/currency, not micros) — derived
  // at normalization time, never recomputed from stale data on read.
  ctr: { type: Number, default: 0 },                 // percent: clicks/impressions*100
  avg_cpc: { type: Number, default: 0 },              // cost/clicks
  cost_per_conversion: { type: Number, default: 0 },  // cost/conversions
  roas: { type: Number, default: 0 },                 // conversions_value/cost

  fetched_at: { type: Date, default: Date.now }

}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'google_ads_campaign_metrics'
});

// Prevent duplicate daily rows for the same campaign+date.
googleAdsCampaignMetricsSchema.index(
  { project_id: 1, campaign_id: 1, date: 1 },
  { unique: true, name: 'unique_project_campaign_date' }
);

// Account-wide (all campaigns) date-range aggregation / trend queries.
googleAdsCampaignMetricsSchema.index(
  { project_id: 1, google_ads_customer_id: 1, date: -1 },
  { name: 'project_customer_date' }
);

// Single-campaign trend queries.
googleAdsCampaignMetricsSchema.index(
  { project_id: 1, campaign_id: 1, date: -1 },
  { name: 'project_campaign_date' }
);

/**
 * Bulk upsert one sync run's worth of daily metric rows. Never touches any
 * date outside the rows provided — the caller (googleAdsSyncService) decides
 * the refetch window (full backfill vs. trailing reconciliation window).
 * @returns {Promise<{inserted:number, updated:number}>}
 */
googleAdsCampaignMetricsSchema.statics.bulkUpsertDailyMetrics = async function (rows) {
  if (!rows.length) return { inserted: 0, updated: 0 };

  const now = new Date();
  const bulkOps = rows.map((row) => ({
    updateOne: {
      filter: { project_id: row.projectId, campaign_id: row.campaignId, date: row.date },
      update: {
        $set: {
          google_ads_customer_id: row.customerId,
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
          fetched_at: now,
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

/** Daily series for a single campaign (trend chart / campaign detail page). */
googleAdsCampaignMetricsSchema.statics.getCampaignSeries = async function (projectId, campaignId, startDate, endDate) {
  return this.find({
    project_id: new mongoose.Types.ObjectId(projectId),
    campaign_id: campaignId,
    date: { $gte: startDate, $lte: endDate }
  }).sort({ date: 1 }).lean();
};

/**
 * Single-campaign totals for a date range — same sum-then-derive-rates
 * approach as getAccountAggregate, scoped to one campaign_id. Backs the
 * Campaign Details endpoint's metrics summary.
 */
googleAdsCampaignMetricsSchema.statics.getCampaignAggregate = async function (projectId, campaignId, startDate, endDate) {
  const result = await this.aggregate([
    {
      $match: {
        project_id: new mongoose.Types.ObjectId(projectId),
        campaign_id: campaignId,
        date: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: null,
        impressions: { $sum: '$impressions' },
        clicks: { $sum: '$clicks' },
        cost_micros: { $sum: '$cost_micros' },
        cost: { $sum: '$cost' },
        conversions: { $sum: '$conversions' },
        conversions_value: { $sum: '$conversions_value' }
      }
    }
  ]);

  const totals = result[0] || { impressions: 0, clicks: 0, cost_micros: 0, cost: 0, conversions: 0, conversions_value: 0 };

  return {
    impressions: totals.impressions,
    clicks: totals.clicks,
    costMicros: totals.cost_micros,
    cost: totals.cost,
    conversions: totals.conversions,
    conversionsValue: totals.conversions_value,
    ctr: totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0,
    avgCpc: totals.clicks > 0 ? totals.cost / totals.clicks : 0,
    conversionRate: totals.clicks > 0 ? (totals.conversions / totals.clicks) * 100 : 0,
    costPerConversion: totals.conversions > 0 ? totals.cost / totals.conversions : 0,
    roas: totals.cost > 0 ? totals.conversions_value / totals.cost : 0
  };
};

/**
 * Bulk version of getCampaignAggregate for the Campaign List endpoint (Gap
 * #2, frontend integration audit): ONE aggregation grouping by campaign_id
 * across every requested campaign, instead of N calls to
 * getCampaignAggregate (one per row) - this is the difference between a
 * single query and an N+1 query pattern for a paginated list.
 * @returns {Promise<Map<string, object>>} campaign_id -> the same shape getCampaignAggregate returns
 */
googleAdsCampaignMetricsSchema.statics.getBulkCampaignAggregates = async function (projectId, campaignIds, startDate, endDate) {
  const map = new Map();
  if (!campaignIds.length) return map;

  const rows = await this.aggregate([
    {
      $match: {
        project_id: new mongoose.Types.ObjectId(projectId),
        campaign_id: { $in: campaignIds },
        date: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: '$campaign_id',
        impressions: { $sum: '$impressions' },
        clicks: { $sum: '$clicks' },
        cost_micros: { $sum: '$cost_micros' },
        cost: { $sum: '$cost' },
        conversions: { $sum: '$conversions' },
        conversions_value: { $sum: '$conversions_value' }
      }
    }
  ]);

  for (const row of rows) {
    map.set(row._id, {
      impressions: row.impressions,
      clicks: row.clicks,
      costMicros: row.cost_micros,
      cost: row.cost,
      conversions: row.conversions,
      conversionsValue: row.conversions_value,
      ctr: row.impressions > 0 ? (row.clicks / row.impressions) * 100 : 0,
      avgCpc: row.clicks > 0 ? row.cost / row.clicks : 0,
      conversionRate: row.clicks > 0 ? (row.conversions / row.clicks) * 100 : 0,
      costPerConversion: row.conversions > 0 ? row.cost / row.conversions : 0,
      roas: row.cost > 0 ? row.conversions_value / row.cost : 0
    });
  }

  return map;
};

/**
 * Earliest date we have ANY metrics row for this project/customer - backs
 * `range=all` (Phase 2: Enterprise Historical Sync). A plain findOne+sort
 * against the existing { project_id, google_ads_customer_id, date } index
 * (see the index block above) - O(1) index seek, not a collection scan or
 * aggregation. Returns null if nothing has ever synced.
 */
googleAdsCampaignMetricsSchema.statics.getEarliestDate = async function (projectId, customerId) {
  const row = await this.findOne(
    { project_id: new mongoose.Types.ObjectId(projectId), google_ads_customer_id: customerId }
  ).sort({ date: 1 }).select('date').lean();
  return row?.date || null;
};

/**
 * Account-level (all campaigns) totals for a date range — the source of the
 * KPI Dashboard overview. Sums raw counts first, THEN derives rates from
 * the sums (correct), rather than averaging each row's already-computed
 * rate (incorrect for ratio metrics).
 */
googleAdsCampaignMetricsSchema.statics.getAccountAggregate = async function (projectId, customerId, startDate, endDate) {
  const result = await this.aggregate([
    {
      $match: {
        project_id: new mongoose.Types.ObjectId(projectId),
        google_ads_customer_id: customerId,
        date: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: null,
        impressions: { $sum: '$impressions' },
        clicks: { $sum: '$clicks' },
        cost_micros: { $sum: '$cost_micros' },
        cost: { $sum: '$cost' },
        conversions: { $sum: '$conversions' },
        conversions_value: { $sum: '$conversions_value' },
        campaignIds: { $addToSet: '$campaign_id' }
      }
    }
  ]);

  const totals = result[0] || {
    impressions: 0, clicks: 0, cost_micros: 0, cost: 0, conversions: 0, conversions_value: 0, campaignIds: []
  };

  return {
    impressions: totals.impressions,
    clicks: totals.clicks,
    costMicros: totals.cost_micros,
    cost: totals.cost,
    conversions: totals.conversions,
    conversionsValue: totals.conversions_value,
    campaignCount: totals.campaignIds.length,
    ctr: totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0,
    avgCpc: totals.clicks > 0 ? totals.cost / totals.clicks : 0,
    conversionRate: totals.clicks > 0 ? (totals.conversions / totals.clicks) * 100 : 0,
    costPerConversion: totals.conversions > 0 ? totals.cost / totals.conversions : 0,
    roas: totals.cost > 0 ? totals.conversions_value / totals.cost : 0
  };
};

/**
 * Account-wide daily trend series (all campaigns summed per day) — backs
 * the Campaign Trends API. Same sum-then-derive-rates approach as
 * getAccountAggregate, applied per day instead of over the whole range.
 */
googleAdsCampaignMetricsSchema.statics.getAccountDailySeries = async function (projectId, customerId, startDate, endDate) {
  const rows = await this.aggregate([
    {
      $match: {
        project_id: new mongoose.Types.ObjectId(projectId),
        google_ads_customer_id: customerId,
        date: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: '$date',
        impressions: { $sum: '$impressions' },
        clicks: { $sum: '$clicks' },
        cost: { $sum: '$cost' },
        conversions: { $sum: '$conversions' },
        conversions_value: { $sum: '$conversions_value' }
      }
    },
    { $sort: { _id: 1 } }
  ]);

  return rows.map((row) => ({
    date: row._id,
    impressions: row.impressions,
    clicks: row.clicks,
    cost: row.cost,
    conversions: row.conversions,
    conversionsValue: row.conversions_value,
    ctr: row.impressions > 0 ? (row.clicks / row.impressions) * 100 : 0,
    avgCpc: row.clicks > 0 ? row.cost / row.clicks : 0,
    roas: row.cost > 0 ? row.conversions_value / row.cost : 0
  }));
};

googleAdsCampaignMetricsSchema.set('toJSON', { virtuals: true, transform: (doc, ret) => { delete ret.__v; return ret; } });
googleAdsCampaignMetricsSchema.set('toObject', { virtuals: true });

const GoogleAdsCampaignMetrics = mongoose.model('GoogleAdsCampaignMetrics', googleAdsCampaignMetricsSchema);
export default GoogleAdsCampaignMetrics;
