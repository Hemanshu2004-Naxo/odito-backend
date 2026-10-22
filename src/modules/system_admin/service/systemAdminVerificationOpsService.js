import mongoose from 'mongoose';
import SeoProject from '../../app_user/model/SeoProject.js';
import User from '../../user/model/User.js';
import Job from '../../jobs/model/Job.js';
import VerificationBatch from '../../verification/model/VerificationBatch.js';
import PageVerificationRun from '../../verification/model/PageVerificationRun.js';
import { BATCH_STATUS, BATCH_STATUSES } from '../../verification/constants/batchStatus.js';
import { JOB_TYPES } from '../../jobs/constants/jobTypes.js';
import { getSchedulerHealth as getStaleLockSchedulerHealth } from '../../jobs/service/staleLockScheduler.js';
import { getSchedulerHealth as getBatchRecoverySchedulerHealth } from '../../verification/service/verificationBatchRecoveryScheduler.js';

/**
 * ODITO-OPS-001 — Verification Operations Dashboard.
 *
 * Strictly read-only, exactly like systemAdminOperationsService.js's own
 * Jobs/Webhooks/Audit Logs section: every function here only queries
 * existing collections (VerificationBatch, PageVerificationRun, Job) and
 * two purely-additive scheduler health getters (see staleLockScheduler.js /
 * verificationBatchRecoveryScheduler.js — neither retry timing, queue
 * semantics, nor the pipeline itself was changed to add those getters).
 * Nothing here creates, updates, retries, or deletes anything.
 */

// Matches verificationBatchRecoveryService.js's own DEFAULT_STALE_THRESHOLD_MS
// — "stuck" here means the exact same thing the recovery sweep itself uses
// to decide a batch needs resuming, not a separately-invented number.
const STUCK_AGGREGATING_THRESHOLD_MS = 15 * 60 * 1000;

// Recovery events are NOT a persisted collection (no schema change was
// permitted for this phase) — "retry reclaimed" / "stale lock recovered" /
// "orphaned job recovered" are derived from markers the existing F4-018
// implementation already writes onto Job.error.message and Job.attempts.
// "batch resumed" / "aggregation resumed" / "duplicate recovery avoided"
// are NOT derivable this way (they're log-line-only today) — the Recovery
// Dashboard surfaces this gap explicitly rather than fabricating data for it.
const RECOVERY_MARKER_REASONS = {
  stale_lock_recovered: 'Stale lock recovered',
  orphaned_pending_job_recovered: 'Orphaned pending job recovered',
};

const PROJECT_JOB_TYPES_ORDER = [
  JOB_TYPES.PAGE_SCRAPING,
  JOB_TYPES.HEADLESS_ACCESSIBILITY,
  JOB_TYPES.PAGE_ANALYSIS,
  JOB_TYPES.SEO_SCORING,
  JOB_TYPES.AI_VISIBILITY,
  JOB_TYPES.PROJECT_SEO_AGGREGATION,
  JOB_TYPES.PROJECT_AI_AGGREGATION,
  JOB_TYPES.PROJECT_TASK_VERIFICATION,
];

/* ────────────────────────── Batch Dashboard ────────────────────────── */

function batchJoinStages() {
  return [
    { $lookup: { from: SeoProject.collection.name, localField: 'projectId', foreignField: '_id', as: '_project' } },
    { $unwind: { path: '$_project', preserveNullAndEmptyArrays: true } },
    { $lookup: { from: User.collection.name, localField: 'createdBy', foreignField: '_id', as: '_creator' } },
    { $unwind: { path: '$_creator', preserveNullAndEmptyArrays: true } },
  ];
}

function currentStageForStatus(status) {
  switch (status) {
    case BATCH_STATUS.PENDING: return 'Pending';
    case BATCH_STATUS.RUNNING: return 'Page Verification';
    case BATCH_STATUS.AGGREGATING: return 'Project Aggregation';
    case BATCH_STATUS.COMPLETED: return 'Completed';
    case BATCH_STATUS.PARTIAL: return 'Completed (Partial)';
    case BATCH_STATUS.FAILED: return 'Failed';
    default: return status;
  }
}

function isStuckBatch(row, now = Date.now()) {
  return row.status === BATCH_STATUS.AGGREGATING
    && !!row.aggregateStartedAt
    && (now - new Date(row.aggregateStartedAt).getTime()) > STUCK_AGGREGATING_THRESHOLD_MS;
}

function serializeBatchRow(row, now = Date.now()) {
  const startTime = row.startedAt || row.createdAt;
  const endTime = row.completedAt || (row.status === BATCH_STATUS.PENDING ? null : now);
  const durationMs = startTime && endTime ? new Date(endTime) - new Date(startTime) : null;

  return {
    batchId: row.batchId,
    project: row._project ? { id: row._project._id, name: row._project.project_name || row._project.main_url } : null,
    user: row._creator
      ? { id: row._creator._id, firstName: row._creator.firstName, lastName: row._creator.lastName, email: row._creator.email }
      : null,
    status: row.status,
    isStuck: isStuckBatch(row, now),
    totalUrls: row.totalUrls,
    completedUrls: row.completedUrls,
    failedUrls: row.failedUrls,
    currentStage: currentStageForStatus(row.status),
    durationMs,
    startedAt: row.startedAt || null,
    aggregateStartedAt: row.aggregateStartedAt || null,
    aggregateCompletedAt: row.aggregateCompletedAt || null,
    completedAt: row.completedAt || null,
    createdAt: row.createdAt,
  };
}

const BATCH_SORT_OPTIONS = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  status: { status: 1 },
};

const listBatches = async ({ page, limit, search, status, projectId, userId, dateFrom, dateTo, stuckOnly, sort }) => {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (pageNum - 1) * limitNum;

  const pipeline = [...batchJoinStages()];

  const match = {};
  if (status && BATCH_STATUSES.includes(status)) match.status = status;
  if (projectId && mongoose.Types.ObjectId.isValid(projectId)) match.projectId = new mongoose.Types.ObjectId(projectId);
  if (userId && mongoose.Types.ObjectId.isValid(userId)) match.createdBy = new mongoose.Types.ObjectId(userId);
  if (dateFrom || dateTo) {
    match.createdAt = {};
    if (dateFrom) match.createdAt.$gte = new Date(dateFrom);
    if (dateTo) match.createdAt.$lte = new Date(dateTo);
  }
  if (search && String(search).trim()) {
    const term = String(search).trim();
    const orClauses = [
      { batchId: { $regex: term, $options: 'i' } },
      { '_project.project_name': { $regex: term, $options: 'i' } },
      { '_creator.email': { $regex: term, $options: 'i' } },
    ];
    match.$or = orClauses;
  }
  if (Object.keys(match).length) pipeline.push({ $match: match });

  // "Stuck" is a computed condition (AGGREGATING past the threshold), so it
  // is applied as its own $match rather than a stored field — this mirrors
  // exactly what verificationBatchRecoveryService.recoverStalledAggregationBatches
  // itself queries for, so "stuck" here can never disagree with what the
  // recovery sweep considers stuck.
  if (stuckOnly === 'true' || stuckOnly === true) {
    const stuckCutoff = new Date(Date.now() - STUCK_AGGREGATING_THRESHOLD_MS);
    pipeline.push({ $match: { status: BATCH_STATUS.AGGREGATING, aggregateStartedAt: { $lt: stuckCutoff } } });
  }

  const sortSpec = BATCH_SORT_OPTIONS[sort] || BATCH_SORT_OPTIONS.newest;

  pipeline.push({
    $facet: {
      data: [{ $sort: sortSpec }, { $skip: skip }, { $limit: limitNum }],
      totalCount: [{ $count: 'count' }],
    },
  });

  const [result] = await VerificationBatch.aggregate(pipeline);
  const total = result?.totalCount?.[0]?.count || 0;
  const now = Date.now();

  return {
    batches: (result?.data || []).map((row) => serializeBatchRow(row, now)),
    pagination: { page: pageNum, limit: limitNum, total, pages: Math.max(1, Math.ceil(total / limitNum)) },
    filters: { statuses: BATCH_STATUSES },
  };
};

const getBatchesSummary = async () => {
  const rows = await VerificationBatch.aggregate([
    { $group: { _id: '$status', count: { $sum: 1 }, totalUrlsSum: { $sum: '$totalUrls' } } },
  ]);

  const counts = { pending: 0, running: 0, aggregating: 0, completed: 0, partial: 0, failed: 0 };
  let totalUrlsSum = 0;
  let totalBatches = 0;
  for (const row of rows) {
    if (row._id in counts) counts[row._id] = row.count;
    totalUrlsSum += row.totalUrlsSum || 0;
    totalBatches += row.count;
  }

  const stuckCutoff = new Date(Date.now() - STUCK_AGGREGATING_THRESHOLD_MS);
  const stuckCount = await VerificationBatch.countDocuments({
    status: BATCH_STATUS.AGGREGATING,
    aggregateStartedAt: { $lt: stuckCutoff },
  });

  // Duration stats computed over TERMINAL batches only (completed/partial/
  // failed) — an in-flight batch has no end time yet, so including it would
  // understate "how long does a batch actually take".
  const [durationRow] = await VerificationBatch.aggregate([
    {
      $match: {
        status: { $in: [BATCH_STATUS.COMPLETED, BATCH_STATUS.PARTIAL, BATCH_STATUS.FAILED] },
        completedAt: { $ne: null },
        startedAt: { $ne: null },
      },
    },
    { $project: { durationMs: { $subtract: ['$completedAt', '$startedAt'] } } },
    { $group: { _id: null, avgDurationMs: { $avg: '$durationMs' }, maxDurationMs: { $max: '$durationMs' } } },
  ]);

  return {
    ...counts,
    stuckCount,
    totalBatches,
    averageUrlsPerBatch: totalBatches > 0 ? Math.round((totalUrlsSum / totalBatches) * 10) / 10 : 0,
    averageDurationMs: durationRow?.avgDurationMs != null ? Math.round(durationRow.avgDurationMs) : null,
    longestBatchDurationMs: durationRow?.maxDurationMs ?? null,
  };
};

function serializeRunRow(run) {
  return {
    runId: run.runId,
    verificationRunId: run._id,
    pageUrl: run.pageUrl,
    status: run.status,
    startedAt: run.startedAt || null,
    completedAt: run.completedAt || null,
    durationMs: run.durationMs ?? null,
    errorMessage: run.errorMessage || null,
  };
}

function serializeJobSummaryRow(job) {
  return {
    id: job._id,
    jobType: job.jobType,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.max_attempts,
    createdAt: job.created_at,
    startedAt: job.started_at || null,
    completedAt: job.completed_at || null,
    failureReason: job.error?.message || null,
  };
}

function isRecoveryMarker(errorMessage) {
  return !!errorMessage && errorMessage in RECOVERY_MARKER_REASONS;
}

function serializeRecoveryEvent(job) {
  return {
    id: job._id,
    timestamp: job.updated_at || job.last_attempted_at || job.created_at,
    batchId: job.input_data?.batchId || null,
    projectId: job.project_id || null,
    jobType: job.jobType,
    reason: RECOVERY_MARKER_REASONS[job.error.message] || job.error.message,
  };
}

/**
 * A best-effort chronological Timeline for one batch — "Batch Created" plus
 * one entry per distinct pipeline stage this batch's jobs actually reached
 * (page-level stages report their EARLIEST occurrence across all runs,
 * since N pages run stage-by-stage independently; project-level stages are
 * inherently singular). Every timestamp here is read directly off existing
 * Job/VerificationBatch documents — nothing is computed or estimated.
 */
function buildTimeline(batch, jobs) {
  const timeline = [{ stage: 'Batch Created', timestamp: batch.createdAt }];

  const earliestByType = new Map();
  for (const job of jobs) {
    const ts = job.started_at || job.created_at;
    const existing = earliestByType.get(job.jobType);
    if (!existing || new Date(ts) < new Date(existing)) {
      earliestByType.set(job.jobType, ts);
    }
  }

  const STAGE_LABELS = {
    [JOB_TYPES.PAGE_SCRAPING]: 'Page Scraping',
    [JOB_TYPES.HEADLESS_ACCESSIBILITY]: 'Headless Accessibility',
    [JOB_TYPES.PAGE_ANALYSIS]: 'Page Analysis',
    [JOB_TYPES.SEO_SCORING]: 'SEO Scoring',
    [JOB_TYPES.AI_VISIBILITY]: 'AI Visibility',
    [JOB_TYPES.PROJECT_SEO_AGGREGATION]: 'Project SEO Aggregation',
    [JOB_TYPES.PROJECT_AI_AGGREGATION]: 'Project AI Aggregation',
    [JOB_TYPES.PROJECT_TASK_VERIFICATION]: 'Project Task Verification',
  };

  for (const jobType of PROJECT_JOB_TYPES_ORDER) {
    if (jobType === JOB_TYPES.PROJECT_SEO_AGGREGATION && batch.aggregateStartedAt) {
      timeline.push({ stage: 'Barrier (all pages resolved)', timestamp: batch.aggregateStartedAt });
    }
    if (earliestByType.has(jobType)) {
      timeline.push({ stage: STAGE_LABELS[jobType], timestamp: earliestByType.get(jobType) });
    }
  }

  if (batch.completedAt) {
    timeline.push({ stage: currentStageForStatus(batch.status), timestamp: batch.completedAt });
  }

  return timeline.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

const getBatchDetail = async (batchId) => {
  const batch = await VerificationBatch.findBatch(batchId).lean();
  if (!batch) return null;

  const [project, creator, runs, jobs] = await Promise.all([
    SeoProject.findById(batch.projectId).select('project_name main_url').lean(),
    batch.createdBy ? User.findById(batch.createdBy).select('firstName lastName email').lean() : null,
    PageVerificationRun.find({ batchId }).sort({ createdAt: 1 }).lean(),
    Job.find({ 'input_data.batchId': batchId }).sort({ created_at: 1 }).lean(),
  ]);

  const recoveryEvents = jobs
    .filter((job) => isRecoveryMarker(job.error?.message))
    .map(serializeRecoveryEvent);

  return {
    batch: serializeBatchRow(batch),
    project: project ? { id: project._id, name: project.project_name || project.main_url } : null,
    user: creator ? { id: creator._id, firstName: creator.firstName, lastName: creator.lastName, email: creator.email } : null,
    runs: runs.map(serializeRunRow),
    jobs: jobs.map(serializeJobSummaryRow),
    timeline: buildTimeline(batch, jobs),
    recoveryEvents,
  };
};

/* ────────────────────────── Queue Dashboard ────────────────────────── */

const QUEUE_STATUSES = ['pending', 'processing', 'retrying', 'failed', 'completed'];

const getQueueSummary = async () => {
  const [statusRows, oldestPendingRows, longestProcessingRows, retryRows] = await Promise.all([
    Job.aggregate([
      { $match: { jobType: { $in: PROJECT_JOB_TYPES_ORDER } } },
      { $group: { _id: { jobType: '$jobType', status: '$status' }, count: { $sum: 1 } } },
    ]),
    Job.aggregate([
      { $match: { jobType: { $in: PROJECT_JOB_TYPES_ORDER }, status: 'pending' } },
      { $sort: { created_at: 1 } },
      { $group: { _id: '$jobType', jobId: { $first: '$_id' }, createdAt: { $first: '$created_at' } } },
    ]),
    Job.aggregate([
      { $match: { jobType: { $in: PROJECT_JOB_TYPES_ORDER }, status: 'processing' } },
      { $sort: { started_at: 1 } },
      { $group: { _id: '$jobType', jobId: { $first: '$_id' }, startedAt: { $first: '$started_at' } } },
    ]),
    Job.aggregate([
      { $match: { jobType: { $in: PROJECT_JOB_TYPES_ORDER }, attempts: { $gt: 0 } } },
      { $group: { _id: '$jobType', count: { $sum: 1 } } },
    ]),
  ]);

  const byType = {};
  for (const jobType of PROJECT_JOB_TYPES_ORDER) {
    byType[jobType] = {
      jobType,
      pending: 0,
      processing: 0,
      retrying: 0,
      failed: 0,
      completed: 0,
      retryCount: 0,
      oldestPending: null,
      longestProcessing: null,
    };
  }

  for (const row of statusRows) {
    const { jobType, status } = row._id;
    if (byType[jobType] && status in byType[jobType]) {
      byType[jobType][status] = row.count;
    }
  }
  for (const row of oldestPendingRows) {
    if (byType[row._id]) {
      byType[row._id].oldestPending = { jobId: row.jobId, createdAt: row.createdAt, ageMs: Date.now() - new Date(row.createdAt).getTime() };
    }
  }
  for (const row of longestProcessingRows) {
    if (byType[row._id] && row.startedAt) {
      byType[row._id].longestProcessing = { jobId: row.jobId, startedAt: row.startedAt, ageMs: Date.now() - new Date(row.startedAt).getTime() };
    }
  }
  for (const row of retryRows) {
    if (byType[row._id]) byType[row._id].retryCount = row.count;
  }

  const queueDepth = Object.values(byType).reduce((sum, t) => sum + t.pending + t.processing + t.retrying, 0);

  return {
    queueDepth,
    byType: PROJECT_JOB_TYPES_ORDER.map((jobType) => byType[jobType]),
  };
};

/* ───────────────────────── Recovery Dashboard ───────────────────────── */

const listRecoveryEvents = async ({ page, limit, projectId, batchId }) => {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
  const skip = (pageNum - 1) * limitNum;

  const match = {
    'error.message': { $in: Object.keys(RECOVERY_MARKER_REASONS) },
  };
  if (projectId && mongoose.Types.ObjectId.isValid(projectId)) match.project_id = new mongoose.Types.ObjectId(projectId);
  if (batchId) match['input_data.batchId'] = batchId;

  const [jobs, total] = await Promise.all([
    Job.find(match).sort({ updated_at: -1 }).skip(skip).limit(limitNum).lean(),
    Job.countDocuments(match),
  ]);

  return {
    events: jobs.map(serializeRecoveryEvent),
    pagination: { page: pageNum, limit: limitNum, total, pages: Math.max(1, Math.ceil(total / limitNum)) },
    // Explicit, not silent: these three categories exist as structured
    // [RECOVERY] log lines (chainingEngine.js / verificationBatchRecoveryService.js)
    // but have no persisted Mongo trace — surfacing them here would require
    // a new collection, which is out of scope for this phase ("NO schema
        // changes"). The dashboard shows this note rather than fabricating data.
    unavailable: ['batch_resumed', 'aggregation_resumed', 'duplicate_recovery_avoided'],
  };
};

const getRecoverySummary = async () => {
  const rows = await Job.aggregate([
    { $match: { 'error.message': { $in: Object.keys(RECOVERY_MARKER_REASONS) } } },
    { $group: { _id: '$error.message', count: { $sum: 1 } } },
  ]);

  const counts = { staleLockRecovered: 0, orphanedJobRecovered: 0 };
  for (const row of rows) {
    if (row._id === 'stale_lock_recovered') counts.staleLockRecovered = row.count;
    if (row._id === 'orphaned_pending_job_recovered') counts.orphanedJobRecovered = row.count;
  }

  // "Retry reclaimed" proxy: any job (of the 8 verification-pipeline types)
  // that reached a terminal state after at least one prior failed attempt —
  // attempts is only ever incremented by jobService.failJob, so attempts>0
  // on a terminal job means it failed and was later reclaimed at least once.
  const retryReclaimedCount = await Job.countDocuments({
    jobType: { $in: PROJECT_JOB_TYPES_ORDER },
    attempts: { $gt: 0 },
    status: { $in: ['completed', 'failed'] },
  });

  return {
    retryReclaimedCount,
    staleLockRecoveredCount: counts.staleLockRecovered,
    orphanedJobRecoveredCount: counts.orphanedJobRecovered,
  };
};

/* ─────────────────────────── Worker Health ─────────────────────────── */

const getWorkerHealth = async () => {
  const nodeUptime = {
    uptimeSeconds: Math.round(process.uptime()),
    staleLockScheduler: getStaleLockSchedulerHealth(),
    verificationBatchRecoveryScheduler: getBatchRecoverySchedulerHealth(),
  };

  // Python has no persisted heartbeat (no worker-side schema change was made
  // for this phase either) — "online/offline" and "last poll" are a
  // heuristic derived from the most recent claim across the 8
  // verification-pipeline job types: claimJob() sets claimed_at the moment
  // ANY Python poller successfully claims a job, so a very recent claimed_at
  // is good (not certain) evidence a worker is alive. Explicitly labeled as
  // a heuristic below, not a real heartbeat.
  const STALE_WORKER_THRESHOLD_MS = 5 * 60 * 1000; // matches claimJob's own 5-minute staleness window

  const [lastClaim] = await Job.aggregate([
    { $match: { jobType: { $in: PROJECT_JOB_TYPES_ORDER }, claimed_at: { $ne: null } } },
    { $sort: { claimed_at: -1 } },
    { $limit: 1 },
    { $project: { claimed_at: 1, jobType: 1 } },
  ]);

  const [processedStats] = await Job.aggregate([
    {
      $match: {
        jobType: { $in: PROJECT_JOB_TYPES_ORDER },
        status: 'completed',
        completed_at: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        started_at: { $ne: null },
      },
    },
    {
      $group: {
        _id: null,
        jobsProcessedLast24h: { $sum: 1 },
        avgProcessingMs: { $avg: { $subtract: ['$completed_at', '$started_at'] } },
      },
    },
  ]);

  const lastPollAgeMs = lastClaim ? Date.now() - new Date(lastClaim.claimed_at).getTime() : null;

  return {
    node: nodeUptime,
    python: {
      // Heuristic, not a certainty — see comment above.
      apparentlyOnline: lastPollAgeMs !== null && lastPollAgeMs < STALE_WORKER_THRESHOLD_MS,
      isStale: lastPollAgeMs === null || lastPollAgeMs >= STALE_WORKER_THRESHOLD_MS,
      lastPollAt: lastClaim?.claimed_at || null,
      lastPollAgeMs,
      jobsProcessedLast24h: processedStats?.jobsProcessedLast24h || 0,
      averageProcessingMs: processedStats?.avgProcessingMs != null ? Math.round(processedStats.avgProcessingMs) : null,
    },
  };
};

export {
  listBatches,
  getBatchesSummary,
  getBatchDetail,
  getQueueSummary,
  listRecoveryEvents,
  getRecoverySummary,
  getWorkerHealth,
};
