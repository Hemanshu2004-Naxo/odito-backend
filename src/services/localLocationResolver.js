/**
 * Local SEO Location Resolver
 *
 * Single, deterministic resolution path for local-scope keyword ranking.
 * Called ONLY when seo_scope === 'local'.  National projects must not use
 * this service — they use COUNTRY_TO_LOCATION_CODE directly in the controller.
 *
 * Resolution order (first match wins):
 *  1. Exact city-name match from verifiedBusiness.city
 *  2. Lat/lng available: city extracted from verifiedBusiness.address
 *  3. City extracted from the plain address string (website manual fallback)
 *  4. Country-level code (last resort)
 *
 * @returns {{ locationCode, mappingMethod, city, confidence, country }}
 */

import {
  getDataForSEOLocations,
  extractCountryCode,
  extractCityFromAddress,
  COUNTRY_TO_LOCATION_CODE,
} from './dataforseoLocationService.js';

// ── Logging helper ────────────────────────────────────────────────────────────

function log(label, { city = null, lat = null, lng = null, resolvedCode = null, mappingMethod = null } = {}) {
  console.log(
    `[LOCATION_TRACE] ${label}` +
    ` | city=${city ?? 'null'}` +
    ` | lat=${lat ?? 'null'}` +
    ` | lng=${lng ?? 'null'}` +
    ` | resolvedCode=${resolvedCode ?? 'null'}` +
    ` | method=${mappingMethod ?? 'null'}`
  );
}

// ── Country resolution ────────────────────────────────────────────────────────

// `verifiedBusinessCountryCode` must be handled as an already-resolved ISO-2
// code, not run through extractCountryCode() — that function looks for a
// full country NAME substring (e.g. "INDIA") inside free-text address
// strings, so a 2-letter code like "IN" or "US" never matches and was
// silently discarded here, even though it was a perfectly good, already-known
// country. This is what let a local-scope project with a set
// `verified_business.countryCode` but no top-level `country` field fall
// through to "country unknown" (and, before the caller-side fix in
// keywordRankingService.js, all the way to a silent US default).
function resolveCountry(country, verifiedBusinessCountryCode, ...addressFallbacks) {
  if (country) return country.toUpperCase();
  if (verifiedBusinessCountryCode) return verifiedBusinessCountryCode.toUpperCase();
  for (const addr of addressFallbacks) {
    const code = extractCountryCode(addr);
    if (code) return code;
  }
  return null;
}

// ── DataForSEO exact city-name search ────────────────────────────────────────

function findCityInLocations(locations, cityName, countryCode) {
  if (!cityName) return null;

  const searchSet = countryCode
    ? locations.filter(loc => loc.country_iso_code === countryCode)
    : locations;
  // If country filter produced nothing, fall back to global search
  const pool = searchSet.length > 0 ? searchSet : locations;

  const needle = cityName.toLowerCase().trim();
  const matches = pool.filter(loc =>
    loc.location_name?.split(',')[0].toLowerCase().trim() === needle
  );

  if (matches.length === 0) return null;
  // Prefer explicit 'City' type; otherwise take first match
  return matches.find(l => l.location_type === 'City') || matches[0];
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve a DataForSEO location_code for a local SEO project.
 *
 * @param {object|null} verifiedBusiness  - Project's verified_business subdoc (may be null for website-manual flow).
 *   Shape: { city, address, location: { lat, lng }, countryCode }
 * @param {string|null} country           - ISO-2 country code from the request (may be null).
 * @param {string|null} address           - Plain address string from the `location` request field.
 *   Used as a fallback when verifiedBusiness is absent (website-manual onboarding path).
 *
 * @returns {{ locationCode: number, mappingMethod: string, city: string|null, confidence: string, country: string|null }}
 */
export async function resolveLocalLocationCode({ verifiedBusiness, country, address = null }) {
  const vbCity    = verifiedBusiness?.city?.trim()             || null;
  const vbAddress = verifiedBusiness?.address                  || null;
  const lat       = verifiedBusiness?.location?.lat            ?? null;
  const lng       = verifiedBusiness?.location?.lng            ?? null;

  // Resolve country: explicit param → verifiedBusiness.countryCode → address string extraction
  const countryCode = resolveCountry(
    country,
    verifiedBusiness?.countryCode,
    vbAddress,
    address
  );

  log('START', { city: vbCity, lat, lng, resolvedCode: null, mappingMethod: null });

  // Fetch the DataForSEO location list (in-memory cached, 24 h TTL)
  let locations;
  try {
    locations = await getDataForSEOLocations();
  } catch (err) {
    // The location list is unreachable, so city-name matching (Priority 1-3
    // below) can't run. We can still return a *correct* result if the
    // project's country is actually known — that is not a guess. What we
    // must not do is invent US when the country is unknown too: that
    // previously happened unconditionally here (`?? COUNTRY_TO_LOCATION_CODE['US']`),
    // which is how a Mumbai-targeted project with no stored country code
    // silently got ranked against Google US SERPs. See keywordRankingService.js,
    // which now treats `locationCode: null` as a hard "configure location"
    // error instead of proceeding with a guessed location.
    const fallbackCode = countryCode ? COUNTRY_TO_LOCATION_CODE[countryCode] : null;
    if (fallbackCode) {
      log('FETCH_ERROR → known-country fallback', { city: null, lat, lng, resolvedCode: fallbackCode, mappingMethod: 'fetch_error_country_fallback' });
      return {
        locationCode:  fallbackCode,
        mappingMethod: 'fetch_error_country_fallback',
        city:          null,
        confidence:    'low',
        country:       countryCode,
      };
    }
    log('FETCH_ERROR → UNRESOLVED (no known country, will not guess US)', { city: vbCity, lat, lng, resolvedCode: null, mappingMethod: 'unresolved_service_unavailable' });
    return {
      locationCode:  null,
      mappingMethod: 'unresolved_service_unavailable',
      city:          vbCity,
      confidence:    'none',
      country:       countryCode,
    };
  }

  // ── Priority 1: verifiedBusiness.city (Google Places city component) ─────────
  if (vbCity) {
    const match = findCityInLocations(locations, vbCity, countryCode);
    if (match) {
      log('P1 resolved — verified_business.city', { city: vbCity, lat, lng, resolvedCode: match.location_code, mappingMethod: 'verified_business_city' });
      return {
        locationCode:  match.location_code,
        mappingMethod: 'verified_business_city',
        city:          vbCity,
        confidence:    'high',
        country:       countryCode,
      };
    }
    log('P1 miss — city absent from DataForSEO dataset', { city: vbCity, lat, lng, resolvedCode: null, mappingMethod: null });
  }

  // ── Priority 2: lat/lng present — extract city from structured vbAddress ─────
  // DataForSEO's /locations endpoint does not expose coordinates, so Haversine
  // cannot be applied directly.  When the business has known coordinates we can
  // trust the structured Google Places address is high-quality, so we extract
  // the city from it and do an exact name match.
  if (lat != null && lng != null && vbAddress) {
    const parsedCity = extractCityFromAddress(vbAddress);
    const match      = parsedCity ? findCityInLocations(locations, parsedCity, countryCode) : null;
    if (match) {
      log('P2 resolved — lat/lng address parse', { city: parsedCity, lat, lng, resolvedCode: match.location_code, mappingMethod: 'haversine_address_city' });
      return {
        locationCode:  match.location_code,
        mappingMethod: 'haversine_address_city',
        city:          parsedCity,
        confidence:    'high',
        country:       countryCode,
      };
    }
    log('P2 miss', { city: parsedCity ?? null, lat, lng, resolvedCode: null, mappingMethod: null });
  }

  // ── Priority 3: extract city from plain address string (website-manual path) ─
  // vbAddress and the plain `address` param may differ; try both.
  const addressesToTry = [...new Set([vbAddress, address].filter(Boolean))];
  for (const addr of addressesToTry) {
    const parsedCity = extractCityFromAddress(addr);
    const match      = parsedCity ? findCityInLocations(locations, parsedCity, countryCode) : null;
    if (match) {
      log('P3 resolved — address string parse', { city: parsedCity, lat, lng, resolvedCode: match.location_code, mappingMethod: 'address_parse' });
      return {
        locationCode:  match.location_code,
        mappingMethod: 'address_parse',
        city:          parsedCity,
        confidence:    'medium',
        country:       countryCode,
      };
    }
    if (parsedCity) {
      log('P3 miss for addr', { city: parsedCity, lat, lng, resolvedCode: null, mappingMethod: null });
    }
  }

  // ── Priority 4: country-level fallback ───────────────────────────────────────
  // Only use this when the country is actually known and supported — never
  // guess US as a last resort. An unresolved result here means "this
  // project's location genuinely cannot be determined from the data we
  // have," which the caller must treat as a configuration problem, not
  // silently rank against whatever COUNTRY_TO_LOCATION_CODE['US'] happens
  // to be.
  const fallbackCode = countryCode ? COUNTRY_TO_LOCATION_CODE[countryCode] : null;
  if (fallbackCode) {
    log('P4 country fallback', { city: null, lat, lng, resolvedCode: fallbackCode, mappingMethod: 'country_fallback' });
    return {
      locationCode:  fallbackCode,
      mappingMethod: 'country_fallback',
      city:          null,
      confidence:    'low',
      country:       countryCode,
    };
  }

  log('P4 UNRESOLVED — no city match and no known/supported country (will not guess US)', { city: vbCity, lat, lng, resolvedCode: null, mappingMethod: 'unresolved_no_country' });
  return {
    locationCode:  null,
    mappingMethod: 'unresolved_no_country',
    city:          vbCity,
    confidence:    'none',
    country:       countryCode,
  };
}
