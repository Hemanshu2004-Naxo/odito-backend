import { schedule } from 'node-cron';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';
import { getGoogleAioConfig } from '../config/googleAioConfig.js';
import * as runs from '../services/runService.js';
import { drainQueue, finalizeExhaustedRun } from './runWorker.js';

/**
 * Recovery sweep for Google AI Overview Visibility (every minute by default, on every instance; every take-over is one conditional
 * update so exactly one instance wins):
 *   queued                         -> claimed and started when capacity allows
 *   running, lease still valid     -> left alone
 *   running, lease expired         -> re-claimed (only `pending` questions are sent again) or, when the claim budget is used up,
 *                                     finalized here (answered questions kept, interrupted ones failed, the rest skipped)
 * With GOOGLE_AIO_VISIBILITY_ENABLED=false the sweep does nothing at all.
 */

const SERVICE = 'GoogleAioVisibilityRecovery';
let task = null;
let startupTimer = null;

async function finalizeExhaustedRuns({ config, now, Model, EvidenceModel }) {
  const found = await runs.findExhausted({ now: now(), config, ...(Model ? { Model } : {}) });
  let finalized = 0;
  for (const run of found) {
    const done = await finalizeExhaustedRun(run, { config, now, Model, EvidenceModel });
    if (done) finalized += 1;
  }
  return finalized;
}

/** One sweep. Exported for tests and an ops "run now". Never throws. */
export async function runOnce({ config = getGoogleAioConfig(), now = () => new Date(), Model = null, EvidenceModel = null, drain = drainQueue } = {}) {
  const summary = { finalizedExhausted: 0, started: 0 };
  if (!config.enabled) return summary;
  try { summary.finalizedExhausted = await finalizeExhaustedRuns({ config, now, Model, EvidenceModel }); } catch (e) { LoggerUtil.error(`${SERVICE}: exhausted-run sweep failed`, { message: e?.message?.slice(0, 200) }); }
  try { summary.started = await drain({ config, now, ...(Model ? { Model } : {}), ...(EvidenceModel ? { EvidenceModel } : {}) }); } catch (e) { LoggerUtil.error(`${SERVICE}: drain failed`, { message: e?.message?.slice(0, 200) }); }
  if (summary.finalizedExhausted || summary.started) LoggerUtil.info(`${SERVICE}: sweep`, summary);
  return summary;
}

export function startGoogleAioVisibilityScheduler() {
  const config = getGoogleAioConfig();
  if (!config.enabled || !config.sweepEnabled) {
    LoggerUtil.service(SERVICE, 'init', 'disabled', { enabled: config.enabled, sweepEnabled: config.sweepEnabled });
    return null;
  }
  if (task) return task;
  task = schedule(config.sweepCron, () => { runOnce().catch(() => {}); }, { noOverlap: true });
  startupTimer = setTimeout(() => { runOnce().catch(() => {}); }, 5_000);
  startupTimer.unref?.();
  LoggerUtil.service(SERVICE, 'init', 'scheduled', { cron: config.sweepCron });
  return task;
}

export function stopGoogleAioVisibilityScheduler() {
  if (task) { task.stop(); task = null; }
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
}

export default { runOnce, startGoogleAioVisibilityScheduler, stopGoogleAioVisibilityScheduler };
