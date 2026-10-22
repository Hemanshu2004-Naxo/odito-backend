import mongoose from 'mongoose';

/**
 * Google Ads Ad Model
 *
 * One row per (project, customer, ad group, ad) — current metadata
 * (type, ad strength, approval/review status) PLUS a rolling-window
 * performance snapshot, same "metadata + rolling metrics" design as
 * GoogleAdsKeyword. Covers every ad format Phase 6.5 asks for (Responsive
 * Search, Performance Max, Display, Video, Shopping) via the same `ad_type`
 * field - Google Ads' AdType enum already distinguishes them
 * (RESPONSIVE_SEARCH_AD, RESPONSIVE_DISPLAY_AD, VIDEO_AD/VIDEO_RESPONSIVE_AD,
 * SHOPPING_PRODUCT_AD/SHOPPING_SMART_AD, etc. - Performance Max ads
 * themselves live under `asset_group_ad`, a different resource; what
 * appears here for a PMax campaign is whatever legacy ad type, if any,
 * still exists on it) - no per-format model needed.
 */

const googleAdsAdSchema = new mongoose.Schema({
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

  ad_group_id: { type: String, required: [true, 'Ad group ID is required'], trim: true },
  ad_group_name: { type: String, default: null },
  ad_id: { type: String, required: [true, 'Ad ID is required'], trim: true },

  campaign_id: { type: String, required: [true, 'Campaign ID is required'], trim: true },
  campaign_name: { type: String, default: null },

  name: { type: String, default: null },
  ad_type: { type: String, default: 'UNKNOWN' },   // free-text, not enum - AdType has 30+ values and grows every version (same reasoning as GoogleAdsRecommendation.type)
  status: { type: String, default: 'UNKNOWN' },

  ad_strength: {
    type: String,
    enum: ['UNSPECIFIED', 'UNKNOWN', 'PENDING', 'NO_ADS', 'POOR', 'AVERAGE', 'GOOD', 'EXCELLENT'],
    default: 'UNKNOWN'
  },
  approval_status: {
    type: String,
    enum: ['UNSPECIFIED', 'UNKNOWN', 'DISAPPROVED', 'APPROVED_LIMITED', 'APPROVED', 'AREA_OF_INTEREST_ONLY'],
    default: 'UNKNOWN'
  },
  review_status: {
    type: String,
    enum: ['UNSPECIFIED', 'UNKNOWN', 'REVIEW_IN_PROGRESS', 'REVIEWED', 'UNDER_APPEAL', 'ELIGIBLE_MAY_SERVE'],
    default: 'UNKNOWN'
  },

  // Denormalized from the owning campaign (Gap #6, frontend integration
  // audit) - lets getAdTypeGroupSummary's $group/$switch pipeline bucket
  // Performance Max campaigns' ads into their own "Performance Max" group
  // regardless of their own ad_type, entirely server-side, without a
  // second query or an in-memory join against GoogleAdsCampaign per ad.
  campaign_channel_type: { type: String, default: null },

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

  is_removed: { type: Boolean, default: false, index: true },
  removed_at: { type: Date, default: null },

  first_synced_at: { type: Date, default: Date.now },
  last_synced_at: { type: Date, default: Date.now }

}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'google_ads_ads'
});

googleAdsAdSchema.index(
  { project_id: 1, google_ads_customer_id: 1, ad_group_id: 1, ad_id: 1 },
  { unique: true, name: 'unique_project_customer_ad_group_ad' }
);

googleAdsAdSchema.index({ project_id: 1, google_ads_customer_id: 1, campaign_id: 1 }, { name: 'project_customer_campaign' });
googleAdsAdSchema.index({ project_id: 1, google_ads_customer_id: 1, ad_type: 1 }, { name: 'project_customer_ad_type' });
googleAdsAdSchema.index({ project_id: 1, google_ads_customer_id: 1, is_removed: 1 }, { name: 'project_customer_removed' });

/** Bulk upsert one sync run's worth of ad rows. */
googleAdsAdSchema.statics.bulkUpsertAds = async function (rows, userId, projectId, customerId) {
  if (!rows.length) return { inserted: 0, updated: 0 };

  const now = new Date();
  const bulkOps = rows.map((row) => ({
    updateOne: {
      filter: { project_id: projectId, google_ads_customer_id: customerId, ad_group_id: row.adGroupId, ad_id: row.adId },
      update: {
        $set: {
          user_id: userId,
          ad_group_name: row.adGroupName,
          campaign_id: row.campaignId,
          campaign_name: row.campaignName,
          campaign_channel_type: row.campaignChannelType,
          name: row.name,
          ad_type: row.adType,
          status: row.status,
          ad_strength: row.adStrength,
          approval_status: row.approvalStatus,
          review_status: row.reviewStatus,
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

googleAdsAdSchema.statics.markMissingAsRemoved = async function (projectId, customerId, seenPairs) {
  const seenSet = new Set(seenPairs);
  const candidates = await this.find(
    { project_id: projectId, google_ads_customer_id: customerId, is_removed: false },
    { ad_group_id: 1, ad_id: 1 }
  ).lean();

  const idsToRemove = candidates.filter((c) => !seenSet.has(`${c.ad_group_id}:${c.ad_id}`)).map((c) => c._id);
  if (!idsToRemove.length) return 0;

  const result = await this.updateMany({ _id: { $in: idsToRemove } }, { $set: { is_removed: true, removed_at: new Date() } });
  return result.modifiedCount || 0;
};

/**
 * Ad Performance Aggregation mode (Gap #6, frontend integration audit) -
 * groups every non-removed ad into exactly the 5 display buckets the
 * existing Ad Performance card renders (Responsive Search Ads/Performance
 * Max/Display/Video/Shopping), with aggregated metrics per bucket, entirely
 * via one $group/$switch aggregation pipeline (no per-ad-type follow-up
 * queries, no in-memory re-bucketing).
 *
 * The "Performance Max" bucket is keyed off `campaign_channel_type`, not
 * `ad_type` - Performance Max campaigns don't have traditional ad_group_ad
 * rows for their asset groups (those live under the separate
 * asset_group_ad resource, which this codebase does not sync - see this
 * model's own file-level doc comment). Any ad_group_ad row that DOES exist
 * under a Performance Max campaign (legacy/mixed campaigns) is bucketed
 * here as Performance Max regardless of its own ad_type, since that's the
 * meaningful business grouping the widget wants; a pure Performance Max
 * account may show this bucket as empty/zero, which is a disclosed data
 * completeness limit, not a bug.
 */
googleAdsAdSchema.statics.getAdTypeGroupSummary = async function (projectId, customerId) {
  const rows = await this.aggregate([
    { $match: { project_id: new mongoose.Types.ObjectId(projectId), google_ads_customer_id: customerId, is_removed: false } },
    {
      $addFields: {
        _group: {
          $switch: {
            branches: [
              { case: { $eq: ['$campaign_channel_type', 'PERFORMANCE_MAX'] }, then: 'PERFORMANCE_MAX' },
              { case: { $eq: ['$ad_type', 'RESPONSIVE_SEARCH_AD'] }, then: 'RESPONSIVE_SEARCH_AD' },
              { case: { $in: ['$ad_type', ['RESPONSIVE_DISPLAY_AD', 'LEGACY_RESPONSIVE_DISPLAY_AD', 'IMAGE_AD', 'HTML5_UPLOAD_AD', 'DYNAMIC_HTML5_AD']] }, then: 'DISPLAY' },
              { case: { $in: ['$ad_type', ['VIDEO_AD', 'VIDEO_RESPONSIVE_AD', 'VIDEO_BUMPER_AD', 'VIDEO_NON_SKIPPABLE_IN_STREAM_AD', 'VIDEO_TRUEVIEW_IN_STREAM_AD', 'IN_FEED_VIDEO_AD']] }, then: 'VIDEO' },
              { case: { $in: ['$ad_type', ['SHOPPING_SMART_AD', 'SHOPPING_PRODUCT_AD', 'SHOPPING_COMPARISON_LISTING_AD']] }, then: 'SHOPPING' }
            ],
            default: 'OTHER'
          }
        }
      }
    },
    {
      $group: {
        _id: '$_group',
        impressions: { $sum: '$metrics.impressions' },
        clicks: { $sum: '$metrics.clicks' },
        cost: { $sum: '$metrics.cost' },
        conversions: { $sum: '$metrics.conversions' },
        conversions_value: { $sum: '$metrics.conversions_value' },
        adCount: { $sum: 1 }
      }
    }
  ]);

  const GROUP_TITLES = {
    RESPONSIVE_SEARCH_AD: 'Responsive Search Ads',
    PERFORMANCE_MAX: 'Performance Max',
    DISPLAY: 'Display',
    VIDEO: 'Video',
    SHOPPING: 'Shopping',
    OTHER: 'Other'
  };

  return rows.map((row) => ({
    key: row._id,
    title: GROUP_TITLES[row._id] || row._id,
    impressions: row.impressions,
    clicks: row.clicks,
    cost: row.cost,
    conversions: row.conversions,
    conversionsValue: row.conversions_value,
    adCount: row.adCount,
    ctr: row.impressions > 0 ? (row.clicks / row.impressions) * 100 : 0,
    roas: row.cost > 0 ? row.conversions_value / row.cost : 0
  }));
};

/** Paginated, filterable, sortable ad list. */
googleAdsAdSchema.statics.getProjectAds = async function (projectId, customerId, options = {}) {
  const { page = 1, limit = 25, campaignId = null, adType = null, includeRemoved = false, sortBy = 'cost', sortOrder = -1 } = options;

  const query = { project_id: new mongoose.Types.ObjectId(projectId), google_ads_customer_id: customerId };
  if (!includeRemoved) query.is_removed = false;
  if (campaignId) query.campaign_id = campaignId;
  if (adType) query.ad_type = adType;

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

/** True if this account has at least one ad with a real (non-UNKNOWN/PENDING) ad strength - backs the capability matrix's supportsAdStrength flag. */
googleAdsAdSchema.statics.hasAdStrengthData = async function (projectId, customerId) {
  const count = await this.countDocuments({
    project_id: new mongoose.Types.ObjectId(projectId),
    google_ads_customer_id: customerId,
    ad_strength: { $nin: ['UNSPECIFIED', 'UNKNOWN', 'PENDING'] }
  });
  return count > 0;
};

googleAdsAdSchema.set('toJSON', { virtuals: true, transform: (doc, ret) => { delete ret.__v; return ret; } });
googleAdsAdSchema.set('toObject', { virtuals: true });

const GoogleAdsAd = mongoose.model('GoogleAdsAd', googleAdsAdSchema);
export default GoogleAdsAd;
