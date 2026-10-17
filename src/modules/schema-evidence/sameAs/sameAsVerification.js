/**
 * sameAsVerification — proves, from a page's RENDERED JSON-LD, that an Organization sameAs fix is live. A saved WordPress setting
 * is not proof: a page cache, a theme override or a second markup source can leave the public page unchanged. Pure checks
 * (inspectRenderedSameAs) + one thin live wrapper (verifyRenderedSameAs) that fetches the public page through the existing
 * same-site fetcher (same host only, no cross-site redirects, size/time limits).
 *
 * What "verified" means here, all of it required:
 *   1. the page carries parseable JSON-LD and the intended Organization entity (matched by @id)
 *   2. every approved URL is in THAT entity's sameAs (compared scheme/slash-insensitively, never by substring)
 *   3. every value that was published before and was not explicitly removed is still there
 *   4. every explicitly removed value is gone
 *   5. no second same-site Organization appeared (the fix must never create a duplicate entity)
 * Anything the check cannot judge (page not fetchable, no JSON-LD) is 'unverifiable', not a failure and never a success.
 */

import * as cheerio from 'cheerio';
import { analyzeOrganizations, flattenJsonLd, typesOf } from '../schemaGraph.js';
import { profileKey } from './profileUrl.js';
import { fetchRenderedHtml } from '../../external_integration/content/renderedHtml.js';

const asList = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const idOf = (n) => (typeof n?.['@id'] === 'string' ? n['@id'] : null);

/** The JSON-LD blocks of an HTML document (parse errors counted, never thrown). */
export function jsonLdFromHtml(html) {
  const $ = cheerio.load(String(html || ''));
  const values = []; let errors = 0;
  $('script[type="application/ld+json"]').each((_, el) => {
    try { values.push(JSON.parse($(el).contents().text())); } catch { errors += 1; }
  });
  return { values, errors };
}

/**
 * @param {{ structuredData: any, pageUrl: string, errors?: number,
 *   expected: { entityId: string|null, add: string[], keep?: string[], remove?: string[], organizationsBefore?: number } }} input
 */
export function inspectRenderedSameAs({ structuredData, pageUrl, errors = 0, expected }) {
  const nodes = flattenJsonLd(structuredData);
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, ...(detail ? { detail } : {}) });
  const unverifiable = (code, message) => ({ status: 'unverifiable', code, reasons: [message], checks, rendered: null });

  if (!nodes.length) return unverifiable('NO_JSON_LD', errors ? 'The page has structured data, but none of it could be parsed.' : 'The public page carries no JSON-LD structured data.');

  let origin;
  try { origin = `${new URL(pageUrl).origin}/`; } catch { return unverifiable('INVALID_URL', 'The page URL is not valid.'); }
  const orgs = analyzeOrganizations(nodes, { siteUrl: origin });
  const entity = expected.entityId
    ? orgs.own.find((n) => idOf(n) === expected.entityId) || null
    : orgs.primary;

  add('parseable_json_ld', errors === 0, errors ? `${errors} JSON-LD block(s) could not be parsed.` : null);
  add('entity_present', !!entity, entity ? null : `The Organization ${expected.entityId || ''} is not on the rendered page.`);

  const rendered = entity ? asList(entity.sameAs).filter((v) => typeof v === 'string') : [];
  const renderedKeys = new Set(rendered.map(profileKey).filter(Boolean));
  const has = (u) => renderedKeys.has(profileKey(u));

  const missing = entity ? expected.add.filter((u) => !has(u)) : expected.add;
  add('approved_urls_present', missing.length === 0, missing.length ? `Missing from the published sameAs: ${missing.join(', ')}` : null);

  const lost = entity ? (expected.keep || []).filter((u) => !has(u)) : (expected.keep || []);
  add('existing_values_preserved', lost.length === 0, lost.length ? `No longer published: ${lost.join(', ')}` : null);

  const stillThere = entity ? (expected.remove || []).filter((u) => has(u)) : [];
  add('removed_values_gone', stillThere.length === 0, stillThere.length ? `Still published: ${stillThere.join(', ')}` : null);

  const duplicateKeys = rendered.length - renderedKeys.size;
  add('no_duplicate_values', duplicateKeys <= 0, duplicateKeys > 0 ? `${duplicateKeys} duplicate value(s) in sameAs.` : null);

  const before = expected.organizationsBefore;
  const duplicateEntity = orgs.duplicateIds.length > 0 || (before != null && orgs.count > before);
  add('no_second_organization', !duplicateEntity, duplicateEntity ? `The page now describes the organization ${orgs.count} times (it did ${before ?? 1}).` : null);

  const failed = checks.filter((c) => !c.ok);
  const entitySummary = entity ? { id: idOf(entity), types: typesOf(entity), sameAs: rendered } : null;
  if (!failed.length) return { status: 'verified', code: null, reasons: [], checks, rendered: entitySummary };

  // The saved setting may be right while the public page still serves an old copy: say so, it is the most likely reason.
  const reasons = failed.map((c) => c.detail || c.name);
  if (failed.some((c) => c.name === 'approved_urls_present')) {
    reasons.push('WordPress may still be serving a cached copy of the page, or another plugin/theme publishes this markup. Clear the page cache and check again.');
  }
  return { status: 'failed', code: failed.some((c) => c.name === 'approved_urls_present') ? 'NOT_IN_RENDERED_PAGE' : failed[0].name.toUpperCase(), reasons, checks, rendered: entitySummary };
}

/** Fetches the public page (same site only, cache-busted) and inspects it. A page that cannot be fetched is 'unverifiable'. */
export async function verifyRenderedSameAs({ pageUrl, siteUrl, expected }, { fetchHtml = fetchRenderedHtml } = {}) {
  let html;
  try {
    ({ html } = await fetchHtml(pageUrl, { siteUrl, cacheBust: true }));
  } catch (error) {
    return { status: 'unverifiable', code: error?.code || 'FETCH_FAILED', reasons: [error?.message || 'The public page could not be fetched.'], checks: [], rendered: null };
  }
  const { values, errors } = jsonLdFromHtml(html);
  return inspectRenderedSameAs({ structuredData: values, pageUrl, errors, expected });
}

export default { inspectRenderedSameAs, verifyRenderedSameAs, jsonLdFromHtml };
