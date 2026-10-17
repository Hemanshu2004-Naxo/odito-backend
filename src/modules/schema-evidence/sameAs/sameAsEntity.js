/**
 * sameAsEntity — which Organization entity a `sameas_array` finding is about, what its sameAs holds now, and whether that entity
 * is the SITE's shared one (published identically on many pages by a theme / SEO plugin) or specific to one page. Pure: it reads
 * the crawl's stored JSON-LD, nothing else.
 *
 * Rules (each exists because the opposite produces a wrong or duplicate fix):
 *   - ALL JSON-LD blocks are read (arrays, @graph at any depth, JSON strings) — flattenJsonLd.
 *   - The Organization is identified from the graph (analyzeOrganizations: subtypes count, a foreign-site entity is never ours),
 *     by @id. A Person's sameAs (an author, a founder) is NEVER the organization's, even when it is the only sameAs on the page.
 *   - Two same-site Organization entities with different @ids are NOT merged: the entity is reported as ambiguous
 *     ('multiple_entities') and the planner refuses to guess which one to edit.
 *   - sameAs absent / empty / populated are three different states: "absent" and "empty" both need a first value, "populated"
 *     needs a reviewed addition and keeps every existing value.
 *   - "Shared" means: the same @id with the same sameAs on most pages that carry an Organization. A shared entity is fixed ONCE at
 *     its source; the finding on every page that publishes it is resolved by that one change.
 */

import { analyzeOrganizations, flattenJsonLd, hasType, resolveHttpUrl, typesOf } from '../schemaGraph.js';
import { evaluateProfileUrl, profileKey } from './profileUrl.js';

const asList = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const origin = (url) => { try { return `${new URL(url).origin}/`; } catch { return undefined; } };
const idOf = (node) => (typeof node?.['@id'] === 'string' && node['@id'] ? node['@id'] : null);

/** The sameAs values of one node as text (a `{"@id": …}` reference is not a profile URL and is ignored). */
export function sameAsValuesOf(node) {
  if (!node || !('sameAs' in node)) return { present: false, values: [] };
  const values = asList(node.sameAs).filter((v) => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
  return { present: true, values };
}

export function describeExisting(values, { siteUrl } = {}) {
  const seen = new Set();
  const valid = []; const invalid = []; const duplicates = [];
  for (const raw of values) {
    const key = profileKey(raw);
    if (!key) { invalid.push({ value: raw, code: 'INVALID_URL' }); continue; }
    if (seen.has(key)) { duplicates.push(raw); continue; }
    seen.add(key);
    const r = evaluateProfileUrl(raw, { siteUrl, source: 'schema' });
    valid.push({ value: raw, comparisonKey: key, platform: r.ok ? r.platform : null, platformLabel: r.ok ? r.platformLabel : null, identityKey: r.ok ? r.identityKey : null });
  }
  return { raw: values, valid, invalid, duplicates };
}

const signatureOf = (node) => asList(node?.sameAs).filter((v) => typeof v === 'string').map(profileKey).filter(Boolean).sort().join('|');

/**
 * @param {{ pages: {url: string, structured_data?: any}[], pageUrl: string }} input   `pages` = stored crawl documents of ONE project
 * @returns {{
 *   state: 'no_entity'|'absent'|'empty'|'populated'|'multiple_entities',
 *   entity: null|{ id: string|null, types: string[], name: string|null, url: string|null, foundOn: string, hasHomeOrganizationId: boolean, node: object },
 *   existing: ReturnType<typeof describeExisting>,
 *   entities: {id: string|null, pageUrl: string, types: string[]}[],
 *   scope: { shared: boolean, pagesWithEntity: number, pagesWithSameEntity: number, affectedPages: string[], reason: string },
 *   personSameAsOnly: boolean
 * }}
 */
export function resolveSameAsEntity({ pages = [], pageUrl }) {
  const siteUrl = origin(pageUrl);
  const perPage = [];
  for (const page of pages) {
    if (!page || typeof page.url !== 'string') continue;
    const nodes = flattenJsonLd(page.structured_data);
    const analysis = analyzeOrganizations(nodes, { siteUrl: origin(page.url) });
    perPage.push({ url: page.url, nodes, analysis, primary: analysis.primary });
  }

  const target = perPage.find((p) => p.url === pageUrl) || null;
  const home = perPage.find((p) => { try { const u = new URL(p.url); return (u.pathname.replace(/\/+$/, '') || '/') === '/' && !u.search && p.primary; } catch { return false; } }) || null;
  // The page's own entity first; a finding on a page without one is about the site's entity.
  const chosen = (target?.primary ? target : null) || home || perPage.find((p) => p.primary) || null;

  const entities = [];
  for (const p of perPage) {
    for (const n of p.analysis.own) entities.push({ id: idOf(n), pageUrl: p.url, types: typesOf(n) });
  }
  const distinctIds = new Set(entities.map((e) => e.id || `anon:${e.pageUrl}`));

  const empty = {
    state: 'no_entity', entity: null, existing: describeExisting([], { siteUrl }), entities, personSameAsOnly: false,
    scope: { shared: false, pagesWithEntity: 0, pagesWithSameEntity: 0, affectedPages: [], reason: 'No Organization entity was found in the stored crawl.' },
  };
  if (!chosen) return empty;

  const node = chosen.primary;
  const id = idOf(node);
  const home_ = home?.url || siteUrl || '';
  const entity = {
    id, types: typesOf(node), name: typeof node.name === 'string' ? node.name : null,
    url: resolveHttpUrl(typeof node.url === 'string' ? node.url : null, chosen.url),
    foundOn: chosen.url,
    hasHomeOrganizationId: !!id && !!home_ && id.replace(/\/+$/, '') === `${new URL(home_).origin}/#organization`.replace(/\/+$/, ''),
    node,
  };

  // Same-site entities that differ by @id (not one entity repeated on pages): never merged, never guessed between.
  const ownIds = new Set(entities.filter((e) => e.id).map((e) => e.id));
  const anonymous = entities.filter((e) => !e.id);
  const onThisPage = chosen.analysis.own;
  const conflictingOnPage = chosen.analysis.conflicting || chosen.analysis.duplicateIds.length > 0 || (onThisPage.length > 1 && new Set(onThisPage.map(idOf)).size > 1);
  const multiple = conflictingOnPage || ownIds.size > 1 || (ownIds.size === 1 && anonymous.length > 0 && !id);

  const { present, values } = sameAsValuesOf(node);
  const existing = describeExisting(values, { siteUrl: origin(chosen.url) });

  // Shared / global: the same @id with the same sameAs on most pages that carry an Organization.
  const withEntity = perPage.filter((p) => p.primary);
  const sig = signatureOf(node);
  const same = withEntity.filter((p) => (id ? idOf(p.primary) === id : p === chosen) && signatureOf(p.primary) === sig);
  const shared = !!id && same.length >= 2 && same.length / Math.max(1, withEntity.length) >= 0.6;
  const reason = shared
    ? `The same Organization (${id}) with the same sameAs is published on ${same.length} of ${withEntity.length} crawled pages that describe the organization, so it comes from one shared source.`
    : withEntity.length <= 1
      ? 'Only one crawled page carries an Organization entity.'
      : `The Organization differs between pages (${same.length} of ${withEntity.length} pages carry this exact entity), so it is treated as page-specific.`;

  const personSameAsOnly = !present && perPage.some((p) => p.url === chosen.url && p.nodes.some((n) => typesOf(n).includes('Person') && !hasType(n, 'Organization') && asList(n.sameAs).length > 0));

  return {
    state: multiple ? 'multiple_entities' : !present ? 'absent' : existing.raw.length ? 'populated' : 'empty',
    entity, existing, entities, personSameAsOnly,
    scope: { shared, pagesWithEntity: withEntity.length, pagesWithSameEntity: same.length, affectedPages: same.map((p) => p.url), reason },
  };
}

export default { resolveSameAsEntity, sameAsValuesOf, describeExisting };
