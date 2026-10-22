import { schedule } from 'node-cron';
import { JobService } from './jobService.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

const SERVICE = 'StaleLockScheduler';

// Every 5 minutes — jobs held in 'processing' past LOCK_TIMEOUT_MS (default
// 10 minutes, matching JobService.cleanupStaleLocks' own default) are reset
// to 'failed' so any per-jobType/target-URL uniqueness lock they were
// holding (e.g. the AI_VISIBILITY partial index) is released. Without this
// sweep, a worker crash mid-job permanently blocks that lock forever —
// cleanupStaleLocks previously existed but was dead code (wrong field name,
// never called from anywhere), so this is the first time it actually runs.
const CRON_EXPRESSION = process.env.STALE_LOCK_CRON || '*/5 * * * *';
const ENABLED = process.env.STALE_LOCK_CLEANUP_ENABLED !== 'false';
const LOCK_TIMEOUT_MS = Number(process.env.STALE_LOCK_TIMEOUT_MS) || 10 * 60 * 1000;

const jobService = new JobService();

let task = null;
// ODITO-OPS-001: purely additive observability state — read by the
// Operations Dashboard's Worker Health view (getSchedulerHealth below).
// Never influences scheduling cadence, retry decisions, or which jobs are
// swept; it only remembers what the LAST tick already did.
let lastRun = null;

/**
 * Run one stale-lock sweep. Exported separately from start() so it can be
 * invoked directly (tests, an ops "run now" trigger) without waiting for the
 * cron tick.
 *
 * @returns {Promise<{modifiedCount:number}>}
 */
export async function runOnce() {
  const startedAt = Date.now();
  LoggerUtil.service(SERVICE, 'run', 'started', { lockTimeoutMs: LOCK_TIMEOUT_MS });

  let result = { modifiedCount: 0 };
  try {
    result = await jobService.cleanupStaleLocks(LOCK_TIMEOUT_MS);

    LoggerUtil.service(SERVICE, 'run', 'completed', {
      durationMs: Date.now() - startedAt,
      modifiedCount: result.modifiedCount,
    });
  } catch (error) {
    LoggerUtil.error(`${SERVICE}: sweep failed`, error);
    LoggerUtil.service(SERVICE, 'run', 'failed', { durationMs: Date.now() - startedAt });
  }

  // H2: same cron tick, same scheduler, same timeout constant — reused, not
  // a second scheduling system. Isolated in its own try/catch so a failure
  // here never masks (or is masked by) cleanupStaleLocks' own result above.
  let orphanResult = { modifiedCount: 0 };
  try {
    orphanResult = await jobService.recoverOrphanedUrlVerificationJobs(LOCK_TIMEOUT_MS);
    if (orphanResult.modifiedCount > 0) {
      LoggerUtil.service(SERVICE, 'run', 'orphaned-url-verification-recovered', {
        modifiedCount: orphanResult.modifiedCount,
      });
    }
  } catch (error) {
    LoggerUtil.error(`${SERVICE}: orphaned URL Verification recovery failed (non-fatal)`, error);
  }

  lastRun = {
    at: new Date(),
    durationMs: Date.now() - startedAt,
    staleLocksRecovered: result.modifiedCount,
    orphanedJobsRecovered: orphanResult.modifiedCount,
  };

  return result;
}

/**
 * ODITO-OPS-001: read-only observability snapshot for the Operations
 * Dashboard's Worker Health view. Never mutates anything and has no effect
 * on scheduling — `task` and `lastRun` already existed as module state for
 * their own reasons; this just exposes them.
 *
 * @returns {{enabled:boolean, running:boolean, cronExpression:string, lockTimeoutMs:number, lastRun:object|null}}
 */
export function getSchedulerHealth() {
  return {
    enabled: ENABLED,
    running: !!task,
    cronExpression: CRON_EXPRESSION,
    lockTimeoutMs: LOCK_TIMEOUT_MS,
    lastRun,
  };
}

/**
 * Start the periodic stale-lock sweep. Safe to call once at server boot —
 * no-ops if already started. Set STALE_LOCK_CLEANUP_ENABLED=false to disable
 * without a code change.
 */
export function startStaleLockScheduler() {
  if (!ENABLED) {
    LoggerUtil.service(SERVICE, 'init', 'disabled', { reason: 'STALE_LOCK_CLEANUP_ENABLED=false' });
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
    // node-cron's own re-entrancy guard: if a sweep is still in progress when
    // the next tick fires, the new tick is skipped rather than overlapping.
    { noOverlap: true }
  );

  LoggerUtil.service(SERVICE, 'init', 'scheduled', {
    cronExpression: CRON_EXPRESSION,
    lockTimeoutMs: LOCK_TIMEOUT_MS,
  });
  return task;
}

export function stopStaleLockScheduler() {
  if (task) {
    task.stop();
    task = null;
    LoggerUtil.service(SERVICE, 'stop', 'completed');
  }
}
