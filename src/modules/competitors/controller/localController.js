import { ValidationFailure } from '../../dataforseo-api/shared/targetDomain.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { LocalSearchError, getLocalOptions, searchLocal } from '../service/localDiscoveryService.js';

/**
 * Local Competitors. Runs AFTER auth + validateProjectAccess(): `req.project` is a project the user owns. The project id and its location
 * always come from there, never from the body, and Google's key and raw errors never leave the server.
 */

function sendError(res, err, req) {
  if (err instanceof LocalSearchError) {
    return res.status(err.httpStatus ?? 400).json({ success: false, code: err.code, message: err.message, ...(err.address ? { address: err.address } : {}) });
  }
  if (err instanceof ValidationFailure) return res.status(400).json({ success: false, code: err.code, field: err.field, message: err.message });
  LoggerUtil.error('Local competitors: unexpected error', err, { userId: String(req.user?._id || ''), projectId: String(req.project?._id || '') });
  return res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' });
}
const ok = (res, data) => { res.set('Cache-Control', 'no-store'); return res.status(200).json({ success: true, data }); };

/** GET /projects/:projectId/local-competitors/options - radii, the search centre (or why there is none) and the suggested categories. No Google request. */
export async function options(req, res) {
  try { return ok(res, await getLocalOptions({ projectId: req.project._id })); } catch (err) { return sendError(res, err, req); }
}

/** POST /projects/:projectId/local-competitors/search  { radiusKm?, queries?, types?, geocode? } - ONE explicit search (1-4 billed Google requests). */
export async function search(req, res) {
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const result = await searchLocal({
      projectId: req.project._id,
      radiusKm: body.radiusKm,
      queries: body.queries,
      types: body.types,
      geocode: body.geocode === true,
      requestId: req.headers['x-request-id'] ? String(req.headers['x-request-id']).slice(0, 64) : null,
    });
    return ok(res, result);
  } catch (err) { return sendError(res, err, req); }
}
