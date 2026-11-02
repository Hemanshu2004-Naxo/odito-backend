import mongoose from 'mongoose';
import { addDiscovered, createCompetitor, deleteCompetitor, getCompetitor, listCompetitors, MY_COMPETITORS_MAX, refreshEnrichment, updateCompetitor } from '../service/myCompetitorsService.js';
import { parseCreateBody, parseDiscoveredBody, parseUpdateBody } from '../validator/myCompetitorInput.js';
import { ValidationFailure, normalizeTargetDomain } from '../../dataforseo-api/shared/targetDomain.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * Runs AFTER auth + validateProjectAccess(): `req.project` is a project the authenticated user owns. The project id always comes from
 * there, never from the body. Responses are `no-store`: the browser must see its own writes.
 */

const STATUS = Object.freeze({
  COMPETITOR_EXISTS: 409, COMPETITOR_LIMIT_REACHED: 409, COMPETITOR_NOT_FOUND: 404, COMPETITOR_BUSY: 503, COMPETITORS_UNAVAILABLE: 503,
  ENRICHMENT_IN_PROGRESS: 409, REFRESH_COOLDOWN: 429, NO_WEBSITE: 400,
});

function projectDomainOf(project) {
  try { return normalizeTargetDomain(project.main_url); } catch { return null; }
}

function sendError(res, err, req) {
  if (err instanceof ValidationFailure) {
    if (err.retryAfterSeconds) res.set('Retry-After', String(err.retryAfterSeconds));
    return res.status(STATUS[err.code] ?? 400).json({ success: false, code: err.code, field: err.field, message: err.message, ...(err.retryAfterSeconds ? { retryAfterSeconds: err.retryAfterSeconds } : {}) });
  }
  LoggerUtil.error('My competitors: unexpected error', err, { userId: String(req.user?._id || ''), projectId: String(req.project?._id || '') });
  return res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' });
}

const ok = (res, status, data) => {
  res.set('Cache-Control', 'no-store');
  return res.status(status).json({ success: true, data });
};

function requireId(req) {
  if (!mongoose.isValidObjectId(req.params.competitorId)) throw new ValidationFailure('id', 'A valid competitor id is required.');
  return req.params.competitorId;
}

/** GET /projects/:projectId/my-competitors */
export async function list(req, res) {
  try {
    return ok(res, 200, { competitors: await listCompetitors(req.project._id), limit: MY_COMPETITORS_MAX });
  } catch (err) { return sendError(res, err, req); }
}

/** POST /projects/:projectId/my-competitors */
export async function create(req, res) {
  try {
    const data = parseCreateBody(req.body);
    return ok(res, 201, { competitor: await createCompetitor({ projectId: req.project._id, data, projectDomain: projectDomainOf(req.project), userId: req.user?._id ?? null }) });
  } catch (err) { return sendError(res, err, req); }
}

/**
 * POST /projects/:projectId/my-competitors/discovered - add a business found in the SEO list or Local Competitors. The same business
 * (same Google place, or same website) is MERGED into the existing record (its provenance and branches grow); it never becomes a second one.
 * 201 when a record was created, 200 when it was merged.
 */
export async function addFromDiscovery(req, res) {
  try {
    const candidate = parseDiscoveredBody(req.body);
    const { competitor, created } = await addDiscovered({ projectId: req.project._id, candidate, projectDomain: projectDomainOf(req.project), userId: req.user?._id ?? null });
    return ok(res, created ? 201 : 200, { competitor, created });
  } catch (err) { return sendError(res, err, req); }
}

/** GET /projects/:projectId/my-competitors/:competitorId - everything stored about one competitor. Never calls a provider. */
export async function details(req, res) {
  try {
    return ok(res, 200, { competitor: await getCompetitor({ projectId: req.project._id, id: requireId(req) }) });
  } catch (err) { return sendError(res, err, req); }
}

/** POST /projects/:projectId/my-competitors/:competitorId/refresh - queue a manual SEO refresh (202: the sweeper does the work). */
export async function refresh(req, res) {
  try {
    return ok(res, 202, { competitor: await refreshEnrichment({ projectId: req.project._id, id: requireId(req) }) });
  } catch (err) { return sendError(res, err, req); }
}

/** PATCH /projects/:projectId/my-competitors/:competitorId */
export async function update(req, res) {
  try {
    const id = requireId(req);
    const patch = parseUpdateBody(req.body);
    return ok(res, 200, { competitor: await updateCompetitor({ projectId: req.project._id, id, patch, projectDomain: projectDomainOf(req.project) }) });
  } catch (err) { return sendError(res, err, req); }
}

/** DELETE /projects/:projectId/my-competitors/:competitorId */
export async function remove(req, res) {
  try {
    await deleteCompetitor({ projectId: req.project._id, id: requireId(req) });
    return ok(res, 200, { id: req.params.competitorId });
  } catch (err) { return sendError(res, err, req); }
}
