import { schedule } from 'node-cron';
import { recoverInterruptedCalendars } from './calendarGenerationRunner.js';
import { reconcileQuotaReservations } from './calendarQuotaService.js';
import { CALENDAR_RECOVERY_CRON, CALENDAR_RECOVERY_ENABLED } from './calendarConfig.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';
import { recordRecoverySweep } from '../../../../monitoring/socialAiMetrics.js';

/**
 * Content Calendar recovery sweep. A generation is a long job running inside one API process; if that process dies, restarts or
 * hangs, its lease stops being renewed and expires. This tick (every minute by default, on every instance) takes over such
 * generations and continues them from the posts already saved - so a restart costs the person a minute, not a calendar and not
 * a lockout. It is safe to run on many instances at once: every take-over is one conditional database update, so exactly one wins.
 * A generation that is waiting out a transient failure is picked up the same way when its retry time arrives, and one that has used
 * up its attempts is finished as `partial` (the person can resume it) instead of being retried forever.
 *
 * SOCIAL_AI_CALENDAR_RECOVERY_ENABLED=false turns the tick off (a request that reads the calendar still recovers its own project's).
 */

const SERVICE = 'CalendarRecovery';
let task = null;

/** One sweep. Exported for tests and for an ops "run now". Never throws. */
export async function runOnce({ now = new Date() } = {}) {
  try {
    const summary = await recoverInterruptedCalendars({ now });
    // reservations of generations that are gone or finished without settling are released, so an allowance can never leak
    summary.quota = await reconcileQuotaReservations({ now });
    recordRecoverySweep(true);
    if (summary.found) LoggerUtil.info(`${SERVICE}: sweep`, summary);
    return summary;
  } catch (error) {
    recordRecoverySweep(false);
    LoggerUtil.error(`${SERVICE}: sweep failed`, { message: error.message });
    return { found: 0, resumed: 0, finished: 0, error: error.message };
  }
}

export function startCalendarRecoveryScheduler() {
  if (!CALENDAR_RECOVERY_ENABLED) {
    LoggerUtil.service(SERVICE, 'init', 'disabled', { reason: 'SOCIAL_AI_CALENDAR_RECOVERY_ENABLED=false' });
    return null;
  }
  if (task) return task;
  task = schedule(CALENDAR_RECOVERY_CRON, () => { runOnce().catch(() => {}); }, { noOverlap: true });
  LoggerUtil.service(SERVICE, 'init', 'scheduled', { cron: CALENDAR_RECOVERY_CRON });
  return task;
}

export function stopCalendarRecoveryScheduler() {
  if (task) {
    task.stop();
    task = null;
  }
}

export default { runOnce, startCalendarRecoveryScheduler, stopCalendarRecoveryScheduler };
