import mongoose from 'mongoose';

/**
 * SocialPost — one real Facebook Page post or Instagram media item,
 * normalized into a single shape and synced from Meta's Graph API by
 * socialSyncService.js. Read by socialFeedService.js for the Feeds page
 * (GET /api/social/feeds). No token/secret of any kind lives on this
 * model — it only ever stores public post content and engagement counts,
 * the same class of data Meta already serves back to any authorized page
 * admin.
 *
 * `rawData` keeps the normalizer's raw mapped-from-Meta fields (not the
 * full Graph API envelope) so a future field can be surfaced without a
 * re-sync, without ever needing to store anything token-adjacent.
 */

const PLATFORMS = ['facebook', 'instagram'];
const POST_TYPES = ['post', 'image', 'video', 'carousel_album', 'reel', 'status', 'link', 'other'];
// Meta's read-only Graph API endpoints used here only ever return posts
// that already exist on the platform — there is no "draft"/"scheduled"
// state visible through this read path (that belongs to a future
// publishing phase, which is explicitly out of scope here). 'published'
// is therefore the only status this sync path ever writes.
const STATUSES = ['published'];

const socialPostSchema = new mongoose.Schema({
  project_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SeoProject',
    required: true,
    index: true,
  },
  social_account_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SocialAccount',
    required: true,
    index: true,
  },
  platform: {
    type: String,
    enum: PLATFORMS,
    required: true,
  },
  // Meta's own post/media ID — the provider-side identity this record
  // represents. Combined with platform + social_account_id below for the
  // uniqueness guarantee (Phase 5's explicit requirement: never duplicate
  // a post on re-sync).
  externalPostId: {
    type: String,
    required: true,
    trim: true,
  },
  accountId: {
    type: String,
    required: true,
    trim: true,
  },
  accountName: {
    type: String,
    trim: true,
    default: null,
  },
  username: {
    type: String,
    trim: true,
    default: null,
  },
  // Captured from the connected account's own metadata at sync time
  // (Page picture / Instagram profile picture) — a real value Meta
  // already returned during Page/Instagram discovery, never fabricated.
  // Denormalized onto each post so the Feeds list never needs a per-post
  // join back to SocialAccount just to render an avatar.
  accountPicture: {
    type: String,
    default: null,
  },
  type: {
    type: String,
    enum: POST_TYPES,
    default: 'other',
  },
  text: {
    type: String,
    default: null,
  },
  mediaUrl: {
    type: String,
    default: null,
  },
  thumbnailUrl: {
    type: String,
    default: null,
  },
  permalink: {
    type: String,
    default: null,
  },
  status: {
    type: String,
    enum: STATUSES,
    default: 'published',
  },
  publishedAt: {
    type: Date,
    default: null,
    index: true,
  },
  // Every metric defaults to null (unavailable/not reported), never 0 —
  // a real Meta-reported zero is written explicitly by the mapper, which
  // is the only place allowed to decide "0" vs "not available" (mirrors
  // facebookOverviewService.js's own established discipline for the same
  // distinction).
  metrics: {
    likes: { type: Number, default: null },
    comments: { type: Number, default: null },
    shares: { type: Number, default: null },
    views: { type: Number, default: null },
  },
  // Raw normalizer output (not the full Graph API envelope, and never a
  // token) — lets a future field be surfaced from already-synced data
  // without forcing a re-sync.
  rawData: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  syncedAt: {
    type: Date,
    default: null,
  },
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
});

// Phase 5's explicit requirement: never create duplicate records on
// repeated sync. Scoped to social_account_id (not just platform) because
// the same externalPostId namespace is per-provider-account, not global.
socialPostSchema.index({ platform: 1, social_account_id: 1, externalPostId: 1 }, { unique: true });
// Feed listing — every real query is project-scoped and sorted by recency.
socialPostSchema.index({ project_id: 1, publishedAt: -1 });
socialPostSchema.index({ project_id: 1, platform: 1, publishedAt: -1 });
// Account-scoped feed reads (socialFeedService.js's default "active
// account only" mode) — project + the $in account-id list + platform
// filter + sort, the exact shape that query runs.
socialPostSchema.index({ project_id: 1, social_account_id: 1, platform: 1, publishedAt: -1 });

const SocialPost = mongoose.model('SocialPost', socialPostSchema);
export default SocialPost;
export { PLATFORMS, POST_TYPES, STATUSES };
