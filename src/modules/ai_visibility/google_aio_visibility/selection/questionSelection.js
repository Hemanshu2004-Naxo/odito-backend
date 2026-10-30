import { QUESTIONS_PER_RUN } from '../config/googleAioConfig.js';
import { GROUPS } from '../../shared/questions/config/questionConfig.js';
import { validateQuestion } from '../../shared/questions/validators/questionValidator.js';
import { normalizeForMatching } from '../../shared/services/brandMatchingService.js';

/**
 * Choose the exactly-five questions of one Google AI Overview run from the project's APPROVED question set (the existing, versioned
 * review/approve workflow is preserved: nothing outside an approved set can be sent).
 *
 * Eligible = enabled, unbranded `visibility` question that is still valid for the CURRENT business profile (so a competitor or alias
 * added after approval, or a changed city, drops the question instead of sending it).
 *
 * Deterministic automatic pick (no randomness, no model): intents are visited in INTENT_ORDER and the best remaining question of each
 * is taken (priority high > medium > low, then the set's own order) until five are chosen; if a round does not fill five, further
 * rounds continue. Questions are never invented or padded: fewer than five eligible questions is a refusal.
 *
 * The caller may instead name exactly five question ids from the set; they must all be eligible.
 */

// Local and generic discovery lead because AI Overviews appear mostly on informational / "which ... in <city>" searches.
export const INTENT_ORDER = Object.freeze(['local_discovery', 'discovery', 'specific_requirements', 'problem_solving', 'buying_decision', 'comparison']);
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

export class QuestionSelectionError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'QuestionSelectionError';
    this.code = code;
    this.details = details;
  }
}

/** Eligible questions with the reason each other question was left out. */
export function eligibleQuestions(set, profile) {
  const eligible = [];
  const excluded = [];
  const seen = new Set();
  (set.questions || []).forEach((q, index) => {
    if (!q || q.group !== GROUPS.VISIBILITY) return;
    if (!q.enabled) { excluded.push({ questionId: q.id, reason: 'DISABLED' }); return; }
    const text = typeof q.text === 'string' ? q.text.trim() : '';
    if (!text) { excluded.push({ questionId: q.id, reason: 'EMPTY_QUESTION' }); return; }
    const issues = validateQuestion({ ...q, text }, { profile, inputs: set.inputs || {}, userEdited: q.source === 'user' });
    if (issues.length) { excluded.push({ questionId: q.id, reason: issues[0] }); return; }
    const key = normalizeForMatching(text);
    if (seen.has(key)) { excluded.push({ questionId: q.id, reason: 'DUPLICATE_QUESTION' }); return; }
    seen.add(key);
    eligible.push({ ...q, text, _index: index });
  });
  return { eligible, excluded };
}

function autoPick(eligible) {
  const byIntent = new Map();
  for (const q of eligible) {
    if (!byIntent.has(q.intent)) byIntent.set(q.intent, []);
    byIntent.get(q.intent).push(q);
  }
  for (const list of byIntent.values()) list.sort((a, b) => (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1) || a._index - b._index);
  const order = [...INTENT_ORDER, ...[...byIntent.keys()].filter((k) => !INTENT_ORDER.includes(k)).sort()];
  const picked = [];
  while (picked.length < QUESTIONS_PER_RUN) {
    let took = false;
    for (const intent of order) {
      const list = byIntent.get(intent);
      if (list?.length && picked.length < QUESTIONS_PER_RUN) { picked.push(list.shift()); took = true; }
    }
    if (!took) break;
  }
  return picked;
}

/**
 * @param {object} set      the approved question set (lean document)
 * @param {object} profile  current business profile (buildBusinessProfile)
 * @param {{questionIds?:string[]|null}} [opts]
 * @returns {{snapshot:object[], excluded:object[], mode:'auto'|'user'}}   snapshot has EXACTLY five entries
 * @throws {QuestionSelectionError}
 */
export function selectQuestions(set, profile, { questionIds = null } = {}) {
  const { eligible, excluded } = eligibleQuestions(set, profile);
  let chosen;
  let mode = 'auto';

  if (questionIds != null) {
    mode = 'user';
    if (!Array.isArray(questionIds) || questionIds.some((id) => typeof id !== 'string' || !id)) {
      throw new QuestionSelectionError('QUESTION_IDS_INVALID', 'questionIds must be a list of question ids');
    }
    if (questionIds.length !== QUESTIONS_PER_RUN) {
      throw new QuestionSelectionError('QUESTION_COUNT_INVALID', `Exactly ${QUESTIONS_PER_RUN} questions must be selected (received ${questionIds.length}).`, { required: QUESTIONS_PER_RUN, received: questionIds.length });
    }
    if (new Set(questionIds).size !== questionIds.length) throw new QuestionSelectionError('DUPLICATE_QUESTION', 'The same question was selected more than once.');
    const byId = new Map(eligible.map((q) => [q.id, q]));
    const unusable = questionIds.filter((id) => !byId.has(id));
    if (unusable.length) {
      throw new QuestionSelectionError('QUESTION_NOT_ELIGIBLE', 'Some selected questions are not in the approved set or are not valid for the current business profile.', { questionIds: unusable });
    }
    chosen = questionIds.map((id) => byId.get(id));
    // Distinct after normalisation (the set already de-duplicates, but two ids could carry the same text in an old set).
    if (new Set(chosen.map((q) => normalizeForMatching(q.text))).size !== QUESTIONS_PER_RUN) throw new QuestionSelectionError('DUPLICATE_QUESTION', 'Two selected questions have the same text.');
  } else {
    chosen = autoPick(eligible);
    if (chosen.length < QUESTIONS_PER_RUN) {
      throw new QuestionSelectionError(
        'NOT_ENOUGH_QUESTIONS',
        `The approved question set has only ${chosen.length} usable question${chosen.length === 1 ? '' : 's'}; ${QUESTIONS_PER_RUN} are required. Enable more questions or generate a new set.`,
        { required: QUESTIONS_PER_RUN, available: chosen.length, excluded: excluded.slice(0, 20) },
      );
    }
  }

  const snapshot = chosen.map((q) => ({
    questionId: q.id,
    group: q.group,
    intent: q.intent,
    text: q.text,
    service: q.service ?? null,
    location: q.location ?? null,
    language: q.language || 'en',
    templateId: q.templateId ?? null,
    priority: q.priority || 'medium',
  }));
  return { snapshot, excluded, mode };
}

export default { selectQuestions, eligibleQuestions, INTENT_ORDER, QuestionSelectionError };
