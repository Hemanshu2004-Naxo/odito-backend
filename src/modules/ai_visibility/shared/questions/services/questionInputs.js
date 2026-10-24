import { sanitizeFact, normalizeKey } from '../../utils/text.js';
import { INPUT_LIMITS } from '../config/questionConfig.js';

/**
 * What the question generator may use, taken ONLY from the normalized business profile - which in turn reads the project's canonical,
 * customer-confirmed details (SeoProject.visibility_profile, sub_industry, target_city...). There is no second store: a question set
 * snapshots these inputs, and a request can never supply them.
 */

/**
 * Clean one list of untrusted entries (used when the customer saves the profile). Entries are trimmed, length-capped and de-duplicated;
 * an entry that looks like an instruction or carries a URL is REJECTED and reported, never silently repaired.
 * @returns {{ values: string[], rejected: number, tooMany: boolean }}
 */
export function sanitizeList(raw) {
  if (!Array.isArray(raw)) return { values: [], rejected: 0, tooMany: false };
  const seen = new Set();
  const values = [];
  let rejected = 0;
  for (const item of raw) {
    if (typeof item === 'string' && item.trim().length > INPUT_LIMITS.itemLength) { rejected += 1; continue; }
    const { value, flagged } = sanitizeFact(item, INPUT_LIMITS.itemLength);
    if (flagged) { rejected += 1; continue; }
    const key = normalizeKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    values.push(value);
  }
  return { values: values.slice(0, INPUT_LIMITS.listItems), rejected, tooMany: values.length > INPUT_LIMITS.listItems };
}

/**
 * The category phrase used in questions: the confirmed sub-industry ("eye hospital"), else the industry as a provider phrase
 * ("healthcare provider"). Never the business type.
 */
function categoryPhrase(business) {
  if (business.subIndustry) return business.subIndustry;
  if (business.industryLabel) return `${business.industryLabel.toLowerCase()} provider`;
  return business.industry || null;
}

/**
 * @param {object} profile normalized business profile (businessProfileService)
 * @returns {{inputs: object, missing: string[], warnings: string[]}}
 */
export function buildQuestionInputs(profile) {
  const c = profile.confirmed || {};
  const category = categoryPhrase(profile.business);
  // Only CONFIRMED target cities: for a local business the profile's resolved target city plus any additional confirmed ones; for a
  // national business only cities the customer explicitly confirmed. A physical (listing) city is never assumed to be a target.
  const cities = profile.market.targetCities || [];
  const inputs = {
    categories: category ? [category] : [],
    services: [...profile.business.services],
    cities: [...cities],
    areas: [...(c.serviceAreas || [])],
    requirements: [...(c.requirements || [])],
    problems: [...(c.customerProblems || [])],
    customerTypes: [...(c.customerTypes || [])],
    buyingRequirements: [...(c.buyingRequirements || [])],
    language: profile.market.language || 'en',
  };

  const missing = [];
  if (!inputs.categories.length) missing.push('business_category');
  if (!inputs.services.length) missing.push('services');
  if (!inputs.cities.length) missing.push('target_cities');
  if (!inputs.customerTypes.length) missing.push('customer_types');
  if (!inputs.problems.length) missing.push('customer_problems');
  if (!inputs.requirements.length) missing.push('requirements');
  if (!inputs.buyingRequirements.length) missing.push('buying_requirements');

  // Profile issues the customer should fix before relying on location-specific questions.
  const warnings = (profile.warnings || []).filter((w) => [
    'location_conflict', 'target_city_needs_confirmation', 'city_source_unverified', 'industry_not_set',
    'industry_is_generic_business_model', 'industry_is_legacy_free_text',
  ].includes(w));
  return { inputs, missing, warnings };
}

export default { buildQuestionInputs, sanitizeList };
