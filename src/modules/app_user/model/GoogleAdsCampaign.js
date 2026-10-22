import mongoose from 'mongoose';

/**
 * Google Ads Campaign Model
 *
 * One row per (project, customer, campaign) — current metadata only (name,
 * status, type, budget, bidding strategy). Time-series performance lives in
 * GoogleAdsCampaignMetrics, not here — same split as
 * BusinessProfileMetadata (1 doc/entity) vs BusinessProfileData (N
 * time-series rows/entity).
 *
 * Design Principles (mirrors BusinessProfileData.js):
 * - Normalized values only — no raw Google Ads API objects stored.
 * - Duplicate prevention through a unique compound index.
 * - Soft-removal (is_removed) rather than deletion, so a campaign paused/
 *   removed in Google Ads doesn't silently disappear from historical
 *   reports that still reference its campaign_id.
 */

const googleAdsCampaignSchema = new mongoose.Schema({
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

  // Digits-only Google Ads customer ID this campaign belongs to (matches
  // GoogleConnection.google_ads_customer_id).
  google_ads_customer_id: {
    type: String,
    required: [true, 'Google Ads customer ID is required'],
    trim: true
  },

  // Google's numeric campaign ID, stored as a string (Ads IDs exceed
  // Number.MAX_SAFE_INTEGER precision guarantees in some locales/tools).
  campaign_id: {
    type: String,
    required: [true, 'Campaign ID is required'],
    trim: true
  },

  name: {
    type: String,
    required: [true, 'Campaign name is required'],
    trim: true
  },

  // Normalized from Google Ads' CampaignStatus enum (ENABLED/PAUSED/REMOVED)
  // - UNKNOWN/UNSPECIFIED cover any future enum value this schema doesn't
  // recognize yet rather than failing the whole sync on an enum mismatch.
  status: {
    type: String,
    enum: ['ENABLED', 'PAUSED', 'REMOVED', 'UNKNOWN', 'UNSPECIFIED'],
    default: 'UNKNOWN'
  },

  channel_type: { type: String, default: null },       // e.g. SEARCH, PERFORMANCE_MAX, DISPLAY
  channel_sub_type: { type: String, default: null },
  bidding_strategy_type: { type: String, default: null },
  serving_status: { type: String, default: null },
  start_date: { type: String, default: null },          // GAQL date string 'YYYY-MM-DD'
  end_date: { type: String, default: null },
  optimization_score: { type: Number, default: null },

  budget: {
    id: { type: String, default: null },
    amount_micros: { type: Number, default: null },
    amount: { type: Number, default: null },              // normalized: amount_micros / 1_000_000
    delivery_method: { type: String, default: null },
    period: { type: String, default: null }
  },

  // Soft-removal: set when a sync's campaign list no longer includes this
  // campaign_id for this customer (deleted/inaccessible in Google Ads),
  // rather than deleting the row and orphaning its historical metrics.
  is_removed: { type: Boolean, default: false, index: true },
  removed_at: { type: Date, default: null },

  first_synced_at: { type: Date, default: Date.now },
  last_synced_at: { type: Date, default: Date.now }

}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'google_ads_campaigns'
});

// Prevent duplicate campaign rows for the same project+customer+campaign.
googleAdsCampaignSchema.index(
  { project_id: 1, google_ads_customer_id: 1, campaign_id: 1 },
  { unique: true, name: 'unique_project_customer_campaign' }
);

googleAdsCampaignSchema.index({ project_id: 1, google_ads_customer_id: 1, status: 1 }, { name: 'project_customer_status' });
googleAdsCampaignSchema.index({ project_id: 1, google_ads_customer_id: 1, is_removed: 1 }, { name: 'project_customer_removed' });
googleAdsCampaignSchema.index({ project_id: 1, name: 'text' }, { name: 'campaign_name_search' });

/**
 * Bulk upsert campaign metadata rows for one sync run.
 * @param {Array} rows - normalized campaign objects (see googleAdsSyncService normalizeCampaign)
 * @returns {Promise<{inserted:number, updated:number}>}
 */
googleAdsCampaignSchema.statics.bulkUpsertCampaigns = async function (rows, userId, projectId, customerId) {
  if (!rows.length) return { inserted: 0, updated: 0 };

  const now = new Date();
  const bulkOps = rows.map((row) => ({
    updateOne: {
      filter: { project_id: projectId, google_ads_customer_id: customerId, campaign_id: row.campaignId },
      update: {
        $set: {
          user_id: userId,
          name: row.name,
          status: row.status,
          channel_type: row.channelType,
          channel_sub_type: row.channelSubType,
          bidding_strategy_type: row.biddingStrategyType,
          serving_status: row.servingStatus,
          start_date: row.startDate,
          end_date: row.endDate,
          optimization_score: row.optimizationScore,
          budget: row.budget,
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

/**
 * Soft-marks campaigns not present in the latest sync's campaign_id list as
 * removed, without deleting them (their historical metrics rows stay valid).
 * @returns {Promise<number>} count of campaigns newly marked removed
 */
googleAdsCampaignSchema.statics.markMissingAsRemoved = async function (projectId, customerId, seenCampaignIds) {
  const result = await this.updateMany(
    {
      project_id: projectId,
      google_ads_customer_id: customerId,
      campaign_id: { $nin: seenCampaignIds },
      is_removed: false
    },
    { $set: { is_removed: true, removed_at: new Date() } }
  );
  return result.modifiedCount || 0;
};

/**
 * Paginated campaign list for the Campaign List API — reads persisted data,
 * never calls Google. Cast projectId to ObjectId explicitly (unlike
 * BusinessProfileData.getProjectAggregates' known string-cast bug) since
 * this uses .find(), which — unlike .aggregate() — DOES cast query values
 * against the schema automatically; the explicit cast here is defensive
 * consistency with the aggregation statics in the sibling models, not a fix
 * for a bug in this particular method.
 */
googleAdsCampaignSchema.statics.getProjectCampaigns = async function (projectId, customerId, options = {}) {
  const { page = 1, limit = 25, status = null, search = null, includeRemoved = false, sort = { name: 1 } } = options;

  const query = { project_id: new mongoose.Types.ObjectId(projectId), google_ads_customer_id: customerId };
  if (!includeRemoved) query.is_removed = false;
  if (status) query.status = status;
  if (search) query.name = { $regex: search, $options: 'i' };

  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const safePage = Math.max(Number(page) || 1, 1);

  const [rows, total] = await Promise.all([
    this.find(query).sort(sort).skip((safePage - 1) * safeLimit).limit(safeLimit).lean(),
    this.countDocuments(query)
  ]);

  return { rows, total, page: safePage, limit: safeLimit, pages: Math.max(Math.ceil(total / safeLimit), 1) };
};

googleAdsCampaignSchema.statics.getByCampaignId = async function (projectId, customerId, campaignId) {
  return this.findOne({ project_id: projectId, google_ads_customer_id: customerId, campaign_id: campaignId }).lean();
};

googleAdsCampaignSchema.set('toJSON', { virtuals: true, transform: (doc, ret) => { delete ret.__v; return ret; } });
googleAdsCampaignSchema.set('toObject', { virtuals: true });

const GoogleAdsCampaign = mongoose.model('GoogleAdsCampaign', googleAdsCampaignSchema);
export default GoogleAdsCampaign;
