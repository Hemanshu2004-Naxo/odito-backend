import { schedule } from 'node-cron';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import {
  reclaimDueProjectTaskVerificationJobs,
  detectOrphanedAggregationJobs,
  recoverStalledAggregationBatches,
} from './verificationBatchRecoveryService.js';

const SERVICE = 'VerificationBatchRecoveryScheduler';

// F4-018: every 30 seconds — deliberately more frequent than
// staleLockScheduler's 5-minute cycle. PROJECT_TASK_VERIFICATION retries
// (reclaimDueProjectTaskVerificationJobs) depend entirely on this scheduler
// (no Python worker ever claims that job type), and a Verification Batch's
// completion latency is directly gated on how quickly a due retry gets
// picked back up, so this tick is tuned for responsiveness rather than
// sweep-cost — each check is a handful of cheap indexed queries.
const CRON_EXPRESSION = process.env.VERIFICATION_BATCH_RECOVERY_CRON || '*/30 * * * * *';
const ENABLED = process.env.VERIFICATION_BATCH_RECOVERY_ENABLED !== 'false';
const STALE_THRESHOLD_MS = Number(process.env.VERIFICATION_BATCH_STALE_THRESHOLD_MS) || 15 * 60 * 1000;

let task = null;
// ODITO-OPS-001: purely additive observability state — see the identical
// note in staleLockScheduler.js. Never influences the sweep itself.
let lastRun = null;

/**
 * Run one recovery pass. Exported separately from start() so it can be
 * invoked directly (tests, an ops "run now" trigger) without waiting for
 * the cron tick.
 *
 * @returns {Promise<{reclaimedCount:number, orphanedCount:number, orphansTerminated:number, orphansSkipped:number, checked:number, resumedCount:number}>}
 */
export async function runOnce() {
  const requestId = `batch_recovery_${Date.now()}`;
  const startedAt = Date.now();

  let reclaimResult = { reclaimedCount: 0 };
  try {
    reclaimResult = await reclaimDueProjectTaskVerificationJobs(requestId);
  } catch (error) {
    LoggerUtil.error(`${SERVICE}: PROJECT_TASK_VERIFICATION reclaim failed`, error);
  }

  // orphanedCount: in-flight aggregation/task-verification jobs whose batch
  // has already left AGGREGATING (or never existed). terminatedCount: how
  // many of those were verifiably dead (batch terminal/missing) and were
  // directly closed out to 'failed' - this is what used to stay 0 forever,
  // logging the same orphans every tick with no remediation (see
  // detectOrphanedAggregationJobs' doc comment). skippedCount: orphans
  // whose batch is PENDING/RUNNING - a different, deeper anomaly,
  // deliberately left for investigation rather than auto-repaired.
  let orphanResult = { orphanedCount: 0, terminatedCount: 0, skippedCount: 0 };
  try {
    orphanResult = await detectOrphanedAggregationJobs();
  } catch (error) {
    LoggerUtil.error(`${SERVICE}: orphaned aggregation job detection failed`, error);
  }

  let batchResult = { checked: 0, resumedCount: 0 };
  try {
    batchResult = await recoverStalledAggregationBatches({ staleThresholdMs: STALE_THRESHOLD_MS, requestId });
  } catch (error) {
    LoggerUtil.error(`${SERVICE}: stalled batch recovery failed`, error);
  }

  if (reclaimResult.reclaimedCount > 0 || orphanResult.orphanedCount > 0 || batchResult.resumedCount > 0) {
    LoggerUtil.service(SERVICE, 'run', 'completed', {
      durationMs: Date.now() - startedAt,
      reclaimedCount: reclaimResult.reclaimedCount,
      orphanedCount: orphanResult.orphanedCount,
      orphansTerminated: orphanResult.terminatedCount,
      orphansSkipped: orphanResult.skippedCount,
      batchesChecked: batchResult.checked,
      batchesResumed: batchResult.resumedCount,
    });
  }

  lastRun = {
    at: new Date(),
    durationMs: Date.now() - startedAt,
    reclaimedCount: reclaimResult.reclaimedCount,
    orphanedCount: orphanResult.orphanedCount,
    orphansTerminated: orphanResult.terminatedCount,
    orphansSkipped: orphanResult.skippedCount,
    batchesChecked: batchResult.checked,
    batchesResumed: batchResult.resumedCount,
  };

  return {
    reclaimedCount: reclaimResult.reclaimedCount,
    orphanedCount: orphanResult.orphanedCount,
    orphansTerminated: orphanResult.terminatedCount,
    orphansSkipped: orphanResult.skippedCount,
    checked: batchResult.checked,
    resumedCount: batchResult.resumedCount,
  };
}

/**
 * ODITO-OPS-001: read-only observability snapshot for the Operations
 * Dashboard's Worker Health view — see staleLockScheduler.getSchedulerHealth's
 * identical rationale.
 *
 * @returns {{enabled:boolean, running:boolean, cronExpression:string, staleThresholdMs:number, lastRun:object|null}}
 */
export function getSchedulerHealth() {
  return {
    enabled: ENABLED,
    running: !!task,
    cronExpression: CRON_EXPRESSION,
    staleThresholdMs: STALE_THRESHOLD_MS,
    lastRun,
  };
}

/**
 * Start the periodic Verification Batch recovery sweep. Safe to call once
 * at server boot — no-ops if already started. Set
 * VERIFICATION_BATCH_RECOVERY_ENABLED=false to disable without a code change.
 */
export function startVerificationBatchRecoveryScheduler() {
  if (!ENABLED) {
    LoggerUtil.service(SERVICE, 'init', 'disabled', { reason: 'VERIFICATION_BATCH_RECOVERY_ENABLED=false' });
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
    // node-cron's own re-entrancy guard: if a sweep is still in progress
    // when the next tick fires, the new tick is skipped rather than
    // overlapping — matches staleLockScheduler's own convention.
    { noOverlap: true }
  );

  LoggerUtil.service(SERVICE, 'init', 'scheduled', {
    cronExpression: CRON_EXPRESSION,
    staleThresholdMs: STALE_THRESHOLD_MS,
  });
  return task;
}

export function stopVerificationBatchRecoveryScheduler() {
  if (task) {
    task.stop();
    task = null;
    LoggerUtil.service(SERVICE, 'stop', 'completed');
  }
}
