/**
 * Google Ads Performance + AI Optimization — controlled vocabulary (Phase 7).
 *
 * "Opportunity vs Recommendation" (spec §13): an Opportunity is a
 * deterministic SIGNAL computed from normalized performance data alone,
 * with zero AI involvement — it is reproducible and explainable without
 * Claude. A Recommendation is a proposed ACTION (always tied to zero or
 * more opportunities) that Claude drafts and the server validates; only a
 * Recommendation can ever become an executable mutation.
 */

// ── Opportunity ────────────────────────────────────────────────────────
export const OPPORTUNITY_TYPES = [
  'HIGH_SPEND_NO_CONVERSIONS',      // campaign or keyword: spend well above the account's typical efficient cost, zero conversions
  'HIGH_CPA',                        // cost-per-conversion materially above the configured/observed target
  'LOW_CTR',                         // CTR materially below the campaign's own baseline, at meaningful volume
  'STRONG_PERFORMER',                // healthy conversion volume + efficient CPA/ROAS — a budget-increase candidate
  'LOW_IMPRESSION_SHARE',            // good efficiency, but capped by budget/rank — informational only (Google Ads doesn't expose impression share for every account/campaign type the same way; treated as informational, never executable)
  'WEAK_KEYWORD',                    // keyword-level: high spend, no/low conversions
  'STRONG_KEYWORD',                  // keyword-level: efficient conversions — preserve/emphasize
  'NEGATIVE_KEYWORD_CANDIDATE',      // search term: spend with zero conversions, not yet excluded
  'UNDERPERFORMING_AD',              // ad-level: spend with materially worse CTR/conversion rate than its ad group's other ads
  'AUTOMATION_RULE_MATCH',           // Phase 8 (additive): a user-defined automation policy rule matched — distinct from the deterministic detector types above, which opportunityDetector.js alone produces.
];

export const OPPORTUNITY_SEVERITIES = ['info', 'warning', 'critical'];

export const OPPORTUNITY_ENTITY_TYPES = ['CAMPAIGN', 'AD_GROUP', 'KEYWORD', 'AD', 'SEARCH_TERM'];

export const OPPORTUNITY_STATUSES = ['open', 'reviewed', 'accepted', 'rejected', 'executed', 'expired'];

// ── Data sufficiency (spec §28) — server-computed, never left to Claude ──
export const CONFIDENCE_LEVELS = ['insufficient_data', 'low_confidence', 'moderate_confidence', 'high_confidence'];

// ── Recommendation ─────────────────────────────────────────────────────
export const RECOMMENDATION_STATUSES = ['pending', 'approved', 'rejected', 'stale', 'executed', 'failed'];

export const RECOMMENDATION_TRANSITIONS = Object.freeze({
  pending: ['approved', 'rejected', 'stale'],
  approved: ['executed', 'failed'],
  rejected: [],
  stale: [],
  executed: [],
  failed: [],
});

export function canTransitionRecommendationStatus(from, to) {
  if (from === to) return true;
  return (RECOMMENDATION_TRANSITIONS[from] || []).includes(to);
}

export const RISK_LEVELS = ['low', 'medium', 'high'];

// ── Allowed optimization operations (spec §17) — closed vocabulary ──────
// Every operation here has a real, tested Phase 7 mutation path (see
// googleAdsOptimizationProvider.js). Nothing outside this list can ever
// become an executable mutation, regardless of what Claude proposes.
//
// Deliberately excluded (spec §25/§17 — "recommend review" instead):
//   - UPDATE_KEYWORD_BID: Odito campaigns only ever use portfolio/automated
//     bidding strategies (MAXIMIZE_CONVERSIONS/_VALUE, MAXIMIZE_CLICKS —
//     see aiCampaignEnums.js BIDDING_STRATEGIES and Phase 6's
//     publishPlanBuilder.js, which already rejects TARGET_CPA/TARGET_ROAS
//     for lack of a captured numeric target). Odito never captures a
//     per-keyword manual CPC bid, so there is nothing to update.
//   - UPDATE_BIDDING: switching bidding strategy post-publish is exactly
//     the "uncertain, recommend review" case spec §25 describes.
//   - REPLACE_AD: full new ad content generation/validation is a bigger
//     surface than this phase's scope; PAUSE_AD/ENABLE_AD cover the safe,
//     reversible actions an ad-level opportunity actually calls for.
//   - PAUSE_AD_GROUP/ENABLE_AD_GROUP: opportunityDetector.js has no
//     ad-group-level rule (its signals are campaign/keyword/ad/search-term
//     scoped) — including an operation with no possible justifying
//     opportunity would be dead, unreachable vocabulary. Every operation
//     below has a real detector rule that can produce it.
export const OPTIMIZATION_OPERATIONS = [
  'PAUSE_KEYWORD',
  'ENABLE_KEYWORD',
  'ADD_NEGATIVE_KEYWORD',
  'PAUSE_AD',
  'ENABLE_AD',
  'UPDATE_CAMPAIGN_BUDGET',
];

export const OPTIMIZATION_TARGETS = ['CAMPAIGN', 'AD_GROUP', 'KEYWORD', 'AD'];

/** operation -> the single target type it addresses. */
export const OPERATION_TARGET = Object.freeze({
  PAUSE_KEYWORD: 'KEYWORD',
  ENABLE_KEYWORD: 'KEYWORD',
  ADD_NEGATIVE_KEYWORD: 'AD_GROUP', // the negative keyword is added TO an ad group
  PAUSE_AD: 'AD',
  ENABLE_AD: 'AD',
  UPDATE_CAMPAIGN_BUDGET: 'CAMPAIGN',
});

/** operation -> server-determined risk classification (never AI-decided — spec §16). Reversible, narrow-blast-radius actions are low risk; anything touching spend directly is higher. */
export const OPERATION_RISK = Object.freeze({
  PAUSE_KEYWORD: 'low',
  ENABLE_KEYWORD: 'low',
  ADD_NEGATIVE_KEYWORD: 'low',
  PAUSE_AD: 'low',
  ENABLE_AD: 'low',
  UPDATE_CAMPAIGN_BUDGET: 'medium',
});

/** True only when `operation` is a real, known operation for exactly `target` — Array.includes lookups only (never unsafe object-key indexing on an untrusted string, the Phase 4 lesson). */
export function isOptimizationOperationAllowed(operation, target) {
  if (!OPTIMIZATION_OPERATIONS.includes(operation)) return false;
  if (!OPTIMIZATION_TARGETS.includes(target)) return false;
  return OPERATION_TARGET[operation] === target;
}

// ── Execution ───────────────────────────────────────────────────────────
export const EXECUTION_STATUSES = ['pending', 'executing', 'executed', 'failed'];

export const RETRYABLE_EXECUTION_STATUSES = ['pending', 'failed'];

// Safe, classified error codes surfaced to the frontend (spec §35). Never a
// raw Google Ads / gRPC error.
export const OPTIMIZATION_ERROR_CODES = [
  'PERFORMANCE_UNAVAILABLE',
  'INSUFFICIENT_DATA',
  'RECOMMENDATION_STALE',
  'RECOMMENDATION_ALREADY_DECIDED',
  'TARGET_NOT_FOUND',
  'TARGET_STATE_CHANGED',
  'OPTIMIZATION_NOT_ALLOWED',
  'OPTIMIZATION_ALREADY_EXECUTED',
  'OPTIMIZATION_ALREADY_IN_PROGRESS',
  'DRAFT_NOT_PUBLISHED',
  'ACCOUNT_UNAVAILABLE',
  'GOOGLE_AUTHORIZATION_FAILED',
  'GOOGLE_VALIDATION_FAILED',
  'GOOGLE_QUOTA',
  'GOOGLE_POLICY',
  'GOOGLE_NETWORK',
  'GOOGLE_UNKNOWN',
];

export default {
  OPPORTUNITY_TYPES,
  OPPORTUNITY_SEVERITIES,
  OPPORTUNITY_ENTITY_TYPES,
  OPPORTUNITY_STATUSES,
  CONFIDENCE_LEVELS,
  RECOMMENDATION_STATUSES,
  RECOMMENDATION_TRANSITIONS,
  canTransitionRecommendationStatus,
  RISK_LEVELS,
  OPTIMIZATION_OPERATIONS,
  OPTIMIZATION_TARGETS,
  OPERATION_TARGET,
  OPERATION_RISK,
  isOptimizationOperationAllowed,
  EXECUTION_STATUSES,
  RETRYABLE_EXECUTION_STATUSES,
  OPTIMIZATION_ERROR_CODES,
};
