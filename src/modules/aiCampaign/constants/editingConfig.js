/**
 * Conversational AI campaign editing — configuration (Phase 4).
 *
 * Sibling of generationConfig.js (Phase 2), same conventions (env override,
 * numeric guard, no hardcoded model name). Kept in its own file rather than
 * added to generationConfig.js so Phase 2's already-tested config module is
 * never touched by this phase.
 */

const num = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

// Model precedence: a dedicated edit-model override → the Phase 2 campaign
// model env var (most deployments will want the same model for both) → the
// same built-in default Phase 2 uses.
export const CLAUDE_EDIT_MODEL =
  process.env.CLAUDE_EDIT_MODEL ||
  process.env.CLAUDE_CAMPAIGN_MODEL ||
  process.env.CLAUDE_MODEL ||
  'claude-sonnet-4-6';

// Edits are typically smaller than a full generation (a handful of changes,
// not a whole campaign) — shorter timeout / smaller output budget than
// Phase 2's generation call.
export const EDIT_TIMEOUT_MS = num(process.env.AI_CAMPAIGN_EDIT_TIMEOUT_MS, 60_000);
export const EDIT_MAX_OUTPUT_TOKENS = num(process.env.AI_CAMPAIGN_EDIT_MAX_OUTPUT_TOKENS, 4_000);
export const EDIT_MAX_RETRIES = num(process.env.AI_CAMPAIGN_EDIT_MAX_RETRIES, 1);
export const EDIT_RETRY_BASE_MS = num(process.env.AI_CAMPAIGN_EDIT_RETRY_BASE_MS, 1_200);

// ── Instruction + proposal limits ─────────────────────────────────────────
export const INSTRUCTION_MAX_LENGTH = num(process.env.AI_CAMPAIGN_INSTRUCTION_MAX_LENGTH, 2_000);
export const INSTRUCTION_MAX_BYTES = num(process.env.AI_CAMPAIGN_INSTRUCTION_MAX_BYTES, 4_000);

// A proposal not accepted within this window is treated as expired at the
// next read/accept attempt (spec §27 — a freshness check, not a cron job).
export const PROPOSAL_EXPIRY_MS = num(process.env.AI_CAMPAIGN_PROPOSAL_EXPIRY_MS, 24 * 60 * 60 * 1000);

// ── Rate limiting for the assistant endpoint (separate budget from /generate
// — an editing turn is far cheaper than a full campaign generation, so a
// tighter per-window count would be wrong; kept as its own knob) ──────────
export const ASSISTANT_RATE_LIMIT = Object.freeze({
  enabled: process.env.AI_CAMPAIGN_RATE_LIMIT_ENABLED !== 'false', // shares Phase 2's kill switch
  windowMs: num(process.env.AI_CAMPAIGN_ASSIST_WINDOW_MS, 15 * 60 * 1000),
  max: num(process.env.AI_CAMPAIGN_ASSIST_MAX, 20),
});
