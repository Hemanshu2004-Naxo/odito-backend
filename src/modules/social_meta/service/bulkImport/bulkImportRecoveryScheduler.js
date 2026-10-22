import { schedule } from 'node-cron';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';
import { recoverStaleImportingBatches } from './bulkImportRecoveryService.js';

const SERVICE = 'BulkImportRecoveryScheduler';

// Every 2 minutes. A bulk import runs sub-second normally, so the sweep
// itself is cheap and rare; 2 min keeps a genuinely-stuck import from
// blocking a project's next upload for long. Env-overridable, and the
// whole scheduler is opt-out via BULK_IMPORT_RECOVERY_ENABLED=false —
// same convention as staleLockScheduler / verificationBatchRecoveryScheduler.
const CRON_EXPRESSION = process.env.BULK_IMPORT_RECOVERY_CRON || '*/2 * * * *';
const ENABLED = process.env.BULK_IMPORT_RECOVERY_ENABLED !== 'false';
const STALE_THRESHOLD_MS = Number(process.env.BULK_IMPORT_STALE_THRESHOLD_MS) || 10 * 60 * 1000;

let task = null;
let lastRun = null;

/**
 * Run one recovery pass. Exported separately from start() so tests / an
 * ops "run now" can invoke it directly.
 * @returns {Promise<{ checked: number, recovered: number, skipped: number }>}
 */
export async function runOnce() {
  const startedAt = Date.now();
  let result = { checked: 0, recovered: 0, skipped: 0 };
  try {
    result = await recoverStaleImportingBatches({ staleThresholdMs: STALE_THRESHOLD_MS });
    if (result.recovered > 0 || result.checked > 0) {
      LoggerUtil.service(SERVICE, 'run', 'completed', {
        durationMs: Date.now() - startedAt,
        checked: result.checked,
        recovered: result.recovered,
        skipped: result.skipped,
      });
    }
  } catch (error) {
    LoggerUtil.error(`${SERVICE}: sweep failed`, error);
    LoggerUtil.service(SERVICE, 'run', 'failed', { durationMs: Date.now() - startedAt });
  }
  lastRun = { at: new Date(), durationMs: Date.now() - startedAt, ...result };
  return result;
}

/** Read-only observability snapshot (matches the other recovery schedulers). */
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
 * Start the periodic stale-import recovery sweep. Safe to call once at
 * server boot — no-ops if already started. Set
 * BULK_IMPORT_RECOVERY_ENABLED=false to disable without a code change.
 */
export function startBulkImportRecoveryScheduler() {
  if (!ENABLED) {
    LoggerUtil.service(SERVICE, 'init', 'disabled', { reason: 'BULK_IMPORT_RECOVERY_ENABLED=false' });
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
    // node-cron's re-entrancy guard — a still-running sweep skips the next
    // tick rather than overlapping.
    { noOverlap: true },
  );

  LoggerUtil.service(SERVICE, 'init', 'scheduled', {
    cronExpression: CRON_EXPRESSION,
    staleThresholdMs: STALE_THRESHOLD_MS,
  });
  return task;
}

export function stopBulkImportRecoveryScheduler() {
  if (task) {
    task.stop();
    task = null;
    LoggerUtil.service(SERVICE, 'stop', 'completed');
  }
}
