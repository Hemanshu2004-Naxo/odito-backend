/**
 * breadcrumbTrails — turns what pages say (breadcrumbExtraction.js facts) into honest, classified breadcrumb TRAILS for one page. Pure:
 * no network, no database, no clock.
 *
 * Trail statuses (per trail):
 *   already_valid  the page already outputs a valid BreadcrumbList (JSON-LD). Nothing to generate; a finding for it is stale.
 *   verified       a trail the page itself shows in reliable markup (microdata / a visible breadcrumb navigation) with a URL for every
 *                  parent. It is reused as is; the owner still confirms once before anything is generated.
 *   suggested      inferred from supporting evidence (the site's navigation menu, or a parent page that links to this page). It is only
 *                  ever a SUGGESTION: the owner confirms or corrects it.
 *   incomplete     only some parents are known (for example a menu heading without a page behind it). The missing URL is asked for.
 *   not_found      nothing reliable was found.
 *
 * Page-level `status` is the best trail's status, or `conflict` when the page outputs a BreadcrumbList that is invalid / duplicated
 * (generating another would create a second entity, so nothing is offered).
 *
 * What is NEVER treated as proof of a hierarchy: a URL path (`/blog/post` does not make `/blog` its parent), a page title, the
 * existence of a crawled page. A path-prefix page counts only when it is ALSO shown linking to the page.
 *
 * Every URL here is absolute, same-site, credential-free and https when the page is https; anything else is dropped, never repaired
 * into something the page did not say.
 */

import { sameSite, samePathIgnoringTrailingSlash, stripTrackingParams } from '../schemaGraph.js';
import { breadcrumbUrlKey } from '../breadcrumbHierarchy.js';

export const TRAIL_STATUS = Object.freeze({ ALREADY_VALID: 'already_valid', VERIFIED: 'verified', SUGGESTED: 'suggested', INCOMPLETE: 'incomplete', NOT_FOUND: 'not_found' });
const RANK = { already_valid: 0, verified: 1, suggested: 2, incomplete: 3, not_found: 4 };

const norm = (s) => String(s || '').toLowerCase().replace(/&amp;/g, '&').replace(/[^a-z0-9]+/g, ' ').trim();

/** Do two labels plausibly name the same page? (equal, one contains the other, or most words in common). Lenient on purpose: used only to
 *  WARN, never to accept or reject a trail on its own. */
export function labelsMatch(a, b) {
  const x = norm(a); const y = norm(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const tx = new Set(x.split(' ').filter((t) => t.length > 2)); const ty = y.split(' ').filter((t) => t.length > 2);
  if (!tx.size || !ty.length) return false;
  return ty.filter((t) => tx.has(t)).length / Math.max(tx.size, ty.length) >= 0.5;
}

/** A page title without its trailing " | Site name" / " - Site name" part. */
export function titleWithoutSite(title) {
  const t = String(title || '').trim();
  if (!t) return '';
  const parts = t.split(/\s+[|–—-]\s+/);
  return (parts[0] || t).trim();
}

const originOf = (url) => { try { return `${new URL(url).origin}/`; } catch { return null; } };

/** An item URL the trail may publish: same site, https when the page is https, no tracking parameters, no credentials, no fragment. */
function acceptUrl(raw, { siteRoot, httpsRequired }) {
  if (!raw || typeof raw !== 'string') return { url: null };
  let u;
  try { u = new URL(raw); } catch { return { url: null, why: 'not a valid URL' }; }
  if (!['http:', 'https:'].includes(u.protocol)) return { url: null, why: 'not a web address' };
  if (u.username || u.password) return { url: null, why: 'contains credentials' };
  if (!sameSite(u.href, siteRoot)) return { url: null, why: 'is on another website' };
  let upgraded = false;
  if (httpsRequired && u.protocol === 'http:') { u.protocol = 'https:'; upgraded = true; }
  u.hash = '';
  const cleaned = stripTrackingParams(u.href) || u.href;
  return { url: cleaned, upgraded };
}

const pageKey = (url) => breadcrumbUrlKey(url);

function trail(source, status, items, extra = {}) {
  return { source, status, items, evidence: [], warnings: [], ...extra };
}

/** Make sure every item has the shape the UI and the validator expect. */
const item = (name, url, origin, extra = {}) => ({ name: String(name || '').trim(), url: url || null, origin, needsUrl: !url, needsConfirmation: false, evidence: null, ...extra });

// ── trails from the page's own markup ────────────────────────────────────────────────────────────────────────────

function trailFromMarkup(group, ctx) {
  const { current, siteRoot, httpsRequired } = ctx;
  const raw = group.items;
  const items = [];
  const dropped = [];
  raw.forEach((it, i) => {
    const last = i === raw.length - 1;
    if (last) return;
    const acc = acceptUrl(it.url, { siteRoot, httpsRequired });
    if (it.url && !acc.url) dropped.push(`${it.name} (${acc.why})`);
    items.push(item(it.name, acc.url, 'markup', { evidence: group.source === 'microdata' ? 'Declared in the page\'s breadcrumb microdata.' : 'Shown in the breadcrumb navigation on the page.' }));
  });
  const lastRaw = raw[raw.length - 1];
  const nameMatches = labelsMatch(lastRaw.name, current.h1) || labelsMatch(lastRaw.name, titleWithoutSite(current.title)) || labelsMatch(lastRaw.name, current.name);
  items.push(item(lastRaw.name || current.name, current.url, 'current', { needsUrl: !current.url, evidence: 'The last item is this page.' }));
  const missing = items.slice(0, -1).filter((i) => !i.url);
  const status = items.length < 2 ? TRAIL_STATUS.NOT_FOUND : missing.length ? TRAIL_STATUS.INCOMPLETE : (nameMatches ? TRAIL_STATUS.VERIFIED : TRAIL_STATUS.SUGGESTED);
  const t = trail(group.source, status, items);
  t.evidence.push(group.source === 'microdata' ? 'The page declares this trail in microdata.' : 'The page shows this breadcrumb navigation.');
  if (!nameMatches && lastRaw.name) t.warnings.push(`The last item says "${lastRaw.name}", which does not clearly match this page ("${current.h1 || titleWithoutSite(current.title) || current.name}"). Check it before using it.`);
  if (dropped.length) t.warnings.push(`Left out of the trail: ${dropped.join('; ')}.`);
  return t;
}

// ── trail from the site navigation ───────────────────────────────────────────────────────────────────────────────

/** Path of nodes from the menu root to the page, or null. Only a node whose own link IS this page counts. */
function navigationPath(tree, targetUrl) {
  const walk = (nodes, trailSoFar) => {
    for (const n of nodes) {
      const here = [...trailSoFar, n];
      if (n.url && samePathIgnoringTrailingSlash(n.url, targetUrl)) return here;
      const deeper = walk(n.children || [], here);
      if (deeper) return deeper;
    }
    return null;
  };
  return Array.isArray(tree) ? walk(tree, []) : null;
}

function trailFromNavigation(ctx) {
  const { navigation, current, siteRoot, httpsRequired, homeName, homeLinked } = ctx;
  if (!navigation) return null;
  const path = navigationPath(navigation, current.url) || (current.pathUrl ? navigationPath(navigation, current.pathUrl) : null);
  if (!path) return null;
  // A menu heading that only repeats the name of the entry below it ("Pay Per Click" > "Pay Per Click") adds nothing: dropped.
  const chain = path.filter((n, i) => !(i < path.length - 1 && !n.url && norm(n.name) === norm(path[i + 1].name)));
  const items = [];
  const rootNav = chain[0] && chain[0].url && samePathIgnoringTrailingSlash(chain[0].url, siteRoot);
  if (!rootNav) {
    // The home page as the first crumb is a convention, not something the menu proves: offered, and flagged for confirmation.
    items.push(item(homeName || 'Home', siteRoot, 'home', {
      needsConfirmation: true,
      evidence: homeLinked ? 'The site\'s home page is linked from the header. Most breadcrumb trails start there — confirm it.' : 'The site root is the usual first breadcrumb — confirm it.',
    }));
  }
  for (const node of chain.slice(0, -1)) {
    const acc = acceptUrl(node.url, { siteRoot, httpsRequired });
    items.push(item(node.name, acc.url, 'navigation', {
      evidence: acc.url ? 'A parent of this page in the site menu.' : 'A menu heading above this page. It has no page of its own, so a URL is needed to use it (or remove it).',
    }));
  }
  items.push(item(current.name, current.url, 'current', { evidence: 'This page.' }));
  const missing = items.slice(0, -1).filter((i) => !i.url);
  const t = trail('navigation', missing.length ? TRAIL_STATUS.INCOMPLETE : TRAIL_STATUS.SUGGESTED, items);
  t.evidence.push(`This page is in the site's navigation menu${path.length > 1 ? ` under ${chain.slice(0, -1).map((n) => n.name).join(' › ')}` : ' as a top-level item'}.`);
  if (missing.length) t.warnings.push(`${missing.map((m) => m.name).join(', ')} ${missing.length === 1 ? 'has' : 'have'} no page URL in the menu, so Odito cannot link ${missing.length === 1 ? 'it' : 'them'}.`);
  return t;
}

// ── trail from a parent page that links to this page ────────────────────────────────────────────────────────────

function trailFromParentLinks(ctx) {
  const { parents, current, siteRoot, httpsRequired, homeName, homeLinked } = ctx;
  const found = [];
  for (const p of parents || []) {
    if (!p?.facts || !p.url) continue;
    if (samePathIgnoringTrailingSlash(p.url, current.url)) continue;
    if (!p.linksToCurrent) continue;
    const acc = acceptUrl(p.url, { siteRoot, httpsRequired });
    if (!acc.url) continue;
    found.push({ name: p.name || titleWithoutSite(p.facts.title) || p.facts.h1, url: acc.url, depth: p.depth ?? 0 });
  }
  if (!found.length) return null;
  found.sort((a, b) => a.depth - b.depth); // shallowest (closest to the root) first
  const items = [item(homeName || 'Home', siteRoot, 'home', {
    needsConfirmation: true,
    evidence: homeLinked ? 'The site\'s home page is linked from the header. Most breadcrumb trails start there — confirm it.' : 'The site root is the usual first breadcrumb — confirm it.',
  })];
  for (const f of found) items.push(item(f.name, f.url, 'link', { evidence: `This page is linked from ${f.url}.` }));
  items.push(item(current.name, current.url, 'current', { evidence: 'This page.' }));
  const t = trail('internal_links', items.slice(0, -1).some((i) => !i.name) ? TRAIL_STATUS.INCOMPLETE : TRAIL_STATUS.SUGGESTED, items);
  t.evidence.push(`${found.map((f) => f.url).join(', ')} ${found.length === 1 ? 'is' : 'are'} on the same path as this page and link${found.length === 1 ? 's' : ''} to it.`);
  return t;
}

/**
 * An item with no URL (a menu heading) may have a page of its own: a CRAWLED same-site page whose title is exactly that heading. It is
 * offered as a suggestion the owner can accept — the item stays "needs a URL" until they do, and nothing is chosen on their behalf.
 */
function attachUrlSuggestions(t, { crawlPages, current, siteRoot, httpsRequired }) {
  for (const it of t.items) {
    if (it.url || it.origin === 'current' || !it.name) continue;
    const matches = (crawlPages || []).filter((p) => p?.url && norm(titleWithoutSite(p.title)) === norm(it.name) && !samePathIgnoringTrailingSlash(p.url, current.url));
    if (matches.length !== 1) continue;
    const acc = acceptUrl(matches[0].canonical || matches[0].url, { siteRoot, httpsRequired });
    if (acc.url) it.urlSuggestion = { url: acc.url, evidence: `A page on your site is titled "${titleWithoutSite(matches[0].title)}".` };
  }
}

// ── the whole page ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} p
 * @param {string} p.pageUrl            the crawl identity of the audited page
 * @param {{url: string|null, trusted: boolean}} p.display   the URL a breadcrumb must use for this page (canonical when verified)
 * @param {string} p.siteRoot           the site's root URL ("https://host/")
 * @param {object|null} p.crawlBreadcrumbs   analyzeBreadcrumbs() of the STORED crawl JSON-LD
 * @param {object|null} p.live          extractBreadcrumbFacts() of the page fetched now, or null when it could not be fetched
 * @param {object|null} p.homeFacts     extractBreadcrumbFacts() of the home page (for the menu and the home link), or null
 * @param {{url: string, name?: string, depth?: number, facts: object, linksToCurrent: boolean}[]} [p.parents]  fetched same-path parents
 * @param {string|null} [p.pageName]    fallback page name (the crawl's title)
 */
export function classifyBreadcrumbPage({ pageUrl, display, siteRoot, crawlBreadcrumbs = null, live = null, homeFacts = null, parents = [], pageName = null, crawlPages = [] }) {
  const httpsRequired = /^https:/i.test(display?.url || pageUrl || '');
  const facts = live || null;
  const url = display?.url || pageUrl;
  const name = (facts?.h1) || titleWithoutSite(facts?.title) || titleWithoutSite(pageName) || '';
  const current = { url, trusted: !!display?.trusted, name, h1: facts?.h1 || null, title: facts?.title || pageName || null, pathUrl: pageUrl };
  const homeLinked = !!(homeFacts?.navigation || []).length || false;
  const homeName = (() => {
    const first = (homeFacts?.navigation || []).find((n) => n.url && samePathIgnoringTrailingSlash(n.url, siteRoot));
    return first?.name || null;
  })();
  const ctx = { current, siteRoot, httpsRequired, navigation: homeFacts?.navigation || facts?.navigation || null, homeName, homeLinked, parents };

  // What the page outputs as JSON-LD: the page fetched now wins over the (possibly older) stored crawl.
  const jsonLd = facts ? facts.jsonLd : (crawlBreadcrumbs ? { count: crawlBreadcrumbs.count, lists: crawlBreadcrumbs.lists } : { count: 0, lists: [] });
  const origin = facts ? 'live' : 'crawl';
  const existing = {
    origin, count: jsonLd.count, duplicate: jsonLd.count > 1,
    lists: (jsonLd.lists || []).map((l) => ({ id: l.id || null, itemCount: l.items.length, problems: l.problems, items: l.items.map((i) => ({ position: i.position, name: i.name, url: i.url })) })),
  };
  const valid = (jsonLd.lists || []).filter((l) => !l.problems.length && l.items.length >= 2);

  const notes = [];
  if (facts?.jsonLd?.errors) notes.push(`${facts.jsonLd.errors} JSON-LD block${facts.jsonLd.errors === 1 ? '' : 's'} on the page could not be parsed.`);
  if (!facts) notes.push('The live page could not be fetched, so only the stored crawl was used.');

  // 1. a valid BreadcrumbList already exists
  if (valid.length === 1 && jsonLd.count === 1) {
    const l = valid[0];
    const items = l.items.map((i, n) => item(i.name, i.url || (n === l.items.length - 1 ? current.url : null), 'markup', { needsUrl: false, evidence: 'Already in the page\'s BreadcrumbList structured data.' }));
    const staleVsCrawl = !!(facts && crawlBreadcrumbs && crawlBreadcrumbs.count === 0);
    const t = trail('json_ld', TRAIL_STATUS.ALREADY_VALID, items);
    t.evidence.push(staleVsCrawl ? 'The live page outputs a valid BreadcrumbList that the stored crawl did not contain — the finding is out of date.' : 'The page already outputs a valid BreadcrumbList.');
    return { status: TRAIL_STATUS.ALREADY_VALID, trails: [t], current, existing, conflict: null, notes, staleFinding: staleVsCrawl || origin === 'live' };
  }

  // 2. a BreadcrumbList exists but is invalid or there are several: another one would duplicate the entity
  if (jsonLd.count > 0) {
    const kind = jsonLd.count > 1 ? (valid.length ? 'multiple_lists' : 'multiple_invalid') : 'existing_invalid';
    const problems = [...new Set((jsonLd.lists || []).flatMap((l) => l.problems))];
    return { status: 'conflict', trails: [], current, existing, conflict: { kind, problems }, notes, staleFinding: false };
  }

  // 3. nothing in JSON-LD: collect trails from the page and from supporting evidence
  const trails = [];
  for (const g of [...(facts?.microdata || []), ...(facts?.dom || [])]) {
    const t = trailFromMarkup(g, ctx);
    if (t.status !== TRAIL_STATUS.NOT_FOUND) trails.push(t);
  }
  const nav = trailFromNavigation(ctx);
  if (nav) trails.push(nav);
  const links = trailFromParentLinks(ctx);
  if (links) trails.push(links);

  // The same trail from two sources is one trail with both pieces of evidence.
  const merged = [];
  for (const t of trails) {
    const key = t.items.map((i) => pageKey(i.url || '') || `~${norm(i.name)}`).join('>');
    const same = merged.find((m) => m.__key === key);
    if (same) { same.evidence.push(...t.evidence); same.sources = [...(same.sources || [same.source]), t.source]; if (RANK[t.status] < RANK[same.status]) same.status = t.status; continue; }
    merged.push({ ...t, __key: key, sources: [t.source] });
  }
  merged.sort((a, b) => RANK[a.status] - RANK[b.status] || (b.items.length - a.items.length));
  for (const m of merged) { delete m.__key; attachUrlSuggestions(m, { crawlPages, current, siteRoot, httpsRequired }); }

  const best = merged[0] || null;
  return { status: best ? best.status : TRAIL_STATUS.NOT_FOUND, trails: merged, current, existing, conflict: null, notes, staleFinding: false };
}

export default { classifyBreadcrumbPage, labelsMatch, titleWithoutSite, TRAIL_STATUS };
