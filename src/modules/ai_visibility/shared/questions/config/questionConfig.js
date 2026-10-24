/**
 * Question-bank configuration (provider-independent). Server-side only: generated output and request bodies can never
 * choose any of it.
 */

/** Bump when the bank, the system instruction or the validation rules change: it versions every stored question set. */
export const QUESTION_GENERATOR_VERSION = '1.0.0';

/** Customer-intent groups of the unbranded visibility questions, in display order, with the target count per business. */
export const INTENTS = Object.freeze({
  discovery: 8,
  specific_requirements: 8,
  problem_solving: 6,
  comparison: 6,
  buying_decision: 6,
  local_discovery: 6,
});
export const INTENT_NAMES = Object.freeze(Object.keys(INTENTS));

/** `visibility` questions never name the tracked business (so they measure organic mentions); `brand_reputation` ones must. */
export const GROUPS = Object.freeze({ VISIBILITY: 'visibility', BRAND_REPUTATION: 'brand_reputation' });
export const BRAND_INTENT = 'brand_reputation';

export const QUESTION_STATUS = Object.freeze({ DRAFT: 'draft', APPROVED: 'approved', ARCHIVED: 'archived' });
export const GENERATED_BY = Object.freeze({ OPENAI: 'openai', TEMPLATE: 'template', TEMPLATE_FALLBACK: 'template_fallback' });
export const PRIORITIES = Object.freeze(['high', 'medium', 'low']);

export const QUESTION_LIMITS = Object.freeze({ minLength: 15, maxLength: 300, maxQuestions: 50, maxBrandQuestions: 5 });
/** Caps for every user-confirmed list so a request body cannot inflate the prompt or the combinatorics. */
export const INPUT_LIMITS = Object.freeze({ listItems: 10, itemLength: 100 });
/** Draft generations allowed per project per rolling 24h (each may cost one model call). */
export const MAX_DRAFTS_PER_DAY = 10;

const posInt = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
};

export function getQuestionConfig(env = process.env) {
  return {
    useOpenAi: String(env.AI_VISIBILITY_QUESTIONS_USE_OPENAI ?? 'true').trim().toLowerCase() !== 'false',
    maxOutputTokens: posInt(env.AI_VISIBILITY_QUESTIONS_MAX_OUTPUT_TOKENS, 6_000),
    /** The model's set is only used when at least this share of the deterministic baseline count survives validation. */
    minAcceptRatio: 0.6,
    fallbackReuseMs: posInt(env.AI_VISIBILITY_PROMPT_FALLBACK_REUSE_MS, 6 * 60 * 60 * 1000),
  };
}

export default { QUESTION_GENERATOR_VERSION, INTENTS, INTENT_NAMES, GROUPS, BRAND_INTENT, QUESTION_STATUS, GENERATED_BY, PRIORITIES, QUESTION_LIMITS, INPUT_LIMITS, MAX_DRAFTS_PER_DAY, getQuestionConfig };
