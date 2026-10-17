/**
 * organizationAddress — what ODITO can PROVE about the postal address of the business, where each piece came from, and
 * whether it is safe to put on the Organization entity.
 *
 * The finding this serves is the detector's "Organization schema incomplete - missing recommended fields: address".
 * Before this module nothing could answer it: the recommender only ever looked for an address when it had already decided
 * on a physical LocalBusiness, so a plain Organization that lacked one was told "reuse the existing entity".
 *
 * Everything here is pure (no I/O) and conservative:
 *   - a candidate is a value some source actually holds, with its provenance; nothing is composed from several sources
 *     unless they provably describe the same place;
 *   - an address is publishable only when it is structured AND complete enough (street + locality);
 *   - two usable addresses that differ are a CONFLICT the owner resolves — ODITO never silently picks one;
 *   - a branch (a separate location entity) is not assumed to be the organization's own address;
 *   - an unstructured line (a Google profile's street text, a website-extraction string) is a suggestion, never a fact;
 *   - nothing is invented: missing postal codes, regions and countries stay missing.
 *
 * States of the assessment (`state`):
 *   no_change             the entity already carries a complete address — nothing to add
 *   ready                 one verified address, safe to propose (add / complete)
 *   needs_confirmation    only suggestions exist (partial / unstructured / branch-only / low trust): the owner confirms or types
 *   conflict              two or more usable addresses disagree: the owner chooses
 *   unavailable           nothing found anywhere: the owner types it
 *   needs_review          the entity itself is ambiguous (several Organization entities): ODITO stops and asks for review
 */

import { addressOf, asArray, hasType, typesOf } from './schemaGraph.js';

export const ADDRESS_FIELDS = Object.freeze(['streetAddress', 'addressLocality', 'addressRegion', 'postalCode', 'addressCountry']);
/** The minimum that makes a PostalAddress worth publishing: where on which street/area. Everything else is added only if known. */
export const REQUIRED_FOR_PUBLISH = Object.freeze(['streetAddress', 'addressLocality']);
export const ADDRESS_ASSESSMENT_VERSION = 1;

export const TRUST = Object.freeze({
  USER_CONFIRMED: 'user_confirmed',        // the owner typed/confirmed it in ODITO
  SITE_MARKUP: 'site_markup',              // the site's own published JSON-LD
  VERIFIED_INTEGRATION: 'verified_integration', // an authorised integration verified to belong to THIS website
  OWNER_PROVIDED: 'owner_provided',        // entered by the owner elsewhere in ODITO (structured)
  UNVERIFIED: 'unverified',                // extracted text, another site's listing, unstructured lines
});
const TRUST_RANK = { [TRUST.USER_CONFIRMED]: 5, [TRUST.SITE_MARKUP]: 4, [TRUST.VERIFIED_INTEGRATION]: 3, [TRUST.OWNER_PROVIDED]: 3, [TRUST.UNVERIFIED]: 1 };
export const isTrusted = (trust) => (TRUST_RANK[trust] || 0) >= 3;

export const SOURCE_LABEL = Object.freeze({
  user_confirmed: 'confirmed by you in ODITO',
  page_entity_markup: "this page's Organization markup",
  page_place_markup: "a Place on this page's markup",
  site_entity_markup: "the site's Organization markup on another page",
  site_place_markup: "the site's Place markup",
  site_location_entity: 'a separate location entity published on your site',
  google_business_profile: 'your connected Google Business Profile',
  verified_business: "the business you selected when creating this project (Google Places)",
  owner_profile: 'the business details you entered in ODITO (Social Media profile)',
  website_extraction: "text extracted from your website when the project was created",
});

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/g;
const MAX_FIELD = 200;

const text = (v) => {
  if (v == null) return null;
  const raw = Array.isArray(v) ? v.filter((x) => typeof x === 'string').join(', ') : typeof v === 'number' ? String(v) : v;
  if (typeof raw !== 'string') return null;
  const t = raw.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, MAX_FIELD) : null;
};

const countryText = (v) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return text(v.name || v.identifier || null);
  return text(v);
};

/** Fields that came from a structured source, in canonical order. Missing parts stay missing. */
export function pickAddressFields(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  const street = text(raw.streetAddress); if (street) out.streetAddress = street;
  const locality = text(raw.addressLocality); if (locality) out.addressLocality = locality;
  const region = text(raw.addressRegion); if (region) out.addressRegion = region;
  const postal = text(raw.postalCode); if (postal) out.postalCode = postal;
  const country = countryText(raw.addressCountry); if (country) out.addressCountry = country;
  return out;
}

/**
 * The exact form an address travels in to and from the Bridge: the five keys in a fixed order, values trimmed (and NOT otherwise
 * rewritten), empty ones omitted. It mirrors the Bridge's Security::canonical_address(), so an address compares equal on both
 * sides exactly when it would publish the same PostalAddress. Accepts an object (or anything else, which yields {}).
 */
export function wireAddress(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const f of ADDRESS_FIELDS) {
    const v = raw[f];
    if ((typeof v === 'string' || typeof v === 'number') && String(v).trim()) out[f] = String(v).trim();
  }
  return out;
}

/** `value` / `expected` for the Bridge: canonical JSON, or '' for "no address". */
export const addressToWire = (raw) => {
  const a = wireAddress(raw);
  return Object.keys(a).length ? JSON.stringify(a) : '';
};

/** The inverse, for display and comparison; {} when the string is empty or not an address. */
export function addressFromWire(text) {
  if (typeof text !== 'string' || !text.trim()) return {};
  try { return wireAddress(JSON.parse(text)); } catch { return {}; }
}

export const formatAddress = (fields) => ADDRESS_FIELDS.map((f) => fields?.[f]).filter(Boolean).join(', ');
export const missingRequired = (fields) => REQUIRED_FOR_PUBLISH.filter((f) => !fields?.[f]);

/**
 * schema.org `address` (object | string | array) -> { fields, formatted, structured, complete, missing } | null.
 * A string is kept verbatim as `formatted` and is NOT split into parts: that would be a guess.
 */
export function normalizePostalAddress(raw) {
  const value = Array.isArray(raw) ? raw.find((x) => x != null && x !== '') : raw;
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    const formatted = text(value);
    return formatted ? { fields: {}, formatted, structured: false, complete: false, missing: [...REQUIRED_FOR_PUBLISH] } : null;
  }
  const fields = pickAddressFields(value);
  if (!Object.keys(fields).length) return null;
  const missing = missingRequired(fields);
  return { fields, formatted: formatAddress(fields), structured: true, complete: missing.length === 0, missing };
}

// ── Comparison ────────────────────────────────────────────────────────────────
const ABBREVIATIONS = [[/\bstreet\b/g, 'st'], [/\broad\b/g, 'rd'], [/\bavenue\b/g, 'ave'], [/\bboulevard\b/g, 'blvd'], [/\blane\b/g, 'ln'], [/\bdrive\b/g, 'dr'], [/\bnear\b/g, 'nr'], [/\bopposite\b/g, 'opp']];
const COUNTRY_ALIASES = {
  in: 'in', india: 'in', bharat: 'in', ind: 'in',
  us: 'us', usa: 'us', 'united states': 'us', 'united states of america': 'us',
  gb: 'gb', uk: 'gb', 'united kingdom': 'gb', 'great britain': 'gb',
  ca: 'ca', canada: 'ca', au: 'au', australia: 'au', ae: 'ae', uae: 'ae', 'united arab emirates': 'ae', sg: 'sg', singapore: 'sg',
  de: 'de', germany: 'de', fr: 'fr', france: 'fr', nz: 'nz', 'new zealand': 'nz', za: 'za', 'south africa': 'za',
};

const plain = (s) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function comparable(field, value) {
  if (value == null || value === '') return '';
  if (field === 'postalCode') return String(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const p = plain(value);
  if (field === 'addressCountry') return COUNTRY_ALIASES[p] || p;
  if (field === 'streetAddress') return ABBREVIATIONS.reduce((acc, [re, to]) => acc.replace(re, to), p);
  return p;
}

/** @returns {{overlap: string[], conflicts: string[]}} fields present in BOTH, and the ones among them that differ */
export function compareFields(a, b) {
  const overlap = []; const conflicts = [];
  for (const f of ADDRESS_FIELDS) {
    if (!a?.[f] || !b?.[f]) continue;
    overlap.push(f);
    if (comparable(f, a[f]) !== comparable(f, b[f])) conflicts.push(f);
  }
  return { overlap, conflicts };
}

/** Same place, provably: nothing differs and they agree on the street or the postal code (not merely on the city). */
export function sameLocation(a, b) {
  const { overlap, conflicts } = compareFields(a, b);
  return conflicts.length === 0 && (overlap.includes('streetAddress') || overlap.includes('postalCode'));
}

/** Compatible enough for the weaker one to complete the stronger one: nothing differs and they agree on the city or postal code. */
function canComplete(strong, weak) {
  const { overlap, conflicts } = compareFields(strong, weak);
  return conflicts.length === 0 && (overlap.includes('addressLocality') || overlap.includes('postalCode') || overlap.includes('streetAddress'));
}

// ── Candidates ────────────────────────────────────────────────────────────────
let seq = 0;
const makeCandidate = ({ source, trust, kind, address, nodeId = null, nodeTypes = null, pageUrl = null, detail = null, note = null }) => {
  const n = normalizePostalAddress(address);
  if (!n) return null;
  seq += 1;
  return {
    id: `addr_${seq}`,
    source, sourceLabel: SOURCE_LABEL[source] || source, trust, kind,
    fields: n.fields, formatted: n.formatted, structured: n.structured, complete: n.complete, missing: n.missing,
    nodeId, nodeTypes, pageUrl, detail, note,
  };
};
export const resetCandidateIds = () => { seq = 0; };

const hostOf = (url) => { try { return new URL(/^https?:/i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./i, '').toLowerCase(); } catch { return null; } };

/**
 * @param {object} p
 * @param {object[]} p.pageNodes   flattened JSON-LD nodes of the audited page
 * @param {object|null} p.primary  the page's own Organization node
 * @param {object|null} p.site     analyzeSiteEntity() (with addressNodes)
 * @param {object|null} p.profile  normalizeBusinessProfile()
 * @param {object|null} p.project  { siteUrl, verifiedBusiness, contactInfo }  (SeoProject, plain)
 * @param {object|null} p.owner    SocialBusinessProfile.overrides
 * @param {object|null} p.confirmed  the owner-confirmed address document
 */
export function collectAddressCandidates({ pageNodes = [], primary = null, site = null, profile = null, project = null, owner = null, confirmed = null } = {}) {
  resetCandidateIds();
  const out = [];
  const push = (c) => { if (c) out.push(c); };

  if (confirmed?.fields && Object.keys(pickAddressFields(confirmed.fields)).length) {
    push(makeCandidate({ source: 'user_confirmed', trust: TRUST.USER_CONFIRMED, kind: 'confirmed', address: confirmed.fields, detail: confirmed.confirmedAt ? `confirmed ${new Date(confirmed.confirmedAt).toISOString().slice(0, 10)}` : null }));
  }

  // 1. This page's own markup: nodes other than the Organization itself that carry an address.
  //    A Place counts only when the entity points at it (`location: {"@id": …}`): an unlinked Place is usually an
  //    event venue or a listing, and its address is not the organization's.
  const locationRef = primary?.location && typeof primary.location === 'object' && !Array.isArray(primary.location) ? primary.location['@id'] : null;
  for (const node of pageNodes) {
    if (!node || node === primary || !addressOf(node)) continue;
    const id = typeof node['@id'] === 'string' ? node['@id'] : null;
    const types = typesOf(node);
    if (hasType(node, 'LocalBusiness') || hasType(node, 'Organization')) {
      // another business entity on the page: a separate location, not assumed to be the organization's own address
      push(makeCandidate({ source: 'site_location_entity', trust: TRUST.SITE_MARKUP, kind: 'branch', address: node.address, nodeId: id, nodeTypes: types }));
    } else if (types.includes('Place') && id && locationRef === id) {
      push(makeCandidate({ source: 'page_place_markup', trust: TRUST.SITE_MARKUP, kind: 'place', address: node.address, nodeId: id, nodeTypes: types }));
    }
  }

  // 2. The site's own markup on other pages (homepage entity, linked Place, location pages).
  for (const entry of site?.addressNodes || []) {
    const isPrimaryEntity = !!entry.isPrimary;
    push(makeCandidate({
      source: isPrimaryEntity ? 'site_entity_markup' : entry.isPlace ? 'site_place_markup' : 'site_location_entity',
      trust: TRUST.SITE_MARKUP,
      kind: isPrimaryEntity || entry.linkedFromPrimary ? 'organization' : entry.isPlace ? 'place' : 'branch',
      address: entry.address, nodeId: entry.id || null, nodeTypes: entry.types || null, pageUrl: entry.pageUrl || null,
    }));
  }

  // 3. A Google Business Profile that was verified to belong to THIS website. Its address is street lines only.
  if (profile?.available && profile.address) {
    push(makeCandidate({
      source: 'google_business_profile', trust: profile.trusted ? TRUST.VERIFIED_INTEGRATION : TRUST.UNVERIFIED, kind: 'external',
      address: profile.address, detail: profile.trusted ? null : `not used as evidence: ${String(profile.reason || 'unverified').replace(/_/g, ' ')}`,
      note: 'Google stores this as street lines only — city, region and postal code are not part of it.',
    }));
  }

  // 4. Business details stored in ODITO.
  const vb = project?.verifiedBusiness;
  if (vb && (vb.address || vb.city)) {
    const siteHost = hostOf(project?.siteUrl);
    const vbHost = vb.website ? hostOf(vb.website) : null;
    const sameWebsite = !!(siteHost && vbHost && siteHost === vbHost);
    push(makeCandidate({
      source: 'verified_business',
      trust: sameWebsite ? TRUST.VERIFIED_INTEGRATION : TRUST.UNVERIFIED,
      kind: 'external',
      // Places gives a formatted line plus separate city/state/country. The street is NOT split out of the line (that would
      // be a guess), so this candidate has no street and can never be published on its own.
      address: (vb.city || vb.state || vb.country || vb.countryCode) ? { addressLocality: vb.city, addressRegion: vb.state, addressCountry: vb.countryCode || vb.country } : vb.address,
      detail: sameWebsite ? null : (vb.website ? 'its website is a different site' : 'it lists no website, so it cannot be tied to this one'),
      note: vb.address ? `Formatted as: ${vb.address}` : null,
    }));
  }
  const ci = project?.contactInfo?.address;
  if (typeof ci === 'string' && ci.trim()) {
    push(makeCandidate({ source: 'website_extraction', trust: TRUST.UNVERIFIED, kind: 'external', address: ci, note: 'Extracted as free text, not structured markup.' }));
  }
  if (owner && (owner.address || owner.city || owner.postalCode)) {
    push(makeCandidate({
      source: 'owner_profile', trust: TRUST.OWNER_PROVIDED, kind: 'external',
      address: { streetAddress: owner.address, addressLocality: owner.city, addressRegion: owner.region, postalCode: owner.postalCode, addressCountry: owner.country },
    }));
  }
  return out;
}

// ── Assessment ────────────────────────────────────────────────────────────────

/** The state of the address on the entity this finding is about. */
export function existingAddressState(primary) {
  if (!primary) return { state: 'no_entity', normalized: null };
  const raw = primary.address;
  const empty = raw == null || raw === '' || (Array.isArray(raw) && !raw.length) || (typeof raw === 'object' && !Array.isArray(raw) && !Object.values(raw).some((v) => v != null && v !== '' && !(typeof v === 'string' && v.startsWith('@'))));
  if (empty) return { state: 'missing', normalized: null };
  const normalized = normalizePostalAddress(raw);
  if (!normalized) return { state: 'missing', normalized: null };
  if (!normalized.structured) return { state: 'present_text', normalized };
  return { state: normalized.complete ? 'present_complete' : 'incomplete', normalized };
}

const bestTrust = (cands) => cands.reduce((m, c) => (TRUST_RANK[c.trust] > (TRUST_RANK[m] || 0) ? c.trust : m), TRUST.UNVERIFIED);

function mergeCluster(members) {
  // Highest trust first; a lower-trust member may only fill a field the higher-trust ones lack.
  const ordered = [...members].sort((a, b) => TRUST_RANK[b.trust] - TRUST_RANK[a.trust]);
  const fields = {}; const fieldSources = {};
  for (const c of ordered) {
    for (const f of ADDRESS_FIELDS) {
      if (c.fields[f] && !fields[f]) { fields[f] = c.fields[f]; fieldSources[f] = c.source; }
    }
  }
  return { fields, fieldSources };
}

/** Groups strong (structured + complete + trusted) candidates that are provably the same place; weak ones that fit are folded in. */
function clusterCandidates(candidates) {
  const strong = candidates.filter((c) => c.structured && c.complete && isTrusted(c.trust));
  const clusters = [];
  for (const c of strong) {
    const home = clusters.find((cl) => cl.members.some((m) => sameLocation(m.fields, c.fields)));
    if (home) home.members.push(c); else clusters.push({ members: [c] });
  }
  // A "strong" pair that merely shares a city but differs elsewhere stays in separate clusters (that is what a conflict is).
  const weak = candidates.filter((c) => !strong.includes(c) && c.structured && isTrusted(c.trust) && Object.keys(c.fields).length);
  for (const w of weak) {
    const fitting = clusters.filter((cl) => canComplete(mergeCluster(cl.members).fields, w.fields));
    if (fitting.length === 1) fitting[0].members.push(w);
  }
  return clusters.map((cl) => ({ ...cl, ...mergeCluster(cl.members), trust: bestTrust(cl.members), kinds: [...new Set(cl.members.map((m) => m.kind))] }));
}

const toNode = (fields) => ({ '@type': 'PostalAddress', ...Object.fromEntries(ADDRESS_FIELDS.filter((f) => fields[f]).map((f) => [f, fields[f]])) });
export { toNode as toPostalAddressNode };

// Only a cluster made up purely of separate location entities (branches) is withheld; anything also backed by the entity's own
// markup, its linked Place, the owner or the owner's business listing is the organization's own location.
const isOwnLocationKind = (kinds) => kinds.some((k) => k !== 'branch');

/**
 * @param {object} p
 * @param {object|null} p.primary     the page's own Organization node (null = this page has no entity)
 * @param {object[]} p.candidates     collectAddressCandidates()
 * @param {{conflictingEntities?: *, duplicateIds?: *[], entityCount?: number}} [p.entityHealth]
 * @returns {object} see the module doc
 */
export function assessOrganizationAddress({ primary, candidates = [], entityHealth = {} }) {
  const existing = existingAddressState(primary);
  const notes = [];
  const base = {
    version: ADDRESS_ASSESSMENT_VERSION,
    existing: { state: existing.state, fields: existing.normalized?.fields || {}, formatted: existing.normalized?.formatted || null, missing: existing.normalized?.missing || [] },
    candidates, proposal: null, alternatives: [], suggestion: null, notes,
  };

  const entityAmbiguous = !!(entityHealth.conflictingEntities || (entityHealth.duplicateIds || []).length);
  if (entityAmbiguous) {
    return { ...base, state: 'needs_review', reason: 'ENTITY_AMBIGUOUS', message: 'This page describes the organization more than once, so ODITO cannot tell which entity the address belongs to. Resolve the duplicate first.' };
  }
  if (existing.state === 'no_entity') {
    return { ...base, state: 'no_change', reason: 'NO_ENTITY', message: 'This page carries no Organization entity of its own, so there is nothing to add an address to.' };
  }

  const confirmed = candidates.find((c) => c.trust === TRUST.USER_CONFIRMED && c.structured && c.complete);
  const clusters = clusterCandidates(candidates);

  // What the entity already holds is never overwritten by this finding; a different verified address is only reported.
  if (existing.state === 'present_complete' || existing.state === 'present_text') {
    const differing = clusters.filter((cl) => compareFields(existing.normalized.fields, cl.fields).conflicts.length > 0);
    if (differing.length && existing.state === 'present_complete') {
      notes.push(`The address on the entity (${existing.normalized.formatted}) differs from ${differing.map((d) => formatAddress(d.fields)).join(' / ')}. ODITO does not overwrite an address that is already published; review which one is correct.`);
    }
    return { ...base, state: 'no_change', reason: existing.state === 'present_complete' ? 'ADDRESS_PRESENT' : 'ADDRESS_PRESENT_AS_TEXT', message: existing.state === 'present_complete' ? 'The entity already carries a complete address.' : 'The entity already carries an address as plain text.' };
  }

  const existingFields = existing.normalized?.fields || {};   // incomplete: parts we must keep
  let usable = clusters;
  if (existing.state === 'incomplete') usable = clusters.filter((cl) => compareFields(existingFields, cl.fields).conflicts.length === 0);
  if (existing.state === 'incomplete' && usable.length < clusters.length) notes.push('Some candidates were ignored because they contradict the address parts the entity already has.');

  const toProposal = (cl, status) => {
    const merged = { ...cl.fields };
    const fieldSources = { ...cl.fieldSources };
    for (const f of ADDRESS_FIELDS) if (existingFields[f]) { merged[f] = existingFields[f]; fieldSources[f] = 'page_entity_markup'; }   // existing parts are kept as they are
    return {
      property: 'address', fields: merged, value: toNode(merged), formatted: formatAddress(merged), fieldSources,
      sources: [...new Set(cl.members.map((m) => m.source))], trust: cl.trust, status,
      confidence: cl.trust === TRUST.USER_CONFIRMED || cl.trust === TRUST.SITE_MARKUP ? 'high' : 'medium',
      completes: existing.state === 'incomplete' ? ADDRESS_FIELDS.filter((f) => !existingFields[f] && merged[f]) : null,
      candidateIds: cl.members.map((m) => m.id),
    };
  };

  // The owner's own confirmation settles it, even when other sources differ (they are listed as informational).
  if (confirmed) {
    const others = usable.filter((cl) => !cl.members.includes(confirmed) && !sameLocation(cl.fields, confirmed.fields));
    if (others.length) notes.push(`Other sources hold different addresses (${others.map((o) => formatAddress(o.fields)).join(' / ')}); the address you confirmed is used.`);
    if (existing.state === 'incomplete' && compareFields(existingFields, confirmed.fields).conflicts.length) {
      return { ...base, state: 'needs_confirmation', reason: 'CONFIRMED_CONTRADICTS_EXISTING', suggestion: { fields: confirmed.fields, formatted: confirmed.formatted, sources: [confirmed.source], kinds: ['confirmed'] }, message: 'The address you confirmed contradicts the address parts the entity already has. Review which is correct.' };
    }
    const cluster = { members: [confirmed], ...mergeCluster([confirmed]), trust: TRUST.USER_CONFIRMED, kinds: ['confirmed'] };
    return { ...base, state: 'ready', reason: 'CONFIRMED_BY_OWNER', proposal: toProposal(cluster, 'confirmed_by_owner'), message: 'The address you confirmed will be added to the existing entity.' };
  }

  const describe = (cl) => ({ fields: cl.fields, formatted: formatAddress(cl.fields), sources: [...new Set(cl.members.map((m) => m.source))], trust: cl.trust, kinds: cl.kinds, candidateIds: cl.members.map((m) => m.id) });

  // Headquarters vs branches: the organization's own address is the one its own entity (or the Place it points at) or the owner
  // supplies. A separate location entity (a branch) with a different address is reported, never used in its place.
  const own = usable.filter((cl) => isOwnLocationKind(cl.kinds));
  const branches = usable.filter((cl) => !isOwnLocationKind(cl.kinds));
  if (own.length === 1 && branches.length) {
    notes.push(`${branches.length === 1 ? 'A separate location' : `${branches.length} separate locations`} on your site (${branches.map((b) => formatAddress(b.fields)).join(' / ')}) ${branches.length === 1 ? 'has' : 'have'} a different address. ${branches.length === 1 ? 'It is' : 'They are'} treated as branch${branches.length === 1 ? '' : 'es'} and not used as the organization's address.`);
    usable = own;
  }
  if (usable.length > 1) {
    return {
      ...base, state: 'conflict', reason: 'CONFLICTING_ADDRESSES',
      alternatives: usable.map(describe),
      message: `${usable.length} different addresses were found. ODITO will not choose between them — confirm which one is the organization's address.`,
    };
  }
  if (usable.length === 1) {
    const only = usable[0];
    // A separate location entity is a branch: its address is not automatically the organization's.
    if (!isOwnLocationKind(only.kinds)) {
      notes.push('This address belongs to a separate location entity (a branch) on your site, so it is not assumed to be the organization\'s own address.');
      return { ...base, state: 'needs_confirmation', reason: 'BRANCH_ONLY', suggestion: { fields: only.fields, formatted: formatAddress(only.fields), sources: [...new Set(only.members.map((m) => m.source))], kinds: only.kinds }, message: 'Only a branch address was found. Confirm whether it is also the organization\'s address, or enter the headquarters address.' };
    }
    return { ...base, state: 'ready', reason: existing.state === 'incomplete' ? 'COMPLETES_EXISTING_ADDRESS' : 'VERIFIED_ADDRESS_FOUND', proposal: toProposal(only, 'verified'), message: 'One verified address was found.' };
  }

  // No usable cluster: offer what exists as a suggestion (never as a fact).
  const suggestible = candidates.filter((c) => Object.keys(c.fields).length || c.formatted);
  if (suggestible.length) {
    const best = [...suggestible].sort((a, b) => (Object.keys(b.fields).length - Object.keys(a.fields).length) || (TRUST_RANK[b.trust] - TRUST_RANK[a.trust]))[0];
    return {
      ...base, state: 'needs_confirmation', reason: 'NO_COMPLETE_VERIFIED_ADDRESS',
      suggestion: { fields: best.fields, formatted: best.formatted, sources: [best.source], kinds: [best.kind], partial: true },
      message: 'Addresses were found, but none is complete and verified enough to publish (a street and a city are needed). Check the suggestion and confirm the full address.',
    };
  }
  return { ...base, state: 'unavailable', reason: 'NO_ADDRESS_FOUND', message: 'No address was found on your site, in your business profile or in the business details stored in ODITO. Enter the address so ODITO can add it.' };
}

/** The compact, browser-safe view of the assessment (no raw nodes). */
export function summarizeAddressAssessment(a) {
  if (!a) return null;
  return {
    version: a.version, state: a.state, reason: a.reason || null, message: a.message || null,
    existing: a.existing,
    proposal: a.proposal ? { fields: a.proposal.fields, value: a.proposal.value, formatted: a.proposal.formatted, fieldSources: a.proposal.fieldSources, sources: a.proposal.sources, trust: a.proposal.trust, status: a.proposal.status, confidence: a.proposal.confidence, completes: a.proposal.completes } : null,
    alternatives: a.alternatives.map((x) => ({ fields: x.fields, formatted: x.formatted, sources: x.sources, trust: x.trust, kinds: x.kinds })),
    suggestion: a.suggestion ? { fields: a.suggestion.fields, formatted: a.suggestion.formatted, sources: a.suggestion.sources, kinds: a.suggestion.kinds, partial: !!a.suggestion.partial } : null,
    candidates: a.candidates.map((c) => ({ id: c.id, source: c.source, sourceLabel: c.sourceLabel, trust: c.trust, kind: c.kind, fields: c.fields, formatted: c.formatted, structured: c.structured, complete: c.complete, missing: c.missing, pageUrl: c.pageUrl, detail: c.detail, note: c.note })),
    notes: a.notes,
  };
}

// ── Owner input ───────────────────────────────────────────────────────────────

const POSTAL_RE = /^[A-Za-z0-9][A-Za-z0-9 -]{1,18}[A-Za-z0-9]$/;
const BAD_CHARS = /[<>{}\[\]\\`]/;
const fail = (field, message) => Object.assign(new Error(message), { code: 'VALIDATION_ERROR', field });

/**
 * Validates an address the owner typed or confirmed. Only the five PostalAddress fields are accepted; anything else is ignored.
 * Street and city are required (see REQUIRED_FOR_PUBLISH); nothing is guessed to fill the rest.
 * @returns {{fields: object}} trimmed, canonical-order fields
 */
export function validateConfirmedAddressInput(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const out = {};
  const take = (field, label, { required = false, min = 1, max = MAX_FIELD } = {}) => {
    const raw = input[field];
    if (raw == null || raw === '') { if (required) throw fail(field, `${label} is required`); return; }
    if (typeof raw !== 'string') throw fail(field, `${label} must be text`);
    const t = raw.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
    if (!t) { if (required) throw fail(field, `${label} is required`); return; }
    if (BAD_CHARS.test(t)) throw fail(field, `${label} contains characters that are not allowed`);
    if (t.length < min) throw fail(field, `${label} is too short`);
    if (t.length > max) throw fail(field, `${label} must be ${max} characters or fewer`);
    out[field] = t;
  };
  take('streetAddress', 'Street address', { required: true, min: 4, max: 200 });
  take('addressLocality', 'City / locality', { required: true, min: 2, max: 100 });
  take('addressRegion', 'State / region', { max: 100 });
  take('postalCode', 'Postal code', { max: 20 });
  if (out.postalCode && !POSTAL_RE.test(out.postalCode)) throw fail('postalCode', 'Postal code may contain only letters, digits, spaces and hyphens');
  take('addressCountry', 'Country', { max: 60 });
  return { fields: Object.fromEntries(ADDRESS_FIELDS.filter((f) => out[f]).map((f) => [f, out[f]])) };
}

export default {
  ADDRESS_FIELDS, REQUIRED_FOR_PUBLISH, TRUST, SOURCE_LABEL, normalizePostalAddress, collectAddressCandidates, assessOrganizationAddress,
  summarizeAddressAssessment, validateConfirmedAddressInput, compareFields, sameLocation, comparable, toPostalAddressNode: toNode,
};
