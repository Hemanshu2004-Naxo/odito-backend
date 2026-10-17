/**
 * organizationMarkup — the JSON-LD an organization recommendation publishes, built ONLY from the verified evidence and
 * the schema intent, plus the difference between that markup and the entity the page already has.
 *
 * Kept in schema-evidence/ (not in the recommendation service) because the delta decides the final intent action
 * (`reuse` when the existing entity already carries everything verifiable, `generate`/extend when it can be improved),
 * which the evidence itself must expose to the guard, validator, builder and UI alike.
 */

import { serializeJsonLdForScript } from './breadcrumbHierarchy.js';

export const FACT_ORDER = ['telephone', 'email', 'address', 'geo', 'hasMap', 'openingHoursSpecification', 'openingHours', 'priceRange', 'areaServed', 'contactPoint', 'faxNumber', 'sameAs'];

const clone = (v) => JSON.parse(JSON.stringify(v));
const stable = (v) => JSON.stringify(v, (_k, val) => (val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : 1))) : val));
const trimSlash = (u) => (typeof u === 'string' ? u.replace(/\/+$/, '') : u);
const logoUrlOfNode = (logo) => {
  const f = Array.isArray(logo) ? logo[0] : logo;
  return typeof f === 'string' ? f : f && typeof f === 'object' ? (f.url || f.contentUrl || null) : null;
};

/** The JSON-LD object for a `generate` intent: identity from the intent, everything else from verified facts. */
export function buildOrganizationJsonLd(evidence) {
  const o = evidence.organization;
  const intent = o.intent;
  const home = o.homepageUrl;
  const node = {
    '@context': 'https://schema.org',
    '@type': intent.types.length === 1 ? intent.types[0] : [...intent.types],
    '@id': intent.id || o.id || (home ? `${home}#organization` : undefined),
    name: o.name?.value,
    url: o.url || home,
  };
  // Descriptive text the site already publishes on this page's entity is carried over unchanged.
  for (const f of ['description', 'alternateName']) {
    const v = o.primary?.node?.[f];
    if (typeof v === 'string' && v.trim()) node[f] = v.trim();
  }
  const lv = o.logo?.verified;
  if (lv) node.logo = { '@type': 'ImageObject', url: lv.url, ...(lv.width && lv.height ? { width: lv.width, height: lv.height } : {}) };
  for (const f of FACT_ORDER) if (o.contact?.[f] != null) node[f] = clone(o.contact[f]);
  for (const k of Object.keys(node)) if (node[k] === undefined) delete node[k];
  return node;
}

/**
 * What the recommended markup would ADD or CHANGE on the page's existing entity.
 * @returns {{field: string, kind: 'add'|'change'|'remove'}[]}  empty = the existing entity is already complete
 */
export function organizationDelta(evidence) {
  const o = evidence.organization;
  const existing = o.primary?.node;
  if (!existing) return [];
  const generated = buildOrganizationJsonLd(evidence);
  const delta = [];
  for (const [k, v] of Object.entries(generated)) {
    if (k === '@context' || k === '@id') continue;
    if (k === '@type') {
      if (stable([].concat(existing['@type'] || []).sort()) !== stable([].concat(v).sort())) delta.push({ field: '@type', kind: 'change' });
      continue;
    }
    if (existing[k] == null) { delta.push({ field: k, kind: 'add' }); continue; }
    if (k === 'logo') {
      // A logo declared as an @id reference to an ImageObject node (Yoast-style) has no url of its own; the evidence already
      // resolved it and verified the image, so compare against that instead of reporting a change that is not one.
      const have = logoUrlOfNode(existing.logo) || (o.logo?.verified?.trust === 'existing_schema' ? o.logo.verified.url : null);
      if (trimSlash(have) !== trimSlash(v.url)) delta.push({ field: 'logo', kind: 'change' });
      continue;
    }
    if (k === 'url') { if (trimSlash(existing.url) !== trimSlash(v)) delta.push({ field: 'url', kind: 'change' }); continue; }
    if (stable(existing[k]) !== stable(v)) delta.push({ field: k, kind: 'change' });
  }
  // A logo the site declares that does not work is removed from the recommendation (never published as-is).
  if (existing.logo != null && generated.logo == null && ['existing_broken', 'all_broken'].includes(o.logo?.status)) delta.push({ field: 'logo', kind: 'remove' });
  return delta;
}

export { serializeJsonLdForScript };
export default { FACT_ORDER, buildOrganizationJsonLd, organizationDelta };
