/**
 * breadcrumbVerification — proves, from a page's RENDERED JSON-LD, that a breadcrumb fix is live. A saved Rank Math setting is not proof
 * (a cache, a theme or another plugin can leave the public page unchanged, and Rank Math builds its own trail).
 *
 * Per page, all required:
 *   1. the page carries parseable JSON-LD
 *   2. exactly ONE BreadcrumbList (a duplicate entity fails the page, whoever caused it)
 *   3. it is valid (absolute same-site URLs, names, positions 1..n, no repeated URL)
 *   4. its last item is the page itself
 *   5. for the page the owner confirmed a trail for: the trail's pages are the confirmed ones, in the confirmed order
 * A page that cannot be fetched or has no JSON-LD is `unverifiable` (never a failure, never a success).
 *
 * A site-wide change is verified PAGE BY PAGE (verifyBreadcrumbRollout): the confirmed page against its trail, every other affected page
 * against (1)–(4). Nothing here marks any issue fixed; the crawler's verdict still comes from a later recrawl.
 */

import { analyzeBreadcrumbs, flattenJsonLd, samePathIgnoringTrailingSlash } from '../schemaGraph.js';
import { breadcrumbUrlKey } from '../breadcrumbHierarchy.js';
import { fetchRenderedHtml } from '../../external_integration/content/renderedHtml.js';
import { jsonLdFromHtml } from '../sameAs/sameAsVerification.js';

const asUrls = (items) => (items || []).map((i) => i.url);

/**
 * @param {{ structuredData: any, pageUrl: string, displayUrl?: string|null, errors?: number, intended?: {url: string}[]|null }} input
 */
export function inspectRenderedBreadcrumb({ structuredData, pageUrl, displayUrl = null, errors = 0, intended = null }) {
  const nodes = flattenJsonLd(structuredData);
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, ...(detail ? { detail } : {}) });
  if (!nodes.length) {
    return { status: 'unverifiable', code: 'NO_JSON_LD', reasons: [errors ? 'The page has structured data, but none of it could be parsed.' : 'The public page carries no JSON-LD structured data.'], checks, rendered: null };
  }
  const crumbs = analyzeBreadcrumbs(nodes, { pageUrl: displayUrl || pageUrl });
  add('parseable_json_ld', errors === 0, errors ? `${errors} JSON-LD block(s) could not be parsed.` : null);
  add('breadcrumb_present', crumbs.count > 0, crumbs.count ? null : 'No BreadcrumbList is published on the page.');
  let list = null;
  if (crumbs.count) {
    add('breadcrumb_single', !crumbs.duplicateLists, crumbs.duplicateLists ? `${crumbs.count} BreadcrumbList entities — a page should have one.` : null);
    list = crumbs.lists[0];
    add('breadcrumb_valid', !list.problems.length && list.items.length >= 2, list.problems.length ? `Problems: ${list.problems.join(', ')}` : (list.items.length < 2 ? 'Fewer than two items.' : null));
    const last = list.items[list.items.length - 1];
    const here = displayUrl || pageUrl;
    // Google allows the last item to omit its URL: it then stands for the page itself.
    add('breadcrumb_current_page', !last?.url || samePathIgnoringTrailingSlash(last.url, here) || samePathIgnoringTrailingSlash(last.url, pageUrl), last?.url ? `The last item is ${last.url}, not this page (${here}).` : null);
    if (Array.isArray(intended) && intended.length >= 2) {
      const found = list.items.map((i, n) => i.url || (n === list.items.length - 1 ? here : null));
      const wanted = asUrls(intended);
      const same = found.length === wanted.length && found.every((u, n) => u && breadcrumbUrlKey(u) === breadcrumbUrlKey(wanted[n]));
      add('breadcrumb_matches_confirmed', same, same ? null : `The published trail differs from the one you confirmed. Confirmed: ${wanted.join(' › ')}. Published: ${found.map((u) => u || '(no URL)').join(' › ')}.`);
    }
  }
  const failed = checks.filter((c) => !c.ok);
  const rendered = list ? { items: list.items.map((i) => ({ position: i.position, name: i.name, url: i.url })) } : null;
  if (!failed.length) return { status: 'verified', code: null, reasons: [], checks, rendered };
  const reasons = failed.map((c) => c.detail || c.name);
  if (failed.some((c) => c.name === 'breadcrumb_present')) reasons.push('WordPress may still be serving a cached copy of the page, or another plugin or theme prevents the breadcrumbs. Clear the page cache and check again.');
  const code = failed.some((c) => c.name === 'breadcrumb_present') ? 'NOT_IN_RENDERED_PAGE' : failed[0].name.toUpperCase();
  return { status: 'failed', code, reasons, checks, rendered };
}

/** Fetches the public page (same site only, cache-busted) and inspects it. A page that cannot be fetched is 'unverifiable'. */
export async function verifyRenderedBreadcrumbPage({ pageUrl, siteUrl, displayUrl = null, intended = null }, { fetchHtml = fetchRenderedHtml } = {}) {
  let html;
  try {
    ({ html } = await fetchHtml(pageUrl, { siteUrl, cacheBust: true }));
  } catch (error) {
    return { status: 'unverifiable', code: error?.code || 'FETCH_FAILED', reasons: [error?.message || 'The public page could not be fetched.'], checks: [], rendered: null };
  }
  const { values, errors } = jsonLdFromHtml(html);
  return inspectRenderedBreadcrumb({ structuredData: values, pageUrl, displayUrl, errors, intended });
}

/**
 * The confirmed page against its trail, then every other page that shares the source (bounded) against the page-level checks.
 * @returns {{ status: 'verified'|'failed'|'unverifiable', code: string|null, reasons: string[], checks: object[], pages: {url: string, status: string, code: string|null, reasons: string[], confirmed: boolean}[] }}
 */
export async function verifyBreadcrumbRollout({ pageUrl, siteUrl, displayUrl = null, intended, otherPages = [], maxOthers = 5 }, { fetchHtml = fetchRenderedHtml, concurrency = 3 } = {}) {
  const main = await verifyRenderedBreadcrumbPage({ pageUrl, siteUrl, displayUrl, intended }, { fetchHtml });
  const others = [...new Set(otherPages)].filter((u) => !samePathIgnoringTrailingSlash(u, pageUrl)).slice(0, maxOthers);
  const results = new Array(others.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, others.length) }, async () => {
    while (next < others.length) {
      const i = next; next += 1;
      results[i] = await verifyRenderedBreadcrumbPage({ pageUrl: others[i], siteUrl, intended: null }, { fetchHtml });
    }
  }));
  const pages = [{ url: pageUrl, status: main.status, code: main.code, reasons: main.reasons, confirmed: true }, ...others.map((u, i) => ({ url: u, status: results[i].status, code: results[i].code, reasons: results[i].reasons, confirmed: false }))];
  // The confirmed page decides the verdict; another page failing is reported (it keeps ITS finding open) but never turns the confirmed page's
  // success into a failure, and never turns an unverifiable page into a success.
  return { status: main.status, code: main.code, reasons: main.reasons, checks: main.checks, rendered: main.rendered, pages };
}

export default { inspectRenderedBreadcrumb, verifyRenderedBreadcrumbPage, verifyBreadcrumbRollout };
