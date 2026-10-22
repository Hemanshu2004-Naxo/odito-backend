import { JobService } from '../service/jobService.js';
import { body, validationResult } from 'express-validator';

const jobService = new JobService();

/**
 * Claim a job for a worker
 * This is the endpoint workers call to get jobs
 */
export const claimJob = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log(`❌ Validation errors:`, errors.array());
      return res.status(400).json({
        success: false,
        message: 'Validation errors',
        errors: errors.array()
      });
    }

    const { job_type } = req.body;

    if (!job_type) {
      return res.status(400).json({
        success: false,
        message: 'job_type is required'
      });
    }

    // Claim a job of the specified type
    const job = await jobService.claimJob(job_type);

    if (!job) {
      return res.status(404).json({
        success: false,
        message: 'No jobs available'
      });
    }

    console.log(`✅ Job ${job._id} (${job.jobType}) claimed by worker`);

    res.json({
      success: true,
      message: 'Job claimed successfully',
      data: {
        job_id: job._id,
        jobType: job.jobType,
        projectId: job.project_id,
        entityId: job.entityId,
        entityType: job.entityType,
        input_data: job.input_data,
        status: job.status,
        claimed_at: job.claimed_at,
        started_at: job.started_at
      }
    });
  } catch (error) {
    console.error('Error claiming job:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to claim job',
      error: error.message
    });
  }
};

// Validation middleware for worker job claiming
export const validateClaimJob = [
  body('job_type').isString().withMessage('job_type must be a string'),
  body('worker_id').isString().withMessage('worker_id must be a string')
];
