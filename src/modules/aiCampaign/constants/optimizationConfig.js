/**
 * Configurable thresholds for the deterministic opportunity detector and AI
 * cost/safety controls (Phase 7, spec §9/§10/§24/§40/§41).
 *
 * NONE of these are presented to the user as universal truths (spec §10 —
 * "do not pretend benchmarks are universal"). They are the server's own
 * DETECTION sensitivity knobs — the actual justification shown to the user
 * for any opportunity always cites the account/campaign's OWN observed
 * baseline (see opportunityDetector.js), never a hardcoded external number
 * presented as fact. Every value below is documented with its rationale so
 * it can be tuned without guessing at intent.
 */

// ── Opportunity detection ────────────────────────────────────────────────

/**
 * Minimum spend (in the campaign's own currency, major units) before a
 * "spend with zero conversions" signal is raised at all — avoids flagging
 * normal early-campaign noise (a handful of clicks costing a few units of
 * currency is not evidence of anything). This is a MINIMUM floor, not a
 * target — the real comparison inside the detector is against the
 * campaign's own average cost-per-conversion where it has any conversions,
 * or this floor when it has none.
 */
export const MIN_SPEND_FOR_ZERO_CONVERSION_FLAG = 500;

/** CPA >= (campaign average CPA * this multiplier) is flagged HIGH_CPA. Requires the campaign to have SOME conversions to compute an average against. */
export const HIGH_CPA_MULTIPLIER = 1.5;

/** CTR >= this percent below the campaign's own average CTR is flagged LOW_CTR (e.g. 40 = "40% below the campaign average"). */
export const LOW_CTR_BELOW_AVERAGE_PERCENT = 40;

/** Minimum impressions before a CTR comparison is considered meaningful at all (spec §28 — statistical caution). */
export const MIN_IMPRESSIONS_FOR_CTR_SIGNAL = 100;

/** Minimum conversions before a campaign/keyword can be flagged STRONG_PERFORMER (spec §28 — 1 conversion is not evidence of a real pattern). */
export const MIN_CONVERSIONS_FOR_STRONG_PERFORMER = 3;

/** STRONG_PERFORMER also requires CPA <= (campaign average CPA * this multiplier) — i.e. at least as efficient as average, not merely high-volume. */
export const STRONG_PERFORMER_CPA_MULTIPLIER = 1.0;

/** Keyword/ad-level: minimum spend before WEAK_KEYWORD / UNDERPERFORMING_AD can fire — same "avoid noise" floor as the campaign-level one, but smaller since individual entities naturally spend less. */
export const MIN_SPEND_FOR_ENTITY_FLAG = 200;

/** Minimum clicks before a data point counts as anything but insufficient_data (spec §28's literal "1 conversion, 2 clicks" example). */
export const MIN_CLICKS_FOR_MEANINGFUL_SIGNAL = 10;

// ── Confidence thresholds (spec §28) ─────────────────────────────────────
export const CONFIDENCE_THRESHOLDS = Object.freeze({
  // clicks < this -> insufficient_data regardless of anything else
  insufficientDataMaxClicks: 5,
  // clicks < this -> low_confidence
  lowConfidenceMaxClicks: 30,
  // clicks < this -> moderate_confidence; >= this -> high_confidence
  moderateConfidenceMaxClicks: 100,
});

// ── Budget safety (spec §24) ──────────────────────────────────────────────
/** A budget-increase recommendation whose proposed amount exceeds current*(1+this) is generated as INFORMATIONAL ONLY — never an executable mutation. */
export const MAX_BUDGET_INCREASE_PERCENT = 30;
/** Symmetric guard on the decrease side — an unusually large cut is just as risky to auto-approve blindly. */
export const MAX_BUDGET_DECREASE_PERCENT = 50;
/**
 * Claude never proposes a specific budget number (spec §16/§24 — a budget
 * amount is a trusted numeric field, not an AI decision). When a
 * STRONG_PERFORMER opportunity leads to an UPDATE_CAMPAIGN_BUDGET
 * recommendation, the server itself computes the proposed amount as
 * current budget * (1 + this) — fixed, deterministic, and always safely
 * under MAX_BUDGET_INCREASE_PERCENT by construction.
 */
export const DEFAULT_BUDGET_INCREASE_PERCENT = 15;

// ── AI cost control / bounded output (spec §40/§41) ──────────────────────
/** Claude is never called if deterministic detection found fewer than this many opportunities (spec §40 — "no meaningful opportunities -> no Claude call"). */
export const MIN_OPPORTUNITIES_FOR_AI_CALL = 1;
/** Upper bound on how many opportunities are ever included in one Claude call, most-severe-first — keeps the prompt small and the recommendation count bounded even for a large campaign. */
export const MAX_OPPORTUNITIES_PER_AI_CALL = 25;
/** Hard cap on recommendations accepted from one Claude response, regardless of how many it returns. */
export const MAX_RECOMMENDATIONS_PER_GENERATION = 15;
/** At most this many open recommendations may exist for one entity at a time — a fresh generation skips an entity that already has a pending recommendation rather than piling on duplicates. */
export const MAX_RECOMMENDATIONS_PER_ENTITY = 1;

// ── Staleness (spec §32) ──────────────────────────────────────────────────
/** A pending recommendation older than this is treated as stale even if nothing else changed — performance data itself ages out. */
export const RECOMMENDATION_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Crash recovery (spec §22/§23, mirrors Phase 6's PUBLISH_LOCK_STALE_MS): an execution lock stuck in 'executing' longer than this is treated as abandoned and may be reclaimed by a fresh approval request. A real optimization mutation is a single Google Ads call — well under a minute. */
export const OPTIMIZATION_LOCK_STALE_MS = 10 * 60 * 1000;

// ── Claude provider (mirrors generationConfig.js / editingConfig.js) ─────
export const CLAUDE_OPTIMIZATION_MODEL = process.env.CLAUDE_OPTIMIZATION_MODEL || 'claude-sonnet-5';
export const OPTIMIZATION_TIMEOUT_MS = 45_000;
export const OPTIMIZATION_MAX_OUTPUT_TOKENS = 4_000;
export const OPTIMIZATION_MAX_RETRIES = 2;
export const OPTIMIZATION_RETRY_BASE_MS = 1_000;

export const PROMPT_VERSION = 'campaign-optimization-v1';

const num = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

// ── Rate limiting for the analyze endpoint (spec §26 analogue) — separate
// budget from /generate and /assistant, same shared kill switch. One
// analyze call is at most one Claude call (often zero — see §40 AI cost
// control), so this can be more generous than a full campaign generation.
export const OPTIMIZATION_RATE_LIMIT = Object.freeze({
  enabled: process.env.AI_CAMPAIGN_RATE_LIMIT_ENABLED !== 'false',
  windowMs: num(process.env.AI_CAMPAIGN_OPTIMIZATION_WINDOW_MS, 15 * 60 * 1000),
  max: num(process.env.AI_CAMPAIGN_OPTIMIZATION_MAX, 20),
});

export default {
  MIN_SPEND_FOR_ZERO_CONVERSION_FLAG,
  HIGH_CPA_MULTIPLIER,
  LOW_CTR_BELOW_AVERAGE_PERCENT,
  MIN_IMPRESSIONS_FOR_CTR_SIGNAL,
  MIN_CONVERSIONS_FOR_STRONG_PERFORMER,
  STRONG_PERFORMER_CPA_MULTIPLIER,
  MIN_SPEND_FOR_ENTITY_FLAG,
  MIN_CLICKS_FOR_MEANINGFUL_SIGNAL,
  CONFIDENCE_THRESHOLDS,
  MAX_BUDGET_INCREASE_PERCENT,
  MAX_BUDGET_DECREASE_PERCENT,
  DEFAULT_BUDGET_INCREASE_PERCENT,
  MIN_OPPORTUNITIES_FOR_AI_CALL,
  MAX_OPPORTUNITIES_PER_AI_CALL,
  MAX_RECOMMENDATIONS_PER_GENERATION,
  MAX_RECOMMENDATIONS_PER_ENTITY,
  RECOMMENDATION_STALE_MS,
  OPTIMIZATION_LOCK_STALE_MS,
  CLAUDE_OPTIMIZATION_MODEL,
  OPTIMIZATION_TIMEOUT_MS,
  OPTIMIZATION_MAX_OUTPUT_TOKENS,
  OPTIMIZATION_MAX_RETRIES,
  OPTIMIZATION_RETRY_BASE_MS,
  PROMPT_VERSION,
  OPTIMIZATION_RATE_LIMIT,
};
