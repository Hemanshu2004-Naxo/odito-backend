import { describe, test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import axios from 'axios';

import wordPressSeoFixService from './wordPressSeoFixService.js';
import wordPressSeoDataService from './wordPressSeoDataService.js';
import wordPressService, { WordPressConnectionError } from './wordPressService.js';
import oditoSeoBridgeService from './oditoSeoBridgeService.js';
import { clearResolverCache } from './wordPressUrlResolver.js';
import taskHistoryService from '../../tasks/service/TaskHistoryService.js';
import Recommendation from '../../recommendations/model/Recommendation.js';
import { serializeFaqPageJsonLd } from '../../tasks/service/faqSchema.js';
import wordPressRoutes from '../routes/wordPressRoutes.js';

/**
 * FAQ schema Apply on a page the URL resolver has to work for — the Naxonify homepage
 * ("https://naxonify.com/") was refused with "This page could not be resolved to a WordPress post
 * or page" because the old resolver looked a page up by the URL's last path segment, and the
 * homepage has none. These run the REAL resolver against an in-memory WordPress REST API (only the
 * HTTP layer and the Bridge are faked) so the whole chain — resolve -> validate -> write -> read
 * back -> Task lifecycle — is exercised.
 */

const SITE = 'https://naxonify.com';
const PAIRS = [
  { question: 'Do you work with all agency sizes?', answer: 'Yes. All deliverables are branded with your agency.' },
  { question: 'How fast can we start?', answer: 'Usually within a week.' },
];

let wp;
let bridgeWrites;
let stored;
let captured;

const item = (id, path, extra = {}) => ({ id, type: 'page', status: 'publish', slug: path.split('/').filter(Boolean).pop() || '', link: `${SITE}${path}`, ...extra });

function makeTask(overrides = {}) {
  const task = {
    _id: 'task-1', projectId: 'project-1', issueKey: 'faq_schema', pageUrl: `${SITE}/`, status: 'task_created', recommendationId: 'rec-1', saved: 0,
    async save() { task.saved += 1; },
    ...overrides,
  };
  return task;
}

const originalDb = Object.getOwnPropertyDescriptor(mongoose.connection, 'db');

beforeEach(() => {
  mock.restoreAll();
  clearResolverCache();
  bridgeWrites = [];
  stored = null;
  captured = [];
  wp = {
    settings: { status: 200, data: { show_on_front: 'page', page_on_front: 8, page_for_posts: 0 } },
    pages: [item(8, '/'), item(233, '/about-naxonify/')],
  };
  // The FAQ pairs the crawler saw on the page (assertFaqPairsAreVisibleOnPage reads seo_page_data).
  Object.defineProperty(mongoose.connection, 'db', {
    configurable: true,
    value: { collection: () => ({ findOne: async () => ({ faq_howto_signals: { faq_pairs: PAIRS } }) }) },
  });

  mock.method(Recommendation, 'findById', () => ({ select: () => ({ lean: async () => ({ projectId: 'project-1' }) }) }));
  mock.method(wordPressService, 'getHydratedConnectionOrThrow', async () => ({ project_id: 'project-1', site_url: SITE, username: 'u', application_password: 'p' }));
  mock.method(wordPressService, 'wpRequest', async (_c, { path }) => {
    if (path.startsWith('/wp-json/wp/v2/settings')) return wp.settings;
    if (path.startsWith('/wp-json/wp/v2/types')) return { status: 200, data: { page: { rest_base: 'pages', slug: 'page' }, post: { rest_base: 'posts', slug: 'post' }, book: { rest_base: 'books', slug: 'book', name: 'Books' } } };
    const byId = /^\/wp-json\/wp\/v2\/pages\/(\d+)/.exec(path);
    if (byId) { const p = wp.pages.find((x) => String(x.id) === byId[1]); return p ? { status: 200, data: p } : { status: 404, data: {} }; }
    const bySlug = /^\/wp-json\/wp\/v2\/([a-z]+)\?slug=([^&]*)/.exec(path);
    if (bySlug) {
      const [, base, slug] = bySlug;
      if (base === 'books') return { status: 200, data: [{ id: 7000, type: 'book', status: 'publish', slug: 'my-book', link: `${SITE}/books/my-book/` }].filter((b) => b.slug === decodeURIComponent(slug)) };
      const list = base === 'pages' ? wp.pages : [];
      return { status: 200, data: list.filter((x) => x.slug === decodeURIComponent(slug)) };
    }
    throw new Error(`unexpected request ${path}`);
  });
  mock.method(axios, 'get', async () => ({ status: 200, data: '<body class="home page-id-8">' }));
  mock.method(axios, 'head', async () => ({ status: 200, headers: {} }));

  mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({ installed: true, provider: 'rank_math', providers: ['rank_math'], bridgeVersion: '1.3.1', faqSchemaSupported: true }));
  mock.method(oditoSeoBridgeService, 'readFaqSchema', async () => ({ pairs: stored }));
  mock.method(oditoSeoBridgeService, 'writeFaqSchema', async (_c, postId, schema) => {
    bridgeWrites.push({ postId, schema });
    stored = schema.mainEntity.map((e) => ({ question: e.name, answer: e.acceptedAnswer.text }));
    return { pairs: stored };
  });
  mock.method(taskHistoryService, 'resolveExpectedValue', async () => ({ snapshot: null, expectedAfterValue: { type: 'faq_schema', pairs: PAIRS } }));
  mock.method(taskHistoryService, 'applyImplementedTransition', async (task, args) => {
    captured.push(args);
    task.status = 'implemented';
    return { attemptNumber: 1 };
  });
});

afterEach(() => {
  if (originalDb) Object.defineProperty(mongoose.connection, 'db', originalDb);
  else delete mongoose.connection.db;
});

const apply = (task) => wordPressSeoFixService.applyFix(task, { approved: true });
const refuse = async (task, reason, messagePattern) => {
  await assert.rejects(apply(task), (e) => {
    assert.ok(e instanceof WordPressConnectionError);
    assert.equal(e.code, 'FIELD_NOT_WRITABLE');
    assert.equal(e.statusCode, 422);
    assert.equal(e.details.resolutionReason, reason);
    assert.match(e.message, messagePattern);
    return true;
  });
  assert.equal(bridgeWrites.length, 0, 'nothing is written when the page cannot be resolved');
  assert.equal(captured.length, 0);
  assert.equal(task.status, 'task_created');
};

describe('FAQ schema apply — the homepage now resolves', () => {
  test('https://naxonify.com/ (static front page) applies to page_on_front: resolve -> write -> read back -> task implemented, never verified_fixed', async () => {
    const task = makeTask();
    const result = await apply(task);

    assert.equal(bridgeWrites.length, 1);
    assert.equal(bridgeWrites[0].postId, 8, 'the ID comes from the site\'s page_on_front setting');
    assert.deepEqual(bridgeWrites[0].schema.mainEntity.map((e) => e.name), PAIRS.map((p) => p.question));
    assert.equal(result.field, 'faq_schema');
    assert.equal(result.immediateVerification, 'success');
    assert.equal(task.status, 'implemented');
    assert.equal(captured[0].externalWrite.wordpressPostId, 8);
    assert.equal(captured[0].externalWrite.field, 'faq_schema');
  });

  test('homepage URL variants (query string, fragment, no trailing slash, www) all apply to the same page', async () => {
    for (const url of [SITE, `${SITE}/?foo=bar`, `${SITE}/#section`, 'https://www.naxonify.com/']) {
      bridgeWrites.length = 0;
      stored = null;
      clearResolverCache();
      await apply(makeTask({ pageUrl: url }));
      assert.equal(bridgeWrites[0].postId, 8, url);
    }
  });

  test('a normal page still applies to its own ID', async () => {
    await apply(makeTask({ pageUrl: `${SITE}/about-naxonify/` }));
    assert.equal(bridgeWrites[0].postId, 233);
  });
});

describe('FAQ schema apply — when a page genuinely cannot be resolved, the reason is specific and nothing is written', () => {
  test('a "latest posts" homepage', async () => {
    wp.settings.data = { show_on_front: 'posts', page_on_front: 0 };
    await refuse(makeTask(), 'front_page_is_posts_index', /homepage shows the latest posts/);
  });

  test('a URL on another site', async () => {
    await refuse(makeTask({ pageUrl: 'https://other-client.com/about/' }), 'cross_site', /does not belong to the connected WordPress site/);
  });

  test('a custom content type', async () => {
    await refuse(makeTask({ pageUrl: `${SITE}/books/my-book/` }), 'unsupported_post_type', /content type \(Books\) is not currently supported/);
  });

  test('a page WordPress does not expose', async () => {
    await refuse(makeTask({ pageUrl: `${SITE}/missing/` }), 'not_exposed_by_rest', /did not expose it through the REST API/);
  });

  test('the same wording is used for every write path that resolves a page (SEO-plugin fields too)', async () => {
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({ installed: true, provider: 'rank_math', providers: ['rank_math'], bridgeVersion: '1.3.1' }));
    mock.method(oditoSeoBridgeService, 'getBridgeCapabilities', async () => ({ fields: { title: { write: true } } }));
    const task = makeTask({ issueKey: 'title_missing', pageUrl: 'https://other-client.com/x/' });
    await assert.rejects(wordPressSeoFixService.validateFix(task), (e) => e.details?.resolutionReason === 'cross_site');
  });
});

describe('GET /wordpress/page-resolution', () => {
  test('resolved: returns the ID, type, permalink and whether it is the front page', async () => {
    const data = await wordPressSeoDataService.getPageResolution('project-1', `${SITE}/?x=1`);
    assert.deepEqual(data, { resolved: true, postId: 8, postType: 'page', slug: '', permalink: `${SITE}/`, isFrontPage: true, matchedBy: 'front_page_setting' });
  });

  test('unresolved: a normal result with the reason, not an error', async () => {
    wp.settings.data = { show_on_front: 'posts' };
    const data = await wordPressSeoDataService.getPageResolution('project-1', `${SITE}/`);
    assert.equal(data.resolved, false);
    assert.equal(data.reason, 'front_page_is_posts_index');
    assert.match(data.message, /latest posts/);
    assert.equal('postId' in data, false);
  });

  test('no WordPress connection for the project -> NOT_CONNECTED (project scoped)', async () => {
    wordPressService.getHydratedConnectionOrThrow.mock.restore();
    mock.method(wordPressService, 'getHydratedConnectionOrThrow', async () => { throw new WordPressConnectionError('NOT_CONNECTED', 'No WordPress connection exists for this project.', 404); });
    await assert.rejects(wordPressSeoDataService.getPageResolution('project-2', `${SITE}/`), (e) => e.code === 'NOT_CONNECTED');
  });

  test('the route is authenticated, validated, rate limited and project-access checked — in that order', () => {
    const layer = wordPressRoutes.stack.find((l) => l.route?.path === '/page-resolution');
    assert.ok(layer, 'route exists');
    const names = layer.route.stack.map((s) => s.name);
    assert.equal(layer.route.methods.get, true);
    assert.ok(names.length >= 4, 'limiter, validators, project access, handler');
    assert.equal(names[names.length - 1], 'getPageResolution');
    assert.ok(wordPressRoutes.stack.some((l) => !l.route && l.name === 'auth'), 'router-level auth middleware applies to every route');
  });
});
