/**
 * automationRunService — Phase 8. Every read/write of AiCampaignAutomationRun
 * lives here, mirroring Phase 6's publishAttemptService.js / Phase 7's
 * executionRecordService.js exactly:
 *
 *  1. IDEMPOTENCY: `findOrCreateRun` upserts on the unique
 *     `{projectId, policyId, scheduledWindow}` key — at most one run
 *     document per policy per scheduled window, ever, even across two app
 *     instances racing the same scheduler tick.
 *  2. CONCURRENCY / CRASH RECOVERY: `claimRun` is the ONE atomic
 *     `findOneAndUpdate` that may move a run into `'running'`, with the
 *     same stale-lock `$or` reclaim clause as Phase 6/7.
 */

import AiCampaignAutomationRun from '../../model/AiCampaignAutomationRun.js';
import { RETRYABLE_RUN_STATUSES, AUTOMATION_LOCK_STALE_MS } from '../../constants/automationEnums.js';

export async function findOrCreateRun({ projectId, draftId, policyId, campaignResourceId, scheduledWindow, mode }) {
  return AiCampaignAutomationRun.findOneAndUpdate(
    { projectId, policyId, scheduledWindow },
    {
      $setOnInsert: {
        draftId, campaignResourceId, mode, status: 'pending', actions: [],
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
  );
}

/** Atomic lock claim, with a stale-lock reclaim for crash recovery (mirrors Phase 6's claimPublishLock / Phase 7's claimExecutionLock). */
export async function claimRun(runId) {
  return AiCampaignAutomationRun.findOneAndUpdate(
    {
      _id: runId,
      $or: [
        { status: { $in: RETRYABLE_RUN_STATUSES } },
        { status: 'running', startedAt: { $lte: new Date(Date.now() - AUTOMATION_LOCK_STALE_MS) } },
      ],
    },
    { $set: { status: 'running', startedAt: new Date(), failureCode: null, failureMessage: null } },
    { new: true },
  );
}

/** Append one action outcome immediately after it is decided — durable, step-by-step, same crash-recovery discipline as Phase 6's recordResource. */
export async function appendAction(runId, action) {
  const inc = {};
  if (action.status === 'executed') inc.actionsExecuted = 1;
  else if (action.status === 'recommended') inc.actionsRecommended = 1;
  else if (action.status === 'skipped') inc.actionsSkipped = 1;
  else if (action.status === 'failed') inc.actionsFailed = 1;

  return AiCampaignAutomationRun.findOneAndUpdate(
    { _id: runId },
    { $push: { actions: action }, $inc: inc },
    { new: true },
  );
}

export async function setActionsPlanned(runId, count) {
  return AiCampaignAutomationRun.findOneAndUpdate({ _id: runId }, { $set: { actionsPlanned: count } }, { new: true });
}

export async function markCompleted(runId) {
  const run = await AiCampaignAutomationRun.findOne({ _id: runId }).lean();
  const status = run && (run.actionsFailed > 0 || run.actionsSkipped > 0) && (run.actionsExecuted > 0 || run.actionsRecommended > 0)
    ? 'partially_completed'
    : 'completed';
  return AiCampaignAutomationRun.findOneAndUpdate(
    { _id: runId, status: 'running' },
    { $set: { status, completedAt: new Date() } },
    { new: true },
  );
}

export async function markFailed(runId, { code, message }) {
  return AiCampaignAutomationRun.findOneAndUpdate(
    { _id: runId, status: 'running' },
    { $set: { status: 'failed', completedAt: new Date(), failureCode: code || null, failureMessage: message ? String(message).slice(0, 500) : null } },
    { new: true },
  );
}

export async function getHistory({ projectId, draftId, policyId, limit = 50 }) {
  const filter = { projectId, draftId };
  if (policyId) filter.policyId = policyId;
  return AiCampaignAutomationRun.find(filter).sort({ createdAt: -1 }).limit(Math.min(limit, 100)).lean();
}

export default {
  findOrCreateRun, claimRun, appendAction, setActionsPlanned, markCompleted, markFailed, getHistory,
};
