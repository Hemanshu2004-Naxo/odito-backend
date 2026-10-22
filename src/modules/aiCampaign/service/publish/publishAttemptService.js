/**
 * publishAttemptService — Phase 6. Every read/write of AiCampaignPublishAttempt
 * lives here, and ONLY here — campaignPublishService.js never touches the
 * model directly. Two responsibilities, kept together because they are two
 * halves of the same invariant:
 *
 *  1. IDEMPOTENCY (spec §8): `findOrCreateAttempt` upserts on the unique
 *     `{projectId, draftId, draftVersion}` key — at most one attempt
 *     document ever exists per draft version, for its whole lifetime.
 *  2. CONCURRENCY (spec §9): `claimPublishLock` is the ONE atomic
 *     `findOneAndUpdate` that may move an attempt into `'publishing'` — the
 *     filter requires the CURRENT status to already be one of
 *     RETRYABLE_ATTEMPT_STATUSES, so two simultaneous callers can never both
 *     win it. MongoDB's single-document write atomicity is the actual
 *     guarantee; nothing here does a separate read-then-write status check.
 *
 * `recordResource` appends to `resources[]` immediately after each Google
 * Ads mutation succeeds (spec §15/§42 — crash recovery needs this to be
 * durable step-by-step, not batched in memory until the very end).
 */

import AiCampaignPublishAttempt from '../../model/AiCampaignPublishAttempt.js';
import { RETRYABLE_ATTEMPT_STATUSES, PUBLISH_LOCK_STALE_MS } from '../../constants/publishEnums.js';
import { NotFoundError, ConflictError } from '../../../../utils/ErrorUtil.js';

/**
 * Upsert-or-fetch the one attempt document for this exact draft version.
 * Never creates a second document for the same (projectId, draftId, draftVersion).
 */
export async function findOrCreateAttempt({ projectId, draftId, draftVersion, userId, customerId, loginCustomerId }) {
  return AiCampaignPublishAttempt.findOneAndUpdate(
    { projectId, draftId, draftVersion },
    {
      $setOnInsert: {
        createdBy: userId,
        customerId,
        loginCustomerId: loginCustomerId || null,
        status: 'pending',
        resources: [],
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
  );
}

/**
 * The atomic concurrency lock (spec §9). Returns the claimed, now-`publishing`
 * attempt, or `null` if another request already holds it. Matches on EITHER
 * a normal retryable status OR a `publishing` attempt whose lock has gone
 * stale (spec §42 crash recovery — see PUBLISH_LOCK_STALE_MS) — one atomic
 * filter, so a genuinely still-active publish (fresh `startedAt`) can never
 * be preempted by a concurrent caller, only a truly abandoned one.
 */
export async function claimPublishLock(attemptId) {
  return AiCampaignPublishAttempt.findOneAndUpdate(
    {
      _id: attemptId,
      $or: [
        { status: { $in: RETRYABLE_ATTEMPT_STATUSES } },
        { status: 'publishing', startedAt: { $lte: new Date(Date.now() - PUBLISH_LOCK_STALE_MS) } },
      ],
    },
    { $set: { status: 'publishing', startedAt: new Date(), failureCode: null, failureMessage: null } },
    { new: true },
  );
}

/** Append one confirmed Google Ads resource mapping — called immediately after each successful mutation. */
export async function recordResource(attemptId, { type, oditoId = null, parentOditoId = null, googleResourceName }) {
  const updated = await AiCampaignPublishAttempt.findOneAndUpdate(
    { _id: attemptId },
    { $push: { resources: { type, oditoId, parentOditoId, googleResourceName, createdAt: new Date() } } },
    { new: true },
  );
  if (!updated) throw new NotFoundError('Publish attempt not found');
  return updated;
}

/** Terminal write: everything in the plan was created successfully. */
export async function markPublished(attemptId, { publishPlanHash } = {}) {
  const updated = await AiCampaignPublishAttempt.findOneAndUpdate(
    { _id: attemptId, status: 'publishing' },
    { $set: { status: 'published', completedAt: new Date(), publishPlanHash: publishPlanHash || null } },
    { new: true },
  );
  if (!updated) throw new ConflictError('Publish attempt is no longer in progress.');
  return updated;
}

/**
 * Terminal write on any non-full-success outcome. `hasResources` decides
 * between `failed` (nothing was created — safe to retry from scratch) and
 * `partially_published` (some resources exist — spec §17, never silently
 * reported as `published`).
 */
export async function markFailed(attemptId, { code, message, hasResources }) {
  const updated = await AiCampaignPublishAttempt.findOneAndUpdate(
    { _id: attemptId, status: 'publishing' },
    {
      $set: {
        status: hasResources ? 'partially_published' : 'failed',
        completedAt: new Date(),
        failureCode: code || 'GOOGLE_UNKNOWN',
        failureMessage: message ? String(message).slice(0, 500) : null,
      },
    },
    { new: true },
  );
  if (!updated) throw new NotFoundError('Publish attempt not found');
  return updated;
}

export async function getLatestAttempt({ draftId, projectId }) {
  return AiCampaignPublishAttempt.findOne({ projectId, draftId }).sort({ draftVersion: -1 }).lean();
}

export default {
  findOrCreateAttempt,
  claimPublishLock,
  recordResource,
  markPublished,
  markFailed,
  getLatestAttempt,
};
