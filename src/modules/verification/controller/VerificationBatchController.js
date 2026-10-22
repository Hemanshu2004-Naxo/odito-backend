import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { AuthUtil } from '../../../utils/AuthUtil.js';
import VerificationBatch from '../model/VerificationBatch.js';
import PageVerificationRun from '../model/PageVerificationRun.js';
import { serializeRun } from './VerificationHistoryController.js';

/**
 * F4-018 §8 — read-only REST recovery API. Exists so the frontend (as a
 * fallback if the one-shot verification:batch-completed websocket event is
 * missed) and operators/debugging tooling have a way to inspect a
 * Verification Batch's state without needing direct DB access — the F4-017
 * audit found no such endpoint existed. Read-only: no field here ever
 * triggers recovery or mutates state. Deliberately does not expose Job
 * documents, internal aggregation-chain job IDs, or raw error stacks — only
 * the same shape a frontend consumer or operator actually needs.
 */
function serializeBatch(batch) {
  return {
    batchId: batch.batchId,
    projectId: batch.projectId.toString(),
    status: batch.status,
    totalUrls: batch.totalUrls,
    completedUrls: batch.completedUrls,
    failedUrls: batch.failedUrls,
    urls: batch.urls,
    startedAt: batch.startedAt,
    completedAt: batch.completedAt,
    aggregateStartedAt: batch.aggregateStartedAt,
    aggregateCompletedAt: batch.aggregateCompletedAt,
    errorMessage: batch.errorMessage,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
  };
}

/**
 * GET /api/seo/verification-batches/:batchId
 * Not project-scoped in the URL, so ownership is resolved from the loaded
 * batch's own projectId — same pattern as getVerificationRun.
 */
export async function getVerificationBatch(req, res) {
  const { batchId } = req.params;

  const batch = await VerificationBatch.findBatch(batchId).lean();
  if (!batch) {
    return res.status(404).json(ResponseUtil.notFound('Verification batch not found'));
  }

  try {
    await AuthUtil.validateProjectAccess(req.user._id, batch.projectId);
  } catch (error) {
    if (error.type === 'NOT_FOUND') {
      return res.status(404).json(ResponseUtil.notFound(error.message));
    }
    if (error.type === 'ACCESS_DENIED') {
      return res.status(403).json(ResponseUtil.accessDenied(error.message));
    }
    return res.status(error.statusCode || 500).json(ResponseUtil.error(error.message, error.statusCode || 500));
  }

  return res.json(ResponseUtil.success(serializeBatch(batch), 'Verification batch retrieved'));
}

/**
 * GET /api/seo/verification-batches/:batchId/runs
 * Every PageVerificationRun belonging to this batch, oldest first (matches
 * the order URLs were submitted in). A batch is bounded in size (the same
 * cap startVerificationBatch enforces at creation), so this is intentionally
 * unpaginated — simpler for the one thing this endpoint is for: seeing the
 * full per-URL breakdown of one batch.
 */
export async function getVerificationBatchRuns(req, res) {
  const { batchId } = req.params;

  const batch = await VerificationBatch.findBatch(batchId).lean();
  if (!batch) {
    return res.status(404).json(ResponseUtil.notFound('Verification batch not found'));
  }

  try {
    await AuthUtil.validateProjectAccess(req.user._id, batch.projectId);
  } catch (error) {
    if (error.type === 'NOT_FOUND') {
      return res.status(404).json(ResponseUtil.notFound(error.message));
    }
    if (error.type === 'ACCESS_DENIED') {
      return res.status(403).json(ResponseUtil.accessDenied(error.message));
    }
    return res.status(error.statusCode || 500).json(ResponseUtil.error(error.message, error.statusCode || 500));
  }

  const runs = await PageVerificationRun.find({ batchId }).sort({ createdAt: 1 }).lean();

  return res.json(ResponseUtil.success(runs.map(serializeRun), 'Verification batch runs retrieved'));
}
