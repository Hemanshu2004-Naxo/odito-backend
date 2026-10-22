import Job from '../model/Job.js';

import SeoProject from '../../app_user/model/SeoProject.js';

import { JOB_TYPES, JOB_TYPE_CONFIG, getRetryBackoffMs } from '../constants/jobTypes.js';

import mongoose from 'mongoose';



export class JobService {

  /**

   * Create a new job

   * CRITICAL: This is called from controllers, NOT workers

   */

  // F4-018: the duplicate claimJob() definition that used to live here (a
  // second `async claimJob(job_type)` further down in this same class body,
  // originally at what's now the definition below) silently shadowed this
  // one — JavaScript class bodies keep only the LAST method with a given
  // name, so this earlier definition was dead code, never actually called.
  // It intended to reclaim 'retrying' jobs (this one did not), which is
  // exactly the bug fixed below: the surviving claimJob() now correctly
  // reclaims both 'pending' and 'retrying' jobs, with the 'retrying' branch
  // honoring failJob's own computed backoff delay instead of adding an
  // extra unintended 5-minute wait on top of it. See the single claimJob()
  // definition later in this file for the fix and its rationale.



  async createJob({

    user_id,

    seo_project_id,

    jobType,

    input_data = {},

    priority = null,

    run_id = null,

    group_id = null,

    chunk_index = null

  }) {

    // Validate job type

    if (!Object.values(JOB_TYPES).includes(jobType)) {

      throw new Error(`Invalid job type: ${jobType}`);

    }



    // Get config

    const config = JOB_TYPE_CONFIG[jobType];

    const usePullModel = process.env.USE_PULL_MODEL === 'true';



    const job = new Job({

      user_id,

      project_id: seo_project_id,

      entityType: 'project',

      entityId: seo_project_id,

      jobType,

      input_data,

      status: 'pending',  // ALWAYS 'pending' - never 'processing' on creation

      priority: priority || config.priority || 5,

      attempts: 0,

      max_attempts: config.maxAttempts || 3,

      run_id,

      group_id,

      chunk_index,

    });



    // SAFEGUARD: Log mode for debugging
    console.log(`[JOB_CREATION] Creating job | jobType=${jobType} | status=pending | mode=${usePullModel ? 'PULL' : 'PUSH'}`);



    try {

      await job.save();

    } catch (error) {

      console.error(`--- Error saving job to database: ---`);

      console.error(error);

      throw error; // Re-throw the error to ensure the caller knows it failed

    }



    // Update project stats

    await this.updateProjectJobStats(seo_project_id);



    console.log(`✅ Job created: ${job._id} (${jobType})`);

    return job;

  }



  /**

   * Fetch pending jobs for workers

   * Uses atomic operation to prevent race conditions

   */

  async fetchPendingJobs(job_types = [], limit = 10) {

    const query = {

      status: 'pending',

      $or: [

        { claimed_at: { $eq: null } },

        { last_attempted_at: { $lt: new Date(Date.now() - 5 * 60 * 1000) } } // 5 min stale locks

      ]

    };



    if (job_types.length > 0) {

      query.jobType = { $in: job_types };

    }



    console.log('\n--- FETCHING PENDING JOBS ---');

    console.log('Query Filter:', JSON.stringify(query, null, 2));



    try {

      const jobs = await Job.find(query)

        .sort({ priority: -1, created_at: 1 })

        .limit(limit)

        .lean();



      console.log(`Found ${jobs.length} pending job(s):`);

      if (jobs.length > 0) {

        jobs.forEach(job => {

          console.log(`  - Job ID: ${job._id}`);

          console.log(`    Status: ${job.status}`);

          console.log(`    JobType: ${job.jobType}`);

          console.log(`    Priority: ${job.priority}`);

          console.log(`    CreatedAt: ${job.created_at}`);

          console.log(`    ClaimedAt: ${job.claimed_at}`);

          console.log('    ---');

        });

      }

      console.log('--- END FETCH ---\n');



      return jobs;

    } catch (error) {

      console.error('❌ Error in fetchPendingJobs:', error.message);

      console.error('Stack:', error.stack);

      throw error;

    }

  }



  /**

   * Atomically lock a job for processing

   * CRITICAL: This prevents multiple workers from processing same job

   */

  async lockJob(job_id) {

    console.log(`\n--- LOCKING JOB ---`);

    console.log(`Job ID: ${job_id}`);



    const lockQuery = {

      _id: job_id,

      status: 'pending',

      $or: [

        { claimed_at: { $eq: null } },

        { last_attempted_at: { $lt: new Date(Date.now() - 5 * 60 * 1000) } }

      ]

    };



    console.log(`Lock Query:`, JSON.stringify(lockQuery, null, 2));



    try {

      const result = await Job.findOneAndUpdate(

        lockQuery,

        {

          $set: {

            status: 'processing',

            claimed_at: new Date(),

            started_at: new Date(),

            last_attempted_at: new Date()

          }

        },

        { new: true }

      );



      if (result) {

        console.log(`✅ Lock successful!`);

        console.log(`Updated status: ${result.status}`);

        console.log(`StartedAt: ${result.started_at}`);

      } else {

        console.log(`⚠️ Lock failed - job doesn't match query conditions`);

        console.log(`Job may already be locked or not in pending status`);

      }



      console.log(`--- END LOCK ---\n`);

      return result;

    } catch (error) {

      console.error(`❌ Error in lockJob:`, error.message);

      console.error(`Stack:`, error.stack);

      throw error;

    }

  }



  /**

   * Update job status

   */

  async updateJobStatus(job_id, status, data = {}) {

    // Normalize case: several call sites (e.g. dispatchLinkDiscoveryJob,
    // dispatchDomainPerformanceJob) historically passed uppercase status
    // strings ('PROCESSING', 'FAILED'). The Job schema's enum is lowercase
    // ('pending','claimed','processing','completed','failed','retrying'),
    // and findByIdAndUpdate skips Mongoose enum validation by default, so an
    // uppercase string silently persisted as-is — invisible to every
    // lowercase status comparison downstream (this function's own
    // completed_at/failed_at side effects below, and
    // scrapingController.getScrapingStatus's per-jobType counters, which is
    // why "processing" jobs of these types never appeared as Running in the
    // frontend). Normalizing once, here, fixes it at the single choke point
    // every status write flows through.
    const normalizedStatus = typeof status === 'string' ? status.toLowerCase() : status;

    const updateData = {

      status: normalizedStatus,

      ...data

    };



    if (normalizedStatus === 'completed') {

      updateData.completed_at = new Date();

      // Keep claimed_at to preserve when job was processed

    }



    if (normalizedStatus === 'failed') {

      updateData.failed_at = data.failed_at || new Date();

      updateData.last_attempted_at = data.last_attempted_at || new Date();

      updateData.claimed_at = null;

    }



    const job = await Job.findByIdAndUpdate(

      job_id,

      { $set: updateData },

      { new: true }

    );



    // Update project stats

    if (job && job.project_id) {

      await this.updateProjectJobStats(job.project_id);

    }



    return job;

  }



  /**

   * Mark job as failed with error

   */

  async failJob(job_id, error, data = {}) {

    const job = await Job.findById(job_id);

    if (!job) throw new Error('Job not found');



    const newAttempts = (job.attempts || 0) + 1;

    const shouldRetry = newAttempts < job.max_attempts;



    const updateData = {

      attempts: newAttempts,

      error: {

        message: error.message,

        stack: error.stack,

        timestamp: new Date(),

      },

      claimed_at: null,

      last_attempted_at: data.last_attempted_at || new Date(), // ✅ Use provided or current

      ...data

    };



    if (shouldRetry) {

      const delayMs = getRetryBackoffMs(newAttempts);

      updateData.status = 'retrying';

      // This field doesn't exist, but the logic is to delay the next attempt.

      // A worker query against `last_attempted_at` will handle this.

      updateData.last_attempted_at = new Date(Date.now() + delayMs);

      console.log(`⚠️ Job ${job_id} failed. Retrying in ${delayMs / 1000} seconds (attempt ${newAttempts}/${job.max_attempts})`);

    } else {

      updateData.status = 'failed';

      updateData.failed_at = data.failed_at || new Date(); // ✅ Use provided or current

      console.error(`❌ Job ${job_id} failed permanently after ${newAttempts} attempts`);

    }



    // Perform a single, atomic update for the failed job

    const updatedJob = await Job.findByIdAndUpdate(

      job_id,

      { $set: updateData },

      { new: true }

    );



    if (updatedJob && updatedJob.project_id) {

      await this.updateProjectJobStats(updatedJob.project_id);

    }



    return updatedJob;

  }



  /**

   * Get jobs by project

   */

  async getJobsByProject(seo_project_id, filters = {}) {

    const query = { project_id: seo_project_id, ...filters };

    return await Job.find(query)

      .sort({ created_at: -1 })

      .lean();

  }



  /**

   * Get single job by ID

   */

  async getJobById(job_id) {

    return await Job.findById(job_id).lean();

  }



  /**

   * Get job statistics for a project

   */

  async getJobStats(seo_project_id) {

    return await Job.aggregate([

      { $match: { project_id: seo_project_id } },

      {

        $group: {

          _id: '$status',

          count: { $sum: 1 }

        }

      }

    ]);

  }



  /**

   * Get job statistics by type

   */

  async getJobStatsByType(seo_project_id) {

    return await Job.aggregate([

      { $match: { project_id: seo_project_id } },

      {

        $group: {

          _id: { job_type: '$jobType', job_status: '$status' },

          count: { $sum: 1 }

        }

      }

    ]);

  }



  /**

   * Update project job statistics

   */

  async updateProjectJobStats(seo_project_id) {

    try {

      const stats = await Job.aggregate([

        { $match: { project_id: seo_project_id } },

        {

          $group: {

            _id: '$status',

            count: { $sum: 1 }

          }

        }

      ]);



      // Get the project to include keyword count

      const project = await SeoProject.findById(seo_project_id);



      const jobStats = {

        totalJobs: 0,

        pendingJobs: 0,

        processingJobs: 0,

        completedJobs: 0,

        failedJobs: 0,

        keywordCount: project ? project.keywords.length : 0

      };



      stats.forEach(stat => {

        jobStats.totalJobs += stat.count;

        if (stat._id === 'pending') jobStats.pendingJobs = stat.count;

        if (stat._id === 'processing') jobStats.processingJobs = stat.count;

        if (stat._id === 'completed') jobStats.completedJobs = stat.count;

        if (stat._id === 'failed') jobStats.failedJobs = stat.count;

      });



      await SeoProject.findByIdAndUpdate(seo_project_id, {

        $set: { jobStats, lastJobRunAt: new Date() }

      });



      return jobStats;

    } catch (error) {

      console.error(`Failed to update job stats for project ${projectId}:`, error);

      return null;

    }

  }



  /**

   * Retry a failed job

   */

  async retryJob(job_id) {

    const job = await Job.findById(job_id);



    if (!job) throw new Error('Job not found');

    if (job.job_status !== 'failed') throw new Error('Only failed jobs can be retried');



    const updatedJob = await Job.findByIdAndUpdate(

      job_id,

      {

        $set: {

          job_status: 'pending',

          attempts: 0,

          error: null,

        }

      },

      { new: true }

    );



    return updatedJob;

  }



  /**

   * Delete old completed jobs (cleanup)

   */

  async deleteOldCompletedJobs(daysOld = 30) {

    const cutoffDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);



    const result = await Job.deleteMany({

      status: 'completed',

      completed_at: { $lt: cutoffDate }

    });



    return result;

  }



  /**

   * Atomically create and dispatch PERFORMANCE_MOBILE job

   * CRITICAL: This operation must be atomic to prevent duplicates

   */

  async createAndDispatchPerformanceMobileJob(pageScrapingJob) {

    try {

      console.log(`[DEBUG] createAndDispatchPerformanceMobileJob called with pageScrapingJob._id=${pageScrapingJob._id}`);



      // Create PERFORMANCE_MOBILE job with source job reference

      const performanceMobileJob = await this.createJob({

        user_id: pageScrapingJob.user_id,

        seo_project_id: pageScrapingJob.project_id,

        jobType: JOB_TYPES.PERFORMANCE_MOBILE,

        input_data: {

          source_job_id: pageScrapingJob._id.toString()

        },

        run_id: pageScrapingJob.run_id,

        priority: JOB_TYPE_CONFIG[JOB_TYPES.PERFORMANCE_MOBILE].priority

      });



      console.log(`[QUEUE] PERFORMANCE_MOBILE job queued | jobId=${performanceMobileJob._id} | sourceJobId=${pageScrapingJob._id}`);



      return performanceMobileJob;



    } catch (error) {

      console.error(`[ERROR] PERFORMANCE_MOBILE creation failed | sourceJobId=${pageScrapingJob._id} | reason="${error.message}"`);

      console.error(`[ERROR] Full error stack: ${error.stack}`);

      throw error;

    }

  }



  /**

   * Atomically create and dispatch PERFORMANCE_DESKTOP job

   * CRITICAL: This operation must be atomic to prevent duplicates

   */

  async createAndDispatchPerformanceDesktopJob(pageScrapingJob) {

    try {

      console.log(`[DEBUG] createAndDispatchPerformanceDesktopJob called with pageScrapingJob._id=${pageScrapingJob._id}`);



      // Create PERFORMANCE_DESKTOP job with source job reference

      const performanceDesktopJob = await this.createJob({

        user_id: pageScrapingJob.user_id,

        seo_project_id: pageScrapingJob.project_id,

        jobType: JOB_TYPES.PERFORMANCE_DESKTOP,

        input_data: {

          source_job_id: pageScrapingJob._id.toString()

        },

        run_id: pageScrapingJob.run_id,

        priority: JOB_TYPE_CONFIG[JOB_TYPES.PERFORMANCE_DESKTOP].priority

      });



      console.log(`[QUEUE] PERFORMANCE_DESKTOP job queued | jobId=${performanceDesktopJob._id} | sourceJobId=${pageScrapingJob._id}`);



      return performanceDesktopJob;



    } catch (error) {

      console.error(`[ERROR] PERFORMANCE_DESKTOP creation failed | sourceJobId=${pageScrapingJob._id} | reason="${error.message}"`);

      console.error(`[ERROR] Full error stack: ${error.stack}`);

      throw error;

    }

  }



  /**

   * Atomically create and dispatch HEADLESS_ACCESSIBILITY job

   * CRITICAL: This operation must be atomic to prevent duplicates

   * Simplified to use projectId for URL retrieval instead of source_job_id dependency

   */

  async createAndDispatchUrlQualificationJob(linkDiscoveryJob) {
    try {
      console.log(`[DEBUG] createAndDispatchUrlQualificationJob called | sourceJobId=${linkDiscoveryJob._id}`);

      const urlQualJob = await this.createJob({
        user_id: linkDiscoveryJob.user_id,
        seo_project_id: linkDiscoveryJob.project_id,
        jobType: JOB_TYPES.URL_QUALIFICATION,
        input_data: {
          source_job_id: linkDiscoveryJob._id.toString(),
          projectId: linkDiscoveryJob.project_id.toString(),
          // Host canonicalization: forward the exact host LINK_DISCOVERY
          // already resolved so URL_QUALIFICATION folds any stray www/non-www
          // (or other host-alias) duplicate onto it before qualifying/probing.
          canonical_host: linkDiscoveryJob.result_data?.canonicalHost || null
        },
        priority: JOB_TYPE_CONFIG[JOB_TYPES.URL_QUALIFICATION].priority,
        run_id: linkDiscoveryJob.run_id
      });

      console.log(`[QUEUE] URL_QUALIFICATION job queued | jobId=${urlQualJob._id} | sourceJobId=${linkDiscoveryJob._id}`);
      return urlQualJob;

    } catch (error) {
      console.error(`[ERROR] URL_QUALIFICATION creation failed | sourceJobId=${linkDiscoveryJob._id} | reason="${error.message}"`);
      throw error;
    }
  }



  async createAndDispatchHeadlessAccessibilityJob(urlQualificationJob) {

    try {

      console.log(`[DEBUG] createAndDispatchHeadlessAccessibilityJob called with sourceJobId=${urlQualificationJob._id}`);

      // canonical_urls forwarded from URL_QUALIFICATION via _canonicalUrls property
      const canonicalUrls = urlQualificationJob._canonicalUrls || [];

      const headlessA11yJob = await this.createJob({

        user_id: urlQualificationJob.user_id,

        seo_project_id: urlQualificationJob.project_id,

        jobType: JOB_TYPES.HEADLESS_ACCESSIBILITY,

        input_data: {

          source_job_id: urlQualificationJob._id.toString(),

          projectId: urlQualificationJob.project_id.toString(),

          canonical_urls: canonicalUrls

        },

        priority: JOB_TYPE_CONFIG[JOB_TYPES.HEADLESS_ACCESSIBILITY].priority,

        run_id: urlQualificationJob.run_id

      });



      console.log(`[QUEUE] HEADLESS_ACCESSIBILITY job queued | jobId=${headlessA11yJob._id} | sourceJobId=${urlQualificationJob._id} | canonicalUrls=${canonicalUrls.length}`);



      return headlessA11yJob;



    } catch (error) {

      console.error(`[ERROR] HEADLESS_ACCESSIBILITY creation failed | sourceJobId=${urlQualificationJob._id} | reason="${error.message}"`);

      console.error(`[ERROR] Full error stack: ${error.stack}`);

      throw error;

    }

  }



  /**

   * Atomically create and dispatch CRAWL_GRAPH job

   * CRITICAL: This is a pure computation step — no HTTP crawling

   */

  async createAndDispatchCrawlGraphJob(pageScrapingJob) {

    try {

      console.log(`[DEBUG] createAndDispatchCrawlGraphJob called with pageScrapingJob._id=${pageScrapingJob._id}`);

      const crawlGraphJob = await this.createJob({

        user_id: pageScrapingJob.user_id,

        seo_project_id: pageScrapingJob.project_id,

        jobType: JOB_TYPES.CRAWL_GRAPH,

        input_data: {

          source_job_id: pageScrapingJob._id.toString(),

          // Propagate mode so chainingEngine can detect verification mode
          // and skip the PERFORMANCE_MOBILE/PERFORMANCE_DESKTOP chain.
          ...(pageScrapingJob.input_data?.mode ? { mode: pageScrapingJob.input_data.mode } : {})

        },

        priority: JOB_TYPE_CONFIG[JOB_TYPES.CRAWL_GRAPH].priority,

        run_id: pageScrapingJob.run_id

      });



      console.log(`[QUEUE] CRAWL_GRAPH job queued | jobId=${crawlGraphJob._id} | sourceJobId=${pageScrapingJob._id}`);



      return crawlGraphJob;



    } catch (error) {

      console.error(`[ERROR] CRAWL_GRAPH creation failed | sourceJobId=${pageScrapingJob._id} | reason="${error.message}"`);

      console.error(`[ERROR] Full error stack: ${error.stack}`);

      throw error;

    }

  }



  /**

   * Atomically create and dispatch PAGE_ANALYSIS job

   * CRITICAL: This operation must be atomic to prevent duplicates

   */

  async createAndDispatchPageAnalysisJob(pageScrapingJob) {

    try {

      // Create PAGE_ANALYSIS job with source job reference

      // P3-003: propagate mode/target_url/urls from the source job when this
      // is a url_verification run, so PAGE_ANALYSIS's existing (Phase 2,
      // previously dormant) `urls` filter actually narrows to the one page
      // being verified. Full Audit and legacy 'verification' mode are
      // unaffected — isUrlVerification is false for both, so input_data
      // is byte-identical to before.
      const isUrlVerification = pageScrapingJob.input_data?.mode === 'url_verification';

      const pageAnalysisJob = await this.createJob({

        user_id: pageScrapingJob.user_id,

        seo_project_id: pageScrapingJob.project_id,

        jobType: JOB_TYPES.PAGE_ANALYSIS,

        input_data: {

          source_job_id: pageScrapingJob._id.toString(),

          ...(isUrlVerification && {
            mode: 'url_verification',
            target_url: pageScrapingJob.input_data.target_url,
            urls: [pageScrapingJob.input_data.target_url],
            // F4-016: propagate batchId the same way target_url/urls already
            // are — without this, PAGE_ANALYSIS (and everything chained from
            // it) has no way to know it's part of a Verification Batch.
            ...(pageScrapingJob.input_data.batchId && { batchId: pageScrapingJob.input_data.batchId }),
          }),

        },

        run_id: pageScrapingJob.run_id,

        priority: JOB_TYPE_CONFIG[JOB_TYPES.PAGE_ANALYSIS].priority

      });



      console.log(`[QUEUE] PAGE_ANALYSIS job queued | jobId=${pageAnalysisJob._id} | sourceJobId=${pageScrapingJob._id}`);



      return pageAnalysisJob;



    } catch (error) {

      console.error(`[ERROR] PAGE_ANALYSIS creation failed | sourceJobId=${pageScrapingJob._id} | reason="${error.message}"`);

      throw error;

    }

  }



  /**

   * Atomically create and dispatch SEO_SCORING job

   * CRITICAL: This operation must be atomic to prevent duplicates

   */

  async createAndDispatchSeoScoringJob(pageAnalysisJob) {

    try {

      // Create SEO_SCORING job with source job reference

      // P3-003: propagate mode/target_url/urls from PAGE_ANALYSIS (its own
      // immediate parent, already carrying these fields when it was itself
      // created with the propagation added above) so SEO_SCORING's Phase 2
      // `urls` filter narrows to the one page being verified.
      const isUrlVerification = pageAnalysisJob.input_data?.mode === 'url_verification';

      const seoScoringJob = await this.createJob({

        user_id: pageAnalysisJob.user_id,

        seo_project_id: pageAnalysisJob.project_id,

        jobType: JOB_TYPES.SEO_SCORING,

        input_data: {

          source_job_id: pageAnalysisJob._id.toString(),

          ...(isUrlVerification && {
            mode: 'url_verification',
            target_url: pageAnalysisJob.input_data.target_url,
            urls: [pageAnalysisJob.input_data.target_url],
            // F4-016: propagate batchId (see PAGE_ANALYSIS's own identical comment above).
            ...(pageAnalysisJob.input_data.batchId && { batchId: pageAnalysisJob.input_data.batchId }),
          }),

        },

        run_id: pageAnalysisJob.run_id,

        priority: JOB_TYPE_CONFIG[JOB_TYPES.SEO_SCORING].priority

      });



      console.log(`[QUEUE] SEO_SCORING job queued | jobId=${seoScoringJob._id} | sourceJobId=${pageAnalysisJob._id}`);



      return seoScoringJob;



    } catch (error) {

      console.error(`[ERROR] SEO_SCORING creation failed | sourceJobId=${pageAnalysisJob._id} | reason="${error.message}"`);

      throw error;

    }

  }



  /**

   * Atomically create and dispatch AI_VISIBILITY job

   * CRITICAL: This operation must be atomic to prevent duplicates

   * Now accepts PAGE_SCRAPING job as source

   */

  async createAndDispatchAiVisibilityJob(urlQualificationJob) {

    const canonicalUrls = urlQualificationJob._canonicalUrls || urlQualificationJob.input_data?.canonical_urls || [];

    // P3-003: propagate mode/target_url/urls from PAGE_SCRAPING (this
    // function's source job, per pipelineConfig.js's PAGE_SCRAPING -> parallel
    // (CRAWL_GRAPH, AI_VISIBILITY)) so AI_VISIBILITY's Phase 2 `urls` filter
    // narrows to the one page being verified. Note: canonical_urls above is
    // a separate, legacy field the Python AI_VISIBILITY worker does not read
    // (confirmed: execute_ai_visibility_v2 reads job.urls) — kept unchanged
    // for whatever else may rely on it; `urls` is the field that actually
    // activates filtering.
    const isUrlVerification = urlQualificationJob.input_data?.mode === 'url_verification';

    console.log("Creating AI_VISIBILITY job", {

      projectId: urlQualificationJob.project_id,

      sourceJobId: urlQualificationJob._id,

      canonicalUrls: canonicalUrls.length

    });



    const aiVisibilityJob = await this.createJob({

      user_id: urlQualificationJob.user_id,

      seo_project_id: urlQualificationJob.project_id,

      jobType: JOB_TYPES.AI_VISIBILITY,

      input_data: {

        source_job_id: urlQualificationJob._id.toString(),

        canonical_urls: canonicalUrls,

        ...(isUrlVerification && {
          mode: 'url_verification',
          target_url: urlQualificationJob.input_data.target_url,
          urls: [urlQualificationJob.input_data.target_url],
          // F4-016: propagate batchId (see PAGE_ANALYSIS's own identical comment above).
          ...(urlQualificationJob.input_data.batchId && { batchId: urlQualificationJob.input_data.batchId }),
        }),

      },

      priority: JOB_TYPE_CONFIG[JOB_TYPES.AI_VISIBILITY].priority,

      run_id: urlQualificationJob.run_id

    });



    console.log(

      `[QUEUE] AI_VISIBILITY job queued | jobId=${aiVisibilityJob._id} | sourceJobId=${urlQualificationJob._id} | canonicalUrls=${canonicalUrls.length}`

    );



    return aiVisibilityJob;

  }



  async createAndDispatchPageScrapingJob(urlQualificationJob) {

    try {

      // canonical_urls forwarded from URL_QUALIFICATION via _canonicalUrls property.
      // Workers consume this list directly — no second DB read needed.
      const canonicalUrls = urlQualificationJob._canonicalUrls || [];

      const pageScrapingJob = await this.createJob({

        user_id: urlQualificationJob.user_id,

        seo_project_id: urlQualificationJob.project_id,

        jobType: JOB_TYPES.PAGE_SCRAPING,

        input_data: {

          source_job_id: urlQualificationJob._id.toString(),

          canonical_urls: canonicalUrls

        },

        priority: JOB_TYPE_CONFIG[JOB_TYPES.PAGE_SCRAPING].priority,

        run_id: urlQualificationJob.run_id

      });



      console.log(`[QUEUE] PAGE_SCRAPING job queued | jobId=${pageScrapingJob._id} | canonicalUrls=${canonicalUrls.length}`);



      return pageScrapingJob;



    } catch (error) {

      console.error(`[ERROR] PAGE_SCRAPING creation failed | sourceJobId=${urlQualificationJob._id} | reason="${error.message}"`);

      throw error;

    }

  }



  /**
   * F4-016: Create the PROJECT_SEO_AGGREGATION job that starts a
   * Verification Batch's project-level aggregation chain. Unlike every
   * other createAndDispatchXXXJob above, this has no "source job" — it is
   * created directly by chainingEngine's batch barrier once every
   * PageVerificationRun in the batch has reached a terminal state, not in
   * response to another job's completion. Exactly-once is guaranteed by the
   * barrier's own atomic RUNNING -> AGGREGATING transition (only the caller
   * that wins that transition ever reaches this method for a given batch).
   */
  async createAndDispatchProjectSeoAggregationJob({ projectId, batchId, userId = null }) {
    const job = await this.createJob({
      user_id: userId,
      seo_project_id: projectId,
      jobType: JOB_TYPES.PROJECT_SEO_AGGREGATION,
      input_data: { batchId },
      priority: JOB_TYPE_CONFIG[JOB_TYPES.PROJECT_SEO_AGGREGATION].priority
    });

    console.log(`[QUEUE] PROJECT_SEO_AGGREGATION job queued | jobId=${job._id} | batchId=${batchId}`);
    return job;
  }

  /**
   * F4-016: Create PROJECT_AI_AGGREGATION from the completed
   * PROJECT_SEO_AGGREGATION job (its source, via JOB_CREATION_MAP/
   * chainingEngine.process — the normal chaining path every other job type
   * in this file already uses).
   */
  async createAndDispatchProjectAiAggregationJob(projectSeoAggregationJob) {
    const job = await this.createJob({
      user_id: projectSeoAggregationJob.user_id,
      seo_project_id: projectSeoAggregationJob.project_id,
      jobType: JOB_TYPES.PROJECT_AI_AGGREGATION,
      input_data: {
        source_job_id: projectSeoAggregationJob._id.toString(),
        batchId: projectSeoAggregationJob.input_data?.batchId
      },
      priority: JOB_TYPE_CONFIG[JOB_TYPES.PROJECT_AI_AGGREGATION].priority
    });

    console.log(`[QUEUE] PROJECT_AI_AGGREGATION job queued | jobId=${job._id} | sourceJobId=${projectSeoAggregationJob._id} | batchId=${job.input_data.batchId}`);
    return job;
  }

  /**
   * F4-016: Create PROJECT_TASK_VERIFICATION from the completed
   * PROJECT_AI_AGGREGATION job. Node-self-processed (see
   * chainingEngine._runProjectTaskVerificationJob) — this method only
   * creates the Job document (status 'pending', for observability/retry
   * tracking); chainingEngine runs the actual verification logic itself
   * instead of dispatching to Python.
   */
  async createAndDispatchProjectTaskVerificationJob(projectAiAggregationJob) {
    const job = await this.createJob({
      user_id: projectAiAggregationJob.user_id,
      seo_project_id: projectAiAggregationJob.project_id,
      jobType: JOB_TYPES.PROJECT_TASK_VERIFICATION,
      input_data: {
        source_job_id: projectAiAggregationJob._id.toString(),
        batchId: projectAiAggregationJob.input_data?.batchId
      },
      priority: JOB_TYPE_CONFIG[JOB_TYPES.PROJECT_TASK_VERIFICATION].priority
    });

    console.log(`[QUEUE] PROJECT_TASK_VERIFICATION job queued | jobId=${job._id} | sourceJobId=${projectAiAggregationJob._id} | batchId=${job.input_data.batchId}`);
    return job;
  }

  /**
   * Phase 6.3: Create GOOGLE_ADS_SYNC. Node-self-processed, same shape as
   * createAndDispatchProjectTaskVerificationJob above — this method only
   * creates the Job document (status 'pending'); the caller (currently only
   * googleAdsController's refresh endpoint — this job type is never chained
   * from another job) is responsible for actually running it via
   * googleAdsSyncService.runGoogleAdsSync(job), exactly like chainingEngine
   * explicitly calls _runProjectTaskVerificationJob right after creating
   * that job, rather than this method triggering execution itself.
   */
  async createAndDispatchGoogleAdsSyncJob(userId, projectId, connectionId, customerId) {
    const job = await this.createJob({
      user_id: userId,
      seo_project_id: projectId,
      jobType: JOB_TYPES.GOOGLE_ADS_SYNC,
      input_data: { connectionId, customerId },
      priority: JOB_TYPE_CONFIG[JOB_TYPES.GOOGLE_ADS_SYNC].priority
    });

    console.log(`[QUEUE] GOOGLE_ADS_SYNC job queued | jobId=${job._id} | projectId=${projectId} | customerId=${customerId}`);
    return job;
  }

  /**
   * Phase 6.4: Create GOOGLE_ADS_KEYWORD_SYNC. Same shape as
   * createAndDispatchGoogleAdsSyncJob above - only creates the Job
   * document; the caller (googleAdsController's keyword refresh endpoint)
   * runs it via googleAdsSyncService.runGoogleAdsKeywordSync(job).
   */
  async createAndDispatchGoogleAdsKeywordSyncJob(userId, projectId, connectionId, customerId) {
    const job = await this.createJob({
      user_id: userId,
      seo_project_id: projectId,
      jobType: JOB_TYPES.GOOGLE_ADS_KEYWORD_SYNC,
      input_data: { connectionId, customerId },
      priority: JOB_TYPE_CONFIG[JOB_TYPES.GOOGLE_ADS_KEYWORD_SYNC].priority
    });

    console.log(`[QUEUE] GOOGLE_ADS_KEYWORD_SYNC job queued | jobId=${job._id} | projectId=${projectId} | customerId=${customerId}`);
    return job;
  }

  /**
   * Phase 6.4: Create GOOGLE_ADS_RECOMMENDATION_SYNC. Same shape - the
   * caller runs it via googleAdsSyncService.runGoogleAdsRecommendationSync(job).
   */
  async createAndDispatchGoogleAdsRecommendationSyncJob(userId, projectId, connectionId, customerId) {
    const job = await this.createJob({
      user_id: userId,
      seo_project_id: projectId,
      jobType: JOB_TYPES.GOOGLE_ADS_RECOMMENDATION_SYNC,
      input_data: { connectionId, customerId },
      priority: JOB_TYPE_CONFIG[JOB_TYPES.GOOGLE_ADS_RECOMMENDATION_SYNC].priority
    });

    console.log(`[QUEUE] GOOGLE_ADS_RECOMMENDATION_SYNC job queued | jobId=${job._id} | projectId=${projectId} | customerId=${customerId}`);
    return job;
  }



  /**

   * Atomically dispatch a job (prevents duplicates)

   * CRITICAL: This is the single point of dispatch control

   * Uses findOneAndUpdate with status guard for atomic operation

   */

  async atomicallyDispatchJob(jobId) {

    const Job = mongoose.model('Job');

    const usePullModel = process.env.USE_PULL_MODEL === 'true';



    // SAFEGUARD: Prevent dispatch in PULL model

    if (usePullModel) {

      console.error(`[DISPATCH] ❌ CRITICAL: atomicallyDispatchJob called in PULL mode | jobId=${jobId} | This should NEVER happen!`);

      console.error(`[DISPATCH] Jobs should remain 'pending' for workers to claim. Skipping dispatch.`);

      return null;

    }



    console.log(`[DISPATCH] Atomic dispatch requested | jobId=${jobId}`);



    // Atomic operation: find PENDING job and mark as DISPATCHED

    // Status guard prevents duplicate dispatch of same job

    const job = await Job.findOneAndUpdate(

      {

        _id: jobId,

        status: 'pending',           // CRITICAL: Only dispatch pending jobs

        dispatchedAt: null           // CRITICAL: Never dispatched before

      },

      {

        $set: {

          status: 'processing',      // Mark as processing

          dispatchedAt: new Date(),  // Track dispatch time

          started_at: new Date(),

          last_attempted_at: new Date()

        }

      },

      { new: true }                  // Return updated document

    );



    if (job) {

      console.log(`[DISPATCH] Atomic dispatch successful | jobId=${jobId} | dispatchedAt=${job.dispatchedAt}`);

    } else {

      console.log(`[DISPATCH] Atomic dispatch failed | jobId=${jobId} | job already dispatched or not pending`);

    }



    return job; // null if already dispatched/processed

  }



  /**

   * Update project statistics after PAGE_ANALYSIS completion

   */

  async updateProjectStatsAfterAnalysis(projectId, analysisStats) {

    try {

      const project = await SeoProject.findById(projectId);

      if (!project) {

        throw new Error('Project not found');

      }



      // Update project with analysis completion stats

      await SeoProject.findByIdAndUpdate(projectId, {

        $set: {

          'jobStats.total_pages': analysisStats.totalPages || 0,

          'jobStats.total_issues': analysisStats.issuesFound || 0,

          'jobStats.updated_at': new Date(),

          'lastAnalysisAt': new Date()

        }

      });



      return {

        success: true,

        message: 'Project stats updated after analysis'

      };

    } catch (error) {

      console.error(`[ERROR] Project stats update failed | projectId=${projectId} | reason="${error.message}"`);

      throw error;

    }

  }



  /**

   * Update project with crawl summary data

   */

  async updateProjectStats(projectId, updateData) {

    try {

      console.log("🔍 [DEBUG] Updating project with:", updateData);

      console.log("🔍 [DEBUG] last_crawl_summary value:", updateData.last_crawl_summary);

      console.log("🔍 [DEBUG] last_crawl_summary type:", typeof updateData.last_crawl_summary);



      const project = await SeoProject.findByIdAndUpdate(

        projectId,

        { $set: updateData },

        { new: true }

      );



      console.log("🔍 [DEBUG] After update DB value:", project.last_crawl_summary);

      console.log("🔍 [DEBUG] Full project object keys:", Object.keys(project.toObject()));



      return project;

    } catch (error) {

      console.error(`[ERROR] Project update failed | projectId=${projectId} | reason="${error.message}"`);

      throw error;

    }

  }



  /**

   * Get comprehensive job statistics for a project by job type

   */

  async getComprehensiveJobStats(projectId) {

    try {

      const jobs = await Job.find({

        project_id: projectId,

        status: 'completed'

      }).sort({ created_at: 1 }).lean();



      const stats = {

        LINK_DISCOVERY: null,

        PAGE_SCRAPING: null,

        PAGE_ANALYSIS: null,

        crawlDuration: 0

      };



      jobs.forEach(job => {

        if (job.jobType === 'LINK_DISCOVERY' && job.result_data) {

          stats.LINK_DISCOVERY = {

            totalUrlsFound: job.result_data.totalUrlsFound || 0,

            internalLinksCount: job.result_data.internalLinksCount || 0,

            externalLinksCount: 0,  // External links disabled

            socialLinksCount: job.result_data.socialLinksCount || 0,

            created_at: job.created_at,

            completed_at: job.completed_at

          };

        }



        if (job.jobType === 'PAGE_SCRAPING' && job.result_data) {

          // PAGE_SCRAPING is chunked (JobGroup architecture) — there can be
          // N completed jobs for one run, not one. Aggregate across all of
          // them instead of overwriting with whichever job this forEach
          // happens to visit last (previously: only the most-recently-
          // created chunk's numbers survived, silently discarding every
          // other chunk's contribution).
          const existing = stats.PAGE_SCRAPING || {
            totalUrls: 0, successfulPages: 0, failedPages: 0,
            created_at: job.created_at, completed_at: job.completed_at
          };

          stats.PAGE_SCRAPING = {
            totalUrls: existing.totalUrls + (job.result_data.totalUrls || 0),
            successfulPages: existing.successfulPages + (job.result_data.successfulPages || 0),
            failedPages: existing.failedPages + (job.result_data.failedPages || 0),
            created_at: job.created_at < existing.created_at ? job.created_at : existing.created_at,
            completed_at: job.completed_at > existing.completed_at ? job.completed_at : existing.completed_at
          };
          stats.PAGE_SCRAPING.successRate = stats.PAGE_SCRAPING.totalUrls > 0
            ? Math.round((stats.PAGE_SCRAPING.successfulPages / stats.PAGE_SCRAPING.totalUrls) * 100)
            : 0;

        }



        if (job.jobType === 'PAGE_ANALYSIS' && job.result_data) {

          stats.PAGE_ANALYSIS = {

            pagesAnalyzed: job.result_data.pagesAnalyzed || 0,

            issuesFound: job.result_data.issuesFound || 0,

            failedAnalyses: job.result_data.failedAnalyses || 0,

            created_at: job.created_at,

            completed_at: job.completed_at

          };

        }

      });



      // Calculate crawl duration from first LINK_DISCOVERY to last PAGE_ANALYSIS

      if (stats.LINK_DISCOVERY?.created_at && stats.PAGE_ANALYSIS?.completed_at) {

        stats.crawlDuration = Math.round(

          (new Date(stats.PAGE_ANALYSIS.completed_at) - new Date(stats.LINK_DISCOVERY.created_at)) / 1000

        );

      }



      return stats;

    } catch (error) {

      console.error(`[ERROR] Failed to get comprehensive job stats | projectId=${projectId} | reason="${error.message}"`);

      return null;

    }

  }



  /**

   * Enhance crawl summary with derived values from job data

   */

  async enhanceCrawlSummary(projectId, crawlSummary) {

    try {

      const jobStats = (await this.getComprehensiveJobStats(projectId)) || {};

      if (!jobStats.LINK_DISCOVERY && !jobStats.PAGE_SCRAPING && !jobStats.PAGE_ANALYSIS) {

        console.log(`[WARNING] No job stats available for enhancement | projectId=${projectId}`);

      }



      let discoveredTotal, internalLinks, externalLinks, socialLinks;

      let crawledSuccessful, crawledFailed, crawledTotal, pagesAnalyzed;

      // Original logic for SEO projects (external links disabled)
        discoveredTotal = (jobStats.LINK_DISCOVERY?.internalLinksCount || 0) +
          (jobStats.LINK_DISCOVERY?.socialLinksCount || 0);



        // Create enhanced summary object

        const baseDiscoveredLinks = crawlSummary?.discovered_links || {};

        const baseCrawledPages = crawlSummary?.crawled_pages || {};

        const baseAnalysisResults = crawlSummary?.analysis_results || {};

        const baseTiming = crawlSummary?.timing || {};



        const resolveCount = (primary, fallback = 0) => (

          typeof primary === 'number' && primary > 0 ? primary : (fallback || 0)

        );



        const resolveDiscoveredCount = (primary, legacy, fallback = 0) => {

          if (typeof primary === 'number' && primary > 0) return primary;

          if (typeof legacy === 'number' && legacy > 0) return legacy;

          return fallback || 0;

        };



        const resolveDuration = (primary, fallback = 0) => (

          typeof primary === 'number' && primary > 0 ? primary : (fallback || 0)

        );



        internalLinks = resolveDiscoveredCount(

          baseDiscoveredLinks.internal_links,

          baseDiscoveredLinks.internal,

          jobStats.LINK_DISCOVERY?.internalLinksCount ?? 0

        );

        externalLinks = 0;  // External links disabled

        socialLinks = resolveDiscoveredCount(

          baseDiscoveredLinks.social_links,

          baseDiscoveredLinks.social,

          jobStats.LINK_DISCOVERY?.socialLinksCount ?? 0

        );



        crawledSuccessful = resolveCount(baseCrawledPages.successful, jobStats.PAGE_SCRAPING?.successfulPages ?? 0);

        crawledFailed = resolveCount(baseCrawledPages.failed, jobStats.PAGE_SCRAPING?.failedPages ?? 0);

        crawledTotal = resolveCount(

          baseCrawledPages.total,

          jobStats.PAGE_SCRAPING?.totalUrls ?? (crawledSuccessful + crawledFailed)

        );

        pagesAnalyzed = resolveCount(baseAnalysisResults.pages_analyzed, jobStats.PAGE_ANALYSIS?.pagesAnalyzed ?? crawledSuccessful);



      const computedCrawlSuccessRate = crawledTotal > 0

        ? Math.round((crawledSuccessful / crawledTotal) * 100)

        : (crawlSummary?.crawled_pages?.success_rate ?? jobStats.PAGE_SCRAPING?.successRate ?? 100);



      const totalDurationMs = crawlSummary?.timing?.total_crawl_duration_ms ?? (jobStats.crawlDuration * 1000) ?? 0;



      const derivedAnalysisDurationMs = jobStats.PAGE_ANALYSIS?.created_at && jobStats.PAGE_ANALYSIS?.completed_at

        ? Math.max(0, new Date(jobStats.PAGE_ANALYSIS.completed_at) - new Date(jobStats.PAGE_ANALYSIS.created_at))

        : 0;



      const pageAnalysisDurationMs = crawlSummary?.timing?.page_analysis_duration_ms ?? derivedAnalysisDurationMs;



      const enhancedSummary = {

        ...crawlSummary,

        // Ensure discovered_links section exists and is complete

        discovered_links: {

          total: discoveredTotal,

          internal_links: internalLinks,

          external_links: externalLinks,

          social_links: socialLinks

        },

        // Ensure crawled_pages section exists and is complete

        crawled_pages: {

          total: crawledTotal,

          successful: crawledSuccessful,

          failed: crawledFailed,

          success_rate: computedCrawlSuccessRate

        },

        // Ensure analysis_results section exists and is complete

        analysis_results: {

          pages_analyzed: pagesAnalyzed,

          issues_found: crawlSummary?.analysis_results?.issues_found ?? 0,

          failed_analyses: crawlSummary?.analysis_results?.failed_analyses ?? 0

        },

        // Ensure timing section exists and is complete

        timing: {

          total_crawl_duration_ms: totalDurationMs,

          page_analysis_duration_ms: pageAnalysisDurationMs

        }

      };



      // SAFETY LOGGING: Log before and after enhancement for verification

      console.log(`[SAFETY] Original crawlSummary | projectId=${projectId} | data=${JSON.stringify(crawlSummary, null, 2)}`);

      console.log(`[SAFETY] Enhanced summary | projectId=${projectId} | data=${JSON.stringify(enhancedSummary, null, 2)}`);



      console.log(`[API] Enhanced crawl summary | projectId=${projectId} | discovered=${enhancedSummary.discovered_links.total} | crawled=${enhancedSummary.crawled_pages.successful} | analyzed=${enhancedSummary.analysis_results.pages_analyzed}`);



      return enhancedSummary;

    } catch (error) {

      console.error(`[ERROR] Failed to enhance crawl summary | projectId=${projectId} | reason="${error.message}"`);

      return crawlSummary;

    }

  }



  /**
   * Clean up stale locks (jobs locked in 'processing' but never completed,
   * e.g. a worker crashed mid-job) after lockTimeoutMs has elapsed.
   *
   * F4-018: previously this forced every matched job straight to 'failed'
   * via a raw Job.updateMany, bypassing failJob's own retry-vs-permanent
   * decision AND the entire chunk-outcome/url_verification/batch-scoped/
   * full-audit branching chainingEngine and the live /fail HTTP callback
   * already apply to a real-time failure — meaning a stale PROJECT_SEO_
   * AGGREGATION/PROJECT_AI_AGGREGATION job (or a stale chunk) recovered by
   * this sweep never advanced its downstream chain, and a Verification
   * Batch could get stuck in AGGREGATING forever.
   *
   * Now routes each stale job through the SAME shared path as a real-time
   * failure: this.failJob() (respects max_attempts — a job with attempts
   * remaining goes to 'retrying', where the fixed claimJob() will correctly
   * reclaim it once its backoff delay elapses, not straight to permanently
   * 'failed') followed by advanceAfterJobFailure() (chunk-outcome
   * accounting + url_verification/batch-scoped/full-audit routing) — one
   * implementation, three callers (this sweep, recoverOrphanedUrlVerification
   * Jobs below, and jobController.js's live /fail handler), matching the
   * exact requirement: recover -> failJob() -> process() -> normal chain.
   *
   * Previously dead code before H2: the query/update used a `job_status`
   * field that does not exist on the Job schema (the real field is
   * `status`), so this never matched a document and was never called from
   * anywhere.
   */
  async cleanupStaleLocks(lockTimeoutMs = 10 * 60 * 1000) { // 10 minutes default

    const staleTime = new Date(Date.now() - lockTimeoutMs);

    const staleJobs = await Job.find({
      status: 'processing',
      claimed_at: { $lt: staleTime }
    }).lean();

    if (staleJobs.length === 0) {
      return { modifiedCount: 0 };
    }

    // Dynamic import breaks a static-import cycle: jobFailureHandler.js
    // imports chainingEngine.js, which imports this file (JobService) —
    // a top-level `import` here would create jobService.js -> jobFailureHandler.js
    // -> chainingEngine.js -> jobService.js. Deferred to call time (well
    // after the whole module graph has finished loading), this is safe.
    const { advanceAfterJobFailure } = await import('./jobFailureHandler.js');

    let modifiedCount = 0;
    for (const staleJob of staleJobs) {
      try {
        const updatedJob = await this.failJob(staleJob._id, {
          message: 'stale_lock_recovered',
        });
        modifiedCount++;
        console.log(`[RECOVERY] stale_lock_recovered | jobId=${staleJob._id} | jobType=${staleJob.jobType} | newStatus=${updatedJob.status}`);
        await advanceAfterJobFailure(
          updatedJob,
          { message: 'Stale lock recovered — worker did not complete in time' },
          { source: 'stale_lock_sweep' }
        );
      } catch (error) {
        console.error(`[RECOVERY] stale_lock_recovery_failed | jobId=${staleJob._id} | reason="${error.message}"`);
      }
    }

    if (modifiedCount > 0) {
      console.log(`🧹 Cleaned up ${modifiedCount} stale locks`);
    }

    return { modifiedCount };

  }

  /**
   * F4-018 (widened from H2's original url_verification-only scope):
   * recovers jobs stuck in 'pending' forever — never claimed by any worker
   * (Python polling loop down, or PUSH-mode dispatch silently failed) or,
   * for the Node-self-processed PROJECT_TASK_VERIFICATION, never picked up
   * because Node crashed between job creation and its synchronous inline
   * run. cleanupStaleLocks above only matches 'processing' jobs that hold a
   * claim (via claimed_at) — a job that was never claimed has no
   * claimed_at at all, so it needs this separate sweep.
   *
   * Scope: input_data.mode:'url_verification' (H2's original scope,
   * unchanged) PLUS PROJECT_SEO_AGGREGATION/PROJECT_AI_AGGREGATION/
   * PROJECT_TASK_VERIFICATION (F4-018 — these are the other job types that
   * can strand a Verification Batch in AGGREGATING if never claimed). Full
   * Audit's other job types are still out of scope — same pre-existing gap,
   * not introduced or widened by this change, and not part of what F4-018
   * was asked to fix.
   *
   * Routes through the same shared this.failJob() + advanceAfterJobFailure()
   * path as cleanupStaleLocks above, instead of a raw Job.updateMany.
   *
   * @param {number} pendingTimeoutMs
   * @returns {Promise<{modifiedCount:number}>}
   */
  async recoverOrphanedUrlVerificationJobs(pendingTimeoutMs = 10 * 60 * 1000) {

    const staleTime = new Date(Date.now() - pendingTimeoutMs);

    const orphanedJobs = await Job.find({
      status: 'pending',
      created_at: { $lt: staleTime },
      $or: [
        { 'input_data.mode': 'url_verification' },
        { jobType: { $in: [JOB_TYPES.PROJECT_SEO_AGGREGATION, JOB_TYPES.PROJECT_AI_AGGREGATION, JOB_TYPES.PROJECT_TASK_VERIFICATION] } },
      ],
    }).lean();

    if (orphanedJobs.length === 0) {
      return { modifiedCount: 0 };
    }

    const { advanceAfterJobFailure } = await import('./jobFailureHandler.js');

    let modifiedCount = 0;
    for (const orphanedJob of orphanedJobs) {
      try {
        const updatedJob = await this.failJob(orphanedJob._id, {
          message: 'orphaned_pending_job_recovered',
        });
        modifiedCount++;
        console.log(`[RECOVERY] orphaned_pending_recovered | jobId=${orphanedJob._id} | jobType=${orphanedJob.jobType} | newStatus=${updatedJob.status}`);
        await advanceAfterJobFailure(
          updatedJob,
          { message: 'Job was never claimed by a worker' },
          { source: 'orphaned_pending_sweep' }
        );
      } catch (error) {
        console.error(`[RECOVERY] orphaned_pending_recovery_failed | jobId=${orphanedJob._id} | reason="${error.message}"`);
      }
    }

    if (modifiedCount > 0) {
      console.log(`🧹 Recovered ${modifiedCount} orphaned pending job(s)`);
    }

    return { modifiedCount };

  }



  /**

   * Claim a job for PULL model processing

   * @param {string} workerType - Type of worker claiming the job

   * @returns {Promise<Object|null>} Claimed job or null

   */

  /**
   * Atomically claim a job of the given type for PULL-model processing.
   * The single source of truth for job claiming (see the F4-018 note where
   * this method's former duplicate used to live, above) — matches:
   *
   *   - 'pending' jobs: claimable immediately (claimed_at null), or after
   *     the existing defensive 5-minute staleness window if one was
   *     somehow left claimed without transitioning to 'processing'.
   *     Unchanged from before this fix.
   *
   *   - 'retrying' jobs: reclaimed once failJob's own computed backoff
   *     delay has elapsed (last_attempted_at, pushed into the future at
   *     failure time, is now <= now). This branch is the F4-018 fix — the
   *     duplicate definition that used to shadow this method omitted
   *     'retrying' entirely, so a job that failed once with attempts
   *     remaining was never reclaimed by anything, for any job type
   *     using this claim path.
   *
   * attempts is intentionally NOT incremented here (unlike the dead
   * duplicate's own version, which double-counted against failJob's own
   * attempts++) — failJob is the single place attempts is incremented, at
   * the moment an attempt actually fails.
   */
  async claimJob(job_type) {

    const now = new Date();
    const staleWindow = new Date(now.getTime() - 5 * 60 * 1000);

    try {
      const job = await Job.findOneAndUpdate(
        {
          jobType: job_type,
          $or: [
            { status: 'pending', claimed_at: null },
            { status: 'pending', claimed_at: { $lt: staleWindow } },
            { status: 'retrying', last_attempted_at: { $lte: now } },
          ],
        },
        {
          $set: {
            status: 'processing',
            claimed_at: now,
            started_at: now,
            last_attempted_at: now,
            claimed_by: process.env.WORKER_ID || 'unknown',
          },
        },
        { new: true, sort: { priority: -1, created_at: 1 } }
      );

      if (job) {
        // attempts is only ever incremented by failJob at failure time, so
        // attempts > 0 here means this claim reclaimed a job that had
        // previously failed at least once (was sitting in 'retrying') —
        // attempts === 0 is an ordinary first-time claim of a fresh
        // 'pending' job. Distinguished for observability (F4-018 §7).
        if (job.attempts > 0) {
          console.log(`[RECOVERY] retry_reclaimed | jobType=${job_type} | jobId=${job._id} | attempts=${job.attempts}`);
        } else {
          console.log(`[CLAIM] job_claimed | jobType=${job_type} | jobId=${job._id}`);
        }
      }

      return job;
    } catch (error) {
      console.error('Failed to claim job:', error);
      throw error;
    }
  }



  /**

   * Create and dispatch DOMAIN_PERFORMANCE job

   * This is called directly from the controller, not from chaining

   */

  async createAndDispatchDomainPerformanceJob(inputData) {

    // DOMAIN_PERFORMANCE jobs are created directly in the controller

    // This method exists for consistency but is not used by chaining engine

    console.log(`[DEBUG] createAndDispatchDomainPerformanceJob called - not used in chaining`);

    return null;

  }

}



