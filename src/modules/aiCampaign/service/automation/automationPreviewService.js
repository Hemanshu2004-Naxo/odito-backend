/**
 * automationPreviewService — Phase 8: a READ-ONLY "what would this policy
 * do right now" preview. Reuses the exact same rule-matching + guardrail
 * evaluation `automationOrchestrator.js` runs for a real scheduled tick
 * (`evaluateRules` + `planCandidate`) — never a second, potentially
 * drifting copy of that logic — but performs NO writes at all: no
 * AiCampaignAutomationRun, no AiCampaignOptimizationOpportunity/
 * Recommendation, no Google Ads call, regardless of the policy's mode.
 */

import campaignDraftService from '../campaignDraftService.js';
import campaignOptimizationService, { CampaignOptimizationError } from '../campaignOptimizationService.js';
import * as performanceDataService from '../optimization/performanceDataService.js';
import { evaluateRules } from './automationRuleEngine.js';
import { computeEffectiveLimits } from './automationGuardrails.js';
import { planCandidate } from './automationOrchestrator.js';
import automationPolicyService from './automationPolicyService.js';
import AiCampaignOptimizationRecommendation from '../../model/AiCampaignOptimizationRecommendation.js';
import AiCampaignOptimizationExecution from '../../model/AiCampaignOptimizationExecution.js';
import { resolveGoogleAdsDateRange } from '../../../../utils/googleAdsDateRange.js';

async function resolvePolicyDateRange(preset) {
  return resolveGoogleAdsDateRange({ query: { range: preset || '30d' } }, {});
}

/**
 * @param {object} args
 * @param {string} args.userId
 * @param {string} args.policyId
 * @returns {Promise<{planned: object[], performanceAvailable: boolean}>}
 */
export async function previewPolicy({ userId, policyId }) {
  const policy = await automationPolicyService.getPolicy({ userId, policyId });
  const draft = await campaignDraftService.getDraft(policy.draftId);

  try {
    campaignOptimizationService.assertDraftOptimizable(draft);
  } catch (err) {
    if (err instanceof CampaignOptimizationError) {
      return { planned: [], performanceAvailable: false, blockedReason: err.code };
    }
    throw err;
  }

  const { startDate, endDate } = await resolvePolicyDateRange(policy.dateRangePreset);
  const snapshot = await performanceDataService.getFullPerformanceSnapshot({
    projectId: policy.projectId, customerId: draft.googleAdsCustomerId, campaignId: draft.googleAdsCampaignId, startDate, endDate,
  });

  if (!snapshot.dataAvailable) {
    return { planned: [], performanceAvailable: false };
  }

  const candidates = evaluateRules({ rules: policy.rules, snapshot: { ...snapshot, dateRange: { startDate, endDate } } });
  const effectiveLimits = computeEffectiveLimits(policy.limits);

  const [openRecommendations, recentAutomationExecutions] = await Promise.all([
    AiCampaignOptimizationRecommendation.find(
      { draftId: draft._id, status: { $in: ['pending', 'approved'] } },
      { target: 1, targetEntityId: 1 },
    ).lean(),
    AiCampaignOptimizationExecution.find(
      {
        draftId: draft._id, trigger: 'automation', status: 'executed',
        completedAt: { $gte: new Date(Date.now() - effectiveLimits.cooldownHours * 60 * 60 * 1000) },
      },
      { target: 1, targetEntityId: 1 },
    ).lean(),
  ]);
  const conflictSet = new Set(openRecommendations.map((r) => `${r.target}:${r.targetEntityId}`));
  const cooldownSet = new Set(recentAutomationExecutions.map((e) => `${e.target}:${e.targetEntityId}`));

  let actionsTakenSoFar = 0;
  const planned = candidates.map((candidate) => {
    const { target, derivedChange, guardrail } = planCandidate({
      candidate, policy, draft, effectiveLimits, actionsTakenSoFar, cooldownSet, conflictSet,
    });
    if (guardrail.allowed) actionsTakenSoFar += 1;
    return {
      operation: candidate.operation,
      target,
      targetEntityId: derivedChange?.targetEntityId || candidate.opportunitySeed.entityId,
      targetEntityLabel: derivedChange?.targetEntityLabel || candidate.opportunitySeed.entityLabel,
      matchedMetric: candidate.matchedMetric,
      matchedValue: candidate.matchedValue,
      operator: candidate.operator,
      threshold: candidate.threshold,
      proposedChange: derivedChange?.proposedChange || null,
      wouldRun: guardrail.allowed && policy.mode !== 'observe',
      skipReason: guardrail.allowed ? (policy.mode === 'observe' ? 'MODE_OBSERVE_ONLY' : null) : guardrail.skipReason,
    };
  });

  return { planned, performanceAvailable: true };
}

export default { previewPolicy };
