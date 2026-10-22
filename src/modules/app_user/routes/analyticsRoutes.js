import express from 'express';
import {
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
} from '../controller/analyticsController.js';
import auth from '../../user/middleware/auth.js';

const router = express.Router();

/**
 * Analytics API Routes
 * 
 * Endpoints:
 * POST /projects/:projectId/analytics/sync - Manual sync
 * GET /projects/:projectId/analytics/status - Sync status
 * GET /projects/:projectId/analytics/data - Performance data
 * GET /projects/:projectId/analytics/properties - List properties
 * POST /projects/:projectId/analytics/select-property - Select property
 */

/**
 * POST /projects/:projectId/analytics/sync
 * 
 * Manual sync endpoint for Analytics data
 * 
 * Request: {}
 * Response: {
 *   success: true,
 *   syncedPages: 42,
 *   dateRange: { start: "YYYY-MM-DD", end: "YYYY-MM-DD" },
 *   lastSyncAt: "ISO_DATE"
 * }
 */
router.post('/:projectId/analytics/sync', 
  auth, 
  syncAnalyticsData
);

/**
 * GET /projects/:projectId/analytics/status
 * 
 * Get sync status and connection info
 * 
 * Response: {
 *   success: true,
 *   connected: true,
 *   serviceEnabled: true,
 *   analyticsPropertyId: "123456789",
 *   lastSyncAt: "ISO_DATE",
 *   dataPoints: 150,
 *   latestDataDate: "ISO_DATE",
 *   googleEmail: "user@example.com"
 * }
 */
router.get('/:projectId/analytics/status', 
  auth, 
  getAnalyticsSyncStatus
);

/**
 * GET /projects/:projectId/analytics/data
 * 
 * Get Analytics performance data with pagination
 * 
 * Query Parameters:
 * - page: Page number (default: 1)
 * - limit: Items per page (default: 50, max: 100)
 * - sort: Sort field (sessions, activeUsers, pageViews, engagementRate, pagePath)
 * - order: Sort order (asc, desc)
 * - start_date: Filter start date (YYYY-MM-DD)
 * - end_date: Filter end date (YYYY-MM-DD)
 * 
 * Response: {
 *   success: true,
 *   data: [{ pagePath, sessions, activeUsers, pageViews, engagementRate, ... }],
 *   pagination: { page, limit, total, pages },
 *   summary: { totalSessions, totalPageViews, avgEngagementRate, lastFetched },
 *   dateRange: { start, end }
 * }
 */
router.get('/:projectId/analytics/data', 
  auth, 
  getAnalyticsData
);

/**
 * GET /projects/:projectId/analytics/properties
 * 
 * List accessible Analytics properties
 * 
 * Response: {
 *   success: true,
 *   properties: [
 *     {
 *       propertyId: "123456789",
 *       displayName: "My Website",
 *       websiteUrl: "https://example.com"
 *     }
 *   ]
 * }
 */
router.get('/:projectId/analytics/properties', 
  auth, 
  getAnalyticsPropertiesList
);

/**
 * POST /projects/:projectId/analytics/select-property
 * 
 * Select and store Analytics property
 * 
 * Request: {
 *   propertyId: "123456789"
 * }
 * Response: {
 *   success: true,
 *   analyticsPropertyId: "123456789"
 * }
 */
router.post('/:projectId/analytics/select-property',
  auth,
  selectAnalyticsProperty
);

/**
 * GET /projects/:projectId/analytics/trends
 *
 * Daily trend series (Phase 1) - powers the Hero KPI grid, Traffic Trends
 * chart, and Today's Summary from a single GA4 Data API runReport call.
 *
 * Query Parameters:
 * - range: '7' | '30' | '90' | '365' (default '30')
 *
 * Response: {
 *   success: true,
 *   data: {
 *     series: [{ date, users, newUsers, sessions, engagedSessions, views, avgEngagementTime, bounceRate, conversions }],
 *     totals: { users, newUsers, sessions, engagedSessions, views, avgEngagementTime, bounceRate, conversions },
 *     dateRange: { start, end }
 *   },
 *   meta: { range: "30", lastSyncAt: "ISO_DATE", generatedAt: "ISO_DATE" }
 * }
 */
router.get('/:projectId/analytics/trends',
  auth,
  getAnalyticsTrends
);

/**
 * GET /projects/:projectId/analytics/property
 *
 * Property facts (Phase 1) - powers the Analytics Header / Property card.
 * Reuses the already-selected analytics_property_id; does not introduce a
 * second property lookup flow.
 *
 * Response: {
 *   success: true,
 *   data: {
 *     propertyId: "384021957",
 *     propertyName: "Bellhaven Dental — Web",
 *     websiteUrl: "https://bellhavendental.com",
 *     measurementId: "G-8QK3P1XN2M",
 *     timezone: "America/Los_Angeles"
 *   },
 *   meta: { lastSyncAt: "ISO_DATE", generatedAt: "ISO_DATE" }
 * }
 */
router.get('/:projectId/analytics/property',
  auth,
  getAnalyticsProperty
);

/**
 * GET /projects/:projectId/analytics/breakdowns
 *
 * Traffic Sources, Top Channels, Countries, Devices, Browsers and
 * Operating Systems (Phase 2) - one batchRunReports call, 5 bundled
 * sub-reports.
 *
 * Query Parameters:
 * - range: '7' | '30' | '90' | '365' (default '30')
 *
 * Response: {
 *   success: true,
 *   data: {
 *     sources: [{ key, label, value }],
 *     channels: [{ key, label, users, sessions, engagementRate, conversions }],
 *     countries: [{ key, label, countryId, value }],
 *     devices: [{ key, label, value }],
 *     browsers: [{ key, label, value }],
 *     operatingSystems: [{ key, label, value }],
 *     dateRange: { start, end }
 *   },
 *   meta: { range: "30", lastSyncAt: "ISO_DATE", generatedAt: "ISO_DATE" }
 * }
 */
router.get('/:projectId/analytics/breakdowns',
  auth,
  getBreakdowns
);

/**
 * GET /projects/:projectId/analytics/events
 *
 * Top events by count, with users and period-over-period trend (Phase 2).
 * Shares its Google fetch with GET .../conversions.
 *
 * Query Parameters:
 * - range: '7' | '30' | '90' | '365' (default '30')
 *
 * Response: {
 *   success: true,
 *   data: {
 *     events: [{ name, count, users, trend, trendDirection }],
 *     dateRange: { start, end }
 *   },
 *   meta: { range: "30", lastSyncAt: "ISO_DATE", generatedAt: "ISO_DATE" }
 * }
 */
router.get('/:projectId/analytics/events',
  auth,
  getEvents
);

/**
 * GET /projects/:projectId/analytics/conversions
 *
 * Conversion events bucketed into named categories (Phase 2). Shares its
 * Google fetch with GET .../events - see analyticsService.js.
 *
 * Query Parameters:
 * - range: '7' | '30' | '90' | '365' (default '30')
 *
 * Response: {
 *   success: true,
 *   data: {
 *     conversions: [{ key, label, count, trend }],
 *     totalConversions: 23,
 *     dateRange: { start, end }
 *   },
 *   meta: { range: "30", lastSyncAt: "ISO_DATE", generatedAt: "ISO_DATE" }
 * }
 */
router.get('/:projectId/analytics/conversions',
  auth,
  getConversions
);

/**
 * GET /projects/:projectId/analytics/realtime
 *
 * Active Users, Active Pages, Active Countries, Active Devices right now
 * (Phase 3) - 3 parallel runRealtimeReport calls. No `range` query param
 * (realtime has no configurable window) and never cached - always live.
 *
 * Response: {
 *   success: true,
 *   data: {
 *     activeUsers: 128,
 *     topPages: [{ path, users }],
 *     topCountries: [{ key, label, users }],
 *     deviceSplit: [{ key, label, users }]
 *   },
 *   meta: { lastSyncAt: "ISO_DATE", generatedAt: "ISO_DATE" }
 * }
 */
router.get('/:projectId/analytics/realtime',
  auth,
  getRealtime
);

/**
 * GET /projects/:projectId/analytics/health
 *
 * Odito-derived Analytics Health score (Phase 3) - NOT a Google metric.
 * See AnalyticsMapper.toHealthDTO for the documented formula. Reuses the
 * Trends endpoint's own cache - zero additional Google requests if Trends
 * was already fetched for the same range recently.
 *
 * Query Parameters:
 * - range: '7' | '30' | '90' | '365' (default '30')
 *
 * Response: {
 *   success: true,
 *   data: {
 *     score: 82,
 *     status: "Good",
 *     reasons: ["Sessions increasing", "Bounce rate improving", "Conversions stable"],
 *     formulaVersion: "v1"
 *   },
 *   meta: { range: "30", lastSyncAt: "ISO_DATE", generatedAt: "ISO_DATE" }
 * }
 */
router.get('/:projectId/analytics/health',
  auth,
  getHealth
);

/**
 * GET /projects/:projectId/analytics/activity
 *
 * Recent Analytics Activity (Phase 3), synthesized server-side from
 * GoogleConnection's own timestamps - no Google API call, no cache.
 *
 * Response: {
 *   success: true,
 *   data: {
 *     activity: [{ id, text, timestamp }]
 *   },
 *   meta: { lastSyncAt: "ISO_DATE", generatedAt: "ISO_DATE" }
 * }
 */
router.get('/:projectId/analytics/activity',
  auth,
  getActivity
);

export default router;
