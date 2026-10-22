/**
 * automationRuleEngine — Phase 8. Pure, deterministic, synchronous — no
 * network, no Mongo, no Claude (mirrors opportunityDetector.js's own
 * purity discipline exactly). Takes a policy's structured `rules[]` and the
 * SAME normalized performance snapshot shape performanceDataService.js
 * produces for Phase 7, and returns candidate actions: which entity, which
 * operation, and the raw metric/threshold that matched — nothing here
 * decides whether an action is actually allowed to run (guardrails,
 * limits, cooldowns, conflicts — see automationGuardrails.js — are a
 * separate, later step).
 *
 * Each candidate carries an `opportunitySeed` shaped EXACTLY like the
 * opportunity objects opportunityDetector.js produces (same entityType/
 * entityId/entityLabel/metrics conventions), so automationOrchestrator.js
 * can hand it straight to recommendationValidator's exported
 * `buildProposedChangeForOperation` — the same trusted-field derivation
 * Phase 7 uses for a Claude-drafted recommendation — rather than
 * reimplementing it.
 */

import { RULE_MATCH_ENTITY_TYPE, evaluateOperator } from '../../constants/automationEnums.js';

// A pause action only makes sense against a currently-enabled entity; an
// enable action only against a currently-paused one. Filtering here avoids
// wasting an action-limit slot on a no-op the executor would just report as
// "already in desired state" anyway.
const STATUS_PRECONDITION = Object.freeze({
  PAUSE_KEYWORD: 'ENABLED',
  ENABLE_KEYWORD: 'PAUSED',
  PAUSE_AD: 'ENABLED',
  ENABLE_AD: 'PAUSED',
});

function buildEntitySeeds(entityType, snapshot) {
  switch (entityType) {
    case 'CAMPAIGN':
      if (!snapshot.campaign?.hasCurrentData) return [];
      return [{
        entityType: 'CAMPAIGN', entityId: 'campaign', entityLabel: 'Campaign',
        metrics: snapshot.campaign.current, clicks: snapshot.campaign.current.clicks || 0, status: null,
      }];
    case 'KEYWORD':
      return (snapshot.keywords || []).map((kw) => ({
        entityType: 'KEYWORD', entityId: kw.criterionId, entityLabel: `"${kw.text}" (${kw.matchType})`,
        metrics: { ...kw.metrics, adGroupId: kw.adGroupId, status: kw.status },
        clicks: kw.metrics?.clicks || 0, status: kw.status,
      }));
    case 'AD':
      return (snapshot.ads || []).map((ad) => ({
        entityType: 'AD', entityId: ad.adId, entityLabel: ad.name || `Ad ${ad.adId}`,
        metrics: { ...ad.metrics, adGroupId: ad.adGroupId, status: ad.status },
        clicks: ad.metrics?.clicks || 0, status: ad.status,
      }));
    case 'SEARCH_TERM':
      return (snapshot.negativeKeywordCandidates || []).map((cand) => ({
        entityType: 'SEARCH_TERM', entityId: `${cand.adGroupId}::${cand.searchTerm}`, entityLabel: `"${cand.searchTerm}"`,
        metrics: cand.metrics, clicks: cand.metrics?.clicks || 0, status: null,
      }));
    default:
      return [];
  }
}

/**
 * @param {object} args
 * @param {object[]} args.rules - policy.rules (plain objects: {operation, metric, operator, threshold, minimumClicks, priority})
 * @param {object} args.snapshot - performanceDataService.getFullPerformanceSnapshot's return value
 * @returns {object[]} candidate actions, priority-then-rule-order sorted, NOT yet guardrail-checked
 */
export function evaluateRules({ rules, snapshot }) {
  const candidates = [];

  (rules || []).forEach((rule, ruleIndex) => {
    const entityType = RULE_MATCH_ENTITY_TYPE[rule.operation];
    if (!entityType) return; // unknown operation — defensively skip, never throw mid-scan

    for (const seed of buildEntitySeeds(entityType, snapshot)) {
      const requiredStatus = STATUS_PRECONDITION[rule.operation];
      if (requiredStatus && seed.status !== requiredStatus) continue;

      const value = seed.metrics[rule.metric];
      if (!evaluateOperator(rule.operator, value, rule.threshold)) continue;

      candidates.push({
        ruleIndex,
        priority: Number.isFinite(rule.priority) ? rule.priority : 0,
        operation: rule.operation,
        minimumClicks: rule.minimumClicks,
        clicks: seed.clicks,
        matchedMetric: rule.metric,
        matchedValue: value,
        operator: rule.operator,
        threshold: rule.threshold,
        opportunitySeed: {
          entityType: seed.entityType, entityId: seed.entityId, entityLabel: seed.entityLabel, metrics: seed.metrics,
        },
      });
    }
  });

  return candidates.sort((a, b) => a.priority - b.priority || a.ruleIndex - b.ruleIndex);
}

export default { evaluateRules };
