import {
  getItemOptions, getItem, updateItem, createItem, approveItem, revokeItemApproval, regenerateItem, generateItemContent,
} from '../service/calendar/socialContentCalendarItemService.js';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * SocialContentCalendarItemController - HTTP only, for the per-item workspace of the Content Calendar. Every route runs
 * behind auth + validateProjectAccess() (routes/socialContentCalendarRoutes.js), which sets req.projectId / req.userId; those
 * are the only identities used here. The item id comes from the path (named :itemId so it can never be mistaken for the
 * project id by the access middleware) and is only ever used inside a project-scoped query. The body is passed on whole to the
 * service, which accepts an explicit whitelist of fields and rejects anything else by name.
 *
 * GET    /options                   what the editor may offer (pillars, hooks, live catalog + product images, formats, connection state)
 * POST   /items                     add a manual item to the current calendar (same model as generated items)
 * GET    /items/:itemId             one item
 * PATCH  /items/:itemId             save an edit (atomic; needs expectedRevision)
 * POST   /items/:itemId/approve     approve the PLAN (never content, design or publishing)
 * POST   /items/:itemId/revoke-approval
 * POST   /items/:itemId/regenerate  re-plan some fields with AI (edited fields are protected unless overwriteEdited)
 * POST   /items/:itemId/generate-content  create the post draft for one platform: mode 'plan' (201) uses the plan's caption verbatim; mode 'ai' (202) writes a new one
 */

const STATUS = {
  NOT_FOUND: 404,
  // state conflicts
  ITEM_CONFLICT: 409, ITEM_LOCKED: 409, CALENDAR_ARCHIVED: 409, PLATFORM_HAS_PUBLICATION: 409, EDITED_FIELDS: 409, NO_CALENDAR: 409,
  NOT_APPROVABLE: 409, NOT_APPROVED: 409, NO_PLAN_CAPTION: 422, CAPTION_TOO_LONG: 422, TOO_MANY_HASHTAGS: 422, PROHIBITED_PHRASE: 422, PLAN_NOT_APPROVED: 409, ALREADY_GENERATED: 409, STRATEGY_CHANGED: 409, LIMIT_REACHED: 409, CONFLICT: 409,
  // the request is well-formed but not allowed
  PLATFORM_NOT_CONNECTED: 422, PLATFORM_NOT_IN_STRATEGY: 422, FORMAT_NOT_SUPPORTED: 422, KPI_MISMATCH: 422, CTA_MISMATCH: 422,
  DATE_OUT_OF_RANGE: 422, DATE_IN_PAST: 422, NO_STRATEGY: 422, OBJECTIVE_NOT_IN_STRATEGY: 422, INSUFFICIENT_PROFILE: 422, AI_BAD_OUTPUT: 422,
  AI_UNAVAILABLE: 503,
  // INVALID_BODY / UNKNOWN_FIELD / INVALID_FIELD / INVALID_PLATFORM / INVALID_OBJECTIVE / INVALID_PILLAR are 400
};

const statusFor = (code) => STATUS[code] || (String(code).startsWith('AI_') ? 502 : 400);
const serverError = (res, message) => res.status(500).json(ResponseUtil.error(message, 500, { code: 'SOCIAL_CALENDAR_ITEM_FAILED' }));

function sendFailure(res, error) {
  const status = statusFor(error.code);
  const { code, message, ...extra } = error;
  return res.status(status).json(ResponseUtil.error(message, status, { code, ...extra }));
}

/** Runs a service call and maps its result to HTTP. `ok` builds the success body; default 200 { item, ...extras }. */
const run = (label, call, ok = ({ success: _s, ...rest }) => rest, successStatus = 200) => async (req, res) => {
  try {
    const result = await call(req);
    if (!result.success) return sendFailure(res, result.error);
    return res.status(successStatus).json(ResponseUtil.success(ok(result)));
  } catch (error) {
    LoggerUtil.error(`[SOCIAL_CALENDAR_ITEM] ${label} failed`, { message: error.message }, { projectId: req.projectId });
    return serverError(res, `Failed to ${label}`);
  }
};

export const getOptionsHandler = run('load the editor options', (req) => getItemOptions(req.projectId, { userId: req.userId }));
export const getItemHandler = run('load the calendar item', (req) => getItem(req.projectId, req.params.itemId));
// the body also carries the routing key `projectId`; it is the access middleware's, not a field of the item
const bodyWithoutRouting = (req) => { const { projectId: _p, ...rest } = req.body || {}; return rest; };
export const updateItemHandler = run('save the calendar item', (req) => updateItem(req.projectId, req.userId, req.params.itemId, bodyWithoutRouting(req)));
export const createItemHandler = run('add the calendar item', (req) => createItem(req.projectId, req.userId, bodyWithoutRouting(req)), (r) => ({ item: r.item }), 201);
export const approveItemHandler = run('approve the plan', (req) => approveItem(req.projectId, req.userId, req.params.itemId, bodyWithoutRouting(req)));
export const revokeApprovalHandler = run('withdraw the approval', (req) => revokeItemApproval(req.projectId, req.userId, req.params.itemId, bodyWithoutRouting(req)));
export const regenerateItemHandler = run('regenerate the plan', (req) => regenerateItem(req.projectId, req.userId, req.params.itemId, bodyWithoutRouting(req)));
/**
 * POST /items/:itemId/generate-content
 *   mode 'plan'  201 { mode: 'plan', item, publication }   the draft's text is the caption of the plan, verbatim (no AI call)
 *   mode 'ai'    202 { status: 'generating', generation }  the single-post generator writes a NEW caption; poll /social/ai-content/status
 */
export async function generateItemContentHandler(req, res) {
  try {
    const result = await generateItemContent(req.projectId, req.userId, req.params.itemId, bodyWithoutRouting(req));
    if (!result.success) return sendFailure(res, result.error);
    if (result.mode === 'plan') return res.status(201).json(ResponseUtil.success({ mode: 'plan', status: 'draft_created', item: result.item, publication: result.publication }));
    return res.status(202).json(ResponseUtil.success({ mode: 'ai', status: 'generating', generationId: result.generation?.id || null, alreadyRunning: !!result.alreadyRunning, generation: result.generation }));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_CALENDAR_ITEM] start the post generation failed', { message: error.message }, { projectId: req.projectId });
    return serverError(res, 'Failed to create the post');
  }
}

export default {
  getOptionsHandler, getItemHandler, updateItemHandler, createItemHandler, approveItemHandler, revokeApprovalHandler, regenerateItemHandler, generateItemContentHandler,
};
