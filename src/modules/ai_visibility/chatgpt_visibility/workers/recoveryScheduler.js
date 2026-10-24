import { schedule } from 'node-cron';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';
import { getChatGptConfig } from '../config/chatgptConfig.js';
import * as runs from '../services/runService.js';
import { emitVisibilityEvent } from '../services/visibilityEvents.js';
import { repairMissingRuns } from '../services/auditTriggerService.js';
import { drainQueue } from './runWorker.js';
import { finalizeExhaustedApprovedRun } from './approvedRunWorker.js';
import { computeVisibilityMetrics } from '../../shared/services/visibilityMetricsService.js';

/**
 * Recovery sweep for ChatGPT visibility (every minute by default, on every instance; every take-over is one conditional update so
 * exactly one instance wins). It distinguishes the states a run can be left in:
 *
 *   queued                         -> claimed and started when capacity allows
 *   running, lease still valid     -> left alone (a live worker owns it)
 *   running, lease expired,
 *       claims left                -> re-claimed; only `pending` executions are sent again
 *       claims exhausted           -> finalized here (completed prompts kept, the rest marked skipped), never retried again
 *   completed/partial/failed/...   -> untouched
 *   audit started, no run record   -> created (crash safety, see auditTriggerService)
 *
 * CHATGPT_VISIBILITY_SWEEP_ENABLED=false turns the tick off. With CHATGPT_VISIBILITY_ENABLED=false the sweep does nothing at all.
 */

const SERVICE = 'ChatGptVisibilityRecovery';
let task = null;
let startupTimer = null;

async function finalizeExhaustedRuns({ config, now, Model }) {
  const found = await runs.findExhausted({ now: now(), config, ...(Model ? { Model } : {}) });
  let finalized = 0;
  for (const run of found) {
    if (run.executionMode === 'approved_questions') {
      // Results live in evidence documents, not in `executions`: finalize from those (answered questions are kept).
      const done = await finalizeExhaustedApprovedRun(run, { config, now, Model });
      if (done) finalized += 1;
      continue;
    }
    const executions = (run.executions || []).map((e) => (e.status === 'pending' ? { ...e, status: 'skipped', errorCode: 'RUN_ATTEMPTS_EXHAUSTED', executedAt: now() } : e));
    const succeeded = executions.filter((e) => e.status === 'succeeded').length;
    const status = succeeded === 0 ? 'failed' : (succeeded === executions.length ? 'completed' : 'partial');
    let amount = 0; let known = 0; let unknownCount = 0;
    for (const e of executions) if (e.status === 'succeeded') { if (typeof e.cost === 'number') { amount += e.cost; known += 1; } else unknownCount += 1; }
    const done = await runs.finalizeAbandoned({
      run, status, executions,
      metrics: run.target && executions.length ? computeVisibilityMetrics(executions, run.target) : null,
      totalCost: { amount: known ? amount : null, unit: known ? config.costUnit : null, unknownCount },
      failureCode: status === 'completed' ? null : 'RUN_ATTEMPTS_EXHAUSTED',
      failureMessage: status === 'completed' ? null : 'The run was interrupted too many times',
      now: now(), ...(Model ? { Model } : {}),
    });
    if (done) { finalized += 1; emitVisibilityEvent(status === 'failed' ? 'failed' : 'completed', done); }
  }
  return finalized;
}

/** One sweep. Exported for tests and an ops "run now". Never throws. */
export async function runOnce({ config = getChatGptConfig(), now = () => new Date(), Model = null, drain = drainQueue, repair = repairMissingRuns } = {}) {
  const summary = { finalizedExhausted: 0, repaired: 0, started: 0 };
  if (!config.enabled) return summary;
  try { summary.finalizedExhausted = await finalizeExhaustedRuns({ config, now, Model }); } catch (e) { LoggerUtil.error(`${SERVICE}: exhausted-run sweep failed`, { message: e?.message?.slice(0, 200) }); }
  try { summary.repaired = await repair({ config, now, ...(Model ? { Model } : {}) }); } catch (e) { LoggerUtil.error(`${SERVICE}: repair failed`, { message: e?.message?.slice(0, 200) }); }
  try { summary.started = await drain({ config, now, ...(Model ? { Model } : {}) }); } catch (e) { LoggerUtil.error(`${SERVICE}: drain failed`, { message: e?.message?.slice(0, 200) }); }
  if (summary.finalizedExhausted || summary.repaired || summary.started) LoggerUtil.info(`${SERVICE}: sweep`, summary);
  return summary;
}

export function startChatGptVisibilityScheduler() {
  const config = getChatGptConfig();
  if (!config.enabled || !config.sweepEnabled) {
    LoggerUtil.service(SERVICE, 'init', 'disabled', { enabled: config.enabled, sweepEnabled: config.sweepEnabled });
    return null;
  }
  if (task) return task;
  task = schedule(config.sweepCron, () => { runOnce().catch(() => {}); }, { noOverlap: true });
  // Pick up what a restart interrupted without waiting a full minute.
  startupTimer = setTimeout(() => { runOnce().catch(() => {}); }, 5_000);
  startupTimer.unref?.();
  LoggerUtil.service(SERVICE, 'init', 'scheduled', { cron: config.sweepCron });
  return task;
}

export function stopChatGptVisibilityScheduler() {
  if (task) { task.stop(); task = null; }
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
}

export default { runOnce, startChatGptVisibilityScheduler, stopChatGptVisibilityScheduler };
