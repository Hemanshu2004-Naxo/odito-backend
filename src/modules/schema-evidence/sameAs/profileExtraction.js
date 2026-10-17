/**
 * profileExtraction — what ONE already-fetched page says about the organization's profiles. Pure (HTML in, facts out).
 *
 * It reports every outbound link with WHERE it sits (header / footer / navigation / sidebar / page content) and WHAT it sits in
 * (a "follow us" block, a share widget, a team-member card, a testimonial, a blog byline …), plus the Organization/Person
 * sameAs values declared in the page's JSON-LD. It does not decide anything: profileCandidates.js turns these sightings into
 * ranked candidates, and profileUrl.js decides whether a URL may ever be a profile at all.
 *
 * The reason placement and container matter: a LinkedIn link in the footer of every page is the organization's; the same
 * network link inside a team-member module, a testimonial or an author byline belongs to a person or a customer, and a
 * "share on Facebook" button is not a profile at all.
 */

import * as cheerio from 'cheerio';
import { flattenJsonLd, hasType, typesOf } from '../schemaGraph.js';

const HEADER = 'header, [role="banner"], .et-l--header, #main-header, #top-header, .site-header, [class*="_tb_header"]';
const FOOTER = 'footer, [role="contentinfo"], .et-l--footer, #main-footer, .site-footer, [class*="_tb_footer"]';
const SIDEBAR = 'aside, [role="complementary"], .sidebar, .widget-area, #sidebar';
const NAV = 'nav, [role="navigation"]';
const ARTICLE_BODY = 'article, .entry-content, .post-content, .et_pb_post_content, .blog-post, .single-post, .hentry';

const FOLLOW_BLOCK = /(^|[\s_-])(social|socials|follow|sns|connect|networks?)([\s_-]|$)|social[_-]?(media|icons?|links?|profiles?|buttons?)|et_pb_social|elementor-social|wp-block-social|widget_social|fa-(facebook|linkedin|instagram|twitter|youtube)/i;
const SHARE_BLOCK = /share|sharing|sharethis|addtoany|a2a_|addthis|sharedaddy|post-share|entry-share|tweet|pin-?it/i;
const PERSON_BLOCK = /team[_-]?member|et_pb_team|testimonial|et_pb_testimonial|author|byline|staff|speaker|employee|comment|reply|review|client|customer|partner|sponsor|blockquote|vcard|meet-the|profile-card|person/i;

const clean = (v, max = 160) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Classes and ids of an element and its nearest ancestors, as one string to match patterns against. */
function lineage($, el, depth = 5) {
  const parts = [];
  let node = $(el);
  for (let i = 0; i < depth && node.length; i += 1) {
    parts.push(`${node.attr('class') || ''} ${node.attr('id') || ''}`);
    node = node.parent();
  }
  return parts.join(' ');
}

/** Where on the page the anchor sits. Header/footer/navigation/sidebar are the page's chrome: repeated on other pages. */
function placementOf($, a) {
  const el = $(a);
  if (el.closest(FOOTER).length) return 'footer';
  if (el.closest(HEADER).length) return 'header';
  if (el.closest(NAV).length) return 'nav';
  if (el.closest(SIDEBAR).length) return 'sidebar';
  return 'content';
}

/**
 * @param {string} html
 * @param {{ pageUrl: string }} options
 * @returns {{
 *   links: {href: string, text: string, label: string, placement: 'header'|'footer'|'nav'|'sidebar'|'content', inArticleBody: boolean,
 *           followBlock: boolean, shareBlock: boolean, personBlock: boolean}[],
 *   schema: { organizations: {id: string|null, types: string[], url: string|null, name: string|null, sameAs: string[]}[],
 *             persons: {id: string|null, name: string|null, sameAs: string[]}[], jsonLdBlocks: number, jsonLdErrors: number },
 *   title: string|null
 * }}
 */
export function extractPageProfiles(html, { pageUrl } = {}) {
  const $ = cheerio.load(String(html || ''));

  // ── JSON-LD ────────────────────────────────────────────────────────────────
  const blocks = $('script[type="application/ld+json"]').toArray();
  let errors = 0;
  const parsed = [];
  for (const el of blocks) {
    try { parsed.push(JSON.parse($(el).contents().text())); } catch { errors += 1; }
  }
  const nodes = flattenJsonLd(parsed);
  const strings = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
  const organizations = nodes.filter((n) => hasType(n, 'Organization')).map((n) => ({
    id: typeof n['@id'] === 'string' ? n['@id'] : null,
    types: typesOf(n),
    url: typeof n.url === 'string' ? n.url : null,
    name: typeof n.name === 'string' ? n.name : null,
    sameAs: strings(n.sameAs),
  }));
  // A Person's sameAs describes that person (an author, a founder). It is reported separately and never offered as the organization's.
  const persons = nodes.filter((n) => typesOf(n).includes('Person')).map((n) => ({
    id: typeof n['@id'] === 'string' ? n['@id'] : null,
    name: typeof n.name === 'string' ? n.name : null,
    sameAs: strings(n.sameAs),
  }));

  // ── links ─────────────────────────────────────────────────────────────────
  const links = [];
  $('a[href]').each((_, a) => {
    const raw = ($(a).attr('href') || '').trim();
    if (!/^(https?:)?\/\//i.test(raw)) return; // relative / mailto / tel / javascript / # are never external profile links
    let href;
    try { href = new URL(raw, pageUrl || undefined).href; } catch { return; }
    const line = lineage($, a);
    const follow = FOLLOW_BLOCK.test(line);
    links.push({
      href,
      text: clean($(a).text(), 60),
      label: clean($(a).attr('aria-label') || $(a).attr('title') || '', 80),
      placement: placementOf($, a),
      inArticleBody: $(a).closest(ARTICLE_BODY).length > 0,
      followBlock: follow,
      // A "follow" block that merely contains the word "share" in a wrapper class stays a follow block.
      shareBlock: SHARE_BLOCK.test(line) && !follow,
      personBlock: PERSON_BLOCK.test(line) || $(a).closest('blockquote, [itemtype*="Person"]').length > 0,
    });
  });

  return {
    links,
    schema: { organizations, persons, jsonLdBlocks: blocks.length, jsonLdErrors: errors },
    title: clean($('title').first().text(), 200) || null,
  };
}

export default { extractPageProfiles };
