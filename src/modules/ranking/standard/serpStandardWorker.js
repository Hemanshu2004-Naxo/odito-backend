import { getStandardService } from './serpStandardService.js';
import { readStandardConfig, resolveSerpMode, fallbackToLive } from './config.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * The Standard SERP worker: runs the task lifecycle (submit in batches -> learn what is ready -> fetch + persist -> recover) apart from any
 * request. All state is in MongoDB and every step is an atomic update, so any number of workers / instances can run it, and a restart
 * simply continues: tasks whose claim lapsed are picked up again, submitted tasks keep being polled.
 *
 * Cadence: every `workerPollMs` while DATAFORSEO_SERP_MODE=standard; once a minute otherwise (it only drains tasks left from before a switch
 * back to Live). The provider-facing call rates are enforced inside the service (tasks_ready: one call per interval across all instances).
 *
 * DATAFORSEO_SERP_STANDARD_WORKER_EMBEDDED=false runs it only where you start it yourself (this module's createStandardWorker()).
 */

export function createStandardWorker({ service = getStandardService(), config = () => readStandardConfig(), mode = () => resolveSerpMode() } = {}) {
  let timer = null;
  let running = null;
  let stopping = false;

  const schedule = () => {
    if (stopping) return;
    const delay = mode() === 'standard' ? config().workerPollMs : 60_000;
    timer = setTimeout(run, delay);
    timer.unref?.();
  };
  const run = async () => {
    timer = null;
    try { running = service.tick(); await running; } catch (err) { LoggerUtil.error('SERP standard worker: tick failed', err); } finally { running = null; schedule(); }
  };

  return {
    start() { if (timer || running) return; stopping = false; LoggerUtil.info('SERP standard worker started', { mode: mode() }); schedule(); },
    async stop() { stopping = true; if (timer) clearTimeout(timer); timer = null; await running; LoggerUtil.info('SERP standard worker stopped'); },
    tick: () => service.tick(),
  };
}

let embedded = null;
export function startStandardSerpWorker() {
  if (process.env.DATAFORSEO_SERP_STANDARD_WORKER_EMBEDDED === 'false') return null;
  if (embedded) return embedded;
  // The ONE line that tells ops which provider this process will use for ranking SERPs. A process that was not restarted with the new
  // environment (e.g. `pm2 restart` without --update-env) still says live here.
  LoggerUtil.info('SERP provider selection', {
    mode: resolveSerpMode(), rolloutPercent: process.env.DATAFORSEO_SERP_STANDARD_ROLLOUT_PERCENT ?? '(unset=100)', fallbackToLive: fallbackToLive(),
    modeVariablePresent: process.env.DATAFORSEO_SERP_MODE !== undefined,
  });
  embedded = createStandardWorker();
  embedded.start();
  for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => { embedded.stop().catch(() => {}); });
  return embedded;
}
