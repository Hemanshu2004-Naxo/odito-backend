import mongoose from 'mongoose';

import PageVerificationRun from '../model/PageVerificationRun.js';
import Job from '../../jobs/model/Job.js';
import { computeVerificationDelta } from './computeVerificationDelta.js';
import { JOB_TYPES } from '../../jobs/constants/jobTypes.js';

/**
 * Finalizes a completed URL Verification run: loads the PageVerificationRun,
 * reads its already-persisted BEFORE snapshot, collects the AFTER snapshot
 * from current data, computes the delta, and persists the result.
 *
 * BEFORE is read from the document rather than queried fresh: seo_page_scores
 * and ai_scores are upserted in place keyed by {project, url} with no run_id
 * in the filter, so by the time a run's own jobs have completed, the "before"
 * state has already been overwritten by this same run's writes. Whatever
 * creates a PageVerificationRun must populate `before` at run-creation time,
 * prior to dispatching the verification jobs — this service only reads it.
 *
 * Does NOT create jobs, expose APIs, modify workers, or emit websocket events.
 */
class VerificationFinalizer {
  async _loadRun(runId) {
    return PageVerificationRun.findOne({ runId });
  }

  _readBeforeSnapshot(run) {
    return run.before ? run.before.toObject() : {};
  }

  async _collectAfterSnapshot(projectId, pageUrl) {
    const db = mongoose.connection.db;

    const [pageScoreDoc, aiScoreDoc] = await Promise.all([
      db.collection('seo_page_scores').findOne({ projectId, page_url: pageUrl }),
      db.collection('ai_scores').findOne({ project_id: projectId, url: pageUrl }),
    ]);

    return {
      pageScore: pageScoreDoc?.page_score ?? null,
      aisoScore: aiScoreDoc?.hubs?.aiso?.score ?? null,
      aeoScore: aiScoreDoc?.hubs?.aeo?.score ?? null,
      geoScore: aiScoreDoc?.hubs?.geo?.score ?? null,
      criticalIssues: pageScoreDoc?.high_issues_count ?? 0,
      warningIssues: pageScoreDoc?.medium_issues_count ?? 0,
      infoIssues: pageScoreDoc?.low_issues_count ?? 0,
    };
  }

  /**
   * M1: determines what actually happened to THIS run's own AI_VISIBILITY
   * job — reusing existing pipeline metadata (the Job document's own status,
   * scoped to this run_id) rather than inferring anything from ai_scores'
   * values, which cannot distinguish "freshly written this run" from
   * "untouched leftover from an earlier run" (ai_scores is upserted in place
   * per {project, url}, with no run_id in its own identity).
   *
   * - 'SUCCESS': the AI_VISIBILITY job for this run completed — ai_scores is
   *   trustworthy as this run's own result.
   * - 'FAILED': the job ran and failed — gracefully tolerated (the overall
   *   run can still complete via SEO_SCORING), but ai_scores was never
   *   updated this run, so it must not be read as current.
   * - 'SKIPPED': no AI_VISIBILITY job exists for this run_id at all.
   */
  async _determineAiVisibilityStatus(runId) {
    const aiVisibilityJob = await Job.findOne({ run_id: runId, jobType: JOB_TYPES.AI_VISIBILITY })
      .select('status')
      .lean();

    if (!aiVisibilityJob) {
      return 'SKIPPED';
    }
    if (aiVisibilityJob.status === 'completed') {
      return 'SUCCESS';
    }
    if (aiVisibilityJob.status === 'failed') {
      return 'FAILED';
    }
    // Not yet resolved (pending/processing/retrying) — finalization normally
    // only reaches here once allTerminalsResolved has confirmed AI_VISIBILITY
    // is resolved, so this is a defensive fallback, not an expected path.
    // Treat as SKIPPED: ai_scores cannot be trusted as this run's own result
    // until the job actually resolves.
    return 'SKIPPED';
  }

  async _persistCompletion(run, after, delta, aiVisibilityStatus) {
    run.after = after;
    run.delta = delta;
    run.aiVisibilityStatus = aiVisibilityStatus;
    run.status = 'completed';
    run.completedAt = new Date();
    run.durationMs = run.completedAt.getTime() - run.startedAt.getTime();
    run.errorMessage = null;
    await run.save();
    return run;
  }

  async _persistFailure(run, errorMessage) {
    // Deliberately does not touch run.after/run.delta — a failed run keeps
    // whatever snapshot state it already had (its unset defaults, if
    // finalization never got that far) rather than persisting a partial
    // or invalid after/delta.
    run.status = 'failed';
    run.completedAt = new Date();
    run.durationMs = run.completedAt.getTime() - run.startedAt.getTime();
    run.errorMessage = errorMessage;
    await run.save();
    return run;
  }

  /**
   * Finalize a verification run.
   *
   * @param {string} runId
   * @param {{status?: 'completed'|'failed', errorMessage?: string}} [outcome]
   *   Omit (or pass status:'completed') for the success path: collects the
   *   after snapshot and computes the delta. Pass status:'failed' with an
   *   errorMessage when the verification itself failed upstream (e.g. a
   *   worker error) — no snapshot collection is attempted in that case.
   */
  async finalizeVerification(runId, outcome = {}) {
    const run = await this._loadRun(runId);
    if (!run) {
      throw new Error(`PageVerificationRun not found for runId: ${runId}`);
    }

    // Idempotent: an already-terminal run is returned as-is, never reprocessed.
    if (run.status === 'completed' || run.status === 'failed') {
      return run;
    }

    if (outcome.status === 'failed') {
      return this._persistFailure(run, outcome.errorMessage || 'Verification failed');
    }

    try {
      const before = this._readBeforeSnapshot(run);
      const after = await this._collectAfterSnapshot(run.projectId, run.pageUrl);
      const aiVisibilityStatus = await this._determineAiVisibilityStatus(run.runId);

      // M1: never let a stale/reused ai_scores value be read as this run's
      // own result — null the AI fields whenever AI_VISIBILITY didn't
      // actually succeed this run. computeVerificationDelta already treats
      // a null on either side as "unknown" (not zero), so nulling here is
      // sufficient for delta.aiso/aeo/geoScoreChange to correctly come out
      // null too — no change needed to the delta calculation itself.
      if (aiVisibilityStatus !== 'SUCCESS') {
        after.aisoScore = null;
        after.aeoScore = null;
        after.geoScore = null;
      }

      const delta = computeVerificationDelta(before, after);
      return this._persistCompletion(run, after, delta, aiVisibilityStatus);
    } catch (err) {
      return this._persistFailure(run, err.message);
    }
  }
}

export default new VerificationFinalizer();
export { VerificationFinalizer };
