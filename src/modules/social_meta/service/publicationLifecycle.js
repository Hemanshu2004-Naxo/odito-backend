import os from 'os';
import crypto from 'crypto';
import mongoose from 'mongoose';
import SocialPublication, { PLATFORMS } from '../model/SocialPublication.js';
import SocialAccount from '../model/SocialAccount.js';
import adapters from './platformAdapters/index.js';
import { markAccountExpired } from './metaTokenService.js';
import { getPublishConfig, computeNextRetryAt, shouldAutoRetry } from './socialPublishConfig.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * PublicationLifecycle — every state transition of a SocialPublication that
 * happens AROUND a publish attempt: who holds the lock, how an attempt is
 * finalized, when a failure is retried vs. terminal, and how an attempt whose
 * outcome Odito could not observe is reconciled against Meta.
 *
 * Lives below both socialPublishingService.js (which claims + publishes) and
 * socialPublishRecoveryService.js (which sweeps orphaned/unknown rows) so the
 * two share exactly one implementation and neither imports the other.
 *
 * Safety model (cross-process — nothing here relies on in-memory state):
 *   - the CLAIM (status -> 'publishing', done in publishNow) is a single
 *     atomic findOneAndUpdate; it also stamps lockedBy/publishingStartedAt.
 *   - every transition OUT of 'publishing' is a conditional update that
 *     matches only while the row is still locked by the same owner, so a
 *     worker whose lock was recovered can never overwrite the recovery's
 *     decision, and two recoveries can never both act.
 *   - the single exception is "a real post exists" (recordPublished): that
 *     is recorded regardless of the current state, because the external
 *     post is the truth and must never be lost or re-created.
 */

let cachedInstanceId = null;

/** Identifies THIS process in lockedBy (host:pid:random) — unique per process start, so a PM2 restart is a new owner. */
export function getInstanceId() {
  if (!cachedInstanceId) {
    cachedInstanceId = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;
  }
  return cachedInstanceId;
}

/** Failure codes after which the only fix is the user re-authorizing the connection. */
export const RECONNECT_REQUIRED_CODES = new Set([
  'FACEBOOK_TOKEN_INVALID', 'INSTAGRAM_TOKEN_INVALID',
  'FACEBOOK_PERMISSION_MISSING', 'INSTAGRAM_PERMISSION_MISSING',
  'ACCOUNT_RECONNECT_REQUIRED',
]);

/**
 * Failure codes where re-sending can never succeed until the CONTENT or
 * account setup changes (not a transient condition, and not an auth issue).
 * Together with RECONNECT_REQUIRED_CODES, outcomeUnknown and the stored
 * failureRetryable verdict this is what the derived `canRetry` is built from.
 */
export const NOT_RETRYABLE_FAILURE_CODES = new Set([
  'FACEBOOK_MEDIA_INVALID', 'INSTAGRAM_MEDIA_INVALID',
  'FACEBOOK_MEDIA_URL_UNREACHABLE', 'INSTAGRAM_MEDIA_URL_UNREACHABLE',
  'MEDIA_REQUIRED', 'MEDIA_NOT_SUPPORTED', 'CONTENT_REQUIRED',
  'PLATFORM_NOT_SUPPORTED', 'ACCOUNT_NOT_FOUND', 'ACCOUNT_NOT_CONNECTED',
  'DUPLICATE_EXTERNAL_POST',
]);

/**
 * Validates the platform has a real adapter and the referenced SocialAccount
 * belongs to this project, is the right platform, and is connected — never
 * trusts a client-supplied socialAccountId beyond that (same IDOR discipline
 * as facebookAccountService.js's setActiveFacebookAccount). An EXPIRED
 * account gets its own code so callers/UI can say "reconnect required"
 * instead of the generic "not connected".
 */
export async function resolveAccount(projectId, platform, socialAccountId) {
  if (!PLATFORMS.includes(platform) || !adapters[platform]) {
    return { error: { code: 'PLATFORM_NOT_SUPPORTED', message: `Publishing to ${platform || 'that platform'} is not supported yet.` } };
  }
  if (!socialAccountId || !mongoose.Types.ObjectId.isValid(socialAccountId)) {
    return { error: { code: 'ACCOUNT_NOT_FOUND', message: 'That social account was not found for this project.' } };
  }
  const account = await SocialAccount.findById(socialAccountId);
  if (!account || account.project_id.toString() !== projectId.toString() || account.platform !== platform) {
    return { error: { code: 'ACCOUNT_NOT_FOUND', message: 'That social account was not found for this project.' } };
  }
  if (account.status === 'expired') {
    return { error: { code: 'ACCOUNT_RECONNECT_REQUIRED', message: 'That account\'s connection has expired — reconnect it to continue.', requiresReconnect: true } };
  }
  if (account.status !== 'active') {
    return { error: { code: 'ACCOUNT_NOT_CONNECTED', message: 'That account is not currently connected.' } };
  }
  return { account };
}

const PUBLISHED_RESET = {
  failureRetryable: null,
  failedAt: null,
  failureReason: null,
  failureCode: null,
  lastError: null,
  lastErrorCode: null,
  outcomeUnknown: false,
  nextRetryAt: null,
  publishingStartedAt: null,
  lockedBy: null,
  reconcileCheckedAt: null,
};

/**
 * Records that a REAL external post exists for this publication. Matches any
 * state except 'published' — deliberately not conditional on the lock: if the
 * post is live, that fact must be recorded even if a recovery already moved
 * the row (otherwise a later retry would create a second post). A duplicate
 * externalPostId (another Odito row already owns that Meta post) is reported
 * as a distinct failed state rather than thrown or silently dropped.
 */
export async function recordPublished(doc, externalPostId, { now = new Date() } = {}) {
  try {
    const updated = await SocialPublication.findOneAndUpdate(
      { _id: doc._id, status: { $ne: 'published' } },
      { $set: { status: 'published', externalPostId, publishedAt: now, ...PUBLISHED_RESET } },
      { new: true },
    );
    if (!updated) {
      LoggerUtil.service('SocialPublishing', 'record_published', 'not_updated', { publicationId: String(doc._id) });
    }
    return { publication: updated, duplicate: false };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    // The unique (social_account_id, externalPostId) index: another
    // publication already owns this exact Meta post. The post exists either
    // way; nothing to fabricate or retry — but THIS row cannot also claim it.
    LoggerUtil.service('SocialPublishing', 'record_published', 'duplicate_external_post_id', { publicationId: String(doc._id) });
    const updated = await SocialPublication.findOneAndUpdate(
      { _id: doc._id, status: { $ne: 'published' } },
      { $set: { status: 'failed', failedAt: now, failureCode: 'DUPLICATE_EXTERNAL_POST', failureRetryable: false, failureReason: 'Meta returned a post that is already recorded for another Odito post, so this one was not marked published.', outcomeUnknown: false, publishingStartedAt: null, lockedBy: null } },
      { new: true },
    );
    return { publication: updated, duplicate: true };
  }
}

/**
 * Best-effort: stores the canonical permalink on a publication that is CONFIRMED published (status 'published' with a real
 * externalPostId - i.e. the direct success path or an existing reconciliation that found the post). One Graph read; any
 * failure just leaves `permalink: null` and is logged as a safe code. It can never change status / externalPostId /
 * publishedAt, never throws, never publishes anything, and is a no-op for other platforms or when already set.
 */
export async function attachPermalink(doc, account) {
  try {
    if (!doc || doc.status !== 'published' || !doc.externalPostId || doc.permalink || doc.platform !== 'facebook' || !account) return doc;
    const adapter = adapters.facebook;
    if (typeof adapter?.getPermalink !== 'function') return doc;
    const { permalink, code } = await adapter.getPermalink({ account, externalPostId: doc.externalPostId });
    if (!permalink) {
      LoggerUtil.warn('[SOCIAL_PERMALINK] No permalink stored', { publicationId: String(doc._id), platform: doc.platform, code });
      return doc;
    }
    const updated = await SocialPublication.findOneAndUpdate(
      { _id: doc._id, status: 'published', externalPostId: doc.externalPostId, permalink: null },
      { $set: { permalink } },
      { new: true },
    );
    LoggerUtil.info('[SOCIAL_PERMALINK] Stored', { publicationId: String(doc._id), platform: doc.platform });
    return updated || doc;
  } catch (error) {
    LoggerUtil.warn('[SOCIAL_PERMALINK] Lookup failed', { publicationId: String(doc?._id), code: 'LOOKUP_ERROR' });
    return doc;
  }
}

/**
 * Settles a failed attempt whose lock THIS caller still holds. One of:
 *   - unknown outcome    -> status 'failed' + outcomeUnknown (never auto-retried)
 *   - retryable + budget -> back to 'scheduled' with nextRetryAt (backoff)
 *   - otherwise          -> terminal 'failed' (MAX_RETRIES_EXCEEDED when the
 *                           retry budget was what ran out)
 * Only scheduler-triggered attempts are retried automatically; a person's
 * manual Publish/Retry that fails just becomes 'failed' for them to act on.
 *
 * Conditional on { status:'publishing', lockedBy } — if a recovery took the
 * row meanwhile, this is a no-op ({ lockLost:true }) and recovery's decision
 * stands.
 */
export async function settleFailure(doc, error, { now = new Date(), config = getPublishConfig() } = {}) {
  const base = {
    lastError: error?.message || 'Publishing failed.',
    lastErrorCode: error?.code || null,
    publishingStartedAt: null,
    lockedBy: null,
  };

  let set;
  let retryScheduled = false;
  if (error?.outcome === 'unknown') {
    set = {
      ...base,
      status: 'failed',
      failedAt: now,
      failureReason: error.message || 'Odito could not confirm whether this post was published.',
      failureCode: 'PUBLISH_OUTCOME_UNKNOWN',
      failureRetryable: null,
      outcomeUnknown: true,
      reconcileCheckedAt: null,
      nextRetryAt: null,
    };
  } else if (doc.publishTrigger === 'scheduler' && shouldAutoRetry(error || {}, doc.attempts, config)) {
    retryScheduled = true;
    set = {
      ...base,
      status: 'scheduled',
      nextRetryAt: computeNextRetryAt(doc.attempts, error.category, now, config),
      failedAt: null,
      failureReason: null,
      failureCode: null,
    };
  } else {
    const exhausted = doc.publishTrigger === 'scheduler' && error?.retryable === true && error?.outcome === 'not_published' && doc.attempts >= config.maxAttempts;
    set = {
      ...base,
      status: 'failed',
      failedAt: now,
      failureReason: exhausted
        ? `${error.message} Odito gave up after ${doc.attempts} attempts.`
        : (error?.message || 'Publishing failed.'),
      failureCode: exhausted ? 'MAX_RETRIES_EXCEEDED' : (error?.code || null),
      // Out of automatic attempts is not "can never work": a person may retry.
      failureRetryable: exhausted ? true : (typeof error?.retryable === 'boolean' ? error.retryable : null),
      nextRetryAt: null,
    };
  }

  const updated = await SocialPublication.findOneAndUpdate(
    { _id: doc._id, status: 'publishing', lockedBy: doc.lockedBy },
    { $set: set },
    { new: true },
  );
  if (!updated) {
    LoggerUtil.service('SocialPublishing', 'settle_failure', 'lock_lost', { publicationId: String(doc._id), code: error?.code });
    return { lockLost: true, publication: await SocialPublication.findById(doc._id), retryScheduled: false };
  }
  LoggerUtil.service('SocialPublishing', 'settle_failure', retryScheduled ? 'retry_scheduled' : 'failed', {
    publicationId: String(doc._id), platform: doc.platform, code: error?.code, attempts: doc.attempts,
    nextRetryAt: retryScheduled ? set.nextRetryAt.toISOString() : null,
  });
  return { publication: updated, retryScheduled, lockLost: false };
}

/**
 * Outcome of a reconciliation that PROVED the post was not created: put the
 * row where a safe next attempt can happen — back to 'scheduled' with
 * backoff for a scheduler-triggered attempt with budget left, otherwise a
 * plain 'failed' (PUBLISH_INTERRUPTED) the person can retry manually.
 * `guard` is the caller's ownership filter (the recovery lock, or the
 * unknown-outcome flag), so this can never apply to a row someone else owns.
 */
export async function applyNotPublished(doc, guard, { now = new Date(), config = getPublishConfig() } = {}) {
  const retry = doc.publishTrigger === 'scheduler' && doc.attempts < config.maxAttempts;
  const set = retry
    ? { status: 'scheduled', nextRetryAt: computeNextRetryAt(doc.attempts, 'TRANSIENT', now, config), failedAt: null, failureReason: null, failureCode: null }
    : { status: 'failed', failedAt: now, failureCode: 'PUBLISH_INTERRUPTED', failureRetryable: true, failureReason: 'The publish was interrupted before Meta created the post (verified against the platform). It is safe to retry.', nextRetryAt: null };
  const updated = await SocialPublication.findOneAndUpdate(
    { _id: doc._id, ...guard },
    { $set: { ...set, outcomeUnknown: false, publishingStartedAt: null, lockedBy: null, reconcileCheckedAt: null } },
    { new: true },
  );
  return { publication: updated, retryScheduled: !!updated && retry };
}

/**
 * Marks a row whose outcome could not be determined as 'failed' +
 * outcomeUnknown — the explicit, safe holding state: not publishable, not
 * auto-retried, resolved only by reconciliation (or a person deleting it).
 */
export async function quarantineUnknown(doc, guard, reasonCode, { now = new Date() } = {}) {
  return SocialPublication.findOneAndUpdate(
    { _id: doc._id, ...guard },
    {
      $set: {
        status: 'failed',
        failedAt: now,
        failureCode: 'PUBLISH_OUTCOME_UNKNOWN',
        failureRetryable: null,
        failureReason: 'Odito could not confirm whether this post was published (the attempt was interrupted). It will not be re-sent until that is verified.',
        lastError: 'Publish outcome could not be confirmed.',
        lastErrorCode: reasonCode || 'PUBLISH_OUTCOME_UNKNOWN',
        outcomeUnknown: true,
        publishingStartedAt: null,
        lockedBy: null,
        nextRetryAt: null,
      },
    },
    { new: true },
  );
}

/**
 * Asks Meta whether the attempt that left `doc` in an unknown state actually
 * created a post, and, when it did, records it as published.
 *
 * Resolutions:
 *   'published'     — a matching post exists; the row is now 'published'
 *   'not_published' — CONFIDENTLY nothing was created (see adapter.reconcile
 *                     for what "confident" requires) AND, when requireSettled,
 *                     enough time has passed for a post to have surfaced
 *   'pending'       — nothing found yet but too soon to be sure (requireSettled)
 *   'unknown'       — cannot be determined (no usable fingerprint, video,
 *                     account unavailable, Meta lookup failed, ...)
 * Never throws for an expected outcome. A dead-token error during the lookup
 * expires the account (same rule as a publish failure).
 */
export async function reconcileUnknownPublication(doc, { since = null, requireSettled = false, now = new Date(), config = getPublishConfig() } = {}) {
  const adapter = adapters[doc.platform];
  if (!adapter || typeof adapter.reconcile !== 'function') {
    return { resolution: 'unknown', reason: 'NO_ADAPTER_SUPPORT' };
  }

  const account = await SocialAccount.findById(doc.social_account_id);
  if (!account || account.status !== 'active') {
    return { resolution: 'unknown', reason: 'ACCOUNT_UNAVAILABLE' };
  }

  const attemptStart = since || doc.lastAttemptAt || doc.publishingStartedAt || doc.updatedAt || null;

  // Posts already attributed to OTHER Odito publications on this account can
  // never be this attempt's post.
  const recorded = await SocialPublication.find({ social_account_id: doc.social_account_id, externalPostId: { $ne: null } })
    .select('externalPostId').sort({ publishedAt: -1 }).limit(200).lean();
  const excludeIds = new Set(recorded.map((r) => r.externalPostId));

  const found = await adapter.reconcile({ account, content: doc.content, media: doc.media, since: attemptStart, excludeIds });

  if (found.authFailure) {
    await markAccountExpired(account);
    return { resolution: 'unknown', reason: 'AUTH_FAILURE' };
  }
  if (found.status === 'found') {
    const recorded = await recordPublished(doc, found.externalPostId, { now });
    LoggerUtil.service('SocialPublishing', 'reconcile', 'found_published', { publicationId: String(doc._id), platform: doc.platform });
    // The post's existence was just CONFIRMED by reconciliation, so (and only so) its permalink may be looked up.
    const publication = recorded.duplicate ? recorded.publication : await attachPermalink(recorded.publication, account);
    return { resolution: 'published', publication };
  }
  if (found.status === 'not_found') {
    if (requireSettled && attemptStart && now.getTime() - new Date(attemptStart).getTime() < config.reconcileSettleMs) {
      return { resolution: 'pending', reason: 'NOT_SETTLED' };
    }
    return { resolution: 'not_published' };
  }
  return { resolution: 'unknown', reason: found.reason || 'UNKNOWN' };
}

export default {
  getInstanceId, resolveAccount, recordPublished, attachPermalink, settleFailure, applyNotPublished, quarantineUnknown,
  reconcileUnknownPublication, RECONNECT_REQUIRED_CODES,
};

