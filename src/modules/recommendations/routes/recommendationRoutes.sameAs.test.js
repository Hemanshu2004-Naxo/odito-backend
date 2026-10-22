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
import { discoverSameAs, validateSameAsUrls, previewSameAs } from '../controller/sameAsController.js';
import { clearDiscoveryCache } from '../../schema-evidence/sameAs/sameAsDiscovery.js';

/**
 * Real HTTP dispatch for the sameAs workflow that runs before a task exists (discovery / validate / preview): real
 * validateProjectAccess, real controllers, live local Mongo (auto-skip when unreachable). Only the JWT middleware is replaced.
 *
 * TEST DATA ONLY: ".example" domain, fictional business. The site is http:// on purpose — discovery fetches only public HTTPS pages,
 * so no network request is ever made here; the stored crawl is what is discovered from.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'http://sameas-route-test.example';
const ORG_ID = `${ORIGIN}/#organization`;
const GRAPH = [{ '@context': 'https://schema.org', '@graph': [{ '@type': 'Organization', '@id': ORG_ID, name: 'SameAs Route Test', url: `${ORIGIN}/` }] }];
const LI = 'https://www.linkedin.com/company/sameas-route-test';

let mongoAvailable = false;
let server; let baseUrl;

before(async () => {
  try { await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 }); mongoAvailable = true; } catch { mongoAvailable = false; return; }
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { const uid = req.headers['x-test-user-id']; req.user = uid ? { _id: uid, id: uid } : undefined; next(); });
  app.post('/recommendations/same-as/discovery', validateProjectAccess(), discoverSameAs);
  app.post('/recommendations/same-as/validate', validateProjectAccess(), validateSameAsUrls);
  app.post('/recommendations/same-as/preview', validateProjectAccess(), previewSameAs);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoAvailable) await mongoose.connection.close();
});

describe('the routes are registered behind authentication and project ownership', () => {
  test('recommendationRoutes.js mounts the three sameAs routes with validateProjectAccess(), after router.use(auth)', () => {
    const text = fs.readFileSync(path.join(__dirname, 'recommendationRoutes.js'), 'utf8');
    for (const [name, handler] of [['discovery', 'discoverSameAs'], ['validate', 'validateSameAsUrls'], ['preview', 'previewSameAs']]) {
      assert.match(text, new RegExp(`router\\.post\\('/same-as/${name}',\\s*sameAsLimiter,\\s*validateProjectAccess\\(\\),\\s*${handler}\\)`));
      assert.ok(text.indexOf('router.use(auth)') < text.indexOf(`'/same-as/${name}'`));
    }
  });
});

describe('POST /recommendations/same-as/*', () => {
  let userId; let otherUserId; let project; let otherProject; let created;

  const post = (route, body, { user = userId } = {}) => fetch(`${baseUrl}/recommendations/same-as/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user-id': String(user) } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const base = (extra = {}) => ({ projectId: String(project._id), pageUrl: `${ORIGIN}/contact`, ...extra });
  const sideEffects = async () => ({
    tasks: await Task.countDocuments({ projectId: { $in: created } }),
    fixes: await WordPressFixRecord.countDocuments({ projectId: { $in: created } }),
  });

  beforeEach(async () => {
    mock.restoreAll();
    clearDiscoveryCache();
    if (!mongoAvailable) return;
    userId = new mongoose.Types.ObjectId();
    otherUserId = new mongoose.Types.ObjectId();
    project = await SeoProject.create({ user_id: userId, project_name: `SameAs route ${Date.now()}`, main_url: ORIGIN, seo_scope: 'local', keywords: ['x'] });
    otherProject = await SeoProject.create({ user_id: otherUserId, project_name: `SameAs other ${Date.now()}`, main_url: ORIGIN, seo_scope: 'local', keywords: ['x'] });
    created = [project._id, otherProject._id];
    const db = mongoose.connection.db;
    await db.collection('seo_page_data').insertMany([
      { projectId: project._id, url: `${ORIGIN}/`, structured_data: GRAPH },
      { projectId: project._id, url: `${ORIGIN}/contact`, structured_data: GRAPH },
      { projectId: otherProject._id, url: `${ORIGIN}/secret`, structured_data: [] },
    ]);
    await db.collection('seo_social_links').insertMany([
      { projectId: project._id, platform: 'linkedin', url: LI, sourceUrl: `${ORIGIN}/`, discoveredAt: new Date() },
      { projectId: project._id, platform: 'linkedin', url: LI, sourceUrl: `${ORIGIN}/contact`, discoveredAt: new Date() },
    ]);
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    const db = mongoose.connection.db;
    await db.collection('seo_page_data').deleteMany({ projectId: { $in: created } });
    await db.collection('seo_social_links').deleteMany({ projectId: { $in: created } });
    await SeoProject.deleteMany({ _id: { $in: created } });
  });

  test('no authenticated user -> 401; another user\'s project -> refused; another project\'s page -> 404 PAGE_NOT_FOUND', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    for (const route of ['discovery', 'validate', 'preview']) {
      assert.equal((await post(route, base(), { user: null })).status, 401, route);
      assert.ok([403, 404].includes((await post(route, base(), { user: otherUserId })).status), route);
      const res = await post(route, { projectId: String(otherProject._id), pageUrl: `${ORIGIN}/contact` }, { user: otherUserId });
      assert.equal(res.status, 404, route); assert.equal((await res.json()).code, 'PAGE_NOT_FOUND');
    }
    assert.deepEqual(await sideEffects(), { tasks: 0, fixes: 0 });
  });

  test('discovery returns candidates with provenance from the stored crawl, performs no write and no network request', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = await post('discovery', base());
    assert.equal(res.status, 200);
    const { data } = await res.json();
    assert.equal(data.entity.state, 'absent'); assert.equal(data.entity.id, ORG_ID);
    assert.equal(data.candidates.length, 1);
    assert.equal(data.candidates[0].url, LI); assert.equal(data.candidates[0].reachability, 'not_checked');
    assert.ok(data.candidates[0].sources.every((s) => s.method === 'crawl_social_link'));
    assert.ok(data.sources.pages.every((p) => p.status === 'skipped'), 'non-HTTPS pages are never fetched live');
    assert.deepEqual(await sideEffects(), { tasks: 0, fixes: 0 });
  });

  test('discovery rejects a missing or oversized pageUrl and a body that is too large', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    assert.equal((await post('discovery', { projectId: String(project._id) })).status, 400);
    assert.equal((await post('discovery', base({ pageUrl: 'x'.repeat(2100) }))).status, 400);
    const res = await fetch(`${baseUrl}/recommendations/same-as/discovery`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user-id': String(userId), 'content-length': '999999' }, body: JSON.stringify(base()) }).catch((e) => e);
    assert.ok(res instanceof Error || [400, 413].includes(res.status));
  });

  test('validate reports per-line errors and normalises valid links without fetching anything', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const bad = await (await post('validate', base({ urls: [LI, 'javascript:alert(1)', 'http://www.facebook.com/x', 'https://linkedin.com/company/sameas-route-test/'] }))).json();
    assert.equal(bad.data.valid, false);
    assert.deepEqual(bad.data.errors.map((e) => [e.index, e.code]), [[1, 'NOT_HTTP'], [2, 'NOT_HTTPS'], [3, 'DUPLICATE']]);
    const good = await (await post('validate', base({ urls: ['https://x.com/SameAsTest/?utm_source=a', LI] }))).json();
    assert.equal(good.data.valid, true);
    assert.equal(good.data.items[0].url, 'https://x.com/SameAsTest'); assert.equal(good.data.items[0].normalized.strippedTracking, true);
    assert.equal((await (await post('validate', base({ urls: 'nope' }))).json()).data.valid, false);
  });

  test('preview without a WordPress connection is a manual-path plan (not an error) with the recommended JSON-LD for the selection', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = await post('preview', base({ urls: [LI] }));
    assert.equal(res.status, 200);
    const { data } = await res.json();
    assert.equal(data.plan.status, 'unsupported'); assert.equal(data.plan.code, 'WORDPRESS_NOT_CONNECTED');
    assert.equal(data.sameAs.panelState, 'unsupported_source'); assert.ok(data.sameAs.manual.steps.length >= 2);
    assert.deepEqual(JSON.parse(data.sameAs.recommendedJsonLd).sameAs, [LI]);
    assert.equal(JSON.parse(data.sameAs.recommendedJsonLd)['@id'], ORG_ID);
    assert.equal(data.approvalStatus, 'not_available');
    assert.deepEqual(await sideEffects(), { tasks: 0, fixes: 0 });
  });

  test('preview refuses unsafe links with per-line details before planning anything', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = await post('preview', base({ urls: ['javascript:alert(1)', 'https://localhost/acme', 'https://www.example.com/acme'] }));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'INVALID_PROFILES');
    assert.deepEqual(body.details.errors.map((e) => e.code), ['NOT_HTTP', 'INVALID_HOST', 'PLACEHOLDER']);
  });
});
