/**
 * Chaining Engine (Config-Driven)
 * Reads pipeline topology from pipelineConfig.js and executes
 * job chaining with atomic guards, parallel dispatch, fallback, and hooks.
 *
 * The completion handler calls: chainingEngine.process(job, stats, requestId)
 */

import { JobService } from './service/jobService.js';
import auditProgressService from './service/auditProgressService.js';
import taskVerificationService from '../tasks/service/TaskVerificationService.js';
import auditHistoryService from '../audit_history/service/AuditHistoryService.js';
import verificationFinalizer from '../verification/service/VerificationFinalizer.js';
import PageVerificationRun from '../verification/model/PageVerificationRun.js';
import VerificationBatch from '../verification/model/VerificationBatch.js';
import { BATCH_STATUS } from '../verification/constants/batchStatus.js';
import { stageNameForJobType, progressForJobType } from '../verification/service/verificationStages.js';
import { JOB_TYPES, JOB_TYPE_CONFIG } from './constants/jobTypes.js';
import JobDispatcher from './service/jobDispatcher.js';
import { PIPELINE_CONFIG } from './pipelineConfig.js';
import SeoProject from '../app_user/model/SeoProject.js';
import mongoose from 'mongoose';
// Side-effect-only import: registers the JobGroup schema with this process's
// mongoose instance (via JobGroup.js's own mongoose.model('JobGroup', ...)
// call). No file in the codebase previously imported JobGroup.js directly,
// so every mongoose.model('JobGroup') lookup below (recordChunkOutcome,
// _createPageScrapingChunkGroup, _createHeadlessAccessibilityChunkGroup,
// checkDependencyGate) threw MissingSchemaError. Do not remove this import
// even though nothing binds a local name to it — that's intentional, it
// exists purely to trigger the registration side effect.
import './model/JobGroup.js';
import UrlSelection from './model/UrlSelection.js';

const jobService = new JobService();
// Remove global jobDispatcher instantiation - will be created in functions

// ---------------------------------------------------------------------------
// Maps: job type → creation function / dispatch function
// Eliminates all switch-case blocks
// ---------------------------------------------------------------------------

const JOB_CREATION_MAP = {
  [JOB_TYPES.LINK_DISCOVERY]: (src) => jobService.createJob({
    user_id: src.user_id,
    seo_project_id: src.project_id,
    jobType: JOB_TYPES.LINK_DISCOVERY,
    input_data: {
      main_url: src.input_data?.main_url || src.main_url
    },
    priority: JOB_TYPE_CONFIG[JOB_TYPES.LINK_DISCOVERY].priority,
    run_id: src.run_id
  }),
  [JOB_TYPES.URL_QUALIFICATION]: (src) => jobService.createAndDispatchUrlQualificationJob(src),
  [JOB_TYPES.PAGE_SCRAPING]: (src) => jobService.createAndDispatchPageScrapingJob(src),
  [JOB_TYPES.PAGE_ANALYSIS]: (src) => jobService.createAndDispatchPageAnalysisJob(src),
  [JOB_TYPES.PERFORMANCE_MOBILE]: (src) => jobService.createAndDispatchPerformanceMobileJob(src),
  [JOB_TYPES.PERFORMANCE_DESKTOP]: (src) => jobService.createAndDispatchPerformanceDesktopJob(src),
  [JOB_TYPES.HEADLESS_ACCESSIBILITY]: (src) => jobService.createAndDispatchHeadlessAccessibilityJob(src),
  [JOB_TYPES.SEO_SCORING]: (src) => jobService.createAndDispatchSeoScoringJob(src),
  [JOB_TYPES.CRAWL_GRAPH]: (src) => jobService.createAndDispatchCrawlGraphJob(src),
  [JOB_TYPES.AI_VISIBILITY]: (src) => jobService.createAndDispatchAiVisibilityJob(src),
  // F4-016: PROJECT_SEO_AGGREGATION has no entry here — it is never created
  // in response to another job's completion (see the barrier's own
  // _enqueueProjectAggregationChain below), so it never goes through
  // _createJobDirect/JOB_CREATION_MAP.
  [JOB_TYPES.PROJECT_AI_AGGREGATION]: (src) => jobService.createAndDispatchProjectAiAggregationJob(src),
  [JOB_TYPES.PROJECT_TASK_VERIFICATION]: (src) => jobService.createAndDispatchProjectTaskVerificationJob(src),
};

// Function to create job dispatch map with local JobDispatcher instance
const createJobDispatchMap = () => {
  const jobDispatcher = new JobDispatcher();
  return {
    [JOB_TYPES.LINK_DISCOVERY]: (job) => jobDispatcher.dispatchLinkDiscoveryJob(job),
    [JOB_TYPES.URL_QUALIFICATION]: (job) => jobDispatcher.dispatchUrlQualificationJob(job),
    [JOB_TYPES.PAGE_SCRAPING]: (job) => jobDispatcher.dispatchPageScrapingJob(job),
    [JOB_TYPES.PERFORMANCE_MOBILE]: (job) => jobDispatcher.dispatchPerformanceMobileJob(job),
    [JOB_TYPES.PERFORMANCE_DESKTOP]: (job) => jobDispatcher.dispatchPerformanceDesktopJob(job),
    [JOB_TYPES.HEADLESS_ACCESSIBILITY]: (job) => jobDispatcher.dispatchHeadlessAccessibilityJob(job),
    [JOB_TYPES.PAGE_ANALYSIS]: (job) => jobDispatcher.dispatchPageAnalysisJob(job),
    [JOB_TYPES.SEO_SCORING]: (job) => jobDispatcher.dispatchSeoScoringJob(job),
    [JOB_TYPES.CRAWL_GRAPH]: (job) => jobDispatcher.dispatchCrawlGraphJob(job),
    [JOB_TYPES.AI_VISIBILITY]: (job) => jobDispatcher.dispatchAiVisibilityJob(job),
    [JOB_TYPES.PROJECT_SEO_AGGREGATION]: (job) => jobDispatcher.dispatchProjectSeoAggregationJob(job),
    [JOB_TYPES.PROJECT_AI_AGGREGATION]: (job) => jobDispatcher.dispatchProjectAiAggregationJob(job),
    // F4-016: PROJECT_TASK_VERIFICATION deliberately has no entry — it is
    // Node-self-processed (see _runProjectTaskVerificationJob) and never
    // reaches _dispatchToWorker; _createAndDispatchJob bypasses this map
    // for that one job type entirely.
  };
};

// ---------------------------------------------------------------------------
// Job types that participate in the PAGE_ANALYSIS dependency gate.
// When any of these completes, we check if all required conditions are met.
//
// Full audit gate:   PERFORMANCE_DESKTOP (completed) + HEADLESS_ACCESSIBILITY → PAGE_ANALYSIS
// Verification gate: PAGE_SCRAPING (completed) + HEADLESS_ACCESSIBILITY (completed|failed)
//                    Both are dispatched simultaneously in startVerification(), so either
//                    can complete first. Adding PAGE_SCRAPING here ensures the gate re-fires
//                    when PAGE_SCRAPING completes after HEADLESS already resolved.
// ---------------------------------------------------------------------------
const DEPENDENCY_GATE_TYPES = new Set([
  JOB_TYPES.PERFORMANCE_DESKTOP,
  JOB_TYPES.HEADLESS_ACCESSIBILITY,
  JOB_TYPES.PAGE_SCRAPING,
]);

// ---------------------------------------------------------------------------
// JobGroup chunking.
//
// PAGE_SCRAPING: 50 matches the size the pipeline is already tuned/proven
// around (the same figure as URL_QUALIFICATION's CANONICAL_CAP).
//
// HEADLESS_ACCESSIBILITY: smaller (25) — browser automation is far more
// expensive per URL (Semaphore(3) concurrency, 180s per-URL timeout) than
// PAGE_SCRAPING's plain HTTP fetch, per the JobGroup architecture audit.
// ---------------------------------------------------------------------------
const PAGE_SCRAPING_CHUNK_SIZE = 50;
const HEADLESS_ACCESSIBILITY_CHUNK_SIZE = 25;

// URL-level PAGE_SCRAPING retry — how many additional retry ROUNDS (not
// whole-job crash-retries, a separate pre-existing mechanism keyed on
// Job.attempts) are attempted for URLs still unresolved in seo_page_failures
// before leaving them as a final, permanent failure. 2 rounds = 3 total
// attempts per URL (1 initial + 2 retries), matching the platform default
// elsewhere. Configurable without a code change if a deployment needs a
// different ceiling.
const PAGE_SCRAPING_MAX_RETRY_ROUNDS = parseInt(process.env.PAGE_SCRAPING_MAX_RETRY_ROUNDS || '2', 10);

class ChainingEngine {

  /**
   * Main entry point — process chaining for a completed job.
   * Reads PIPELINE_CONFIG to determine what to do.
   *
   * @param {Object} updatedJob - The completed job document
   * @param {Object} stats - Stats payload from the worker
   * @param {string} requestId - Request trace ID for logging
   */
  async process(updatedJob, stats, requestId) {
    const jobType = updatedJob.jobType;
    const config = PIPELINE_CONFIG[jobType];

    console.log(`[CHAINING:${requestId}] Job completed: ${jobType}`);

    // Project status updates are handled by projectStatusService.updateForJobType()
    // in jobCompletionHandler.js — no duplicate call needed here.

    try {
      // ── URL Verification stage progress (P3-006) ────────────────────────
      // Emitted for every job completion in a url_verification run (not
      // just terminals) — one emit per real pipeline stage finishing, which
      // is a handful of events per run, not a per-tick cost. A single
      // lookup confirms the run isn't already terminal (a job unrelated to
      // — or arriving after — a run that already finished should never
      // re-open its progress bar).
      if (updatedJob.input_data?.mode === 'url_verification' && updatedJob.project_id) {
        try {
          const run = await PageVerificationRun.findOne({ runId: updatedJob.run_id?.toString() })
            .select('_id status pageUrl');
          if (run && run.status !== 'completed' && run.status !== 'failed') {
            auditProgressService.emitVerificationProgress({
              runId: updatedJob.run_id.toString(),
              verificationRunId: run._id.toString(),
              projectId: updatedJob.project_id.toString(),
              pageUrl: run.pageUrl,
              progress: progressForJobType(jobType),
              currentStage: stageNameForJobType(jobType),
              currentJob: updatedJob._id.toString(),
            });
          }
        } catch (progressEmitError) {
          console.error(`[CHAINING:${requestId}] verification:progress emit failed (non-fatal): ${progressEmitError.message}`);
        }
      }

      // ── Chunked-stage completion (PAGE_SCRAPING, HEADLESS_ACCESSIBILITY) ──
      // If this completing job belongs to a JobGroup, it was one chunk of a
      // multi-chunk stage. Quick Recheck's PAGE_SCRAPING/HEADLESS_ACCESSIBILITY
      // never have a group_id (created directly in scrapingController.js,
      // never routed through the chunked creation path), so verification mode
      // is completely unaffected and falls through to the unchanged logic
      // below.
      //
      // Every chunk completion increments the group's counters; only the
      // completion that resolves the LAST outstanding chunk continues past
      // this point. Every other chunk's completion returns immediately —
      // this is what prevents the N-way duplication that firing a stage's
      // `next`/dependency-gate re-check on every individual chunk would
      // otherwise cause.
      if (updatedJob.group_id) {
        const finalizedGroup = await this.recordChunkOutcome(updatedJob, requestId);
        if (!finalizedGroup) {
          console.log(`[CHAINING:${requestId}] Chunk completed, group not yet resolved — no fan-out for this chunk | jobId=${updatedJob._id}`);
          return;
        }
        console.log(`[CHAINING:${requestId}] JobGroup resolved | groupId=${finalizedGroup._id} | stage=${finalizedGroup.stage} | status=${finalizedGroup.status}`);

        // URL-level retry (PAGE_SCRAPING only): before treating this group as
        // truly finalized, check whether seo_page_failures still has
        // unresolved URLs for this run and retry budget remains. If so,
        // create retry chunk(s) scoped to ONLY those URLs, extend this SAME
        // group (total_chunks/chunks_completed — no new JobGroup), and defer
        // entirely — recordChunkOutcome's own atomic counters naturally
        // re-open (resolvedChunks < total_chunks again) the moment
        // total_chunks increases, so the dependency gate below is never
        // reached until the retry chunks also resolve. No other code needs
        // to change for the gate to "wait" for retries.
        if (jobType === JOB_TYPES.PAGE_SCRAPING) {
          const retryCreated = await this._maybeCreatePageScrapingRetryChunks(finalizedGroup, updatedJob, requestId);
          if (retryCreated) {
            return;
          }
        }

        // PAGE_SCRAPING specifically: a totally-failed group has no
        // successful data to hand to CRAWL_GRAPH/AI_VISIBILITY via
        // PAGE_SCRAPING's own `next` fan-out, so skip it entirely. This is
        // safe and inert either way — CRAWL_GRAPH never being created means
        // PERFORMANCE_DESKTOP never exists, so the full-audit dependency
        // gate stays closed regardless of whether it's re-checked here.
        //
        // HEADLESS_ACCESSIBILITY has no `next` fan-out of its own (its only
        // downstream effect is the dependency gate below) and the gate
        // already treats "completed OR failed" as equally resolved
        // (graceful degradation). A totally-failed HEADLESS group must
        // still reach the gate check below — skipping it here would risk
        // PAGE_ANALYSIS waiting forever on accessibility data that will
        // never arrive.
        if (jobType === JOB_TYPES.PAGE_SCRAPING && finalizedGroup.status === 'failed') {
          console.log(`[CHAINING:${requestId}] PAGE_SCRAPING JobGroup failed (0 successful chunks) — no next-stage fan-out | groupId=${finalizedGroup._id}`);
          return;
        }
        // Otherwise fall through to the existing hooks/next-stage/gate logic
        // below, exactly as if a single job of this type had completed.
      }

      // onComplete hook fires for every terminal job type (SEO_SCORING,
      // AI_VISIBILITY — see PIPELINE_CONFIG). These are independent parallel
      // branches of the same audit; completion of ONE of them proves nothing
      // about the other. audit:completed must therefore be emitted at most
      // once, and only once every required terminal type has actually
      // resolved for this run — never on the first one to finish.
      if (config?.hooks?.onComplete === 'emitCompleted') {

        // P3-002: Task Verification now runs exactly once per batch, gated
        // behind each branch's own single-winner guard below (the
        // `!alreadyTerminal` check for url_verification, `finalized` for a
        // full audit) — previously this ran unconditionally here, once per
        // terminal job type (SEO_SCORING AND AI_VISIBILITY independently),
        // i.e. twice per batch, racing both callers against the same Task
        // documents. See the two call sites further down.

        // P3-004: a url_verification run must never reach Full Audit's
        // completion path — no audit_runs snapshot, no crawl_status flip,
        // no audit:completed event (crawl_status/audit:completed are
        // project-wide signals; a single-page recheck has no business
        // touching either). Full Audit and legacy 'verification' mode fall
        // through to the exact unchanged block below — isUrlVerification is
        // false for both, so their behavior is byte-identical to before.
        const isUrlVerification = updatedJob.input_data?.mode === 'url_verification';

        if (isUrlVerification) {
          // ── URL Verification finalization ────────────────────────────
          // Reuses auditHistoryService.allTerminalsResolved() unchanged —
          // it already scopes to run_id and already treats AI_VISIBILITY
          // failure as gracefully resolved, exactly what a verification run
          // needs too. Routes to VerificationFinalizer instead of
          // AuditHistoryService/crawl_status once both terminals resolve.
          if (updatedJob.project_id) {
            try {
              const allResolved = await auditHistoryService.allTerminalsResolved(
                updatedJob.project_id, updatedJob.run_id, requestId
              );
              if (allResolved) {
                // Duplicate-emission guard: checked BEFORE calling
                // finalizeVerification, mirroring _finalizeAuditCompletion's
                // own "was this MY call that transitioned it" pattern — if
                // two terminal jobs resolve nearly simultaneously, only the
                // caller that finds a non-terminal run emits.
                const preCheckRun = await PageVerificationRun.findOne({ runId: updatedJob.run_id.toString() })
                  .select('status');
                const alreadyTerminal = preCheckRun && (preCheckRun.status === 'completed' || preCheckRun.status === 'failed');

                const finalizedRun = await verificationFinalizer.finalizeVerification(updatedJob.run_id.toString());
                console.log(`[CHAINING:${requestId}] URL Verification finalized | runId=${updatedJob.run_id} | projectId=${updatedJob.project_id} | status=${finalizedRun.status}`);

                if (!alreadyTerminal) {
                  // ── Task Verification (P3-002, exactly once) ─────────────
                  // Piggybacks on the SAME single-winner guard used just above
                  // to decide who gets to emit verification:completed/failed —
                  // reuses the existing synchronization strategy rather than
                  // introducing a new one. Runs before the emit below so the
                  // Task's status is already updated by the time the frontend
                  // receives verification:completed and refetches.
                  try {
                    const verifyResult = await taskVerificationService.verifyImplementedTasks(
                      updatedJob.project_id, requestId, updatedJob._id
                    );
                    console.log(`[CHAINING:${requestId}] Task verification complete | verified=${verifyResult.verified} | reopened=${verifyResult.reopened}`);
                  } catch (verifyError) {
                    console.error(`[CHAINING:${requestId}] Task verification failed (non-fatal): ${verifyError.message}`);
                  }

                  try {
                    const eventData = {
                      runId: updatedJob.run_id.toString(),
                      verificationRunId: finalizedRun._id.toString(),
                      projectId: updatedJob.project_id.toString(),
                      pageUrl: finalizedRun.pageUrl,
                      currentJob: updatedJob._id.toString(),
                    };
                    if (finalizedRun.status === 'completed') {
                      auditProgressService.emitVerificationCompleted(eventData);
                    } else if (finalizedRun.status === 'failed') {
                      auditProgressService.emitVerificationFailed({ ...eventData, currentStage: 'Finalization', errorMessage: finalizedRun.errorMessage });
                    }
                  } catch (emitError) {
                    console.error(`[CHAINING:${requestId}] verification:completed/failed emit failed (non-fatal): ${emitError.message}`);
                  }

                  // ── Verification Batch barrier (F4-015, exactly once) ────
                  // Only runs for a run that actually belongs to a batch —
                  // single-URL verification (batchId null) never reaches
                  // this at all. Piggybacks on the SAME per-page winner
                  // guard as task verification/the emit above, matching
                  // this file's own established pattern.
                  if (finalizedRun.batchId) {
                    try {
                      await this._checkVerificationBatchBarrier(finalizedRun, requestId);
                    } catch (barrierError) {
                      console.error(`[CHAINING:${requestId}] Verification batch barrier check failed (non-fatal): ${barrierError.message}`);
                    }
                  }
                } else {
                  console.log(`[CHAINING:${requestId}] URL Verification already finalized by a concurrent completion — no duplicate emit | runId=${updatedJob.run_id}`);
                }
              } else {
                console.log(`[CHAINING:${requestId}] ${jobType} completed but other required terminal job(s) unresolved — deferring verification finalization | projectId=${updatedJob.project_id}`);
              }
            } catch (verificationFinalizeError) {
              console.error(`[CHAINING:${requestId}] URL Verification finalization failed (non-fatal): ${verificationFinalizeError.message}`);
            }
          }
        } else {
          // ── Audit finalization (single source of truth) ─────────────────
          // auditHistoryService.allTerminalsResolved() is the one place that
          // decides whether the ENTIRE audit is done — it checks every job
          // type PIPELINE_CONFIG marks as a completion terminal, not just the
          // one that just completed. Only when all of them have resolved do we
          // (a) atomically flip SeoProject.crawl_status to 'completed' — the
          // single canonical signal the frontend now polls — and (b) emit the
          // audit:completed websocket event. The atomic, conditional
          // findOneAndUpdate in _finalizeAuditCompletion guarantees that even
          // if two terminal jobs resolve at nearly the same instant (two
          // concurrent calls into this function), only one of them wins the
          // transition, so crawl_status changes exactly once and the websocket
          // event fires exactly once.
          if (updatedJob.project_id) {
            try {
              const allResolved = await auditHistoryService.allTerminalsResolved(
                updatedJob.project_id, updatedJob.run_id, requestId
              );
              if (allResolved) {
                const finalized = await this._finalizeAuditCompletion(updatedJob, requestId);
                if (finalized) {
                  // ── Task Verification (P3-002, exactly once) ───────────
                  // Piggybacks on _finalizeAuditCompletion's own atomic
                  // findOneAndUpdate guard — `finalized` is true only for
                  // the one caller that actually won the crawl_status
                  // transition, so this can never double-run even if both
                  // terminal jobs resolve at nearly the same instant.
                  try {
                    const verifyResult = await taskVerificationService.verifyImplementedTasks(
                      updatedJob.project_id, requestId, updatedJob._id
                    );
                    console.log(`[CHAINING:${requestId}] Task verification complete | verified=${verifyResult.verified} | reopened=${verifyResult.reopened}`);
                  } catch (verifyError) {
                    console.error(`[CHAINING:${requestId}] Task verification failed (non-fatal): ${verifyError.message}`);
                  }

                  await this._emitCompletionEvent(updatedJob, stats, requestId);
                } else {
                  console.log(`[CHAINING:${requestId}] Audit already finalized by a concurrent completion — no duplicate emit | projectId=${updatedJob.project_id}`);
                }
              } else {
                console.log(`[CHAINING:${requestId}] ${jobType} completed but other required terminal job(s) unresolved — deferring audit:completed | projectId=${updatedJob.project_id}`);
              }
            } catch (finalizeError) {
              console.error(`[CHAINING:${requestId}] Audit finalization check failed (non-fatal): ${finalizeError.message}`);
            }
          }

          // ── Audit History ──────────────────────────────────────────────
          // Capture an immutable snapshot of this audit into audit_runs.
          // Called after each terminal job (SEO_SCORING or AI_VISIBILITY) —
          // the service checks internally (via the same allTerminalsResolved)
          // that all terminals are resolved before writing. Failure here is
          // non-fatal and never blocks the pipeline.
          if (updatedJob.project_id) {
            try {
              await auditHistoryService.captureIfComplete(
                updatedJob.project_id,
                updatedJob.run_id,
                requestId
              );
            } catch (historyError) {
              console.error(`[CHAINING:${requestId}] Audit history capture failed (non-fatal): ${historyError.message}`);
            }

          }
        }
      } else if (config?.hooks?.onComplete === 'batchCompleted') {
        // ── Verification Batch completion (F4-016, exactly once) ──────────
        // PROJECT_TASK_VERIFICATION's own onComplete hook — separate from
        // 'emitCompleted' above since this is a batch-scoped completion
        // (Verification Batch), never a Full Audit / single-URL
        // verification one. Runs regardless of whether updatedJob itself is
        // 'completed' or permanently 'failed' (see
        // _runProjectTaskVerificationJob below) — COMPLETED/PARTIAL/FAILED
        // is determined from the batch's own per-URL counts, not from this
        // one job's own outcome.
        const batchId = updatedJob.input_data?.batchId;
        if (batchId) {
          try {
            await this._finalizeVerificationBatch(batchId, requestId);
          } catch (batchFinalizeError) {
            console.error(`[CHAINING_ERROR:${requestId}] Verification batch finalization failed (non-fatal): ${batchFinalizeError.message}`);
          }
        } else {
          console.error(`[CHAINING_ERROR:${requestId}] PROJECT_TASK_VERIFICATION completed with no batchId — cannot finalize batch | jobId=${updatedJob._id}`);
        }
      }

      // Verification-family mode: PAGE_SCRAPING must NOT chain to CRAWL_GRAPH.
      // In a full audit, PAGE_SCRAPING → parallel(CRAWL_GRAPH, AI_VISIBILITY).
      // In verification mode (detected via input_data.mode), CRAWL_GRAPH is skipped —
      // the dependency gate now opens on HEADLESS_ACCESSIBILITY alone (no CRAWL_GRAPH,
      // no PERFORMANCE_DESKTOP), so PAGE_ANALYSIS starts as soon as headless resolves.
      //
      // P1-002: widened to also recognize 'url_verification' (the new
      // single-URL Verification Engine mode — P1-001) alongside the existing
      // legacy project-wide 'verification' mode; both skip CRAWL_GRAPH
      // identically, no new branching beyond that. Any other mode value
      // (including undefined/missing, i.e. Full Audit) is unaffected —
      // .includes() only matches these two literal strings.
      //
      // checkDependencyGate's own, separate mode check (a few hundred lines
      // below) is NOT modified by this task — that widening is P1-003.
      const isVerificationMode = ['verification', 'url_verification'].includes(updatedJob.input_data?.mode);
      const isVerificationPageScraping = jobType === JOB_TYPES.PAGE_SCRAPING && isVerificationMode;

      // Compute effective next-job list; filter CRAWL_GRAPH for verification PAGE_SCRAPING
      let effectiveNext = config?.next ? [...config.next] : [];
      if (isVerificationPageScraping) {
        effectiveNext = effectiveNext.filter(t => t !== JOB_TYPES.CRAWL_GRAPH);
        console.log(`[CHAINING:${requestId}] Verification mode: CRAWL_GRAPH excluded from PAGE_SCRAPING chain`);
      }

      // Chunked-stage creation: PAGE_SCRAPING (Phase C) and
      // HEADLESS_ACCESSIBILITY (Phase D) are each created as a JobGroup of
      // chunk jobs — not a single job — when reached via URL_QUALIFICATION's
      // fan-out, the only place either is created for a full audit. Both
      // are filtered out of effectiveNext here and handled by dedicated
      // methods instead of the generic single-job _createAndDispatchJob.
      const isChunkedPageScrapingTarget = jobType === JOB_TYPES.URL_QUALIFICATION
        && effectiveNext.includes(JOB_TYPES.PAGE_SCRAPING);
      const isChunkedHeadlessTarget = jobType === JOB_TYPES.URL_QUALIFICATION
        && effectiveNext.includes(JOB_TYPES.HEADLESS_ACCESSIBILITY);
      if (isChunkedPageScrapingTarget) {
        effectiveNext = effectiveNext.filter(t => t !== JOB_TYPES.PAGE_SCRAPING);
      }
      if (isChunkedHeadlessTarget) {
        effectiveNext = effectiveNext.filter(t => t !== JOB_TYPES.HEADLESS_ACCESSIBILITY);
      }

      // No config or empty next → nothing to chain (but may have dependency gate)
      if (!config || (effectiveNext.length === 0 && !isChunkedPageScrapingTarget && !isChunkedHeadlessTarget)) {
        console.log(`[CHAINING:${requestId}] No direct chaining for jobType=${jobType}`);
      } else {
        // Pre-chain hooks (beforeChain only fires when there are next jobs)
        if (config.hooks?.beforeChain === 'emitCompleted') {
          await this._emitCompletionEvent(updatedJob, stats, requestId);
        }

        const sourceJob = updatedJob;

        // forwardCanonicalUrls: extract canonicalUrls from this job's result_data
        // and attach them to sourceJob so createAndDispatch* methods can propagate
        // them into each downstream job's input_data without a second DB read.
        if (config.forwardCanonicalUrls) {
          const canonicalUrls = updatedJob.result_data?.canonicalUrls || [];
          console.log(`[CHAINING:${requestId}] Forwarding canonicalUrls to downstream jobs | count=${canonicalUrls.length}`);
          // Attach to sourceJob so all JOB_CREATION_MAP entries receive it
          sourceJob._canonicalUrls = canonicalUrls;
        }

        // Determine stageFrom (for progress events)
        const stageFrom = config.stageFrom || jobType;

        if (config.parallel) {
          await Promise.allSettled(
            effectiveNext.map((nextType) =>
              this._createAndDispatchJob(nextType, updatedJob, sourceJob, stageFrom, config, requestId, false)
            )
          );
        } else {
          for (const nextType of effectiveNext) {
            await this._createAndDispatchJob(nextType, updatedJob, sourceJob, stageFrom, config, requestId, false);
          }
        }

        // Chunked PAGE_SCRAPING/HEADLESS_ACCESSIBILITY creation, each run as
        // an additional, separately caught step so a failure in one can
        // never block (or be blocked by) the other — mirroring the "don't
        // let one failure block the other" intent of parallel:true without
        // touching the shared dispatch loop itself.
        //
        // URL Selection gate: if this project requires user review of
        // discovered URLs (SeoProject.require_url_selection, default true),
        // park the pipeline here instead of auto-creating either JobGroup.
        // Quick Recheck never reaches this code at all (it creates
        // PAGE_SCRAPING/HEADLESS_ACCESSIBILITY directly, bypassing
        // URL_QUALIFICATION entirely), so it is unaffected regardless of
        // this flag. The chunk-creation functions themselves are untouched —
        // POST /url-selection calls them directly once the user approves.
        if (isChunkedPageScrapingTarget || isChunkedHeadlessTarget) {
          const project = await SeoProject.findById(sourceJob.project_id).select('require_url_selection').lean();
          const requiresSelection = project?.require_url_selection !== false; // default true

          if (requiresSelection) {
            // Idempotency guard: a duplicate/retried URL_QUALIFICATION
            // completion (e.g. completeJobSafely receiving the same job's
            // completion event more than once) must not re-park a project
            // that has already been through this gate once — the user may
            // already have approved a UrlSelection, and PAGE_SCRAPING/
            // HEADLESS_ACCESSIBILITY JobGroups may already be actively
            // running. Check for any of the three artifacts the approval
            // flow produces, scoped to this exact run, before ever
            // rewriting crawl_status or re-emitting the awaiting-selection
            // event a second time.
            const JobGroup = mongoose.model('JobGroup');
            const [existingSelection, existingPageScrapingGroup, existingHeadlessGroup] = await Promise.all([
              UrlSelection.findOne({ project_id: sourceJob.project_id, run_id: sourceJob.run_id }).lean(),
              JobGroup.findOne({ project_id: sourceJob.project_id, run_id: sourceJob.run_id, stage: JOB_TYPES.PAGE_SCRAPING }).lean(),
              JobGroup.findOne({ project_id: sourceJob.project_id, run_id: sourceJob.run_id, stage: JOB_TYPES.HEADLESS_ACCESSIBILITY }).lean()
            ]);
            const alreadyPassedGate = !!(existingSelection || existingPageScrapingGroup || existingHeadlessGroup);

            if (alreadyPassedGate) {
              console.log(`[CHAINING:${requestId}] URL selection gate already resolved for this run — skipping duplicate park | projectId=${sourceJob.project_id} | runId=${sourceJob.run_id}`);
            } else {
              try {
                await SeoProject.findByIdAndUpdate(sourceJob.project_id, {
                  crawl_status: 'awaiting_url_selection'
                });
                auditProgressService.emitAwaitingSelection(sourceJob.project_id.toString(), {
                  projectId: sourceJob.project_id.toString(),
                  sourceJobId: sourceJob._id.toString(),
                  totalQualified: (sourceJob._canonicalUrls || []).length
                });
                console.log(`[CHAINING:${requestId}] URL selection required — pipeline parked at 'awaiting_url_selection', JobGroup creation deferred | projectId=${sourceJob.project_id}`);
              } catch (gateError) {
                console.error(`[CHAINING_ERROR:${requestId}] Failed to park project for URL selection | reason="${gateError.message}"`);
              }
            }
          } else {
            if (isChunkedPageScrapingTarget) {
              try {
                await this._createPageScrapingChunkGroup(sourceJob, requestId);
              } catch (chunkError) {
                console.error(`[CHAINING_ERROR:${requestId}] PAGE_SCRAPING chunk group creation failed | reason="${chunkError.message}"`);
              }
            }
            if (isChunkedHeadlessTarget) {
              try {
                await this._createHeadlessAccessibilityChunkGroup(sourceJob, requestId);
              } catch (chunkError) {
                console.error(`[CHAINING_ERROR:${requestId}] HEADLESS_ACCESSIBILITY chunk group creation failed | reason="${chunkError.message}"`);
              }
            }
          }
        }
      }

      // ─────────────────────────────────────────────────────────────────────
      // Dependency gate: PERFORMANCE_DESKTOP + HEADLESS_ACCESSIBILITY → PAGE_ANALYSIS
      // Checked whenever either gating job completes.
      // ─────────────────────────────────────────────────────────────────────
      if (DEPENDENCY_GATE_TYPES.has(jobType)) {
        await this.checkDependencyGate(updatedJob, requestId);
      }

      console.log(`[CHAINING:${requestId}] Job chaining completed | jobType=${jobType}`);

    } catch (error) {
      console.error(`[CHAINING_ERROR:${requestId}] Job chaining failed | jobType=${jobType} | reason="${error.message}"`);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // JobGroup chunking (Phase C — PAGE_SCRAPING only)
  // ---------------------------------------------------------------------------

  /**
   * Atomically increments the owning JobGroup's chunk counters and detects
   * whether THIS outcome is the one that resolves the last outstanding
   * chunk. Called from process() for successful chunk completions and from
   * jobController.failJob for chunks that permanently fail (retries
   * exhausted) — both paths funnel through this one function so "is this
   * the last chunk" has a single, atomic implementation regardless of which
   * way a chunk resolves.
   *
   * Race safety: $inc is atomic and monotonic, so exactly one call will ever
   * observe the counters reach total_chunks for a given group — no separate
   * locking needed for that detection. The subsequent finalize step is
   * additionally guarded by a status filter so even a duplicate/redundant
   * call after finalization is a safe no-op.
   *
   * Per-job idempotency: the $inc above only guarantees a *single* call
   * increments the counters correctly — it does nothing to stop the SAME
   * physical chunk job from being recorded twice if its completion/failure
   * is delivered more than once (worker retry, redelivered callback,
   * concurrent requests for the same job_id). That would otherwise corrupt
   * the counters (and could finalize the group early, on incomplete data,
   * silently dropping the real last chunk's outcome). To prevent this, the
   * job is atomically claimed via `chunk_recorded` BEFORE either counter is
   * touched: the filtered findOneAndUpdate below can only ever succeed once
   * per job _id, so a duplicate call for the same job is a safe no-op that
   * never reaches the JobGroup at all.
   *
   * @param {Object} updatedJob - The completed/failed chunk Job document
   * @param {string} requestId
   * @returns {Object|null} the finalized JobGroup if this call closed out
   *   the group, or null if the group is not yet fully resolved, this job's
   *   outcome was already recorded (duplicate), or the group was already
   *   finalized by a concurrent/duplicate call.
   */
  async recordChunkOutcome(updatedJob, requestId) {
    if (!updatedJob.group_id) {
      return null;
    }

    const Job = mongoose.model('Job');

    // Atomic per-job claim: exactly one caller can ever flip chunk_recorded
    // false→true for this job _id. Every other (duplicate) call for the
    // same job gets null here and returns before the JobGroup is touched.
    const claimedJob = await Job.findOneAndUpdate(
      { _id: updatedJob._id, chunk_recorded: { $ne: true } },
      { $set: { chunk_recorded: true } },
      { new: true }
    );

    if (!claimedJob) {
      console.log(`[CHUNK:${requestId}] Duplicate chunk outcome ignored (already recorded) | jobId=${updatedJob._id} | group_id=${updatedJob.group_id}`);
      return null;
    }

    const JobGroup = mongoose.model('JobGroup');
    const incField = updatedJob.status === 'completed' ? 'chunks_completed' : 'chunks_failed';

    const group = await JobGroup.findByIdAndUpdate(
      updatedJob.group_id,
      { $inc: { [incField]: 1 }, $set: { status: 'processing' } },
      { new: true }
    );

    if (!group) {
      console.error(`[CHUNK:${requestId}] JobGroup not found | group_id=${updatedJob.group_id} | jobId=${updatedJob._id}`);
      return null;
    }

    const resolvedChunks = group.chunks_completed + group.chunks_failed;
    console.log(`[CHUNK:${requestId}] Chunk outcome recorded | groupId=${group._id} | stage=${group.stage} | jobStatus=${updatedJob.status} | resolved=${resolvedChunks}/${group.total_chunks}`);

    if (resolvedChunks < group.total_chunks) {
      return null; // group not yet fully resolved
    }

    const finalStatus = group.chunks_failed === 0
      ? 'completed'
      : (group.chunks_completed === 0 ? 'failed' : 'partial');

    // Status-guarded finalize: only the first call to observe
    // resolvedChunks === total_chunks (there can only ever be one, since
    // $inc is atomic) actually flips status away from a non-terminal value.
    const finalizedGroup = await JobGroup.findOneAndUpdate(
      { _id: group._id, status: { $nin: ['completed', 'partial', 'failed'] } },
      { $set: { status: finalStatus } },
      { new: true }
    );

    if (!finalizedGroup) {
      console.log(`[CHUNK:${requestId}] JobGroup already finalized by a concurrent call | groupId=${group._id}`);
      return null;
    }

    return finalizedGroup;
  }

  /**
   * Create a PAGE_SCRAPING JobGroup and its chunk jobs from a completed
   * URL_QUALIFICATION job, then dispatch each chunk (PUSH mode) or leave
   * them pending for the Python poller (PULL mode) — mirroring exactly how
   * the single-job PAGE_SCRAPING path already handles each mode.
   *
   * Idempotent: the JobGroup's (project_id, run_id, stage) index is unique,
   * so a duplicate call (e.g. a repeated completion webhook) fails on
   * create() with a duplicate-key error, which is caught and treated as a
   * safe no-op rather than creating a second set of chunk jobs.
   *
   * @param {Object} urlQualificationJob - The completed URL_QUALIFICATION
   *   job, with `_canonicalUrls` already attached by process() when
   *   forwardCanonicalUrls is set.
   * @param {string} requestId
   */
  async _createPageScrapingChunkGroup(urlQualificationJob, requestId) {
    const JobGroup = mongoose.model('JobGroup');

    const canonicalUrls = urlQualificationJob._canonicalUrls
      || urlQualificationJob.input_data?.canonical_urls
      || [];
    const totalUrls = canonicalUrls.length;
    const chunkSize = PAGE_SCRAPING_CHUNK_SIZE;
    const totalChunks = Math.max(1, Math.ceil(totalUrls / chunkSize) || 1);

    let group;
    try {
      group = await JobGroup.create({
        project_id: urlQualificationJob.project_id,
        run_id: urlQualificationJob.run_id,
        stage: JOB_TYPES.PAGE_SCRAPING,
        total_urls: totalUrls,
        chunk_size: chunkSize,
        total_chunks: totalChunks,
        status: 'processing'
      });
    } catch (createError) {
      if (createError.code === 11000) {
        console.log(`[CHUNK:${requestId}] PAGE_SCRAPING JobGroup already exists for this run (race-safe skip) | project_id=${urlQualificationJob.project_id}`);
        return;
      }
      throw createError;
    }

    console.log(`[CHUNK:${requestId}] Created PAGE_SCRAPING JobGroup | groupId=${group._id} | totalUrls=${totalUrls} | totalChunks=${totalChunks} | chunkSize=${chunkSize}`);

    const usePullModel = process.env.USE_PULL_MODEL === 'true';
    const jobDispatcher = new JobDispatcher();

    for (let i = 0; i < totalChunks; i++) {
      const chunkUrls = canonicalUrls.slice(i * chunkSize, (i + 1) * chunkSize);

      const chunkJob = await jobService.createJob({
        user_id: urlQualificationJob.user_id,
        seo_project_id: urlQualificationJob.project_id,
        jobType: JOB_TYPES.PAGE_SCRAPING,
        input_data: {
          source_job_id: urlQualificationJob._id.toString(),
          canonical_urls: chunkUrls
        },
        priority: JOB_TYPE_CONFIG[JOB_TYPES.PAGE_SCRAPING].priority,
        run_id: urlQualificationJob.run_id,
        group_id: group._id,
        chunk_index: i
      });

      if (!usePullModel) {
        try {
          const dispatchedJob = await jobService.atomicallyDispatchJob(chunkJob._id);
          if (dispatchedJob) {
            await jobDispatcher.dispatchPageScrapingJob(dispatchedJob);
          }
        } catch (dispatchError) {
          console.error(`[CHUNK:${requestId}] Chunk dispatch failed | jobId=${chunkJob._id} | chunkIndex=${i} | reason="${dispatchError.message}"`);
        }
      }
      // PULL mode: chunk job already created with status 'pending' — Python's
      // poller claims it directly, exactly like the single-job PAGE_SCRAPING
      // PULL-mode path. No explicit dispatch call needed.
    }

    console.log(`[CHUNK:${requestId}] All ${totalChunks} PAGE_SCRAPING chunks created${usePullModel ? '' : ' and dispatched'} | groupId=${group._id}`);
  }

  /**
   * URL-level PAGE_SCRAPING retry. Called every time a PAGE_SCRAPING
   * JobGroup would otherwise be considered finalized (from process(), and
   * from jobController.failJob for a chunk that permanently fails). Reads
   * seo_page_failures directly (project_id+run_id+resolved!=true) — never
   * URL_SELECTION — to build the retry candidate list, chunks it the same
   * way the initial group was chunked, creates those chunk Jobs under the
   * SAME group_id/run_id (no new JobGroup — the unique {project_id,run_id,
   * stage} index wouldn't allow a second one anyway), and extends
   * total_chunks so recordChunkOutcome's existing atomic counters naturally
   * keep the group open until the retry chunks resolve too.
   *
   * @param {Object} finalizedGroup - the JobGroup recordChunkOutcome just
   *   finalized (its total_chunks/status here are about to be reverted if a
   *   retry round is created)
   * @param {Object} updatedJob - the chunk Job whose completion triggered
   *   this finalization (used only for user_id/source_job_id — identical
   *   across every sibling chunk in the group)
   * @param {string} requestId
   * @returns {boolean} true if retry chunks were created (caller must NOT
   *   fan out / check the dependency gate yet), false if there was nothing
   *   to retry or the retry budget is exhausted (caller proceeds exactly as
   *   before this feature existed).
   */
  async _maybeCreatePageScrapingRetryChunks(finalizedGroup, updatedJob, requestId) {
    const retryRoundsUsed = finalizedGroup.retry_rounds_used || 0;
    if (retryRoundsUsed >= PAGE_SCRAPING_MAX_RETRY_ROUNDS) {
      return false;
    }

    const db = mongoose.connection.db;
    const unresolvedDocs = await db.collection('seo_page_failures')
      .find(
        { project_id: finalizedGroup.project_id, run_id: finalizedGroup.run_id, resolved: { $ne: true } },
        { projection: { url: 1, _id: 0 } }
      )
      .toArray();

    if (unresolvedDocs.length === 0) {
      return false;
    }

    // Defensive de-dupe — one failure doc per URL by construction, but never
    // trust that blindly when building a retry input list.
    const failedUrls = [...new Set(unresolvedDocs.map(d => d.url))];
    const nextRetryRound = retryRoundsUsed + 1;
    const chunkSize = PAGE_SCRAPING_CHUNK_SIZE;
    const newChunkCount = Math.ceil(failedUrls.length / chunkSize);

    const JobGroup = mongoose.model('JobGroup');
    // Revert the just-set terminal status and reserve the new chunk slots in
    // one atomic update, BEFORE any retry Job document exists — closes the
    // race window where another reader could see total_chunks/status still
    // reflecting "finalized" while retry chunks are mid-creation.
    const reverted = await JobGroup.findOneAndUpdate(
      { _id: finalizedGroup._id },
      {
        $inc: { total_chunks: newChunkCount },
        $set: { status: 'processing', retry_rounds_used: nextRetryRound }
      },
      { new: true }
    );

    console.log(`[RETRY:${requestId}] PAGE_SCRAPING retry round ${nextRetryRound}/${PAGE_SCRAPING_MAX_RETRY_ROUNDS} | unresolvedUrls=${failedUrls.length} | newChunks=${newChunkCount} | groupId=${finalizedGroup._id}`);

    const usePullModel = process.env.USE_PULL_MODEL === 'true';
    const jobDispatcher = new JobDispatcher();
    const startingChunkIndex = reverted.total_chunks - newChunkCount;

    for (let i = 0; i < newChunkCount; i++) {
      const chunkUrls = failedUrls.slice(i * chunkSize, (i + 1) * chunkSize);

      const chunkJob = await jobService.createJob({
        user_id: updatedJob.user_id,
        seo_project_id: finalizedGroup.project_id,
        jobType: JOB_TYPES.PAGE_SCRAPING,
        input_data: {
          source_job_id: updatedJob.input_data?.source_job_id,
          canonical_urls: chunkUrls,
          is_retry: true,
          retry_round: nextRetryRound
        },
        priority: JOB_TYPE_CONFIG[JOB_TYPES.PAGE_SCRAPING].priority,
        run_id: finalizedGroup.run_id,
        group_id: finalizedGroup._id,
        chunk_index: startingChunkIndex + i
      });

      if (!usePullModel) {
        try {
          const dispatchedJob = await jobService.atomicallyDispatchJob(chunkJob._id);
          if (dispatchedJob) {
            await jobDispatcher.dispatchPageScrapingJob(dispatchedJob);
          }
        } catch (dispatchError) {
          console.error(`[RETRY:${requestId}] Retry chunk dispatch failed | jobId=${chunkJob._id} | reason="${dispatchError.message}"`);
        }
      }
      // PULL mode: chunk job already created with status 'pending' — same
      // as every other PAGE_SCRAPING chunk, Python's poller claims it
      // directly with no distinction from an initial chunk.
    }

    console.log(`[RETRY:${requestId}] Retrying ${failedUrls.length} failed URL(s) across ${newChunkCount} chunk(s) (round ${nextRetryRound}) | groupId=${finalizedGroup._id}`);
    return true;
  }

  /**
   * Create a HEADLESS_ACCESSIBILITY JobGroup and its chunk jobs from a
   * completed URL_QUALIFICATION job, then dispatch each chunk (PUSH mode) or
   * leave them pending for the Python poller (PULL mode) — same pattern as
   * _createPageScrapingChunkGroup, with HEADLESS_ACCESSIBILITY's own stage,
   * chunk size, input_data shape, and dispatcher method.
   *
   * Idempotent via the same unique (project_id, run_id, stage) index —
   * `stage` differing from PAGE_SCRAPING's group means the two coexist
   * without conflicting.
   *
   * @param {Object} urlQualificationJob - The completed URL_QUALIFICATION job.
   * @param {string} requestId
   */
  async _createHeadlessAccessibilityChunkGroup(urlQualificationJob, requestId) {
    const JobGroup = mongoose.model('JobGroup');

    const canonicalUrls = urlQualificationJob._canonicalUrls
      || urlQualificationJob.input_data?.canonical_urls
      || [];
    const totalUrls = canonicalUrls.length;
    const chunkSize = HEADLESS_ACCESSIBILITY_CHUNK_SIZE;
    const totalChunks = Math.max(1, Math.ceil(totalUrls / chunkSize) || 1);

    let group;
    try {
      group = await JobGroup.create({
        project_id: urlQualificationJob.project_id,
        run_id: urlQualificationJob.run_id,
        stage: JOB_TYPES.HEADLESS_ACCESSIBILITY,
        total_urls: totalUrls,
        chunk_size: chunkSize,
        total_chunks: totalChunks,
        status: 'processing'
      });
    } catch (createError) {
      if (createError.code === 11000) {
        console.log(`[CHUNK:${requestId}] HEADLESS_ACCESSIBILITY JobGroup already exists for this run (race-safe skip) | project_id=${urlQualificationJob.project_id}`);
        return;
      }
      throw createError;
    }

    console.log(`[CHUNK:${requestId}] Created HEADLESS_ACCESSIBILITY JobGroup | groupId=${group._id} | totalUrls=${totalUrls} | totalChunks=${totalChunks} | chunkSize=${chunkSize}`);

    const usePullModel = process.env.USE_PULL_MODEL === 'true';
    const jobDispatcher = new JobDispatcher();

    for (let i = 0; i < totalChunks; i++) {
      const chunkUrls = canonicalUrls.slice(i * chunkSize, (i + 1) * chunkSize);

      const chunkJob = await jobService.createJob({
        user_id: urlQualificationJob.user_id,
        seo_project_id: urlQualificationJob.project_id,
        jobType: JOB_TYPES.HEADLESS_ACCESSIBILITY,
        input_data: {
          source_job_id: urlQualificationJob._id.toString(),
          projectId: urlQualificationJob.project_id.toString(),
          canonical_urls: chunkUrls
        },
        priority: JOB_TYPE_CONFIG[JOB_TYPES.HEADLESS_ACCESSIBILITY].priority,
        run_id: urlQualificationJob.run_id,
        group_id: group._id,
        chunk_index: i
      });

      if (!usePullModel) {
        try {
          const dispatchedJob = await jobService.atomicallyDispatchJob(chunkJob._id);
          if (dispatchedJob) {
            await jobDispatcher.dispatchHeadlessAccessibilityJob(dispatchedJob);
          }
        } catch (dispatchError) {
          console.error(`[CHUNK:${requestId}] Chunk dispatch failed | jobId=${chunkJob._id} | chunkIndex=${i} | reason="${dispatchError.message}"`);
        }
      }
      // PULL mode: chunk job already created with status 'pending' — Python's
      // poller claims it directly, exactly like the single-job
      // HEADLESS_ACCESSIBILITY PULL-mode path. No explicit dispatch call needed.
    }

    console.log(`[CHUNK:${requestId}] All ${totalChunks} HEADLESS_ACCESSIBILITY chunks created${usePullModel ? '' : ' and dispatched'} | groupId=${group._id}`);
  }

  // ---------------------------------------------------------------------------
  // Dependency gate: PAGE_ANALYSIS is created only when both
  // PERFORMANCE_DESKTOP (completed) and HEADLESS_ACCESSIBILITY (completed|failed)
  // are resolved for the same project.
  // ---------------------------------------------------------------------------

  /**
   * Check whether both parallel branches are resolved and, if so,
   * atomically create PAGE_ANALYSIS.
   *
   * Race safety: even if both jobs complete on overlapping event-loop ticks,
   * _createNextJobAtomically performs a findOne guard that prevents duplicate
   * PAGE_ANALYSIS creation. The subsequent atomicallyDispatchJob provides a
   * second layer of protection at the dispatch level.
   *
   * Public (no underscore prefix): also called directly from
   * jobController.js::failJob when a chunked HEADLESS_ACCESSIBILITY group's
   * last outstanding chunk resolves via failure — process() is never invoked
   * on the failure path, so failJob must be able to trigger this gate itself
   * to avoid PAGE_ANALYSIS waiting forever on a group that will never
   * otherwise re-check.
   */
  async checkDependencyGate(completedJob, requestId) {
    const Job = mongoose.model('Job');
    const projectId = completedJob.project_id;

    console.log(`[GATE:${requestId}] Checking dependency gate | projectId=${projectId} | trigger=${completedJob.jobType}`);

    try {
      // 1. PAGE_ANALYSIS must not already exist for this run. Scoped by run_id
      // (in addition to project_id) so a stray PAGE_ANALYSIS left over from a
      // superseded run (e.g. incomplete resetProjectCrawlData cleanup) can't be
      // mistaken for "already exists" and silently block the current run's gate.
      const existingAnalysis = await Job.findOne({
        project_id: projectId,
        run_id: completedJob.run_id,
        jobType: JOB_TYPES.PAGE_ANALYSIS
      });

      if (existingAnalysis) {
        console.log(`[GATE:${requestId}] PAGE_ANALYSIS already exists | jobId=${existingAnalysis._id} | status=${existingAnalysis.status}`);
        return;
      }

      // 2. Determine run mode by inspecting the PAGE_SCRAPING job's input_data.mode.
      //
      //    Verification mode: startVerification() creates PAGE_SCRAPING with
      //      input_data.mode = 'verification' (legacy, project-wide) or
      //      'url_verification' (P1-001, single-URL Verification Engine —
      //      recognized here as of P1-003). Both PAGE_SCRAPING and HEADLESS
      //      are dispatched simultaneously, so either can complete first.
      //      The gate must require BOTH to resolve before opening.
      //
      //    Full audit mode: PERFORMANCE_DESKTOP is created downstream of CRAWL_GRAPH
      //      and is the definitive gate signal. HEADLESS runs in parallel from
      //      URL_QUALIFICATION. Gate opens only when PERF_DESKTOP is done.
      //
      //    P1-003: widened from a single '=== verification' comparison to
      //      recognize 'url_verification' too — both take the identical
      //      lightweight gate below. This is the fix for the risk flagged
      //      during validation: without this widening, a real
      //      'url_verification' PAGE_SCRAPING completion would fall into the
      //      full-audit branch below and wait forever for a
      //      PERFORMANCE_DESKTOP job that a verification run never creates,
      //      silently hanging PAGE_ANALYSIS/SEO_SCORING forever. Any other
      //      mode value (including undefined/missing, i.e. Full Audit) is
      //      unaffected — .includes() only matches these two literal
      //      strings, exactly mirroring P1-002's widening of the sibling
      //      CRAWL_GRAPH-exclusion check earlier in this file.
      const pageScrapingJob = await Job.findOne({
        project_id: projectId,
        run_id: completedJob.run_id,
        jobType: JOB_TYPES.PAGE_SCRAPING
      });

      const isVerificationMode = ['verification', 'url_verification'].includes(pageScrapingJob?.input_data?.mode);
      console.log(`[GATE:${requestId}] Mode detected: ${isVerificationMode ? 'verification' : 'full-audit'}`);

      if (isVerificationMode) {
        // ── Verification gate: PAGE_SCRAPING (completed) + HEADLESS (completed|failed) ──
        // Identical gate condition for both 'verification' and
        // 'url_verification' — a single-URL run resolves this exactly the
        // same way a project-wide run does, just with a narrower URL set.

        // PAGE_SCRAPING must be completed
        if (!pageScrapingJob || pageScrapingJob.status !== 'completed') {
          console.log(`[GATE:${requestId}] PAGE_SCRAPING not yet completed — gate remains closed (verification mode)`);
          return;
        }

        // HEADLESS_ACCESSIBILITY must be completed or failed
        const headlessA11y = await Job.findOne({
          project_id: projectId,
          run_id: completedJob.run_id,
          jobType: JOB_TYPES.HEADLESS_ACCESSIBILITY,
          status: { $in: ['completed', 'failed'] }
        });

        if (!headlessA11y) {
          console.log(`[GATE:${requestId}] HEADLESS_ACCESSIBILITY not yet resolved — gate remains closed (verification mode)`);
          return;
        }

      } else {
        // ── Full audit gate: PERFORMANCE_DESKTOP (completed) + HEADLESS (completed|failed) ──

        const perfDesktop = await Job.findOne({
          project_id: projectId,
          run_id: completedJob.run_id,
          jobType: JOB_TYPES.PERFORMANCE_DESKTOP
        });

        if (!perfDesktop) {
          // PERFORMANCE_DESKTOP not yet created (CRAWL_GRAPH still running) — keep gate closed
          console.log(`[GATE:${requestId}] PERFORMANCE_DESKTOP not yet created — gate remains closed (full audit)`);
          return;
        }

        if (perfDesktop.status !== 'completed') {
          console.log(`[GATE:${requestId}] PERFORMANCE_DESKTOP not yet completed — gate remains closed (full audit)`);
          return;
        }

        // HEADLESS_ACCESSIBILITY is chunked for full audits (Phase D) — check
        // the owning JobGroup's resolution instead of a single Job's status.
        // "Resolved" means completed, partial, or failed, matching the
        // single-job $in:['completed','failed'] semantics this replaces:
        // total failure still counts as resolved, so PAGE_ANALYSIS is never
        // blocked waiting on accessibility data that will never arrive.
        const JobGroup = mongoose.model('JobGroup');
        const headlessGroup = await JobGroup.findOne({
          project_id: projectId,
          run_id: completedJob.run_id,
          stage: JOB_TYPES.HEADLESS_ACCESSIBILITY
        });

        const headlessResolved = !!headlessGroup
          && ['completed', 'partial', 'failed'].includes(headlessGroup.status);

        if (!headlessResolved) {
          console.log(`[GATE:${requestId}] HEADLESS_ACCESSIBILITY group not yet resolved — gate remains closed (full audit)`);
          return;
        }
      }

      // 3. All conditions met — create PAGE_ANALYSIS atomically
      console.log(`[GATE:${requestId}] All dependencies resolved — opening gate for PAGE_ANALYSIS`);

      // Reload PAGE_SCRAPING as completed source (already fetched above for verification;
      // for full audit mode, re-query with status filter to be safe). With
      // PAGE_SCRAPING chunked, this may match any one of several completed
      // chunks sharing this run_id — safe because createAndDispatchPageAnalysisJob
      // only reads user_id/project_id/run_id from it, all identical across chunks.
      const completedPageScraping = await Job.findOne({
        project_id: projectId,
        run_id: completedJob.run_id,
        jobType: JOB_TYPES.PAGE_SCRAPING,
        status: 'completed'
      });

      if (!completedPageScraping) {
        console.error(`[GATE:${requestId}] Cannot find completed PAGE_SCRAPING job for project ${projectId}`);
        return;
      }

      await this._createAndDispatchJob(
        JOB_TYPES.PAGE_ANALYSIS,
        completedJob,
        completedPageScraping,
        JOB_TYPES.PAGE_SCRAPING,
        { atomicGuard: true },
        requestId,
        false
      );

      console.log(`[GATE:${requestId}] PAGE_ANALYSIS gate processed successfully`);

    } catch (error) {
      console.error(`[GATE_ERROR:${requestId}] Dependency gate failed | reason="${error.message}"`);
      // Do NOT re-throw — gate failures should not crash the completion handler
    }
  }

  // ---------------------------------------------------------------------------
  // Core: create + dispatch a single next job with full guard/fallback logic
  // ---------------------------------------------------------------------------

  /**
   * Create and dispatch a single next job.
   * Handles atomic guard, dispatch, stageChanged emission, afterDispatch,
   * and fallback on failure.
   *
   * @param {string}  nextJobType  - Job type to create
   * @param {Object}  updatedJob   - The completed job (for event IDs)
   * @param {Object}  sourceJob    - The job used for creation (may be resolved)
   * @param {string}  stageFrom    - "from" field for stageChanged events
   * @param {Object}  stageConfig  - Pipeline config for the completed stage
   * @param {string}  requestId    - Request trace ID
   * @param {boolean} isFallback   - Whether this is a fallback path
   */
  async _createAndDispatchJob(nextJobType, updatedJob, sourceJob, stageFrom, stageConfig, requestId, isFallback) {
    const logPrefix = isFallback ? 'FALLBACK' : 'CHAINING';

    const useAtomicGuard = isFallback
      ? (stageConfig.atomicGuard !== false)               // fallback inherits parent's guard setting
      : (stageConfig.atomicGuard !== false);               // default: true

    try {
      // 1. Create job
      let nextJob;

      if (useAtomicGuard) {
        nextJob = await this._createNextJobAtomically(sourceJob, nextJobType, requestId);
      } else {
        nextJob = await this._createJobDirect(sourceJob, nextJobType, requestId);
      }

      if (!nextJob) {
        return;
      }

      // F4-016: PROJECT_TASK_VERIFICATION is Node-self-processed — no
      // Python worker ever claims this job type (it isn't in
      // createJobDispatchMap and isn't polled by main.py). Bypass both the
      // PULL "leave pending" branch and the PUSH "_dispatchToWorker" branch
      // below entirely; chainingEngine runs the verification logic itself
      // and completes the job in-process.
      if (nextJobType === JOB_TYPES.PROJECT_TASK_VERIFICATION) {
        await this._runProjectTaskVerificationJob(nextJob, requestId);
        return;
      }

      // 2. In PULL model: job remains pending, worker will claim it
      //    In PUSH model: atomically mark as dispatched and send to worker
      const usePullModel = process.env.USE_PULL_MODEL === 'true';
      
      if (usePullModel) {
        auditProgressService.emitStageChanged(updatedJob._id.toString(), {
          from: stageFrom,
          to: nextJobType,
          newJobId: nextJob._id.toString(),
          projectId: updatedJob.project_id?.toString()
        });
      } else {
        const dispatchedJob = await jobService.atomicallyDispatchJob(nextJob._id);

        if (dispatchedJob) {
          auditProgressService.emitStageChanged(updatedJob._id.toString(), {
            from: stageFrom,
            to: nextJobType,
            newJobId: nextJob._id.toString(),
            projectId: updatedJob.project_id?.toString()
          });

          await this._dispatchToWorker(nextJobType, dispatchedJob);
          console.log(`[${logPrefix}:${requestId}] ${nextJobType} dispatched | jobId=${dispatchedJob._id}`);

          const afterJobs = stageConfig.afterDispatch?.[nextJobType];
          if (afterJobs) {
            for (const afterType of afterJobs) {
              await this._createAndDispatchJob(
                afterType, updatedJob, sourceJob, stageFrom,
                { atomicGuard: false }, requestId, false
              );
            }
          }
        } else {
          console.log(`[${logPrefix}:${requestId}] ${nextJobType} already dispatched | jobId=${nextJob._id}`);
        }
      }

    } catch (error) {
      console.error(`[CHAINING_ERROR:${requestId}] ${nextJobType} creation failed | reason="${error.message}"`);
      console.error(`[CHAINING_ERROR:${requestId}] Full error:`, error);

      // Fallback: try alternative jobs if configured
      const fallbackTargets = stageConfig.fallback?.[nextJobType] || stageConfig.creationFallback?.[nextJobType];
      if (fallbackTargets) {
        for (const fallbackType of fallbackTargets) {
          try {
            await this._createAndDispatchJob(
              fallbackType, updatedJob, sourceJob, stageFrom,
              { atomicGuard: stageConfig.atomicGuard !== false }, requestId, true
            );
          } catch (fallbackError) {
            console.error(`[CHAINING_ERROR:${requestId}] Fallback ${fallbackType} also failed | reason="${fallbackError.message}"`);
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Job creation strategies
  // ---------------------------------------------------------------------------

  /**
   * Atomic guard: check for existing job before creating.
   * Prevents duplicate next-job creation in concurrent scenarios.
   */
  async _createNextJobAtomically(sourceJob, nextJobType, requestId) {
    const Job = mongoose.model('Job');

    // Check if next job already exists for this source job
    const existingNextJob = await Job.findOne({
      'input_data.source_job_id': sourceJob._id.toString(),
      jobType: nextJobType,
      status: { $in: ['pending', 'processing', 'retrying'] }
    });

    if (existingNextJob) {
      console.log(`[GUARD:${requestId}] Next job already exists | jobId=${existingNextJob._id} | status=${existingNextJob.status}`);
      return existingNextJob;
    }

    return await this._createJobDirect(sourceJob, nextJobType, requestId);
  }

  /**
   * Direct creation without duplicate check.
   * Uses JOB_CREATION_MAP to call the correct jobService method.
   */
  async _createJobDirect(sourceJob, jobType, requestId) {
    const createFn = JOB_CREATION_MAP[jobType];

    if (!createFn) {
      console.error(`[CHAINING:${requestId}] Unsupported next job type: ${jobType}`);
      throw new Error(`Unsupported next job type: ${jobType}`);
    }

    return await createFn(sourceJob);
  }

  // ---------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------

  /**
   * Dispatch a created job to the correct worker.
   * Uses JOB_DISPATCH_MAP to call the correct dispatcher method.
   */
  async _dispatchToWorker(jobType, job) {
    const dispatchFn = createJobDispatchMap()[jobType];
    if (!dispatchFn) {
      throw new Error(`No dispatcher for job type: ${jobType}`);
    }
    return await dispatchFn(job);
  }


  // ---------------------------------------------------------------------------
  // Hooks
  // ---------------------------------------------------------------------------

  /**
   * Emit audit completion event (PAGE_ANALYSIS hook).
   * Called before SEO_SCORING chaining.
   */
  /**
   * Atomically flips SeoProject.crawl_status to 'completed' — the single
   * canonical, persisted signal for "the entire audit has finished" that the
   * frontend now polls directly (see ProcessingScreen.jsx). Also computes
   * audit_duration_ms here, at the true completion moment, instead of at
   * PAGE_ANALYSIS time (which could be well before SEO_SCORING/AI_VISIBILITY
   * finish).
   *
   * The conditional `crawl_status: { $ne: 'completed' }` filter makes this
   * the same kind of atomic, race-safe transition already used by
   * completeJobSafely for job documents: only the request whose update
   * actually matches a document proceeds to return true. If SEO_SCORING and
   * AI_VISIBILITY both resolve the pipeline at nearly the same instant (two
   * concurrent calls into chainingEngine.process), only one of them can win
   * this write — the caller uses the return value to ensure the
   * audit:completed websocket event fires exactly once, never twice.
   *
   * @param {Object} updatedJob - The just-completed terminal job document
   * @param {string} requestId
   * @returns {boolean} true if THIS call performed the finalizing transition
   */
  async _finalizeAuditCompletion(updatedJob, requestId) {
    const completedAt = new Date();
    const project = await SeoProject.findById(updatedJob.project_id).select('audit_started_at').lean();
    const auditDurationMs = project?.audit_started_at
      ? Math.max(0, completedAt.getTime() - new Date(project.audit_started_at).getTime())
      : 0;

    const finalized = await SeoProject.findOneAndUpdate(
      { _id: updatedJob.project_id, crawl_status: { $ne: 'completed' } },
      { $set: { crawl_status: 'completed', audit_duration_ms: auditDurationMs } },
      { new: true }
    );

    if (!finalized) {
      return false;
    }

    console.log(`[CHAINING:${requestId}] Audit fully complete — crawl_status='completed' | projectId=${updatedJob.project_id} | audit_duration_ms=${auditDurationMs}`);
    return true;
  }

  /**
   * Verification Batch barrier (F4-015). Determines whether every
   * PageVerificationRun belonging to finalizedRun.batchId has reached a
   * terminal state (completed/failed — pending/running are ignored) and,
   * if so, atomically transitions the batch from RUNNING to AGGREGATING.
   *
   * Called only from the existing per-page url_verification finalization
   * branch above, only when finalizedRun.batchId is non-null — never a new
   * cron/poll/watchdog, and never for a single-URL (non-batched) run.
   *
   * The atomic `status: BATCH_STATUS.RUNNING` filter is the same
   * conditional-write pattern _finalizeAuditCompletion above already uses
   * for full-audit completion: only the caller whose update actually
   * matches (batch still RUNNING at that instant) performs the transition.
   * Every other concurrent caller's filter fails to match (status already
   * AGGREGATING) and returns null — a silent no-op, never a duplicate
   * transition, never a second log line.
   *
   * F4-016: on winning the transition, also enqueues PROJECT_SEO_AGGREGATION
   * — the first job in the project-level aggregation chain
   * (PROJECT_SEO_AGGREGATION -> PROJECT_AI_AGGREGATION ->
   * PROJECT_TASK_VERIFICATION, see pipelineConfig.js) — via
   * _enqueueProjectAggregationChain. Reuses the queue exactly like every
   * other job creation in this file; no aggregation logic runs inline here.
   *
   * @param {Object} finalizedRun - the just-finalized PageVerificationRun
   * @param {string} requestId
   * @returns {Promise<boolean>} true only if THIS call performed the
   *   RUNNING -> AGGREGATING transition (mirrors _finalizeAuditCompletion's
   *   own return-value convention above).
   */
  async _checkVerificationBatchBarrier(finalizedRun, requestId) {
    const batchId = finalizedRun.batchId;

    const totalUrls = await PageVerificationRun.countDocuments({ batchId });
    const terminalUrls = await PageVerificationRun.countDocuments({
      batchId,
      status: { $in: ['completed', 'failed'] },
    });

    if (terminalUrls < totalUrls) {
      console.log(`[CHAINING:${requestId}] Verification batch not yet complete | batchId=${batchId} | terminal=${terminalUrls}/${totalUrls}`);
      return false;
    }

    const completedUrls = await PageVerificationRun.countDocuments({ batchId, status: 'completed' });
    const failedUrls = terminalUrls - completedUrls;

    const won = await VerificationBatch.findOneAndUpdate(
      { batchId, status: BATCH_STATUS.RUNNING },
      { $set: { status: BATCH_STATUS.AGGREGATING, aggregateStartedAt: new Date() } },
      { new: true }
    );

    if (won) {
      console.log(`[VERIFICATION_BATCH] enteredAggregation | batchId=${batchId} | completedUrls=${completedUrls} | failedUrls=${failedUrls} | totalUrls=${totalUrls}`);

      try {
        await this._enqueueProjectAggregationChain(won, requestId);
      } catch (enqueueError) {
        console.error(`[CHAINING_ERROR:${requestId}] Failed to enqueue project aggregation chain | batchId=${batchId} | reason="${enqueueError.message}"`);
      }

      return true;
    }
    // won === null: another concurrent completion already made this exact
    // transition — correct, silent no-op, no log (§6: "no repeated logs
    // from losing threads").
    return false;
  }

  /**
   * F4-016: create + dispatch the FIRST job in the project-level aggregation
   * chain (PROJECT_SEO_AGGREGATION). Unlike every other job creation in this
   * file, there is no "source job" completing here — this is called
   * directly from the batch barrier above, not from process()'s normal
   * per-job completion flow. Exactly-once is guaranteed entirely by the
   * barrier's own atomic RUNNING -> AGGREGATING transition (only the winning
   * caller ever reaches this method for a given batch) — no separate guard
   * is needed here.
   *
   * @param {Object} batch - the just-transitioned VerificationBatch document
   * @param {string} requestId
   */
  async _enqueueProjectAggregationChain(batch, requestId) {
    // F4-018: idempotency guard. The barrier's own atomic RUNNING ->
    // AGGREGATING transition already guarantees this is called at most once
    // in the normal flow — this check exists so the batch-recovery sweep
    // (verificationBatchRecoveryService.js) can ALSO safely call this method
    // again for any batch it finds stuck in AGGREGATING (e.g. Node crashed
    // between the barrier's DB write and this method actually creating the
    // first job) without ever creating a second PROJECT_SEO_AGGREGATION for
    // the same batch.
    const Job = mongoose.model('Job');
    const existing = await Job.findOne({
      jobType: JOB_TYPES.PROJECT_SEO_AGGREGATION,
      'input_data.batchId': batch.batchId,
    });
    if (existing) {
      console.log(`[RECOVERY] duplicate_recovery_avoided | batchId=${batch.batchId} | existingJobId=${existing._id}`);
      return existing;
    }

    const nextJob = await jobService.createAndDispatchProjectSeoAggregationJob({
      projectId: batch.projectId,
      batchId: batch.batchId,
      userId: batch.createdBy
    });

    const usePullModel = process.env.USE_PULL_MODEL === 'true';
    if (!usePullModel) {
      const dispatchedJob = await jobService.atomicallyDispatchJob(nextJob._id);
      if (dispatchedJob) {
        await this._dispatchToWorker(JOB_TYPES.PROJECT_SEO_AGGREGATION, dispatchedJob);
      }
    }
    // PULL mode: job already created with status 'pending' — main.py's
    // poller claims it directly, same as every other PULL-mode job type.

    console.log(`[VERIFICATION_BATCH] Project aggregation chain enqueued | batchId=${batch.batchId} | firstJobId=${nextJob._id}`);
    return nextJob;
  }

  /**
   * F4-016: Node-internal execution of PROJECT_TASK_VERIFICATION. No Python
   * worker ever claims this job type (it is absent from both
   * createJobDispatchMap and main.py's polling list) — chainingEngine acts
   * as its own "worker" so the job document stays fully observable/
   * retryable (status/attempts/max_attempts), exactly like every other job
   * type, just executed in-process instead of over HTTP/polling.
   *
   * Success: marks the job completed, then re-enters process() so
   * PIPELINE_CONFIG's 'batchCompleted' hook for this job type runs exactly
   * as it would for any other terminal job.
   *
   * Failure: reuses the EXISTING jobService.failJob retry/backoff mechanism
   * (the same getRetryBackoffMs schedule every Python-polled job type
   * already uses). F4-018: a 'retrying' outcome is now PERSISTED ONLY — no
   * in-process setTimeout is scheduled (the previous design lost any
   * pending retry entirely on a Node restart/deploy, permanently stranding
   * the batch in AGGREGATING). Retries are instead reclaimed by
   * verificationBatchRecoveryService's scheduled sweep, using the exact
   * same claim semantics (status 'retrying' + elapsed last_attempted_at)
   * jobService.claimJob() uses for every Python-polled job type — this
   * method has no memory of its own; every invocation, first attempt or
   * retry alike, is triggered by something reading Job state fresh from
   * Mongo. Only once attempts are exhausted (failJob returns status
   * 'failed') does this re-enter process() — batch completion must still
   * run even if task verification itself never succeeds, since
   * COMPLETED/PARTIAL/FAILED is determined from the batch's own per-URL
   * counts (_finalizeVerificationBatch), not from this job's own outcome.
   */
  async _runProjectTaskVerificationJob(job, requestId) {
    try {
      // claimed_at is what cleanupStaleLocks' existing 'processing' sweep
      // keys on (Job.find({status:'processing', claimed_at:{$lt:staleTime}})
      // — jobService.js). Without it, a Node crash between this line and the
      // 'completed' write below leaves the job stuck at 'processing' forever
      // with no recovery sweep able to see it (recoverOrphanedUrlVerification
      // Jobs only matches 'pending'; this job already left that state).
      // Confirmed via code trace during Phase 3 hardening — not a
      // hypothetical. Setting it here is enough to bring this job type under
      // the SAME existing recovery mechanism every other 'processing' job
      // already relies on, no new sweep needed.
      await jobService.updateJobStatus(job._id, 'processing', {
        started_at: new Date(),
        last_attempted_at: new Date(),
        claimed_at: new Date(),
      });

      const verifyResult = await taskVerificationService.verifyImplementedTasks(job.project_id, requestId, job._id);

      const completedJob = await jobService.updateJobStatus(job._id, 'completed', {
        result_data: { verified: verifyResult.verified, reopened: verifyResult.reopened }
      });

      console.log(`[CHAINING:${requestId}] PROJECT_TASK_VERIFICATION complete | jobId=${job._id} | verified=${verifyResult.verified} | reopened=${verifyResult.reopened}`);

      await this.process(completedJob, verifyResult, requestId);

    } catch (error) {
      console.error(`[CHAINING_ERROR:${requestId}] PROJECT_TASK_VERIFICATION failed | jobId=${job._id} | reason="${error.message}"`);

      let failedJob;
      try {
        failedJob = await jobService.failJob(job._id, error);
      } catch (failError) {
        console.error(`[CHAINING_ERROR:${requestId}] PROJECT_TASK_VERIFICATION failJob bookkeeping failed | jobId=${job._id} | reason="${failError.message}"`);
        return;
      }

      if (failedJob.status === 'retrying') {
        console.log(`[RECOVERY] retry_persisted | jobType=PROJECT_TASK_VERIFICATION | jobId=${job._id} | attempts=${failedJob.attempts} | reclaimAfter=${failedJob.last_attempted_at.toISOString()}`);
      } else {
        console.error(`[CHAINING_ERROR:${requestId}] PROJECT_TASK_VERIFICATION permanently failed after ${failedJob.attempts} attempts | jobId=${job._id}`);
        await this.process(failedJob, {}, requestId);
      }
    }
  }

  /**
   * F4-016: Finalize a Verification Batch once its project-level
   * aggregation chain (PROJECT_SEO_AGGREGATION -> PROJECT_AI_AGGREGATION ->
   * PROJECT_TASK_VERIFICATION) has reached a terminal state. Determines
   * COMPLETED (every URL succeeded) / PARTIAL (mixed) / FAILED (every URL
   * failed) from PageVerificationRun's own per-page statuses — recomputed
   * here rather than trusted from the barrier's earlier count, matching
   * this file's own established "recompute, don't cache" pattern (see
   * auditHistoryService.allTerminalsResolved).
   *
   * Atomic AGGREGATING -> {COMPLETED|PARTIAL|FAILED} transition, the same
   * conditional-write pattern as _finalizeAuditCompletion/
   * _checkVerificationBatchBarrier above: only the caller whose update
   * actually matches (batch still AGGREGATING) performs the transition and
   * emits verification:batch-completed — a duplicate/retried completion of
   * PROJECT_TASK_VERIFICATION is a safe, silent no-op.
   *
   * @param {string} batchId
   * @param {string} requestId
   */
  async _finalizeVerificationBatch(batchId, requestId) {
    const totalUrls = await PageVerificationRun.countDocuments({ batchId });
    const completedUrls = await PageVerificationRun.countDocuments({ batchId, status: 'completed' });
    const failedUrls = await PageVerificationRun.countDocuments({ batchId, status: 'failed' });

    const finalStatus = failedUrls === 0
      ? BATCH_STATUS.COMPLETED
      : (completedUrls === 0 ? BATCH_STATUS.FAILED : BATCH_STATUS.PARTIAL);

    const won = await VerificationBatch.findOneAndUpdate(
      { batchId, status: BATCH_STATUS.AGGREGATING },
      {
        $set: {
          status: finalStatus,
          completedUrls,
          failedUrls,
          completedAt: new Date(),
          aggregateCompletedAt: new Date()
        }
      },
      { new: true }
    );

    if (!won) {
      console.log(`[VERIFICATION_BATCH] finalize skipped — already finalized by a concurrent completion | batchId=${batchId}`);
      return null;
    }

    console.log(`[VERIFICATION_BATCH] finalized | batchId=${batchId} | status=${finalStatus} | completedUrls=${completedUrls} | failedUrls=${failedUrls} | totalUrls=${totalUrls}`);

    try {
      auditProgressService.emitVerificationBatchCompleted({
        batchId,
        projectId: won.projectId.toString(),
        status: finalStatus,
        totalUrls,
        completedUrls,
        failedUrls
      });
    } catch (emitError) {
      console.error(`[CHAINING_ERROR:${requestId}] verification:batch-completed emit failed (non-fatal): ${emitError.message}`);
    }

    return won;
  }

  async _emitCompletionEvent(updatedJob, stats, requestId) {
    try {
      auditProgressService.emitCompleted(updatedJob.project_id, {
        projectId: updatedJob.project_id,
        jobId: updatedJob._id.toString(),
        stats: stats,
        summary: {
          pages_analyzed: stats?.pagesAnalyzed || stats?.totalPages || 0,
          issues_found: stats?.issuesFound || 0,
          crawl_status: 'completed'
        }
      });
      console.log(`[CHAINING:${requestId}] Completion event emitted | projectId=${updatedJob.project_id}`);
    } catch (emitError) {
      console.error(`[CHAINING_ERROR:${requestId}] Event emission failed | reason="${emitError.message}"`);
    }
  }
}

export default new ChainingEngine();
