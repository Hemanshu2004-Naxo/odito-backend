import mongoose from 'mongoose';

/**
 * Business Profile Post Model
 *
 * Represents a Google Business Profile Local Post for a connected project/location.
 * Follows the incremental-sync and unique constraint design established by
 * BusinessProfileReview.js and BusinessProfileMedia.js:
 * - Unique compound index on (project_id, google_post_id)
 * - Soft delete via `is_deleted` + `last_seen_at` for synced posts
 * - Supports Standard updates, Events, Offers, and Alerts
 * - Tracks Google performance insights (search views, CTA clicks) and status metadata
 */
const businessProfilePostSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  project_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SeoProject',
    required: true,
    index: true
  },

  business_account_id: { type: String, required: true },
  business_location_id: { type: String, required: true },

  google_post_id: { type: String, required: true },
  google_resource_name: { type: String, required: true },

  language_code: { type: String, default: 'en-US' },
  summary: { type: String, default: '' },

  topic_type: {
    type: String,
    enum: ['STANDARD', 'EVENT', 'OFFER', 'ALERT'],
    default: 'STANDARD',
    index: true
  },

  alert_type: {
    type: String,
    enum: ['ALERT_TYPE_UNSPECIFIED', 'COVID_19'],
    default: 'ALERT_TYPE_UNSPECIFIED'
  },

  call_to_action: {
    action_type: {
      type: String,
      enum: ['ACTION_TYPE_UNSPECIFIED', 'BOOK', 'ORDER', 'SHOP', 'LEARN_MORE', 'SIGN_UP', 'CALL'],
      default: 'ACTION_TYPE_UNSPECIFIED'
    },
    url: { type: String, default: null }
  },

  event: {
    title: { type: String, default: null },
    schedule: {
      start_date: {
        year: { type: Number },
        month: { type: Number },
        day: { type: Number }
      },
      start_time: {
        hours: { type: Number },
        minutes: { type: Number },
        seconds: { type: Number, default: 0 },
        nanos: { type: Number, default: 0 }
      },
      end_date: {
        year: { type: Number },
        month: { type: Number },
        day: { type: Number }
      },
      end_time: {
        hours: { type: Number },
        minutes: { type: Number },
        seconds: { type: Number, default: 0 },
        nanos: { type: Number, default: 0 }
      }
    }
  },

  offer: {
    coupon_code: { type: String, default: null },
    redeem_online_url: { type: String, default: null },
    terms_conditions: { type: String, default: null }
  },

  media: [
    {
      media_format: { type: String, enum: ['PHOTO', 'VIDEO'], default: 'PHOTO' },
      source_url: { type: String, default: null },
      google_url: { type: String, default: null }
    }
  ],

  state: {
    type: String,
    enum: ['LOCAL_POST_STATE_UNSPECIFIED', 'PROCESSING', 'LIVE', 'REJECTED'],
    default: 'LIVE',
    index: true
  },

  rejection_reason: { type: String, default: null },
  search_url: { type: String, default: null },

  // Performance / Insights metrics from Google reportLocalPostInsights
  views_search: { type: Number, default: 0 },
  actions_call_to_action: { type: Number, default: 0 },
  metrics_last_synced_at: { type: Date, default: null },

  create_time: { type: Date, required: true },
  update_time: { type: Date, default: null },

  // Incremental sync bookkeeping
  last_seen_at: { type: Date, required: true },
  is_deleted: { type: Boolean, default: false, index: true }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'business_profile_posts'
});

businessProfilePostSchema.index(
  { project_id: 1, google_post_id: 1 },
  { unique: true, name: 'unique_project_post' }
);

businessProfilePostSchema.index(
  { project_id: 1, is_deleted: 1, create_time: -1 },
  { name: 'project_posts_list' }
);

/**
 * Bulk incremental upsert of posts from Google sync.
 */
businessProfilePostSchema.statics.bulkUpsertPosts = async function(posts, userId, projectId, accountId, locationId, syncedAt) {
  if (!posts || !posts.length) return { upserted: 0, modified: 0 };

  const bulkOps = posts.map((p) => {
    const set = {
      user_id: userId,
      business_account_id: accountId,
      business_location_id: locationId,
      google_resource_name: p.google_resource_name,
      language_code: p.language_code || 'en-US',
      summary: p.summary || '',
      topic_type: p.topic_type || 'STANDARD',
      alert_type: p.alert_type || 'ALERT_TYPE_UNSPECIFIED',
      call_to_action: p.call_to_action || { action_type: 'ACTION_TYPE_UNSPECIFIED', url: null },
      event: p.event || null,
      offer: p.offer || null,
      media: p.media || [],
      state: p.state || 'LIVE',
      rejection_reason: p.rejection_reason || null,
      search_url: p.search_url || null,
      create_time: p.create_time || syncedAt,
      update_time: p.update_time || syncedAt,
      last_seen_at: syncedAt,
      is_deleted: false
    };

    // Metrics are written ONLY when Google actually reported them. A sync (or an
    // edit/create) that carries no metrics must neither wipe real numbers to 0
    // nor stamp metrics_last_synced_at as if they had been measured; a brand-new
    // post starts at 0 / "never measured" (metrics_last_synced_at stays null).
    const hasMetrics = typeof p.views_search === 'number' || typeof p.actions_call_to_action === 'number';
    const update = { $set: set };
    if (hasMetrics) {
      set.views_search = typeof p.views_search === 'number' ? p.views_search : 0;
      set.actions_call_to_action = typeof p.actions_call_to_action === 'number' ? p.actions_call_to_action : 0;
      set.metrics_last_synced_at = p.metrics_last_synced_at || syncedAt;
    } else {
      update.$setOnInsert = { views_search: 0, actions_call_to_action: 0, metrics_last_synced_at: null };
    }

    return {
      updateOne: {
        filter: { project_id: projectId, google_post_id: p.google_post_id },
        update,
        upsert: true
      }
    };
  });

  const result = await this.bulkWrite(bulkOps, { ordered: false });
  return { upserted: result.upsertedCount, modified: result.modifiedCount };
};

/**
 * Mark posts Google no longer returns as deleted (soft delete).
 */
businessProfilePostSchema.statics.markStaleAsDeleted = async function(projectId, syncedAt) {
  const result = await this.updateMany(
    { project_id: projectId, is_deleted: false, last_seen_at: { $lt: syncedAt } },
    { $set: { is_deleted: true } }
  );
  return result.modifiedCount;
};

/**
 * Paginated and filtered query for dashboard list.
 */
businessProfilePostSchema.statics.getPaginated = async function(projectId, {
  page = 1,
  limit = 10,
  topicType = '',
  state = '',
  search = '',
  sort = 'newest'
} = {}) {
  const query = { project_id: projectId, is_deleted: false };

  if (topicType && topicType.trim() && topicType !== 'ALL') {
    query.topic_type = topicType.trim();
  }

  if (state && state.trim() && state !== 'ALL') {
    query.state = state.trim();
  }

  if (search && search.trim()) {
    const escaped = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    query.$or = [
      { summary: { $regex: escaped, $options: 'i' } },
      { 'event.title': { $regex: escaped, $options: 'i' } },
      { 'offer.coupon_code': { $regex: escaped, $options: 'i' } }
    ];
  }

  let sortOption = { create_time: -1 };
  if (sort === 'oldest') {
    sortOption = { create_time: 1 };
  } else if (sort === 'most_viewed') {
    sortOption = { views_search: -1, create_time: -1 };
  } else if (sort === 'most_clicked') {
    sortOption = { actions_call_to_action: -1, create_time: -1 };
  }

  const skip = (page - 1) * limit;

  const [posts, total] = await Promise.all([
    this.find(query)
      .sort(sortOption)
      .skip(skip)
      .limit(limit)
      .lean(),
    this.countDocuments(query)
  ]);

  return {
    posts,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    }
  };
};

/**
 * Aggregate summary KPIs for the posts dashboard:
 * Total posts, Live posts, Search views, CTA clicks.
 */
businessProfilePostSchema.statics.getMetricsSummary = async function(projectId) {
  const [summary] = await this.aggregate([
    { $match: { project_id: new mongoose.Types.ObjectId(projectId), is_deleted: false } },
    {
      $group: {
        _id: null,
        totalPosts: { $sum: 1 },
        livePosts: {
          $sum: { $cond: [{ $eq: ['$state', 'LIVE'] }, 1, 0] }
        },
        totalViews: { $sum: '$views_search' },
        totalActions: { $sum: '$actions_call_to_action' },
        // posts whose views/clicks were actually measured by Google (vs never measured)
        postsWithMetrics: { $sum: { $cond: [{ $ne: [{ $ifNull: ['$metrics_last_synced_at', null] }, null] }, 1, 0] } }
      }
    }
  ]);

  return {
    totalPosts: summary?.totalPosts || 0,
    livePosts: summary?.livePosts || 0,
    totalViews: summary?.totalViews || 0,
    totalActions: summary?.totalActions || 0,
    postsWithMetrics: summary?.postsWithMetrics || 0
  };
};

const BusinessProfilePost = mongoose.model('BusinessProfilePost', businessProfilePostSchema);
export default BusinessProfilePost;
