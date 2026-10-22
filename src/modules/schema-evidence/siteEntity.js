/**
 * siteEntity — where the business entity lives across the WHOLE site, from the crawl's own stored structured data.
 *
 * A recommendation for one page used to see only that page's JSON-LD. The business entity (Organization / LocalBusiness
 * / Hospital …) normally sits on the homepage and a few other pages, so for a gallery or appointment page the model
 * saw "no entity, no address, no phone" and produced a generic Organization from scratch. This module gives every
 * recommendation the site-level truth: which entity exists, on which page, with which @id, types and published
 * facts, and whether the site publishes a physical address at all.
 *
 * `analyzeSiteEntity` is pure (and therefore testable); `collectSiteEntity` only reads the project's own
 * seo_page_data (scoped by projectId) — no network, no other collection.
 */

import mongoose from 'mongoose';
import {
  addressOf, analyzeOrganizations, flattenJsonLd, hasType, isPhysicalLocationNode, nodeById, resolveHttpUrl, typesOf,
} from './schemaGraph.js';

const MAX_PAGES = 400;

const pathOf = (url) => { try { return new URL(url).pathname.replace(/\/+$/, '') || '/'; } catch { return null; } };
// The homepage is the root URL itself. `/?post_type=events` has the same path but is a listing, not the homepage.
const isRootUrl = (url) => { try { const u = new URL(url); return (u.pathname.replace(/\/+$/, '') || '/') === '/' && !u.search; } catch { return false; } };
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

/**
 * @param {{url: string, structured_data?: any}[]} pages  stored crawl documents of ONE project
 * @returns {{
 *   found: boolean, pagesScanned: number, homeUrl: string|null,
 *   primary: null | { pageUrl: string, id: string|null, types: string[], physical: boolean, node: object },
 *   entityPageUrls: string[], conflictingIds: string[],
 *   place: null | { pageUrl: string, id: string|null, address: *, geo: *, hasMap: string|null },
 *   hasAddressEvidence: boolean, specificTypes: string[]
 * }}
 */
export function analyzeSiteEntity(pages) {
  const entities = [];
  const places = [];
  const addressRaw = [];
  let homeUrl = null;
  let scanned = 0;

  for (const page of pages || []) {
    if (!page || typeof page.url !== 'string') continue;
    scanned += 1;
    const origin = (() => { try { return `${new URL(page.url).origin}/`; } catch { return undefined; } })();
    const nodes = flattenJsonLd(page.structured_data);
    if (isRootUrl(page.url) && !homeUrl) homeUrl = page.url;

    const { primary } = analyzeOrganizations(nodes, { siteUrl: origin });
    if (primary) {
      entities.push({
        pageUrl: page.url,
        id: typeof primary['@id'] === 'string' ? primary['@id'] : null,
        types: typesOf(primary),
        physical: isPhysicalLocationNode(primary),
        node: primary,
        nodes,
      });
    }
    for (const n of nodes) {
      if (typesOf(n).includes('Place') && addressOf(n)) {
        places.push({ pageUrl: page.url, id: typeof n['@id'] === 'string' ? n['@id'] : null, address: clone(n.address), geo: clone(n.geo) || null, hasMap: typeof n.hasMap === 'string' ? n.hasMap : null });
      }
    }
    // Every business entity on this page that carries an address (not only the primary one): the owner's headquarters and
    // any separate location entities are told apart later, from whether they are the primary entity or its linked Place.
    const orgIds = new Set();
    for (const n of nodes) {
      if (!hasType(n, 'Organization') || !addressOf(n)) continue;
      orgIds.add(n);
      addressRaw.push({ pageUrl: page.url, node: n, nodes, isPlace: false });
    }
    for (const n of nodes) {
      if (!hasType(n, 'Organization')) continue;
      const ref = n.location && typeof n.location === 'object' && !Array.isArray(n.location) ? n.location['@id'] : null;
      const linked = ref ? nodeById(nodes, ref) : null;
      if (linked && addressOf(linked) && !orgIds.has(linked)) addressRaw.push({ pageUrl: page.url, node: linked, nodes, isPlace: true, linkedFrom: n });
    }
  }

  // Primary: the homepage's entity, else a physical-location one, else the shallowest page's.
  let chosen = entities.find((e) => e.pageUrl === homeUrl) || null;
  if (!chosen) chosen = [...entities].sort((a, b) => Number(b.physical) - Number(a.physical) || (pathOf(a.pageUrl) || '').length - (pathOf(b.pageUrl) || '').length)[0] || null;

  // The place the entity points at (`location: {"@id": ...}`), else the homepage's / first place with an address.
  let place = null;
  if (chosen) {
    const ref = chosen.node.location && typeof chosen.node.location === 'object' ? chosen.node.location['@id'] : null;
    const linked = ref ? nodeById(chosen.nodes, ref) : null;
    if (linked && addressOf(linked)) place = { pageUrl: chosen.pageUrl, id: linked['@id'] || null, address: clone(linked.address), geo: clone(linked.geo) || null, hasMap: typeof linked.hasMap === 'string' ? linked.hasMap : null };
  }
  place = place || places.find((p) => p.pageUrl === homeUrl) || places[0] || null;

  // Address-bearing entities across the site, each marked: is it THE primary entity, or the Place the primary entity points at?
  // Anything else is a separate location entity (a branch) — it is reported, never assumed to be the organization's address.
  const seenAddr = new Set();
  const addressNodes = [];
  for (const e of addressRaw) {
    const id = typeof e.node['@id'] === 'string' ? e.node['@id'] : null;
    const key = `${e.pageUrl}|${id || ''}|${JSON.stringify(e.node.address)}`;
    if (seenAddr.has(key)) continue;
    seenAddr.add(key);
    const isPrimary = !!chosen && !e.isPlace && (e.node === chosen.node || (!!id && id === chosen.id));
    const primaryLocationRef = chosen?.node?.location && typeof chosen.node.location === 'object' ? chosen.node.location['@id'] : null;
    const linkedFromPrimary = !!(e.isPlace && chosen && ((e.linkedFrom && e.linkedFrom === chosen.node) || (id && id === primaryLocationRef)));
    addressNodes.push({ pageUrl: e.pageUrl, id, types: typesOf(e.node), address: clone(e.node.address), isPrimary, isPlace: !!e.isPlace, linkedFromPrimary });
  }

  const ids = [...new Set(entities.map((e) => e.id).filter(Boolean))];
  const primary = chosen ? { pageUrl: chosen.pageUrl, id: chosen.id, types: chosen.types, physical: chosen.physical, node: clone(chosen.node) } : null;
  return {
    found: !!chosen,
    pagesScanned: scanned,
    homeUrl,
    primary,
    entityPageUrls: entities.map((e) => e.pageUrl),
    conflictingIds: ids.length > 1 ? ids : [],
    place,
    addressNodes,
    hasAddressEvidence: !!place || entities.some((e) => addressOf(e.node)),
    specificTypes: primary ? primary.types.filter((t) => t !== 'Organization' && t !== 'LocalBusiness') : [],
  };
}

/** Reads the project's own stored pages and analyses them. Never throws: an unavailable crawl is "nothing found". */
export async function collectSiteEntity(projectId, { db = mongoose.connection?.db } = {}) {
  if (!projectId || !db) return analyzeSiteEntity([]);
  try {
    const pages = await db.collection('seo_page_data')
      .find({ projectId: new mongoose.Types.ObjectId(String(projectId)) }, { projection: { url: 1, structured_data: 1 } })
      .limit(MAX_PAGES)
      .toArray();
    return analyzeSiteEntity(pages);
  } catch (err) {
    console.warn(`[SITE_ENTITY] unavailable: ${err.message}`);
    return analyzeSiteEntity([]);
  }
}

/** The site's homepage URL for markup: the crawled homepage, else the origin of the audited page. */
export function homepageUrlFor(site, pageUrl) {
  if (site?.homeUrl) return resolveHttpUrl(site.homeUrl) || site.homeUrl;
  try { return `${new URL(pageUrl).origin}/`; } catch { return null; }
}

export default { analyzeSiteEntity, collectSiteEntity, homepageUrlFor };
