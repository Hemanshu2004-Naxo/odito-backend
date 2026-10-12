import SocialPublication from '../model/SocialPublication.js';
import {
  getInstanceId, reconcileUnknownPublication, applyNotPublished, quarantineUnknown,
} from './publicationLifecycle.js';
import { getPublishConfig } from './socialPublishConfig.js';
import { activeProjectScope } from './projectLifecycleGuard.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * SocialPublishRecoveryService — the maintenance sweeps the existing
 * social scheduler tick runs BEFORE it publishes due posts (see
 * socialSchedulerService.js; this is not a second scheduler, just three
 * plain async functions it calls, in the same style as
 * executeDuePublications):
 *
 *   recoverStalePublications  — a row stuck in 'publishing' (crashed /
 *       restarted / OOM-killed worker, DB save failure) whose lock is older
 *       than the stale threshold is reconciled against Meta, never blindly
 *       re-published.
 *   reconcileUnknownOutcomes  — rows already parked as 'failed' +
 *       outcomeUnknown (a publish whose response was lost) are re-checked
 *       against Meta until resolved or the give-up window passes.
 *   markMissedPublications    — scheduled posts that are too late to publish
 *       automatically are failed with SCHEDULE_MISSED (see maxLatenessMs).
 *
 * Concurrency: every sweep first takes its own atomic claim on a row
 * (findOneAndUpdate that only matches while the row still looks unhandled)
 * before acting, so N workers/PM2 instances running the same sweep at the
 * same moment can never double-process a row. All state changes afterwards
 * are conditional on that claim (see publicationLifecycle.js).
 */

const MAX_PER_SWEEP = 50;

/**
 * Every sweep accepts an optional `projectId` that narrows it to one project.
 * Production ticks never pass it (they sweep everything); it exists so an
 * ops/"run now" call — and tests sharing one database across parallel
 * processes — can act on a single project without touching anyone else's rows.
 */
/**
 * The project part of every sweep's filter: the requested project, or every project EXCEPT those in the trash - a trashed
 * project's posts are neither recovered, reconciled against Meta nor marked missed (a restore finds them as they were).
 * See projectLifecycleGuard.js.
 */
const scopeFor = (projectId) => activeProjectScope(projectId);

function staleFilter(staleBefore, scope) {
  return {
    ...scope,
    status: 'publishing',
    $or: [
      { publishingStartedAt: { $lt: staleBefore } },
      // Rows stuck by the pre-lock-field code have no publishingStartedAt;
      // their last write (the claim itself) is the best available age.
      { publishingStartedAt: null, updatedAt: { $lt: staleBefore } },
    ],
  };
}

export async function recoverStalePublications({ now = new Date(), config = getPublishConfig(), projectId = null } = {}) {
  const staleBefore = new Date(now.getTime() - config.staleMs);
  const filter = staleFilter(staleBefore, await scopeFor(projectId));
  const candidates = await SocialPublication.find(filter).sort({ publishingStartedAt: 1 }).limit(MAX_PER_SWEEP);

  const summary = { found: candidates.length, recovered: 0, published: 0, requeued: 0, quarantined: 0, skipped: 0 };
  const recoveryLock = `recovery:${getInstanceId()}`;

  for (const candidate of candidates) {
    // When did the orphaned attempt begin? Captured BEFORE the claim below
    // overwrites publishingStartedAt — reconciliation looks for a post
    // created since THAT moment.
    const attemptStart = candidate.lastAttemptAt || candidate.publishingStartedAt || candidate.updatedAt;

    // Atomic recovery claim: refreshes the lock timestamp, so the row is no
    // longer "stale" to any other sweeper — only one of them gets a match.
    const claimed = await SocialPublication.findOneAndUpdate(
      { _id: candidate._id, ...filter },
      { $set: { publishingStartedAt: now, lockedBy: recoveryLock } },
      { new: true },
    );
    if (!claimed) { summary.skipped += 1; continue; }

    try {
      const guard = { status: 'publishing', lockedBy: recoveryLock };
      const result = await reconcileUnknownPublication(claimed, { since: attemptStart, requireSettled: false, now, config });

      if (result.resolution === 'published') {
        summary.published += 1;
      } else if (result.resolution === 'not_published') {
        const { retryScheduled } = await applyNotPublished(claimed, guard, { now, config });
        if (retryScheduled) summary.requeued += 1;
      } else {
        await quarantineUnknown(claimed, guard, result.reason, { now });
        summary.quarantined += 1;
      }
      summary.recovered += 1;
      LoggerUtil.service('SocialRecovery', 'stale_publishing', result.resolution, { publicationId: String(claimed._id), reason: result.reason || null });
    } catch (error) {
      // Leave the (refreshed) lock in place: the row becomes stale again
      // after another staleMs and is retried — never crash the whole sweep.
      LoggerUtil.error('[SOCIAL_RECOVERY] Failed to recover a stale publication', { message: error.message }, { publicationId: String(claimed._id) });
    }
  }
  return summary;
}

export async function reconcileUnknownOutcomes({ now = new Date(), config = getPublishConfig(), projectId = null } = {}) {
  const settledBefore = new Date(now.getTime() - config.reconcileSettleMs);
  const giveUpBefore = new Date(now.getTime() - config.reconcileGiveUpMs);
  const filter = {
    ...(await scopeFor(projectId)),
    status: 'failed',
    outcomeUnknown: true,
    lastAttemptAt: { $lte: settledBefore, $gte: giveUpBefore },
    $or: [{ reconcileCheckedAt: null }, { reconcileCheckedAt: { $lte: settledBefore } }],
  };
  const candidates = await SocialPublication.find(filter).sort({ lastAttemptAt: 1 }).limit(MAX_PER_SWEEP);

  const summary = { found: candidates.length, published: 0, cleared: 0, stillUnknown: 0, skipped: 0 };
  for (const candidate of candidates) {
    // Atomic claim: stamps reconcileCheckedAt so a concurrent sweep (or the
    // next tick) skips this row until the settle interval has passed again.
    const claimed = await SocialPublication.findOneAndUpdate(
      { _id: candidate._id, ...filter },
      { $set: { reconcileCheckedAt: now }, $inc: { reconcileAttempts: 1 } },
      { new: true },
    );
    if (!claimed) { summary.skipped += 1; continue; }

    try {
      const result = await reconcileUnknownPublication(claimed, { requireSettled: true, now, config });
      if (result.resolution === 'published') {
        summary.published += 1;
      } else if (result.resolution === 'not_published') {
        await applyNotPublished(claimed, { status: 'failed', outcomeUnknown: true }, { now, config });
        summary.cleared += 1;
      } else {
        summary.stillUnknown += 1;
      }
    } catch (error) {
      LoggerUtil.error('[SOCIAL_RECOVERY] Failed to reconcile an unknown-outcome publication', { message: error.message }, { publicationId: String(claimed._id) });
    }
  }
  return summary;
}

/**
 * Scheduled posts too late to publish automatically — e.g. the API was
 * down/restarted, or the scheduler was disabled, across the scheduled time —
 * are failed with SCHEDULE_MISSED instead of being published late. "Too late"
 * is measured from the time the post was MEANT to go out (scheduledAt), or
 * for a post waiting on a retry from that retry's own nextRetryAt.
 * Publishing them is then a deliberate user action (Retry Publish).
 *
 * One conditional updateMany: atomic per document, and idempotent across
 * concurrent workers (the second sees nothing left to match).
 */
export async function markMissedPublications({ now = new Date(), config = getPublishConfig(), projectId = null } = {}) {
  const cutoff = new Date(now.getTime() - config.maxLatenessMs);
  const minutes = Math.round(config.maxLatenessMs / 60000);
  const res = await SocialPublication.updateMany(
    {
      ...(await scopeFor(projectId)),
      status: 'scheduled',
      $or: [
        { nextRetryAt: null, scheduledAt: { $lt: cutoff } },
        { nextRetryAt: { $ne: null, $lt: cutoff } },
      ],
    },
    {
      $set: {
        status: 'failed',
        failedAt: now,
        failureCode: 'SCHEDULE_MISSED',
        failureRetryable: true,
        failureReason: `This post was not published automatically because it was more than ${minutes} minutes past its scheduled time (the scheduler was unavailable). Review it, then publish or reschedule it.`,
        lastError: 'Scheduled time was missed.',
        lastErrorCode: 'SCHEDULE_MISSED',
        nextRetryAt: null,
      },
    },
  );
  if (res.modifiedCount > 0) {
    LoggerUtil.warn('[SOCIAL_RECOVERY] Marked overdue scheduled posts as missed', { count: res.modifiedCount, maxLatenessMinutes: minutes });
  }
  return { missed: res.modifiedCount };
}

export default { recoverStalePublications, reconcileUnknownOutcomes, markMissedPublications };
