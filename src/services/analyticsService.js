import {
  getAuthenticatedHttpClient,
  withRetry,
  logAxiosError,
  getCacheKey,
  getCachedData,
  setCachedData,
  clearCacheEntries
} from './businessProfileService.js';
import {
  AnalyticsMapper,
  TREND_METRIC_NAMES,
  CHANNEL_METRIC_NAMES,
  EVENT_METRIC_NAMES
} from '../modules/app_user/mapper/analyticsMapper.js';

/**
 * Analytics API Service
 *
 * Google Analytics GA4 Data API and Admin API - property discovery and
 * performance data fetching with backfill/incremental sync support.
 *
 * Reuses businessProfileService.js's generic HTTP/retry/cache helpers
 * rather than reimplementing them (same pattern as searchConsoleService.js).
 *
 * Confirmed current, official GA4 API hosts (not Universal Analytics,
 * which Google fully shut down in July 2023 and which does not appear
 * anywhere in this codebase).
 */

const ANALYTICS_ADMIN_API_BASE = 'https://analyticsadmin.googleapis.com/v1beta';
const ANALYTICS_DATA_API_BASE = 'https://analyticsdata.googleapis.com/v1beta';

async function getAuthenticatedDataClient(googleConnection) {
  return getAuthenticatedHttpClient(googleConnection, ANALYTICS_DATA_API_BASE);
}

async function getAuthenticatedAdminClient(googleConnection) {
  return getAuthenticatedHttpClient(googleConnection, ANALYTICS_ADMIN_API_BASE);
}

/**
 * Get list of accessible Analytics properties (cached, retried).
 */
export async function getAnalyticsProperties(googleConnection) {
  const cacheKey = getCacheKey('ga_properties', googleConnection._id);
  const cached = getCachedData(cacheKey);
  if (cached) return cached;

  try {
    console.log('[ANALYTICS] Fetching accessible properties');

    const client = await getAuthenticatedAdminClient(googleConnection);
    const response = await withRetry(() => client.get('/accountSummaries'));

    if (!response.data?.accountSummaries || !Array.isArray(response.data.accountSummaries)) {
      console.log('[ANALYTICS] No account summaries found');
      return [];
    }

    const properties = [];
    for (const accountSummary of response.data.accountSummaries) {
      if (Array.isArray(accountSummary.propertySummaries)) {
        for (const propertySummary of accountSummary.propertySummaries) {
          properties.push({
            propertyId: propertySummary.property.replace('properties/', ''),
            displayName: propertySummary.displayName,
            websiteUrl: propertySummary.websiteUrl || null
          });
        }
      }
    }

    console.log('[ANALYTICS] Found accessible properties:', { count: properties.length });

    setCachedData(cacheKey, properties);
    return properties;

  } catch (error) {
    logAxiosError('getAnalyticsProperties', error);

    if (error.response?.status === 403) {
      throw new Error('Access denied: User does not have Analytics permissions. Please ensure the user has at least one Analytics property with read access.');
    }
    if (error.response?.status === 401) {
      throw new Error('Authentication failed: Invalid or expired credentials');
    }

    throw new Error(`Failed to fetch Analytics properties: ${error.message}`);
  }
}

/**
 * Validate access to a specific Analytics property.
 */
export async function validateAnalyticsPropertyAccess(googleConnection, propertyId) {
  const properties = await getAnalyticsProperties(googleConnection);
  const hasAccess = properties.some(prop => prop.propertyId === propertyId);

  if (!hasAccess) {
    throw new Error(`Property ${propertyId} not found in user's accessible properties`);
  }

  return true;
}

/**
 * Fetch Analytics performance data using the Data API.
 *
 * @param {Object} googleConnection
 * @param {string} propertyId
 * @param {Object} [options]
 * @param {number} [options.days=28] - Lookback window. Controller passes a
 *   larger value for a first-ever sync and a small rolling value for
 *   incremental syncs - see analyticsController.js. GA4 has no API-imposed
 *   historical ceiling (unlike Search Console's 16 months), but the same
 *   backfill/incremental split still applies: re-pulling full history on
 *   every sync burns quota (200,000 tokens/property/day, see Data API
 *   quotas) for data that, past a few days, does not change again.
 */
export async function getAnalyticsPerformanceData(googleConnection, propertyId, options = {}) {
  const { days = 28 } = options;

  try {
    console.log('[ANALYTICS] Fetching performance data', { propertyId, days });

    const client = await getAuthenticatedDataClient(googleConnection);

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(endDate.getDate() - days);

    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];

    const requestBody = {
      property: `properties/${propertyId}`,
      dateRanges: [{ startDate: startDateStr, endDate: endDateStr }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [
        { name: 'sessions' },
        { name: 'activeUsers' },
        { name: 'screenPageViews' },
        { name: 'engagementRate' }
      ],
      limit: 50,
      keepEmptyRows: false
    };

    const response = await withRetry(() => client.post(`properties/${propertyId}:runReport`, requestBody));

    if (!response.data || !response.data.rows) {
      console.log('[ANALYTICS] No performance data available for this range');
      return { data: [], syncedPages: 0, skippedPages: 0, dateRange: { start: startDateStr, end: endDateStr } };
    }

    const rawData = response.data.rows;

    const normalizeRow = (row) => {
      if (!row || !Array.isArray(row.dimensionValues) || row.dimensionValues.length === 0) return null;
      if (!Array.isArray(row.metricValues) || row.metricValues.length === 0) return null;

      const pagePath = row.dimensionValues[0]?.value || '';
      const sessions = parseInt(row.metricValues[0]?.value || '0', 10);
      const pageViews = parseInt(row.metricValues[2]?.value || '0', 10);

      if (!pagePath && sessions === 0 && pageViews === 0) return null;

      return {
        page_path: pagePath,
        sessions,
        active_users: parseInt(row.metricValues[1]?.value || '0', 10),
        page_views: pageViews,
        engagement_rate: parseFloat(row.metricValues[3]?.value || '0')
      };
    };

    const normalizedData = rawData.map(normalizeRow).filter(Boolean);
    const skippedCount = rawData.length - normalizedData.length;

    console.log('[ANALYTICS] Normalized performance data', {
      rowsIn: rawData.length,
      rowsOut: normalizedData.length,
      skipped: skippedCount
    });

    return {
      data: normalizedData,
      syncedPages: normalizedData.length,
      skippedPages: skippedCount,
      dateRange: { start: startDateStr, end: endDateStr }
    };

  } catch (error) {
    logAxiosError('getAnalyticsPerformanceData', error);

    if (error.response?.status === 403) {
      throw new Error(`Access denied: No permission for property ${propertyId}`);
    }
    if (error.response?.status === 404) {
      throw new Error(`Property not found: ${propertyId}`);
    }
    if (error.response?.status === 400) {
      const errorDetails = error.response?.data?.error?.message || error.message;
      throw new Error(`Invalid request: ${errorDetails}`);
    }

    throw new Error(`Failed to fetch Analytics performance data: ${error.message}`);
  }
}

/**
 * Complete workflow: validate property and fetch performance data.
 *
 * @param {Object} [options] - forwarded to getAnalyticsPerformanceData (days)
 */
export async function getProjectAnalyticsData(googleConnection, propertyId, options = {}) {
  await validateAnalyticsPropertyAccess(googleConnection, propertyId);
  const performanceResult = await getAnalyticsPerformanceData(googleConnection, propertyId, options);

  console.log('[ANALYTICS] Workflow completed', {
    propertyId,
    dataPoints: performanceResult.data.length
  });

  return performanceResult;
}

/**
 * Fetch daily Analytics trends (Users, New Users, Sessions, Engaged
 * Sessions, Views, Avg. Engagement Time, Bounce Rate, Conversions) in a
 * single GA4 Data API runReport call - one Google request powers the Hero
 * KPI grid, the Traffic Trends chart, and Today's Summary on the frontend,
 * per the approved Phase 1 blueprint (do not split these into separate
 * endpoints/requests).
 *
 * Cached like every other Business Profile/Analytics report in this
 * codebase (getCacheKey/getCachedData/setCachedData, 10-minute TTL - see
 * businessProfileService.js) - the cache holds the already-mapped
 * {series, totals} shape, not the raw Google response, mirroring
 * getBusinessProfileDailyMetricsTimeSeries's cache-the-pivoted-result
 * pattern in businessProfileService.js.
 *
 * @param {Object} googleConnection
 * @param {string} propertyId
 * @param {Object} [options]
 * @param {number} [options.days=30] - lookback window (7/30/90/365, validated by the controller)
 */
export async function getAnalyticsTrendsSeries(googleConnection, propertyId, options = {}) {
  const { days = 30 } = options;
  const cacheKey = getCacheKey('ga_trends', googleConnection._id, propertyId, days);
  const cached = getCachedData(cacheKey);
  if (cached) return cached;

  try {
    console.log('[ANALYTICS] Fetching trends series', { propertyId, days });

    const client = await getAuthenticatedDataClient(googleConnection);

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(endDate.getDate() - days);
    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];

    const requestBody = {
      property: `properties/${propertyId}`,
      dateRanges: [{ startDate: startDateStr, endDate: endDateStr }],
      dimensions: [{ name: 'date' }],
      metrics: TREND_METRIC_NAMES.map((name) => ({ name })),
      orderBys: [{ dimension: { dimensionName: 'date' } }],
      // 400 safely covers the largest supported range (365 days) with
      // headroom - well under GA4's own row-limit ceiling, and keeps the
      // response bounded regardless of what range a caller passes.
      limit: 400,
      keepEmptyRows: false
    };

    const response = await withRetry(() => client.post(`properties/${propertyId}:runReport`, requestBody));

    const { series, totals } = AnalyticsMapper.toTrendsSeries(response.data?.rows || []);
    const result = { series, totals, dateRange: { start: startDateStr, end: endDateStr } };

    console.log('[ANALYTICS] Trends series fetched', { propertyId, days, points: series.length });

    setCachedData(cacheKey, result);
    return result;

  } catch (error) {
    logAxiosError('getAnalyticsTrendsSeries', error);

    if (error.response?.status === 403) {
      throw new Error(`Access denied: No permission for property ${propertyId}`);
    }
    if (error.response?.status === 404) {
      throw new Error(`Property not found: ${propertyId}`);
    }
    if (error.response?.status === 429) {
      throw new Error('Google Analytics rate limit reached. Please try again shortly.');
    }
    if (error.response?.status === 400) {
      const errorDetails = error.response?.data?.error?.message || error.message;
      throw new Error(`Invalid request: ${errorDetails}`);
    }

    throw new Error(`Failed to fetch Analytics trends: ${error.message}`);
  }
}

/**
 * Fetch GA4 property facts (display name, website URL, Measurement ID,
 * timezone) for the Analytics Header / Property card. Two lightweight
 * Admin API calls (properties.get + dataStreams.list), run in parallel,
 * cached together as one entry - property facts change rarely, but reuse
 * the same shared 10-minute cache helper as everything else rather than
 * introducing a second cache mechanism with its own TTL.
 *
 * Deliberately NOT persisted to GoogleConnection or any collection - kept
 * out of the OAuth document entirely per the Phase 1 database constraints
 * (no new collections, no unrelated fields on GoogleConnection). If a
 * future phase decides these facts need to survive a server restart, that
 * is a distinct, explicit decision - not a side effect of this phase.
 *
 * @param {Object} googleConnection
 * @param {string} propertyId
 */
export async function getAnalyticsPropertyDetails(googleConnection, propertyId) {
  const cacheKey = getCacheKey('ga_property', googleConnection._id, propertyId);
  const cached = getCachedData(cacheKey);
  if (cached) return cached;

  try {
    console.log('[ANALYTICS] Fetching property details', { propertyId });

    const client = await getAuthenticatedAdminClient(googleConnection);

    const [propertyResponse, streamsResponse] = await Promise.all([
      withRetry(() => client.get(`/properties/${propertyId}`)),
      withRetry(() => client.get(`/properties/${propertyId}/dataStreams`))
    ]);

    const details = AnalyticsMapper.toPropertyDetails(
      propertyResponse.data,
      streamsResponse.data?.dataStreams || []
    );

    console.log('[ANALYTICS] Property details fetched', { propertyId, hasMeasurementId: !!details.measurementId });

    setCachedData(cacheKey, details);
    return details;

  } catch (error) {
    logAxiosError('getAnalyticsPropertyDetails', error);

    if (error.response?.status === 403) {
      throw new Error(`Access denied: No permission for property ${propertyId}`);
    }
    if (error.response?.status === 404) {
      throw new Error(`Property not found: ${propertyId}`);
    }
    if (error.response?.status === 429) {
      throw new Error('Google Analytics rate limit reached. Please try again shortly.');
    }

    throw new Error(`Failed to fetch Analytics property details: ${error.message}`);
  }
}

function toDateStr(date) {
  return date.toISOString().split('T')[0];
}

/**
 * Fetch Traffic Sources, Top Channels, Countries, Devices, Browsers and
 * Operating Systems in ONE Google request via batchRunReports (5 bundled
 * sub-reports, 1 HTTP round-trip) - per the Phase 2 blueprint, this
 * replaces what would otherwise be 5+ independent runReport calls.
 *
 * Cached like getAnalyticsTrendsSeries: the mapped {sources, channels,
 * countries, devices, browsers, operatingSystems} shape, not the raw
 * batchRunReports response.
 *
 * @param {Object} googleConnection
 * @param {string} propertyId
 * @param {Object} [options]
 * @param {number} [options.days=30]
 */
export async function getAnalyticsBreakdowns(googleConnection, propertyId, options = {}) {
  const { days = 30 } = options;
  const cacheKey = getCacheKey('ga_breakdowns', googleConnection._id, propertyId, days);
  const cached = getCachedData(cacheKey);
  if (cached) return cached;

  try {
    console.log('[ANALYTICS] Fetching breakdowns (batchRunReports)', { propertyId, days });

    const client = await getAuthenticatedDataClient(googleConnection);

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(endDate.getDate() - days);
    const dateRanges = [{ startDate: toDateStr(startDate), endDate: toDateStr(endDate) }];

    // Fixed request order - AnalyticsMapper.toBreakdownDTO destructures
    // `reports` by this same position (channels, countries, devices,
    // browsers, operatingSystems). Each sub-request omits `property` -
    // implied by the batchRunReports URL itself, applies to every bundled
    // sub-report.
    const requestBody = {
      requests: [
        {
          dateRanges,
          dimensions: [{ name: 'sessionDefaultChannelGroup' }],
          metrics: CHANNEL_METRIC_NAMES.map((name) => ({ name })),
          orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
          limit: 10
        },
        {
          dateRanges,
          dimensions: [{ name: 'country' }, { name: 'countryId' }],
          metrics: [{ name: 'activeUsers' }],
          orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
          limit: 10
        },
        {
          dateRanges,
          dimensions: [{ name: 'deviceCategory' }],
          metrics: [{ name: 'sessions' }],
          orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
          limit: 10
        },
        {
          dateRanges,
          dimensions: [{ name: 'browser' }],
          metrics: [{ name: 'sessions' }],
          orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
          limit: 10
        },
        {
          dateRanges,
          dimensions: [{ name: 'operatingSystem' }],
          metrics: [{ name: 'sessions' }],
          orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
          limit: 10
        }
      ]
    };

    const response = await withRetry(() => client.post(`properties/${propertyId}:batchRunReports`, requestBody));

    const breakdowns = AnalyticsMapper.toBreakdownDTO(response.data?.reports || []);
    const result = { ...breakdowns, dateRange: { start: toDateStr(startDate), end: toDateStr(endDate) } };

    console.log('[ANALYTICS] Breakdowns fetched', {
      propertyId,
      channelCount: result.channels.length,
      countryCount: result.countries.length,
      deviceCount: result.devices.length
    });

    setCachedData(cacheKey, result);
    return result;

  } catch (error) {
    logAxiosError('getAnalyticsBreakdowns', error);

    if (error.response?.status === 403) {
      throw new Error(`Access denied: No permission for property ${propertyId}`);
    }
    if (error.response?.status === 404) {
      throw new Error(`Property not found: ${propertyId}`);
    }
    if (error.response?.status === 429) {
      throw new Error('Google Analytics rate limit reached. Please try again shortly.');
    }
    if (error.response?.status === 400) {
      const errorDetails = error.response?.data?.error?.message || error.message;
      throw new Error(`Invalid request: ${errorDetails}`);
    }

    throw new Error(`Failed to fetch Analytics breakdowns: ${error.message}`);
  }
}

/**
 * Single cached Google fetch shared by getAnalyticsEventsData and
 * getAnalyticsConversionsData - one eventName-dimensioned runReport call
 * (with 2 dateRanges, for period-over-period trend) powers both the Events
 * and Conversions widgets. Not exported: callers only ever want one of the
 * two mapped DTOs, never these raw rows directly.
 *
 * limit:100 (not 10) - the Events endpoint trims to its own top-N in the
 * mapper, but the Conversions endpoint needs the full conversion-flagged
 * set (which is typically NOT the top-10-by-count events) to bucket
 * correctly, so the shared raw fetch has to stay wide enough for both.
 */
async function fetchAnalyticsEventsRawReport(googleConnection, propertyId, days) {
  const cacheKey = getCacheKey('ga_events', googleConnection._id, propertyId, days);
  const cached = getCachedData(cacheKey);
  if (cached) return cached;

  console.log('[ANALYTICS] Fetching events report', { propertyId, days });

  const client = await getAuthenticatedDataClient(googleConnection);

  const currentEnd = new Date();
  const currentStart = new Date();
  currentStart.setDate(currentEnd.getDate() - days);
  // Immediately-preceding, non-overlapping window of the same length -
  // the standard period-over-period comparison window.
  const previousEnd = new Date(currentStart);
  const previousStart = new Date(previousEnd);
  previousStart.setDate(previousEnd.getDate() - days);

  const requestBody = {
    property: `properties/${propertyId}`,
    // Order matters: index 0 = previous period, index 1 = current period -
    // AnalyticsMapper.groupEventRows reads GA4's auto-appended
    // 'date_range_0'/'date_range_1' dimension value against this exact
    // ordering.
    dateRanges: [
      { startDate: toDateStr(previousStart), endDate: toDateStr(previousEnd) },
      { startDate: toDateStr(currentStart), endDate: toDateStr(currentEnd) }
    ],
    dimensions: [{ name: 'eventName' }],
    metrics: EVENT_METRIC_NAMES.map((name) => ({ name })),
    orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
    limit: 100,
    keepEmptyRows: false
  };

  const response = await withRetry(() => client.post(`properties/${propertyId}:runReport`, requestBody));
  const rawRows = response.data?.rows || [];

  const result = {
    rawRows,
    dateRange: {
      current: { start: toDateStr(currentStart), end: toDateStr(currentEnd) },
      previous: { start: toDateStr(previousStart), end: toDateStr(previousEnd) }
    }
  };

  setCachedData(cacheKey, result);
  return result;
}

function handleEventsReportError(error, propertyId, label) {
  logAxiosError(label, error);

  if (error.response?.status === 403) {
    throw new Error(`Access denied: No permission for property ${propertyId}`);
  }
  if (error.response?.status === 404) {
    throw new Error(`Property not found: ${propertyId}`);
  }
  if (error.response?.status === 429) {
    throw new Error('Google Analytics rate limit reached. Please try again shortly.');
  }
  if (error.response?.status === 400) {
    const errorDetails = error.response?.data?.error?.message || error.message;
    throw new Error(`Invalid request: ${errorDetails}`);
  }

  throw new Error(`Failed to fetch Analytics events: ${error.message}`);
}

/**
 * Top events by count, with period-over-period trend. Shares its Google
 * fetch with getAnalyticsConversionsData via fetchAnalyticsEventsRawReport's
 * cache - calling both in the same 10-minute window costs exactly one
 * Google request, not two, regardless of which endpoint is hit first.
 */
export async function getAnalyticsEventsData(googleConnection, propertyId, options = {}) {
  const { days = 30, limit = 10 } = options;

  try {
    const { rawRows, dateRange } = await fetchAnalyticsEventsRawReport(googleConnection, propertyId, days);
    const { events } = AnalyticsMapper.toEventsDTO(rawRows, { limit });
    return { events, dateRange: dateRange.current };
  } catch (error) {
    handleEventsReportError(error, propertyId, 'getAnalyticsEventsData');
  }
}

/**
 * Conversion events bucketed into named categories (Purchases/Leads/
 * Newsletter/Downloads/Form Submissions/Other). Shares its Google fetch
 * with getAnalyticsEventsData - see fetchAnalyticsEventsRawReport.
 */
export async function getAnalyticsConversionsData(googleConnection, propertyId, options = {}) {
  const { days = 30 } = options;

  try {
    const { rawRows, dateRange } = await fetchAnalyticsEventsRawReport(googleConnection, propertyId, days);
    const { conversions, totalConversions } = AnalyticsMapper.toConversionsDTO(rawRows);
    return { conversions, totalConversions, dateRange: dateRange.current };
  } catch (error) {
    handleEventsReportError(error, propertyId, 'getAnalyticsConversionsData');
  }
}

/**
 * Realtime active-user snapshot (Active Users, Active Pages, Active
 * Countries, Active Devices) - 3 independent runRealtimeReport calls, run
 * in parallel via Promise.all.
 *
 * Deliberately NOT batched into 1 request: combining unifiedScreenName +
 * country + deviceCategory as multiple dimensions on one runRealtimeReport
 * would return their cross-tabulation (rows for every page×country×device
 * combination), not the 3 independent single-dimension breakdowns this
 * widget needs. No batch variant of runRealtimeReport (a
 * "batchRunRealtimeReports") is used anywhere in this codebase, and its
 * existence in the current GA4 Data API v1beta surface could not be
 * verified from this codebase alone - if Google does offer one, bundling
 * these 3 calls into it is a safe, isolated future optimization, not a
 * blocker for this phase.
 *
 * Never cached (per the Phase 2/3 rule: realtime is always live) - no
 * getCacheKey/getCachedData/setCachedData calls anywhere in this function.
 *
 * @param {Object} googleConnection
 * @param {string} propertyId
 */
export async function getAnalyticsRealtimeData(googleConnection, propertyId) {
  try {
    console.log('[ANALYTICS] Fetching realtime data', { propertyId });

    const client = await getAuthenticatedDataClient(googleConnection);

    const [pagesResponse, countriesResponse, devicesResponse] = await Promise.all([
      withRetry(() => client.post(`properties/${propertyId}:runRealtimeReport`, {
        dimensions: [{ name: 'unifiedScreenName' }],
        metrics: [{ name: 'activeUsers' }],
        orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
        limit: 5
      })),
      withRetry(() => client.post(`properties/${propertyId}:runRealtimeReport`, {
        dimensions: [{ name: 'country' }],
        metrics: [{ name: 'activeUsers' }],
        orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
        limit: 5
      })),
      // limit:10 covers deviceCategory's small, exhaustive value set
      // (desktop/mobile/tablet) with headroom - unlike the two lists
      // above, this one is summed for the activeUsers total below, so it
      // must not be truncated.
      withRetry(() => client.post(`properties/${propertyId}:runRealtimeReport`, {
        dimensions: [{ name: 'deviceCategory' }],
        metrics: [{ name: 'activeUsers' }],
        orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
        limit: 10
      }))
    ]);

    const realtime = AnalyticsMapper.toRealtimeDTO({
      pagesReport: pagesResponse.data,
      countriesReport: countriesResponse.data,
      devicesReport: devicesResponse.data
    });

    console.log('[ANALYTICS] Realtime data fetched', { propertyId, activeUsers: realtime.activeUsers });

    return realtime;

  } catch (error) {
    logAxiosError('getAnalyticsRealtimeData', error);

    if (error.response?.status === 403) {
      throw new Error(`Access denied: No permission for property ${propertyId}`);
    }
    if (error.response?.status === 404) {
      throw new Error(`Property not found: ${propertyId}`);
    }
    if (error.response?.status === 429) {
      throw new Error('Google Analytics rate limit reached. Please try again shortly.');
    }
    if (error.response?.status === 400) {
      const errorDetails = error.response?.data?.error?.message || error.message;
      throw new Error(`Invalid request: ${errorDetails}`);
    }

    // Realtime is a distinct, more failure-prone API surface than standard
    // reports (its own smaller quota, can go briefly unavailable
    // independent of standard reports being healthy) - a dedicated message
    // keeps an outage here from reading like a Trends/Breakdowns failure.
    throw new Error('Realtime data is temporarily unavailable. Please try again shortly.');
  }
}

/**
 * Odito-derived Analytics Health score - NOT a Google metric (Google
 * exposes no composite health/score concept for GA4). Computed entirely
 * from an already-fetched (and cache-shared) Trends series - see
 * AnalyticsMapper.toHealthDTO for the deterministic formula. Costs zero
 * additional Google requests: this reuses getAnalyticsTrendsSeries's own
 * ga_trends cache, so calling Health after (or before) Trends within the
 * same 10-minute window is a cache hit either way.
 *
 * @param {Object} googleConnection
 * @param {string} propertyId
 * @param {Object} [options]
 * @param {number} [options.days=30]
 */
export async function getAnalyticsHealthData(googleConnection, propertyId, options = {}) {
  const { days = 30 } = options;
  const trends = await getAnalyticsTrendsSeries(googleConnection, propertyId, { days });
  return AnalyticsMapper.toHealthDTO(trends.series);
}

/**
 * Recent Analytics Activity - synthesized entirely from GoogleConnection's
 * own timestamps (connected_at, last_sync_at), never from a Google API
 * call or a hardcoded list. Odito does not currently track a granular
 * sync-event history (only a single last_sync_at per connection, shared
 * across all 3 Google services) - see AnalyticsMapper.toActivityDTO for
 * exactly what is and isn't derivable from that.
 *
 * Synchronous - no I/O, no cache, deterministic given the connection
 * document's current state.
 *
 * @param {Object} googleConnection
 */
export function getAnalyticsActivityData(googleConnection) {
  return AnalyticsMapper.toActivityDTO(googleConnection);
}

/**
 * Clear every Analytics cache entry (ga_properties, ga_trends,
 * ga_breakdowns, ga_events, ga_property) for a specific GoogleConnection.
 * Built on the same clearCacheEntries primitive businessProfileService.js's
 * clearCacheForConnection uses - not a second cache implementation, just
 * this module's own prefixes.
 *
 * Two callers: analyticsController.js's syncAnalyticsData (manual "Sync
 * Now" must invalidate stale Analytics data, not just write fresh rows to
 * AnalyticsData while Trends/Breakdowns/Events keep serving 10-minute-old
 * cache - a gap identified and fixed in this phase) and oauth.routes.js's
 * reconnect handler (a new Google identity must invalidate Analytics'
 * cache the same way it already invalidates Business Profile's).
 *
 * Realtime is never cached (see getAnalyticsRealtimeData), so there is
 * nothing to clear for it here.
 */
export function clearAnalyticsCacheForConnection(connectionId) {
  const cleared = clearCacheEntries({
    exactKeys: [`ga_properties:${connectionId}`],
    prefixes: [
      `ga_trends:${connectionId}:`,
      `ga_breakdowns:${connectionId}:`,
      `ga_events:${connectionId}:`,
      `ga_property:${connectionId}:`
    ]
  });
  if (cleared > 0) {
    console.log(`[ANALYTICS] Cleared ${cleared} cache entr${cleared === 1 ? 'y' : 'ies'} for connection ${connectionId}`);
  }
  return cleared;
}

export default {
  getAnalyticsProperties,
  validateAnalyticsPropertyAccess,
  getAnalyticsPerformanceData,
  getProjectAnalyticsData,
  getAnalyticsTrendsSeries,
  getAnalyticsPropertyDetails,
  getAnalyticsBreakdowns,
  getAnalyticsEventsData,
  getAnalyticsConversionsData,
  getAnalyticsRealtimeData,
  getAnalyticsHealthData,
  getAnalyticsActivityData,
  clearAnalyticsCacheForConnection
};
