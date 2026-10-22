import {
  GBP_LEGACY_API,
  getAuthenticatedHttpClient,
  withRetry,
  logAxiosError,
  getCacheKey
} from './businessProfileService.js';

/**
 * Business Profile Media (Photos/Videos) Service
 *
 * Media items (photos/videos) live exclusively on the legacy My Business API
 * v4 (mybusiness.googleapis.com/v4) - there is no media endpoint on the
 * current Business Information/Performance v1 services. Same access gate as
 * reviews (businessProfileReviewService.js): the legacy API must be enabled
 * for the project and, per Google's 2024 policy, this host is generally
 * allowlist-restricted for third-party developer projects. Mirrors that
 * file's capability-probe pattern rather than assuming a fixed answer.
 */

const CAPABILITY_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour, same as reviews capability
const MEDIA_PAGE_SIZE = 100; // Google's documented default (max 2500)
const MAX_PAGES = 50; // hard ceiling (5,000 media items) - protects against a pageToken loop bug on Google's side

/**
 * Classify why media access failed. Mirrors
 * businessProfileReviewService.classifyReviewsError() exactly - same host,
 * same failure modes (API not enabled vs allowlist-gated vs rate-limited).
 */
function classifyMediaError(error) {
  const status = error.response?.status;
  const googleError = error.response?.data?.error;
  const reason = googleError?.details?.find(d => d.reason)?.reason;

  if (status === 403 && reason === 'SERVICE_DISABLED') {
    return {
      status: 'api_disabled',
      reason: 'The legacy Google My Business API is not enabled for this application in Google Cloud Console.'
    };
  }
  if (status === 403) {
    return {
      status: 'restricted',
      reason: 'Google does not provide media access for this application. Media access requires Google approval (allowlist) under their 2024 API policy.'
    };
  }
  if (status === 429) {
    return {
      status: 'rate_limited',
      reason: 'Google Business Profile API rate limit reached. Will retry on next sync.'
    };
  }
  if (status === 401) {
    return {
      status: 'error',
      reason: 'Authentication failed - the Google connection may need to be reconnected.'
    };
  }
  return {
    status: 'error',
    reason: googleError?.message || error.message || 'Unknown error contacting Google Business Profile API.'
  };
}

// Separate cache from businessProfileService's cache Map, same reasoning as
// businessProfileReviewService's capabilityCache: plain objects, longer TTL.
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
 * Probe whether this connection can actually list media, without assuming a
 * fixed answer. Cached for 1 hour, never cached as a permanent "no".
 */
export async function checkMediaCapability(googleConnection, accountId, locationId) {
  const cacheKey = getCacheKey('media_capability', googleConnection._id, accountId, locationId);
  const cached = getCachedCapability(cacheKey);
  if (cached) return cached;

  let result;
  try {
    const client = await getAuthenticatedHttpClient(googleConnection, GBP_LEGACY_API);
    await client.get(`accounts/${accountId}/locations/${locationId}/media`, {
      params: { pageSize: 1 }
    });
    result = { status: 'available', reason: null };
  } catch (error) {
    logAxiosError('checkMediaCapability', error);
    result = classifyMediaError(error);
  }

  const withTimestamp = { ...result, checked_at: new Date() };
  cacheCapability(cacheKey, withTimestamp);
  return withTimestamp;
}

function normalizeMediaItem(item) {
  // item.name = "accounts/{a}/locations/{l}/media/{mediaKey}"
  const mediaKey = item.name?.split('/').pop();

  return {
    google_media_key: mediaKey,
    google_resource_name: item.name,
    category: item.locationAssociation?.category || 'ADDITIONAL',
    media_format: item.mediaFormat || 'PHOTO',
    google_url: item.googleUrl || null,
    thumbnail_url: item.thumbnailUrl || null,
    width_px: item.dimensions?.widthPixels || null,
    height_px: item.dimensions?.heightPixels || null,
    view_count: item.insights?.viewCount ? Number(item.insights.viewCount) : 0,
    description: item.description || null,
    is_customer_media: !!item.attribution,
    create_time: item.createTime ? new Date(item.createTime) : new Date()
  };
}

/**
 * Fetch ALL media items for a location via v4 media.list, paginating through
 * every page. Mirrors fetchAllReviews()'s pagination shape exactly (fail on
 * first page, keep partial results from a later-page failure).
 */
export async function fetchAllMedia(googleConnection, accountId, locationId) {
  const client = await getAuthenticatedHttpClient(googleConnection, GBP_LEGACY_API);

  let allMedia = [];
  let pageToken = undefined;
  let totalMediaItemCount = null;
  let page = 0;

  do {
    page++;
    const response = await withRetry(() =>
      client.get(`accounts/${accountId}/locations/${locationId}/media`, {
        params: {
          pageSize: MEDIA_PAGE_SIZE,
          pageToken
        }
      })
    );

    const data = response.data || {};
    if (typeof data.totalMediaItemCount === 'number') totalMediaItemCount = data.totalMediaItemCount;

    const normalized = (data.mediaItems || []).map(normalizeMediaItem);
    allMedia = allMedia.concat(normalized);

    pageToken = data.nextPageToken || undefined;
  } while (pageToken && page < MAX_PAGES);

  return { media: allMedia, totalMediaItemCount, pagesFetched: page };
}

export default {
  checkMediaCapability,
  fetchAllMedia
};
