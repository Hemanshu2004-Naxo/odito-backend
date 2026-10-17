/**
 * schemaIntent — WHICH entity ODITO should recommend, decided from evidence and carried unchanged through the
 * whole pipeline (Issue → Resolver → Evidence → Context → Objective → Prompt → Guard → Validator → UI).
 *
 * Before this module the pipeline had no notion of "which schema": the objective said "Organization", the prompt said
 * "Organization", and the guard downgraded any new LocalBusiness to Organization when the page itself held no
 * address — so a hospital whose address sat on the homepage was always told to publish a generic Organization.
 *
 * `resolveSchemaIntent` is pure. It uses only verified evidence:
 *   - the page's own markup,
 *   - the site-level entity registry (markup on any crawled page of the project),
 *   - a Google Business Profile that was verified to belong to THIS website.
 * It never picks a specific type (Hospital, Dentist …) without such evidence, never invents a missing fact, and when a
 * fact that the chosen type requires is missing it returns `action: 'needs_input'` — a question, not a guess.
 *
 * Intents:
 *   organization_schema     a plain Organization (no verified physical location)
 *   local_business_schema   LocalBusiness or a specific subtype other than Hospital (Dentist, MedicalClinic, Restaurant …)
 *   hospital_schema         Hospital (only with evidence)
 *   schema_already_present  the entity exists (on this page, or site-wide for a page that needs none): reuse, don't duplicate
 *
 * Actions: generate | reuse | reference | needs_input
 */

import { hasType, typeSatisfies, typesOf } from './schemaGraph.js';

export const SCHEMA_INTENT_VERSION = 1;

export const INTENTS = Object.freeze({
  ORGANIZATION: 'organization_schema',
  LOCAL_BUSINESS: 'local_business_schema',
  HOSPITAL: 'hospital_schema',
  ALREADY_PRESENT: 'schema_already_present',
});

const LOCATION_PAGE_TYPES = new Set(['contact', 'location']);

const first = (v) => (Array.isArray(v) ? v[0] : v);
const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const isRootUrl = (url) => { try { const u = new URL(url); return (u.pathname.replace(/\/+$/, '') || '/') === '/' && !u.search; } catch { return false; } };

export const pageNeedsEntity = (pageUrl, pageType) => isHomepage(pageUrl, pageType) || isLocationPage(pageType);
const isHomepage = (pageUrl, pageType) => isRootUrl(pageUrl) || /^home(page)?$/i.test(pageType || '');
const isLocationPage = (pageType) => LOCATION_PAGE_TYPES.has(String(pageType || '').toLowerCase());

/** The most specific recognised Organization subtype among `types` (not Organization / LocalBusiness themselves). */
export function specificTypeOf(types) {
  return typesOf({ '@type': types }).find((t) => t !== 'Organization' && t !== 'LocalBusiness' && typeSatisfies(t, 'Organization')) || null;
}

export const intentNameFor = (type) => (type === 'Hospital' ? INTENTS.HOSPITAL : type === 'Organization' ? INTENTS.ORGANIZATION : INTENTS.LOCAL_BUSINESS);

const FIELD_LABEL = {
  address: 'Street address of the location',
  name: 'Business name',
};

/** @returns {{value:*, source:string}|null} the first non-empty candidate, in priority order */
const firstFact = (...candidates) => candidates.find((c) => c && c.value != null && c.value !== '' && !(Array.isArray(c.value) && !c.value.length)) || null;

/**
 * The facts a recommendation may publish, each with the source it came from. Priority is always: this page's own
 * markup → the site's entity markup (any page) → the verified Business Profile. Physical-only facts (address, geo,
 * hours, map) are collected only for a physical-location intent.
 */
export function collectVerifiedFacts({ organization, site, profile, physical }) {
  const pageNode = organization?.primary?.node || null;
  const siteNode = site?.primary?.node || null;
  const gbp = profile?.trusted ? profile : null;
  const out = {};
  const pick = (field, ...extra) => {
    const hit = firstFact(
      pageNode?.[field] != null ? { value: clone(pageNode[field]), source: 'page_markup' } : null,
      siteNode?.[field] != null ? { value: clone(siteNode[field]), source: 'site_entity_markup' } : null,
      ...extra,
    );
    if (hit) out[field] = hit;
  };

  pick('telephone', gbp?.telephone ? { value: gbp.telephone, source: 'google_business_profile' } : null);
  for (const f of ['email', 'contactPoint', 'sameAs', 'faxNumber', 'priceRange', 'areaServed']) pick(f);
  if (physical) {
    pick('address',
      site?.place?.address != null ? { value: clone(site.place.address), source: 'site_place_markup' } : null,
      gbp?.address ? { value: gbp.address, source: 'google_business_profile' } : null);
    // geo / hasMap live on the Place the entity already points to (`location`); copying them onto the entity too would
    // only duplicate that node, so they are added only when the entity has no linked Place.
    const linkedPlace = !!(pageNode?.location || siteNode?.location);
    pick('geo',
      !linkedPlace && site?.place?.geo ? { value: clone(site.place.geo), source: 'site_place_markup' } : null,
      Number.isFinite(gbp?.latitude) && Number.isFinite(gbp?.longitude) ? { value: { '@type': 'GeoCoordinates', latitude: gbp.latitude, longitude: gbp.longitude }, source: 'google_business_profile' } : null);
    pick('hasMap', !linkedPlace && site?.place?.hasMap ? { value: site.place.hasMap, source: 'site_place_markup' } : null);
    pick('openingHoursSpecification', gbp?.openingHoursSpecification ? { value: gbp.openingHoursSpecification, source: 'google_business_profile' } : null);
    pick('openingHours');
  }
  return out;
}

/** Verified business name: page entity → site entity → WebSite → og:site_name → Business Profile (only when trusted). */
export function pickName(organization, site, profile) {
  const o = organization?.name;
  if (o?.value) return o;
  const siteName = clean(site?.primary?.node?.name);
  if (siteName) return { value: siteName, source: 'site_entity_schema', verified: true };
  if (profile?.trusted && clean(profile.name)) return { value: clean(profile.name), source: 'google_business_profile', verified: true };
  return null;
}

/**
 * @param {object} p
 * @param {string} p.pageUrl
 * @param {string|null} p.pageType
 * @param {object} p.organization  evidence.organization (page-level)
 * @param {object|null} p.site     analyzeSiteEntity() result
 * @param {object|null} p.profile  normalizeBusinessProfile() result
 */
export function resolveSchemaIntent({ pageUrl, pageType = null, organization, site = null, profile = null, address = null }) {
  const home = isHomepage(pageUrl, pageType);
  const locationPage = isLocationPage(pageType);
  const entityPage = home || locationPage;
  const scope = home ? 'homepage' : locationPage ? 'location_page' : 'non_entity_page';
  const reasons = [];
  const notes = [];
  const pageEntity = organization?.primary || null;
  const siteEntity = site?.primary || null;

  if (profile?.available && !profile.trusted) {
    notes.push(profile.reason === 'profile_website_is_a_different_site'
      ? 'The connected Google Business Profile lists a different website, so none of its details were used.'
      : `The connected Google Business Profile was not used (${String(profile.reason || 'unverified').replace(/_/g, ' ')}).`);
  }

  const base = { version: SCHEMA_INTENT_VERSION, scope, placement: entityPage ? 'this_page' : 'homepage', reasons, notes, missing: [], optional: [], reuse: null };
  const reuseOf = (entity, why) => entity ? { id: entity.id || null, pageUrl: entity.pageUrl || null, types: entity.types || [], reason: why } : null;

  // ── 1. This page already carries a valid entity ────────────────────────────
  if (pageEntity) {
    const types = pageEntity.types;
    const physical = hasType({ '@type': types }, 'LocalBusiness');
    const specific = specificTypeOf(types);
    if (physical || !locationPage) {
      // The entity exists, but the detector's finding is about what it LACKS. "Reuse" is only right when nothing is lacking.
      if (address && ['missing', 'incomplete'].includes(address.existing?.state) && address.state !== 'no_change') {
        return addressDrivenIntent({ base, address, pageEntity, types, physical, specific, pageUrl, reasons, reuseOf });
      }
      reasons.push(`This page already declares ${types.join(' + ')}${pageEntity.id ? ` (${pageEntity.id})` : ''}; ODITO reuses it and does not create another entity.`);
      if (specific) reasons.push(`The specific type ${specific} is kept — it is never downgraded to a generic type.`);
      return { ...base, intent: INTENTS.ALREADY_PRESENT, action: 'reuse', type: specific || (physical ? 'LocalBusiness' : 'Organization'), types: clone(types), id: pageEntity.id || null, existingEntity: true, reuse: reuseOf({ id: pageEntity.id, pageUrl, types }, 'declared on this page') };
    }
    // a plain Organization on a location page: the physical location is the missing piece
    return physicalIntent({ base, pageUrl, organization, site, profile, locationPage, home, existing: { id: pageEntity.id, types, from: 'this page' }, reasons, notes });
  }

  // ── 2. This page has none; it is not a page that needs one ─────────────────
  if (!entityPage) {
    if (siteEntity) {
      reasons.push(`This is a ${pageType || 'general'} page. The site's business entity is already declared on ${siteEntity.pageUrl}, so this page needs no standalone ${siteEntity.physical ? 'LocalBusiness' : 'Organization'} markup.`);
      reasons.push('Other schema on this page (WebPage, Article, BreadcrumbList …) can point to it by @id instead of repeating it.');
      return { ...base, intent: INTENTS.ALREADY_PRESENT, action: 'reference', type: specificTypeOf(siteEntity.types) || (siteEntity.physical ? 'LocalBusiness' : 'Organization'), types: clone(siteEntity.types), id: siteEntity.id || null, reuse: reuseOf(siteEntity, 'declared on another page of this site') };
    }
    reasons.push(`This is a ${pageType || 'general'} page; a business entity belongs on the homepage. The site has none on any crawled page, so the recommendation is for the homepage.`);
  }

  // ── 3. An entity must be created (this page, or the homepage on behalf of the site) ─────────
  return generateIntent({ base, pageUrl, organization, site, profile, locationPage, home, siteEntity, reasons, notes });
}

const ADDRESS_PART_LABEL = { streetAddress: 'street', addressLocality: 'city', addressRegion: 'region', postalCode: 'postal code', addressCountry: 'country' };

/**
 * The page's own entity lacks an address (absent, or published without a street/city). The entity is EXTENDED — same @id,
 * same properties, no second entity — when a verified address exists; otherwise ODITO asks the owner. It never invents one.
 *   ready                    -> action generate (mode extend_existing; finalizeOrganizationIntent computes the exact delta)
 *   conflict / confirmation  -> action needs_input, missing: address  (the owner chooses or types it)
 *   unavailable              -> action needs_input, missing: address
 *   needs_review             -> action needs_input, missing: entity   (several Organization entities: stop and review)
 */
function addressDrivenIntent({ base, address, pageEntity, types, physical, specific, pageUrl, reasons, reuseOf }) {
  const type = specific || (physical ? 'LocalBusiness' : 'Organization');
  const idText = pageEntity.id ? ` (${pageEntity.id})` : '';
  const existingState = address.existing.state;
  const lacking = existingState === 'incomplete'
    ? `it publishes an incomplete address (missing ${address.existing.missing.map((f) => ADDRESS_PART_LABEL[f] || f).join(' and ')})`
    : 'it has no address property';
  reasons.push(`This page already declares ${types.join(' + ')}${idText}, but ${lacking}. That is what the finding is about — the entity is completed, not replaced.`);
  if (specific) reasons.push(`The specific type ${specific} is kept — it is never downgraded to a generic type.`);

  const common = {
    ...base, type, types: clone(types), id: pageEntity.id || null, existingEntity: true, addressDemand: true,
    typeSource: 'existing_markup', optional: [], facts: {},
    reuse: reuseOf({ id: pageEntity.id, pageUrl, types }, 'the existing entity is extended, not duplicated'),
    address: { state: address.state, reason: address.reason || null, existing: existingState },
  };

  if (address.state === 'ready') {
    const p = address.proposal;
    reasons.push(p.status === 'confirmed_by_owner'
      ? 'The address you confirmed in ODITO is used.'
      : `A verified address was found (${p.sources.join(', ').replace(/_/g, ' ')}); it is added to the existing entity with every property it already has.`);
    return { ...common, intent: intentNameFor(type), action: 'generate', mode: 'extend_existing', facts: { address: p.sources[0] } };
  }

  reasons.push(address.message);
  const field = address.state === 'needs_review' ? 'entity' : 'address';
  const label = field === 'entity' ? 'Which Organization entity to change' : 'Business address (street and city)';
  return { ...common, intent: INTENTS.ALREADY_PRESENT, action: 'needs_input', missing: [{ field, label, why: address.message, code: address.reason || address.state, state: address.state }] };
}

function physicalIntent({ base, pageUrl, organization, site, profile, locationPage, home, existing, reasons, notes }) {
  const specific = specificTypeOf(existing.types) || specificTypeOf(site?.primary?.types) || (profile?.trusted ? profile.schemaType : null);
  const type = specific || 'LocalBusiness';
  const facts = collectVerifiedFacts({ organization, site, profile, physical: true });
  reasons.push(`This is a ${locationPage ? 'location' : 'business'} page: it presents a physical place, and the ${existing.from} has only ${existing.types.join(' + ')}.`);
  return finish({ base: { ...base, existingEntity: true }, type, types: dedupeTypes([type, ...existing.types.filter((t) => t !== 'Organization')]), id: existing.id || site?.primary?.id || null, facts, reasons, notes, organization, site, profile, reuse: existing.id ? { id: existing.id, pageUrl, types: existing.types, reason: 'the existing entity is extended, not duplicated' } : null, typeSource: specific ? (profile?.trusted && specific === profile.schemaType ? 'business_profile' : 'existing_markup') : 'location_page' });
}

function generateIntent({ base, pageUrl, organization, site, profile, locationPage, home, siteEntity, reasons, notes }) {
  const siteSpecific = specificTypeOf(siteEntity?.types);
  const gbpType = profile?.trusted ? profile.schemaType : null;
  const physicalEvidence = !!(siteEntity?.physical || site?.place || (profile?.trusted && profile.address));

  let type; let typeSource;
  if (siteSpecific) { type = siteSpecific; typeSource = 'existing_markup'; reasons.push(`The site's own markup already identifies the business as ${siteSpecific} (${siteEntity.pageUrl}); that type is reused.`); }
  else if (gbpType) { type = gbpType; typeSource = 'business_profile'; reasons.push(`The verified Google Business Profile category (${profile.categoryLabel}) maps to schema.org ${gbpType}.`); }
  else if (siteEntity?.physical || locationPage) { type = 'LocalBusiness'; typeSource = siteEntity?.physical ? 'existing_markup' : 'location_page'; reasons.push(siteEntity?.physical ? 'The site\'s existing entity is a physical location, so LocalBusiness is used.' : 'This is a location page: it needs a LocalBusiness (a physical place), which requires a verified address.'); }
  else if (physicalEvidence) { type = 'LocalBusiness'; typeSource = 'verified_address'; reasons.push('The site publishes a verified physical address, so the business is described as a LocalBusiness.'); }
  else { type = 'Organization'; typeSource = 'default'; reasons.push('No verified physical location (address, Place or Business Profile) was found, so a plain Organization is the only claim ODITO can support.'); }

  const physical = type !== 'Organization';
  const facts = collectVerifiedFacts({ organization, site, profile, physical });
  const reuse = siteEntity ? { id: siteEntity.id || null, pageUrl: siteEntity.pageUrl, types: siteEntity.types, reason: 'the site already identifies this entity; its @id and published facts are reused' } : null;
  return finish({ base, type, types: dedupeTypes(siteEntity && siteSpecific ? siteEntity.types : [type]), id: siteEntity?.id || null, facts, reasons, notes, organization, site, profile, reuse, typeSource });
}

const dedupeTypes = (arr) => [...new Set(arr.filter(Boolean))];

function finish({ base, type, types, id, facts, reasons, notes, organization, site, profile, reuse, typeSource }) {
  const physical = type !== 'Organization';
  const name = pickName(organization, site, profile);
  const missing = [];
  if (!name) missing.push({ field: 'name', label: FIELD_LABEL.name, why: 'No business name was found in your markup or Open Graph tags.' });
  if (physical && !facts.address) missing.push({ field: 'address', label: FIELD_LABEL.address, why: `${type === 'LocalBusiness' ? 'A LocalBusiness' : `A ${type}`} is a claim of a physical place. ODITO found no verified address on your site${profile?.trusted ? ' or in your Business Profile' : ''} and will not guess one.` });
  const optional = [];
  if (physical && !facts.telephone) optional.push('telephone');
  if (physical && !facts.openingHoursSpecification && !facts.openingHours) optional.push('opening hours');
  if (organization?.logo?.status === 'none') optional.push('logo URL');
  const intent = intentNameFor(type);
  if (missing.length) reasons.push(`${missing.map((m) => m.label.toLowerCase()).join(' and ')} must be provided before markup can be produced.`);
  return { ...base, intent, action: missing.length ? 'needs_input' : 'generate', type, types, id, reuse, typeSource, missing, optional, facts: summariseFacts(facts), nameSource: name?.source || null };
}

/** Facts without their values' bulk: field -> source. The values themselves are carried on the evidence contact. */
const summariseFacts = (facts) => Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, v.source]));

/** The compact intent the fingerprint, prompt and UI work from. Contains no fact values. */
export function intentFingerprintMaterial(intent) {
  if (!intent) return null;
  return [intent.version, intent.intent, intent.action, intent.type, [...(intent.types || [])].sort(), intent.id, intent.scope, intent.placement, intent.reuse?.pageUrl || null, intent.typeSource || null, (intent.missing || []).map((m) => m.field).sort(), Object.entries(intent.facts || {}).sort(([a], [b]) => (a < b ? -1 : 1))];
}

export default { INTENTS, SCHEMA_INTENT_VERSION, resolveSchemaIntent, collectVerifiedFacts, pickName, specificTypeOf, intentFingerprintMaterial };
