import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { ErrorUtil } from '../../../utils/ErrorUtil.js';
import GoogleConnection from '../model/GoogleConnection.js';
import SeoProject from '../model/SeoProject.js';
import GoogleAdsCampaign from '../model/GoogleAdsCampaign.js';
import GoogleAdsCampaignMetrics from '../model/GoogleAdsCampaignMetrics.js';
import GoogleAdsCampaignSnapshot from '../model/GoogleAdsCampaignSnapshot.js';
import GoogleAdsKeyword from '../model/GoogleAdsKeyword.js';
import GoogleAdsSearchTerm from '../model/GoogleAdsSearchTerm.js';
import GoogleAdsRecommendation from '../model/GoogleAdsRecommendation.js';
import GoogleAdsOptimizationHistory from '../model/GoogleAdsOptimizationHistory.js';
import GoogleAdsDevicePerformance from '../model/GoogleAdsDevicePerformance.js';
import GoogleAdsGeoPerformance from '../model/GoogleAdsGeoPerformance.js';
import GoogleAdsAudiencePerformance from '../model/GoogleAdsAudiencePerformance.js';
import GoogleAdsAd from '../model/GoogleAdsAd.js';
import GoogleAdsConversionAction from '../model/GoogleAdsConversionAction.js';
import GoogleAdsBudgetAlert from '../model/GoogleAdsBudgetAlert.js';
import Job from '../../jobs/model/Job.js';
import { JobService } from '../../jobs/service/jobService.js';
import {
  getGoogleAdsAccessibleAccounts,
  validateGoogleAdsAccountAccess
} from '../../../services/googleAdsService.js';
import {
  runGoogleAdsSync,
  runGoogleAdsKeywordSync,
  runGoogleAdsRecommendationSync
} from '../../../services/googleAdsSyncService.js';
import { computeAllCampaignHealth, computeCampaignHealthForIds, computeAccountHealthSummary, tierForScore } from '../../../services/googleAdsHealthService.js';
import { getBudgetOverview, getBudgetForecast, getCampaignBudgetHealth } from '../../../services/googleAdsBudgetService.js';
import { getCapabilities } from '../../../services/googleAdsCapabilityService.js';
import { getGoogleAdsActivityFeed } from '../../../services/googleAdsActivityService.js';
import {
  getCacheKey,
  getCachedData,
  setCachedData
} from '../../../services/businessProfileService.js';
import { resolveGoogleAdsDateRange } from '../../../utils/googleAdsDateRange.js';

/**
 * Google Ads Controller
 *
 * Phase 6.2 (foundation): connect -> select account -> validate -> campaign
 * metadata, all live-Google reads.
 * Phase 6.3: campaign list/details/overview/trends read exclusively from
 * MongoDB (GoogleAdsCampaign/CampaignMetrics/CampaignSnapshot, populated by
 * googleAdsSyncService) - the frontend never talks to Google directly.
 * Phase 6.4 (this file, extended): keyword performance, search terms,
 * optimization score, recommendations, and a server-side campaign health
 * engine - same "read from MongoDB, sync via background Job" pattern
 * throughout, zero new architecture.
 *
 * Same request shape as businessProfileController.js throughout: validate
 * project ownership -> validate an active GoogleConnection -> call the
 * service/model -> map errors through ResponseUtil, preserving Google's real
 * status codes (401/403/429) instead of collapsing everything to 500.
 *
 * Every lookup here uses `purpose: 'google_ads'` explicitly
 * (GoogleConnection.findActiveConnection defaults to 'google_visibility') -
 * Google Ads is a separate OAuth connection/consent, not a 4th service_type
 * on the existing bundle (see GoogleConnection.js and oauth.routes.js's
 * "google_ads" branch, Phase 6.1).
 *
 * Still out of scope (next phase, 6.5): device/location/audience reports,
 * ad performance, budget forecasting, attribution reports.
 */

const jobService = new JobService();

const GOOGLE_ADS_PURPOSE = 'google_ads';

/**
 * Shared preamble for every handler below: validate project ownership, then
 * load the active `purpose: 'google_ads'` GoogleConnection. Writes the
 * appropriate error response and returns null when either check fails, so
 * callers can `if (!ctx) return;` instead of repeating this five times.
 */
async function resolveProjectAndAdsConnection(req, res, { requireSelectedAccount = false } = {}) {
  const { projectId } = req.params;
  const userId = req.user._id;

  const project = await SeoProject.findById(projectId);
  if (!project) {
    res.status(404).json(ResponseUtil.error('Project not found', 404));
    return null;
  }

  if (project.user_id.toString() !== userId.toString()) {
    LoggerUtil.security('Access denied - user does not own project', { projectId, userId: userId.toString() });
    res.status(403).json(ResponseUtil.accessDenied('Access denied'));
    return null;
  }

  const googleConnection = await GoogleConnection.findActiveConnection(userId, projectId, GOOGLE_ADS_PURPOSE);
  if (!googleConnection) {
    res.status(400).json(ResponseUtil.error('Google Ads account not connected. Please connect Google Ads first.', 400));
    return null;
  }

  if (requireSelectedAccount && !googleConnection.google_ads_customer_id) {
    res.status(400).json(ResponseUtil.error('No Google Ads account has been selected for this project yet.', 400));
    return null;
  }

  return { project, userId, googleConnection };
}

/**
 * Phase 2 (Enterprise Historical Sync): parses `?range=7d|30d|90d|12m|all`
 * or `?startDate=&endDate=` into a [startDate, endDate] UTC window, plus a
 * stable cacheKey descriptor. Thin per-request wrapper around the shared
 * resolveGoogleAdsDateRange - only binds projectId/customerId so
 * range=all's earliest-date lookup (GoogleAdsCampaignMetrics.getEarliestDate,
 * index-covered) only ever runs for the one request type that needs it.
 * Legacy numeric values (?range=7|30|90|365) are still accepted - see the
 * shared resolver's own doc comment.
 */
async function resolveDateRange(req, projectId, customerId) {
  return resolveGoogleAdsDateRange(req, {
    getEarliestDate: () => GoogleAdsCampaignMetrics.getEarliestDate(projectId, customerId)
  });
}

/**
 * Optional startDate/endDate parsing for the current-state-snapshot list
 * endpoints (keywords, search terms) - see GoogleAdsKeyword/GoogleAdsSearchTerm's
 * getProject* doc comments for what this actually filters on. Returns
 * {startDate:null, endDate:null} when neither is supplied (no filter
 * applied, current behavior unchanged) rather than defaulting to any range.
 */
function parseOptionalDateFilter(req) {
  const parseOne = (value, label) => {
    if (!value) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
      throw ErrorUtil.validation(`${label} must be a valid date in YYYY-MM-DD format`);
    }
    const d = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) throw ErrorUtil.validation(`${label} must be a valid date in YYYY-MM-DD format`);
    return d;
  };
  return {
    startDate: parseOne(req.query.startDate, 'startDate'),
    endDate: parseOne(req.query.endDate, 'endDate')
  };
}

/** Maps a classified/wrapped Google Ads service error onto a ResponseUtil response. */
function respondWithGoogleAdsError(res, error, fallbackMessage) {
  // .httpStatus is classifyGoogleAdsError/wrapGoogleAdsError's own field for
  // a real Google Ads API failure (see googleAdsService.js); .statusCode is
  // the standard ErrorUtil-typed-error field (ErrorUtil.js) - e.g. the
  // ServiceUnavailableError getGoogleAdsClient() throws when
  // GOOGLE_ADS_DEVELOPER_TOKEN is unset. Both are recognized so neither
  // error convention silently falls through to the generic 500 below.
  const status = error.httpStatus || error.statusCode || error.response?.status;

  if (status === 401) {
    return res.status(401).json(ResponseUtil.error('Google Ads authentication failed. Please reconnect Google Ads.', 401));
  }
  if (status === 403) {
    return res.status(403).json(ResponseUtil.accessDenied(error.message || 'Access denied by Google Ads'));
  }
  if (status === 429) {
    return res.status(429).json(ResponseUtil.error('Google Ads API quota exceeded. Please try again shortly.', 429, { retryAfter: 60 }));
  }
  if (status === 400 || error.category === 'invalid_customer' || error.category === 'invalid_request') {
    return res.status(400).json(ResponseUtil.error(error.message || fallbackMessage, 400));
  }
  if (status === 502 || error.category === 'internal') {
    return res.status(502).json(ResponseUtil.error('Google Ads API is temporarily unavailable. Please try again shortly.', 502));
  }
  if (status === 503) {
    // getGoogleAdsClient()'s own message is already a deliberately-crafted,
    // user-safe explanation (not a raw Google/DB error) - safe to pass
    // straight through, unlike the generic 500 fallback below.
    return res.status(503).json(ResponseUtil.error(error.message || 'Google Ads is not configured yet.', 503));
  }

  return res.status(500).json(ResponseUtil.error(fallbackMessage, 500));
}

/**
 * GET /projects/:projectId/google-ads/accounts
 * Lists every Google Ads account accessible to this connection, with
 * manager (MCC) accounts already expanded to their direct child accounts.
 */
export const getGoogleAdsAccountsController = async (req, res) => {
  const { projectId } = req.params;
  LoggerUtil.info('Getting Google Ads accounts', { projectId, userId: req.user._id.toString() });

  try {
    const ctx = await resolveProjectAndAdsConnection(req, res);
    if (!ctx) return;

    const accounts = await getGoogleAdsAccessibleAccounts(ctx.googleConnection);

    LoggerUtil.info('Google Ads accounts retrieved', { projectId, accountCount: accounts.length });
    return res.json(ResponseUtil.success(accounts, 'Google Ads accounts retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error fetching Google Ads accounts', error, { projectId });
    return respondWithGoogleAdsError(res, error, 'Failed to fetch Google Ads accounts');
  }
};

/**
 * POST /projects/:projectId/google-ads/select
 * Body: { customerId, loginCustomerId? }
 *
 * Never trusts the submitted IDs on their own - re-validates them live
 * against Google before persisting anything, exactly like
 * selectBusinessProfile() validates before saving business_account_id/
 * business_location_id.
 */
export const selectGoogleAdsAccountController = async (req, res) => {
  const { projectId } = req.params;
  const { customerId, loginCustomerId } = req.body || {};
  const userId = req.user._id;

  LoggerUtil.info('Selecting Google Ads account', { projectId, userId: userId.toString(), customerId, loginCustomerId: loginCustomerId || null });

  try {
    const ctx = await resolveProjectAndAdsConnection(req, res);
    if (!ctx) return;

    if (!customerId) {
      return res.status(400).json(ResponseUtil.error('customerId is required', 400));
    }

    let validated;
    try {
      validated = await validateGoogleAdsAccountAccess(ctx.googleConnection, customerId, loginCustomerId || null);
    } catch (validationError) {
      LoggerUtil.warn('Google Ads account selection rejected - validation failed', {
        projectId, customerId, loginCustomerId: loginCustomerId || null, message: validationError.message
      });
      return respondWithGoogleAdsError(res, validationError, 'Selected Google Ads account could not be validated');
    }

    if (validated.isManager) {
      return res.status(400).json(ResponseUtil.error(
        'The selected account is a manager (MCC) account and cannot be synced directly. Please select one of its child accounts.',
        400
      ));
    }

    const now = new Date();
    await GoogleConnection.findByIdAndUpdate(
      ctx.googleConnection._id,
      {
        $set: {
          google_ads_customer_id: validated.customerId,
          google_ads_login_customer_id: loginCustomerId || null,
          // Was computed here and returned to the caller but never actually
          // persisted - google_ads_account_name has existed on the schema
          // since Phase 6.1 but stayed permanently null. Needed now so
          // GET /sync-status (read on every dashboard load) can surface the
          // real account name without a second live Google Ads call.
          google_ads_account_name: validated.name || null,
          google_ads_currency_code: validated.currencyCode || null,
          google_ads_last_validated_at: now,
          last_used_at: now,
          updated_at: now
        },
        $addToSet: { service_type: GOOGLE_ADS_PURPOSE }
      },
      { new: true, runValidators: true }
    );

    LoggerUtil.info('Google Ads account selected successfully', { projectId, customerId: validated.customerId, loginCustomerId: loginCustomerId || null });

    return res.json(ResponseUtil.success({
      googleAdsCustomerId: validated.customerId,
      googleAdsLoginCustomerId: loginCustomerId || null,
      accountName: validated.name,
      currencyCode: validated.currencyCode,
      timeZone: validated.timeZone
    }, 'Google Ads account selected successfully'));
  } catch (error) {
    LoggerUtil.error('Error selecting Google Ads account', error, { projectId });
    return respondWithGoogleAdsError(res, error, 'Failed to select Google Ads account');
  }
};

/**
 * POST /projects/:projectId/google-ads/validate
 * Re-validates the already-selected account (no body required) - a health
 * check the frontend can call on demand, separate from the one-time
 * validation embedded in /select.
 */
export const validateGoogleAdsAccountController = async (req, res) => {
  const { projectId } = req.params;
  LoggerUtil.info('Validating Google Ads account', { projectId, userId: req.user._id.toString() });

  try {
    const ctx = await resolveProjectAndAdsConnection(req, res, { requireSelectedAccount: true });
    if (!ctx) return;

    const validated = await validateGoogleAdsAccountAccess(
      ctx.googleConnection,
      ctx.googleConnection.google_ads_customer_id,
      ctx.googleConnection.google_ads_login_customer_id
    );

    const now = new Date();
    await GoogleConnection.findByIdAndUpdate(ctx.googleConnection._id, {
      $set: {
        google_ads_currency_code: validated.currencyCode || null,
        google_ads_last_validated_at: now,
        last_used_at: now,
        updated_at: now
      }
    });

    LoggerUtil.info('Google Ads account validated', { projectId, customerId: validated.customerId });

    return res.json(ResponseUtil.success({
      valid: true,
      customerId: validated.customerId,
      accountName: validated.name,
      status: validated.status,
      currencyCode: validated.currencyCode,
      timeZone: validated.timeZone,
      lastValidatedAt: now.toISOString()
    }, 'Google Ads account is valid'));
  } catch (error) {
    LoggerUtil.error('Error validating Google Ads account', error, { projectId });
    return respondWithGoogleAdsError(res, error, 'Failed to validate Google Ads account');
  }
};

/**
 * GET /projects/:projectId/google-ads/campaigns
 * Paginated campaign list - reads persisted, already-synced data
 * (GoogleAdsCampaign) rather than calling Google. Never returns anything
 * for a project that hasn't synced yet (empty rows + total:0, not an
 * error - "no data synced yet" is a normal, expected state).
 *
 * Query params: page, limit (max 100), status, search, includeRemoved
 */
/**
 * GET /projects/:projectId/google-ads/campaigns?range=7|30|90|365
 *
 * Gap #2 (frontend integration audit): each row now embeds its own
 * range-scoped metrics (spend/clicks/impressions/ctr/cpc/conversions/
 * conversionValue/roas), its full per-campaign health object, and a
 * `budgetHealth` convenience field - all in this ONE paginated response,
 * with zero additional per-campaign requests. Metrics come from
 * GoogleAdsCampaignMetrics.getBulkCampaignAggregates (one grouped
 * aggregation across the current page's campaign_ids); health comes from
 * computeCampaignHealthForIds (scoped to the same page, not the whole
 * account) - neither is an N+1 query pattern.
 */
export const getGoogleAdsCampaignsController = async (req, res) => {
  const { projectId } = req.params;
  const { page = 1, limit = 25, status = null, search = null, includeRemoved = false } = req.query;
  LoggerUtil.info('Getting Google Ads campaigns', { projectId, userId: req.user._id.toString(), page, limit, status });

  try {
    const ctx = await resolveProjectAndAdsConnection(req, res, { requireSelectedAccount: true });
    if (!ctx) return;

    const customerId = ctx.googleConnection.google_ads_customer_id;
    const { startDate, endDate, cacheKey: rangeCacheKey } = await resolveDateRange(req, projectId, customerId);
    const cacheKey = getCacheKey('ads_campaign_list', ctx.googleConnection._id, customerId, page, limit, status || 'all', search || '', includeRemoved, rangeCacheKey);
    const cached = getCachedData(cacheKey);
    if (cached) {
      return res.json(ResponseUtil.paginated(cached.rows, cached.pagination, 'Google Ads campaigns retrieved successfully'));
    }

    const { rows, total, pages } = await GoogleAdsCampaign.getProjectCampaigns(projectId, customerId, {
      page, limit, status, search, includeRemoved: includeRemoved === 'true' || includeRemoved === true
    });

    const campaignIds = rows.map((r) => r.campaign_id);

    const [metricsByCampaignId, healthByCampaignId] = await Promise.all([
      GoogleAdsCampaignMetrics.getBulkCampaignAggregates(projectId, campaignIds, startDate, endDate),
      computeCampaignHealthForIds(projectId, customerId, campaignIds).then((healthRows) => {
        const map = new Map();
        for (const h of healthRows) map.set(h.campaignId, h);
        return map;
      })
    ]);

    const enrichedRows = rows.map((row) => {
      const health = healthByCampaignId.get(row.campaign_id) || null;
      const budgetComponent = health?.components?.budget || null;
      return {
        ...row,
        metrics: metricsByCampaignId.get(row.campaign_id) || null,
        health: health ? { healthScore: health.healthScore, tier: health.tier, components: health.components } : null,
        budgetHealth: budgetComponent ? { score: budgetComponent.score, tier: tierForScore(budgetComponent.score), available: budgetComponent.available, utilization: budgetComponent.utilization ?? null } : null
      };
    });

    const pagination = { page: Number(page) || 1, limit: Number(limit) || 25, total, pages };
    setCachedData(cacheKey, { rows: enrichedRows, pagination });

    LoggerUtil.info('Google Ads campaigns retrieved', { projectId, campaignCount: enrichedRows.length, total });
    return res.json(ResponseUtil.paginated(enrichedRows, pagination, 'Google Ads campaigns retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error fetching Google Ads campaigns', error, { projectId });
    return respondWithGoogleAdsError(res, error, 'Failed to fetch Google Ads campaigns');
  }
};

/**
 * GET /projects/:projectId/google-ads/campaigns/:campaignId
 * Campaign metadata (GoogleAdsCampaign) plus a metrics summary for
 * ?range=7|30|90|365 days (default 30), both read from MongoDB. Mirrors
 * getBusinessProfileLocationDetails()'s list-vs-detail split, applied to
 * campaigns instead of locations.
 */
export const getGoogleAdsCampaignMetadataController = async (req, res) => {
  const { projectId, campaignId } = req.params;
  LoggerUtil.info('Getting Google Ads campaign detail', { projectId, campaignId, userId: req.user._id.toString() });

  try {
    const ctx = await resolveProjectAndAdsConnection(req, res, { requireSelectedAccount: true });
    if (!ctx) return;

    if (!campaignId || !/^\d+$/.test(campaignId)) {
      return res.status(400).json(ResponseUtil.error('A valid numeric campaignId is required', 400));
    }

    const customerId = ctx.googleConnection.google_ads_customer_id;
    const { startDate, endDate, days, range: resolvedRange, cacheKey: rangeCacheKey } = await resolveDateRange(req, projectId, customerId);

    const cacheKey = getCacheKey('ads_campaign_detail', ctx.googleConnection._id, customerId, campaignId, rangeCacheKey);
    const cached = getCachedData(cacheKey);
    if (cached) {
      return res.json(ResponseUtil.success(cached, 'Google Ads campaign detail retrieved successfully'));
    }

    const campaign = await GoogleAdsCampaign.getByCampaignId(projectId, customerId, campaignId);
    if (!campaign) {
      return res.status(404).json(ResponseUtil.error('Campaign not found for this project - it may not have synced yet', 404));
    }

    const metrics = await GoogleAdsCampaignMetrics.getCampaignAggregate(projectId, campaignId, startDate, endDate);

    const detail = { campaign, metrics, range: { preset: resolvedRange, days, startDate: startDate.toISOString().slice(0, 10), endDate: endDate.toISOString().slice(0, 10) } };
    setCachedData(cacheKey, detail);

    LoggerUtil.info('Google Ads campaign detail retrieved', { projectId, campaignId });
    return res.json(ResponseUtil.success(detail, 'Google Ads campaign detail retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error fetching Google Ads campaign detail', error, { projectId, campaignId });
    return respondWithGoogleAdsError(res, error, 'Failed to fetch Google Ads campaign detail');
  }
};

/**
 * GET /projects/:projectId/google-ads/overview?range=7|30|90|365
 * KPI Dashboard - one request, every account-wide total the frontend needs
 * (spend/clicks/impressions/ctr/avgCpc/conversions/conversionRate/
 * costPerConversion/roas), aggregated server-side from GoogleAdsCampaignMetrics.
 * Never calls Google.
 */
export const getGoogleAdsOverviewController = async (req, res) => {
  const { projectId } = req.params;
  LoggerUtil.info('Getting Google Ads overview', { projectId, userId: req.user._id.toString() });

  try {
    const ctx = await resolveProjectAndAdsConnection(req, res, { requireSelectedAccount: true });
    if (!ctx) return;

    const customerId = ctx.googleConnection.google_ads_customer_id;
    const { startDate, endDate, days, range: resolvedRange, cacheKey: rangeCacheKey } = await resolveDateRange(req, projectId, customerId);

    const cacheKey = getCacheKey('ads_overview', ctx.googleConnection._id, customerId, rangeCacheKey);
    const cached = getCachedData(cacheKey);
    if (cached) {
      return res.json(ResponseUtil.success(cached, 'Google Ads overview retrieved successfully'));
    }

    const overview = await GoogleAdsCampaignMetrics.getAccountAggregate(projectId, customerId, startDate, endDate);
    const result = { ...overview, range: { preset: resolvedRange, days, startDate: startDate.toISOString().slice(0, 10), endDate: endDate.toISOString().slice(0, 10) } };

    setCachedData(cacheKey, result);
    LoggerUtil.info('Google Ads overview retrieved', { projectId, days, campaignCount: overview.campaignCount });
    return res.json(ResponseUtil.success(result, 'Google Ads overview retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error fetching Google Ads overview', error, { projectId });
    return respondWithGoogleAdsError(res, error, 'Failed to fetch Google Ads overview');
  }
};

/**
 * GET /projects/:projectId/google-ads/trends?range=7|30|90|365&granularity=daily|weekly|monthly&campaignId=1234567890
 * Historical trend series backing the Campaign Performance Trends chart.
 * daily reads GoogleAdsCampaignMetrics directly; weekly/monthly read the
 * pre-aggregated GoogleAdsCampaignSnapshot rollups - neither calls Google.
 *
 * Optional `campaignId` scopes the series to one campaign (Campaign Detail
 * page) instead of the account-wide rollup - GoogleAdsCampaignSnapshot
 * already stores a dedicated per-campaign rollup row alongside the
 * account-wide one (`campaign_id: null` vs a real id, see that model's
 * getTrend), and GoogleAdsCampaignMetrics.getCampaignSeries already exists
 * for the daily grain - both were simply never wired to this endpoint.
 */
export const getGoogleAdsTrendsController = async (req, res) => {
  const { projectId } = req.params;
  const granularity = ['daily', 'weekly', 'monthly'].includes(req.query.granularity) ? req.query.granularity : 'daily';
  const campaignId = /^\d+$/.test(req.query.campaignId || '') ? req.query.campaignId : null;
  LoggerUtil.info('Getting Google Ads trends', { projectId, granularity, campaignId, userId: req.user._id.toString() });

  try {
    const ctx = await resolveProjectAndAdsConnection(req, res, { requireSelectedAccount: true });
    if (!ctx) return;

    const customerId = ctx.googleConnection.google_ads_customer_id;
    const { startDate, endDate, days, range: resolvedRange, cacheKey: rangeCacheKey } = await resolveDateRange(req, projectId, customerId);

    const cacheKey = getCacheKey('ads_trends', ctx.googleConnection._id, customerId, granularity, campaignId || 'account', rangeCacheKey);
    const cached = getCachedData(cacheKey);
    if (cached) {
      return res.json(ResponseUtil.success(cached, 'Google Ads trends retrieved successfully'));
    }

    let series;
    if (granularity === 'daily') {
      series = campaignId
        ? await GoogleAdsCampaignMetrics.getCampaignSeries(projectId, campaignId, startDate, endDate)
        : await GoogleAdsCampaignMetrics.getAccountDailySeries(projectId, customerId, startDate, endDate);
    } else {
      // Phase 2: scale the snapshot lookback to the resolved range instead
      // of a fixed 26 weeks / 12 months, so range=all / 12m / custom
      // actually widen the weekly/monthly trend too, not just the daily one.
      const periodDays = granularity === 'weekly' ? 7 : 30;
      const limit = Math.max(1, Math.ceil(days / periodDays));
      const snapshotRows = await GoogleAdsCampaignSnapshot.getTrend(projectId, customerId, granularity, { campaignId, limit });
      // GoogleAdsCampaignSnapshot documents key their period by `period_start`,
      // not `date` - but CampaignPerformanceTrendsCard.jsx's chart (XAxis
      // dataKey="date") only knows the `date` contract GoogleAdsCampaignMetrics.
      // getAccountDailySeries() already returns for the daily path. Without
      // this alias, every weekly/monthly point's `date` was undefined, so
      // the X-axis and every Area had nothing to plot against - the chart
      // rendered completely blank for 12m/all (both use monthly granularity)
      // even though impressions/clicks/cost/ctr/conversions/roas were all
      // present and correct on every row. Purely additive - period_start is
      // still returned as-is alongside it, nothing upstream changes.
      series = snapshotRows.map((row) => ({ ...row, date: row.period_start }));
    }

    const result = { granularity, series, range: { preset: resolvedRange, days } };
    setCachedData(cacheKey, result);

    LoggerUtil.info('Google Ads trends retrieved', { projectId, granularity, pointCount: series.length });
    return res.json(ResponseUtil.success(result, 'Google Ads trends retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error fetching Google Ads trends', error, { projectId });
    return respondWithGoogleAdsError(res, error, 'Failed to fetch Google Ads trends');
  }
};

/**
 * POST /projects/:projectId/google-ads/refresh
 * Triggers a background campaign metrics sync (JOB_TYPES.GOOGLE_ADS_SYNC) -
 * never blocks the HTTP request. Returns the created job's id immediately;
 * progress is available via the google_ads_sync:* websocket events on the
 * project-{projectId} room, and the final outcome via GET /sync-status.
 *
 * A partial-unique index on Job (unique_google_ads_sync_in_flight) rejects a
 * second sync while one is already pending/processing for this project -
 * surfaced here as 409, not a generic 500.
 */
export const refreshGoogleAdsCampaignsController = async (req, res) => {
  const { projectId } = req.params;
  LoggerUtil.info('Refresh Google Ads campaigns requested', { projectId, userId: req.user._id.toString() });

  try {
    const ctx = await resolveProjectAndAdsConnection(req, res, { requireSelectedAccount: true });
    if (!ctx) return;

    const customerId = ctx.googleConnection.google_ads_customer_id;

    let job;
    try {
      job = await jobService.createAndDispatchGoogleAdsSyncJob(ctx.userId, projectId, ctx.googleConnection._id.toString(), customerId);
    } catch (createError) {
      if (createError.code === 11000) {
        LoggerUtil.warn('Google Ads sync already in progress for this project', { projectId });
        return res.status(409).json(ResponseUtil.conflict('A Google Ads sync is already in progress for this project.'));
      }
      throw createError;
    }

    // Node-self-processed - run in-process, fire-and-forget, mirroring how
    // chainingEngine explicitly calls _runProjectTaskVerificationJob right
    // after creating that job rather than the creation method doing it.
    runGoogleAdsSync(job).catch((err) => {
      LoggerUtil.error('Unhandled error running GOOGLE_ADS_SYNC job', err, { jobId: job._id.toString(), projectId });
    });

    LoggerUtil.info('Google Ads sync job queued', { projectId, jobId: job._id.toString(), customerId });
    return res.status(202).json(ResponseUtil.success({ jobId: job._id.toString(), status: 'queued' }, 'Google Ads campaign sync started'));
  } catch (error) {
    LoggerUtil.error('Error starting Google Ads sync', error, { projectId });
    return respondWithGoogleAdsError(res, error, 'Failed to start Google Ads campaign sync');
  }
};

/**
 * GET /projects/:projectId/google-ads/sync-status
 * Sync bookkeeping for this project's Google Ads connection: last
 * started/completed/failed timestamps, duration, row counts, and whether a
 * sync is currently in flight (read from the Job collection - the same
 * partial-unique index that guards against overlapping syncs is also the
 * source of truth for "is one running right now").
 */
export const getGoogleAdsSyncStatusController = async (req, res) => {
  const { projectId } = req.params;
  LoggerUtil.info('Getting Google Ads sync status', { projectId, userId: req.user._id.toString() });

  try {
    const ctx = await resolveProjectAndAdsConnection(req, res);
    if (!ctx) return;

    const inFlightJob = await Job.findOne({
      project_id: projectId,
      jobType: 'GOOGLE_ADS_SYNC',
      status: { $in: ['pending', 'processing', 'retrying'] }
    }).sort({ created_at: -1 }).lean();

    const conn = ctx.googleConnection;

    return res.json(ResponseUtil.success({
      customerId: conn.google_ads_customer_id || null,
      // Purely additive - lets the header show the real connected account
      // name/id instead of a placeholder, without a second request against
      // the accounts-list endpoint (which would re-hit Google Ads on every
      // dashboard load just to redisplay a name already captured at /select time).
      accountName: conn.google_ads_account_name || null,
      // Single source of truth for currency across the whole Google Ads
      // dashboard (see frontend/contexts/GoogleAdsCurrencyContext.jsx) -
      // same "persisted at /select + /validate, read here so no page load
      // needs a second live Google Ads call" reasoning as accountName above.
      currencyCode: conn.google_ads_currency_code || null,
      inProgress: !!inFlightJob,
      currentJobStatus: inFlightJob?.status || null,
      lastSyncStartedAt: conn.google_ads_last_sync_started_at || null,
      lastSyncCompletedAt: conn.google_ads_last_sync_completed_at || null,
      lastSyncFailedAt: conn.google_ads_last_sync_failed_at || null,
      lastSyncError: conn.google_ads_last_sync_error || null,
      lastSyncDurationMs: conn.google_ads_last_sync_duration_ms || null,
      lastSyncStats: conn.google_ads_last_sync_stats || null,
      lastValidatedAt: conn.google_ads_last_validated_at || null
    }, 'Google Ads sync status retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error fetching Google Ads sync status', error, { projectId });
    return respondWithGoogleAdsError(res, error, 'Failed to fetch Google Ads sync status');
  }
};

// ═══════════════════════════════════════════════════════════════════════
// Phase 6.4 — Keyword Performance, Search Terms, Optimization Score,
// Recommendations, Campaign Health
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /projects/:projectId/google-ads/keywords
 * Paginated, filterable, sortable keyword list - reads persisted data.
 * Query params: page, limit, campaignId, matchType, status, search,
 * sortBy (cost|clicks|impressions|conversions|ctr|quality_score|keyword_text), sortOrder (1|-1)
 */
export const getGoogleAdsKeywordsController = async (req, res) => {
  const { projectId } = req.params;
  const { page = 1, limit = 25, campaignId = null, matchType = null, status = null, search = null, sortBy = 'cost', sortOrder = -1 } = req.query;
  LoggerUtil.info('Getting Google Ads keywords', { projectId, userId: req.user._id.toString(), page, limit });

  try {
    const ctx = await resolveProjectAndAdsConnection(req, res, { requireSelectedAccount: true });
    if (!ctx) return;

    const customerId = ctx.googleConnection.google_ads_customer_id;
    const { startDate, endDate } = parseOptionalDateFilter(req);
    const dateCacheKey = startDate || endDate ? `${req.query.startDate || ''}:${req.query.endDate || ''}` : 'nodate';
    const cacheKey = getCacheKey('ads_keywords', ctx.googleConnection._id, customerId, page, limit, campaignId || 'all', matchType || 'all', status || 'all', search || '', sortBy, sortOrder, dateCacheKey);
    const cached = getCachedData(cacheKey);
    if (cached) {
      return res.json(ResponseUtil.paginated(cached.rows, cached.pagination, 'Google Ads keywords retrieved successfully'));
    }

    const { rows, total, pages } = await GoogleAdsKeyword.getProjectKeywords(projectId, customerId, {
      page, limit, campaignId, matchType, status, search, sortBy, sortOrder: Number(sortOrder), startDate, endDate
    });

    const pagination = { page: Number(page) || 1, limit: Number(limit) || 25, total, pages };
    setCachedData(cacheKey, { rows, pagination });

    LoggerUtil.info('Google Ads keywords retrieved', { projectId, count: rows.length, total });
    return res.json(ResponseUtil.paginated(rows, pagination, 'Google Ads keywords retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error fetching Google Ads keywords', error, { projectId });
    return respondWithGoogleAdsError(res, error, 'Failed to fetch Google Ads keywords');
  }
};

/**
 * GET /projects/:projectId/google-ads/keywords/:adGroupId/:criterionId
 * Single keyword detail - Google's ad_group_criterion identity is the
 * (ad_group_id, criterion_id) PAIR, not criterion_id alone, hence the
 * two-segment path.
 */
export const getGoogleAdsKeywordDetailController = async (req, res) => {
  const { projectId, adGroupId, criterionId } = req.params;
  LoggerUtil.info('Getting Google Ads keyword detail', { projectId, adGroupId, criterionId, userId: req.user._id.toString() });

  try {
    const ctx = await resolveProjectAndAdsConnection(req, res, { requireSelectedAccount: true });
    if (!ctx) return;

    const customerId = ctx.googleConnection.google_ads_customer_id;
    const keyword = await GoogleAdsKeyword.getByCriterionId(projectId, customerId, adGroupId, criterionId);
    if (!keyword) {
      return res.status(404).json(ResponseUtil.error('Keyword not found for this project - it may not have synced yet', 404));
    }

    return res.json(ResponseUtil.success(keyword, 'Google Ads keyword retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error fetching Google Ads keyword detail', error, { projectId, adGroupId, criterionId });
    return respondWithGoogleAdsError(res, error, 'Failed to fetch Google Ads keyword detail');
  }
};

/**
 * POST /projects/:projectId/google-ads/keywords/refresh
 * Triggers a background keyword sync (JOB_TYPES.GOOGLE_ADS_KEYWORD_SYNC) -
 * independent of the campaign metrics sync, per Phase 6.4's own dedicated
 * refresh endpoint.
 */
export const refreshGoogleAdsKeywordsController = async (req, res) => {
  const { projectId } = req.params;
  LoggerUtil.info('Refresh Google Ads keywords requested', { projectId, userId: req.user._id.toString() });

  try {
    const ctx = await resolveProjectAndAdsConnection(req, res, { requireSelectedAccount: true });
    if (!ctx) return;

    const customerId = ctx.googleConnection.google_ads_customer_id;

    let job;
    try {
      job = await jobService.createAndDispatchGoogleAdsKeywordSyncJob(ctx.userId, projectId, ctx.googleConnection._id.toString(), customerId);
    } catch (createError) {
      if (createError.code === 11000) {
        return res.status(409).json(ResponseUtil.conflict('A Google Ads keyword sync is already in progress for this project.'));
      }
      throw createError;
    }

    runGoogleAdsKeywordSync(job).catch((err) => {
      LoggerUtil.error('Unhandled error running GOOGLE_ADS_KEYWORD_SYNC job', err, { jobId: job._id.toString(), projectId });
    });

    LoggerUtil.info('Google Ads keyword sync job queued', { projectId, jobId: job._id.toString(), customerId });
    return res.status(202).json(ResponseUtil.success({ jobId: job._id.toString(), status: 'queued' }, 'Google Ads keyword sync started'));
  } catch (error) {
    LoggerUtil.error('Error starting Google Ads keyword sync', error, { projectId });
    return respondWithGoogleAdsError(res, error, 'Failed to start Google Ads keyword sync');
  }
};

/**
 * GET /projects/:projectId/google-ads/search-terms
 * Paginated, filterable, sortable search term list - reads persisted data.
 * Each row already carries its own date_range_start/end (the window the
 * most recent sync covered) - "Date Range" support is therefore about what
 * window the NEXT sync fetches, not a read-time filter over stored rows.
 * Query params: page, limit, campaignId, suggestedAction, search, sortBy, sortOrder
 */
export const getGoogleAdsSearchTermsController = async (req, res) => {
  const { projectId } = req.params;
  const { page = 1, limit = 25, campaignId = null, suggestedAction = null, search = null, sortBy = 'cost', sortOrder = -1 } = req.query;
  LoggerUtil.info('Getting Google Ads search terms', { projectId, userId: req.user._id.toString(), page, limit });

  try {
    const ctx = await resolveProjectAndAdsConnection(req, res, { requireSelectedAccount: true });
    if (!ctx) return;

    const customerId = ctx.googleConnection.google_ads_customer_id;
    const { startDate, endDate } = parseOptionalDateFilter(req);
    const dateCacheKey = startDate || endDate ? `${req.query.startDate || ''}:${req.query.endDate || ''}` : 'nodate';
    const cacheKey = getCacheKey('ads_search_terms', ctx.googleConnection._id, customerId, page, limit, campaignId || 'all', suggestedAction || 'all', search || '', sortBy, sortOrder, dateCacheKey);
    const cached = getCachedData(cacheKey);
    if (cached) {
      return res.json(ResponseUtil.paginated(cached.rows, cached.pagination, 'Google Ads search terms retrieved successfully'));
    }

    const { rows, total, pages } = await GoogleAdsSearchTerm.getProjectSearchTerms(projectId, customerId, {
      page, limit, campaignId, suggestedAction, search, sortBy, sortOrder: Number(sortOrder), startDate, endDate
    });

    const pagination = { page: Number(page) || 1, limit: Number(limit) || 25, total, pages };
    setCachedData(cacheKey, { rows, pagination });

    LoggerUtil.info('Google Ads search terms retrieved', { projectId, count: rows.length, total });
    return res.json(ResponseUtil.paginated(rows, pagination, 'Google Ads search terms retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error fetching Google Ads search terms', error, { projectId });
    return respondWithGoogleAdsError(res, error, 'Failed to fetch Google Ads search terms');
  }
};

/**
 * GET /projects/:projectId/google-ads/optimization-score?range=7|30|90|365
 * Current score/weight plus the historical trend series, in one request -
 * both read from GoogleAdsOptimizationHistory, never from Google.
 */
export const getGoogleAdsOptimizationScoreController = async (req, res) => {
  const { projectId } = req.params;
  LoggerUtil.info('Getting Google Ads optimization score', { projectId, userId: req.user._id.toString() });

  try {
    const ctx = await resolveProjectAndAdsConnection(req, res, { requireSelectedAccount: true });
    if (!ctx) return;

    const customerId = ctx.googleConnection.google_ads_customer_id;
    const { startDate, endDate, days, range: resolvedRange, cacheKey: rangeCacheKey } = await resolveDateRange(req, projectId, customerId);

    const cacheKey = getCacheKey('ads_optimization', ctx.googleConnection._id, customerId, rangeCacheKey);
    const cached = getCachedData(cacheKey);
    if (cached) {
      return res.json(ResponseUtil.success(cached, 'Google Ads optimization score retrieved successfully'));
    }

    const [latest, trend] = await Promise.all([
      GoogleAdsOptimizationHistory.getLatest(projectId, customerId),
      GoogleAdsOptimizationHistory.getTrend(projectId, customerId, startDate, endDate)
    ]);

    const result = {
      current: latest ? {
        score: latest.optimization_score,
        scorePercent: latest.optimization_score_percent,
        weight: latest.optimization_score_weight,
        asOf: latest.date
      } : null,
      trend: trend.map((t) => ({ date: t.date, scorePercent: t.optimization_score_percent, weight: t.optimization_score_weight })),
      range: { preset: resolvedRange, days }
    };

    setCachedData(cacheKey, result);
    LoggerUtil.info('Google Ads optimization score retrieved', { projectId, hasCurrent: !!latest, trendPoints: trend.length });
    return res.json(ResponseUtil.success(result, 'Google Ads optimization score retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error fetching Google Ads optimization score', error, { projectId });
    return respondWithGoogleAdsError(res, error, 'Failed to fetch Google Ads optimization score');
  }
};

/**
 * GET /projects/:projectId/google-ads/recommendations
 * Paginated, filterable recommendation list + a pending/applied/dismissed
 * status summary - reads persisted data.
 * Query params: page, limit, status, type, campaignId, includeResolved
 */
export const getGoogleAdsRecommendationsController = async (req, res) => {
  const { projectId } = req.params;
  const { page = 1, limit = 25, status = null, type = null, campaignId = null, includeResolved = false } = req.query;
  LoggerUtil.info('Getting Google Ads recommendations', { projectId, userId: req.user._id.toString(), page, limit });

  try {
    const ctx = await resolveProjectAndAdsConnection(req, res, { requireSelectedAccount: true });
    if (!ctx) return;

    const customerId = ctx.googleConnection.google_ads_customer_id;
    const cacheKey = getCacheKey('ads_recommendations', ctx.googleConnection._id, customerId, page, limit, status || 'all', type || 'all', campaignId || 'all', includeResolved);
    const cached = getCachedData(cacheKey);
    if (cached) {
      return res.json(ResponseUtil.success(
        { recommendations: cached.rows, summary: cached.summary },
        'Google Ads recommendations retrieved successfully',
        { pagination: cached.pagination }
      ));
    }

    const [{ rows, total, pages }, summary] = await Promise.all([
      GoogleAdsRecommendation.getProjectRecommendations(projectId, customerId, {
        page, limit, status, type, campaignId, includeResolved: includeResolved === 'true' || includeResolved === true
      }),
      GoogleAdsRecommendation.getStatusSummary(projectId, customerId)
    ]);

    const pagination = { page: Number(page) || 1, limit: Number(limit) || 25, total, pages };
    setCachedData(cacheKey, { rows, pagination, summary });

    LoggerUtil.info('Google Ads recommendations retrieved', { projectId, count: rows.length, total, summary });
    return res.json(ResponseUtil.success(
      { recommendations: rows, summary },
      'Google Ads recommendations retrieved successfully',
      { pagination }
    ));
  } catch (error) {
    LoggerUtil.error('Error fetching Google Ads recommendations', error, { projectId });
    return respondWithGoogleAdsError(res, error, 'Failed to fetch Google Ads recommendations');
  }
};

/**
 * POST /projects/:projectId/google-ads/recommendations/refresh
 * Triggers a background recommendation sync
 * (JOB_TYPES.GOOGLE_ADS_RECOMMENDATION_SYNC).
 */
export const refreshGoogleAdsRecommendationsController = async (req, res) => {
  const { projectId } = req.params;
  LoggerUtil.info('Refresh Google Ads recommendations requested', { projectId, userId: req.user._id.toString() });

  try {
    const ctx = await resolveProjectAndAdsConnection(req, res, { requireSelectedAccount: true });
    if (!ctx) return;

    const customerId = ctx.googleConnection.google_ads_customer_id;

    let job;
    try {
      job = await jobService.createAndDispatchGoogleAdsRecommendationSyncJob(ctx.userId, projectId, ctx.googleConnection._id.toString(), customerId);
    } catch (createError) {
      if (createError.code === 11000) {
        return res.status(409).json(ResponseUtil.conflict('A Google Ads recommendation sync is already in progress for this project.'));
      }
      throw createError;
    }

    runGoogleAdsRecommendationSync(job).catch((err) => {
      LoggerUtil.error('Unhandled error running GOOGLE_ADS_RECOMMENDATION_SYNC job', err, { jobId: job._id.toString(), projectId });
    });

    LoggerUtil.info('Google Ads recommendation sync job queued', { projectId, jobId: job._id.toString(), customerId });
    return res.status(202).json(ResponseUtil.success({ jobId: job._id.toString(), status: 'queued' }, 'Google Ads recommendation sync started'));
  } catch (error) {
    LoggerUtil.error('Error starting Google Ads recommendation sync', error, { projectId });
    return respondWithGoogleAdsError(res, error, 'Failed to start Google Ads recommendation sync');
  }
};

/**
 * GET /projects/:projectId/google-ads/campaigns/health
 * Server-side campaign health engine (googleAdsHealthService) - one
 * composite 0-100 score per campaign, computed from already-synced data.
 * Never computed in the frontend.
 */
export const getGoogleAdsCampaignHealthController = async (req, res) => {
  const { projectId } = req.params;
  LoggerUtil.info('Getting Google Ads campaign health', { projectId, userId: req.user._id.toString() });

  try {
    const ctx = await resolveProjectAndAdsConnection(req, res, { requireSelectedAccount: true });
    if (!ctx) return;

    const customerId = ctx.googleConnection.google_ads_customer_id;
    const cacheKey = getCacheKey('ads_health', ctx.googleConnection._id, customerId);
    const cached = getCachedData(cacheKey);
    if (cached) {
      return res.json(ResponseUtil.success(cached, 'Google Ads campaign health retrieved successfully'));
    }

    const health = await computeAllCampaignHealth(projectId, customerId);

    setCachedData(cacheKey, health);
    LoggerUtil.info('Google Ads campaign health computed', { projectId, campaignCount: health.length });
    return res.json(ResponseUtil.success(health, 'Google Ads campaign health retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error computing Google Ads campaign health', error, { projectId });
    return respondWithGoogleAdsError(res, error, 'Failed to compute Google Ads campaign health');
  }
};

/**
 * GET /projects/:projectId/google-ads/campaigns/health/summary
 *
 * Gap #3 (frontend integration audit) - the four account-wide tiles the
 * existing Campaign Health Grid widget renders (Budget Pacing / Quality
 * Score Avg / Ad Strength / Conversion Tracking), in ONE request. Does not
 * replace computeAllCampaignHealth/getGoogleAdsCampaignHealthController
 * above (the per-campaign engine) - this is an additional aggregation over
 * the same underlying data.
 */
export const getGoogleAdsCampaignHealthSummaryController = async (req, res) => {
  const { projectId } = req.params;
  LoggerUtil.info('Getting Google Ads account health summary', { projectId, userId: req.user._id.toString() });

  try {
    const ctx = await resolveProjectAndAdsConnection(req, res, { requireSelectedAccount: true });
    if (!ctx) return;

    const customerId = ctx.googleConnection.google_ads_customer_id;
    const cacheKey = getCacheKey('ads_health_summary', ctx.googleConnection._id, customerId);
    const cached = getCachedData(cacheKey);
    if (cached) {
      return res.json(ResponseUtil.success(cached, 'Google Ads account health summary retrieved successfully'));
    }

    // Budget Pacing needs the account-wide utilization percentage, already
    // computed by googleAdsBudgetService - composed here rather than
    // health service importing budget service (see
    // computeAccountHealthSummary's doc comment on why that would be circular).
    const overview = await getBudgetOverview(projectId, customerId);
    const summary = await computeAccountHealthSummary(projectId, customerId, { budgetHealth: overview.budgetHealth });

    setCachedData(cacheKey, summary);
    LoggerUtil.info('Google Ads account health summary computed', { projectId });
    return res.json(ResponseUtil.success(summary, 'Google Ads account health summary retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error computing Google Ads account health summary', error, { projectId });
    return respondWithGoogleAdsError(res, error, 'Failed to compute Google Ads account health summary');
  }
};

// ═══════════════════════════════════════════════════════════════════════
// Phase 6.5 — Device, Geographic, Audience, Ad Performance, Budget
// Analytics, Attribution, Capability Matrix
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /projects/:projectId/google-ads/device-performance?range=7|30|90|365
 * Account-wide device breakdown (desktop/mobile/tablet/...) summed over the
 * range, read from MongoDB - never calls Google.
 */
export const getGoogleAdsDevicePerformanceController = async (req, res) => {
  const { projectId } = req.params;
  LoggerUtil.info('Getting Google Ads device performance', { projectId, userId: req.user._id.toString() });

  try {
    const ctx = await resolveProjectAndAdsConnection(req, res, { requireSelectedAccount: true });
    if (!ctx) return;

    const customerId = ctx.googleConnection.google_ads_customer_id;
    const { startDate, endDate, days, range: resolvedRange, cacheKey: rangeCacheKey } = await resolveDateRange(req, projectId, customerId);

    const cacheKey = getCacheKey('ads_devices', ctx.googleConnection._id, customerId, rangeCacheKey);
    const cached = getCachedData(cacheKey);
    if (cached) return res.json(ResponseUtil.success(cached, 'Google Ads device performance retrieved successfully'));

    const breakdown = await GoogleAdsDevicePerformance.getBreakdown(projectId, customerId, startDate, endDate);
    const result = { devices: breakdown, range: { preset: resolvedRange, days } };

    setCachedData(cacheKey, result);
    LoggerUtil.info('Google Ads device performance retrieved', { projectId, deviceCount: breakdown.length });
    return res.json(ResponseUtil.success(result, 'Google Ads device performance retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error fetching Google Ads device performance', error, { projectId });
    return respondWithGoogleAdsError(res, error, 'Failed to fetch Google Ads device performance');
  }
};

/**
 * GET /projects/:projectId/google-ads/geo-performance?level=country|region|city
 * Paginated, filterable, sortable geographic performance list for one geo
 * level, read from MongoDB.
 */
export const getGoogleAdsGeoPerformanceController = async (req, res) => {
  const { projectId } = req.params;
  const { level = 'country', page = 1, limit = 25, search = null, sortBy = 'cost', sortOrder = -1 } = req.query;
  LoggerUtil.info('Getting Google Ads geo performance', { projectId, level, userId: req.user._id.toString() });

  try {
    const ctx = await resolveProjectAndAdsConnection(req, res, { requireSelectedAccount: true });
    if (!ctx) return;

    if (!['country', 'region', 'city'].includes(level)) {
      return res.status(400).json(ResponseUtil.error('level must be one of: country, region, city', 400));
    }

    const customerId = ctx.googleConnection.google_ads_customer_id;
    const cacheKey = getCacheKey('ads_geo', ctx.googleConnection._id, customerId, level, page, limit, search || '', sortBy, sortOrder);
    const cached = getCachedData(cacheKey);
    if (cached) {
      return res.json(ResponseUtil.paginated(cached.rows, cached.pagination, 'Google Ads geographic performance retrieved successfully'));
    }

    const { rows, total, pages } = await GoogleAdsGeoPerformance.getProjectGeoPerformance(projectId, customerId, level, {
      page, limit, search, sortBy, sortOrder: Number(sortOrder)
    });

    const pagination = { page: Number(page) || 1, limit: Number(limit) || 25, total, pages };
    setCachedData(cacheKey, { rows, pagination });

    LoggerUtil.info('Google Ads geo performance retrieved', { projectId, level, count: rows.length, total });
    return res.json(ResponseUtil.paginated(rows, pagination, 'Google Ads geographic performance retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error fetching Google Ads geo performance', error, { projectId });
    return respondWithGoogleAdsError(res, error, 'Failed to fetch Google Ads geographic performance');
  }
};

/**
 * GET /projects/:projectId/google-ads/audience-performance
 * All 6 audience dimensions bundled in one response (age, gender,
 * household income, affinity, in-market, audience segment) - one request,
 * same "frontend needs only one call" principle as the KPI Overview.
 */
export const getGoogleAdsAudiencePerformanceController = async (req, res) => {
  const { projectId } = req.params;
  LoggerUtil.info('Getting Google Ads audience performance', { projectId, userId: req.user._id.toString() });

  try {
    const ctx = await resolveProjectAndAdsConnection(req, res, { requireSelectedAccount: true });
    if (!ctx) return;

    const customerId = ctx.googleConnection.google_ads_customer_id;
    const cacheKey = getCacheKey('ads_audience', ctx.googleConnection._id, customerId);
    const cached = getCachedData(cacheKey);
    if (cached) return res.json(ResponseUtil.success(cached, 'Google Ads audience performance retrieved successfully'));

    const dimensionTypes = ['age', 'gender', 'household_income', 'affinity', 'in_market', 'audience_segment'];
    const results = await Promise.all(dimensionTypes.map((type) => GoogleAdsAudiencePerformance.getByDimensionType(projectId, customerId, type)));

    const result = dimensionTypes.reduce((acc, type, i) => {
      acc[type] = results[i];
      return acc;
    }, {});

    setCachedData(cacheKey, result);
    LoggerUtil.info('Google Ads audience performance retrieved', { projectId });
    return res.json(ResponseUtil.success(result, 'Google Ads audience performance retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error fetching Google Ads audience performance', error, { projectId });
    return respondWithGoogleAdsError(res, error, 'Failed to fetch Google Ads audience performance');
  }
};

/**
 * GET /projects/:projectId/google-ads/ads
 * Paginated, filterable, sortable ad list (Responsive Search/Display/
 * Video/Shopping/legacy formats - see GoogleAdsAd.js), read from MongoDB.
 */
/**
 * GET /projects/:projectId/google-ads/ads
 * GET /projects/:projectId/google-ads/ads?groupBy=ad_type
 *
 * Gap #6 (frontend integration audit): ?groupBy=ad_type switches this same
 * endpoint from the paginated individual-ad list to the 5-bucket
 * aggregation (Responsive Search/Performance Max/Display/Video/Shopping)
 * the existing Ad Performance card renders - one aggregation pipeline
 * (GoogleAdsAd.getAdTypeGroupSummary), not a second endpoint, and not a
 * client-side re-bucketing of the individual-ad list.
 */
export const getGoogleAdsAdPerformanceController = async (req, res) => {
  const { projectId } = req.params;
  const { page = 1, limit = 25, campaignId = null, adType = null, includeRemoved = false, sortBy = 'cost', sortOrder = -1, groupBy = null } = req.query;
  LoggerUtil.info('Getting Google Ads ad performance', { projectId, userId: req.user._id.toString(), page, limit, groupBy });

  try {
    const ctx = await resolveProjectAndAdsConnection(req, res, { requireSelectedAccount: true });
    if (!ctx) return;

    const customerId = ctx.googleConnection.google_ads_customer_id;

    if (groupBy === 'ad_type') {
      const cacheKey = getCacheKey('ads_ads_grouped', ctx.googleConnection._id, customerId);
      const cached = getCachedData(cacheKey);
      if (cached) {
        return res.json(ResponseUtil.success(cached, 'Google Ads ad performance (grouped) retrieved successfully'));
      }

      const groups = await GoogleAdsAd.getAdTypeGroupSummary(projectId, customerId);
      setCachedData(cacheKey, groups);

      LoggerUtil.info('Google Ads ad performance (grouped) retrieved', { projectId, groupCount: groups.length });
      return res.json(ResponseUtil.success(groups, 'Google Ads ad performance (grouped) retrieved successfully'));
    }

    const cacheKey = getCacheKey('ads_ads', ctx.googleConnection._id, customerId, page, limit, campaignId || 'all', adType || 'all', includeRemoved, sortBy, sortOrder);
    const cached = getCachedData(cacheKey);
    if (cached) {
      return res.json(ResponseUtil.paginated(cached.rows, cached.pagination, 'Google Ads ad performance retrieved successfully'));
    }

    const { rows, total, pages } = await GoogleAdsAd.getProjectAds(projectId, customerId, {
      page, limit, campaignId, adType, includeRemoved: includeRemoved === 'true' || includeRemoved === true, sortBy, sortOrder: Number(sortOrder)
    });

    const pagination = { page: Number(page) || 1, limit: Number(limit) || 25, total, pages };
    setCachedData(cacheKey, { rows, pagination });

    LoggerUtil.info('Google Ads ad performance retrieved', { projectId, count: rows.length, total });
    return res.json(ResponseUtil.paginated(rows, pagination, 'Google Ads ad performance retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error fetching Google Ads ad performance', error, { projectId });
    return respondWithGoogleAdsError(res, error, 'Failed to fetch Google Ads ad performance');
  }
};

/**
 * GET /projects/:projectId/google-ads/budget/overview
 * Daily/monthly budget, spend, remaining, utilization, burn rate, per-
 * campaign budget health, and active budget alerts - one request, all
 * computed server-side from already-synced data. Never calls Google.
 */
export const getGoogleAdsBudgetOverviewController = async (req, res) => {
  const { projectId } = req.params;
  LoggerUtil.info('Getting Google Ads budget overview', { projectId, userId: req.user._id.toString() });

  try {
    const ctx = await resolveProjectAndAdsConnection(req, res, { requireSelectedAccount: true });
    if (!ctx) return;

    const customerId = ctx.googleConnection.google_ads_customer_id;
    const cacheKey = getCacheKey('ads_budget', ctx.googleConnection._id, customerId);
    const cached = getCachedData(cacheKey);
    if (cached) return res.json(ResponseUtil.success(cached, 'Google Ads budget overview retrieved successfully'));

    const [overview, campaignHealth, activeAlerts] = await Promise.all([
      getBudgetOverview(projectId, customerId),
      getCampaignBudgetHealth(projectId, customerId),
      GoogleAdsBudgetAlert.getActiveAlerts(projectId, customerId)
    ]);

    const result = { overview, campaignBudgetHealth: campaignHealth, alerts: activeAlerts };
    setCachedData(cacheKey, result);

    LoggerUtil.info('Google Ads budget overview retrieved', { projectId, alertCount: activeAlerts.length });
    return res.json(ResponseUtil.success(result, 'Google Ads budget overview retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error fetching Google Ads budget overview', error, { projectId });
    return respondWithGoogleAdsError(res, error, 'Failed to fetch Google Ads budget overview');
  }
};

/**
 * GET /projects/:projectId/google-ads/budget/forecast
 * Linear burn-rate-based projected spend for the rest of the current
 * calendar month, computed server-side. Never calls Google.
 */
export const getGoogleAdsBudgetForecastController = async (req, res) => {
  const { projectId } = req.params;
  LoggerUtil.info('Getting Google Ads budget forecast', { projectId, userId: req.user._id.toString() });

  try {
    const ctx = await resolveProjectAndAdsConnection(req, res, { requireSelectedAccount: true });
    if (!ctx) return;

    const customerId = ctx.googleConnection.google_ads_customer_id;
    const cacheKey = getCacheKey('ads_forecast', ctx.googleConnection._id, customerId);
    const cached = getCachedData(cacheKey);
    if (cached) return res.json(ResponseUtil.success(cached, 'Google Ads budget forecast retrieved successfully'));

    const forecast = await getBudgetForecast(projectId, customerId);

    setCachedData(cacheKey, forecast);
    LoggerUtil.info('Google Ads budget forecast retrieved', { projectId, forecastStatus: forecast.forecastStatus });
    return res.json(ResponseUtil.success(forecast, 'Google Ads budget forecast retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error fetching Google Ads budget forecast', error, { projectId });
    return respondWithGoogleAdsError(res, error, 'Failed to fetch Google Ads budget forecast');
  }
};

/**
 * GET /projects/:projectId/google-ads/attribution
 * Attribution model per conversion action, top conversion sources, and the
 * account-wide click-vs-view-through conversion split - read from MongoDB.
 * "Conversion Paths" and "Assist Conversions" are honestly reported as
 * unavailable (`pathDataAvailable: false`) rather than fabricated - see
 * GoogleAdsConversionAction.js's file-level doc comment for why: no such
 * GAQL-queryable resource exists in the standard Google Ads API.
 */
export const getGoogleAdsAttributionController = async (req, res) => {
  const { projectId } = req.params;
  LoggerUtil.info('Getting Google Ads attribution data', { projectId, userId: req.user._id.toString() });

  try {
    const ctx = await resolveProjectAndAdsConnection(req, res, { requireSelectedAccount: true });
    if (!ctx) return;

    const customerId = ctx.googleConnection.google_ads_customer_id;
    const cacheKey = getCacheKey('ads_attribution', ctx.googleConnection._id, customerId);
    const cached = getCachedData(cacheKey);
    if (cached) return res.json(ResponseUtil.success(cached, 'Google Ads attribution data retrieved successfully'));

    const [topSources, attributionSplit] = await Promise.all([
      GoogleAdsConversionAction.getTopSources(projectId, customerId),
      GoogleAdsConversionAction.getAttributionSplit(projectId, customerId)
    ]);

    const result = {
      topConversionSources: topSources,
      clickAttribution: { conversions: attributionSplit.clickConversions, percentage: attributionSplit.clickAttributionPct },
      viewAttribution: { conversions: attributionSplit.viewThroughConversions, percentage: attributionSplit.viewAttributionPct },
      totalConversionsValue: attributionSplit.totalConversionsValue,
      // Honest platform-limitation flags - see doc comment above.
      conversionPathsAvailable: false,
      assistConversionsAvailable: false
    };

    setCachedData(cacheKey, result);
    LoggerUtil.info('Google Ads attribution data retrieved', { projectId, sourceCount: topSources.length });
    return res.json(ResponseUtil.success(result, 'Google Ads attribution data retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error fetching Google Ads attribution data', error, { projectId });
    return respondWithGoogleAdsError(res, error, 'Failed to fetch Google Ads attribution data');
  }
};

/**
 * GET /projects/:projectId/google-ads/capabilities
 * The capability matrix - which Google Ads dashboard features have real
 * data behind them for this account, computed from observed sync outcomes
 * (see googleAdsCapabilityService.js). The frontend reads this instead of
 * guessing.
 */
export const getGoogleAdsCapabilitiesController = async (req, res) => {
  const { projectId } = req.params;
  LoggerUtil.info('Getting Google Ads capability matrix', { projectId, userId: req.user._id.toString() });

  try {
    const ctx = await resolveProjectAndAdsConnection(req, res, { requireSelectedAccount: true });
    if (!ctx) return;

    const cacheKey = getCacheKey('ads_capabilities', ctx.googleConnection._id);
    const cached = getCachedData(cacheKey);
    if (cached) return res.json(ResponseUtil.success(cached, 'Google Ads capability matrix retrieved successfully'));

    const capabilities = await getCapabilities(ctx.googleConnection);

    setCachedData(cacheKey, capabilities);
    LoggerUtil.info('Google Ads capability matrix retrieved', { projectId, capabilities });
    return res.json(ResponseUtil.success(capabilities, 'Google Ads capability matrix retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error fetching Google Ads capability matrix', error, { projectId });
    return respondWithGoogleAdsError(res, error, 'Failed to fetch Google Ads capability matrix');
  }
};

/**
 * GET /projects/:projectId/google-ads/activity
 * Recent Activity Feed (Gap #7, frontend integration audit) - merges Sync
 * History, Recommendations, Budget Alerts, Campaign Changes, and
 * Optimization Events into one normalized, timestamp-sorted list. Entirely
 * derived from data already persisted by prior syncs (see
 * googleAdsActivityService.js) - never calls Google.
 */
export const getGoogleAdsActivityController = async (req, res) => {
  const { projectId } = req.params;
  const { limit = 20, lookbackDays = 14 } = req.query;
  LoggerUtil.info('Getting Google Ads activity feed', { projectId, userId: req.user._id.toString(), limit, lookbackDays });

  try {
    const ctx = await resolveProjectAndAdsConnection(req, res, { requireSelectedAccount: true });
    if (!ctx) return;

    const customerId = ctx.googleConnection.google_ads_customer_id;
    const cacheKey = getCacheKey('ads_activity', ctx.googleConnection._id, customerId, limit, lookbackDays);
    const cached = getCachedData(cacheKey);
    if (cached) return res.json(ResponseUtil.success(cached, 'Google Ads activity feed retrieved successfully'));

    const activity = await getGoogleAdsActivityFeed(projectId, customerId, {
      limit: Number(limit) || 20,
      lookbackDays: Number(lookbackDays) || 14
    });

    setCachedData(cacheKey, activity);
    LoggerUtil.info('Google Ads activity feed retrieved', { projectId, count: activity.length });
    return res.json(ResponseUtil.success(activity, 'Google Ads activity feed retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error fetching Google Ads activity feed', error, { projectId });
    return respondWithGoogleAdsError(res, error, 'Failed to fetch Google Ads activity feed');
  }
};
