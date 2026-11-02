import os from 'node:os';
import { schedule } from 'node-cron';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { getEnrichmentConfig } from '../config/enrichmentConfig.js';
import { claimNext, requeueMissingShared } from '../service/enrichmentStore.js';
import { enrichClaimed } from '../service/enrichmentService.js';
import { runAssessmentsOnce } from './assessmentWorker.js';

/**
 * My Competitors enrichment sweeper (every minute by default, on every instance; every take-over is one conditional update, so exactly
 * one instance gets a given competitor):
 *   pending, next attempt reached  -> claimed and enriched
 *   processing, lease still valid  -> left alone (another worker owns it)
 *   processing, lease expired      -> claimed again (the worker that held it crashed or stalled), the interrupted run starts over
 * A sweep starts at most `maxPerSweep` competitors and runs at most `concurrency` of them at once in this process, so a project with many
 * competitors can never launch a burst of provider calls. With COMPETITOR_ENRICHMENT_ENABLED=false it does nothing at all.
 */

const SERVICE = 'CompetitorEnrichment';
const OWNER = `${os.hostname()}:${process.pid}`;
let task = null;
let startupTimer = null;

/** One sweep. Exported for tests and an ops "run now". Never throws. */
export async function runOnce({ config = getEnrichmentConfig(), now = () => new Date(), claim = claimNext, enrich = enrichClaimed, owner = OWNER } = {}) {
  const summary = { claimed: 0, outcomes: {} };
  if (!config.enabled) return summary;
  try {
    while (summary.claimed < config.maxPerSweep) {
      const batch = [];
      while (batch.length < config.concurrency && summary.claimed + batch.length < config.maxPerSweep) {
        const claimed = await claim({ owner, now: now(), leaseMs: config.leaseMs });
        if (!claimed) break;
        batch.push(Promise.resolve(enrich(claimed, owner)).then((r) => r?.outcome ?? 'done', () => 'error'));
      }
      if (batch.length === 0) break;
      summary.claimed += batch.length;
      for (const outcome of await Promise.all(batch)) summary.outcomes[outcome] = (summary.outcomes[outcome] ?? 0) + 1;
    }
  } catch (err) {
    LoggerUtil.error(`${SERVICE}: sweep failed`, err);
  }
  if (summary.claimed) LoggerUtil.info(`${SERVICE}: sweep`, summary);
  return summary;
}

export function startCompetitorEnrichmentScheduler() {
  const config = getEnrichmentConfig();
  if (!config.enabled || !config.sweepEnabled) {
    LoggerUtil.service(SERVICE, 'init', 'disabled', { enabled: config.enabled, sweepEnabled: config.sweepEnabled });
    return null;
  }
  if (task) return task;
  // One scheduler for both queues (SEO enrichment and relevance assessment): the same kill switch and lease model.
  const sweep = async () => { await requeueMissingShared().catch((err) => LoggerUtil.error(`${SERVICE}: could not queue older competitors for the shared-keywords comparison`, err)); return Promise.allSettled([runOnce(), runAssessmentsOnce()]); };
  task = schedule(config.sweepCron, () => { sweep().catch(() => {}); }, { noOverlap: true });
  startupTimer = setTimeout(() => { sweep().catch(() => {}); }, 7_000);
  startupTimer.unref?.();
  LoggerUtil.service(SERVICE, 'init', 'scheduled', { cron: config.sweepCron, concurrency: config.concurrency, maxPerSweep: config.maxPerSweep });
  return task;
}

export function stopCompetitorEnrichmentScheduler() {
  if (task) { task.stop(); task = null; }
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
}

export default { runOnce, startCompetitorEnrichmentScheduler, stopCompetitorEnrichmentScheduler };
