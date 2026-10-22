import mongoose from 'mongoose';
import HomepageAudit from '../model/HomepageAudit.js';
import Job from '../../jobs/model/Job.js';
import { JOB_TYPES, JOB_TYPE_CONFIG } from '../../jobs/constants/jobTypes.js';

/**
 * Homepage Audit Video Service
 *
 * Orchestrates Homepage Audit video generation using the ONE existing job system.
 * Source of truth: HomepageAudit.snapshot ONLY — never re-runs audits or fetches live data.
 *
 * Idempotency:
 *   - video.status === 'PROCESSING' → return the in-flight job (no duplicate render)
 *   - video.videoUrl exists         → return the existing video (no re-render)
 */
export class HomepageAuditVideoService {
  /**
   * Initiate (or return existing) video generation for a HomepageAudit.
   *
   * @param {string} auditId - HomepageAudit._id
   * @param {string|null} userId - Optional authenticated user
   * @returns {Object} { status, jobId?, videoUrl?, existing }
   */
  static async initiate(auditId, userId = null) {
    if (!mongoose.Types.ObjectId.isValid(auditId)) {
      const err = new Error('Invalid audit ID');
      err.statusCode = 400;
      throw err;
    }

    const audit = await HomepageAudit.findById(auditId).select('snapshot video user_id').lean();
    if (!audit) {
      const err = new Error('Homepage audit not found');
      err.statusCode = 404;
      throw err;
    }
    if (!audit.snapshot) {
      const err = new Error('Homepage audit has no snapshot to render');
      err.statusCode = 400;
      throw err;
    }

    // IDEMPOTENCY 1: a finished video already exists → return it
    if (audit.video?.status === 'RENDERED' && audit.video?.videoUrl) {
      return {
        existing: true,
        status: 'RENDERED',
        videoUrl: audit.video.videoUrl,
        jobId: audit.video.jobId
      };
    }

    // IDEMPOTENCY 2: a render is already in flight → return the existing job
    if (['PENDING', 'PROCESSING'].includes(audit.video?.status) && audit.video?.jobId) {
      // Verify the job hasn't silently died — if it failed, allow a fresh render below
      const existingJob = await Job.findById(audit.video.jobId).select('status').lean();
      if (existingJob && ['pending', 'processing', 'retrying'].includes(existingJob.status)) {
        return {
          existing: true,
          status: audit.video.status,
          jobId: audit.video.jobId
        };
      }
      // else: stale/failed job — fall through to create a new one
    }

    // Create the job DIRECTLY (not via JobService.createJob, which is project-coupled).
    // entityType=homepage_audit, no project_id, auditId carried in input_data.
    const config = JOB_TYPE_CONFIG[JOB_TYPES.HOMEPAGE_VIDEO_GENERATION];
    const job = new Job({
      jobType: JOB_TYPES.HOMEPAGE_VIDEO_GENERATION,
      entityType: 'homepage_audit',
      ...(userId ? { user_id: userId } : {}),
      input_data: { auditId: auditId.toString() },
      status: 'pending',
      priority: config?.priority || 6,
      attempts: 0,
      max_attempts: config?.maxAttempts || 2
    });
    await job.save();

    // Mark the audit as PENDING (inline status — no separate collection)
    await HomepageAudit.findByIdAndUpdate(auditId, {
      video: {
        status: 'PENDING',
        jobId: job._id,
        videoUrl: null,
        generatedAt: null
      }
    });

    // Dispatch to the SAME video worker (PUSH, fire-and-forget) — routes by videoType
    try {
      const JobDispatcher = (await import('../../jobs/service/jobDispatcher.js')).default;
      const dispatcher = new JobDispatcher();
      dispatcher.dispatchHomepageVideoJob(job).catch((err) => {
        console.error(`[HOMEPAGE_VIDEO_SERVICE] Dispatch failed | jobId=${job._id}:`, err.message);
      });
    } catch (dispatchError) {
      console.error('[HOMEPAGE_VIDEO_SERVICE] Failed to load dispatcher:', dispatchError.message);
    }

    return {
      existing: false,
      status: 'PENDING',
      jobId: job._id
    };
  }

  /**
   * Get current video status for a HomepageAudit.
   *
   * @param {string} auditId - HomepageAudit._id
   * @returns {Object|null} video status object, or null if audit not found
   */
  static async getStatus(auditId) {
    if (!mongoose.Types.ObjectId.isValid(auditId)) {
      const err = new Error('Invalid audit ID');
      err.statusCode = 400;
      throw err;
    }

    const audit = await HomepageAudit.findById(auditId).select('video').lean();
    if (!audit) return null;

    const video = audit.video || {};
    return {
      status: video.status || null,
      jobId: video.jobId || null,
      videoUrl: video.videoUrl || null,
      generatedAt: video.generatedAt || null
    };
  }

  /**
   * Persist the rendered video result. Called by the job completion handler.
   *
   * @param {string} jobId - Job._id
   * @param {string} auditId - HomepageAudit._id (from job.input_data.auditId)
   * @param {Object} result - { videoUrl } on success
   * @param {boolean} success
   */
  static async finalize(jobId, auditId, result, success) {
    if (!mongoose.Types.ObjectId.isValid(auditId)) return;

    if (success && result?.videoUrl) {
      await HomepageAudit.findByIdAndUpdate(auditId, {
        video: {
          status: 'RENDERED',
          jobId,
          videoUrl: result.videoUrl,
          generatedAt: new Date()
        }
      });
      console.log(`[HOMEPAGE_VIDEO_SERVICE] ✅ Video RENDERED | auditId=${auditId}`);
    } else {
      await HomepageAudit.findByIdAndUpdate(auditId, {
        'video.status': 'FAILED'
      });
      console.log(`[HOMEPAGE_VIDEO_SERVICE] ❌ Video FAILED | auditId=${auditId}`);
    }
  }
}

export default HomepageAuditVideoService;
