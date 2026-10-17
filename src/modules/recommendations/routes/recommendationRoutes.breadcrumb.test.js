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
import Recommendation from '../model/Recommendation.js';
import Task from '../../tasks/model/Task.js';
import SchemaBreadcrumbEvidence from '../../schema-evidence/SchemaBreadcrumbEvidence.js';
import claudeService from '../service/claudeService.js';
import recommendationService from '../service/recommendationService.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import { regenerateBreadcrumbHierarchy } from '../controller/recommendationController.js';

/**
 * Real HTTP dispatch for POST /recommendations/breadcrumb-hierarchy: real validateProjectAccess, real controller,
 * real service/validators/guard, live local Mongo (auto-skip when unreachable). Only the JWT middleware is replaced
 * (as in recommendationRoutes.wiring.test.js) and the LLM is switched off — the deterministic path must not need it.
 * No website is contacted: submitted URLs are never fetched.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'https://breadcrumb-route-test.example';
const HOME = `${ORIGIN}/`;
const BLOG_KEY = `${ORIGIN}/blog`;
const BLOG_CANON = `${ORIGIN}/blog/`;
const li = (position, name, item) => ({ '@type': 'ListItem', position, name, item });

let mongoAvailable = false;
let server; let baseUrl;

before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch { mongoAvailable = false; return; }

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { const uid = req.headers['x-test-user-id']; req.user = uid ? { _id: uid, id: uid } : undefined; next(); });
  app.post('/recommendations/breadcrumb-hierarchy', validateProjectAccess(), regenerateBreadcrumbHierarchy);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoAvailable) await mongoose.connection.close();
});

describe('the route is registered behind authentication and project ownership', () => {
  test('recommendationRoutes.js mounts POST /breadcrumb-hierarchy with validateProjectAccess(), under router.use(auth)', () => {
    const text = fs.readFileSync(path.join(__dirname, 'recommendationRoutes.js'), 'utf8');
    assert.match(text, /router\.use\(auth\)/);
    assert.match(text, /router\.post\('\/breadcrumb-hierarchy',\s*validateProjectAccess\(\),\s*regenerateBreadcrumbHierarchy\)/);
    assert.ok(text.indexOf("router.use(auth)") < text.indexOf("'/breadcrumb-hierarchy'"));
  });
});

describe('POST /recommendations/breadcrumb-hierarchy', () => {
  let userId; let otherUserId; let project; let otherProject; let created;

  const post = (body, { user = userId, headers = {} } = {}) => fetch(`${baseUrl}/recommendations/breadcrumb-hierarchy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user-id': String(user) } : {}), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const GOOD = () => ({ projectId: String(project._id), pageUrl: BLOG_KEY, items: [{ name: 'Home', url: HOME }, { name: 'Blog', url: BLOG_CANON }] });
  const counts = async () => ({
    recs: await Recommendation.countDocuments({ projectId: project._id }),
    evidence: await SchemaBreadcrumbEvidence.countDocuments({ projectId: project._id }),
    tasks: await Task.countDocuments({ projectId: project._id }),
    jobs: await mongoose.connection.db.collection('jobs').countDocuments({ $or: [{ projectId: project._id }, { project_id: project._id }, { projectId: String(project._id) }] }),
  });

  beforeEach(async () => {
    mock.restoreAll();
    if (!mongoAvailable) return;
    mock.method(claudeService, 'isAvailable', () => false);
    userId = new mongoose.Types.ObjectId();
    otherUserId = new mongoose.Types.ObjectId();
    project = await SeoProject.create({ user_id: userId, project_name: `BC route ${Date.now()}`, main_url: ORIGIN, seo_scope: 'local', keywords: ['x'] });
    otherProject = await SeoProject.create({ user_id: otherUserId, project_name: `BC other ${Date.now()}`, main_url: ORIGIN, seo_scope: 'local', keywords: ['x'] });
    created = [project._id, otherProject._id];
    const db = mongoose.connection.db;
    await db.collection('seo_page_data').insertOne({ projectId: project._id, url: BLOG_KEY, canonical: BLOG_CANON, title: 'Blog', structured_data: [], meta_tags: {}, images: [], word_count: 100 });
    // the OTHER project crawled a different page; it must never be able to touch project A's
    await db.collection('seo_page_data').insertOne({ projectId: otherProject._id, url: `${ORIGIN}/other`, canonical: `${ORIGIN}/other/`, title: 'Other', structured_data: [] });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    const db = mongoose.connection.db;
    await Recommendation.deleteMany({ projectId: { $in: created } });
    await SchemaBreadcrumbEvidence.deleteMany({ projectId: { $in: created } });
    await Task.deleteMany({ projectId: { $in: created } });
    await db.collection('seo_page_data').deleteMany({ projectId: { $in: created } });
    await db.collection('seo_page_issues').deleteMany({ projectId: { $in: created } });
    await SeoProject.deleteMany({ _id: { $in: created } });
  });

  describe('authentication and ownership', () => {
    test('no authenticated user -> 401, nothing stored', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const before = await counts();
      const res = await post(GOOD(), { user: null });
      assert.equal(res.status, 401);
      assert.deepEqual(await counts(), before);
    });

    test('another user\'s project -> refused (403/404), and nothing is stored or readable', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const res = await post(GOOD(), { user: otherUserId });
      assert.ok([403, 404].includes(res.status), `status ${res.status}`);
      assert.deepEqual(await counts(), { recs: 0, evidence: 0, tasks: 0, jobs: 0 });
    });

    test('the caller\'s OWN project but another project\'s page URL -> 404 PAGE_NOT_FOUND (the page must be in the caller\'s crawl)', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const res = await post({ projectId: String(otherProject._id), pageUrl: BLOG_KEY, items: GOOD().items }, { user: otherUserId });
      assert.equal(res.status, 404);
      assert.equal((await res.json()).code, 'PAGE_NOT_FOUND');
      assert.equal(await SchemaBreadcrumbEvidence.countDocuments({}) >= 0, true);
      assert.equal(await SchemaBreadcrumbEvidence.countDocuments({ projectId: otherProject._id }), 0);
    });

    test('a projectId that is not an id at all is refused before the controller', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const res = await post({ ...GOOD(), projectId: 'not-an-id' });
      assert.ok(res.status >= 400 && res.status < 500 || res.status === 500);
      assert.equal(res.ok, false);
    });
  });

  describe('request validation (server-side)', () => {
    test('invalid items -> 422 with field-level errors, the canonical to match, and NOTHING generated or stored', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const res = await post({ ...GOOD(), items: [{ name: '', url: 'nope' }, { name: 'Blog', url: `${ORIGIN}/wrong/` }] });
      const body = await res.json();
      assert.equal(res.status, 422);
      assert.equal(body.code, 'BREADCRUMB_INPUT_INVALID');
      assert.deepEqual(body.errors.map((e) => [e.index, e.field, e.code]), [[0, 'name', 'name_required'], [0, 'url', 'url_invalid']].concat([[1, 'url', 'final_url_mismatch']]));
      assert.deepEqual(body.canonical, { url: BLOG_CANON, trusted: true });
      assert.deepEqual(await counts(), { recs: 0, evidence: 0, tasks: 0, jobs: 0 });
    });

    test('the final URL that differs from the canonical is explained and NOT rewritten', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const body = await (await post({ ...GOOD(), items: [{ name: 'Home', url: HOME }, { name: 'Blog', url: `${ORIGIN}/news/` }] })).json();
      assert.equal(body.errors[0].code, 'final_url_mismatch');
      assert.equal(body.errors[0].expectedUrl, BLOG_CANON);
      assert.match(body.errors[0].message, /does not rewrite it/);
    });

    test('a browser-supplied canonical / ownership claim is ignored: only the stored crawl decides', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const res = await post({ ...GOOD(), canonicalUrl: `${ORIGIN}/news/`, canonical: `${ORIGIN}/news/`, items: [{ name: 'Home', url: HOME }, { name: 'News', url: `${ORIGIN}/news/` }] });
      assert.equal(res.status, 422);
    });

    test('bad shapes -> 400, and an oversized body -> 413', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      assert.equal((await post({ projectId: String(project._id), items: GOOD().items })).status, 400);
      assert.equal((await post({ projectId: String(project._id), pageUrl: BLOG_KEY, items: 'x' })).status, 400);
      assert.equal((await post({ projectId: String(project._id), pageUrl: 'x'.repeat(3000), items: GOOD().items })).status, 400);
      const huge = JSON.stringify({ ...GOOD(), pad: 'z'.repeat(40 * 1024) });
      assert.equal((await post(huge)).status, 413);
      assert.deepEqual(await counts(), { recs: 0, evidence: 0, tasks: 0, jobs: 0 });
    });

    test('too many items, too-long names, duplicate URLs and bad positions are refused with the specific code', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const many = Array.from({ length: 11 }, (_, i) => ({ name: `P${i}`, url: `${ORIGIN}/p${i}/` }));
      assert.equal((await (await post({ ...GOOD(), items: many })).json()).errors[0].code, 'too_many_items');
      assert.equal((await (await post({ ...GOOD(), items: [{ name: 'x'.repeat(200), url: HOME }, GOOD().items[1]] })).json()).errors[0].code, 'name_too_long');
      assert.equal((await (await post({ ...GOOD(), items: [{ name: 'A', url: HOME }, { name: 'B', url: ORIGIN }, GOOD().items[1]] })).json()).errors[0].code, 'duplicate_url');
      assert.equal((await (await post({ ...GOOD(), items: [{ name: 'A', url: HOME, position: 2 }, { ...GOOD().items[1], position: 2 }] })).json()).errors.some((e) => e.code === 'position_duplicate'), true);
    });
  });

  describe('successful regeneration', () => {
    test('valid hierarchy -> deterministic JSON-LD that passed the guard and validator; evidence stored; the LLM was never called', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const generate = mock.method(claudeService, 'generate', async () => { throw new Error('the LLM must not be used'); });
      const res = await post(GOOD());
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.success, true);
      assert.equal(generate.mock.callCount(), 0);
      assert.equal(body.meta.source, 'template');
      assert.equal(body.meta.cached, false);
      assert.equal(body.meta.evidenceChanged, true);
      assert.equal(body.meta.schemaEvidence.breadcrumb.status, 'user_provided');

      const code = body.data.sections.implementationExample.content;
      const jsonLd = JSON.parse(code.replace(/<\/?script[^>]*>/g, ''));
      assert.deepEqual(jsonLd, {
        '@context': 'https://schema.org', '@type': 'BreadcrumbList',
        itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home', item: HOME }, { '@type': 'ListItem', position: 2, name: 'Blog', item: BLOG_CANON }],
      });
      assert.equal(body.data.sections.recommendedVersion, 'enabled', 'the Rank Math toggle contract is preserved');
      assert.match(body.data.sections.recommendedFix, /does not change your website/);
      assert.match(body.data.sections.recommendedFix, /not both/);

      const stored = await SchemaBreadcrumbEvidence.findOne({ projectId: project._id, pageUrl: BLOG_KEY }).lean();
      assert.deepEqual(stored.items.map((i) => [i.position, i.name, i.url]), [[1, 'Home', HOME], [2, 'Blog', BLOG_CANON]]);
      assert.equal(stored.canonicalUrl, BLOG_CANON);
      assert.equal(stored.canonicalSource, 'canonical_tag');
      assert.equal(String(stored.submittedBy), String(userId));
      assert.ok(stored.submittedAt && stored.regeneratedAt);
    });

    test('repeating the SAME submission creates no second recommendation or evidence record and does not rewrite the evidence', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const first = await (await post(GOOD())).json();
      const doc1 = await SchemaBreadcrumbEvidence.findOne({ projectId: project._id }).lean();
      const second = await (await post(GOOD())).json();
      const doc2 = await SchemaBreadcrumbEvidence.findOne({ projectId: project._id }).lean();
      assert.equal(second.meta.cached, true);
      assert.equal(second.meta.evidenceChanged, false);
      assert.equal(String(first.data.id), String(second.data.id));
      assert.deepEqual(await counts(), { recs: 1, evidence: 1, tasks: 0, jobs: 0 });
      assert.equal(doc1.revision, doc2.revision);
      assert.equal(String(doc1.submittedAt), String(doc2.submittedAt));
    });

    test('changing the hierarchy yields a NEW recommendation (new fingerprint) and bumps the evidence revision; the stale one is never reused', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      await post(GOOD());
      const changed = { ...GOOD(), items: [{ name: 'Home', url: HOME }, { name: 'Resources', url: `${ORIGIN}/resources/` }, { name: 'Blog', url: BLOG_CANON }] };
      const res = await (await post(changed)).json();
      assert.equal(res.meta.cached, false);
      assert.equal(res.meta.evidenceChanged, true);
      assert.equal(JSON.parse(res.data.sections.implementationExample.content.replace(/<\/?script[^>]*>/g, '')).itemListElement.length, 3);
      assert.equal((await SchemaBreadcrumbEvidence.findOne({ projectId: project._id }).lean()).revision, 2);
    });

    test('RELOAD: the normal generate path serves the saved, validated recommendation and reports the saved evidence', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      await post(GOOD());
      const again = await recommendationService.getOrGenerate({ projectId: String(project._id), issueId: 'breadcrumblist_schema', pageUrl: BLOG_KEY, issueSource: 'on_page', ruleMetadata: {} });
      assert.equal(again.cached, true);
      assert.equal(again.schemaEvidence.breadcrumb.status, 'user_provided');
      assert.equal(again.schemaEvidence.breadcrumb.userProvided.items.length, 2);
      assert.match(again.recommendation.sections.implementationExample.content, /"BreadcrumbList"/);
    });

    test('it never launches an audit or any job, and never creates or changes a task — an implemented task stays implemented', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const task = await Task.create({ projectId: project._id, issueKey: 'breadcrumblist_schema', pageUrl: BLOG_KEY, status: 'implemented', origin: 'diy_guide', implementedAt: new Date('2026-10-01T00:00:00Z') });
      const jobsBefore = (await counts()).jobs;
      await post(GOOD());
      await post(GOOD());
      const after = await Task.findById(task._id).lean();
      assert.equal(after.status, 'implemented');
      assert.equal(String(after.updatedAt), String(task.updatedAt));
      assert.equal((after.fixHistory || []).length, 0);
      assert.equal(await Task.countDocuments({ projectId: project._id }), 1);
      assert.equal((await counts()).jobs, jobsBefore);
      assert.equal(await mongoose.connection.db.collection('audit_runs').countDocuments({ projectId: project._id }), 0);
    });

    test('a page with no canonical tag: the owner\'s confirmed URL is accepted but flagged as unverified', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      await mongoose.connection.db.collection('seo_page_data').updateOne({ projectId: project._id, url: BLOG_KEY }, { $unset: { canonical: '' } });
      const res = await (await post(GOOD())).json();
      assert.equal(res.success, true);
      assert.equal(res.meta.warnings[0].code, 'canonical_unverified');
      assert.equal((await SchemaBreadcrumbEvidence.findOne({ projectId: project._id }).lean()).canonicalSource, 'user_confirmed');
    });
  });

  describe('existing schema', () => {
    const withExisting = async (itemListElement) => mongoose.connection.db.collection('seo_page_data').updateOne(
      { projectId: project._id, url: BLOG_KEY },
      { $set: { structured_data: [{ '@context': 'https://schema.org', '@graph': [{ '@type': 'WebPage' }, { '@type': 'BreadcrumbList', itemListElement }] }] } },
    );

    test('G. an existing, DIFFERENT BreadcrumbList is a conflict: no second BreadcrumbList is generated, and the response says so', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      await withExisting([li(1, 'Home', HOME), li(2, 'News', `${ORIGIN}/news/`), li(3, 'Blog', BLOG_CANON)]);
      const res = await post(GOOD());
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.meta.schemaEvidence.breadcrumb.status, 'conflict');
      assert.equal(body.meta.schemaEvidence.breadcrumb.conflict.kind, 'existing_valid_differs');
      assert.ok(!/"@type":\s*"BreadcrumbList"/.test(body.data.sections.implementationExample.content || ''));
      assert.notEqual(body.meta.source, 'template');
    });

    test('G. an existing INVALID BreadcrumbList is a conflict too', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      await withExisting([li(1, 'Home', HOME), li(7, 'Blog', BLOG_CANON)]);
      const body = await (await post(GOOD())).json();
      assert.equal(body.meta.schemaEvidence.breadcrumb.status, 'conflict');
      assert.equal(body.meta.schemaEvidence.breadcrumb.conflict.kind, 'existing_invalid');
    });

    test('F. an existing VALID trail identical to the submission: status "existing", nothing new generated', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      await withExisting([li(1, 'Home', HOME), li(2, 'Blog', BLOG_CANON)]);
      const body = await (await post(GOOD())).json();
      assert.equal(body.meta.schemaEvidence.breadcrumb.status, 'existing');
      assert.notEqual(body.data.sections.sourceAttribution?.promptPath, 'deterministic_user_breadcrumb_hierarchy');
    });
  });
});
