/**
 * Automation & Autonomous Optimization Controls — Phase 8 controlled
 * vocabulary.
 *
 * Phase 8 does not invent a second mutation system. A policy's rules match
 * deterministically against the SAME performance snapshot shape Phase 7
 * uses (performanceDataService.js), produce a candidate action for one of
 * Phase 7's own OPTIMIZATION_OPERATIONS, and — once guardrails pass — are
 * driven through the EXACT SAME AiCampaignOptimizationRecommendation /
 * campaignOptimizationService.approveRecommendation mutation boundary a
 * human's manual approval already uses (see automationOrchestrator.js).
 * This file only adds the vocabulary specific to the automation layer
 * itself: modes, rule shape, run/action lifecycle, and risk gating.
 */

import { OPTIMIZATION_OPERATIONS, OPERATION_TARGET, OPERATION_RISK } from './optimizationEnums.js';

// ── Modes (spec: observe/recommend/execute, default disabled + observe) ──
// A mode change is NEVER made by the scheduler/orchestrator itself — only
// automationPolicyService.setMode(), called from an explicit user request.
// This file intentionally defines no "transition table" for modes: any mode
// is reachable from any other by explicit user action; the important
// invariant (mode never silently escalates on its own) is enforced by
// automationOrchestrator.js never writing `policy.mode`, not by a state
// machine here.
export const AUTOMATION_MODES = ['observe', 'recommend', 'execute'];

// ── Rule vocabulary — closed, structured, no eval/expressions/raw code ───
// Mirrors the metric fields performanceDataService.deriveRates/normalizeMetrics
// actually produces (Phase 7) — a rule can only ever reference a metric that
// is a real, already-normalized number.
export const RULE_METRICS = ['impressions', 'clicks', 'cost', 'conversions', 'conversionsValue', 'ctr', 'avgCpc', 'conversionRate', 'cpa', 'roas'];

export const RULE_OPERATORS = ['lt', 'lte', 'gt', 'gte', 'eq'];

export function evaluateOperator(operator, value, threshold) {
  if (value == null) return false; // a null rate metric (zero denominator) never satisfies any rule — spec's null-vs-zero discipline carries over
  switch (operator) {
    case 'lt': return value < threshold;
    case 'lte': return value <= threshold;
    case 'gt': return value > threshold;
    case 'gte': return value >= threshold;
    case 'eq': return value === threshold;
    default: return false;
  }
}

// ── Restricted operation allowlist (spec: subset of Phase 7's operations) ─
// Every automation operation is still one of Phase 7's own closed
// OPTIMIZATION_OPERATIONS — Phase 8 adds no new mutation kind, only a
// risk-tiered subset + an explicit high-risk opt-in gate on top of it.
export const AUTOMATION_OPERATIONS = OPTIMIZATION_OPERATIONS;

// Conservative, reversible, spend-protective actions — usable the moment a
// policy is enabled, no extra opt-in required.
export const AUTOMATION_DEFAULT_OPERATIONS = ['PAUSE_KEYWORD', 'ADD_NEGATIVE_KEYWORD', 'PAUSE_AD'];

// Re-activating a paused entity or changing spend unattended carries more
// blast radius than pausing/excluding — requires policy.highRiskOperationsEnabled.
export const AUTOMATION_HIGH_RISK_OPERATIONS = ['ENABLE_KEYWORD', 'ENABLE_AD', 'UPDATE_CAMPAIGN_BUDGET'];

export function isAutomationOperationAllowed(operation) {
  return AUTOMATION_OPERATIONS.includes(operation);
}

export function isHighRiskAutomationOperation(operation) {
  return AUTOMATION_HIGH_RISK_OPERATIONS.includes(operation);
}

// The entity type a rule for this operation actually matches against.
// ADD_NEGATIVE_KEYWORD's own OPERATION_TARGET is AD_GROUP (the negative
// keyword is added TO an ad group) but the matching signal is SEARCH_TERM
// level, exactly like Phase 7's opportunityDetector/recommendationValidator
// treat it — reused here rather than re-decided.
export const RULE_MATCH_ENTITY_TYPE = Object.freeze({
  PAUSE_KEYWORD: 'KEYWORD',
  ENABLE_KEYWORD: 'KEYWORD',
  ADD_NEGATIVE_KEYWORD: 'SEARCH_TERM',
  PAUSE_AD: 'AD',
  ENABLE_AD: 'AD',
  UPDATE_CAMPAIGN_BUDGET: 'CAMPAIGN',
});

export { OPERATION_TARGET, OPERATION_RISK };

// ── Schedule ───────────────────────────────────────────────────────────
export const AUTOMATION_FREQUENCIES = ['every_6_hours', 'every_12_hours', 'daily', 'weekly'];
// Frequencies whose next-run is computed from elapsed time alone (no
// timezone/hour-of-day involved) vs. ones anchored to a local wall-clock
// hour in the policy's own timezone (see automationScheduleCalculator.js).
export const ELAPSED_TIME_FREQUENCIES = ['every_6_hours', 'every_12_hours'];
export const WALL_CLOCK_FREQUENCIES = ['daily', 'weekly'];

// ── Run lifecycle ──────────────────────────────────────────────────────
export const AUTOMATION_RUN_STATUSES = ['pending', 'running', 'completed', 'failed', 'partially_completed'];
export const RETRYABLE_RUN_STATUSES = ['pending', 'failed', 'partially_completed'];

export const AUTOMATION_RUN_TRANSITIONS = Object.freeze({
  pending: ['running'],
  running: ['completed', 'failed', 'partially_completed'],
  completed: [],
  failed: ['running'], // a crashed/failed run may be retried by a fresh claim, same document
  partially_completed: ['running'],
});

export function canTransitionAutomationRunStatus(from, to) {
  if (from === to) return true;
  // Array.includes() FIRST — `from`/`to` may be arbitrary strings, and
  // indexing AUTOMATION_RUN_TRANSITIONS with a key like "__proto__" would
  // otherwise return Object.prototype (truthy, but not an array) rather
  // than undefined.
  if (!AUTOMATION_RUN_STATUSES.includes(from) || !AUTOMATION_RUN_STATUSES.includes(to)) return false;
  return (AUTOMATION_RUN_TRANSITIONS[from] || []).includes(to);
}

// Crash recovery (mirrors Phase 6 PUBLISH_LOCK_STALE_MS / Phase 7
// OPTIMIZATION_LOCK_STALE_MS): a run stuck in 'running' longer than this is
// abandoned and may be reclaimed. An automation run is a handful of Google
// Ads reads + at most a system-capped number of mutations — well under 10 min.
export const AUTOMATION_LOCK_STALE_MS = 10 * 60 * 1000;

// ── Per-action outcome within a run ────────────────────────────────────
export const AUTOMATION_ACTION_STATUSES = ['executed', 'recommended', 'skipped', 'failed'];

export const AUTOMATION_SKIP_REASONS = [
  'INSUFFICIENT_DATA',
  'COOLDOWN_ACTIVE',
  'LIMIT_REACHED',
  'CONFLICT_EXISTING_RECOMMENDATION',
  'OPERATION_NOT_ALLOWED',
  'HIGH_RISK_NOT_ENABLED',
  'BUDGET_CHANGE_EXCEEDS_LIMIT',
  'ALREADY_IN_DESIRED_STATE',
  'MODE_OBSERVE_ONLY',
];

// ── Safe, classified error codes (never a raw Google Ads / gRPC error) ───
export const AUTOMATION_ERROR_CODES = [
  'POLICY_NOT_FOUND',
  'POLICY_DISABLED',
  'AUTOMATION_KILL_SWITCH_ENABLED',
  'DRAFT_NOT_PUBLISHED',
  'ACCOUNT_UNAVAILABLE',
  'PERFORMANCE_UNAVAILABLE',
  'RUN_ALREADY_IN_PROGRESS',
  'INVALID_SCHEDULE',
  'INVALID_RULE',
  'VERSION_CONFLICT',
];

export default {
  AUTOMATION_MODES,
  RULE_METRICS,
  RULE_OPERATORS,
  evaluateOperator,
  AUTOMATION_OPERATIONS,
  AUTOMATION_DEFAULT_OPERATIONS,
  AUTOMATION_HIGH_RISK_OPERATIONS,
  isAutomationOperationAllowed,
  isHighRiskAutomationOperation,
  RULE_MATCH_ENTITY_TYPE,
  OPERATION_TARGET,
  OPERATION_RISK,
  AUTOMATION_FREQUENCIES,
  ELAPSED_TIME_FREQUENCIES,
  WALL_CLOCK_FREQUENCIES,
  AUTOMATION_RUN_STATUSES,
  RETRYABLE_RUN_STATUSES,
  AUTOMATION_RUN_TRANSITIONS,
  canTransitionAutomationRunStatus,
  AUTOMATION_LOCK_STALE_MS,
  AUTOMATION_ACTION_STATUSES,
  AUTOMATION_SKIP_REASONS,
  AUTOMATION_ERROR_CODES,
};
