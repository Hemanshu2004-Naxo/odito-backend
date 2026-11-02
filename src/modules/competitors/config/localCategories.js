/**
 * How a project's business maps to Google Places searches for Local Competitors. ONE maintainable table.
 *
 * Two kinds of search come out of it:
 *   queries  free-text searches ("eye hospital") taken from the PROJECT'S OWN words (its sub-industry and connected Business Profile
 *            categories). They are never invented: Google has no "eye care" type, but its text search finds eye hospitals by name.
 *   types    Google Places type names (Table A of "Place Types (New)") for a broader search. ONLY values in ALLOWED_TYPES may ever be sent:
 *            they were checked against Google's published list, so an unknown value can never reach Google as a 400.
 *
 * A rule fires when ANY of its patterns matches the project's own phrases; the more specific a project's words, the more specific the types.
 * When nothing in the project's words matches any rule, the industry gives a broad fallback (marked "broad"); when even that is missing,
 * the result is "none": the page asks the user to confirm a category rather than searching for everything nearby.
 */

/** Google Places (New) Table A values used here, verified against https://developers.google.com/maps/documentation/places/web-service/place-types */
export const ALLOWED_TYPES = Object.freeze(new Set([
  // Health and wellness
  'chiropractor', 'dental_clinic', 'dentist', 'doctor', 'drugstore', 'general_hospital', 'hospital', 'medical_center', 'medical_clinic', 'medical_lab',
  'pharmacy', 'physiotherapist', 'skin_care_clinic', 'spa', 'wellness_center', 'massage', 'yoga_studio',
  // Food and drink
  'restaurant', 'cafe', 'coffee_shop', 'bakery', 'meal_takeaway', 'indian_restaurant', 'fast_food_restaurant',
  // Services
  'beauty_salon', 'hair_salon', 'hair_care', 'nail_salon', 'barber_shop', 'lawyer', 'real_estate_agency', 'insurance_agency', 'travel_agency', 'tour_agency',
  'plumber', 'electrician', 'veterinary_care', 'consultant', 'marketing_consultant', 'child_care_agency', 'moving_company', 'florist', 'laundry',
  // Shopping, lodging, education, automotive
  'store', 'clothing_store', 'electronics_store', 'furniture_store', 'jewelry_store', 'supermarket', 'grocery_store',
  'hotel', 'lodging', 'guest_house', 'resort_hotel',
  'school', 'university', 'preschool', 'primary_school', 'secondary_school',
  'car_dealer', 'car_repair', 'car_rental', 'car_wash', 'tire_shop',
]));

const RULES = [
  { id: 'eye_care', match: [/\beye\b/, /ophthalm/, /optic/, /optom/, /cataract/, /lasik/, /retina/], types: ['hospital', 'doctor', 'medical_clinic'] },
  { id: 'hospital', match: [/hospital/, /nursing home/], types: ['hospital', 'general_hospital'] },
  { id: 'clinic', match: [/clinic/, /polyclinic/, /medical cent(re|er)/], types: ['medical_clinic', 'medical_center', 'doctor'] },
  { id: 'doctor', match: [/doctor/, /physician/, /surgeon/, /specialist/, /consultant physician/], types: ['doctor', 'medical_clinic'] },
  { id: 'dental', match: [/dent(al|ist)/, /orthodont/], types: ['dentist', 'dental_clinic'] },
  { id: 'pharmacy', match: [/pharmac/, /chemist/, /medical store/], types: ['pharmacy', 'drugstore'] },
  { id: 'lab', match: [/diagnostic/, /pathology/, /\blab(oratory)?\b/], types: ['medical_lab'] },
  { id: 'physio', match: [/physio/, /rehab/], types: ['physiotherapist'] },
  { id: 'restaurant', match: [/restaurant/, /dining/, /eatery/], types: ['restaurant'] },
  { id: 'cafe', match: [/\bcafe\b/, /coffee/], types: ['cafe', 'coffee_shop'] },
  { id: 'bakery', match: [/bakery/, /patisserie/], types: ['bakery'] },
  { id: 'salon', match: [/salon/, /hair/, /barber/], types: ['hair_salon', 'beauty_salon', 'hair_care'] },
  { id: 'beauty', match: [/beauty/, /cosmetic/, /skin/, /makeup/], types: ['beauty_salon', 'skin_care_clinic'] },
  { id: 'spa', match: [/\bspa\b/, /wellness/, /massage/], types: ['spa', 'wellness_center'] },
  { id: 'legal', match: [/lawyer/, /law firm/, /advocate/, /attorney/, /legal/], types: ['lawyer'] },
  { id: 'real_estate', match: [/real estate/, /property/, /realtor/, /broker/], types: ['real_estate_agency'] },
  { id: 'insurance', match: [/insurance/], types: ['insurance_agency'] },
  { id: 'travel', match: [/travel/, /tour/, /holiday/], types: ['travel_agency', 'tour_agency'] },
  { id: 'hotel', match: [/hotel/, /resort/, /lodging/, /guest house/], types: ['hotel', 'lodging', 'guest_house'] },
  { id: 'school', match: [/school/, /academy/, /coaching/, /tuition/], types: ['school', 'secondary_school', 'primary_school'] },
  { id: 'college', match: [/college/, /university/, /institute/], types: ['university', 'school'] },
  { id: 'auto', match: [/\bcar\b/, /garage/, /automobile/, /auto (service|repair)/, /dealership/], types: ['car_repair', 'car_dealer'] },
  { id: 'plumber', match: [/plumb/], types: ['plumber'] },
  { id: 'electrician', match: [/electric/], types: ['electrician'] },
  { id: 'vet', match: [/\bvet(erinary)?\b/, /pet clinic/], types: ['veterinary_care'] },
  { id: 'marketing', match: [/marketing/, /advertis/, /seo\b/, /branding/], types: ['marketing_consultant', 'consultant'] },
];

/** Used only when none of the project's own words match a rule. A broad net: results are marked "broad" and rarely "direct". */
const INDUSTRY_FALLBACK = {
  healthcare: ['hospital', 'doctor', 'medical_clinic'],
  beauty_wellness: ['beauty_salon', 'hair_salon', 'spa'],
  hospitality_food: ['restaurant', 'cafe', 'hotel'],
  legal: ['lawyer'],
  real_estate_construction: ['real_estate_agency'],
  home_services: ['plumber', 'electrician'],
  automotive: ['car_repair', 'car_dealer'],
  travel_tourism: ['travel_agency', 'tour_agency'],
  education: ['school', 'university'],
  finance: ['insurance_agency'],
  professional_services: ['consultant'],
  marketing_advertising: ['marketing_consultant'],
  retail_ecommerce: ['store'],
};

const norm = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const clean = (s) => { const v = typeof s === 'string' ? s.trim().replace(/\s+/g, ' ') : ''; return v.length >= 3 && v.length <= 60 ? v : null; };
export const MAX_QUERIES = 3;
export const MAX_TYPES = 6;

/**
 * Suggested searches for a project (the classifier's profile: subIndustry, gbp, services, industry). Pure.
 * @returns {{ specificity: 'specific'|'broad'|'none', queries: string[], types: string[], rules: string[], words: string[] }}
 *  `words` are the project's own phrases, used to tell a "direct" result from a "related" one.
 */
export function suggestCategories(profile) {
  const phrases = [];
  const add = (v) => { const c = clean(v); if (c && !phrases.some((p) => norm(p) === norm(c))) phrases.push(c); };
  add(profile?.subIndustry);
  if (profile?.gbp?.trusted) { add(profile.gbp.category); (profile.gbp.secondary ?? []).forEach(add); }
  add(profile?.businessType);
  const queries = phrases.slice(0, MAX_QUERIES);
  const text = phrases.map(norm);
  const fired = RULES.filter((r) => text.some((t) => r.match.some((re) => re.test(t))));
  let types = [...new Set(fired.flatMap((r) => r.types))].filter((t) => ALLOWED_TYPES.has(t)).slice(0, MAX_TYPES);
  const services = (profile?.services ?? []).map(clean).filter(Boolean);
  if (types.length) return { specificity: 'specific', queries, types, rules: fired.map((r) => r.id), words: [...phrases, ...services] };
  const fallback = (INDUSTRY_FALLBACK[profile?.industry] ?? []).filter((t) => ALLOWED_TYPES.has(t));
  if (fallback.length || queries.length) return { specificity: fallback.length ? 'broad' : 'specific', queries, types: fallback, rules: [], words: [...phrases, ...services] };
  return { specificity: 'none', queries: [], types: [], rules: [], words: [...services] };
}

/** A user's correction of the suggestion: only valid queries and allowed types survive; nothing else is ever sent to Google. */
export function applyCorrection(suggestion, { queries, types } = {}) {
  const q = Array.isArray(queries) ? [...new Set(queries.map(clean).filter(Boolean))].slice(0, MAX_QUERIES) : null;
  const t = Array.isArray(types) ? [...new Set(types.filter((x) => typeof x === 'string' && ALLOWED_TYPES.has(x)))].slice(0, MAX_TYPES) : null;
  const out = { ...suggestion, queries: q ?? suggestion.queries, types: t ?? suggestion.types };
  if (q || t) out.specificity = (out.queries.length || out.types.length) ? 'specific' : 'none';
  out.corrected = Boolean(q || t);
  return out;
}

/**
 * How one Google result relates to the project's category: 'direct' (its Google category is one of the project's types AND its name or
 * category label uses one of the project's own words), 'related' (its category is one of the types, or its words match, but not both),
 * or 'unclassified' (nothing connects it). Proximity is never an input.
 */
export function classifyPlace(place, mapping) {
  const types = new Set([...(place.types ?? []), place.primaryType].filter(Boolean));
  const typeHit = mapping.types.some((t) => types.has(t));
  const label = norm(`${place.name ?? ''} ${place.primaryTypeLabel ?? ''}`);
  const labelTokens = new Set(label.split(' ').filter(Boolean));
  const wordHit = mapping.words.some((w) => {
    const n = norm(w);
    if (!n) return false;
    if (` ${label} `.includes(` ${n} `)) return true;
    const toks = n.split(' ').filter((x) => x.length > 2);
    return toks.length >= 2 && toks.every((x) => labelTokens.has(x));
  });
  if (typeHit && wordHit) return 'direct';
  if (typeHit || wordHit) return 'related';
  return 'unclassified';
}
