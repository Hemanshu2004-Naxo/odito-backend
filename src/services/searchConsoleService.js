import {
  getAuthenticatedHttpClient,
  withRetry,
  logAxiosError,
  getCacheKey,
  getCachedData,
  setCachedData
} from './businessProfileService.js';

/**
 * Search Console API Service
 *
 * Site discovery, explicit property selection, and performance data fetching
 * with backfill/incremental sync support.
 *
 * Reuses businessProfileService.js's generic HTTP/retry/cache helpers rather
 * than reimplementing them - see that file's exports (getAuthenticatedHttpClient,
 * withRetry, logAxiosError, getCacheKey/getCachedData/setCachedData), all of
 * which are already parameterized over baseUrl/cache-key and not
 * Business-Profile-specific.
 *
 * API host: https://www.googleapis.com/webmasters/v3
 * Verified live (2026-07-21) against a real webmasters.readonly-scoped
 * connection: this host returns 200 with real data. The rebranded host
 * (https://searchconsole.googleapis.com) was also tested and returns an
 * identical response on the same /webmasters/v3/... path - Google renamed
 * the product/host but kept the v3 REST path structure. Since the current
 * host is confirmed working, it is kept as-is (no migration risk for zero
 * functional benefit); SEARCH_CONSOLE_API_BASE is the only place a future
 * switch to the rebranded host would need to change.
 */

const SEARCH_CONSOLE_API_BASE = 'https://www.googleapis.com/webmasters/v3';

// The URL Inspection API lives on a different host/version than the rest of
// this file's webmasters/v3 calls - it was introduced later as part of the
// "Search Console API" rebrand and was never folded into webmasters/v3.
// getAuthenticatedHttpClient() is already generic over baseUrl (see
// businessProfileService.js), so this needs no new OAuth/token logic - just
// a second client pointed at a different host.
const SEARCH_CONSOLE_INSPECTION_API_BASE = 'https://searchconsole.googleapis.com/v1';

// Same TTL class as businessProfileService's general cache (10 min) - site
// lists change rarely enough that this is safe, and setCachedData's
// "never cache an empty result" guard already prevents a one-off empty
// response from being treated as "this user has no sites" for the full TTL.
async function getAuthenticatedSearchConsoleClient(googleConnection) {
  return getAuthenticatedHttpClient(googleConnection, SEARCH_CONSOLE_API_BASE);
}

/**
 * Extract domain from project URL for site matching
 */
function extractDomainFromUrl(projectUrl) {
  try {
    const url = new URL(projectUrl);
    return url.hostname;
  } catch (error) {
    console.warn('[SEARCH_CONSOLE] Invalid project URL for domain extraction:', projectUrl);
    return projectUrl;
  }
}

/**
 * Find matching Search Console site for a project.
 *
 * Priority: exact HTTPS URL-prefix match -> exact HTTP URL-prefix match ->
 * domain property (sc-domain:) match -> no match (caller must fall back to
 * explicit user selection via the sites list).
 *
 * The previous implementation's 4th tier - a bare `siteUrl.includes(domain)`
 * substring check - is intentionally removed: it could match an unrelated
 * property whose URL merely contains the domain as a substring (e.g.
 * "example.com" matching "notexample.com.example.com"), which is a real
 * correctness risk for zero practical benefit once explicit site selection
 * exists as a fallback.
 */
function findMatchingSite(sites, projectUrl) {
  const projectDomain = extractDomainFromUrl(projectUrl);

  console.log('[SEARCH_CONSOLE] Finding matching site', {
    projectDomain,
    availableSites: sites.length
  });

  const httpsMatch = sites.find(site =>
    site.siteUrl === `https://${projectDomain}/` ||
    site.siteUrl === `https://${projectDomain}`
  );
  if (httpsMatch) return httpsMatch.siteUrl;

  const httpMatch = sites.find(site =>
    site.siteUrl === `http://${projectDomain}/` ||
    site.siteUrl === `http://${projectDomain}`
  );
  if (httpMatch) return httpMatch.siteUrl;

  const scDomainMatch = sites.find(site => site.siteUrl === `sc-domain:${projectDomain}`);
  if (scDomainMatch) return scDomainMatch.siteUrl;

  console.log('[SEARCH_CONSOLE] No confident automatic match for domain:', projectDomain);
  return null;
}

/**
 * Get list of accessible sites from Search Console (cached, retried).
 */
export async function getSearchConsoleSites(googleConnection) {
  const cacheKey = getCacheKey('sc_sites', googleConnection._id);
  const cached = getCachedData(cacheKey);
  if (cached) return cached;

  try {
    console.log('[SEARCH_CONSOLE] Fetching accessible sites');

    const client = await getAuthenticatedSearchConsoleClient(googleConnection);
    const response = await withRetry(() => client.get('/sites'));

    let sites = [];
    if (response.data?.siteEntry && Array.isArray(response.data.siteEntry)) {
      sites = response.data.siteEntry;
    } else if (response.data?.sites && Array.isArray(response.data.sites)) {
      sites = response.data.sites;
    } else if (Array.isArray(response.data)) {
      sites = response.data;
    }

    console.log('[SEARCH_CONSOLE] Found accessible sites:', { count: sites.length });

    setCachedData(cacheKey, sites);
    return sites;

  } catch (error) {
    logAxiosError('getSearchConsoleSites', error);

    if (error.response?.status === 403) {
      throw new Error('Access denied: User does not have Search Console permissions. Please ensure the user has at least one Search Console property added to their account.');
    }
    if (error.response?.status === 401) {
      throw new Error('Authentication failed: Invalid or expired credentials');
    }

    throw new Error(`Failed to fetch Search Console sites: ${error.message}`);
  }
}

/**
 * Find the appropriate Search Console site for a project (automatic
 * best-effort match, used to pre-select a suggestion - not a substitute for
 * explicit selection when no confident match exists).
 */
export async function findProjectSearchConsoleSite(googleConnection, projectUrl) {
  const sites = await getSearchConsoleSites(googleConnection);

  if (sites.length === 0) {
    throw new Error(`No Search Console properties found in user account. Please add ${projectUrl} to Google Search Console first.`);
  }

  const matchingSite = findMatchingSite(sites, projectUrl);

  if (!matchingSite) {
    const availableSites = sites.map(site => site.siteUrl).join(', ');
    throw new Error(`No matching Search Console property found for project: ${projectUrl}. Available properties: ${availableSites}`);
  }

  return matchingSite;
}

/**
 * Validate that a specific site URL is genuinely accessible to this
 * connection - the Search Console equivalent of
 * businessProfileService.validateBusinessProfileAccess() /
 * analyticsService.validateAnalyticsPropertyAccess(). Used by the explicit
 * property-selection endpoint so a user (or a stale/tampered request) can
 * never select a site this Google account doesn't actually have access to.
 */
export async function validateSearchConsoleSiteAccess(googleConnection, siteUrl) {
  const sites = await getSearchConsoleSites(googleConnection);
  const hasAccess = sites.some(site => site.siteUrl === siteUrl);

  if (!hasAccess) {
    throw new Error(`Site ${siteUrl} not found in user's accessible Search Console properties`);
  }

  return true;
}

/**
 * Low-level Search Analytics `searchAnalytics.query` call, shared by every
 * dimension this service queries (page, date, query, country, device,
 * searchAppearance). Does the HTTP call + retry + date-range math only -
 * callers own row normalization, since each dimension's row shape differs.
 *
 * Factored out of what used to be two near-identical copies of this exact
 * fetch (in getSearchConsolePerformanceData and getSearchConsoleTrendData)
 * so adding more dimensions doesn't mean copy-pasting the POST/retry block
 * again - both of those functions now delegate here with identical external
 * behavior.
 *
 * @param {Object} googleConnection
 * @param {string} siteUrl
 * @param {Object} options
 * @param {number} [options.days=28]
 * @param {string[]} options.dimensions
 * @param {number} [options.rowLimit=50]
 * @returns {Promise<{rows: Array, date_range: {start: string, end: string}}>}
 */
async function querySearchAnalytics(googleConnection, siteUrl, options = {}) {
  const {
    days = 28,
    dimensions,
    rowLimit = 50
  } = options;

  const client = await getAuthenticatedSearchConsoleClient(googleConnection);

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - days);

  const startDateStr = startDate.toISOString().split('T')[0];
  const endDateStr = endDate.toISOString().split('T')[0];

  const requestBody = {
    startDate: startDateStr,
    endDate: endDateStr,
    dimensions,
    rowLimit,
    type: 'web'
  };

  const response = await withRetry(() =>
    client.post(`/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, requestBody)
  );

  return {
    rows: response.data?.rows || [],
    date_range: { start: startDateStr, end: endDateStr }
  };
}

/**
 * Fetch Search Console performance data for a site.
 *
 * @param {Object} googleConnection
 * @param {string} siteUrl
 * @param {Object} [options]
 * @param {number} [options.days=28] - Lookback window. Controller passes a
 *   larger value (e.g. 90) for a first-ever sync and a small rolling value
 *   (e.g. 7) for incremental syncs - see searchConsoleController.js. 28 is
 *   kept as the default only for direct/manual callers that don't specify it.
 * @param {string[]} [options.dimensions=['page']]
 * @param {number} [options.rowLimit=50]
 */
export async function getSearchConsolePerformanceData(googleConnection, siteUrl, options = {}) {
  const {
    days = 28,
    dimensions = ['page'],
    rowLimit = 50
  } = options;

  try {
    console.log('[SEARCH_CONSOLE] Fetching performance data', { siteUrl, days, dimensions, rowLimit });

    const { rows: rawData, date_range: { start: startDateStr, end: endDateStr } } =
      await querySearchAnalytics(googleConnection, siteUrl, { days, dimensions, rowLimit });

    if (rawData.length === 0) {
      console.log('[SEARCH_CONSOLE] No performance data available for this range');
      return { data: [], synced_pages: 0, skipped_pages: 0, date_range: { start: startDateStr, end: endDateStr } };
    }

    const normalizeRow = (row) => {
      if (!row || typeof row !== 'object' || !Array.isArray(row.keys) || row.keys.length === 0) {
        return null;
      }

      const pageUrl = row.keys[0] || '';
      const clicks = row.clicks || 0;
      const impressions = row.impressions || 0;

      if (!pageUrl && clicks === 0 && impressions === 0) {
        return null;
      }

      return {
        page_url: pageUrl,
        clicks: parseInt(clicks, 10),
        impressions: parseInt(impressions, 10),
        ctr: parseFloat(row.ctr || 0),
        position: parseFloat(row.position || 0)
      };
    };

    const normalizedData = rawData.map(normalizeRow).filter(Boolean);
    const skippedCount = rawData.length - normalizedData.length;

    console.log('[SEARCH_CONSOLE] Normalized performance data', {
      rowsIn: rawData.length,
      rowsOut: normalizedData.length,
      skipped: skippedCount
    });

    return {
      data: normalizedData,
      synced_pages: normalizedData.length,
      skipped_pages: skippedCount,
      date_range: { start: startDateStr, end: endDateStr }
    };

  } catch (error) {
    logAxiosError('getSearchConsolePerformanceData', error);

    if (error.response?.status === 403) {
      throw new Error(`Access denied: No permission for site ${siteUrl}`);
    }
    if (error.response?.status === 404) {
      throw new Error(`Site not found in Search Console: ${siteUrl}`);
    }
    if (error.response?.status === 400) {
      const errorDetails = error.response?.data?.error?.message || error.message;
      throw new Error(`Invalid request: ${errorDetails}`);
    }

    throw new Error(`Failed to fetch Search Console performance data: ${error.message}`);
  }
}

/**
 * Complete workflow: find (or use a given) site and fetch performance data.
 *
 * @param {Object} googleConnection
 * @param {string} projectUrl
 * @param {Object} [options] - forwarded to getSearchConsolePerformanceData
 *   (days/dimensions/rowLimit); siteUrl may be passed explicitly to skip
 *   automatic matching once a site has been selected via
 *   validateSearchConsoleSiteAccess()/selectSearchConsoleSite.
 */
export async function getProjectSearchConsoleData(googleConnection, projectUrl, options = {}) {
  const siteUrl = options.siteUrl || await findProjectSearchConsoleSite(googleConnection, projectUrl);
  const performanceResult = await getSearchConsolePerformanceData(googleConnection, siteUrl, options);

  console.log('[SEARCH_CONSOLE] Workflow completed', {
    siteUrl,
    dataPoints: performanceResult.data.length
  });

  return performanceResult;
}

/**
 * Fetch day-by-day Search Console performance for a site, using the `date`
 * dimension instead of `page`. Powers the Search Performance Trends chart -
 * getSearchConsolePerformanceData's `page` dimension has no per-day
 * resolution to chart (it returns one aggregate row per page for the whole
 * requested window).
 *
 * @param {Object} googleConnection
 * @param {string} siteUrl
 * @param {Object} [options]
 * @param {number} [options.days=90] - Lookback window.
 * @param {number} [options.rowLimit=1000] - One row per calendar day, so
 *   even a 400-day backfill is well within this default.
 */
export async function getSearchConsoleTrendData(googleConnection, siteUrl, options = {}) {
  const {
    days = 90,
    rowLimit = 1000
  } = options;

  try {
    console.log('[SEARCH_CONSOLE] Fetching daily trend data', { siteUrl, days, rowLimit });

    const { rows: rawData, date_range: { start: startDateStr, end: endDateStr } } =
      await querySearchAnalytics(googleConnection, siteUrl, { days, dimensions: ['date'], rowLimit });

    if (rawData.length === 0) {
      console.log('[SEARCH_CONSOLE] No trend data available for this range');
      return { data: [], date_range: { start: startDateStr, end: endDateStr } };
    }

    const normalizeRow = (row) => {
      if (!row || typeof row !== 'object' || !Array.isArray(row.keys) || row.keys.length === 0) {
        return null;
      }

      const date = row.keys[0] || '';
      if (!date) return null;

      return {
        date,
        clicks: parseInt(row.clicks || 0, 10),
        impressions: parseInt(row.impressions || 0, 10),
        ctr: parseFloat(row.ctr || 0),
        position: parseFloat(row.position || 0)
      };
    };

    const normalizedData = rawData.map(normalizeRow).filter(Boolean);

    console.log('[SEARCH_CONSOLE] Normalized trend data', {
      rowsIn: rawData.length,
      rowsOut: normalizedData.length
    });

    return {
      data: normalizedData,
      date_range: { start: startDateStr, end: endDateStr }
    };

  } catch (error) {
    logAxiosError('getSearchConsoleTrendData', error);

    if (error.response?.status === 403) {
      throw new Error(`Access denied: No permission for site ${siteUrl}`);
    }
    if (error.response?.status === 404) {
      throw new Error(`Site not found in Search Console: ${siteUrl}`);
    }
    if (error.response?.status === 400) {
      const errorDetails = error.response?.data?.error?.message || error.message;
      throw new Error(`Invalid request: ${errorDetails}`);
    }

    throw new Error(`Failed to fetch Search Console trend data: ${error.message}`);
  }
}

/**
 * Complete workflow: find (or use a given) site and fetch daily trend data.
 * Mirrors getProjectSearchConsoleData for the `date`-dimension query.
 */
export async function getProjectSearchConsoleTrends(googleConnection, projectUrl, options = {}) {
  const siteUrl = options.siteUrl || await findProjectSearchConsoleSite(googleConnection, projectUrl);
  const trendResult = await getSearchConsoleTrendData(googleConnection, siteUrl, options);

  console.log('[SEARCH_CONSOLE] Trends workflow completed', {
    siteUrl,
    dataPoints: trendResult.data.length
  });

  return trendResult;
}

// The 4 additional dimensions the Search Analytics API supports beyond
// `page`/`date` (already used above) - query terms, geography, device
// class, and how the result appeared in Google's SERP. One row per
// dimension value, keyed generically as `dimension_value` since the
// meaning changes per dimension (a query string, an ISO country code, a
// device class, a search-appearance type).
export const BREAKDOWN_DIMENSIONS = ['query', 'country', 'device', 'searchAppearance'];

/**
 * Fetch a single-dimension breakdown (query/country/device/searchAppearance)
 * for a site. Same underlying `searchAnalytics.query` call as
 * getSearchConsolePerformanceData/getSearchConsoleTrendData - only the
 * dimension and row normalization differ, via the shared
 * querySearchAnalytics() helper.
 *
 * @param {Object} googleConnection
 * @param {string} siteUrl
 * @param {string} dimension - one of BREAKDOWN_DIMENSIONS
 * @param {Object} [options]
 * @param {number} [options.days=28]
 * @param {number} [options.rowLimit=25]
 */
export async function getSearchConsoleBreakdownData(googleConnection, siteUrl, dimension, options = {}) {
  if (!BREAKDOWN_DIMENSIONS.includes(dimension)) {
    throw new Error(`Invalid breakdown dimension: ${dimension}. Must be one of: ${BREAKDOWN_DIMENSIONS.join(', ')}`);
  }

  const { days = 28, rowLimit = 25 } = options;

  try {
    console.log('[SEARCH_CONSOLE] Fetching breakdown data', { siteUrl, dimension, days, rowLimit });

    const { rows: rawData, date_range } =
      await querySearchAnalytics(googleConnection, siteUrl, { days, dimensions: [dimension], rowLimit });

    const normalizeRow = (row) => {
      if (!row || typeof row !== 'object' || !Array.isArray(row.keys) || row.keys.length === 0) {
        return null;
      }

      const dimensionValue = row.keys[0] || '';
      const clicks = row.clicks || 0;
      const impressions = row.impressions || 0;

      if (!dimensionValue && clicks === 0 && impressions === 0) {
        return null;
      }

      return {
        dimension_value: dimensionValue,
        clicks: parseInt(clicks, 10),
        impressions: parseInt(impressions, 10),
        ctr: parseFloat(row.ctr || 0),
        position: parseFloat(row.position || 0)
      };
    };

    const normalizedData = rawData.map(normalizeRow).filter(Boolean);

    console.log('[SEARCH_CONSOLE] Normalized breakdown data', {
      dimension,
      rowsIn: rawData.length,
      rowsOut: normalizedData.length
    });

    return { data: normalizedData, date_range };

  } catch (error) {
    logAxiosError('getSearchConsoleBreakdownData', error);

    if (error.response?.status === 403) {
      throw new Error(`Access denied: No permission for site ${siteUrl}`);
    }
    if (error.response?.status === 404) {
      throw new Error(`Site not found in Search Console: ${siteUrl}`);
    }
    if (error.response?.status === 400) {
      const errorDetails = error.response?.data?.error?.message || error.message;
      throw new Error(`Invalid request: ${errorDetails}`);
    }

    throw new Error(`Failed to fetch Search Console ${dimension} breakdown: ${error.message}`);
  }
}

/**
 * Complete workflow: find (or use a given) site and fetch a breakdown.
 * Mirrors getProjectSearchConsoleData/getProjectSearchConsoleTrends.
 */
export async function getProjectSearchConsoleBreakdown(googleConnection, projectUrl, dimension, options = {}) {
  const siteUrl = options.siteUrl || await findProjectSearchConsoleSite(googleConnection, projectUrl);
  const result = await getSearchConsoleBreakdownData(googleConnection, siteUrl, dimension, options);

  console.log('[SEARCH_CONSOLE] Breakdown workflow completed', {
    siteUrl,
    dimension,
    dataPoints: result.data.length
  });

  return result;
}

/**
 * List submitted sitemaps for a site (Sitemaps API - same webmasters/v3
 * host as everything else in this file, just a different resource).
 * Live-fetched and cached like getSearchConsoleSites(), not synced to Mongo:
 * a site typically has only a handful of sitemaps, so there's no need for
 * the sync/store pattern used for performance data.
 */
export async function getSearchConsoleSitemaps(googleConnection, siteUrl) {
  const cacheKey = getCacheKey('sc_sitemaps', googleConnection._id, siteUrl);
  const cached = getCachedData(cacheKey);
  if (cached) return cached;

  try {
    console.log('[SEARCH_CONSOLE] Fetching sitemaps', { siteUrl });

    const client = await getAuthenticatedSearchConsoleClient(googleConnection);
    const response = await withRetry(() =>
      client.get(`/sites/${encodeURIComponent(siteUrl)}/sitemaps`)
    );

    const rawSitemaps = Array.isArray(response.data?.sitemap) ? response.data.sitemap : [];

    const sitemaps = rawSitemaps.map((s) => ({
      path: s.path,
      last_submitted: s.lastSubmitted || null,
      last_downloaded: s.lastDownloaded || null,
      is_pending: !!s.isPending,
      is_sitemaps_index: !!s.isSitemapsIndex,
      type: s.type || null,
      warnings: s.warnings != null ? parseInt(s.warnings, 10) : 0,
      errors: s.errors != null ? parseInt(s.errors, 10) : 0,
      contents: Array.isArray(s.contents)
        ? s.contents.map((c) => ({ type: c.type, submitted: parseInt(c.submitted || 0, 10), indexed: parseInt(c.indexed || 0, 10) }))
        : []
    }));

    console.log('[SEARCH_CONSOLE] Sitemaps retrieved', { siteUrl, count: sitemaps.length });

    setCachedData(cacheKey, sitemaps);
    return sitemaps;

  } catch (error) {
    logAxiosError('getSearchConsoleSitemaps', error);

    if (error.response?.status === 403) {
      throw new Error(`Access denied: No permission for site ${siteUrl}`);
    }
    if (error.response?.status === 404) {
      throw new Error(`Site not found in Search Console: ${siteUrl}`);
    }

    throw new Error(`Failed to fetch Search Console sitemaps: ${error.message}`);
  }
}

/**
 * Inspect a single URL's indexing status (URL Inspection API). Live,
 * on-demand, user-triggered - not synced/stored, matching how the
 * inspection widget itself works (type a URL, inspect it, see the result).
 *
 * Uses SEARCH_CONSOLE_INSPECTION_API_BASE, not SEARCH_CONSOLE_API_BASE -
 * this endpoint was never added to webmasters/v3.
 */
export async function inspectSearchConsoleUrl(googleConnection, siteUrl, inspectionUrl) {
  try {
    console.log('[SEARCH_CONSOLE] Inspecting URL', { siteUrl, inspectionUrl });

    const client = await getAuthenticatedHttpClient(googleConnection, SEARCH_CONSOLE_INSPECTION_API_BASE);

    const response = await withRetry(() =>
      client.post('/urlInspection/index:inspect', { inspectionUrl, siteUrl })
    );

    const result = response.data?.inspectionResult || {};
    const indexStatus = result.indexStatusResult || {};
    const richResults = result.richResultsResult || {};
    // mobileUsabilityResult is only present for connections/properties Google
    // still returns it for - the standalone Mobile-Friendly Test API this
    // fed was deprecated, so most inspections will have no mobile usability
    // data at all. Normalized to null (not fabricated) when absent; the
    // frontend renders that as "—", never a guessed value.
    const mobileUsability = result.mobileUsabilityResult || {};

    return {
      inspection_url: inspectionUrl,
      verdict: indexStatus.verdict || 'UNKNOWN',
      coverage_state: indexStatus.coverageState || null,
      robots_txt_state: indexStatus.robotsTxtState || null,
      indexing_state: indexStatus.indexingState || null,
      page_fetch_state: indexStatus.pageFetchState || null,
      last_crawl_time: indexStatus.lastCrawlTime || null,
      google_canonical: indexStatus.googleCanonical || null,
      user_canonical: indexStatus.userCanonical || null,
      sitemap: Array.isArray(indexStatus.sitemap) ? indexStatus.sitemap : [],
      referring_urls: Array.isArray(indexStatus.referringUrls) ? indexStatus.referringUrls : [],
      crawled_as: indexStatus.crawledAs || null,
      mobile_usability_verdict: mobileUsability.verdict || null,
      rich_results_verdict: richResults.verdict || null,
      inspection_result_link: result.inspectionResultLink || null
    };

  } catch (error) {
    logAxiosError('inspectSearchConsoleUrl', error);

    if (error.response?.status === 403) {
      throw new Error(`Access denied: No permission for site ${siteUrl}`);
    }
    if (error.response?.status === 400) {
      const errorDetails = error.response?.data?.error?.message || error.message;
      throw new Error(`Invalid request: ${errorDetails}`);
    }

    throw new Error(`Failed to inspect URL: ${error.message}`);
  }
}

export default {
  getSearchConsoleSites,
  findProjectSearchConsoleSite,
  validateSearchConsoleSiteAccess,
  getSearchConsolePerformanceData,
  getProjectSearchConsoleData,
  getSearchConsoleTrendData,
  getProjectSearchConsoleTrends,
  getSearchConsoleBreakdownData,
  getProjectSearchConsoleBreakdown,
  getSearchConsoleSitemaps,
  inspectSearchConsoleUrl
};
