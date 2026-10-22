import GoogleAdsCampaign from '../modules/app_user/model/GoogleAdsCampaign.js';
import GoogleAdsCampaignMetrics from '../modules/app_user/model/GoogleAdsCampaignMetrics.js';
import GoogleAdsKeyword from '../modules/app_user/model/GoogleAdsKeyword.js';
import GoogleAdsOptimizationHistory from '../modules/app_user/model/GoogleAdsOptimizationHistory.js';
import GoogleAdsRecommendation from '../modules/app_user/model/GoogleAdsRecommendation.js';
import GoogleAdsAd from '../modules/app_user/model/GoogleAdsAd.js';
import GoogleAdsConversionAction from '../modules/app_user/model/GoogleAdsConversionAction.js';

/**
 * Google Ads Campaign Health Engine (Phase 6.4)
 *
 * Pure, server-side computation over already-synced MongoDB data — makes
 * zero Google API calls and is never computed in the frontend (per the
 * explicit "Do NOT calculate this in React" requirement). One composite
 * 0-100 score per campaign, built from up to 7 components; any component
 * whose source data doesn't exist yet is marked `available: false` and
 * excluded from the weighted average (with the remaining weights
 * renormalized), rather than silently substituting a fabricated number.
 *
 * Ad Strength was `available: false` unconditionally through Phase 6.4
 * (the Ad/AdGroupAd sync it depends on didn't exist yet). Phase 6.5 built
 * that sync (GoogleAdsAd.ad_strength) and the frontend integration audit's
 * Gap #3 needs a real account-wide Ad Strength average, so this component
 * now scores real data when it exists (scoreAdStrength below) - the
 * overall engine shape (composite score, per-component availability,
 * weight renormalization) is unchanged; only this one component's
 * previously-hardcoded placeholder was stale and is now correct.
 *
 * "Optimization Score" is account-level in the Google Ads API (there is no
 * per-campaign equivalent) - every campaign's health computation reuses the
 * same account-wide score. This is a deliberate, documented modeling
 * simplification, not a bug.
 *
 * Gap #3 (frontend integration audit) additions: computeCampaignHealthForIds
 * (the same per-campaign engine, scoped to a specific list of campaign_ids
 * instead of "every campaign in the account" - used by the paginated
 * Campaign List endpoint so it never computes health for campaigns outside
 * the current page) and computeAccountHealthSummary (the four account-wide
 * tiles - Budget Pacing / Quality Score Avg / Ad Strength / Conversion
 * Tracking - reusing scoreQuality/scoreAdStrength directly against the
 * account's full keyword/ad sets rather than averaging per-campaign
 * averages, which would double-weight small campaigns).
 */

const ROLLING_WINDOW_DAYS = 30;
const BUDGET_PACING_WINDOW_DAYS = 7;

// Nominal weights, sum to 1.0 - renormalized across whichever components
// are actually available for a given campaign.
const COMPONENT_WEIGHTS = {
  budget: 0.20,
  quality: 0.15,
  optimization: 0.15,
  ctr: 0.15,
  conversion: 0.20,
  adStrength: 0.10,
  recommendationCount: 0.05
};

function utcMidnight(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** Exported so callers surfacing a sub-component score standalone (e.g. the Campaign List's per-row "Budget Health") can label it with the same tiers the overall score uses, instead of a second threshold table. */
export function tierForScore(score) {
  if (score === null) return 'Unavailable';
  if (score >= 80) return 'Excellent';
  if (score >= 60) return 'Good';
  if (score >= 40) return 'Fair';
  return 'Poor';
}

/** Weighted average across only the available components, renormalizing weights so they still sum to 1. */
function computeOverallScore(components) {
  let weightedSum = 0;
  let weightTotal = 0;

  for (const [key, weight] of Object.entries(COMPONENT_WEIGHTS)) {
    const component = components[key];
    if (component?.available && typeof component.score === 'number') {
      weightedSum += component.score * weight;
      weightTotal += weight;
    }
  }

  if (weightTotal === 0) return null;
  return Math.round(weightedSum / weightTotal);
}

/**
 * Core utilization -> 0-100 score curve, extracted so both scoreBudget
 * (per-campaign, driven by recent daily spend rows) and
 * scoreBudgetUtilization (account-wide, driven by a pre-computed
 * utilization percentage from googleAdsBudgetService.getBudgetOverview)
 * share one formula instead of two copies of the same thresholds.
 */
function utilizationToScore(utilization) {
  if (utilization >= 0.7 && utilization <= 1.05) return 100;
  if (utilization > 1.05) {
    // Overspending relative to daily budget (Google caps actual spend at
    // ~2x budget on high-traffic days) - penalize proportionally past 1.05x.
    return clamp(100 - (utilization - 1.05) * 150, 0, 100);
  }
  // Underspending - unused budget headroom, penalize proportionally below 0.7x.
  return clamp((utilization / 0.7) * 100, 0, 100);
}

/**
 * Exported (unlike every other scoreX helper in this file) so
 * googleAdsBudgetService.js's "Campaign Budget Health" reuses the exact
 * same pacing-utilization formula instead of re-implementing it - Phase
 * 6.5's Budget Analytics section asks for the same concept Phase 6.4's
 * health engine already computes.
 */
export function scoreBudget(campaign, recentMetricsRows) {
  const budgetAmount = campaign.budget?.amount;
  if (!budgetAmount || budgetAmount <= 0 || !recentMetricsRows.length) {
    return { score: null, available: false, reason: 'No budget or spend data available' };
  }

  const totalRecentCost = recentMetricsRows.reduce((sum, row) => sum + (row.cost || 0), 0);
  const avgDailySpend = totalRecentCost / recentMetricsRows.length;
  const utilization = avgDailySpend / budgetAmount;

  return {
    score: Math.round(utilizationToScore(utilization)),
    available: true,
    avgDailySpend: Math.round(avgDailySpend * 100) / 100,
    budgetAmount,
    utilization: Math.round(utilization * 1000) / 1000
  };
}

/**
 * Account-wide equivalent of scoreBudget, for the Campaign Health Summary's
 * "Budget Pacing" tile (Gap #3) and Budget Overview's "Budget Health"
 * field (Gap #5) - takes an already-computed utilization PERCENTAGE
 * (0-100+, e.g. from googleAdsBudgetService.getBudgetOverview) rather than
 * raw campaign+metrics rows, since the caller composes this from data that
 * already exists at the account level. Reuses the exact same
 * utilizationToScore curve as the per-campaign version - no second scoring
 * formula.
 */
export function scoreBudgetUtilization(utilizationPct) {
  if (typeof utilizationPct !== 'number' || Number.isNaN(utilizationPct)) {
    return { score: null, available: false, reason: 'No budget data available' };
  }
  const utilization = utilizationPct / 100;
  return { score: Math.round(utilizationToScore(utilization)), available: true, utilizationPct };
}

function scoreQuality(keywordRows) {
  const scored = keywordRows.filter((k) => typeof k.quality_score === 'number');
  if (!scored.length) {
    return { score: null, available: false, reason: 'No keyword quality scores synced for this campaign' };
  }

  const avg = scored.reduce((sum, k) => sum + k.quality_score, 0) / scored.length;
  return { score: Math.round((avg / 10) * 100), available: true, avgQualityScore: Math.round(avg * 10) / 10, keywordCount: scored.length };
}

function scoreOptimization(optimizationRow) {
  if (!optimizationRow || typeof optimizationRow.optimization_score_percent !== 'number') {
    return { score: null, available: false, reason: 'No optimization score synced yet' };
  }
  return { score: Math.round(optimizationRow.optimization_score_percent), available: true, accountWide: true };
}

function scoreCtr(metricsAggregate) {
  if (!metricsAggregate || metricsAggregate.clicks === 0 && metricsAggregate.impressions === 0) {
    return { score: null, available: false, reason: 'No impression data for the rolling window' };
  }
  const ctr = metricsAggregate.ctr || 0;
  const score = clamp((ctr / 5) * 100, 0, 100); // 5% CTR treated as "excellent" ceiling
  return { score: Math.round(score), available: true, ctr: Math.round(ctr * 100) / 100 };
}

function scoreConversion(metricsAggregate) {
  if (!metricsAggregate || metricsAggregate.clicks === 0) {
    return { score: null, available: false, reason: 'No clicks in the rolling window' };
  }
  const conversionRate = metricsAggregate.conversionRate || 0;
  const score = clamp((conversionRate / 5) * 100, 0, 100); // 5% conversion rate treated as "excellent" ceiling
  return { score: Math.round(score), available: true, conversionRate: Math.round(conversionRate * 100) / 100 };
}

function scoreRecommendationCount(openCount) {
  const score = clamp(100 - openCount * 20, 0, 100);
  return { score: Math.round(score), available: true, openCount };
}

// Maps GoogleAdsAd.ad_strength (Phase 6.5's AdStrength enum) onto the same
// 0-100 scale every other health component uses. PENDING/NO_ADS/UNKNOWN/
// UNSPECIFIED are deliberately excluded (not a real quality signal yet),
// same "don't fabricate a number from non-data" rule as every other
// component in this file.
const AD_STRENGTH_NUMERIC = { POOR: 25, AVERAGE: 50, GOOD: 75, EXCELLENT: 100 };

/** Shared by both the per-campaign engine (adRows scoped to one campaign) and the account summary (adRows = every ad in the account). */
function scoreAdStrength(adRows) {
  const scored = adRows.filter((a) => AD_STRENGTH_NUMERIC[a.ad_strength] !== undefined);
  if (!scored.length) {
    return { score: null, available: false, reason: 'No ads with a computed Ad Strength score synced yet' };
  }
  const avg = scored.reduce((sum, a) => sum + AD_STRENGTH_NUMERIC[a.ad_strength], 0) / scored.length;
  return { score: Math.round(avg), available: true, adCount: scored.length };
}

/**
 * Account-wide only (conversion actions aren't campaign-scoped in this
 * schema - see GoogleAdsConversionAction.js). Scores the fraction of
 * enabled conversion actions that are actually receiving conversions
 * (click-attributed or view-through) - "configured but silent" tracking
 * pulls the score down same as "not configured at all" pulls it to null.
 */
function scoreConversionTracking(conversionActions) {
  const active = conversionActions.filter((c) => c.status === 'ENABLED');
  if (!active.length) {
    return { score: null, available: false, reason: 'No active conversion actions configured' };
  }
  const withData = active.filter((c) => (c.metrics?.conversions || 0) + (c.metrics?.view_through_conversions || 0) > 0);
  return { score: Math.round((withData.length / active.length) * 100), available: true, activeCount: active.length, trackingCount: withData.length };
}

/**
 * Computes one composite health score for a single campaign, given
 * pre-fetched supporting data (so computeAllCampaignHealth can batch-fetch
 * once instead of N+1 querying per campaign).
 */
function buildCampaignHealth(campaign, { recentMetricsRows, rollingAggregate, keywordRows, optimizationRow, openRecommendationCount, adRows = [] }) {
  const components = {
    budget: scoreBudget(campaign, recentMetricsRows),
    quality: scoreQuality(keywordRows),
    optimization: scoreOptimization(optimizationRow),
    ctr: scoreCtr(rollingAggregate),
    conversion: scoreConversion(rollingAggregate),
    adStrength: scoreAdStrength(adRows),
    recommendationCount: scoreRecommendationCount(openRecommendationCount)
  };

  const healthScore = computeOverallScore(components);

  return {
    campaignId: campaign.campaign_id,
    campaignName: campaign.name,
    status: campaign.status,
    healthScore,
    tier: tierForScore(healthScore),
    components
  };
}

/**
 * Shared batch-fetch-once-then-loop-metrics-per-campaign core, extracted
 * from the original computeAllCampaignHealth so both "every campaign in
 * the account" and "just these specific campaign_ids" (Gap #2's paginated
 * Campaign List) go through the exact same logic - one function, two entry
 * points below, instead of a second copy of the batching.
 */
async function computeHealthForCampaignList(projectId, customerId, campaigns) {
  if (!campaigns.length) return [];

  const today = utcMidnight(new Date());
  const rollingStart = new Date(today);
  rollingStart.setUTCDate(rollingStart.getUTCDate() - (ROLLING_WINDOW_DAYS - 1));
  const budgetWindowStart = new Date(today);
  budgetWindowStart.setUTCDate(budgetWindowStart.getUTCDate() - (BUDGET_PACING_WINDOW_DAYS - 1));

  const campaignIds = campaigns.map((c) => c.campaign_id);

  const [keywords, optimizationRow, openRecommendations, ads] = await Promise.all([
    GoogleAdsKeyword.find({ project_id: projectId, google_ads_customer_id: customerId, campaign_id: { $in: campaignIds }, is_removed: false }, { campaign_id: 1, quality_score: 1 }).lean(),
    GoogleAdsOptimizationHistory.getLatest(projectId, customerId),
    GoogleAdsRecommendation.find({ project_id: projectId, google_ads_customer_id: customerId, campaign_id: { $in: campaignIds }, is_resolved: false, status: 'pending' }, { campaign_id: 1 }).lean(),
    GoogleAdsAd.find({ project_id: projectId, google_ads_customer_id: customerId, campaign_id: { $in: campaignIds }, is_removed: false }, { campaign_id: 1, ad_strength: 1 }).lean()
  ]);

  const keywordsByCampaign = new Map();
  for (const k of keywords) {
    if (!keywordsByCampaign.has(k.campaign_id)) keywordsByCampaign.set(k.campaign_id, []);
    keywordsByCampaign.get(k.campaign_id).push(k);
  }

  const adsByCampaign = new Map();
  for (const a of ads) {
    if (!adsByCampaign.has(a.campaign_id)) adsByCampaign.set(a.campaign_id, []);
    adsByCampaign.get(a.campaign_id).push(a);
  }

  const recommendationCountByCampaign = new Map();
  for (const r of openRecommendations) {
    if (!r.campaign_id) continue; // account-wide recommendations aren't attributable to one campaign
    recommendationCountByCampaign.set(r.campaign_id, (recommendationCountByCampaign.get(r.campaign_id) || 0) + 1);
  }

  const results = [];
  for (const campaign of campaigns) {
    // Per-campaign metrics queries remain a loop - each campaign needs its
    // own date-scoped aggregation, which can't be batched into the single
    // Promise.all above the way the other four sources were.
    const [recentMetricsRows, rollingAggregate] = await Promise.all([
      GoogleAdsCampaignMetrics.getCampaignSeries(projectId, campaign.campaign_id, budgetWindowStart, today),
      GoogleAdsCampaignMetrics.getCampaignAggregate(projectId, campaign.campaign_id, rollingStart, today)
    ]);

    results.push(buildCampaignHealth(campaign, {
      recentMetricsRows,
      rollingAggregate,
      keywordRows: keywordsByCampaign.get(campaign.campaign_id) || [],
      adRows: adsByCampaign.get(campaign.campaign_id) || [],
      optimizationRow,
      openRecommendationCount: recommendationCountByCampaign.get(campaign.campaign_id) || 0
    }));
  }

  return results;
}

/** Health score for every active campaign in the account. */
export async function computeAllCampaignHealth(projectId, customerId) {
  const campaigns = await GoogleAdsCampaign.find({ project_id: projectId, google_ads_customer_id: customerId, is_removed: false }).lean();
  return computeHealthForCampaignList(projectId, customerId, campaigns);
}

/**
 * Health score for a specific, bounded list of campaign_ids - used by the
 * paginated Campaign List endpoint (Gap #2) so a request for page 2 of 25
 * campaigns never computes health for the other 475 in a large account.
 */
export async function computeCampaignHealthForIds(projectId, customerId, campaignIds) {
  if (!campaignIds.length) return [];
  const campaigns = await GoogleAdsCampaign.find({ project_id: projectId, google_ads_customer_id: customerId, campaign_id: { $in: campaignIds } }).lean();
  return computeHealthForCampaignList(projectId, customerId, campaigns);
}

/** Health score for one specific campaign - used by the campaign detail view. */
export async function computeCampaignHealth(projectId, customerId, campaignId) {
  const campaign = await GoogleAdsCampaign.getByCampaignId(projectId, customerId, campaignId);
  if (!campaign) return null;

  const today = utcMidnight(new Date());
  const rollingStart = new Date(today);
  rollingStart.setUTCDate(rollingStart.getUTCDate() - (ROLLING_WINDOW_DAYS - 1));
  const budgetWindowStart = new Date(today);
  budgetWindowStart.setUTCDate(budgetWindowStart.getUTCDate() - (BUDGET_PACING_WINDOW_DAYS - 1));

  const [recentMetricsRows, rollingAggregate, keywordRows, adRows, optimizationRow, openRecommendationCount] = await Promise.all([
    GoogleAdsCampaignMetrics.getCampaignSeries(projectId, campaignId, budgetWindowStart, today),
    GoogleAdsCampaignMetrics.getCampaignAggregate(projectId, campaignId, rollingStart, today),
    GoogleAdsKeyword.find({ project_id: projectId, google_ads_customer_id: customerId, campaign_id: campaignId, is_removed: false }, { quality_score: 1 }).lean(),
    GoogleAdsAd.find({ project_id: projectId, google_ads_customer_id: customerId, campaign_id: campaignId, is_removed: false }, { ad_strength: 1 }).lean(),
    GoogleAdsOptimizationHistory.getLatest(projectId, customerId),
    GoogleAdsRecommendation.countDocuments({ project_id: projectId, google_ads_customer_id: customerId, campaign_id: campaignId, is_resolved: false, status: 'pending' })
  ]);

  return buildCampaignHealth(campaign, { recentMetricsRows, rollingAggregate, keywordRows, adRows, optimizationRow, openRecommendationCount });
}

/**
 * Gap #3 - the four account-wide tiles the existing Campaign Health Grid
 * widget already renders (Budget Pacing / Quality Score Avg / Ad Strength /
 * Conversion Tracking), computed directly from account-wide data rather
 * than averaging computeAllCampaignHealth's per-campaign components (which
 * would equal-weight small and large campaigns the same way "7.4/10
 * weighted average" implies it should NOT). Does not replace or duplicate
 * the per-campaign engine above - scoreQuality/scoreAdStrength are the
 * SAME functions the per-campaign engine uses, just given the account's
 * full keyword/ad sets instead of one campaign's subset.
 *
 * `budgetHealth` (`{ score, available }`) is injected by the caller -
 * specifically googleAdsBudgetService.getBudgetOverview's own
 * `budgetHealth` field (Gap #5), which already scores MTD spend against
 * what's EXPECTED at this point in the month (not raw MTD%, which would
 * misreport day 3 of a 30-day month as "underspending" even at perfect
 * pace - see that function's own doc comment). Reusing its output here
 * - rather than this file recomputing a second, cruder version from a raw
 * percentage - is what keeps "Budget Pacing" on this widget and
 * "Budget Health" on the Budget Overview endpoint always in agreement.
 * This file does not import googleAdsBudgetService directly because that
 * service already imports scoreBudget/scoreBudgetUtilization FROM this
 * file - a reverse import would be circular. The controller, which
 * already needs both services for other endpoints, composes them.
 */
export async function computeAccountHealthSummary(projectId, customerId, { budgetHealth = null } = {}) {
  const [allKeywords, allAds, conversionActions] = await Promise.all([
    GoogleAdsKeyword.find({ project_id: projectId, google_ads_customer_id: customerId, is_removed: false }, { quality_score: 1 }).lean(),
    GoogleAdsAd.find({ project_id: projectId, google_ads_customer_id: customerId, is_removed: false }, { ad_strength: 1 }).lean(),
    GoogleAdsConversionAction.find({ project_id: projectId, google_ads_customer_id: customerId, is_removed: false }, { status: 1, metrics: 1 }).lean()
  ]);

  const budget = budgetHealth || { score: null, available: false };
  const quality = scoreQuality(allKeywords);
  const adStrength = scoreAdStrength(allAds);
  const tracking = scoreConversionTracking(conversionActions);

  return [
    {
      key: 'pacing',
      score: budget.available ? budget.score : null,
      title: 'Budget Pacing',
      subtitle: budget.available ? tierForScore(budget.score) + ' pacing across active campaigns' : 'No budget data available yet'
    },
    {
      key: 'quality',
      score: quality.available ? quality.score : null,
      title: 'Quality Score Avg',
      subtitle: quality.available ? `${quality.avgQualityScore}/10 weighted average` : 'No keyword quality scores synced yet'
    },
    {
      key: 'adStrength',
      score: adStrength.available ? adStrength.score : null,
      title: 'Ad Strength',
      subtitle: adStrength.available ? `Averaged across ${adStrength.adCount} ad${adStrength.adCount === 1 ? '' : 's'}` : 'No ads with a computed Ad Strength score synced yet'
    },
    {
      key: 'tracking',
      score: tracking.available ? tracking.score : null,
      title: 'Conversion Tracking',
      subtitle: tracking.available ? `${tracking.trackingCount}/${tracking.activeCount} active conversion actions verified` : 'No conversion actions configured yet'
    }
  ];
}

export default {
  computeAllCampaignHealth,
  computeCampaignHealthForIds,
  computeCampaignHealth,
  computeAccountHealthSummary,
  scoreBudget,
  scoreBudgetUtilization,
  tierForScore,
  clamp
};
