import AiVisibilityQuestionSet from '../models/AiVisibilityQuestionSet.js';
import { VisibilityError, VISIBILITY_ERROR } from '../../errors/visibilityErrors.js';
import { QUESTION_STATUS, GROUPS, MAX_DRAFTS_PER_DAY, QUESTION_LIMITS } from '../config/questionConfig.js';
import { generateQuestionSet } from './questionGenerationService.js';
import { validateQuestion } from '../validators/questionValidator.js';
import { normalizeForMatching } from '../../services/brandMatchingService.js';
import { cleanText } from '../../utils/text.js';

/**
 * Question-set persistence and the approval workflow (provider-independent).
 *
 *   generate   POST creates a DRAFT (next version). Capped per project per rolling 24h because each may cost a model call.
 *   review     the owner can switch questions off or reword them while the set is a draft. Rewording is re-validated (never
 *              brand/competitor/URL/instruction text) and marked source:"user".
 *   approve    freezes the set. Any previously approved set is archived, so there is exactly one approved set to compare
 *              runs against. An approved set can never be edited: a change means a new draft and a new version.
 *
 * Every query is scoped by projectId, so a set id from another project is simply "not found".
 */

const MAX_VERSION_ATTEMPTS = 5;
const isDuplicateKey = (e) => e && (e.code === 11000 || e.code === 11001);
const stateError = (message, details) => new VisibilityError(VISIBILITY_ERROR.QUESTION_SET_STATE, message, details);
const notFound = () => new VisibilityError(VISIBILITY_ERROR.QUESTION_SET_NOT_FOUND, 'Question set not found');

export async function createDraft({ profile, userId = null, maxVisibility = null }, deps = {}) {
  const Model = deps.Model || AiVisibilityQuestionSet;
  const now = deps.now || (() => new Date());
  const generate = deps.generate || generateQuestionSet;

  const since = new Date(now().getTime() - 24 * 60 * 60 * 1000);
  const recent = await Model.countDocuments({ projectId: profile.projectId, createdAt: { $gte: since } });
  if (String(process.env.GOOGLE_AIO_VISIBILITY_LIMITS_ENABLED).toLowerCase() === 'true' && recent >= MAX_DRAFTS_PER_DAY) {
    throw new VisibilityError(VISIBILITY_ERROR.QUESTION_SET_LIMIT, 'Too many question sets were generated for this project today. Review or approve an existing draft.', { limit: MAX_DRAFTS_PER_DAY });
  }

  const generated = await generate(profile, { ...(deps.generateDeps || {}), ...(maxVisibility ? { maxVisibility } : {}) });

  for (let attempt = 1; attempt <= MAX_VERSION_ATTEMPTS; attempt += 1) {
    const last = await Model.findOne({ projectId: profile.projectId }).sort({ version: -1 }).select('version').lean();
    try {
      const doc = await Model.create({
        projectId: profile.projectId,
        version: (last?.version || 0) + 1,
        status: QUESTION_STATUS.DRAFT,
        profileHash: generated.profileHash,
        generatorVersion: generated.generatorVersion,
        inputs: generated.inputs,
        language: generated.language,
        generatedBy: generated.generatedBy,
        fallbackReason: generated.fallbackReason,
        model: generated.model,
        questions: generated.questions,
        missingBusinessInformation: generated.missingBusinessInformation,
        warnings: generated.warnings,
        generationReport: generated.generationReport || null,
        tokenUsage: generated.tokenUsage,
        createdBy: userId,
        createdAt: now(),
      });
      return doc.toObject();
    } catch (error) {
      if (!isDuplicateKey(error)) throw error; // lost the version race: retry with the next number
    }
  }
  throw new VisibilityError(VISIBILITY_ERROR.PROMPT_SET_PERSIST_FAILED, 'Could not store the question set');
}

export const listQuestionSets = (projectId, { limit = 20, skip = 0, Model = AiVisibilityQuestionSet } = {}) => (
  Model.find({ projectId }).sort({ version: -1 }).skip(skip).limit(limit).lean()
);

export const getQuestionSet = (projectId, setId, { Model = AiVisibilityQuestionSet } = {}) => (
  Model.findOne({ _id: setId, projectId }).lean()
);

/** The single set runs are executed and compared against, or null. */
export const getApprovedQuestionSet = (projectId, { Model = AiVisibilityQuestionSet } = {}) => (
  Model.findOne({ projectId, status: QUESTION_STATUS.APPROVED }).lean()
);

/**
 * Edit one question of a DRAFT: toggle `enabled` and/or reword `text`.
 * @throws {VisibilityError} QUESTION_SET_NOT_FOUND | QUESTION_SET_STATE | QUESTION_SET_INVALID (issue codes only)
 */
export async function updateDraftQuestion({ projectId, setId, questionId, changes, profile }, { Model = AiVisibilityQuestionSet } = {}) {
  const set = await Model.findOne({ _id: setId, projectId }).lean();
  if (!set) throw notFound();
  if (set.status !== QUESTION_STATUS.DRAFT) throw stateError('Only a draft question set can be edited. Create a new version instead.');
  const question = set.questions.find((q) => q.id === questionId);
  if (!question) throw new VisibilityError(VISIBILITY_ERROR.QUESTION_SET_NOT_FOUND, 'Question not found');

  const $set = {};
  if (typeof changes.enabled === 'boolean') $set['questions.$[q].enabled'] = changes.enabled;
  if (changes.text !== undefined) {
    const text = cleanText(changes.text, QUESTION_LIMITS.maxLength + 50);
    const candidate = { ...question, text, source: 'user' };
    const issues = validateQuestion(candidate, { profile, inputs: set.inputs, userEdited: true });
    const duplicate = set.questions.some((q) => q.id !== questionId && normalizeForMatching(q.text) === normalizeForMatching(text || ''));
    if (duplicate) issues.push('DUPLICATE_QUESTION');
    if (issues.length) throw new VisibilityError(VISIBILITY_ERROR.QUESTION_SET_INVALID, 'The reworded question failed validation', { issues: issues.map((code) => ({ code })) });
    $set['questions.$[q].text'] = text;
    $set['questions.$[q].source'] = 'user';
    $set['questions.$[q].validationStatus'] = 'user_edited';
  }
  if (!Object.keys($set).length) throw new VisibilityError(VISIBILITY_ERROR.QUESTION_SET_INVALID, 'Nothing to change', { issues: [{ code: 'NO_CHANGES' }] });

  const res = await Model.updateOne(
    { _id: setId, projectId, status: QUESTION_STATUS.DRAFT },
    { $set },
    { arrayFilters: [{ 'q.id': questionId }] },
  );
  if (!res.matchedCount) throw stateError('The question set changed while you were editing it.');
  return Model.findOne({ _id: setId, projectId }).lean();
}

export async function approveQuestionSet({ projectId, setId, userId = null, now = () => new Date() }, { Model = AiVisibilityQuestionSet } = {}) {
  const set = await Model.findOne({ _id: setId, projectId }).lean();
  if (!set) throw notFound();
  if (set.status !== QUESTION_STATUS.DRAFT) throw stateError(`A ${set.status} question set cannot be approved.`);
  const enabledVisibility = set.questions.filter((q) => q.enabled && q.group === GROUPS.VISIBILITY);
  if (enabledVisibility.length === 0) {
    throw new VisibilityError(VISIBILITY_ERROR.QUESTION_SET_INVALID, 'Enable at least one visibility question before approving.', { issues: [{ code: 'NO_ENABLED_QUESTIONS' }] });
  }

  const previous = await Model.findOne({ projectId, status: QUESTION_STATUS.APPROVED }).select('_id').lean();
  // The partial unique index allows one approved set, so the old one is archived first and restored if this approval fails.
  if (previous) await Model.updateOne({ _id: previous._id, status: QUESTION_STATUS.APPROVED }, { $set: { status: QUESTION_STATUS.ARCHIVED, archivedAt: now() } });
  const restore = async () => { if (previous) await Model.updateOne({ _id: previous._id, status: QUESTION_STATUS.ARCHIVED }, { $set: { status: QUESTION_STATUS.APPROVED, archivedAt: null } }); };

  try {
    const res = await Model.updateOne(
      { _id: setId, projectId, status: QUESTION_STATUS.DRAFT },
      { $set: { status: QUESTION_STATUS.APPROVED, approvedAt: now(), approvedBy: userId } },
    );
    if (!res.matchedCount) { await restore(); throw stateError('The question set changed while it was being approved.'); }
  } catch (error) {
    if (error instanceof VisibilityError) throw error;
    await restore();
    if (isDuplicateKey(error)) throw stateError('Another question set was approved at the same time. Please retry.');
    throw error;
  }
  return Model.findOne({ _id: setId, projectId }).lean();
}

/** A draft the owner does not want: kept as history, never executed. */
export async function discardDraft({ projectId, setId, now = () => new Date() }, { Model = AiVisibilityQuestionSet } = {}) {
  const res = await Model.updateOne({ _id: setId, projectId, status: QUESTION_STATUS.DRAFT }, { $set: { status: QUESTION_STATUS.ARCHIVED, archivedAt: now() } });
  if (!res.matchedCount) {
    const exists = await Model.exists({ _id: setId, projectId });
    throw exists ? stateError('Only a draft question set can be discarded.') : notFound();
  }
  return Model.findOne({ _id: setId, projectId }).lean();
}

export default { createDraft, listQuestionSets, getQuestionSet, getApprovedQuestionSet, updateDraftQuestion, approveQuestionSet, discardDraft };
