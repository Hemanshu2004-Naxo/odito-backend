import os from 'node:os';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { getEnrichmentConfig } from '../config/enrichmentConfig.js';
import { claimNextAssessment } from '../service/assessmentStore.js';
import { assessClaimed } from '../service/assessmentService.js';

/**
 * Drains the assessment queue (called by the same one-minute sweeper as the SEO enrichment, so there is one scheduler, one kill switch
 * and one lease model). It starts at most `maxPerSweep` assessments and runs at most `concurrency` at once. An assessment reads one
 * public homepage (or none, for a registry site), so it costs no provider money; the limits protect the sites it reads and the server.
 */
const OWNER = `${os.hostname()}:${process.pid}:assess`;
const ASSESS_PER_SWEEP = 12;
const ASSESS_CONCURRENCY = 3;

export async function runAssessmentsOnce({ config = getEnrichmentConfig(), now = () => new Date(), claim = claimNextAssessment, assess = assessClaimed, owner = OWNER, perSweep = ASSESS_PER_SWEEP, concurrency = ASSESS_CONCURRENCY } = {}) {
  const summary = { claimed: 0, outcomes: {} };
  if (!config.enabled) return summary;
  try {
    while (summary.claimed < perSweep) {
      const batch = [];
      while (batch.length < concurrency && summary.claimed + batch.length < perSweep) {
        const claimed = await claim({ owner, now: now(), leaseMs: config.leaseMs });
        if (!claimed) break;
        batch.push(Promise.resolve(assess(claimed, owner)).then((r) => r?.outcome ?? 'done', () => 'error'));
      }
      if (batch.length === 0) break;
      summary.claimed += batch.length;
      for (const outcome of await Promise.all(batch)) summary.outcomes[outcome] = (summary.outcomes[outcome] ?? 0) + 1;
    }
  } catch (err) {
    LoggerUtil.error('CompetitorAssessment: sweep failed', err);
  }
  if (summary.claimed) LoggerUtil.info('CompetitorAssessment: sweep', summary);
  return summary;
}
