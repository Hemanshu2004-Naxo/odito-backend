import mongoose from 'mongoose';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { JobService } from '../../jobs/service/jobService.js';
import SeoProject from '../model/SeoProject.js';
import auditProgressService from '../../jobs/service/auditProgressService.js';
import fetch from 'node-fetch';
import Job from '../../jobs/model/Job.js';
import { startProjectAudit, AUDIT_RESULT_CODES } from '../service/projectAuditService.js';
import { startProjectVerification, VERIFICATION_RESULT_CODES } from '../service/projectVerificationService.js';
import { RUN_SOURCES } from '../../jobs/runSources.js';
import {
  startUrlVerification as startUrlVerificationService,
  startVerificationBatch as startVerificationBatchService,
  URL_VERIFICATION_RESULT_CODES,
} from '../../verification/service/urlVerificationService.js';

// Get MongoDB connection to access collections directly
const getDb = () => mongoose.connection.db;

const jobService = new JobService();

// Debug: Verify Job model is imported
LoggerUtil.debug('Job model loaded', { type: typeof Job });

/**
 * Start the Quick Recheck (verification) pipeline (manual dashboard trigger).
 *
 * Thin HTTP wrapper — all logic (ownership check, atomic crawl_status guard,
 * URL loading, soft reset, job creation/dispatch) lives in
 * projectVerificationService.startProjectVerification(), which the Weekly
 * Recheck scheduler calls too. Do not re-add any of that logic here.
 */
export const startVerification = async (req, res) => {
  const { project_id } = req.body;

  try {
    if (!project_id) {
      return res.status(400).json({ success: false, message: 'project_id is required' });
    }

    const result = await startProjectVerification(project_id, {
      source: RUN_SOURCES.MANUAL_RECHECK,
      requestingUserId: req.user._id,
    });

    if (!result.success) {
      switch (result.code) {
        case VERIFICATION_RESULT_CODES.NOT_FOUND:
          return res.status(404).json({ success: false, message: result.message });
        case VERIFICATION_RESULT_CODES.ACCESS_DENIED:
          return res.status(403).json({ success: false, message: result.message });
        case VERIFICATION_RESULT_CODES.ALREADY_RUNNING:
          return res.status(409).json({ success: false, message: result.message });
        case VERIFICATION_RESULT_CODES.NO_PREVIOUS_CRAWL:
          return res.status(400).json({ success: false, code: 'NO_PREVIOUS_CRAWL', message: result.message });
        default:
          return res.status(500).json(ResponseUtil.error('Failed to start verification pipeline', 500));
      }
    }

    return res.status(201).json({
      success: true,
      message: 'Quick Recheck started',
      data: result.data,
    });

  } catch (error) {
    LoggerUtil.error('Error starting verification pipeline', error, { project_id });
    return res.status(500).json(ResponseUtil.error('Failed to start verification pipeline', 500));
  }
};

/**
 * Start a URL Verification run (single-page recheck).
 *
 * This is a thin HTTP wrapper — all URL Verification logic (project
 * resolution, ownership check, URL validation, duplicate-run protection,
 * PageVerificationRun/job creation, dispatch) lives in
 * urlVerificationService.startUrlVerification(). Do not re-add any of that
 * logic here, matching the exact pattern startScraping() above uses for
 * startProjectAudit().
 */
export const startUrlVerification = async (req, res) => {
  const { projectId, url, options = {} } = req.body;

  try {
    if (!projectId || !url) {
      return res.status(400).json({
        success: false,
        message: 'projectId and url are required'
      });
    }

    // requestingUserId always comes from the authenticated session (auth
    // middleware), never from client-supplied `options` — options is
    // accepted per the request contract but the service does not currently
    // read anything else from it.
    const result = await startUrlVerificationService(projectId, url, {
      ...options,
      requestingUserId: req.user._id,
    });

    if (!result.success) {
      switch (result.code) {
        case URL_VERIFICATION_RESULT_CODES.NOT_FOUND:
          return res.status(404).json({ success: false, message: result.message });
        case URL_VERIFICATION_RESULT_CODES.ACCESS_DENIED:
          return res.status(403).json({ success: false, message: result.message });
        case URL_VERIFICATION_RESULT_CODES.INVALID_URL:
          return res.status(400).json({ success: false, message: result.message });
        case URL_VERIFICATION_RESULT_CODES.ALREADY_RUNNING:
          return res.status(409).json({ success: false, message: result.message });
        default:
          return res.status(500).json(ResponseUtil.error('Failed to start URL verification', 500));
      }
    }

    return res.status(201).json({
      success: true,
      message: 'URL Verification started',
      data: result.data,
    });

  } catch (error) {
    LoggerUtil.error('Error starting URL verification', error, { projectId, url });
    return res.status(500).json(ResponseUtil.error('Failed to start URL verification', 500));
  }
};

/**
 * Start a Verification Batch (F4-013 — API and creation infrastructure
 * only; no jobs, no dispatch, no orchestration yet).
 *
 * Thin HTTP wrapper — all logic lives in
 * urlVerificationService.startVerificationBatch(), matching the exact
 * pattern startUrlVerification() above uses. The response shape is flat
 * (no `data` wrapper) per this endpoint's own contract, unlike the
 * single-URL endpoint's `{success, message, data}` shape.
 */
export const startVerificationBatch = async (req, res) => {
  const { projectId, urls } = req.body;

  try {
    if (!projectId || !Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'projectId and a non-empty urls array are required'
      });
    }

    const result = await startVerificationBatchService(projectId, urls, {
      requestingUserId: req.user._id,
    });

    if (!result.success) {
      switch (result.code) {
        case URL_VERIFICATION_RESULT_CODES.NOT_FOUND:
          return res.status(404).json({ success: false, message: result.message });
        case URL_VERIFICATION_RESULT_CODES.ACCESS_DENIED:
          return res.status(403).json({ success: false, message: result.message });
        case URL_VERIFICATION_RESULT_CODES.ALREADY_RUNNING:
          return res.status(409).json({ success: false, message: result.message });
        case URL_VERIFICATION_RESULT_CODES.NO_VALID_URLS:
          return res.status(400).json({ success: false, message: result.message, rejected: result.data?.rejected || [] });
        default:
          return res.status(500).json(ResponseUtil.error('Failed to start verification batch', 500));
      }
    }

    return res.status(201).json({
      success: true,
      ...result.data,
    });

  } catch (error) {
    LoggerUtil.error('Error starting verification batch', error, { projectId, urlCount: urls?.length });
    return res.status(500).json(ResponseUtil.error('Failed to start verification batch', 500));
  }
};

/**
 * Start the new scraping pipeline (manual "Recrawl Project" trigger).
 *
 * This is a thin HTTP wrapper — all audit-start logic (ownership check,
 * atomic crawl_status guard, duplicate-job guard, manual recrawl credit
 * reservation, job creation/dispatch) lives in startProjectAudit(). Do not
 * re-add any of that logic here. The Weekly Recheck scheduler does not call
 * this — it runs the Quick Recheck pipeline instead.
 */
export const startScraping = async (req, res) => {
  const { project_id } = req.body;

  try {
    if (!project_id) {
      return res.status(400).json({
        success: false,
        message: 'project_id is required'
      });
    }

    const result = await startProjectAudit(project_id, {
      source: RUN_SOURCES.MANUAL_RECRAWL,
      requestingUserId: req.user._id,
    });

    if (!result.success) {
      switch (result.code) {
        case AUDIT_RESULT_CODES.NOT_FOUND:
          return res.status(404).json({ success: false, message: result.message });
        case AUDIT_RESULT_CODES.ACCESS_DENIED:
          return res.status(403).json({ success: false, message: result.message });
        case AUDIT_RESULT_CODES.ALREADY_RUNNING:
          return res.status(409).json({
            success: false,
            message: result.message,
            ...(result.existing_job ? { existing_job: result.existing_job } : {}),
          });
        case AUDIT_RESULT_CODES.INSUFFICIENT_RECRAWLS:
          return res.status(403).json({
            success: false,
            code: AUDIT_RESULT_CODES.INSUFFICIENT_RECRAWLS,
            message: result.message,
            ...(result.data ? { data: result.data } : {}),
          });
        case AUDIT_RESULT_CODES.SUBSCRIPTION_NOT_ACTIVE:
          return res.status(403).json({
            success: false,
            code: AUDIT_RESULT_CODES.SUBSCRIPTION_NOT_ACTIVE,
            message: result.message,
          });
        default:
          return res.status(500).json(ResponseUtil.error('Failed to start scraping pipeline', 500));
      }
    }

    return res.status(201).json({
      success: true,
      message: 'Your crawling has started',
      data: result.data,
    });

  } catch (error) {
    LoggerUtil.error('Error starting scraping pipeline', error, { project_id });
    return res.status(500).json(ResponseUtil.error('Failed to start scraping pipeline', 500));
  }
};

/**
 * Cancel running audit for a project
 */
export const cancelAudit = async (req, res) => {
  LoggerUtil.info('Cancel audit API called', { body: req.body });

  try {
    const { project_id, job_id } = req.body; // Accept both project_id and job_id

    if (!project_id && !job_id) {
      LoggerUtil.warn('Missing project_id or job_id');
      return res.status(400).json(ResponseUtil.error('project_id or job_id is required', 400));
    }

    // 🔒 SECURITY: Verify project ownership before cancelling
    if (project_id) {
      const project = await SeoProject.findById(project_id);
      if (!project) {
        return res.status(404).json(ResponseUtil.error('Project not found', 404));
      }
      if (project.user_id.toString() !== req.user._id.toString()) {
        return res.status(403).json(ResponseUtil.error('Access denied: You do not own this project', 403));
      }
    }

    let runningJobs = [];

    if (job_id) {
      // Cancel specific job by job_id (preferred)
      LoggerUtil.debug(`Looking for specific job: ${job_id}`);
      const job = await Job.findById(job_id);
      if (job && ['PROCESSING', 'QUEUED', 'CLAIMED'].includes(job.status)) {
        runningJobs = [job];
      }
    } else {
      // Legacy: find all running jobs for project
      LoggerUtil.debug(`Looking for running jobs in project: ${project_id}`);

      // First, let's see ALL jobs for this project for debugging
      const allJobs = await jobService.getJobsByProject(project_id, {});
      LoggerUtil.debug(`ALL jobs for project ${project_id}`, allJobs.map(j => ({
        id: j._id,
        status: j.status,
        jobType: j.jobType,
        project_id: j.project_id
      })));

      // Find running jobs for this project (PROCESSING, QUEUED, CLAIMED)
      runningJobs = allJobs.filter(job =>
        ['PROCESSING', 'QUEUED', 'CLAIMED'].includes(job.status)
      );
    }

    LoggerUtil.debug(`Found ${runningJobs.length} running jobs`, runningJobs.map(j => ({ id: j._id, status: j.status })));

    if (runningJobs.length === 0) {
      LoggerUtil.warn('No running jobs found');
      return res.status(404).json(ResponseUtil.error('No running jobs found for this project', 404));
    }

    // Mark jobs as cancelled in database
    const jobIds = runningJobs.map(job => job._id);
    LoggerUtil.debug(`Marking jobs as cancelled`, { jobIds });

    for (const jobId of jobIds) {
      await jobService.updateJobStatus(jobId, 'failed', {
        error_message: 'Audit cancelled by user',
        failed_at: new Date()
      });
    }

    LoggerUtil.info('Jobs marked as cancelled in database');

    // Notify Python workers to stop processing these jobs
    const pythonWorkerUrl = process.env.PYTHON_WORKER_URL;
    if (!pythonWorkerUrl) {
      throw new Error('PYTHON_WORKER_URL environment variable is required');
    }
    LoggerUtil.debug(`Notifying Python worker at: ${pythonWorkerUrl}`);

    for (const jobId of jobIds) {
      try {
        LoggerUtil.debug(`Sending cancel request for job: ${jobId}`);
        
        // Forward Authorization header to Python worker
        const headers = { 'Content-Type': 'application/json' };
        if (req.headers.authorization) {
          headers.Authorization = req.headers.authorization;
        }
        
        const response = await fetch(`${pythonWorkerUrl}/jobs/cancel`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ jobId: jobId.toString() })
        });

        if (response.ok) {
          LoggerUtil.debug(`Notified Python worker to cancel job: ${jobId}`);
        } else {
          LoggerUtil.error(`Failed to notify Python worker for job ${jobId}`, { status: response.statusText });
        }
      } catch (workerError) {
        LoggerUtil.error(`Error notifying Python worker for job ${jobId}`, { message: workerError.message });
      }
    }

    // Emit cancellation event to frontend via auditProgressService
    runningJobs.forEach(job => {
      auditProgressService.emitError(job._id.toString(), {
        jobId: job._id,
        message: 'Audit cancelled by user',
        subtext: 'The audit was stopped by the user',
        error: 'USER_CANCELLED'
      });
    });

    // Update project status back to draft
    if (project_id) {
      await SeoProject.findByIdAndUpdate(project_id, {
        status: 'draft',
        crawl_status: 'cancelled'
      });
    }

    LoggerUtil.info(`User cancelled audit`, { jobIds });

    return res.json(ResponseUtil.success({
      cancelledJobs: jobIds,
      project_id
    }, 'Audit cancelled successfully'));

  } catch (error) {
    LoggerUtil.error('Error cancelling audit', error);
    return res.status(500).json(ResponseUtil.error('Failed to cancel audit', 500));
  }
};

/**
 * Get scraping status for a project
 */
export const getScrapingStatus = async (req, res) => {
  try {
    // Project ownership already verified by validateProjectAccess middleware
    const project_id = req.params.id;

    // Scope by the project's current run so a stale job from a superseded
    // run (e.g. incomplete cleanup, or genuinely still-finishing chunk work
    // in a future chunked stage) can never be counted alongside the run
    // that's actually live, which would otherwise let a completed status
    // from an old run mask a new run's still-in-progress state.
    const project = await SeoProject.findById(project_id).select('current_run_id crawl_status').lean();
    const currentRunId = project?.current_run_id || null;

    const jobs = await jobService.getJobsByProject(
      project_id,
      currentRunId ? { run_id: currentRunId } : {}
    );

    // All pipeline job types — update this list when adding new stages
    const PIPELINE_JOB_TYPES = [
      'link_discovery',
      'domain_performance',
      'technical_domain',
      'page_scraping',
      'headless_accessibility',
      'crawl_graph',
      'performance_mobile',
      'performance_desktop',
      'page_analysis',
      'seo_scoring',
      'ai_visibility',
      'ai_visibility_scoring'
    ];

    // Dynamically build the status object from the list
    const status = {};
    PIPELINE_JOB_TYPES.forEach(type => {
      status[type] = { pending: 0, processing: 0, completed: 0, failed: 0, latest: null };
    });

    jobs.forEach(job => {
      const key = job.jobType.toLowerCase();
      // Defensive: job.status is normally already lowercase (enforced in
      // jobService.updateJobStatus), but this counts case-insensitively too
      // so any stray/pre-existing record with an uppercase status (e.g. jobs
      // written before that normalization existed) still counts correctly
      // instead of silently vanishing from the response the frontend polls.
      const normalizedJobStatus = typeof job.status === 'string' ? job.status.toLowerCase() : job.status;
      if (status[key] && status[key][normalizedJobStatus] !== undefined) {
        status[key][normalizedJobStatus]++;
        if (!status[key].latest || new Date(job.created_at) > new Date(status[key].latest.created_at)) {
          status[key].latest = {
            job_id: job._id,
            status: normalizedJobStatus,
            created_at: job.created_at,
            completed_at: job.completed_at,
            failed_at: job.failed_at
          };
        }
      }
    });

    res.json({
      success: true,
      data: status,
      // Sibling of `data`, not merged into it — `data` must stay pure
      // job-type buckets since frontend callers do Object.values(data)
      // expecting every entry to be a {pending,processing,completed,failed}
      // shape. Surfaced so pollers (ProcessingScreen) can detect the
      // 'awaiting_url_selection' pause without a second API call — job-type
      // buckets alone can't represent it (no PAGE_SCRAPING/
      // HEADLESS_ACCESSIBILITY job exists yet while a project is parked in
      // that state).
      crawl_status: project?.crawl_status || null
    });

  } catch (error) {
    LoggerUtil.error('Error getting scraping status', error, { project_id: req.params.project_id });
    return res.status(500).json(ResponseUtil.error('Failed to get scraping status', 500));
  }
};

/**
 * Get raw HTML for a specific URL from stored page data
 */
export const getPageRawHtml = async (req, res) => {
  try {
    const { url, project_id } = req.query;

    if (!url) {
      return res.status(400).json({
        success: false,
        message: 'URL parameter is required'
      });
    }

    // 🔒 SECURITY: Require project_id to prevent cross-project data leakage
    if (!project_id) {
      return res.status(400).json({
        success: false,
        message: 'project_id parameter is required'
      });
    }

    // 🔒 SECURITY: Verify project ownership
    const project = await SeoProject.findById(project_id);
    if (!project || project.user_id.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    LoggerUtil.debug(`Fetching raw HTML from stored data for URL: ${url}`);

    // Get the page data from seo_page_data collection — scoped by projectId
    // Projection: only fetch raw_html + timestamps; avoids loading the full document
    const db = getDb();
    const { ObjectId } = mongoose.Types;
    const pageData = await db.collection('seo_page_data').findOne(
      { url: url, projectId: new ObjectId(project_id) },
      { projection: { raw_html: 1, scrapedAt: 1, scraped_at: 1, _id: 0 } }
    );

    if (!pageData) {
      return res.status(404).json({
        success: false,
        message: 'Page data not found for this URL'
      });
    }

    // Check if HTML content exists in the stored data (field is raw_html)
    if (!pageData.raw_html) {
      return res.status(404).json({
        success: false,
        message: 'HTML content not found for this URL'
      });
    }

    LoggerUtil.debug(`Found HTML for ${url}`, { length: pageData.raw_html.length });

    res.json({
      success: true,
      data: {
        html: pageData.raw_html,
        url: url,
        fetched_at: pageData.scrapedAt || pageData.scraped_at || new Date().toISOString()
      }
    });

  } catch (error) {
    LoggerUtil.error(`Error getting raw HTML for ${req.query.url}`, error);
    return res.status(500).json(ResponseUtil.error('Failed to get HTML from stored data', 500));
  }
};
