import { describe, test, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import express from 'express';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import Task from '../../tasks/model/Task.js';
import WordPressFixRecord from '../../external_integration/model/WordPressFixRecord.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import { discoverBreadcrumbTrail, classifyBreadcrumbPages } from '../controller/breadcrumbController.js';
import { clearBreadcrumbDiscoveryCache } from '../../schema-evidence/breadcrumbs/breadcrumbDiscovery.js';

/**
 * Real HTTP dispatch for the breadcrumb discovery routes: real validateProjectAccess, real controllers, live local Mongo (auto-skip when
 * unreachable). Only the JWT middleware is replaced. TEST DATA ONLY: ".example" domain; the site is http:// so discovery makes no network
 * request (it fetches only public HTTPS pages) — the stored crawl is what is discovered from.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'http://bc-route-test.example';
const PAGE = `${ORIGIN}/services/local-seo`;
const validList = { '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home', item: `${ORIGIN}/` }, { '@type': 'ListItem', position: 2, name: 'Local SEO', item: `${PAGE}/` }] };

let mongoAvailable = false;
let server; let baseUrl;
before(async () => {
  try { await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 }); mongoAvailable = true; } catch { mongoAvailable = false; return; }
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { const uid = req.headers['x-test-user-id']; req.user = uid ? { _id: uid, id: uid } : undefined; next(); });
  app.post('/recommendations/breadcrumb/discovery', validateProjectAccess(), discoverBreadcrumbTrail);
  app.post('/recommendations/breadcrumb/pages', validateProjectAccess(), classifyBreadcrumbPages);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://localhost:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoAvailable) await mongoose.connection.close();
});

describe('the routes are registered behind authentication and project ownership', () => {
  test('recommendationRoutes.js mounts both breadcrumb routes with validateProjectAccess(), after router.use(auth)', () => {
    const text = fs.readFileSync(path.join(__dirname, 'recommendationRoutes.js'), 'utf8');
    for (const [name, handler] of [['discovery', 'discoverBreadcrumbTrail'], ['pages', 'classifyBreadcrumbPages']]) {
      assert.match(text, new RegExp(`router\\.post\\('/breadcrumb/${name}',\\s*sameAsLimiter,\\s*validateProjectAccess\\(\\),\\s*${handler}\\)`));
      assert.ok(text.indexOf('router.use(auth)') < text.indexOf(`'/breadcrumb/${name}'`));
    }
  });
});

describe('POST /recommendations/breadcrumb/*', () => {
  let userId; let otherUserId; let project; let otherProject; let created;
  const post = (route, body, { user = userId } = {}) => fetch(`${baseUrl}/recommendations/breadcrumb/${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user-id': String(user) } : {}) }, body: JSON.stringify(body),
  });
  const base = (extra = {}) => ({ projectId: String(project._id), pageUrl: PAGE, ...extra });
  const sideEffects = async () => ({ tasks: await Task.countDocuments({ projectId: { $in: created } }), fixes: await WordPressFixRecord.countDocuments({ projectId: { $in: created } }) });

  beforeEach(async () => {
    mock.restoreAll(); clearBreadcrumbDiscoveryCache();
    if (!mongoAvailable) return;
    userId = new mongoose.Types.ObjectId(); otherUserId = new mongoose.Types.ObjectId();
    project = await SeoProject.create({ user_id: userId, project_name: `BC route ${Date.now()}`, main_url: ORIGIN, seo_scope: 'local', keywords: ['x'] });
    otherProject = await SeoProject.create({ user_id: otherUserId, project_name: `BC other ${Date.now()}`, main_url: ORIGIN, seo_scope: 'local', keywords: ['x'] });
    created = [project._id, otherProject._id];
    const db = mongoose.connection.db;
    await db.collection('seo_page_data').insertMany([
      { projectId: project._id, url: `${ORIGIN}/`, title: 'Home', structured_data: [{ '@graph': [{ '@type': 'WebPage' }] }] },
      { projectId: project._id, url: PAGE, canonical: `${PAGE}/`, title: 'Local SEO | Acme', structured_data: [{ '@graph': [{ '@type': 'WebPage' }] }] },
      { projectId: project._id, url: `${ORIGIN}/about`, canonical: `${ORIGIN}/about/`, title: 'About | Acme', structured_data: [{ '@graph': [validList] }] },
      { projectId: otherProject._id, url: `${ORIGIN}/secret`, title: 'x', structured_data: [] },
    ]);
    await db.collection('seo_page_issues').insertMany([
      { projectId: project._id, page_url: PAGE, rule_id: 'breadcrumblist_schema', issue_code: 'breadcrumblist_schema', status: 'open', dedup_key: `bc-${project._id}-1` },
      { projectId: project._id, page_url: `${ORIGIN}/about`, rule_id: 'breadcrumblist_schema', issue_code: 'breadcrumblist_schema', status: 'open', dedup_key: `bc-${project._id}-2` },
      { projectId: project._id, page_url: `${ORIGIN}/`, rule_id: 'breadcrumblist_schema', issue_code: 'breadcrumblist_schema', status: 'resolved', dedup_key: `bc-${project._id}-3` },
    ]);
  });
  afterEach(async () => {
    if (!mongoAvailable) return;
    const db = mongoose.connection.db;
    for (const c of ['seo_page_data', 'seo_page_issues']) await db.collection(c).deleteMany({ projectId: { $in: created } });
    await SeoProject.deleteMany({ _id: { $in: created } });
  });

  test('no authenticated user -> 401; another user\'s project -> refused; another project\'s page -> 404', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    for (const route of ['discovery', 'pages']) {
      assert.equal((await post(route, base(), { user: null })).status, 401, route);
      assert.ok([403, 404].includes((await post(route, base(), { user: otherUserId })).status), route);
    }
    const res = await post('discovery', { projectId: String(otherProject._id), pageUrl: PAGE }, { user: otherUserId });
    assert.equal(res.status, 404); assert.equal((await res.json()).code, 'PAGE_NOT_FOUND');
    assert.deepEqual(await sideEffects(), { tasks: 0, fixes: 0 });
  });

  test('discovery reports the page from the stored crawl, performs no write and no network request; non-HTTPS pages are skipped, not fetched', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = await post('discovery', base());
    assert.equal(res.status, 200);
    const { data } = await res.json();
    assert.equal(data.status, 'not_found'); assert.deepEqual(data.trails, []);
    assert.equal(data.canonical.url, `${PAGE}/`); assert.equal(data.canonical.trusted, true);
    assert.ok(data.sources.fetched.every((f) => f.status === 'skipped'));
    assert.ok(data.notes.some((n) => /could not be fetched/.test(n)));
    assert.deepEqual(await sideEffects(), { tasks: 0, fixes: 0 });
  });

  test('a stored valid BreadcrumbList is reported as already_valid with the finding flagged stale', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { data } = await (await post('discovery', base({ pageUrl: `${ORIGIN}/about` }))).json();
    assert.equal(data.status, 'already_valid'); assert.equal(data.recommended.items.length, 2);
  });

  test('discovery rejects a missing or oversized pageUrl', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    assert.equal((await post('discovery', { projectId: String(project._id) })).status, 400);
    assert.equal((await post('discovery', base({ pageUrl: 'x'.repeat(2100) }))).status, 400);
  });

  test('pages classifies EVERY page with an open finding, each on its own; resolved findings and client URLs are never used', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = await post('pages', { projectId: String(project._id), urls: ['http://169.254.169.254/latest'] });
    assert.equal(res.status, 200);
    const { data } = await res.json();
    assert.equal(data.total, 2); assert.deepEqual(data.pages.map((p) => p.url).sort(), [`${ORIGIN}/about`, PAGE].sort());
    assert.ok(data.pages.every((p) => p.status === 'unreachable'), 'non-HTTPS pages are not fetched');
    assert.ok(!JSON.stringify(data).includes('169.254'));
    assert.deepEqual(await sideEffects(), { tasks: 0, fixes: 0 });
  });
});
