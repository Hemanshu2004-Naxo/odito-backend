/**
 * executionRecordService — Phase 7. Every read/write of
 * AiCampaignOptimizationExecution lives here, mirroring Phase 6's
 * publishAttemptService.js exactly:
 *
 *  1. IDEMPOTENCY (spec §22): `findOrCreateExecution` upserts on the unique
 *     `recommendationId` key — at most one execution document per
 *     recommendation, ever.
 *  2. CONCURRENCY (spec §23): `claimExecutionLock` is the ONE atomic
 *     `findOneAndUpdate` that may move an execution into `'executing'`.
 */

import AiCampaignOptimizationExecution from '../../model/AiCampaignOptimizationExecution.js';
import { RETRYABLE_EXECUTION_STATUSES } from '../../constants/optimizationEnums.js';
import { OPTIMIZATION_LOCK_STALE_MS } from '../../constants/optimizationConfig.js';

export async function findOrCreateExecution({ projectId, draftId, recommendationId, campaignResourceId, operation, target, targetEntityId, executedBy }) {
  return AiCampaignOptimizationExecution.findOneAndUpdate(
    { recommendationId },
    {
      $setOnInsert: {
        projectId, draftId, campaignResourceId, operation, target, targetEntityId, executedBy, status: 'pending',
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
  );
}

/** Atomic lock claim (spec §23), with a stale-lock reclaim for crash recovery (spec §22, mirrors Phase 6's claimPublishLock). */
export async function claimExecutionLock(executionId) {
  return AiCampaignOptimizationExecution.findOneAndUpdate(
    {
      _id: executionId,
      $or: [
        { status: { $in: RETRYABLE_EXECUTION_STATUSES } },
        { status: 'executing', startedAt: { $lte: new Date(Date.now() - OPTIMIZATION_LOCK_STALE_MS) } },
      ],
    },
    { $set: { status: 'executing', startedAt: new Date(), failureCode: null, failureMessage: null } },
    { new: true },
  );
}

export async function markExecuted(executionId, { googleResourceName, beforeState, afterState }) {
  return AiCampaignOptimizationExecution.findOneAndUpdate(
    { _id: executionId, status: 'executing' },
    { $set: { status: 'executed', completedAt: new Date(), googleResourceName, beforeState, afterState } },
    { new: true },
  );
}

export async function markFailed(executionId, { code, message }) {
  return AiCampaignOptimizationExecution.findOneAndUpdate(
    { _id: executionId, status: 'executing' },
    { $set: { status: 'failed', completedAt: new Date(), failureCode: code || 'GOOGLE_UNKNOWN', failureMessage: message ? String(message).slice(0, 500) : null } },
    { new: true },
  );
}

export async function getExecutionForRecommendation(recommendationId) {
  return AiCampaignOptimizationExecution.findOne({ recommendationId }).lean();
}

export async function getHistory({ projectId, draftId, limit = 50 }) {
  return AiCampaignOptimizationExecution.find({ projectId, draftId }).sort({ createdAt: -1 }).limit(Math.min(limit, 100)).lean();
}

export default {
  findOrCreateExecution, claimExecutionLock, markExecuted, markFailed, getExecutionForRecommendation, getHistory,
};
