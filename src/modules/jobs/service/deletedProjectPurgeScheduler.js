import { schedule } from 'node-cron';
import SeoProject from '../../app_user/model/SeoProject.js';
import { deleteProjectCascade } from '../../app_user/service/projectCascadeDeleteService.js';
import { purgeOrphanedSocialData } from '../../social_meta/service/socialProjectCleanupService.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

const SERVICE = 'DeletedProjectPurgeScheduler';

// Daily, offset an hour after the Weekly Recheck scheduler's default 03:00
// slot so the two never contend for the same tick.
const CRON_EXPRESSION = process.env.PROJECT_PURGE_CRON || '0 4 * * *';
const ENABLED = process.env.PROJECT_PURGE_ENABLED !== 'false';

let task = null;

/**
 * Purge every project whose trash retention window has elapsed. Exported
 * separately from start() so it can be invoked directly (tests, an ops
 * "run now" trigger) without waiting for the cron tick.
 *
 * A single project failing must never abort the run — every project is
 * wrapped in its own try/catch and logged independently (Phase 3 failure
 * handling requirement).
 *
 * @returns {Promise<{processed:number, purged:number, failed:number, failedProjects:object[]}>}
 */
export async function runOnce() {
  const startedAt = Date.now();
  LoggerUtil.service(SERVICE, 'run', 'started');

  const summary = { processed: 0, purged: 0, failed: 0, failedProjects: [] };

  let dueProjects = [];
  try {
    // Restoring a project (Phase 2) sets is_deleted back to false, so it can
    // never match this query again — Scenario 1 is satisfied by this filter
    // alone, no extra check needed.
    dueProjects = await SeoProject.find({
      is_deleted: true,
      scheduled_purge_at: { $lte: new Date() },
    }).select('_id').lean();
  } catch (error) {
    LoggerUtil.error(`${SERVICE}: failed to load projects due for purge`, error);
    LoggerUtil.service(SERVICE, 'run', 'failed', { durationMs: Date.now() - startedAt });
    return summary;
  }

  LoggerUtil.info(`${SERVICE}: projects due for purge`, { count: dueProjects.length });

  for (const project of dueProjects) {
    summary.processed += 1;
    const projectId = project._id.toString();

    try {
      const result = await deleteProjectCascade(projectId);

      if (result.projectDeleted) {
        summary.purged += 1;
        LoggerUtil.info(`${SERVICE}: project purged`, {
          projectId,
          collectionCounts: result.collectionCounts,
          screenshotCounts: result.screenshotCounts,
        });
      } else {
        // deleteProjectCascade ran but the SeoProject document itself wasn't
        // removed — treat as a failure for this project without aborting
        // the batch.
        summary.failed += 1;
        summary.failedProjects.push({ projectId, error: 'SeoProject document was not deleted', failures: result.failures });
        LoggerUtil.error(`${SERVICE}: purge did not complete`, null, { projectId, failures: result.failures });
      }
    } catch (error) {
      summary.failed += 1;
      summary.failedProjects.push({ projectId, error: error.message });
      LoggerUtil.error(`${SERVICE}: purge failed`, error, { projectId });
    }
  }

  // Social rows (stored credentials, scheduled posts) whose project is already gone - left behind by purges that predate
  // purgeProjectSocialData. Never aborts the run.
  try {
    summary.orphanedSocial = await purgeOrphanedSocialData();
  } catch (error) {
    LoggerUtil.error(`${SERVICE}: orphaned social data sweep failed`, error);
  }

  LoggerUtil.service(SERVICE, 'run', 'completed', {
    durationMs: Date.now() - startedAt,
    processed: summary.processed,
    purged: summary.purged,
    failed: summary.failed,
  });

  return summary;
}

/**
 * Start the daily cron tick. Safe to call once at server boot — no-ops if
 * already started. Set PROJECT_PURGE_ENABLED=false to disable without a
 * code change.
 */
export function startDeletedProjectPurgeScheduler() {
  if (!ENABLED) {
    LoggerUtil.service(SERVICE, 'init', 'disabled', { reason: 'PROJECT_PURGE_ENABLED=false' });
    return null;
  }

  if (task) {
    LoggerUtil.warn(`${SERVICE}: start called but scheduler is already running`);
    return task;
  }

  task = schedule(
    CRON_EXPRESSION,
    () => {
      runOnce().catch((error) => {
        LoggerUtil.error(`${SERVICE}: run crashed unexpectedly`, error);
      });
    },
    { noOverlap: true }
  );

  LoggerUtil.service(SERVICE, 'init', 'scheduled', { cronExpression: CRON_EXPRESSION });
  return task;
}

export function stopDeletedProjectPurgeScheduler() {
  if (task) {
    task.stop();
    task = null;
    LoggerUtil.service(SERVICE, 'stop', 'completed');
  }
}
