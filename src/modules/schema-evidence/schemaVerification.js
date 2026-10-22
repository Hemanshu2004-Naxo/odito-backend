/**
 * schemaVerification — decides whether a schema fix is really live and correct, by inspecting
 * the JSON-LD the crawler found on the page AFTER the fix.
 *
 * Why this exists: task verification used to ask only "is the audit finding still open?". The
 * Organization rule stops firing as soon as an Organization with name/url exists, so a pasted
 * schema whose logo returns 404 was reported `verified_fixed`. An issue disappearing is not
 * proof the intended fix is present and correct; this module checks the markup itself.
 *
 *   verified      the deployed markup satisfies every check
 *   failed        the markup was observed and something is wrong (reasons say exactly what)
 *   unverifiable  it cannot be judged right now (page not re-crawled since the fix, no page
 *                 data, an asset that could not be fetched) - the caller must leave the task
 *                 pending; this is never reported as success OR as a failure
 */

import { evidenceKindsFor, buildSchemaEvidence } from './schemaEvidence.js';
import {
  analyzeBreadcrumbs, analyzeOrganizations, flattenJsonLd, isArticleNode, parseSchemaDate,
  resolveHttpUrl, samePathIgnoringTrailingSlash, sameSite, typeSatisfies,
} from './schemaGraph.js';
import { verifyImageUrls } from './imageVerificationClient.js';
import { breadcrumbUrlKey } from './breadcrumbHierarchy.js';
import { pageNeedsEntity } from './schemaIntent.js';
import { ADDRESS_FIELDS, compareFields, formatAddress, normalizePostalAddress } from './organizationAddress.js';
import { typesOf } from './schemaGraph.js';

/**
 * A fingerprint of WHICH structured-data entities a page carries (their @id and types, never their content), taken before a change
 * is applied. After the change the same entities must still be there: ODITO adds an address to ONE entity and must not remove or
 * replace any other. Content is deliberately not compared — dates and counters legitimately change between crawls.
 * @returns {{id: string|null, types: string[]}[]}
 */
export function structuredDataInventory(structuredData) {
  const seen = new Set();
  const out = [];
  for (const n of flattenJsonLd(structuredData)) {
    const entry = { id: typeof n['@id'] === 'string' ? n['@id'] : null, types: typesOf(n).slice().sort() };
    const key = `${entry.id || ''}|${entry.types.join('+')}`;
    if (!seen.has(key) || !entry.id) out.push(entry);
    seen.add(key);
  }
  return out;
}

const inventoryKey = (e) => `${e.id || ''}|${(e.types || []).join('+')}`;

/** Entities that were on the page before and are gone now (an anonymous entity is matched by type, by count). */
export function missingFromInventory(before, after) {
  const have = new Map();
  for (const e of after) have.set(inventoryKey(e), (have.get(inventoryKey(e)) || 0) + 1);
  const missing = [];
  for (const e of before) {
    const k = inventoryKey(e);
    const n = have.get(k) || 0;
    if (n > 0) have.set(k, n - 1); else missing.push(e);
  }
  return missing;
}

export function appliesToVerification(issueKey) {
  return evidenceKindsFor(issueKey).length > 0;
}

const headingsFrom = (doc) => {
  const h = doc?.content?.headings;
  if (h && typeof h === 'object' && !Array.isArray(h)) return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v : [v]]));
  return {};
};

const toDate = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** URLs declared in the deployed markup that must actually serve an image. */
function declaredImageUrls(kind, nodes, pageUrl) {
  const out = [];
  if (kind === 'organization') {
    const { primary } = analyzeOrganizations(nodes, { siteUrl: new URL(pageUrl).origin + '/' });
    const logo = primary?.logo;
    for (const l of (Array.isArray(logo) ? logo : [logo])) {
      const raw = typeof l === 'string' ? l : (l?.url || l?.contentUrl || (l?.['@id'] ? nodes.find((n) => n['@id'] === l['@id'])?.url : null));
      const url = resolveHttpUrl(raw, pageUrl);
      if (url) out.push(url);
    }
  }
  if (kind === 'article') {
    for (const n of nodes.filter(isArticleNode)) {
      for (const i of (Array.isArray(n.image) ? n.image : [n.image])) {
        const url = resolveHttpUrl(typeof i === 'string' ? i : i?.url, pageUrl);
        if (url) out.push(url);
      }
    }
  }
  return [...new Set(out)];
}

/**
 * @param {object} p
 * @param {string} p.issueKey
 * @param {object|null} p.pageDoc        seo_page_data of the page, from the post-fix crawl
 * @param {Date|string|null} p.implementedAt  when the fix was marked implemented / applied
 * @param {{name: string, url: string}[]|null} [p.intendedBreadcrumb]  the hierarchy the owner confirmed for this page
 *        (breadcrumb tasks): the deployed trail must follow the SAME pages in the SAME order, not merely be "a valid trail"
 * @param {{type: string, action: string}|null} [p.intendedOrganization]  the schema intent of the recommendation (organization
 *        tasks): the deployed entity must satisfy the intended type — a Hospital is not satisfied by a generic Organization
 * @param {object|null} [p.site]         analyzeSiteEntity() of the project. When given, a page that needs no standalone entity
 *        (not the homepage, not a location page) is satisfied by the site's entity instead of being demanded its own
 * @param {Function} [p.verifyImages]    injectable (tests)
 * @returns {Promise<{status: 'verified'|'failed'|'unverifiable', kinds: string[], checks: {id: string, ok: boolean, detail: string}[], reasons: string[]}>}
 */
export async function verifySchemaFix({ issueKey, pageDoc, implementedAt = null, intendedBreadcrumb = null, intendedOrganization = null, site = null, verifyImages = verifyImageUrls }) {
  const kinds = evidenceKindsFor(issueKey);
  // `code` says WHY a verdict is unverifiable, so callers can tell "wait for a recrawl" from "cannot be judged":
  //   NO_POST_WRITE_CRAWL / PAGE_NOT_CRAWLED (pending) vs ASSET_UNREACHABLE / NO_INSPECTION (cannot verify).
  const result = (status, checks, reasons, code = null) => ({ status, kinds, checks, reasons, code });
  if (!kinds.length) return result('unverifiable', [], ['This issue type has no schema inspection.'], 'NO_INSPECTION');
  if (!pageDoc || !pageDoc.url) return result('unverifiable', [], ['The page was not found in the latest crawl, so the deployed markup could not be inspected.'], 'PAGE_NOT_CRAWLED');

  const scrapedAt = toDate(pageDoc.scraped_at);
  const implemented = toDate(implementedAt);
  if (scrapedAt && implemented && scrapedAt < implemented) {
    return result('unverifiable', [], ['The page has not been re-crawled since the fix was applied, so the deployed markup could not be inspected.'], 'NO_POST_WRITE_CRAWL');
  }

  const pageUrl = pageDoc.url;
  const nodes = flattenJsonLd(pageDoc.structured_data);
  const evidence = buildSchemaEvidence({ issueId: issueKey, pageUrl, pageData: pageDoc, headingsByTag: headingsFrom(pageDoc), pageType: pageDoc.page_type?.name || pageDoc.page_type || null });
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok, detail });
  const unverifiable = [];

  // Image assets declared in the deployed markup must be real images.
  const imageKinds = kinds.filter((k) => k === 'organization' || k === 'article');
  const imageUrls = imageKinds.flatMap((k) => declaredImageUrls(k, nodes, pageUrl));
  let probes = [];
  if (imageUrls.length) {
    try { probes = await verifyImages(imageUrls); } catch (err) { console.warn(`[SCHEMA_VERIFY] image verification failed: ${err.message}`); }
  }
  const imageCheck = (label, urls) => {
    for (const url of urls) {
      const p = probes.find((x) => x?.url === url);
      if (p?.ok) add(`${label}_url`, true, `${url} is a ${p.format || 'valid'} image${p.width ? ` (${p.width}x${p.height})` : ''}`);
      else if (p?.conclusive) add(`${label}_url`, false, `${url} is not usable: ${p.reason || p.status}`);
      else unverifiable.push(`${label} ${url} could not be fetched right now (${p?.status || 'no result'}), so it could not be confirmed.`);
    }
  };

  if (kinds.includes('organization')) {
    const org = evidence.organization;
    const pageTypeName = pageDoc.page_type?.name || pageDoc.page_type || null;
    if (site && !org.present && !pageNeedsEntity(pageUrl, pageTypeName)) {
      // This page is not where the business entity belongs; the site-level entity is what the finding is about.
      if (site.found) add('organization_site_level', true, `This page needs no standalone entity; the site declares ${site.primary.types.join(' + ')} on ${site.primary.pageUrl}.`);
      else add('organization_present', false, 'No Organization entity (including subtypes) was found on any page of the site.');
    } else {
      add('organization_present', org.present, org.present ? 'An Organization entity is present.' : 'No Organization entity (including subtypes) was found in the deployed markup.');
    }
    if (org.present) {
      if (intendedOrganization?.type && ['generate'].includes(intendedOrganization.action)) {
        const deployed = org.primary.types;
        const ok = deployed.some((t) => typeSatisfies(t, intendedOrganization.type));
        add('organization_type', ok, ok
          ? `The deployed entity is typed ${deployed.join(' + ')}, which satisfies the recommended ${intendedOrganization.type}.`
          : `The deployed entity is typed ${deployed.join(' + ')} but the recommendation was ${intendedOrganization.type}.`);
      }
      if (intendedOrganization?.address && typeof intendedOrganization.address === 'object') {
        // The finding is a missing address. Two separate questions, reported separately:
        //   the detector's own test    does the entity carry an address at all (the rule fires when it is empty)?
        //   the intended value         is it the address that was approved, not some other one?
        const want = intendedOrganization.address;
        const got = normalizePostalAddress(org.primary.node.address);
        add('detector_address_present', !!got, got ? 'The entity now has an address, which is the test the detector applies.' : 'The entity still has no address — the detector will keep reporting the finding.');
        if (got) {
          const { conflicts } = compareFields(want, got.fields);
          const missingParts = ADDRESS_FIELDS.filter((f) => want[f] && !got.fields[f]);
          const ok = got.structured && conflicts.length === 0 && missingParts.length === 0;
          add('organization_address', ok, ok
            ? `The deployed address (${formatAddress(got.fields)}) is the one that was approved.`
            : `The deployed address (${got.formatted}) is not the approved one (${formatAddress(want)})${conflicts.length ? ` — differs in: ${conflicts.join(', ')}` : ''}${missingParts.length ? ` — missing: ${missingParts.join(', ')}` : ''}.`);
        }
      }
      if (Array.isArray(intendedOrganization?.preservedNodes) && intendedOrganization.preservedNodes.length) {
        const gone = missingFromInventory(intendedOrganization.preservedNodes, structuredDataInventory(pageDoc.structured_data));
        add('structured_data_preserved', gone.length === 0, gone.length === 0
          ? 'Every structured-data entity that was on the page before the change is still there.'
          : `Structured data that was on the page before the change is gone: ${gone.map((e) => e.id || e.types.join('+')).join(', ')}.`);
      }
      add('organization_single', !org.conflictingEntities && !org.duplicateIds.length, org.conflictingEntities || org.duplicateIds.length
        ? `The page describes the organization more than once (${org.entityCount} entities${org.duplicateIds.length ? `, duplicate @id: ${org.duplicateIds.map((d) => d.id).join(', ')}` : ''}).` : 'One Organization entity.');
      const node = org.primary.node;
      add('organization_name', !!(typeof node.name === 'string' && node.name.trim()), 'name is present');
      const url = resolveHttpUrl(node.url, pageUrl);
      add('organization_url', !!url && sameSite(url, pageUrl), url ? 'url is a same-site URL' : 'url is missing or not a valid absolute URL');
      imageCheck('logo', declaredImageUrls('organization', nodes, pageUrl));
    }
  }

  if (kinds.includes('breadcrumb')) {
    const crumbs = analyzeBreadcrumbs(nodes, { pageUrl });
    add('breadcrumb_present', crumbs.count > 0, crumbs.count ? 'A BreadcrumbList is present.' : 'No BreadcrumbList was found in the deployed markup.');
    if (crumbs.count) {
      add('breadcrumb_single', !crumbs.duplicateLists, crumbs.duplicateLists ? `${crumbs.count} BreadcrumbList entities - a page should have one.` : 'One BreadcrumbList.');
      const list = crumbs.lists[0];
      add('breadcrumb_items', list.items.length >= 2, `${list.items.length} item(s)`);
      add('breadcrumb_valid', !list.problems.length, list.problems.length ? `Problems: ${list.problems.join(', ')}` : 'Positions, names and URLs are valid.');
      const lastItem = list.items[list.items.length - 1]; // Google allows the final item to omit its URL (it is the page itself)
      const display = evidence.url.display;
      if (lastItem?.url && display) {
        add('breadcrumb_current_page', samePathIgnoringTrailingSlash(lastItem.url, display), `last item ${lastItem.url} vs page ${display}`);
      }
      if (Array.isArray(intendedBreadcrumb) && intendedBreadcrumb.length >= 2) {
        // A trail with a valid structure is not necessarily THE trail the owner confirmed. A final item without its own
        // URL (allowed by Google) stands for the page itself.
        const found = list.items.map((i, n) => (i.url || (n === list.items.length - 1 ? display : null)));
        const wanted = intendedBreadcrumb.map((i) => i.url);
        const same = found.length === wanted.length && found.every((u, n) => u && breadcrumbUrlKey(u) === breadcrumbUrlKey(wanted[n]));
        add('breadcrumb_matches_intended', same, same
          ? 'The deployed trail follows the hierarchy you confirmed.'
          : `The deployed trail differs from the hierarchy you confirmed. Expected: ${wanted.join(' > ')}. Found: ${found.map((u) => u || '(no URL)').join(' > ')}.`);
      }
    }
  }

  if (kinds.includes('article')) {
    const articles = nodes.filter(isArticleNode);
    add('article_present', articles.length > 0, articles.length ? 'Article markup is present.' : 'No Article/BlogPosting entity was found in the deployed markup.');
    if (articles.length) {
      add('article_single', articles.length === 1, articles.length === 1 ? 'One Article entity.' : `${articles.length} Article entities on one page.`);
      // Applicability is judged WITHOUT the Article markup under test (its presence would make any page "an article").
      const withoutArticle = buildSchemaEvidence({
        issueId: issueKey, pageUrl, pageType: pageDoc.page_type?.name || pageDoc.page_type || null, headingsByTag: headingsFrom(pageDoc),
        pageData: { ...pageDoc, structured_data: nodes.filter((n) => !isArticleNode(n)) },
      });
      add('article_applicable', withoutArticle.article.applicable, withoutArticle.article.applicable ? 'The page is an article.' : `Article markup is on a page that is not an article: ${withoutArticle.article.reason}`);
      const a = articles[0];
      add('article_headline', typeof a.headline === 'string' && !!a.headline.trim(), 'headline is present');
      const pub = parseSchemaDate(String(a.datePublished ?? ''));
      const mod = parseSchemaDate(String(a.dateModified ?? ''));
      add('article_datePublished', pub.valid, pub.valid ? 'datePublished is a valid ISO 8601 date.' : `datePublished is missing or invalid (${pub.reason}).`);
      add('article_dateModified', mod.valid, mod.valid ? 'dateModified is a valid ISO 8601 date.' : `dateModified is missing or invalid (${mod.reason}).`);
      if (pub.valid && mod.valid) add('article_date_order', mod.epochMs >= pub.epochMs, mod.epochMs >= pub.epochMs ? 'dateModified is not before datePublished.' : 'dateModified is earlier than datePublished.');
      imageCheck('article_image', declaredImageUrls('article', nodes, pageUrl));
    }
  }

  const failed = checks.filter((c) => !c.ok);
  if (failed.length) return result('failed', checks, failed.map((c) => c.detail));
  if (unverifiable.length) return result('unverifiable', checks, unverifiable, 'ASSET_UNREACHABLE');
  return result('verified', checks, []);
}

export default { verifySchemaFix, appliesToVerification };
