import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import GoogleConnection from '../model/GoogleConnection.js';
import SearchConsoleData from '../model/SearchConsoleData.js';
import SearchConsoleTrend from '../model/SearchConsoleTrend.js';
import SearchConsoleBreakdown from '../model/SearchConsoleBreakdown.js';
import SeoProject from '../model/SeoProject.js';
import {
  getProjectSearchConsoleData,
  getProjectSearchConsoleTrends,
  getProjectSearchConsoleBreakdown,
  getSearchConsoleSites,
  getSearchConsoleSitemaps,
  inspectSearchConsoleUrl,
  validateSearchConsoleSiteAccess,
  BREAKDOWN_DIMENSIONS
} from '../../../services/searchConsoleService.js';

// Initial sync pulls a larger historical window (bounded well within
// Search Console's 16-month API ceiling and its 25,000-row-per-request
// limit for a single-dimension query); every subsequent sync only re-pulls
// a short rolling window, since Search Console data for a given day can
// still be revised for a few days after it first appears ("fresh"/non-final
// dataState) - re-fetching the full history on every sync would be wasted
// quota for data that, once outside this window, cannot change again.
const BACKFILL_DAYS = 90;
const INCREMENTAL_DAYS = 7;

// The daily trend backfill (`date` dimension, one row/day) is far cheaper
// than the page-level backfill (up to `rowLimit` rows/day), so it can safely
// cover a longer window - enough to back the Trends chart's "12 Months"
// range option. Incremental re-syncs reuse INCREMENTAL_DAYS, same
// data-revision rationale as the page-level sync above.
const TRENDS_BACKFILL_DAYS = 400;

// Row caps per breakdown dimension - device only ever has a handful of
// values (desktop/mobile/tablet), searchAppearance a handful of SERP
// feature types, while query/country can genuinely have many. These mirror
// what the corresponding dashboard widgets actually display (Top Queries,
// Top Countries, etc.), not the API's own much higher ceiling.
const BREAKDOWN_ROW_LIMITS = {
  query: 25,
  country: 20,
  device: 10,
  searchAppearance: 10
};

/**
 * Search Console Sync Controller
 * 
 * Implements manual sync endpoint for Search Console performance data
 * 
 * Flow:
 * 1. Validate user ownership and Google connection
 * 2. Fetch data from Search Console API
 * 3. Store data with duplicate prevention
 * 4. Update sync metadata
 * 5. Return sync status
 * 
 * Safety Features:
 * - Transaction-safe operations
 * - Idempotent sync (safe to retry)
 * - Partial failure handling
 * - Comprehensive validation
 */

/**
 * Sync Search Console data for a project
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const syncSearchConsoleData = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;

  LoggerUtil.info('Search Console sync starting', { projectId, userId: userId.toString() });

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

    // Step 2: Validate Google connection
    LoggerUtil.debug('Step 2: Validating Google connection...');
    const googleConnection = await GoogleConnection.findActiveConnection(userId, projectId, 'search_console');
    
    if (!googleConnection) {
      LoggerUtil.warn('No active Google connection found', { projectId });
      return res.status(400).json(ResponseUtil.error('Google account not connected. Please connect your Google account first.', 400));
    }

    LoggerUtil.debug('Google connection validated', {
      googleEmail: googleConnection.google_email,
      serviceTypes: googleConnection.service_type,
      lastSync: googleConnection.last_sync_at
    });

    // Step 3: Fetch Search Console data
    LoggerUtil.debug('Step 3: Fetching Search Console data...');
    let performanceData;
    let dateRange;
    let syncDays;

    try {
      // Backfill on the first-ever sync for THIS project's Search Console
      // data specifically (not GoogleConnection.last_sync_at, which is
      // shared across Business Profile/Analytics/Search Console and would
      // otherwise make Search Console's first sync look like a repeat sync
      // whenever another service already synced first).
      const existingDataCount = await SearchConsoleData.countDocuments({ project_id: projectId });
      const isFirstSync = existingDataCount === 0;
      const days = isFirstSync ? BACKFILL_DAYS : INCREMENTAL_DAYS;
      syncDays = days;

      LoggerUtil.debug('Sync window determined', { isFirstSync, days });

      // Reuse the explicitly-selected site if one exists; fall back to
      // automatic URL matching for projects that haven't gone through the
      // new property-selection endpoint yet (backward compatible).
      const syncOptions = { days };
      if (googleConnection.search_console_site_url) {
        syncOptions.siteUrl = googleConnection.search_console_site_url;
      }

      performanceData = await getProjectSearchConsoleData(googleConnection, project.main_url, syncOptions);

      if (!performanceData || !performanceData.data || performanceData.data.length === 0) {
        LoggerUtil.info('No Search Console data available', { projectId });
        return res.status(200).json(ResponseUtil.success({
          synced_pages: 0,
          skipped_pages: 0,
          data_points: 0,
          date_range: null,
          last_sync_at: googleConnection.last_sync_at
        }, 'No Search Console data available for this project'));
      }

      dateRange = performanceData.date_range;

      LoggerUtil.info('Search Console data fetched', {
        dataPoints: performanceData.dataPoints || performanceData.data?.length || 0,
        syncedPages: performanceData.syncedPages || 0,
        skippedPages: performanceData.skippedPages || 0,
        dateRange,
        isFirstSync
      });

    } catch (apiError) {
      LoggerUtil.error('Google API fetch failed', apiError, { projectId });
      
      // Don't update sync state on API failure
      return res.status(400).json(ResponseUtil.error(`Failed to fetch Search Console data: ${apiError.message}`, 400));
    }

    LoggerUtil.debug('Step 4: Storing data in database...');
    let dbResult;

    try {
      const startDate = new Date(dateRange.start);
      const endDate = new Date(dateRange.end);

      dbResult = await SearchConsoleData.upsertPerformanceData(
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
      return res.status(500).json(ResponseUtil.error('Failed to store Search Console data. Please try again.', 500));
    }

    // Step 4b: Sync daily trend data (date dimension) for the Trends chart.
    // Best-effort and non-critical: the page-level sync above is the primary
    // target of this endpoint, so a trends-specific failure (e.g. a
    // transient API error) must not fail the whole sync or roll back the
    // page data that already saved successfully.
    LoggerUtil.debug('Step 4b: Syncing daily trend data...');
    try {
      const existingTrendCount = await SearchConsoleTrend.countDocuments({ project_id: projectId });
      const isFirstTrendSync = existingTrendCount === 0;
      const trendDays = isFirstTrendSync ? TRENDS_BACKFILL_DAYS : INCREMENTAL_DAYS;

      const trendSyncOptions = { days: trendDays };
      if (googleConnection.search_console_site_url) {
        trendSyncOptions.siteUrl = googleConnection.search_console_site_url;
      }

      const trendsResult = await getProjectSearchConsoleTrends(googleConnection, project.main_url, trendSyncOptions);

      if (trendsResult?.data?.length) {
        const trendDbResult = await SearchConsoleTrend.upsertDailyData(trendsResult.data, userId, projectId);
        LoggerUtil.info('Trend data stored successfully', {
          upserted: trendDbResult.upserted,
          modified: trendDbResult.modified,
          total: trendDbResult.total
        });
      } else {
        LoggerUtil.info('No trend data available for this range', { projectId });
      }
    } catch (trendsError) {
      LoggerUtil.warn('Search Console trends sync failed (non-critical)', {
        message: trendsError.message,
        projectId
      });
    }

    // Step 4c: Sync the 4 breakdown dimensions (query/country/device/
    // searchAppearance) for the same window as the page-level sync above -
    // these describe performance over the same period Top Pages does, so
    // reusing `syncDays` (rather than inventing a separate first-sync check
    // per dimension) keeps all of them describing the same window. Same
    // best-effort/non-critical contract as Step 4b: one dimension failing
    // must not fail the others or the overall sync.
    LoggerUtil.debug('Step 4c: Syncing dimension breakdowns...');
    for (const dimension of BREAKDOWN_DIMENSIONS) {
      try {
        const breakdownSyncOptions = { days: syncDays, rowLimit: BREAKDOWN_ROW_LIMITS[dimension] };
        if (googleConnection.search_console_site_url) {
          breakdownSyncOptions.siteUrl = googleConnection.search_console_site_url;
        }

        const breakdownResult = await getProjectSearchConsoleBreakdown(
          googleConnection, project.main_url, dimension, breakdownSyncOptions
        );

        if (breakdownResult?.data?.length) {
          const startDate = new Date(breakdownResult.date_range.start);
          const endDate = new Date(breakdownResult.date_range.end);

          const breakdownDbResult = await SearchConsoleBreakdown.upsertBreakdownData(
            dimension, breakdownResult.data, userId, projectId, startDate, endDate
          );

          LoggerUtil.info('Breakdown data stored successfully', {
            dimension,
            upserted: breakdownDbResult.upserted,
            modified: breakdownDbResult.modified,
            total: breakdownDbResult.total
          });
        } else {
          LoggerUtil.info('No breakdown data available for dimension', { dimension, projectId });
        }
      } catch (breakdownError) {
        LoggerUtil.warn('Search Console breakdown sync failed (non-critical)', {
          dimension,
          message: breakdownError.message,
          projectId
        });
      }
    }

    LoggerUtil.debug('Step 5: Updating sync metadata and enabling Search Console service...');
    try {
      // Update last_sync_at and automatically enable Search Console service
      await GoogleConnection.findByIdAndUpdate(
        googleConnection._id,
        {
          last_sync_at: new Date(),
          updated_at: new Date(),
          // Automatically add search_console to service_type on first successful sync
          $addToSet: { service_type: 'search_console' }
        },
        { new: true }
      );

      LoggerUtil.info('Sync metadata updated');

    } catch (metadataError) {
      LoggerUtil.error('Failed to update sync metadata', metadataError);
      
      // Data was stored successfully, but metadata update failed
      // This is not critical, so we can still return success
      LoggerUtil.warn('Continuing despite metadata update failure');
    }

    LoggerUtil.info('Sync completed successfully', {
      projectId,
      syncedPages: dbResult.total,
      dateRange
    });

    return res.status(200).json(ResponseUtil.success({
      synced_pages: dbResult.total,
      skipped_pages: performanceData.skipped_pages || 0,
      data_points: performanceData.dataPoints || performanceData.data?.length || 0,
      date_range: dateRange,
      last_sync_at: new Date().toISOString()
    }, 'Search Console data synced successfully'));

  } catch (error) {
    LoggerUtil.error('Unexpected error during sync', error, { projectId, userId });
    
    return res.status(500).json(ResponseUtil.error('An unexpected error occurred during sync. Please try again.', 500));
  }
};

/**
 * Get Search Console sync status for a project
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const getSearchConsoleSyncStatus = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;

  LoggerUtil.info('Getting Search Console sync status', { projectId, userId: userId.toString() });

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
    const googleConnection = await GoogleConnection.findActiveConnection(userId, projectId, 'search_console');
    
    if (!googleConnection) {
      return res.json(ResponseUtil.success({
        connected: false,
        service_enabled: false,
        last_sync_at: null,
        message: 'Google account not connected'
      }));
    }

    const isServiceEnabled = googleConnection.service_type.includes('search_console');

    // Get latest data count
    let dataCount = 0;
    let latestDataDate = null;

    if (isServiceEnabled) {
      try {
        // FIX: Count search_console_data documents directly like Analytics
        dataCount = await SearchConsoleData.countDocuments({
          project_id: projectId
        });
        
        // Get latest data date if we have data
        if (dataCount > 0) {
          const aggregates = await SearchConsoleData.getProjectAggregates(projectId);
          latestDataDate = aggregates.lastFetched;
        }
      } catch (countError) {
        LoggerUtil.warn('Failed to get data count', { message: countError.message });
      }
    }

    const statusResponse = {
      success: true,
      connected: true,
      service_enabled: isServiceEnabled,
      last_sync_at: googleConnection.last_sync_at,
      data_points: dataCount,
      latest_data_date: latestDataDate,
      google_email: googleConnection.google_email,
      search_console_site_url: googleConnection.search_console_site_url || null
    };

    LoggerUtil.debug('Status retrieved', statusResponse);

    return res.json(ResponseUtil.success(statusResponse));

  } catch (error) {
    LoggerUtil.error('Error getting sync status', error, { projectId });
    
    return res.status(500).json(ResponseUtil.error('Failed to get sync status', 500));
  }
};

/**
 * Get Search Console performance data for a project
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const getSearchConsoleData = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;

  // Parse query parameters
  const {
    page = 1,
    limit = 50,
    sort = 'clicks',
    order = 'desc',
    start_date,
    end_date
  } = req.query;

  LoggerUtil.info('Fetching Search Console performance data', {
    projectId,
    userId: userId.toString(),
    queryParams: { page, limit, sort, order, start_date, end_date }
  });

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

    // Validate Google connection
    const googleConnection = await GoogleConnection.findActiveConnection(userId, projectId, 'search_console');
    
    if (!googleConnection || !googleConnection.service_type.includes('search_console')) {
      return res.status(400).json(ResponseUtil.error('Search Console not connected for this project', 400));
    }

    // Parse and validate parameters
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    // Validate sort field
    const validSortFields = ['clicks', 'impressions', 'ctr', 'position', 'page_url'];
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
    const performanceData = await SearchConsoleData.getProjectPerformanceData(
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
    const aggregates = await SearchConsoleData.getProjectAggregates(
      projectId,
      startDateFilter,
      endDateFilter
    );

    const response = {
      success: true,
      data: performanceData,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: aggregates.page_count || 0,
        pages: Math.max(1, Math.ceil((aggregates.page_count || 0) / limitNum))  // FIX: Never return 0
      },
      summary: {
        total_clicks: aggregates.totalClicks || 0,
        total_impressions: aggregates.totalImpressions || 0,
        avg_ctr: aggregates.avgCtr || 0,
        avg_position: aggregates.avgPosition || 0,
        last_fetched: aggregates.lastFetched
      },
      date_range: {
        start: start_date || null,
        end: end_date || null
      }
    };

    LoggerUtil.info('Data retrieved successfully', {
      projectId,
      dataPoints: performanceData.length,
      totalPages: response.pagination.pages
    });

    // Send the full response shape (rows + summary + date_range), matching
    // businessProfileController.getBusinessProfileData - previously only
    // response.data (the bare row array) was sent, so summary/date_range
    // were computed above but never reached the HTTP response.
    return res.json(ResponseUtil.success(
      { rows: response.data, summary: response.summary, date_range: response.date_range },
      'Data retrieved successfully',
      {
        page: pageNum,
        limit: limitNum,
        total: aggregates.page_count || 0,
        pages: response.pagination.pages
      }
    ));

  } catch (error) {
    LoggerUtil.error('Error fetching Search Console data', error, { projectId });
    
    return res.status(500).json(ResponseUtil.error('Failed to fetch Search Console data', 500));
  }
};

/**
 * Get list of accessible Search Console sites
 * Mirrors analyticsController.getAnalyticsPropertiesList()
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const getSearchConsoleSitesList = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;

  LoggerUtil.info('Getting Search Console sites', { projectId, userId: userId.toString() });

  try {
    const project = await SeoProject.findById(projectId);
    if (!project) return res.status(404).json(ResponseUtil.error('Project not found', 404));
    if (project.user_id.toString() !== userId.toString()) {
      return res.status(403).json(ResponseUtil.accessDenied('Access denied'));
    }

    const googleConnection = await GoogleConnection.findActiveConnection(userId, projectId, 'search_console');
    if (!googleConnection) {
      return res.status(400).json(ResponseUtil.error('Google account not connected', 400));
    }

    const sites = await getSearchConsoleSites(googleConnection);

    LoggerUtil.info('Sites retrieved', { projectId, siteCount: sites.length });

    return res.json(ResponseUtil.success(sites, 'Sites retrieved successfully'));

  } catch (error) {
    LoggerUtil.error('Error fetching Search Console sites', error, { projectId });
    return res.status(500).json(ResponseUtil.error('Failed to fetch Search Console sites', 500));
  }
};

/**
 * Select and store a Search Console site for a project
 * Mirrors analyticsController.selectAnalyticsProperty()
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const selectSearchConsoleSite = async (req, res) => {
  const { projectId } = req.params;
  const { siteUrl } = req.body;
  const userId = req.user._id;

  LoggerUtil.info('Selecting Search Console site', { projectId, userId: userId.toString(), siteUrl });

  try {
    const project = await SeoProject.findById(projectId);
    if (!project) return res.status(404).json(ResponseUtil.error('Project not found', 404));
    if (project.user_id.toString() !== userId.toString()) {
      return res.status(403).json(ResponseUtil.accessDenied('Access denied'));
    }

    if (!siteUrl || typeof siteUrl !== 'string' || !siteUrl.trim()) {
      return res.status(400).json(ResponseUtil.error('Site URL is required', 400));
    }

    const googleConnection = await GoogleConnection.findActiveConnection(userId, projectId, 'search_console');
    if (!googleConnection) {
      return res.status(400).json(ResponseUtil.error('Google account not connected', 400));
    }

    try {
      await validateSearchConsoleSiteAccess(googleConnection, siteUrl);
    } catch (validationError) {
      return res.status(400).json(ResponseUtil.error(`Access denied for site: ${validationError.message}`, 400));
    }

    await GoogleConnection.findByIdAndUpdate(
      googleConnection._id,
      {
        search_console_site_url: siteUrl,
        $addToSet: { service_type: 'search_console' },
        updated_at: new Date()
      },
      { new: true }
    );

    LoggerUtil.info('Site selected successfully', { projectId, siteUrl });

    return res.json(ResponseUtil.success({ searchConsoleSiteUrl: siteUrl }, 'Site selected successfully'));

  } catch (error) {
    LoggerUtil.error('Error selecting Search Console site', error, { projectId });
    return res.status(500).json(ResponseUtil.error('Failed to select Search Console site', 500));
  }
};

/**
 * Get daily Search Console trend series for a project (date dimension) -
 * powers the Search Performance Trends chart.
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const getSearchConsoleTrends = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;
  const { range = '30' } = req.query;

  LoggerUtil.info('Fetching Search Console trends', { projectId, userId: userId.toString(), range });

  try {
    const project = await SeoProject.findById(projectId);
    if (!project) return res.status(404).json(ResponseUtil.error('Project not found', 404));
    if (project.user_id.toString() !== userId.toString()) {
      return res.status(403).json(ResponseUtil.accessDenied('Access denied'));
    }

    const googleConnection = await GoogleConnection.findActiveConnection(userId, projectId, 'search_console');
    if (!googleConnection || !googleConnection.service_type.includes('search_console')) {
      return res.status(400).json(ResponseUtil.error('Search Console not connected for this project', 400));
    }

    const validRanges = ['7', '30', '90', '365'];
    const rangeStr = String(range);
    if (!validRanges.includes(rangeStr)) {
      return res.status(400).json(ResponseUtil.error(`Invalid range. Must be one of: ${validRanges.join(', ')}`, 400));
    }

    const days = parseInt(rangeStr, 10);
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(endDate.getDate() - days);

    const rows = await SearchConsoleTrend.getProjectSeries(projectId, startDate, endDate);

    const series = rows.map((row) => ({
      date: row.date.toISOString().split('T')[0],
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position
    }));

    LoggerUtil.info('Trends retrieved successfully', { projectId, points: series.length });

    return res.json(ResponseUtil.success({ series, range: rangeStr }, 'Trends retrieved successfully'));

  } catch (error) {
    LoggerUtil.error('Error fetching Search Console trends', error, { projectId });
    return res.status(500).json(ResponseUtil.error('Failed to fetch Search Console trends', 500));
  }
};

/**
 * Get a stored dimension breakdown (query/country/device/searchAppearance)
 * for a project - the same 4-dimension set synced in Step 4c above.
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const getSearchConsoleBreakdown = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;
  const { dimension, limit } = req.query;

  LoggerUtil.info('Fetching Search Console breakdown', { projectId, userId: userId.toString(), dimension });

  try {
    if (!dimension || !BREAKDOWN_DIMENSIONS.includes(dimension)) {
      return res.status(400).json(ResponseUtil.error(`Invalid or missing dimension. Must be one of: ${BREAKDOWN_DIMENSIONS.join(', ')}`, 400));
    }

    const project = await SeoProject.findById(projectId);
    if (!project) return res.status(404).json(ResponseUtil.error('Project not found', 404));
    if (project.user_id.toString() !== userId.toString()) {
      return res.status(403).json(ResponseUtil.accessDenied('Access denied'));
    }

    const googleConnection = await GoogleConnection.findActiveConnection(userId, projectId, 'search_console');
    if (!googleConnection || !googleConnection.service_type.includes('search_console')) {
      return res.status(400).json(ResponseUtil.error('Search Console not connected for this project', 400));
    }

    const rowLimit = Math.min(parseInt(limit, 10) || BREAKDOWN_ROW_LIMITS[dimension], 100);
    const rows = await SearchConsoleBreakdown.getTopByDimension(projectId, dimension, rowLimit);

    const dateRange = rows.length
      ? { start: rows[0].date_range.start_date, end: rows[0].date_range.end_date }
      : null;

    LoggerUtil.info('Breakdown retrieved successfully', { projectId, dimension, rows: rows.length });

    return res.json(ResponseUtil.success({
      dimension,
      rows: rows.map((r) => ({
        dimension_value: r.dimension_value,
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position
      })),
      date_range: dateRange
    }, 'Breakdown retrieved successfully'));

  } catch (error) {
    LoggerUtil.error('Error fetching Search Console breakdown', error, { projectId, dimension });
    return res.status(500).json(ResponseUtil.error('Failed to fetch Search Console breakdown', 500));
  }
};

/**
 * List submitted sitemaps for the project's selected Search Console
 * property. Mirrors getSearchConsoleSitesList's live-fetch pattern.
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const getSearchConsoleSitemapsList = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;

  LoggerUtil.info('Getting Search Console sitemaps', { projectId, userId: userId.toString() });

  try {
    const project = await SeoProject.findById(projectId);
    if (!project) return res.status(404).json(ResponseUtil.error('Project not found', 404));
    if (project.user_id.toString() !== userId.toString()) {
      return res.status(403).json(ResponseUtil.accessDenied('Access denied'));
    }

    const googleConnection = await GoogleConnection.findActiveConnection(userId, projectId, 'search_console');
    if (!googleConnection) {
      return res.status(400).json(ResponseUtil.error('Google account not connected', 400));
    }
    if (!googleConnection.search_console_site_url) {
      return res.status(400).json(ResponseUtil.error('No Search Console property selected for this project', 400));
    }

    const sitemaps = await getSearchConsoleSitemaps(googleConnection, googleConnection.search_console_site_url);

    LoggerUtil.info('Sitemaps retrieved', { projectId, count: sitemaps.length });

    return res.json(ResponseUtil.success(sitemaps, 'Sitemaps retrieved successfully'));

  } catch (error) {
    LoggerUtil.error('Error fetching Search Console sitemaps', error, { projectId });
    return res.status(500).json(ResponseUtil.error('Failed to fetch Search Console sitemaps', 500));
  }
};

/**
 * Inspect a single URL's indexing status via the URL Inspection API. Live,
 * on-demand - not synced/stored (see inspectSearchConsoleUrl's docstring).
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const inspectSearchConsoleUrlHandler = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;
  const { url } = req.body;

  LoggerUtil.info('Inspecting Search Console URL', { projectId, userId: userId.toString(), url });

  try {
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
      return res.status(400).json(ResponseUtil.error('A valid http(s) URL is required', 400));
    }

    const project = await SeoProject.findById(projectId);
    if (!project) return res.status(404).json(ResponseUtil.error('Project not found', 404));
    if (project.user_id.toString() !== userId.toString()) {
      return res.status(403).json(ResponseUtil.accessDenied('Access denied'));
    }

    const googleConnection = await GoogleConnection.findActiveConnection(userId, projectId, 'search_console');
    if (!googleConnection) {
      return res.status(400).json(ResponseUtil.error('Google account not connected', 400));
    }
    if (!googleConnection.search_console_site_url) {
      return res.status(400).json(ResponseUtil.error('No Search Console property selected for this project', 400));
    }

    const result = await inspectSearchConsoleUrl(googleConnection, googleConnection.search_console_site_url, url.trim());

    LoggerUtil.info('URL inspected successfully', { projectId, url, verdict: result.verdict });

    return res.json(ResponseUtil.success(result, 'URL inspected successfully'));

  } catch (error) {
    LoggerUtil.error('Error inspecting Search Console URL', error, { projectId, url });
    return res.status(500).json(ResponseUtil.error(error.message || 'Failed to inspect URL', 500));
  }
};

export default {
  syncSearchConsoleData,
  getSearchConsoleSyncStatus,
  getSearchConsoleData,
  getSearchConsoleSitesList,
  selectSearchConsoleSite,
  getSearchConsoleTrends,
  getSearchConsoleBreakdown,
  getSearchConsoleSitemapsList,
  inspectSearchConsoleUrlHandler
};
