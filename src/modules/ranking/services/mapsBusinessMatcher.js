/**
 * Google Maps listing -> tracked business identity matching. Pure functions, no I/O.
 *
 * Three separate questions, never conflated:
 *   brand    Do the names share a chain / brand?            ("ASG Krishna Eye Centre" vs "ASG Mumbai Eye Care": yes)
 *   business Is it the same business / legal entity?        (exact website domain, or a distinctive name match)
 *   branch   Is it THIS location of that business?          (Google place_id, address, coordinates)
 *
 * A Maps rank is branch-specific, so only a branch-level match (or, when neither side has any branch data, a UNIQUE
 * business-level match) is accepted. Sharing a brand is never enough, and a chain-wide website domain proves the
 * business, not the branch. Missing identifiers are never invented: a signal that cannot be computed is `null`, not 0.
 */

// Words that appear in almost every name of a category ("eye hospital", "dental clinic") or are legal-form noise.
// They are removed before comparing names so that a shared "Eye Hospital" is not mistaken for a shared identity.
const GENERIC_NAME_WORDS = new Set([
  'the', 'an', 'a', 'and', 'of', 'at', 'in', 'by', 'for', 'dr', 'doctor', 'drs',
  'pvt', 'ltd', 'private', 'limited', 'llp', 'llc', 'inc', 'corp', 'corporation', 'co', 'company', 'plc', 'gmbh',
  'eye', 'centre', 'center', 'hospital', 'clinic', 'care', 'institute', 'research', 'medical', 'health', 'healthcare',
  'services', 'service', 'group', 'branch', 'office',
]);

// Address words that carry no identity (type of street / building, direction words).
const GENERIC_ADDRESS_WORDS = new Set([
  'road', 'rd', 'street', 'st', 'lane', 'ln', 'avenue', 'ave', 'floor', 'flr', 'near', 'nearby', 'opposite', 'opp', 'above',
  'below', 'behind', 'beside', 'next', 'building', 'bldg', 'shop', 'unit', 'suite', 'ste', 'plot', 'the', 'and', 'off',
  'marg', 'nagar', 'no', 'num', 'number', 'block', 'sector', 'phase', 'main', 'cross', 'china',
]);

// Branch confirmed / rejected thresholds.
export const GEO_SAME_PLACE_M = 150;
export const GEO_DIFFERENT_PLACE_M = 1000;
const ADDRESS_STRONG_JACCARD = 0.5;
// Low on purpose: Places-formatted and Maps-formatted versions of ONE address overlap only partly, and a false "other
// branch" verdict costs a real rank. A differing postal code is the stronger conflict signal.
const ADDRESS_CONFLICT_JACCARD = 0.2;
const NAME_BUSINESS_JACCARD = 0.5;

export const MATCH_LEVEL = Object.freeze({ BRANCH: 'branch', BUSINESS: 'business' });

// ── normalisation ───────────────────────────────────────────────────────────

function ascii(s) {
  return String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Lower-case hostname without scheme, "www." or path. null when there is nothing usable. */
export function normalizeDomain(raw) {
  const s = ascii(raw).trim();
  if (!s) return null;
  const host = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0].replace(/\.$/, '');
  return host.includes('.') ? host : null;
}

function tokens(s, stop) {
  return ascii(s).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length > 1 && !stop.has(t));
}

/** Distinctive name tokens for one name; "A | B" style titles are compared segment-wise by the caller. */
export function nameTokens(name) {
  return new Set(tokens(name, GENERIC_NAME_WORDS));
}

function fullNameKey(name) {
  return ascii(name).replace(/\b(pvt|ltd|private|limited|llp|llc|inc)\b/g, ' ').replace(/[^a-z0-9]/g, '');
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

function containsAll(superset, subset) {
  if (!subset.size) return false;
  for (const t of subset) if (!superset.has(t)) return false;
  return true;
}

// ── signals ────────────────────────────────────────────────────────────────

/**
 * Name signal. Titles like "ASG Krishna Eye Centre | An ASG Eye Hospital" carry the branch name before the "|" and
 * the brand after it, so every segment of both names is compared and the best segment pair wins.
 *   exact      normalised full names are identical
 *   business   distinctive tokens of the target are all present AND overlap is at least NAME_BUSINESS_JACCARD
 *   brand      some distinctive token is shared (a chain), nothing more
 */
export function compareNames(expected, actual) {
  const exp = String(expected ?? ''), act = String(actual ?? '');
  if (!exp.trim() || !act.trim()) return { score: 0, exact: false, business: false, brand: false };

  const exact = fullNameKey(exp) === fullNameKey(act);
  const expSegments = exp.split('|').map(s => s.trim()).filter(Boolean);
  const actSegments = act.split('|').map(s => s.trim()).filter(Boolean);

  let best = 0, business = false, brand = false;
  for (const e of expSegments) {
    const te = nameTokens(e);
    for (const a of actSegments) {
      const ta = nameTokens(a);
      const j = jaccard(te, ta);
      if (j > best) best = j;
      if (j > 0) brand = true;
      if (containsAll(ta, te) && j >= NAME_BUSINESS_JACCARD) business = true;
    }
  }
  // The target's FIRST segment is its own name; require that one specifically (not just its brand tagline) to be present,
  // so "ASG Krishna Eye Centre | An ASG Eye Hospital" does not business-match "ASG Mumbai Eye Care | An ASG Eye Hospital"
  // merely because the tagline segments are identical.
  const ownTokens = nameTokens(expSegments[0] ?? '');
  const actAll = new Set(actSegments.flatMap(s => [...nameTokens(s)]));
  if (business && ownTokens.size) business = containsAll(actAll, ownTokens);

  return { score: exact ? 100 : Math.round(best * 100), exact, business: exact || business, brand: exact || brand };
}

/** Postal / ZIP codes found in free text (5-6 digit runs; ZIP+4 and spaced UK-style codes are not attempted). */
function postalCodes(address) {
  return new Set((String(address ?? '').match(/\b\d{5,6}\b/g) ?? []));
}

/**
 * Address signal. null when either side has no address (never a fabricated 0).
 *   strong    same postal code (when both have one) and enough shared street/locality tokens, or very high token overlap
 *   conflict  both have a postal code and they differ, or overlap is very low
 */
export function compareAddresses(expected, actual) {
  if (!String(expected ?? '').trim() || !String(actual ?? '').trim()) return null;
  const te = new Set(tokens(expected, GENERIC_ADDRESS_WORDS).filter(t => !/^\d{5,6}$/.test(t)));
  const ta = new Set(tokens(actual,   GENERIC_ADDRESS_WORDS).filter(t => !/^\d{5,6}$/.test(t)));
  const pe = postalCodes(expected), pa = postalCodes(actual);
  const bothPostal = pe.size > 0 && pa.size > 0;
  const samePostal = bothPostal && [...pe].some(p => pa.has(p));
  const j = jaccard(te, ta);

  const strong = (samePostal && j >= 0.25) || j >= ADDRESS_STRONG_JACCARD;
  const conflict = !strong && ((bothPostal && !samePostal) || j < ADDRESS_CONFLICT_JACCARD);
  return { score: Math.round(j * 100), samePostal: bothPostal ? samePostal : null, strong, conflict };
}

function toNum(v) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

/** Metres between two coordinates, or null when either point is missing / invalid. */
export function distanceMeters(a, b) {
  const lat1 = toNum(a?.lat), lng1 = toNum(a?.lng), lat2 = toNum(b?.lat), lng2 = toNum(b?.lng);
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return null;
  if (Math.abs(lat1) > 90 || Math.abs(lat2) > 90 || Math.abs(lng1) > 180 || Math.abs(lng2) > 180) return null;
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}

// ── identity + candidate evaluation ─────────────────────────────────────────

/**
 * Normalise whatever the caller knows about the tracked business. Only fields that are really present are kept;
 * nothing is derived or defaulted. Accepts the legacy (businessName, targetDomain) shape too.
 */
export function buildBusinessIdentity({ name, placeId, website, domain, address, lat, lng } = {}) {
  const coords = (toNum(lat) != null && toNum(lng) != null) ? { lat: toNum(lat), lng: toNum(lng) } : null;
  return {
    name:    String(name ?? '').trim() || null,
    placeId: String(placeId ?? '').trim() || null,
    domain:  normalizeDomain(domain || website),
    address: String(address ?? '').trim() || null,
    coords,
  };
}

function itemCoords(item) {
  const lat = toNum(item?.latitude ?? item?.gps_coordinates?.latitude ?? item?.location?.lat);
  const lng = toNum(item?.longitude ?? item?.gps_coordinates?.longitude ?? item?.location?.lng);
  return lat != null && lng != null ? { lat, lng } : null;
}

function itemAddress(item) {
  return item?.address ?? item?.address_info?.address ?? null;
}

/**
 * Evaluate ONE Maps item against the identity.
 * @returns {{ verdict: 'branch'|'business'|'different_branch'|'no_match', confidence: number, basis: string[], signals: object }}
 *   branch            same business AND same location: safe to use for a branch-specific rank
 *   business          same business, nothing available to confirm the location (needs a uniqueness check by the caller)
 *   different_branch  same business / brand, but evidence says it is another location
 *   no_match          unrelated
 */
export function evaluateCandidate(identity, item) {
  const title = item?.title ?? '';
  const name  = compareNames(identity.name, title);
  const itemDomain = normalizeDomain(item?.domain || item?.url);
  const domainExact = identity.domain && itemDomain ? identity.domain === itemDomain : null;
  const itemPlaceId = String(item?.place_id ?? '').trim() || null;
  const placeIdEqual = identity.placeId && itemPlaceId ? identity.placeId === itemPlaceId : null;
  const meters = distanceMeters(identity.coords, itemCoords(item));
  const addr   = compareAddresses(identity.address, itemAddress(item));

  const signals = {
    nameScore: name.score, nameExact: name.exact, nameBusiness: name.business, brandShared: name.brand,
    domainExact, placeIdEqual, distanceMeters: meters, addressScore: addr?.score ?? null, addressStrong: addr?.strong ?? null,
  };
  const basis = [];

  if (placeIdEqual === true) {
    return { verdict: 'branch', confidence: 100, basis: ['place_id'], signals };
  }

  const businessLevel = name.exact || name.business || (domainExact === true && name.brand);
  const geoSame      = meters != null && meters <= GEO_SAME_PLACE_M;
  const geoDifferent = meters != null && meters > GEO_DIFFERENT_PLACE_M;
  const addrSame      = addr?.strong === true;
  const addrDifferent = addr?.conflict === true;
  const branchConfirmed = geoSame || addrSame;
  const branchConflict  = !branchConfirmed && (geoDifferent || addrDifferent || placeIdEqual === false);

  if (!businessLevel) {
    // A different place_id/address on an unrelated name is simply another business. A shared brand alone lands here too.
    return { verdict: name.brand ? 'different_branch' : 'no_match', confidence: Math.min(name.score, 49), basis: name.brand ? ['brand_only'] : [], signals };
  }

  if (name.exact) basis.push('name_exact'); else if (name.business) basis.push('name');
  if (domainExact === true) basis.push('domain');

  if (branchConfirmed) {
    if (geoSame)  basis.push('coordinates');
    if (addrSame) basis.push('address');
    const confidence = Math.min(100, 70 + (name.exact ? 10 : 0) + (domainExact ? 5 : 0) + (geoSame ? 10 : 0) + (addrSame ? 5 : 0));
    return { verdict: 'branch', confidence, basis, signals };
  }
  if (branchConflict) {
    return { verdict: 'different_branch', confidence: Math.min(name.score, 49), basis: [...basis, 'branch_conflict'], signals };
  }
  return { verdict: 'business', confidence: Math.min(75, 50 + (name.exact ? 15 : 0) + (domainExact ? 10 : 0)), basis, signals };
}

/**
 * Pick the target listing from a Maps result list.
 *
 * @returns {{ status: 'matched'|'not_found'|'ambiguous', level: 'branch'|'business'|null, item: object|null,
 *             confidence: number, basis: string[], candidates: number, reason: string }}
 *   ambiguous: several listings are equally plausible and nothing separates them (e.g. two same-named branches and no
 *              address / coordinates / place_id on the tracked business). No rank is produced; the caller must say so.
 */
export function matchBusinessInMapsResults(identity, items) {
  const list = Array.isArray(items) ? items : [];
  if (!identity?.name && !identity?.placeId && !identity?.domain) {
    return { status: 'not_found', level: null, item: null, confidence: 0, basis: [], candidates: 0, reason: 'no_identity' };
  }

  const evaluated = list.map(item => ({ item, ...evaluateCandidate(identity, item) }));
  const rankOf = (e) => e.item?.rank_group ?? e.item?.rank_absolute ?? Number.MAX_SAFE_INTEGER;

  const branches = evaluated.filter(e => e.verdict === 'branch')
    .sort((a, b) => b.confidence - a.confidence || rankOf(a) - rankOf(b));
  if (branches.length) {
    const top = branches[0];
    return { status: 'matched', level: MATCH_LEVEL.BRANCH, item: top.item, confidence: top.confidence, basis: top.basis, candidates: branches.length, reason: 'branch_confirmed' };
  }

  const businesses = evaluated.filter(e => e.verdict === 'business');
  if (businesses.length === 1) {
    const only = businesses[0];
    return { status: 'matched', level: MATCH_LEVEL.BUSINESS, item: only.item, confidence: only.confidence, basis: only.basis, candidates: 1, reason: 'unique_business_match' };
  }
  if (businesses.length > 1) {
    return { status: 'ambiguous', level: null, item: null, confidence: 0, basis: [], candidates: businesses.length, reason: 'multiple_branches_cannot_be_distinguished' };
  }

  const other = evaluated.filter(e => e.verdict === 'different_branch').length;
  return { status: 'not_found', level: null, item: null, confidence: 0, basis: [], candidates: 0, reason: other ? 'only_other_branches_or_brand_matches' : 'no_matching_listing' };
}
