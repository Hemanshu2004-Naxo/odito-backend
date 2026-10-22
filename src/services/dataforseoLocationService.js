/**
 * DataForSEO Location Mapping Service
 * 
 * Dynamically maps Google Places lat/lng to nearest DataForSEO location_code
 * using geographical proximity and country matching.
 */

import axios from 'axios';

// DataForSEO Locations API
const DATASEO_LOCATIONS_API = 'https://api.dataforseo.com/v3/serp/google/locations';

// Country-level fallback map — single source of truth for all JS consumers
export const COUNTRY_TO_LOCATION_CODE = {
  US: 2840, IN: 2356, UK: 2826, GB: 2826,
  CA: 2124, AU: 2036, DE: 2315, FR: 2250,
  ES: 2246, IT: 2240, JP: 2132, BR: 2075,
  MX: 2239, KR: 2131, RU: 2306,
};

// In-memory cache for location data (refresh every 24 hours)
let locationsCache = {
  data: null,
  lastFetch: null,
  cacheDuration: 24 * 60 * 60 * 1000 // 24 hours
};

/**
 * Get DataForSEO locations list with caching
 */
async function getDataForSEOLocations() {
  const now = Date.now();
  
  // Return cached data if still valid
  if (locationsCache.data &&
      locationsCache.lastFetch &&
      (now - locationsCache.lastFetch) < locationsCache.cacheDuration) {
    return locationsCache.data;
  }

  try {
    
    const login = process.env.DATAFORSEO_LOGIN || process.env.DATASEO_API_LOGIN || '';
    const password = process.env.DATAFORSEO_PASSWORD || process.env.DATASEO_API_PASSWORD || '';
    const credentials = Buffer.from(`${login}:${password}`).toString('base64');

    const response = await axios.get(DATASEO_LOCATIONS_API, {
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    if (!response.data?.tasks || !response.data.tasks[0]?.result) {
      throw new Error('Invalid response structure from DataForSEO locations API');
    }

    const locations = response.data.tasks[0].result;
    
    // Cache the results
    locationsCache.data = locations;
    locationsCache.lastFetch = now;
    return locations;
    
  } catch (error) {
    console.error('[DATASEO_LOCATIONS] Failed to fetch locations:', {
      error: error.message,
      status: error.response?.status
    });
    
    // If we have old cache data, use it as fallback
    if (locationsCache.data) {
      return locationsCache.data;
    }
    
    throw new Error(`Failed to fetch DataForSEO locations: ${error.message}`);
  }
}

/**
 * Calculate distance between two lat/lng points using Haversine formula
 */
function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c; // Distance in kilometers
}

/**
 * Extract country code from Google Places address
 */
function extractCountryCode(address) {
  if (!address) return null;
  
  const addressUpper = address.toUpperCase();
  
  // Common country patterns
  if (addressUpper.includes('INDIA')) return 'IN';
  if (addressUpper.includes('UNITED STATES') || addressUpper.includes('USA')) return 'US';
  if (addressUpper.includes('UNITED KINGDOM') || addressUpper.includes('UK')) return 'UK';
  if (addressUpper.includes('CANADA')) return 'CA';
  if (addressUpper.includes('AUSTRALIA')) return 'AU';
  if (addressUpper.includes('GERMANY')) return 'DE';
  if (addressUpper.includes('FRANCE')) return 'FR';
  if (addressUpper.includes('SPAIN')) return 'ES';
  if (addressUpper.includes('ITALY')) return 'IT';
  if (addressUpper.includes('JAPAN')) return 'JP';
  if (addressUpper.includes('BRAZIL')) return 'BR';
  if (addressUpper.includes('MEXICO')) return 'MX';
  if (addressUpper.includes('SOUTH KOREA') || addressUpper.includes('KOREA')) return 'KR';
  if (addressUpper.includes('RUSSIA')) return 'RU';
  
  return null;
}

/**
 * Get the country-level location_code fallback — never defaults to US unless country is explicitly US.
 */
function getCountryFallbackCode(countryCode, addressFallback = null) {
  const code = countryCode?.toUpperCase() || extractCountryCode(addressFallback);
  if (code && COUNTRY_TO_LOCATION_CODE[code]) {
    return COUNTRY_TO_LOCATION_CODE[code];
  }
  console.warn('[DATASEO_LOCATIONS] No country code resolved, defaulting to US (2840)');
  return COUNTRY_TO_LOCATION_CODE['US']; // 2840 — only reached when country is truly unknown
}

/**
 * Extract city name from a Google Places formatted address string.
 * Address format (Indian example):
 *   "..., Thatte Nagar, Nashik, Maharashtra 422 001, India"
 * Strategy: split by comma, strip country (last) and state+postal (second-to-last),
 * return the next part as city.
 */
function extractCityFromAddress(address) {
  if (!address) return null;
  const parts = address.split(',').map(p => p.trim()).filter(Boolean);
  // Need at least: [..., city, state+postal, country]
  if (parts.length < 3) return null;
  // Second-to-last part often contains a postal code (digits) — that is the state segment
  const stateCandidate = parts[parts.length - 2];
  if (/\d/.test(stateCandidate)) {
    // Classic: [..., city, "State 000000", "Country"]
    return parts[parts.length - 3] || null;
  }
  // Fallback: third from last
  return parts[parts.length - 3] || null;
}

/**
 * Resolve the best DataForSEO location_code via city-name matching.
 *
 * Root cause confirmed by runtime logs (2026-06-17):
 *   ENTRIES WITH LAT/LNG 0 of 24397
 *   RETURNING 2356 — RETURN POINT A
 *
 * DataForSEO /v3/serp/google/locations does NOT return location_lat/location_lng.
 * Those fields are absent from every entry in the 226,293-location dataset.
 * The previous Haversine strategy was entirely non-functional.
 *
 * Correct strategy: match city name against the first segment of location_name.
 * DataForSEO location_name format: "Nashik,Nashik,Maharashtra,India"
 * Split on comma → first segment = city name → exact match against resolved city.
 *
 * @param {number}      userLat     - Google Places latitude (kept for signature compat)
 * @param {number}      userLng     - Google Places longitude (kept for signature compat)
 * @param {string|null} userAddress - Full formatted address (city extracted as fallback)
 * @param {string|null} countryCode - ISO-2 country code
 * @param {string|null} cityName    - Explicit city name from Google Places addressComponents
 */
async function getBestLocationCode(userLat, userLng, userAddress = null, countryCode = null, cityName = null) {
  try {
    const locations = await getDataForSEOLocations();

    const userCountry = countryCode?.toUpperCase() || extractCountryCode(userAddress);

    // Narrow to same country first
    let filteredLocations = locations;
    if (userCountry) {
      filteredLocations = locations.filter(loc => loc.country_iso_code === userCountry);
    }
    if (filteredLocations.length === 0) {
      filteredLocations = locations;
    }

    // Resolve city: prefer explicit Google Places city component, fall back to address parse
    const resolvedCity = (cityName?.trim()) || extractCityFromAddress(userAddress);

    if (resolvedCity) {
      const cityLower = resolvedCity.toLowerCase();
      const cityMatches = filteredLocations.filter(loc => {
        if (!loc.location_name) return false;
        return loc.location_name.split(',')[0].toLowerCase().trim() === cityLower;
      });

      if (cityMatches.length > 0) {
        const best = cityMatches.find(l => l.location_type === 'City') || cityMatches[0];
        return best.location_code;
      }
    }

    return getCountryFallbackCode(userCountry, userAddress);

  } catch (error) {
    return getCountryFallbackCode(countryCode, userAddress);
  }
}

/**
 * Get location_code from Google Places result
 */
async function getLocationCodeFromGooglePlaces(googlePlacesResult) {
  if (!googlePlacesResult || !googlePlacesResult.location) {
    console.warn('[DATASEO_LOCATIONS] Invalid Google Places result provided');
    return 2840; // Fallback to US
  }
  
  const { lat, lng } = googlePlacesResult.location;
  const address = googlePlacesResult.address || '';
  
  return await getBestLocationCode(lat, lng, address);
}

/**
 * Clear the locations cache (for testing or manual refresh)
 */
function clearLocationsCache() {
  console.log('[DATASEO_LOCATIONS] Clearing cache');
  locationsCache.data = null;
  locationsCache.lastFetch = null;
}

/**
 * Get cache status for debugging
 */
function getCacheStatus() {
  const now = Date.now();
  const age = locationsCache.lastFetch ? now - locationsCache.lastFetch : null;
  
  return {
    hasData: !!locationsCache.data,
    lastFetch: locationsCache.lastFetch,
    ageMinutes: age ? Math.round(age / 60000) : null,
    isExpired: age ? age > locationsCache.cacheDuration : true
  };
}

export {
  getBestLocationCode,
  getLocationCodeFromGooglePlaces,
  getDataForSEOLocations,
  clearLocationsCache,
  getCacheStatus,
  calculateDistance,
  extractCountryCode,
  extractCityFromAddress,
};
