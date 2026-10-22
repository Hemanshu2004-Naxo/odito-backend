import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import GoogleConnection from '../../app_user/model/GoogleConnection.js';
import BusinessProfileMetadata from '../../app_user/model/BusinessProfileMetadata.js';
import SocialBusinessProfile from '../model/SocialBusinessProfile.js';
import router from '../routes/socialBusinessProfileRoutes.js';
import mainRouter from '../../../routes/index.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import { getSocialBusinessProfileHandler, updateSocialBusinessProfileHandler } from './socialBusinessProfileController.js';

/**
 * HTTP layer of the Social Business Profile: response shape, status codes,
 * route wiring, and — through the REAL validateProjectAccess() middleware —
 * cross-project isolation. The resolver / validation rules themselves are
 * covered in service/socialBusinessProfile.test.js.
 */

let mongoAvailable = false;
before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch {
    mongoAvailable = false;
  }
});
after(async () => {
  if (mongoAvailable) await mongoose.connection.close();
});

const mockRes = () => ({
  statusCode: 200, body: null,
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; },
});

describe('social business profile — route wiring', () => {
  const routes = router.stack.filter((l) => l.route).map((l) => ({ path: l.route.path, methods: Object.keys(l.route.methods), layers: l.route.stack.length }));

  test('1: GET and PUT exist, each behind auth + validateProjectAccess + handler', () => {
    for (const method of ['get', 'put']) {
      const r = routes.find((x) => x.path === '/' && x.methods.includes(method));
      assert.ok(r, `${method} /`);
      assert.equal(r.layers, 3);
    }
  });

  test('2: the router is mounted at /social/business-profile (and nothing else was added to the API surface)', () => {
    const mounts = mainRouter.stack.filter((l) => !l.route && l.handle === router).map((l) => String(l.regexp));
    assert.equal(mounts.length, 1);
    assert.match(mounts[0], /social\\\/business-profile/);
    // the profile itself (GET / PUT) plus the user's brand logo (POST / DELETE /logo) — nothing else
    assert.deepEqual(
      routes.map((r) => `${r.methods.join(',')} ${r.path}`).sort(),
      ['delete /logo', 'get /', 'post /logo', 'put /'],
    );
  });

  test('3: the logo routes sit behind auth + validateProjectAccess (the upload also behind multer, which must run first)', () => {
    const upload = routes.find((x) => x.path === '/logo' && x.methods.includes('post'));
    const remove = routes.find((x) => x.path === '/logo' && x.methods.includes('delete'));
    assert.equal(upload.layers, 4, 'auth, multer, validateProjectAccess, handler');
    assert.equal(remove.layers, 3, 'auth, validateProjectAccess, handler');
  });
});

describe('social business profile — endpoints (real MongoDB)', () => {
  let owner, stranger, project, otherProject, pid, created;
  const track = (d) => { created.push(d); return d; };

  beforeEach(async () => {
    if (!mongoAvailable) return;
    created = [];
    owner = new mongoose.Types.ObjectId();
    stranger = new mongoose.Types.ObjectId();
    const mk = (u, extra = {}) => SeoProject.create({ user_id: u, project_name: `Biz Ctrl ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'], ...extra });
    project = track(await mk(owner, { verified_business: { name: 'Owner Biz' } }));
    otherProject = track(await mk(stranger, { verified_business: { name: 'Stranger Biz' } }));
    pid = project._id.toString();
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    const ids = created.map((d) => d._id);
    await SocialBusinessProfile.deleteMany({ project_id: { $in: ids } });
    await GoogleConnection.deleteMany({ project_id: { $in: ids } });
    await BusinessProfileMetadata.deleteMany({ project_id: { $in: ids } });
    await SeoProject.deleteMany({ _id: { $in: ids } });
  });

  const get = async (projectId = pid) => { const res = mockRes(); await getSocialBusinessProfileHandler({ projectId, userId: String(owner), query: { projectId } }, res); return res; };
  const put = async (body, projectId = pid) => { const res = mockRes(); await updateSocialBusinessProfileHandler({ projectId, userId: String(owner), body: { projectId, ...body } }, res); return res; };

  test('3: GET returns { resolvedProfile, editableProfile, googleStatus } from real project data, with no Google connection', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = await get();
    assert.equal(res.statusCode, 200);
    const { resolvedProfile, editableProfile, googleStatus } = res.body.data;
    assert.equal(resolvedProfile.projectId, pid);
    assert.deepEqual([resolvedProfile.business.name.value, resolvedProfile.business.name.source], ['Owner Biz', 'verified_business']);
    assert.equal(googleStatus.connectionStatus, 'not_connected');
    assert.equal(resolvedProfile.meta.hasGoogleBusinessProfile, false);
    assert.equal(editableProfile.exists, false);
  });

  test('4: PUT saves manual fields and returns the re-resolved profile (an override takes effect server-side)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = await put({ goals: ['Grow'], toneOfVoice: { primary: 'Warm' }, overrides: { businessName: 'Brand Name' } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data.editableProfile.goals, ['Grow']);
    assert.deepEqual([res.body.data.resolvedProfile.business.name.value, res.body.data.resolvedProfile.business.name.source], ['Brand Name', 'social_override']);
    assert.deepEqual(res.body.data.resolvedProfile.strategy.toneOfVoice, { primary: 'Warm', secondary: [] });
    // and a later GET sees the same (persisted, not just echoed)
    const again = await get();
    assert.deepEqual(again.body.data.editableProfile.goals, ['Grow']);
  });

  test('5: invalid input is a 400 with a code and a readable message; nothing is saved', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    let res = await put({ offers: [{ name: 'x', url: 'javascript:alert(1)' }] });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.details.code, 'INVALID_PROFILE');
    assert.match(res.body.message, /offers\[0\]\.url/);
    res = await put({ business_location_id: 'evil' });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.details.code, 'UNKNOWN_FIELD');
    res = await put({});
    assert.equal(res.body.details.code, 'EMPTY_UPDATE');
    assert.equal(await SocialBusinessProfile.countDocuments({ project_id: project._id }), 0);
  });

  test('6: a project that no longer exists is a 404 (never another project\'s data)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const ghost = new mongoose.Types.ObjectId().toString();
    assert.equal((await get(ghost)).statusCode, 404);
    const saved = await put({ goals: ['x'] }, ghost);
    assert.equal(saved.statusCode, 404);
    assert.equal(await SocialBusinessProfile.countDocuments({ project_id: ghost }), 0, 'no orphan profile is created');
  });

  test('7: cross-project access is blocked by validateProjectAccess() for both GET and PUT, before any handler runs', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialBusinessProfile.create({ project_id: project._id, goals: ['Owner secret goal'] });
    const mw = validateProjectAccess();
    for (const req of [
      { user: { id: String(stranger) }, query: { projectId: pid }, params: {}, body: {}, path: '/', method: 'GET' },
      { user: { id: String(stranger) }, query: {}, params: {}, body: { projectId: pid, goals: ['hijack'] }, path: '/', method: 'PUT' },
    ]) {
      const res = mockRes();
      let nextCalled = false;
      await mw(req, res, () => { nextCalled = true; });
      assert.equal(nextCalled, false, `${req.method}: the handler must not run`);
      assert.ok([403, 404].includes(res.statusCode), `${req.method} -> ${res.statusCode}`);
      assert.equal(JSON.stringify(res.body).includes('Owner secret goal'), false);
    }
    const doc = await SocialBusinessProfile.findOne({ project_id: project._id }).lean();
    assert.deepEqual(doc.goals, ['Owner secret goal'], 'the stranger changed nothing');

    // the owner passes the same middleware
    let ok = false;
    await mw({ user: { id: String(owner) }, query: { projectId: pid }, params: {}, body: {}, path: '/', method: 'GET' }, mockRes(), () => { ok = true; });
    assert.equal(ok, true);
  });

  test('8: the response carries no Google token, ciphertext, or Google ids even when a connection exists', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    track(await GoogleConnection.create({
      user_id: owner, project_id: project._id, purpose: 'business_profile', service_type: ['business_profile'],
      business_account_id: 'acct-XYZ', business_location_id: 'loc-XYZ', refresh_token: 'REFRESH-SECRET', access_token: 'ACCESS-SECRET',
      google_email: 'o@example.com', google_name: 'O', status: 'active',
    }));
    track(await BusinessProfileMetadata.create({
      user_id: owner, project_id: project._id, business_account_id: 'acct-XYZ', business_location_id: 'loc-XYZ', business_name: 'Google Biz',
      metadata_last_synced_at: new Date(), details_last_synced_at: new Date(),
    }));
    const getRes = await get();
    const putRes = await put({ goals: ['a'] });
    for (const res of [getRes, putRes]) {
      const json = JSON.stringify(res.body);
      for (const secret of ['REFRESH-SECRET', 'ACCESS-SECRET', 'enc:v1', 'acct-XYZ', 'loc-XYZ', 'refresh_token']) assert.equal(json.includes(secret), false, secret);
      assert.equal(res.body.data.resolvedProfile.business.name.source, 'google_business_profile');
      assert.equal(res.body.data.googleStatus.connected, true);
      assert.equal(res.body.data.googleStatus.googleEmail, 'o@example.com');
    }
  });
});
