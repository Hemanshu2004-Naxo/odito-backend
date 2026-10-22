import { getValidAccessToken, createAuthenticatedClient } from './googleApiService.js';
import axios from 'axios';

/**
 * Business Profile API Service
 * 
 * Implementation for Google My Business APIs
 * 
 * APIs Used:
 * - Account Management API: https://mybusinessaccountmanagement.googleapis.com/v1/accounts
 * - Business Information API: https://mybusinessbusinessinformation.googleapis.com/v1/
 * - Business Profile Performance API: https://businessprofileperformance.googleapis.com/v1/
 * 
 * Safety Features:
 * - Uses centralized token refresh
 * - Exponential backoff for quota management
 * - Comprehensive error handling
 * - Normalized output format
 * - 10-15 minute caching
 */

// Business Profile API base URLs
// Exported (not just used internally) so businessProfileReviewService.js
// reuses the exact same hosts rather than redeclaring them.
export const GBP_ACCOUNT_MANAGEMENT_API = 'https://mybusinessaccountmanagement.googleapis.com/v1';
export const GBP_BUSINESS_INFO_API = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const GBP_PERFORMANCE_API = 'https://businessprofileperformance.googleapis.com/v1';
// Reviews remain on the legacy (v4) My Business API - there is no reviews
// endpoint on businessprofileperformance.googleapis.com. Google restricts
// general developer access to accounts.locations.reviews.list (allowlist
// required as of the 2024 API policy change), so calls to this host are
// expected to 403 for most projects and are handled as a soft failure below.
export const GBP_LEGACY_API = 'https://mybusiness.googleapis.com/v4';

// mybusinessbusinessinformation.googleapis.com's accounts.locations.list and
// accounts.locations.get methods both REQUIRE a readMask query parameter —
// Google rejects the request with 400 INVALID_ARGUMENT before any
// authorization check runs if it's absent, regardless of how valid the
// token/scopes are. Field names are the current v1 Location resource shape
// (title / storefrontAddress / categories.primaryCategory), which replaced
// the v4 My Business API's displayName / address / primaryCategory names.
export const LOCATION_READ_MASK = 'name,title,storefrontAddress,categories,websiteUri';

// Extended field mask for the dedicated Business Profile dashboard page -
// everything LOCATION_READ_MASK omits that the page needs to display
// (description, phone, hours, coordinates, service area, open/verification
// metadata). Kept separate from LOCATION_READ_MASK rather than widening that
// constant in place, because LOCATION_READ_MASK is also used by
// getBusinessProfileLocations() (the account->locations dropdown list) and
// validateBusinessProfileAccess() - neither needs this much payload per row,
// and businessProfileReviewService.fetchBusinessMetadata() already appends
// its own one-off field (phoneNumbers) onto LOCATION_READ_MASK the same way.
export const EXTENDED_LOCATION_READ_MASK =
  'name,title,phoneNumbers,categories,storefrontAddress,websiteUri,regularHours,specialHours,serviceArea,latlng,openInfo,metadata,profile';

// Current (2023+) Business Profile Performance API daily metrics, fetched via
// the ":fetchMultiDailyMetricsTimeSeries" custom method. These replace the
// deprecated GMB API v4 Insights metric names (VIEWS_SEARCH, VIEWS_MAPS,
// ACTIONS_WEBSITE, ACTIONS_PHONE, ACTIONS_DRIVING_DIRECTIONS) which do not
// exist on the businessprofileperformance.googleapis.com host - the previous
// implementation sent v4 metric names to the v1 performance API, which would
// fail as an invalid request.
const DAILY_METRICS = [
  'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
  'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
  'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
  'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
  'WEBSITE_CLICKS',
  'CALL_CLICKS',
  'BUSINESS_DIRECTION_REQUESTS',
  'BUSINESS_BOOKINGS'
];

/**
 * Simple in-memory cache (10-15 minute TTL)
 * Prevents rapid repeated API calls that trigger quota limits
 */
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

export function getCacheKey(prefix, ...args) {
  return `${prefix}:${args.join(':')}`;
}

export function getCachedData(key) {
  const cached = cache.get(key);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    console.log(`[BUSINESS_PROFILE] Returning cached data for key: ${key}`);
    return cached.data;
  }
  return null;
}

export function setCachedData(key, data) {
  // Never cache an empty result. An empty array is indistinguishable here
  // from "Google returned nothing this one time" (a transient 5xx that
  // exhausted retries into an unexpected shape, a request landing mid-token-
  // refresh, eventual consistency right after a fresh OAuth connection,
  // etc.) versus "this account genuinely has zero accounts/locations" - and
  // caching the former for the full TTL with no way to force a retry turns
  // a one-off blip into up to 10 minutes of the UI showing "no locations"
  // even though Google has real data.
  if (Array.isArray(data) && data.length === 0) {
    console.log(`[BUSINESS_PROFILE] Not caching empty result for key: ${key}`);
    return;
  }

  cache.set(key, {
    data,
    timestamp: Date.now()
  });

  // Clean up old cache entries periodically
  if (cache.size > 50) {
    const now = Date.now();
    for (const [cacheKey, value] of cache.entries()) {
      if (now - value.timestamp > CACHE_TTL) {
        cache.delete(cacheKey);
      }
    }
  }
}

/**
 * Generic cache-entry removal by exact key and/or key-prefix, against the
 * one module-private `cache` Map above. This is the single shared primitive
 * every service-specific "clear this connection's cache" helper is built
 * on (clearCacheForConnection below; analyticsService.js's
 * clearAnalyticsCacheForConnection) - there is exactly one place that
 * knows how to iterate/delete cache entries, not one per service, even
 * though multiple services' prefixes live in the same Map.
 *
 * @param {Object} options
 * @param {string[]} [options.exactKeys] - keys removed only on an exact match
 * @param {string[]} [options.prefixes] - keys removed if they start with any of these
 * @returns {number} count of entries removed
 */
export function clearCacheEntries({ exactKeys = [], prefixes = [] } = {}) {
  let cleared = 0;
  for (const key of cache.keys()) {
    if (exactKeys.includes(key) || prefixes.some((prefix) => key.startsWith(prefix))) {
      cache.delete(key);
      cleared++;
    }
  }
  return cleared;
}

/**
 * Clear every cached accounts/locations/performance entry for a specific
 * GoogleConnection.
 *
 * Must be called whenever a connection's underlying Google identity can
 * change - i.e. on OAuth (re)connect - because the cache keys are keyed by
 * GoogleConnection._id, and reconnecting reuses the same _id (upsert matched
 * on user_id+project_id+purpose, not on Google account identity). Without
 * this, switching from one Google account to another on the same project
 * can serve stale accounts/locations cached under the previous identity.
 *
 * Scoped to Business Profile's own prefixes only - Search Console and
 * Analytics own and clear their own prefixes (see
 * analyticsService.js's clearAnalyticsCacheForConnection), all built on the
 * same clearCacheEntries primitive above rather than this function reaching
 * into cache namespaces it doesn't own.
 */
export function clearCacheForConnection(connectionId) {
  const cleared = clearCacheEntries({
    exactKeys: [`accounts:${connectionId}`],
    prefixes: [`locations:${connectionId}:`, `performance:${connectionId}:`],
  });
  if (cleared > 0) {
    console.log(`[BUSINESS_PROFILE] Cleared ${cleared} cache entr${cleared === 1 ? 'y' : 'ies'} for connection ${connectionId}`);
  }
}

/**
 * Exponential backoff wrapper for API calls
 * @param {Function} fn - Function to retry
 * @param {number} retries - Number of retries
 * @returns {Promise} - Result of function call
 */
export async function withRetry(fn, retries = 3) {
  let delay = 1000; // Start with 1 second
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      // Only retry on quota exceeded (429) or temporary server errors (5xx)
      if (err.response?.status !== 429 && !(err.response?.status >= 500 && err.response?.status < 600)) {
        throw err;
      }

      if (i === retries - 1) {
        // BUG (fixed): this used to throw `new Error('...quota exceeded...')`
        // here, a brand-new Error with no `.response` property at all. Every
        // caller's catch block reads `error.response?.status` /
        // `error.response?.data` for diagnostics, so the real Google error
        // (status code, error body) was silently discarded on the final
        // attempt - logs showed `status: undefined, data: undefined` even
        // though Google's actual response (429 or 5xx, with a real error
        // body) was sitting right there in `err`. Re-throwing the original
        // error preserves `err.response.status` / `err.response.data` /
        // `err.config` for the caller.
        console.error(`[BUSINESS_PROFILE] Exhausted ${retries} retries, giving up. Final Google response:`, {
          status: err.response?.status,
          statusText: err.response?.statusText,
          data: err.response?.data,
          headers: err.response?.headers
        });
        throw err;
      }

      console.warn(`[BUSINESS_PROFILE] Quota/Server error (status ${err.response?.status}), retrying in ${delay}ms (attempt ${i + 1}/${retries})`, {
        data: err.response?.data
      });

      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2; // Exponential backoff: 1s, 2s, 4s
    }
  }
}

/**
 * Log every field needed to distinguish a real Google API error from a
 * network/DNS/timeout/SSL failure. Axios errors carry the real HTTP response
 * (if one was received) on `error.response`; if that's undefined, the
 * request either never got a response (network/timeout/DNS/SSL) or never
 * left the process (thrown before the request was sent).
 *
 * Uses JSON.stringify (not a plain object passed to console.error) so
 * Node's default util.inspect depth (2) never truncates `error.response.data`
 * — Google's error body is itself a nested object (`{ error: { code,
 * message, status, details } }`), which sits 3+ levels deep in the logged
 * object and was previously printed as `data: { error: [Object] }`,
 * silently hiding the one field (`data.error.message`) that names exactly
 * which required parameter/argument Google rejected.
 */
export function logAxiosError(context, error) {
  const diagnostics = {
    message: error.message,
    code: error.code,           // e.g. 'ECONNABORTED' (timeout), 'ENOTFOUND' (DNS), 'ECONNRESET'
    name: error.name,
    isAxiosError: error.isAxiosError,
    // Present only if Google actually sent back an HTTP response:
    response: error.response ? {
      status: error.response.status,
      statusText: error.response.statusText,
      data: error.response.data,
      headers: error.response.headers
    } : 'NO RESPONSE RECEIVED (network error, timeout, DNS failure, or SSL issue)',
    // Present if a request was sent but no response came back at all:
    hadRequest: !!error.request,
    config: error.config ? {
      url: error.config.baseURL ? `${error.config.baseURL}${error.config.url}` : error.config.url,
      method: error.config.method,
      params: error.config.params,
      timeout: error.config.timeout,
      headers: {
        ...error.config.headers,
        Authorization: error.config.headers?.Authorization ? 'Bearer <redacted>' : undefined
      }
    } : undefined,
    stack: error.stack
  };
  console.error(`[BUSINESS_PROFILE][${context}] Full error diagnostics:`, JSON.stringify(diagnostics, null, 2));
}

/**
 * DEBUG ONLY (set GBP_DEBUG=true): calls Google's tokeninfo endpoint to see
 * exactly which scopes the current access token was actually granted.
 * Answers "did the OAuth consent the user completed actually include
 * business.manage?" directly from Google, rather than trusting what our own
 * /google/start code intended to request - the token could have been issued
 * by an older server process, a partial re-consent, etc.
 */
async function debugLogTokenScope(accessToken) {
  if (process.env.GBP_DEBUG !== 'true') return;
  try {
    const res = await axios.get('https://oauth2.googleapis.com/tokeninfo', {
      params: { access_token: accessToken }
    });
    const grantedScopes = (res.data.scope || '').split(' ');
    console.log('[BUSINESS_PROFILE][DEBUG] Token scope check:', {
      granted: grantedScopes,
      hasBusinessManage: grantedScopes.includes('https://www.googleapis.com/auth/business.manage'),
      audience: res.data.aud,
      expiresInSeconds: res.data.expires_in
    });
  } catch (err) {
    console.error('[BUSINESS_PROFILE][DEBUG] tokeninfo check failed (token may be malformed/expired):', {
      status: err.response?.status,
      data: err.response?.data
    });
  }
}

/**
 * Get authenticated HTTP client for GBP API calls
 * @param {Object} googleConnection - GoogleConnection document
 * @param {string} baseUrl - Base URL for the API
 * @returns {Object} - Axios instance with authentication headers
 */
export async function getAuthenticatedHttpClient(googleConnection, baseUrl = GBP_BUSINESS_INFO_API) {
  const accessToken = await getValidAccessToken(googleConnection);

  await debugLogTokenScope(accessToken);

  return axios.create({
    baseURL: baseUrl,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    timeout: 30000 // 30 second timeout
  });
}

const ACCOUNTS_PAGE_SIZE = 20;    // accounts.list maximum
const LOCATIONS_PAGE_SIZE = 100;  // accounts.locations.list maximum
const MAX_LIST_PAGES = 50;        // ceiling against a nextPageToken loop on Google's side

/**
 * Follow nextPageToken until exhausted. `fetchPage(pageToken)` must resolve to
 * an axios response; the items are read from the first array-valued field of
 * `response.data` named by `itemsKey` ('accounts' | 'locations').
 */
async function fetchAllPages(fetchPage, itemsKey) {
  const items = [];
  let pageToken;
  let pages = 0;
  do {
    const response = await fetchPage(pageToken);
    const batch = response.data?.[itemsKey];
    if (Array.isArray(batch)) items.push(...batch);
    pageToken = response.data?.nextPageToken || undefined;
    pages++;
  } while (pageToken && pages < MAX_LIST_PAGES);

  if (pageToken) {
    console.warn(`[BUSINESS_PROFILE] ${itemsKey} list truncated at ${MAX_LIST_PAGES} pages`);
  }
  return items;
}

/**
 * Get list of accessible Business Profile accounts
 * @param {Object} googleConnection - GoogleConnection document
 * @returns {Promise<Array>} - List of accessible accounts
 */
export async function getBusinessProfileAccounts(googleConnection) {
  try {
    console.log('[BUSINESS_PROFILE] Fetching accessible accounts');
    
    // Check cache first
    const cacheKey = getCacheKey('accounts', googleConnection._id);
    const cached = getCachedData(cacheKey);
    if (cached) {
      return cached;
    }
    
    const client = await getAuthenticatedHttpClient(googleConnection, GBP_ACCOUNT_MANAGEMENT_API);

    // accounts.list is paginated (pageSize max 20) - follow nextPageToken.
    const rawAccounts = await fetchAllPages(
      (pageToken) => withRetry(() => client.get('/accounts', { params: { pageSize: ACCOUNTS_PAGE_SIZE, pageToken } })),
      'accounts'
    );

    console.log('[BUSINESS_PROFILE] Accounts response:', { accountCount: rawAccounts.length });

    if (rawAccounts.length === 0) {
      console.log('[BUSINESS_PROFILE] No accounts found');
      const emptyResult = [];
      setCachedData(cacheKey, emptyResult);
      return emptyResult;
    }

    const accounts = rawAccounts.map(account => ({
      accountId: account.name.replace('accounts/', ''),
      accountName: account.displayName || account.name
    }));
    
    // Cache the result
    setCachedData(cacheKey, accounts);
    
    console.log('[BUSINESS_PROFILE] Found accessible accounts:', {
      count: accounts.length
    });
    
    return accounts;
    
  } catch (error) {
    logAxiosError('getBusinessProfileAccounts', error);

    // Don't convert to generic error - preserve original error with status
    throw error;
  }
}

/**
 * Get locations for a specific Business Profile account
 * @param {Object} googleConnection - GoogleConnection document
 * @param {string} accountId - Account ID to fetch locations for
 * @returns {Promise<Array>} - List of locations for the account
 */
export async function getBusinessProfileLocations(googleConnection, accountId) {
  try {
    console.log('[BUSINESS_PROFILE] Fetching locations for account:', accountId);
    
    // Check cache first
    const cacheKey = getCacheKey('locations', googleConnection._id, accountId);
    const cached = getCachedData(cacheKey);
    if (cached) {
      return cached;
    }
    
    const client = await getAuthenticatedHttpClient(googleConnection, GBP_BUSINESS_INFO_API);

    // accounts.locations.list is paginated (default pageSize is only 10, max
    // 100) - without following nextPageToken, accounts with more than 10
    // locations silently lose the rest.
    const rawLocations = await fetchAllPages(
      (pageToken) => withRetry(() =>
        client.get(`/accounts/${accountId}/locations`, {
          params: { readMask: LOCATION_READ_MASK, pageSize: LOCATIONS_PAGE_SIZE, pageToken }
        })
      ),
      'locations'
    );

    const locations = rawLocations.map(location => ({
      locationId: location.name.replace('locations/', ''),
      locationName: location.title || location.name,
      address: location.storefrontAddress?.addressLines?.join(', ') || '',
      category: location.categories?.primaryCategory?.displayName || '',
      websiteUri: location.websiteUri || null
    }));
    
    // Cache the result
    setCachedData(cacheKey, locations);
    
    console.log('[BUSINESS_PROFILE] Found locations:', {
      accountId,
      locationCount: locations.length
    });
    
    return locations;
    
  } catch (error) {
    logAxiosError('getBusinessProfileLocations', error);
    throw error;
  }
}

/**
 * Validate access to a specific Business Profile account and location
 *
 * IMPORTANT: locations.get on the Business Information API v1 addresses a
 * location as a TOP-LEVEL resource - `locations/{locationId}` - not nested
 * under its account (`accounts/{accountId}/locations/{locationId}` is only
 * a valid path for the LIST method, accounts.locations.list; Google has no
 * route registered for it as a GET-single path, so hitting it 404s at the
 * front-end/routing layer rather than returning a JSON API error).
 * getBusinessProfileLocations() already receives this correctly: Google's
 * own locations.list response returns `location.name` as the bare
 * `locations/{id}` top-level resource name, which is the exact string that
 * must be reused here rather than reconstructed under /accounts/.
 *
 * @param {Object} googleConnection - GoogleConnection document
 * @param {string} accountId - Account ID (kept for logging/signature
 *   compatibility with existing callers; not part of the locations.get URL)
 * @param {string} locationId - Location ID to validate
 * @returns {Promise<boolean>} - True if access is valid
 */
export async function validateBusinessProfileAccess(googleConnection, accountId, locationId) {
  try {
    console.log('[BUSINESS_PROFILE] Validating account/location access', { accountId, locationId });

    // Try to fetch the specific location - if we can access it, validation passes
    const client = await getAuthenticatedHttpClient(googleConnection, GBP_BUSINESS_INFO_API);

    await withRetry(() =>
      client.get(`/locations/${locationId}`, {
        params: { readMask: LOCATION_READ_MASK }
      })
    );
    
    console.log('[BUSINESS_PROFILE] Account/location access validated successfully');
    return true;
    
  } catch (error) {
    logAxiosError('validateBusinessProfileAccess', error);

    // Preserve the real status/data on the thrown error (previously this
    // replaced `error` with a brand-new Error carrying no `.response` at
    // all - the exact same "hidden error" bug as withRetry's final-attempt
    // path above, just in a different function).
    const wrapped = new Error(
      `Access denied: Cannot access the specified Business Profile account/location${error.response?.status ? ` (Google returned ${error.response.status})` : ''}`
    );
    wrapped.response = error.response;
    wrapped.status = error.response?.status;
    throw wrapped;
  }
}

function toDateComponents(date) {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/**
 * Fetch daily performance metrics via the current Business Profile
 * Performance API custom method. This is a GET with repeated query params,
 * matching Google's REST binding for ":fetchMultiDailyMetricsTimeSeries".
 */
async function fetchDailyMetrics(client, locationId, startDate, endDate) {
  const params = new URLSearchParams();
  for (const metric of DAILY_METRICS) params.append('dailyMetrics', metric);

  const start = toDateComponents(startDate);
  const end = toDateComponents(endDate);
  params.append('dailyRange.start_date.year', start.year);
  params.append('dailyRange.start_date.month', start.month);
  params.append('dailyRange.start_date.day', start.day);
  params.append('dailyRange.end_date.year', end.year);
  params.append('dailyRange.end_date.month', end.month);
  params.append('dailyRange.end_date.day', end.day);

  const response = await withRetry(() =>
    client.get(`locations/${locationId}:fetchMultiDailyMetricsTimeSeries?${params.toString()}`)
  );

  return response.data;
}

function sumMetric(multiDailyMetricTimeSeries, metricName) {
  if (!Array.isArray(multiDailyMetricTimeSeries)) return 0;
  let total = 0;
  for (const group of multiDailyMetricTimeSeries) {
    for (const series of group.dailyMetricTimeSeries || []) {
      if (series.dailyMetric !== metricName) continue;
      for (const datedValue of series.timeSeries?.datedValues || []) {
        total += Number(datedValue.value || 0);
      }
    }
  }
  return total;
}

const STAR_RATING_MAP = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

/**
 * Transform raw Google API responses (daily metrics time series + reviews)
 * into the flat shape BusinessProfileData.upsertPerformanceData expects:
 * { views_search, views_maps, actions_website, actions_calls,
 *   actions_directions, reviews_count, average_rating }
 *
 * This is the mapper that was previously missing entirely - nothing in the
 * codebase converted Google's nested response shapes into the DB schema's
 * flat fields, so synced data never actually reached BusinessProfileData.
 */
export function mapGoogleResponseToBusinessProfileData(metricsResponse, reviewsResult) {
  const series = metricsResponse?.multiDailyMetricTimeSeries || [];

  const views_search =
    sumMetric(series, 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH') +
    sumMetric(series, 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH');
  const views_maps =
    sumMetric(series, 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS') +
    sumMetric(series, 'BUSINESS_IMPRESSIONS_MOBILE_MAPS');
  const actions_website = sumMetric(series, 'WEBSITE_CLICKS');
  const actions_calls = sumMetric(series, 'CALL_CLICKS');
  const actions_directions = sumMetric(series, 'BUSINESS_DIRECTION_REQUESTS');

  const reviews = Array.isArray(reviewsResult?.reviews) ? reviewsResult.reviews : [];
  const numericRatings = reviews
    .map((r) => (typeof r.starRating === 'number' ? r.starRating : STAR_RATING_MAP[r.starRating]))
    .filter((v) => typeof v === 'number');

  const reviews_count = typeof reviewsResult?.totalReviewCount === 'number'
    ? reviewsResult.totalReviewCount
    : reviews.length;

  const average_rating = numericRatings.length
    ? Math.round((numericRatings.reduce((a, b) => a + b, 0) / numericRatings.length) * 10) / 10
    : 0;

  return {
    views_search,
    views_maps,
    actions_website,
    actions_calls,
    actions_directions,
    reviews_count,
    average_rating
  };
}

/**
 * Get Business Profile performance data for a location
 * @param {Object} googleConnection - GoogleConnection document
 * @param {string} accountId - Account ID
 * @param {string} locationId - Location ID
 * @param {Date} [startDate] - Start date for data, defaults to 30 days ago
 * @param {Date} [endDate] - End date for data, defaults to today
 * @returns {Promise<Object>} - { locationId, dateRange, metrics, reviewsAccessRestricted }
 */
export async function getBusinessProfilePerformanceData(googleConnection, accountId, locationId, startDate, endDate) {
  const effectiveEnd = endDate || new Date();
  const effectiveStart = startDate || new Date(effectiveEnd.getTime() - 30 * 24 * 60 * 60 * 1000);

  const startDateStr = effectiveStart.toISOString().split('T')[0];
  const endDateStr = effectiveEnd.toISOString().split('T')[0];

  console.log('[BUSINESS_PROFILE] Fetching performance data', { accountId, locationId, startDateStr, endDateStr });

  const cacheKey = getCacheKey('performance', googleConnection._id, locationId, startDateStr, endDateStr);
  const cached = getCachedData(cacheKey);
  if (cached) {
    return cached;
  }

  // Fetch performance metrics
  let metricsResponse = null;
  try {
    const metricsClient = await getAuthenticatedHttpClient(googleConnection, GBP_PERFORMANCE_API);
    metricsResponse = await fetchDailyMetrics(metricsClient, locationId, effectiveStart, effectiveEnd);
    console.log('[BUSINESS_PROFILE] Performance metrics retrieved', {
      seriesCount: metricsResponse?.multiDailyMetricTimeSeries?.length || 0
    });
  } catch (metricsError) {
    logAxiosError('getBusinessProfilePerformanceData:metrics', metricsError);

    const status = metricsError.response?.status;
    let wrapped;
    if (status === 403) {
      wrapped = new Error(`Access denied: No permission for location ${locationId}`);
    } else if (status === 404) {
      wrapped = new Error(`Location not found: ${locationId}`);
    } else if (status === 400) {
      wrapped = new Error(`Invalid request: ${metricsError.response?.data?.error?.message || metricsError.message}`);
    } else {
      wrapped = new Error(`Failed to fetch Business Profile performance data: ${metricsError.message}`);
    }
    // Preserve the real Google response on the wrapped error so callers can
    // still inspect status/data instead of it vanishing (see withRetry fix above).
    wrapped.response = metricsError.response;
    wrapped.status = status;
    throw wrapped;
  }

  // Fetch reviews (legacy v4 API - gated behind Google's allowlist for most
  // developer projects; degrade to an empty set rather than fail the sync).
  let reviewsResult = null;
  let reviewsAccessRestricted = false;
  try {
    const legacyClient = await getAuthenticatedHttpClient(googleConnection, GBP_LEGACY_API);
    const reviewsResponse = await withRetry(() =>
      legacyClient.get(`accounts/${accountId}/locations/${locationId}/reviews`)
    );
    reviewsResult = reviewsResponse.data;
    console.log('[BUSINESS_PROFILE] Reviews retrieved', { reviewCount: reviewsResult?.reviews?.length || 0 });
  } catch (reviewsError) {
    if (reviewsError.response?.status === 403) {
      reviewsAccessRestricted = true;
      console.warn('[BUSINESS_PROFILE] Reviews API access restricted for this project (403) - continuing without reviews');
    } else {
      console.warn('[BUSINESS_PROFILE] Failed to fetch reviews:', reviewsError.message);
    }
  }

  const metrics = mapGoogleResponseToBusinessProfileData(metricsResponse, reviewsResult);

  const performanceData = {
    locationId,
    dateRange: { start: startDateStr, end: endDateStr },
    metrics,
    reviewsAccessRestricted
  };

  setCachedData(cacheKey, performanceData);

  return performanceData;
}

/**
 * Complete workflow: Validate account/location and fetch performance data,
 * normalized into the shape businessProfileController/BusinessProfileData
 * expect: { data: [flatMetrics], dateRange, syncedPages, skippedPages }.
 *
 * @param {Object} googleConnection - GoogleConnection document
 * @param {string} accountId - GBP Account ID
 * @param {string} locationId - GBP Location ID
 * @param {Date} [startDate] - defaults to 30 days ago (see getBusinessProfilePerformanceData)
 * @param {Date} [endDate] - defaults to today
 * @returns {Promise<Object>} - { data, dateRange, syncedPages, skippedPages, reviewsAccessRestricted }
 */
export async function getProjectBusinessProfileData(googleConnection, accountId, locationId, startDate, endDate) {
  try {
    console.log('[BUSINESS_PROFILE] Starting workflow', { accountId, locationId });

    // Step 1: Validate account/location access
    await validateBusinessProfileAccess(googleConnection, accountId, locationId);

    // Step 2: Fetch performance data (dates default internally if omitted)
    const performanceResult = await getBusinessProfilePerformanceData(googleConnection, accountId, locationId, startDate, endDate);

    console.log('[BUSINESS_PROFILE] Workflow completed', {
      accountId,
      locationId,
      dateRange: performanceResult.dateRange,
      reviewsAccessRestricted: performanceResult.reviewsAccessRestricted
    });

    // One location -> one aggregated metrics row per sync, matching the
    // (project_id, date_range) uniqueness constraint on BusinessProfileData.
    return {
      data: [performanceResult.metrics],
      dateRange: performanceResult.dateRange,
      syncedPages: 1,
      skippedPages: 0,
      reviewsAccessRestricted: performanceResult.reviewsAccessRestricted
    };
  } catch (error) {
    console.error('[BUSINESS_PROFILE] Workflow failed', {
      accountId,
      locationId,
      error: error.message
    });

    throw error;
  }
}

/**
 * Fetch the extended Location resource (description, hours, coordinates,
 * service area, open/verification metadata) for the dedicated Business
 * Profile dashboard page. Uses EXTENDED_LOCATION_READ_MASK rather than the
 * lightweight LOCATION_READ_MASK used elsewhere - see that constant's
 * comment for why it's a separate mask instead of widening the shared one.
 *
 * @param {Object} googleConnection - GoogleConnection document
 * @param {string} locationId - Location ID
 * @returns {Promise<Object>} - normalized extended profile fields
 */
export async function getBusinessProfileLocationDetails(googleConnection, locationId) {
  console.log('[BUSINESS_PROFILE] Fetching extended location details', { locationId });

  const cacheKey = getCacheKey('location_details', googleConnection._id, locationId);
  const cached = getCachedData(cacheKey);
  if (cached) return cached;

  const client = await getAuthenticatedHttpClient(googleConnection, GBP_BUSINESS_INFO_API);

  const response = await withRetry(() =>
    client.get(`/locations/${locationId}`, {
      params: { readMask: EXTENDED_LOCATION_READ_MASK }
    })
  );

  const location = response.data || {};

  const details = {
    businessName: location.title || null,
    description: location.profile?.description || null,
    primaryCategory: location.categories?.primaryCategory?.displayName || null,
    secondaryCategories: (location.categories?.additionalCategories || []).map(c => c.displayName).filter(Boolean),
    businessStatus: location.openInfo?.status || null,
    website: location.websiteUri || null,
    phone: location.phoneNumbers?.primaryPhone || null,
    address: location.storefrontAddress?.addressLines?.join(', ') || null,
    latitude: typeof location.latlng?.latitude === 'number' ? location.latlng.latitude : null,
    longitude: typeof location.latlng?.longitude === 'number' ? location.latlng.longitude : null,
    mapsUri: location.metadata?.mapsUri || null,
    newReviewUri: location.metadata?.newReviewUri || null,
    placeId: location.metadata?.placeId || null,
    hasVoiceOfMerchant: typeof location.metadata?.hasVoiceOfMerchant === 'boolean' ? location.metadata.hasVoiceOfMerchant : null,
    serviceArea: location.serviceArea || null,
    regularHours: location.regularHours?.periods || null,
    specialHours: location.specialHours?.specialHourPeriods || null
  };

  setCachedData(cacheKey, details);
  return details;
}

const GEOCODE_TIMEOUT_MS = 5000;

// Sub-building segments ("8th Floor", "Suite 200", "Unit 5", "#4B") break
// Nominatim's free-text parser - confirmed live: the exact address Google
// returned for a real listing ("100 Church Street, 8th Floor, New York
// City, New York 10007, United States") returned zero results with the
// floor segment in place, and geocoded correctly the moment it was
// stripped. Google's storefrontAddress.addressLines legitimately includes
// these as their own comma-separated segment, so they're filtered out
// before querying rather than assuming the raw joined address is geocodable.
const GEOCODE_SKIP_SEGMENT_PATTERN = /\b(floor|fl\.?|suite|ste\.?|unit|apt\.?|apartment|#)\b/i;

function simplifyAddressForGeocoding(address) {
  return address
    .split(',')
    .map((segment) => segment.trim())
    .filter((segment) => segment && !GEOCODE_SKIP_SEGMENT_PATTERN.test(segment))
    .join(', ');
}

/**
 * Free, keyless geocoding fallback (OpenStreetMap Nominatim) - used only
 * when getBusinessProfileLocationDetails() comes back with no latlng.
 * Confirmed live (not assumed): Google's Business Information API omits
 * the `latlng` field entirely for locations that don't have it set - it's
 * documented as user-provided, not guaranteed for every listing. This
 * fills that gap from the address Google DID give us, so the map preview
 * still has coordinates to render instead of falling back to a
 * placeholder. Nominatim's usage policy requires an identifying
 * User-Agent and caps free-tier usage around 1 req/sec - safe here since
 * the caller only invokes this once per project (result is cached on
 * BusinessProfileMetadata, never re-geocoded on subsequent syncs).
 */
export async function geocodeAddress(address) {
  if (!address) return null;

  const query = simplifyAddressForGeocoding(address);
  if (!query) return null;

  try {
    const response = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: { q: query, format: 'json', limit: 1 },
      headers: { 'User-Agent': 'Odito-SEO-Platform/1.0 (+https://odito.ai)' },
      timeout: GEOCODE_TIMEOUT_MS
    });

    const match = response.data?.[0];
    if (!match) return null;

    const latitude = parseFloat(match.lat);
    const longitude = parseFloat(match.lon);
    if (Number.isNaN(latitude) || Number.isNaN(longitude)) return null;

    return { latitude, longitude };
  } catch (error) {
    console.warn('[BUSINESS_PROFILE] Geocoding fallback failed for address:', address, '-', error.message);
    return null;
  }
}

/**
 * Pivot a fetchMultiDailyMetricsTimeSeries response into day-by-day rows
 * (one object per date), instead of the single-total shape sumMetric()
 * produces for the existing sync/persist path. Reuses the exact same fetch
 * (fetchDailyMetrics) rather than re-implementing the querystring/response
 * handling - only the aggregation step differs.
 */
function pivotDailyMetricsToRows(metricsResponse) {
  const series = metricsResponse?.multiDailyMetricTimeSeries || [];
  const rowsByDate = new Map();

  const METRIC_TO_FIELD = {
    BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: 'search',
    BUSINESS_IMPRESSIONS_MOBILE_SEARCH: 'search',
    BUSINESS_IMPRESSIONS_DESKTOP_MAPS: 'maps',
    BUSINESS_IMPRESSIONS_MOBILE_MAPS: 'maps',
    WEBSITE_CLICKS: 'clicks',
    CALL_CLICKS: 'calls',
    BUSINESS_DIRECTION_REQUESTS: 'directions',
    BUSINESS_BOOKINGS: 'bookings'
  };

  for (const group of series) {
    for (const metricSeries of group.dailyMetricTimeSeries || []) {
      const field = METRIC_TO_FIELD[metricSeries.dailyMetric];
      if (!field) continue;

      for (const datedValue of metricSeries.timeSeries?.datedValues || []) {
        const d = datedValue.date;
        if (!d) continue;
        const dateKey = `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;

        if (!rowsByDate.has(dateKey)) {
          rowsByDate.set(dateKey, { date: dateKey, search: 0, maps: 0, clicks: 0, calls: 0, directions: 0, bookings: 0 });
        }
        rowsByDate.get(dateKey)[field] += Number(datedValue.value || 0);
      }
    }
  }

  return Array.from(rowsByDate.values()).sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * True day-by-day performance time series for the Performance Trends chart
 * and KPI totals (7 / 30 / 90 / 365-day ranges). Distinct from
 * getBusinessProfilePerformanceData(), which only exposes pre-summed totals
 * (that function feeds the persisted BusinessProfileData snapshot row, not a
 * chart). Reuses the same auth client / retry / cache helpers and the same
 * Performance API host/metrics as the rest of this file.
 *
 * @param {Object} googleConnection - GoogleConnection document
 * @param {string} locationId - Location ID
 * @param {Date} startDate
 * @param {Date} endDate
 * @returns {Promise<Array<{date, search, maps, clicks, calls, directions, bookings}>>}
 */
export async function getBusinessProfileDailyMetricsTimeSeries(googleConnection, locationId, startDate, endDate) {
  const startDateStr = startDate.toISOString().split('T')[0];
  const endDateStr = endDate.toISOString().split('T')[0];

  const cacheKey = getCacheKey('daily_metrics', googleConnection._id, locationId, startDateStr, endDateStr);
  const cached = getCachedData(cacheKey);
  if (cached) return cached;

  const client = await getAuthenticatedHttpClient(googleConnection, GBP_PERFORMANCE_API);
  const metricsResponse = await fetchDailyMetrics(client, locationId, startDate, endDate);
  const rows = pivotDailyMetricsToRows(metricsResponse);

  setCachedData(cacheKey, rows);
  return rows;
}

export default {
  getBusinessProfileAccounts,
  getBusinessProfileLocations,
  validateBusinessProfileAccess,
  getBusinessProfilePerformanceData,
  getProjectBusinessProfileData,
  mapGoogleResponseToBusinessProfileData,
  getBusinessProfileLocationDetails,
  getBusinessProfileDailyMetricsTimeSeries,
  geocodeAddress,
  clearCacheForConnection
};
