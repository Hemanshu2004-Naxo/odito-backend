import mongoose from 'mongoose';

/**
 * Google Ads Recommendation Model
 *
 * One row per Google recommendation resource, bulk-upserted and
 * stale-marked on every sync — same shape as BusinessProfileReview.js
 * (bulkUpsertReviews / markStaleAsDeleted / getPaginated), applied here to
 * `is_resolved` instead of `is_deleted` (a recommendation Google stops
 * returning has typically been auto-resolved: applied elsewhere, expired,
 * or no longer applicable — not "deleted" in any real sense).
 *
 * `type` is deliberately a free-text String, not a Mongoose enum: Google
 * Ads' RecommendationType has ~58 values today and grows every API version
 * (mostly Shopping/asset-specific additions) — hard-enumerating the current
 * set would reject a real recommendation the moment Google ships type #59,
 * partial-failing that one bulkWrite row. `type` is still normalized (the
 * library decodes the raw enum int to its name — see decodeEnum in
 * googleAdsService.js), just not schema-constrained to a fixed list.
 */

const googleAdsRecommendationSchema = new mongoose.Schema({
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

  // Google's own stable identity for this recommendation - the full
  // "customers/{id}/recommendations/{recommendation_id}" resource name.
  resource_name: {
    type: String,
    required: [true, 'Recommendation resource name is required'],
    trim: true
  },

  type: { type: String, required: [true, 'Recommendation type is required'], trim: true },
  // Human-readable label derived from `type` (see RECOMMENDATION_TYPE_LABELS
  // in googleAdsService.js) - e.g. "CAMPAIGN_BUDGET" -> "Increase Budget".
  title: { type: String, required: [true, 'Title is required'] },

  // Presentation layer (Gap #4, frontend integration audit) - all derived
  // server-side in googleAdsService.js (categoryForRecommendationType /
  // buildRecommendationDescription / buildRecommendationStat /
  // assignRecommendationPriorities) and persisted here so the read
  // endpoint never has to recompute or - worse - push that derivation onto
  // the frontend. `category`/`priority`/`severity` are free-text/enum
  // strings rather than a fixed list precisely because `type` itself is
  // (58+ values and growing) - see that field's own comment.
  category: { type: String, default: 'Other' },
  description: { type: String, default: null },
  stat_label: { type: String, default: null },
  stat_value: { type: String, default: null },
  priority: { type: String, enum: ['high', 'medium', 'low'], default: 'low' },
  severity: { type: String, enum: ['critical', 'warning', 'info'], default: 'info' },

  campaign_id: { type: String, default: null },
  campaign_name: { type: String, default: null },

  impact: {
    base_metrics: {
      impressions: { type: Number, default: null },
      clicks: { type: Number, default: null },
      cost_micros: { type: Number, default: null },
      cost: { type: Number, default: null },
      conversions: { type: Number, default: null }
    },
    potential_metrics: {
      impressions: { type: Number, default: null },
      clicks: { type: Number, default: null },
      cost_micros: { type: Number, default: null },
      cost: { type: Number, default: null },
      conversions: { type: Number, default: null }
    }
  },

  // Type-specific detail (e.g. { currentBudget, recommendedBudget } for
  // CAMPAIGN_BUDGET, { keywordText, matchType } for KEYWORD) - stored
  // generically since each of the ~58 recommendation types has its own
  // sub-message shape; see mapRecommendationRow in googleAdsService.js for
  // the small set of types this phase extracts detail for.
  details: { type: mongoose.Schema.Types.Mixed, default: null },

  // Google's own dismissed flag, synced as-is.
  dismissed: { type: Boolean, default: false },

  // Odito's own workflow status. 'applied' is schema-ready but not yet
  // reachable in this phase - no apply/dismiss mutate endpoint was in
  // Phase 6.4's API Endpoints list, only read + refresh.
  status: {
    type: String,
    enum: ['pending', 'applied', 'dismissed'],
    default: 'pending'
  },

  status_history: [{
    status: { type: String, enum: ['pending', 'applied', 'dismissed'] },
    changed_at: { type: Date, default: Date.now },
    source: { type: String, default: 'sync' } // 'sync' | 'user' (once a write endpoint exists)
  }],

  is_resolved: { type: Boolean, default: false, index: true },
  resolved_at: { type: Date, default: null },

  first_synced_at: { type: Date, default: Date.now },
  last_synced_at: { type: Date, default: Date.now }

}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'google_ads_recommendations'
});

googleAdsRecommendationSchema.index(
  { project_id: 1, google_ads_customer_id: 1, resource_name: 1 },
  { unique: true, name: 'unique_project_customer_resource' }
);

googleAdsRecommendationSchema.index({ project_id: 1, google_ads_customer_id: 1, status: 1 }, { name: 'project_customer_status' });
googleAdsRecommendationSchema.index({ project_id: 1, google_ads_customer_id: 1, is_resolved: 1 }, { name: 'project_customer_resolved' });
googleAdsRecommendationSchema.index({ project_id: 1, google_ads_customer_id: 1, type: 1 }, { name: 'project_customer_type' });

/** Bulk upsert one sync run's worth of recommendation rows. Never overwrites `status`/`status_history` on an existing row - only Google-sourced fields. */
googleAdsRecommendationSchema.statics.bulkUpsertRecommendations = async function (rows, userId, projectId, customerId) {
  if (!rows.length) return { inserted: 0, updated: 0 };

  const now = new Date();
  const bulkOps = rows.map((row) => ({
    updateOne: {
      filter: { project_id: projectId, google_ads_customer_id: customerId, resource_name: row.resourceName },
      update: {
        $set: {
          user_id: userId,
          type: row.type,
          title: row.title,
          category: row.category,
          description: row.description,
          stat_label: row.statLabel,
          stat_value: row.statValue,
          priority: row.priority,
          severity: row.severity,
          campaign_id: row.campaignId,
          campaign_name: row.campaignName,
          impact: row.impact,
          details: row.details,
          dismissed: row.dismissed,
          is_resolved: false,
          resolved_at: null,
          last_synced_at: now,
          updated_at: now
        },
        // Only set status on first insert (from Google's own dismissed
        // flag) - a resync must never clobber a status a user already
        // changed locally (e.g. a future apply action), only refresh the
        // Google-sourced fields above.
        $setOnInsert: {
          status: row.dismissed ? 'dismissed' : 'pending',
          status_history: [{ status: row.dismissed ? 'dismissed' : 'pending', changed_at: now, source: 'sync' }],
          first_synced_at: now,
          created_at: now
        }
      },
      upsert: true
    }
  }));

  const result = await this.bulkWrite(bulkOps, { ordered: false });
  return { inserted: result.upsertedCount || 0, updated: result.modifiedCount || 0 };
};

/** Marks recommendations Google no longer returns as resolved (mirrors BusinessProfileReview.markStaleAsDeleted). */
googleAdsRecommendationSchema.statics.markMissingAsResolved = async function (projectId, customerId, seenResourceNames) {
  const result = await this.updateMany(
    {
      project_id: projectId,
      google_ads_customer_id: customerId,
      resource_name: { $nin: seenResourceNames },
      is_resolved: false
    },
    { $set: { is_resolved: true, resolved_at: new Date() } }
  );
  return result.modifiedCount || 0;
};

/** Paginated, filterable recommendation list. */
googleAdsRecommendationSchema.statics.getProjectRecommendations = async function (projectId, customerId, options = {}) {
  const { page = 1, limit = 25, status = null, type = null, campaignId = null, includeResolved = false } = options;

  const query = { project_id: new mongoose.Types.ObjectId(projectId), google_ads_customer_id: customerId };
  if (!includeResolved) query.is_resolved = false;
  if (status) query.status = status;
  if (type) query.type = type;
  if (campaignId) query.campaign_id = campaignId;

  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const safePage = Math.max(Number(page) || 1, 1);

  const [rows, total] = await Promise.all([
    this.find(query).sort({ created_at: -1 }).skip((safePage - 1) * safeLimit).limit(safeLimit).lean(),
    this.countDocuments(query)
  ]);

  return { rows, total, page: safePage, limit: safeLimit, pages: Math.max(Math.ceil(total / safeLimit), 1) };
};

/** Status distribution summary (pending/applied/dismissed counts), for the Recommendations widget header. */
googleAdsRecommendationSchema.statics.getStatusSummary = async function (projectId, customerId) {
  const rows = await this.aggregate([
    { $match: { project_id: new mongoose.Types.ObjectId(projectId), google_ads_customer_id: customerId, is_resolved: false } },
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]);

  const summary = { pending: 0, applied: 0, dismissed: 0 };
  for (const row of rows) {
    if (row._id in summary) summary[row._id] = row.count;
  }
  return summary;
};

googleAdsRecommendationSchema.set('toJSON', { virtuals: true, transform: (doc, ret) => { delete ret.__v; return ret; } });
googleAdsRecommendationSchema.set('toObject', { virtuals: true });

const GoogleAdsRecommendation = mongoose.model('GoogleAdsRecommendation', googleAdsRecommendationSchema);
export default GoogleAdsRecommendation;
