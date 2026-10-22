import { describe, test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

import wordPressService, { WordPressConnectionError } from './wordPressService.js';
import {
  resolveWordPressResourceByUrl, normalizeUrlIdentity, clearResolverCache, resolutionFailureToError,
} from './wordPressUrlResolver.js';

/**
 * The shared URL -> WordPress resource resolver, against an in-memory WordPress REST API that
 * answers exactly like core does (settings, types, <base>?slug=, <base>/<id>), with real
 * Naxonify-shaped permalinks: a static front page, nested pages, posts under /blog/<category>/.
 */

const SITE = 'https://naxonify.com';
const conn = { project_id: 'project-A', site_url: SITE };

const page = (id, path, extra = {}) => ({ id, type: 'page', status: 'publish', slug: path.split('/').filter(Boolean).pop(), link: `${SITE}${path}`, ...extra });
const post = (id, path, extra = {}) => ({ id, type: 'post', status: 'publish', slug: path.split('/').filter(Boolean).pop(), link: `${SITE}${path}`, ...extra });

let wp;
let requests;
let htmlResponses;   // url -> {status, data} for axios.get (homepage markup fallback)
let headResponses;   // url -> {status, headers} for axios.head (redirects)

function pick(item) { const { id, link, type, slug, status } = item; return { id, link, type, slug, status }; }

beforeEach(() => {
  mock.restoreAll();
  clearResolverCache();
  requests = [];
  htmlResponses = {};
  headResponses = {};
  wp = {
    settings: { status: 200, data: { show_on_front: 'page', page_on_front: 8, page_for_posts: 0 } },
    pages: [
      page(8, '/'), page(233, '/about-naxonify/'), page(263, '/contact-us/'), page(4721, '/seo-reseller/'), page(4333, '/services/'),
      page(4115, '/services/app-development-services/app-development/'),
      page(9001, '/services/web-development/app-development/'),       // same last slug, different parent (collision)
      page(9100, '/caf%C3%A9-menu/', { slug: 'caf%c3%a9-menu' }),
      page(9200, '/drafty/', { status: 'draft' }),
    ],
    posts: [post(4879, '/blog/ppc-advertising/google-shopping-ads-management/'), post(5000, '/2024/05/dated-post/')],
    // A custom post type registered as public + REST-enabled
    types: {
      post: { rest_base: 'posts', slug: 'post', name: 'Posts' },
      page: { rest_base: 'pages', slug: 'page', name: 'Pages' },
      attachment: { rest_base: 'media', slug: 'attachment', name: 'Media' },
      book: { rest_base: 'books', slug: 'book', name: 'Books' },
    },
    cpt: { books: [{ id: 7000, type: 'book', status: 'publish', slug: 'my-book', link: `${SITE}/books/my-book/` }] },
    statuses: {},   // path prefix -> forced status (REST failures)
  };
  // Pages: the front page is stored with link `${SITE}/` — WordPress does the same.
  mock.method(wordPressService, 'wpRequest', async (_c, { method, path }) => {
    requests.push({ method, path });
    for (const [prefix, status] of Object.entries(wp.statuses)) if (path.startsWith(prefix)) return { status, data: {} };
    if (path.startsWith('/wp-json/wp/v2/settings')) return wp.settings;
    if (path.startsWith('/wp-json/wp/v2/types')) return { status: 200, data: wp.types };
    const bySlug = /^\/wp-json\/wp\/v2\/([a-z_-]+)\?slug=([^&]*)/.exec(path);
    if (bySlug) {
      const [, base, slugEnc] = bySlug;
      const slug = decodeURIComponent(slugEnc);
      const list = base === 'pages' ? wp.pages : base === 'posts' ? wp.posts : wp.cpt[base];
      if (!list) return { status: 404, data: { code: 'rest_no_route' } };
      // WordPress stores slugs already sanitized/encoded (post_name); the REST arg is sanitize_title'd the same way.
      const norm = (s) => encodeURIComponent(decodeURIComponent(String(s))).toLowerCase();
      return { status: 200, data: list.filter((i) => i.status === 'publish' && (i.slug === slug || norm(i.slug) === norm(slug))).map(pick) };
    }
    const byId = /^\/wp-json\/wp\/v2\/(pages|posts)\/(\d+)/.exec(path);
    if (byId) {
      const item = (byId[1] === 'pages' ? wp.pages : wp.posts).find((i) => String(i.id) === byId[2]);
      return item ? { status: 200, data: pick(item) } : { status: 404, data: {} };
    }
    throw new Error(`unexpected request ${path}`);
  });
  mock.method(axios, 'get', async (url) => {
    requests.push({ method: 'HTML', path: url });
    return htmlResponses[url] || { status: 200, data: '<html><body class="home page-template page-id-8"></body></html>' };
  });
  mock.method(axios, 'head', async (url) => {
    requests.push({ method: 'HEAD', path: url });
    return headResponses[url] || { status: 200, headers: {} };
  });
});

const resolve = (url, options = { useCache: false }) => resolveWordPressResourceByUrl(conn, url, options);
const summary = (r) => (r.resolved ? { id: r.postId, type: r.postType, name: r.postTypeName, front: r.isFrontPage, by: r.matchedBy } : { reason: r.reason });
const wpCalls = () => requests.filter((r) => r.method !== 'HTML' && r.method !== 'HEAD');

describe('homepage — resolved from WordPress\'s own settings, never guessed', () => {
  test('static front page: https://naxonify.com/ -> page_on_front', async () => {
    const r = await resolve('https://naxonify.com/');
    assert.deepEqual(summary(r), { id: 8, type: 'pages', name: 'page', front: true, by: 'front_page_setting' });
    assert.equal(r.permalink, `${SITE}/`);
    assert.ok(requests.some((q) => q.path.startsWith('/wp-json/wp/v2/settings')));
  });

  test('the ID comes from page_on_front, not from any hardcoded value', async () => {
    wp.settings.data.page_on_front = 233;
    const r = await resolve('https://naxonify.com/');
    assert.equal(r.postId, 233);
  });

  test('"latest posts" homepage is a blog index, not a post/page — reported as such', async () => {
    wp.settings.data = { show_on_front: 'posts', page_on_front: 0, page_for_posts: 0 };
    const r = await resolve('https://naxonify.com/');
    assert.deepEqual(summary(r), { reason: 'front_page_is_posts_index' });
    assert.match(r.message, /latest posts/);
  });

  test('show_on_front=page with no page chosen behaves like a posts index', async () => {
    wp.settings.data = { show_on_front: 'page', page_on_front: 0, page_for_posts: 0 };
    assert.deepEqual(summary(await resolve('https://naxonify.com/')), { reason: 'front_page_is_posts_index' });
  });

  test('a front page the REST API does not expose is reported, not guessed', async () => {
    wp.settings.data.page_on_front = 99999;
    const r = await resolve('https://naxonify.com/');
    assert.equal(r.resolved, false);
    assert.equal(r.reason, 'not_exposed_by_rest');
  });

  test('settings unreadable (403): the homepage markup (page-id-N) is used and CONFIRMED through the REST API', async () => {
    wp.settings = { status: 403, data: {} };
    const r = await resolve('https://naxonify.com/');
    assert.deepEqual(summary(r), { id: 8, type: 'pages', name: 'page', front: true, by: 'front_page_html_hint' });
  });

  test('settings unreadable and the markup hint does not check out against REST: not determinable, no guess', async () => {
    wp.settings = { status: 403, data: {} };
    htmlResponses['https://naxonify.com'] = { status: 200, data: '<body class="home page-id-233">' };   // 233 is /about-naxonify/, not "/"
    const r = await resolve('https://naxonify.com/');
    assert.deepEqual(summary(r), { reason: 'front_page_not_determinable' });
  });

  test('settings unreadable and the markup says "blog": posts index', async () => {
    wp.settings = { status: 401, data: {} };
    htmlResponses['https://naxonify.com'] = { status: 200, data: '<body class="home blog">' };
    assert.deepEqual(summary(await resolve('https://naxonify.com/')), { reason: 'front_page_is_posts_index' });
  });

  test('plain-permalink addressing (?page_id=N) resolves that page by ID', async () => {
    const r = await resolve('https://naxonify.com/?page_id=233');
    assert.deepEqual(summary(r), { id: 233, type: 'pages', name: 'page', front: false, by: 'id_query' });
  });
});

describe('URL normalization — one identity per WordPress resource', () => {
  const same = ['https://naxonify.com/about-naxonify/', 'https://naxonify.com/about-naxonify', 'https://naxonify.com/about-naxonify?test=1',
    'https://naxonify.com/about-naxonify/?et_fb=1', 'https://naxonify.com/about-naxonify/#section', 'http://naxonify.com/about-naxonify/',
    'https://www.naxonify.com/about-naxonify/', 'https://NAXONIFY.COM/About-Naxonify/', 'https://naxonify.com//about-naxonify//'];
  for (const url of same) {
    test(`${url} -> page 233`, async () => {
      const r = await resolve(url);
      assert.equal(r.postId, 233);
      assert.equal(r.matchedBy, 'permalink');
    });
  }

  test('query strings and fragments are never forwarded to WordPress', async () => {
    await resolve('https://naxonify.com/about-naxonify/?et_fb=1&utm_source=x#top');
    for (const q of wpCalls()) {
      assert.ok(!/et_fb|utm_source|#top/.test(q.path), q.path);
    }
  });

  test('homepage variants all share one identity', async () => {
    for (const url of ['https://naxonify.com', 'https://naxonify.com/', 'https://naxonify.com/?foo=bar', 'https://naxonify.com/#section', 'https://www.naxonify.com//']) {
      assert.equal((await resolve(url)).postId, 8, url);
    }
  });

  test('percent-encoding: an encoded and a decoded URL are the same resource', async () => {
    assert.equal((await resolve('https://naxonify.com/caf%C3%A9-menu/')).postId, 9100);
    assert.equal((await resolve('https://naxonify.com/café-menu/')).postId, 9100);
    assert.equal((await resolve('https://naxonify.com/caf%c3%a9-menu')).postId, 9100);
  });

  test('normalizeUrlIdentity exposes the same key for equivalent URLs and none for foreign ones', () => {
    const key = (u) => normalizeUrlIdentity(u, SITE);
    assert.equal(key('https://www.naxonify.com/a//b/?x=1#y').key, '/a/b');
    assert.equal(key('https://naxonify.com').key, '/');
    assert.equal(key('https://evil.example/a').reason, 'cross_site');
    assert.equal(key('https://naxonify.com.evil.example/a').reason, 'cross_site');
    assert.equal(key('https://naxonify.com:8443/a').reason, 'cross_site');
    assert.equal(key('ftp://naxonify.com/a').reason, 'invalid_url');
    assert.equal(key('https://user:pass@naxonify.com/a').reason, 'invalid_url');
    assert.equal(key('not a url').reason, 'invalid_url');
  });

  test('a site installed in a sub-directory only resolves URLs under that directory', () => {
    const sub = 'https://example.com/shop';
    assert.equal(normalizeUrlIdentity('https://example.com/shop/', sub).key, '/');
    assert.equal(normalizeUrlIdentity('https://example.com/shop/about/', sub).key, '/about');
    assert.equal(normalizeUrlIdentity('https://example.com/other/', sub).reason, 'cross_site');
  });
});

describe('pages, nested pages, posts and canonical permalink matching', () => {
  test('normal pages', async () => {
    assert.deepEqual(summary(await resolve('https://naxonify.com/contact-us/')), { id: 263, type: 'pages', name: 'page', front: false, by: 'permalink' });
    assert.equal((await resolve('https://naxonify.com/services/')).postId, 4333);
    assert.equal((await resolve('https://naxonify.com/seo-reseller/')).postId, 4721);
  });

  test('nested pages resolve by their full permalink', async () => {
    assert.equal((await resolve('https://naxonify.com/services/app-development-services/app-development/')).postId, 4115);
  });

  test('slug collision: two pages with the same last slug resolve to the one whose full permalink matches', async () => {
    assert.equal((await resolve('https://naxonify.com/services/web-development/app-development/')).postId, 9001);
    assert.equal((await resolve('https://naxonify.com/services/app-development-services/app-development/')).postId, 4115);
  });

  test('a collision with NO matching permalink resolves to nothing — never to a look-alike', async () => {
    const r = await resolve('https://naxonify.com/marketing/app-development/');
    assert.equal(r.resolved, false);
    assert.equal(r.reason, 'not_exposed_by_rest');
  });

  test('blog posts resolve although the URL path is not the post slug (category prefix, dated permalinks)', async () => {
    assert.deepEqual(summary(await resolve('https://naxonify.com/blog/ppc-advertising/google-shopping-ads-management/')), { id: 4879, type: 'posts', name: 'post', front: false, by: 'permalink' });
    assert.equal((await resolve('https://naxonify.com/2024/05/dated-post/')).postId, 5000);
  });

  test('pages and posts are not confused', async () => {
    wp.posts.push(post(6000, '/blog/about-naxonify/'));
    assert.deepEqual(summary(await resolve('https://naxonify.com/about-naxonify/')), { id: 233, type: 'pages', name: 'page', front: false, by: 'permalink' });
    assert.deepEqual(summary(await resolve('https://naxonify.com/blog/about-naxonify/')), { id: 6000, type: 'posts', name: 'post', front: false, by: 'permalink' });
  });

  test('a non-published page is not resolved', async () => {
    assert.equal((await resolve('https://naxonify.com/drafty/')).resolved, false);
  });

  test('a page that does not exist reports not_exposed_by_rest with a clear message', async () => {
    const r = await resolve('https://naxonify.com/nope/');
    assert.deepEqual(summary(r), { reason: 'not_exposed_by_rest' });
    assert.match(r.message, /did not expose it through the REST API/);
  });

  test('efficient: an ordinary page needs at most two REST reads (pages, then posts) — no crawling', async () => {
    await resolve('https://naxonify.com/contact-us/');
    assert.equal(wpCalls().length, 1);
    wp.posts.push(post(6100, '/blog/only-a-post/'));
    requests.length = 0;
    await resolve('https://naxonify.com/blog/only-a-post/');
    assert.equal(wpCalls().length, 2);
    assert.ok(wpCalls().every((q) => !/per_page=(\d{3,})/.test(q.path)));
  });
});

describe('custom post types — explained, never writable', () => {
  test('a public REST custom post type is reported as unsupported_post_type, not "page not found"', async () => {
    const r = await resolve('https://naxonify.com/books/my-book/');
    assert.equal(r.resolved, false);
    assert.equal(r.reason, 'unsupported_post_type');
    assert.equal(r.postType, 'books');
    assert.match(r.message, /content type \(Books\) is not currently supported/);
  });

  test('media / internal types are never probed', async () => {
    await resolve('https://naxonify.com/unknown-thing/');
    assert.ok(!requests.some((q) => q.path.includes('/media')));
  });

  test('pages and posts are not re-queried when looking for other content types; internal types are skipped', async () => {
    await resolve('https://naxonify.com/unknown-thing/');
    const slugQueries = wpCalls().filter((q) => q.path.includes('?slug='));
    assert.deepEqual(slugQueries.map((q) => q.path.split('?')[0]), ['/wp-json/wp/v2/pages', '/wp-json/wp/v2/posts', '/wp-json/wp/v2/books']);
  });

  test('the legacy entry point returns null for it (callers never get a writable ID)', async () => {
    assert.equal(await wordPressService.resolvePostIdFromUrl(conn, 'https://naxonify.com/books/my-book/', { useCache: false }), null);
  });
});

describe('redirects', () => {
  test('an old URL that WordPress redirects (same site) resolves to the canonical page', async () => {
    headResponses['https://naxonify.com/old-about/'] = { status: 301, headers: { location: '/about-naxonify/' } };
    const r = await resolve('https://naxonify.com/old-about/');
    assert.equal(r.postId, 233);
    assert.equal(r.matchedBy, 'redirect');
  });

  test('a redirect to another site is never followed', async () => {
    headResponses['https://naxonify.com/old-about/'] = { status: 301, headers: { location: 'https://evil.example/about-naxonify/' } };
    const r = await resolve('https://naxonify.com/old-about/');
    assert.equal(r.resolved, false);
    assert.equal(requests.filter((q) => q.method === 'HEAD').length, 1);
  });

  test('redirect loops are bounded', async () => {
    headResponses['https://naxonify.com/a/'] = { status: 301, headers: { location: '/b/' } };
    headResponses['https://naxonify.com/b/'] = { status: 301, headers: { location: '/a/' } };
    const r = await resolve('https://naxonify.com/a/');
    assert.equal(r.resolved, false);
    assert.ok(requests.filter((q) => q.method === 'HEAD').length <= 3);
  });
});

describe('security — project / site scoped', () => {
  test('a URL on another site cannot be resolved through this connection (cross-site / cross-project)', async () => {
    const r = await resolve('https://other-client.com/about-naxonify/');
    assert.deepEqual(summary(r), { reason: 'cross_site' });
    assert.equal(requests.length, 0, 'no request is made for a foreign URL');
  });

  test('look-alike hosts and other ports are foreign too', async () => {
    for (const url of ['https://naxonify.com.evil.example/', 'https://evilnaxonify.com/', 'https://naxonify.com:8080/']) {
      assert.equal((await resolve(url)).reason, 'cross_site', url);
    }
    assert.equal(requests.length, 0);
  });

  test('the cache never crosses projects or sites', async () => {
    const a = { project_id: 'project-A', site_url: SITE };
    const b = { project_id: 'project-B', site_url: SITE };
    await resolveWordPressResourceByUrl(a, 'https://naxonify.com/contact-us/');
    requests.length = 0;
    await resolveWordPressResourceByUrl(a, 'https://naxonify.com/contact-us/');
    assert.equal(requests.length, 0, 'same project + site: cached');
    await resolveWordPressResourceByUrl(b, 'https://naxonify.com/contact-us/');
    assert.ok(requests.length > 0, 'another project resolves for itself');
  });

  test('failures are never cached, and a cached success can be bypassed', async () => {
    await resolveWordPressResourceByUrl(conn, 'https://naxonify.com/nope/');
    requests.length = 0;
    await resolveWordPressResourceByUrl(conn, 'https://naxonify.com/nope/');
    assert.ok(requests.length > 0);
    await resolveWordPressResourceByUrl(conn, 'https://naxonify.com/contact-us/');
    requests.length = 0;
    await resolveWordPressResourceByUrl(conn, 'https://naxonify.com/contact-us/', { useCache: false });
    assert.ok(requests.length > 0);
  });
});

describe('REST failures are reported as themselves, not as "page not found"', () => {
  for (const [status, code] of [[401, 'INVALID_CREDENTIALS'], [403, 'INSUFFICIENT_PERMISSIONS'], [429, 'RATE_LIMITED'], [500, 'SITE_UNREACHABLE'], [502, 'SITE_UNREACHABLE']]) {
    test(`HTTP ${status} on the lookup throws ${code}`, async () => {
      wp.statuses['/wp-json/wp/v2/pages?slug'] = status;
      await assert.rejects(resolve('https://naxonify.com/contact-us/'), (e) => e instanceof WordPressConnectionError && e.code === code);
    });
  }

  test('a genuine 404 on a post type just means "not exposed": the next type is tried', async () => {
    wp.statuses['/wp-json/wp/v2/pages?slug'] = 404;
    assert.equal((await resolve('https://naxonify.com/blog/ppc-advertising/google-shopping-ads-management/')).postId, 4879);
  });

  test('a network-level failure propagates', async () => {
    wordPressService.wpRequest.mock.restore();
    mock.method(wordPressService, 'wpRequest', async () => { throw new WordPressConnectionError('SITE_UNREACHABLE', 'down', 502); });
    await assert.rejects(resolve('https://naxonify.com/contact-us/'), (e) => e.code === 'SITE_UNREACHABLE');
  });
});

describe('errors for write paths', () => {
  test('resolutionFailureToError gives a specific, user-facing message and a machine reason', () => {
    const cross = resolutionFailureToError({ reason: 'cross_site', message: 'The page URL does not belong to the connected WordPress site.' });
    assert.equal(cross.code, 'FIELD_NOT_WRITABLE');
    assert.equal(cross.statusCode, 422);
    assert.equal(cross.details.resolutionReason, 'cross_site');
    assert.match(cross.message, /does not belong to the connected WordPress site/);
  });

  test('wordPressService.resolveWordPressResource returns the reason; resolvePostIdFromUrl keeps returning null', async () => {
    wp.settings.data = { show_on_front: 'posts' };
    assert.equal(await wordPressService.resolvePostIdFromUrl(conn, 'https://naxonify.com/', { useCache: false }), null);
    assert.equal((await wordPressService.resolveWordPressResource(conn, 'https://naxonify.com/', { useCache: false })).reason, 'front_page_is_posts_index');
  });

  test('the legacy entry point keeps its documented shape for every adapter', async () => {
    const r = await wordPressService.resolvePostIdFromUrl(conn, 'https://naxonify.com/about-naxonify/', { useCache: false });
    assert.equal(r.postId, 233);
    assert.equal(r.postType, 'pages');
    assert.equal('resolved' in r, false);
    assert.equal(r.isFrontPage, false);
  });
});
