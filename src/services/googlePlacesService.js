import axios from 'axios';
import { LoggerUtil } from '../utils/LoggerUtil.js';

/**
 * Google Places API Service
 *
 * Uses Google Places API (v1) for business search
 * Reuses patterns from businessProfileService.js for consistency
 *
 * API: https://places.googleapis.com/v1/places:searchText
 * Auth: API Key (not OAuth)
 *
 * Failures are surfaced as PlacesError (stable `code`), never swallowed into
 * an empty array: "Google said no matches" and "Google refused the request"
 * are different outcomes and callers must be able to tell them apart.
 */

// Places API base URL
const PLACES_API_URL = 'https://places.googleapis.com/v1/places:searchText';

// Typeahead needs a fast answer; the 30s default used for details is far too long.
const SEARCH_TIMEOUT_MS = 8000;
const SEARCH_MAX_RETRIES = 2;
const SEARCH_MAX_RESULTS = 5;

export const PLACES_ERROR = Object.freeze({
  NOT_CONFIGURED: 'PLACES_NOT_CONFIGURED',
  KEY_INVALID: 'PLACES_KEY_INVALID',
  ACCESS_DENIED: 'PLACES_ACCESS_DENIED',
  BILLING_REQUIRED: 'PLACES_BILLING_REQUIRED',
  RATE_LIMITED: 'PLACES_RATE_LIMITED',
  TIMEOUT: 'PLACES_TIMEOUT',
  UNAVAILABLE: 'PLACES_UNAVAILABLE',
  INVALID_REQUEST: 'PLACES_INVALID_REQUEST',
  BAD_RESPONSE: 'PLACES_BAD_RESPONSE'
});

/**
 * Typed failure from the Places integration. `upstreamStatus` / `upstreamReason`
 * are for server logs only - controllers must not forward them to the browser.
 */
export class PlacesError extends Error {
  constructor(code, message, { upstreamStatus = null, upstreamReason = null } = {}) {
    super(message);
    this.name = 'PlacesError';
    this.code = code;
    this.upstreamStatus = upstreamStatus;
    this.upstreamReason = upstreamReason;
  }
}

/**
 * Translate an axios/Google failure into a PlacesError. Google's error body
 * is `{ error: { code, status, message, details: [{ reason }] } }`.
 *
 * The message texts keep the substrings legacy callers match on
 * ("API key", "quota exceeded", "Invalid search request").
 */
export function classifyPlacesError(error) {
  if (error instanceof PlacesError) return error;

  const status = error.response?.status ?? null;
  const g = error.response?.data?.error;
  const reason = g?.details?.find?.(d => d?.reason)?.reason || g?.status || null;
  const text = `${g?.message || ''} ${reason || ''}`.toLowerCase();
  const meta = { upstreamStatus: status, upstreamReason: reason };

  if (!error.response) {
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || /timeout/i.test(error.message || '')) {
      return new PlacesError(PLACES_ERROR.TIMEOUT, 'Google Places API request timed out.', { ...meta, upstreamReason: error.code || 'timeout' });
    }
    return new PlacesError(PLACES_ERROR.UNAVAILABLE, 'Google Places API is unreachable.', { ...meta, upstreamReason: error.code || 'network' });
  }

  if (status === 429) {
    return new PlacesError(PLACES_ERROR.RATE_LIMITED, 'Google Places API quota exceeded. Please try again later.', meta);
  }
  if (status >= 500) {
    return new PlacesError(PLACES_ERROR.UNAVAILABLE, 'Google Places API is temporarily unavailable.', meta);
  }
  if (status === 401 || (status === 400 && (reason === 'API_KEY_INVALID' || text.includes('api key not valid')))) {
    return new PlacesError(PLACES_ERROR.KEY_INVALID, 'Google Places API key is invalid. Check your API key.', meta);
  }
  if (status === 403) {
    if (reason === 'BILLING_DISABLED' || text.includes('billing')) {
      return new PlacesError(PLACES_ERROR.BILLING_REQUIRED, 'Google Places API requires billing on the Cloud project. Check your API key project.', meta);
    }
    // SERVICE_DISABLED, API_KEY_*_BLOCKED, or the bare PERMISSION_DENIED
    // Google returns when Places API (New) is not usable by this key's project.
    return new PlacesError(PLACES_ERROR.ACCESS_DENIED, 'Google Places API access denied. Check your API key.', meta);
  }
  if (status === 400) {
    return new PlacesError(PLACES_ERROR.INVALID_REQUEST, `Invalid search request: ${g?.message || error.message}`, meta);
  }
  return new PlacesError(PLACES_ERROR.UNAVAILABLE, `Google Places API error (HTTP ${status}).`, meta);
}

/** True when the key is present - never exposes the key itself. */
export function isPlacesConfigured() {
  return !!process.env.GOOGLE_PLACES_API_KEY;
}

/**
 * Simple in-memory cache (10-15 minute TTL)
 * Prevents rapid repeated API calls that trigger quota limits
 * Reused from businessProfileService.js pattern
 */
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function getCacheKey(prefix, ...args) {
  return `${prefix}:${args.join(':')}`;
}

function getCachedData(key) {
  const cached = cache.get(key);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    console.log(`[GOOGLE_PLACES] Returning cached data for key: ${key}`);
    return cached.data;
  }
  return null;
}

function setCachedData(key, data) {
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
 * Exponential backoff wrapper for API calls
 * Reused from businessProfileService.js
 */
async function withRetry(fn, { retries = 3, baseDelayMs = 1000 } = {}) {
  let delay = baseDelayMs;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      // Only retry on quota exceeded (429) or temporary server errors (5xx)
      if (err.response?.status !== 429 && !(err.response?.status >= 500 && err.response?.status < 600)) {
        throw err;
      }

      // Final attempt: re-throw the ORIGINAL error so the real Google status
      // survives for classification (a fresh Error here used to discard it).
      if (i === retries - 1) {
        throw err;
      }

      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2; // Exponential backoff
    }
  }
}

/**
 * Get authenticated HTTP client for Places API calls
 * Uses API key authentication (different from OAuth in businessProfileService)
 */
function getPlacesHttpClient({ timeoutMs = 30000 } = {}) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;

  if (!apiKey) {
    throw new PlacesError(PLACES_ERROR.NOT_CONFIGURED, 'GOOGLE_PLACES_API_KEY environment variable is required');
  }

  return axios.create({
    baseURL: 'https://places.googleapis.com/v1/',
    headers: {
      'X-Goog-Api-Key': apiKey,
      'Content-Type': 'application/json'
    },
    timeout: timeoutMs
  });
}

/** Test hook: the cache is module-level state. */
export function clearPlacesCache() {
  cache.clear();
}

/**
 * Calculate relative time description from a date
 * @param {Date} date - Date to calculate from
 * @returns {string} - Relative time description (e.g., "2 months ago")
 */
function calculateRelativeTime(date) {
  if (!date) return 'Recently';
  
  const now = new Date();
  const diffMs = now - date;
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  const diffWeeks = Math.floor(diffDays / 7);
  const diffMonths = Math.floor(diffDays / 30);
  const diffYears = Math.floor(diffDays / 365);

  if (diffSecs < 60) return 'Just now';
  if (diffMins < 60) return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
  if (diffWeeks < 4) return `${diffWeeks} week${diffWeeks === 1 ? '' : 's'} ago`;
  if (diffMonths < 12) return `${diffMonths} month${diffMonths === 1 ? '' : 's'} ago`;
  return `${diffYears} year${diffYears === 1 ? '' : 's'} ago`;
}

/**
 * Search for businesses using Google Places API (New) Text Search.
 *
 * Resolves to an array (empty ONLY when Google genuinely returned no matches)
 * and throws PlacesError for every failure - missing key, permission/billing
 * problems, rate limits, timeouts, malformed responses.
 *
 * @param {string} businessName - Business name to search for
 * @param {string} location - Location (city/area) to search in
 * @param {Object} [options]
 * @param {string} [options.requestId] - Correlation id for log lines
 * @param {number} [options.timeoutMs] - Per-attempt timeout
 * @param {number} [options.retries] - Attempts for transient (429/5xx) errors
 * @param {number} [options.retryDelayMs] - Initial backoff delay
 * @param {number} [options.maxResults] - maxResultCount sent to Google (1-20)
 * @returns {Promise<Array>} - Array of normalized business results
 */
export async function searchBusinesses(businessName, location = '', options = {}) {
  const {
    requestId = null,
    timeoutMs = SEARCH_TIMEOUT_MS,
    retries = SEARCH_MAX_RETRIES,
    retryDelayMs = 1000,
    maxResults = SEARCH_MAX_RESULTS
  } = options;

  const startedAt = Date.now();
  // Never log the query text itself - only its length - and never the key.
  const logCtx = {
    requestId,
    provider: 'google_places_v1_text_search',
    queryLength: (businessName || '').trim().length,
    hasLocation: !!(location && location.trim()),
    credentialsConfigured: isPlacesConfigured(),
    authRequired: false
  };

  try {
    if (!businessName || !businessName.trim()) {
      throw new PlacesError(PLACES_ERROR.INVALID_REQUEST, 'Invalid search request: business name is required');
    }

    // Check cache first (location may be empty — that's fine)
    const cacheKey = getCacheKey('search', businessName.trim().toLowerCase(), (location || '').trim().toLowerCase());
    const cached = getCachedData(cacheKey);
    if (cached) {
      LoggerUtil.info('[GOOGLE_PLACES] Search served from cache', { ...logCtx, durationMs: Date.now() - startedAt, candidates: cached.length, cacheHit: true });
      return cached;
    }

    // Construct search query — include location only when provided
    const searchQuery = location && location.trim()
      ? `${businessName.trim()} in ${location.trim()}`
      : businessName.trim();

    const client = getPlacesHttpClient({ timeoutMs });

    const response = await withRetry(() =>
      client.post('places:searchText', {
        textQuery: searchQuery,
        maxResultCount: maxResults,
        languageCode: 'en'
      }, {
        headers: {
          'X-Goog-FieldMask': 'places.id,places.name,places.displayName,places.formattedAddress,places.websiteUri,places.internationalPhoneNumber,places.types,places.addressComponents,places.location,places.businessStatus'
        }
      }),
      { retries, baseDelayMs: retryDelayMs }
    );

    const data = response.data;

    // Google answers a zero-match query with `{}` (no `places` key). Anything
    // else that isn't a places array is a malformed response, not "no results".
    if (data === null || typeof data !== 'object' || Array.isArray(data) ||
        (data.places !== undefined && !Array.isArray(data.places))) {
      throw new PlacesError(PLACES_ERROR.BAD_RESPONSE, 'Google Places API returned an unexpected response.', { upstreamStatus: response.status });
    }

    // Normalize the results
    // In Places API v1, place.id is the bare place ID ("ChIJ...") and
    // place.name is the resource name ("places/ChIJ...") that Place Details accepts.
    const seen = new Set();
    const normalizedResults = [];
    for (const place of data.places || []) {
      const resourceName = place?.name || '';
      const placeId = place?.id || resourceName.replace(/^places\//, '');
      const name = place?.displayName?.text || '';
      // A result needs an identity and a name. Address is NOT required:
      // service-area businesses can legitimately come back without one.
      if (!placeId || !name || seen.has(placeId)) continue;
      seen.add(placeId);

      // Extract city, state, country from addressComponents
      const components = place.addressComponents || [];
      const getComponent = (type) => components.find(c => c.types?.includes(type));
      const city = getComponent('locality')?.longText
        || getComponent('sublocality_level_1')?.longText
        || null;
      const state = getComponent('administrative_area_level_1')?.longText || null;
      const countryComponent = getComponent('country');
      const country = countryComponent?.longText || null;
      const countryCode = countryComponent?.shortText?.toUpperCase() || null;

      normalizedResults.push({
        // Bare place ID. getPlaceDetails() accepts it (it prefixes "places/").
        placeId,
        name,
        address: place.formattedAddress || '',
        city,
        state,
        country,
        countryCode,
        lat: place.location?.latitude ?? null,
        lng: place.location?.longitude ?? null,
        businessStatus: place.businessStatus || null,
        website: place.websiteUri || '',
        phone: place.internationalPhoneNumber || '',
        types: place.types || []
      });
    }

    setCachedData(cacheKey, normalizedResults);

    LoggerUtil.info('[GOOGLE_PLACES] Search completed', {
      ...logCtx,
      upstreamStatus: response.status,
      durationMs: Date.now() - startedAt,
      candidates: normalizedResults.length,
      fallbackAttempted: false
    });

    return normalizedResults;

  } catch (error) {
    const placesError = classifyPlacesError(error);

    LoggerUtil.warn('[GOOGLE_PLACES] Search failed', {
      ...logCtx,
      durationMs: Date.now() - startedAt,
      errorCode: placesError.code,
      upstreamStatus: placesError.upstreamStatus,
      upstreamReason: placesError.upstreamReason,
      message: placesError.message,
      fallbackAttempted: false
    });

    throw placesError;
  }
}

/**
 * Get detailed information about a specific place using Place Details API
 * @param {string} placeId - The place resource name (e.g. "places/ChIJ...")
 * @returns {Promise<Object>} - Detailed place information
 */
export async function getPlaceDetails(placeId) {
  try {
    console.log('[GOOGLE_PLACES] Fetching place details', { placeId });

    if (!placeId || !placeId.trim()) {
      throw new Error('Place ID is required');
    }

    // Check cache first
    const cacheKey = getCacheKey('details', placeId.trim());
    const cached = getCachedData(cacheKey);
    if (cached) {
      return cached;
    }

    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
      throw new Error('GOOGLE_PLACES_API_KEY environment variable is required');
    }

    // Place Details API (v1) - GET /v1/places/{placeId}
    const placeResourceName = placeId.startsWith('places/') ? placeId : `places/${placeId}`;
    const detailsUrl = `https://places.googleapis.com/v1/${placeResourceName}`;

    const response = await withRetry(() =>
      axios.get(detailsUrl, {
        headers: {
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'displayName,formattedAddress,internationalPhoneNumber,websiteUri,types,primaryType,rating,userRatingCount,reviews,googleMapsUri,location,addressComponents',
          'Content-Type': 'application/json'
        },
        timeout: 30000
      })
    );

    const place = response.data;

    // Extract reviews (limit to top 5)
    const reviews = (place.reviews || []).slice(0, 5).map(r => ({
      author: r.authorAttribution?.displayName?.text || r.authorAttribution?.displayName || 'Anonymous',
      rating: r.rating || 0,
      text: r.originalText || r.text || '',
      relative_time: r.publishTime ? calculateRelativeTime(new Date(r.publishTime)) : 'Recently'
    }));

    // Extract category safely (handle both string and object formats)
    let category = '';
    if (place.primaryType) {
      category = typeof place.primaryType === 'string' 
        ? place.primaryType 
        : place.primaryType?.displayValue || place.primaryType?.text || '';
    } else if (place.types && Array.isArray(place.types) && place.types.length > 0) {
      const firstType = place.types[0];
      category = typeof firstType === 'string'
        ? firstType
        : firstType?.displayValue || firstType?.text || '';
    }

    // Extract city, state, country from addressComponents
    const detailComponents = place.addressComponents || [];
    const getDetailComponent = (type) => detailComponents.find(c => c.types?.includes(type));
    // Prefer 'locality' (city-level). Fall back to 'administrative_area_level_2' (district/city
    // in countries like India where 'locality' is sometimes absent). Never use sublocality — it
    // maps to neighborhoods, not cities, and will fail DataForSEO city-name matching.
    const detailCity = getDetailComponent('locality')?.longText
      || getDetailComponent('administrative_area_level_2')?.longText
      || null;
    const detailState = getDetailComponent('administrative_area_level_1')?.longText || null;
    const detailCountryComp = getDetailComponent('country');
    const detailCountry = detailCountryComp?.longText || null;
    const detailCountryCode = detailCountryComp?.shortText?.toUpperCase() || null;

    const result = {
      name: place.displayName?.text || place.displayName || '',
      address: place.formattedAddress || '',
      city: detailCity,
      state: detailState,
      country: detailCountry,
      countryCode: detailCountryCode,
      phone: place.internationalPhoneNumber || '',
      category: category.replace(/_/g, ' ').trim() || '',
      website: place.websiteUri || '',
      rating: place.rating || null,
      total_reviews: place.userRatingCount || 0,
      google_maps_url: place.googleMapsUri || '',
      location: {
        lat: place.location?.latitude || null,
        lng: place.location?.longitude || null
      },
      reviews: reviews
    };

    // Cache the result
    setCachedData(cacheKey, result);

    console.log('[GOOGLE_PLACES] Place details fetched', {
      placeId,
      name: result.name
    });

    return result;

  } catch (error) {
    console.error('[GOOGLE_PLACES] Get place details failed', {
      placeId,
      error: error.message,
      status: error.response?.status
    });

    if (error.response?.status === 403) {
      throw new Error('Google Places API access denied. Check your API key.');
    }

    if (error.response?.status === 429) {
      throw new Error('Google Places API quota exceeded. Please try again later.');
    }

    throw new Error(`Failed to get place details: ${error.message}`);
  }
}

export default {
  searchBusinesses,
  getPlaceDetails
};
