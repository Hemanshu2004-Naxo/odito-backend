/**
 * Provider-independent prompt-system configuration. Everything the OpenAI customization step may be tuned by lives
 * here (server-side, env-driven). Generated output can never choose any of it.
 */

/** Bump when the templates, the system instruction or the validation rules change: it versions every stored prompt set. */
export const GENERATOR_VERSION = '1.0.0';

/** The five categories, in execution/display order. A valid prompt set has exactly one prompt per category. */
export const PROMPT_CATEGORIES = Object.freeze([
  'industry_discovery',
  'service_discovery',
  'brand_recognition',
  'competitor_comparison',
  'local_market_intent',
]);

/** Whether a category's prompt must (true) or must not (false) name the business. */
export const CATEGORY_BRANDED = Object.freeze({
  industry_discovery: false,
  service_discovery: false,
  brand_recognition: true,
  competitor_comparison: true,
  local_market_intent: false,
});

export const GENERATED_BY = Object.freeze({
  OPENAI: 'openai',
  TEMPLATE: 'template',
  TEMPLATE_FALLBACK: 'template_fallback',
});

export const PROMPT_LIMITS = Object.freeze({ minLength: 20, maxLength: 500 });

const posInt = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
};

/** Read lazily so tests (and ops) can change the environment without re-importing. */
export function getPromptConfig(env = process.env) {
  const key = [env.AI_VISIBILITY_OPENAI_API_KEY, env.OPENAI_API_KEY, env.OPENAI_POST_API_KEY].map((v) => (v ?? '').trim()).find(Boolean) || '';
  return {
    // OpenAI customization is optional: without a key, or with this switched off, deterministic templates are used (generatedBy: "template").
    useOpenAi: String(env.AI_VISIBILITY_PROMPT_USE_OPENAI ?? 'true').trim().toLowerCase() !== 'false',
    apiKey: key,
    model: (env.AI_VISIBILITY_PROMPT_MODEL || env.OPENAI_MODEL || 'gpt-4.1-mini').trim(),
    timeoutMs: posInt(env.AI_VISIBILITY_PROMPT_TIMEOUT_MS, 30_000),
    maxOutputTokens: posInt(env.AI_VISIBILITY_PROMPT_MAX_OUTPUT_TOKENS, 1_200),
    providerRetries: posInt(env.AI_VISIBILITY_PROMPT_PROVIDER_RETRIES, 1),
    /** Extra model calls allowed when the output fails Odito's validation. One repair, never a loop. */
    repairAttempts: Math.min(1, posInt(env.AI_VISIBILITY_PROMPT_REPAIR_ATTEMPTS, 1)),
    /** A template_fallback set is only reused for this long, so a transient OpenAI outage is retried on a later run. */
    fallbackReuseMs: posInt(env.AI_VISIBILITY_PROMPT_FALLBACK_REUSE_MS, 6 * 60 * 60 * 1000),
  };
}

export default { GENERATOR_VERSION, PROMPT_CATEGORIES, CATEGORY_BRANDED, GENERATED_BY, PROMPT_LIMITS, getPromptConfig };
