import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import GoogleConnection from '../model/GoogleConnection.js';
import AnalyticsData from '../model/AnalyticsData.js';
import SeoProject from '../model/SeoProject.js';
import {
  getProjectAnalyticsData,
  getAnalyticsProperties,
  validateAnalyticsPropertyAccess,
  getAnalyticsTrendsSeries,
  getAnalyticsPropertyDetails,
  getAnalyticsBreakdowns,
  getAnalyticsEventsData,
  getAnalyticsConversionsData,
  getAnalyticsRealtimeData,
  getAnalyticsHealthData,
  getAnalyticsActivityData,
  clearAnalyticsCacheForConnection
} from '../../../services/analyticsService.js';

// See searchConsoleController.js for the identical backfill/incremental
// rationale - GA4 has no API-imposed historical ceiling, but re-pulling
// full history every sync would still waste Data API quota (200,000
// tokens/property/day) for data that stabilizes after a few days.
const BACKFILL_DAYS = 90;
const INCREMENTAL_DAYS = 7;

/**
 * Analytics Sync Controller
 * 
 * Implements manual sync endpoint for Analytics performance data
 * 
 * Flow:
 * 1. Validate user ownership and Google connection
 * 2. Validate stored analytics_property_id
 * 3. Fetch data from Analytics API
 * 4. Store data with duplicate prevention
 * 5. Update sync metadata
 * 6. Return sync status
 * 
 * Safety Features:
 * - Transaction-safe operations
 * - Idempotent sync (safe to retry)
 * - Partial failure handling
 * - Comprehensive validation
 */

/**
 * Sync Analytics data for a project
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const syncAnalyticsData = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;

  LoggerUtil.info('Analytics sync starting', { projectId, userId: userId.toString() });

  try {
    // Step 1: Validate project ownership
    LoggerUtil.debug('Step 1: Validating project ownership...');
    const project = await SeoProject.findById(projectId);
    
    if (!project) {
      LoggerUtil.warn('Project not found', { projectId });
      return res.status(404).json(ResponseUtil.error('Project not found', 404));
    }

    if (project.user_id.toString() !== userId.toString()) {
      LoggerUtil.security('Access denied - user does not own project', { projectId, userId });
      return res.status(403).json(ResponseUtil.accessDenied('Access denied'));
    }

    LoggerUtil.debug('Project ownership validated', {
      projectName: project.project_name,
      projectUrl: project.main_url
    });

    LoggerUtil.debug('Step 2: Validating Google connection...');
    const googleConnection = await GoogleConnection.findActiveConnection(userId, projectId, 'analytics');
    
    if (!googleConnection) {
      LoggerUtil.warn('No active Google connection found', { projectId });
      return res.status(400).json(ResponseUtil.error('Google account not connected. Please connect your Google account first.', 400));
    }

    LoggerUtil.debug('Google connection validated', {
      googleEmail: googleConnection.google_email,
      serviceTypes: googleConnection.service_type,
      lastSync: googleConnection.last_sync_at
    });

    LoggerUtil.debug('Step 3: Validating analytics property ID...');
    if (!googleConnection.service_type.includes('analytics')) {
      LoggerUtil.warn('Analytics service not enabled', { projectId });
      return res.status(400).json(ResponseUtil.error('Analytics service not enabled. Please select an Analytics property first.', 400));
    }

    if (!googleConnection.analytics_property_id) {
      LoggerUtil.warn('No analytics property ID stored', { projectId });
      return res.status(400).json(ResponseUtil.error('Analytics property not selected. Please select an Analytics property first.', 400));
    }

    LoggerUtil.debug('Analytics property ID validated', {
      propertyId: googleConnection.analytics_property_id
    });

    LoggerUtil.debug('Step 4: Fetching Analytics data...');
    let performanceData;
    let dateRange;

    try {
      // Backfill on the first-ever sync for THIS project's Analytics data
      // specifically (not GoogleConnection.last_sync_at, which is shared
      // across all three Google services - see searchConsoleController.js
      // for the identical reasoning).
      const existingDataCount = await AnalyticsData.countDocuments({ project_id: projectId });
      const isFirstSync = existingDataCount === 0;
      const days = isFirstSync ? BACKFILL_DAYS : INCREMENTAL_DAYS;

      LoggerUtil.debug('Sync window determined', { isFirstSync, days });

      performanceData = await getProjectAnalyticsData(
        googleConnection,
        googleConnection.analytics_property_id,
        { days }
      );

      if (!performanceData || !performanceData.data || performanceData.data.length === 0) {
        LoggerUtil.info('No Analytics data available', { projectId });
        return res.status(200).json(ResponseUtil.success({
          syncedPages: 0,
          skippedPages: 0,
          dataPoints: 0,
          dateRange: null,
          lastSyncAt: googleConnection.last_sync_at
        }, 'No Analytics data available for this property'));
      }

      dateRange = performanceData.dateRange;

      LoggerUtil.info('Analytics data fetched', {
        dataPoints: performanceData.dataPoints || performanceData.data?.length || 0,
        syncedPages: performanceData.syncedPages || 0,
        skippedPages: performanceData.skippedPages || 0,
        dateRange,
        isFirstSync
      });

    } catch (apiError) {
      LoggerUtil.error('Google API fetch failed', apiError, { projectId });
      
      // Don't update sync state on API failure
      return res.status(400).json(ResponseUtil.error(`Failed to fetch Analytics data: ${apiError.message}`, 400));
    }

    LoggerUtil.debug('Step 5: Storing data in database...');
    let dbResult;

    try {
      const startDate = new Date(dateRange.start);
      const endDate = new Date(dateRange.end);

      dbResult = await AnalyticsData.upsertPerformanceData(
        performanceData.data,
        userId,
        projectId,
        startDate,
        endDate
      );

      LoggerUtil.info('Data stored successfully', {
        upserted: dbResult.upserted,
        modified: dbResult.modified,
        total: dbResult.total
      });

    } catch (dbError) {
      LoggerUtil.error('Database operation failed', dbError, { projectId });
      
      // Don't update sync state on DB failure
      return res.status(500).json(ResponseUtil.error('Failed to store Analytics data. Please try again.', 500));
    }

    LoggerUtil.debug('Step 6: Updating sync metadata...');
    try {
      await GoogleConnection.findByIdAndUpdate(
        googleConnection._id,
        {
          last_sync_at: new Date(),
          updated_at: new Date()
        },
        { new: true }
      );

      LoggerUtil.info('Sync metadata updated');

    } catch (metadataError) {
      LoggerUtil.error('Failed to update sync metadata', metadataError);

      // Data was stored successfully, but metadata update failed
      LoggerUtil.warn('Continuing despite metadata update failure');
    }

    // A manual sync must invalidate the live-pull-through caches Trends/
    // Breakdowns/Events/Health/Property all read from (see
    // clearAnalyticsCacheForConnection) - otherwise "Sync Now" only
    // refreshes the legacy per-page AnalyticsData table above while every
    // other widget keeps serving up-to-10-minute-old cached Google data.
    // Never fatal: a cache-clear failure shouldn't fail a sync that
    // otherwise succeeded, the entries will simply expire on their own TTL.
    try {
      clearAnalyticsCacheForConnection(googleConnection._id.toString());
    } catch (cacheError) {
      LoggerUtil.warn('Failed to clear Analytics cache after sync', { message: cacheError.message });
    }

    LoggerUtil.info('Sync completed successfully', {
      projectId,
      syncedPages: dbResult.total,
      dateRange
    });

    return res.status(200).json(ResponseUtil.success({
      syncedPages: dbResult.total,
      skippedPages: performanceData.skipped_pages || 0,
      dataPoints: performanceData.dataPoints || performanceData.data?.length || 0,
      dateRange: dateRange,
      lastSyncAt: new Date().toISOString()
    }, 'Analytics data synced successfully'));

  } catch (error) {
    LoggerUtil.error('Unexpected error during sync', error, { projectId, userId });
    
    return res.status(500).json(ResponseUtil.error('An unexpected error occurred during sync. Please try again.', 500));
  }
};

/**
 * Get Analytics sync status for a project
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const getAnalyticsSyncStatus = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;

  LoggerUtil.info('Getting Analytics sync status', { projectId, userId: userId.toString() });

  try {
    // Validate project ownership
    const project = await SeoProject.findById(projectId);
    
    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    if (project.user_id.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Check Google connection
    const googleConnection = await GoogleConnection.findActiveConnection(userId, projectId, 'analytics');
    
    if (!googleConnection) {
      return res.json(ResponseUtil.success({
        connected: false,
        serviceEnabled: false,
        lastSyncAt: null,
        message: 'Google account not connected'
      }));
    }

    const isServiceEnabled = googleConnection.service_type.includes('analytics');

    // Get latest data count
    let dataCount = 0;
    let latestDataDate = null;

    if (isServiceEnabled) {
      try {
        // FIX: Count analytics_data documents directly like Search Console
        dataCount = await AnalyticsData.countDocuments({
          project_id: projectId
        });
        
        // Get latest data date if we have data
        if (dataCount > 0) {
          const aggregates = await AnalyticsData.getProjectAggregates(projectId);
          latestDataDate = aggregates.lastFetched;
        }
      } catch (countError) {
        LoggerUtil.warn('Failed to get data count', { message: countError.message });
      }
    }

    const statusResponse = {
      success: true,
      connected: true,
      serviceEnabled: isServiceEnabled,
      analyticsPropertyId: googleConnection.analytics_property_id || null,
      lastSyncAt: googleConnection.last_sync_at,
      dataPoints: dataCount,
      latestDataDate: latestDataDate,
      googleEmail: googleConnection.google_email
    };

    LoggerUtil.debug('Status retrieved', statusResponse);

    return res.json(ResponseUtil.success(statusResponse));

  } catch (error) {
    LoggerUtil.error('Error getting sync status', error, { projectId });
    
    return res.status(500).json(ResponseUtil.error('Failed to get sync status', 500));
  }
};

/**
 * Get Analytics performance data for a project
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const getAnalyticsData = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;

  // Parse query parameters
  const {
    page = 1,
    limit = 50,
    sort = 'sessions',
    order = 'desc',
    start_date,
    end_date
  } = req.query;

  LoggerUtil.info('Fetching Analytics performance data', {
    projectId,
    userId: userId.toString(),
    queryParams: { page, limit, sort, order, start_date, end_date }
  });

  try {
    // Validate project ownership
    const project = await SeoProject.findById(projectId);
    
    if (!project) {
      return res.status(404).json(ResponseUtil.error('Project not found', 404));
    }

    if (project.user_id.toString() !== userId.toString()) {
      return res.status(403).json(ResponseUtil.accessDenied('Access denied'));
    }

    // Validate Google connection
    const googleConnection = await GoogleConnection.findActiveConnection(userId, projectId, 'analytics');
    
    if (!googleConnection || !googleConnection.service_type.includes('analytics')) {
      return res.status(400).json(ResponseUtil.error('Analytics not connected for this project', 400));
    }

    // Parse and validate parameters
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    // Validate sort field
    const validSortFields = ['sessions', 'activeUsers', 'pageViews', 'engagementRate', 'pagePath'];
    if (!validSortFields.includes(sort)) {
      return res.status(400).json(ResponseUtil.error(`Invalid sort field. Must be one of: ${validSortFields.join(', ')}`, 400));
    }

    // Build sort object
    const sortObj = {};
    sortObj[sort] = order === 'desc' ? -1 : 1;

    // Parse dates
    let startDateFilter = null;
    let endDateFilter = null;

    if (start_date) {
      startDateFilter = new Date(start_date);
      if (isNaN(startDateFilter.getTime())) {
        return res.status(400).json(ResponseUtil.error('Invalid start_date format', 400));
      }
    }

    if (end_date) {
      endDateFilter = new Date(end_date);
      if (isNaN(endDateFilter.getTime())) {
        return res.status(400).json(ResponseUtil.error('Invalid end_date format', 400));
      }
    }

    // Fetch data
    const performanceData = await AnalyticsData.getProjectPerformanceData(
      projectId,
      startDateFilter,
      endDateFilter,
      {
        sort: sortObj,
        limit: limitNum,
        skip: skip
      }
    );

    // Get total count for pagination
    const aggregates = await AnalyticsData.getProjectAggregates(
      projectId,
      startDateFilter,
      endDateFilter
    );

    const response = {
      success: true,
      data: performanceData.map(row => ({  // FIX: Normalize field names for frontend
        pagePath: row.page_path,
        sessions: row.sessions,
        activeUsers: row.active_users,
        pageViews: row.page_views,
        engagementRate: row.engagement_rate,
        fetchedAt: row.fetched_at
      })),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: aggregates.page_count || 0,
        pages: Math.max(1, Math.ceil((aggregates.page_count || 0) / limitNum))  // FIX: Never return 0
      },
      summary: {
        totalSessions: aggregates.totalSessions || 0,
        totalPageViews: aggregates.totalPageViews || 0,
        avgEngagementRate: aggregates.avgEngagementRate || 0,
        lastFetched: aggregates.lastFetched
      },
      dateRange: {
        start: start_date || null,
        end: end_date || null
      }
    };

    LoggerUtil.info('Data retrieved successfully', {
      projectId,
      dataPoints: performanceData.length,
      totalPages: response.pagination.pages
    });

    // Send the full response shape (rows + summary + dateRange), matching
    // businessProfileController.getBusinessProfileData - see identical fix
    // in searchConsoleController.getSearchConsoleData.
    return res.json(ResponseUtil.success(
      { rows: response.data, summary: response.summary, dateRange: response.dateRange },
      'Data retrieved successfully',
      response.pagination
    ));

  } catch (error) {
    LoggerUtil.error('Error fetching Analytics data', error, { projectId });
    
    return res.status(500).json(ResponseUtil.error('Failed to fetch Analytics data', 500));
  }
};

/**
 * Get list of accessible Analytics properties
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const getAnalyticsPropertiesList = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;

  LoggerUtil.info('Getting Analytics properties', { projectId, userId: userId.toString() });

  try {
    // Validate project ownership
    const project = await SeoProject.findById(projectId);
    
    if (!project) {
      return res.status(404).json(ResponseUtil.error('Project not found', 404));
    }

    if (project.user_id.toString() !== userId.toString()) {
      return res.status(403).json(ResponseUtil.accessDenied('Access denied'));
    }

    // Check Google connection
    const googleConnection = await GoogleConnection.findActiveConnection(userId, projectId, 'analytics');
    
    if (!googleConnection) {
      return res.status(400).json(ResponseUtil.error('Google account not connected', 400));
    }

    // Get Analytics properties
    const properties = await getAnalyticsProperties(googleConnection);

    LoggerUtil.info('Properties retrieved', { projectId, propertyCount: properties.length });

    return res.json(ResponseUtil.success(properties, 'Properties retrieved successfully'));

  } catch (error) {
    LoggerUtil.error('Error fetching Analytics properties', error, { projectId });
    
    return res.status(500).json(ResponseUtil.error('Failed to fetch Analytics properties', 500));
  }
};

/**
 * Select and store Analytics property
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const selectAnalyticsProperty = async (req, res) => {
  const { projectId } = req.params;
  const { propertyId } = req.body;
  const userId = req.user._id;

  LoggerUtil.info('Selecting Analytics property', { projectId, userId: userId.toString(), propertyId });

  try {
    // Validate project ownership
    const project = await SeoProject.findById(projectId);
    
    if (!project) {
      return res.status(404).json(ResponseUtil.error('Project not found', 404));
    }

    if (project.user_id.toString() !== userId.toString()) {
      return res.status(403).json(ResponseUtil.accessDenied('Access denied'));
    }

    if (!propertyId) {
      return res.status(400).json(ResponseUtil.error('Property ID is required', 400));
    }

    // Check Google connection
    const googleConnection = await GoogleConnection.findActiveConnection(userId, projectId, 'analytics');
    
    if (!googleConnection) {
      return res.status(400).json(ResponseUtil.error('Google account not connected', 400));
    }

    // Validate property access
    try {
      await validateAnalyticsPropertyAccess(googleConnection, propertyId);
    } catch (validationError) {
      return res.status(400).json(ResponseUtil.error(`Access denied for property: ${validationError.message}`, 400));
    }

    // Update connection with property ID and enable analytics service
    await GoogleConnection.findByIdAndUpdate(
      googleConnection._id,
      {
        analytics_property_id: propertyId,
        $addToSet: { service_type: 'analytics' },
        updated_at: new Date()
      },
      { new: true }
    );

    LoggerUtil.info('Property selected successfully', { projectId, propertyId });

    return res.json(ResponseUtil.success({ analyticsPropertyId: propertyId }, 'Property selected successfully'));

  } catch (error) {
    LoggerUtil.error('Error selecting Analytics property', error, { projectId });
    
    return res.status(500).json(ResponseUtil.error('Failed to select Analytics property', 500));
  }
};

const VALID_TREND_RANGES = { '7': 7, '30': 30, '90': 90, '365': 365 };

/**
 * Shared project ownership + active-connection + Analytics-enabled check,
 * used by the two Phase 1 handlers below. Not applied to the five existing
 * handlers above - those keep their own inline checks unchanged, per "do
 * not rewrite the existing service/controller."
 *
 * Returns { error: {status, body} } on failure, or { googleConnection,
 * project } on success - callers just check `.error` and return early.
 */
async function resolveAnalyticsConnection(projectId, userId) {
  const project = await SeoProject.findById(projectId);
  if (!project) {
    return { error: { status: 404, body: ResponseUtil.error('Project not found', 404) } };
  }
  if (project.user_id.toString() !== userId.toString()) {
    return { error: { status: 403, body: ResponseUtil.accessDenied('Access denied') } };
  }

  const googleConnection = await GoogleConnection.findActiveConnection(userId, projectId, 'analytics');
  if (!googleConnection || !googleConnection.service_type.includes('analytics') || !googleConnection.analytics_property_id) {
    return { error: { status: 400, body: ResponseUtil.error('Analytics not connected for this project. Please connect Google and select a property first.', 400) } };
  }

  return { project, googleConnection };
}

/**
 * Maps a thrown Google-API error (from analyticsService.js) to the right
 * HTTP status/message - never forwards Google's raw error body to the
 * client, per requirement 10.
 */
function respondWithGoogleError(res, error, projectId, logLabel) {
  LoggerUtil.error(logLabel, error, { projectId });

  const message = error.message || '';
  if (/^Access denied/i.test(message)) {
    return res.status(400).json(ResponseUtil.error('Access denied for this Analytics property. Please reconnect Google or reselect a property.', 400));
  }
  if (/^Property not found/i.test(message)) {
    return res.status(400).json(ResponseUtil.error('The selected Analytics property could not be found. It may have been deleted or access revoked.', 400));
  }
  if (/rate limit reached/i.test(message)) {
    return res.status(429).json(ResponseUtil.error('Google Analytics rate limit reached. Please try again shortly.', 429));
  }
  if (/^Invalid request/i.test(message)) {
    return res.status(400).json(ResponseUtil.error('Invalid Analytics request. Please try again or contact support if this persists.', 400));
  }

  return res.status(500).json(ResponseUtil.error('Failed to fetch Analytics data. Please try again.', 500));
}

/**
 * One consistent `meta` envelope for every Analytics endpoint below
 * (requirement: "success/data/meta/lastSync/generatedAt where
 * appropriate") - `data` on every response is the resource payload only;
 * cross-cutting fields (which range was requested, when this connection
 * last completed a full sync, exactly when this response was generated)
 * live here instead of being duplicated into every DTO shape.
 */
function buildMeta({ range, lastSyncAt } = {}) {
  const meta = { generatedAt: new Date().toISOString() };
  if (range !== undefined) meta.range = range;
  if (lastSyncAt !== undefined) meta.lastSyncAt = lastSyncAt;
  return meta;
}

/**
 * GET /projects/:projectId/analytics/trends?range=7|30|90|365
 *
 * Daily Users/New Users/Sessions/Engaged Sessions/Views/Avg. Engagement
 * Time/Bounce Rate/Conversions in one GA4 Data API call - powers the Hero
 * KPI grid, Traffic Trends chart, and Today's Summary. No other endpoint
 * covers these widgets; see the Phase 1 blueprint.
 */
export const getAnalyticsTrends = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;
  const range = req.query.range || '30';

  LoggerUtil.info('Getting Analytics trends', { projectId, userId: userId.toString(), range });

  try {
    if (!VALID_TREND_RANGES[range]) {
      return res.status(400).json(ResponseUtil.error(`Invalid range. Must be one of: ${Object.keys(VALID_TREND_RANGES).join(', ')}`, 400));
    }

    const { error, googleConnection } = await resolveAnalyticsConnection(projectId, userId);
    if (error) return res.status(error.status).json(error.body);

    const days = VALID_TREND_RANGES[range];
    const trends = await getAnalyticsTrendsSeries(googleConnection, googleConnection.analytics_property_id, { days });

    return res.json(ResponseUtil.success(
      { series: trends.series, totals: trends.totals, dateRange: trends.dateRange },
      'Analytics trends retrieved successfully',
      buildMeta({ range, lastSyncAt: googleConnection.last_sync_at })
    ));

  } catch (error) {
    return respondWithGoogleError(res, error, projectId, 'Error fetching Analytics trends');
  }
};

/**
 * GET /projects/:projectId/analytics/property
 *
 * Property display name, website URL, Measurement ID and timezone for the
 * Analytics Header / Property card. Reuses the already-selected
 * analytics_property_id (no separate property lookup flow).
 */
export const getAnalyticsProperty = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;

  LoggerUtil.info('Getting Analytics property details', { projectId, userId: userId.toString() });

  try {
    const { error, googleConnection } = await resolveAnalyticsConnection(projectId, userId);
    if (error) return res.status(error.status).json(error.body);

    const details = await getAnalyticsPropertyDetails(googleConnection, googleConnection.analytics_property_id);

    return res.json(ResponseUtil.success(
      {
        propertyId: googleConnection.analytics_property_id,
        propertyName: details.propertyName,
        websiteUrl: details.websiteUrl,
        measurementId: details.measurementId,
        timezone: details.timezone
      },
      'Analytics property details retrieved successfully',
      buildMeta({ lastSyncAt: googleConnection.last_sync_at })
    ));

  } catch (error) {
    return respondWithGoogleError(res, error, projectId, 'Error fetching Analytics property details');
  }
};

/**
 * GET /projects/:projectId/analytics/breakdowns?range=7|30|90|365
 *
 * Traffic Sources, Top Channels, Countries, Devices, Browsers and
 * Operating Systems - one batchRunReports call (5 bundled sub-reports).
 */
export const getBreakdowns = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;
  const range = req.query.range || '30';

  LoggerUtil.info('Getting Analytics breakdowns', { projectId, userId: userId.toString(), range });

  try {
    if (!VALID_TREND_RANGES[range]) {
      return res.status(400).json(ResponseUtil.error(`Invalid range. Must be one of: ${Object.keys(VALID_TREND_RANGES).join(', ')}`, 400));
    }

    const { error, googleConnection } = await resolveAnalyticsConnection(projectId, userId);
    if (error) return res.status(error.status).json(error.body);

    const days = VALID_TREND_RANGES[range];
    const breakdowns = await getAnalyticsBreakdowns(googleConnection, googleConnection.analytics_property_id, { days });

    return res.json(ResponseUtil.success(
      {
        sources: breakdowns.sources,
        channels: breakdowns.channels,
        countries: breakdowns.countries,
        devices: breakdowns.devices,
        browsers: breakdowns.browsers,
        operatingSystems: breakdowns.operatingSystems,
        dateRange: breakdowns.dateRange
      },
      'Analytics breakdowns retrieved successfully',
      buildMeta({ range, lastSyncAt: googleConnection.last_sync_at })
    ));

  } catch (error) {
    return respondWithGoogleError(res, error, projectId, 'Error fetching Analytics breakdowns');
  }
};

/**
 * GET /projects/:projectId/analytics/events?range=7|30|90|365
 *
 * Top events by count, each with users and a real period-over-period
 * trend. Shares its Google fetch with GET .../conversions - see
 * fetchAnalyticsEventsRawReport in analyticsService.js.
 */
export const getEvents = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;
  const range = req.query.range || '30';

  LoggerUtil.info('Getting Analytics events', { projectId, userId: userId.toString(), range });

  try {
    if (!VALID_TREND_RANGES[range]) {
      return res.status(400).json(ResponseUtil.error(`Invalid range. Must be one of: ${Object.keys(VALID_TREND_RANGES).join(', ')}`, 400));
    }

    const { error, googleConnection } = await resolveAnalyticsConnection(projectId, userId);
    if (error) return res.status(error.status).json(error.body);

    const days = VALID_TREND_RANGES[range];
    const result = await getAnalyticsEventsData(googleConnection, googleConnection.analytics_property_id, { days });

    return res.json(ResponseUtil.success(
      { events: result.events, dateRange: result.dateRange },
      'Analytics events retrieved successfully',
      buildMeta({ range, lastSyncAt: googleConnection.last_sync_at })
    ));

  } catch (error) {
    return respondWithGoogleError(res, error, projectId, 'Error fetching Analytics events');
  }
};

/**
 * GET /projects/:projectId/analytics/conversions?range=7|30|90|365
 *
 * Conversion events bucketed into Purchases/Leads/Newsletter/Downloads/
 * Form Submissions/Other, each with count and trend. Shares its Google
 * fetch with GET .../events - calling both within the same 10-minute cache
 * window costs exactly one Google request, not two.
 */
export const getConversions = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;
  const range = req.query.range || '30';

  LoggerUtil.info('Getting Analytics conversions', { projectId, userId: userId.toString(), range });

  try {
    if (!VALID_TREND_RANGES[range]) {
      return res.status(400).json(ResponseUtil.error(`Invalid range. Must be one of: ${Object.keys(VALID_TREND_RANGES).join(', ')}`, 400));
    }

    const { error, googleConnection } = await resolveAnalyticsConnection(projectId, userId);
    if (error) return res.status(error.status).json(error.body);

    const days = VALID_TREND_RANGES[range];
    const result = await getAnalyticsConversionsData(googleConnection, googleConnection.analytics_property_id, { days });

    return res.json(ResponseUtil.success(
      { conversions: result.conversions, totalConversions: result.totalConversions, dateRange: result.dateRange },
      'Analytics conversions retrieved successfully',
      buildMeta({ range, lastSyncAt: googleConnection.last_sync_at })
    ));

  } catch (error) {
    return respondWithGoogleError(res, error, projectId, 'Error fetching Analytics conversions');
  }
};

/**
 * GET /projects/:projectId/analytics/realtime
 *
 * Active Users, Active Pages, Active Countries, Active Devices right now.
 * No `range` (realtime has no configurable window) and never cached - see
 * getAnalyticsRealtimeData. `respondWithGoogleError`'s generic fallback
 * message doesn't fit a Realtime-specific outage as well as it does for
 * the other endpoints, so this handler adds one extra check ahead of it.
 */
export const getRealtime = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;

  LoggerUtil.info('Getting Analytics realtime data', { projectId, userId: userId.toString() });

  try {
    const { error, googleConnection } = await resolveAnalyticsConnection(projectId, userId);
    if (error) return res.status(error.status).json(error.body);

    const realtime = await getAnalyticsRealtimeData(googleConnection, googleConnection.analytics_property_id);

    return res.json(ResponseUtil.success(
      { activeUsers: realtime.activeUsers, topPages: realtime.topPages, topCountries: realtime.topCountries, deviceSplit: realtime.deviceSplit },
      'Analytics realtime data retrieved successfully',
      buildMeta({ lastSyncAt: googleConnection.last_sync_at })
    ));

  } catch (error) {
    if (/realtime data is temporarily unavailable/i.test(error.message || '')) {
      LoggerUtil.error('Error fetching Analytics realtime data', error, { projectId });
      return res.status(503).json(ResponseUtil.error('Realtime data is temporarily unavailable. Please try again shortly.', 503));
    }
    return respondWithGoogleError(res, error, projectId, 'Error fetching Analytics realtime data');
  }
};

/**
 * GET /projects/:projectId/analytics/health?range=7|30|90|365
 *
 * Odito-derived Analytics Health score - see AnalyticsMapper.toHealthDTO
 * for the full documented formula. Reuses the Trends fetch's own cache, so
 * this costs zero additional Google requests when Trends was already
 * fetched for the same range within the last 10 minutes.
 */
export const getHealth = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;
  const range = req.query.range || '30';

  LoggerUtil.info('Getting Analytics health', { projectId, userId: userId.toString(), range });

  try {
    if (!VALID_TREND_RANGES[range]) {
      return res.status(400).json(ResponseUtil.error(`Invalid range. Must be one of: ${Object.keys(VALID_TREND_RANGES).join(', ')}`, 400));
    }

    const { error, googleConnection } = await resolveAnalyticsConnection(projectId, userId);
    if (error) return res.status(error.status).json(error.body);

    const days = VALID_TREND_RANGES[range];
    const health = await getAnalyticsHealthData(googleConnection, googleConnection.analytics_property_id, { days });

    return res.json(ResponseUtil.success(
      { score: health.score, status: health.status, reasons: health.reasons, formulaVersion: health.formulaVersion },
      'Analytics health computed successfully',
      buildMeta({ range, lastSyncAt: googleConnection.last_sync_at })
    ));

  } catch (error) {
    return respondWithGoogleError(res, error, projectId, 'Error computing Analytics health');
  }
};

/**
 * GET /projects/:projectId/analytics/activity
 *
 * Recent Analytics Activity, synthesized server-side from GoogleConnection's
 * own timestamps - no Google API call, no cache (the underlying data is
 * the connection document itself, already loaded by resolveAnalyticsConnection).
 */
export const getActivity = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;

  LoggerUtil.info('Getting Analytics activity', { projectId, userId: userId.toString() });

  try {
    const { error, googleConnection } = await resolveAnalyticsConnection(projectId, userId);
    if (error) return res.status(error.status).json(error.body);

    const activity = getAnalyticsActivityData(googleConnection);

    return res.json(ResponseUtil.success(
      { activity: activity.activity },
      'Analytics activity retrieved successfully',
      buildMeta({ lastSyncAt: googleConnection.last_sync_at })
    ));

  } catch (error) {
    LoggerUtil.error('Error fetching Analytics activity', error, { projectId });
    return res.status(500).json(ResponseUtil.error('Failed to fetch Analytics activity', 500));
  }
};

export default {
  syncAnalyticsData,
  getAnalyticsSyncStatus,
  getAnalyticsData,
  getAnalyticsPropertiesList,
  selectAnalyticsProperty,
  getAnalyticsTrends,
  getAnalyticsProperty,
  getBreakdowns,
  getEvents,
  getConversions,
  getRealtime,
  getHealth,
  getActivity
};
