import verificationFinalizer from './VerificationFinalizer.js';
import PageVerificationRun from '../model/PageVerificationRun.js';
import auditProgressService from '../../jobs/service/auditProgressService.js';
import { stageNameForJobType } from './verificationStages.js';
import { JOB_TYPES } from '../../jobs/constants/jobTypes.js';

/**
 * Routes a failed url_verification-mode job through VerificationFinalizer's
 * existing explicit-failure outcome and emits the existing verification:failed
 * event. AI_VISIBILITY is excluded — its failure is already gracefully
 * tolerated (a run can still complete via SEO_SCORING), so it must not
 * prematurely fail a run that can still finish normally.
 *
 * Shared by jobController.js's failJob() (the real-time /fail callback,
 * P3-006/H1) and the H2 stale-job/orphaned-pending-job recovery sweep
 * (jobService.js) — one implementation, two callers, so neither path can
 * drift from the other or duplicate this logic.
 *
 * @param {{_id, jobType, run_id, project_id, input_data}} job - plain object
 *   or Mongoose document; only these fields are read.
 * @param {string} errorMessage
 * @returns {Promise<object|null>} the finalized PageVerificationRun, or null
 *   if this job isn't eligible (not url_verification mode, or AI_VISIBILITY).
 */
export async function handleUrlVerificationJobFailure(job, errorMessage) {
  if (job.input_data?.mode !== 'url_verification' || job.jobType === JOB_TYPES.AI_VISIBILITY) {
    return null;
  }

  // Duplicate-emission guard: checked BEFORE calling finalizeVerification,
  // mirroring the same "was this call the one that transitioned it" pattern
  // chainingEngine.js's completion path uses (P3-006) — finalizeVerification
  // itself is idempotent (a no-op on an already-terminal run, P3-002), but
  // without this pre-check every caller would still emit verification:failed
  // even when nothing actually changed.
  const preCheckRun = await PageVerificationRun.findOne({ runId: job.run_id.toString() }).select('status');
  const alreadyTerminal = preCheckRun && (preCheckRun.status === 'completed' || preCheckRun.status === 'failed');

  const finalizedRun = await verificationFinalizer.finalizeVerification(
    job.run_id.toString(),
    { status: 'failed', errorMessage }
  );

  if (!alreadyTerminal) {
    auditProgressService.emitVerificationFailed({
      runId: job.run_id.toString(),
      verificationRunId: finalizedRun._id.toString(),
      projectId: job.project_id.toString(),
      pageUrl: finalizedRun.pageUrl,
      currentStage: stageNameForJobType(job.jobType),
      currentJob: job._id.toString(),
      errorMessage,
    });
  }

  return finalizedRun;
}
