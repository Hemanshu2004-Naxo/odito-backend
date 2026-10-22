import GoogleAdsCampaign from '../modules/app_user/model/GoogleAdsCampaign.js';
import GoogleAdsCampaignMetrics from '../modules/app_user/model/GoogleAdsCampaignMetrics.js';
import GoogleAdsSearchTerm from '../modules/app_user/model/GoogleAdsSearchTerm.js';
import GoogleAdsRecommendation from '../modules/app_user/model/GoogleAdsRecommendation.js';
import GoogleAdsOptimizationHistory from '../modules/app_user/model/GoogleAdsOptimizationHistory.js';
import GoogleAdsAudiencePerformance from '../modules/app_user/model/GoogleAdsAudiencePerformance.js';
import GoogleAdsConversionAction from '../modules/app_user/model/GoogleAdsConversionAction.js';
import GoogleAdsAd from '../modules/app_user/model/GoogleAdsAd.js';
import GoogleConnection from '../modules/app_user/model/GoogleConnection.js';

/**
 * Google Ads Capability Matrix (Phase 6.5, enriched per the frontend
 * integration audit's Gap #8)
 *
 * "The frontend should never guess capabilities" - every flag here is
 * derived from OBSERVED data presence after a real sync, never assumed
 * from account type or plan tier. Computed once at the end of every
 * runGoogleAdsSync run and cached on GoogleConnection.google_ads_capabilities
 * (cheap to read on every request; recomputing per-request would mean 8+
 * existence-check queries on every dashboard load for no benefit, since
 * capabilities only change when new data is synced).
 *
 * Gap #8 requirement: every flag is an OBJECT, not a bare boolean -
 * `{ supported, reason, requiredPermission, requiresSync, availableSince }` -
 * so the frontend never has to guess *why* something is unavailable.
 * `availableSince` is preserved across recomputations (see
 * computeAndPersistCapabilities): once a flag first flips true, its date
 * doesn't reset to "now" on every subsequent sync.
 */

const CAPABILITY_REASONS = {
  supportsRecommendations: 'No recommendations have synced for this account yet. Run a sync to check for account recommendations.',
  supportsOptimizationScore: 'Optimization score has not synced yet, or this account has no active campaigns.',
  supportsSearchTerms: 'No search term data has synced yet.',
  supportsAudienceInsights: 'No audience performance data has synced yet.',
  supportsAttribution: 'No conversion actions have synced yet - configure conversion tracking in Google Ads first.',
  supportsBudgetForecast: 'At least 7 days of campaign metrics history is needed to generate a reliable forecast.',
  supportsAdStrength: 'No ads with a computed Ad Strength score have synced yet.',
  supportsPerformanceMax: 'This account has no Performance Max campaigns.'
};

// None of the 8 capabilities gated here depend on a Google Ads API access
// tier beyond what basic developer-token access already grants (unlike,
// say, click-level `click_view` data, which this codebase does not sync -
// see GoogleAdsConversionAction.js's doc comment on why conversion paths
// aren't implemented). Kept as an explicit map (not hardcoded null inline)
// so a future capability that DOES require elevated access has an obvious
// place to declare it, rather than this file silently always returning null.
const CAPABILITY_REQUIRED_PERMISSIONS = {
  supportsRecommendations: null,
  supportsOptimizationScore: null,
  supportsSearchTerms: null,
  supportsAudienceInsights: null,
  supportsAttribution: null,
  supportsBudgetForecast: null,
  supportsAdStrength: null,
  supportsPerformanceMax: null
};

async function computeRawFlags(projectId, customerId) {
  const pid = projectId;

  const [
    hasSearchTerms,
    hasRecommendations,
    hasOptimizationScore,
    hasAudienceInsights,
    hasConversionActions,
    hasAdStrength,
    hasPerformanceMax,
    metricsHistoryDays
  ] = await Promise.all([
    GoogleAdsSearchTerm.exists({ project_id: pid, google_ads_customer_id: customerId }),
    GoogleAdsRecommendation.exists({ project_id: pid, google_ads_customer_id: customerId }),
    GoogleAdsOptimizationHistory.exists({ project_id: pid, google_ads_customer_id: customerId }),
    GoogleAdsAudiencePerformance.exists({ project_id: pid, google_ads_customer_id: customerId }),
    GoogleAdsConversionAction.exists({ project_id: pid, google_ads_customer_id: customerId }),
    GoogleAdsAd.hasAdStrengthData(pid, customerId),
    GoogleAdsCampaign.exists({ project_id: pid, google_ads_customer_id: customerId, channel_type: 'PERFORMANCE_MAX' }),
    GoogleAdsCampaignMetrics.distinct('date', { project_id: pid, google_ads_customer_id: customerId })
  ]);

  return {
    supportsRecommendations: !!hasRecommendations,
    supportsOptimizationScore: !!hasOptimizationScore,
    supportsSearchTerms: !!hasSearchTerms,
    supportsAudienceInsights: !!hasAudienceInsights,
    supportsAttribution: !!hasConversionActions,
    // A forecast needs at least a week of real spend history to be
    // meaningful - fewer days than that isn't "unsupported", just not
    // reliable yet, which the frontend should be told explicitly rather
    // than rendering a forecast off 1-2 data points.
    supportsBudgetForecast: (metricsHistoryDays?.length || 0) >= 7,
    supportsAdStrength: !!hasAdStrength,
    supportsPerformanceMax: !!hasPerformanceMax
  };
}

/**
 * Computes the full rich capability matrix. `previous` (the connection's
 * currently-stored google_ads_capabilities, if any) is used only to carry
 * `availableSince` forward - every other field is recomputed fresh.
 */
export async function computeCapabilities(projectId, customerId, previous = null) {
  const rawFlags = await computeRawFlags(projectId, customerId);
  const now = new Date();
  const result = { computedAt: now };

  for (const key of Object.keys(rawFlags)) {
    const supported = rawFlags[key];
    const previousEntry = previous?.[key];

    result[key] = {
      supported,
      reason: supported ? null : CAPABILITY_REASONS[key],
      requiredPermission: CAPABILITY_REQUIRED_PERMISSIONS[key],
      requiresSync: !supported,
      // Preserve the original first-true timestamp if one is already
      // recorded; only stamp a fresh "now" the moment this flag is
      // observed true for the first time.
      availableSince: supported ? (previousEntry?.availableSince || now) : null
    };
  }

  return result;
}

/** Persists the computed matrix onto the connection - called at the end of every sync run. */
export async function computeAndPersistCapabilities(connectionId, projectId, customerId) {
  const connection = await GoogleConnection.findById(connectionId, { google_ads_capabilities: 1 });
  const capabilities = await computeCapabilities(projectId, customerId, connection?.google_ads_capabilities);
  await GoogleConnection.findByIdAndUpdate(connectionId, { $set: { google_ads_capabilities: capabilities } });
  return capabilities;
}

const EMPTY_CAPABILITY_MATRIX = Object.keys(CAPABILITY_REASONS).reduce((acc, key) => {
  acc[key] = { supported: false, reason: CAPABILITY_REASONS[key], requiredPermission: null, requiresSync: true, availableSince: null };
  return acc;
}, { computedAt: null });

/** Fast read path - the stored matrix, not recomputed per request. */
export async function getCapabilities(googleConnection) {
  return googleConnection.google_ads_capabilities || EMPTY_CAPABILITY_MATRIX;
}

export default { computeCapabilities, computeAndPersistCapabilities, getCapabilities };
