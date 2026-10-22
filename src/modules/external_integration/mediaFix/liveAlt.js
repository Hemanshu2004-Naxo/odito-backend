/**
 * liveAlt — what the LIVE page renders for one attachment right now. Used only to tell a stale finding from a real mismatch.
 *
 * The audit's crawl can be old, and the library alt may have been set since. When WordPress already holds meaningful alt text but the
 * crawl says the page renders none, a fresh read of the public page decides: alt text now present everywhere => the finding is
 * stale; still empty => something on the page overrides the library.
 *
 * Safety: the fetch is renderedHtml.fetchRenderedHtml (same-host only, no cross-site redirects, size cap). The images are matched to the
 * attachment by the wp-image class or an EXACT upload path (imageIdentity.matchRenderedImages) — never by file-name similarity. HTML is
 * parsed with scripting off, so <noscript> fallbacks are ignored. Results are remembered for a minute so repeated previews of the same
 * page do not re-download it.
 */

import * as cheerio from 'cheerio';
import { fetchRenderedHtml } from '../content/renderedHtml.js';
import { matchRenderedImages } from './imageIdentity.js';

const TTL_MS = 60_000;
const MAX_ENTRIES = 20;
const cache = new Map(); // pageUrl -> { at, images }

const WP_IMAGE_CLASS = /(?:^|\s)wp-image-(\d+)(?:\s|$)/;
const srcsetOf = (el) => String(el.attr('srcset') || el.attr('data-srcset') || '').split(',').map((p) => p.trim().split(/\s+/)[0]).filter((u) => u && !u.startsWith('data:'));

/** The page's <img> elements in the crawler's record shape (so matchRenderedImages can be reused unchanged). Pure. */
export function imagesFromHtml(html) {
  const $ = cheerio.load(html, { scriptingEnabled: false });
  const out = [];
  $('img').each((_, node) => {
    const el = $(node);
    // cheerio keeps <noscript> children as text when scripting is enabled; with it off they would be elements, so skip them explicitly.
    if (el.closest('noscript').length) return;
    const link = el.closest('a');
    const cls = WP_IMAGE_CLASS.exec(el.attr('class') || '');
    out.push({
      src: el.attr('src') || null,
      lazy_src: el.attr('data-src') || el.attr('data-lazy-src') || null,
      srcset_urls: srcsetOf(el),
      wp_attachment_id: cls ? Number(cls[1]) : null,
      alt: el.attr('alt') === undefined ? null : el.attr('alt'),
      in_link: link.length > 0,
      link_label: link.length ? (link.attr('aria-label') || '').trim() : '',
      link_title: link.length ? (link.attr('title') || '').trim() : '',
      link_text: link.length ? link.text().replace(/\s+/g, ' ').trim() : '',
    });
  });
  return out;
}

/**
 * @returns {{status: 'checked'|'not_found'|'unavailable', instances: {alt: string|null, in_link: boolean, link_label: string}[]}}
 */
export async function checkLiveImageAlt({ pageUrl, siteUrl, attachmentId, exactPaths, fresh = false }, { fetchHtml = fetchRenderedHtml, now = Date.now } = {}) {
  let images;
  const hit = fresh ? null : cache.get(pageUrl); // a post-write verification (fresh) never reads the remembered copy
  if (hit && now() - hit.at < TTL_MS) images = hit.images;
  else {
    try {
      const { html } = await fetchHtml(pageUrl, { siteUrl, cacheBust: true });
      images = imagesFromHtml(html);
    } catch {
      return { status: 'unavailable', instances: [] };
    }
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(pageUrl, { at: now(), images });
  }
  const { matched } = matchRenderedImages(images, { attachmentId, exactPaths });
  return { status: matched.length ? 'checked' : 'not_found', instances: matched.map((m) => ({ alt: m.alt == null ? null : String(m.alt).replace(/\s+/g, ' ').trim(), inLink: !!m.in_link, linkName: m.link_label || m.link_title || m.link_text || null })) };
}

export const clearLiveAltCache = () => cache.clear();

export default { checkLiveImageAlt, imagesFromHtml, clearLiveAltCache };
