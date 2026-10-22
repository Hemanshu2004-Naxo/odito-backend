/**
 * Audit Progress Service
 * Handles real-time progress tracking for SEO audit jobs
 * Emits WebSocket events to connected clients
 */

class AuditProgressService {
  constructor() {
    this.progressCache = new Map(); // Cache progress for active jobs
  }

  /**
   * Emit audit progress update to clients
   * @param {string} jobId - Job ID
   * @param {Object} progressData - Progress data
   */
  emitProgress(jobId, progressData) {
    const io = global.io;
    if (!io) {
      console.warn('⚠️ Socket.IO not available for progress emission');
      return;
    }

    // Cache progress for new connections
    this.progressCache.set(jobId, {
      ...progressData,
      lastUpdated: new Date()
    });

    // Emit to job-specific room (include projectId if available for frontend filtering)
    io.to(`audit-${jobId}`).emit('audit:progress', {
      jobId,
      projectId: progressData.projectId || null,
      ...progressData,
      timestamp: new Date()
    });

    console.log(`[EVENT] Audit progress emitted | jobId=${jobId} | step=${progressData.step} | percentage=${progressData.percentage}`);
  }

  /**
   * Emit audit started event
   * @param {string} jobId - Job ID
   * @param {Object} jobData - Job information
   */
  emitStarted(jobId, jobData) {
    const io = global.io;
    if (!io) return;

    const progressData = {
      status: 'started',
      step: 'Start',
      percentage: 0,
      message: 'Your website crawling has been started',
      subtext: 'Initializing audit process',
      projectId: jobData.projectId || jobData.project_id || null,
      jobData
    };

    this.emitProgress(jobId, progressData);
    
    // Also emit general started event
    io.to(`audit-${jobId}`).emit('audit:started', {
      jobId,
      projectId: jobData.projectId || jobData.project_id || null,
      ...progressData,
      timestamp: new Date()
    });

    console.log(`[EVENT] Audit started | jobId=${jobId}`);
  }

  /**
   * Emit audit completed event
   * @param {string} jobId - Job ID
   * @param {Object} resultData - Final results
   */
  emitCompleted(jobId, resultData) {
    const io = global.io;
    if (!io) return;

    const progressData = {
      status: 'completed',
      step: 'Complete',
      percentage: 100,
      message: 'Website link crawling completed',
      subtext: 'Audit finished successfully',
      resultData
    };

    this.emitProgress(jobId, progressData);
    
    // 🔥 CRITICAL: Emit to PROJECT room, not job room (jobs change IDs)
    const projectId = resultData.projectId || resultData.resultData?.projectId;
    if (projectId) {
      io.to(`project-${projectId}`).emit('audit:completed', {
        jobId,
        projectId,
        ...progressData,
        timestamp: new Date()
      });
      
      // Also emit to job room for backward compatibility
      io.to(`audit-${jobId}`).emit('audit:completed', {
        jobId,
        projectId,
        ...progressData,
        timestamp: new Date()
      });
      
      console.log(`[EVENT] Audit completed emitted | projectId=${projectId} | jobId=${jobId}`);
    } else {
      // Fallback: Job-only emission
      io.to(`audit-${jobId}`).emit('audit:completed', {
        jobId,
        ...progressData,
        timestamp: new Date()
      });
      console.log(`[EVENT] Audit completed emitted (job-only) | jobId=${jobId}`);
    }

    // Remove from cache after completion
    this.progressCache.delete(jobId);
  }

  /**
   * Emit audit error event
   * @param {string} jobId - Job ID
   * @param {Error} error - Error details
   */
  emitError(jobId, error) {
    const io = global.io;
    if (!io) return;

    const progressData = {
      status: 'error',
      step: 'Error',
      percentage: 0,
      message: 'An error occurred during the audit',
      subtext: error.message || 'Unknown error occurred',
      projectId: error.projectId || error.project_id || null,
      error: {
        message: error.message,
        stack: error.stack
      }
    };

    this.emitProgress(jobId, progressData);
    
    // Also emit general error event
    io.to(`audit-${jobId}`).emit('audit:error', {
      jobId,
      projectId: error.projectId || error.project_id || null,
      ...progressData,
      timestamp: new Date()
    });

    // Remove from cache after error
    this.progressCache.delete(jobId);

    console.log(`[EVENT] Audit error | jobId=${jobId} | reason="${error.message}"`);
  }

  /**
   * Emit "awaiting URL selection" event — fired when URL_QUALIFICATION
   * completes for a project that requires user review of discovered URLs.
   * Emitted to the project room (job IDs change across stages, matching
   * emitCompleted's convention). Enhancement only, not authoritative — the
   * frontend's polling of crawl_status is the correctness guarantee; this
   * just lets a listener react instantly instead of waiting for the next
   * poll tick.
   * @param {string} projectId - SeoProject _id
   * @param {Object} data - { projectId, sourceJobId, totalQualified }
   */
  emitAwaitingSelection(projectId, data) {
    const io = global.io;
    if (!io) return;

    io.to(`project-${projectId}`).emit('audit:awaitingSelection', {
      projectId,
      ...data,
      timestamp: new Date()
    });

    console.log(`[EVENT] Awaiting URL selection | projectId=${projectId} | totalQualified=${data?.totalQualified}`);
  }

  /**
   * Emit audit stage change event
   * @param {string} oldJobId - Previous job ID
   * @param {Object} stageData - Stage transition data
   */
  emitStageChanged(oldJobId, stageData) {
    const io = global.io;
    if (!io) return;

    // Emit to old job room to notify frontend of stage change
    io.to(`audit-${oldJobId}`).emit('audit:stageChanged', {
      from: stageData.from,
      to: stageData.to,
      newJobId: stageData.newJobId,
      projectId: stageData.projectId || stageData.project_id || null,
      timestamp: new Date()
    });

    console.log(`[EVENT] Stage changed | oldJobId=${oldJobId} | from=${stageData.from} | to=${stageData.to} | newJobId=${stageData.newJobId}`);
  }

  /**
   * P3-006: URL Verification realtime events. Reuses this same emitter,
   * global.io, and the existing project-{projectId} room (the same choice
   * emitCompleted already made, for the same reason: a verification run's
   * job id changes across stages, so the project room is the one stable
   * target for the whole run's lifetime) — no new room architecture.
   *
   * Payload is additive/consistent across all four events: runId,
   * verificationRunId, projectId, pageUrl, status, progress, currentStage,
   * currentJob, timestamp.
   */
  emitVerificationStarted({ runId, verificationRunId, projectId, pageUrl, currentJob = null }) {
    const io = global.io;
    if (!io) {
      console.warn(`⚠️ verification:started dropped — Socket.IO not available | runId=${runId} | projectId=${projectId} | pageUrl=${pageUrl}`);
      return;
    }

    io.to(`project-${projectId}`).emit('verification:started', {
      runId,
      verificationRunId,
      projectId,
      pageUrl,
      status: 'started',
      progress: 0,
      currentStage: 'Queued',
      currentJob,
      timestamp: new Date(),
    });

    console.log(`[EVENT] Verification started | runId=${runId} | projectId=${projectId} | pageUrl=${pageUrl}`);
  }

  emitVerificationProgress({ runId, verificationRunId, projectId, pageUrl, progress, currentStage, currentJob = null }) {
    const io = global.io;
    if (!io) {
      console.warn(`⚠️ verification:progress dropped — Socket.IO not available | runId=${runId} | projectId=${projectId} | pageUrl=${pageUrl} | stage=${currentStage}`);
      return;
    }

    io.to(`project-${projectId}`).emit('verification:progress', {
      runId,
      verificationRunId,
      projectId,
      pageUrl,
      status: 'processing',
      progress,
      currentStage,
      currentJob,
      timestamp: new Date(),
    });

    console.log(`[EVENT] Verification progress | runId=${runId} | stage=${currentStage} | progress=${progress}`);
  }

  emitVerificationCompleted({ runId, verificationRunId, projectId, pageUrl, currentJob = null }) {
    const io = global.io;
    if (!io) {
      console.warn(`⚠️ verification:completed dropped — Socket.IO not available | runId=${runId} | projectId=${projectId} | pageUrl=${pageUrl}`);
      return;
    }

    io.to(`project-${projectId}`).emit('verification:completed', {
      runId,
      verificationRunId,
      projectId,
      pageUrl,
      status: 'completed',
      progress: 100,
      currentStage: 'Completed',
      currentJob,
      timestamp: new Date(),
    });

    console.log(`[EVENT] Verification completed | runId=${runId} | projectId=${projectId}`);
  }

  emitVerificationFailed({ runId, verificationRunId, projectId, pageUrl, currentStage = 'Failed', currentJob = null, errorMessage = null }) {
    const io = global.io;
    if (!io) {
      console.warn(`⚠️ verification:failed dropped — Socket.IO not available | runId=${runId} | projectId=${projectId} | pageUrl=${pageUrl}`);
      return;
    }

    io.to(`project-${projectId}`).emit('verification:failed', {
      runId,
      verificationRunId,
      projectId,
      pageUrl,
      status: 'failed',
      progress: null,
      currentStage,
      currentJob,
      errorMessage,
      timestamp: new Date(),
    });

    console.log(`[EVENT] Verification failed | runId=${runId} | projectId=${projectId} | reason="${errorMessage}"`);
  }

  /**
   * F4-016: emitted exactly once per Verification Batch, only after the
   * final project-level job (PROJECT_TASK_VERIFICATION) resolves and
   * chainingEngine._finalizeVerificationBatch wins the AGGREGATING ->
   * {COMPLETED|PARTIAL|FAILED} transition. Deliberately the ONLY new batch
   * websocket event — batch-started/batch-progress were explicitly not
   * added; the frontend already reconstructs per-URL progress from the
   * existing verification:started/progress/completed/failed events emitted
   * for each PageVerificationRun in the batch.
   */
  emitVerificationBatchCompleted({ batchId, projectId, status, totalUrls, completedUrls, failedUrls }) {
    const io = global.io;
    if (!io) {
      console.warn(`⚠️ verification:batch-completed dropped — Socket.IO not available | batchId=${batchId} | projectId=${projectId}`);
      return;
    }

    io.to(`project-${projectId}`).emit('verification:batch-completed', {
      batchId,
      projectId,
      status,
      totalUrls,
      completedUrls,
      failedUrls,
      timestamp: new Date(),
    });

    console.log(`[EVENT] Verification batch completed | batchId=${batchId} | projectId=${projectId} | status=${status} | completed=${completedUrls}/${totalUrls}`);
  }

  /**
   * Phase 6.3: Google Ads campaign sync progress. Same emitter, same
   * global.io, same project-{projectId} room convention as every event
   * above - no new websocket architecture. A sync job's id doesn't change
   * mid-run (unlike the audit pipeline's stage-to-stage job handoff), but
   * the project room is used anyway for consistency with every other
   * long-running-job event in this file, and because it's the room the
   * frontend is already subscribed to for this project.
   */
  emitGoogleAdsSyncStarted({ jobId, projectId, customerId, syncType }) {
    const io = global.io;
    if (!io) {
      console.warn(`⚠️ google_ads_sync:started dropped — Socket.IO not available | jobId=${jobId} | projectId=${projectId}`);
      return;
    }

    io.to(`project-${projectId}`).emit('google_ads_sync:started', {
      jobId,
      projectId,
      customerId,
      syncType,
      status: 'started',
      stage: 'started',
      progress: 0,
      timestamp: new Date(),
    });

    console.log(`[EVENT] Google Ads sync started | jobId=${jobId} | projectId=${projectId} | syncType=${syncType}`);
  }

  /**
   * @param {string} stage - one of 'fetching_campaigns' | 'fetching_metrics' |
   *   'updating_database' | 'generating_aggregates'
   */
  emitGoogleAdsSyncProgress({ jobId, projectId, customerId, stage, progress }) {
    const io = global.io;
    if (!io) {
      console.warn(`⚠️ google_ads_sync:progress dropped — Socket.IO not available | jobId=${jobId} | projectId=${projectId} | stage=${stage}`);
      return;
    }

    io.to(`project-${projectId}`).emit('google_ads_sync:progress', {
      jobId,
      projectId,
      customerId,
      status: 'processing',
      stage,
      progress,
      timestamp: new Date(),
    });

    console.log(`[EVENT] Google Ads sync progress | jobId=${jobId} | stage=${stage} | progress=${progress}`);
  }

  emitGoogleAdsSyncCompleted({ jobId, projectId, customerId, stats }) {
    const io = global.io;
    if (!io) {
      console.warn(`⚠️ google_ads_sync:completed dropped — Socket.IO not available | jobId=${jobId} | projectId=${projectId}`);
      return;
    }

    io.to(`project-${projectId}`).emit('google_ads_sync:completed', {
      jobId,
      projectId,
      customerId,
      status: 'completed',
      stage: 'completed',
      progress: 100,
      stats,
      timestamp: new Date(),
    });

    console.log(`[EVENT] Google Ads sync completed | jobId=${jobId} | projectId=${projectId}`);
  }

  emitGoogleAdsSyncFailed({ jobId, projectId, customerId, errorMessage }) {
    const io = global.io;
    if (!io) {
      console.warn(`⚠️ google_ads_sync:failed dropped — Socket.IO not available | jobId=${jobId} | projectId=${projectId}`);
      return;
    }

    io.to(`project-${projectId}`).emit('google_ads_sync:failed', {
      jobId,
      projectId,
      customerId,
      status: 'failed',
      stage: 'failed',
      progress: null,
      errorMessage,
      timestamp: new Date(),
    });

    console.log(`[EVENT] Google Ads sync failed | jobId=${jobId} | projectId=${projectId} | reason="${errorMessage}"`);
  }

  /**
   * Phase 6.4: Keyword performance sync progress. Same shape as the
   * google_ads_sync:* events above, its own event namespace because
   * GOOGLE_ADS_KEYWORD_SYNC is its own job (own jobId, own lifecycle),
   * separately triggerable from the campaign sync.
   */
  emitGoogleAdsKeywordSyncStarted({ jobId, projectId, customerId }) {
    const io = global.io;
    if (!io) {
      console.warn(`⚠️ google_ads_keyword_sync:started dropped — Socket.IO not available | jobId=${jobId} | projectId=${projectId}`);
      return;
    }

    io.to(`project-${projectId}`).emit('google_ads_keyword_sync:started', {
      jobId, projectId, customerId, status: 'started', stage: 'started', progress: 0, timestamp: new Date(),
    });

    console.log(`[EVENT] Google Ads keyword sync started | jobId=${jobId} | projectId=${projectId}`);
  }

  /** @param {string} stage - 'fetching_keywords' | 'updating_database' */
  emitGoogleAdsKeywordSyncProgress({ jobId, projectId, customerId, stage, progress }) {
    const io = global.io;
    if (!io) {
      console.warn(`⚠️ google_ads_keyword_sync:progress dropped — Socket.IO not available | jobId=${jobId} | stage=${stage}`);
      return;
    }

    io.to(`project-${projectId}`).emit('google_ads_keyword_sync:progress', {
      jobId, projectId, customerId, status: 'processing', stage, progress, timestamp: new Date(),
    });

    console.log(`[EVENT] Google Ads keyword sync progress | jobId=${jobId} | stage=${stage} | progress=${progress}`);
  }

  emitGoogleAdsKeywordSyncCompleted({ jobId, projectId, customerId, stats }) {
    const io = global.io;
    if (!io) {
      console.warn(`⚠️ google_ads_keyword_sync:completed dropped — Socket.IO not available | jobId=${jobId}`);
      return;
    }

    io.to(`project-${projectId}`).emit('google_ads_keyword_sync:completed', {
      jobId, projectId, customerId, status: 'completed', stage: 'completed', progress: 100, stats, timestamp: new Date(),
    });

    console.log(`[EVENT] Google Ads keyword sync completed | jobId=${jobId} | projectId=${projectId}`);
  }

  emitGoogleAdsKeywordSyncFailed({ jobId, projectId, customerId, errorMessage }) {
    const io = global.io;
    if (!io) {
      console.warn(`⚠️ google_ads_keyword_sync:failed dropped — Socket.IO not available | jobId=${jobId}`);
      return;
    }

    io.to(`project-${projectId}`).emit('google_ads_keyword_sync:failed', {
      jobId, projectId, customerId, status: 'failed', stage: 'failed', progress: null, errorMessage, timestamp: new Date(),
    });

    console.log(`[EVENT] Google Ads keyword sync failed | jobId=${jobId} | reason="${errorMessage}"`);
  }

  /**
   * Phase 6.4: Recommendation sync progress. Same shape, own event
   * namespace, own job (GOOGLE_ADS_RECOMMENDATION_SYNC).
   */
  emitGoogleAdsRecommendationSyncStarted({ jobId, projectId, customerId }) {
    const io = global.io;
    if (!io) {
      console.warn(`⚠️ google_ads_recommendation_sync:started dropped — Socket.IO not available | jobId=${jobId}`);
      return;
    }

    io.to(`project-${projectId}`).emit('google_ads_recommendation_sync:started', {
      jobId, projectId, customerId, status: 'started', stage: 'started', progress: 0, timestamp: new Date(),
    });

    console.log(`[EVENT] Google Ads recommendation sync started | jobId=${jobId} | projectId=${projectId}`);
  }

  /** @param {string} stage - 'fetching_recommendations' | 'updating_database' */
  emitGoogleAdsRecommendationSyncProgress({ jobId, projectId, customerId, stage, progress }) {
    const io = global.io;
    if (!io) {
      console.warn(`⚠️ google_ads_recommendation_sync:progress dropped — Socket.IO not available | jobId=${jobId} | stage=${stage}`);
      return;
    }

    io.to(`project-${projectId}`).emit('google_ads_recommendation_sync:progress', {
      jobId, projectId, customerId, status: 'processing', stage, progress, timestamp: new Date(),
    });

    console.log(`[EVENT] Google Ads recommendation sync progress | jobId=${jobId} | stage=${stage} | progress=${progress}`);
  }

  emitGoogleAdsRecommendationSyncCompleted({ jobId, projectId, customerId, stats }) {
    const io = global.io;
    if (!io) {
      console.warn(`⚠️ google_ads_recommendation_sync:completed dropped — Socket.IO not available | jobId=${jobId}`);
      return;
    }

    io.to(`project-${projectId}`).emit('google_ads_recommendation_sync:completed', {
      jobId, projectId, customerId, status: 'completed', stage: 'completed', progress: 100, stats, timestamp: new Date(),
    });

    console.log(`[EVENT] Google Ads recommendation sync completed | jobId=${jobId} | projectId=${projectId}`);
  }

  emitGoogleAdsRecommendationSyncFailed({ jobId, projectId, customerId, errorMessage }) {
    const io = global.io;
    if (!io) {
      console.warn(`⚠️ google_ads_recommendation_sync:failed dropped — Socket.IO not available | jobId=${jobId}`);
      return;
    }

    io.to(`project-${projectId}`).emit('google_ads_recommendation_sync:failed', {
      jobId, projectId, customerId, status: 'failed', stage: 'failed', progress: null, errorMessage, timestamp: new Date(),
    });

    console.log(`[EVENT] Google Ads recommendation sync failed | jobId=${jobId} | reason="${errorMessage}"`);
  }

  /**
   * Get cached progress for a job
   * @param {string} jobId - Job ID
   * @returns {Object|null} - Cached progress data
   */
  getCachedProgress(jobId) {
    return this.progressCache.get(jobId) || null;
  }

  /**
   * Clean up old progress cache entries
   * @param {number} maxAge - Maximum age in milliseconds (default: 1 hour)
   */
  cleanupCache(maxAge = 60 * 60 * 1000) {
    const now = new Date();
    for (const [jobId, progress] of this.progressCache.entries()) {
      if (now - progress.lastUpdated > maxAge) {
        this.progressCache.delete(jobId);
        console.log(`🧹 Cleaned up old progress cache for job: ${jobId}`);
      }
    }
  }

  /**
   * Map job status to frontend step
   * @param {string} jobStatus - Backend job status
   * @param {number} percentage - Progress percentage
   * @returns {Object} - Frontend step data
   */
  mapStatusToStep(jobStatus, percentage = 0) {
    const stepMap = {
      'pending': { step: 'Start', percentage: 0 },
      'processing': { 
        step: percentage < 30 ? 'Find' : percentage < 70 ? 'Analyze' : 'Complete',
        percentage 
      },
      'completed': { step: 'Complete', percentage: 100 },
      'failed': { step: 'Error', percentage: 0 }
    };

    return stepMap[jobStatus] || { step: 'Start', percentage: 0 };
  }

  /**
   * Handle job status change and emit appropriate progress
   * @param {string} jobId - Job ID
   * @param {string} status - New job status
   * @param {Object} additionalData - Additional progress data
   */
  handleJobStatusChange(jobId, status, additionalData = {}) {
    const { percentage = 0, message, resultData, error } = additionalData;
    
    switch (status) {
      case 'processing':
        const { step, percentage: mappedPercentage } = this.mapStatusToStep(status, percentage);
        this.emitProgress(jobId, {
          status: 'processing',
          step,
          percentage: mappedPercentage,
          message: message || `Processing ${step.toLowerCase()} phase...`,
          subtext: this.getStepSubtext(step)
        });
        break;
        
      case 'completed':
        this.emitCompleted(jobId, resultData || {});
        break;
        
      case 'failed':
        this.emitError(jobId, error || new Error('Job failed'));
        break;
        
      default:
        console.log(`ℹ️ Job ${jobId} status changed to: ${status}`);
    }
  }

  /**
   * Get subtext for each step
   * @param {string} step - Step name
   * @returns {string} - Step subtext
   */
  getStepSubtext(step) {
    const subtextMap = {
      'Start': 'Initializing audit process',
      'Find': 'Crawling internal and external URLs',
      'Analyze': 'Processing SEO metrics and data',
      'Complete': 'Audit finished successfully',
      'Error': 'An error occurred during processing'
    };
    
    return subtextMap[step] || 'Processing...';
  }
}

export default new AuditProgressService();
