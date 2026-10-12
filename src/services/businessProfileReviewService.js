import axios from 'axios';
import { getAccessTokenWithoutStatusChange } from './googleApiService.js';
import {
  GBP_BUSINESS_INFO_API,
  GBP_LEGACY_API,
  LOCATION_READ_MASK,
  getAuthenticatedHttpClient,
  withRetry,
  logAxiosError,
  getCacheKey
} from './businessProfileService.js';

/**
 * Business Profile Review Service
 *
 * Responsibilities: business metadata, reviews (with capability detection,
 * pagination, retry, rate-limit handling), and incremental sync into
 * BusinessProfileReview/BusinessProfileMetadata.
 *
 * Reviews live exclusively on the legacy My Business API v4
 * (mybusiness.googleapis.com/v4) - there is no reviews endpoint on the
 * current Business Information API v1, and Google gates general developer
 * access to it (project must have the legacy API enabled in Google Cloud
 * Console, AND be allowlisted for reviews.list per Google's 2024 policy).
 * Average rating / review count are NOT exposed as fields on any current
 * API location resource - they only ever come from aggregating the reviews
 * list response itself (`averageRating`/`totalReviewCount` on the v4
 * ListReviewsResponse). This means rating/count share the exact same
 * capability gate as reviews - if reviews are unavailable, rating is too.
 *
 * checkReviewsCapability() probes this ONCE (cached) rather than assuming
 * a fixed answer, so access being granted later (API enabled, allowlist
 * approved) is picked up automatically on the next sync with no code change.
 */

const CAPABILITY_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour - capability rarely changes
const REVIEW_PAGE_SIZE = 50; // Google's documented max for reviews.list

const STAR_RATING_MAP = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

/**
 * Classify why reviews access failed, from the actual Google error shape -
 * never guessed. Distinguishes "API not enabled" (a Google Cloud Console
 * config action) from "allowlist-gated" (a Google approval process) from
 * genuine rate limiting (retry later, not a capability problem) from a
 * generic error, because the frontend and the sync logging need different
 * messages for each.
 */
function classifyReviewsError(error) {
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
      reason: 'Google does not provide review access for this application. Review access requires Google approval (allowlist) under their 2024 API policy.'
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

/**
 * Probe whether this connection can actually list reviews, without
 * assuming a fixed answer. Cached for 1 hour (capability status changes
 * rarely - there's no value in re-probing on every page load) but never
 * cached as a permanent "no", so access being granted is picked up on the
 * next sync automatically.
 */
// Capability results use their own cache (separate from businessProfileService's
// cache Map) for two reasons: they're plain objects, not the arrays
// setCachedData()'s "don't cache empty results" guard is designed around;
// and a 1-hour TTL is intentionally different from the general 10-minute
// TTL - capability status is far more stable than accounts/locations data.
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
 * Probe whether this connection can actually list reviews, without
 * assuming a fixed answer. Cached for 1 hour (capability status changes
 * rarely - there's no value in re-probing on every page load) but never
 * cached as a permanent "no", so access being granted is picked up on the
 * next sync automatically.
 */
export async function checkReviewsCapability(googleConnection, accountId, locationId) {
  const cacheKey = getCacheKey('reviews_capability', googleConnection._id, accountId, locationId);
  const cached = getCachedCapability(cacheKey);
  if (cached) return cached;

  let result;
  try {
    const client = await getAuthenticatedHttpClient(googleConnection, GBP_LEGACY_API);
    await client.get(`accounts/${accountId}/locations/${locationId}/reviews`, {
      params: { pageSize: 1 }
    });
    result = { status: 'available', reason: null };
  } catch (error) {
    logAxiosError('checkReviewsCapability', error);
    result = classifyReviewsError(error);
  }

  const withTimestamp = { ...result, checked_at: new Date() };
  cacheCapability(cacheKey, withTimestamp);
  return withTimestamp;
}

/**
 * Fetch business metadata (name, category, phone, website, address) from
 * the current, non-restricted Business Information API v1. This works
 * regardless of reviews capability - proven live against this app's actual
 * connection during the forensic investigation for this feature.
 */
export async function fetchBusinessMetadata(googleConnection, locationId) {
  const client = await getAuthenticatedHttpClient(googleConnection, GBP_BUSINESS_INFO_API);

  const response = await withRetry(() =>
    client.get(`/locations/${locationId}`, {
      params: { readMask: `${LOCATION_READ_MASK},phoneNumbers` }
    })
  );

  const location = response.data;
  return {
    business_name: location.title || null,
    category: location.categories?.primaryCategory?.displayName || null,
    phone: location.phoneNumbers?.primaryPhone || null,
    website: location.websiteUri || null,
    address: location.storefrontAddress?.addressLines?.join(', ') || null
  };
}

/**
 * Fetch ALL reviews for a location via v4 reviews.list, paginating through
 * every page (Google returns up to REVIEW_PAGE_SIZE per call + nextPageToken).
 * Retries transient failures via the shared withRetry() wrapper. Returns
 * normalized review objects ready for BusinessProfileReview.bulkUpsertReviews(),
 * plus Google's own averageRating/totalReviewCount from the response root
 * (the only place this data exists - see module docstring).
 *
 * Any page failure (after withRetry) THROWS and nothing is returned - the
 * caller then stores nothing and deletes nothing, so a failed or partial
 * fetch can never be mistaken for "these reviews were removed".
 *
 * Completeness (this is what keeps the stored count honest against Google's
 * `totalReviewCount`):
 *  - Reviews are de-duplicated by id. The list is ordered by updateTime, so a
 *    review edited or added WHILE we page can shift into a page we already read
 *    (a duplicate) or out of the page we are about to read (a miss).
 *  - If fewer distinct reviews than Google's own total came back, ONE more
 *    full pass is made and the two passes are merged by id, which recovers
 *    reviews that slipped between pages.
 *  - `complete` is false when a shortfall remains or the page ceiling was hit.
 *    The caller must not treat unseen reviews as deleted in that case.
 */
const MAX_REVIEW_PAGES = 200; // hard ceiling (10,000 reviews) - protects against a pageToken loop bug on Google's side

async function fetchReviewPass(client, accountId, locationId) {
  const byId = new Map();
  let pageToken = undefined;
  let averageRating = null;
  let totalReviewCount = null;
  let pages = 0;
  let skipped = 0;
  let raw = 0;
  let duplicates = 0;

  do {
    pages++;
    const response = await withRetry(() =>
      client.get(`accounts/${accountId}/locations/${locationId}/reviews`, {
        params: {
          pageSize: REVIEW_PAGE_SIZE,
          pageToken,
          orderBy: 'updateTime desc'
        }
      })
    );

    const data = response.data || {};
    if (typeof data.averageRating === 'number') averageRating = data.averageRating;
    if (typeof data.totalReviewCount === 'number') totalReviewCount = data.totalReviewCount;

    for (const item of data.reviews || []) {
      raw++;
      const review = normalizeReview(item);
      if (!review.google_review_id) { skipped++; continue; } // cannot be keyed -> cannot be stored
      if (byId.has(review.google_review_id)) duplicates++;
      byId.set(review.google_review_id, review);
    }

    pageToken = data.nextPageToken || undefined;
  } while (pageToken && pages < MAX_REVIEW_PAGES);

  return { byId, averageRating, totalReviewCount, pages, skipped, raw, duplicates, truncated: !!pageToken };
}

export async function fetchAllReviews(googleConnection, accountId, locationId, { client: providedClient } = {}) {
  // `client` exists only for read-only diagnostics that must not go through the
  // shared token manager (a failed refresh there can flip a connection to `expired`).
  const client = providedClient || await getAuthenticatedHttpClient(googleConnection, GBP_LEGACY_API);

  const first = await fetchReviewPass(client, accountId, locationId);
  let merged = first.byId;
  let { averageRating, totalReviewCount } = first;
  let pagesFetched = first.pages;
  let truncated = first.truncated;
  let retried = false;
  let rawFetched = first.raw;
  let duplicatesWithinPass = first.duplicates;
  let skippedWithoutId = first.skipped;

  const short = () => typeof totalReviewCount === 'number' && merged.size < totalReviewCount;
  if (short() && !truncated) {
    retried = true;
    const second = await fetchReviewPass(client, accountId, locationId);
    merged = new Map([...merged, ...second.byId]); // later pass wins: it is the fresher copy
    pagesFetched += second.pages;
    rawFetched += second.raw;
    // Same records are seen again on a second pass, so report the worse single pass, not a sum.
    duplicatesWithinPass = Math.max(duplicatesWithinPass, second.duplicates);
    skippedWithoutId = Math.max(skippedWithoutId, second.skipped);
    truncated = second.truncated;
    if (typeof second.averageRating === 'number') averageRating = second.averageRating;
    if (typeof second.totalReviewCount === 'number') totalReviewCount = second.totalReviewCount;
  }

  const missingCount = typeof totalReviewCount === 'number' ? Math.max(0, totalReviewCount - merged.size) : 0;
  return {
    reviews: [...merged.values()],
    averageRating,
    totalReviewCount,
    pagesFetched,
    // Authoritative for "did we see everything Google says exists".
    complete: !truncated && missingCount === 0,
    missingCount,
    truncated,
    retried,
    // Counts for the sync reconciliation log (see the sync in businessProfileController):
    rawFetched,                  // review records Google returned across every page and pass
    uniqueFetched: merged.size,  // distinct review ids among them
    duplicatesWithinPass,        // the same id returned twice inside ONE pass (page shift); worst single pass
    skippedWithoutId             // records with no usable id (cannot be stored)
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Review reply (WRITE) - PUT accounts/{a}/locations/{l}/reviews/{id}/reply
// Same v4 host and same `business.manage` scope the reviews READ already uses.
// Google: "only valid if the specified location is verified"; comment max 4096
// bytes; the response ReviewReply carries reviewReplyState PENDING|APPROVED|REJECTED.
// ─────────────────────────────────────────────────────────────────────────

export const MAX_REPLY_BYTES = 4096;
const REPLY_TIMEOUT_MS = 20000;

/** Safe, user-facing failure. Never carries tokens or raw Google bodies. */
export class ReviewReplyError extends Error {
  constructor(code, httpStatus, message, extra = {}) {
    super(message);
    this.name = 'ReviewReplyError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = !!extra.retryable;
    this.googleStatus = extra.googleStatus ?? null;   // HTTP status Google answered with
    this.googleCode = extra.googleCode ?? null;       // e.g. PERMISSION_DENIED / INVALID_ARGUMENT
    this.existingReply = extra.existingReply ?? null; // set for ALREADY_REPLIED
  }
}

function classifyReplyError(error) {
  const googleStatus = error.response?.status;
  const googleError = error.response?.data?.error;
  const googleCode = googleError?.status || googleError?.details?.find((d) => d.reason)?.reason || null;
  const extra = { googleStatus, googleCode };

  if (!error.response) {
    // timeout / DNS / connection reset - nothing reached Google or no answer came back
    return new ReviewReplyError('GOOGLE_UNAVAILABLE', 503, 'Could not reach Google. Please try again.', { ...extra, retryable: true });
  }
  if (googleStatus === 401) {
    return new ReviewReplyError('GOOGLE_AUTH_FAILED', 502, 'Your Google Business Profile connection may need to be re-authorized.', extra);
  }
  if (googleStatus === 403) {
    return new ReviewReplyError('GOOGLE_PERMISSION_DENIED', 502, 'Your Google account does not have permission to reply to this review.', extra);
  }
  if (googleStatus === 404) {
    return new ReviewReplyError('REVIEW_NOT_FOUND', 404, 'This review no longer exists on Google.', extra);
  }
  if (googleStatus === 429) {
    return new ReviewReplyError('GOOGLE_RATE_LIMITED', 429, 'Google is limiting requests right now. Please wait a moment and try again.', { ...extra, retryable: true });
  }
  if (googleStatus >= 500) {
    return new ReviewReplyError('GOOGLE_UNAVAILABLE', 503, 'Google is temporarily unavailable. Please try again.', { ...extra, retryable: true });
  }
  return new ReviewReplyError('GOOGLE_REJECTED', 422, 'Google rejected this reply.', extra);
}

function reviewResourcePath(accountId, locationId, reviewId) {
  const e = encodeURIComponent;
  return `accounts/${e(accountId)}/locations/${e(locationId)}/reviews/${e(reviewId)}`;
}

/**
 * Post a reply to ONE review through the official Google API.
 *
 * Steps: token (refresh failure never changes connection status) ->
 * preflight GET (review exists, belongs to this account/location, has no
 * reply yet - so a reply made directly on Google is never silently
 * overwritten) -> PUT reply. Returns Google's own ReviewReply.
 * Throws ReviewReplyError for every failure.
 */
export async function replyToReview(googleConnection, accountId, locationId, reviewId, comment) {
  let accessToken;
  try {
    accessToken = await getAccessTokenWithoutStatusChange(googleConnection);
  } catch {
    throw new ReviewReplyError('GOOGLE_AUTH_FAILED', 502, 'Your Google Business Profile connection may need to be re-authorized.');
  }

  const client = axios.create({
    baseURL: GBP_LEGACY_API,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    timeout: REPLY_TIMEOUT_MS
  });
  const path = reviewResourcePath(accountId, locationId, reviewId);

  // Preflight (read-only)
  let existing;
  try {
    existing = (await client.get(path)).data;
  } catch (error) {
    throw classifyReplyError(error);
  }
  if (existing?.reviewReply?.comment) {
    throw new ReviewReplyError('ALREADY_REPLIED', 409, 'This review already has a reply.', {
      existingReply: {
        comment: existing.reviewReply.comment,
        update_time: existing.reviewReply.updateTime ? new Date(existing.reviewReply.updateTime) : null,
        state: existing.reviewReply.reviewReplyState || null
      }
    });
  }

  // The write. This is the ONLY place a reply is sent to Google.
  try {
    const res = await client.put(`${path}/reply`, { comment });
    const reply = res.data || {};
    return {
      comment: reply.comment ?? comment,
      update_time: reply.updateTime ? new Date(reply.updateTime) : new Date(),
      state: reply.reviewReplyState || null,
      policyViolation: reply.policyViolation || null,
      googleStatus: res.status
    };
  } catch (error) {
    throw classifyReplyError(error);
  }
}

function normalizeReview(googleReview) {
  // googleReview.name = "accounts/{a}/locations/{l}/reviews/{reviewId}" -
  // preserve verbatim (google_resource_name) rather than reconstructing it
  // later, and only derive the bare ID for our own indexing/lookup key.
  const reviewId = googleReview.name?.split('/').pop() || googleReview.reviewId;

  return {
    google_review_id: reviewId,
    google_resource_name: googleReview.name,
    reviewer_name: googleReview.reviewer?.isAnonymous
      ? 'A Google user'
      : (googleReview.reviewer?.displayName || 'Anonymous'),
    reviewer_photo_url: googleReview.reviewer?.profilePhotoUrl || null,
    reviewer_is_anonymous: !!googleReview.reviewer?.isAnonymous,
    star_rating: STAR_RATING_MAP[googleReview.starRating] || null,
    comment: googleReview.comment || '',
    // A review's age decides which period it falls in. Google always sends
    // createTime; if it is ever missing, the review's own updateTime is a
    // truthful bound - "now" (the sync time) would invent a brand-new review
    // and inflate the 7D / 30D counts on every sync.
    review_create_time: googleReview.createTime
      ? new Date(googleReview.createTime)
      : (googleReview.updateTime ? new Date(googleReview.updateTime) : new Date()),
    review_update_time: googleReview.updateTime ? new Date(googleReview.updateTime) : new Date(),
    reply: googleReview.reviewReply ? {
      comment: googleReview.reviewReply.comment || null,
      update_time: googleReview.reviewReply.updateTime ? new Date(googleReview.reviewReply.updateTime) : null,
      state: googleReview.reviewReply.reviewReplyState || null
    } : { comment: null, update_time: null, state: null }
  };
}

export default {
  checkReviewsCapability,
  fetchBusinessMetadata,
  fetchAllReviews
};
