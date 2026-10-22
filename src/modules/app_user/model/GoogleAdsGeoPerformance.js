import mongoose from 'mongoose';

/**
 * Google Ads Geographic Performance Model
 *
 * One row per (project, customer, geo level, geo target id) — a
 * rolling-window snapshot (metrics for whatever window the most recent sync
 * covered), same design as GoogleAdsKeyword/SearchTerm: city-level rows in
 * particular can run into the hundreds for a national campaign, so a daily
 * grain here would grow unbounded for no reporting benefit this phase needs.
 *
 * `geo_target_id` is Google's opaque numeric geo-target-constant ID
 * (resolved to `name`/`country_code` via a batched geo_target_constant
 * lookup at sync time - see googleAdsService.resolveGeoTargetNames - not a
 * second Google Ads API call per row).
 */

const googleAdsGeoPerformanceSchema = new mongoose.Schema({
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

  geo_level: {
    type: String,
    enum: ['country', 'region', 'city'],
    required: [true, 'Geo level is required']
  },

  geo_target_id: { type: String, required: [true, 'Geo target ID is required'], trim: true },
  name: { type: String, default: null },          // resolved from geo_target_constant, null if lookup failed
  country_code: { type: String, default: null },

  metrics: {
    impressions: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
    cost_micros: { type: Number, default: 0 },
    cost: { type: Number, default: 0 },
    conversions: { type: Number, default: 0 },
    conversions_value: { type: Number, default: 0 },
    ctr: { type: Number, default: 0 },
    roas: { type: Number, default: 0 }
  },

  date_range_start: { type: Date, default: null },
  date_range_end: { type: Date, default: null },

  first_synced_at: { type: Date, default: Date.now },
  last_synced_at: { type: Date, default: Date.now }

}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'google_ads_geo_performance'
});

googleAdsGeoPerformanceSchema.index(
  { project_id: 1, google_ads_customer_id: 1, geo_level: 1, geo_target_id: 1 },
  { unique: true, name: 'unique_project_customer_geolevel_target' }
);

googleAdsGeoPerformanceSchema.index({ project_id: 1, google_ads_customer_id: 1, geo_level: 1, 'metrics.cost': -1 }, { name: 'project_customer_level_cost_desc' });

/** Bulk upsert one sync run's worth of geo performance rows for a single geo_level. */
googleAdsGeoPerformanceSchema.statics.bulkUpsertGeoPerformance = async function (rows, userId, projectId, customerId) {
  if (!rows.length) return { inserted: 0, updated: 0 };

  const now = new Date();
  const bulkOps = rows.map((row) => ({
    updateOne: {
      filter: { project_id: projectId, google_ads_customer_id: customerId, geo_level: row.geoLevel, geo_target_id: row.geoTargetId },
      update: {
        $set: {
          user_id: userId,
          name: row.name,
          country_code: row.countryCode,
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

/** Paginated, filterable, sortable geo performance list for one level. */
googleAdsGeoPerformanceSchema.statics.getProjectGeoPerformance = async function (projectId, customerId, geoLevel, options = {}) {
  const { page = 1, limit = 25, search = null, sortBy = 'cost', sortOrder = -1 } = options;

  const query = { project_id: new mongoose.Types.ObjectId(projectId), google_ads_customer_id: customerId, geo_level: geoLevel };
  if (search) query.name = { $regex: search, $options: 'i' };

  const sortableFields = ['cost', 'clicks', 'impressions', 'conversions', 'ctr', 'roas'];
  const sortField = sortableFields.includes(sortBy) ? `metrics.${sortBy}` : 'metrics.cost';
  const sort = { [sortField]: sortOrder === 1 ? 1 : -1 };

  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const safePage = Math.max(Number(page) || 1, 1);

  const [rows, total] = await Promise.all([
    this.find(query).sort(sort).skip((safePage - 1) * safeLimit).limit(safeLimit).lean(),
    this.countDocuments(query)
  ]);

  return { rows, total, page: safePage, limit: safeLimit, pages: Math.max(Math.ceil(total / safeLimit), 1) };
};

googleAdsGeoPerformanceSchema.set('toJSON', { virtuals: true, transform: (doc, ret) => { delete ret.__v; return ret; } });
googleAdsGeoPerformanceSchema.set('toObject', { virtuals: true });

const GoogleAdsGeoPerformance = mongoose.model('GoogleAdsGeoPerformance', googleAdsGeoPerformanceSchema);
export default GoogleAdsGeoPerformance;
