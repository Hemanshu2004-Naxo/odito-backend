import express from 'express';
import {
  syncSearchConsoleData,
  getSearchConsoleSyncStatus,
  getSearchConsoleData,
  getSearchConsoleSitesList,
  selectSearchConsoleSite,
  getSearchConsoleTrends,
  getSearchConsoleBreakdown,
  getSearchConsoleSitemapsList,
  inspectSearchConsoleUrlHandler
} from '../controller/searchConsoleController.js';
import auth from '../../user/middleware/auth.js';

const router = express.Router();

/**
 * Search Console API Routes
 * 
 * Endpoints:
 * POST /projects/:projectId/search-console/sync - Manual sync
 * GET /projects/:projectId/search-console/status - Sync status
 * GET /projects/:projectId/search-console/data - Performance data
 */

/**
 * POST /projects/:projectId/search-console/sync
 * 
 * Manual sync endpoint for Search Console data
 * 
 * Request: {}
 * Response: {
 *   success: true,
 *   synced_pages: 42,
 *   date_range: { start: "YYYY-MM-DD", end: "YYYY-MM-DD" },
 *   last_sync_at: "ISO_DATE"
 * }
 */
router.post('/:projectId/search-console/sync', 
  auth, 
  syncSearchConsoleData
);

/**
 * GET /projects/:projectId/search-console/status
 * 
 * Get sync status and connection info
 * 
 * Response: {
 *   success: true,
 *   connected: true,
 *   service_enabled: true,
 *   last_sync_at: "ISO_DATE",
 *   data_points: 150,
 *   latest_data_date: "ISO_DATE",
 *   google_email: "user@example.com"
 * }
 */
router.get('/:projectId/search-console/status', 
  auth, 
  getSearchConsoleSyncStatus
);

/**
 * GET /projects/:projectId/search-console/data
 * 
 * Get Search Console performance data with pagination
 * 
 * Query Parameters:
 * - page: Page number (default: 1)
 * - limit: Items per page (default: 50, max: 100)
 * - sort: Sort field (clicks, impressions, ctr, position, page_url)
 * - order: Sort order (asc, desc)
 * - start_date: Filter start date (YYYY-MM-DD)
 * - end_date: Filter end date (YYYY-MM-DD)
 * 
 * Response: {
 *   success: true,
 *   data: [{ page_url, clicks, impressions, ctr, position, ... }],
 *   pagination: { page, limit, total, pages },
 *   summary: { total_clicks, total_impressions, avg_ctr, avg_position },
 *   date_range: { start, end }
 * }
 */
router.get('/:projectId/search-console/data',
  auth,
  getSearchConsoleData
);

/**
 * GET /projects/:projectId/search-console/sites
 *
 * List accessible Search Console sites
 *
 * Response: {
 *   success: true,
 *   data: [{ siteUrl: "https://example.com/" | "sc-domain:example.com", permissionLevel }]
 * }
 */
router.get('/:projectId/search-console/sites',
  auth,
  getSearchConsoleSitesList
);

/**
 * POST /projects/:projectId/search-console/select-site
 *
 * Select and store a Search Console site for a project
 *
 * Request: { siteUrl: "https://example.com/" }
 * Response: { success: true, searchConsoleSiteUrl: "https://example.com/" }
 */
router.post('/:projectId/search-console/select-site',
  auth,
  selectSearchConsoleSite
);

/**
 * GET /projects/:projectId/search-console/trends
 *
 * Get the daily Search Console performance series (date dimension) for the
 * Search Performance Trends chart.
 *
 * Query Parameters:
 * - range: '7' | '30' | '90' | '365' (default '30')
 *
 * Response: {
 *   success: true,
 *   data: {
 *     series: [{ date: "YYYY-MM-DD", clicks, impressions, ctr, position }],
 *     range: "30"
 *   }
 * }
 */
router.get('/:projectId/search-console/trends',
  auth,
  getSearchConsoleTrends
);

/**
 * GET /projects/:projectId/search-console/breakdown
 *
 * Get a stored dimension breakdown (query/country/device/searchAppearance),
 * synced alongside the page-level data on every /sync call.
 *
 * Query Parameters:
 * - dimension: 'query' | 'country' | 'device' | 'searchAppearance' (required)
 * - limit: max rows to return (default varies per dimension, capped at 100)
 *
 * Response: {
 *   success: true,
 *   data: {
 *     dimension: "query",
 *     rows: [{ dimension_value, clicks, impressions, ctr, position }],
 *     date_range: { start: "ISO_DATE", end: "ISO_DATE" } | null
 *   }
 * }
 */
router.get('/:projectId/search-console/breakdown',
  auth,
  getSearchConsoleBreakdown
);

/**
 * GET /projects/:projectId/search-console/sitemaps
 *
 * List submitted sitemaps for the project's selected property (Sitemaps
 * API), live-fetched (not synced/stored).
 *
 * Response: {
 *   success: true,
 *   data: [{ path, last_submitted, last_downloaded, is_pending,
 *            is_sitemaps_index, type, warnings, errors, contents }]
 * }
 */
router.get('/:projectId/search-console/sitemaps',
  auth,
  getSearchConsoleSitemapsList
);

/**
 * POST /projects/:projectId/search-console/inspect-url
 *
 * Inspect a single URL's indexing status (URL Inspection API). Live,
 * on-demand - not synced/stored.
 *
 * Request: { url: "https://example.com/some-page" }
 * Response: {
 *   success: true,
 *   data: {
 *     inspection_url, verdict, coverage_state, robots_txt_state,
 *     indexing_state, page_fetch_state, last_crawl_time, google_canonical,
 *     user_canonical, sitemap, referring_urls, crawled_as,
 *     rich_results_verdict, inspection_result_link
 *   }
 * }
 */
router.post('/:projectId/search-console/inspect-url',
  auth,
  inspectSearchConsoleUrlHandler
);

export default router;
