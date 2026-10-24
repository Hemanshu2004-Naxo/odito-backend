import mongoose from 'mongoose';
import { ResponseUtil } from '../../../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../../../utils/LoggerUtil.js';
import { VISIBILITY_ERROR } from '../../errors/visibilityErrors.js';
import { buildBusinessProfile } from '../../services/businessProfileService.js';
import * as sets from '../services/questionSetService.js';
import { QUESTION_TEMPLATES } from '../templates/questionBank.js';
import { INTENTS } from '../config/questionConfig.js';

/**
 * Question-set HTTP handlers. Mounted behind `auth` + validateProjectAccess() (req.project is proven to belong to the
 * caller) and every query is scoped by that project id. A request body can only supply the user's confirmed business
 * details; it can never choose a model, limits, templates or the questions themselves (questions are produced by the
 * server-side generator and only edited through the validated review endpoint).
 */

const STATUS = {
  [VISIBILITY_ERROR.QUESTION_SET_NOT_FOUND]: 404,
  [VISIBILITY_ERROR.QUESTION_SET_STATE]: 409,
  [VISIBILITY_ERROR.QUESTION_SET_LIMIT]: 429,
  [VISIBILITY_ERROR.QUESTION_SET_INVALID]: 422,
  [VISIBILITY_ERROR.INSUFFICIENT_PROFILE]: 422,
  [VISIBILITY_ERROR.PROJECT_NOT_FOUND]: 404,
};

export function toQuestionSetDto(set, { currentProfileHash = null } = {}) {
  if (!set) return null;
  return {
    id: String(set._id),
    version: set.version,
    status: set.status,
    generatorVersion: set.generatorVersion,
    generatedBy: set.generatedBy,
    fallbackReason: set.fallbackReason ?? null,
    model: set.model ?? null,
    language: set.language ?? 'en',
    inputs: set.inputs ?? null,
    missingBusinessInformation: set.missingBusinessInformation || [],
    warnings: set.warnings || [],
    // True when the business profile changed after this set was generated: the questions may no longer match the business.
    profileChanged: currentProfileHash ? currentProfileHash !== set.profileHash : null,
    questions: (set.questions || []).map((q) => ({
      id: q.id, group: q.group, text: q.text, intent: q.intent, topic: q.topic ?? null, brandNamed: q.brandNamed ?? q.group === 'brand_reputation',
      validationStatus: q.validationStatus ?? 'passed', service: q.service ?? null, location: q.location ?? null,
      language: q.language, templateId: q.templateId ?? null, priority: q.priority, selectionReason: q.selectionReason, source: q.source, enabled: q.enabled,
    })),
    counts: {
      total: (set.questions || []).length,
      enabled: (set.questions || []).filter((q) => q.enabled).length,
      visibility: (set.questions || []).filter((q) => q.group === 'visibility').length,
      brandReputation: (set.questions || []).filter((q) => q.group === 'brand_reputation').length,
    },
    approvedAt: set.approvedAt ?? null,
    createdAt: set.createdAt,
  };
}

const fail = (res, status, message, details = null) => res.status(status).json(ResponseUtil.error(message, status, details));
const objectIdOr404 = (res, id, label) => {
  if (!mongoose.isValidObjectId(id)) { fail(res, 404, `${label} not found`); return false; }
  return true;
};

function handleError(res, error, req, what) {
  const status = STATUS[error?.code];
  if (status) return fail(res, status, error.message, { code: error.code, ...(error.details || {}) });
  LoggerUtil.error(`AI Visibility questions: ${what} failed`, { projectId: String(req.project?._id), code: error?.code });
  return fail(res, 500, `Could not ${what}`);
}

const currentHash = async (projectId) => {
  try { return (await buildBusinessProfile(projectId)).profileHash; } catch { return null; }
};

export async function generateQuestions(req, res) {
  try {
    const profile = await buildBusinessProfile(req.project._id);
    // Questions are generated ONLY from the stored, confirmed business profile (PUT .../profile); nothing in the body is used.
    const draft = await sets.createDraft({ profile, userId: req.user?._id || null });
    return res.status(201).json(ResponseUtil.success(toQuestionSetDto(draft, { currentProfileHash: profile.profileHash }), 'Question draft generated. Review and approve it to use it.'));
  } catch (error) {
    return handleError(res, error, req, 'generate the question set');
  }
}

export async function listQuestionSets(req, res) {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 10));
    const items = await sets.listQuestionSets(req.project._id, { limit, skip: (page - 1) * limit });
    return res.json(ResponseUtil.success(items.map((s) => toQuestionSetDto(s)), 'Success', { page, limit }));
  } catch (error) {
    return handleError(res, error, req, 'load the question sets');
  }
}

export async function getApproved(req, res) {
  try {
    const set = await sets.getApprovedQuestionSet(req.project._id);
    return res.json(ResponseUtil.success(toQuestionSetDto(set, { currentProfileHash: set ? await currentHash(req.project._id) : null })));
  } catch (error) {
    return handleError(res, error, req, 'load the approved question set');
  }
}

export async function getQuestionSetById(req, res) {
  try {
    if (!objectIdOr404(res, req.params.setId, 'Question set')) return undefined;
    const set = await sets.getQuestionSet(req.project._id, req.params.setId);
    if (!set) return fail(res, 404, 'Question set not found');
    return res.json(ResponseUtil.success(toQuestionSetDto(set, { currentProfileHash: await currentHash(req.project._id) })));
  } catch (error) {
    return handleError(res, error, req, 'load the question set');
  }
}

export async function updateQuestion(req, res) {
  try {
    if (!objectIdOr404(res, req.params.setId, 'Question set')) return undefined;
    const { enabled, text } = req.body || {};
    const changes = {};
    if (enabled !== undefined) {
      if (typeof enabled !== 'boolean') return fail(res, 400, 'enabled must be true or false');
      changes.enabled = enabled;
    }
    if (text !== undefined) {
      if (typeof text !== 'string') return fail(res, 400, 'text must be a string');
      changes.text = text;
    }
    const profile = await buildBusinessProfile(req.project._id);
    const set = await sets.updateDraftQuestion({ projectId: req.project._id, setId: req.params.setId, questionId: String(req.params.questionId), changes, profile });
    return res.json(ResponseUtil.success(toQuestionSetDto(set, { currentProfileHash: profile.profileHash })));
  } catch (error) {
    return handleError(res, error, req, 'update the question');
  }
}

export async function approve(req, res) {
  try {
    if (!objectIdOr404(res, req.params.setId, 'Question set')) return undefined;
    const set = await sets.approveQuestionSet({ projectId: req.project._id, setId: req.params.setId, userId: req.user?._id || null });
    return res.json(ResponseUtil.success(toQuestionSetDto(set, { currentProfileHash: await currentHash(req.project._id) }), 'Question set approved'));
  } catch (error) {
    return handleError(res, error, req, 'approve the question set');
  }
}

export async function discard(req, res) {
  try {
    if (!objectIdOr404(res, req.params.setId, 'Question set')) return undefined;
    const set = await sets.discardDraft({ projectId: req.project._id, setId: req.params.setId });
    return res.json(ResponseUtil.success(toQuestionSetDto(set), 'Draft discarded'));
  } catch (error) {
    return handleError(res, error, req, 'discard the draft');
  }
}

/** The public shape of the bank, so the UI can explain what is asked and why (no business data). */
export function getQuestionBank(_req, res) {
  return res.json(ResponseUtil.success({
    targetCounts: INTENTS,
    templates: QUESTION_TEMPLATES.map((t) => ({ id: t.id, intent: t.intent, pattern: t.text })),
  }));
}

export default { generateQuestions, listQuestionSets, getApproved, getQuestionSetById, updateQuestion, approve, discard, getQuestionBank };
