import { getDataForSEOLocations } from '../../../../services/dataforseoLocationService.js';
import { normalizeForMatching } from '../../shared/services/brandMatchingService.js';

/**
 * Resolve the DataForSEO `location_code` for a visibility run from the project's saved market, through the provider's own location
 * list (cached 24 h by dataforseoLocationService). The target city is NEVER replaced by another city or a country: when it cannot be
 * resolved the run is refused with a configuration error that says what to fix.
 *
 *   local scope    the saved city (+ state when known) inside the saved country
 *   national scope the saved country
 *
 * DataForSEO location_name looks like "Nashik,Maharashtra,India": first segment = place, last = country, middle = state / region.
 */

export class LocationConfigError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'LocationConfigError';
    this.code = code;
    this.details = details;
  }
}

export const LOCATION_ERROR = Object.freeze({
  COUNTRY_MISSING: 'LOCATION_COUNTRY_MISSING',
  CITY_MISSING: 'LOCATION_CITY_MISSING',
  NOT_FOUND: 'LOCATION_NOT_FOUND',
  AMBIGUOUS: 'LOCATION_AMBIGUOUS',
  LOOKUP_FAILED: 'LOCATION_LOOKUP_FAILED',
});

const segments = (loc) => String(loc?.location_name || '').split(',').map((s) => s.trim());
const same = (a, b) => normalizeForMatching(a) === normalizeForMatching(b);

/**
 * @param {{effectiveScope:string, city:string|null, state:string|null, countryCode:string|null}} market  from the business profile
 * @param {{loadLocations?:Function}} [deps]
 * @returns {Promise<{locationCode:number, locationName:string, locationType:string|null, method:string}>}
 * @throws {LocationConfigError}
 */
export async function resolveLocation(market, { loadLocations = getDataForSEOLocations } = {}) {
  const countryCode = typeof market?.countryCode === 'string' && /^[A-Za-z]{2}$/.test(market.countryCode) ? market.countryCode.toUpperCase() : null;
  if (!countryCode) {
    throw new LocationConfigError(LOCATION_ERROR.COUNTRY_MISSING, 'Set the project\'s target country before running Google AI Overview Visibility.');
  }
  const local = market.effectiveScope === 'local';
  if (local && !market.city) {
    throw new LocationConfigError(LOCATION_ERROR.CITY_MISSING, 'Confirm the project\'s target city before running Google AI Overview Visibility.');
  }

  let locations;
  try {
    locations = await loadLocations();
  } catch {
    throw new LocationConfigError(LOCATION_ERROR.LOOKUP_FAILED, 'The location could not be verified with the data provider. Try again shortly.');
  }
  const inCountry = (Array.isArray(locations) ? locations : []).filter((l) => String(l?.country_iso_code || '').toUpperCase() === countryCode && Number.isInteger(l?.location_code));

  if (!local) {
    const country = inCountry.find((l) => l.location_type === 'Country');
    if (!country) throw new LocationConfigError(LOCATION_ERROR.NOT_FOUND, `No Google location was found for country ${countryCode}.`, { countryCode });
    return { locationCode: country.location_code, locationName: country.location_name, locationType: 'Country', method: 'country' };
  }

  let matches = inCountry.filter((l) => same(segments(l)[0], market.city) && l.location_type !== 'Country');
  const cityOnly = matches.filter((l) => l.location_type === 'City');
  if (cityOnly.length) matches = cityOnly;
  if (!matches.length) {
    throw new LocationConfigError(LOCATION_ERROR.NOT_FOUND, `Google has no location named "${market.city}" in ${countryCode}. Check the target city in the business profile; the run will not fall back to another place.`, { city: market.city, countryCode });
  }
  if (matches.length > 1 && market.state) {
    const byState = matches.filter((l) => segments(l).slice(1, -1).some((s) => same(s, market.state)));
    if (byState.length) matches = byState;
  }
  if (matches.length > 1) {
    throw new LocationConfigError(
      LOCATION_ERROR.AMBIGUOUS,
      `More than one Google location is named "${market.city}" in ${countryCode}. Add the state to the business profile so the right one is used.`,
      { city: market.city, candidates: matches.slice(0, 5).map((l) => l.location_name) },
    );
  }
  const [hit] = matches;
  return { locationCode: hit.location_code, locationName: hit.location_name, locationType: hit.location_type || null, method: 'city' };
}

export default { resolveLocation, LocationConfigError, LOCATION_ERROR };
