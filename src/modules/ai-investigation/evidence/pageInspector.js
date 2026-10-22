/**
 * pageInspector — turns HTML into a bounded, category-agnostic set of page facts.
 *
 * Pure (no I/O). Every list is capped so the result can be sent to a model without dumping the page.
 * Nothing is inferred beyond what the markup says; absent things are reported as absent/empty, never guessed.
 * All strings come from an untrusted page and are only ever passed on as DATA.
 */

import * as cheerio from 'cheerio';

const CAP = Object.freeze({ headings: 40, jsonLdBytes: 6000, jsonLdBlocks: 12, images: 25, navLinks: 60, breadcrumbItems: 12, a11y: 15, text: 300 });

const clean = (value, max = CAP.text) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function absolute(href, base) {
  try {
    const u = new URL(href, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch { return null; }
}

/** Collects @type values from a parsed JSON-LD value, walking @graph and nested objects. */
export function collectJsonLdTypes(node, out = new Set(), depth = 0) {
  if (!node || depth > 8) return out;
  if (Array.isArray(node)) { node.forEach((n) => collectJsonLdTypes(n, out, depth + 1)); return out; }
  if (typeof node !== 'object') return out;
  const t = node['@type'];
  if (typeof t === 'string') out.add(t);
  else if (Array.isArray(t)) t.filter((x) => typeof x === 'string').forEach((x) => out.add(x));
  for (const value of Object.values(node)) if (value && typeof value === 'object') collectJsonLdTypes(value, out, depth + 1);
  return out;
}

const DOC_BUDGET = 400_000; // total serialized characters of full documents kept for server-side analyzers

function readJsonLd($, docs = []) {
  const blocks = [];
  let used = 0;
  $('script[type="application/ld+json"]').each((index, el) => {
    if (index >= CAP.jsonLdBlocks) return;
    const raw = $(el).contents().text();
    try {
      const parsed = JSON.parse(raw);
      const text = JSON.stringify(parsed);
      if (used + text.length <= DOC_BUDGET) { docs.push(parsed); used += text.length; }
      blocks.push({
        index, valid: true, types: [...collectJsonLdTypes(parsed)], scriptClass: clean($(el).attr('class') || '', 120) || null,
        truncated: text.length > CAP.jsonLdBytes,
        json: text.length > CAP.jsonLdBytes ? null : parsed,
        preview: text.slice(0, CAP.jsonLdBytes),
      });
    } catch (error) {
      blocks.push({ index, valid: false, types: [], scriptClass: clean($(el).attr('class') || '', 120) || null, parseError: clean(error.message, 120), preview: clean(raw, 400) });
    }
  });
  return blocks;
}

function breadcrumbListSummary(blocks) {
  const lists = [];
  const visit = (node, blockIndex, depth = 0) => {
    if (!node || depth > 8) return;
    if (Array.isArray(node)) return node.forEach((n) => visit(n, blockIndex, depth + 1));
    if (typeof node !== 'object') return;
    const types = [].concat(node['@type'] || []);
    if (types.includes('BreadcrumbList')) {
      const items = [].concat(node.itemListElement || []).map((el) => ({
        position: el?.position ?? null,
        name: clean(el?.name ?? el?.item?.name ?? ''),
        url: typeof el?.item === 'string' ? el.item : (el?.item?.['@id'] || el?.item?.url || el?.['@id'] || null),
      }));
      lists.push({ blockIndex, itemCount: items.length, items: items.slice(0, CAP.breadcrumbItems) });
    }
    Object.values(node).forEach((v) => v && typeof v === 'object' && visit(v, blockIndex, depth + 1));
  };
  blocks.forEach((b) => b.valid && b.json && visit(b.json, b.index));
  return lists;
}

function visibleBreadcrumbs($, base) {
  const selectors = [
    'nav[aria-label*="readcrumb" i]', '[class*="breadcrumb" i]', '[id*="breadcrumb" i]',
    'ol[itemtype*="BreadcrumbList"]', 'ul[itemtype*="BreadcrumbList"]', '[typeof="BreadcrumbList"]',
  ];
  const found = []; const seen = new Set();
  for (const sel of selectors) {
    $(sel).each((_, el) => {
      if (seen.has(el) || found.length >= 3) return;
      seen.add(el);
      const items = $(el).find('a, [aria-current], li > span').map((__, a) => ({
        name: clean($(a).text(), 120),
        url: $(a).attr('href') ? absolute($(a).attr('href'), base) : null,
        current: $(a).attr('aria-current') ? true : undefined,
      })).get().filter((i) => i.name).slice(0, CAP.breadcrumbItems);
      if (items.length) found.push({ selector: sel, hasMicrodata: /BreadcrumbList/i.test(`${$(el).attr('itemtype') || ''}${$(el).attr('typeof') || ''}`), items });
    });
  }
  return found;
}

const isPlaceholderHref = (href) => !href || /^\s*(#|javascript:|mailto:|tel:)/i.test(href);

function navigationLinks($, base) {
  const links = []; const seen = new Set();
  $('header a[href], nav a[href], [role="navigation"] a[href]').each((_, a) => {
    if (links.length >= CAP.navLinks) return;
    const href = $(a).attr('href');
    if (isPlaceholderHref(href)) return; // "#" / javascript: are menu toggles, not pages
    const url = absolute(href, base);
    const text = clean($(a).text(), 100);
    if (!url || !text || seen.has(`${url}|${text}`)) return;
    seen.add(`${url}|${text}`);
    // Menu parentage: the item this link is nested under (a dropdown group). A group whose own href is "#" has a name but no page.
    const parentLi = $(a).closest('li').parent().closest('li');
    const parentA = parentLi.length ? parentLi.children('a').first() : null;
    const parent = parentA && parentA.length
      ? { text: clean(parentA.text(), 100), url: isPlaceholderHref(parentA.attr('href')) ? null : absolute(parentA.attr('href'), base) }
      : null;
    links.push({ text, url, depth: Math.min(6, $(a).parents('ul, ol').length), topLevel: !parentLi.length, parent });
  });
  return links;
}

function imageFacts($, base) {
  const all = $('img'); const issues = [];
  let missingAlt = 0; let emptyAlt = 0;
  all.each((_, img) => {
    const alt = $(img).attr('alt');
    const role = $(img).attr('role');
    if (alt === undefined) missingAlt += 1; else if (!alt.trim() && role !== 'presentation') emptyAlt += 1;
    if ((alt === undefined || !alt.trim()) && issues.length < CAP.images) {
      issues.push({
        src: absolute($(img).attr('src') || $(img).attr('data-src') || '', base),
        altAttribute: alt === undefined ? 'absent' : 'empty',
        insideLink: $(img).closest('a').length > 0,
        figcaption: clean($(img).closest('figure').find('figcaption').first().text(), 120) || null,
        nearbyHeading: clean($(img).closest('section, article, div').find('h1,h2,h3').first().text(), 100) || null,
      });
    }
  });
  return { total: all.length, missingAltAttribute: missingAlt, emptyAlt, sample: issues };
}

/** Plain loop on purpose: cheerio's .map() flattens returned arrays, which breaks [key, value] pairs. */
function openGraphTags($) {
  const out = {};
  $('meta[property^="og:"]').each((index, m) => {
    if (index >= 12) return;
    const key = $(m).attr('property');
    if (key) out[key] = clean($(m).attr('content'), 200);
  });
  return out;
}

function accessibilitySignals($) {
  const signals = [];
  const push = (type, el) => { if (signals.length < CAP.a11y) signals.push({ type, html: clean($.html(el), 200) }); };
  if (!$('html').attr('lang')) signals.push({ type: 'html_lang_missing', html: '<html>' });
  $('input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea').each((_, el) => {
    const id = $(el).attr('id');
    const labelled = $(el).attr('aria-label') || $(el).attr('aria-labelledby') || $(el).attr('title')
      || (id && $(`label[for="${id}"]`).length) || $(el).closest('label').length;
    if (!labelled) push('form_control_without_label', el);
  });
  $('a[href]').each((_, el) => {
    if (!clean($(el).text()) && !$(el).attr('aria-label') && !$(el).find('img[alt]:not([alt=""])').length) push('link_without_accessible_name', el);
  });
  $('button').each((_, el) => {
    if (!clean($(el).text()) && !$(el).attr('aria-label') && !$(el).attr('title')) push('button_without_accessible_name', el);
  });
  return signals;
}

function renderingHints($) {
  const bodyText = clean($('body').text(), 100000);
  const scripts = $('script[src]').length;
  const spaRoot = $('#root, #app, #__next, #__nuxt, [data-reactroot], app-root').first();
  return {
    bodyTextLength: bodyText.length,
    externalScripts: scripts,
    spaRootPresent: spaRoot.length > 0,
    spaRootEmpty: spaRoot.length > 0 && clean(spaRoot.text()).length < 50,
    hasNoscript: $('noscript').length > 0,
    // Heuristic only: a near-empty body with many scripts suggests content is injected by JavaScript.
    likelyClientRendered: bodyText.length < 400 && scripts >= 3,
  };
}

function platformHints($) {
  const generator = clean($('meta[name="generator"]').attr('content') || '', 120) || null;
  const html = $.html();
  const hints = [];
  if (/wp-content|wp-includes/i.test(html)) hints.push('wordpress');
  if (/\/_next\//.test(html)) hints.push('nextjs');
  if (/cdn\.shopify\.com/.test(html)) hints.push('shopify');
  if (/wixstatic\.com/.test(html)) hints.push('wix');
  if (/static\.squarespace\.com/.test(html)) hints.push('squarespace');
  if (/et_pb_|et-boc|\/themes\/Divi\//i.test(html)) hints.push('divi');
  if (/elementor/i.test(html)) hints.push('elementor');
  return { generator, hints };
}

/**
 * @param {string} html
 * @param {string} pageUrl base for relative URLs
 */
export function inspectHtml(html, pageUrl) {
  const $ = cheerio.load(String(html || ''));
  const documents = [];
  const jsonLd = readJsonLd($, documents);
  const headings = $('h1, h2, h3, h4').slice(0, CAP.headings).map((_, h) => ({ level: Number(h.tagName[1]), text: clean($(h).text(), 140) })).get();
  const metaRobots = clean($('meta[name="robots"]').attr('content') || '', 200) || null;

  return {
    title: clean($('title').first().text(), 300) || null,
    metaDescription: clean($('meta[name="description"]').attr('content') || '', 500) || null,
    metaRobots,
    xRobotsNote: null,
    canonicalLinks: $('link[rel~="canonical"]').map((_, l) => absolute($(l).attr('href') || '', pageUrl)).get().filter(Boolean),
    lang: $('html').attr('lang') || null,
    viewport: $('meta[name="viewport"]').attr('content') || null,
    openGraph: openGraphTags($),
    headings,
    h1Count: $('h1').length,
    structuredData: {
      jsonLd,
      // Complete parsed JSON-LD for server-side analyzers (the prompt and the stored trace never carry it).
      documents,
      generators: [...new Set(jsonLd.map((b) => (/rank-?math/i.test(b.scriptClass || '') ? 'rank_math' : /yoast/i.test(b.scriptClass || '') ? 'yoast' : null)).filter(Boolean))],
      jsonLdTypes: [...new Set(jsonLd.flatMap((b) => b.types))],
      invalidJsonLdBlocks: jsonLd.filter((b) => !b.valid).length,
      microdataTypes: [...new Set($('[itemtype]').map((_, el) => clean($(el).attr('itemtype'), 120)).get())].slice(0, 20),
      rdfaTypes: [...new Set($('[typeof]').map((_, el) => clean($(el).attr('typeof'), 120)).get())].slice(0, 20),
      breadcrumbLists: breadcrumbListSummary(jsonLd),
    },
    visibleBreadcrumbs: visibleBreadcrumbs($, pageUrl),
    navigation: navigationLinks($, pageUrl),
    images: imageFacts($, pageUrl),
    accessibilitySignals: accessibilitySignals($),
    rendering: renderingHints($),
    platform: platformHints($),
  };
}

export default { inspectHtml, collectJsonLdTypes };
