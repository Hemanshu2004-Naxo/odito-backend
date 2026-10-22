import metaApiService from '../metaApiService.js';
import { isPubliclyReachableUrl } from '../media/mediaStorageService.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';
import { classifyMetaFailure, isAuthenticationFailure } from '../metaErrorClassifier.js';
import { getPublishConfig } from '../socialPublishConfig.js';

/**
 * FacebookAdapter — the ONLY place that turns a SocialPublication into a
 * real Meta Graph API call for Facebook. socialPublishingService.js calls
 * `publish()` and nothing lower-level; this file has no DB access at all,
 * same layering as every other Graph-API-only file in this module
 * (facebookPageDataService.js, instagramMediaService.js).
 *
 * Text posts use /{page-id}/feed. Image/video posts use /{page-id}/photos
 * and /{page-id}/videos respectively, both via Meta's URL-based upload
 * (`url` / `file_url` params) — Meta itself fetches the media from the
 * public HTTPS URL mediaStorageService.js produced; this adapter never
 * uploads raw bytes to Meta directly. A Facebook video accepted via
 * file_url is queued for asynchronous processing on META's side — the id
 * this call returns is the real video id immediately, so there is nothing
 * to poll for here (unlike Instagram's container→publish flow, where the
 * SECOND step cannot succeed until Meta's processing finishes).
 */
export async function publish({ account, content, media }) {
  if (Array.isArray(media) && media.length > 1) {
    return { success: false, externalPostId: null, error: { code: 'MEDIA_NOT_SUPPORTED', message: 'Only a single image or video is supported per Facebook post in this phase — albums are not yet supported.' } };
  }

  const pageId = account.pageId || account.platformAccountId;
  const pageAccessToken = account.accessToken; // decrypted via the schema's own getter, never accepted as a parameter
  const [item] = media || [];

  if (!item) {
    if (!content || !content.trim()) {
      return { success: false, externalPostId: null, error: { code: 'CONTENT_REQUIRED', message: 'Post text is required.' } };
    }
    const result = await metaApiService.request({
      method: 'POST',
      path: `/${pageId}/feed`,
      params: { message: content.trim() },
      accessToken: pageAccessToken,
      context: 'facebook_publish_post',
      timeoutMs: getPublishConfig().publishTimeoutMs,
    });
    return finalizeResult(result, ['id']);
  }

  // Checked BEFORE calling Meta at all — same reasoning as
  // instagramAdapter.js's identical check: Meta's own error for an
  // unreachable media URL is ambiguous (it looks the same as "not a real
  // image/video"), so Odito checks the URL it itself generated first
  // rather than trying to reverse-engineer the cause from Meta's response.
  if (!isPubliclyReachableUrl(item.url)) {
    LoggerUtil.service('FacebookAdapter', 'publish', 'media_url_unreachable', {});
    return { success: false, externalPostId: null, error: { code: 'FACEBOOK_MEDIA_URL_UNREACHABLE', message: 'Facebook could not access the uploaded media. Publishing requires a publicly reachable HTTPS media URL.' } };
  }

  if (item.type === 'video') {
    const result = await metaApiService.request({
      method: 'POST',
      path: `/${pageId}/videos`,
      params: { file_url: item.url, description: content || '' },
      accessToken: pageAccessToken,
      context: 'facebook_publish_video',
      timeoutMs: getPublishConfig().publishTimeoutMs,
    });
    return finalizeResult(result, ['id']);
  }

  // image — Meta's /photos response includes BOTH `id` (the photo object)
  // and, when published:true, `post_id` (the actual feed post that shows
  // up on the Page's timeline). post_id is preferred as externalPostId
  // since that's the real, viewable post; id is only a fallback for the
  // unexpected case where Meta omits post_id.
  const result = await metaApiService.request({
    method: 'POST',
    path: `/${pageId}/photos`,
    params: { url: item.url, caption: content || '', published: true },
    accessToken: pageAccessToken,
    context: 'facebook_publish_photo',
    timeoutMs: getPublishConfig().publishTimeoutMs,
  });
  return finalizeResult(result, ['post_id', 'id']);
}

function finalizeResult(result, idKeys) {
  if (!result.success) {
    return { success: false, externalPostId: null, error: normalizeFailure(result) };
  }

  let externalPostId = null;
  for (const key of idKeys) {
    if (result.data?.[key]) {
      externalPostId = result.data[key];
      break;
    }
  }
  if (!externalPostId) {
    LoggerUtil.service('FacebookAdapter', 'publish', 'malformed_response', {});
    // Meta said "OK" but gave no id: the post may well exist — an UNKNOWN
    // outcome, not a definite failure, so it must be reconciled before any
    // retry rather than blindly re-sent.
    return { success: false, externalPostId: null, error: { code: 'PUBLISH_OUTCOME_UNKNOWN', message: 'Meta accepted the request but returned no post ID, so Odito cannot confirm whether it was published.', category: 'UNKNOWN_OUTCOME', retryable: true, outcome: 'unknown', accountAction: 'none', requiresReconnect: false } };
  }

  LoggerUtil.service('FacebookAdapter', 'publish', 'completed', {});
  return { success: true, externalPostId, error: null };
}

/**
 * Deletes a previously-published Facebook Page post: DELETE /{externalPostId}
 * using the same Page access token and pages_manage_posts permission
 * required to create it (Meta has no separate delete-scope for Page
 * posts). `externalPostId` must be the real Meta post id already recorded
 * on the owned SocialPublication — the caller (socialPublishingService.js)
 * is responsible for never sourcing this from anything else.
 *
 * Meta's documented response for successfully deleting an object is
 * `{ success: true }`; for an object that is already gone/inaccessible,
 * Meta returns its standard "nonexisting node" error —
 * GraphMethodException, code 100 (commonly with error_subcode 33,
 * "Unsupported get request... object... does not exist, cannot be
 * loaded... or does not support this operation"). That specific,
 * well-documented signature is treated as an IDEMPOTENT success here
 * (`alreadyDeleted: true`): if the post is already gone on Facebook's
 * side, there is nothing left to delete, and refusing to let the Odito
 * record be removed in that case would leave it stuck forever. Any other
 * failure (permission, invalid/expired token, rate limit, or anything
 * unrecognized) is a real failure — the Odito record must NOT be deleted.
 */
export async function remove({ account, externalPostId }) {
  const pageAccessToken = account.accessToken; // decrypted via the schema's own getter, same as publish() above

  const result = await metaApiService.request({
    method: 'DELETE',
    path: `/${externalPostId}`,
    accessToken: pageAccessToken,
    context: 'facebook_delete_post',
  });

  if (result.success) {
    LoggerUtil.service('FacebookAdapter', 'delete', 'completed', {});
    return { success: true, alreadyDeleted: false, error: null };
  }

  const metaError = result.data?.error;
  if (metaError?.type === 'GraphMethodException' && metaError?.code === 100) {
    LoggerUtil.service('FacebookAdapter', 'delete', 'already_deleted', { subcode: metaError?.error_subcode ?? null });
    return { success: true, alreadyDeleted: true, error: null };
  }

  return { success: false, alreadyDeleted: false, error: normalizeDeleteFailure(result) };
}

function normalizeDeleteFailure(result) {
  const c = classifyMetaFailure(result, { platform: 'facebook' });
  LoggerUtil.service('FacebookAdapter', 'delete', 'failed', { status: result.status, category: c.category, code: c.code });

  if (c.code === 'FACEBOOK_PERMISSION_MISSING') {
    return { code: 'FACEBOOK_PERMISSION_MISSING', message: 'This Facebook Page is connected but missing posting permission — reconnect it, then try deleting again. The post was NOT deleted.' };
  }
  if (c.code === 'FACEBOOK_TOKEN_INVALID') {
    return { code: 'FACEBOOK_TOKEN_INVALID', message: 'Meta denied this request — the Page connection may need to be reconnected. The post was NOT deleted.' };
  }
  if (c.code === 'FACEBOOK_RATE_LIMITED') {
    return { code: 'FACEBOOK_RATE_LIMITED', message: 'Meta is rate-limiting requests for this Page right now. Try again shortly. The post was NOT deleted.' };
  }
  return { code: 'FACEBOOK_DELETE_FAILED', message: 'Meta refused to delete this post. The post still exists on Facebook and the Odito record was NOT deleted.' };
}

/**
 * Turns a failed publish call into the adapter's error shape. All
 * classification lives in metaErrorClassifier.js; this only attaches the
 * result to the code/message contract the publishing service and UI already
 * consume. Every Facebook publish call (/feed, /photos, /videos) is the
 * FINAL, post-creating step, so a lost response there is an UNKNOWN outcome
 * (outcome:'unknown'), never a plain failure.
 */
function normalizeFailure(result) {
  const c = classifyMetaFailure(result, { platform: 'facebook', finalPublishStep: true });
  LoggerUtil.service('FacebookAdapter', 'publish', 'failed', { status: result.status, category: c.category, code: c.code, outcome: c.outcome });
  return toAdapterError(c);
}

function toAdapterError(c) {
  return {
    code: c.code,
    message: c.message,
    category: c.category,
    retryable: c.retryable,
    outcome: c.outcome,
    accountAction: c.accountAction,
    requiresReconnect: c.requiresReconnect,
  };
}

/**
 * Looks for a Page post that matches an attempt whose outcome is unknown
 * (the publish request was sent but no usable answer came back).
 *
 * There is no idempotency key for a Graph publish call, so this is
 * reconciliation by FINGERPRINT: a post on the Page created at/after the
 * attempt started whose text equals the attempted content. Returns
 *   { status:'found', externalPostId }     — a matching post exists
 *   { status:'not_found' }                 — CONFIDENTLY not published: the
 *        lookup succeeded, covered the attempt window, and the attempt had a
 *        reliable fingerprint (non-empty text, not a video — a video's
 *        description does not reliably surface as the post `message`)
 *   { status:'unknown', reason }           — anything else (empty/unfingerprintable
 *        content, video, lookup failed, window not covered). The caller must
 *        NOT re-publish on 'unknown'.
 * A lookup that fails with a dead-token error is reported via
 * `authFailure:true` so the caller can expire the account.
 */
const RECONCILE_LIMIT = 25;
const RECONCILE_CLOCK_SKEW_MS = 2 * 60 * 1000;

export async function reconcile({ account, content, media, since, excludeIds = null }) {
  const text = (content || '').trim();
  const isVideo = Array.isArray(media) && media.some((m) => m?.type === 'video');
  if (!text) return { status: 'unknown', reason: 'NO_FINGERPRINT' };
  if (!(since instanceof Date) || Number.isNaN(since.getTime())) return { status: 'unknown', reason: 'NO_ATTEMPT_TIME' };

  const pageId = account.pageId || account.platformAccountId;
  const result = await metaApiService.request({
    method: 'GET',
    path: `/${pageId}/posts`,
    params: { fields: 'id,message,created_time', limit: RECONCILE_LIMIT },
    accessToken: account.accessToken,
    context: 'facebook_reconcile_posts',
  });
  if (!result.success) {
    return { status: 'unknown', reason: 'LOOKUP_FAILED', authFailure: isAuthenticationFailure(result) };
  }

  const posts = Array.isArray(result.data?.data) ? result.data.data : [];
  const earliest = since.getTime() - RECONCILE_CLOCK_SKEW_MS;
  // excludeIds: posts already recorded against ANOTHER Odito publication must
  // never be claimed as this attempt's post (two identical posts, one real).
  const match = posts.find((p) => p?.id && !excludeIds?.has(p.id) && typeof p.message === 'string' && p.message.trim() === text && new Date(p.created_time).getTime() >= earliest);
  if (match) return { status: 'found', externalPostId: match.id };

  const windowCovered = posts.length < RECONCILE_LIMIT
    || posts.some((p) => new Date(p.created_time).getTime() < earliest);
  if (!windowCovered) return { status: 'unknown', reason: 'WINDOW_NOT_COVERED' };
  if (isVideo) return { status: 'unknown', reason: 'VIDEO_NOT_FINGERPRINTABLE' };
  return { status: 'not_found' };
}

/** A Facebook post id looks like "<pageId>_<postId>" (text/feed) or a bare numeric id (photo/video). Anything else is never sent to Graph. */
const FACEBOOK_POST_ID_RE = /^\d{5,30}(_\d{5,30})?$/;
const FACEBOOK_HOST_RE = /(^|\.)facebook\.com$/i;
const PERMALINK_LOOKUP_TIMEOUT_MS = 5_000;

/** The permalink only if it is a plain https facebook.com URL: no credentials, no token parameter, bounded length. */
export function validateFacebookPermalink(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || !FACEBOOK_HOST_RE.test(url.hostname)) return null;
  if (url.username || url.password || url.searchParams.has('access_token')) return null;
  return url.toString();
}

/**
 * Reads the canonical permalink of a post that Odito has ALREADY confirmed as published: one
 * `GET /{externalPostId}?fields=permalink_url` with the same Page token. Never throws and never reports an error to the
 * caller as a failure of the publish - the result is { permalink, code }: a validated URL, or null with a SAFE code
 * (HTTP_<status> | TIMEOUT | NETWORK | NO_PERMALINK | INVALID_PERMALINK | INVALID_POST_ID). Nothing from the Graph response
 * other than the validated URL is returned or logged here.
 */
export async function getPermalink({ account, externalPostId }) {
  if (typeof externalPostId !== 'string' || !FACEBOOK_POST_ID_RE.test(externalPostId)) return { permalink: null, code: 'INVALID_POST_ID' };
  let result;
  try {
    result = await metaApiService.request({
      method: 'GET',
      path: `/${externalPostId}`,
      params: { fields: 'permalink_url' },
      accessToken: account.accessToken, // decrypted via the schema's own getter, never accepted as a parameter
      context: 'facebook_permalink',
      timeoutMs: PERMALINK_LOOKUP_TIMEOUT_MS,
    });
  } catch {
    return { permalink: null, code: 'NETWORK' };
  }
  if (!result || !result.success) {
    const code = result?.kind === 'http' ? `HTTP_${result.status}` : result?.kind === 'timeout' ? 'TIMEOUT' : 'NETWORK';
    return { permalink: null, code };
  }
  const raw = result.data?.permalink_url;
  if (raw === undefined || raw === null || raw === '') return { permalink: null, code: 'NO_PERMALINK' };
  const permalink = validateFacebookPermalink(raw);
  return permalink ? { permalink, code: null } : { permalink: null, code: 'INVALID_PERMALINK' };
}

export default { publish, remove, reconcile, getPermalink };
