import { schedule } from 'node-cron';
import SeoProject from '../../app_user/model/SeoProject.js';
import User from '../../user/model/User.js';
import {
  startProjectVerification,
  VERIFICATION_RESULT_CODES,
} from '../../app_user/service/projectVerificationService.js';
import { canConsumeQuota } from '../../subscription/service/subscriptionLifecycle.js';
import { RUN_SOURCES } from '../runSources.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

const SERVICE = 'WeeklyRecheckScheduler';

// Once per day by default — SeoProject.getProjectsNeedingScrape() applies the
// actual 7-day-or-never-scraped eligibility window, so daily is just the
// polling cadence, not the recheck interval itself.
//
// WEEKLY_RECRAWL_* are the original env var names (the scheduler used to start
// full Recrawls); they keep working so existing deployments don't silently
// lose their cron/kill-switch settings. WEEKLY_RECHECK_* take precedence.
const CRON_EXPRESSION = process.env.WEEKLY_RECHECK_CRON || process.env.WEEKLY_RECRAWL_CRON || '0 3 * * *';
const ENABLED = (process.env.WEEKLY_RECHECK_ENABLED ?? process.env.WEEKLY_RECRAWL_ENABLED) !== 'false';

let task = null;

/**
 * Process every project currently due for its scheduled Weekly Recheck.
 * Exported separately from start() so it can be invoked directly (tests, an
 * ops "run now" trigger) without waiting for the cron tick.
 *
 * What runs: the Quick Recheck (verification) pipeline via the shared
 * startProjectVerification() service — the same implementation behind the
 * dashboard's Quick Recheck button, tagged run source 'weekly_recheck'.
 * It NEVER starts a full Recrawl/audit and never touches billing: neither
 * project credits nor manual recrawl credits are checked or consumed.
 *
 * Safety comes from the service, not from this loop: the atomic crawl_status
 * claim + active-job guard make a double tick, a scheduler restart, a second
 * backend instance, or a manual Recrawl/Recheck already in flight all resolve
 * to ALREADY_RUNNING for every caller but one.
 *
 * A single project failing must never abort the run — every project is
 * wrapped in its own try/catch and logged independently.
 *
 * @returns {Promise<{processed:number, started:number, skipped:number, failed:number, skippedProjects:object[], failedProjects:object[]}>}
 */
export async function runOnce() {
  const startedAt = Date.now();
  LoggerUtil.service(SERVICE, 'run', 'started');

  const summary = { processed: 0, started: 0, skipped: 0, failed: 0, skippedProjects: [], failedProjects: [] };

  let dueProjects = [];
  let ownerStatusById = new Map();
  try {
    // Reuses the existing static method as-is — do not duplicate the
    // scrape_frequency / last_scraped_at eligibility logic here.
    dueProjects = await SeoProject.getProjectsNeedingScrape();

    // Existing subscription rules (subscriptionLifecycle.js): only an
    // 'active' subscription may consume quota. A Weekly Recheck consumes none,
    // but it does cost compute, so it is limited to owners in good standing.
    const ownerIds = [...new Set(dueProjects.map((p) => p.user_id?.toString()).filter(Boolean))];
    if (ownerIds.length > 0) {
      const owners = await User.find({ _id: { $in: ownerIds } }).select('subscription.status').lean();
      ownerStatusById = new Map(owners.map((u) => [u._id.toString(), u.subscription?.status]));
    }
  } catch (error) {
    LoggerUtil.error(`${SERVICE}: failed to load due projects`, error);
    LoggerUtil.service(SERVICE, 'run', 'failed', { durationMs: Date.now() - startedAt });
    return summary;
  }

  LoggerUtil.info(`${SERVICE}: projects due`, { count: dueProjects.length });

  for (const project of dueProjects) {
    summary.processed += 1;
    const projectId = project._id.toString();

    try {
      if (!canConsumeQuota(ownerStatusById.get(project.user_id?.toString()))) {
        summary.skipped += 1;
        summary.skippedProjects.push({ projectId, reason: 'SUBSCRIPTION_NOT_ACTIVE' });
        LoggerUtil.info(`${SERVICE}: project skipped — owner subscription not active`, { projectId });
        continue;
      }

      const result = await startProjectVerification(projectId, {
        source: RUN_SOURCES.WEEKLY_RECHECK,
      });

      if (result.success) {
        summary.started += 1;
        LoggerUtil.info(`${SERVICE}: weekly recheck triggered`, {
          projectId,
          main_url: project.main_url,
          run_source: RUN_SOURCES.WEEKLY_RECHECK,
        });
      } else if (result.code === VERIFICATION_RESULT_CODES.ALREADY_RUNNING) {
        summary.skipped += 1;
        summary.skippedProjects.push({ projectId, reason: result.code });
        LoggerUtil.info(`${SERVICE}: project skipped — run already in progress`, { projectId });
      } else {
        summary.skipped += 1;
        summary.skippedProjects.push({ projectId, reason: result.code });
        LoggerUtil.warn(`${SERVICE}: project skipped`, {
          projectId,
          reason: result.code,
          message: result.message,
        });
      }
    } catch (error) {
      // Unexpected failure for this one project — log and keep going. The
      // project stays eligible (last_scraped_at is untouched), so the next
      // daily tick retries it; nothing is billed either way.
      summary.failed += 1;
      summary.failedProjects.push({ projectId, error: error.message });
      LoggerUtil.error(`${SERVICE}: project failed`, error, { projectId });
    }
  }

  LoggerUtil.service(SERVICE, 'run', 'completed', {
    durationMs: Date.now() - startedAt,
    processed: summary.processed,
    started: summary.started,
    skipped: summary.skipped,
    failed: summary.failed,
  });

  return summary;
}

/**
 * Start the daily cron tick. Safe to call once at server boot — no-ops if
 * already started. Set WEEKLY_RECHECK_ENABLED=false (or the legacy
 * WEEKLY_RECRAWL_ENABLED=false) to disable without a code change (e.g. to
 * pause automatic rechecks in an incident).
 */
export function startWeeklyRecheckScheduler() {
  if (!ENABLED) {
    LoggerUtil.service(SERVICE, 'init', 'disabled', { reason: 'WEEKLY_RECHECK_ENABLED/WEEKLY_RECRAWL_ENABLED=false' });
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
    // node-cron's own re-entrancy guard: if a run is still in progress when
    // the next tick fires (shouldn't happen at a once-a-day cadence, but a
    // stuck run must never overlap with itself), the new tick is skipped.
    { noOverlap: true }
  );

  LoggerUtil.service(SERVICE, 'init', 'scheduled', { cronExpression: CRON_EXPRESSION });
  return task;
}

export function stopWeeklyRecheckScheduler() {
  if (task) {
    task.stop();
    task = null;
    LoggerUtil.service(SERVICE, 'stop', 'completed');
  }
}
