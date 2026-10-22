/**
 * Targeting resolver (Phase 6) — the ONLY place in this pipeline that turns
 * a free-text Odito location/language name into a Google Ads resource name
 * (`geoTargetConstants/{id}` / `languageConstants/{id}`).
 *
 * Read-only (GAQL SELECT), never a mutation. Kept isolated from
 * publishPlanBuilder.js on purpose: the plan builder must stay a pure,
 * deterministic function (spec §11) — this file is the async, network-
 * dependent step that runs BEFORE it and hands it already-resolved
 * resource names.
 *
 * DETERMINISTIC-OR-FAIL (spec §12): every location/language either resolves
 * to exactly one Google resource, or this throws a `TargetingResolutionError`
 * before any mutation is attempted. Never guesses, never picks "the first
 * match" when more than one exists.
 *
 * GAQL INJECTION DEFENCE: this is the first place in the codebase that
 * interpolates a free-text value (a location/language NAME, author-supplied
 * via the campaign draft) into a GAQL string, rather than only a validated
 * numeric id (the convention every existing googleAdsService.js query
 * follows). `escapeGaqlStringLiteral` implements GAQL's own string-literal
 * escaping rules (backslash and single-quote) so a name containing `'` or
 * `\` can never break out of its quoted literal — see the injection tests
 * in targetingResolver.test.js.
 */

import { withGoogleAdsRetry, wrapGoogleAdsError } from '../../../../services/googleAdsService.js';

export class TargetingResolutionError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'TargetingResolutionError';
    this.type = 'TARGETING_UNRESOLVED';
    this.details = details;
  }
}

/** GAQL string-literal escaping: backslash first, then single-quote. */
export function escapeGaqlStringLiteral(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

const LOCATION_TARGET_TYPE = {
  CITY: 'City',
  COUNTRY: 'Country',
  POSTAL_CODE: 'Postal Code',
};

/**
 * Resolve one Odito location to exactly one geoTargetConstants/{id} resource
 * name. CITY/COUNTRY/POSTAL_CODE are matched by name + country_code +
 * target_type. REGION has no single reliable target_type across countries
 * (it varies: State/Province/Region/...), so it is matched by name +
 * country_code alone and REQUIRES the match to be unique.
 */
async function resolveLocationTarget(customer, location) {
  const name = escapeGaqlStringLiteral(location.name);
  const countryCode = escapeGaqlStringLiteral(location.countryCode);
  const targetType = LOCATION_TARGET_TYPE[location.type];

  const conditions = [
    `geo_target_constant.name = '${name}'`,
    `geo_target_constant.country_code = '${countryCode}'`,
    `geo_target_constant.status = 'ENABLED'`,
  ];
  if (targetType) conditions.push(`geo_target_constant.target_type = '${escapeGaqlStringLiteral(targetType)}'`);

  let rows;
  try {
    rows = await withGoogleAdsRetry(
      () => customer.query(`
        SELECT geo_target_constant.id, geo_target_constant.resource_name, geo_target_constant.target_type
        FROM geo_target_constant
        WHERE ${conditions.join(' AND ')}
      `),
      'resolveLocationTarget',
    );
  } catch (err) {
    throw wrapGoogleAdsError(err, 'resolveLocationTarget', { name: location.name, countryCode: location.countryCode });
  }

  if (!rows || rows.length === 0) {
    throw new TargetingResolutionError(
      `Could not find a Google Ads location matching "${location.name}" (${location.countryCode}). Fix the location in the campaign settings before publishing.`,
      { location },
    );
  }
  if (rows.length > 1) {
    throw new TargetingResolutionError(
      `"${location.name}" (${location.countryCode}) matches more than one Google Ads location and cannot be resolved automatically. Use a more specific location before publishing.`,
      { location, matchCount: rows.length },
    );
  }
  return rows[0].geo_target_constant.resource_name;
}

/** Resolve one Odito language code to exactly one languageConstants/{id} resource name. */
async function resolveLanguageTarget(customer, language) {
  const code = escapeGaqlStringLiteral(String(language.code).toLowerCase());

  let rows;
  try {
    rows = await withGoogleAdsRetry(
      () => customer.query(`
        SELECT language_constant.id, language_constant.resource_name
        FROM language_constant
        WHERE language_constant.code = '${code}' AND language_constant.targetable = true
      `),
      'resolveLanguageTarget',
    );
  } catch (err) {
    throw wrapGoogleAdsError(err, 'resolveLanguageTarget', { code: language.code });
  }

  if (!rows || rows.length === 0) {
    throw new TargetingResolutionError(
      `"${language.code}" is not a targetable Google Ads language. Fix the language in the campaign settings before publishing.`,
      { language },
    );
  }
  return rows[0].language_constant.resource_name;
}

/**
 * @param {object} customer - a google-ads-api Customer handle (already built for the target account)
 * @param {object} args
 * @param {object[]} args.locations - draft.campaign.locations
 * @param {object[]} args.languages - draft.campaign.languages
 * @returns {Promise<{locations: {resourceName:string}[], languages: {resourceName:string}[]}>}
 */
export async function resolveTargeting(customer, { locations = [], languages = [] }) {
  const resolvedLocations = [];
  for (const location of locations) {
    // eslint-disable-next-line no-await-in-loop -- each lookup depends on nothing else; sequential keeps quota usage bounded and predictable, and there are at most a handful of locations per campaign.
    const resourceName = await resolveLocationTarget(customer, location);
    resolvedLocations.push({ ...location, resourceName });
  }

  const resolvedLanguages = [];
  for (const language of languages) {
    // eslint-disable-next-line no-await-in-loop
    const resourceName = await resolveLanguageTarget(customer, language);
    resolvedLanguages.push({ ...language, resourceName });
  }

  return { locations: resolvedLocations, languages: resolvedLanguages };
}

export default { resolveTargeting, escapeGaqlStringLiteral, TargetingResolutionError };
