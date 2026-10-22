/**
 * breadcrumbDiscovery — finds out what breadcrumb trail a page really has, or can honestly be offered, when a user opens a
 * `breadcrumblist_schema` finding. Orchestration only: extraction (breadcrumbExtraction.js) and classification (breadcrumbTrails.js) are pure.
 *
 * Sources, in order of reliability:
 *   1. the BreadcrumbList JSON-LD the page outputs (the page fetched NOW wins over the stored crawl: a finding can be stale)
 *   2. breadcrumb microdata / the visible breadcrumb navigation of the page
 *   3. the stored crawl records (structured data of every crawled page)
 *   4. the site navigation menu (home page) and same-path parent pages that are shown linking to this page
 *   5. canonical URL and page title — supporting evidence for names and the current-page URL only, never for hierarchy
 *
 * Safety: every fetch goes through fetchRenderedHtml (same host as the page, no cross-site redirects, size/time caps) and only for public
 * HTTPS pages; at most `maxFetches` pages are requested; a failing page never fails discovery; no URL supplied by a client is ever fetched.
 */

import mongoose from 'mongoose';
import { analyzeBreadcrumbs, flattenJsonLd, pickDisplayUrl, samePathIgnoringTrailingSlash } from '../schemaGraph.js';
import { fetchRenderedHtml } from '../../external_integration/content/renderedHtml.js';
import { isPubliclyReachableUrl } from '../../../utils/publicUrlCheck.js';
import { getUserBreadcrumbEvidence } from '../breadcrumbEvidenceStore.js';
import { extractBreadcrumbFacts } from './breadcrumbExtraction.js';
import { classifyBreadcrumbPage, titleWithoutSite, TRAIL_STATUS } from './breadcrumbTrails.js';

const intEnv = (name, fallback, min, max) => {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
export const breadcrumbDiscoveryLimits = () => ({
  maxFetches: intEnv('BREADCRUMB_DISCOVERY_MAX_FETCHES', 5, 1, 10),
  concurrency: intEnv('BREADCRUMB_DISCOVERY_CONCURRENCY', 3, 1, 4),
  budgetMs: intEnv('BREADCRUMB_DISCOVERY_BUDGET_MS', 25_000, 5_000, 90_000),
  cacheTtlMs: intEnv('BREADCRUMB_DISCOVERY_CACHE_TTL_MS', 300_000, 0, 3_600_000),
  maxCrawlPages: 400,
});

const toObjectId = (id) => { try { return new mongoose.Types.ObjectId(String(id)); } catch { return null; } };
const originOf = (url) => { try { return `${new URL(url).origin}/`; } catch { return null; } };
const pathOf = (url) => { try { return new URL(url).pathname.replace(/\/+$/, '') || '/'; } catch { return null; } };

async function mapLimit(items, limit, fn, deadline, now) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next; next += 1;
      if (now() > deadline) { out[i] = { skipped: 'budget_exhausted' }; continue; }
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const defaultDeps = () => ({
  loadPage: async (projectId, pageUrl) => {
    const pid = toObjectId(projectId); const db = mongoose.connection?.db;
    if (!pid || !db) return null;
    return db.collection('seo_page_data').findOne({ projectId: pid, url: pageUrl }, { projection: { url: 1, structured_data: 1, canonical: 1, title: 1 } });
  },
  loadPages: async (projectId, limit) => {
    const pid = toObjectId(projectId); const db = mongoose.connection?.db;
    if (!pid || !db) return [];
    return db.collection('seo_page_data').find({ projectId: pid }, { projection: { url: 1, title: 1, canonical: 1 } }).limit(limit).toArray();
  },
  loadSaved: getUserBreadcrumbEvidence,
  fetchHtml: fetchRenderedHtml,
  isFetchable: isPubliclyReachableUrl,
  now: () => Date.now(),
});

const cache = new Map();
export const clearBreadcrumbDiscoveryCache = () => cache.clear();

/** The label the site's own menu gives a page ("Blog"), or null. */
function menuLabelFor(homeFacts, url) {
  const find = (nodes) => { for (const n of nodes || []) { if (n.url && samePathIgnoringTrailingSlash(n.url, url)) return n.name; const d = find(n.children); if (d) return d; } return null; };
  return find(homeFacts?.navigation);
}

/** Same-path ancestors of `pageUrl` that exist in the crawl, shallowest first. Path alone proves nothing: these are only CANDIDATES to look at. */
export function parentCandidates(pageUrl, crawlPages, max = 3) {
  const p = pathOf(pageUrl);
  if (!p || p === '/') return [];
  const segments = p.split('/').filter(Boolean);
  const wanted = [];
  for (let n = 1; n < segments.length; n += 1) wanted.push(`/${segments.slice(0, n).join('/')}`);
  const out = [];
  wanted.forEach((path, depth) => {
    const hit = (crawlPages || []).find((c) => pathOf(c.url) === path);
    if (hit) out.push({ url: hit.url, depth, title: hit.title || null });
  });
  return out.slice(0, max);
}

/**
 * @param {{ projectId: *, pageUrl: string, refresh?: boolean }} input   pageUrl = the page's crawl identity (seo_page_data.url)
 * @param {object} [overrides]  injected dependencies (tests)
 */
export async function discoverBreadcrumbs({ projectId, pageUrl, refresh = false }, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const limits = { ...breadcrumbDiscoveryLimits(), ...(overrides.limits || {}) };
  const cacheKey = `${projectId}|${pageUrl}`;
  const hit = cache.get(cacheKey);
  if (!refresh && hit && deps.now() - hit.at < limits.cacheTtlMs) return { ...hit.value, cached: true };

  const doc = await deps.loadPage(projectId, pageUrl);
  const display = pickDisplayUrl({ canonical: Array.isArray(doc?.canonical) ? doc.canonical[0] : doc?.canonical, pageUrl });
  const siteRoot = originOf(display.url || pageUrl);
  const crawlBreadcrumbs = analyzeBreadcrumbs(flattenJsonLd(doc?.structured_data), { pageUrl });
  const isHome = !!siteRoot && samePathIgnoringTrailingSlash(display.url || pageUrl, siteRoot) && !new URL(pageUrl).search;

  const crawlPages = await deps.loadPages(projectId, limits.maxCrawlPages).catch(() => []);
  const candidates = isHome ? [] : parentCandidates(pageUrl, crawlPages, 3);
  const deadline = deps.now() + limits.budgetMs;

  // The fetch plan, bounded: the page itself, the home page (menu + home link), then same-path parent candidates.
  const plan = [{ key: 'page', url: pageUrl }];
  if (!isHome && siteRoot) plan.push({ key: 'home', url: siteRoot });
  for (const c of candidates) plan.push({ key: 'parent', url: c.url, candidate: c });
  const fetched = await mapLimit(plan.slice(0, limits.maxFetches), limits.concurrency, async (step) => {
    if (!deps.isFetchable(step.url)) return { ...step, status: 'skipped', reason: 'Only public HTTPS pages are fetched.' };
    try {
      const { html } = await deps.fetchHtml(step.url, { siteUrl: step.url, cacheBust: step.key === 'page' });
      return { ...step, status: 'ok', facts: extractBreadcrumbFacts(html, { pageUrl: step.url }) };
    } catch (error) {
      return { ...step, status: 'failed', reason: error?.message || 'The page could not be fetched.', code: error?.code || null };
    }
  }, deadline, deps.now);
  const results = fetched.map((f, i) => (f?.skipped ? { ...plan[i], status: 'skipped', reason: 'The time budget for discovery was used up.' } : f));
  const byKey = (k) => results.find((r) => r.key === k && r.status === 'ok')?.facts || null;

  const live = byKey('page');
  const homeFacts = isHome ? live : byKey('home');
  const currentForLinks = display.url || pageUrl;
  const parents = results.filter((r) => r.key === 'parent' && r.status === 'ok').map((r) => ({
    url: r.candidate.url, depth: r.candidate.depth, facts: r.facts,
    name: menuLabelFor(homeFacts, r.url) || titleWithoutSite(r.facts.title) || titleWithoutSite(r.candidate.title) || titleWithoutSite(r.facts.h1),
    linksToCurrent: (r.facts.internalLinks || []).some((l) => samePathIgnoringTrailingSlash(l, currentForLinks) || samePathIgnoringTrailingSlash(l, pageUrl)),
  }));

  const classified = isHome
    ? { status: TRAIL_STATUS.NOT_FOUND, trails: [], current: { url: display.url || pageUrl, trusted: display.trusted, name: '' }, existing: { origin: live ? 'live' : 'crawl', count: crawlBreadcrumbs.count, duplicate: false, lists: [] }, conflict: null, notes: ['This is the home page. A breadcrumb trail needs at least one parent page, so a home page normally has none.'], staleFinding: false }
    : classifyBreadcrumbPage({ pageUrl, display, siteRoot, crawlBreadcrumbs, live, homeFacts, parents, pageName: doc?.title || null, crawlPages });

  const saved = await deps.loadSaved(projectId, pageUrl).catch(() => null);
  const value = {
    generatedAt: new Date(deps.now()).toISOString(),
    pageUrl, siteRoot, isHomePage: isHome,
    canonical: { url: display.url, trusted: display.trusted, source: display.source },
    status: classified.status,
    recommended: classified.trails[0] || null,
    trails: classified.trails,
    current: classified.current,
    existing: classified.existing,
    conflict: classified.conflict,
    staleFinding: !!classified.staleFinding,
    notes: classified.notes,
    saved: saved ? { items: saved.items, evidenceHash: saved.evidenceHash, canonicalSource: saved.canonicalSource, submittedAt: saved.submittedAt } : null,
    sources: {
      crawl: { pagesConsidered: crawlPages.length, hasBreadcrumbJsonLd: crawlBreadcrumbs.count > 0 },
      fetched: results.map((r) => ({ key: r.key, url: r.url, status: r.status, reason: r.reason || null })),
      parentCandidates: candidates.map((c) => c.url),
    },
    limits: { maxFetches: limits.maxFetches, concurrency: limits.concurrency, budgetMs: limits.budgetMs },
    cached: false,
  };
  if (limits.cacheTtlMs > 0) cache.set(cacheKey, { at: deps.now(), value });
  return value;
}

/**
 * The state of several pages' own BreadcrumbList, each judged independently from the page fetched NOW (bounded, same-site, concurrent).
 * Used to classify an issue's affected pages and to verify a site-wide change page by page.
 * @returns {Promise<{url: string, status: 'valid'|'missing'|'invalid'|'duplicate'|'unreachable', items: object[], problems: string[], reason: string|null}[]>}
 */
export async function inspectPagesBreadcrumbs({ urls, intended = null }, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const limits = { ...breadcrumbDiscoveryLimits(), ...(overrides.limits || {}) };
  const list = [...new Set(urls || [])].slice(0, overrides.maxPages ?? 40);
  const deadline = deps.now() + limits.budgetMs * 2;
  const out = await mapLimit(list, limits.concurrency, async (url) => {
    if (!deps.isFetchable(url)) return { url, status: 'unreachable', items: [], problems: [], reason: 'Only public HTTPS pages are fetched.' };
    try {
      const { html } = await deps.fetchHtml(url, { siteUrl: url, cacheBust: true });
      const facts = extractBreadcrumbFacts(html, { pageUrl: url });
      const lists = facts.jsonLd.lists;
      const good = lists.filter((l) => !l.problems.length && l.items.length >= 2);
      const status = !lists.length ? 'missing' : lists.length > 1 ? 'duplicate' : good.length ? 'valid' : 'invalid';
      const chosen = good[0] || lists[0] || null;
      return { url, status, items: chosen ? chosen.items.map((i) => ({ position: i.position, name: i.name, url: i.url })) : [], problems: [...new Set(lists.flatMap((l) => l.problems))], reason: null };
    } catch (error) {
      return { url, status: 'unreachable', items: [], problems: [], reason: error?.message || 'The page could not be fetched.' };
    }
  }, deadline, deps.now);
  return out.map((r, i) => (r?.skipped ? { url: list[i], status: 'unreachable', items: [], problems: [], reason: 'The time budget was used up.' } : r));
}

export default { discoverBreadcrumbs, inspectPagesBreadcrumbs, parentCandidates, breadcrumbDiscoveryLimits, clearBreadcrumbDiscoveryCache };
