/**
 * Facts from the owner-connected Google Business Profile, as schema evidence — but ONLY when the profile demonstrably
 * belongs to THIS website.
 *
 * Why the trust gate matters: a profile can describe a different brand or a different listing than the site being
 * audited (a real project: a hospital-network profile whose website was another domain, with a different phone number).
 * Writing its phone or address into the site's schema would publish the wrong facts, so the profile is trusted only when
 * its `website` is on the same host as the project's site and the business is open. Anything else is reported as
 * unverified and never used for a value.
 */

import { hostOf } from './schemaGraph.js';

// GBP primary-category label (lower-cased) -> schema.org type. A deliberately small, vetted table: an unlisted
// category maps to nothing, which means "LocalBusiness" at most, never a guessed specific type.
export const CATEGORY_TO_SCHEMA_TYPE = Object.freeze({
  hospital: 'Hospital',
  'medical clinic': 'MedicalClinic',
  clinic: 'MedicalClinic',
  dentist: 'Dentist',
  'dental clinic': 'Dentist',
  pharmacy: 'Pharmacy',
  optician: 'Optician',
  physician: 'Physician',
  doctor: 'Physician',
  restaurant: 'Restaurant',
  cafe: 'CafeOrCoffeeShop',
  'coffee shop': 'CafeOrCoffeeShop',
  bakery: 'Bakery',
  hotel: 'Hotel',
  'beauty salon': 'BeautySalon',
  'hair salon': 'HairSalon',
  'nail salon': 'NailSalon',
  'law firm': 'LegalService',
  lawyer: 'LegalService',
  'real estate agency': 'RealEstateAgent',
  'travel agency': 'TravelAgency',
  'accounting firm': 'AccountingService',
  store: 'Store',
});

export const schemaTypeForCategory = (label) => (typeof label === 'string' ? CATEGORY_TO_SCHEMA_TYPE[label.trim().toLowerCase()] || null : null);

const DAYS = { MONDAY: 'Monday', TUESDAY: 'Tuesday', WEDNESDAY: 'Wednesday', THURSDAY: 'Thursday', FRIDAY: 'Friday', SATURDAY: 'Saturday', SUNDAY: 'Sunday' };
const hhmm = (t) => (t && Number.isFinite(Number(t.hours ?? 0)) ? `${String(Number(t.hours ?? 0)).padStart(2, '0')}:${String(Number(t.minutes ?? 0)).padStart(2, '0')}` : null);

/** Google `regularHours.periods` -> schema.org openingHoursSpecification; null when the shape is not the expected one. */
export function hoursToSpecification(regularHours) {
  const periods = Array.isArray(regularHours) ? regularHours : regularHours?.periods;
  if (!Array.isArray(periods) || !periods.length) return null;
  const out = [];
  for (const p of periods) {
    const open = hhmm(p?.openTime); const close = hhmm(p?.closeTime);
    if (!DAYS[p?.openDay] || !open || !close || p.openDay !== p.closeDay) return null; // overnight/odd periods: omit rather than guess
    out.push({ '@type': 'OpeningHoursSpecification', dayOfWeek: DAYS[p.openDay], opens: open, closes: close });
  }
  return out;
}

/**
 * @param {object|null} meta     business_profile_metadata document (or null)
 * @param {{siteUrl: string}} ctx
 */
export function normalizeBusinessProfile(meta, { siteUrl } = {}) {
  if (!meta) return { available: false, trusted: false, reason: 'no_profile' };
  const siteHost = hostOf(siteUrl);
  const profileHost = hostOf(meta.website);
  let reason = null;
  if (!meta.website || !profileHost) reason = 'profile_has_no_website';
  else if (!siteHost || profileHost !== siteHost) reason = 'profile_website_is_a_different_site';
  else if (meta.business_status && meta.business_status !== 'OPEN') reason = 'business_not_open';
  const trusted = reason === null;

  return {
    available: true,
    trusted,
    reason,
    name: meta.business_name || null,
    categoryLabel: meta.category || null,
    schemaType: schemaTypeForCategory(meta.category),
    address: typeof meta.address === 'string' && meta.address.trim() ? meta.address.trim() : null,
    telephone: typeof meta.phone === 'string' && meta.phone.trim() ? meta.phone.trim() : null,
    openingHoursSpecification: hoursToSpecification(meta.regular_hours),
    latitude: Number.isFinite(meta.latitude) ? meta.latitude : null,
    longitude: Number.isFinite(meta.longitude) ? meta.longitude : null,
    website: meta.website || null,
  };
}

/** Loads and normalises the project's GBP metadata. Never throws; any failure means "no profile". */
export async function loadBusinessProfileFacts(projectId, siteUrl, { model } = {}) {
  try {
    const Model = model || (await import('../app_user/model/BusinessProfileMetadata.js')).default;
    const meta = await Model.findOne({ project_id: projectId }).lean();
    return normalizeBusinessProfile(meta, { siteUrl });
  } catch (err) {
    console.warn(`[BUSINESS_PROFILE_FACTS] unavailable: ${err.message}`);
    return { available: false, trusted: false, reason: 'unavailable' };
  }
}

export default { CATEGORY_TO_SCHEMA_TYPE, schemaTypeForCategory, hoursToSpecification, normalizeBusinessProfile, loadBusinessProfileFacts };
