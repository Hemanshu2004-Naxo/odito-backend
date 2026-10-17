/**
 * schemaGraph — pure, dependency-free helpers for reading JSON-LD the way a crawler
 * actually finds it: @type as a string OR an array, entities at the root, in arrays,
 * or inside @graph, ids referencing other nodes.
 *
 * WHY THIS EXISTS: three different places (SchemaResolver, SchemaValidator,
 * TaskVerificationService) each re-implemented "find the Organization" and each got a
 * different answer. The resolver compared `@type` to a string, so
 * `"@type": ["Hospital","Organization"]` looked like "no Organization" and the generator
 * produced a duplicate (with an invented logo). Everything schema-related in the
 * recommendation / verification pipeline reads entities through this file.
 *
 * Nothing here performs network I/O.
 */

// ── schema.org type hierarchy (Organization + Article branches) ───────────────
// Mirrors python_workers/scraper/workers/ai_v2/rules/schema_hierarchy.py (and the flat
// ORG_SUBTYPES list in aiHubController.js). Update all three together.
const PARENT = {
  Organization: null,
  Corporation: 'Organization',
  NGO: 'Organization',
  GovernmentOrganization: 'Organization',
  EducationalOrganization: 'Organization',
  School: 'EducationalOrganization',
  CollegeOrUniversity: 'EducationalOrganization',
  MedicalOrganization: 'Organization',
  // schema.org: a Hospital is also an EmergencyService (-> LocalBusiness) and a CivicStructure, so it IS a
  // physical-location entity, not only a MedicalOrganization.
  Hospital: 'EmergencyService',
  Pharmacy: 'MedicalBusiness',
  Physician: 'MedicalBusiness',
  NewsMediaOrganization: 'Organization',
  OnlineBusiness: 'Organization',
  PerformingGroup: 'Organization',
  SportsOrganization: 'Organization',
  LocalBusiness: 'Organization',
  MedicalBusiness: 'LocalBusiness',
  Optician: 'MedicalBusiness',
  MedicalClinic: 'LocalBusiness',
  Dentist: 'LocalBusiness',
  AutoDealer: 'LocalBusiness',
  HealthAndBeautyBusiness: 'LocalBusiness',
  HomeAndConstructionBusiness: 'LocalBusiness',
  LodgingBusiness: 'LocalBusiness',
  EntertainmentBusiness: 'LocalBusiness',
  FoodEstablishment: 'LocalBusiness',
  Store: 'LocalBusiness',
  FinancialService: 'LocalBusiness',
  SportsActivityLocation: 'LocalBusiness',
  LegalService: 'LocalBusiness',
  AnimalShelter: 'LocalBusiness',
  ChildCare: 'LocalBusiness',
  DryCleaningOrLaundry: 'LocalBusiness',
  EmergencyService: 'LocalBusiness',
  EmploymentAgency: 'LocalBusiness',
  ProfessionalService: 'LocalBusiness',
  RealEstateAgent: 'LocalBusiness',
  TravelAgency: 'LocalBusiness',
  HairSalon: 'HealthAndBeautyBusiness',
  BeautySalon: 'HealthAndBeautyBusiness',
  NailSalon: 'HealthAndBeautyBusiness',
  TattooParlor: 'HealthAndBeautyBusiness',
  Restaurant: 'FoodEstablishment',
  CafeOrCoffeeShop: 'FoodEstablishment',
  FastFoodRestaurant: 'Restaurant',
  Bakery: 'FoodEstablishment',
  BarOrPub: 'FoodEstablishment',
  IceCreamShop: 'FoodEstablishment',
  BedAndBreakfast: 'LodgingBusiness',
  Campground: 'LodgingBusiness',
  Hostel: 'LodgingBusiness',
  Hotel: 'LodgingBusiness',
  Motel: 'LodgingBusiness',
  Resort: 'LodgingBusiness',
  VacationRental: 'LodgingBusiness',

  CreativeWork: null,
  Article: 'CreativeWork',
  BlogPosting: 'Article',
  NewsArticle: 'Article',
  TechArticle: 'Article',
  ScholarlyArticle: 'Article',
  Report: 'Article',
  OpinionNewsArticle: 'NewsArticle',
  AnalysisNewsArticle: 'NewsArticle',
  ReportageNewsArticle: 'NewsArticle',
};

function ancestors(typeName) {
  const out = new Set();
  let cur = typeName;
  while (cur && !out.has(cur)) {
    out.add(cur);
    cur = PARENT[cur] ?? null;
  }
  return out;
}

/** True if `typeName` equals or descends from `expected` in the (partial) schema.org hierarchy. */
export function typeSatisfies(typeName, expected) {
  return typeof typeName === 'string' && ancestors(typeName).has(expected);
}

// ── basics ────────────────────────────────────────────────────────────────────

export const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

/** @type normalised to an array of non-empty strings (the value may be a string or an array). */
export function typesOf(node) {
  return asArray(node?.['@type']).filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim());
}

export function hasType(node, expected) {
  return typesOf(node).some((t) => typeSatisfies(t, expected));
}

export const isOrganizationNode = (node) => hasType(node, 'Organization');
/** A physical-location entity: LocalBusiness or any subtype (Hospital, MedicalClinic, Dentist, Restaurant, ...). */
export const isPhysicalLocationNode = (node) => hasType(node, 'LocalBusiness');
/** schema.org `address` as an object or a single line; null when there is nothing usable. */
export function addressOf(node) {
  const a = node?.address;
  if (typeof a === 'string') return a.trim() ? a.trim() : null;
  if (a && typeof a === 'object' && ['streetAddress', 'addressLocality', 'postalCode'].some((k) => a[k])) return a;
  return null;
}
export const isArticleNode = (node) => hasType(node, 'Article');
export const isBreadcrumbNode = (node) => typesOf(node).includes('BreadcrumbList');

/**
 * Every typed node of a crawler `structured_data` value — arrays, `@graph` (at any
 * nesting, also when the parent declares @context), and a JSON string — as a flat list.
 * A node that only references another (`{"@id": "..."}`) has no @type and is not returned.
 */
export function flattenJsonLd(structuredData) {
  const nodes = [];
  const visit = (value, depth) => {
    if (value == null || depth > 6) return;
    if (typeof value === 'string') {
      try { visit(JSON.parse(value), depth + 1); } catch { /* not JSON */ }
      return;
    }
    if (Array.isArray(value)) { value.forEach((v) => visit(v, depth + 1)); return; }
    if (typeof value !== 'object') return;
    if (value['@graph']) visit(value['@graph'], depth + 1);
    if (value['@type']) nodes.push(value);
  };
  visit(structuredData, 0);
  return nodes;
}

export function nodeById(nodes, id) {
  if (typeof id !== 'string' || !id) return null;
  return nodes.find((n) => n['@id'] === id) || null;
}

// ── URLs ──────────────────────────────────────────────────────────────────────

const TRACKING_EXACT = new Set(['fbclid', 'gclid', 'msclkid', 'dclid', 'gbraid', 'wbraid', 'yclid', 'igshid', 'mc_cid', 'mc_eid', '_hsenc', '_hsmi', 'mkt_tok', 'twclid', 'ttclid']);
const isTrackingParam = (k) => /^utm_/i.test(k) || TRACKING_EXACT.has(k.toLowerCase());

/**
 * Absolute http(s) URL, or null. Resolves relative and protocol-relative references against
 * `base`. Uses the WHATWG parser only — it never decodes the path, so percent-encoding and
 * path case are preserved exactly. Credentials and non-http(s) schemes are rejected.
 */
export function resolveHttpUrl(value, base) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || /[\u0000-\u001f\s<>"\\`]/.test(raw)) return null;
  try {
    const u = new URL(raw, base || undefined);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

/**
 * True only for an ABSOLUTE http(s) URL exactly as written — "/logo.png", "//cdn.x/l.png" and
 * "logo.png" are not. Generated markup must publish absolute URLs; relative references are only
 * ever resolved when READING a page (resolveHttpUrl with a base).
 */
export function isAbsoluteHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim()) && resolveHttpUrl(value) !== null;
}

/** Removes the fragment and well-known tracking parameters ONLY (never substring-matches parameter names). */
export function stripTrackingParams(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (isTrackingParam(key)) u.searchParams.delete(key);
    }
    return u.href;
  } catch {
    return null;
  }
}

export const hostOf = (url) => {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
};

export const sameSite = (a, b) => {
  const ha = hostOf(a);
  return !!ha && ha === hostOf(b);
};

/** Path comparison that ignores only a trailing slash (everything else is significant). */
export function samePathIgnoringTrailingSlash(a, b) {
  try {
    const ua = new URL(a); const ub = new URL(b);
    const norm = (u) => u.pathname.replace(/\/+$/, '') + u.search;
    return ua.hostname.replace(/^www\./, '') === ub.hostname.replace(/^www\./, '') && norm(ua) === norm(ub);
  } catch {
    return false;
  }
}

/**
 * The URL a schema should use for a page. Crawl identity keys (python utils.normalize_url)
 * deliberately have no trailing slash, are percent-decoded and have some query parameters
 * removed — fine for de-duplicating pages, wrong for a URL that is published in markup. A
 * same-site canonical tag is the only trustworthy source; without one the crawl key is
 * returned with `trusted: false` so callers can say so instead of presenting it as canonical.
 */
export function pickDisplayUrl({ canonical, pageUrl }) {
  const fromCanonical = resolveHttpUrl(canonical, pageUrl);
  if (fromCanonical && sameSite(fromCanonical, pageUrl)) {
    return {
      url: stripTrackingParams(fromCanonical) || fromCanonical,
      source: 'canonical_tag',
      trusted: true,
      selfReferencing: samePathIgnoringTrailingSlash(fromCanonical, pageUrl),
    };
  }
  const page = resolveHttpUrl(pageUrl);
  return { url: page, source: page ? 'crawl_url' : 'none', trusted: false, selfReferencing: null };
}

// ── Organization ──────────────────────────────────────────────────────────────

/**
 * Locates the site's Organization entities and picks the primary one.
 *
 * - Subtypes count (Hospital, MedicalClinic, LocalBusiness, …) and so do multi-typed nodes.
 * - A node whose own `url` is on a different site is someone else's entity (a reviewed
 *   business, a partner) and is never the primary.
 * - Duplicates are reported, never silently merged: two nodes sharing an @id, or two
 *   same-site organizations with different ids.
 */
export function analyzeOrganizations(nodes, { siteUrl } = {}) {
  const all = nodes.filter(isOrganizationNode);
  const own = []; const foreign = [];
  for (const n of all) {
    const nodeUrl = resolveHttpUrl(n.url, siteUrl);
    (nodeUrl && siteUrl && !sameSite(nodeUrl, siteUrl) ? foreign : own).push(n);
  }

  const score = (n) => {
    let s = 0;
    const id = typeof n['@id'] === 'string' ? n['@id'] : '';
    if (/#organi[sz]ation$/i.test(id)) s += 4;
    const u = resolveHttpUrl(n.url, siteUrl);
    if (u && siteUrl && sameSite(u, siteUrl)) { s += 1; try { if (new URL(u).pathname === '/') s += 1; } catch { /* ignore */ } }
    if (n.logo) s += 1;
    if (n.name) s += 1;
    if (typesOf(n).includes('Organization')) s += 0.5;
    return s;
  };
  const primary = own.length ? own.reduce((best, n) => (score(n) > score(best) ? n : best), own[0]) : null;

  const byId = new Map();
  for (const n of own) {
    const id = typeof n['@id'] === 'string' ? n['@id'] : null;
    if (!id) continue;
    byId.set(id, (byId.get(id) || 0) + 1);
  }
  const duplicateIds = [...byId.entries()].filter(([, c]) => c > 1).map(([id, count]) => ({ id, count }));
  const distinctIds = new Set(own.map((n) => (typeof n['@id'] === 'string' ? n['@id'] : `__anon${own.indexOf(n)}`)));
  const conflicting = distinctIds.size > 1;

  return { all, own, foreign, primary, duplicateIds, conflicting, count: own.length };
}

function imageRef(value, nodes, base, source) {
  const out = [];
  for (const v of asArray(value)) {
    if (typeof v === 'string') {
      const url = resolveHttpUrl(v, base);
      if (url) out.push({ url, source, declaredWidth: null, declaredHeight: null });
    } else if (v && typeof v === 'object') {
      const target = (!v.url && !v.contentUrl && v['@id']) ? nodeById(nodes, v['@id']) : v;
      // An @id is an identifier ("https://site/#logo" names the homepage document), never an image URL.
      const raw = target?.url || target?.contentUrl || null;
      const url = resolveHttpUrl(typeof raw === 'string' ? raw : null, base);
      const num = (x) => { const n = Number(x); return Number.isFinite(n) && n > 0 ? n : null; };
      if (url) out.push({ url, source, declaredWidth: num(target?.width), declaredHeight: num(target?.height) });
    }
  }
  return out;
}

/**
 * Logo URLs the SITE ITSELF declares in its structured data — the only logo evidence that
 * is not a guess. De-duplicated by URL, strongest source first.
 */
export function logoCandidatesFromSchema(nodes, primaryOrg, base) {
  const found = [];
  if (primaryOrg) found.push(...imageRef(primaryOrg.logo, nodes, base, 'organization.logo'));
  for (const n of nodes) {
    if (typeof n['@id'] === 'string' && /#logo$/i.test(n['@id']) && typesOf(n).includes('ImageObject')) {
      found.push(...imageRef(n, nodes, base, 'logo_node'));
    }
    if (n !== primaryOrg && n.publisher && typeof n.publisher === 'object') {
      found.push(...imageRef(n.publisher.logo, nodes, base, 'publisher.logo'));
    }
  }
  const seen = new Set();
  return found.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));
}

// ── BreadcrumbList ────────────────────────────────────────────────────────────

/**
 * Parses and checks every BreadcrumbList in the page's structured data.
 * Problems are codes, not prose, so callers can map them to messages / fix hints.
 */
export function analyzeBreadcrumbs(nodes, { pageUrl } = {}) {
  const lists = nodes.filter(isBreadcrumbNode).map((node) => {
    const elements = asArray(node.itemListElement);
    const items = elements.map((el, i) => {
      const inner = el && typeof el.item === 'object' && el.item ? el.item : null;
      const rawUrl = typeof el?.item === 'string' ? el.item : (inner?.['@id'] || inner?.url || null);
      const name = (typeof el?.name === 'string' && el.name.trim()) || (typeof inner?.name === 'string' && inner.name.trim()) || null;
      const position = el?.position == null ? null : Number(el.position);
      return { index: i, position: Number.isFinite(position) ? position : null, name, rawUrl: typeof rawUrl === 'string' ? rawUrl : null, url: resolveHttpUrl(rawUrl, pageUrl) };
    });
    return { id: node['@id'] || null, items, problems: breadcrumbProblems(items, pageUrl) };
  });
  return { lists, count: lists.length, duplicateLists: lists.length > 1 };
}

export function breadcrumbProblems(items, pageUrl) {
  const problems = new Set();
  if (!items.length) { problems.add('empty_list'); return [...problems]; }
  const seenUrls = new Set();
  items.forEach((it, i) => {
    const last = i === items.length - 1;
    if (!it.name) problems.add('missing_name');
    if (!it.rawUrl) { if (!last) problems.add('missing_url'); }
    else if (!isAbsoluteHttpUrl(it.rawUrl)) problems.add(/^[a-z][a-z0-9+.-]*:/i.test(it.rawUrl) && !/^https?:/i.test(it.rawUrl) ? 'unsupported_url' : 'relative_or_invalid_url');
    else {
      if (pageUrl && !sameSite(it.url, pageUrl)) problems.add('cross_site_url');
      const key = it.url.replace(/\/+$/, '');
      if (seenUrls.has(key)) problems.add('duplicate_url');
      seenUrls.add(key);
    }
    if (it.position !== i + 1) problems.add('position_not_sequential');
  });
  return [...problems];
}

// ── Dates ─────────────────────────────────────────────────────────────────────

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Strict ISO-8601 parse for schema dates. The ORIGINAL offset is kept in `value` (a
 * published time of "2024-03-05T09:30:00+05:30" is never silently turned into UTC, and a
 * date with no offset is reported as `hasTimezone: false` rather than assumed to be UTC).
 * Impossible calendar dates (2024-02-30) and free-text dates are rejected.
 */
export function parseSchemaDate(input) {
  if (typeof input !== 'string') return { valid: false, reason: 'not_a_string' };
  const raw = input.trim();
  const m = DATE_RE.exec(raw);
  if (!m) return { valid: false, reason: 'not_iso_8601' };
  const [, y, mo, d, h = '00', mi = '00', s = '00', tz] = m;
  const Y = +y; const M = +mo; const D = +d; const H = +h; const I = +mi; const S = +s;
  if (M < 1 || M > 12 || D < 1 || H > 23 || I > 59 || S > 59) return { valid: false, reason: 'out_of_range' };
  const probe = new Date(Date.UTC(Y, M - 1, D));
  if (probe.getUTCFullYear() !== Y || probe.getUTCMonth() !== M - 1 || probe.getUTCDate() !== D) return { valid: false, reason: 'impossible_date' };

  let offsetMinutes = null;
  let normalizedTz = '';
  if (tz) {
    if (tz === 'Z') { offsetMinutes = 0; normalizedTz = 'Z'; } else {
      const sign = tz[0] === '-' ? -1 : 1;
      const digits = tz.slice(1).replace(':', '');
      const oh = +digits.slice(0, 2); const om = +digits.slice(2, 4);
      if (oh > 14 || om > 59) return { valid: false, reason: 'bad_offset' };
      offsetMinutes = sign * (oh * 60 + om);
      normalizedTz = `${tz[0]}${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
    }
  }
  const hasTime = m[4] !== undefined;
  const value = hasTime
    ? `${y}-${mo}-${d}T${h}:${mi}:${s}${raw.match(/\.\d{1,9}/) ? raw.match(/\.\d{1,9}/)[0] : ''}${normalizedTz}`
    : `${y}-${mo}-${d}`;
  const utcMs = Date.UTC(Y, M - 1, D, H, I, S) - (offsetMinutes ?? 0) * 60000;
  return { valid: true, value, hasTime, hasTimezone: tz != null, offsetMinutes, epochMs: utcMs };
}

// ── Duplicate / conflicting entities ──────────────────────────────────────────

/** Duplicate @id values and repeated single-instance types (a page needs one BreadcrumbList, one primary Article). */
export function findDuplicateEntities(nodes) {
  const ids = new Map();
  for (const n of nodes) {
    if (typeof n['@id'] !== 'string') continue;
    ids.set(n['@id'], [...(ids.get(n['@id']) || []), typesOf(n)]);
  }
  const duplicateIds = [...ids.entries()].filter(([, v]) => v.length > 1).map(([id, v]) => ({ id, count: v.length }));
  const count = (pred) => nodes.filter(pred).length;
  return {
    duplicateIds,
    breadcrumbLists: count(isBreadcrumbNode),
    articles: count(isArticleNode),
    organizations: analyzeOrganizations(nodes).own.length,
  };
}

export default {
  asArray, typesOf, hasType, typeSatisfies, isOrganizationNode, isPhysicalLocationNode, addressOf, isArticleNode, isBreadcrumbNode,
  flattenJsonLd, nodeById, resolveHttpUrl, stripTrackingParams, hostOf, sameSite, samePathIgnoringTrailingSlash,
  isAbsoluteHttpUrl, pickDisplayUrl, analyzeOrganizations, logoCandidatesFromSchema, analyzeBreadcrumbs, breadcrumbProblems,
  parseSchemaDate, findDuplicateEntities,
};
