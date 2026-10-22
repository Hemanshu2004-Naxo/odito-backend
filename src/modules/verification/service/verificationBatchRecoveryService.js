/**
 * F4-018: Verification Batch recovery.
 *
 * Detects and resumes Verification Batches (and their project-level
 * aggregation jobs) that can no longer make forward progress on their own —
 * a Node restart/crash at the wrong instant, an orphaned PROJECT_TASK_VERIFICATION
 * job (Node-self-processed, so nothing polls it), or a gap in the
 * PROJECT_SEO_AGGREGATION -> PROJECT_AI_AGGREGATION -> PROJECT_TASK_VERIFICATION
 * chain are the only ways a batch can get permanently stuck in AGGREGATING
 * (see F4-017's audit). Every action here reuses EXISTING, already-atomic/
 * idempotent chainingEngine primitives (_enqueueProjectAggregationChain,
 * process(), _finalizeVerificationBatch) — this module does not duplicate
 * any aggregation, chaining, or scoring logic, and never mutates
 * VerificationBatch/Job state directly beyond what those primitives already
 * do safely.
 */

import mongoose from 'mongoose';
import chainingEngine from '../../jobs/chainingEngine.js';
import VerificationBatch from '../model/VerificationBatch.js';
import { BATCH_STATUS } from '../constants/batchStatus.js';
import { JOB_TYPES } from '../../jobs/constants/jobTypes.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

const SERVICE = 'VerificationBatchRecoveryService';

// A batch in one of these statuses has already concluded - an in-flight job
// still pointing at it (or at a batchId with no VerificationBatch document
// at all) has nowhere left to report to. See detectOrphanedAggregationJobs.
const TERMINAL_BATCH_STATUSES = new Set([BATCH_STATUS.COMPLETED, BATCH_STATUS.PARTIAL, BATCH_STATUS.FAILED]);

const PROJECT_JOB_TYPES = [
  JOB_TYPES.PROJECT_SEO_AGGREGATION,
  JOB_TYPES.PROJECT_AI_AGGREGATION,
  JOB_TYPES.PROJECT_TASK_VERIFICATION,
];

// Default: a batch is only considered "stalled" once it's been in
// AGGREGATING for longer than a normal aggregation chain could plausibly
// take (SEO/AI aggregation are each budgeted a couple of minutes in
// JOB_TYPE_CONFIG) — 15 minutes gives ample headroom above that before
// treating it as needing intervention, avoiding false positives on a batch
// that's merely mid-chain.
const DEFAULT_STALE_THRESHOLD_MS = 15 * 60 * 1000;

/**
 * PROJECT_TASK_VERIFICATION is Node-self-processed — no Python worker ever
 * claims it (absent from both createJobDispatchMap and main.py's polling
 * list). Its first attempt runs synchronously at creation time
 * (chainingEngine._createAndDispatchJob's bypass); any RETRY (status
 * 'retrying' after a failure, or 'pending' if Node crashed before the first
 * synchronous run ever happened) has no other trigger. This is the trigger —
 * an atomic claim, same shape as jobService.claimJob's own pending/retrying
 * matching, scoped to this one job type, run on a schedule instead of via
 * HTTP polling since chainingEngine already runs in this same Node process.
 *
 * @param {string} requestId
 * @returns {Promise<{reclaimedCount:number}>}
 */
export async function reclaimDueProjectTaskVerificationJobs(requestId) {
  const Job = mongoose.model('Job');
  const now = new Date();
  let reclaimedCount = 0;

  // Bounded loop (not unbounded while(true)): claims one due job at a time
  // until none remain, with a defensive upper bound so a bug that somehow
  // leaves a claimed job still matchable can never spin this forever.
  for (let i = 0; i < 100; i++) {
    const claimed = await Job.findOneAndUpdate(
      {
        jobType: JOB_TYPES.PROJECT_TASK_VERIFICATION,
        $or: [
          { status: 'pending' },
          { status: 'retrying', last_attempted_at: { $lte: now } },
        ],
      },
      { $set: { status: 'processing', claimed_at: now } },
      { new: true, sort: { priority: -1, created_at: 1 } }
    );

    if (!claimed) break;

    reclaimedCount++;
    console.log(`[RECOVERY] retry_reclaimed | jobType=PROJECT_TASK_VERIFICATION | jobId=${claimed._id} | attempts=${claimed.attempts}`);

    try {
      await chainingEngine._runProjectTaskVerificationJob(claimed, requestId);
    } catch (error) {
      console.error(`[RECOVERY] PROJECT_TASK_VERIFICATION reclaim run crashed | jobId=${claimed._id} | reason="${error.message}"`);
    }
  }

  return { reclaimedCount };
}

/**
 * Detects PROJECT_SEO_AGGREGATION/PROJECT_AI_AGGREGATION/PROJECT_TASK_VERIFICATION
 * jobs still in-flight (pending/processing/retrying) whose batch is no
 * longer AGGREGATING (already finalized elsewhere, or the batch document is
 * missing entirely), and closes them out. Two sub-cases, handled
 * differently:
 *
 *   - Batch is verifiably TERMINAL (completed/partial/failed) or MISSING:
 *     the job has nowhere left to report to - there is no "resume" for it,
 *     only "clean up". Transitioned directly to a terminal 'failed' status
 *     (bypassing the retry-aware jobService.failJob, since retrying is
 *     meaningless once the batch it belongs to is already concluded or
 *     gone, and bypassing the aggregation-chain-advancement pipeline in
 *     jobFailureHandler.js, since there is nothing left to advance). This
 *     closes the gap that previously made this a pure, unbounded logging
 *     loop: once terminated, the job's status leaves the
 *     pending/processing/retrying set, so it stops matching this query on
 *     every subsequent tick.
 *   - Batch is PENDING/RUNNING (a chain job exists before its batch ever
 *     reached AGGREGATING - contradicts the atomic barrier guards
 *     elsewhere and points at a different, deeper bug in that barrier, not
 *     in this recovery sweep): still logged only, per F4-018 §6 ("log
 *     unexpected transitions, do not silently repair corrupted state") -
 *     auto-terminating here could mask that bug rather than surface it.
 *
 * @returns {Promise<{orphanedCount:number, terminatedCount:number, skippedCount:number}>}
 */
export async function detectOrphanedAggregationJobs() {
  const Job = mongoose.model('Job');

  const inFlightJobs = await Job.find({
    jobType: { $in: PROJECT_JOB_TYPES },
    status: { $in: ['pending', 'processing', 'retrying'] },
  }).select('_id jobType status input_data').lean();

  LoggerUtil.database('find', 'jobs', null, { service: SERVICE, query: 'orphan_detection_in_flight_jobs', count: inFlightJobs.length });

  if (inFlightJobs.length === 0) {
    return { orphanedCount: 0, terminatedCount: 0, skippedCount: 0 };
  }

  const batchIds = [...new Set(inFlightJobs.map((j) => j.input_data?.batchId).filter(Boolean))];
  const batches = await VerificationBatch.find({ batchId: { $in: batchIds } }).select('batchId status').lean();
  const batchStatusById = new Map(batches.map((b) => [b.batchId, b.status]));

  LoggerUtil.database('find', 'verification_batches', null, { service: SERVICE, query: 'orphan_detection_batch_lookup', count: batches.length });

  let orphanedCount = 0;
  let terminatedCount = 0;
  let skippedCount = 0;

  for (const job of inFlightJobs) {
    const batchId = job.input_data?.batchId;
    const batchStatus = batchId ? batchStatusById.get(batchId) : undefined;

    if (batchStatus === BATCH_STATUS.AGGREGATING) continue; // legitimately in-flight, not orphaned

    orphanedCount++;

    const batchMissing = !batchId || batchStatus === undefined;
    const batchTerminal = batchStatus !== undefined && TERMINAL_BATCH_STATUSES.has(batchStatus);

    if (batchMissing || batchTerminal) {
      const reason = batchMissing ? 'batch_missing' : `batch_terminal_${batchStatus}`;
      try {
        const updated = await Job.updateOne(
          // Re-check status atomically - defends against this same job
          // already having been reclaimed (and moved on) by a different
          // sweep between this function's initial find() and this write.
          { _id: job._id, status: { $in: ['pending', 'processing', 'retrying'] } },
          {
            $set: {
              status: 'failed',
              error: { message: `Orphaned aggregation job terminated: ${reason}`, timestamp: new Date() },
              completed_at: new Date(),
            },
          }
        );
        if (updated.modifiedCount > 0) {
          terminatedCount++;
          LoggerUtil.job(job._id.toString(), job.jobType, 'orphan_terminated', { service: SERVICE, batchId: batchId ?? null, reason });
        }
      } catch (error) {
        LoggerUtil.error(`${SERVICE}: failed to terminate orphaned job`, error, { jobId: job._id.toString(), jobType: job.jobType, batchId: batchId ?? null, reason });
      }
      continue;
    }

    skippedCount++;
    LoggerUtil.warn(`${SERVICE}: orphaned job skipped - batch not yet aggregating (possible barrier bug, needs investigation)`, {
      jobId: job._id.toString(), jobType: job.jobType, batchId: batchId ?? null, batchStatus,
    });
  }

  return { orphanedCount, terminatedCount, skippedCount };
}

/**
 * Determines what, if anything, is missing from ONE stalled batch's
 * aggregation chain and resumes it via existing, already-idempotent
 * chainingEngine primitives. Never duplicates already-completed work:
 *
 *   - PROJECT_SEO_AGGREGATION missing entirely (Node crashed between the
 *     barrier's DB write and the job actually being created): re-invoke
 *     _enqueueProjectAggregationChain, which itself checks for an existing
 *     job before creating one.
 *   - A chain job is terminal (completed/failed) but its downstream sibling
 *     was never created (Node crashed between the two): re-invoke
 *     process() on the terminal job — creation of the next job is guarded
 *     by _createNextJobAtomically's own existing-job check, so this is a
 *     safe no-op if the sibling already exists.
 *   - PROJECT_TASK_VERIFICATION is terminal but the batch never finalized
 *     (Node crashed between marking it terminal and _finalizeVerificationBatch's
 *     own write): re-invoke _finalizeVerificationBatch, which is itself
 *     guarded by an atomic AGGREGATING-only transition.
 *   - Otherwise (a chain job is still legitimately in flight, e.g. Python
 *     is mid-processing, or PROJECT_TASK_VERIFICATION is mid-retry-backoff
 *     and will be picked up by reclaimDueProjectTaskVerificationJobs): skip.
 *
 * @param {Object} batch - a VerificationBatch document with status AGGREGATING
 * @param {string} requestId
 * @returns {Promise<boolean>} true if this call took a resuming action
 */
async function resumeOneBatch(batch, requestId) {
  const Job = mongoose.model('Job');

  const jobs = await Job.find({
    'input_data.batchId': batch.batchId,
    jobType: { $in: PROJECT_JOB_TYPES },
  }).sort({ created_at: 1 });

  const byType = {};
  for (const job of jobs) {
    (byType[job.jobType] = byType[job.jobType] || []).push(job);
  }

  // Defense-in-depth: the atomic guards elsewhere (barrier's RUNNING ->
  // AGGREGATING transition, _createNextJobAtomically's existence check,
  // _enqueueProjectAggregationChain's own guard added in F4-018) should make
  // this impossible — detected and logged, never silently repaired, per
  // F4-018 §6.
  for (const [jobType, list] of Object.entries(byType)) {
    if (list.length > 1) {
      console.error(`[RECOVERY] duplicate_jobs_detected | batchId=${batch.batchId} | jobType=${jobType} | count=${list.length} | jobIds=${list.map((j) => j._id).join(',')}`);
    }
  }

  const seoAgg = byType[JOB_TYPES.PROJECT_SEO_AGGREGATION]?.[0];
  const aiAgg = byType[JOB_TYPES.PROJECT_AI_AGGREGATION]?.[0];
  const taskVerif = byType[JOB_TYPES.PROJECT_TASK_VERIFICATION]?.[0];

  if (!seoAgg) {
    console.log(`[RECOVERY] batch_resumed | batchId=${batch.batchId} | reason=missing_seo_aggregation_job`);
    await chainingEngine._enqueueProjectAggregationChain(batch, requestId);
    return true;
  }

  if (taskVerif && (taskVerif.status === 'completed' || taskVerif.status === 'failed')) {
    console.log(`[RECOVERY] batch_resumed | batchId=${batch.batchId} | reason=task_verification_terminal_but_batch_unfinalized`);
    await chainingEngine._finalizeVerificationBatch(batch.batchId, requestId);
    return true;
  }

  if (taskVerif) {
    // Still pending/processing/retrying — reclaimDueProjectTaskVerificationJobs
    // (run every tick, alongside this) already owns bringing it to a
    // terminal state; nothing else to do here.
    console.log(`[RECOVERY] recovery_skipped | batchId=${batch.batchId} | reason=task_verification_in_progress | status=${taskVerif.status}`);
    return false;
  }

  if (!aiAgg && (seoAgg.status === 'completed' || seoAgg.status === 'failed')) {
    console.log(`[RECOVERY] aggregation_resumed | batchId=${batch.batchId} | reason=missing_ai_aggregation_job | fromJobType=PROJECT_SEO_AGGREGATION`);
    await chainingEngine.process(seoAgg, {}, requestId);
    return true;
  }

  if (aiAgg && (aiAgg.status === 'completed' || aiAgg.status === 'failed')) {
    console.log(`[RECOVERY] aggregation_resumed | batchId=${batch.batchId} | reason=missing_task_verification_job | fromJobType=PROJECT_AI_AGGREGATION`);
    await chainingEngine.process(aiAgg, {}, requestId);
    return true;
  }

  console.log(`[RECOVERY] recovery_skipped | batchId=${batch.batchId} | reason=no_actionable_gap_found | seoAggStatus=${seoAgg.status} | aiAggStatus=${aiAgg?.status ?? 'missing'}`);
  return false;
}

/**
 * Sweeps every VerificationBatch stuck in AGGREGATING past staleThresholdMs
 * and attempts to resume each one. See resumeOneBatch for the per-batch
 * decision logic.
 *
 * @param {{staleThresholdMs?:number, requestId?:string}} [options]
 * @returns {Promise<{checked:number, resumedCount:number}>}
 */
export async function recoverStalledAggregationBatches(options = {}) {
  const { staleThresholdMs = DEFAULT_STALE_THRESHOLD_MS, requestId = `batch_recovery_${Date.now()}` } = options;
  const staleTime = new Date(Date.now() - staleThresholdMs);

  const stalledBatches = await VerificationBatch.find({
    status: BATCH_STATUS.AGGREGATING,
    aggregateStartedAt: { $lt: staleTime },
  });

  let resumedCount = 0;
  for (const batch of stalledBatches) {
    try {
      const acted = await resumeOneBatch(batch, requestId);
      if (acted) resumedCount++;
    } catch (error) {
      console.error(`[RECOVERY] batch_resume_failed | batchId=${batch.batchId} | reason="${error.message}"`);
    }
  }

  return { checked: stalledBatches.length, resumedCount };
}
