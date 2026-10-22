/**
 * Production-safe job completion handler with defensive architecture
 * Prevents cascading failures and ensures reliable webhook responses
 *
 * Delegates to:
 *   - projectStatusService  (SeoProject status updates by job type)
 *   - chainingEngine         (all job chaining, atomic guards, dispatch, fallback)
 */

import { JobService } from '../service/jobService.js';
import projectStatusService from '../service/projectStatusService.js';
import chainingEngine from '../chainingEngine.js';
import { AIGeneratedVideoService } from '../../video/services/aiGeneratedVideo.service.js';
import { sendMail } from '../../mail/services/mailService.js';
import { MAIL_TYPES } from '../../mail/constants/emailTypes.js';
import { generateRealPDF } from '../../../services/pdfGeneratorService.js';
import { getEnvVar } from '../../../config/env.js';
import User from '../../user/model/User.js';
import SeoProject from '../../app_user/model/SeoProject.js';
import Job from '../model/Job.js';

// Same CORS_ORIGIN-as-frontend-URL idiom used in subscriptionWebhookService.js's
// MANAGE_SUBSCRIPTION_URL — a hard-required env var, safe to read at module
// load time. Works unchanged in dev/staging/prod since it's never hardcoded.
const FRONTEND_URL = getEnvVar('CORS_ORIGIN');

const jobService = new JobService();

/**
 * Safe job completion with guaranteed response
 * Uses immediate response pattern with async chaining
 */
export const completeJobSafely = async (req, res) => {
  const requestId = Math.random().toString(36).substr(2, 9);
  const { jobId } = req.params;
  const { stats, result_data } = req.body;

  console.log(`[REQUEST:${requestId}] Job completion started | jobId=${jobId}`);

  // Immediate validation and response
  try {
    // Atomic transition: the database, not a prior read, decides which
    // request (if any concurrent duplicates exist) gets to complete this
    // job. Previously this was getJobById() followed by a separate
    // updateJobStatus() call — a read-then-write TOCTOU race where two
    // near-simultaneous completion deliveries for the same job could both
    // observe "not yet completed" before either write committed, and both
    // would go on to schedule handleJobCompletion() / chainingEngine.process()
    // a second time. The filter below (`status: {$ne:'completed'}`) makes
    // the transition itself the single point of truth: only the request
    // whose findOneAndUpdate actually matches a document ever proceeds past
    // this point, no matter how many arrive concurrently.
    const mergedResultData = { ...(stats || {}), ...(result_data || {}) };
    const updatedJob = await Job.findOneAndUpdate(
      { _id: jobId, status: { $ne: 'completed' } },
      {
        $set: {
          status: 'completed',
          result_data: mergedResultData,
          completed_at: new Date()
        },
        // Data-integrity cleanup only, not the concurrency fix above: a job
        // that was previously marked failed (e.g. a premature dispatch
        // timeout) and later recovers here would otherwise keep stale
        // failed_at/error/error_message fields forever alongside
        // status:'completed'. Isolated to this one atomic write — no extra
        // query, no change to the transition logic itself.
        $unset: {
          failed_at: "",
          error: "",
          error_message: ""
        }
      },
      { new: true }
    );

    if (!updatedJob) {
      // Either the job doesn't exist, or it was already completed (by this
      // same request racing a concurrent duplicate, or a genuinely earlier
      // call). This read is only used to pick the response wording — it no
      // longer gates any state transition or chaining decision, so it
      // cannot reintroduce the race the atomic update above just closed.
      const existing = await jobService.getJobById(jobId);
      if (!existing) {
        console.log(`[ERROR:${requestId}] Job not found | jobId=${jobId}`);
        return res.status(404).json({
          success: false,
          message: 'Job not found',
          requestId
        });
      }
      console.log(`[INFO:${requestId}] Job already completed | jobId=${jobId}`);
      return res.json({
        success: true,
        message: 'Job already completed',
        requestId
      });
    }

    // Preserve the same side effect jobService.updateJobStatus() would have
    // performed (project-level job-count aggregation), since this path now
    // bypasses that helper for the atomic $set above.
    if (updatedJob.project_id) {
      await jobService.updateProjectJobStats(updatedJob.project_id);
    }

    console.log(`[SUCCESS:${requestId}] Job status updated | jobId=${jobId} | jobType=${updatedJob.jobType}`);

    // Send immediate response BEFORE chaining
    res.json({
      success: true,
      message: 'Job marked as completed',
      requestId,
      jobType: updatedJob.jobType
    });

    console.log(`[RESPONSE:${requestId}] Response sent | jobId=${jobId}`);

    // Update project status + chain next jobs asynchronously (non-blocking)
    setImmediate(() => {
      handleJobCompletion(updatedJob, stats, requestId).catch(error => {
        console.error(`[CHAINING_ERROR:${requestId}] Job chaining failed | jobId=${jobId} | reason="${error.message}"`);
      });
    });

  } catch (error) {
    console.error(`[ERROR:${requestId}] Job completion failed | jobId=${jobId} | reason="${error.message}"`);

    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: 'Failed to complete job',
        error: error.message,
        requestId
      });
    }
  }
};

/**
 * Post-response handler: update project status, then chain next jobs.
 * This is the clean entry point that delegates to services.
 */
async function handleJobCompletion(updatedJob, stats, requestId) {
  console.log(`[COMPLETION_HANDLER:${requestId}] handleJobCompletion called | jobType=${updatedJob.jobType} | jobId=${updatedJob._id}`);
  console.log(`[COMPLETION_HANDLER:${requestId}] Stats payload:`, JSON.stringify(stats, null, 2));
  
  // 🎥 VIDEO GENERATION: Save video metadata to ai_generated_videos collection
  if (updatedJob.jobType === 'VIDEO_GENERATION') {
    try {
      console.log(`[VIDEO_STORAGE:${requestId}] Processing video generation completion | jobId=${updatedJob._id}`);
      
      const videoData = {
        userId: updatedJob.user_id,
        projectId: updatedJob.project_id,
        jobId: updatedJob._id,
        videoUrl: updatedJob.result_data?.videoUrl || null,
        videoFileName: updatedJob.result_data?.videoFileName || null,
        status: updatedJob.result_data?.videoUrl ? 'RENDERED' : 'FAILED',
        fileSize: updatedJob.result_data?.fileSize || null,
        processingTime: updatedJob.result_data?.processingTime || null,
        error: (updatedJob.status === 'failed' && updatedJob.error) ? {
          message: updatedJob.error.message,
          stack: updatedJob.error.stack,
          timestamp: updatedJob.error.timestamp
        } : null
      };
      
      console.log(`[VIDEO_STORAGE:${requestId}] VIDEO SAVE PAYLOAD:`, videoData);
      
      const savedVideo = await AIGeneratedVideoService.saveVideo(videoData);
      console.log(`[VIDEO_STORAGE:${requestId}] ✅ Video metadata saved to ai_generated_videos | videoId=${savedVideo._id} | status=${savedVideo.status}`);
      
    } catch (videoError) {
      console.error(`[VIDEO_STORAGE:${requestId}] ❌ Failed to save video metadata | jobId=${updatedJob._id}:`, videoError);
      // Don't fail the job completion, just log the error
    }
  }
  
  await projectStatusService.updateForJobType(updatedJob, stats, requestId);
  console.log(`[COMPLETION_HANDLER:${requestId}] projectStatusService.updateForJobType completed`);
  
  await chainingEngine.process(updatedJob, stats, requestId);
  console.log(`[COMPLETION_HANDLER:${requestId}] chainingEngine.process completed`);

  // 📧 EMAIL NOTIFICATION: Send report email for final job types
  await sendReportEmailForFinalJob(updatedJob, requestId);
}

/**
 * Send report email for final job types (SEO_SCORING)
 * @param {Object} job - Completed job object
 * @param {string} requestId - Request tracking ID
 */
async function sendReportEmailForFinalJob(job, requestId) {
  // Only send email for final job types
  const finalJobTypes = ['SEO_SCORING'];
  
  if (!finalJobTypes.includes(job.jobType)) {
    console.log(`[EMAIL:${requestId}] Skipping email - not a final job type | jobType=${job.jobType}`);
    return;
  }

  try {
    console.log(`[EMAIL:${requestId}] Final job completed - preparing email | jobType=${job.jobType} | jobId=${job._id}`);
    
    // Get user information
    const user = await User.findById(job.user_id).lean();
    if (!user) {
      console.error(`[EMAIL:${requestId}] User not found | userId=${job.user_id}`);
      return;
    }

    console.log(`[EMAIL:${requestId}] Sending report email to: ${user.email}`);

    // Generate real PDF from frontend report page
    console.log(`[PDF:${requestId}] Generating PDF for project: ${job.project_id}`);
    let pdfUrl;
    try {
      pdfUrl = await generateRealPDF(job.project_id, job);
      console.log(`[PDF:${requestId}] ✅ PDF generated successfully: ${pdfUrl}`);
    } catch (pdfError) {
      console.error(`[PDF:${requestId}] ❌ PDF generation failed: ${pdfError.message}`);
      // Fallback to placeholder URL if PDF generation fails
      pdfUrl = `https://your-domain.com/api/reports/${job.project_id}/pdf?jobId=${job._id}`;
      console.log(`[PDF:${requestId}] Using fallback URL: ${pdfUrl}`);
    }

    // pages_crawled/pages_analyzed/total_issues are already computed and
    // stored on the project by the time SEO_SCORING (the pipeline's final
    // job) completes — written earlier by PAGE_SCRAPING/PAGE_ANALYSIS
    // completion (see projectStatusService.js). Read, never recomputed.
    const project = await SeoProject.findById(job.project_id).select('project_name main_url pages_crawled pages_analyzed total_issues').lean();

    // Primary CTA opens the interactive frontend dashboard, not the PDF —
    // ?project=<id> is read by ProjectContext.jsx on load to select this
    // project (deep-link support added alongside this change). If the
    // project can't be found, fall back to the bare dashboard URL, which
    // already auto-selects a project on its own — never a broken link.
    const dashboardUrl = project
      ? `${FRONTEND_URL}/dashboard?project=${project._id}`
      : `${FRONTEND_URL}/dashboard`;

    // Send email with error handling
    const emailSent = await sendMail(MAIL_TYPES.AUDIT_COMPLETED, user.email, {
      firstName: user.firstName,
      projectName: project?.project_name || null,
      websiteUrl: project?.main_url || null,
      auditStatus: 'Completed',
      pagesCrawled: project?.pages_crawled ?? null,
      pagesAnalyzed: project?.pages_analyzed ?? null,
      issuesFound: project?.total_issues ?? null,
      auditDate: job.completed_at || new Date(),
      dashboardUrl,
    });

    if (emailSent) {
      console.log(`[EMAIL:${requestId}] ✅ Report email sent successfully | email=${user.email} | jobType=${job.jobType}`);
    } else {
      console.error(`[EMAIL:${requestId}] ❌ Failed to send report email | email=${user.email} | jobType=${job.jobType}`);
    }
    
  } catch (error) {
    console.error(`[EMAIL:${requestId}] ❌ Email sending failed | jobId=${job._id} | reason="${error.message}"`);
    // Don't fail the job completion process due to email errors
  }
}

export default completeJobSafely;
