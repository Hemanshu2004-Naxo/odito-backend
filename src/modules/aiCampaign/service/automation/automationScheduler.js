import { schedule } from 'node-cron';
import AiCampaignAutomationPolicy from '../../model/AiCampaignAutomationPolicy.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';
import * as automationRunService from './automationRunService.js';
import { runClaimedPolicy, rescheduleAfterRun } from './automationOrchestrator.js';
import { AUTOMATION_SCHEDULER_CRON, AUTOMATION_SYSTEM_ENABLED } from '../../constants/automationConfig.js';

/**
 * automationScheduler — Phase 8. Mirrors weeklyRecheckScheduler.js's own
 * shape exactly: ONE cron registration scans for every policy currently
 * due (`enabled:true, nextRunAt <= now`), not one timer per policy. A
 * single policy failing never aborts the scan — each is wrapped in its
 * own try/catch, same as weeklyRecheckScheduler's per-project loop.
 *
 * Double-processing protection is NOT node-cron's `noOverlap` alone (that
 * only protects one process's own scan from overlapping itself) — the real
 * guarantee is automationRunService's atomic
 * `findOrCreateRun` (unique `{projectId,policyId,scheduledWindow}`) +
 * `claimRun` (atomic status transition), exactly like
 * projectAuditService.startProjectAudit's atomic crawl_status claim that
 * weeklyRecheckScheduler itself relies on. Two app instances racing the
 * same due policy can both attempt this; only one ever wins the claim.
 */

const SERVICE = 'AiCampaignAutomationScheduler';

let task = null;

/**
 * @returns {Promise<{processed:number, started:number, skipped:number, failed:number, skippedPolicies:object[], failedPolicies:object[]}>}
 */
export async function runOnce() {
  const startedAt = Date.now();

  if (!AUTOMATION_SYSTEM_ENABLED) {
    LoggerUtil.service(SERVICE, 'run', 'disabled', { reason: 'AI_CAMPAIGN_AUTOMATION_ENABLED=false' });
    return { processed: 0, started: 0, skipped: 0, failed: 0, skippedPolicies: [], failedPolicies: [] };
  }

  const summary = { processed: 0, started: 0, skipped: 0, failed: 0, skippedPolicies: [], failedPolicies: [] };

  let duePolicies = [];
  try {
    duePolicies = await AiCampaignAutomationPolicy.find({ enabled: true, nextRunAt: { $lte: new Date() } }).lean();
  } catch (error) {
    LoggerUtil.error(`${SERVICE}: failed to load due policies`, error);
    LoggerUtil.service(SERVICE, 'run', 'failed', { durationMs: Date.now() - startedAt });
    return summary;
  }

  LoggerUtil.info(`${SERVICE}: policies due`, { count: duePolicies.length });

  for (const policy of duePolicies) {
    summary.processed += 1;
    const policyId = policy._id.toString();

    try {
      const scheduledWindow = new Date(policy.nextRunAt).toISOString();
      // eslint-disable-next-line no-await-in-loop
      const run = await automationRunService.findOrCreateRun({
        projectId: policy.projectId, draftId: policy.draftId, policyId: policy._id,
        campaignResourceId: null, scheduledWindow, mode: policy.mode,
      });
      // eslint-disable-next-line no-await-in-loop
      const claimed = await automationRunService.claimRun(run._id);

      if (!claimed) {
        summary.skipped += 1;
        summary.skippedPolicies.push({ policyId, reason: 'RUN_ALREADY_IN_PROGRESS' });
        LoggerUtil.info(`${SERVICE}: policy skipped — run already in progress`, { policyId });
        continue; // eslint-disable-line no-continue
      }

      summary.started += 1;
      LoggerUtil.info(`${SERVICE}: policy run started`, { policyId, mode: policy.mode });
      // eslint-disable-next-line no-await-in-loop
      const outcome = await runClaimedPolicy({ policy, run: claimed });
      // eslint-disable-next-line no-await-in-loop
      await rescheduleAfterRun(AiCampaignAutomationPolicy, policy, outcome);
    } catch (error) {
      summary.failed += 1;
      summary.failedPolicies.push({ policyId, error: error.message });
      LoggerUtil.error(`${SERVICE}: policy failed`, error, { policyId });
      try {
        // Still reschedule on an unexpected crash — otherwise a
        // persistently-failing policy stays "due" forever and starves
        // every scan behind it.
        // eslint-disable-next-line no-await-in-loop
        await rescheduleAfterRun(AiCampaignAutomationPolicy, policy, { status: 'failed' });
      } catch {
        // best-effort — already logged above
      }
    }
  }

  LoggerUtil.service(SERVICE, 'run', 'completed', {
    durationMs: Date.now() - startedAt,
    processed: summary.processed,
    started: summary.started,
    skipped: summary.skipped,
    failed: summary.failed,
  });

  return summary;
}

/** Start the polling cron tick. Safe to call once at server boot — no-ops if already started. Set AI_CAMPAIGN_AUTOMATION_ENABLED=false (the global kill switch) to disable without a code change. */
export function startAutomationScheduler() {
  if (!AUTOMATION_SYSTEM_ENABLED) {
    LoggerUtil.service(SERVICE, 'init', 'disabled', { reason: 'AI_CAMPAIGN_AUTOMATION_ENABLED=false' });
    return null;
  }
  if (task) {
    LoggerUtil.warn(`${SERVICE}: start called but scheduler is already running`);
    return task;
  }

  task = schedule(
    AUTOMATION_SCHEDULER_CRON,
    () => {
      runOnce().catch((error) => {
        LoggerUtil.error(`${SERVICE}: run crashed unexpectedly`, error);
      });
    },
    { noOverlap: true },
  );

  LoggerUtil.service(SERVICE, 'init', 'scheduled', { cronExpression: AUTOMATION_SCHEDULER_CRON });
  return task;
}

export function stopAutomationScheduler() {
  if (task) {
    task.stop();
    task = null;
    LoggerUtil.service(SERVICE, 'stop', 'completed');
  }
}

export default { runOnce, startAutomationScheduler, stopAutomationScheduler };
