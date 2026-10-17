/**
 * breadcrumbExtraction — what ONE already-fetched page says about its own breadcrumb trail and its site navigation. Pure (HTML in,
 * facts out); it never fetches and never decides what is trustworthy (breadcrumbTrails.js does).
 *
 * Reads, in order of how much the markup can be trusted:
 *   - JSON-LD BreadcrumbList (every block; @graph and arrays)         the page's own structured data
 *   - microdata / RDFa BreadcrumbList (itemtype / typeof)             structured, in the visible markup
 *   - the visible breadcrumb navigation (aria-label, common plugin / theme classes: Rank Math, Yoast, WooCommerce, generic)
 *   - the site's primary navigation as a tree (header menu with sub-menus)  evidence about parents, never proof of a trail
 *
 * Items keep their absolute same-page-resolved URL (or null when the item is not a link, such as the current page or a "#" menu
 * parent), exactly as written: nothing is normalised, re-cased or invented here.
 */

import * as cheerio from 'cheerio';
import { analyzeBreadcrumbs, flattenJsonLd, resolveHttpUrl } from '../schemaGraph.js';

const clean = (v, max = 200) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);

const CRUMB_SELECTORS = [
  'nav[aria-label*="readcrumb" i]', '[aria-label*="readcrumb" i]', '.rank-math-breadcrumb', '.yoast-breadcrumbs', '#breadcrumbs', '.woocommerce-breadcrumb',
  'ol.breadcrumb', 'ul.breadcrumb', '.breadcrumbs', '.breadcrumb', '#et-breadcrumbs', '[class*="breadcrumb" i]', '[id*="breadcrumb" i]',
].join(',');

const NAV_SELECTORS = [
  '#top-menu-nav', '#et-top-navigation nav', '#main-header nav', 'header nav', '[role="banner"] nav', '.main-navigation', '.primary-menu',
  '.menu-primary', 'header ul.menu', 'nav.navbar', 'nav[role="navigation"]', 'nav',
];

const SEPARATOR_ONLY = /^[\s>»›/|\\\-–—•·:]+$/;

const linkOf = ($el, base) => {
  const href = ($el.attr('href') || '').trim();
  if (!href || href === '#' || /^(javascript|mailto|tel):/i.test(href)) return null;
  return resolveHttpUrl(href, base);
};

/** The items of ONE breadcrumb container: <li> entries when it has them, else its links followed by the trailing plain text. */
function itemsOfContainer($, el, base) {
  const out = [];
  const lis = $(el).find('li').toArray();
  if (lis.length >= 2) {
    for (const li of lis) {
      // A nested <li> belongs to its parent entry only once: skip entries that contain another breadcrumb <li>.
      if ($(li).find('li').length) continue;
      const a = $(li).find('a[href]').first();
      const name = clean(a.length ? a.text() : $(li).text());
      if (!name || SEPARATOR_ONLY.test(name)) continue;
      out.push({ name, url: a.length ? linkOf(a, base) : null, current: !a.length || $(li).is('[aria-current]') || $(li).find('[aria-current]').length > 0 });
    }
    return out;
  }
  const anchors = $(el).find('a[href]').toArray();
  for (const a of anchors) {
    const name = clean($(a).text());
    if (name && !SEPARATOR_ONLY.test(name)) out.push({ name, url: linkOf($(a), base), current: false });
  }
  // The last item is normally not a link: the text after the final link/separator.
  const full = clean($(el).text(), 600);
  const lastLinkName = out.length ? out[out.length - 1].name : '';
  const tail = lastLinkName ? full.slice(full.lastIndexOf(lastLinkName) + lastLinkName.length) : full;
  const tailName = clean(tail.replace(/^[\s>»›/|\\\-–—•·:]+/, '').split(/[>»›|]/)[0]);
  if (tailName && !SEPARATOR_ONLY.test(tailName) && !out.some((i) => i.name === tailName)) out.push({ name: tailName, url: null, current: true });
  return out;
}

function schemaMicrodata($, base) {
  const out = [];
  $('[itemtype$="BreadcrumbList"], [typeof$="BreadcrumbList"]').each((_, root) => {
    const items = [];
    $(root).find('[itemprop="itemListElement"], [property="itemListElement"]').each((__, el) => {
      const link = $(el).find('[itemprop="item"][href], a[itemprop="item"], [itemprop="url"][href], a[href]').first();
      const nameEl = $(el).find('[itemprop="name"], [property="name"]').first();
      const name = clean(nameEl.length ? nameEl.text() : $(el).text());
      const href = link.length ? (link.attr('href') || link.attr('content') || link.attr('itemid') || '') : ($(el).find('[itemprop="item"]').attr('content') || '');
      if (name) items.push({ name, url: href ? resolveHttpUrl(href.trim(), base) : null, current: !href });
    });
    if (items.length) out.push({ source: 'microdata', items });
  });
  return out;
}

/** The primary navigation as a tree: [{ name, url|null, children: [...] }]. null when no menu with links is found. */
function navigationTree($, base) {
  let best = null; let bestLinks = 0;
  for (const sel of NAV_SELECTORS) {
    $(sel).each((_, el) => {
      const n = $(el).find('a[href]').length;
      if (n > bestLinks && n <= 400) { best = el; bestLinks = n; }
    });
    if (best && bestLinks >= 3) break;
  }
  if (!best) return null;
  const root = $(best).is('ul, ol') ? $(best) : $(best).find('ul, ol').first();
  if (!root.length) return null;
  const walk = (list, depth) => list.children('li').toArray().map((li) => {
    const a = $(li).children('a[href]').first().length ? $(li).children('a[href]').first() : $(li).find('a[href]').first();
    const name = clean(a.text() || $(li).children('span').first().text());
    // A sub-menu is a direct <ul>, or one wrapped in a <div> (mega-menus). Depth is bounded.
    const direct = $(li).children('ul, ol').first();
    const wrapped = direct.length ? direct : $(li).children('div').children('ul, ol').first();
    const subList = depth < 5 && wrapped.length ? wrapped : null;
    return { name, url: a.length ? linkOf(a, base) : null, children: subList ? walk(subList, depth + 1) : [] };
  }).filter((n) => n.name);
  const tree = walk(root, 0);
  return tree.length ? tree : null;
}

/**
 * @param {string} html
 * @param {{ pageUrl: string }} options
 * @returns {{
 *   jsonLd: { count: number, lists: {id: string|null, items: object[], problems: string[]}[], blocks: number, errors: number },
 *   microdata: {source: string, items: object[]}[],
 *   dom: {source: 'dom', items: {name: string, url: string|null, current: boolean}[]}[],
 *   navigation: object[]|null,
 *   internalLinks: string[],
 *   h1: string|null, title: string|null, canonical: string|null
 * }}
 */
export function extractBreadcrumbFacts(html, { pageUrl } = {}) {
  const $ = cheerio.load(String(html || ''));

  const blocks = $('script[type="application/ld+json"]').toArray();
  const values = []; let errors = 0;
  for (const el of blocks) { try { values.push(JSON.parse($(el).contents().text())); } catch { errors += 1; } }
  const crumbs = analyzeBreadcrumbs(flattenJsonLd(values), { pageUrl });

  // Visible breadcrumb containers: only the OUTERMOST match counts (a ".breadcrumb" inside a ".breadcrumbs" is the same trail).
  const containers = $(CRUMB_SELECTORS).toArray().filter((el) => !$(el).parents(CRUMB_SELECTORS).length && !$(el).closest('script, style, noscript').length);
  const dom = [];
  for (const el of containers) {
    const items = itemsOfContainer($, el, pageUrl);
    if (items.length >= 2) dom.push({ source: 'dom', items });
  }

  const title = clean($('title').first().text(), 200) || null;
  // Absolute http(s) links on the page (bounded): lets a caller check whether THIS page links to another one.
  const internalLinks = [];
  const seenLinks = new Set();
  $('a[href]').each((_, a) => {
    if (internalLinks.length >= 1500) return;
    const u = linkOf($(a), pageUrl);
    if (u && !seenLinks.has(u)) { seenLinks.add(u); internalLinks.push(u); }
  });
  return {
    jsonLd: { count: crumbs.count, lists: crumbs.lists, blocks: blocks.length, errors },
    microdata: schemaMicrodata($, pageUrl),
    dom,
    navigation: navigationTree($, pageUrl),
    internalLinks,
    h1: clean($('h1').first().text(), 200) || null,
    title,
    canonical: resolveHttpUrl($('link[rel="canonical"]').attr('href') || '', pageUrl),
  };
}

export default { extractBreadcrumbFacts };
