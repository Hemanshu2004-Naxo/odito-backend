/**
 * Project Status Service
 * Handles SeoProject status updates during audit pipeline stages.
 * Extracted from jobCompletionHandler.js to separate business logic from job chaining.
 */

import SeoProject from '../../app_user/model/SeoProject.js';
import Job from '../model/Job.js';
import JobGroup from '../model/JobGroup.js';
import { JOB_TYPES } from '../constants/jobTypes.js';

class ProjectStatusService {

  /**
   * Dispatcher: update project status based on the completed job's type.
   * Only LINK_DISCOVERY, PAGE_SCRAPING, and PAGE_ANALYSIS trigger updates.
   *
   * @param {Object} updatedJob - The completed job document
   * @param {Object} stats - Stats payload from the worker
   * @param {string} requestId - Request trace ID for logging
   */
  async updateForJobType(updatedJob, stats, requestId) {
    console.log(`[PROJECT_STATUS:${requestId}] updateForJobType called | jobType=${updatedJob.jobType} | projectId=${updatedJob.project_id}`);
    
    switch (updatedJob.jobType) {
      case JOB_TYPES.LINK_DISCOVERY:
        await this.updateOnLinkDiscovery(updatedJob.project_id, stats, requestId);
        break;
      case JOB_TYPES.PAGE_SCRAPING:
        await this.updateOnPageScraping(updatedJob, stats, requestId);
        break;
      case JOB_TYPES.PAGE_ANALYSIS:
        await this.updateOnPageAnalysisComplete(updatedJob.project_id, stats, requestId);
        break;
      default:
        // No project status update for other job types
        console.log(`[PROJECT_STATUS:${requestId}] No handler for jobType=${updatedJob.jobType}`);
        break;
    }
  }

  /**
   * Update project after LINK_DISCOVERY completes.
   * Sets crawl_status='discovered' and records pages_discovered count.
   *
   * @param {string} projectId - SeoProject _id
   * @param {Object} stats - Stats payload from the completed job
   * @param {string} requestId - Request trace ID for logging
   */
  async updateOnLinkDiscovery(projectId, stats, requestId) {
    try {
      await SeoProject.findByIdAndUpdate(projectId, {
        crawl_status: 'discovered',
        pages_discovered: stats?.discovered_links?.total || stats?.totalUrlsFound || 0,
        // Host canonicalization: persist the redirect-resolved host so it's
        // visible/auditable on the project and available to any future
        // caller without re-deriving it. URL_QUALIFICATION gets its copy
        // directly from the LINK_DISCOVERY job's result_data (see
        // jobService.createAndDispatchUrlQualificationJob), not from here.
        canonical_host: stats?.canonicalHost || null,
        canonical_url: stats?.canonicalUrl || null
      });
      console.log(`[CHAINING:${requestId}] Project status updated | projectId=${projectId}`);
    } catch (statusError) {
      console.error(`[CHAINING_ERROR:${requestId}] Project status update failed | reason="${statusError.message}"`);
    }
  }

  /**
   * Update project after a PAGE_SCRAPING job completes.
   * Sets crawl_status='crawled' and records pages_crawled count.
   *
   * PAGE_SCRAPING is single-job for Quick Recheck (verification mode) but
   * chunked into N sibling jobs sharing one group_id/run_id for full audits
   * (JobGroup architecture). A chunk completing is NOT the same event as the
   * stage completing, so:
   *   - group_id absent  -> unchanged legacy behavior: this IS the whole
   *     stage, update immediately from this job's own stats.
   *   - group_id present -> this is one of N chunks. Only write the project
   *     fields once every PAGE_SCRAPING job sharing this run_id has reached
   *     a terminal state (completed or failed), and aggregate pages_crawled
   *     by summing every completed chunk's own stats rather than using only
   *     the chunk that happens to be finishing right now. This read-and-sum
   *     is naturally idempotent (recomputed fresh from persisted job docs
   *     each time), so it's safe to be called again by another chunk's
   *     completion without any extra locking.
   *
   * @param {Object} updatedJob - The completed PAGE_SCRAPING job document
   * @param {Object} stats - Stats payload from the completed job
   * @param {string} requestId - Request trace ID for logging
   */
  async updateOnPageScraping(updatedJob, stats, requestId) {
    const projectId = updatedJob.project_id;
    try {
      if (!updatedJob.group_id) {
        // Non-chunked path (Quick Recheck / any legacy single-job PAGE_SCRAPING).
        // Field names match the real PAGE_SCRAPING result_data schema
        // (python_workers/.../page_scraping.py) — successfulPages/totalUrls,
        // not crawled_pages.successful/totalPages, which never existed in
        // that payload and always fell through to 0.
        await SeoProject.findByIdAndUpdate(projectId, {
          crawl_status: 'crawled',
          pages_crawled: stats?.successfulPages ?? stats?.totalUrls ?? 0
        });
        console.log(`[CHAINING:${requestId}] Project status updated | projectId=${projectId}`);
        return;
      }

      // Chunked path: check every PAGE_SCRAPING job for this run, not just
      // this one chunk, before touching project-level fields.
      const chunkJobs = await Job.find({
        project_id: projectId,
        run_id: updatedJob.run_id,
        jobType: JOB_TYPES.PAGE_SCRAPING
      }).select('status result_data').lean();

      // URL-level retry (chainingEngine._maybeCreatePageScrapingRetryChunks)
      // increases the JobGroup's total_chunks BEFORE the new retry chunk Job
      // documents are actually created — a real (if brief) window where
      // chunkJobs.length is momentarily behind total_chunks. Comparing
      // against total_chunks (not just "are the currently-existing jobs all
      // terminal") closes that window: this defers the pages_crawled write
      // until every chunk the group actually expects — including any retry
      // rounds not yet created as Job documents — has resolved, so the
      // final number is never written prematurely and then silently
      // corrected later.
      const group = await JobGroup.findOne({
        project_id: projectId,
        run_id: updatedJob.run_id,
        stage: JOB_TYPES.PAGE_SCRAPING
      }).select('total_chunks').lean();
      const expectedChunks = group?.total_chunks ?? chunkJobs.length;

      const stillOutstanding = chunkJobs.length < expectedChunks
        || chunkJobs.some(j => !['completed', 'failed'].includes(j.status));
      if (stillOutstanding) {
        console.log(`[CHAINING:${requestId}] PAGE_SCRAPING chunk completed, group not yet fully resolved — project status update deferred | projectId=${projectId}`);
        return;
      }

      const pagesCrawled = chunkJobs.reduce((sum, j) => {
        if (j.status !== 'completed') return sum;
        const r = j.result_data || {};
        // Same field-name fix as the non-chunked branch above.
        return sum + (r.successfulPages ?? r.totalUrls ?? 0);
      }, 0);

      await SeoProject.findByIdAndUpdate(projectId, {
        crawl_status: 'crawled',
        pages_crawled: pagesCrawled
      });
      console.log(`[CHAINING:${requestId}] Project status updated (aggregated across ${chunkJobs.length} PAGE_SCRAPING chunks) | projectId=${projectId} | pages_crawled=${pagesCrawled}`);
    } catch (statusError) {
      console.error(`[CHAINING_ERROR:${requestId}] Project status update failed | reason="${statusError.message}"`);
    }
  }

  /**
   * Update project after PAGE_ANALYSIS completes.
   * Records pages_analyzed, total_issues, and last_analysis_at — facts that
   * are genuinely true the moment PAGE_ANALYSIS itself finishes.
   *
   * Does NOT set crawl_status or audit_duration_ms here: PAGE_ANALYSIS is not
   * the end of the pipeline (SEO_SCORING runs after it, and AI_VISIBILITY is
   * a separate parallel branch that may still be running) — declaring the
   * project "completed" and freezing a duration at this point was the exact
   * premature-completion bug. Both fields are now written exactly once, by
   * chainingEngine.js's _finalizeAuditCompletion(), only after every required
   * terminal job type (SEO_SCORING, AI_VISIBILITY) has actually resolved.
   *
   * @param {string} projectId - SeoProject _id
   * @param {Object} stats - Stats payload from the completed job
   * @param {string} requestId - Request trace ID for logging
   */
  async updateOnPageAnalysisComplete(projectId, stats, requestId) {
    try {
      await SeoProject.findByIdAndUpdate(projectId, {
        pages_analyzed: stats?.pagesAnalyzed || stats?.totalPages || 0,
        total_issues: stats?.issuesFound || 0,
        last_analysis_at: new Date()
      });
      console.log(`[CHAINING:${requestId}] Project updated | projectId=${projectId}`);
    } catch (statusError) {
      console.error(`[CHAINING_ERROR:${requestId}] Project update failed | reason="${statusError.message}"`);
    }
  }

}

export default new ProjectStatusService();
