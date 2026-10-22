import { getDefaultRunner } from '../controller/investigationController.js';

/**
 * Crash/restart recovery for investigations. Runs once at startup and then periodically: any queued/running investigation that nobody has
 * written to for (deadline + 60s) is marked failed with INVESTIGATION_INTERRUPTED, which also releases the "one active run per page" slot.
 * Safe on several instances (every reap is one conditional update) and a no-op when nothing is stale.
 * Opt-out: INVESTIGATION_RECOVERY_ENABLED=false.
 */
const INTERVAL_MS = Number(process.env.INVESTIGATION_RECOVERY_INTERVAL_MS ?? 5 * 60 * 1000);

export async function runInvestigationRecoveryOnce(runner = getDefaultRunner()) {
  try {
    await runner.deps.store.ensureIndexes?.();
    const reaped = await runner.recoverInterrupted();
    if (reaped) console.warn(`[AI_INVESTIGATION] recovered ${reaped} interrupted investigation(s)`);
    return reaped;
  } catch (error) {
    console.error('[AI_INVESTIGATION] recovery failed:', error.message);
    return 0;
  }
}

export function startInvestigationRecoveryScheduler() {
  if (process.env.INVESTIGATION_RECOVERY_ENABLED === 'false') return null;
  runInvestigationRecoveryOnce();
  const timer = setInterval(() => { runInvestigationRecoveryOnce(); }, INTERVAL_MS);
  timer.unref?.();
  return timer;
}

export default { startInvestigationRecoveryScheduler, runInvestigationRecoveryOnce };
