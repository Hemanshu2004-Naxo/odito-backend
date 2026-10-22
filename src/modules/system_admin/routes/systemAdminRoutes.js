import express from 'express';
import { getDashboard } from '../controller/systemAdminDashboardController.js';
import {
  listUsers,
  getUserDetail,
  suspendUser,
  activateUser,
} from '../controller/systemAdminUserController.js';
import {
  listSubscriptions,
  getSubscriptionDetail,
} from '../controller/systemAdminSubscriptionController.js';
import {
  listCustomPlanRequests,
  getCustomPlanRequestDetail,
} from '../controller/systemAdminCustomPlanRequestController.js';
import {
  listPayments,
  getPaymentsSummary,
  getPaymentDetail,
} from '../controller/systemAdminPaymentController.js';
import {
  listJobs,
  getJobDetail,
  getJobsSummary,
  listWebhooks,
  getWebhookDetail,
  getWebhooksSummary,
  listAuditLogs,
  getAuditLogDetail,
  getAuditLogsSummary,
} from '../controller/systemAdminOperationsController.js';
import {
  listProjects,
  getProjectsSummary,
  getProjectDetail,
  startAudit,
  deleteProject,
  restoreProject,
  permanentlyDeleteProject,
} from '../controller/systemAdminProjectController.js';
import {
  listBatches,
  getBatchesSummary,
  getBatchDetail,
  getQueueSummary,
  listRecoveryEvents,
  getRecoverySummary,
  getWorkerHealth,
} from '../controller/systemAdminVerificationOpsController.js';
import auth from '../../user/middleware/auth.js';
import { requireSystemAdmin } from '../../../middleware/auth.middleware.js';

const router = express.Router();

/**
 * @route   GET /api/system-admin/dashboard
 * @desc    Aggregate System Admin dashboard statistics (users, subscriptions,
 *          revenue, projects, audits, jobs, webhooks).
 * @access  Private (roleId === 1 only)
 */
router.get('/system-admin/dashboard', auth, requireSystemAdmin(), getDashboard);

/**
 * @route   GET /api/system-admin/users
 * @desc    List users — search, filter (role/subscriptionStatus/
 *          emailVerified/accountStatus), sort, paginate.
 * @access  Private (roleId === 1 only)
 */
router.get('/system-admin/users', auth, requireSystemAdmin(), listUsers);

/**
 * @route   GET /api/system-admin/users/:id
 * @desc    Full user profile: account, subscription, credits, pages,
 *          project/audit counts, last 5 billing records.
 * @access  Private (roleId === 1 only)
 */
router.get('/system-admin/users/:id', auth, requireSystemAdmin(), getUserDetail);

/**
 * @route   POST /api/system-admin/users/:id/suspend
 * @desc    Sets isActive=false. Audit-logged. An admin cannot suspend their
 *          own account.
 * @access  Private (roleId === 1 only)
 */
router.post('/system-admin/users/:id/suspend', auth, requireSystemAdmin(), suspendUser);

/**
 * @route   POST /api/system-admin/users/:id/activate
 * @desc    Sets isActive=true. Audit-logged.
 * @access  Private (roleId === 1 only)
 */
router.post('/system-admin/users/:id/activate', auth, requireSystemAdmin(), activateUser);

/**
 * @route   GET /api/system-admin/subscriptions
 * @desc    List subscriptions — search, filter (plan/status/
 *          hasStripeCustomer/hasSubscription), sort, paginate.
 * @access  Private (roleId === 1 only)
 */
router.get('/system-admin/subscriptions', auth, requireSystemAdmin(), listSubscriptions);

/**
 * @route   GET /api/system-admin/subscriptions/:userId
 * @desc    Full subscription profile: account, subscription (incl. live
 *          Stripe renewal info), credits, pages, billing summary, recent
 *          transactions/additional-credits/additional-pages.
 * @access  Private (roleId === 1 only)
 *
 * Plan/quota/status CHANGES are deliberately not routed through here —
 * see modules/subscription/routes/subscriptionRoutes.js's existing
 * /subscription/admin/users/:userId/{plan,quota,status} routes
 * (adminAssignPlan/adminAdjustQuota/adminUpdateStatus), which the System
 * Admin UI calls directly. Reused as-is, not duplicated.
 */
router.get('/system-admin/subscriptions/:userId', auth, requireSystemAdmin(), getSubscriptionDetail);

/**
 * @route   GET /api/system-admin/custom-plan-requests
 * @desc    List Custom Plan requests — search (company/email/contact),
 *          filter (status), sort (newest/oldest), paginate.
 * @access  Private (roleId === 1 only)
 */
router.get('/system-admin/custom-plan-requests', auth, requireSystemAdmin(), listCustomPlanRequests);

/**
 * @route   GET /api/system-admin/custom-plan-requests/:id
 * @desc    Full request detail: every submitted field, internal admin
 *          notes, and the merged Created/status-change/note Timeline.
 *          Status/note WRITES are deliberately not routed through here —
 *          see modules/subscription/routes/subscriptionRoutes.js's
 *          /subscription/admin/custom-plan-requests/:id/{status,notes}
 *          routes, same split already established for Subscriptions above.
 * @access  Private (roleId === 1 only)
 */
router.get('/system-admin/custom-plan-requests/:id', auth, requireSystemAdmin(), getCustomPlanRequestDetail);

/**
 * @route   GET /api/system-admin/payments
 * @desc    Merged Transaction + PagePurchase + CreditPurchase list — search,
 *          filter (paymentType/status/invoice/currency), sort, paginate.
 *          Served entirely from MongoDB (one aggregation, no Stripe calls).
 * @access  Private (roleId === 1 only)
 */
router.get('/system-admin/payments', auth, requireSystemAdmin(), listPayments);

/**
 * @route   GET /api/system-admin/payments/summary
 * @desc    Platform-wide revenue/status rollup for the summary cards.
 *          Registered BEFORE /payments/:paymentId so "summary" is never
 *          matched as a paymentId.
 * @access  Private (roleId === 1 only)
 */
router.get('/system-admin/payments/summary', auth, requireSystemAdmin(), getPaymentsSummary);

/**
 * @route   GET /api/system-admin/payments/:paymentId
 * @desc    Full payment detail. paymentId is "<source>:<objectId>" (as
 *          returned by the list endpoint) — identifies which of the 3
 *          underlying collections to read.
 * @access  Private (roleId === 1 only)
 */
router.get('/system-admin/payments/:paymentId', auth, requireSystemAdmin(), getPaymentDetail);

/**
 * @route   GET /api/system-admin/jobs
 * @desc    List jobs — search (jobType/project/user/id), filter (status/
 *          jobType), sort, paginate. Read-only monitoring — no
 *          retry/cancel/requeue action anywhere in this module.
 * @access  Private (roleId === 1 only)
 */
router.get('/system-admin/jobs', auth, requireSystemAdmin(), listJobs);

/**
 * @route   GET /api/system-admin/jobs/summary
 * @desc    Pending/Running/Retrying/Completed/Failed counts. Registered
 *          BEFORE /jobs/:jobId so "summary" is never matched as a jobId.
 * @access  Private (roleId === 1 only)
 */
router.get('/system-admin/jobs/summary', auth, requireSystemAdmin(), getJobsSummary);

/**
 * @route   GET /api/system-admin/jobs/:jobId
 * @desc    Full job detail: project, user, type, status, duration, retry
 *          count, timestamps, failure reason.
 * @access  Private (roleId === 1 only)
 */
router.get('/system-admin/jobs/:jobId', auth, requireSystemAdmin(), getJobDetail);

/**
 * @route   GET /api/system-admin/webhooks
 * @desc    List Stripe WebhookEvent rows — filter (status/eventType), sort,
 *          paginate. No search field (no user/project relation to search).
 * @access  Private (roleId === 1 only)
 */
router.get('/system-admin/webhooks', auth, requireSystemAdmin(), listWebhooks);

/**
 * @route   GET /api/system-admin/webhooks/summary
 * @desc    Completed/Processing/Failed/Ignored counts. Registered BEFORE
 *          /webhooks/:id.
 * @access  Private (roleId === 1 only)
 */
router.get('/system-admin/webhooks/summary', auth, requireSystemAdmin(), getWebhooksSummary);

/**
 * @route   GET /api/system-admin/webhooks/:id
 * @desc    Full webhook event detail: event type, status, Stripe event id,
 *          processing time, error, created/processed timestamps.
 * @access  Private (roleId === 1 only)
 */
router.get('/system-admin/webhooks/:id', auth, requireSystemAdmin(), getWebhookDetail);

/**
 * @route   GET /api/system-admin/audit-logs
 * @desc    List SystemAdminAuditLog rows — search (admin/target user name/email),
 *          filter (action/admin), sort by date, paginate.
 * @access  Private (roleId === 1 only)
 */
router.get('/system-admin/audit-logs', auth, requireSystemAdmin(), listAuditLogs);

/**
 * @route   GET /api/system-admin/audit-logs/summary
 * @desc    Today's Actions / Suspensions / Activations / Plan Changes /
 *          Quota Changes counts. Registered BEFORE /audit-logs/:id.
 * @access  Private (roleId === 1 only)
 */
router.get('/system-admin/audit-logs/summary', auth, requireSystemAdmin(), getAuditLogsSummary);

/**
 * @route   GET /api/system-admin/audit-logs/:id
 * @desc    Full audit log entry: admin, target user, action, before/after,
 *          reason, timestamp.
 * @access  Private (roleId === 1 only)
 */
router.get('/system-admin/audit-logs/:id', auth, requireSystemAdmin(), getAuditLogDetail);

/**
 * @route   GET /api/system-admin/projects
 * @desc    List projects across ALL users — search (name/url/owner),
 *          filter (owner/status/industry/subscriptionStatus), sort,
 *          paginate. One aggregation, no N+1.
 * @access  Private (roleId === 1 only)
 */
router.get('/system-admin/projects', auth, requireSystemAdmin(), listProjects);

/**
 * @route   GET /api/system-admin/projects/summary
 * @desc    Total/Running/Completed/Failed/Paused/Deleted counts. Registered
 *          BEFORE /projects/:id.
 * @access  Private (roleId === 1 only)
 */
router.get('/system-admin/projects/summary', auth, requireSystemAdmin(), getProjectsSummary);

/**
 * @route   GET /api/system-admin/projects/:id
 * @desc    Full project profile: project fields, owner, job/audit
 *          statistics, last 5 audits, last 5 jobs.
 * @access  Private (roleId === 1 only)
 */
router.get('/system-admin/projects/:id', auth, requireSystemAdmin(), getProjectDetail);

/**
 * @route   POST /api/system-admin/projects/:id/start-audit
 * @desc    Reuses startProjectAudit(projectId, {source:'admin_recrawl'}) —
 *          the full-audit pipeline, unbilled to the owner. No new
 *          pipeline logic. Audit-logged.
 * @access  Private (roleId === 1 only)
 */
router.post('/system-admin/projects/:id/start-audit', auth, requireSystemAdmin(), startAudit);

/**
 * @route   DELETE /api/system-admin/projects/:id
 * @desc    Soft-delete (same fields/guard as seoProjectController.js's
 *          deleteSeoProject, without the ownership filter). The owner can
 *          still restore it from their own Trash page. Audit-logged.
 * @access  Private (roleId === 1 only)
 */
router.delete('/system-admin/projects/:id', auth, requireSystemAdmin(), deleteProject);

/**
 * @route   POST /api/system-admin/projects/:id/restore
 * @desc    Restores a trashed project — same field reset as
 *          seoProjectController.js's restoreProject, without the
 *          ownership check. Audit-logged.
 * @access  Private (roleId === 1 only)
 */
router.post('/system-admin/projects/:id/restore', auth, requireSystemAdmin(), restoreProject);

/**
 * @route   DELETE /api/system-admin/projects/:id/permanent
 * @desc    Permanently deletes a trashed project via the existing
 *          deleteProjectCascade() (same function the customer's own
 *          "Delete Permanently" button and the daily purge scheduler use).
 *          Audit-logged.
 * @access  Private (roleId === 1 only)
 */
router.delete('/system-admin/projects/:id/permanent', auth, requireSystemAdmin(), permanentlyDeleteProject);

/**
 * ─────────────────────── Verification Operations Dashboard (ODITO-OPS-001) ───────────────────────
 * Strictly read-only: no retry/requeue/cancel/repair action anywhere in this
 * section. Every endpoint below only queries VerificationBatch/
 * PageVerificationRun/Job (existing collections, no schema changes) plus two
 * purely-additive scheduler health getters — the verification pipeline,
 * workers, retry behavior, and queue semantics built in F4-016/017/018 are
 * completely unmodified.
 */

/**
 * @route   GET /api/system-admin/verification/batches
 * @desc    List Verification Batches — search (batchId/project/user email),
 *          filter (status/project/user/date range/stuckOnly), sort, paginate.
 * @access  Private (roleId === 1 only)
 */
router.get('/system-admin/verification/batches', auth, requireSystemAdmin(), listBatches);

/**
 * @route   GET /api/system-admin/verification/batches/summary
 * @desc    Status counts (pending/running/aggregating/completed/partial/
 *          failed), stuck-batch count, average URLs per batch, average and
 *          longest batch duration. Registered BEFORE /batches/:batchId.
 * @access  Private (roleId === 1 only)
 */
router.get('/system-admin/verification/batches/summary', auth, requireSystemAdmin(), getBatchesSummary);

/**
 * @route   GET /api/system-admin/verification/batches/:batchId
 * @desc    Full batch detail: VerificationBatch, project/user, every
 *          PageVerificationRun, every Job stamped with this batchId, a
 *          derived Timeline, and any recovery-marker events found among
 *          those jobs.
 * @access  Private (roleId === 1 only)
 */
router.get('/system-admin/verification/batches/:batchId', auth, requireSystemAdmin(), getBatchDetail);

/**
 * @route   GET /api/system-admin/verification/queue/summary
 * @desc    Live queue counts (pending/processing/retrying/failed/completed)
 *          grouped by the 8 verification-pipeline job types, plus oldest
 *          pending job, longest-processing job, and retry counts per type.
 * @access  Private (roleId === 1 only)
 */
router.get('/system-admin/verification/queue/summary', auth, requireSystemAdmin(), getQueueSummary);

/**
 * @route   GET /api/system-admin/verification/recovery
 * @desc    List recovery events derivable from persisted Job data (stale
 *          lock recovered, orphaned pending job recovered) — filter by
 *          project/batch. batch-resumed/aggregation-resumed/duplicate-
 *          recovery-avoided are NOT included (log-line-only today, no
 *          schema change was made to persist them) — the response's
 *          `unavailable` field names this gap explicitly.
 * @access  Private (roleId === 1 only)
 */
router.get('/system-admin/verification/recovery', auth, requireSystemAdmin(), listRecoveryEvents);

/**
 * @route   GET /api/system-admin/verification/recovery/summary
 * @desc    Retry-reclaimed (proxy: terminal jobs with attempts>0),
 *          stale-lock-recovered, and orphaned-job-recovered counts.
 *          Registered BEFORE nothing — recovery has no :id detail route.
 * @access  Private (roleId === 1 only)
 */
router.get('/system-admin/verification/recovery/summary', auth, requireSystemAdmin(), getRecoverySummary);

/**
 * @route   GET /api/system-admin/verification/workers
 * @desc    Node process uptime + both scheduler health snapshots (stale
 *          lock, batch recovery); a heuristic Python online/offline signal
 *          derived from the most recent job claim (no real Python heartbeat
 *          exists — worker code was not modified to add one).
 * @access  Private (roleId === 1 only)
 */
router.get('/system-admin/verification/workers', auth, requireSystemAdmin(), getWorkerHealth);

export default router;
