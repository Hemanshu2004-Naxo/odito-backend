import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import SocialAccount from '../model/SocialAccount.js';
import SocialDesignGeneration from '../model/SocialDesignGeneration.js';
import SocialPublication from '../model/SocialPublication.js';
import router from '../routes/socialAIDesignRoutes.js';
import mainRouter from '../../../routes/index.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import { socialAIDesignGenerateRateLimiter, socialAIContentGenerateRateLimiter } from '../middleware/socialAIStrategyRateLimiter.js';
import { generateAIDesignHandler, getAIDesignStatusHandler } from './socialAIDesignController.js';
import { createPublication, submitContentForApproval, approveContent } from '../service/socialPublishingService.js';
import { setDesignProviderOverride, resetDesignProviderOverride, getDesignGenerationStatus } from '../service/aiDesign/socialDesignGenerationService.js';
import { DESIGN_RATE_LIMIT } from '../service/aiDesign/designConfig.js';
import { CONTENT_RATE_LIMIT } from '../service/aiContent/contentConfig.js';
import { mockImageProvider, removeProjectMedia } from '../testSupport/designFixtures.js';
import { providerError } from '../testSupport/aiStrategyFixtures.js';

/** HTTP layer of AI design generation: wiring, status codes, cross-project blocking, rate limiting, client-controlled fields. */

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

describe('AI design routes - wiring', () => {
  const routes = router.stack.filter((l) => l.route).map((l) => ({ path: l.route.path, methods: Object.keys(l.route.methods), layers: l.route.stack.map((s) => s.handle) }));
  const find = (path, method) => routes.find((r) => r.path === path && r.methods.includes(method));

  test('1: POST /generate = auth + project access + rate limiter + handler; GET /status = auth + project access + handler', () => {
    const gen = find('/generate', 'post');
    assert.equal(gen.layers.length, 4);
    assert.equal(gen.layers[2], socialAIDesignGenerateRateLimiter, 'rate limit runs after auth + project access, before the handler');
    assert.equal(gen.layers[3], generateAIDesignHandler);
    const status = find('/status', 'get');
    assert.equal(status.layers.length, 3);
    assert.equal(status.layers[2], getAIDesignStatusHandler);
  });

  test('2: generate, status and the four Creative Studio routes - no approve / schedule / publish / edit route', () => {
    assert.deepEqual(routes.map((r) => `${r.methods.join()} ${r.path}`).sort(), ['get /status', 'get /studio', 'post /generate', 'post /studio/generate', 'post /studio/regenerate', 'post /studio/select']);
  });

  test('3: mounted at /social/ai-design', () => {
    const mounts = mainRouter.stack.filter((l) => !l.route && l.handle === router).map((l) => String(l.regexp));
    assert.equal(mounts.length, 1);
    assert.match(mounts[0], /social\\\/ai-design/);
  });

  test('4: image generation has its OWN, tighter budget; 429 RATE_LIMITED + Retry-After once spent; per user; switchable', async () => {
    assert.notEqual(socialAIDesignGenerateRateLimiter, socialAIContentGenerateRateLimiter);
    assert.ok(DESIGN_RATE_LIMIT.max < CONTENT_RATE_LIMIT.max, 'images cost more than text');
    process.env.SOCIAL_AI_DESIGN_RATE_LIMIT_ENABLED = 'false';
    let passed = false;
    socialAIDesignGenerateRateLimiter({ user: { _id: 'u-off' }, ip: '1.1.1.1' }, mockRes(), () => { passed = true; });
    assert.equal(passed, true);
    delete process.env.SOCIAL_AI_DESIGN_RATE_LIMIT_ENABLED;

    const hit = async (userKey) => {
      const res = mockRes();
      let next = false;
      await new Promise((resolve) => {
        const req = { user: { _id: userKey }, ip: '3.3.3.3', headers: {}, app: { get: () => false } };
        const origJson = res.json.bind(res);
        res.json = (p) => { origJson(p); resolve(); return res; };
        res.setHeader = () => {};
        res.getHeader = () => undefined;
        socialAIDesignGenerateRateLimiter(req, res, () => { next = true; resolve(); });
      });
      return { res, next };
    };
    let blocked = null;
    for (let i = 0; i < DESIGN_RATE_LIMIT.max + 1; i += 1) { const r = await hit('d-limited'); if (!r.next) blocked = r.res; }
    assert.ok(blocked);
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.body.details.code, 'RATE_LIMITED');
    assert.ok(blocked.headers['Retry-After']);
    assert.equal((await hit('d-another')).next, true);
  });
});

describe('AI design endpoints (real MongoDB, real sharp/storage, scripted provider)', () => {
  let owner, stranger, project, otherProject, pid, created, fb, pub;
  const track = (d) => { created.push(d); return d; };

  beforeEach(async () => {
    if (!mongoAvailable) return;
    created = [];
    owner = new mongoose.Types.ObjectId();
    stranger = new mongoose.Types.ObjectId();
    const mk = (u) => SeoProject.create({ user_id: u, project_name: `Design Ctrl ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'], description: 'A dental practice' });
    project = track(await mk(owner));
    otherProject = track(await mk(stranger));
    pid = project._id.toString();
    fb = await SocialAccount.create({ user_id: owner, project_id: project._id, platform: 'facebook', platformAccountId: 'pgdc', platformAccountName: 'P', accountType: 'page', pageId: 'pgdc', accessToken: 'FB-SECRET-TOKEN', status: 'active', isActive: true });
    const r = await createPublication(pid, owner, { platform: 'facebook', socialAccountId: fb._id.toString(), content: 'Owner private caption about teeth' });
    await submitContentForApproval(pid, r.publication.id, owner);
    pub = (await approveContent(pid, r.publication.id, owner, 1)).publication;
  });

  afterEach(async () => {
    resetDesignProviderOverride();
    if (!mongoAvailable) return;
    const ids = created.map((d) => d._id);
    await Promise.all([SocialDesignGeneration.deleteMany({ project_id: { $in: ids } }), SocialPublication.deleteMany({ project_id: { $in: ids } }), SocialAccount.deleteMany({ project_id: { $in: ids } })]);
    await SeoProject.deleteMany({ _id: { $in: ids } });
    for (const id of ids) await removeProjectMedia(id);
  });

  const body = (over = {}) => ({ publicationId: pub.id, contentVersion: 1, ...over });
  const post = async (payload = body(), projectId = pid, userId = owner) => { const res = mockRes(); await generateAIDesignHandler({ projectId, userId: String(userId), query: { projectId }, body: { projectId, ...payload } }, res); return res; };
  const status = async (query = {}, projectId = pid, userId = owner) => { const res = mockRes(); await getAIDesignStatusHandler({ projectId, userId: String(userId), query: { projectId, publicationId: pub.id, ...query }, body: {} }, res); return res; };
  const settled = async () => { for (let i = 0; i < 300; i += 1) { if (!(await SocialDesignGeneration.countDocuments({ project_id: project._id, active: true }))) return; await new Promise((r) => setTimeout(r, 20)); } throw new Error('did not finish'); };

  test('5: POST -> 202 at once; a duplicate joins it; polling shows generating then ready with the REAL publication in design_review', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    let release;
    const gate = new Promise((r) => { release = r; });
    const provider = mockImageProvider({ gate });
    setDesignProviderOverride(provider);

    const started = await post();
    assert.equal(started.statusCode, 202);
    assert.equal(started.body.data.status, 'generating');
    assert.equal(started.body.data.alreadyRunning, false);
    assert.ok(started.body.data.generationId);
    const dup = await post();
    assert.equal(dup.statusCode, 202);
    assert.equal(dup.body.data.alreadyRunning, true);
    assert.equal(dup.body.data.generationId, started.body.data.generationId);

    const mid = await status();
    assert.equal(mid.body.data.status, 'generating');
    assert.equal(mid.body.data.publication.approval.state, 'content_approved');
    assert.deepEqual(mid.body.data.publication.media, []);

    release();
    await settled();
    const done = await status({ generationId: started.body.data.generationId });
    assert.equal(done.statusCode, 200);
    assert.equal(done.body.data.status, 'ready');
    assert.equal(done.body.data.publication.approval.state, 'design_review');
    assert.equal(done.body.data.publication.approval.designVersion, 2);
    assert.equal(done.body.data.publication.media.length, 1);
    assert.equal(done.body.data.publication.status, 'draft');
    assert.equal(provider.calls.length, 1);
  });

  test('6: refusals map to HTTP statuses with a machine code; the provider is not called', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const provider = mockImageProvider();
    setDesignProviderOverride(provider);
    const stale = await post(body({ contentVersion: 7 }));
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.body.details.code, 'VERSION_MISMATCH');
    assert.equal(stale.body.details.currentContentVersion, 1);
    assert.equal((await post(body({ contentVersion: 'x' }))).statusCode, 400);
    assert.equal((await post(body({ publicationId: 'nope' }))).statusCode, 400);
    assert.equal((await post(body({ publicationId: new mongoose.Types.ObjectId().toString() }))).statusCode, 404);

    const draft = await createPublication(pid, owner, { platform: 'facebook', socialAccountId: fb._id.toString(), content: 'not approved' });
    const unapproved = await post(body({ publicationId: draft.publication.id }));
    assert.equal(unapproved.statusCode, 409);
    assert.equal(unapproved.body.details.code, 'CONTENT_NOT_APPROVED');

    await SocialAccount.updateOne({ _id: fb._id }, { $set: { status: 'expired' } });
    assert.equal((await post()).body.details.code, 'PLATFORM_NOT_CONNECTED');
    assert.equal(provider.calls.length, 0);
  });

  test('7: AI not configured -> 503 AI_UNAVAILABLE and nothing is created', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    setDesignProviderOverride(mockImageProvider({ available: false }));
    const res = await post();
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.details.code, 'AI_UNAVAILABLE');
    assert.equal(await SocialDesignGeneration.countDocuments({ project_id: project._id }), 0);
  });

  test('8: a failed generation is reported with the safe failure; no provider detail, prompt, key or token in any response', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    setDesignProviderOverride(mockImageProvider({ behavior: () => { throw providerError('AI_PROVIDER_AUTH', { message: 'sk-LEAK', bodySnippet: 'sk-LEAK' }); } }));
    await post();
    await settled();
    const res = await status();
    assert.equal(res.body.data.status, 'failed');
    assert.equal(res.body.data.generation.failure.code, 'AI_UNAVAILABLE');
    assert.equal(res.body.data.publication.approval.state, 'content_approved');
    const text = JSON.stringify(res.body);
    for (const leak of ['sk-LEAK', 'AI_PROVIDER_', 'OPENAI', 'FB-SECRET-TOKEN', 'accessToken', 'lockedBy', 'approved_caption', 'HARD RULES']) assert.equal(text.includes(leak), false, leak);
  });

  test('9: cross-project: validateProjectAccess() blocks the stranger before any handler; a foreign publication id is the same safe 404 as an unknown one', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    setDesignProviderOverride(mockImageProvider());
    await post();
    await settled();
    const mw = validateProjectAccess();
    for (const method of ['GET', 'POST']) {
      const res = mockRes();
      let nextCalled = false;
      await mw({ user: { id: String(stranger) }, query: { projectId: pid }, params: {}, body: { projectId: pid }, path: '/', method }, res, () => { nextCalled = true; });
      assert.equal(nextCalled, false);
      assert.ok([403, 404].includes(res.statusCode));
      assert.equal(JSON.stringify(res.body).includes('Owner private caption'), false);
    }
    // the stranger, in THEIR OWN project, naming the owner's publication
    const foreignPost = await post(body(), otherProject._id.toString(), stranger);
    const unknownPost = await post(body({ publicationId: new mongoose.Types.ObjectId().toString() }), otherProject._id.toString(), stranger);
    assert.equal(foreignPost.statusCode, 404);
    assert.deepEqual(foreignPost.body, unknownPost.body);
    const foreignStatus = await status({}, otherProject._id.toString(), stranger);
    assert.equal(foreignStatus.statusCode, 404);
    assert.equal(JSON.stringify(foreignStatus.body).includes('Owner private caption'), false);
    const ownerGen = (await status()).body.data.generation.id;
    assert.equal((await status({ generationId: ownerGen }, otherProject._id.toString(), stranger)).statusCode, 404);
    assert.equal(await SocialDesignGeneration.countDocuments({ project_id: otherProject._id }), 0);
  });

  test('10: the client controls only publicationId / contentVersion / replaceApproved - forged state, versions, account, prompt, size, model are ignored', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const provider = mockImageProvider();
    setDesignProviderOverride(provider);
    const res = await post(body({
      approvalState: 'design_approved', designVersion: 50, platform: 'instagram', socialAccountId: new mongoose.Types.ObjectId().toString(), prompt: 'draw PWNED text', size: '4096x4096', model: 'gpt-evil',
      design: { source: 'human' }, generation: { source: 'human' }, status: 'published', scheduledAt: '2031-01-01T00:00:00Z', media: [{ url: 'https://evil.example/x.png', type: 'image' }], strategyId: 'x', profileSnapshot: { a: 1 },
    }));
    assert.equal(res.statusCode, 202);
    await settled();
    const after = await SocialPublication.findById(pub.id).lean();
    assert.equal(after.approvalState, 'design_review');
    assert.equal(after.designVersion, 2);
    assert.equal(after.status, 'draft');
    assert.equal(after.scheduledAt ?? null, null);
    assert.equal(after.platform, 'facebook');
    assert.equal(after.design.source, 'ai');
    assert.equal(after.media.some((m) => m.url.includes('evil.example')), false);
    assert.ok(['1024x1024', '1536x1024', '1024x1536'].includes(provider.calls[0].size), 'the requested size is decided on the server, never the 4096x4096 a client sends');
    assert.equal(provider.calls[0].prompt.includes('PWNED'), false);
  });

  test('11: status needs a valid publication id; malformed or operator-style ids are 404/400, never a 500 or a query', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    assert.equal((await status({ publicationId: 'nope' })).statusCode, 404);
    assert.equal((await status({ publicationId: { $ne: null } })).statusCode, 404);
    assert.equal((await status({ generationId: '../../etc' })).statusCode, 404);
    const none = await status();
    assert.equal(none.statusCode, 200);
    assert.equal(none.body.data.status, 'none');
  });

  test('12: a missing body is a clean 400', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = mockRes();
    await generateAIDesignHandler({ projectId: pid, userId: String(owner), query: {}, body: null }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.details.code, 'INVALID_PUBLICATION');
  });
});
