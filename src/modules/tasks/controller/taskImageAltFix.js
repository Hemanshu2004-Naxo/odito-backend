import mongoose from 'mongoose';
import Task from '../model/Task.js';
import { assertTaskOwnership } from './taskAuthz.js';
import { WordPressConnectionError } from '../../external_integration/service/wordPressService.js';
import altFixService from '../../external_integration/mediaFix/altFixService.js';

/**
 * HTTP layer for the image alt-text fix. Every handler loads the Task, proves the caller owns the Task's PROJECT, and only then
 * reads or writes anything. The body can name ONE image (the URL of a finding of THIS task — the service re-checks it against the
 * task's own findings), the alt text a person wrote, an "informative" confirmation, the approval and the previewed plan's
 * fingerprint. It cannot name an attachment, a field, a WordPress path or a site: those are derived server-side.
 */

export const ALT_ISSUE_KEY = 'images_missing_alt_text';
const MAX_SRC = 2048;
const MAX_ALT_INPUT = 1000; // generous: the service's own limit (250) produces the useful message

const toObjectId = (id) => { try { return new mongoose.Types.ObjectId(id); } catch { return null; } };

function sendError(res, req, event, error) {
  if (error instanceof WordPressConnectionError) {
    console.warn(`[TASK] ${event} rejected | taskId=${req.params?.taskId} | code=${error.code}`);
    return res.status(error.statusCode || 502).json({ success: false, message: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) });
  }
  console.error(`[TASK] ${event} error | taskId=${req.params?.taskId}: ${error.message}`);
  return res.status(500).json({ success: false, message: 'Failed to process the image alt fix' });
}

async function loadOwnedAltTask(req, res) {
  const tid = toObjectId(req.params.taskId);
  if (!tid) { res.status(400).json({ success: false, message: 'Invalid taskId' }); return null; }
  const task = await Task.findById(tid);
  if (!task || task.isDeleted) { res.status(404).json({ success: false, message: 'Task not found' }); return null; }
  if (!(await assertTaskOwnership(req, res, task))) return null;
  if (task.issueKey !== ALT_ISSUE_KEY) {
    res.status(422).json({ success: false, message: 'This issue type has no image alt fix.', code: 'FIELD_NOT_WRITABLE' });
    return null;
  }
  return task;
}

/** Shape only; meaning is the service's job. Returns the cleaned input or writes a 400 and returns null. */
function readInput(req, res, { needAlt = false, needApproval = false } = {}) {
  const b = req.body || {};
  const bad = (message) => { res.status(400).json({ success: false, message, code: 'INVALID_INPUT' }); return null; };
  if (typeof b.imageSrc !== 'string' || !b.imageSrc || b.imageSrc.length > MAX_SRC) return bad("imageSrc must be the URL of one of this task's images");
  if (b.proposedAlt != null && (typeof b.proposedAlt !== 'string' || b.proposedAlt.length > MAX_ALT_INPUT)) return bad('proposedAlt must be text');
  if (needAlt && typeof b.proposedAlt !== 'string') return bad('proposedAlt is required');
  if (b.informative != null && typeof b.informative !== 'boolean') return bad('informative must be true or false');
  if (needApproval) {
    if (typeof b.approved !== 'boolean') return bad('approved (boolean) is required');
    if (b.expectedPlanFingerprint != null && (typeof b.expectedPlanFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(b.expectedPlanFingerprint))) return bad('expectedPlanFingerprint must be a 64-character hex string');
  }
  return { imageSrc: b.imageSrc, proposedAlt: b.proposedAlt ?? null, informative: b.informative === true, approved: b.approved, expectedPlanFingerprint: b.expectedPlanFingerprint };
}

/** GET /tasks/:taskId/image-alt/images */
export async function listImageAltImages(req, res) {
  try {
    const task = await loadOwnedAltTask(req, res);
    if (!task) return;
    return res.status(200).json({ success: true, data: await altFixService.listAltImagesWithSummary(task) }); // { images, summary }
  } catch (error) { return sendError(res, req, 'listImageAltImages', error); }
}

/** POST /tasks/:taskId/image-alt/preview — read-only */
export async function previewImageAltFix(req, res) {
  try {
    const task = await loadOwnedAltTask(req, res);
    if (!task) return;
    const input = readInput(req, res);
    if (!input) return;
    return res.status(200).json({ success: true, data: await altFixService.getAltFixPreview(task, input) });
  } catch (error) { return sendError(res, req, 'previewImageAltFix', error); }
}

/** POST /tasks/:taskId/image-alt/apply */
export async function applyImageAltFix(req, res) {
  try {
    const task = await loadOwnedAltTask(req, res);
    if (!task) return;
    const input = readInput(req, res, { needAlt: true, needApproval: true });
    if (!input) return;
    const result = await altFixService.applyAltFix(task, { ...input, actorId: req.user?._id || null });
    if (global.io) global.io.to(`project-${task.projectId}`).emit('task:implemented', { taskId: task._id, issueKey: task.issueKey, pageUrl: task.pageUrl, status: task.status });
    return res.status(200).json({ success: true, data: { task: result.task, field: result.fix?.target?.sourceKind === 'divi_page_module' ? 'divi_module_alt' : 'alt_text', alreadyApplied: result.alreadyApplied, immediateVerification: result.immediateVerification, fix: result.fix } });
  } catch (error) { return sendError(res, req, 'applyImageAltFix', error); }
}

/** POST /tasks/:taskId/image-alt/reverify */
export async function reverifyImageAltFix(req, res) {
  try {
    const task = await loadOwnedAltTask(req, res);
    if (!task) return;
    const input = readInput(req, res);
    if (!input) return;
    return res.status(200).json({ success: true, data: await altFixService.reverifyAltFix(task, { imageSrc: input.imageSrc }) });
  } catch (error) { return sendError(res, req, 'reverifyImageAltFix', error); }
}

/** POST /tasks/:taskId/image-alt/rollback */
export async function rollbackImageAltFix(req, res) {
  try {
    const task = await loadOwnedAltTask(req, res);
    if (!task) return;
    const input = readInput(req, res);
    if (!input) return;
    return res.status(200).json({ success: true, data: await altFixService.rollbackAltFix(task, { imageSrc: input.imageSrc, actorId: req.user?._id || null }) });
  } catch (error) { return sendError(res, req, 'rollbackImageAltFix', error); }
}

export default { listImageAltImages, previewImageAltFix, applyImageAltFix, reverifyImageAltFix, rollbackImageAltFix, ALT_ISSUE_KEY };
