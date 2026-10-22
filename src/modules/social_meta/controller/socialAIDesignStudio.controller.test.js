import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import SocialAccount from '../model/SocialAccount.js';
import SocialAIStrategy from '../model/SocialAIStrategy.js';
import SocialDesignGeneration from '../model/SocialDesignGeneration.js';
import SocialPublication from '../model/SocialPublication.js';
import router from '../routes/socialAIDesignRoutes.js';
import { socialAIDesignGenerateRateLimiter } from '../middleware/socialAIStrategyRateLimiter.js';
import { getStudioHandler, studioGenerateHandler, studioRegenerateHandler, studioSelectHandler } from './socialAIDesignController.js';
import { createPublication, submitContentForApproval, approveContent } from '../service/socialPublishingService.js';
import { setDesignProviderOverride, resetDesignProviderOverride } from '../service/aiDesign/socialDesignGenerationService.js';
import { setDesignDirectorOverride, resetDesignDirectorOverride } from '../service/aiDesign/designDirector.js';
import { mockImageProvider, removeProjectMedia } from '../testSupport/designFixtures.js';
import { validRawStrategy } from '../testSupport/aiStrategyFixtures.js';

/** HTTP layer of Creative Studio: wiring, status codes, project isolation, whitelisted bodies, no leaks. */

let mongoAvailable = false;
before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
    await SocialDesignGeneration.init();
  } catch { mongoAvailable = false; }
});
after(async () => {
  resetDesignProviderOverride();
  if (mongoAvailable) await mongoose.connection.close();
});

const mockRes = () => ({
  statusCode: 200, body: null, headers: {},
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; },
  set(k, v) { this.headers[k] = v; return this; },
});

describe('Creative Studio routes - wiring', () => {
  const routes = router.stack.filter((l) => l.route).map((l) => ({ path: l.route.path, methods: Object.keys(l.route.methods), layers: l.route.stack.map((s) => s.handle) }));
  const find = (path, method) => routes.find((r) => r.path === path && r.methods.includes(method));

  test('1: every studio route is behind auth + project access; the two AI routes also share the design rate limiter; select does not call the AI', () => {
    assert.equal(find('/studio', 'get').layers.length, 3);
    assert.equal(find('/studio', 'get').layers[2], getStudioHandler);
    for (const [path, handler] of [['/studio/generate', studioGenerateHandler], ['/studio/regenerate', studioRegenerateHandler]]) {
      const r = find(path, 'post');
      assert.equal(r.layers.length, 4, path);
      assert.equal(r.layers[2], socialAIDesignGenerateRateLimiter, path);
      assert.equal(r.layers[3], handler, path);
    }
    const select = find('/studio/select', 'post');
    assert.equal(select.layers.length, 3);
    assert.equal(select.layers[2], studioSelectHandler);
  });
});

describe('Creative Studio endpoints (real MongoDB, real sharp/storage, scripted provider)', () => {
  let owner, stranger, project, otherProject, pid, opid, created, fb, pub;
  const track = (d) => { created.push(d); return d; };

  beforeEach(async () => {
    setDesignDirectorOverride(async () => null);
    if (!mongoAvailable) return;
    created = [];
    owner = new mongoose.Types.ObjectId();
    stranger = new mongoose.Types.ObjectId();
    const mk = (u) => SeoProject.create({ user_id: u, project_name: `Studio Ctrl ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'], description: 'A dental practice' });
    project = track(await mk(owner));
    otherProject = track(await mk(stranger));
    pid = project._id.toString();
    opid = otherProject._id.toString();
    fb = await SocialAccount.create({ user_id: owner, project_id: project._id, platform: 'facebook', platformAccountId: 'pgsc', platformAccountName: 'P', accountType: 'page', pageId: 'pgsc', accessToken: 'FB-SECRET-TOKEN', status: 'active', isActive: true });
    await SocialAIStrategy.create({ project_id: project._id, version: 1, status: 'ready', strategy: validRawStrategy(), profileSnapshot: { generatedAt: new Date(), hash: 'h', data: { business: { name: 'Acme Dental', category: 'Dentist' }, brand: { primaryColor: '#1d4ed8' }, offers: [], competitors: [], prohibitedPhrases: [] } }, generation: { startedAt: new Date(), finishedAt: new Date() } });
    const r = await createPublication(pid, owner, { platform: 'facebook', socialAccountId: fb._id.toString(), content: 'Owner private caption about teeth\n\n#Teeth #Care' });
    await submitContentForApproval(pid, r.publication.id, owner);
    pub = (await approveContent(pid, r.publication.id, owner, 1)).publication;
  });

  afterEach(async () => {
    resetDesignProviderOverride();
    resetDesignDirectorOverride();
    if (!mongoAvailable) return;
    const ids = created.map((d) => d._id);
    await Promise.all([SocialDesignGeneration.deleteMany({ project_id: { $in: ids } }), SocialPublication.deleteMany({ project_id: { $in: ids } }), SocialAIStrategy.deleteMany({ project_id: { $in: ids } }), SocialAccount.deleteMany({ project_id: { $in: ids } })]);
    await SeoProject.deleteMany({ _id: { $in: ids } });
    for (const id of ids) await removeProjectMedia(id);
  });

  const call = async (handler, { projectId = pid, userId = owner, query = {}, body = {} } = {}) => { const res = mockRes(); await handler({ projectId, userId: String(userId), query: { projectId, ...query }, body: { projectId, ...body } }, res); return res; };
  const getState = (query = { publicationId: pub.id }, projectId = pid) => call(getStudioHandler, { projectId, query });
  const generate = (body = {}, projectId = pid) => call(studioGenerateHandler, { projectId, body: { publicationId: pub.id, contentVersion: 1, ...body } });
  const settled = async () => { for (let i = 0; i < 400; i += 1) { if (!(await SocialDesignGeneration.countDocuments({ project_id: project._id, active: true }))) return; await new Promise((r) => setTimeout(r, 20)); } throw new Error('did not finish'); };

  test('2: GET /studio returns the real post and its gate; a missing / unknown / other-project publication is a 404 (never a fallback)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const ok = await getState();
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.body.data.content.caption, 'Owner private caption about teeth');
    assert.deepEqual(ok.body.data.content.hashtags, ['#Teeth', '#Care']);
    assert.equal(ok.body.data.gate.allowed, true);
    assert.equal(ok.body.data.generation, null);
    for (const query of [{}, { publicationId: 'nope' }, { publicationId: String(new mongoose.Types.ObjectId()) }]) assert.equal((await getState(query)).statusCode, 404, JSON.stringify(query));
    const cross = await getState({ publicationId: pub.id }, opid);
    assert.equal(cross.statusCode, 404);
    assert.equal(JSON.stringify(cross.body).includes('teeth'), false);
  });

  test('3: POST /studio/generate -> 202 at once, a duplicate joins it, GET shows three real candidates when it finishes, the post is untouched', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    let release;
    const gate = new Promise((r) => { release = r; });
    const provider = mockImageProvider({ gate });
    setDesignProviderOverride(provider);
    const started = await generate();
    assert.equal(started.statusCode, 202);
    assert.equal(started.body.data.status, 'generating');
    assert.equal(started.body.data.alreadyRunning, false);
    const dup = await generate();
    assert.equal(dup.statusCode, 202);
    assert.equal(dup.body.data.alreadyRunning, true);
    assert.equal(dup.body.data.generationId, started.body.data.generationId);
    const running = await getState();
    assert.equal(running.body.data.generation.status, 'generating');
    release();
    await settled();
    const done = await getState();
    assert.equal(done.body.data.generation.status, 'ready');
    assert.equal(done.body.data.generation.candidates.length, 3);
    assert.equal(new Set(done.body.data.generation.candidates.map((c) => c.creativeType)).size, 3);
    assert.equal(provider.calls.length, 2, 'two photographs; the infographic needs none');
    assert.equal((await SocialPublication.findById(pub.id).lean()).designVersion, 1);
  });

  test('4: the gate and the version check are HTTP errors with codes: 409 for unapproved content / a stale caption, 400 for bad input, 404 for another project', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const provider = mockImageProvider();
    setDesignProviderOverride(provider);
    const stale = await generate({ contentVersion: 5 });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.body.details.code, 'VERSION_MISMATCH');
    assert.equal(stale.body.details.currentContentVersion, 1);
    const bad = await generate({ contentVersion: 'one' });
    assert.equal(bad.statusCode, 400);
    assert.equal((await generate({}, opid)).statusCode, 404);
    const draft = (await createPublication(pid, owner, { platform: 'facebook', socialAccountId: fb._id.toString(), content: 'Not approved yet' })).publication;
    const gated = await call(studioGenerateHandler, { body: { publicationId: draft.id, contentVersion: 1 } });
    assert.equal(gated.statusCode, 409);
    assert.equal(gated.body.details.code, 'CONTENT_NOT_APPROVED');
    assert.equal(provider.calls.length, 0);
  });

  test('5: select -> 200 with the post in design_review at designVersion 2; a stale designVersion is a 409 carrying the current one', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    setDesignProviderOverride(mockImageProvider());
    await generate();
    await settled();
    const g = (await getState()).body.data.generation;
    const pick = (over = {}) => ({ publicationId: pub.id, generationId: g.id, candidateId: g.candidates[0].id, contentVersion: 1, designVersion: 1, ...over });
    const ok = await call(studioSelectHandler, { body: pick() });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.body.data.designVersion, 2);
    assert.equal(ok.body.data.publication.approval.state, 'design_review');
    const stale = await call(studioSelectHandler, { body: pick({ candidateId: g.candidates[1].id }) });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.body.details.code, 'DESIGN_VERSION_MISMATCH');
    assert.equal(stale.body.details.currentDesignVersion, 2);
    assert.equal((await call(studioSelectHandler, { projectId: opid, body: pick({ designVersion: 2 }) })).statusCode, 404);
  });

  test('6: POST /studio/regenerate takes only whitelisted fields: forged versions / prompts / ids are ignored; the instruction reaches the provider', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const provider = mockImageProvider();
    setDesignProviderOverride(provider);
    await generate();
    await settled();
    const g = (await getState()).body.data.generation;
    const photo = g.candidates.find((c) => c.layoutId === 'photo_hero');
    const res = await call(studioRegenerateHandler, { body: { publicationId: pub.id, generationId: g.id, candidateId: photo.id, contentVersion: 1, instruction: 'Use a different photo of a team in a clinic', designVersion: 99, approvalState: 'design_approved', prompt: 'PWNED', size: '4096x4096' } });
    assert.equal(res.statusCode, 202);
    await settled();
    assert.equal(provider.calls.length, 3, 'a change about the picture asks the model for a new one');
    const last = provider.calls.at(-1);
    assert.match(last.prompt, /<requested_visual_changes>\nUse a different photo of a team in a clinic/);
    assert.equal(last.prompt.includes('PWNED'), false);
    assert.ok(['1024x1024', '1536x1024', '1024x1536'].includes(last.size), 'the size is decided on the server');
    const bad = await call(studioRegenerateHandler, { body: { publicationId: pub.id, generationId: g.id, candidateId: photo.id, contentVersion: 1, instruction: 'x'.repeat(500) } });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.body.details.code, 'INVALID_INSTRUCTION');
  });

  test('7: nothing in any studio response leaks tokens, storage keys or prompt text', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    setDesignProviderOverride(mockImageProvider());
    const started = await generate();
    await settled();
    const text = JSON.stringify([started.body, (await getState()).body]);
    for (const bad of ['FB-SECRET-TOKEN', 'accessToken', 'storageKey', 'HARD RULES', 'text_to_render', 'lockedBy']) assert.equal(text.includes(bad), false, bad);
  });
});
