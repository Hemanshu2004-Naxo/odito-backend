import axios from 'axios';

import { JobService } from '../service/jobService.js';

import AIScript from '../../aiVideo/models/aiScript.model.js';

import { getEnvVar } from '../../../config/env.js';



const jobService = new JobService();



class JobDispatcher {

  constructor() {

    // PULL/PULL model feature flag
    this.usePullModel = process.env.USE_PULL_MODEL === 'true';

    // Validate required environment variables

    const pythonWorkerUrl = process.env.PYTHON_WORKER_URL;

    if (!pythonWorkerUrl) {

      throw new Error('PYTHON_WORKER_URL environment variable is required');

    }

    

    this.pythonBaseURL = pythonWorkerUrl;

    this.videoWorkerURL = getEnvVar('VIDEO_WORKER_URL');

    this.isProcessing = false;

    this.jobQueue = [];

  }



  /**

   * Add job to queue for sequential processing

   */

  async queueLinkDiscoveryJob(job) {

    this.jobQueue.push(job);



    // Start processing if not already running

    if (!this.isProcessing) {

      this.processQueue();

    }

  }



  /**

   * Queue DOMAIN_PERFORMANCE job for immediate dispatch

   */

  async queueDomainPerformanceJob(job) {

    // DOMAIN_PERFORMANCE jobs are dispatched immediately (no queue)

    this.dispatchDomainPerformanceJob(job).catch(error => {

      console.error(`[ERROR] DOMAIN_PERFORMANCE dispatch failed | jobId=${job._id} | reason="${error.message}"`);

    });

  }



  /**

   * Process jobs sequentially from queue (internal only)

   */

  async processQueue() {

    if (this.isProcessing || this.jobQueue.length === 0) {

      return;

    }



    this.isProcessing = true;



    while (this.jobQueue.length > 0) {

      const job = this.jobQueue.shift();



      // CRITICAL: Only LINK_DISCOVERY jobs should ever be in the queue

      if (job.jobType !== 'LINK_DISCOVERY') {

        continue; // Silent skip - no logs for internal queue operations

      }



      try {

        await this.dispatchLinkDiscoveryJob(job);

      } catch (error) {

        console.error(`[ERROR] LINK_DISCOVERY processing failed | jobId=${job._id} | reason="${error.message}"`);

      }



      // Small delay between jobs

      await new Promise(resolve => setTimeout(resolve, 2000));

    }



    this.isProcessing = false;

    // REMOVED: "Queue processing completed" log - this is internal detail

  }



  /**

   * Dispatch LINK_DISCOVERY job directly to Python worker via HTTP

   * This is the PUSH model - Node actively calls Python

   */

  async dispatchLinkDiscoveryJob(job) {
    try {
      if (this.usePullModel) {
        // PULL model: mark as pending, worker will poll. Migrated off the
        // PUSH path — its axios.post below was the exact mechanism proven
        // (via live reproduction) to occasionally exceed its client timeout
        // under audit-start contention, producing a transient FAILED job.
        // execute_link_discovery() itself is unchanged and already reports
        // completion/failure via the same /complete and /fail callbacks
        // used by every other PULL-mode job type.
        await jobService.updateJobStatus(job._id, 'pending');
        console.log(`✅ [PULL] LINK_DISCOVERY job queued for polling | jobId=${job._id}`);
        return { success: true, jobId: job._id, dispatched: false };
      }

      // Update job status to processing first
      await jobService.updateJobStatus(job._id, 'PROCESSING', {
        started_at: new Date(),
        last_attempted_at: new Date()
      });

      // Direct HTTP call to Python worker - NON-BLOCKING with shorter timeout
      const dispatchUrl = `${this.pythonBaseURL}/api/jobs/link-discovery`;
      const dispatchPayload = {
        jobId: job._id.toString(),
        projectId: job.project_id.toString(),
        userId: job.user_id.toString(),
        main_url: job.input_data.main_url
      };

      // Fire-and-forget dispatch - only wait for acceptance, not completion
      const response = await axios.post(dispatchUrl, dispatchPayload, {
        timeout: 30000,  // Reduced to 30s - only wait for job acceptance
        headers: {
          'Content-Type': 'application/json'
        }
      });

      console.log(`✅ [DISPATCH] Job accepted by worker | status=${response.status}`);
      console.log(`✅ [DISPATCH] Job ${job._id} dispatched successfully`);

      return {
        success: true,
        jobId: job._id,
        dispatched: true  // Worker will callback on completion
      };

    } catch (error) {
      console.error(`❌ [DISPATCH] Request failed | jobId=${job._id}`);
      console.error(`❌ [DISPATCH] Error details:`, {
        message: error.message,
        code: error.code,
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data
      });

      // Mark job as failed if dispatch fails
      await jobService.updateJobStatus(job._id, 'FAILED', {
        completed_at: new Date(),
        error_message: `Dispatch failed: ${error.message}`
      });

      return {
        success: false,
        jobId: job._id,
        error: error.message
      };
    }
  }



  /**

   * Dispatch PAGE_SCRAPING job directly to Python worker via HTTP

   * This is PUSH model - Node actively calls Python

   * CRITICAL: Job must already be atomically marked as dispatched

   */

  async dispatchPageScrapingJob(job) {

    try {

      if (this.usePullModel) {

        // PULL model: mark as pending, worker will poll

        await jobService.updateJobStatus(job._id, 'pending');

        console.log(`✅ [PULL] Job queued for polling | jobId=${job._id}`);

        return {

          success: true,

          jobId: job._id,

          dispatched: false

        };

      } else {

        // Existing PUSH logic (unchanged)

        const response = await axios.post(`${this.pythonBaseURL}/api/jobs/page-scraping`, {

          jobId: job._id.toString(),

          projectId: job.project_id.toString(),

          userId: job.user_id.toString(),

          urls: job.input_data.urls || [],

          canonicalUrls: job.input_data.canonical_urls || [],

          sourceJobId: job.input_data.source_job_id

        }, {

          timeout: 30000,  // Reduced to 30s - only wait for job acceptance

          headers: {

            'Content-Type': 'application/json'

          }

        });



        console.log(`✅ [DISPATCH] PAGE_SCRAPING job accepted by worker | jobId=${job._id}`);

        return {

          success: true,

          jobId: job._id,

          dispatched: true  // Worker will callback on completion

        };

      }

    } catch (error) {

      console.error(`[ERROR] PAGE_SCRAPING dispatch failed | jobId=${job._id} | reason="${error.message}"`);



      // Mark job as failed if dispatch fails

      await jobService.updateJobStatus(job._id, 'FAILED', {

        completed_at: new Date(),

        error_message: `Dispatch failed: ${error.message}`

      });



      return {

        success: false,

        message: 'Failed to dispatch PAGE_SCRAPING job to Python worker',

        error: error.message

      };

    }

  }



  /**

   * Dispatch PAGE_ANALYSIS job directly to Python worker via HTTP

   * This is PUSH model - Node actively calls Python

   * CRITICAL: Job must already be atomically marked as dispatched

   */

  async dispatchPageAnalysisJob(job) {

    try {

      if (this.usePullModel) {

        // PULL model: mark as pending, worker will poll

        await jobService.updateJobStatus(job._id, 'pending');

        console.log(`✅ [PULL] PAGE_ANALYSIS job queued for polling | jobId=${job._id}`);

        return {

          success: true,

          jobId: job._id,

          dispatched: false

        };

      }

      // Job should already be marked as dispatched atomically

      // Just send the HTTP request to Python

      const response = await axios.post(`${this.pythonBaseURL}/api/jobs/page-analysis`, {

        jobId: job._id.toString(),

        projectId: job.project_id.toString(),

        userId: job.user_id.toString(),

        sourceJobId: job.input_data.source_job_id

      }, {

        // 180s: the Python endpoint runs the job synchronously and only
        // responds once it finishes (confirmed for the sibling
        // domain-performance/technical-domain endpoints; this dispatch
        // pattern is shared). 30s was shorter than observed real completion
        // times under audit-start load, causing Node to mark the job FAILED
        // via this timeout while Python was still working, then correct it
        // back to completed via its own callback moments later.
        timeout: 180000,

        headers: {

          'Content-Type': 'application/json'

        }

      });



      return {

        success: true,

        jobId: job._id

      };

    } catch (error) {

      console.error(`[ERROR] PAGE_ANALYSIS dispatch failed | jobId=${job._id} | reason="${error.message}"`);



      // Mark job as failed if dispatch fails

      await jobService.updateJobStatus(job._id, 'FAILED', {

        completed_at: new Date(),

        error_message: `Dispatch failed: ${error.message}`

      });



      return {

        success: false,

        message: 'Failed to dispatch PAGE_ANALYSIS job to Python worker',

        error: error.message

      };

    }

  }



  /**

   * Dispatch SEO_SCORING job directly to Python worker via HTTP

   * This is PUSH model - Node actively calls Python

   * CRITICAL: Job must already be atomically marked as dispatched

   */

  async dispatchSeoScoringJob(job) {

    try {

      // Job should already be marked as dispatched atomically

      // Just send the HTTP request to Python

      const response = await axios.post(`${this.pythonBaseURL}/api/jobs/seo-scoring`, {

        jobId: job._id.toString(),

        projectId: job.project_id.toString(),

        userId: job.user_id.toString(),

        sourceJobId: job.input_data.source_job_id

      }, {

        // 180s — see the identical note in dispatchPageAnalysisJob above.
        timeout: 180000,

        headers: {

          'Content-Type': 'application/json'

        }

      });



      return {

        success: true,

        jobId: job._id

      };

    } catch (error) {

      console.error(`[ERROR] SEO_SCORING dispatch failed | jobId=${job._id} | reason="${error.message}"`);



      // Mark job as failed if dispatch fails

      await jobService.updateJobStatus(job._id, 'FAILED', {

        completed_at: new Date(),

        error_message: `Dispatch failed: ${error.message}`

      });



      return {

        success: false,

        message: 'Failed to dispatch SEO_SCORING job to Python worker',

        error: error.message

      };

    }

  }



  /**

   * Dispatch PERFORMANCE_MOBILE job directly to Python worker via HTTP

   * This is PUSH model - Node actively calls Python

   * CRITICAL: Job must already be atomically marked as dispatched

   */

  async dispatchPerformanceMobileJob(job) {

    try {

      if (this.usePullModel) {

        // PULL model: mark as pending, worker will poll

        await jobService.updateJobStatus(job._id, 'pending');

        console.log(`✅ [PULL] PERFORMANCE_MOBILE job queued for polling | jobId=${job._id}`);

        return {

          success: true,

          jobId: job._id,

          dispatched: false

        };

      }

      console.log(`[DEBUG] dispatchPerformanceMobileJob called with jobId=${job._id}`);



      const dispatchUrl = `${this.pythonBaseURL}/api/jobs/performance-mobile`;

      console.log(`[DEBUG] Dispatching PERFORMANCE_MOBILE to URL: ${dispatchUrl}`);



      // Job should already be marked as dispatched atomically

      // Just send the HTTP request to Python

      const response = await axios.post(dispatchUrl, {

        jobId: job._id.toString(),

        projectId: job.project_id.toString(),

        userId: job.user_id.toString(),

        sourceJobId: job.input_data.source_job_id

      }, {

        // 180s — see the identical note in dispatchPageAnalysisJob above.
        timeout: 180000,

        headers: {

          'Content-Type': 'application/json'

        }

      });



      console.log(`[DEBUG] PERFORMANCE_MOBILE HTTP response status: ${response.status}`);



      return {

        success: true,

        jobId: job._id

      };

    } catch (error) {

      console.error(`[ERROR] PERFORMANCE_MOBILE dispatch failed | jobId=${job._id} | reason="${error.message}"`);

      console.error(`[ERROR] Full error stack: ${error.stack}`);



      // Mark job as failed if dispatch fails

      await jobService.updateJobStatus(job._id, 'FAILED', {

        completed_at: new Date(),

        error_message: `Dispatch failed: ${error.message}`

      });



      return {

        success: false,

        message: 'Failed to dispatch PERFORMANCE_MOBILE job to Python worker',

        error: error.message

      };

    }

  }



  /**

   * Dispatch PERFORMANCE_DESKTOP job directly to Python worker via HTTP

   * This is PUSH model - Node actively calls Python

   * CRITICAL: Job must already be atomically marked as dispatched

   */

  async dispatchPerformanceDesktopJob(job) {

    try {

      if (this.usePullModel) {

        // PULL model: mark as pending, worker will poll

        await jobService.updateJobStatus(job._id, 'pending');

        console.log(`✅ [PULL] PERFORMANCE_DESKTOP job queued for polling | jobId=${job._id}`);

        return {

          success: true,

          jobId: job._id,

          dispatched: false

        };

      }

      console.log(`[DEBUG] dispatchPerformanceDesktopJob called with jobId=${job._id}`);



      const dispatchUrl = `${this.pythonBaseURL}/api/jobs/performance-desktop`;

      console.log(`[DEBUG] Dispatching PERFORMANCE_DESKTOP to URL: ${dispatchUrl}`);



      // Job should already be marked as dispatched atomically

      // Just send the HTTP request to Python

      const response = await axios.post(dispatchUrl, {

        jobId: job._id.toString(),

        projectId: job.project_id.toString(),

        userId: job.user_id.toString(),

        sourceJobId: job.input_data.source_job_id

      }, {

        // 180s — see the identical note in dispatchPageAnalysisJob above.
        timeout: 180000,

        headers: {

          'Content-Type': 'application/json'

        }

      });



      console.log(`[DEBUG] PERFORMANCE_DESKTOP HTTP response status: ${response.status}`);



      return {

        success: true,

        jobId: job._id

      };

    } catch (error) {

      console.error(`[ERROR] PERFORMANCE_DESKTOP dispatch failed | jobId=${job._id} | reason="${error.message}"`);

      console.error(`[ERROR] Full error stack: ${error.stack}`);



      // Mark job as failed if dispatch fails

      await jobService.updateJobStatus(job._id, 'FAILED', {

        completed_at: new Date(),

        error_message: `Dispatch failed: ${error.message}`

      });



      return {

        success: false,

        message: 'Failed to dispatch PERFORMANCE_DESKTOP job to Python worker',

        error: error.message

      };

    }

  }



  /**

   * Dispatch HEADLESS_ACCESSIBILITY job directly to Python worker via HTTP

   * This is PUSH model - Node actively calls Python

   * CRITICAL: Job must already be atomically marked as dispatched

   */

  async dispatchHeadlessAccessibilityJob(job) {

    try {

      if (this.usePullModel) {

        // PULL model: mark as pending, worker will poll

        await jobService.updateJobStatus(job._id, 'pending');

        console.log(`✅ [PULL] HEADLESS_ACCESSIBILITY job queued for polling | jobId=${job._id}`);

        return {

          success: true,

          jobId: job._id,

          dispatched: false

        };

      }

      console.log(`[DEBUG] dispatchHeadlessAccessibilityJob called with jobId=${job._id}`);



      const dispatchUrl = `${this.pythonBaseURL}/api/jobs/headless-accessibility`;

      console.log(`[DEBUG] Dispatching HEADLESS_ACCESSIBILITY to URL: ${dispatchUrl}`);



      // Job should already be marked as dispatched atomically

      // Just send the HTTP request to Python - NON-BLOCKING

      const response = await axios.post(dispatchUrl, {

        jobId: job._id.toString(),

        projectId: job.project_id.toString(),

        userId: job.user_id.toString(),

        sourceJobId: job.input_data.source_job_id,

        urls: job.input_data.urls || [],

        canonicalUrls: job.input_data.canonical_urls || []

      }, {

        timeout: 30000,  // Reduced to 30s - only wait for job acceptance

        headers: {

          'Content-Type': 'application/json'

        }

      });



      console.log(`✅ [DISPATCH] HEADLESS_ACCESSIBILITY job accepted by worker | jobId=${job._id}`);



      return {

        success: true,

        jobId: job._id,

        dispatched: true  // Worker will callback on completion

      };

    } catch (error) {

      console.error(`[ERROR] HEADLESS_ACCESSIBILITY dispatch failed | jobId=${job._id} | reason="${error.message}"`);

      console.error(`[ERROR] Full error stack: ${error.stack}`);



      // Mark job as failed if dispatch fails

      await jobService.updateJobStatus(job._id, 'FAILED', {

        completed_at: new Date(),

        error_message: `Dispatch failed: ${error.message}`

      });



      return {

        success: false,

        message: 'Failed to dispatch HEADLESS_ACCESSIBILITY job to Python worker',

        error: error.message

      };

    }

  }



  /**

   * Dispatch CRAWL_GRAPH job directly to Python worker via HTTP

   * This is PUSH model - Node actively calls Python

   * CRITICAL: Pure computation — no HTTP crawling, reads from MongoDB only

   */

  async dispatchCrawlGraphJob(job) {

    try {

      console.log(`[DEBUG] dispatchCrawlGraphJob called with jobId=${job._id}`);



      const dispatchUrl = `${this.pythonBaseURL}/api/jobs/crawl-graph`;

      console.log(`[DEBUG] Dispatching CRAWL_GRAPH to URL: ${dispatchUrl}`);



      // Job should already be marked as dispatched atomically

      // Just send the HTTP request to Python

      const response = await axios.post(dispatchUrl, {

        jobId: job._id.toString(),

        projectId: job.project_id.toString(),

        userId: job.user_id.toString(),

        sourceJobId: job.input_data.source_job_id

      }, {

        // 180s — see the identical note in dispatchPageAnalysisJob above.
        timeout: 180000,

        headers: {

          'Content-Type': 'application/json'

        }

      });



      console.log(`[DEBUG] CRAWL_GRAPH HTTP response status: ${response.status}`);



      return {

        success: true,

        jobId: job._id

      };

    } catch (error) {

      console.error(`[ERROR] CRAWL_GRAPH dispatch failed | jobId=${job._id} | reason="${error.message}"`);

      console.error(`[ERROR] Full error stack: ${error.stack}`);



      // Mark job as failed if dispatch fails

      await jobService.updateJobStatus(job._id, 'FAILED', {

        completed_at: new Date(),

        error_message: `Dispatch failed: ${error.message}`

      });



      return {

        success: false,

        message: 'Failed to dispatch CRAWL_GRAPH job to Python worker',

        error: error.message

      };

    }

  }



  /**

   * Dispatch AI_VISIBILITY job directly to Python worker via HTTP

   * This is PUSH model - Node actively calls Python

   * CRITICAL: Job must already be atomically marked as dispatched

   */

  async dispatchAiVisibilityJob(job) {

    try {

      // Debug: Log what we're sending

      const payload = {

        jobId: job._id.toString(),

        projectId: job.project_id ? job.project_id.toString() : null,

        userId: job.user_id.toString()

      };



      console.log("[DISPATCH] AI_VISIBILITY payload:", {

        projectId: payload.projectId,

        hasInputData: !!job.input_data

      });



      // Job should already be marked as dispatched atomically

      // Just send the HTTP request to Python

      const response = await axios.post(`${this.pythonBaseURL}/api/jobs/ai-visibility`, payload, {

        // 180s — see the identical note in dispatchPageAnalysisJob above.
        timeout: 180000,

        headers: {

          'Content-Type': 'application/json'

        }

      });



      return {

        success: true,

        jobId: job._id

      };

    } catch (error) {

      console.error(`[ERROR] AI_VISIBILITY dispatch failed | jobId=${job._id} | reason="${error.message}"`);



      // Mark job as failed if dispatch fails

      await jobService.updateJobStatus(job._id, 'FAILED', {

        completed_at: new Date(),

        error_message: `Dispatch failed: ${error.message}`

      });



      return {

        success: false,

        message: 'Failed to dispatch AI_VISIBILITY job to Python worker',

        error: error.message

      };

    }

  }



  /**

   * Dispatch DOMAIN_PERFORMANCE job directly to Python worker via HTTP

   * This is PUSH model - Node actively calls Python

   */

  async dispatchDomainPerformanceJob(job) {

    try {

      if (this.usePullModel) {
        // PULL model: mark as pending, worker will poll. main.py's poller
        // now supports DOMAIN_PERFORMANCE (added alongside LINK_DISCOVERY) —
        // this was previously PUSH-only because no PULL support existed on
        // the Python side; that gap is closed, so this now follows the same
        // pattern as every other PULL-mode job type. execute_domain_performance_logic()
        // itself is unchanged and already reports completion/failure via the
        // same /complete and /fail callbacks used everywhere else.
        await jobService.updateJobStatus(job._id, 'pending');
        console.log(`✅ [PULL] DOMAIN_PERFORMANCE job queued for polling | jobId=${job._id}`);
        return { success: true, jobId: job._id, dispatched: false };
      }

      // Update job status to processing first

      await jobService.updateJobStatus(job._id, 'PROCESSING', {

        started_at: new Date(),

        last_attempted_at: new Date()

      });



      // Direct HTTP call to Python worker

      const response = await axios.post(`${this.pythonBaseURL}/api/jobs/domain-performance`, {

        jobId: job._id.toString(),

        projectId: job.project_id.toString(),

        userId: job.user_id.toString(),

        main_url: job.input_data.main_url

      }, {

        // PROVEN root cause of the transient "One or more jobs failed"
        // symptom: domain_performance.py's handler runs the full mobile +
        // desktop PageSpeed Insights scan (each with its own retry/backoff)
        // synchronously and only responds when both finish — confirmed by
        // direct trace, not assumed. A live reproduction measured 91.4s for
        // this endpoint to respond under normal audit-start load; the
        // previous 30s client timeout fired before that response arrived,
        // so Node marked the job FAILED while Python was still working, then
        // Python's own completion callback corrected it back to completed
        // ~60s later. 180s gives comfortable headroom above the observed
        // 91.4s without masking a genuine hang indefinitely.
        timeout: 180000,

        headers: {

          'Content-Type': 'application/json'

        }

      });



      return {

        success: true,

        jobId: job._id

      };

    } catch (error) {

      console.error(`[ERROR] DOMAIN_PERFORMANCE dispatch failed | jobId=${job._id} | reason="${error.message}"`);



      // Mark job as failed if dispatch fails

      await jobService.updateJobStatus(job._id, 'FAILED', {

        completed_at: new Date(),

        error_message: `Dispatch failed: ${error.message}`

      });



      return {

        success: false,

        message: 'Failed to dispatch DOMAIN_PERFORMANCE job to Python worker',

        error: error.message

      };

    }

  }



  /**

   * Dispatch TECHNICAL_DOMAIN job directly to Python worker via HTTP

   * This is PUSH model - Node actively calls Python

   * CRITICAL: Pure data collection - no scoring or rule logic

   */

  async dispatchTechnicalDomainJob(job) {

    try {

      if (this.usePullModel) {
        // PULL model: mark as pending, worker will poll. Avoids the PUSH
        // path's 30s HTTP dispatch call below, which was observed to
        // consistently time out (~30.1s after creation, every audit run)
        // at audit start — likely Python-side contention with
        // LINK_DISCOVERY's heavier concurrent work — producing a spurious
        // failed→completed cycle that ProcessingScreen's polling can latch
        // onto as a permanent (and incorrect) failure state.
        await jobService.updateJobStatus(job._id, 'pending');
        console.log(`✅ [PULL] TECHNICAL_DOMAIN job queued for polling | jobId=${job._id}`);
        return { success: true, jobId: job._id, dispatched: false };
      }

      // Update job status to processing first (this job is now dispatched
      // directly as an audit-start seed job, not via chainingEngine's
      // atomicallyDispatchJob, which used to perform this transition)

      await jobService.updateJobStatus(job._id, 'PROCESSING', {

        started_at: new Date(),

        last_attempted_at: new Date()

      });

      const response = await axios.post(`${this.pythonBaseURL}/api/jobs/technical-domain`, {

        jobId: job._id.toString(),

        projectId: job.project_id.toString(),

        userId: job.user_id.toString(),

        domain: job.input_data.domain

      }, {

        // 180s — see the identical note in dispatchDomainPerformanceJob
        // above; this endpoint follows the same synchronous-handler pattern
        // and was independently observed to time out at 30s "every audit
        // run" per the PULL-mode comment just above this function.
        timeout: 180000,

        headers: {

          'Content-Type': 'application/json'

        }

      });



      return {

        success: true,

        jobId: job._id

      };

    } catch (error) {

      console.error(`[ERROR] TECHNICAL_DOMAIN dispatch failed | jobId=${job._id} | reason="${error.message}"`);



      // Mark job as failed if dispatch fails

      await jobService.updateJobStatus(job._id, 'FAILED', {

        completed_at: new Date(),

        error_message: `Dispatch failed: ${error.message}`

      });



      return {

        success: false,

        message: 'Failed to dispatch TECHNICAL_DOMAIN job to Python worker',

        error: error.message

      };

    }

  }



  /**

   * Dispatch VIDEO_GENERATION job to Video Worker via HTTP

   */

  async dispatchVideoGenerationJob(job) {

    try {

      console.log(`[VIDEO_DISPATCH] Starting dispatch | jobId=${job._id} | projectId=${job.project_id}`);



      // Update job status to processing first

      await jobService.updateJobStatus(job._id, 'processing', {

        started_at: new Date(),

        last_attempted_at: new Date()

      });



      // Fetch auditSnapshot and script from aiScript collection

      console.log(`[VIDEO_DISPATCH] Fetching auditSnapshot and script for projectId=${job.project_id}`);

      const aiScriptRecord = await AIScript.findOne({ 

        projectId: job.project_id, 

        status: 'completed' 

      });



      if (!aiScriptRecord) {

        throw new Error(`No completed script found for projectId=${job.project_id}`);

      }



      if (!aiScriptRecord.auditSnapshot) {

        throw new Error(`auditSnapshot not found for projectId=${job.project_id}`);

      }



      if (!aiScriptRecord.script) {

        throw new Error(`script not found for projectId=${job.project_id}`);

      }



      console.log(`[VIDEO_DISPATCH] ✅ Found auditSnapshot and script`);

      console.log(`[VIDEO_DISPATCH] auditSnapshot keys:`, Object.keys(aiScriptRecord.auditSnapshot));

      console.log(`[VIDEO_DISPATCH] script length:`, aiScriptRecord.script.length);



      // Prepare payload with auditSnapshot and script

      const videoPayload = {

        jobId: job._id.toString(),

        projectId: job.project_id.toString(),

        userId: job.user_id.toString(),

        auditSnapshot: aiScriptRecord.auditSnapshot,

        script: aiScriptRecord.script

      };



      // Direct HTTP call to Video worker

      const response = await axios.post(`${this.videoWorkerURL}/jobs/video-generation`, videoPayload, {

        timeout: 300000, // 5 minutes timeout for video generation

        headers: {

          'Content-Type': 'application/json'

        }

      });



      console.log(`[VIDEO_DISPATCH] Job dispatched successfully | jobId=${job._id} | workerResponse=${response.status}`);



      return {

        success: true,

        jobId: job._id

      };

    } catch (error) {

      console.error(`[VIDEO_DISPATCH] Dispatch failed | jobId=${job._id} | reason="${error.message}"`);



      // Mark job as failed if dispatch fails

      await jobService.updateJobStatus(job._id, 'failed', {

        error: {

          message: `Failed to dispatch job to Video worker: ${error.message}`,

          timestamp: new Date()

        },

        failed_at: new Date()

      });



      return {

        success: false,

        message: 'Failed to dispatch job to Video worker',

        error: error.message

      };

    }

  }



  /**
   * Dispatch HOMEPAGE_VIDEO_GENERATION job to the SAME Video Worker via HTTP.
   * Source of truth: HomepageAudit.snapshot ONLY. No live fetches.
   * Sends videoType so the worker routes to the homepageAuditProcessor.
   */
  async dispatchHomepageVideoJob(job) {
    try {
      console.log(`[HOMEPAGE_VIDEO_DISPATCH] Starting dispatch | jobId=${job._id}`);

      await jobService.updateJobStatus(job._id, 'processing', {
        started_at: new Date(),
        last_attempted_at: new Date()
      });

      // auditId is stored in the job's input_data at creation time
      const auditId = job.input_data?.auditId;
      if (!auditId) {
        throw new Error(`auditId not found in job input_data | jobId=${job._id}`);
      }

      const HomepageAudit = (await import('../../external/model/HomepageAudit.js')).default;
      const audit = await HomepageAudit.findById(auditId).lean();

      if (!audit) {
        throw new Error(`HomepageAudit not found | auditId=${auditId}`);
      }
      if (!audit.snapshot) {
        throw new Error(`snapshot not found on HomepageAudit | auditId=${auditId}`);
      }

      console.log(`[HOMEPAGE_VIDEO_DISPATCH] ✅ Found snapshot | auditId=${auditId} | keys=${Object.keys(audit.snapshot).length}`);

      const videoPayload = {
        jobId: job._id.toString(),
        videoType: 'HOMEPAGE_AUDIT',
        auditId: auditId.toString(),
        auditSnapshot: audit.snapshot
      };

      const response = await axios.post(`${this.videoWorkerURL}/jobs/video-generation`, videoPayload, {
        timeout: 300000,
        headers: { 'Content-Type': 'application/json' }
      });

      console.log(`[HOMEPAGE_VIDEO_DISPATCH] Job dispatched successfully | jobId=${job._id} | workerResponse=${response.status}`);

      return { success: true, jobId: job._id };

    } catch (error) {
      console.error(`[HOMEPAGE_VIDEO_DISPATCH] Dispatch failed | jobId=${job._id} | reason="${error.message}"`);

      await jobService.updateJobStatus(job._id, 'failed', {
        error: {
          message: `Failed to dispatch homepage video job to Video worker: ${error.message}`,
          timestamp: new Date()
        },
        failed_at: new Date()
      });

      return { success: false, message: 'Failed to dispatch homepage video job', error: error.message };
    }
  }

  /**
   * Dispatch URL_QUALIFICATION job to Python worker.
   * PULL model: job stays pending, worker polls and claims.
   * PUSH model: HTTP POST to Python.
   */
  async dispatchUrlQualificationJob(job) {
    try {
      if (this.usePullModel) {
        await jobService.updateJobStatus(job._id, 'pending');
        console.log(`✅ [PULL] URL_QUALIFICATION job queued for polling | jobId=${job._id}`);
        return { success: true, jobId: job._id, dispatched: false };
      }

      const dispatchUrl = `${this.pythonBaseURL}/api/jobs/url-qualification`;
      console.log(`[DISPATCH] URL_QUALIFICATION → ${dispatchUrl} | jobId=${job._id}`);

      const response = await axios.post(dispatchUrl, {
        jobId: job._id.toString(),
        projectId: job.project_id.toString(),
        userId: job.user_id.toString(),
        sourceJobId: job.input_data.source_job_id,
        canonicalHost: job.input_data.canonical_host || null,
      }, {
        // 180s — see the identical note in dispatchPageAnalysisJob above.
        timeout: 180000,
        headers: { 'Content-Type': 'application/json' },
      });

      console.log(`✅ [DISPATCH] URL_QUALIFICATION accepted | jobId=${job._id}`);
      return { success: true, jobId: job._id, dispatched: true };

    } catch (error) {
      console.error(`[ERROR] URL_QUALIFICATION dispatch failed | jobId=${job._id} | reason="${error.message}"`);

      await jobService.updateJobStatus(job._id, 'FAILED', {
        completed_at: new Date(),
        error_message: `Dispatch failed: ${error.message}`,
      });

      return { success: false, message: 'Failed to dispatch URL_QUALIFICATION job', error: error.message };
    }
  }



  /**
   * Dispatch PROJECT_SEO_AGGREGATION job directly to Python worker via HTTP.
   * F4-016 — PUSH model only reachable if USE_PULL_MODEL is ever toggled
   * off; in PULL mode (the current deployment) chainingEngine never calls
   * this, the job stays 'pending' and main.py's poller claims it directly,
   * same as SEO_SCORING/AI_VISIBILITY.
   */
  async dispatchProjectSeoAggregationJob(job) {
    try {
      const response = await axios.post(`${this.pythonBaseURL}/api/jobs/project-seo-aggregation`, {
        jobId: job._id.toString(),
        projectId: job.project_id.toString(),
        userId: job.user_id ? job.user_id.toString() : null,
        batchId: job.input_data?.batchId,
        sourceJobId: job.input_data?.source_job_id
      }, {
        timeout: 180000,
        headers: { 'Content-Type': 'application/json' }
      });

      return { success: true, jobId: job._id };

    } catch (error) {
      console.error(`[ERROR] PROJECT_SEO_AGGREGATION dispatch failed | jobId=${job._id} | reason="${error.message}"`);

      await jobService.updateJobStatus(job._id, 'FAILED', {
        completed_at: new Date(),
        error_message: `Dispatch failed: ${error.message}`
      });

      return { success: false, message: 'Failed to dispatch PROJECT_SEO_AGGREGATION job', error: error.message };
    }
  }

  /**
   * Dispatch PROJECT_AI_AGGREGATION job directly to Python worker via HTTP.
   * F4-016 — see dispatchProjectSeoAggregationJob's note on PULL vs PUSH.
   */
  async dispatchProjectAiAggregationJob(job) {
    try {
      const response = await axios.post(`${this.pythonBaseURL}/api/jobs/project-ai-aggregation`, {
        jobId: job._id.toString(),
        projectId: job.project_id.toString(),
        userId: job.user_id ? job.user_id.toString() : null,
        batchId: job.input_data?.batchId,
        sourceJobId: job.input_data?.source_job_id
      }, {
        timeout: 180000,
        headers: { 'Content-Type': 'application/json' }
      });

      return { success: true, jobId: job._id };

    } catch (error) {
      console.error(`[ERROR] PROJECT_AI_AGGREGATION dispatch failed | jobId=${job._id} | reason="${error.message}"`);

      await jobService.updateJobStatus(job._id, 'FAILED', {
        completed_at: new Date(),
        error_message: `Dispatch failed: ${error.message}`
      });

      return { success: false, message: 'Failed to dispatch PROJECT_AI_AGGREGATION job', error: error.message };
    }
  }

  /**

   * Get Python worker health status

   */

  async getWorkerHealth() {

    try {

      const response = await axios.get(

        `${this.pythonBaseURL}/health`,

        { timeout: 5000 }

      );

      return { healthy: true, status: response.data };

    } catch (error) {

      return { healthy: false, error: error.message };

    }

  }

}



export default JobDispatcher;

