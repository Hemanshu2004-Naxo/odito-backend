/**
 * automationGuardrails — Phase 8. Every safety check a candidate action
 * must pass BEFORE it is allowed to become a recommendation (mode:
 * 'recommend'/'execute') or is even logged as actionable (mode: 'observe'
 * skips this whole module). Pure and deterministic — conflict resolution,
 * limits, and cooldowns are never delegated to Claude; this file has no
 * network or Mongo access of its own, so it can never accidentally do so.
 * automationOrchestrator.js supplies every piece of live state (cooldown/
 * conflict lookups) as plain booleans computed from a small number of
 * upfront queries, keeping this module fully unit-testable without a
 * database.
 */

import {
  isAutomationOperationAllowed, isHighRiskAutomationOperation,
} from '../../constants/automationEnums.js';
import {
  SYSTEM_MAX_ACTIONS_PER_RUN, SYSTEM_MIN_COOLDOWN_HOURS, SYSTEM_MAX_BUDGET_CHANGE_PERCENT,
  MIN_ALLOWED_RULE_MINIMUM_CLICKS,
} from '../../constants/automationConfig.js';

/** effectiveLimit = min(userConfigured, systemMaximum) for ceilings, max(...) for a floor like cooldown (a user may only ask for MORE caution, never less than the system minimum). */
export function computeEffectiveLimits(policyLimits) {
  return {
    maxActionsPerRun: Math.min(policyLimits?.maxActionsPerRun ?? SYSTEM_MAX_ACTIONS_PER_RUN, SYSTEM_MAX_ACTIONS_PER_RUN),
    cooldownHours: Math.max(policyLimits?.cooldownHours ?? SYSTEM_MIN_COOLDOWN_HOURS, SYSTEM_MIN_COOLDOWN_HOURS),
    maxBudgetChangePercent: Math.min(policyLimits?.maxBudgetChangePercent ?? SYSTEM_MAX_BUDGET_CHANGE_PERCENT, SYSTEM_MAX_BUDGET_CHANGE_PERCENT),
  };
}

/**
 * @param {object} args
 * @param {object} args.candidate - one automationRuleEngine.evaluateRules() candidate
 * @param {object} args.policy - plain policy object ({ allowedOperations, highRiskOperationsEnabled })
 * @param {object} args.effectiveLimits - computeEffectiveLimits()'s return value
 * @param {number} args.actionsTakenSoFar - how many actions this run has already committed to (executed/recommended), before this one
 * @param {boolean} args.cooldownActive - true if this exact entity had an automation execution within the cooldown window
 * @param {boolean} args.conflictExists - true if this exact entity already has an open (pending/approved) recommendation, from any source
 * @param {object|null} args.derivedChange - recommendationValidator.buildProposedChangeForOperation()'s output for this candidate (null if it couldn't be derived at all)
 * @returns {{allowed: true} | {allowed: false, skipReason: string}}
 */
export function checkGuardrails({
  candidate, policy, effectiveLimits, actionsTakenSoFar, cooldownActive, conflictExists, derivedChange,
}) {
  if (!isAutomationOperationAllowed(candidate.operation) || !(policy.allowedOperations || []).includes(candidate.operation)) {
    return { allowed: false, skipReason: 'OPERATION_NOT_ALLOWED' };
  }
  if (isHighRiskAutomationOperation(candidate.operation) && !policy.highRiskOperationsEnabled) {
    return { allowed: false, skipReason: 'HIGH_RISK_NOT_ENABLED' };
  }

  const minClicks = Math.max(candidate.minimumClicks || 0, MIN_ALLOWED_RULE_MINIMUM_CLICKS);
  if ((candidate.clicks || 0) < minClicks) {
    return { allowed: false, skipReason: 'INSUFFICIENT_DATA' };
  }

  if (cooldownActive) return { allowed: false, skipReason: 'COOLDOWN_ACTIVE' };
  if (conflictExists) return { allowed: false, skipReason: 'CONFLICT_EXISTING_RECOMMENDATION' };

  if (candidate.operation === 'UPDATE_CAMPAIGN_BUDGET') {
    const before = derivedChange?.proposedChange?.before;
    const after = derivedChange?.proposedChange?.after;
    if (Number.isFinite(before) && before > 0 && Number.isFinite(after)) {
      const pctChange = (Math.abs(after - before) / before) * 100;
      if (pctChange > effectiveLimits.maxBudgetChangePercent) {
        return { allowed: false, skipReason: 'BUDGET_CHANGE_EXCEEDS_LIMIT' };
      }
    }
  }

  if (actionsTakenSoFar >= effectiveLimits.maxActionsPerRun) {
    return { allowed: false, skipReason: 'LIMIT_REACHED' };
  }

  return { allowed: true };
}

export default { computeEffectiveLimits, checkGuardrails };
