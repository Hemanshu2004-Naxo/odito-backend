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
import SchemaOrganizationAddress from '../../schema-evidence/SchemaOrganizationAddress.js';
import claudeService from '../service/claudeService.js';
import schemaEvidenceService from '../../schema-evidence/schemaEvidenceService.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import { confirmOrganizationAddress } from '../controller/recommendationController.js';

/**
 * Real HTTP dispatch for POST /recommendations/organization-address ("Confirm Address"): real validateProjectAccess, real
 * controller, real recommendation service, live local Mongo (auto-skip when unreachable). Only the JWT middleware is replaced
 * and the LLM is off. No website is contacted and no image is fetched (the verifier is stubbed to "unreachable").
 *
 * TEST DATA ONLY: ".example" domain, fictional business and address.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'https://address-route-test.example';
const ORG_ID = `${ORIGIN}/#organization`;
const GRAPH = [{ '@context': 'https://schema.org', '@graph': [
  { '@type': 'WebSite', '@id': `${ORIGIN}/#website`, url: `${ORIGIN}/`, name: 'Address Route Test' },
  { '@type': 'Organization', '@id': ORG_ID, name: 'Address Route Test', url: `${ORIGIN}/`, sameAs: [`${ORIGIN}/profile`] },
] }];
const ADDRESS = { streetAddress: '14 Lakeview Road', addressLocality: 'Rivertown', addressRegion: 'Karnataka', postalCode: '560001', addressCountry: 'IN' };

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
  app.post('/recommendations/organization-address', validateProjectAccess(), confirmOrganizationAddress);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoAvailable) await mongoose.connection.close();
});

describe('the route is registered behind authentication and project ownership', () => {
  test('recommendationRoutes.js mounts POST /organization-address with validateProjectAccess(), under router.use(auth)', () => {
    const text = fs.readFileSync(path.join(__dirname, 'recommendationRoutes.js'), 'utf8');
    assert.match(text, /router\.use\(auth\)/);
    assert.match(text, /router\.post\('\/organization-address',\s*validateProjectAccess\(\),\s*confirmOrganizationAddress\)/);
    assert.ok(text.indexOf('router.use(auth)') < text.indexOf("'/organization-address'"));
  });
});

describe('POST /recommendations/organization-address', () => {
  let userId; let otherUserId; let project; let otherProject; let created;

  const post = (body, { user = userId } = {}) => fetch(`${baseUrl}/recommendations/organization-address`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user-id': String(user) } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const GOOD = () => ({ projectId: String(project._id), pageUrl: ORIGIN, address: { ...ADDRESS } });
  const counts = async () => ({
    addresses: await SchemaOrganizationAddress.countDocuments({ projectId: { $in: created } }),
    tasks: await Task.countDocuments({ projectId: { $in: created } }),
    jobs: await mongoose.connection.db.collection('jobs').countDocuments({ $or: [{ projectId: project._id }, { project_id: project._id }] }),
  });

  beforeEach(async () => {
    mock.restoreAll();
    if (!mongoAvailable) return;
    mock.method(claudeService, 'isAvailable', () => false);
    // no network: the logo verifier reports nothing
    mock.method(schemaEvidenceService, 'collectSchemaEvidence', schemaEvidenceService.collectSchemaEvidence);
    userId = new mongoose.Types.ObjectId();
    otherUserId = new mongoose.Types.ObjectId();
    project = await SeoProject.create({ user_id: userId, project_name: `Addr route ${Date.now()}`, main_url: ORIGIN, seo_scope: 'local', keywords: ['x'] });
    otherProject = await SeoProject.create({ user_id: otherUserId, project_name: `Addr other ${Date.now()}`, main_url: ORIGIN, seo_scope: 'local', keywords: ['x'] });
    created = [project._id, otherProject._id];
    const db = mongoose.connection.db;
    await db.collection('seo_page_data').insertOne({ projectId: project._id, url: ORIGIN, canonical: `${ORIGIN}/`, title: 'Home', structured_data: GRAPH, meta_tags: {}, images: [], word_count: 300, page_type: { name: 'homepage' } });
    await db.collection('seo_page_data').insertOne({ projectId: otherProject._id, url: `${ORIGIN}/other`, title: 'Other', structured_data: [] });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    const db = mongoose.connection.db;
    await Recommendation.deleteMany({ projectId: { $in: created } });
    await SchemaOrganizationAddress.deleteMany({ projectId: { $in: created } });
    await Task.deleteMany({ projectId: { $in: created } });
    await db.collection('seo_page_data').deleteMany({ projectId: { $in: created } });
    await db.collection('seo_page_issues').deleteMany({ projectId: { $in: created } });
    await SeoProject.deleteMany({ _id: { $in: created } });
  });

  describe('authentication and ownership', () => {
    test('no authenticated user -> 401, nothing stored', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const res = await post(GOOD(), { user: null });
      assert.equal(res.status, 401);
      assert.deepEqual(await counts(), { addresses: 0, tasks: 0, jobs: 0 });
    });

    test("another user's project -> refused (403/404); nothing is stored", async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const res = await post(GOOD(), { user: otherUserId });
      assert.ok([403, 404].includes(res.status), `status ${res.status}`);
      assert.deepEqual(await counts(), { addresses: 0, tasks: 0, jobs: 0 });
    });

    test("the caller's own project but another project's page -> 404 PAGE_NOT_FOUND, nothing stored", async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const res = await post({ projectId: String(otherProject._id), pageUrl: ORIGIN, address: ADDRESS }, { user: otherUserId });
      assert.equal(res.status, 404);
      assert.equal((await res.json()).code, 'PAGE_NOT_FOUND');
      assert.equal(await SchemaOrganizationAddress.countDocuments({ projectId: otherProject._id }), 0);
    });
  });

  describe('validation', () => {
    test('a missing street, a missing city, markup and non-text are rejected with 422 and the offending field; nothing is stored', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      for (const [patch, field] of [
        [{ streetAddress: '' }, 'streetAddress'],
        [{ addressLocality: '' }, 'addressLocality'],
        [{ streetAddress: '<img src=x onerror=alert(1)>' }, 'streetAddress'],
        [{ addressLocality: { $ne: null } }, 'addressLocality'],
        [{ postalCode: '56{0}001' }, 'postalCode'],
      ]) {
        const res = await post({ ...GOOD(), address: { ...ADDRESS, ...patch } });
        assert.equal(res.status, 422, JSON.stringify(patch));
        const json = await res.json();
        assert.equal(json.code, 'ADDRESS_INPUT_INVALID');
        assert.equal(json.field, field);
      }
      assert.equal((await counts()).addresses, 0);
    });

    test('pageUrl is required', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const res = await post({ projectId: String(project._id), address: ADDRESS });
      assert.equal(res.status, 400);
    });
  });

  describe('the happy path', () => {
    test('stores the confirmed address, regenerates the recommendation as READY with the exact diff, and touches nothing else', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const res = await post(GOOD());
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);
      assert.equal(json.meta.addressChanged, true);

      const fix = json.meta.schemaEvidence.organization.addressFix;
      assert.equal(fix.state, 'ready');
      assert.equal(fix.action, 'review_and_apply');
      assert.equal(fix.proposal.status, 'confirmed_by_owner');
      assert.deepEqual(fix.diff.changes, [{ path: 'address', kind: 'add', before: null, after: { '@type': 'PostalAddress', ...ADDRESS } }]);
      assert.equal(fix.diff.after['@id'], ORG_ID);
      assert.equal(fix.modifiesWebsite, false);
      assert.equal(fix.requiresApproval, true);

      // The text no longer claims "reuse / second copy would duplicate".
      assert.doesNotMatch(JSON.stringify(json.data), /second copy would create a duplicate/i);
      assert.match(json.data.sections.recommendedFix, /14 Lakeview Road/);

      const stored = await SchemaOrganizationAddress.findOne({ projectId: project._id }).lean();
      assert.equal(stored.fields.streetAddress, '14 Lakeview Road');
      assert.equal(String(stored.confirmedBy), String(userId));
      assert.equal(stored.basis, 'typed');
      // no task, no job, and the crawled page document is untouched (the website is never modified)
      assert.deepEqual(await counts(), { addresses: 1, tasks: 0, jobs: 0 });
      const page = await mongoose.connection.db.collection('seo_page_data').findOne({ projectId: project._id, url: ORIGIN });
      assert.deepEqual(page.structured_data, GRAPH);
    });

    test('confirming the same address again is idempotent: one record, addressChanged=false', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      await post(GOOD());
      const second = await (await post(GOOD())).json();
      assert.equal(second.meta.addressChanged, false);
      assert.equal(await SchemaOrganizationAddress.countDocuments({ projectId: project._id }), 1);
    });

    test('a different confirmed address replaces it, the recommendation follows, and the stale one is not served', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const first = await (await post(GOOD())).json();
      const second = await (await post({ ...GOOD(), address: { ...ADDRESS, streetAddress: '15 Lakeview Road' } })).json();
      assert.equal(second.meta.addressChanged, true);
      assert.equal(second.meta.schemaEvidence.organization.addressFix.proposal.value.streetAddress, '15 Lakeview Road');
      assert.notEqual(first.data.id, second.data.id, 'a different address is a different recommendation');
      const doc = await SchemaOrganizationAddress.findOne({ projectId: project._id }).lean();
      assert.equal(doc.revision, 2);
    });

    test('the address belongs to the project: another project is unaffected and still sees "no address"', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      await post(GOOD());
      assert.equal(await SchemaOrganizationAddress.countDocuments({ projectId: otherProject._id }), 0);
    });

    test('basisSource is recorded only for a known source; anything else is treated as typed', async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      await post({ ...GOOD(), basisSource: 'site_entity_markup' });
      assert.equal((await SchemaOrganizationAddress.findOne({ projectId: project._id }).lean()).basisSource, 'site_entity_markup');
      await SchemaOrganizationAddress.deleteMany({ projectId: project._id });
      await post({ ...GOOD(), basisSource: '<script>' });
      const doc = await SchemaOrganizationAddress.findOne({ projectId: project._id }).lean();
      assert.equal(doc.basis, 'typed');
      assert.equal(doc.basisSource, null);
    });
  });
});
