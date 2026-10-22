import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import GoogleConnection from '../model/GoogleConnection.js';
import SeoProject from '../model/SeoProject.js';
import BusinessProfilePost from '../model/BusinessProfilePost.js';
import {
  checkPostsCapability,
  fetchAllPosts,
  createLocalPost,
  updateLocalPost,
  deleteLocalPost,
  LocalPostError
} from '../../../services/businessProfilePostService.js';
import {
  validatePostImage,
  uploadPostImage,
  deletePostImageByUrl
} from '../../../services/businessProfilePostMediaService.js';

const VALID_TOPIC_TYPES = ['STANDARD', 'EVENT', 'OFFER', 'ALERT'];
const VALID_CTA_TYPES = ['ACTION_TYPE_UNSPECIFIED', 'BOOK', 'ORDER', 'SHOP', 'LEARN_MORE', 'SIGN_UP', 'CALL'];
const MAX_SUMMARY_CHARS = 1500;

function isValidUrl(string) {
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * GET /projects/:projectId/business-profile/posts
 *
 * Paginated, searchable, topic/state filterable list of local posts.
 */
export const getBusinessProfilePostsController = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
  const topicType = typeof req.query.topicType === 'string' ? req.query.topicType : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 100) : '';
  const sort = typeof req.query.sort === 'string' ? req.query.sort : 'newest';

  try {
    const project = await SeoProject.findById(projectId);
    if (!project) return res.status(404).json(ResponseUtil.error('Project not found', 404));
    if (project.user_id.toString() !== userId.toString()) {
      return res.status(403).json(ResponseUtil.accessDenied('Access denied'));
    }

    const googleConnection = await GoogleConnection.findActiveConnection(userId, projectId, 'business_profile');
    if (!googleConnection || !googleConnection.business_account_id || !googleConnection.business_location_id) {
      return res.json(ResponseUtil.success({
        available: false,
        status: 'unknown',
        reason: 'Google Business Profile not connected or location not selected.',
        posts: [],
        summary: { totalPosts: 0, livePosts: 0, totalViews: 0, totalActions: 0 },
        pagination: { page, limit, total: 0, pages: 0 }
      }));
    }

    const capability = await checkPostsCapability(
      googleConnection,
      googleConnection.business_account_id,
      googleConnection.business_location_id
    );

    if (capability.status !== 'available') {
      return res.json(ResponseUtil.success({
        available: false,
        status: capability.status,
        reason: capability.reason,
        posts: [],
        summary: { totalPosts: 0, livePosts: 0, totalViews: 0, totalActions: 0 },
        pagination: { page, limit, total: 0, pages: 0 }
      }));
    }

    const [listResult, summary] = await Promise.all([
      BusinessProfilePost.getPaginated(projectId, { page, limit, topicType, state, search, sort }),
      BusinessProfilePost.getMetricsSummary(projectId)
    ]);

    return res.json(ResponseUtil.success({
      available: true,
      status: 'available',
      reason: null,
      summary,
      ...listResult
    }));

  } catch (error) {
    LoggerUtil.error('Error fetching Business Profile posts', error, { projectId });
    return res.status(500).json(ResponseUtil.error('Failed to fetch local posts', 500));
  }
};

/**
 * POST /projects/:projectId/business-profile/posts
 *
 * Create and publish a new Google Business Profile Local Post.
 */
export const createBusinessProfilePostController = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;

  try {
    const project = await SeoProject.findById(projectId);
    if (!project) return res.status(404).json(ResponseUtil.error('Project not found', 404));
    if (project.user_id.toString() !== userId.toString()) {
      return res.status(403).json(ResponseUtil.accessDenied('Access denied'));
    }

    const googleConnection = await GoogleConnection.findActiveConnection(userId, projectId, 'business_profile');
    if (!googleConnection || !googleConnection.business_account_id || !googleConnection.business_location_id) {
      return res.status(400).json(ResponseUtil.error('Google Business Profile is not connected or no location selected', 400));
    }

    const {
      summary,
      topicType = 'STANDARD',
      callToAction,
      event,
      offer,
      mediaUrl
    } = req.body;

    // Validation
    if (!summary || typeof summary !== 'string' || !summary.trim()) {
      return res.status(400).json(ResponseUtil.error('Post text/summary is required', 400));
    }
    const trimmedSummary = summary.trim();
    if (trimmedSummary.length > MAX_SUMMARY_CHARS) {
      return res.status(400).json(ResponseUtil.error(`Post summary exceeds maximum limit of ${MAX_SUMMARY_CHARS} characters`, 400));
    }

    if (!VALID_TOPIC_TYPES.includes(topicType)) {
      return res.status(400).json(ResponseUtil.error(`Invalid topic type. Allowed: ${VALID_TOPIC_TYPES.join(', ')}`, 400));
    }

    if (callToAction && callToAction.actionType && callToAction.actionType !== 'ACTION_TYPE_UNSPECIFIED') {
      if (!VALID_CTA_TYPES.includes(callToAction.actionType)) {
        return res.status(400).json(ResponseUtil.error('Invalid call-to-action action type', 400));
      }
      if (callToAction.actionType !== 'CALL' && (!callToAction.url || !isValidUrl(callToAction.url))) {
        return res.status(400).json(ResponseUtil.error('Valid URL is required for the selected call-to-action button', 400));
      }
    }

    if (mediaUrl && !isValidUrl(mediaUrl)) {
      return res.status(400).json(ResponseUtil.error('Media URL must be a valid http or https URL', 400));
    }

    if (topicType === 'EVENT' || topicType === 'OFFER') {
      if (!event || !event.title || !event.schedule || !event.schedule.startDate || !event.schedule.endDate) {
        return res.status(400).json(ResponseUtil.error('Event title and start/end dates are required for event posts', 400));
      }
    }

    // Call Google Local Posts API
    const googlePost = await createLocalPost(
      googleConnection,
      googleConnection.business_account_id,
      googleConnection.business_location_id,
      {
        summary: trimmedSummary,
        topicType,
        callToAction,
        event,
        offer,
        mediaUrl
      }
    );

    // Save into local MongoDB for immediate availability
    const syncedAt = new Date();
    await BusinessProfilePost.bulkUpsertPosts(
      [googlePost],
      userId,
      projectId,
      googleConnection.business_account_id,
      googleConnection.business_location_id,
      syncedAt
    );

    const savedDoc = await BusinessProfilePost.findOne({
      project_id: projectId,
      google_post_id: googlePost.google_post_id
    }).lean();

    LoggerUtil.info('[AUDIT] LOCAL_POST_CREATE', {
      action: 'LOCAL_POST_CREATE',
      projectId,
      userId: userId.toString(),
      postId: googlePost.google_post_id,
      topicType
    });

    return res.status(201).json(ResponseUtil.success(savedDoc || googlePost, 'Local post created successfully', 201));

  } catch (error) {
    if (error instanceof LocalPostError) {
      LoggerUtil.warn('Google local post creation failed', {
        code: error.code,
        message: error.message,
        projectId
      });
      return res.status(error.httpStatus).json(ResponseUtil.error(error.message, error.httpStatus, error.code));
    }
    LoggerUtil.error('Unexpected error creating local post', error, { projectId });
    return res.status(500).json(ResponseUtil.error('Failed to create local post', 500));
  }
};

/**
 * PATCH /projects/:projectId/business-profile/posts/:postId
 *
 * Update an existing Google Business Profile Local Post.
 */
export const updateBusinessProfilePostController = async (req, res) => {
  const { projectId, postId } = req.params;
  const userId = req.user._id;

  try {
    const project = await SeoProject.findById(projectId);
    if (!project) return res.status(404).json(ResponseUtil.error('Project not found', 404));
    if (project.user_id.toString() !== userId.toString()) {
      return res.status(403).json(ResponseUtil.accessDenied('Access denied'));
    }

    const googleConnection = await GoogleConnection.findActiveConnection(userId, projectId, 'business_profile');
    if (!googleConnection || !googleConnection.business_account_id || !googleConnection.business_location_id) {
      return res.status(400).json(ResponseUtil.error('Google Business Profile is not connected or no location selected', 400));
    }

    const existingPost = await BusinessProfilePost.findOne({
      project_id: projectId,
      google_post_id: postId,
      is_deleted: false
    });

    if (!existingPost) {
      return res.status(404).json(ResponseUtil.error('Local post not found in this project', 404));
    }

    const {
      summary,
      callToAction,
      event,
      offer,
      mediaUrl
    } = req.body;

    const updatePayload = {};

    if (summary !== undefined) {
      if (typeof summary !== 'string' || !summary.trim()) {
        return res.status(400).json(ResponseUtil.error('Summary cannot be empty', 400));
      }
      if (summary.trim().length > MAX_SUMMARY_CHARS) {
        return res.status(400).json(ResponseUtil.error(`Summary exceeds ${MAX_SUMMARY_CHARS} characters`, 400));
      }
      updatePayload.summary = summary.trim();
    }

    if (callToAction !== undefined) {
      if (callToAction && callToAction.actionType && callToAction.actionType !== 'ACTION_TYPE_UNSPECIFIED') {
        if (!VALID_CTA_TYPES.includes(callToAction.actionType)) {
          return res.status(400).json(ResponseUtil.error('Invalid call-to-action action type', 400));
        }
        if (callToAction.actionType !== 'CALL' && (!callToAction.url || !isValidUrl(callToAction.url))) {
          return res.status(400).json(ResponseUtil.error('Valid URL is required for call-to-action button', 400));
        }
      }
      updatePayload.callToAction = callToAction;
    }

    if (event !== undefined) updatePayload.event = event;
    if (offer !== undefined) updatePayload.offer = offer;
    if (mediaUrl !== undefined) {
      if (mediaUrl && !isValidUrl(mediaUrl)) {
        return res.status(400).json(ResponseUtil.error('Media URL must be a valid http or https URL', 400));
      }
      updatePayload.mediaUrl = mediaUrl;
    }

    const googleUpdated = await updateLocalPost(
      googleConnection,
      googleConnection.business_account_id,
      googleConnection.business_location_id,
      postId,
      updatePayload
    );

    // Update local database record
    if (updatePayload.summary !== undefined) existingPost.summary = updatePayload.summary;
    if (updatePayload.callToAction !== undefined) existingPost.call_to_action = updatePayload.callToAction;
    if (updatePayload.event !== undefined) existingPost.event = updatePayload.event;
    if (updatePayload.offer !== undefined) existingPost.offer = updatePayload.offer;
    if (googleUpdated.media) existingPost.media = googleUpdated.media;
    existingPost.update_time = new Date();
    await existingPost.save();

    LoggerUtil.info('[AUDIT] LOCAL_POST_UPDATE', {
      action: 'LOCAL_POST_UPDATE',
      projectId,
      userId: userId.toString(),
      postId
    });

    return res.json(ResponseUtil.success(existingPost.toObject(), 'Local post updated successfully'));

  } catch (error) {
    if (error instanceof LocalPostError) {
      LoggerUtil.warn('Google local post update failed', {
        code: error.code,
        message: error.message,
        projectId,
        postId
      });
      return res.status(error.httpStatus).json(ResponseUtil.error(error.message, error.httpStatus, error.code));
    }
    LoggerUtil.error('Unexpected error updating local post', error, { projectId, postId });
    return res.status(500).json(ResponseUtil.error('Failed to update local post', 500));
  }
};

/**
 * DELETE /projects/:projectId/business-profile/posts/:postId
 *
 * Delete an existing Google Business Profile Local Post.
 */
export const deleteBusinessProfilePostController = async (req, res) => {
  const { projectId, postId } = req.params;
  const userId = req.user._id;

  try {
    const project = await SeoProject.findById(projectId);
    if (!project) return res.status(404).json(ResponseUtil.error('Project not found', 404));
    if (project.user_id.toString() !== userId.toString()) {
      return res.status(403).json(ResponseUtil.accessDenied('Access denied'));
    }

    const googleConnection = await GoogleConnection.findActiveConnection(userId, projectId, 'business_profile');
    if (!googleConnection || !googleConnection.business_account_id || !googleConnection.business_location_id) {
      return res.status(400).json(ResponseUtil.error('Google Business Profile is not connected or no location selected', 400));
    }

    const postDoc = await BusinessProfilePost.findOne({
      project_id: projectId,
      google_post_id: postId,
      is_deleted: false
    });

    if (!postDoc) {
      return res.status(404).json(ResponseUtil.error('Local post not found in this project', 404));
    }

    await deleteLocalPost(
      googleConnection,
      googleConnection.business_account_id,
      googleConnection.business_location_id,
      postId
    );

    postDoc.is_deleted = true;
    await postDoc.save();

    LoggerUtil.info('[AUDIT] LOCAL_POST_DELETE', {
      action: 'LOCAL_POST_DELETE',
      projectId,
      userId: userId.toString(),
      postId
    });

    return res.json(ResponseUtil.success({ deleted: true, postId }, 'Local post deleted successfully'));

  } catch (error) {
    if (error instanceof LocalPostError) {
      LoggerUtil.warn('Google local post delete failed', {
        code: error.code,
        message: error.message,
        projectId,
        postId
      });
      return res.status(error.httpStatus).json(ResponseUtil.error(error.message, error.httpStatus, error.code));
    }
    LoggerUtil.error('Unexpected error deleting local post', error, { projectId, postId });
    return res.status(500).json(ResponseUtil.error('Failed to delete local post', 500));
  }
};

/**
 * POST /projects/:projectId/business-profile/sync-posts
 *
 * Standalone manual sync of local posts + performance insights from Google.
 */
export const syncBusinessProfilePostsController = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;

  LoggerUtil.info('Business Profile posts sync starting', { projectId, userId: userId.toString() });

  try {
    const project = await SeoProject.findById(projectId);
    if (!project) return res.status(404).json(ResponseUtil.error('Project not found', 404));
    if (project.user_id.toString() !== userId.toString()) {
      return res.status(403).json(ResponseUtil.accessDenied('Access denied'));
    }

    const googleConnection = await GoogleConnection.findActiveConnection(userId, projectId, 'business_profile');
    if (!googleConnection) {
      return res.status(400).json(ResponseUtil.error('Google account not connected', 400));
    }
    if (!googleConnection.business_account_id || !googleConnection.business_location_id) {
      return res.status(400).json(ResponseUtil.error('Business Profile account/location not selected', 400));
    }

    const accountId = googleConnection.business_account_id;
    const locationId = googleConnection.business_location_id;

    const capability = await checkPostsCapability(googleConnection, accountId, locationId);
    if (capability.status !== 'available') {
      return res.json(ResponseUtil.success({
        postsCapability: capability.status,
        reason: capability.reason,
        postCount: 0
      }, 'Posts capability not available'));
    }

    const { posts, insights } = await fetchAllPosts(googleConnection, accountId, locationId);
    const syncedAt = new Date();

    const upsertResult = await BusinessProfilePost.bulkUpsertPosts(posts, userId, projectId, accountId, locationId, syncedAt);
    const deletedCount = await BusinessProfilePost.markStaleAsDeleted(projectId, syncedAt);

    LoggerUtil.info('Posts sync completed', {
      projectId,
      totalFetched: posts.length,
      upserted: upsertResult.upserted,
      modified: upsertResult.modified,
      staleDeleted: deletedCount,
      insightsRequested: insights.requested,
      insightsReceived: insights.received,
      insightsFailedBatches: insights.failedBatches
    });
    if (insights.failedBatches > 0) {
      LoggerUtil.warn('Posts synced but Google views/clicks could not be fetched for some posts', { projectId, ...insights });
    }

    return res.json(ResponseUtil.success({
      postsCapability: 'available',
      postCount: posts.length,
      syncedAt,
      // false = Google refused some/all views/clicks requests; stored numbers were left untouched
      metricsSynced: insights.failedBatches === 0,
      insights
    }, 'Posts sync completed'));

  } catch (error) {
    LoggerUtil.error('Unexpected error during posts sync', error, { projectId, userId });
    return res.status(500).json(ResponseUtil.error('An unexpected error occurred during posts sync', 500));
  }
};

/**
 * POST /projects/:projectId/business-profile/posts/media
 *
 * Dedicated image upload endpoint for Google Business Profile posts.
 * Validates authenticated user, project ownership, active Google connection,
 * real image content (via sharp), and safely stores file under storage/business_profile_posts/<projectId>/
 */
export const uploadBusinessProfilePostMediaController = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;

  try {
    const project = await SeoProject.findById(projectId);
    if (!project) return res.status(404).json(ResponseUtil.error('Project not found', 404));
    if (project.user_id.toString() !== userId.toString()) {
      return res.status(403).json(ResponseUtil.accessDenied('Access denied'));
    }

    const googleConnection = await GoogleConnection.findActiveConnection(userId, projectId, 'business_profile');
    if (!googleConnection || !googleConnection.business_account_id || !googleConnection.business_location_id) {
      return res.status(400).json(ResponseUtil.error('Google Business Profile is not connected or no location selected', 400));
    }

    if (!req.file || !req.file.buffer) {
      return res.status(400).json(ResponseUtil.error('Please select an image.', 400, 'MEDIA_REQUIRED'));
    }

    const validation = await validatePostImage(req.file.buffer);
    if (validation.error) {
      const status = validation.error.code === 'MEDIA_TOO_LARGE' ? 413 : 400;
      return res.status(status).json(ResponseUtil.error(validation.error.message, status, validation.error.code));
    }

    const uploaded = await uploadPostImage({
      buffer: req.file.buffer,
      projectId,
      extension: validation.extension,
      originalFilename: req.file.originalname
    });

    LoggerUtil.info('[AUDIT] LOCAL_POST_MEDIA_UPLOAD', {
      action: 'LOCAL_POST_MEDIA_UPLOAD',
      projectId,
      userId: userId.toString(),
      filename: uploaded.filename,
      size: uploaded.size
    });

    return res.status(201).json(ResponseUtil.success({
      url: uploaded.url,
      filename: uploaded.filename,
      mimeType: validation.mimeType,
      size: uploaded.size,
      width: validation.width,
      height: validation.height
    }, 'Image uploaded successfully', 201));

  } catch (error) {
    LoggerUtil.error('Unexpected error uploading post media', error, { projectId });
    return res.status(500).json(ResponseUtil.error('Failed to upload image.', 500, 'MEDIA_UPLOAD_FAILED'));
  }
};

/**
 * DELETE /projects/:projectId/business-profile/posts/media
 *
 * Safe cleanup of an uploaded image if the user removes it before publishing.
 */
export const deleteBusinessProfilePostMediaController = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;
  const { url } = req.body || {};

  try {
    const project = await SeoProject.findById(projectId);
    if (!project) return res.status(404).json(ResponseUtil.error('Project not found', 404));
    if (project.user_id.toString() !== userId.toString()) {
      return res.status(403).json(ResponseUtil.accessDenied('Access denied'));
    }

    if (url) {
      await deletePostImageByUrl(url);
    }

    return res.json(ResponseUtil.success({ deleted: true }, 'Media removed successfully'));
  } catch (error) {
    LoggerUtil.warn('Failed to delete unreferenced post media', { message: error.message, projectId });
    return res.json(ResponseUtil.success({ deleted: false }, 'Media removed'));
  }
};

