import mongoose from 'mongoose';
import Task from '../model/Task.js';
import { assertTaskOwnership } from './taskAuthz.js';
import { WordPressConnectionError } from '../../external_integration/service/wordPressService.js';
import organizationFixService from '../../external_integration/schemaFix/organizationFixService.js';

/**
 * HTTP layer for the typed schema fixes (today: Organization). Kept apart from taskController so that file stays
 * focused on the Task lifecycle. Every handler loads the Task by id, then proves the caller owns the Task's PROJECT
 * (assertTaskOwnership) before anything else is read or written; the connection, site, fields and values are all derived
 * server-side from that Task — nothing but the approval flag and the previewed plan's fingerprint comes from the client.
 */

export const SCHEMA_FIX_ISSUE_KEYS = new Set(['organization_schema', 'sameas_array', 'breadcrumblist_schema']);

/**
 * Whether POST /apply-wordpress for this task is the typed (preview -> approve -> apply) contract. Organization always is. sameAs is
 * typed when the request carries the previewed plan's fingerprint; a request without one is the older owner-typed-profiles call,
 * which stays on its own path so existing clients keep working.
 */
export const isTypedSchemaFixApply = (task, body) => task.issueKey === 'organization_schema'
  || ((task.issueKey === 'sameas_array' || task.issueKey === 'breadcrumblist_schema') && body && body.expectedPlanFingerprint !== undefined);

const listOrUndefined = (v) => (v === undefined || v === null ? [] : v);

const toObjectId = (id) => { try { return new mongoose.Types.ObjectId(id); } catch { return null; } };

function sendError(res, req, event, error) {
  if (error instanceof WordPressConnectionError) {
    console.warn(`[TASK] ${event} rejected | taskId=${req.params?.taskId} | code=${error.code}`);
    return res.status(error.statusCode || 502).json({
      success: false, message: error.message, code: error.code, ...(error.details ? { details: error.details } : {}),
    });
  }
  console.error(`[TASK] ${event} error | taskId=${req.params?.taskId}: ${error.message}`);
  return res.status(500).json({ success: false, message: 'Failed to process the WordPress fix' });
}

/** Loads the task and checks project ownership; writes the response and returns null on any problem. */
async function loadOwnedSchemaFixTask(req, res) {
  const tid = toObjectId(req.params.taskId);
  if (!tid) { res.status(400).json({ success: false, message: 'Invalid taskId' }); return null; }
  const task = await Task.findById(tid);
  if (!task || task.isDeleted) { res.status(404).json({ success: false, message: 'Task not found' }); return null; }
  if (!(await assertTaskOwnership(req, res, task))) return null;
  if (!SCHEMA_FIX_ISSUE_KEYS.has(task.issueKey)) {
    res.status(422).json({ success: false, message: 'This issue type has no typed WordPress schema fix.', code: 'FIELD_NOT_WRITABLE' });
    return null;
  }
  return task;
}

/** GET /tasks/:taskId/wordpress-fix/preview */
export async function previewWordPressFix(req, res) {
  try {
    const task = await loadOwnedSchemaFixTask(req, res);
    if (!task) return;
    // sameAs is planned from the links the owner selected (POST body); the Organization fix needs no input.
    const body = req.method === 'POST' ? (req.body || {}) : {};
    const data = await organizationFixService.getOrganizationFixPreview(task, {}, { urls: listOrUndefined(body.urls), removeUrls: listOrUndefined(body.removeUrls) });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return sendError(res, req, 'previewWordPressFix', error);
  }
}

/** POST /tasks/:taskId/wordpress-fix/reverify */
export async function reverifyWordPressFix(req, res) {
  try {
    const task = await loadOwnedSchemaFixTask(req, res);
    if (!task) return;
    const data = await organizationFixService.reverifyOrganizationFix(task);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return sendError(res, req, 'reverifyWordPressFix', error);
  }
}

/** POST /tasks/:taskId/wordpress-fix/rollback */
export async function rollbackWordPressFix(req, res) {
  try {
    const task = await loadOwnedSchemaFixTask(req, res);
    if (!task) return;
    const data = await organizationFixService.rollbackOrganizationFix(task, { actorId: req.user?._id || null });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return sendError(res, req, 'rollbackWordPressFix', error);
  }
}

/**
 * The Organization branch of POST /tasks/:taskId/apply-wordpress. `task` is already loaded and ownership-checked by
 * applyWordPressFix; the request body is validated for SHAPE here and for meaning in the service.
 */
export async function applySchemaFixResponse(req, res, task) {
  try {
    const { approved, expectedPlanFingerprint, urls, removeUrls } = req.body || {};
    const result = await organizationFixService.applyOrganizationFix(task, {
      approved, expectedPlanFingerprint, actorId: req.user?._id || null,
      ...(task.issueKey === 'sameas_array' ? { urls: listOrUndefined(urls), removeUrls: listOrUndefined(removeUrls) } : {}),
    });
    if (global.io) {
      global.io.to(`project-${task.projectId}`).emit('task:implemented', { taskId: task._id, issueKey: task.issueKey, pageUrl: task.pageUrl, status: 'implemented' });
    }
    return res.status(200).json({
      success: true,
      data: {
        task: result.task,
        field: task.issueKey === 'sameas_array' ? 'organization_same_as' : task.issueKey === 'breadcrumblist_schema' ? 'breadcrumb_setting' : 'organization_schema',
        provider: 'rank_math',
        alreadyApplied: result.alreadyApplied,
        immediateVerification: result.immediateVerification,
        fix: result.fix,
      },
    });
  } catch (error) {
    return sendError(res, req, 'applyWordPressFix(schema)', error);
  }
}

export default { previewWordPressFix, reverifyWordPressFix, rollbackWordPressFix, applySchemaFixResponse, SCHEMA_FIX_ISSUE_KEYS, isTypedSchemaFixApply };
