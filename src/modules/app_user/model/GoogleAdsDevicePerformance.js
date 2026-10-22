import mongoose from 'mongoose';

/**
 * Google Ads Device Performance Model
 *
 * One row per (project, customer, device, day) — account-wide (not
 * per-campaign) daily grain, same "never overwrite an older day" design as
 * GoogleAdsCampaignMetrics: a sync only ever upserts TODAY's row per
 * device, so historical days stay untouched and support real trend
 * reporting rather than a recomputed-on-read approximation.
 */

const googleAdsDevicePerformanceSchema = new mongoose.Schema({
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

  device: {
    type: String,
    enum: ['MOBILE', 'TABLET', 'DESKTOP', 'CONNECTED_TV', 'OTHER', 'UNKNOWN', 'UNSPECIFIED'],
    required: [true, 'Device is required']
  },

  date: { type: Date, required: [true, 'Date is required'], index: true },

  impressions: { type: Number, default: 0 },
  clicks: { type: Number, default: 0 },
  cost_micros: { type: Number, default: 0 },
  cost: { type: Number, default: 0 },
  conversions: { type: Number, default: 0 },
  conversions_value: { type: Number, default: 0 },
  ctr: { type: Number, default: 0 },
  avg_cpc: { type: Number, default: 0 },
  roas: { type: Number, default: 0 },

  fetched_at: { type: Date, default: Date.now }

}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'google_ads_device_performance'
});

googleAdsDevicePerformanceSchema.index(
  { project_id: 1, google_ads_customer_id: 1, device: 1, date: 1 },
  { unique: true, name: 'unique_project_customer_device_date' }
);
// Phase 2: pure date-range scans (getBreakdown's $match) without device as
// a leading/intermediate key - the unique index above still works for this
// via its project_id+customer_id prefix, but a dedicated date-first index
// keeps range=all's full-history scan (3 years x every device) fast as the
// account grows, rather than relying on prefix-only index usage.
googleAdsDevicePerformanceSchema.index(
  { project_id: 1, google_ads_customer_id: 1, date: 1 },
  { name: 'project_customer_date' }
);

/** Upsert one sync run's worth of daily device rows - never touches a date outside the ones provided. */
googleAdsDevicePerformanceSchema.statics.bulkUpsertDaily = async function (rows) {
  if (!rows.length) return { inserted: 0, updated: 0 };

  const now = new Date();
  const bulkOps = rows.map((row) => ({
    updateOne: {
      filter: { project_id: row.projectId, google_ads_customer_id: row.customerId, device: row.device, date: row.date },
      update: {
        $set: {
          impressions: row.impressions, clicks: row.clicks, cost_micros: row.costMicros, cost: row.cost,
          conversions: row.conversions, conversions_value: row.conversionsValue, ctr: row.ctr,
          avg_cpc: row.avgCpc, roas: row.roas, fetched_at: now, updated_at: now
        },
        $setOnInsert: { created_at: now }
      },
      upsert: true
    }
  }));

  const result = await this.bulkWrite(bulkOps, { ordered: false });
  return { inserted: result.upsertedCount || 0, updated: result.modifiedCount || 0 };
};

/** Device breakdown (summed across the range, one row per device) for the Device Performance widget. */
googleAdsDevicePerformanceSchema.statics.getBreakdown = async function (projectId, customerId, startDate, endDate) {
  const rows = await this.aggregate([
    { $match: { project_id: new mongoose.Types.ObjectId(projectId), google_ads_customer_id: customerId, date: { $gte: startDate, $lte: endDate } } },
    {
      $group: {
        _id: '$device',
        impressions: { $sum: '$impressions' }, clicks: { $sum: '$clicks' }, cost: { $sum: '$cost' },
        conversions: { $sum: '$conversions' }, conversions_value: { $sum: '$conversions_value' }
      }
    }
  ]);

  return rows.map((r) => ({
    device: r._id,
    impressions: r.impressions,
    clicks: r.clicks,
    cost: r.cost,
    conversions: r.conversions,
    conversionsValue: r.conversions_value,
    ctr: r.impressions > 0 ? (r.clicks / r.impressions) * 100 : 0,
    avgCpc: r.clicks > 0 ? r.cost / r.clicks : 0,
    roas: r.cost > 0 ? r.conversions_value / r.cost : 0
  }));
};

/** Day-by-day series for one device (trend chart). */
googleAdsDevicePerformanceSchema.statics.getTrend = async function (projectId, customerId, device, startDate, endDate) {
  return this.find({
    project_id: new mongoose.Types.ObjectId(projectId), google_ads_customer_id: customerId, device, date: { $gte: startDate, $lte: endDate }
  }).sort({ date: 1 }).lean();
};

googleAdsDevicePerformanceSchema.set('toJSON', { virtuals: true, transform: (doc, ret) => { delete ret.__v; return ret; } });
googleAdsDevicePerformanceSchema.set('toObject', { virtuals: true });

const GoogleAdsDevicePerformance = mongoose.model('GoogleAdsDevicePerformance', googleAdsDevicePerformanceSchema);
export default GoogleAdsDevicePerformance;
