import express from 'express';
import {
  getGoogleAdsAccountsController,
  selectGoogleAdsAccountController,
  validateGoogleAdsAccountController,
  getGoogleAdsCampaignsController,
  getGoogleAdsCampaignMetadataController,
  getGoogleAdsOverviewController,
  getGoogleAdsTrendsController,
  refreshGoogleAdsCampaignsController,
  getGoogleAdsSyncStatusController,
  getGoogleAdsKeywordsController,
  getGoogleAdsKeywordDetailController,
  refreshGoogleAdsKeywordsController,
  getGoogleAdsSearchTermsController,
  getGoogleAdsOptimizationScoreController,
  getGoogleAdsRecommendationsController,
  refreshGoogleAdsRecommendationsController,
  getGoogleAdsCampaignHealthController,
  getGoogleAdsCampaignHealthSummaryController,
  getGoogleAdsDevicePerformanceController,
  getGoogleAdsGeoPerformanceController,
  getGoogleAdsAudiencePerformanceController,
  getGoogleAdsAdPerformanceController,
  getGoogleAdsBudgetOverviewController,
  getGoogleAdsBudgetForecastController,
  getGoogleAdsAttributionController,
  getGoogleAdsCapabilitiesController,
  getGoogleAdsActivityController
} from '../controller/googleAdsController.js';
import auth from '../../user/middleware/auth.js';

const router = express.Router();

/**
 * Google Ads API Routes
 *
 * Same mounting/auth convention as searchConsoleRoutes.js /
 * analyticsRoutes.js / businessProfileRoutes.js: mounted at '/projects' in
 * src/routes/index.js, every route `auth`-only (no extra validation
 * middleware here, matching those three - ownership + input-shape checks
 * are done inline in the controller, same as GBP/GA/GSC).
 *
 * Endpoints (Phase 6.1-6.3):
 * GET  /projects/:projectId/google-ads/accounts               - List accessible accounts (managers expanded)
 * POST /projects/:projectId/google-ads/select                 - Select + validate + persist an account
 * POST /projects/:projectId/google-ads/validate                - Re-validate the already-selected account
 * GET  /projects/:projectId/google-ads/overview                - KPI Dashboard (server-side aggregate, one request)
 * GET  /projects/:projectId/google-ads/campaigns                - Paginated campaign list (DB-backed)
 * GET  /projects/:projectId/google-ads/campaigns/health         - Server-side campaign health scores (Phase 6.4)
 * GET  /projects/:projectId/google-ads/campaigns/:campaignId    - Campaign detail + metrics summary (DB-backed)
 * GET  /projects/:projectId/google-ads/trends                   - Daily/weekly/monthly trend series (DB-backed)
 * POST /projects/:projectId/google-ads/refresh                  - Trigger a background campaign metrics sync
 * GET  /projects/:projectId/google-ads/sync-status              - Last/current sync bookkeeping
 *
 * Endpoints (Phase 6.4):
 * GET  /projects/:projectId/google-ads/keywords                          - Paginated keyword list
 * GET  /projects/:projectId/google-ads/keywords/:adGroupId/:criterionId  - Single keyword detail
 * POST /projects/:projectId/google-ads/keywords/refresh                  - Trigger a background keyword sync
 * GET  /projects/:projectId/google-ads/search-terms                      - Paginated search term list
 * GET  /projects/:projectId/google-ads/optimization-score                - Current score + trend
 * GET  /projects/:projectId/google-ads/recommendations                   - Paginated recommendation list + status summary
 * POST /projects/:projectId/google-ads/recommendations/refresh           - Trigger a background recommendation sync
 *
 * NOTE: '/campaigns/health' is registered BEFORE '/campaigns/:campaignId'
 * below - Express matches routes in registration order, so the literal
 * path must come first or it would be swallowed by the :campaignId param.
 *
 * Still out of scope (Phase 6.5): device/location/audience reports, ad
 * performance, budget forecasting, attribution reports.
 */

/**
 * GET /projects/:projectId/google-ads/accounts
 *
 * List every Google Ads account accessible to the connected Google
 * identity. Manager (MCC) accounts are already expanded to their direct
 * child accounts - the response is one flat, selectable list.
 *
 * Response: {
 *   success: true,
 *   data: [
 *     { customerId: "1234567890", name: "Client Account", isManager: false,
 *       loginCustomerId: "9876543210" | null, status: "ENABLED",
 *       currencyCode: "USD", timeZone: "America/New_York" }
 *   ]
 * }
 */
router.get('/:projectId/google-ads/accounts',
  auth,
  getGoogleAdsAccountsController
);

/**
 * POST /projects/:projectId/google-ads/select
 *
 * Validate and persist the selected Google Ads customer for this project.
 * Re-validates customerId/loginCustomerId live against Google before
 * saving anything - never trusts the request body on its own.
 *
 * Request: { customerId: "1234567890", loginCustomerId?: "9876543210" }
 * Response: {
 *   success: true,
 *   data: { googleAdsCustomerId, googleAdsLoginCustomerId, accountName, currencyCode, timeZone }
 * }
 */
router.post('/:projectId/google-ads/select',
  auth,
  selectGoogleAdsAccountController
);

/**
 * POST /projects/:projectId/google-ads/validate
 *
 * Re-validate the account already selected for this project (health check).
 * Requires google_ads_customer_id to already be set - use /select first.
 *
 * Response: {
 *   success: true,
 *   data: { valid: true, customerId, accountName, status, currencyCode, timeZone, lastValidatedAt }
 * }
 */
router.post('/:projectId/google-ads/validate',
  auth,
  validateGoogleAdsAccountController
);

/**
 * GET /projects/:projectId/google-ads/overview?range=7|30|90|365
 *
 * KPI Dashboard - every account-wide total the frontend needs in one
 * request, aggregated server-side from already-synced data. Never calls
 * Google.
 *
 * Response: {
 *   success: true,
 *   data: { impressions, clicks, cost, conversions, conversionsValue,
 *           ctr, avgCpc, conversionRate, costPerConversion, roas,
 *           campaignCount, range: { days, startDate, endDate } }
 * }
 */
router.get('/:projectId/google-ads/overview',
  auth,
  getGoogleAdsOverviewController
);

/**
 * GET /projects/:projectId/google-ads/campaigns
 *
 * Paginated campaign list for the selected account, read from MongoDB
 * (populated by the most recent sync) - never calls Google.
 *
 * Query params: page, limit (max 100), status, search, includeRemoved
 * Response: {
 *   success: true,
 *   data: [{ campaign_id, name, status, channel_type, budget: {...}, ... }],
 *   pagination: { page, limit, total, pages }
 * }
 */
router.get('/:projectId/google-ads/campaigns',
  auth,
  getGoogleAdsCampaignsController
);

/**
 * GET /projects/:projectId/google-ads/campaigns/health
 *
 * Server-side per-campaign health engine: one composite 0-100 score per
 * campaign (budget pacing, quality score, optimization score, CTR,
 * conversions, ad strength, open recommendation count), computed entirely
 * server-side from already-synced data. Registered before '/:campaignId' -
 * see file-level note.
 *
 * Response: {
 *   success: true,
 *   data: [{ campaignId, campaignName, status, healthScore, tier, components: {...} }]
 * }
 */
router.get('/:projectId/google-ads/campaigns/health',
  auth,
  getGoogleAdsCampaignHealthController
);

/**
 * GET /projects/:projectId/google-ads/campaigns/health/summary
 *
 * Gap #3 (frontend integration audit) - the four account-wide tiles the
 * Campaign Health Grid widget renders, in one request: Budget Pacing,
 * Quality Score Avg, Ad Strength, Conversion Tracking. Additional to, not a
 * replacement for, the per-campaign engine above. More specific than
 * '/campaigns/health' (3 literal segments vs 2) so no ordering ambiguity
 * with either that route or '/:campaignId'.
 *
 * Response: {
 *   success: true,
 *   data: [{ key, score, title, subtitle }]  // exactly 4 entries: pacing, quality, adStrength, tracking
 * }
 */
router.get('/:projectId/google-ads/campaigns/health/summary',
  auth,
  getGoogleAdsCampaignHealthSummaryController
);

/**
 * GET /projects/:projectId/google-ads/campaigns/:campaignId?range=7|30|90|365
 *
 * Campaign metadata + a metrics summary for the requested range, both read
 * from MongoDB.
 *
 * Response: {
 *   success: true,
 *   data: { campaign: {...}, metrics: { impressions, clicks, cost, ... }, range: {...} }
 * }
 */
router.get('/:projectId/google-ads/campaigns/:campaignId',
  auth,
  getGoogleAdsCampaignMetadataController
);

/**
 * GET /projects/:projectId/google-ads/trends?range=7|30|90|365&granularity=daily|weekly|monthly
 *
 * Historical trend series for the Campaign Performance Trends chart. daily
 * reads the raw daily snapshot grain; weekly/monthly read the pre-aggregated
 * rollups. Never calls Google - "future reports read from snapshots".
 *
 * Response: {
 *   success: true,
 *   data: { granularity, series: [{ date|period_start, impressions, clicks, cost, ... }], range: {...} }
 * }
 */
router.get('/:projectId/google-ads/trends',
  auth,
  getGoogleAdsTrendsController
);

/**
 * POST /projects/:projectId/google-ads/refresh
 *
 * Triggers a background campaign metrics sync (does not block this
 * request) - as of Phase 6.4 this also syncs search terms and optimization
 * score in the same job (see googleAdsSyncService.runGoogleAdsSync). 409
 * if a sync is already in progress for this project.
 *
 * Response (202): { success: true, data: { jobId, status: "queued" } }
 */
router.post('/:projectId/google-ads/refresh',
  auth,
  refreshGoogleAdsCampaignsController
);

/**
 * GET /projects/:projectId/google-ads/sync-status
 *
 * Last/current campaign+metrics sync bookkeeping - whether a sync is in
 * flight right now, plus the last started/completed/failed timestamps,
 * duration, row counts, and any error message.
 *
 * Response: {
 *   success: true,
 *   data: { customerId, inProgress, currentJobStatus, lastSyncStartedAt,
 *           lastSyncCompletedAt, lastSyncFailedAt, lastSyncError,
 *           lastSyncDurationMs, lastSyncStats, lastValidatedAt }
 * }
 */
router.get('/:projectId/google-ads/sync-status',
  auth,
  getGoogleAdsSyncStatusController
);

/**
 * GET /projects/:projectId/google-ads/keywords
 *
 * Paginated, filterable, sortable keyword performance list, read from
 * MongoDB (populated by the keyword sync) - never calls Google.
 *
 * Query params: page, limit (max 100), campaignId, matchType, status,
 * search, sortBy (cost|clicks|impressions|conversions|ctr|quality_score|keyword_text), sortOrder (1|-1)
 * Response: {
 *   success: true,
 *   data: [{ criterion_id, keyword_text, match_type, quality_score, status, metrics: {...}, ... }],
 *   pagination: { page, limit, total, pages }
 * }
 */
router.get('/:projectId/google-ads/keywords',
  auth,
  getGoogleAdsKeywordsController
);

/**
 * GET /projects/:projectId/google-ads/keywords/:adGroupId/:criterionId
 *
 * Single keyword detail. Google's ad_group_criterion identity is the
 * (ad_group_id, criterion_id) pair, hence the two-segment path.
 *
 * Response: { success: true, data: { criterion_id, keyword_text, ... } }
 */
router.get('/:projectId/google-ads/keywords/:adGroupId/:criterionId',
  auth,
  getGoogleAdsKeywordDetailController
);

/**
 * POST /projects/:projectId/google-ads/keywords/refresh
 *
 * Triggers a background keyword sync (JOB_TYPES.GOOGLE_ADS_KEYWORD_SYNC),
 * independent of the campaign metrics sync. 409 if already in progress.
 *
 * Response (202): { success: true, data: { jobId, status: "queued" } }
 */
router.post('/:projectId/google-ads/keywords/refresh',
  auth,
  refreshGoogleAdsKeywordsController
);

/**
 * GET /projects/:projectId/google-ads/search-terms
 *
 * Paginated, filterable, sortable search term list, read from MongoDB
 * (populated by the campaign sync's search-term stage) - never calls Google.
 *
 * Query params: page, limit (max 100), campaignId, suggestedAction, search, sortBy, sortOrder
 * Response: {
 *   success: true,
 *   data: [{ search_term, targeting_status, suggested_action, metrics: {...}, date_range_start, date_range_end }],
 *   pagination: { page, limit, total, pages }
 * }
 */
router.get('/:projectId/google-ads/search-terms',
  auth,
  getGoogleAdsSearchTermsController
);

/**
 * GET /projects/:projectId/google-ads/optimization-score?range=7|30|90|365
 *
 * Current optimization score + weight plus the historical trend series,
 * both read from MongoDB - never calls Google.
 *
 * Response: {
 *   success: true,
 *   data: { current: { score, scorePercent, weight, asOf } | null,
 *           trend: [{ date, scorePercent, weight }], range: { days } }
 * }
 */
router.get('/:projectId/google-ads/optimization-score',
  auth,
  getGoogleAdsOptimizationScoreController
);

/**
 * GET /projects/:projectId/google-ads/recommendations
 *
 * Paginated, filterable recommendation list + a pending/applied/dismissed
 * status summary, read from MongoDB - never calls Google.
 *
 * Query params: page, limit (max 100), status, type, campaignId, includeResolved
 * Response: {
 *   success: true,
 *   data: { recommendations: [{ resource_name, type, title, impact, details, status, ... }],
 *           summary: { pending, applied, dismissed } },
 *   meta: { pagination: { page, limit, total, pages } }
 * }
 */
router.get('/:projectId/google-ads/recommendations',
  auth,
  getGoogleAdsRecommendationsController
);

/**
 * POST /projects/:projectId/google-ads/recommendations/refresh
 *
 * Triggers a background recommendation sync
 * (JOB_TYPES.GOOGLE_ADS_RECOMMENDATION_SYNC). 409 if already in progress.
 *
 * Response (202): { success: true, data: { jobId, status: "queued" } }
 */
router.post('/:projectId/google-ads/recommendations/refresh',
  auth,
  refreshGoogleAdsRecommendationsController
);

// ═══════════════════════════════════════════════════════════════════════
// Phase 6.5 — Device, Geographic, Audience, Ad Performance, Budget
// Analytics, Attribution, Capability Matrix. All read-only - every sync
// for these domains rides the existing POST /refresh (see
// googleAdsSyncService.runGoogleAdsSync's Phase 6.5 stages); none of them
// has its own dedicated refresh endpoint.
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /projects/:projectId/google-ads/device-performance?range=7|30|90|365
 * Response: { success: true, data: { devices: [{ device, impressions, clicks, cost, ctr, avgCpc, roas }], range: {...} } }
 */
router.get('/:projectId/google-ads/device-performance',
  auth,
  getGoogleAdsDevicePerformanceController
);

/**
 * GET /projects/:projectId/google-ads/geo-performance?level=country|region|city&page=&limit=&search=&sortBy=&sortOrder=
 * Response: { success: true, data: [{ geo_level, geo_target_id, name, country_code, metrics: {...} }], pagination: {...} }
 */
router.get('/:projectId/google-ads/geo-performance',
  auth,
  getGoogleAdsGeoPerformanceController
);

/**
 * GET /projects/:projectId/google-ads/audience-performance
 * Response: { success: true, data: { age: [...], gender: [...], household_income: [...], affinity: [...], in_market: [...], audience_segment: [...] } }
 */
router.get('/:projectId/google-ads/audience-performance',
  auth,
  getGoogleAdsAudiencePerformanceController
);

/**
 * GET /projects/:projectId/google-ads/ads?page=&limit=&campaignId=&adType=&includeRemoved=&sortBy=&sortOrder=
 * Response: { success: true, data: [{ ad_id, name, ad_type, ad_strength, approval_status, review_status, metrics: {...} }], pagination: {...} }
 *
 * GET /projects/:projectId/google-ads/ads?groupBy=ad_type
 * Gap #6 (frontend integration audit) - same endpoint, aggregation mode:
 * Response: { success: true, data: [{ key, title, impressions, clicks, cost, conversions, conversionsValue, ctr, roas, adCount }] }
 * (exactly 5 possible keys: RESPONSIVE_SEARCH_AD, PERFORMANCE_MAX, DISPLAY, VIDEO, SHOPPING - plus OTHER as a catch-all)
 */
router.get('/:projectId/google-ads/ads',
  auth,
  getGoogleAdsAdPerformanceController
);

/**
 * GET /projects/:projectId/google-ads/budget/overview
 * Response: { success: true, data: { overview: {...}, campaignBudgetHealth: [...], alerts: [...] } }
 */
router.get('/:projectId/google-ads/budget/overview',
  auth,
  getGoogleAdsBudgetOverviewController
);

/**
 * GET /projects/:projectId/google-ads/budget/forecast
 * Response: { success: true, data: { projectedSpend, monthlyBudget, forecastStatus, variancePct, daysRemaining, burnRatePerDay } }
 */
router.get('/:projectId/google-ads/budget/forecast',
  auth,
  getGoogleAdsBudgetForecastController
);

/**
 * GET /projects/:projectId/google-ads/attribution
 * Response: { success: true, data: { topConversionSources: [...], clickAttribution: {...}, viewAttribution: {...}, conversionPathsAvailable: false, assistConversionsAvailable: false } }
 */
router.get('/:projectId/google-ads/attribution',
  auth,
  getGoogleAdsAttributionController
);

/**
 * GET /projects/:projectId/google-ads/capabilities
 * Response: { success: true, data: { supportsRecommendations, supportsOptimizationScore, supportsSearchTerms, supportsAudienceInsights, supportsAttribution, supportsBudgetForecast, supportsAdStrength, supportsPerformanceMax, computedAt } }
 */
router.get('/:projectId/google-ads/capabilities',
  auth,
  getGoogleAdsCapabilitiesController
);

/**
 * GET /projects/:projectId/google-ads/activity
 * GET /projects/:projectId/google-ads/activity?limit=20&lookbackDays=14
 * Gap #7 (frontend integration audit): normalized Recent Activity feed
 * merging Sync History, Recommendations, Budget Alerts, Campaign Changes,
 * and Optimization Events, sorted by timestamp desc.
 * Response: { success: true, data: [{ id, type, text, severity, color, timestamp }] }
 */
router.get('/:projectId/google-ads/activity',
  auth,
  getGoogleAdsActivityController
);

export default router;
