/**
 * Single-post AI content generation - configuration. Every knob lives here
 * (env overrides, non-positive / non-finite values rejected); nothing is
 * hardcoded in the service or provider. Single posts are written by OpenAI
 * (the AI Strategy stays on Claude and has its own config). The model:
 *   SOCIAL_AI_CONTENT_MODEL -> OPENAI_MODEL -> DEFAULT_CONTENT_MODEL
 * The key (OPENAI_POST_API_KEY, else OPENAI_API_KEY) is read by the provider on the server only.
 */

const num = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

/** Fallback only when neither env var is set. A non-reasoning model with Structured Outputs support; override in production. */
export const DEFAULT_CONTENT_MODEL = 'gpt-4.1-mini';
export const CONTENT_MODEL = process.env.SOCIAL_AI_CONTENT_MODEL || process.env.OPENAI_MODEL || DEFAULT_CONTENT_MODEL;
/** One post is short; this is a ceiling, not a target. */
export const CONTENT_MAX_OUTPUT_TOKENS = num(process.env.SOCIAL_AI_CONTENT_MAX_OUTPUT_TOKENS, 2_000);
export const CONTENT_TIMEOUT_MS = num(process.env.SOCIAL_AI_CONTENT_TIMEOUT_MS, 60_000);
/** Transient provider failures only (timeout / overloaded / rate-limit / network). */
export const CONTENT_PROVIDER_RETRIES = num(process.env.SOCIAL_AI_CONTENT_PROVIDER_RETRIES, 1);
/** Extra model calls allowed when the output fails Odito's validation. Exactly one repair, never a loop. */
export const CONTENT_MAX_REPAIR_ATTEMPTS = num(process.env.SOCIAL_AI_CONTENT_REPAIR_ATTEMPTS, 1);
/** A `generating` record older than this is treated as interrupted and failed, so the project can generate again. */
export const CONTENT_STALE_MS = num(process.env.SOCIAL_AI_CONTENT_STALE_MS, 5 * 60 * 1000);
/** Finished generation records are bookkeeping only (the draft is the product) and expire after this many days. */
export const CONTENT_RECORD_TTL_DAYS = num(process.env.SOCIAL_AI_CONTENT_RECORD_TTL_DAYS, 30);

export const CONTENT_RATE_LIMIT = Object.freeze({
  windowMs: num(process.env.SOCIAL_AI_CONTENT_RATE_WINDOW_MS, 15 * 60 * 1000),
  max: num(process.env.SOCIAL_AI_CONTENT_RATE_MAX, 20),
});

/** Per-platform hard ceilings for the FINAL text (caption + hashtags). Instagram's own caption limit is 2,200 characters. */
export const PLATFORM_TEXT_LIMITS = Object.freeze({
  instagram: num(process.env.SOCIAL_AI_CONTENT_MAX_CHARS_INSTAGRAM, 2_200),
  facebook: num(process.env.SOCIAL_AI_CONTENT_MAX_CHARS_FACEBOOK, 3_000),
});
export const MAX_HASHTAGS = { instagram: 30, facebook: 10 };
