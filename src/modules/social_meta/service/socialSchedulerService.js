import { schedule } from 'node-cron';
import { executeDuePublications } from './socialPublishingService.js';
import { recoverStalePublications, reconcileUnknownOutcomes } from './socialPublishRecoveryService.js';
import { getSocialSchedulerState } from '../../../config/env.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

const SERVICE = 'SocialSchedulerService';

// Every minute by default — a scheduled post should go out close to its
// chosen time, not up to a day late the way the recrawl scheduler's daily
// cadence would be fine with.
const DEFAULT_CRON_EXPRESSION = '* * * * *';

let task = null;

// Observability: the last tick's outcome, readable by a health endpoint /
// ops script without parsing logs. In-memory and per-process by design (each
// PM2 instance reports its own); never used for any publish decision.
const runtimeStatus = {
  enabled: false,
  disabledReason: null,
  running: false,
  cronExpression: null,
  lastRunAt: null,
  lastRunDurationMs: null,
  lastRunError: null,
  lastSummary: null,
};

/** Snapshot of this process's scheduler state (safe to expose; no secrets). */
export function getSchedulerStatus() {
  return { ...runtimeStatus };
}

/**
 * One scheduler tick. Order matters:
 *   1. recoverStalePublications — resolve rows orphaned in 'publishing' by a
 *      crash/restart (reconcile with Meta; never blind re-publish),
 *   2. reconcileUnknownOutcomes — re-check publishes whose response was lost,
 *   3. executeDuePublications  — fail anything too late (SCHEDULE_MISSED), then
 *      publish what is due. The atomic claim inside publishNow, not this
 *      sequencing, is what makes concurrent PM2 instances safe.
 * `projectId` (optional, never passed by the cron) scopes the tick to one
 * project for ops/"run now" use. Each stage is isolated: a failure in one is logged and never prevents the
 * next, and nothing here can throw out of the tick (the API process must
 * never crash because Mongo/Meta hiccupped).
 */
export async function runOnce({ projectId = null } = {}) {
  const startedAt = Date.now();
  LoggerUtil.service(SERVICE, 'run', 'started');
  const summary = { stale: null, unknownOutcomes: null, processed: 0, succeeded: 0, failed: 0, skipped: 0, missed: 0, results: [] };
  let firstError = null;

  try {
    summary.stale = await recoverStalePublications({ projectId });
  } catch (error) {
    firstError = firstError || error;
    LoggerUtil.error(`${SERVICE}: stale-publication recovery failed`, error);
  }

  try {
    summary.unknownOutcomes = await reconcileUnknownOutcomes({ projectId });
  } catch (error) {
    firstError = firstError || error;
    LoggerUtil.error(`${SERVICE}: unknown-outcome reconciliation failed`, error);
  }

  try {
    Object.assign(summary, await executeDuePublications({ projectId }));
  } catch (error) {
    firstError = firstError || error;
    LoggerUtil.error(`${SERVICE}: run failed`, error);
  }

  runtimeStatus.lastRunAt = new Date().toISOString();
  runtimeStatus.lastRunDurationMs = Date.now() - startedAt;
  runtimeStatus.lastRunError = firstError ? firstError.message : null;
  runtimeStatus.lastSummary = { ...summary, results: undefined };

  LoggerUtil.service(SERVICE, 'run', firstError ? 'completed_with_errors' : 'completed', { durationMs: runtimeStatus.lastRunDurationMs, ...summary, results: undefined });
  return summary;
}

/**
 * Safe to call once at server boot — no-ops if already started or disabled.
 *
 * SOCIAL_SCHEDULER_ENABLED / SOCIAL_SCHEDULER_CRON are read HERE, at call
 * time — deliberately NOT as module-top-level constants. This project is
 * native ESM ("type":"module" in package.json). server.js calls
 * dotenv.config() as a statement in ITS OWN top-level body, but ES modules
 * fully evaluate every statically-imported dependency (this file included)
 * BEFORE the importing module's own top-level statements run, regardless
 * of where that import is textually positioned relative to dotenv.config().
 * A top-level `const ENABLED = process.env.SOCIAL_SCHEDULER_ENABLED === 'true'`
 * here would therefore always observe `undefined` — evaluated before
 * dotenv ever populates process.env — permanently freezing this scheduler
 * disabled no matter what .env actually says (confirmed: this was exactly
 * the bug — a real due 'scheduled' post sat untouched in production
 * because this line never saw the real value). Reading process.env inside
 * this function instead means it's read only once startSocialScheduler() is
 * actually CALLED (server.js's startServer(), long after dotenv.config() has
 * already run), so it correctly reflects the real configured value.
 *
 * Deliberately OPT-IN: ONLY the exact string "true" enables it (see
 * config/env.js getSocialSchedulerState — the single definition of that
 * rule). Unlike this codebase's other schedulers (weeklyRecheckScheduler.js,
 * staleLockScheduler.js — both default ON, `!== 'false'`), which only ever
 * touch Odito's own database, this one makes REAL, irreversible posts to a
 * real, external Facebook/Instagram account the moment it runs — the
 * operator must explicitly set SOCIAL_SCHEDULER_ENABLED=true. When it is
 * disabled the reason is logged at WARN on boot and exposed through
 * getSchedulerStatus(), so "scheduled posts silently never go out" is
 * observable rather than a mystery.
 */
export function startSocialScheduler() {
  const state = getSocialSchedulerState();
  runtimeStatus.enabled = state.enabled;
  runtimeStatus.disabledReason = state.reason;

  if (!state.enabled) {
    LoggerUtil.warn(`${SERVICE}: DISABLED — scheduled posts will NOT be automatically published until this is enabled`, { reason: state.reason });
    return null;
  }
  if (task) {
    LoggerUtil.warn(`${SERVICE}: start called but scheduler is already running`);
    return task;
  }

  const cronExpression = process.env.SOCIAL_SCHEDULER_CRON || DEFAULT_CRON_EXPRESSION;

  task = schedule(
    cronExpression,
    () => {
      runOnce().catch((error) => {
        LoggerUtil.error(`${SERVICE}: run crashed unexpectedly`, error);
      });
    },
    { noOverlap: true },
  );

  runtimeStatus.running = true;
  runtimeStatus.cronExpression = cronExpression;
  LoggerUtil.service(SERVICE, 'init', 'scheduled', { cronExpression });
  return task;
}

export function stopSocialScheduler() {
  if (task) {
    task.stop();
    task = null;
    runtimeStatus.running = false;
    LoggerUtil.service(SERVICE, 'stop', 'completed');
  }
}
