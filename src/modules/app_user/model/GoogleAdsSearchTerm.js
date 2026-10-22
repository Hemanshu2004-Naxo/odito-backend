import mongoose from 'mongoose';

/**
 * Google Ads Search Term Model
 *
 * One row per (project, customer, campaign, ad group, search term) — a
 * rolling-window performance snapshot (the metrics for whatever date range
 * the most recent search-term sync covered), refreshed in place on every
 * sync. Same "rolling snapshot, not daily grain" design as GoogleAdsKeyword,
 * for the same reason: a search-term report can return far more rows than
 * there are keywords, and nothing in this phase needs a search-term trend
 * chart — only "Date Ranges" filtering on the current snapshot, which
 * date_range_start/end below supports.
 *
 * `suggested_action` is schema-readiness for the explicitly-deferred
 * "Future Negative Keyword workflows" requirement — computed heuristically
 * at normalization time (see googleAdsSyncService.js), not yet backed by any
 * mutate/apply endpoint in this phase.
 */

const googleAdsSearchTermSchema = new mongoose.Schema({
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

  campaign_id: { type: String, required: [true, 'Campaign ID is required'], trim: true },
  campaign_name: { type: String, default: null },
  ad_group_id: { type: String, required: [true, 'Ad group ID is required'], trim: true },
  ad_group_name: { type: String, default: null },

  search_term: { type: String, required: [true, 'Search term is required'], trim: true },

  // Whether this term is already added as a keyword / excluded as a
  // negative / neither, per Google's own SearchTermTargetingStatus.
  targeting_status: {
    type: String,
    enum: ['ADDED', 'EXCLUDED', 'ADDED_EXCLUDED', 'NONE', 'UNKNOWN', 'UNSPECIFIED'],
    default: 'UNKNOWN'
  },

  // Heuristic suggestion computed at sync time: 'add' (good performer, not
  // yet a keyword) | 'negative' (spend with zero conversions) | 'watch'
  // (borderline) | null (already targeted, or no clear signal).
  suggested_action: {
    type: String,
    enum: ['add', 'negative', 'watch', null],
    default: null
  },

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
  collection: 'google_ads_search_terms'
});

googleAdsSearchTermSchema.index(
  { project_id: 1, google_ads_customer_id: 1, campaign_id: 1, ad_group_id: 1, search_term: 1 },
  { unique: true, name: 'unique_project_customer_campaign_ad_group_term' }
);

googleAdsSearchTermSchema.index({ project_id: 1, google_ads_customer_id: 1, 'metrics.cost': -1 }, { name: 'project_customer_cost_desc' });
googleAdsSearchTermSchema.index({ project_id: 1, google_ads_customer_id: 1, suggested_action: 1 }, { name: 'project_customer_suggested_action' });
googleAdsSearchTermSchema.index({ project_id: 1, search_term: 'text' }, { name: 'search_term_text_search' });
// Phase 2: supports getProjectSearchTerms' optional startDate/endDate overlap filter.
googleAdsSearchTermSchema.index({ project_id: 1, google_ads_customer_id: 1, date_range_start: 1, date_range_end: 1 }, { name: 'project_customer_date_range' });

/** Bulk upsert one sync run's worth of search term rows. */
googleAdsSearchTermSchema.statics.bulkUpsertSearchTerms = async function (rows, userId, projectId, customerId) {
  if (!rows.length) return { inserted: 0, updated: 0 };

  const now = new Date();
  const bulkOps = rows.map((row) => ({
    updateOne: {
      filter: {
        project_id: projectId,
        google_ads_customer_id: customerId,
        campaign_id: row.campaignId,
        ad_group_id: row.adGroupId,
        search_term: row.searchTerm
      },
      update: {
        $set: {
          user_id: userId,
          campaign_name: row.campaignName,
          ad_group_name: row.adGroupName,
          targeting_status: row.targetingStatus,
          suggested_action: row.suggestedAction,
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

/** Paginated, filterable, sortable search term list — reads persisted data, never calls Google. */
googleAdsSearchTermSchema.statics.getProjectSearchTerms = async function (projectId, customerId, options = {}) {
  const {
    page = 1, limit = 25, campaignId = null, suggestedAction = null,
    search = null, sortBy = 'cost', sortOrder = -1, startDate = null, endDate = null
  } = options;

  const query = { project_id: new mongoose.Types.ObjectId(projectId), google_ads_customer_id: customerId };
  if (campaignId) query.campaign_id = campaignId;
  if (suggestedAction) query.suggested_action = suggestedAction;
  if (search) query.search_term = { $regex: search, $options: 'i' };
  // Phase 2 (Enterprise Historical Sync): optional interval-overlap filter.
  // Each row is a current-state snapshot tagged with the [date_range_start,
  // date_range_end] window its metrics were captured over (NOT a per-day
  // time series like GoogleAdsCampaignMetrics) - so this answers "was this
  // row's captured window within the requested range", not "show me this
  // search term's performance for exactly this range". Only applied when
  // the caller actually supplies dates; omitted entirely otherwise, so
  // default behavior (no date params) is byte-for-byte unchanged.
  if (startDate) query.date_range_end = { $gte: startDate };
  if (endDate) query.date_range_start = { ...(query.date_range_start || {}), $lte: endDate };

  const sortableFields = ['cost', 'clicks', 'impressions', 'conversions', 'ctr'];
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

googleAdsSearchTermSchema.set('toJSON', { virtuals: true, transform: (doc, ret) => { delete ret.__v; return ret; } });
googleAdsSearchTermSchema.set('toObject', { virtuals: true });

const GoogleAdsSearchTerm = mongoose.model('GoogleAdsSearchTerm', googleAdsSearchTermSchema);
export default GoogleAdsSearchTerm;
