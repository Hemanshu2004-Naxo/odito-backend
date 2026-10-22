import mongoose from 'mongoose';
import User from '../../user/model/User.js';
import SeoProject from '../../app_user/model/SeoProject.js';
import AuditRun from '../../audit_history/model/AuditRun.js';
import Job from '../../jobs/model/Job.js';
import SystemAdminAuditLog from '../../subscription/model/SystemAdminAuditLog.js';
import { startProjectAudit, isAuditInProgress } from '../../app_user/service/projectAuditService.js';
import { RUN_SOURCES } from '../../jobs/runSources.js';
import { deleteProjectCascade } from '../../app_user/service/projectCascadeDeleteService.js';

/**
 * Projects (Phase 2H) — read-only monitoring + two mutating actions that
 * reuse EXISTING service functions verbatim:
 *   - startAuditForProject() calls startProjectAudit(projectId,
 *     {source:'admin_recrawl'}). That source (unlike 'manual_recrawl')
 *     skips the per-request ownership check inside startProjectAudit() and
 *     is never billed against the owner's manual recrawls — no new bypass
 *     logic was added to the pipeline for this.
 *   - deleteProjectSoft() reuses isAuditInProgress() (imported, not
 *     duplicated) and performs the same ~10-line soft-delete mutation
 *     seoProjectController.js's deleteSeoProject does, just without the
 *     user_id ownership filter on the lookup.
 *
 * Pause/Resume Audit and Cancel Audit are deliberately NOT implemented —
 * see Phase 2H's audit report: no pause/resume primitive exists anywhere
 * in the Job model or pipeline, and the existing cancelAudit
 * (scrapingController.js) is tightly coupled to a single request (forwards
 * the caller's own auth header to the Python worker, ownership check
 * inline) — reusing it for admin-on-behalf-of-another-user would either
 * duplicate that logic or require refactoring an unrelated, currently
 * working module. Per explicit instruction, both are omitted rather than
 * reimplemented or duplicated.
 */

const PROJECT_STATUSES = SeoProject.schema.path('status').enumValues; // draft/active/paused/error
const CRAWL_STATUSES = SeoProject.schema.path('crawl_status').enumValues;
const SUBSCRIPTION_STATUSES = ['inactive', 'active', 'paused', 'canceled', 'past_due'];

// crawl_status bucketing for the "Audit Status" summary cards — real enum
// values only, grouped into the 3 buckets the summary cards ask for.
// "Paused Audits" has no crawl_status equivalent (crawl_status has no
// 'paused' value) — it maps to the project-level status:'paused' instead,
// which IS a real, existing enum value.
const RUNNING_CRAWL_STATUSES = ['pending', 'running', 'discovered', 'awaiting_url_selection', 'crawled'];
const FAILED_CRAWL_STATUSES = ['failed', 'cancelled'];

const SORT_OPTIONS = {
  newest: { created_at: -1 },
  oldest: { created_at: 1 },
  name: { project_name: 1 },
  lastAudit: { _lastAuditAt: -1 },
  // Only meaningful on the "deleted" view — most recently trashed first.
  deletedNewest: { deleted_at: -1 },
};

function ownerJoinStage() {
  return [
    {
      $lookup: {
        from: User.collection.name,
        localField: 'user_id',
        foreignField: '_id',
        as: '_owner',
      },
    },
    { $unwind: { path: '$_owner', preserveNullAndEmptyArrays: true } },
  ];
}

// Only joined for the "deleted" view (see listProjects) — the active view
// never needs deleted_by, so this stays out of the common-case pipeline.
function deletedByJoinStage() {
  return [
    {
      $lookup: {
        from: User.collection.name,
        localField: 'deleted_by',
        foreignField: '_id',
        as: '_deletedBy',
      },
    },
    { $unwind: { path: '$_deletedBy', preserveNullAndEmptyArrays: true } },
  ];
}

function lastAuditJoinStage() {
  return [
    {
      $lookup: {
        from: AuditRun.collection.name,
        let: { projectId: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$projectId', '$$projectId'] } } },
          { $sort: { startedAt: -1 } },
          { $limit: 1 },
          { $project: { startedAt: 1, completedAt: 1, websiteScore: 1 } },
        ],
        as: '_lastAudit',
      },
    },
    { $unwind: { path: '$_lastAudit', preserveNullAndEmptyArrays: true } },
    { $addFields: { _lastAuditAt: '$_lastAudit.startedAt' } },
  ];
}

function serializeListRow(row) {
  return {
    id: row._id,
    projectName: row.project_name,
    website: row.main_url,
    status: row.status,
    crawlStatus: row.crawl_status,
    totalPages: row.total_pages || 0,
    industry: row.industry || null,
    isDeleted: !!row.is_deleted,
    owner: row._owner
      ? {
          id: row._owner._id,
          firstName: row._owner.firstName,
          lastName: row._owner.lastName,
          email: row._owner.email,
        }
      : null,
    lastAudit: row._lastAudit
      ? {
          startedAt: row._lastAudit.startedAt,
          completedAt: row._lastAudit.completedAt || null,
          websiteScore: row._lastAudit.websiteScore ?? null,
        }
      : null,
    // Only ever populated on the "deleted" view (deletedByJoinStage is only
    // added to that pipeline) — undefined/null on the active view.
    deletedAt: row.deleted_at || null,
    scheduledPurgeAt: row.scheduled_purge_at || null,
    deletedBy: row._deletedBy
      ? { id: row._deletedBy._id, firstName: row._deletedBy.firstName, lastName: row._deletedBy.lastName, email: row._deletedBy.email }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// view: 'active' (default) shows only non-deleted projects, exactly like
// before. 'deleted' shows ONLY trashed projects — a dedicated Deleted
// Projects tab, not a mixed active+deleted list.
function buildMatchStage({ search, owner, status, industry, subscriptionStatus, view }) {
  const match = {};

  match.is_deleted = view === 'deleted' ? true : { $ne: true };

  if (search && String(search).trim()) {
    const term = String(search).trim();
    match.$or = [
      { project_name: { $regex: term, $options: 'i' } },
      { main_url: { $regex: term, $options: 'i' } },
      { '_owner.firstName': { $regex: term, $options: 'i' } },
      { '_owner.lastName': { $regex: term, $options: 'i' } },
      { '_owner.email': { $regex: term, $options: 'i' } },
    ];
  }

  if (owner && mongoose.Types.ObjectId.isValid(owner)) {
    match.user_id = new mongoose.Types.ObjectId(owner);
  }

  if (status && PROJECT_STATUSES.includes(status)) {
    match.status = status;
  }

  if (industry && String(industry).trim()) {
    match.industry = String(industry).trim();
  }

  if (subscriptionStatus && SUBSCRIPTION_STATUSES.includes(subscriptionStatus)) {
    match['_owner.subscription.status'] = subscriptionStatus;
  }

  return match;
}

/**
 * List + search + filter + sort + paginate across ALL users' projects —
 * one aggregation, $lookup for owner + latest AuditRun done once per
 * project (not per row in application code), $facet for paginated data +
 * count + dynamic industry list in the same round trip.
 */
const listProjects = async ({ page, limit, search, owner, status, industry, subscriptionStatus, view, sort }) => {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (pageNum - 1) * limitNum;
  const resolvedView = view === 'deleted' ? 'deleted' : 'active';

  const pipeline = [
    ...ownerJoinStage(),
    ...lastAuditJoinStage(),
    ...(resolvedView === 'deleted' ? deletedByJoinStage() : []),
  ];

  const matchStage = buildMatchStage({ search, owner, status, industry, subscriptionStatus, view: resolvedView });
  pipeline.push({ $match: matchStage });

  const sortSpec = SORT_OPTIONS[sort] || SORT_OPTIONS.newest;

  pipeline.push({
    $facet: {
      data: [{ $sort: sortSpec }, { $skip: skip }, { $limit: limitNum }],
      totalCount: [{ $count: 'count' }],
      industries: [
        { $match: { industry: { $ne: null } } },
        { $group: { _id: '$industry' } },
        { $sort: { _id: 1 } },
      ],
    },
  });

  const [result] = await SeoProject.aggregate(pipeline);
  const total = result?.totalCount?.[0]?.count || 0;
  const industries = (result?.industries || []).map((i) => i._id).filter(Boolean);

  return {
    projects: (result?.data || []).map(serializeListRow),
    pagination: { page: pageNum, limit: limitNum, total, pages: Math.max(1, Math.ceil(total / limitNum)) },
    filters: { statuses: PROJECT_STATUSES, industries },
  };
};

/**
 * Platform-wide project/audit rollup for the 6 summary cards. One
 * aggregation via $facet — every bucket computed in the same round trip,
 * nothing calculated twice.
 */
const getProjectsSummary = async () => {
  const [result] = await SeoProject.aggregate([
    {
      $facet: {
        total: [{ $match: { is_deleted: { $ne: true } } }, { $count: 'count' }],
        running: [{ $match: { is_deleted: { $ne: true }, crawl_status: { $in: RUNNING_CRAWL_STATUSES } } }, { $count: 'count' }],
        completed: [{ $match: { is_deleted: { $ne: true }, crawl_status: 'completed' } }, { $count: 'count' }],
        failed: [{ $match: { is_deleted: { $ne: true }, crawl_status: { $in: FAILED_CRAWL_STATUSES } } }, { $count: 'count' }],
        paused: [{ $match: { is_deleted: { $ne: true }, status: 'paused' } }, { $count: 'count' }],
        deleted: [{ $match: { is_deleted: true } }, { $count: 'count' }],
      },
    },
  ]);

  const count = (facet) => result?.[facet]?.[0]?.count || 0;

  return {
    total: count('total'),
    running: count('running'),
    completed: count('completed'),
    failed: count('failed'),
    paused: count('paused'),
    deleted: count('deleted'),
  };
};

/**
 * Full project profile: project fields + owner + statistics (job counts,
 * audit count) + last 5 audits + last 5 jobs.
 */
const getProjectDetail = async (projectId) => {
  if (!mongoose.Types.ObjectId.isValid(projectId)) return null;

  const project = await SeoProject.findById(projectId).lean();
  if (!project) return null;

  const [owner, recentAudits, recentJobs, jobStatusCounts, auditCount] = await Promise.all([
    User.findById(project.user_id).select('firstName lastName email subscription.status').lean(),
    AuditRun.find({ projectId }).sort({ startedAt: -1 }).limit(5).lean(),
    Job.find({ project_id: projectId }).sort({ created_at: -1 }).limit(5).lean(),
    Job.aggregate([{ $match: { project_id: new mongoose.Types.ObjectId(projectId) } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    AuditRun.countDocuments({ projectId }),
  ]);

  const jobCounts = { pending: 0, claimed: 0, processing: 0, retrying: 0, completed: 0, failed: 0 };
  for (const row of jobStatusCounts) {
    if (row._id in jobCounts) jobCounts[row._id] = row.count;
  }

  return {
    id: project._id,
    projectName: project.project_name,
    website: project.main_url,
    status: project.status,
    crawlStatus: project.crawl_status,
    industry: project.industry || null,
    businessType: project.business_type || null,
    totalPages: project.total_pages || 0,
    totalIssues: project.total_issues || 0,
    isDeleted: !!project.is_deleted,
    deletedAt: project.deleted_at || null,
    owner: owner
      ? {
          id: owner._id,
          firstName: owner.firstName,
          lastName: owner.lastName,
          email: owner.email,
          subscriptionStatus: owner.subscription?.status || null,
        }
      : null,
    statistics: {
      auditCount,
      jobs: jobCounts,
    },
    recentAudits: recentAudits.map((a) => ({
      id: a._id,
      auditNumber: a.auditNumber,
      startedAt: a.startedAt,
      completedAt: a.completedAt || null,
      websiteScore: a.websiteScore ?? null,
      totalIssues: a.totalIssues ?? null,
    })),
    recentJobs: recentJobs.map((j) => ({
      id: j._id,
      jobType: j.jobType,
      status: j.status,
      createdAt: j.created_at,
      completedAt: j.completed_at || null,
    })),
    createdAt: project.created_at,
    updatedAt: project.updated_at,
  };
};

/**
 * Reuses startProjectAudit() verbatim — see the file-level comment for why
 * source:'admin_recrawl' (formerly the 'scheduled' alias) is the correct,
 * already-existing bypass of the per-request ownership check (not a new
 * one). It is also never billed against the owner's manual recrawls.
 */
const startAuditForProject = async (projectId, adminId, reason) => {
  const project = await SeoProject.findById(projectId).select('user_id crawl_status is_deleted');
  if (!project || project.is_deleted) return null;

  const before = { crawlStatus: project.crawl_status };
  const result = await startProjectAudit(projectId, { source: RUN_SOURCES.ADMIN_RECRAWL });

  await SystemAdminAuditLog.create({
    admin: adminId,
    targetUser: project.user_id,
    action: 'project_audit_started',
    before,
    after: { success: result.success, code: result.code || null },
    reason: reason || null,
  });

  return result;
};

/**
 * Same soft-delete shape as seoProjectController.js's deleteSeoProject —
 * same isAuditInProgress() guard (imported, not duplicated), same
 * is_deleted/deleted_at/scheduled_purge_at/deleted_by fields, just without
 * the user_id ownership filter. The project's own owner can still restore
 * it via their normal Trash page — restore only checks user_id, not
 * deleted_by.
 */
const deleteProjectSoft = async (projectId, adminId, reason) => {
  const project = await SeoProject.findOne({ _id: projectId, is_deleted: { $ne: true } });
  if (!project) return null;

  if (await isAuditInProgress(projectId)) {
    return { blocked: true, code: 'AUDIT_IN_PROGRESS' };
  }

  const now = new Date();
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  await SeoProject.updateOne(
    { _id: projectId },
    {
      is_deleted: true,
      deleted_at: now,
      scheduled_purge_at: new Date(now.getTime() + SEVEN_DAYS_MS),
      deleted_by: adminId,
    }
  );

  await SystemAdminAuditLog.create({
    admin: adminId,
    targetUser: project.user_id,
    action: 'project_deleted',
    before: { isDeleted: false },
    after: { isDeleted: true },
    reason: reason || null,
  });

  return { blocked: false, projectId };
};

/**
 * Same field-reset shape as seoProjectController.js's restoreProject —
 * is_deleted/deleted_at/scheduled_purge_at/deleted_by all cleared — just
 * looked up without the user_id ownership check that endpoint enforces.
 */
const restoreProjectAdmin = async (projectId, adminId, reason) => {
  const project = await SeoProject.findById(projectId);
  if (!project) return null;

  if (!project.is_deleted) {
    return { notDeleted: true };
  }

  const before = { isDeleted: true, deletedAt: project.deleted_at };

  project.is_deleted = false;
  project.deleted_at = null;
  project.scheduled_purge_at = null;
  project.deleted_by = null;
  await project.save();

  await SystemAdminAuditLog.create({
    admin: adminId,
    targetUser: project.user_id,
    action: 'project_restored',
    before,
    after: { isDeleted: false },
    reason: reason || null,
  });

  return { restored: true, projectId };
};

/**
 * Reuses deleteProjectCascade() verbatim (imported, not duplicated) — the
 * exact same pure function the customer's own "Delete Permanently" button
 * and the daily deletedProjectPurgeScheduler.js both already call in
 * production. Same is_deleted guard seoProjectController.js's
 * permanentlyDeleteProject enforces, just without the ownership check.
 */
const permanentlyDeleteProjectAdmin = async (projectId, adminId, reason) => {
  const project = await SeoProject.findById(projectId).select('user_id is_deleted project_name');
  if (!project) return null;

  if (!project.is_deleted) {
    return { notDeleted: true };
  }

  const result = await deleteProjectCascade(projectId);

  await SystemAdminAuditLog.create({
    admin: adminId,
    targetUser: project.user_id,
    action: 'project_permanently_deleted',
    before: { projectName: project.project_name, isDeleted: true },
    after: { deleted: true },
    reason: reason || null,
  });

  return { deleted: true, result };
};

export {
  listProjects,
  getProjectsSummary,
  getProjectDetail,
  startAuditForProject,
  deleteProjectSoft,
  restoreProjectAdmin,
  permanentlyDeleteProjectAdmin,
};
