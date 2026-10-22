import { JobService } from '../service/jobService.js';
import { body, param, validationResult } from 'express-validator';
import Job from '../model/Job.js';
import axios from 'axios';
import chainingEngine from '../chainingEngine.js';
import { advanceAfterJobFailure } from '../service/jobFailureHandler.js';

const jobService = new JobService();
// Remove global jobDispatcher instantiation - will be created in functions

/**
 * Complete a job (callback from Python worker)
 */
export const completeJob = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation errors',
        errors: errors.array()
      });
    }

    const { jobId } = req.params;
    const { stats, result_data } = req.body;

    // Validate job exists
    const job = await jobService.getJobById(jobId);
    if (!job) {
      return res.status(404).json({
        success: false,
        message: 'Job not found'
      });
    }

    // Check if already completed (idempotent)
    if (job.status === 'completed') {
      return res.json({
        success: true,
        message: 'Job already completed'
      });
    }

    // Update job status to completed
    const mergedResultData = {
      ...(stats || {}),
      ...(result_data || {})
    };

    const updatedJob = await jobService.updateJobStatus(jobId, 'completed', {
      result_data: mergedResultData,
      completed_at: new Date()
    });

    // Generate unique request ID for tracing
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Use chainingEngine for all job orchestration based on pipelineConfig.js
    console.log(`[API] Job completion received | jobId=${jobId} | jobType=${updatedJob.jobType} | requestId=${requestId}`);
    
    try {
      await chainingEngine.process(updatedJob, stats, requestId);
      console.log(`[API] Chaining completed successfully | jobId=${jobId} | requestId=${requestId}`);
    } catch (chainingError) {
      console.error(`[ERROR] Chaining failed | jobId=${jobId} | requestId=${requestId} | reason="${chainingError.message}"`);
      // Don't fail the job completion, just log the chaining error
    }

  } catch (error) {
    console.log(`[ERROR] Job completion failed | jobId=${jobId} | jobType=${job.jobType} | reason="${error.message}"`);
    res.status(500).json({
      success: false,
      message: 'Failed to complete job',
      error: error.message
    });
  }
};

/**
 * Fail a job (callback from Python worker)
 */
export const failJob = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation errors',
        errors: errors.array()
      });
    }

    const { jobId } = req.params;
    const { error, stats } = req.body;

    // Validate job exists
    const job = await jobService.getJobById(jobId);
    if (!job) {
      return res.status(404).json({
        success: false,
        message: 'Job not found'
      });
    }

    // Check if already completed (idempotent)
    if (job.status === 'completed') {
      return res.json({
        success: true,
        message: 'Job already completed'
      });
    }

    // Create error object
    const errorObj = error ? {
      message: error.message || error,
      timestamp: new Date()
    } : {
      message: 'Unknown error from Python worker',
      timestamp: new Date()
    };

    // Update job status to 'failed' (terminal, retries exhausted) or
    // 'retrying' (attempts remain) — see jobService.failJob.
    const updatedJob = await jobService.failJob(jobId, errorObj, {
      result_data: stats || {}
    });

    // NOTE: TECHNICAL_DOMAIN is a standalone informational job (seeded at audit
    // start alongside DOMAIN_PERFORMANCE/KEYWORD_RESEARCH) and is no longer part
    // of the LINK_DISCOVERY → URL_QUALIFICATION → PAGE_SCRAPING crawl chain. A
    // TECHNICAL_DOMAIN failure must not advance or shortcut the crawl pipeline —
    // it falls through to the same generic failure handling as any other job.

    // F4-018: everything from chunk-outcome accounting through the
    // url_verification/batch-scoped-aggregation/full-audit-reset branching
    // is now a single shared implementation (jobFailureHandler.js) reused by
    // this live HTTP callback AND both stale-job recovery sweeps in
    // jobService.js — so a job recovered by a sweep advances its chain
    // exactly like a real-time failure does, instead of dead-ending.
    const { retryChunkCreated } = await advanceAfterJobFailure(updatedJob, errorObj, { source: 'http' });

    if (retryChunkCreated) {
      return res.json({
        success: true,
        message: 'Job marked for retry via URL-level retry',
        data: { job_id: jobId, status: updatedJob.status }
      });
    }

    res.json({
      success: true,
      message: updatedJob.status === 'retrying' ? 'Job marked for retry' : 'Job marked as failed',
      data: {
        job_id: jobId,
        status: updatedJob.status,
        failed_at: updatedJob.failed_at,
        error: errorObj.message,
        stats: stats || {}
      }
    });
  } catch (error) {
    console.log(`[ERROR] Job failure processing failed | jobId=${jobId} | jobType=${job.jobType} | reason="${error.message}"`);
    res.status(500).json({
      success: false,
      message: 'Failed to fail job',
      error: error.message
    });
  }
};

// Validation middleware - relaxed for Python worker callbacks
export const validateCompleteJob = [
  // param('jobId').isMongoId().withMessage('Valid job ID required'),
  body('stats').optional().isObject().withMessage('Stats must be an object'),
  body('result_data').optional().isObject().withMessage('Result data must be an object')
];

export const validateFailJob = [
  // param('jobId').isMongoId().withMessage('Valid job ID required'),
  body('error').optional().isString().withMessage('Error must be a string'),
  body('stats').optional().isObject().withMessage('Stats must be an object')
];

/**
 * Claim a job (for Python workers)
 */
export const claimJob = async (req, res) => {
  try {
    const { job_type, worker_id } = req.body;

    if (!job_type || !worker_id) {
      return res.status(400).json({
        success: false,
        message: 'job_type and worker_id are required'
      });
    }

    // Atomically claim a job
    const job = await Job.findOneAndUpdate(
      {
        jobType: job_type,
        status: 'pending',
        $or: [
          { last_attempted_at: { $lt: new Date(Date.now() - 5 * 60 * 1000) } },
          { last_attempted_at: null }
        ]
      },
      {
        $set: {
          status: 'processing',
          claimed_at: new Date(),
          started_at: new Date(),
          last_attempted_at: new Date()
        },
        $inc: { attempts: 1 }
      },
      {
        new: true,
        sort: { priority: -1, created_at: 1 }
      }
    );

    if (!job) {
      return res.status(404).json({
        success: false,
        message: 'No jobs available'
      });
    }

    console.log(`[JOB] Job claimed | jobId=${job._id} | jobType=${job.jobType} | worker=${worker_id}`);

    return res.json({
      success: true,
      job: {
        _id: job._id,
        project_id: job.project_id,
        user_id: job.user_id,
        input_data: job.input_data
      }
    });

  } catch (error) {
    console.error('[JOB_CLAIM_ERROR]', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to claim job'
    });
  }
};

export const validateClaimJob = [
  body('job_type').isString().withMessage('Job type must be a string'),
  body('worker_id').isString().withMessage('Worker ID must be a string')
];
