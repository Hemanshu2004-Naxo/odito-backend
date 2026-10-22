import axios from 'axios';
import * as cheerio from 'cheerio';
import wordPressService, { WordPressConnectionError } from './wordPressService.js';

/**
 * The ONE place a page URL is turned into a WordPress post/page.
 *
 *   resolveWordPressResourceByUrl(connection, pageUrl)
 *     -> { resolved: true,  postId, postType ('pages'|'posts' — the REST base every caller already
 *          builds paths from), postTypeName ('page'|'post'), slug, permalink, isFrontPage, status, matchedBy }
 *     -> { resolved: false, reason, message, ... }   (a normal outcome, never a throw)
 *
 * It is used by every WordPress operation that starts from a URL (SEO fields, FAQ/rating schema,
 * H1 content fixes, the adapters) through wordPressService.resolvePostIdFromUrl, so URL handling
 * cannot diverge between features.
 *
 * How a URL is resolved, and why:
 *  1. Identity. The requested URL and every WordPress `link` are reduced to the same key
 *     (host without "www", port, decoded lower-case path without duplicate/trailing slashes; query
 *     and #fragment dropped — they never identify a WordPress resource, and are never forwarded).
 *     A URL on another host/port/base path is refused before any request (cross_site): the
 *     connection can only ever resolve — and later write — inside its own site.
 *  2. The homepage is resolved from WordPress's own configuration (GET /wp/v2/settings:
 *     show_on_front / page_on_front), never guessed. A "latest posts" homepage is a blog index,
 *     not a post/page, and is reported as such. If the connected account cannot read settings,
 *     the homepage's own markup (page-id-N body class / shortlink) is used and then CONFIRMED
 *     through the REST API.
 *  3. Everything else: query the built-in public types (pages, posts) by the URL's last path
 *     segment, and accept only the item whose canonical `link` equals the requested URL — so
 *     nested pages, slug collisions and posts under a /blog/category/ prefix resolve to the exact
 *     resource, never to a look-alike. If nothing matches, the URL's own same-site redirect (if
 *     any) is followed once and resolved the same way. Finally other public REST types are
 *     checked ONLY to tell "exists but is an unsupported content type" from "not found".
 *  4. Only pages and posts are ever reported as resolved (and therefore writable).
 */

const SUPPORTED_TYPES = [
  { base: 'pages', name: 'page' },
  { base: 'posts', name: 'post' },
];
const SUPPORTED_BASES = new Set(SUPPORTED_TYPES.map((t) => t.base));
// Types that are never content pages.
const NON_CONTENT_TYPES = new Set([
  'attachment', 'nav_menu_item', 'wp_block', 'wp_template', 'wp_template_part', 'wp_navigation',
  'wp_global_styles', 'wp_font_family', 'wp_font_face', 'revision',
]);
const MAX_OTHER_TYPES = 6;
const MAX_REDIRECT_HOPS = 3;
const FIELDS = 'id,link,type,slug,status';
const READ_TIMEOUT_MS = 10_000;

export const RESOLUTION_REASONS = Object.freeze({
  INVALID_URL: 'invalid_url',
  CROSS_SITE: 'cross_site',
  FRONT_PAGE_IS_POSTS_INDEX: 'front_page_is_posts_index',
  FRONT_PAGE_NOT_DETERMINABLE: 'front_page_not_determinable',
  UNSUPPORTED_POST_TYPE: 'unsupported_post_type',
  NOT_EXPOSED_BY_REST: 'not_exposed_by_rest',
});

const MESSAGES = {
  invalid_url: 'The page URL is not valid.',
  cross_site: 'The page URL does not belong to the connected WordPress site.',
  front_page_is_posts_index: 'This site\'s homepage shows the latest posts (a blog index) rather than a single WordPress page, so a page-level change cannot be applied to it automatically.',
  front_page_not_determinable: 'This is the site\'s homepage, but WordPress did not say which page is the front page (its settings are not readable with the connected account).',
  not_exposed_by_rest: 'The page belongs to this site, but WordPress did not expose it through the REST API.',
};

const fail = (reason, extra = {}) => ({ resolved: false, reason, message: extra.message || MESSAGES[reason], ...extra });

// ── URL identity ────────────────────────────────────────────────────────────────────────

const hostOf = (url) => url.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
const portOf = (url) => (url.port || (url.protocol === 'https:' ? '443' : '80'));

function decodeSegment(segment) {
  try { return decodeURIComponent(segment); } catch { return segment; }
}

function pathSegments(url) {
  return url.pathname.split('/').filter(Boolean).map((s) => decodeSegment(s).toLowerCase());
}

/**
 * Reduces a URL to its identity on the connected site.
 * @returns {{ok: true, key: string, segments: string[], url: URL} | {ok: false, reason: string}}
 */
export function normalizeUrlIdentity(rawUrl, siteUrl) {
  let url;
  let site;
  try {
    url = new URL(String(rawUrl).trim());
    site = new URL(siteUrl);
  } catch {
    return { ok: false, reason: RESOLUTION_REASONS.INVALID_URL };
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    return { ok: false, reason: RESOLUTION_REASONS.INVALID_URL };
  }
  // http vs https and www vs non-www are the same site; a different host or an explicit
  // different port is not.
  if (hostOf(url) !== hostOf(site) || (url.port && portOf(url) !== portOf(site))) {
    return { ok: false, reason: RESOLUTION_REASONS.CROSS_SITE };
  }
  const base = pathSegments(site);
  const segments = pathSegments(url);
  if (base.some((s, i) => segments[i] !== s)) return { ok: false, reason: RESOLUTION_REASONS.CROSS_SITE };
  const relative = segments.slice(base.length);
  return { ok: true, key: `/${relative.join('/')}`, segments: relative, url };
}

/** Same reduction for a WordPress-provided permalink (path only: WP's home URL host may differ in "www"). */
function permalinkKey(link, siteUrl) {
  if (!link) return null;
  try {
    const url = new URL(link);
    const base = pathSegments(new URL(siteUrl));
    const segments = pathSegments(url);
    const relative = base.every((s, i) => segments[i] === s) ? segments.slice(base.length) : segments;
    return `/${relative.join('/')}`;
  } catch {
    return null;
  }
}

// ── small brief cache (successful resolutions only; per project + site + page) ─────────

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 500;
const cache = new Map();

export function clearResolverCache() { cache.clear(); }

const cacheKey = (connection, key) => `${String(connection.project_id ?? '')}|${String(connection.site_url).toLowerCase()}|${key}`;

function cacheGet(k) {
  const hit = cache.get(k);
  if (!hit) return null;
  if (hit.expires < Date.now()) { cache.delete(k); return null; }
  return hit.value;
}

function cacheSet(k, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(k, { value, expires: Date.now() + CACHE_TTL_MS });
}

// ── WordPress access ────────────────────────────────────────────────────────────────────

/** GET that returns {status, data} for every HTTP status; only network-level failures throw. */
async function wpGet(connection, path) {
  return wordPressService.wpRequest(connection, { method: 'GET', path, timeout: READ_TIMEOUT_MS, skipErrorClassification: true });
}

const asResolved = (item, type, { isFrontPage, matchedBy }) => ({
  resolved: true,
  postId: item.id,
  postType: type.base,
  postTypeName: type.name,
  slug: item.slug ?? null,
  permalink: item.link ?? null,
  status: item.status ?? null,
  isFrontPage,
  matchedBy,
});

async function fetchById(connection, type, id) {
  const { status, data } = await wpGet(connection, `/wp-json/wp/v2/${type.base}/${encodeURIComponent(id)}?_fields=${FIELDS}`);
  return status === 200 && data && data.id ? data : null;
}

async function querySlug(connection, base, slug) {
  const { status, data } = await wpGet(connection, `/wp-json/wp/v2/${base}?slug=${encodeURIComponent(slug)}&per_page=20&_fields=${FIELDS}`);
  if (status === 404) return []; // this type is not exposed on this site
  if (status < 200 || status >= 300) {
    // Real failures (bad credentials, rate limit, server error) surface as themselves, never as
    // "page not found" — the same vocabulary wordPressService uses for every other request.
    if (status === 401) throw new WordPressConnectionError('INVALID_CREDENTIALS', 'Invalid WordPress username or Application Password.', 401);
    if (status === 403) throw new WordPressConnectionError('INSUFFICIENT_PERMISSIONS', 'This WordPress account does not have permission to complete this action.', 403);
    if (status === 429) throw new WordPressConnectionError('RATE_LIMITED', 'WordPress is rate-limiting requests from Odito. Please try again shortly.', 429);
    if (status >= 500) throw new WordPressConnectionError('SITE_UNREACHABLE', 'The WordPress site returned a server error. Please try again shortly.', 502);
    throw new WordPressConnectionError('UNKNOWN_ERROR', 'Could not connect to this WordPress site.', 502);
  }
  return Array.isArray(data) ? data : [];
}

// ── homepage ────────────────────────────────────────────────────────────────────────────

async function frontPageFromHtml(connection, siteUrl) {
  let response;
  try {
    response = await axios.get(siteUrl, {
      timeout: READ_TIMEOUT_MS, maxRedirects: 3, maxContentLength: 3 * 1024 * 1024, responseType: 'text',
      transformResponse: (d) => d, validateStatus: () => true,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OditoContentCheck/1.0)' },
      beforeRedirect: (options) => {
        if (String(options.hostname || '').toLowerCase().replace(/^www\./, '') !== hostOf(new URL(siteUrl))) throw new Error('cross-site redirect');
      },
    });
  } catch {
    return null;
  }
  if (response.status < 200 || response.status >= 300) return null;
  const $ = cheerio.load(String(response.data || ''));
  const classes = ($('body').attr('class') || '').split(/\s+/);
  if (classes.includes('blog') && !classes.some((c) => /^page-id-\d+$/.test(c))) return { postsIndex: true };
  const fromClass = classes.map((c) => /^page-id-(\d+)$/.exec(c)).find(Boolean);
  const shortlink = $('link[rel="shortlink"]').attr('href') || '';
  const fromShortlink = /[?&]p=(\d+)/.exec(shortlink);
  const id = Number((fromClass && fromClass[1]) || (fromShortlink && fromShortlink[1]));
  return Number.isInteger(id) && id > 0 ? { id } : null;
}

async function resolveFrontPage(connection, siteUrl) {
  const settings = await wpGet(connection, '/wp-json/wp/v2/settings');
  const data = settings.status === 200 ? settings.data : null;

  if (data && (data.show_on_front === 'page' || data.show_on_front === 'posts')) {
    const id = Number(data.page_on_front);
    if (data.show_on_front === 'page' && id > 0) {
      const page = await fetchById(connection, SUPPORTED_TYPES[0], id);
      if (!page) return fail(RESOLUTION_REASONS.NOT_EXPOSED_BY_REST, { message: 'WordPress reports a static front page, but did not expose it through the REST API.' });
      return asResolved(page, SUPPORTED_TYPES[0], { isFrontPage: true, matchedBy: 'front_page_setting' });
    }
    return fail(RESOLUTION_REASONS.FRONT_PAGE_IS_POSTS_INDEX);
  }

  // Settings not readable with this account: use the homepage's own markup, then CONFIRM it.
  const hint = await frontPageFromHtml(connection, siteUrl);
  if (hint?.postsIndex) return fail(RESOLUTION_REASONS.FRONT_PAGE_IS_POSTS_INDEX);
  if (hint?.id) {
    for (const type of SUPPORTED_TYPES) {
      const item = await fetchById(connection, type, hint.id);
      if (item && permalinkKey(item.link, siteUrl) === '/') return asResolved(item, type, { isFrontPage: true, matchedBy: 'front_page_html_hint' });
    }
  }
  return fail(RESOLUTION_REASONS.FRONT_PAGE_NOT_DETERMINABLE);
}

// ── ordinary pages and posts ────────────────────────────────────────────────────────────

async function followSameSiteRedirect(pageUrl, siteUrl) {
  let current = pageUrl;
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop += 1) {
    let response;
    try {
      response = await axios.head(current, { timeout: READ_TIMEOUT_MS, maxRedirects: 0, validateStatus: () => true, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OditoContentCheck/1.0)' } });
    } catch {
      return null;
    }
    const location = response.headers?.location;
    if (response.status < 300 || response.status >= 400 || !location) return hop === 0 ? null : current;
    let next;
    try { next = new URL(location, current).toString(); } catch { return null; }
    if (!normalizeUrlIdentity(next, siteUrl).ok) return null; // never follow off the connected site
    current = next;
  }
  return current;
}

async function resolveByPath(connection, identity, pageUrl, { allowRedirect }) {
  const siteUrl = connection.site_url;
  const slug = identity.segments[identity.segments.length - 1];
  const seenLinks = [];

  for (const type of SUPPORTED_TYPES) {
    const items = await querySlug(connection, type.base, slug);
    const exact = items.find((item) => permalinkKey(item.link, siteUrl) === identity.key);
    if (exact) return asResolved(exact, type, { isFrontPage: false, matchedBy: 'permalink' });
    seenLinks.push(...items.map((i) => i.link));
  }

  // The requested URL may be an old/alternate address that WordPress redirects to the canonical one.
  if (allowRedirect) {
    const finalUrl = await followSameSiteRedirect(pageUrl, siteUrl);
    if (finalUrl) {
      const finalIdentity = normalizeUrlIdentity(finalUrl, siteUrl);
      if (finalIdentity.ok && finalIdentity.key !== identity.key) {
        const viaRedirect = finalIdentity.key === '/'
          ? await resolveFrontPage(connection, siteUrl)
          : await resolveByPath(connection, finalIdentity, finalUrl, { allowRedirect: false });
        if (viaRedirect.resolved) return { ...viaRedirect, matchedBy: 'redirect' };
      }
    }
  }

  // Not a page/post: is it another PUBLIC content type? Reported only to explain why it cannot be changed.
  const { status, data } = await wpGet(connection, '/wp-json/wp/v2/types');
  if (status === 200 && data && typeof data === 'object') {
    const others = Object.values(data)
      .filter((t) => t?.rest_base && !SUPPORTED_BASES.has(t.rest_base) && !NON_CONTENT_TYPES.has(t.slug))
      .slice(0, MAX_OTHER_TYPES);
    for (const t of others) {
      const items = await querySlug(connection, t.rest_base, slug);
      const exact = items.find((item) => permalinkKey(item.link, siteUrl) === identity.key);
      if (exact) {
        return fail(RESOLUTION_REASONS.UNSUPPORTED_POST_TYPE, {
          message: `WordPress resource found, but this content type (${t.name || t.slug}) is not currently supported for automatic changes.`,
          postId: exact.id, postType: t.rest_base, postTypeName: t.slug,
        });
      }
    }
  }
  return fail(RESOLUTION_REASONS.NOT_EXPOSED_BY_REST);
}

/**
 * @param {object} connection hydrated WordPressConnection (project scoped by the caller)
 * @param {string} pageUrl
 * @param {{ useCache?: boolean }} [options] pass useCache:false where a stale mapping must never be used (writes)
 */
export async function resolveWordPressResourceByUrl(connection, pageUrl, { useCache = true } = {}) {
  const siteUrl = connection?.site_url;
  const identity = normalizeUrlIdentity(pageUrl, siteUrl);
  if (!identity.ok) return fail(identity.reason);

  const k = cacheKey(connection, identity.key);
  if (useCache) {
    const hit = cacheGet(k);
    if (hit) return hit;
  }

  let result;
  if (identity.key === '/') {
    // Plain-permalink sites address content as /?page_id=N or /?p=N: the only query parameters that mean something.
    const pageId = Number(identity.url.searchParams.get('page_id'));
    const postId = Number(identity.url.searchParams.get('p'));
    const byId = Number.isInteger(pageId) && pageId > 0 ? [SUPPORTED_TYPES[0], pageId] : (Number.isInteger(postId) && postId > 0 ? [SUPPORTED_TYPES[1], postId] : null);
    if (byId) {
      const item = await fetchById(connection, byId[0], byId[1]);
      result = item ? asResolved(item, byId[0], { isFrontPage: false, matchedBy: 'id_query' }) : fail(RESOLUTION_REASONS.NOT_EXPOSED_BY_REST);
    } else {
      result = await resolveFrontPage(connection, siteUrl);
    }
  } else {
    result = await resolveByPath(connection, identity, pageUrl, { allowRedirect: true });
  }

  if (result.resolved && useCache) cacheSet(k, result);
  return result;
}

/** The typed error a write path throws when a URL cannot be resolved — one wording, from the resolver's own reason. */
export function resolutionFailureToError(result) {
  const error = new WordPressConnectionError('FIELD_NOT_WRITABLE', result.message || MESSAGES.not_exposed_by_rest, 422);
  error.details = { resolutionReason: result.reason, ...(result.postType ? { postType: result.postType } : {}) };
  return error;
}

export default { resolveWordPressResourceByUrl, resolutionFailureToError, normalizeUrlIdentity, clearResolverCache, RESOLUTION_REASONS };
