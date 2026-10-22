import mongoose from 'mongoose';

/**
 * Business Profile Media (Photos/Videos) Model
 *
 * One document per Google media item. Mirrors BusinessProfileReview.js's
 * incremental-sync design exactly: unique on (project_id, google_media_key),
 * last_seen_at + markStaleAsDeleted() detect items Google no longer returns,
 * paginated/filterable reads for the Photos gallery.
 *
 * google_url/thumbnail_url are Google-hosted signed URLs that Google's own
 * docs state "may change over time" - they are cached here for convenience
 * but should be treated as short-lived; a stale image is refreshed on the
 * next sync rather than guaranteed permanently valid.
 */
const businessProfileMediaSchema = new mongoose.Schema({
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

  google_media_key: { type: String, required: true },
  google_resource_name: { type: String, required: true },

  category: {
    type: String,
    enum: ['COVER', 'PROFILE', 'LOGO', 'EXTERIOR', 'INTERIOR', 'PRODUCT', 'AT_WORK', 'FOOD_AND_DRINK', 'MENU', 'COMMON_AREA', 'ROOMS', 'TEAMS', 'ADDITIONAL'],
    default: 'ADDITIONAL'
  },
  media_format: { type: String, enum: ['PHOTO', 'VIDEO'], default: 'PHOTO' },

  google_url: { type: String, default: null },
  thumbnail_url: { type: String, default: null },
  width_px: { type: Number, default: null },
  height_px: { type: Number, default: null },
  view_count: { type: Number, default: 0 },
  description: { type: String, default: null },
  is_customer_media: { type: Boolean, default: false },

  create_time: { type: Date, required: true },

  // 🔄 Incremental sync bookkeeping (same pattern as BusinessProfileReview)
  last_seen_at: { type: Date, required: true },
  is_deleted: { type: Boolean, default: false, index: true }

}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'business_profile_media'
});

businessProfileMediaSchema.index(
  { project_id: 1, google_media_key: 1 },
  { unique: true, name: 'unique_project_media' }
);

businessProfileMediaSchema.index(
  { project_id: 1, is_deleted: 1, category: 1, create_time: -1 },
  { name: 'project_media_gallery' }
);

/**
 * Bulk incremental upsert. Idempotent - safe to call every sync run.
 * Mirrors BusinessProfileReview.bulkUpsertReviews().
 */
businessProfileMediaSchema.statics.bulkUpsertMedia = async function(mediaItems, userId, projectId, accountId, locationId, syncedAt) {
  if (!mediaItems.length) return { upserted: 0, modified: 0 };

  const bulkOps = mediaItems.map(m => ({
    updateOne: {
      filter: { project_id: projectId, google_media_key: m.google_media_key },
      update: {
        $set: {
          user_id: userId,
          business_account_id: accountId,
          business_location_id: locationId,
          google_resource_name: m.google_resource_name,
          category: m.category,
          media_format: m.media_format,
          google_url: m.google_url,
          thumbnail_url: m.thumbnail_url,
          width_px: m.width_px,
          height_px: m.height_px,
          view_count: m.view_count,
          description: m.description,
          is_customer_media: m.is_customer_media,
          create_time: m.create_time,
          last_seen_at: syncedAt,
          is_deleted: false
        }
      },
      upsert: true
    }
  }));

  const result = await this.bulkWrite(bulkOps, { ordered: false });
  return { upserted: result.upsertedCount, modified: result.modifiedCount };
};

/**
 * Mark media Google no longer returns as deleted (soft delete). Mirrors
 * BusinessProfileReview.markStaleAsDeleted().
 */
businessProfileMediaSchema.statics.markStaleAsDeleted = async function(projectId, syncedAt) {
  const result = await this.updateMany(
    { project_id: projectId, is_deleted: false, last_seen_at: { $lt: syncedAt } },
    { $set: { is_deleted: true } }
  );
  return result.modifiedCount;
};

/**
 * Paginated, optionally category-filtered media list for the Photos gallery.
 */
businessProfileMediaSchema.statics.getPaginated = async function(projectId, { page = 1, limit = 24, category = '' } = {}) {
  const query = { project_id: projectId, is_deleted: false };
  if (category && category.trim()) {
    query.category = category.trim();
  }

  const skip = (page - 1) * limit;

  const [media, total] = await Promise.all([
    this.find(query)
      .sort({ create_time: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    this.countDocuments(query)
  ]);

  return {
    media,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    }
  };
};

/**
 * A single item per category (logo, cover, ...) for the Business Summary
 * card - the most recently seen item wins if Google ever returns more than
 * one for the same category.
 */
businessProfileMediaSchema.statics.getPrimaryByCategory = async function(projectId, categories) {
  const items = await this.find({
    project_id: projectId,
    is_deleted: false,
    category: { $in: categories }
  })
    .sort({ create_time: -1 })
    .lean();

  const byCategory = {};
  for (const item of items) {
    if (!byCategory[item.category]) byCategory[item.category] = item;
  }
  return byCategory;
};

const BusinessProfileMedia = mongoose.model('BusinessProfileMedia', businessProfileMediaSchema);
export default BusinessProfileMedia;
