import mongoose from 'mongoose';
import User from '../../user/model/User.js';
import SeoProject from '../../app_user/model/SeoProject.js';
import Job from '../../jobs/model/Job.js';
import WebhookEvent from '../../subscription/model/WebhookEvent.js';
import SystemAdminAuditLog from '../../subscription/model/SystemAdminAuditLog.js';

/**
 * Operations Center (Phase 2F/2G) — Jobs, Webhooks, Audit Logs. Strictly
 * read-only: no status/retry/replay/delete logic lives here, only queries
 * against the existing Job/WebhookEvent/SystemAdminAuditLog collections.
 * Nothing in the job pipeline (jobService.js/chainingEngine.js/
 * jobDispatcher.js), Stripe webhook processing
 * (subscriptionWebhookService.js), or SystemAdminAuditLog generation
 * (adminSubscriptionController.js / systemAdminUserController.js) is
 * touched or duplicated — this file only ever reads what those already
 * wrote.
 */

/* ────────────────────────────── Jobs ────────────────────────────── */

const JOB_STATUSES = Job.schema.path('status').enumValues;
// "Do not hardcode" — job types are read from the Job model's own schema
// enum (the actual constraint on what can ever be stored), not a
// re-declared list. jobTypes.js's JOB_TYPES constant has MORE entries than
// this (legacy/unused types no longer in the schema enum), so it is
// deliberately not used here — it would offer filter options that could
// never match a real Job document.
const JOB_TYPES = Job.schema.path('jobType').enumValues;

// Operations Center groups the 6 real statuses into 5 summary buckets —
// 'claimed' and 'processing' both read as "Running", with 'retrying' kept
// as its own bucket (unlike the Dashboard's simpler Running/Failed/
// Completed/Pending cards from Phase 2B, which folds retrying into
// Running too — this view is intentionally more granular).
const JOB_SUMMARY_BUCKET = {
  pending: 'pending',
  claimed: 'running',
  processing: 'running',
  retrying: 'retrying',
  completed: 'completed',
  failed: 'failed',
};

const JOB_SORT_OPTIONS = {
  newest: { created_at: -1 },
  oldest: { created_at: 1 },
  status: { status: 1 },
  type: { jobType: 1 },
};

function jobUserJoinStages() {
  return [
    {
      $lookup: {
        from: SeoProject.collection.name,
        localField: 'project_id',
        foreignField: '_id',
        as: '_project',
      },
    },
    { $unwind: { path: '$_project', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: User.collection.name,
        localField: 'user_id',
        foreignField: '_id',
        as: '_user',
      },
    },
    { $unwind: { path: '$_user', preserveNullAndEmptyArrays: true } },
  ];
}

function serializeJobRow(row) {
  return {
    id: row._id,
    jobType: row.jobType,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    project: row._project ? { id: row._project._id, name: row._project.project_name || row._project.main_url } : null,
    user: row._user ? { id: row._user._id, firstName: row._user.firstName, lastName: row._user.lastName, email: row._user.email } : null,
    createdAt: row.created_at,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
  };
}

const listJobs = async ({ page, limit, search, status, jobType, sort }) => {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (pageNum - 1) * limitNum;

  const pipeline = [...jobUserJoinStages()];

  const match = {};
  if (status && JOB_STATUSES.includes(status)) match.status = status;
  if (jobType && JOB_TYPES.includes(jobType)) match.jobType = jobType;

  if (search && String(search).trim()) {
    const term = String(search).trim();
    const orClauses = [
      { jobType: { $regex: term, $options: 'i' } },
      { '_project.project_name': { $regex: term, $options: 'i' } },
      { '_user.firstName': { $regex: term, $options: 'i' } },
      { '_user.lastName': { $regex: term, $options: 'i' } },
      { '_user.email': { $regex: term, $options: 'i' } },
    ];
    // A search term that is itself a valid ObjectId also matches by _id —
    // lets an admin paste a job id straight into the search box.
    if (mongoose.Types.ObjectId.isValid(term)) {
      orClauses.push({ _id: new mongoose.Types.ObjectId(term) });
    }
    match.$or = orClauses;
  }

  if (Object.keys(match).length) pipeline.push({ $match: match });

  const sortSpec = JOB_SORT_OPTIONS[sort] || JOB_SORT_OPTIONS.newest;

  pipeline.push({
    $facet: {
      data: [{ $sort: sortSpec }, { $skip: skip }, { $limit: limitNum }],
      totalCount: [{ $count: 'count' }],
    },
  });

  const [result] = await Job.aggregate(pipeline);
  const total = result?.totalCount?.[0]?.count || 0;

  return {
    jobs: (result?.data || []).map(serializeJobRow),
    pagination: { page: pageNum, limit: limitNum, total, pages: Math.max(1, Math.ceil(total / limitNum)) },
    filters: { statuses: JOB_STATUSES, jobTypes: JOB_TYPES },
  };
};

const getJobDetail = async (jobId) => {
  if (!mongoose.Types.ObjectId.isValid(jobId)) return null;

  const job = await Job.findById(jobId).lean();
  if (!job) return null;

  const [project, user] = await Promise.all([
    job.project_id ? SeoProject.findById(job.project_id).select('project_name main_url').lean() : null,
    job.user_id ? User.findById(job.user_id).select('firstName lastName email').lean() : null,
  ]);

  const durationMs =
    job.started_at && job.completed_at ? new Date(job.completed_at) - new Date(job.started_at) : null;

  return {
    id: job._id,
    jobType: job.jobType,
    status: job.status,
    project: project ? { id: project._id, name: project.project_name || project.main_url } : null,
    user: user ? { id: user._id, firstName: user.firstName, lastName: user.lastName, email: user.email } : null,
    attempts: job.attempts,
    maxAttempts: job.max_attempts,
    durationMs,
    createdAt: job.created_at,
    startedAt: job.started_at || null,
    completedAt: job.completed_at || null,
    claimedAt: job.claimed_at || null,
    failureReason: job.error?.message || null,
  };
};

const getJobsSummary = async () => {
  const rows = await Job.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
  const counts = { pending: 0, running: 0, retrying: 0, completed: 0, failed: 0 };
  for (const row of rows) {
    const bucket = JOB_SUMMARY_BUCKET[row._id];
    if (bucket) counts[bucket] += row.count;
  }
  return counts;
};

/* ──────────────────────────── Webhooks ──────────────────────────── */

const WEBHOOK_STATUSES = WebhookEvent.schema.path('status').enumValues;

const WEBHOOK_SORT_OPTIONS = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  status: { status: 1 },
  type: { eventType: 1 },
};

function serializeWebhookRow(w) {
  return {
    id: w._id,
    stripeEventId: w.stripeEventId,
    eventType: w.eventType,
    status: w.status,
    createdAt: w.createdAt,
    processedAt: w.processedAt || null,
  };
}

// No search is defined for webhooks (Step 5 — pagination/filters/sorting
// only, no search field). WebhookEvent has no user/project relation to
// search across either.
const listWebhooks = async ({ page, limit, status, eventType, sort }) => {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (pageNum - 1) * limitNum;

  const query = {};
  if (status && WEBHOOK_STATUSES.includes(status)) query.status = status;
  if (eventType && String(eventType).trim()) query.eventType = String(eventType).trim();

  const sortSpec = WEBHOOK_SORT_OPTIONS[sort] || WEBHOOK_SORT_OPTIONS.newest;

  const [events, total, eventTypes] = await Promise.all([
    WebhookEvent.find(query).sort(sortSpec).skip(skip).limit(limitNum).lean(),
    WebhookEvent.countDocuments(query),
    // "Populate from database" — no schema enum exists for eventType (it's
    // whatever Stripe sends), so distinct() against real stored events is
    // the only honest source, unlike jobType/action which have a schema
    // enum to read from instead.
    WebhookEvent.distinct('eventType'),
  ]);

  return {
    webhooks: events.map(serializeWebhookRow),
    pagination: { page: pageNum, limit: limitNum, total, pages: Math.max(1, Math.ceil(total / limitNum)) },
    filters: { statuses: WEBHOOK_STATUSES, eventTypes: eventTypes.sort() },
  };
};

const getWebhookDetail = async (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;

  const w = await WebhookEvent.findById(id).lean();
  if (!w) return null;

  const processingTimeMs = w.processedAt ? new Date(w.processedAt) - new Date(w.createdAt) : null;

  return {
    id: w._id,
    stripeEventId: w.stripeEventId,
    eventType: w.eventType,
    status: w.status,
    processingTimeMs,
    error: w.processingError || null,
    createdAt: w.createdAt,
    processedAt: w.processedAt || null,
  };
};

const getWebhooksSummary = async () => {
  const rows = await WebhookEvent.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
  const counts = { completed: 0, processing: 0, failed: 0, ignored: 0 };
  for (const row of rows) {
    if (row._id in counts) counts[row._id] = row.count;
  }
  return counts;
};

/* ─────────────────────────── Audit Logs ─────────────────────────── */

const AUDIT_ACTIONS = SystemAdminAuditLog.schema.path('action').enumValues;

const AUDIT_SORT_OPTIONS = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
};

function auditUserJoinStages() {
  return [
    {
      $lookup: {
        from: User.collection.name,
        localField: 'admin',
        foreignField: '_id',
        as: '_admin',
      },
    },
    { $unwind: { path: '$_admin', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: User.collection.name,
        localField: 'targetUser',
        foreignField: '_id',
        as: '_targetUser',
      },
    },
    { $unwind: { path: '$_targetUser', preserveNullAndEmptyArrays: true } },
  ];
}

function serializeAuditRow(row) {
  return {
    id: row._id,
    action: row.action,
    admin: row._admin
      ? { id: row._admin._id, firstName: row._admin.firstName, lastName: row._admin.lastName, email: row._admin.email }
      : null,
    targetUser: row._targetUser
      ? { id: row._targetUser._id, firstName: row._targetUser.firstName, lastName: row._targetUser.lastName, email: row._targetUser.email }
      : null,
    reason: row.reason || null,
    createdAt: row.createdAt,
  };
}

const listAuditLogs = async ({ page, limit, search, action, admin, sort }) => {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (pageNum - 1) * limitNum;

  const pipeline = [...auditUserJoinStages()];

  const match = {};
  if (action && AUDIT_ACTIONS.includes(action)) match.action = action;
  if (admin && mongoose.Types.ObjectId.isValid(admin)) match.admin = new mongoose.Types.ObjectId(admin);

  if (search && String(search).trim()) {
    const term = String(search).trim();
    match.$or = [
      { '_admin.firstName': { $regex: term, $options: 'i' } },
      { '_admin.lastName': { $regex: term, $options: 'i' } },
      { '_admin.email': { $regex: term, $options: 'i' } },
      { '_targetUser.firstName': { $regex: term, $options: 'i' } },
      { '_targetUser.lastName': { $regex: term, $options: 'i' } },
      { '_targetUser.email': { $regex: term, $options: 'i' } },
    ];
  }

  if (Object.keys(match).length) pipeline.push({ $match: match });

  const sortSpec = AUDIT_SORT_OPTIONS[sort] || AUDIT_SORT_OPTIONS.newest;

  pipeline.push({
    $facet: {
      data: [{ $sort: sortSpec }, { $skip: skip }, { $limit: limitNum }],
      totalCount: [{ $count: 'count' }],
      // "Admin: Dynamic" — the filter dropdown is populated from admins who
      // actually have audit log entries, not every roleId===1 account.
      admins: [
        { $group: { _id: '$admin', firstName: { $first: '$_admin.firstName' }, lastName: { $first: '$_admin.lastName' } } },
        { $sort: { firstName: 1 } },
      ],
    },
  });

  const [result] = await SystemAdminAuditLog.aggregate(pipeline);
  const total = result?.totalCount?.[0]?.count || 0;
  const admins = (result?.admins || [])
    .filter((a) => a._id)
    .map((a) => ({ id: a._id, name: `${a.firstName || ''} ${a.lastName || ''}`.trim() || 'Unknown' }));

  return {
    auditLogs: (result?.data || []).map(serializeAuditRow),
    pagination: { page: pageNum, limit: limitNum, total, pages: Math.max(1, Math.ceil(total / limitNum)) },
    filters: { actions: AUDIT_ACTIONS, admins },
  };
};

const getAuditLogDetail = async (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;

  const log = await SystemAdminAuditLog.findById(id).lean();
  if (!log) return null;

  const [admin, targetUser] = await Promise.all([
    User.findById(log.admin).select('firstName lastName email').lean(),
    User.findById(log.targetUser).select('firstName lastName email').lean(),
  ]);

  return {
    id: log._id,
    action: log.action,
    admin: admin ? { id: admin._id, firstName: admin.firstName, lastName: admin.lastName, email: admin.email } : null,
    targetUser: targetUser
      ? { id: targetUser._id, firstName: targetUser.firstName, lastName: targetUser.lastName, email: targetUser.email }
      : null,
    before: log.before ?? null,
    after: log.after ?? null,
    reason: log.reason || null,
    createdAt: log.createdAt,
  };
};

const getAuditLogsSummary = async () => {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [todayCount, actionCounts] = await Promise.all([
    SystemAdminAuditLog.countDocuments({ createdAt: { $gte: startOfToday } }),
    SystemAdminAuditLog.aggregate([{ $group: { _id: '$action', count: { $sum: 1 } } }]),
  ]);

  const counts = { todayActions: todayCount, suspensions: 0, activations: 0, planChanges: 0, quotaChanges: 0 };
  const ACTION_TO_KEY = {
    account_suspended: 'suspensions',
    account_activated: 'activations',
    plan_assignment: 'planChanges',
    quota_adjustment: 'quotaChanges',
  };
  for (const row of actionCounts) {
    const key = ACTION_TO_KEY[row._id];
    if (key) counts[key] = row.count;
  }
  return counts;
};

export {
  listJobs,
  getJobDetail,
  getJobsSummary,
  listWebhooks,
  getWebhookDetail,
  getWebhooksSummary,
  listAuditLogs,
  getAuditLogDetail,
  getAuditLogsSummary,
};
