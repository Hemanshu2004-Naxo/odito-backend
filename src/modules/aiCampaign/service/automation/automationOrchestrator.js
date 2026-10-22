/**
 * automationOrchestrator — Phase 8: runs exactly ONE policy for ONE
 * scheduled window. This is the file that ties the deterministic rule
 * engine + guardrails to the REAL mutation boundary — and it does so by
 * reusing Phase 6/7's own machinery, never a second one:
 *
 *   1. Read performance — performanceDataService.js (Phase 7, unmodified).
 *   2. Match rules       — automationRuleEngine.js (pure, Phase 8).
 *   3. Derive trusted fields for a match — recommendationValidator's own
 *      `buildProposedChangeForOperation` (Phase 7, reused verbatim — an
 *      automation rule already carries its `operation`, so there is no
 *      Claude operation-selection step to redo here).
 *   4. Guardrails — automationGuardrails.js (pure, Phase 8): allowlist,
 *      high-risk opt-in, data sufficiency, cooldown, conflict, budget
 *      ceiling, per-run action limit. Every check here is deterministic;
 *      NOTHING about whether an action executes is ever decided by Claude.
 *   5. Persist as a REAL AiCampaignOptimizationRecommendation
 *      (source:'automation') — the exact same document type, and the exact
 *      same UI (OptimizationPanel), a human's manual analysis produces.
 *   6. In 'execute' mode only: drive it through
 *      campaignOptimizationService.approveRecommendation — the SAME
 *      Layer-2-revalidate-then-mutate path a human's Approve click uses,
 *      just with `userId` set to the policy's own creator (whose connected
 *      Google Ads account this campaign already runs under).
 *
 * Claude is deliberately NOT called anywhere in this file. An automation
 * rule's `operation` is already fully specified by the user (it's part of
 * the rule, not inferred), so there is nothing here for Claude to decide;
 * `reason`/`expectedImpact` use a deterministic template
 * (buildDeterministicReason/buildDeterministicExpectedImpact below) instead
 * of an extra paid API call for prose alone. Nothing about correctness or
 * safety here depends on Claude being configured.
 */

import { LoggerUtil } from '../../../../utils/LoggerUtil.js';
import campaignDraftService from '../campaignDraftService.js';
import campaignOptimizationService, { CampaignOptimizationError } from '../campaignOptimizationService.js';
import AiCampaignOptimizationOpportunity from '../../model/AiCampaignOptimizationOpportunity.js';
import AiCampaignOptimizationRecommendation from '../../model/AiCampaignOptimizationRecommendation.js';
import AiCampaignOptimizationExecution from '../../model/AiCampaignOptimizationExecution.js';
import * as performanceDataService from '../optimization/performanceDataService.js';
import { computeConfidence } from '../optimization/opportunityDetector.js';
import { buildProposedChangeForOperation } from '../optimization/recommendationValidator.js';
import { evaluateRules } from './automationRuleEngine.js';
import { computeEffectiveLimits, checkGuardrails } from './automationGuardrails.js';
import * as automationRunService from './automationRunService.js';
import { computeNextRunAt } from './automationScheduleCalculator.js';
import { OPERATION_TARGET, OPERATION_RISK } from '../../constants/automationEnums.js';
import { resolveGoogleAdsDateRange } from '../../../../utils/googleAdsDateRange.js';

const CONFIDENCE_RANK = { insufficient_data: 0, low_confidence: 1, moderate_confidence: 2, high_confidence: 3 };
const OPERATOR_LABEL = { lt: 'is below', lte: 'is at or below', gt: 'is above', gte: 'is at or above', eq: 'equals' };

function buildDeterministicReason(candidate) {
  const label = OPERATOR_LABEL[candidate.operator] || candidate.operator;
  const observed = Number.isFinite(candidate.matchedValue) ? candidate.matchedValue.toFixed(2) : String(candidate.matchedValue);
  return `Automation rule matched: ${candidate.matchedMetric} ${label} ${candidate.threshold} (observed ${observed}) for ${candidate.opportunitySeed.entityLabel}.`.slice(0, 1000);
}

function buildDeterministicExpectedImpact() {
  return 'This action follows your configured automation policy rule. Review the automation history after it runs to confirm the effect.';
}

async function resolvePolicyDateRange(preset) {
  // Reuses the exact same day-count math every Phase 7 endpoint uses,
  // via the same req-shaped call contract, rather than re-deriving preset
  // day-counts a second time in this file.
  const fakeReq = { query: { range: preset || '30d' } };
  return resolveGoogleAdsDateRange(fakeReq, {});
}

async function upsertAutomationOpportunity({ projectId, draftId, campaignResourceId, seed, dateRange }) {
  const dateRangeKey = `${dateRange.startDate.toISOString().slice(0, 10)}_${dateRange.endDate.toISOString().slice(0, 10)}`;
  const confidence = computeConfidence(seed.metrics?.clicks || 0);
  const doc = await AiCampaignOptimizationOpportunity.findOneAndUpdate(
    {
      draftId, entityType: seed.entityType, entityId: seed.entityId, opportunityType: 'AUTOMATION_RULE_MATCH', dateRangeKey,
    },
    {
      $set: {
        projectId, campaignResourceId, entityLabel: seed.entityLabel, severity: 'info', confidence,
        metrics: seed.metrics, baseline: { source: 'automation_policy_rule' },
        message: `Automation policy rule matched for ${seed.entityLabel}.`,
        dateRangeStart: dateRange.startDate, dateRangeEnd: dateRange.endDate, detectedAt: new Date(),
      },
      $setOnInsert: { status: 'open' },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
  );
  return doc.toObject();
}

/**
 * Derive the trusted change + run every guardrail for ONE candidate,
 * without writing anything. Shared by `runClaimedPolicy` (which then
 * persists/executes) and automationPreviewService.js (which stops here —
 * spec's read-only "preview a policy's rules" requirement reuses this
 * exact evaluation instead of a second, potentially-drifting copy of it).
 */
export function planCandidate({
  candidate, policy, draft, effectiveLimits, actionsTakenSoFar, cooldownSet, conflictSet,
}) {
  const target = OPERATION_TARGET[candidate.operation];
  const derivedChange = buildProposedChangeForOperation(candidate.operation, candidate.opportunitySeed, {
    campaign: { campaignResourceId: draft.googleAdsCampaignId, dailyBudgetMicros: draft.campaign?.dailyBudgetMicros },
  });

  if (!derivedChange) {
    return { target, derivedChange: null, guardrail: { allowed: false, skipReason: 'INSUFFICIENT_DATA' } };
  }

  const entityKey = `${target}:${derivedChange.targetEntityId}`;
  const guardrail = checkGuardrails({
    candidate, policy, effectiveLimits, actionsTakenSoFar,
    cooldownActive: cooldownSet.has(entityKey), conflictExists: conflictSet.has(entityKey), derivedChange,
  });
  return { target, derivedChange, guardrail, entityKey };
}

/**
 * Runs one already-claimed automation run to completion. The caller
 * (automationScheduler.js) is responsible for claiming the run via
 * automationRunService.claimRun — this function assumes it already holds
 * the lock and focuses purely on evaluation + execution.
 *
 * @param {object} args
 * @param {object} args.policy - plain AiCampaignAutomationPolicy object
 * @param {object} args.run - the claimed AiCampaignAutomationRun document (Mongoose doc, not lean — its _id is used throughout)
 */
export async function runClaimedPolicy({ policy, run }) {
  const runId = run._id;

  let draft;
  try {
    draft = await campaignDraftService.getDraft(policy.draftId);
    campaignOptimizationService.assertDraftOptimizable(draft);
  } catch (err) {
    await automationRunService.markFailed(runId, { code: 'DRAFT_NOT_PUBLISHED', message: err.message });
    return { status: 'failed', code: 'DRAFT_NOT_PUBLISHED' };
  }

  try {
    await campaignOptimizationService.resolveAccount({ userId: policy.createdBy, projectId: policy.projectId, draft });
  } catch (err) {
    await automationRunService.markFailed(runId, { code: 'ACCOUNT_UNAVAILABLE', message: err.message });
    return { status: 'failed', code: 'ACCOUNT_UNAVAILABLE' };
  }

  const { startDate, endDate } = await resolvePolicyDateRange(policy.dateRangePreset);
  const snapshot = await performanceDataService.getFullPerformanceSnapshot({
    projectId: policy.projectId, customerId: draft.googleAdsCustomerId, campaignId: draft.googleAdsCampaignId, startDate, endDate,
  });

  if (!snapshot.dataAvailable) {
    await automationRunService.markFailed(runId, { code: 'PERFORMANCE_UNAVAILABLE', message: 'No performance data is available yet for this campaign.' });
    return { status: 'failed', code: 'PERFORMANCE_UNAVAILABLE' };
  }

  const candidates = evaluateRules({ rules: policy.rules, snapshot: { ...snapshot, dateRange: { startDate, endDate } } });
  await automationRunService.setActionsPlanned(runId, candidates.length);

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

  for (const candidate of candidates) {
    const {
      target, derivedChange, guardrail, entityKey,
    } = planCandidate({
      candidate, policy, draft, effectiveLimits, actionsTakenSoFar, cooldownSet, conflictSet,
    });

    if (!derivedChange) {
      // eslint-disable-next-line no-await-in-loop
      await automationRunService.appendAction(runId, {
        ruleIndex: candidate.ruleIndex, operation: candidate.operation, target,
        targetEntityId: candidate.opportunitySeed.entityId, targetEntityLabel: candidate.opportunitySeed.entityLabel,
        matchedMetric: candidate.matchedMetric, matchedValue: candidate.matchedValue, threshold: candidate.threshold,
        status: 'skipped', skipReason: 'INSUFFICIENT_DATA',
      });
      continue; // eslint-disable-line no-continue
    }

    if (!guardrail.allowed) {
      // eslint-disable-next-line no-await-in-loop
      await automationRunService.appendAction(runId, {
        ruleIndex: candidate.ruleIndex, operation: candidate.operation, target,
        targetEntityId: derivedChange.targetEntityId, targetEntityLabel: derivedChange.targetEntityLabel,
        matchedMetric: candidate.matchedMetric, matchedValue: candidate.matchedValue, threshold: candidate.threshold,
        status: 'skipped', skipReason: guardrail.skipReason,
      });
      continue; // eslint-disable-line no-continue
    }

    if (policy.mode === 'observe') {
      // eslint-disable-next-line no-await-in-loop
      await automationRunService.appendAction(runId, {
        ruleIndex: candidate.ruleIndex, operation: candidate.operation, target,
        targetEntityId: derivedChange.targetEntityId, targetEntityLabel: derivedChange.targetEntityLabel,
        matchedMetric: candidate.matchedMetric, matchedValue: candidate.matchedValue, threshold: candidate.threshold,
        status: 'skipped', skipReason: 'MODE_OBSERVE_ONLY',
      });
      continue; // eslint-disable-line no-continue
    }

    // ── recommend / execute: persist a REAL Phase 7 recommendation ──────
    // eslint-disable-next-line no-await-in-loop
    const opportunity = await upsertAutomationOpportunity({
      projectId: policy.projectId, draftId: draft._id, campaignResourceId: draft.googleAdsCampaignId,
      seed: candidate.opportunitySeed, dateRange: { startDate, endDate },
    });

    const confidence = computeConfidence(candidate.clicks);
    const executable = candidate.operation === 'UPDATE_CAMPAIGN_BUDGET'
      ? CONFIDENCE_RANK[confidence] >= CONFIDENCE_RANK.moderate_confidence
      : true;

    // eslint-disable-next-line no-await-in-loop
    const recommendation = await AiCampaignOptimizationRecommendation.create({
      projectId: policy.projectId, draftId: draft._id, campaignResourceId: draft.googleAdsCampaignId,
      opportunityIds: [opportunity._id],
      operation: candidate.operation, target,
      targetEntityId: derivedChange.targetEntityId, targetEntityLabel: derivedChange.targetEntityLabel,
      negativeKeywordText: derivedChange.negativeKeywordText || null, negativeKeywordMatchType: derivedChange.negativeKeywordMatchType || null,
      proposedChange: derivedChange.proposedChange, expectedCurrentValue: derivedChange.expectedCurrentValue,
      reason: buildDeterministicReason(candidate), expectedImpact: buildDeterministicExpectedImpact(),
      confidence, risk: OPERATION_RISK[candidate.operation], supportingMetrics: candidate.opportunitySeed.metrics,
      executable,
      status: 'pending',
      performanceDateRangeStart: startDate, performanceDateRangeEnd: endDate,
      source: 'automation', automationPolicyId: policy._id, automationRunId: runId,
    });

    conflictSet.add(entityKey); // this run's own new recommendation now counts as an open conflict for any later candidate targeting the same entity

    if (policy.mode === 'recommend' || !executable) {
      actionsTakenSoFar += 1;
      // eslint-disable-next-line no-await-in-loop
      await automationRunService.appendAction(runId, {
        ruleIndex: candidate.ruleIndex, operation: candidate.operation, target,
        targetEntityId: derivedChange.targetEntityId, targetEntityLabel: derivedChange.targetEntityLabel,
        matchedMetric: candidate.matchedMetric, matchedValue: candidate.matchedValue, threshold: candidate.threshold,
        status: 'recommended', recommendationId: recommendation._id,
      });
      continue; // eslint-disable-line no-continue
    }

    // mode === 'execute' and executable — drive through the EXACT SAME
    // mutation boundary a human's manual Approve click uses.
    actionsTakenSoFar += 1;
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await campaignOptimizationService.approveRecommendation({
        draftId: draft._id, recommendationId: recommendation._id, userId: policy.createdBy, projectId: policy.projectId,
      });
      // eslint-disable-next-line no-await-in-loop
      await AiCampaignOptimizationExecution.updateOne({ _id: result.execution._id }, { $set: { trigger: 'automation' } });
      // eslint-disable-next-line no-await-in-loop
      await automationRunService.appendAction(runId, {
        ruleIndex: candidate.ruleIndex, operation: candidate.operation, target,
        targetEntityId: derivedChange.targetEntityId, targetEntityLabel: derivedChange.targetEntityLabel,
        matchedMetric: candidate.matchedMetric, matchedValue: candidate.matchedValue, threshold: candidate.threshold,
        status: 'executed', recommendationId: recommendation._id, executionId: result.execution._id,
      });
    } catch (err) {
      const code = err instanceof CampaignOptimizationError ? err.code : 'GOOGLE_UNKNOWN';
      // eslint-disable-next-line no-await-in-loop
      await automationRunService.appendAction(runId, {
        ruleIndex: candidate.ruleIndex, operation: candidate.operation, target,
        targetEntityId: derivedChange.targetEntityId, targetEntityLabel: derivedChange.targetEntityLabel,
        matchedMetric: candidate.matchedMetric, matchedValue: candidate.matchedValue, threshold: candidate.threshold,
        status: 'failed', recommendationId: recommendation._id, errorCode: code, errorMessage: err.message,
      });
      LoggerUtil.error('automation_action_failed', err, { policyId: String(policy._id), runId: String(runId), operation: candidate.operation, code });
    }
  }

  const finalRun = await automationRunService.markCompleted(runId);
  LoggerUtil.info('automation_run_completed', { policyId: String(policy._id), runId: String(runId), status: finalRun?.status });
  return { status: finalRun?.status || 'completed' };
}

/** Reschedules a policy's next run and records the outcome — always called after runClaimedPolicy, success or failure, best-effort (never throws — a scheduling-persistence hiccup must not crash the tick for other policies). */
export async function rescheduleAfterRun(policyModel, policy, outcome) {
  try {
    await policyModel.updateOne(
      { _id: policy._id },
      { $set: { nextRunAt: computeNextRunAt(policy.schedule, new Date()), lastRunAt: new Date(), lastRunStatus: outcome.status } },
    );
  } catch (err) {
    LoggerUtil.error('automation_reschedule_failed', err, { policyId: String(policy._id) });
  }
}

export default { runClaimedPolicy, rescheduleAfterRun };
