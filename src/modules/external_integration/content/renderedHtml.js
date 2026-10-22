import axios from 'axios';
import * as cheerio from 'cheerio';

/**
 * Reads what a visitor (and a crawler) actually receives for a page and counts its H1s.
 *
 * This is deliberately separate from the WordPress REST read: post_content is the SOURCE, the
 * rendered page is the RESULT, and they can disagree (a theme/template adds or removes headings,
 * dynamic content resolves to different text, a builder module is hidden). "HTTP 200 from
 * WordPress" proves neither.
 *
 * Safety: only ever fetches a URL on the connected site's own host (never an arbitrary URL from
 * a request), refuses redirects that leave that host, and caps the response size.
 */

const MAX_BYTES = 6 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

export class RenderedHtmlError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RenderedHtmlError';
    this.code = code;
  }
}

const sameHost = (a, b) => new URL(a).host.toLowerCase() === new URL(b).host.toLowerCase();

/** Parses HTML into the H1 facts every caller needs. Pure. */
export function inspectHtml(html) {
  const $ = cheerio.load(html);
  const h1s = $('h1').map((_, el) => $(el).text().replace(/\s+/g, ' ').trim()).get();
  return {
    h1Count: h1s.length,
    h1NonEmpty: h1s.filter(Boolean).length,
    h1Texts: h1s.filter(Boolean),
    bodyClass: ($('body').attr('class') || '').slice(0, 500),
    title: $('title').first().text().trim() || null,
  };
}

/**
 * @param {string} pageUrl
 * @param {{ siteUrl: string, cacheBust?: boolean }} options
 */
export async function fetchRenderedHtml(pageUrl, { siteUrl, cacheBust = false } = {}) {
  let target;
  try {
    target = new URL(pageUrl);
  } catch {
    throw new RenderedHtmlError('INVALID_URL', 'The page URL is not valid.');
  }
  if (!['http:', 'https:'].includes(target.protocol)) throw new RenderedHtmlError('INVALID_URL', 'Only http(s) pages can be checked.');
  if (!siteUrl || !sameHost(pageUrl, siteUrl)) {
    throw new RenderedHtmlError('CROSS_SITE', 'The page is not on the connected WordPress site.');
  }
  // A throwaway query parameter asks caches for a fresh copy; it never changes the page.
  if (cacheBust) target.searchParams.set('odito_verify', String(Date.now()));

  const siteHost = new URL(siteUrl).hostname.toLowerCase();
  let response;
  try {
    response = await axios.get(target.toString(), {
      timeout: TIMEOUT_MS,
      maxRedirects: 3,
      maxContentLength: MAX_BYTES,
      responseType: 'text',
      transformResponse: (data) => data,
      validateStatus: () => true,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OditoContentCheck/1.0)', 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      beforeRedirect: (options) => {
        if (String(options.hostname || '').toLowerCase() !== siteHost) {
          throw new RenderedHtmlError('CROSS_SITE_REDIRECT', 'The page redirected to a different site.');
        }
      },
    });
  } catch (error) {
    if (error instanceof RenderedHtmlError) throw error;
    throw new RenderedHtmlError('FETCH_FAILED', `The public page could not be fetched (${error.code || error.message}).`);
  }

  if (response.status < 200 || response.status >= 300) {
    throw new RenderedHtmlError('BAD_STATUS', `The public page returned HTTP ${response.status}.`);
  }
  return { status: response.status, html: String(response.data || '') };
}

/** The H1 facts of a page's rendered HTML (same safe fetch). */
export async function fetchRenderedPage(pageUrl, options = {}) {
  const { status, html } = await fetchRenderedHtml(pageUrl, options);
  return { status, ...inspectHtml(html) };
}

export default { fetchRenderedPage, fetchRenderedHtml, inspectHtml, RenderedHtmlError };
