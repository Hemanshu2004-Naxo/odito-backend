import mongoose from 'mongoose';

/**
 * Google Ads Keyword Model
 *
 * One row per (project, customer, ad group, criterion) — current metadata
 * (text, match type, quality score, status) PLUS a rolling-window
 * performance snapshot (the metrics for whatever date range the most recent
 * keyword sync covered), refreshed in place on every sync. Deliberately
 * does NOT keep a separate daily-grain history collection the way
 * GoogleAdsCampaignMetrics does for campaigns — keyword sets can run into
 * the thousands per account, and nothing in this phase's scope needs a
 * keyword-level trend chart yet. The schema is additive-safe for that
 * later (a GoogleAdsKeywordMetrics collection could be introduced the same
 * way GoogleAdsCampaignMetrics was, without touching this model).
 *
 * Design Principles (mirrors GoogleAdsCampaign.js / BusinessProfileData.js):
 * - Normalized values only — no raw Google Ads API objects stored.
 * - Duplicate prevention through a unique compound index.
 * - Soft-removal (is_removed) rather than deletion, consistent with
 *   GoogleAdsCampaign's own campaign soft-removal.
 */

const googleAdsKeywordSchema = new mongoose.Schema({
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

  // Google's ad_group_criterion identity is the (ad_group_id, criterion_id)
  // PAIR, not criterion_id alone — stored as two separate string fields so
  // the compound unique index below reflects Google's real identity model.
  ad_group_id: { type: String, required: [true, 'Ad group ID is required'], trim: true },
  ad_group_name: { type: String, default: null },
  criterion_id: { type: String, required: [true, 'Criterion ID is required'], trim: true },

  campaign_id: { type: String, required: [true, 'Campaign ID is required'], trim: true },
  campaign_name: { type: String, default: null }, // denormalized for list/filter display without a lookup

  keyword_text: { type: String, required: [true, 'Keyword text is required'], trim: true },
  match_type: {
    type: String,
    enum: ['EXACT', 'PHRASE', 'BROAD', 'UNKNOWN', 'UNSPECIFIED'],
    default: 'UNKNOWN'
  },
  status: {
    type: String,
    enum: ['ENABLED', 'PAUSED', 'REMOVED', 'UNKNOWN', 'UNSPECIFIED'],
    default: 'UNKNOWN'
  },

  // 1–10, null when Google hasn't computed one yet (new keyword, low volume).
  quality_score: { type: Number, default: null, min: 1, max: 10 },

  // Rolling-window performance snapshot — same normalized shape as
  // GoogleAdsCampaignMetrics' per-row fields, summed over date_range below.
  metrics: {
    impressions: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
    cost_micros: { type: Number, default: 0 },
    cost: { type: Number, default: 0 },
    conversions: { type: Number, default: 0 },
    conversions_value: { type: Number, default: 0 },
    ctr: { type: Number, default: 0 },
    avg_cpc: { type: Number, default: 0 },
    cost_per_conversion: { type: Number, default: 0 }
  },

  date_range_start: { type: Date, default: null },
  date_range_end: { type: Date, default: null },

  is_removed: { type: Boolean, default: false, index: true },
  removed_at: { type: Date, default: null },

  first_synced_at: { type: Date, default: Date.now },
  last_synced_at: { type: Date, default: Date.now }

}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'google_ads_keywords'
});

googleAdsKeywordSchema.index(
  { project_id: 1, google_ads_customer_id: 1, ad_group_id: 1, criterion_id: 1 },
  { unique: true, name: 'unique_project_customer_ad_group_criterion' }
);

googleAdsKeywordSchema.index({ project_id: 1, google_ads_customer_id: 1, campaign_id: 1 }, { name: 'project_customer_campaign' });
googleAdsKeywordSchema.index({ project_id: 1, google_ads_customer_id: 1, is_removed: 1 }, { name: 'project_customer_removed' });
googleAdsKeywordSchema.index({ project_id: 1, google_ads_customer_id: 1, 'metrics.cost': -1 }, { name: 'project_customer_cost_desc' });
googleAdsKeywordSchema.index({ project_id: 1, keyword_text: 'text' }, { name: 'keyword_text_search' });
// Phase 2: supports getProjectKeywords' optional startDate/endDate overlap filter.
googleAdsKeywordSchema.index({ project_id: 1, google_ads_customer_id: 1, date_range_start: 1, date_range_end: 1 }, { name: 'project_customer_date_range' });

/** Bulk upsert one sync run's worth of keyword rows. */
googleAdsKeywordSchema.statics.bulkUpsertKeywords = async function (rows, userId, projectId, customerId) {
  if (!rows.length) return { inserted: 0, updated: 0 };

  const now = new Date();
  const bulkOps = rows.map((row) => ({
    updateOne: {
      filter: { project_id: projectId, google_ads_customer_id: customerId, ad_group_id: row.adGroupId, criterion_id: row.criterionId },
      update: {
        $set: {
          user_id: userId,
          ad_group_name: row.adGroupName,
          campaign_id: row.campaignId,
          campaign_name: row.campaignName,
          keyword_text: row.keywordText,
          match_type: row.matchType,
          status: row.status,
          quality_score: row.qualityScore,
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

/** Soft-marks keywords absent from the latest sync as removed (mirrors GoogleAdsCampaign.markMissingAsRemoved). */
googleAdsKeywordSchema.statics.markMissingAsRemoved = async function (projectId, customerId, seenPairs) {
  // seenPairs: array of "adGroupId:criterionId" strings, matched via $expr
  // since Mongo has no native "pair not in list of pairs" operator.
  const seenSet = new Set(seenPairs);
  const candidates = await this.find(
    { project_id: projectId, google_ads_customer_id: customerId, is_removed: false },
    { ad_group_id: 1, criterion_id: 1 }
  ).lean();

  const idsToRemove = candidates
    .filter((c) => !seenSet.has(`${c.ad_group_id}:${c.criterion_id}`))
    .map((c) => c._id);

  if (!idsToRemove.length) return 0;

  const result = await this.updateMany(
    { _id: { $in: idsToRemove } },
    { $set: { is_removed: true, removed_at: new Date() } }
  );
  return result.modifiedCount || 0;
};

/** Paginated, filterable, sortable keyword list — reads persisted data, never calls Google. */
googleAdsKeywordSchema.statics.getProjectKeywords = async function (projectId, customerId, options = {}) {
  const {
    page = 1, limit = 25, campaignId = null, matchType = null, status = null,
    search = null, includeRemoved = false, sortBy = 'cost', sortOrder = -1,
    startDate = null, endDate = null
  } = options;

  const query = { project_id: new mongoose.Types.ObjectId(projectId), google_ads_customer_id: customerId };
  if (!includeRemoved) query.is_removed = false;
  if (campaignId) query.campaign_id = campaignId;
  if (matchType) query.match_type = matchType;
  if (status) query.status = status;
  if (search) query.keyword_text = { $regex: search, $options: 'i' };
  // Phase 2 (Enterprise Historical Sync): same optional interval-overlap
  // filter as GoogleAdsSearchTerm.getProjectSearchTerms - see that
  // function's doc comment for why this is "captured within range", not a
  // true per-day historical drill-down. Omitted entirely when no dates are
  // supplied - default behavior unchanged.
  if (startDate) query.date_range_end = { $gte: startDate };
  if (endDate) query.date_range_start = { ...(query.date_range_start || {}), $lte: endDate };

  const sortableFields = ['cost', 'clicks', 'impressions', 'conversions', 'ctr', 'quality_score', 'keyword_text'];
  const sortField = sortableFields.includes(sortBy) ? (sortBy === 'quality_score' || sortBy === 'keyword_text' ? sortBy : `metrics.${sortBy}`) : 'metrics.cost';
  const sort = { [sortField]: sortOrder === 1 ? 1 : -1 };

  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const safePage = Math.max(Number(page) || 1, 1);

  const [rows, total] = await Promise.all([
    this.find(query).sort(sort).skip((safePage - 1) * safeLimit).limit(safeLimit).lean(),
    this.countDocuments(query)
  ]);

  return { rows, total, page: safePage, limit: safeLimit, pages: Math.max(Math.ceil(total / safeLimit), 1) };
};

googleAdsKeywordSchema.statics.getByCriterionId = async function (projectId, customerId, adGroupId, criterionId) {
  return this.findOne({ project_id: projectId, google_ads_customer_id: customerId, ad_group_id: adGroupId, criterion_id: criterionId }).lean();
};

googleAdsKeywordSchema.set('toJSON', { virtuals: true, transform: (doc, ret) => { delete ret.__v; return ret; } });
googleAdsKeywordSchema.set('toObject', { virtuals: true });

const GoogleAdsKeyword = mongoose.model('GoogleAdsKeyword', googleAdsKeywordSchema);
export default GoogleAdsKeyword;
