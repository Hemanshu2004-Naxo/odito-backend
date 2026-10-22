/**
 * F4-018: single, shared post-failure orchestration path.
 *
 * Previously this branching logic (chunk-outcome accounting, then
 * url_verification / batch-scoped-aggregation / full-audit-reset routing)
 * existed only inline inside jobController.js's HTTP /fail callback. The two
 * recovery sweeps (jobService.js's cleanupStaleLocks and
 * recoverOrphanedUrlVerificationJobs) instead did a raw Job.updateMany
 * straight to 'failed', bypassing all of it — meaning a job recovered by
 * either sweep never advanced its downstream chain, and a Verification
 * Batch (or a Full Audit) could get stuck forever with no signal.
 *
 * This module takes an ALREADY-updated job (the result of jobService.failJob)
 * and performs everything that must happen after that transition, so every
 * caller — the live HTTP callback and both sweeps — shares one
 * implementation instead of three drifting copies. Deliberately does NOT
 * call failJob itself: the caller does that first (jobService.js's own
 * methods call `this.failJob`, avoiding a jobService.js -> this module ->
 * chainingEngine.js -> jobService.js import cycle that would otherwise
 * result from this module importing JobService directly).
 */

import auditProgressService from './auditProgressService.js';
import SeoProject from '../../app_user/model/SeoProject.js';
import chainingEngine from '../chainingEngine.js';
import { JOB_TYPES } from '../constants/jobTypes.js';
import { handleUrlVerificationJobFailure } from '../../verification/service/verificationFailureHandler.js';

// F4-018: PROJECT_TASK_VERIFICATION included alongside the two Python-
// processed aggregation types — recoverOrphanedUrlVerificationJobs' widened
// scope can now recover a PROJECT_TASK_VERIFICATION stuck 'pending' (Node
// crashed before its synchronous first run ever happened), and that must
// advance/finalize the batch exactly like _runProjectTaskVerificationJob's
// own permanent-failure branch does (chainingEngine.process() below routes
// to the 'batchCompleted' hook, which calls _finalizeVerificationBatch) —
// never fall through to the generic "reset whole project to draft" branch.
const BATCH_SCOPED_PROJECT_JOB_TYPES = [
  JOB_TYPES.PROJECT_SEO_AGGREGATION,
  JOB_TYPES.PROJECT_AI_AGGREGATION,
  JOB_TYPES.PROJECT_TASK_VERIFICATION,
];

/**
 * @param {Object} updatedJob - the Job document AFTER jobService.failJob has
 *   already run (status is 'retrying' or 'failed').
 * @param {{message:string,[key:string]:any}} errorObj
 * @param {{source?:string}} [options] - `source` is for logging only, e.g.
 *   'http', 'stale_lock_sweep', 'orphaned_pending_sweep'.
 * @returns {Promise<{retryChunkCreated:boolean}>}
 */
export async function advanceAfterJobFailure(updatedJob, errorObj, options = {}) {
  const { source = 'unknown' } = options;
  const jobId = updatedJob._id;

  console.log(`[RECOVERY] job_failed | source=${source} | jobId=${jobId} | jobType=${updatedJob.jobType} | status=${updatedJob.status} | reason="${errorObj.message}"`);

  // Chunked-stage failure accounting (PAGE_SCRAPING, HEADLESS_ACCESSIBILITY):
  // only a TERMINAL failure (retries exhausted) counts against the owning
  // JobGroup — a job still 'retrying' will be attempted again.
  let retryChunkCreated = false;

  if (updatedJob.group_id && updatedJob.status === 'failed') {
    try {
      const finalizedGroup = await chainingEngine.recordChunkOutcome(updatedJob, `fail_${jobId}`);
      if (finalizedGroup) {
        console.log(`[CHUNK] JobGroup resolved via chunk failure | groupId=${finalizedGroup._id} | stage=${finalizedGroup.stage} | status=${finalizedGroup.status} | source=${source}`);

        if (finalizedGroup.stage === JOB_TYPES.PAGE_SCRAPING) {
          try {
            retryChunkCreated = await chainingEngine._maybeCreatePageScrapingRetryChunks(finalizedGroup, updatedJob, `fail_${jobId}`);
          } catch (retryError) {
            console.error(`[CHUNK] PAGE_SCRAPING retry check failed after chunk failure | jobId=${jobId} | reason="${retryError.message}"`);
          }
        }

        if (!retryChunkCreated) {
          if (finalizedGroup.stage === JOB_TYPES.HEADLESS_ACCESSIBILITY) {
            // HEADLESS_ACCESSIBILITY has no next-stage fan-out of its own —
            // its only downstream effect is the PAGE_ANALYSIS dependency
            // gate, which chainingEngine.process() is never invoked to
            // re-check on this (failure) path.
            try {
              await chainingEngine.checkDependencyGate(updatedJob, `fail_${jobId}`);
            } catch (gateError) {
              console.error(`[CHUNK] Dependency gate check failed after HEADLESS_ACCESSIBILITY chunk failure | jobId=${jobId} | reason="${gateError.message}"`);
            }
          } else if (finalizedGroup.status !== 'failed') {
            console.log(`[CHUNK] Group has successful chunks but resolved via a failure — next-stage fan-out NOT triggered from this path (deferred) | groupId=${finalizedGroup._id}`);
          }
        }
      }
    } catch (chunkError) {
      console.error(`[CHUNK] Failed to record chunk failure | jobId=${jobId} | reason="${chunkError.message}"`);
    }
  }

  if (retryChunkCreated) {
    return { retryChunkCreated: true };
  }

  // P3-006: a url_verification-mode failure must NOT reset the project's
  // crawl_status/status or emit the generic audit:error — those are
  // project-wide Full Audit signals. Instead, route to VerificationFinalizer's
  // explicit-failure path and emit verification:failed.
  const isUrlVerificationFailure = updatedJob.status === 'failed'
    && updatedJob.input_data?.mode === 'url_verification';

  // F4-016: a permanently-failed PROJECT_SEO_AGGREGATION/PROJECT_AI_AGGREGATION
  // job is batch-scoped, not Full-Audit-wide — it must not fall into the
  // generic "reset whole project to draft" branch below. Gracefully degrade:
  // still advance the aggregation chain, since batch completion
  // (COMPLETED/PARTIAL/FAILED) is determined from PageVerificationRun's own
  // per-URL statuses, never from these jobs' own outcome.
  const isBatchScopedAggregationFailure = updatedJob.status === 'failed'
    && BATCH_SCOPED_PROJECT_JOB_TYPES.includes(updatedJob.jobType)
    && !!updatedJob.input_data?.batchId;

  if (isUrlVerificationFailure) {
    try {
      const finalizedRun = await handleUrlVerificationJobFailure(updatedJob, errorObj.message);
      if (finalizedRun) {
        console.log(`[RECOVERY] url_verification_failed | source=${source} | runId=${updatedJob.run_id} | jobType=${updatedJob.jobType} | jobId=${jobId}`);
      }
    } catch (verificationFailError) {
      console.error(`[RECOVERY] URL Verification failure handling error (non-fatal) | source=${source} | reason="${verificationFailError.message}"`);
    }
  } else if (isBatchScopedAggregationFailure) {
    const failRequestId = `req_fail_${source}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    try {
      await chainingEngine.process(updatedJob, {}, failRequestId);
      console.log(`[RECOVERY] aggregation_chain_advanced_after_failure | source=${source} | jobType=${updatedJob.jobType} | batchId=${updatedJob.input_data.batchId} | jobId=${jobId}`);
    } catch (chainingError) {
      console.error(`[RECOVERY] Failed to advance project aggregation chain after failure | source=${source} | jobId=${jobId} | reason="${chainingError.message}"`);
    }
  } else if (updatedJob.status === 'failed' && updatedJob.input_data?.mode !== 'url_verification') {
    try {
      await SeoProject.findByIdAndUpdate(updatedJob.project_id, {
        crawl_status: 'draft',
        status: 'draft'
      });
      console.log(`[RECOVERY] project_status_reset | source=${source} | projectId=${updatedJob.project_id} | jobId=${jobId}`);
    } catch (statusError) {
      console.error(`[RECOVERY] Failed to reset project status | source=${source} | projectId=${updatedJob.project_id} | error="${statusError.message}"`);
    }

    auditProgressService.emitError(jobId.toString(), {
      jobId: jobId.toString(),
      projectId: updatedJob.project_id?.toString(),
      message: errorObj.message,
      subtext: 'The audit encountered an error and has been stopped',
      error: errorObj.message || 'WORKER_ERROR'
    });
  }

  return { retryChunkCreated: false };
}
