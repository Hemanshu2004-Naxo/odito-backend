/**
 * opportunityDetector — Phase 7 (spec §9/§10/§28). Pure, deterministic,
 * synchronous — no network, no Claude, no Mongo. Takes the normalized
 * performance snapshot from performanceDataService.js and an OPTIONAL set
 * of explicitly-supplied business targets (spec §11 — never assumed, never
 * invented; comes from the request or stays unset), and returns candidate
 * opportunity objects shaped for AiCampaignOptimizationOpportunity.
 *
 * Every comparison is against the ACCOUNT/CAMPAIGN'S OWN observed baseline
 * (its own previous period, or its own average across its own keywords/ads)
 * or an explicitly-configured target — never a hardcoded universal
 * benchmark presented as fact (spec §10). `baseline` on every returned
 * opportunity records exactly what it was compared against, so the UI can
 * show "40% below this campaign's own 30-day average", never an unsourced
 * claim.
 *
 * LOW_IMPRESSION_SHARE (spec §9) is deliberately NOT implemented: the
 * existing Google Ads sync (googleAdsSyncService.js, unmodified by this
 * phase) does not capture impression-share metrics anywhere in the synced
 * collections. Fabricating one here would violate spec §6's "do not
 * fabricate metrics Google Ads does not provide."
 */

import {
  MIN_SPEND_FOR_ZERO_CONVERSION_FLAG, HIGH_CPA_MULTIPLIER, LOW_CTR_BELOW_AVERAGE_PERCENT,
  MIN_IMPRESSIONS_FOR_CTR_SIGNAL, MIN_CONVERSIONS_FOR_STRONG_PERFORMER, STRONG_PERFORMER_CPA_MULTIPLIER,
  MIN_SPEND_FOR_ENTITY_FLAG, MIN_CLICKS_FOR_MEANINGFUL_SIGNAL, CONFIDENCE_THRESHOLDS,
} from '../../constants/optimizationConfig.js';

const dateKey = (d) => new Date(d).toISOString().slice(0, 10);
const rangeKey = (start, end) => `${dateKey(start)}_${dateKey(end)}`;

/** Server-computed data-sufficiency signal (spec §28) — Claude may explain the evidence, but never decides this. */
export function computeConfidence(clicks) {
  const n = Number(clicks) || 0;
  if (n < CONFIDENCE_THRESHOLDS.insufficientDataMaxClicks) return 'insufficient_data';
  if (n < CONFIDENCE_THRESHOLDS.lowConfidenceMaxClicks) return 'low_confidence';
  if (n < CONFIDENCE_THRESHOLDS.moderateConfidenceMaxClicks) return 'moderate_confidence';
  return 'high_confidence';
}

function makeOpportunity({
  entityType, entityId, entityLabel, opportunityType, severity, metrics, baseline, message, dateRange, confidence,
}) {
  return {
    entityType, entityId, entityLabel, opportunityType, severity, confidence,
    metrics, baseline, message,
    dateRangeStart: dateRange.startDate,
    dateRangeEnd: dateRange.endDate,
    dateRangeKey: rangeKey(dateRange.startDate, dateRange.endDate),
  };
}

function campaignAverage(items, field) {
  const values = items.map((i) => i.metrics[field]).filter((v) => v != null);
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * @param {object} snapshot - performanceDataService.getFullPerformanceSnapshot's return value
 * @param {object} [targets] - { targetCPA, targetROAS, minCTR, maxCPA, minConversions } — explicitly supplied, never assumed (spec §11)
 * @returns {object[]} candidate opportunities, NOT yet persisted or deduplicated
 */
export function detectOpportunities(snapshot, targets = {}) {
  const opportunities = [];
  const { dateRange, campaign, keywords, ads, negativeKeywordCandidates } = snapshot;
  const campaignId = 'campaign';

  // ── Campaign-level ──────────────────────────────────────────────────
  if (campaign.hasCurrentData) {
    const m = campaign.current;
    const confidence = computeConfidence(m.clicks);

    if (m.cost >= MIN_SPEND_FOR_ZERO_CONVERSION_FLAG && m.conversions === 0) {
      opportunities.push(makeOpportunity({
        entityType: 'CAMPAIGN', entityId: campaignId, entityLabel: 'Campaign',
        opportunityType: 'HIGH_SPEND_NO_CONVERSIONS', severity: 'critical', confidence,
        metrics: { cost: m.cost, conversions: m.conversions, clicks: m.clicks },
        baseline: { minSpendThreshold: MIN_SPEND_FOR_ZERO_CONVERSION_FLAG },
        message: `This campaign spent ${m.cost.toFixed(2)} with zero conversions over the selected period.`,
        dateRange, confidence,
      }));
    }

    const cpaTarget = targets.targetCPA ?? targets.maxCPA ?? null;
    if (m.cpa != null) {
      if (cpaTarget != null && m.cpa > cpaTarget) {
        opportunities.push(makeOpportunity({
          entityType: 'CAMPAIGN', entityId: campaignId, entityLabel: 'Campaign',
          opportunityType: 'HIGH_CPA', severity: 'warning', confidence,
          metrics: { cpa: m.cpa, conversions: m.conversions },
          baseline: { targetCPA: cpaTarget, source: 'configured_target' },
          message: `Cost per conversion (${m.cpa.toFixed(2)}) is above the configured target (${cpaTarget.toFixed(2)}).`,
          dateRange, confidence,
        }));
      } else if (cpaTarget == null && campaign.previous?.cpa != null && m.cpa >= campaign.previous.cpa * HIGH_CPA_MULTIPLIER) {
        opportunities.push(makeOpportunity({
          entityType: 'CAMPAIGN', entityId: campaignId, entityLabel: 'Campaign',
          opportunityType: 'HIGH_CPA', severity: 'warning', confidence,
          metrics: { cpa: m.cpa, previousCpa: campaign.previous.cpa },
          baseline: { previousPeriodCpa: campaign.previous.cpa, source: 'previous_period' },
          message: `Cost per conversion (${m.cpa.toFixed(2)}) is up ${(((m.cpa - campaign.previous.cpa) / campaign.previous.cpa) * 100).toFixed(0)}% from the previous comparable period (${campaign.previous.cpa.toFixed(2)}).`,
          dateRange, confidence,
        }));
      }
    }

    if (m.ctr != null && m.impressions >= MIN_IMPRESSIONS_FOR_CTR_SIGNAL) {
      const minCtrTarget = targets.minCTR ?? null;
      if (minCtrTarget != null && m.ctr < minCtrTarget) {
        opportunities.push(makeOpportunity({
          entityType: 'CAMPAIGN', entityId: campaignId, entityLabel: 'Campaign',
          opportunityType: 'LOW_CTR', severity: 'info', confidence,
          metrics: { ctr: m.ctr, impressions: m.impressions },
          baseline: { minCTRTarget: minCtrTarget, source: 'configured_target' },
          message: `CTR (${m.ctr.toFixed(2)}%) is below the configured minimum (${minCtrTarget.toFixed(2)}%).`,
          dateRange, confidence,
        }));
      } else if (minCtrTarget == null && campaign.previous?.ctr != null) {
        const dropPercent = ((campaign.previous.ctr - m.ctr) / campaign.previous.ctr) * 100;
        if (dropPercent >= LOW_CTR_BELOW_AVERAGE_PERCENT) {
          opportunities.push(makeOpportunity({
            entityType: 'CAMPAIGN', entityId: campaignId, entityLabel: 'Campaign',
            opportunityType: 'LOW_CTR', severity: 'info', confidence,
            metrics: { ctr: m.ctr, previousCtr: campaign.previous.ctr },
            baseline: { previousPeriodCtr: campaign.previous.ctr, source: 'previous_period' },
            message: `CTR (${m.ctr.toFixed(2)}%) is down ${dropPercent.toFixed(0)}% from the previous comparable period (${campaign.previous.ctr.toFixed(2)}%).`,
            dateRange, confidence,
          }));
        }
      }
    }

    const minConversionsTarget = targets.minConversions ?? MIN_CONVERSIONS_FOR_STRONG_PERFORMER;
    if (m.conversions >= minConversionsTarget && m.cpa != null) {
      const efficientVsTarget = cpaTarget == null || m.cpa <= cpaTarget;
      const efficientVsPrevious = campaign.previous?.cpa == null || m.cpa <= campaign.previous.cpa * STRONG_PERFORMER_CPA_MULTIPLIER;
      if (efficientVsTarget && efficientVsPrevious) {
        opportunities.push(makeOpportunity({
          entityType: 'CAMPAIGN', entityId: campaignId, entityLabel: 'Campaign',
          opportunityType: 'STRONG_PERFORMER', severity: 'info', confidence,
          metrics: { conversions: m.conversions, cpa: m.cpa, roas: m.roas },
          baseline: cpaTarget != null ? { targetCPA: cpaTarget } : { previousPeriodCpa: campaign.previous?.cpa ?? null },
          message: `This campaign produced ${m.conversions} conversion${m.conversions === 1 ? '' : 's'} at an efficient cost per conversion (${m.cpa.toFixed(2)}).`,
          dateRange, confidence,
        }));
      }
    }
  }

  // ── Keyword-level ────────────────────────────────────────────────────
  const campaignAvgCtr = campaignAverage(keywords, 'ctr');
  const campaignAvgCpa = campaignAverage(keywords, 'cpa');
  for (const kw of keywords) {
    const m = kw.metrics;
    const confidence = computeConfidence(m.clicks);
    const entityLabel = `"${kw.text}" (${kw.matchType})`;

    if (m.cost >= MIN_SPEND_FOR_ENTITY_FLAG && m.conversions === 0 && m.clicks >= MIN_CLICKS_FOR_MEANINGFUL_SIGNAL) {
      opportunities.push(makeOpportunity({
        entityType: 'KEYWORD', entityId: kw.criterionId, entityLabel,
        opportunityType: 'WEAK_KEYWORD', severity: 'warning', confidence,
        // adGroupId/status are carried here (not just performance numbers)
        // because they are the trusted identity/current-state fields
        // recommendationValidator.js derives an executable PAUSE_KEYWORD
        // recommendation from — never taken from Claude's own text.
        metrics: { cost: m.cost, clicks: m.clicks, conversions: m.conversions, adGroupId: kw.adGroupId, status: kw.status },
        baseline: { minSpendThreshold: MIN_SPEND_FOR_ENTITY_FLAG },
        message: `Keyword ${entityLabel} spent ${m.cost.toFixed(2)} across ${m.clicks} clicks with zero conversions.`,
        dateRange, confidence,
      }));
    } else if (m.conversions >= MIN_CONVERSIONS_FOR_STRONG_PERFORMER && m.cpa != null && (campaignAvgCpa == null || m.cpa <= campaignAvgCpa)) {
      opportunities.push(makeOpportunity({
        entityType: 'KEYWORD', entityId: kw.criterionId, entityLabel,
        opportunityType: 'STRONG_KEYWORD', severity: 'info', confidence,
        metrics: { conversions: m.conversions, cpa: m.cpa, adGroupId: kw.adGroupId, status: kw.status },
        baseline: { campaignAverageCpa: campaignAvgCpa },
        message: `Keyword ${entityLabel} produced ${m.conversions} conversion${m.conversions === 1 ? '' : 's'} at or below this campaign's average cost per conversion.`,
        dateRange, confidence,
      }));
    }

    if (m.ctr != null && m.impressions >= MIN_IMPRESSIONS_FOR_CTR_SIGNAL && campaignAvgCtr != null) {
      const dropPercent = ((campaignAvgCtr - m.ctr) / campaignAvgCtr) * 100;
      if (dropPercent >= LOW_CTR_BELOW_AVERAGE_PERCENT) {
        opportunities.push(makeOpportunity({
          entityType: 'KEYWORD', entityId: kw.criterionId, entityLabel,
          opportunityType: 'LOW_CTR', severity: 'info', confidence,
          metrics: { ctr: m.ctr, impressions: m.impressions },
          baseline: { campaignAverageCtr: campaignAvgCtr },
          message: `Keyword ${entityLabel}'s CTR (${m.ctr.toFixed(2)}%) is ${dropPercent.toFixed(0)}% below this campaign's average (${campaignAvgCtr.toFixed(2)}%).`,
          dateRange, confidence,
        }));
      }
    }
  }

  // ── Ad-level (compared against sibling ads in the same ad group) ─────
  const byAdGroup = new Map();
  for (const ad of ads) {
    if (!byAdGroup.has(ad.adGroupId)) byAdGroup.set(ad.adGroupId, []);
    byAdGroup.get(ad.adGroupId).push(ad);
  }
  for (const [, siblings] of byAdGroup) {
    if (siblings.length < 2) continue; // nothing to compare against
    for (const ad of siblings) {
      const m = ad.metrics;
      if (m.cost < MIN_SPEND_FOR_ENTITY_FLAG || m.clicks < MIN_CLICKS_FOR_MEANINGFUL_SIGNAL || m.ctr == null) continue;
      const others = siblings.filter((s) => s.adId !== ad.adId);
      const siblingAvgCtr = campaignAverage(others, 'ctr');
      if (siblingAvgCtr == null) continue;
      const dropPercent = ((siblingAvgCtr - m.ctr) / siblingAvgCtr) * 100;
      if (dropPercent >= LOW_CTR_BELOW_AVERAGE_PERCENT) {
        opportunities.push(makeOpportunity({
          entityType: 'AD', entityId: ad.adId, entityLabel: ad.name || `Ad ${ad.adId}`,
          opportunityType: 'UNDERPERFORMING_AD', severity: 'info', confidence: computeConfidence(m.clicks),
          metrics: { ctr: m.ctr, cost: m.cost, adGroupId: ad.adGroupId, status: ad.status },
          baseline: { adGroupSiblingAverageCtr: siblingAvgCtr },
          message: `This ad's CTR (${m.ctr.toFixed(2)}%) is ${dropPercent.toFixed(0)}% below its ad group's other ads (${siblingAvgCtr.toFixed(2)}%).`,
          dateRange, confidence: computeConfidence(m.clicks),
        }));
      }
    }
  }

  // ── Negative keyword candidates ───────────────────────────────────────
  for (const cand of negativeKeywordCandidates) {
    if (cand.metrics.cost <= 0) continue;
    opportunities.push(makeOpportunity({
      entityType: 'SEARCH_TERM', entityId: `${cand.adGroupId}::${cand.searchTerm}`, entityLabel: `"${cand.searchTerm}"`,
      opportunityType: 'NEGATIVE_KEYWORD_CANDIDATE', severity: 'info', confidence: computeConfidence(cand.metrics.clicks),
      metrics: { cost: cand.metrics.cost, clicks: cand.metrics.clicks, conversions: cand.metrics.conversions },
      baseline: { source: 'existing_sync_heuristic' },
      message: `The search term "${cand.searchTerm}" spent ${cand.metrics.cost.toFixed(2)} without a matching converting pattern and is not yet excluded.`,
      dateRange, confidence: computeConfidence(cand.metrics.clicks),
    }));
  }

  return opportunities;
}

export default { detectOpportunities, computeConfidence };
