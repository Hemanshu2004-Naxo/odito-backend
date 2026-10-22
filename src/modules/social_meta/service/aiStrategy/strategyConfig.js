/**
 * AI Strategy generation — configuration. Every knob lives here (env overrides,
 * non-positive / non-finite values rejected), nothing is hardcoded in the
 * service or provider. The model is NOT pinned in code:
 *   SOCIAL_AI_STRATEGY_MODEL -> CLAUDE_MODEL (what the other Claude integrations use) -> a default.
 */
const num = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

export const STRATEGY_MODEL = process.env.SOCIAL_AI_STRATEGY_MODEL || process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
/** Ceiling for ONE streamed call. A strategy is a long answer (6-10k tokens, 2-3 min), so this is not the limit that detects a dead connection - the idle timeout below is. */
export const STRATEGY_TIMEOUT_MS = num(process.env.SOCIAL_AI_STRATEGY_TIMEOUT_MS, 300_000);
/** Streamed calls only: how long the model may produce nothing at all before the call is treated as hung. */
export const STREAM_IDLE_TIMEOUT_MS = num(process.env.SOCIAL_AI_STREAM_IDLE_TIMEOUT_MS, 60_000);
/** Stream the model's answer (default). SOCIAL_AI_STREAMING=false falls back to one plain request bounded only by the total timeout. */
export const STREAM_ENABLED = process.env.SOCIAL_AI_STREAMING !== 'false';
export const STRATEGY_MAX_OUTPUT_TOKENS = num(process.env.SOCIAL_AI_STRATEGY_MAX_OUTPUT_TOKENS, 12_000);
/** Transient provider failures only (timeout / overloaded / rate-limit / network). */
export const STRATEGY_PROVIDER_RETRIES = num(process.env.SOCIAL_AI_STRATEGY_PROVIDER_RETRIES, 1);
/** Extra model calls allowed when the output fails Odito's validation (one repair attempt). */
export const STRATEGY_MAX_REPAIR_ATTEMPTS = num(process.env.SOCIAL_AI_STRATEGY_REPAIR_ATTEMPTS, 1);
/**
 * A `generating` strategy older than this is treated as interrupted (the process died or the
 * provider hung) and is failed so the project can generate again. Must exceed the worst-case
 * run: (timeout x (retries + 1) + backoff) x (repair attempts + 1).
 */
export const STRATEGY_STALE_MS = num(process.env.SOCIAL_AI_STRATEGY_STALE_MS, 30 * 60 * 1000);
/** Archived (superseded) versions kept per project. */
export const STRATEGY_HISTORY_LIMIT = num(process.env.SOCIAL_AI_STRATEGY_HISTORY_LIMIT, 20);

export const RATE_LIMIT = Object.freeze({
  enabled: process.env.SOCIAL_AI_STRATEGY_RATE_LIMIT_ENABLED !== 'false',
  windowMs: num(process.env.SOCIAL_AI_STRATEGY_RATE_WINDOW_MS, 15 * 60 * 1000),
  max: num(process.env.SOCIAL_AI_STRATEGY_RATE_MAX, 8),
});
