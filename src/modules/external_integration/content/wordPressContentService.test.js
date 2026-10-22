import { describe, test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import axios from 'axios';

import wordPressService, { WordPressConnectionError } from '../service/wordPressService.js';
import {
  applyH1Change, getH1Context, restoreContent, fingerprintOf,
} from './wordPressContentService.js';
import { fetchRenderedPage, inspectHtml, RenderedHtmlError } from './renderedHtml.js';
import { parseTags, attrValue, decodeAttrValue, decodeDynamicContent } from './diviShortcodes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REAL = fs.readFileSync(path.join(here, '__fixtures__', 'seo_reseller_divi_content.txt'), 'utf8');

const SITE = 'https://naxonify.com';
const PAGE_URL = 'https://naxonify.com/seo-reseller';
const VALUE = 'SEO Reseller Services by Naxonify';
const conn = { site_url: SITE };

/**
 * An in-memory WordPress: core REST for one page (GET ?context=edit, POST content) and the public
 * page rendered FROM whatever content is currently stored — headings become <hN>, Divi dynamic
 * titles resolve to the page title — so the rendered-page checks exercise real HTML, not flags.
 */
let wp;
let requests;

function renderHeadings(content, title) {
  return parseTags(content)
    .filter((t) => t.name === 'et_pb_heading' && !t.closing)
    .map((t) => {
      const raw = attrValue(t, 'title') || '';
      const dynamic = decodeDynamicContent(raw);
      const text = dynamic ? title : decodeAttrValue(raw);
      const level = attrValue(t, 'title_level') || 'h2';
      return `<${level} class="et_pb_module_header">${text}</${level}>`;
    }).join('');
}

const wpHtml = () => {
  if (wp.renderStatus !== 200) return { status: wp.renderStatus, data: 'err' };
  if (wp.staleRender) return { status: 200, data: wp.staleRender };
  return {
    status: 200,
    data: `<html><head><title>SEO Reseller</title></head><body class="page-id-4721 et_divi_theme">${wp.themeExtra || ''}${renderHeadings(wp.content, wp.title)}</body></html>`,
  };
};

beforeEach(() => {
  mock.restoreAll();
  requests = [];
  wp = {
    id: 4721, postType: 'pages', status: 'publish', title: 'SEO Reseller', content: REAL, revision: 0,
    renderStatus: 200, themeExtra: '', staleRender: null,
    mangleOnWrite: false, failWrites: 0, breakRestore: false, resolveTo: 'pages',
  };
  mock.method(wordPressService, 'resolvePostIdFromUrl', async (_c, url) => {
    requests.push({ op: 'resolve', url });
    return wp.resolveTo ? { postId: wp.id, postType: wp.resolveTo } : null;
  });
  mock.method(wordPressService, 'wpRequest', async (_c, { method, path: p, data }) => {
    requests.push({ op: method, path: p, data });
    if (method === 'GET') {
      return {
        data: {
          id: wp.id, type: 'page', status: wp.status, link: PAGE_URL, slug: 'seo-reseller',
          title: { raw: wp.title }, content: { raw: wp.content }, meta: {}, modified_gmt: `2026-08-17T05:43:${String(wp.revision).padStart(2, '0')}`,
        },
      };
    }
    if (method === 'POST') {
      if (p !== `/wp-json/wp/v2/pages/${wp.id}`) throw new Error(`unexpected write path ${p}`);
      if (wp.failWrites > 0) { wp.failWrites -= 1; throw new WordPressConnectionError('WRITE_FAILED', 'nope', 502); }
      const isRestore = data.content === wp.original;
      if (isRestore && wp.breakRestore) throw new WordPressConnectionError('WRITE_FAILED', 'restore blocked', 502);
      wp.content = wp.mangleOnWrite && !isRestore ? `${data.content} ` : data.content;
      wp.revision += 1;
      return { data: { id: wp.id } };
    }
    throw new Error('unexpected method');
  });
  mock.method(axios, 'get', async (url, options) => {
    requests.push({ op: 'RENDER', url, options });
    return wpHtml();
  });
  wp.original = wp.content;
});

const writes = () => requests.filter((r) => r.op === 'POST');
const renderCalls = () => requests.filter((r) => r.op === 'RENDER');
const currentFingerprint = async () => (await getH1Context(conn, PAGE_URL)).fingerprint;
const apply = (input = {}) => applyH1Change(conn, { pageUrl: PAGE_URL, value: VALUE, ...input });
const reject = async (promise, code, status) => {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof WordPressConnectionError, `expected WordPressConnectionError, got ${error?.constructor?.name}: ${error?.message}`);
    assert.equal(error.code, code);
    if (status) assert.equal(error.statusCode, status);
    return true;
  });
};

describe('getH1Context — read only', () => {
  test('resolves the exact page from its URL and reports the builder, plan, fingerprint and rendered H1 facts', async () => {
    const ctx = await getH1Context(conn, PAGE_URL);
    assert.equal(ctx.supported, true);
    assert.equal(ctx.builder.name, 'divi');
    assert.equal(ctx.state, 'missing');
    assert.equal(ctx.postId, 4721);
    assert.equal(ctx.postType, 'pages');
    assert.equal(ctx.current.h1Count, 0);
    assert.equal(ctx.current.pageTitle, 'SEO Reseller');
    assert.match(ctx.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(writes().length, 0, 'a context read never writes');
  });

  test('a Gutenberg page is reported as unsupported, with the builder named', async () => {
    wp.content = '<!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph -->';
    const ctx = await getH1Context(conn, PAGE_URL);
    assert.equal(ctx.supported, false);
    assert.equal(ctx.builder.name, 'gutenberg');
    assert.ok(ctx.reason);
  });

  test('a URL that is not a WordPress post/page is reported, not thrown', async () => {
    wp.resolveTo = null;
    const ctx = await getH1Context(conn, PAGE_URL);
    assert.equal(ctx.supported, false);
    assert.equal(ctx.code, 'PAGE_NOT_RESOLVED');
  });

  test('an unpublished page is not offered', async () => {
    wp.status = 'draft';
    const ctx = await getH1Context(conn, PAGE_URL);
    assert.equal(ctx.supported, false);
    assert.equal(ctx.code, 'PAGE_NOT_PUBLISHED');
  });

  test('when the rendered page cannot be fetched the context says so and declines', async () => {
    wp.renderStatus = 503;
    const ctx = await getH1Context(conn, PAGE_URL);
    assert.equal(ctx.supported, false);
    assert.match(ctx.renderedCheckError, /503/);
  });
});

describe('applyH1Change — the happy path on the real page', () => {
  test('writes ONE content update, reads it back, fetches the rendered page and confirms exactly one H1', async () => {
    const fingerprint = await currentFingerprint();
    const result = await apply({ expectedFingerprint: fingerprint });

    assert.equal(writes().length, 1);
    assert.equal(writes()[0].path, '/wp-json/wp/v2/pages/4721');
    assert.deepEqual(Object.keys(writes()[0].data), ['content'], 'only the content field is sent');

    assert.equal(result.immediateVerification, 'success');
    assert.equal(result.contentVerified, true);
    assert.deepEqual(result.rendered, { h1Count: 1, h1NonEmpty: 1, h1Texts: [VALUE], matches: true });
    assert.equal(result.builder.name, 'divi');
    assert.equal(result.value, VALUE);
    assert.notEqual(result.after.fingerprint, result.before.fingerprint);
    assert.equal(result.restore.originalContent, REAL);
    assert.equal(wp.content !== REAL, true);
    assert.equal(inspectHtml(wpHtml().data).h1Count, 1);
  });

  test('the recommendation\'s markup is normalized: an <h1> wrapper never reaches the page as literal HTML', async () => {
    const fingerprint = await currentFingerprint();
    const result = await apply({ value: '<h1>\n  SEO Reseller Services by Naxonify\n</h1>', expectedFingerprint: fingerprint });
    assert.equal(result.value, VALUE);
    assert.equal(/<h1/i.test(wp.content), false);
  });

  test('the cache-busting query parameter is used for the before and after page fetches', async () => {
    await apply({ expectedFingerprint: await currentFingerprint() });
    const urls = renderCalls().map((c) => c.url);
    assert.ok(urls.length >= 3);
    for (const u of urls) assert.match(u, /odito_verify=\d+/);
  });
});

describe('applyH1Change — input safety (nothing is read or written)', () => {
  test('invalid H1 values are refused before any WordPress call', async () => {
    const fingerprint = 'a'.repeat(64);
    for (const value of ['<h1><script>x()</script>A</h1>', '<h1 onclick="x">A</h1>', '<h1>A</h1><h1>B</h1>', '', 'x'.repeat(500)]) {
      await reject(apply({ value, expectedFingerprint: fingerprint }), 'INVALID_H1', 422);
    }
    assert.equal(requests.length, 0);
  });

  test('a missing or malformed page-state fingerprint is refused', async () => {
    await reject(apply({}), 'EXPECTED_STATE_REQUIRED', 400);
    await reject(apply({ expectedFingerprint: 'not-a-hash' }), 'EXPECTED_STATE_REQUIRED', 400);
    assert.equal(requests.length, 0);
  });

  test('a page URL on another site is refused before any request (cross-site protection)', async () => {
    await reject(applyH1Change(conn, { pageUrl: 'https://evil.example/seo-reseller', value: VALUE, expectedFingerprint: 'a'.repeat(64) }), 'FIELD_NOT_WRITABLE', 422);
    assert.equal(requests.length, 0);
  });

  test('a URL that does not resolve to a WordPress post/page is refused (post ownership)', async () => {
    wp.resolveTo = null;
    await reject(apply({ expectedFingerprint: 'a'.repeat(64) }), 'FIELD_NOT_WRITABLE', 422);
    assert.equal(writes().length, 0);
  });

  test('only posts and pages are ever written — any other resolved post type is refused', async () => {
    wp.resolveTo = 'media';
    await reject(apply({ expectedFingerprint: 'a'.repeat(64) }), 'FIELD_NOT_WRITABLE', 422);
    assert.equal(writes().length, 0);
  });

  test('a page that is not published is refused', async () => {
    wp.status = 'draft';
    await reject(apply({ expectedFingerprint: 'a'.repeat(64) }), 'FIELD_NOT_WRITABLE', 422);
    assert.equal(writes().length, 0);
  });

  test('an unsupported builder is refused with no write', async () => {
    wp.content = '<!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph -->';
    await reject(apply({ expectedFingerprint: fingerprintOf({ content: { raw: wp.content }, modifiedGmt: '2026-08-17T05:43:00', status: 'publish' }) }), 'FIELD_NOT_WRITABLE', 422);
    assert.equal(writes().length, 0);
  });
});

describe('applyH1Change — stale-value protection', () => {
  test('page content edited in WordPress after the user reviewed it: nothing is overwritten (stale_current_value)', async () => {
    const fingerprint = await currentFingerprint();
    wp.content += '<!-- edited by someone else -->';
    wp.revision += 1;
    await assert.rejects(apply({ expectedFingerprint: fingerprint }), (error) => {
      assert.equal(error.code, 'CONFLICT');
      assert.equal(error.statusCode, 409);
      assert.equal(error.details.reason, 'stale_current_value');
      return true;
    });
    assert.equal(writes().length, 0);
    assert.ok(wp.content.endsWith('<!-- edited by someone else -->'));
  });

  test('a save with identical content but a newer modified date is also stale', async () => {
    const fingerprint = await currentFingerprint();
    wp.revision += 1;
    await reject(apply({ expectedFingerprint: fingerprint }), 'CONFLICT', 409);
    assert.equal(writes().length, 0);
  });

  test('someone added an H1 (e.g. via the theme) since the review: refused, never replaced', async () => {
    const fingerprint = await currentFingerprint();
    wp.themeExtra = '<h1>Theme H1</h1>';
    await assert.rejects(apply({ expectedFingerprint: fingerprint }), (error) => {
      assert.equal(error.code, 'CONFLICT');
      assert.equal(error.details.reason, 'stale_current_value');
      return true;
    });
    assert.equal(writes().length, 0);
  });

  test('two H1s on the rendered page: refused', async () => {
    const fingerprint = await currentFingerprint();
    wp.themeExtra = '<h1>One</h1><h1>Two</h1>';
    await assert.rejects(apply({ expectedFingerprint: fingerprint }), (error) => {
      assert.equal(error.code, 'CONFLICT');
      assert.equal(error.details.reason, 'MULTIPLE_H1');
      return true;
    });
    assert.equal(writes().length, 0);
  });

  test('the page cannot be read publicly: nothing is changed', async () => {
    const fingerprint = await currentFingerprint();
    wp.renderStatus = 500;
    await reject(apply({ expectedFingerprint: fingerprint }), 'FIELD_NOT_WRITABLE', 422);
    assert.equal(writes().length, 0);
  });
});

describe('applyH1Change — failure handling and rollback', () => {
  test('a failed write leaves the page untouched and surfaces the error', async () => {
    const fingerprint = await currentFingerprint();
    wp.failWrites = 1;
    await reject(apply({ expectedFingerprint: fingerprint }), 'WRITE_FAILED', 502);
    assert.equal(wp.content, REAL);
  });

  test('WordPress storing different content than was sent: the original is restored', async () => {
    const fingerprint = await currentFingerprint();
    wp.mangleOnWrite = true;
    await assert.rejects(apply({ expectedFingerprint: fingerprint }), (error) => {
      assert.equal(error.code, 'WRITE_FAILED');
      assert.equal(error.details.rolledBack, true);
      assert.match(error.message, /stored different content than was sent/);
      assert.match(error.message, /original page content was restored/);
      return true;
    });
    assert.equal(wp.content, REAL);
    assert.equal(writes().length, 2, 'the change, then the restore');
  });

  test('two H1s rendered after the write (a theme/template adds one): the change is rolled back', async () => {
    const fingerprint = await currentFingerprint();
    // The theme starts rendering a second H1 only once the page has its own.
    mock.method(axios, 'get', async (url, options) => {
      requests.push({ op: 'RENDER', url, options });
      const h = wpHtml();
      const extra = wp.content !== REAL ? '<h1>Injected by theme</h1>' : '';
      return { status: 200, data: h.data.replace('<body', `<body data-x="1"`).replace('</body>', `${extra}</body>`) };
    });
    await assert.rejects(apply({ expectedFingerprint: fingerprint }), (error) => {
      assert.equal(error.code, 'WRITE_FAILED');
      assert.equal(error.details.rolledBack, true);
      assert.match(error.message, /2 H1 headings/);
      return true;
    });
    assert.equal(wp.content, REAL);
  });

  test('when restoring ALSO fails, the error says so and points at the revision history', async () => {
    const fingerprint = await currentFingerprint();
    wp.mangleOnWrite = true;
    wp.breakRestore = true;
    await assert.rejects(apply({ expectedFingerprint: fingerprint }), (error) => {
      assert.equal(error.code, 'WRITE_FAILED');
      assert.equal(error.details.rollbackFailed, true);
      assert.match(error.message, /revision history/);
      return true;
    });
  });

  test('rendered page not fetchable after the write: the write stays, verification is "unknown"', async () => {
    const fingerprint = await currentFingerprint();
    let calls = 0;
    mock.method(axios, 'get', async (url, options) => {
      requests.push({ op: 'RENDER', url, options });
      calls += 1;
      if (calls > 1) throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
      return wpHtml();
    });
    const result = await apply({ expectedFingerprint: fingerprint });
    assert.equal(result.immediateVerification, 'unknown');
    assert.ok(result.rendered.error);
    assert.notEqual(wp.content, REAL);
  });

  test('a cache still serving the old page: the write stays, verification is "failed" — not success', async () => {
    const fingerprint = await currentFingerprint();
    const oldHtml = wpHtml().data;
    let calls = 0;
    mock.method(axios, 'get', async (url, options) => {
      requests.push({ op: 'RENDER', url, options });
      calls += 1;
      return calls === 1 ? wpHtml() : { status: 200, data: oldHtml };
    });
    const result = await apply({ expectedFingerprint: fingerprint });
    assert.equal(result.immediateVerification, 'failed');
    assert.equal(result.rendered.matches, false);
    assert.notEqual(wp.content, REAL);
  });
});

describe('restoreContent — putting the original page back', () => {
  test('restores the exact original content and confirms it by reading it back', async () => {
    const fingerprint = await currentFingerprint();
    const result = await apply({ expectedFingerprint: fingerprint });
    assert.notEqual(wp.content, REAL);

    const restored = await restoreContent(conn, result.restore);
    assert.equal(restored.restored, true);
    assert.equal(wp.content, REAL);
    assert.equal(inspectHtml(wpHtml().data).h1Count, 0, 'the rendered page is back to its original state');
  });

  test('reports restored:false when WordPress does not hold the original afterwards', async () => {
    wp.mangleOnWrite = true;
    const restored = await restoreContent(conn, { postType: 'pages', postId: 4721, originalContent: 'something else' });
    assert.equal(restored.restored, false);
  });
});

describe('restoreContent — transient network failures while restoring', () => {
  const info = { postType: 'pages', postId: 4721, originalContent: REAL };
  test('a dropped connection is retried and the original is put back', async () => {
    wp.content = REAL + '<!-- changed -->';
    const original = wordPressService.wpRequest;
    let left = 2;
    mock.method(wordPressService, 'wpRequest', async (c, args) => {
      if (args.method === 'POST' && left > 0) { left -= 1; throw new WordPressConnectionError('UNKNOWN_ERROR', 'Could not connect to this WordPress site.', 502); }
      return original(c, args);
    });
    const result = await restoreContent(conn, info, { delayMs: 0 });
    assert.equal(result.restored, true);
    assert.equal(result.attempts, 3);
    assert.equal(wp.content, REAL);
  });

  test('gives up after the configured attempts and surfaces the error', async () => {
    mock.method(wordPressService, 'wpRequest', async () => { throw new WordPressConnectionError('TIMEOUT', 'slow', 504); });
    await assert.rejects(restoreContent(conn, info, { attempts: 3, delayMs: 0 }), (e) => e.code === 'TIMEOUT');
    assert.equal(wordPressService.wpRequest.mock.callCount(), 3);
  });

  test('a non-transient failure (no permission) is NOT retried', async () => {
    mock.method(wordPressService, 'wpRequest', async () => { throw new WordPressConnectionError('INSUFFICIENT_PERMISSIONS', 'no', 403); });
    await assert.rejects(restoreContent(conn, info, { attempts: 4, delayMs: 0 }), (e) => e.code === 'INSUFFICIENT_PERMISSIONS');
    assert.equal(wordPressService.wpRequest.mock.callCount(), 1);
  });
});

describe('fingerprintOf', () => {
  const base = { content: { raw: 'a' }, modifiedGmt: 't', status: 'publish' };
  test('depends on content, modified date and status', () => {
    const f = fingerprintOf(base);
    assert.match(f, /^[a-f0-9]{64}$/);
    assert.notEqual(f, fingerprintOf({ ...base, content: { raw: 'b' } }));
    assert.notEqual(f, fingerprintOf({ ...base, modifiedGmt: 'u' }));
    assert.notEqual(f, fingerprintOf({ ...base, status: 'draft' }));
    assert.equal(f, crypto.createHash('sha256').update('a\nt\npublish').digest('hex'));
  });
});

describe('renderedHtml', () => {
  test('inspectHtml counts H1s, distinguishes empty ones and normalizes text', () => {
    const facts = inspectHtml('<body class="x"><h1> A  b </h1><h1></h1><div><h1><span>C</span></h1></div></body>');
    assert.equal(facts.h1Count, 3);
    assert.equal(facts.h1NonEmpty, 2);
    assert.deepEqual(facts.h1Texts, ['A b', 'C']);
  });

  test('only the connected site\'s own host is ever fetched', async () => {
    await assert.rejects(fetchRenderedPage('https://evil.example/x', { siteUrl: SITE }), (e) => e instanceof RenderedHtmlError && e.code === 'CROSS_SITE');
    await assert.rejects(fetchRenderedPage('ftp://naxonify.com/x', { siteUrl: SITE }), (e) => e.code === 'INVALID_URL');
    assert.equal(renderCalls().length, 0);
  });

  test('a non-2xx response is an error, not an empty page', async () => {
    wp.renderStatus = 404;
    await assert.rejects(fetchRenderedPage(PAGE_URL, { siteUrl: SITE }), (e) => e.code === 'BAD_STATUS');
  });

  test('a redirect to another host is refused', async () => {
    mock.method(axios, 'get', async (url, options) => {
      options.beforeRedirect({ hostname: 'evil.example' });
      return { status: 200, data: '' };
    });
    await assert.rejects(fetchRenderedPage(PAGE_URL, { siteUrl: SITE }), (e) => e.code === 'CROSS_SITE_REDIRECT');
  });

  test('network failures are reported as FETCH_FAILED', async () => {
    mock.method(axios, 'get', async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); });
    await assert.rejects(fetchRenderedPage(PAGE_URL, { siteUrl: SITE }), (e) => e.code === 'FETCH_FAILED');
  });
});
