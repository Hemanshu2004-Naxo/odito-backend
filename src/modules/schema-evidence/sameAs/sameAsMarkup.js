/**
 * sameAsMarkup — the deterministic JSON-LD patch for an Organization's sameAs. Pure; no AI, no I/O.
 *
 * The result is built ONLY from (a) the Organization node the site already publishes and (b) the URLs the owner approved. Every
 * other property of the node (@context, @type, @id, name, url, logo, address, contactPoint, anything unrelated) is copied through
 * unchanged and in its original order; sameAs is the only key touched, and it is added at the end when it did not exist. Existing
 * entries — including ones this module does not understand — are kept in place; approved additions are appended; an explicit
 * removal drops exactly that value. An empty array is never produced: a removal that would empty the list deletes the property.
 */

import { profileKey } from './profileUrl.js';

const asList = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

/**
 * @param {{ node: object, add?: string[], remove?: string[] }} input
 * @returns {{ sameAs: any[]|null, node: object, added: string[], removed: string[], kept: any[], changed: boolean }}
 */
export function buildSameAsPatch({ node, add = [], remove = [] }) {
  const base = node && typeof node === 'object' ? node : {};
  const existing = asList(base.sameAs).filter((v) => v !== '' && v != null);
  const removeKeys = new Set(remove.map(profileKey).filter(Boolean));

  const kept = [];
  const removed = [];
  const seen = new Set();
  for (const value of existing) {
    const key = typeof value === 'string' ? profileKey(value) : null;
    if (key && removeKeys.has(key)) { removed.push(value); continue; }
    // A duplicate of an entry already kept adds nothing and is dropped; an entry that is not a parseable URL is kept as it is.
    if (key) { if (seen.has(key)) continue; seen.add(key); }
    kept.push(value);
  }
  const added = [];
  for (const url of add) {
    const key = profileKey(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    added.push(url);
  }
  const list = [...kept, ...added];

  // Same key order as the source node; sameAs keeps its position when it existed, otherwise it is the last key.
  const out = {};
  for (const [k, v] of Object.entries(base)) {
    if (k === 'sameAs') { if (list.length) out.sameAs = list; continue; }
    out[k] = v;
  }
  if (!('sameAs' in base) && list.length) out.sameAs = list;

  return { sameAs: list.length ? list : null, node: out, added, removed, kept, changed: added.length > 0 || removed.length > 0 };
}

/** The recommended structured data, as the text a person can copy: the existing entity with the approved sameAs. */
export function renderRecommendedJsonLd(node, { withContext = true } = {}) {
  const body = { ...(withContext && !('@context' in node) ? { '@context': 'https://schema.org' } : {}), ...node };
  return JSON.stringify(body, null, 2);
}

export default { buildSameAsPatch, renderRecommendedJsonLd };
