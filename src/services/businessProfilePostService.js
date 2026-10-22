import {
  GBP_LEGACY_API,
  getAuthenticatedHttpClient,
  withRetry,
  logAxiosError,
  getCacheKey
} from './businessProfileService.js';
import { LoggerUtil } from '../utils/LoggerUtil.js';

/**
 * Business Profile Local Posts Service
 *
 * Implements Google My Business API v4 Local Posts integration:
 * - accounts.locations.localPosts.list
 * - accounts.locations.localPosts.create
 * - accounts.locations.localPosts.patch
 * - accounts.locations.localPosts.delete
 * - accounts.locations.localPosts.reportInsights
 *
 * Like reviews and media, localPosts live on the legacy v4 host
 * (https://mybusiness.googleapis.com/v4) and requires the business.manage
 * OAuth scope and an allowlisted or enabled Google My Business API in Google Cloud.
 */

const CAPABILITY_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const POSTS_PAGE_SIZE = 100;
const MAX_PAGES = 50;

/**
 * Custom error class for Local Post operations.
 */
export class LocalPostError extends Error {
  constructor(message, code, httpStatus = 400, retryable = false, details = null) {
    super(message);
    this.name = 'LocalPostError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
    this.details = details;
  }
}

/**
 * Classify Google API errors into user-friendly status and reasons.
 */
export function classifyPostsError(error) {
  const status = error.response?.status;
  const googleError = error.response?.data?.error;
  const reason = googleError?.details?.find(d => d.reason)?.reason;

  if (status === 403 && reason === 'SERVICE_DISABLED') {
    return {
      status: 'api_disabled',
      reason: 'The Google My Business API is not enabled for this project in Google Cloud Console.'
    };
  }
  if (status === 403) {
    return {
      status: 'restricted',
      reason: 'Google does not grant post publishing/management access for this application under current API permissions.'
    };
  }
  if (status === 429) {
    return {
      status: 'rate_limited',
      reason: 'Google Business Profile API rate limit reached. Please wait before retrying.'
    };
  }
  if (status === 401) {
    return {
      status: 'error',
      reason: 'Authentication failed. Please reconnect your Google account.'
    };
  }
  return {
    status: 'error',
    reason: googleError?.message || error.message || 'Error communicating with Google Business Profile API.'
  };
}

const capabilityCache = new Map();
function cacheCapability(key, value) {
  capabilityCache.set(key, { value, timestamp: Date.now() });
}
function getCachedCapability(key) {
  const entry = capabilityCache.get(key);
  if (entry && (Date.now() - entry.timestamp) < CAPABILITY_CACHE_TTL_MS) return entry.value;
  return null;
}

/**
 * Probe whether the connected Google account has access to list/manage local posts.
 */
export async function checkPostsCapability(googleConnection, accountId, locationId) {
  const cacheKey = getCacheKey('posts_capability', googleConnection._id, accountId, locationId);
  const cached = getCachedCapability(cacheKey);
  if (cached) return cached;

  let result;
  try {
    const client = await getAuthenticatedHttpClient(googleConnection, GBP_LEGACY_API);
    await client.get(`accounts/${accountId}/locations/${locationId}/localPosts`, {
      params: { pageSize: 1 }
    });
    result = { status: 'available', reason: null };
  } catch (error) {
    logAxiosError('checkPostsCapability', error);
    result = classifyPostsError(error);
  }

  const withTimestamp = { ...result, checked_at: new Date() };
  cacheCapability(cacheKey, withTimestamp);
  return withTimestamp;
}

/**
 * Normalizes a raw Google localPost item into our document structure.
 */
export function normalizeGooglePost(item) {
  const postId = item.name ? item.name.split('/').pop() : item.localPostId;

  return {
    google_post_id: postId,
    google_resource_name: item.name,
    language_code: item.languageCode || 'en-US',
    summary: item.summary || '',
    topic_type: item.topicType || 'STANDARD',
    alert_type: item.alertType || 'ALERT_TYPE_UNSPECIFIED',
    call_to_action: item.callToAction ? {
      action_type: item.callToAction.actionType || 'ACTION_TYPE_UNSPECIFIED',
      url: item.callToAction.url || null
    } : { action_type: 'ACTION_TYPE_UNSPECIFIED', url: null },
    event: item.event ? {
      title: item.event.title || null,
      schedule: item.event.schedule ? {
        start_date: item.event.schedule.startDate || null,
        start_time: item.event.schedule.startTime || null,
        end_date: item.event.schedule.endDate || null,
        end_time: item.event.schedule.endTime || null
      } : null
    } : null,
    offer: item.offer ? {
      coupon_code: item.offer.couponCode || null,
      redeem_online_url: item.offer.redeemOnlineUrl || null,
      terms_conditions: item.offer.termsConditions || null
    } : null,
    media: (item.media || []).map(m => ({
      media_format: m.mediaFormat || 'PHOTO',
      source_url: m.sourceUrl || null,
      google_url: m.googleUrl || null
    })),
    state: item.state || 'LIVE',
    rejection_reason: item.rejectionReason || null,
    search_url: item.searchUrl || null,
    create_time: item.createTime ? new Date(item.createTime) : new Date(),
    update_time: item.updateTime ? new Date(item.updateTime) : null
  };
}

// Google caps a reportInsights call at 100 posts and the time range at 18 months.
const INSIGHTS_BATCH_SIZE = 50;
const INSIGHTS_WINDOW_DAYS = 540; // ~18 months, the most Google allows

/** The documented ReportLocalPostInsightsRequest body (accounts.locations.localPosts:reportInsights). */
export function buildInsightsRequest(localPostNames, now = new Date()) {
  const start = new Date(now.getTime() - INSIGHTS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return {
    localPostNames,
    basicRequest: {
      metricRequests: [{ metric: 'ALL', options: ['AGGREGATED_TOTAL'] }],
      timeRange: { startTime: start.toISOString(), endTime: now.toISOString() }
    }
  };
}

/** Safe, credential-free description of a Google failure for logs. */
function describeGoogleError(error) {
  return {
    status: error.response?.status ?? null,
    googleStatus: error.response?.data?.error?.status ?? null,
    message: error.response?.data?.error?.message || error.message
  };
}

/**
 * Fetch insights/metrics for local posts from Google.
 * Endpoint: POST accounts/{accountId}/locations/{locationId}/localPosts:reportInsights
 *
 * Returns what was actually measured AND whether anything failed, so a failed
 * request is never mistaken for "0 views": posts missing from `insights` are
 * UNKNOWN, not zero.
 *
 * @returns {Promise<{ insights: Object, requested: number, received: number, failedBatches: number, totalBatches: number }>}
 */
export async function fetchLocalPostInsightsReport(googleConnection, accountId, locationId, localPostNames, now = new Date()) {
  const names = localPostNames || [];
  const report = { insights: {}, requested: names.length, received: 0, failedBatches: 0, totalBatches: 0 };
  if (!names.length) return report;

  let client;
  try {
    client = await getAuthenticatedHttpClient(googleConnection, GBP_LEGACY_API);
  } catch (error) {
    LoggerUtil.warn('Local post insights skipped: could not authenticate with Google', { message: error.message });
    report.totalBatches = report.failedBatches = Math.ceil(names.length / INSIGHTS_BATCH_SIZE);
    return report;
  }

  for (let i = 0; i < names.length; i += INSIGHTS_BATCH_SIZE) {
    const batch = names.slice(i, i + INSIGHTS_BATCH_SIZE);
    report.totalBatches += 1;
    try {
      const response = await withRetry(() =>
        client.post(`accounts/${accountId}/locations/${locationId}/localPosts:reportInsights`, buildInsightsRequest(batch, now))
      );

      for (const postMetric of response.data?.localPostMetrics || []) {
        const postId = postMetric.localPostName ? postMetric.localPostName.split('/').pop() : null;
        if (!postId) continue;

        let viewsSearch = 0;
        let actionsCta = 0;
        for (const val of postMetric.metricValues || []) {
          if (val.metric === 'LOCAL_POST_VIEWS_SEARCH') viewsSearch = Number(val.totalValue?.value) || 0;
          else if (val.metric === 'LOCAL_POST_ACTIONS_CALL_TO_ACTION') actionsCta = Number(val.totalValue?.value) || 0;
        }
        report.insights[postId] = {
          views_search: viewsSearch,
          actions_call_to_action: actionsCta,
          metrics_last_synced_at: new Date()
        };
        report.received += 1;
      }
    } catch (batchErr) {
      report.failedBatches += 1;
      LoggerUtil.warn('Failed to fetch insights for local posts batch', { batchCount: batch.length, ...describeGoogleError(batchErr) });
    }
  }
  return report;
}

/** Back-compatible wrapper: just the per-post metrics map. */
export async function fetchLocalPostInsights(googleConnection, accountId, locationId, localPostNames) {
  return (await fetchLocalPostInsightsReport(googleConnection, accountId, locationId, localPostNames)).insights;
}

/**
 * Fetch all local posts for a location via v4 localPosts.list with pagination.
 */
export async function fetchAllPosts(googleConnection, accountId, locationId) {
  const client = await getAuthenticatedHttpClient(googleConnection, GBP_LEGACY_API);

  let allPosts = [];
  let pageToken = undefined;
  let page = 0;

  do {
    page++;
    const response = await withRetry(() =>
      client.get(`accounts/${accountId}/locations/${locationId}/localPosts`, {
        params: {
          pageSize: POSTS_PAGE_SIZE,
          pageToken
        }
      })
    );

    const data = response.data || {};
    const normalized = (data.localPosts || []).map(normalizeGooglePost);
    allPosts = allPosts.concat(normalized);

    pageToken = data.nextPageToken;
    if (pageToken && page >= MAX_PAGES) {
      LoggerUtil.warn('Reached MAX_PAGES cap during local posts fetch', { page, count: allPosts.length });
      break;
    }
  } while (pageToken);

  // Enrich with insight metrics. Posts Google did not report on keep NO metric
  // fields, so the upsert leaves their stored numbers alone (unknown, not zero).
  let insightsReport = { requested: 0, received: 0, failedBatches: 0, totalBatches: 0 };
  if (allPosts.length > 0) {
    const resourceNames = allPosts.map(p => p.google_resource_name).filter(Boolean);
    const { insights, ...status } = await fetchLocalPostInsightsReport(googleConnection, accountId, locationId, resourceNames);
    insightsReport = status;

    for (const post of allPosts) {
      const metric = insights[post.google_post_id];
      if (metric) {
        post.views_search = metric.views_search;
        post.actions_call_to_action = metric.actions_call_to_action;
        post.metrics_last_synced_at = metric.metrics_last_synced_at;
      }
    }
  }

  return { posts: allPosts, insights: insightsReport };
}

/**
 * Create a new Local Post on Google Business Profile.
 */
export async function createLocalPost(googleConnection, accountId, locationId, postData) {
  const client = await getAuthenticatedHttpClient(googleConnection, GBP_LEGACY_API);

  const googlePayload = {
    languageCode: postData.languageCode || 'en-US',
    summary: postData.summary,
    topicType: postData.topicType || 'STANDARD'
  };

  if (postData.callToAction && postData.callToAction.actionType && postData.callToAction.actionType !== 'ACTION_TYPE_UNSPECIFIED') {
    googlePayload.callToAction = {
      actionType: postData.callToAction.actionType,
      url: postData.callToAction.url
    };
  }

  if (postData.event && (postData.topicType === 'EVENT' || postData.topicType === 'OFFER')) {
    googlePayload.event = postData.event;
  }

  if (postData.offer && postData.topicType === 'OFFER') {
    googlePayload.offer = postData.offer;
  }

  if (postData.mediaUrl) {
    googlePayload.media = [
      {
        mediaFormat: 'PHOTO',
        sourceUrl: postData.mediaUrl
      }
    ];
  } else if (Array.isArray(postData.media) && postData.media.length > 0) {
    googlePayload.media = postData.media;
  }

  try {
    const response = await client.post(`accounts/${accountId}/locations/${locationId}/localPosts`, googlePayload);
    return normalizeGooglePost(response.data);
  } catch (error) {
    logAxiosError('createLocalPost', error);
    mapGooglePostError(error, 'CREATE');
  }
}

/**
 * Update an existing Local Post on Google Business Profile.
 */
export async function updateLocalPost(googleConnection, accountId, locationId, postId, postData) {
  const client = await getAuthenticatedHttpClient(googleConnection, GBP_LEGACY_API);

  const updateMaskFields = [];
  const googlePayload = {};

  if (postData.summary !== undefined) {
    googlePayload.summary = postData.summary;
    updateMaskFields.push('summary');
  }

  if (postData.callToAction !== undefined) {
    if (postData.callToAction && postData.callToAction.actionType && postData.callToAction.actionType !== 'ACTION_TYPE_UNSPECIFIED') {
      googlePayload.callToAction = {
        actionType: postData.callToAction.actionType,
        url: postData.callToAction.url
      };
    } else {
      googlePayload.callToAction = null;
    }
    updateMaskFields.push('callToAction');
  }

  if (postData.event !== undefined) {
    googlePayload.event = postData.event;
    updateMaskFields.push('event');
  }

  if (postData.offer !== undefined) {
    googlePayload.offer = postData.offer;
    updateMaskFields.push('offer');
  }

  if (postData.mediaUrl !== undefined) {
    googlePayload.media = postData.mediaUrl ? [{ mediaFormat: 'PHOTO', sourceUrl: postData.mediaUrl }] : [];
    updateMaskFields.push('media');
  } else if (postData.media !== undefined) {
    googlePayload.media = postData.media;
    updateMaskFields.push('media');
  }

  if (!updateMaskFields.length) {
    throw new LocalPostError('No fields provided to update', 'NO_FIELDS_TO_UPDATE', 400);
  }

  const updateMask = updateMaskFields.join(',');

  try {
    const response = await client.patch(
      `accounts/${accountId}/locations/${locationId}/localPosts/${postId}?updateMask=${updateMask}`,
      googlePayload
    );
    return normalizeGooglePost(response.data);
  } catch (error) {
    logAxiosError('updateLocalPost', error);
    mapGooglePostError(error, 'UPDATE');
  }
}

/**
 * Delete a Local Post from Google Business Profile.
 */
export async function deleteLocalPost(googleConnection, accountId, locationId, postId) {
  const client = await getAuthenticatedHttpClient(googleConnection, GBP_LEGACY_API);

  try {
    await client.delete(`accounts/${accountId}/locations/${locationId}/localPosts/${postId}`);
    return { success: true };
  } catch (error) {
    logAxiosError('deleteLocalPost', error);
    mapGooglePostError(error, 'DELETE');
  }
}

/**
 * Helper to map Google API errors to typed LocalPostError.
 */
function mapGooglePostError(error, actionName) {
  const status = error.response?.status;
  const googleErr = error.response?.data?.error;
  const message = googleErr?.message || error.message || `Failed to ${actionName.toLowerCase()} local post`;
  const code = googleErr?.status || (status === 404 ? 'NOT_FOUND' : status === 403 ? 'PERMISSION_DENIED' : status === 429 ? 'RATE_LIMITED' : 'GOOGLE_API_ERROR');

  if (status === 401) {
    throw new LocalPostError('Google authentication failed. Please reconnect your account.', 'GOOGLE_AUTH_FAILED', 401);
  }
  if (status === 403) {
    throw new LocalPostError('Permission denied on Google Business Profile.', 'GOOGLE_PERMISSION_DENIED', 403);
  }
  if (status === 404) {
    throw new LocalPostError('Local post not found on Google Business Profile.', 'POST_NOT_FOUND', 404);
  }
  if (status === 429) {
    throw new LocalPostError('Google API rate limit reached. Please wait a moment and try again.', 'GOOGLE_RATE_LIMITED', 429, true);
  }
  if (status >= 500) {
    throw new LocalPostError('Google Business Profile service is temporarily unavailable.', 'GOOGLE_UNAVAILABLE', 503, true);
  }

  throw new LocalPostError(message, code, status || 400);
}
