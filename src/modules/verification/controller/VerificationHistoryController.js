import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { AuthUtil } from '../../../utils/AuthUtil.js';
import PageVerificationRun from '../model/PageVerificationRun.js';

/**
 * Read-only URL Verification history endpoints (P3-007). Mirrors
 * AuditHistoryController's exact conventions (thin controller, no business
 * logic, ResponseUtil.paginated for lists) but reads PageVerificationRun
 * instead of AuditRun. Every value returned is read directly from the
 * persisted document — nothing is computed here.
 */
export function serializeRun(run) {
  return {
    verificationRunId: run._id.toString(),
    runId: run.runId,
    projectId: run.projectId.toString(),
    pageUrl: run.pageUrl,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    durationMs: run.durationMs,
    // M1: persisted, not computed — VerificationFinalizer already nulled
    // after.aiso/aeo/geoScore whenever this isn't 'SUCCESS', so consumers
    // reading this field can never mistake a stale/reused AI score for a
    // fresh one.
    aiVisibilityStatus: run.aiVisibilityStatus,
    before: run.before,
    after: run.after,
    delta: run.delta,
    errorMessage: run.errorMessage,
  };
}

/**
 * GET /api/seo/verification-runs/:runId
 * Not project-scoped in the URL, so ownership is resolved from the loaded
 * run's own projectId via the same AuthUtil.validateProjectAccess used by
 * the validateProjectAccess() middleware on the other two routes.
 */
export async function getVerificationRun(req, res) {
  const { runId } = req.params;

  const run = await PageVerificationRun.findOne({ runId }).lean();
  if (!run) {
    return res.status(404).json(ResponseUtil.notFound('Verification run not found'));
  }

  try {
    await AuthUtil.validateProjectAccess(req.user._id, run.projectId);
  } catch (error) {
    if (error.type === 'NOT_FOUND') {
      return res.status(404).json(ResponseUtil.notFound(error.message));
    }
    if (error.type === 'ACCESS_DENIED') {
      return res.status(403).json(ResponseUtil.accessDenied(error.message));
    }
    return res.status(error.statusCode || 500).json(ResponseUtil.error(error.message, error.statusCode || 500));
  }

  return res.json(ResponseUtil.success(serializeRun(run), 'Verification run retrieved'));
}

/**
 * GET /api/seo/projects/:projectId/verification-history?page=&limit=
 * Paginated, newest first. Project ownership already validated by the
 * validateProjectAccess() middleware on this route.
 *
 * No status/date-range/pageUrl filtering: grepped the codebase for an
 * existing query-filter precedent (status enums, date ranges) on any
 * listing endpoint — none exists (AuditComparisonService.getHistory(),
 * the closest sibling, is unfiltered pagination only) — so per this task's
 * own instruction ("only if these patterns already exist... otherwise do
 * not invent them"), none is added here.
 */
export async function getVerificationHistory(req, res) {
  const { projectId } = req.params;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
  const skip = (page - 1) * limit;

  const [runs, total] = await Promise.all([
    PageVerificationRun.find({ projectId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    PageVerificationRun.countDocuments({ projectId }),
  ]);

  const pages = Math.ceil(total / limit) || 1;
  return res.json(ResponseUtil.paginated(
    runs.map(serializeRun),
    { page, limit, total, pages, hasNext: page < pages, hasPrev: page > 1 },
    'Verification history retrieved'
  ));
}

/**
 * GET /api/seo/projects/:projectId/pages/:encodedUrl/latest-verification
 * Project ownership already validated by validateProjectAccess() middleware.
 */
export async function getLatestVerificationForPage(req, res) {
  const { projectId, encodedUrl } = req.params;

  let pageUrl;
  try {
    pageUrl = decodeURIComponent(encodedUrl);
  } catch {
    return res.status(400).json(ResponseUtil.error('Malformed encoded URL', 400));
  }

  const run = await PageVerificationRun.findOne({ projectId, pageUrl })
    .sort({ createdAt: -1 })
    .lean();

  if (!run) {
    return res.status(404).json(ResponseUtil.notFound('No verification found for this page'));
  }

  return res.json(ResponseUtil.success(serializeRun(run), 'Latest verification retrieved'));
}
