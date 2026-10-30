import crypto from 'crypto';
import SeoProject from '../../../app_user/model/SeoProject.js';
import SocialBusinessProfile from '../../../social_meta/model/SocialBusinessProfile.js';
import { VisibilityError, VISIBILITY_ERROR } from '../errors/visibilityErrors.js';
import { cleanText, sanitizeFact, normalizeKey } from '../utils/text.js';
import { assessNameReliability } from './brandMatchingService.js';
import { deriveTargetHost } from './citationNormalizationService.js';
import { isIndustryValue, industryLabel } from '../../../../config/industries.js';

/**
 * The normalized, provider-independent business context every AI visibility provider works from.
 *
 * Sources (read-only, nothing is invented):
 *   SeoProject            name / industry / sub_industry / target_city / location / country / scope / language / keywords / host
 *   SeoProject.visibility_profile  the details the customer CONFIRMED for visibility questions (services, target cities, areas,
 *                         customer types and problems, requirements) - the canonical store; question sets snapshot it
 *   verified_business     the Google Places listing: name and PHYSICAL city. Only a listing with a placeId is "verified"; older
 *                         website-path projects stored a website-inferred city there without one, which is treated as unconfirmed.
 *   SocialBusinessProfile user-entered services and competitors (Social AI's profile). It is the only place Odito stores
 *                         them; it is optional, so both lists are often empty.
 *
 * Brand aliases: Google listing names are often branch names ("ASG Eye Hospital LASIK & FEMTO Laser Center jodhpur") while answers say
 * "ASG Eye Hospital". deriveBrandAliases() adds the core brand (and the customer-typed business_name) so mentions are matched.
 *
 * Name precedence: verified_business.name -> business_name (customer-typed) -> project_name (unverified fallback).
 * Category precedence: sub_industry -> legacy free-text industry -> industry label. business_type (how the business operates) is
 * NEVER used as an industry.
 * Target-city precedence: target_city (confirmed) -> first confirmed target city -> Google Places city -> customer-typed location ->
 * (last resort) an unverified verified_business.city. A disagreement between these is reported as a conflict, never resolved silently.
 * Every free-text fact is untrusted: it is cleaned, length-capped and DROPPED (never repaired) when it looks like an
 * instruction or carries a URL. `description` and `keywords` are carried for context but never reach a prompt or the
 * profile hash: descriptions are free text (an injection surface) and keywords change with every rank-tracking edit.
 */

export const PROFILE_HASH_VERSION = 2;
const MAX_LIST = 10;
const MAX_SERVICES = 10;
const MAX_COMPETITORS = 10;
const NAME_OPTS = { allowUrlLike: true };
// Business-model labels offered by onboarding (plus common spellings); compared via normalizeKey.
const GENERIC_BUSINESS_MODELS = new Set([
  'service-based', 'service based', 'service', 'services',
  'product-based', 'product based', 'product', 'products',
  'e-commerce', 'ecommerce', 'e commerce', 'agency', 'other', 'business',
]);

function regionName(code) {
  if (!code) return null;
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || null;
  } catch {
    return null;
  }
}

function dedupe(values) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    const k = normalizeKey(v);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

const byKey = (a, b) => (normalizeKey(a) < normalizeKey(b) ? -1 : normalizeKey(a) > normalizeKey(b) ? 1 : 0);

/** Deterministic hash of the MATERIAL inputs only (no timestamps, ids, description or keywords). */
export function computeProfileHash(profile) {
  const material = {
    v: PROFILE_HASH_VERSION,
    name: normalizeKey(profile.business.name),
    aliases: [...profile.business.aliases].map(normalizeKey).sort(),
    industry: normalizeKey(profile.business.industry),
    industryKey: profile.business.industryKey || null,
    subIndustry: normalizeKey(profile.business.subIndustry),
    services: profile.business.services.map(normalizeKey).sort(),
    targetCities: (profile.market.targetCities || []).map(normalizeKey).sort(),
    confirmed: Object.fromEntries(Object.entries(profile.confirmed || {}).filter(([k]) => k !== 'language').map(([k, v]) => [k, (v || []).map(normalizeKey).sort()])),
    competitors: profile.business.competitors.map(normalizeKey).sort(),
    scope: profile.market.effectiveScope,
    city: normalizeKey(profile.market.city),
    state: normalizeKey(profile.market.state),
    country: normalizeKey(profile.market.countryCode),
    language: normalizeKey(profile.market.language),
  };
  return crypto.createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

/**
 * Pure normalization of already-loaded documents (plain objects). Exported for tests and for callers that already
 * hold the documents.
 */
const KIND_WORD = /^(hospitals?|clinics?|centres?|centers?|institutes?|agency|agencies|studios?|schools?|academy|college|labs?|laboratories|pharmacy|salon|spa|restaurant|cafe|hotel|store|shop|solutions|technologies|group|associates|dental|care|services)$/i;
const escapeRe = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Shorter names the same business is commonly called by, derived ONLY from names on record (never invented): the listing name with a
 * trailing city and anything after a separator removed, and its shortest prefix that ends in a business-kind word ("... Hospital").
 */
export function deriveBrandAliases(name, { cities = [], extraNames = [] } = {}) {
  if (!name) return [];
  const out = [];
  const add = (v) => {
    const t = (v || '').replace(/[\s,&|\-–—]+$/, '').trim();
    if (t.split(/\s+/).length >= 2 && t.length >= 4 && normalizeKey(t) !== normalizeKey(name) && !out.some((o) => normalizeKey(o) === normalizeKey(t))) out.push(t);
  };
  let n = name;
  for (const c of cities.filter(Boolean)) n = n.replace(new RegExp(`[\\s,\\-|]*\\b${escapeRe(c)}\\s*$`, 'i'), '');
  n = n.split(/\s[-|–—]\s|,|\(/)[0].trim();
  add(n);
  const words = n.split(/\s+/);
  const kind = words.findIndex((w, i) => i >= 1 && KIND_WORD.test(w.replace(/[^A-Za-z]/g, '')));
  if (kind >= 1) add(words.slice(0, kind + 1).join(' '));
  for (const e of extraNames) add(e);
  return out.slice(0, 5);
}

export function normalizeBusinessProfile({ project, socialProfile = null }) {
  const warnings = [];
  const flag = (field) => warnings.push(`${field}_dropped_unsafe_value`);
  const take = (raw, field, max, opts) => {
    const r = sanitizeFact(raw, max, opts);
    if (r.flagged) flag(field);
    return r.value;
  };

  const verified = project.verified_business || {};

  // ── name ──
  let name = null;
  let nameSource = null;
  const candidates = [
    ['verified_business', take(verified.name, 'verified_business_name', 150, NAME_OPTS)],
    ['business_name', take(project.business_name, 'business_name', 150, NAME_OPTS)],
    ['project_name', take(project.project_name, 'project_name', 150, NAME_OPTS)],
  ];
  for (const [source, value] of candidates) {
    if (value) { name = value; nameSource = source; break; }
  }
  const nameVerified = nameSource === 'verified_business';
  if (nameSource === 'project_name') warnings.push('business_name_is_unverified_project_name');

  // ── industry / sub-industry ──
  // business_type ("Service-based"...) says HOW a business operates; it is never an industry, not even as a fallback.
  const isGeneric = (v) => Boolean(v) && GENERIC_BUSINESS_MODELS.has(normalizeKey(v));
  const rawIndustry = take(project.industry, 'industry', 100);
  const industryKey = isIndustryValue(rawIndustry) ? rawIndustry : null;
  let legacyIndustryText = null;
  if (rawIndustry && !industryKey) {
    if (isGeneric(rawIndustry)) warnings.push('industry_is_generic_business_model');
    else { legacyIndustryText = rawIndustry; warnings.push('industry_is_legacy_free_text'); }
  }
  if (!industryKey && !legacyIndustryText) warnings.push('industry_not_set');
  const subIndustryRaw = take(project.sub_industry, 'sub_industry', 100);
  const subIndustryOk = subIndustryRaw && !isGeneric(subIndustryRaw) ? subIndustryRaw : null;
  const subIndustry = subIndustryOk || legacyIndustryText || null;
  const indLabel = industryKey && industryKey !== 'other' ? industryLabel(industryKey) : null;
  // The phrase prompts and questions use for "what kind of business": the most specific confirmed one.
  const industry = subIndustry || (indLabel ? indLabel.toLowerCase() : null);
  const industrySource = subIndustryOk ? 'project.sub_industry' : (legacyIndustryText ? 'project.industry_legacy_text' : (indLabel ? 'project.industry' : null));

  // ── confirmed visibility details (canonical store on the project) ──
  const vp = project.visibility_profile || {};
  const list = (raw, field) => dedupe((Array.isArray(raw) ? raw : []).map((v) => take(v, field, 100)).filter(Boolean)).slice(0, MAX_LIST);
  const confirmed = {
    services: list(vp.services, 'confirmed_service'),
    targetCities: list(vp.target_cities, 'target_city'),
    serviceAreas: list(vp.service_areas, 'service_area'),
    customerTypes: list(vp.customer_types, 'customer_type'),
    customerProblems: list(vp.customer_problems, 'customer_problem'),
    requirements: list(vp.requirements, 'requirement'),
    buyingRequirements: list(vp.buying_requirements, 'buying_requirement'),
    language: typeof vp.language === 'string' && /^[a-z]{2}(-[a-z]{2})?$/i.test(vp.language) ? vp.language.toLowerCase() : null,
  };

  // ── services / competitors (user-entered Social AI profile; may not exist) ──
  const socialServices = dedupe(
    (socialProfile?.services || [])
      .filter((s) => s && (s.status === undefined || s.status === 'active'))
      .map((s) => take(s.name, 'service', 100))
      .filter(Boolean),
  ).slice(0, MAX_SERVICES);
  // Services the customer confirmed for visibility win; otherwise the Social AI profile's services are used.
  const services = confirmed.services.length ? confirmed.services : socialServices;
  const competitors = dedupe(
    (socialProfile?.competitors || [])
      .map((c) => take(c?.name, 'competitor', 100, NAME_OPTS))
      .filter((c) => c && normalizeKey(c) !== normalizeKey(name)),
  ).slice(0, MAX_COMPETITORS);

  // ── market ──
  const scope = project.seo_scope === 'local' || project.seo_scope === 'national' ? project.seo_scope : null;
  const countryCode = (typeof project.country === 'string' && /^[A-Za-z]{2}$/.test(project.country.trim())
    ? project.country.trim()
    : (typeof verified.countryCode === 'string' && /^[A-Za-z]{2}$/.test(verified.countryCode.trim()) ? verified.countryCode.trim() : null));
  const upperCountry = countryCode ? countryCode.toUpperCase() : null;
  const country = regionName(upperCountry);

  const placesVerified = Boolean(verified.placeId);
  const verifiedCity = take(verified.city, 'verified_city', 100);
  const locationCity = typeof project.location === 'string' ? take(project.location.split(',')[0], 'location', 100) : null;
  const targetCity = take(project.target_city, 'target_city', 100);
  const targetCityConfirmed = Boolean(targetCity) && project.location_source !== 'website_inferred';
  if (targetCity && !targetCityConfirmed) warnings.push('target_city_needs_confirmation');
  const cityCandidates = [
    [targetCityConfirmed ? targetCity : null, 'project.target_city'],
    [confirmed.targetCities[0] || null, 'visibility_profile.target_cities'],
    [placesVerified ? verifiedCity : null, 'verified_business.city'],
    [locationCity, 'project.location'],
    [!placesVerified ? verifiedCity : null, 'verified_business.city_unverified'],
  ];
  let city = null;
  let citySource = null;
  for (const [value, source] of cityCandidates) { if (value) { city = value; citySource = source; break; } }
  if (citySource === 'verified_business.city_unverified') warnings.push('city_source_unverified');

  // Disagreements are reported, never resolved silently. A Places-listed (physical) city may legitimately differ from the target.
  const conflicts = [];
  const hasConfirmedTarget = targetCityConfirmed || confirmed.targetCities.length > 0;
  if (!hasConfirmedTarget && !placesVerified && verifiedCity && locationCity && normalizeKey(verifiedCity) !== normalizeKey(locationCity)) {
    conflicts.push({ field: 'city', values: [locationCity, verifiedCity], sources: ['project.location', 'verified_business.city_unverified'] });
    warnings.push('location_conflict');
  }
  if (placesVerified && verifiedCity && city && normalizeKey(verifiedCity) !== normalizeKey(city)) warnings.push('physical_location_differs_from_target');
  // The listing's state only belongs with the listing's own city (e.g. not "Rajasthan" next to a Nashik target).
  // A state the customer typed next to the target city wins; otherwise the listing's state, but only with the listing's own city.
  const targetState = take(project.target_state, 'target_state', 100);
  const state = citySource === 'verified_business.city' ? take(verified.state, 'state', 100) : (targetState || null);
  const effectiveScope = scope === 'local' && city ? 'local' : 'national';
  const targetCities = effectiveScope === 'local' ? dedupe([city, ...confirmed.targetCities].filter(Boolean)).slice(0, MAX_LIST) : [...confirmed.targetCities];
  if (scope === 'local' && !city) warnings.push('local_scope_without_city_treated_as_national');
  if (!scope) warnings.push('seo_scope_not_set_treated_as_national');
  const projectLanguage = typeof project.language === 'string' && /^[a-z]{2}(-[a-z]{2})?$/i.test(project.language) ? project.language.toLowerCase() : 'en';
  const language = confirmed.language || projectLanguage;

  const label = effectiveScope === 'local'
    ? [city, state, country].filter(Boolean).join(', ')
    : (country || null);

  const targetHost = deriveTargetHost({ canonicalHost: project.canonical_host, canonicalUrl: project.canonical_url, mainUrl: project.main_url });

  const profile = {
    projectId: String(project._id),
    website: {
      mainUrl: project.main_url || null,
      canonicalUrl: project.canonical_url || null,
      canonicalHost: project.canonical_host || null,
      targetHost,
    },
    business: {
      name,
      nameSource,
      nameVerified,
      nameReliability: name ? assessNameReliability(name, [industry, indLabel, ...services].filter(Boolean)) : { reliable: false, reason: 'empty' },
      // A derived alias is only used when it can be matched reliably on its own: "Eye Hospital" (from "Eye Hospital of Mumbai") would
      // "match" every answer that merely describes the category, so it is dropped rather than inflating mentions.
      aliases: deriveBrandAliases(name, { cities: [verified.city, project.target_city, locationCity], extraNames: [take(project.business_name, 'business_name', 150, NAME_OPTS)].filter((v) => v && normalizeKey(v) !== normalizeKey(name)) })
        .filter((a) => assessNameReliability(a, [industry, indLabel, ...services].filter(Boolean)).reliable),
      aliasesSupported: true,
      industry,
      industrySource,
      industryKey,
      industryLabel: indLabel,
      subIndustry,
      businessType: take(project.business_type, 'business_type', 200),
      description: cleanText(project.description, 500),
      services,
      servicesSource: confirmed.services.length ? 'visibility_profile.services' : (services.length ? 'social_business_profile.services' : null),
      keywords: Array.isArray(project.keywords) ? project.keywords.map((k) => cleanText(k, 100)).filter(Boolean).slice(0, 50) : [],
      competitors,
      competitorsSource: competitors.length ? 'social_business_profile.competitors' : null,
    },
    market: {
      scope,
      effectiveScope,
      city: effectiveScope === 'local' ? city : null,
      citySource: effectiveScope === 'local' ? citySource : null,
      targetCities,
      physicalCity: placesVerified ? verifiedCity : null,
      conflicts,
      state: effectiveScope === 'local' ? state : null,
      country,
      countryCode: upperCountry,
      language,
      label,
    },
    confirmed,
    warnings,
  };
  profile.profileHash = computeProfileHash(profile);
  return profile;
}

/**
 * Load and normalize the business profile of one project.
 * @param {string} projectId
 * @param {{ loadProject?: Function, loadSocialProfile?: Function }} [deps] test seams
 * @throws {VisibilityError} PROJECT_NOT_FOUND
 */
export async function buildBusinessProfile(projectId, deps = {}) {
  const loadProject = deps.loadProject || ((id) => SeoProject.findOne({ _id: id, is_deleted: { $ne: true } }).lean());
  const loadSocialProfile = deps.loadSocialProfile || ((id) => SocialBusinessProfile.findOne({ project_id: id }).select('services competitors').lean());
  const project = await loadProject(projectId);
  if (!project) throw new VisibilityError(VISIBILITY_ERROR.PROJECT_NOT_FOUND, 'Project not found');
  let socialProfile = null;
  try {
    socialProfile = await loadSocialProfile(projectId);
  } catch {
    // The optional profile being unreadable must not block visibility: services/competitors fall back to the safe generic prompts.
    socialProfile = null;
  }
  return normalizeBusinessProfile({ project, socialProfile });
}

export default { buildBusinessProfile, normalizeBusinessProfile, computeProfileHash, PROFILE_HASH_VERSION };
