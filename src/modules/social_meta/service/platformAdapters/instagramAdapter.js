import metaApiService from '../metaApiService.js';
import { isPubliclyReachableUrl } from '../media/mediaStorageService.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';
import { classifyMetaFailure, isAuthenticationFailure } from '../metaErrorClassifier.js';
import { getPublishConfig } from '../socialPublishConfig.js';

/**
 * InstagramAdapter — real Meta Graph API two-step publish flow: create a
 * media container, then publish it. Instagram's API has no text-only post
 * type at all — every publish requires a publicly reachable media URL,
 * which comes from mediaStorageService.js's upload pipeline; this adapter
 * correctly rejects with a clear, actionable error whenever no media URL
 * is given rather than fabricating a success or silently doing nothing.
 *
 * Between container creation and publish, Meta processes the media
 * asynchronously (fetching the URL, transcoding video) — publishing a
 * container before it reaches status_code=FINISHED fails with Meta's own
 * "media not ready" error. This adapter polls the container's status
 * before attempting the publish step, bounded so a stuck/slow container
 * can never hang the request indefinitely; a container that doesn't
 * finish in time comes back as INSTAGRAM_PROCESSING_TIMEOUT, which is
 * retryable through the exact same 'failed' -> retry path every other
 * publish failure already uses (see socialPublishingService.js's
 * PUBLISHABLE_FROM).
 */

function pollIntervalMs() {
  // Overridable via env for tests only — production always gets the
  // default. Read at call time (not module load) so tests can set it
  // per-run without needing to reset any cached module state.
  return Number(process.env.INSTAGRAM_CONTAINER_POLL_INTERVAL_MS) || 1500;
}
const MAX_POLL_ATTEMPTS = 10; // ~15s ceiling at the default interval

async function waitForContainerReady(creationId, pageAccessToken) {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    const statusResult = await metaApiService.request({
      method: 'GET',
      path: `/${creationId}`,
      params: { fields: 'status_code' },
      accessToken: pageAccessToken,
      context: 'instagram_check_container_status',
    });
    if (!statusResult.success) {
      return { ready: false, error: normalizeFailure(statusResult, 'check_container_status') };
    }
    const statusCode = statusResult.data?.status_code;
    if (statusCode === 'FINISHED') return { ready: true };
    if (statusCode === 'ERROR') {
      return { ready: false, error: { code: 'INSTAGRAM_PUBLISH_FAILED', message: 'Meta failed to process this media.', category: 'PERMANENT', retryable: false, outcome: 'not_published', accountAction: 'none', requiresReconnect: false } };
    }
    // IN_PROGRESS, EXPIRED, or an unrecognized value — wait and retry.
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs()));
  }
  // media_publish was never called, so nothing can have been published: a
  // definite, retryable failure (a retry makes a fresh container).
  return { ready: false, error: { code: 'INSTAGRAM_PROCESSING_TIMEOUT', message: 'Meta is still processing this media — try publishing again in a moment.', category: 'TRANSIENT', retryable: true, outcome: 'not_published', accountAction: 'none', requiresReconnect: false } };
}

export async function publish({ account, content, media }) {
  if (!Array.isArray(media) || media.length === 0) {
    return { success: false, externalPostId: null, error: { code: 'MEDIA_REQUIRED', message: 'Instagram requires a photo or video.' } };
  }
  if (media.length > 1) {
    return { success: false, externalPostId: null, error: { code: 'MEDIA_NOT_SUPPORTED', message: 'Only a single image or video is supported per Instagram post in this phase — carousels are not yet supported.' } };
  }

  const igAccountId = account.instagramBusinessAccountId || account.platformAccountId;
  const pageAccessToken = account.accessToken; // same Page token, never a separate Instagram credential (see SocialAccount.js)
  const [item] = media;

  // Checked BEFORE ever calling Meta — live-verified need: a real
  // container-creation call against a http://localhost media URL was
  // rejected by Meta as OAuthException code 9004 ("Only photo or video
  // can be accepted as media type"), even though the file itself was a
  // genuinely valid, already-validated JPEG. Meta's own error for this
  // case doesn't distinguish "couldn't fetch the URL at all" from
  // "fetched something that isn't a real image" — checking reachability
  // ourselves first (using the URL Odito itself generated) gives a
  // precise, deterministic error instead of guessing at Meta's intent.
  if (!isPubliclyReachableUrl(item.url)) {
    LoggerUtil.service('InstagramAdapter', 'publish', 'media_url_unreachable', {});
    return { success: false, externalPostId: null, error: { code: 'INSTAGRAM_MEDIA_URL_UNREACHABLE', message: 'Instagram could not access the uploaded media. Publishing requires a publicly reachable HTTPS media URL.' } };
  }

  const containerResult = await metaApiService.request({
    method: 'POST',
    path: `/${igAccountId}/media`,
    params: item.type === 'video'
      ? { video_url: item.url, caption: content || '', media_type: 'REELS' }
      : { image_url: item.url, caption: content || '' },
    accessToken: pageAccessToken,
    context: 'instagram_create_media_container',
    timeoutMs: getPublishConfig().publishTimeoutMs,
  });

  if (!containerResult.success) {
    return { success: false, externalPostId: null, error: normalizeFailure(containerResult, 'create_container') };
  }

  const creationId = containerResult.data?.id || null;
  if (!creationId) {
    LoggerUtil.service('InstagramAdapter', 'publish', 'malformed_container_response', {});
    return { success: false, externalPostId: null, error: { code: 'INSTAGRAM_PUBLISH_FAILED', message: 'Meta accepted the media but returned no container ID.' } };
  }

  const readiness = await waitForContainerReady(creationId, pageAccessToken);
  if (!readiness.ready) {
    return { success: false, externalPostId: null, error: readiness.error };
  }

  const publishResult = await metaApiService.request({
    method: 'POST',
    path: `/${igAccountId}/media_publish`,
    params: { creation_id: creationId },
    accessToken: pageAccessToken,
    context: 'instagram_publish_media',
    timeoutMs: getPublishConfig().publishTimeoutMs,
  });

  if (!publishResult.success) {
    return { success: false, externalPostId: null, error: normalizeFailure(publishResult, 'publish_container') };
  }

  const externalPostId = publishResult.data?.id || null;
  if (!externalPostId) {
    LoggerUtil.service('InstagramAdapter', 'publish', 'malformed_publish_response', {});
    // media_publish answered OK without an id: the post may exist — UNKNOWN.
    return { success: false, externalPostId: null, error: { code: 'PUBLISH_OUTCOME_UNKNOWN', message: 'Meta accepted the publish request but returned no media ID, so Odito cannot confirm whether it was published.', category: 'UNKNOWN_OUTCOME', retryable: true, outcome: 'unknown', accountAction: 'none', requiresReconnect: false } };
  }

  LoggerUtil.service('InstagramAdapter', 'publish', 'completed', { igAccountId });
  return { success: true, externalPostId, error: null };
}

/**
 * Classification lives in metaErrorClassifier.js. Only the LAST call
 * (`publish_container`, i.e. media_publish) creates the real post, so only a
 * lost response there is an UNKNOWN outcome; a timeout while creating the
 * (unpublished) container or polling its status cannot have published
 * anything and is a plain retryable transient failure.
 */
function normalizeFailure(result, step) {
  const c = classifyMetaFailure(result, { platform: 'instagram', finalPublishStep: step === 'publish_container' });
  LoggerUtil.service('InstagramAdapter', step, 'failed', { status: result.status, category: c.category, code: c.code, outcome: c.outcome });
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
 * Looks for an Instagram media item matching an attempt whose outcome is
 * unknown (media_publish was sent but no usable answer came back). Same
 * contract as facebookAdapter.reconcile: reconciliation by FINGERPRINT (no
 * idempotency key exists) — a media item posted at/after the attempt began
 * whose caption equals the attempted content. 'not_found' is only returned
 * when the lookup succeeded, covered the attempt window, and the caption is
 * a usable fingerprint (non-empty); otherwise 'unknown', and the caller must
 * NOT re-publish.
 */
const RECONCILE_LIMIT = 25;
const RECONCILE_CLOCK_SKEW_MS = 2 * 60 * 1000;

export async function reconcile({ account, content, since, excludeIds = null }) {
  const text = (content || '').trim();
  if (!text) return { status: 'unknown', reason: 'NO_FINGERPRINT' };
  if (!(since instanceof Date) || Number.isNaN(since.getTime())) return { status: 'unknown', reason: 'NO_ATTEMPT_TIME' };

  const igAccountId = account.instagramBusinessAccountId || account.platformAccountId;
  const result = await metaApiService.request({
    method: 'GET',
    path: `/${igAccountId}/media`,
    params: { fields: 'id,caption,timestamp', limit: RECONCILE_LIMIT },
    accessToken: account.accessToken,
    context: 'instagram_reconcile_media',
  });
  if (!result.success) {
    return { status: 'unknown', reason: 'LOOKUP_FAILED', authFailure: isAuthenticationFailure(result) };
  }

  const items = Array.isArray(result.data?.data) ? result.data.data : [];
  const earliest = since.getTime() - RECONCILE_CLOCK_SKEW_MS;
  const match = items.find((m) => m?.id && !excludeIds?.has(m.id) && typeof m.caption === 'string' && m.caption.trim() === text && new Date(m.timestamp).getTime() >= earliest);
  if (match) return { status: 'found', externalPostId: match.id };

  const windowCovered = items.length < RECONCILE_LIMIT || items.some((m) => new Date(m.timestamp).getTime() < earliest);
  return windowCovered ? { status: 'not_found' } : { status: 'unknown', reason: 'WINDOW_NOT_COVERED' };
}

export default { publish, reconcile };
