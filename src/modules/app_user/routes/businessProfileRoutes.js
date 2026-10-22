import express from 'express';
import {
  syncBusinessProfileData,
  getBusinessProfileSyncStatus,
  getBusinessProfileData,
  getBusinessProfileAccountsController,
  getBusinessProfileLocationsController,
  getBusinessProfileRatingController,
  getBusinessProfileReviewsController,
  syncBusinessProfileReviewsController,
  replyToBusinessProfileReviewController,
  getBusinessProfileReviewAnalyticsController,
  snapshotBusinessProfileReviewsController,
  selectBusinessProfile,
  getBusinessProfileDetailsController,
  getBusinessProfileTrendsController,
  getBusinessProfileMediaController,
  syncBusinessProfileMediaController
} from '../controller/businessProfileController.js';
import {
  getBusinessProfilePostsController,
  createBusinessProfilePostController,
  updateBusinessProfilePostController,
  deleteBusinessProfilePostController,
  syncBusinessProfilePostsController,
  uploadBusinessProfilePostMediaController,
  deleteBusinessProfilePostMediaController
} from '../controller/businessProfilePostController.js';
import { handlePostImageUpload } from '../../../services/businessProfilePostMediaService.js';
import auth from '../../user/middleware/auth.js';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

const router = express.Router();

/**
 * Business Profile API Routes
 * 
 * Endpoints:
 * POST /projects/:projectId/business-profile/sync - Manual sync
 * GET /projects/:projectId/business-profile/status - Sync status
 * GET /projects/:projectId/business-profile/data - Performance data
 * GET /projects/:projectId/business-profile/accounts - List accounts
 * GET /projects/:projectId/business-profile/locations - List locations
 * POST /projects/:projectId/business-profile/select - Select account/location
 */

/**
 * POST /projects/:projectId/business-profile/sync
 * 
 * Manual sync endpoint for Business Profile data
 * 
 * Request: {}
 * Response: {
 *   success: true,
 *   dataPoints: 28,
 *   dateRange: { start: "YYYY-MM-DD", end: "YYYY-MM-DD" },
 *   lastSyncAt: "ISO_DATE"
 * }
 */
router.post('/:projectId/business-profile/sync', 
  auth, 
  syncBusinessProfileData
);

/**
 * GET /projects/:projectId/business-profile/status
 * 
 * Get sync status and connection info
 * 
 * Response: {
 *   success: true,
 *   connected: true,
 *   serviceEnabled: true,
 *   businessAccountId: "123",
 *   businessLocationId: "456",
 *   lastSyncAt: "ISO_DATE",
 *   dataPoints: 28,
 *   googleEmail: "user@example.com"
 * }
 */
router.get('/:projectId/business-profile/status', 
  auth, 
  getBusinessProfileSyncStatus
);

/**
 * GET /projects/:projectId/business-profile/data
 * 
 * Get Business Profile performance data with pagination
 * 
 * Query Parameters:
 * - page: Page number (default: 1)
 * - limit: Items per page (default: 50, max: 100)
 * - sort: Sort field
 * - order: Sort order (asc, desc)
 * - start_date: Filter start date (YYYY-MM-DD)
 * - end_date: Filter end date (YYYY-MM-DD)
 * 
 * Response: {
 *   success: true,
 *   data: [{ metric_date, views, searches, actions, ... }],
 *   pagination: { page, limit, total, pages },
 *   summary: { totalViews, totalActions, ... },
 *   dateRange: { start, end }
 * }
 */
router.get('/:projectId/business-profile/data', 
  auth, 
  getBusinessProfileData
);

/**
 * GET /projects/:projectId/business-profile/accounts
 * 
 * List accessible Business Profile accounts
 * 
 * Response: {
 *   success: true,
 *   accounts: [
 *     {
 *       accountId: "123",
 *       accountName: "My Business Account"
 *     }
 *   ]
 * }
 */
router.get('/:projectId/business-profile/accounts', 
  auth, 
  getBusinessProfileAccountsController
);

/**
 * GET /projects/:projectId/business-profile/locations
 * 
 * List locations for a specific account
 * 
 * Query Parameters:
 * - accountId: Account ID to fetch locations for
 * 
 * Response: {
 *   success: true,
 *   locations: [
 *     {
 *       locationId: "456",
 *       locationName: "Main Location",
 *       address: "123 Main St"
 *     }
 *   ]
 * }
 */
router.get('/:projectId/business-profile/locations', 
  auth, 
  getBusinessProfileLocationsController
);

/**
 * POST /projects/:projectId/business-profile/select
 * 
 * Select and store Business Profile account and location
 * 
 * Request: {
 *   accountId: "123",
 *   locationId: "456"
 * }
 * Response: {
 *   success: true,
 *   businessAccountId: "123",
 *   businessLocationId: "456"
 * }
 */
router.post('/:projectId/business-profile/select',
  auth,
  selectBusinessProfile
);

/**
 * GET /projects/:projectId/business-profile/rating
 *
 * Average rating / total review count summary. Returns
 * { available: false, status, reason } instead of misleading zeros when
 * Google restricts review access for this application - see
 * businessProfileReviewService.checkReviewsCapability().
 *
 * Response: {
 *   success: true,
 *   available: true,
 *   averageRating: 4.6,
 *   totalReviewCount: 128,
 *   lastSyncedAt: "ISO_DATE"
 * }
 */
router.get('/:projectId/business-profile/rating',
  auth,
  getBusinessProfileRatingController
);

/**
 * GET /projects/:projectId/business-profile/reviews
 *
 * Paginated, searchable review list (served from synced MongoDB data).
 *
 * Query Parameters:
 * - page: Page number (default: 1)
 * - limit: Items per page (default: 20, max: 100)
 * - search: Free-text search over reviewer name + comment
 * - rating: Exact star rating filter (1-5)
 * - replied: "true" (has business reply) | "false" (no reply)
 * - sort: newest (default) | oldest | highest | lowest
 *
 * Response: {
 *   success: true,
 *   available: true,
 *   reviews: [{ google_review_id, reviewer_name, star_rating, comment, reply, review_create_time, ... }],
 *   pagination: { page, limit, total, pages }
 * }
 */
router.get('/:projectId/business-profile/reviews',
  auth,
  getBusinessProfileReviewsController
);

/**
 * GET /projects/:projectId/business-profile/reviews/analytics
 *
 * Aggregated review analytics (insight cards, rating distribution/trends,
 * glance, response rate, text/no-text distribution, sentiment + timeline) in
 * ONE response, from the synced reviews. Registered before any
 * /reviews/:reviewId route so "analytics" is never read as a review id.
 *
 * Query: range = 7d | 30d | 90d (default) | 6m | 12m ; tz = IANA timezone (default UTC)
 */
router.get('/:projectId/business-profile/reviews/analytics',
  auth,
  getBusinessProfileReviewAnalyticsController
);

// Each manual snapshot runs one aggregation: per-user cap (in-process store).
const snapshotRateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user?._id ? `u:${String(req.user._id)}` : ipKeyGenerator(req.ip)),
  handler: (req, res) => res.status(429).json({
    success: false,
    code: 'RATE_LIMITED',
    message: 'Too many snapshot requests. Please wait a few minutes and try again.'
  })
});

/**
 * POST /projects/:projectId/business-profile/reviews/analytics/snapshot
 *
 * Create/refresh TODAY's historical review snapshot (manual + initial trigger;
 * the daily scheduler uses the same service). No body: location and day are
 * derived server-side from the stored connection. 201 = created, 200 = the
 * day's existing snapshot was updated.
 */
router.post('/:projectId/business-profile/reviews/analytics/snapshot',
  auth,
  snapshotRateLimiter,
  snapshotBusinessProfileReviewsController
);

// Abuse/accident protection for the Google write: per authenticated user,
// in-process store (single instance - same approach as aiCampaignRateLimiter).
const replyRateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user?._id ? `u:${String(req.user._id)}` : ipKeyGenerator(req.ip)),
  handler: (req, res) => res.status(429).json({
    success: false,
    code: 'RATE_LIMITED',
    message: 'Too many replies in a short time. Please wait a few minutes and try again.'
  })
});

/**
 * POST /projects/:projectId/business-profile/reviews/:reviewId/reply
 *
 * REAL write to Google Business Profile (v4 reviews.updateReply). Posts the
 * reply for ONE review of the project's connected location.
 *
 * Body: { reply: string }  (trimmed, non-empty, <= 4096 bytes)
 * Success: { success, data: { review, google: { status, replyState, updateTime }, localSyncFailed } }
 * Failure: { success:false, code, message, retryable? } - codes: INVALID_REPLY,
 *   REPLY_IN_PROGRESS, ALREADY_REPLIED, REVIEW_NOT_FOUND, GOOGLE_AUTH_FAILED,
 *   GOOGLE_PERMISSION_DENIED, GOOGLE_RATE_LIMITED, GOOGLE_UNAVAILABLE,
 *   GOOGLE_REJECTED, REPLY_REJECTED, RATE_LIMITED
 */
router.post('/:projectId/business-profile/reviews/:reviewId/reply',
  auth,
  replyRateLimiter,
  replyToBusinessProfileReviewController
);

/**
 * POST /projects/:projectId/business-profile/sync-reviews
 *
 * Standalone business metadata + reviews sync (capability-checked - a
 * restricted/disabled Google API degrades gracefully rather than failing).
 *
 * Response: {
 *   success: true,
 *   metadataSynced: true,
 *   reviewsCapability: "available" | "api_disabled" | "restricted" | "rate_limited" | "error",
 *   reviewCount: 42
 * }
 */
router.post('/:projectId/business-profile/sync-reviews',
  auth,
  syncBusinessProfileReviewsController
);

/**
 * GET /projects/:projectId/business-profile/profile
 *
 * Extended business profile fields: description, categories, hours,
 * coordinates, service area, open/verification status. Served from MongoDB,
 * populated by the same sync that populates /rating and /reviews.
 *
 * Response: {
 *   success: true,
 *   available: true,
 *   businessName, description, primaryCategory, secondaryCategories,
 *   businessStatus, hasVoiceOfMerchant, website, phone, address,
 *   latitude, longitude, mapsUri, newReviewUri, placeId,
 *   serviceArea, regularHours, specialHours,
 *   averageRating, totalReviewCount, syncTimestamps
 * }
 */
router.get('/:projectId/business-profile/profile',
  auth,
  getBusinessProfileDetailsController
);

/**
 * GET /projects/:projectId/business-profile/trends?range=7|30|90|365
 *
 * True day-by-day performance series (live from Google's Performance API)
 * plus range totals for the KPI cards, in one call.
 *
 * Response: {
 *   success: true,
 *   range: "30",
 *   series: [{ date, search, maps, clicks, calls, directions, bookings }],
 *   totals: { search, maps, clicks, calls, directions, bookings }
 * }
 */
router.get('/:projectId/business-profile/trends',
  auth,
  getBusinessProfileTrendsController
);

/**
 * GET /projects/:projectId/business-profile/media
 *
 * Paginated, optionally category-filtered photos/videos list (served from
 * synced MongoDB data, same capability-gated pattern as /reviews).
 *
 * Query Parameters:
 * - page: Page number (default: 1)
 * - limit: Items per page (default: 24, max: 100)
 * - category: COVER | PROFILE | LOGO | EXTERIOR | INTERIOR | PRODUCT | AT_WORK | FOOD_AND_DRINK | MENU | COMMON_AREA | ROOMS | TEAMS | ADDITIONAL
 *
 * Response: {
 *   success: true,
 *   available: true,
 *   media: [{ google_media_key, category, media_format, google_url, thumbnail_url, ... }],
 *   pagination: { page, limit, total, pages }
 * }
 */
router.get('/:projectId/business-profile/media',
  auth,
  getBusinessProfileMediaController
);

/**
 * POST /projects/:projectId/business-profile/sync-media
 *
 * Standalone media sync (independent of the performance/reviews sync).
 *
 * Response: {
 *   success: true,
 *   mediaCapability: "available" | "api_disabled" | "restricted" | "rate_limited" | "error",
 *   mediaCount: 18
 * }
 */
router.post('/:projectId/business-profile/sync-media',
  auth,
  syncBusinessProfileMediaController
);

// Abuse/flood protection for Google Local Post mutations
const postMutationRateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user?._id ? `u:${String(req.user._id)}` : ipKeyGenerator(req.ip)),
  handler: (req, res) => res.status(429).json({
    success: false,
    code: 'RATE_LIMITED',
    message: 'Too many post requests in a short time. Please wait a few minutes and try again.'
  })
});

/**
 * GET /projects/:projectId/business-profile/posts
 *
 * Paginated, searchable, filtered list of Google Business Profile local posts.
 */
router.get('/:projectId/business-profile/posts',
  auth,
  getBusinessProfilePostsController
);

/**
 * POST /projects/:projectId/business-profile/posts
 *
 * Create and publish a new local post on Google Business Profile.
 */
router.post('/:projectId/business-profile/posts',
  auth,
  postMutationRateLimiter,
  createBusinessProfilePostController
);

/**
 * PATCH /projects/:projectId/business-profile/posts/:postId
 *
 * Edit an existing local post on Google Business Profile.
 */
router.patch('/:projectId/business-profile/posts/:postId',
  auth,
  postMutationRateLimiter,
  updateBusinessProfilePostController
);

/**
 * DELETE /projects/:projectId/business-profile/posts/:postId
 *
 * Delete an existing local post on Google Business Profile.
 */
router.delete('/:projectId/business-profile/posts/:postId',
  auth,
  postMutationRateLimiter,
  deleteBusinessProfilePostController
);

/**
 * POST /projects/:projectId/business-profile/sync-posts
 *
 * Standalone posts sync with Google Business Profile.
 */
router.post('/:projectId/business-profile/sync-posts',
  auth,
  syncBusinessProfilePostsController
);

/**
 * POST /projects/:projectId/business-profile/posts/media
 *
 * Image upload endpoint for Google Business Profile posts.
 */
router.post('/:projectId/business-profile/posts/media',
  auth,
  handlePostImageUpload,
  uploadBusinessProfilePostMediaController
);

/**
 * DELETE /projects/:projectId/business-profile/posts/media
 *
 * Cleanup unreferenced uploaded post image.
 */
router.delete('/:projectId/business-profile/posts/media',
  auth,
  deleteBusinessProfilePostMediaController
);

export default router;
