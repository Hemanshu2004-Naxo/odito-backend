import mongoose from 'mongoose';
import { JobService } from '../../jobs/service/jobService.js';
import JobDispatcher from '../../jobs/service/jobDispatcher.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

const jobService = new JobService();

// ---------------------------------------------------------------------------
// POST /api/pagespeed/rescan/:projectId
// Trigger a standalone DOMAIN_PERFORMANCE rescan without running a full audit.
// ---------------------------------------------------------------------------
export const rescanPageSpeed = async (req, res) => {
  const { projectId } = req.params;
  const project = req.project;           // attached by validateProjectAccess()
  const userId   = req.user?._id || req.user?.id;

  LoggerUtil.info('PageSpeed rescan requested', { projectId, userId });

  try {
    const Job = mongoose.model('Job');

    // ── Duplicate-scan guard ─────────────────────────────────────────────────
    // Return 409 if a DOMAIN_PERFORMANCE job is already active for this project
    const activeJob = await Job.findOne({
      project_id: new mongoose.Types.ObjectId(projectId),
      jobType:    'DOMAIN_PERFORMANCE',
      status:     { $in: ['pending', 'processing'] },
    });

    if (activeJob) {
      LoggerUtil.info('PageSpeed rescan blocked — scan already in progress', {
        projectId,
        existingJobId: activeJob._id,
        status: activeJob.status,
      });
      return res.status(409).json({
        success: false,
        message: 'PageSpeed scan already in progress',
        jobId:   activeJob._id,
      });
    }

    // ── Create DOMAIN_PERFORMANCE job ────────────────────────────────────────
    const job = await jobService.createJob({
      user_id:        userId,
      seo_project_id: projectId,
      jobType:        'DOMAIN_PERFORMANCE',
      input_data: {
        main_url:    project.main_url,
        rescan_only: true,               // flag so chainingEngine (if reached) skips chaining
      },
      priority: 2,
    });

    LoggerUtil.info('DOMAIN_PERFORMANCE rescan job created', {
      jobId:     job._id,
      projectId,
      main_url:  project.main_url,
    });

    // ── Emit WebSocket "started" event immediately ───────────────────────────
    const io = global.io;
    if (io) {
      io.to(`project-${projectId}`).emit('pagespeed:started', {
        projectId,
        jobId:     job._id.toString(),
        timestamp: new Date().toISOString(),
      });
    }

    // ── Dispatch to Python worker (fire-and-forget) ──────────────────────────
    const dispatcher = new JobDispatcher();
    dispatcher.queueDomainPerformanceJob(job).catch(err => {
      LoggerUtil.error('DOMAIN_PERFORMANCE dispatch failed (non-fatal)', err, {
        jobId:     job._id,
        projectId,
      });
    });

    return res.status(202).json({
      success:   true,
      message:   'PageSpeed rescan started',
      jobId:     job._id,
      projectId,
    });

  } catch (err) {
    LoggerUtil.error('PageSpeed rescan endpoint error', err, { projectId, userId });
    return res.status(500).json({
      success: false,
      message: 'Failed to start PageSpeed rescan',
      error:   err.message,
    });
  }
};

// ---------------------------------------------------------------------------
// GET /api/pagespeed/status/:projectId
// Returns current scan status from seo_domain_performance metadata.
// Used by the frontend to poll or display accurate status.
// ---------------------------------------------------------------------------
export const getPageSpeedStatus = async (req, res) => {
  const { projectId } = req.params;

  try {
    const db  = mongoose.connection.db;
    const doc = await db.collection('seo_domain_performance').findOne(
      { project_id: new mongoose.Types.ObjectId(projectId) },
      {
        projection: {
          scan_status:            1,
          mobile_status:          1,
          desktop_status:         1,
          last_run_at:            1,
          last_successful_run_at: 1,
          last_error:             1,
          mobile_error:           1,
          desktop_error:          1,
          retry_count:            1,
          duration_ms:            1,
          job_id:                 1,
          tested_at:              1,
        },
      },
    );

    if (!doc) {
      return res.json({
        success: true,
        data: {
          scan_status: 'no_data',
          message:     'No PageSpeed scan has been run yet',
        },
      });
    }

    // Also check if there is an active job in-flight
    const Job      = mongoose.model('Job');
    const activeJob = await Job.findOne({
      project_id: new mongoose.Types.ObjectId(projectId),
      jobType:    'DOMAIN_PERFORMANCE',
      status:     { $in: ['pending', 'processing'] },
    });

    return res.json({
      success: true,
      data: {
        scan_status:            activeJob ? 'running' : (doc.scan_status || 'completed'),
        mobile_status:          doc.mobile_status,
        desktop_status:         doc.desktop_status,
        last_run_at:            doc.last_run_at,
        last_successful_run_at: doc.last_successful_run_at,
        last_error:             doc.last_error,
        mobile_error:           doc.mobile_error,
        desktop_error:          doc.desktop_error,
        retry_count:            doc.retry_count,
        duration_ms:            doc.duration_ms,
        job_id:                 activeJob ? activeJob._id : doc.job_id,
        tested_at:              doc.tested_at,
        is_running:             !!activeJob,
      },
    });

  } catch (err) {
    LoggerUtil.error('PageSpeed status endpoint error', err, { projectId });
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch PageSpeed status',
      error:   err.message,
    });
  }
};

// ---------------------------------------------------------------------------
// POST /api/pagespeed/ws-event
// Internal endpoint: Python worker calls this to forward WS events to clients.
// Not authenticated (internal only — bind behind INTERNAL_SECRET or firewall).
// ---------------------------------------------------------------------------
export const forwardWsEvent = async (req, res) => {
  const { projectId, event, payload } = req.body;

  if (!projectId || !event) {
    return res.status(400).json({ success: false, message: 'projectId and event required' });
  }

  const io = global.io;
  if (io) {
    io.to(`project-${projectId}`).emit(event, {
      ...payload,
      timestamp: new Date().toISOString(),
    });
  }

  return res.json({ success: true });
};
