/**
 * performanceDataService — Phase 7 (spec §5-§8).
 *
 * Reads Google Ads performance for exactly ONE published campaign, scoped
 * by the trusted association `AiCampaignDraft.googleAdsCustomerId` +
 * `AiCampaignDraft.googleAdsCampaignId` (spec §49 — never an arbitrary
 * client-supplied Google campaign id). Reuses the EXISTING, already-synced
 * Google Ads reporting collections (`GoogleAdsCampaignMetrics`,
 * `GoogleAdsKeyword`, `GoogleAdsAd`, `GoogleAdsSearchTerm` — populated by
 * the pre-existing `googleAdsSyncService.js`, itself untouched by this
 * phase) instead of a second live Google Ads read path. This is a
 * deliberate reuse decision (spec §3/§39): campaign-level metrics are
 * genuinely date-range-queryable from Mongo already; keyword/ad/search-term
 * data is a rolling snapshot of whatever window the last sync covered —
 * Phase 7 surfaces that snapshot as-is (clearly dated, never silently
 * presented as "live" or as covering an arbitrary custom range) rather
 * than adding a second, redundant live-GAQL-per-entity read path Google
 * Ads sync already solves.
 *
 * If the account has never been synced, every function here returns an
 * explicit "no data" shape (never throws) — the caller
 * (campaignOptimizationService) turns that into a safe
 * PERFORMANCE_UNAVAILABLE response telling the user to sync their Google
 * Ads dashboard first, rather than Phase 7 silently building a duplicate
 * sync mechanism.
 *
 * NORMALIZATION (spec §6): every rate metric is recomputed here from raw
 * counts, never trusted from a collection's own precomputed field, and is
 * `null` — never `0` — whenever its denominator is zero. `0` is only ever
 * returned when the metric is genuinely zero (e.g. a keyword with
 * impressions but no clicks has a real 0% CTR).
 */

import GoogleAdsCampaignMetrics from '../../../app_user/model/GoogleAdsCampaignMetrics.js';
import GoogleAdsKeyword from '../../../app_user/model/GoogleAdsKeyword.js';
import GoogleAdsAd from '../../../app_user/model/GoogleAdsAd.js';
import GoogleAdsSearchTerm from '../../../app_user/model/GoogleAdsSearchTerm.js';

/** Recompute every rate metric from raw counts — null (never 0) when the denominator is zero. */
export function deriveRates({ impressions = 0, clicks = 0, cost = 0, conversions = 0, conversionsValue = 0 }) {
  return {
    ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
    avgCpc: clicks > 0 ? cost / clicks : null,
    conversionRate: clicks > 0 ? (conversions / clicks) * 100 : null,
    cpa: conversions > 0 ? cost / conversions : null, // cost-per-conversion / "CPA"
    roas: cost > 0 ? conversionsValue / cost : null,
  };
}

/** Wrap a raw {impressions,clicks,cost,conversions,conversionsValue} totals object into the full normalized metrics shape. */
function normalizeMetrics(totals) {
  const impressions = totals.impressions || 0;
  const clicks = totals.clicks || 0;
  const cost = totals.cost || 0;
  const conversions = totals.conversions || 0;
  const conversionsValue = totals.conversionsValue ?? totals.conversions_value ?? 0;
  return { impressions, clicks, cost, conversions, conversionsValue, ...deriveRates({ impressions, clicks, cost, conversions, conversionsValue }) };
}

/**
 * Campaign-level performance for [startDate, endDate], plus a same-length
 * PRECEDING period for comparison (spec §27). Returns `null` comparison
 * metrics (not a fabricated 0%) when the account has no data for the prior
 * window at all — never draws a conclusion from a missing baseline.
 */
export async function getCampaignPerformance({ projectId, campaignId, startDate, endDate }) {
  const current = await GoogleAdsCampaignMetrics.getCampaignAggregate(projectId, campaignId, startDate, endDate);

  const periodMs = endDate.getTime() - startDate.getTime();
  const previousEnd = new Date(startDate.getTime() - 24 * 60 * 60 * 1000);
  const previousStart = new Date(previousEnd.getTime() - periodMs);
  const previous = await GoogleAdsCampaignMetrics.getCampaignAggregate(projectId, campaignId, previousStart, previousEnd);

  const hasCurrentData = current.impressions > 0 || current.clicks > 0 || current.cost > 0;
  const hasPreviousData = previous.impressions > 0 || previous.clicks > 0 || previous.cost > 0;

  return {
    current: normalizeMetrics(current),
    hasCurrentData,
    previous: hasPreviousData ? normalizeMetrics(previous) : null,
    previousDateRange: hasPreviousData ? { startDate: previousStart, endDate: previousEnd } : null,
    comparison: hasCurrentData && hasPreviousData ? buildComparison(normalizeMetrics(current), normalizeMetrics(previous)) : null,
  };
}

/** Percent change for each metric, null when either side is null/undefined (no fabricated deltas — spec §27). */
function buildComparison(current, previous) {
  const pctChange = (curr, prev) => {
    if (curr == null || prev == null) return null;
    if (prev === 0) return null; // a "% change from zero" is not meaningful
    return ((curr - prev) / prev) * 100;
  };
  return {
    impressions: pctChange(current.impressions, previous.impressions),
    clicks: pctChange(current.clicks, previous.clicks),
    cost: pctChange(current.cost, previous.cost),
    conversions: pctChange(current.conversions, previous.conversions),
    ctr: pctChange(current.ctr, previous.ctr),
    cpa: pctChange(current.cpa, previous.cpa),
    roas: pctChange(current.roas, previous.roas),
  };
}

/** Daily series for the campaign trend view — thin, normalized wrapper over the existing daily-grain collection. */
export async function getCampaignDailySeries({ projectId, campaignId, startDate, endDate }) {
  const rows = await GoogleAdsCampaignMetrics.getCampaignSeries(projectId, campaignId, startDate, endDate);
  return rows.map((row) => ({
    date: row.date,
    ...normalizeMetrics({
      impressions: row.impressions, clicks: row.clicks, cost: row.cost, conversions: row.conversions, conversionsValue: row.conversions_value,
    }),
  }));
}

/** Every currently-synced keyword under this campaign, normalized. Rolling snapshot — see file header. */
export async function getKeywordPerformance({ projectId, customerId, campaignId }) {
  const { rows } = await GoogleAdsKeyword.getProjectKeywords(projectId, customerId, { campaignId, limit: 100, includeRemoved: false });
  return rows.map((row) => ({
    adGroupId: row.ad_group_id,
    adGroupName: row.ad_group_name,
    criterionId: row.criterion_id,
    text: row.keyword_text,
    matchType: row.match_type,
    status: row.status,
    qualityScore: row.quality_score,
    dateRangeStart: row.date_range_start,
    dateRangeEnd: row.date_range_end,
    metrics: normalizeMetrics({
      impressions: row.metrics?.impressions, clicks: row.metrics?.clicks, cost: row.metrics?.cost,
      conversions: row.metrics?.conversions, conversionsValue: row.metrics?.conversions_value,
    }),
  }));
}

/** Every currently-synced ad under this campaign, normalized. */
export async function getAdPerformance({ projectId, customerId, campaignId }) {
  const { rows } = await GoogleAdsAd.getProjectAds(projectId, customerId, { campaignId, limit: 100, includeRemoved: false });
  return rows.map((row) => ({
    adGroupId: row.ad_group_id,
    adGroupName: row.ad_group_name,
    adId: row.ad_id,
    name: row.name,
    adType: row.ad_type,
    status: row.status,
    metrics: normalizeMetrics({
      impressions: row.metrics?.impressions, clicks: row.metrics?.clicks, cost: row.metrics?.cost,
      conversions: row.metrics?.conversions, conversionsValue: row.metrics?.conversions_value,
    }),
  }));
}

/** Search terms already flagged by the existing sync heuristic as negative-keyword candidates for this campaign. */
export async function getNegativeKeywordCandidates({ projectId, customerId, campaignId }) {
  const { rows } = await GoogleAdsSearchTerm.getProjectSearchTerms(projectId, customerId, { campaignId, suggestedAction: 'negative', limit: 50 });
  return rows.map((row) => ({
    adGroupId: row.ad_group_id,
    adGroupName: row.ad_group_name,
    searchTerm: row.search_term,
    metrics: normalizeMetrics({
      impressions: row.metrics?.impressions, clicks: row.metrics?.clicks, cost: row.metrics?.cost,
      conversions: row.metrics?.conversions, conversionsValue: row.metrics?.conversions_value,
    }),
  }));
}

/**
 * The complete performance snapshot campaignOptimizationService builds an
 * analysis from. `dataAvailable` is false only when the account has never
 * synced any campaign-level data at all — the caller must not proceed to
 * opportunity detection in that case (nothing to compute from).
 */
export async function getFullPerformanceSnapshot({ projectId, customerId, campaignId, startDate, endDate }) {
  const [campaign, keywords, ads, negativeCandidates] = await Promise.all([
    getCampaignPerformance({ projectId, campaignId, startDate, endDate }),
    getKeywordPerformance({ projectId, customerId, campaignId }),
    getAdPerformance({ projectId, customerId, campaignId }),
    getNegativeKeywordCandidates({ projectId, customerId, campaignId }),
  ]);

  return {
    dateRange: { startDate, endDate },
    dataAvailable: campaign.hasCurrentData || keywords.length > 0 || ads.length > 0,
    campaign,
    keywords,
    ads,
    negativeKeywordCandidates: negativeCandidates,
  };
}

export default {
  deriveRates,
  getCampaignPerformance,
  getCampaignDailySeries,
  getKeywordPerformance,
  getAdPerformance,
  getNegativeKeywordCandidates,
  getFullPerformanceSnapshot,
};
