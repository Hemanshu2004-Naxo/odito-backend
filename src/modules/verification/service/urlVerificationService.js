import mongoose from 'mongoose';

import SeoProject from '../../app_user/model/SeoProject.js';
import { JobService } from '../../jobs/service/jobService.js';
import JobDispatcher from '../../jobs/service/jobDispatcher.js';
import auditProgressService from '../../jobs/service/auditProgressService.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import PageVerificationRun from '../model/PageVerificationRun.js';
import VerificationBatch from '../model/VerificationBatch.js';
import { BATCH_STATUS } from '../constants/batchStatus.js';
import { collectPageMetricSnapshot } from './pageMetricSnapshot.js';
import { validateUrl, normalizeUrl } from '../../../services/websiteExtractionService.js';
import { isProjectWideAuditInProgress } from '../../app_user/service/projectAuditService.js';

const jobService = new JobService();

/**
 * Result codes returned by startUrlVerification / startVerificationBatch.
 * Mirrors the AUDIT_RESULT_CODES / startProjectAudit convention: never
 * throws for expected business outcomes, only for unexpected infra
 * failures. NO_VALID_URLS is F4-013 (batch) only — every URL in a batch
 * submission was rejected before any PageVerificationRun was created.
 */
export const URL_VERIFICATION_RESULT_CODES = {
  STARTED: 'STARTED',
  NOT_FOUND: 'NOT_FOUND',
  ACCESS_DENIED: 'ACCESS_DENIED',
  INVALID_URL: 'INVALID_URL',
  ALREADY_RUNNING: 'ALREADY_RUNNING',
  NO_VALID_URLS: 'NO_VALID_URLS',
};

// H1: comparison-only normalization. Builds on websiteExtractionService's
// own normalizeUrl() (real URL parsing — forces https, lowercases the
// hostname, strips the scheme's default port, strips a bare trailing
// slash) with one addition neither existing normalizer performs: stripping
// the fragment. Query strings are deliberately left untouched, matching
// normalizeUrl()'s own behavior — not inventing stricter normalization than
// what already exists.
function normalizeForComparison(url) {
  return normalizeUrl(url.split('#')[0]);
}

// H1: the URL must belong to the project's own site AND represent a page
// eligible for verification. Reuses the exact source of truth legacy
// startVerification() (scrapingController.js) already established for
// "pages that belong to this project" — seo_page_data, plus project.main_url
// itself (always allowed, even before any page has been discovered) — no
// new collection, no new field.
async function isEligibleProjectUrl(project, targetUrl) {
  const normalizedTarget = normalizeForComparison(targetUrl);

  if (normalizeForComparison(project.main_url) === normalizedTarget) {
    return true;
  }

  const db = mongoose.connection.db;
  const pageDataDocs = await db.collection('seo_page_data')
    .find({ projectId: project._id }, { projection: { url: 1 } })
    .toArray();

  return pageDataDocs.some((doc) => doc.url && normalizeForComparison(doc.url) === normalizedTarget);
}

// F4-013: shared by both startUrlVerification (single URL) and
// startVerificationBatch (many URLs) — extracted so the batch endpoint
// reuses the exact same project-resolution/ownership rules instead of a
// copy-pasted second implementation. Byte-identical to what
// startUrlVerification already did inline; behavior is unchanged, only the
// location moved.
async function loadAuthorizedProject(projectId, requestingUserId) {
  let project;
  try {
    project = await SeoProject.findById(projectId);
  } catch (err) {
    // Malformed projectId (CastError) is a not-found from the caller's
    // point of view, not an infra failure.
    return { authorized: false, code: URL_VERIFICATION_RESULT_CODES.NOT_FOUND, message: 'Project not found' };
  }

  if (!project || project.is_deleted) {
    return { authorized: false, code: URL_VERIFICATION_RESULT_CODES.NOT_FOUND, message: 'Project not found' };
  }

  if (requestingUserId && project.user_id.toString() !== requestingUserId.toString()) {
    return { authorized: false, code: URL_VERIFICATION_RESULT_CODES.ACCESS_DENIED, message: 'Access denied: You do not own this project' };
  }

  return { authorized: true, project };
}

// F4-013: shared per-URL validation (format/protocol/SSRF + same-origin/
// previously-discovered-page eligibility) — extracted from
// startUrlVerification's own inline checks, reused as-is by the batch path
// so a URL is judged eligible by exactly one piece of code either way.
async function validateTargetUrlForProject(project, targetUrl) {
  // H1: format + protocol + SSRF (localhost/private-IP/loopback/internal-host)
  // validation, reusing websiteExtractionService's existing validateUrl() —
  // a strict superset of the previous protocol-only check, not a parallel
  // validator.
  if (typeof targetUrl !== 'string' || !validateUrl(targetUrl).valid) {
    return { valid: false, code: URL_VERIFICATION_RESULT_CODES.INVALID_URL, message: `Invalid target URL: ${targetUrl}` };
  }

  // H1: domain/page-ownership check — must belong to THIS project, before
  // any PageVerificationRun or Job is created. Same INVALID_URL code and
  // generic message for foreign domains, undiscovered pages, and malformed
  // URLs alike — internal reasoning is never echoed back to the caller.
  if (!(await isEligibleProjectUrl(project, targetUrl))) {
    return { valid: false, code: URL_VERIFICATION_RESULT_CODES.INVALID_URL, message: `Invalid target URL: ${targetUrl}` };
  }

  return { valid: true };
}

// F4-014: shared PAGE_SCRAPING seed-job creation — extracted from
// startUrlVerification's own inline call so startVerificationBatch reuses
// the exact same job-creation code, not a copy. batchId is stamped into
// input_data only when provided (additive field; a single-URL call passes
// nothing, so its job payload is byte-identical to before this change).
// Throws a plain Error with `.isDuplicateVerification = true` for the
// existing P1-001 partial-unique-index race, so callers can distinguish it
// from an unexpected infra failure without inspecting error.code themselves.
async function createPageScrapingSeedJob(project, targetUrl, runId, batchId = null) {
  try {
    return await jobService.createJob({
      user_id: project.user_id,
      seo_project_id: project._id,
      jobType: 'PAGE_SCRAPING',
      input_data: {
        mode: 'url_verification',
        target_url: targetUrl,
        canonical_urls: [targetUrl],
        main_url: project.main_url,
        ...(batchId ? { batchId } : {}),
      },
      priority: 1,
      run_id: runId,
    });
  } catch (error) {
    // Duplicate protection: the partial unique index on
    // {project_id, jobType, input_data.target_url} (P1-001) rejects a
    // second pending/processing verification for the same page.
    if (error.code === 11000) {
      const duplicateError = new Error('A verification for this URL is already in progress');
      duplicateError.isDuplicateVerification = true;
      throw duplicateError;
    }
    throw error;
  }
}

// F4-014: shared HEADLESS_ACCESSIBILITY seed-job creation — same reasoning
// as createPageScrapingSeedJob above.
async function createHeadlessAccessibilitySeedJob(project, targetUrl, runId, pageScrapingJobId, batchId = null) {
  return jobService.createJob({
    user_id: project.user_id,
    seo_project_id: project._id,
    jobType: 'HEADLESS_ACCESSIBILITY',
    input_data: {
      mode: 'url_verification',
      target_url: targetUrl,
      canonical_urls: [targetUrl],
      main_url: project.main_url,
      source_job_id: pageScrapingJobId.toString(),
      ...(batchId ? { batchId } : {}),
    },
    priority: 1,
    run_id: runId,
  });
}

// F4-014: shared verification:started emission + fire-and-forget dispatch
// of both seed jobs — extracted from startUrlVerification's own inline
// code, reused as-is by the batch path. Per-run (per-URL), exactly as
// today — nothing about this changes for a batch member: it still gets its
// own verification:started event and its own dispatch calls, identical to
// a standalone single-URL verification.
function emitVerificationStartedAndDispatch({ runId, run, pageScrapingJob, headlessJob, projectId, targetUrl }) {
  const jobDispatcher = new JobDispatcher();

  // P3-006: verification:started, emitted to the project room — non-fatal,
  // never blocks job creation/dispatch if the socket layer is unavailable.
  try {
    auditProgressService.emitVerificationStarted({
      runId: runId.toString(),
      verificationRunId: run._id.toString(),
      projectId: projectId.toString(),
      pageUrl: targetUrl,
      currentJob: pageScrapingJob._id.toString(),
    });
  } catch (emitError) {
    LoggerUtil.error('Failed to emit verification:started (non-fatal)', emitError, { project_id: projectId, target_url: targetUrl });
  }

  // Dispatch both seed jobs asynchronously — mirrors startVerification()'s
  // fire-and-forget dispatch pattern.
  jobDispatcher.dispatchPageScrapingJob(pageScrapingJob).catch((error) => {
    LoggerUtil.error(`Failed to dispatch PAGE_SCRAPING verification job ${pageScrapingJob._id}`, error);
  });

  jobDispatcher.dispatchHeadlessAccessibilityJob(headlessJob).catch((error) => {
    LoggerUtil.error(`Failed to dispatch HEADLESS_ACCESSIBILITY verification job ${headlessJob._id}`, error);
  });
}

/**
 * Start a URL Verification run: creates the PageVerificationRun, the two
 * seed jobs (PAGE_SCRAPING + HEADLESS_ACCESSIBILITY, mode='url_verification'),
 * and dispatches them. Everything downstream (PAGE_ANALYSIS, SEO_SCORING,
 * AI_VISIBILITY) is created by the existing, unmodified chainingEngine —
 * this function never creates or dispatches those job types itself.
 *
 * Does NOT use the project-wide crawl_status claim startProjectAudit()/
 * startVerification() use — per the frozen locking design, url_verification
 * relies solely on the Job model's partial unique index
 * ({project_id, jobType, input_data.target_url}, P1-001) for per-URL
 * duplicate protection.
 *
 * Known limitation, not addressed here (see P3-003 output report): once
 * this run's SEO_SCORING/AI_VISIBILITY jobs complete, the existing,
 * unmodified chainingEngine completion hook will still write an audit_runs
 * snapshot and flip the project's crawl_status — a documented, frozen-plan-
 * acknowledged gap this task deliberately does not fix.
 *
 * @param {string} projectId
 * @param {string} targetUrl - the single URL to verify
 * @param {Object} [options]
 * @param {string|mongoose.Types.ObjectId} [options.requestingUserId] - must own the project
 * @returns {Promise<{success:boolean, code:string, message?:string, data?:object}>}
 */
export async function startUrlVerification(projectId, targetUrl, options = {}) {
  const { requestingUserId = null } = options;

  const authResult = await loadAuthorizedProject(projectId, requestingUserId);
  if (!authResult.authorized) {
    return { success: false, code: authResult.code, message: authResult.message };
  }
  const { project } = authResult;

  const urlResult = await validateTargetUrlForProject(project, targetUrl);
  if (!urlResult.valid) {
    return { success: false, code: urlResult.code, message: urlResult.message };
  }

  // H3: reject if a PROJECT-WIDE run (Full Audit or legacy verification) is
  // already using this project's shared collections (seo_page_data/
  // seo_page_issues/seo_page_scores/ai_scores) — reuses
  // isProjectWideAuditInProgress() (projectAuditService.js), which shares
  // ACTIVE_PIPELINE_JOB_TYPES with Full Audit's own guard but excludes other
  // url_verification-mode jobs, so concurrent verifications of different
  // pages on the same project (P3-003) remain allowed. Checked before any
  // PageVerificationRun or Job is created.
  if (await isProjectWideAuditInProgress(projectId)) {
    return {
      success: false,
      code: URL_VERIFICATION_RESULT_CODES.ALREADY_RUNNING,
      message: 'An audit or verification is already in progress for this project',
    };
  }

  const runId = new mongoose.Types.ObjectId();

  // Seed job 1: PAGE_SCRAPING. Created first (not via chainingEngine — this
  // is the entry point chainingEngine picks up from) so its real _id is
  // available for PageVerificationRun.jobId below.
  let pageScrapingJob;
  try {
    pageScrapingJob = await createPageScrapingSeedJob(project, targetUrl, runId);
  } catch (error) {
    if (error.isDuplicateVerification) {
      return {
        success: false,
        code: URL_VERIFICATION_RESULT_CODES.ALREADY_RUNNING,
        message: error.message,
      };
    }
    LoggerUtil.error('URL Verification: PAGE_SCRAPING creation failed', error, { project_id: projectId, target_url: targetUrl });
    throw error;
  }

  // BEFORE snapshot: captured now, before any job for this run executes.
  // seo_page_scores/ai_scores are upserted in place keyed by {project, url}
  // with no run_id in the filter, so by the time this run's own jobs
  // complete, the true "before" state would already be overwritten —
  // VerificationFinalizer (P3-002) reads this persisted value rather than
  // querying fresh.
  const before = await collectPageMetricSnapshot(project._id, targetUrl);

  let run;
  try {
    run = await PageVerificationRun.create({
      projectId,
      jobId: pageScrapingJob._id,
      runId: runId.toString(),
      pageUrl: targetUrl,
      status: 'pending',
      startedAt: new Date(),
      before,
    });
  } catch (error) {
    LoggerUtil.error('URL Verification: PageVerificationRun creation failed', error, { project_id: projectId, target_url: targetUrl });
    throw error;
  }

  // Seed job 2: HEADLESS_ACCESSIBILITY, same run_id/target_url/canonical_urls.
  let headlessJob;
  try {
    headlessJob = await createHeadlessAccessibilitySeedJob(project, targetUrl, runId, pageScrapingJob._id);
  } catch (error) {
    LoggerUtil.error('URL Verification: HEADLESS_ACCESSIBILITY creation failed', error, { project_id: projectId, target_url: targetUrl });
    run.status = 'failed';
    run.completedAt = new Date();
    run.errorMessage = error.message;
    await run.save();
    throw error;
  }

  run.status = 'running';
  await run.save();

  emitVerificationStartedAndDispatch({ runId, run, pageScrapingJob, headlessJob, projectId: project._id, targetUrl });

  return {
    success: true,
    code: URL_VERIFICATION_RESULT_CODES.STARTED,
    data: {
      // P3-005: surfaces the PageVerificationRun document's own _id and
      // current status — both already computed above, not a new lookup —
      // so API consumers (and the run's own REST identity) don't need a
      // second query for data this function already has in scope.
      verificationRunId: run._id.toString(),
      runId: runId.toString(),
      status: run.status,
      projectId,
      pageUrl: targetUrl,
      jobs: [
        { job_id: pageScrapingJob._id, job_type: pageScrapingJob.jobType, status: pageScrapingJob.status },
        { job_id: headlessJob._id, job_type: headlessJob.jobType, status: headlessJob.status },
      ],
    },
  };
}

/**
 * Start a Verification Batch for many URLs at once (F4-013 API/creation
 * infrastructure + F4-014 job creation/dispatch).
 *
 * Reuses loadAuthorizedProject/validateTargetUrlForProject (project/
 * ownership/format/SSRF/same-origin checks) AND createPageScrapingSeedJob/
 * createHeadlessAccessibilitySeedJob/emitVerificationStartedAndDispatch (job
 * creation + verification:started + dispatch) — the exact same functions
 * startUrlVerification itself now calls for a single URL. A batch member's
 * pipeline is byte-identical to a standalone single-URL verification's,
 * except its PAGE_SCRAPING/HEADLESS_ACCESSIBILITY jobs additionally carry
 * `input_data.batchId`, and its PageVerificationRun carries `batchId` too.
 * No chainingEngine/worker/websocket code was touched to make this true —
 * both already operate purely on run_id, indifferent to batchId's presence.
 *
 * Three distinct failure categories, all surfaced per-URL rather than
 * aborting the batch:
 *  - Rejected before any run exists (malformed/ineligible/duplicate-in-
 *    submission) — surfaced in `rejected[]`, never counted in totalUrls.
 *  - Rejected after its PageVerificationRun exists but job creation/dispatch
 *    failed (e.g. the P1-001 duplicate-run race, or an infra error) — this
 *    run is marked `status:'failed'`, still counted in totalUrls/`runs[]`
 *    (with `dispatched:false`), NOT moved into `rejected[]`.
 *  - Every submitted URL rejected at the first category above — the whole
 *    batch fails outright (NO_VALID_URLS), no VerificationBatch is created.
 *
 * VerificationBatch.status: PENDING (schema default) is never actually
 * observed by a caller — this function only ever returns after resolving it
 * to RUNNING (>=1 URL successfully dispatched) or FAILED (every accepted
 * URL's job creation/dispatch failed). No progress tracking, no barrier, no
 * aggregation — those are later phases.
 *
 * No existing "maximum URLs per batch" limit was found anywhere in the
 * backend (grepped for MAX_URL/MAX_BATCH/MAX_BULK/etc. — nothing) — per
 * F4-013 §2 ("reuse existing limits if available"), none is invented here.
 *
 * @param {string} projectId
 * @param {string[]} urls
 * @param {Object} [options]
 * @param {string|mongoose.Types.ObjectId} [options.requestingUserId] - must own the project
 * @returns {Promise<{success:boolean, code:string, message?:string, data?:object}>}
 */
export async function startVerificationBatch(projectId, urls, options = {}) {
  const { requestingUserId = null } = options;

  if (!Array.isArray(urls) || urls.length === 0) {
    return { success: false, code: URL_VERIFICATION_RESULT_CODES.NO_VALID_URLS, message: 'urls must be a non-empty array' };
  }

  const authResult = await loadAuthorizedProject(projectId, requestingUserId);
  if (!authResult.authorized) {
    return { success: false, code: authResult.code, message: authResult.message };
  }
  const { project } = authResult;

  // H3, checked once for the whole batch rather than once per URL — this
  // guard already excludes url_verification-mode jobs from its own
  // definition (see startUrlVerification's identical check), so its answer
  // cannot change based on how many URLs are in the submission.
  if (await isProjectWideAuditInProgress(projectId)) {
    return {
      success: false,
      code: URL_VERIFICATION_RESULT_CODES.ALREADY_RUNNING,
      message: 'An audit or verification is already in progress for this project',
    };
  }

  // Minted upfront, exactly like runId already is for a single URL — used
  // to stamp every accepted PageVerificationRun before the VerificationBatch
  // document itself exists (its own urls/totalUrls aren't known until the
  // loop below finishes filtering out rejections).
  const batchId = new mongoose.Types.ObjectId().toString();

  const accepted = [];
  const rejected = [];
  const seenNormalized = new Set();
  let dispatchedCount = 0;
  let dispatchFailedCount = 0;
  let jobsCreated = 0;
  let jobsDispatched = 0;

  for (const rawUrl of urls) {
    if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
      rejected.push({ url: rawUrl, reason: URL_VERIFICATION_RESULT_CODES.INVALID_URL, message: `Invalid target URL: ${rawUrl}` });
      continue;
    }

    let normalized;
    try {
      normalized = normalizeForComparison(rawUrl);
    } catch {
      rejected.push({ url: rawUrl, reason: URL_VERIFICATION_RESULT_CODES.INVALID_URL, message: `Invalid target URL: ${rawUrl}` });
      continue;
    }

    if (seenNormalized.has(normalized)) {
      rejected.push({ url: rawUrl, reason: 'DUPLICATE', message: 'Duplicate URL in this batch submission' });
      continue;
    }
    seenNormalized.add(normalized);

    const urlResult = await validateTargetUrlForProject(project, rawUrl);
    if (!urlResult.valid) {
      rejected.push({ url: rawUrl, reason: urlResult.code, message: urlResult.message });
      continue;
    }

    // Sequential, independent per-URL creation (F4-011 Phase 3's own
    // recommendation) — one URL's failure, at ANY step below, must not
    // abort the rest of the batch.
    const runId = new mongoose.Types.ObjectId();
    let run;
    try {
      run = await PageVerificationRun.create({
        projectId,
        batchId,
        runId: runId.toString(),
        pageUrl: rawUrl,
        status: 'pending',
      });
    } catch (error) {
      LoggerUtil.error('Verification Batch: PageVerificationRun creation failed', error, { project_id: projectId, target_url: rawUrl });
      rejected.push({ url: rawUrl, reason: 'CREATION_FAILED', message: 'Failed to create verification run for this URL' });
      continue;
    }

    // F4-014: this URL is accepted into the batch from here on regardless
    // of what happens next — a job-creation/dispatch failure below marks
    // THIS run failed (§6) but the run already exists and already counts
    // toward totalUrls; it is never moved into `rejected` at this point.
    const acceptedEntry = { url: rawUrl, runId: runId.toString(), verificationRunId: run._id.toString(), dispatched: false };
    accepted.push(acceptedEntry);

    let pageScrapingJob;
    try {
      pageScrapingJob = await createPageScrapingSeedJob(project, rawUrl, runId, batchId);
      jobsCreated++;
    } catch (error) {
      const message = error.isDuplicateVerification ? error.message : 'Failed to create PAGE_SCRAPING job';
      if (!error.isDuplicateVerification) {
        LoggerUtil.error('Verification Batch: PAGE_SCRAPING creation failed', error, { project_id: projectId, target_url: rawUrl, batchId });
      }
      run.status = 'failed';
      run.completedAt = new Date();
      run.errorMessage = message;
      await run.save();
      dispatchFailedCount++;
      continue;
    }

    // BEFORE snapshot + jobId/startedAt: this is the exact moment F4-013
    // deferred — "whichever later phase actually dispatches" — so the
    // run's nullable jobId/startedAt now transition to their normal,
    // populated runtime state, identical in shape to the single-URL flow.
    const before = await collectPageMetricSnapshot(project._id, rawUrl);
    run.jobId = pageScrapingJob._id;
    run.startedAt = new Date();
    run.before = before;
    await run.save();

    let headlessJob;
    try {
      headlessJob = await createHeadlessAccessibilitySeedJob(project, rawUrl, runId, pageScrapingJob._id, batchId);
      jobsCreated++;
    } catch (error) {
      LoggerUtil.error('Verification Batch: HEADLESS_ACCESSIBILITY creation failed', error, { project_id: projectId, target_url: rawUrl, batchId });
      run.status = 'failed';
      run.completedAt = new Date();
      run.errorMessage = error.message;
      await run.save();
      dispatchFailedCount++;
      continue;
    }

    run.status = 'running';
    await run.save();

    emitVerificationStartedAndDispatch({ runId, run, pageScrapingJob, headlessJob, projectId: project._id, targetUrl: rawUrl });

    acceptedEntry.dispatched = true;
    dispatchedCount++;
    jobsDispatched += 2;
  }

  if (accepted.length === 0) {
    return {
      success: false,
      code: URL_VERIFICATION_RESULT_CODES.NO_VALID_URLS,
      message: 'No submitted URL was eligible for verification',
      data: { rejected },
    };
  }

  // F4-014 §5/§6: PENDING -> RUNNING once at least one URL actually
  // dispatched; FAILED only if every accepted URL's job creation/dispatch
  // failed (distinct from NO_VALID_URLS above, which is zero URLs ever
  // being accepted at validation time). No progress tracking beyond this
  // one status field — that's a later phase (the barrier).
  const finalStatus = dispatchedCount > 0 ? BATCH_STATUS.RUNNING : BATCH_STATUS.FAILED;

  await VerificationBatch.createBatch({
    batchId,
    projectId,
    urls: accepted.map((r) => r.url),
    createdBy: requestingUserId,
  });
  await VerificationBatch.updateBatch(batchId, {
    status: finalStatus,
    ...(dispatchedCount > 0 ? { startedAt: new Date() } : {}),
  });

  LoggerUtil.info('[VERIFICATION_BATCH] batch dispatched', {
    batchId,
    projectId,
    createdJobs: jobsCreated,
    dispatchedJobs: jobsDispatched,
    failedJobs: dispatchFailedCount,
  });

  return {
    success: true,
    code: URL_VERIFICATION_RESULT_CODES.STARTED,
    data: {
      batchId,
      status: finalStatus,
      totalUrls: accepted.length,
      acceptedUrls: accepted.length,
      rejectedUrls: rejected.length,
      dispatchedUrls: dispatchedCount,
      failedDispatchUrls: dispatchFailedCount,
      runs: accepted,
      rejected,
    },
  };
}
