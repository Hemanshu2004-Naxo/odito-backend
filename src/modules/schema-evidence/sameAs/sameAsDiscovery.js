/**
 * sameAsDiscovery — finds the organization's own profile links, from sources of decreasing reliability, when a user opens a
 * sameAs finding. Everything it reports was SEEN somewhere (see profileCandidates.js); nothing is invented or guessed.
 *
 *   1. sameAs already declared in the site's own Organization JSON-LD (the stored crawl of every page)
 *   2. organization-level links in the header / footer / contact / about of the home page (fetched live, same site only)
 *   3. other same-site pages — a bounded, prioritised sample (contact, about, pages the crawl saw social links on) plus the crawl's
 *      stored social links, so a profile found on a page that is not re-fetched still counts
 *   4. profiles of accounts the owner connected to this project in Odito
 *
 * Safety: pages are fetched ONLY through fetchRenderedHtml (same host as the page, no cross-site redirects, size and time caps),
 * only when the URL is public HTTPS, and never more than `maxPages` of them. No third-party profile URL is ever requested.
 * One page failing never fails discovery; it is reported under `sources.pages`.
 */

import mongoose from 'mongoose';
import { analyzeSiteEntity } from '../siteEntity.js';
import { flattenJsonLd, hasType, hostOf } from '../schemaGraph.js';
import { fetchRenderedHtml } from '../../external_integration/content/renderedHtml.js';
import { isPubliclyReachableUrl } from '../../../utils/publicUrlCheck.js';
import { extractPageProfiles } from './profileExtraction.js';
import { buildCandidates, pageRoleOf } from './profileCandidates.js';
import { resolveSameAsEntity } from './sameAsEntity.js';

const intEnv = (name, fallback, min, max) => {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
/** Configurable bounds. Read per call so a deployment can tune them without a code change. */
export const discoveryLimits = () => ({
  maxPages: intEnv('SAMEAS_DISCOVERY_MAX_PAGES', 6, 1, 12),
  concurrency: intEnv('SAMEAS_DISCOVERY_CONCURRENCY', 3, 1, 4),
  budgetMs: intEnv('SAMEAS_DISCOVERY_BUDGET_MS', 30_000, 5_000, 120_000),
  cacheTtlMs: intEnv('SAMEAS_DISCOVERY_CACHE_TTL_MS', 300_000, 0, 3_600_000),
  maxCrawlPages: 400,
});

const UTILITY_PATH = /^\/(wp-admin|wp-login|wp-json|wp-content|wp-includes|feed|cart|checkout|my-account|account|login|logout|register|search|tag|author|category|xmlrpc)(\/|\.|$)/i;

const normPage = (url) => { try { const u = new URL(url); u.hash = ''; return `${u.origin}${u.pathname.replace(/\/+$/, '') || '/'}${u.search}`; } catch { return null; } };
const originOf = (url) => { try { return `${new URL(url).origin}/`; } catch { return null; } };

/**
 * Which same-site pages are worth fetching live — a pure, deterministic, bounded choice. The home page always comes first
 * (the header/footer chrome is repeated from there), then contact and about pages, then pages the crawl saw social links on,
 * then the audited page, then the shallowest remaining pages. Anything off-site, non-http(s), parameterised or a utility URL
 * is never chosen.
 */
export function selectDiscoveryPages({ pageUrls = [], crawlLinks = [], targetPageUrl, siteUrl, maxPages = 6 }) {
  const siteHost = hostOf(siteUrl || targetPageUrl);
  const sourceCounts = new Map();
  for (const l of crawlLinks) {
    const n = normPage(l.sourceUrl || '');
    if (n) sourceCounts.set(n, (sourceCounts.get(n) || 0) + 1);
  }
  const seen = new Set();
  const rows = [];
  const consider = (url, extra = 0) => {
    const n = normPage(url);
    if (!n || seen.has(n)) return;
    let u; try { u = new URL(n); } catch { return; }
    if (!['http:', 'https:'].includes(u.protocol) || hostOf(n) !== siteHost) return;
    if (u.search || UTILITY_PATH.test(u.pathname)) return;
    seen.add(n);
    const role = pageRoleOf(n);
    const depth = u.pathname.split('/').filter(Boolean).length;
    const rank = (role === 'home' ? 1000 : 0) + (role === 'contact' ? 700 : 0) + (role === 'about' ? 600 : 0)
      + Math.min(300, (sourceCounts.get(n) || 0) * 40) + extra - depth * 5;
    rows.push({ url, normalized: n, role, rank });
  };
  const origin = originOf(siteUrl || targetPageUrl);
  if (origin) consider(origin);
  for (const url of pageUrls) consider(url);
  if (targetPageUrl) consider(targetPageUrl, 450);
  return rows.sort((a, b) => b.rank - a.rank || a.normalized.localeCompare(b.normalized)).slice(0, maxPages).map(({ url, role }) => ({ url, role }));
}

async function mapLimit(items, limit, fn, deadline) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next; next += 1;
      if (Date.now() > deadline) { results[i] = { skipped: 'budget_exhausted' }; continue; }
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ── default data loaders (project-scoped reads; tests inject their own) ───────────────────────────────────────────

const toObjectId = (id) => { try { return new mongoose.Types.ObjectId(String(id)); } catch { return null; } };

async function loadPages(projectId, { maxCrawlPages }) {
  const pid = toObjectId(projectId);
  const db = mongoose.connection?.db;
  if (!pid || !db) return [];
  return db.collection('seo_page_data').find({ projectId: pid }, { projection: { url: 1, structured_data: 1 } }).limit(maxCrawlPages).toArray();
}

async function loadCrawlLinks(projectId) {
  const pid = toObjectId(projectId);
  const db = mongoose.connection?.db;
  if (!pid || !db) return [];
  return db.collection('seo_social_links').find({ projectId: pid }, { projection: { url: 1, sourceUrl: 1, platform: 1 } }).sort({ discoveredAt: -1 }).limit(300).toArray();
}

/**
 * Profiles of accounts the owner connected to THIS project. A connected Facebook Page has a stable numeric ID, so its profile
 * address is https://www.facebook.com/<id>. Odito stores no profile URL for other connections (Instagram: id only; Google: no
 * profile link), so they cannot be offered — reported in `sources.integrations`, never guessed.
 */
async function loadIntegrationProfiles(projectId) {
  const pid = toObjectId(projectId);
  const db = mongoose.connection?.db;
  if (!pid || !db) return { profiles: [], notes: [] };
  const accounts = await db.collection('socialaccounts').find({ project_id: pid, status: 'active', isActive: true, platform: 'facebook', accountType: 'page' }, { projection: { platformAccountId: 1, platformAccountName: 1, isActive: 1 } }).limit(10).toArray();
  const profiles = accounts.filter((a) => /^\d{5,}$/.test(String(a.platformAccountId || ''))).map((a) => ({
    url: `https://www.facebook.com/${a.platformAccountId}`,
    label: 'Facebook Page connected to this project',
    detail: a.platformAccountName ? `Connected page: ${a.platformAccountName}` : 'Connected Facebook Page',
  }));
  return { profiles, notes: accounts.length ? [] : ['No Facebook Page is connected to this project.'] };
}

const defaultDeps = () => ({
  loadPages, loadCrawlLinks, loadIntegrationProfiles,
  fetchHtml: fetchRenderedHtml,
  isFetchable: isPubliclyReachableUrl,
  now: () => Date.now(),
});

const cache = new Map();
export const clearDiscoveryCache = () => cache.clear();

/** Pseudo-pages carrying only the Organization sameAs each CRAWLED page declared (source 1; no network). */
function schemaOnlyPages(crawlPages) {
  const out = [];
  for (const p of crawlPages) {
    if (!p?.url) continue;
    const orgs = flattenJsonLd(p.structured_data).filter((n) => hasType(n, 'Organization')).map((n) => ({
      id: typeof n['@id'] === 'string' ? n['@id'] : null,
      sameAs: (Array.isArray(n.sameAs) ? n.sameAs : n.sameAs ? [n.sameAs] : []).filter((v) => typeof v === 'string'),
    })).filter((o) => o.sameAs.length);
    if (orgs.length) out.push({ url: p.url, links: [], schema: { organizations: orgs, persons: [] } });
  }
  return out;
}

export const stateOf = ({ candidates, entity }) => {
  const fresh = candidates.filter((c) => c.status !== 'already_present');
  if (!fresh.length) return entity?.state === 'populated' ? 'existing_present' : 'none_found';
  return fresh.some((c) => c.status === 'suggested') ? 'candidates_discovered' : 'needs_confirmation';
};

/**
 * @param {{ projectId: *, pageUrl: string, refresh?: boolean }} input
 * @param {object} [overrides]  injected dependencies (tests)
 */
export async function discoverSameAsProfiles({ projectId, pageUrl, refresh = false }, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const limits = { ...discoveryLimits(), ...(overrides.limits || {}) };
  const cacheKey = `${projectId}|${pageUrl}`;
  const hit = cache.get(cacheKey);
  if (!refresh && hit && deps.now() - hit.at < limits.cacheTtlMs) return { ...hit.value, cached: true };

  const [crawlPages, crawlLinks, integration] = await Promise.all([
    deps.loadPages(projectId, limits).catch(() => []),
    deps.loadCrawlLinks(projectId).catch(() => []),
    deps.loadIntegrationProfiles(projectId).catch(() => ({ profiles: [], notes: ['Connected accounts could not be read.'] })),
  ]);

  const entity = resolveSameAsEntity({ pages: crawlPages, pageUrl });
  const site = analyzeSiteEntity(crawlPages);
  const siteUrl = site.homeUrl || originOf(pageUrl) || pageUrl;

  const selected = selectDiscoveryPages({ pageUrls: crawlPages.map((p) => p.url), crawlLinks, targetPageUrl: pageUrl, siteUrl, maxPages: limits.maxPages });
  const deadline = deps.now() + limits.budgetMs;
  const fetched = await mapLimit(selected, limits.concurrency, async ({ url, role }) => {
    if (!deps.isFetchable(url)) return { url, role, status: 'skipped', reason: 'Only public HTTPS pages are fetched.' };
    try {
      const { html } = await deps.fetchHtml(url, { siteUrl: url });
      return { url, role, status: 'ok', parsed: extractPageProfiles(html, { pageUrl: url }) };
    } catch (error) {
      return { url, role, status: 'failed', reason: error?.message || 'The page could not be fetched.', code: error?.code || null };
    }
  }, deadline);

  const livePages = fetched.map((f, i) => f?.skipped ? { url: selected[i].url, role: selected[i].role, status: 'skipped', reason: 'The time budget for discovery was used up.' } : f);
  const parsedPages = livePages.filter((p) => p.status === 'ok').map((p) => ({ url: p.url, links: p.parsed.links, schema: p.parsed.schema }));

  const organizationNames = [entity.entity?.name, ...parsedPages.flatMap((p) => p.schema.organizations.map((o) => o.name))].filter(Boolean);
  const built = buildCandidates({
    pages: [...schemaOnlyPages(crawlPages), ...parsedPages],
    crawlLinks,
    integrationProfiles: integration.profiles,
    existingSameAs: entity.existing.raw,
    siteUrl,
    organizationNames: [...new Set(organizationNames)],
  });

  const value = {
    generatedAt: new Date(deps.now()).toISOString(),
    pageUrl, siteUrl,
    state: stateOf({ candidates: built.candidates, entity }),
    entity: {
      state: entity.state,
      id: entity.entity?.id || null, types: entity.entity?.types || [], name: entity.entity?.name || null, foundOn: entity.entity?.foundOn || null,
      // The Organization as the site publishes it today: the base of every deterministic JSON-LD patch.
      node: entity.entity?.node || null, hasHomeOrganizationId: !!entity.entity?.hasHomeOrganizationId,
      existing: { urls: entity.existing.raw, invalid: entity.existing.invalid, duplicates: entity.existing.duplicates },
      scope: entity.scope, personSameAsOnly: entity.personSameAsOnly,
    },
    candidates: built.candidates,
    rejected: built.rejected,
    conflicts: built.conflicts,
    ignored: built.ignored,
    sources: {
      schema: { crawledPages: crawlPages.length },
      pages: livePages.map((p) => ({ url: p.url, role: p.role, status: p.status, reason: p.reason || null })),
      crawlSocialLinks: crawlLinks.length,
      integrations: integration.notes.concat(integration.profiles.map((p) => p.detail)),
    },
    limits: { maxPages: limits.maxPages, concurrency: limits.concurrency, budgetMs: limits.budgetMs },
    cached: false,
  };
  if (limits.cacheTtlMs > 0) cache.set(cacheKey, { at: deps.now(), value });
  return value;
}

export default { discoverSameAsProfiles, selectDiscoveryPages, discoveryLimits, stateOf, clearDiscoveryCache };
