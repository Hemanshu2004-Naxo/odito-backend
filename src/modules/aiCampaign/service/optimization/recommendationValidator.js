/**
 * recommendationValidator — Phase 7 (spec §16/§18 Layer 1, §24/§26).
 *
 * Turns Claude's raw, untrusted `{recommendations: [...]}` tool output into
 * validated AiCampaignOptimizationRecommendation-shaped objects, or drops a
 * malformed entry entirely (never partially trusts one). EVERY trusted
 * field — target entity id/label, current value, proposed change, risk —
 * is derived here from the SERVER's own already-persisted opportunities,
 * never from Claude's text (spec §16). Claude's only surviving contribution
 * per recommendation is `reason`/`expectedImpact` (prose) and its choice of
 * `operation` (validated against the closed vocabulary) and which
 * opportunities it responds to.
 *
 * This is Layer 1 only — target EXISTENCE/shape validation. Layer 2 (spec
 * §18 — "is the live Google Ads state still what this recommendation
 * assumed") happens later, at approval time, in campaignOptimizationService.js.
 */

import {
  OPTIMIZATION_OPERATIONS, OPERATION_TARGET, OPERATION_RISK, isOptimizationOperationAllowed,
} from '../../constants/optimizationEnums.js';
import { MAX_RECOMMENDATIONS_PER_GENERATION, DEFAULT_BUDGET_INCREASE_PERCENT } from '../../constants/optimizationConfig.js';

const CONFIDENCE_RANK = { insufficient_data: 0, low_confidence: 1, moderate_confidence: 2, high_confidence: 3 };

/** The weakest confidence among the referenced opportunities — never let a low-confidence opportunity hide behind a high-confidence one it's bundled with. */
function weakestConfidence(opportunities) {
  return opportunities.reduce((weakest, o) => (CONFIDENCE_RANK[o.confidence] < CONFIDENCE_RANK[weakest] ? o.confidence : weakest), 'high_confidence');
}

// Guarantee-language Claude must never use for expected impact (spec §26).
const GUARANTEE_LANGUAGE = /\b(guarantee[sd]?|will\s+(?:increase|improve|reduce|boost|fix)|definitely\s+will|100%\s+(?:certain|sure))\b/i;

// Exported additively for Phase 8 (automationOrchestrator.js): an
// automation rule already knows its own `operation` (it's part of the
// rule, not inferred by Claude), so it reuses this SAME trusted-field
// derivation directly instead of re-implementing it — zero logic
// duplication, and any future change to how a trusted field is computed
// only ever needs to happen here.
export function buildProposedChangeForOperation(operation, opportunity, { campaign }) {
  switch (operation) {
    case 'PAUSE_KEYWORD':
      return {
        targetEntityId: opportunity.entityId,
        targetEntityLabel: opportunity.entityLabel,
        expectedCurrentValue: opportunity.metrics?.status ?? 'ENABLED',
        proposedChange: { field: 'status', before: opportunity.metrics?.status ?? 'ENABLED', after: 'PAUSED' },
        adGroupId: opportunity.metrics?.adGroupId ?? null,
      };
    case 'ENABLE_KEYWORD':
      return {
        targetEntityId: opportunity.entityId,
        targetEntityLabel: opportunity.entityLabel,
        expectedCurrentValue: opportunity.metrics?.status ?? 'PAUSED',
        proposedChange: { field: 'status', before: opportunity.metrics?.status ?? 'PAUSED', after: 'ENABLED' },
        adGroupId: opportunity.metrics?.adGroupId ?? null,
      };
    case 'PAUSE_AD':
      return {
        targetEntityId: opportunity.entityId,
        targetEntityLabel: opportunity.entityLabel,
        expectedCurrentValue: opportunity.metrics?.status ?? 'ENABLED',
        proposedChange: { field: 'status', before: opportunity.metrics?.status ?? 'ENABLED', after: 'PAUSED' },
        adGroupId: opportunity.metrics?.adGroupId ?? null,
      };
    case 'ENABLE_AD':
      return {
        targetEntityId: opportunity.entityId,
        targetEntityLabel: opportunity.entityLabel,
        expectedCurrentValue: opportunity.metrics?.status ?? 'PAUSED',
        proposedChange: { field: 'status', before: opportunity.metrics?.status ?? 'PAUSED', after: 'ENABLED' },
        adGroupId: opportunity.metrics?.adGroupId ?? null,
      };
    case 'ADD_NEGATIVE_KEYWORD': {
      // opportunity.entityId for NEGATIVE_KEYWORD_CANDIDATE is "adGroupId::searchTerm" (see opportunityDetector.js)
      const [adGroupId, ...rest] = String(opportunity.entityId).split('::');
      const searchTerm = rest.join('::');
      return {
        targetEntityId: adGroupId,
        targetEntityLabel: opportunity.entityLabel,
        expectedCurrentValue: null,
        proposedChange: { field: 'negativeKeyword', before: null, after: { text: searchTerm, matchType: 'BROAD' } },
        negativeKeywordText: searchTerm,
        negativeKeywordMatchType: 'BROAD',
        adGroupId,
      };
    }
    case 'UPDATE_CAMPAIGN_BUDGET': {
      const currentMicros = campaign?.dailyBudgetMicros ?? null;
      if (!Number.isFinite(currentMicros) || currentMicros <= 0) return null; // no safe boundary to compute from — reject rather than guess (spec §24)
      const proposedMicros = Math.round(currentMicros * (1 + DEFAULT_BUDGET_INCREASE_PERCENT / 100));
      return {
        targetEntityId: campaign.campaignResourceId,
        targetEntityLabel: 'Campaign budget',
        expectedCurrentValue: currentMicros,
        proposedChange: { field: 'dailyBudgetMicros', before: currentMicros, after: proposedMicros },
        adGroupId: null,
      };
    }
    default:
      return null;
  }
}

/**
 * @param {object} args
 * @param {object[]} args.rawRecommendations - Claude's tool output `recommendations` array
 * @param {object[]} args.opportunities - the SAME ordered array sent to Claude, each a plain persisted-opportunity object (with `_id`)
 * @param {object} args.campaign - { campaignResourceId, dailyBudgetMicros, currency, dateRangeStart, dateRangeEnd }
 * @returns {{ recommendations: object[], rejectedCount: number }}
 */
export function validateAndBuildRecommendations({ rawRecommendations, opportunities, campaign }) {
  if (!Array.isArray(rawRecommendations)) return { recommendations: [], rejectedCount: 0 };

  const built = [];
  let rejectedCount = 0;
  const seenEntities = new Set(); // one recommendation per entity per generation (spec §9's "propose at most one recommendation per entity")

  for (const raw of rawRecommendations.slice(0, MAX_RECOMMENDATIONS_PER_GENERATION * 3)) { // generous slack before the real cap below, so a noisy response can't cause unbounded work
    if (built.length >= MAX_RECOMMENDATIONS_PER_GENERATION) break;

    const indexes = Array.isArray(raw?.opportunityIndexes) ? raw.opportunityIndexes : null;
    if (!indexes || indexes.length === 0) { rejectedCount += 1; continue; }
    if (!indexes.every((i) => Number.isInteger(i) && i >= 0 && i < opportunities.length)) { rejectedCount += 1; continue; }

    const operation = raw.operation;
    if (!OPTIMIZATION_OPERATIONS.includes(operation)) { rejectedCount += 1; continue; }
    const target = OPERATION_TARGET[operation];
    if (!isOptimizationOperationAllowed(operation, target)) { rejectedCount += 1; continue; }

    const refs = indexes.map((i) => opportunities[i]);
    const primary = refs[0];
    // All referenced opportunities must be about the SAME entity — Claude
    // bundling unrelated entities under one action is rejected outright.
    if (!refs.every((o) => o.entityId === primary.entityId && o.entityType === primary.entityType)) {
      rejectedCount += 1; continue;
    }

    // The opportunity's own entityType must be the kind this operation
    // actually addresses (target===AD_GROUP for ADD_NEGATIVE_KEYWORD is the
    // one deliberate exception — its opportunity is SEARCH_TERM-scoped).
    const expectedOpportunityEntityType = operation === 'ADD_NEGATIVE_KEYWORD' ? 'SEARCH_TERM' : target;
    if (primary.entityType !== expectedOpportunityEntityType) { rejectedCount += 1; continue; }

    const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
    const expectedImpact = typeof raw.expectedImpact === 'string' ? raw.expectedImpact.trim() : '';
    if (!reason || !expectedImpact) { rejectedCount += 1; continue; }
    if (GUARANTEE_LANGUAGE.test(reason) || GUARANTEE_LANGUAGE.test(expectedImpact)) { rejectedCount += 1; continue; }

    const derived = buildProposedChangeForOperation(operation, primary, { campaign });
    if (!derived) { rejectedCount += 1; continue; }

    const entityKey = `${target}:${derived.targetEntityId}`;
    if (seenEntities.has(entityKey)) { rejectedCount += 1; continue; }
    seenEntities.add(entityKey);

    built.push({
      opportunityIds: refs.map((o) => o._id),
      operation,
      target,
      targetEntityId: derived.targetEntityId,
      targetEntityLabel: derived.targetEntityLabel,
      negativeKeywordText: derived.negativeKeywordText || null,
      negativeKeywordMatchType: derived.negativeKeywordMatchType || null,
      proposedChange: derived.proposedChange,
      expectedCurrentValue: derived.expectedCurrentValue,
      reason: reason.slice(0, 1000),
      expectedImpact: expectedImpact.slice(0, 500),
      confidence: weakestConfidence(refs),
      risk: OPERATION_RISK[operation],
      supportingMetrics: primary.metrics || {},
      // A budget change is the one operation with real financial exposure
      // beyond the reversible pause/enable/negative-keyword actions (spec
      // §24/§28) — even though the proposed amount is always
      // server-capped (never Claude-decided, see buildProposedChangeForOperation
      // above), executing one automatically off THIN data is still risky.
      // Everything else stays executable regardless of confidence — a
      // pause/enable/negative-keyword action is trivially reversible.
      executable: operation === 'UPDATE_CAMPAIGN_BUDGET' ? CONFIDENCE_RANK[weakestConfidence(refs)] >= CONFIDENCE_RANK.moderate_confidence : true,
      performanceDateRangeStart: campaign.dateRangeStart,
      performanceDateRangeEnd: campaign.dateRangeEnd,
    });
  }

  return { recommendations: built, rejectedCount };
}

export default { validateAndBuildRecommendations, buildProposedChangeForOperation };
