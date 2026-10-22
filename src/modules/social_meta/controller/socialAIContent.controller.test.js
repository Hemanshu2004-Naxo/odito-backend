import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import SocialAccount from '../model/SocialAccount.js';
import SocialAIStrategy from '../model/SocialAIStrategy.js';
import SocialContentGeneration from '../model/SocialContentGeneration.js';
import SocialPublication from '../model/SocialPublication.js';
import router from '../routes/socialAIContentRoutes.js';
import mainRouter from '../../../routes/index.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import { socialAIContentGenerateRateLimiter } from '../middleware/socialAIStrategyRateLimiter.js';
import { generateAIContentHandler, getAIContentStatusHandler } from './socialAIContentController.js';
import { createPublicationHandler } from './socialPublishingController.js';
import { setContentProviderOverride, resetContentProviderOverride, getContentGenerationStatus } from '../service/aiContent/socialContentGenerationService.js';
import { CONTENT_RATE_LIMIT } from '../service/aiContent/contentConfig.js';
import { validRawStrategy, validRawPost, mockContentProvider, providerError } from '../testSupport/aiStrategyFixtures.js';

/**
 * HTTP layer of single-post generation: wiring (auth + project access + rate limit), status codes,
 * response shape, cross-project blocking through the REAL validateProjectAccess(), the rate limiter,
 * and that the client controls nothing but platform / pillar / objective.
 */

let mongoAvailable = false;
before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
    await SocialContentGeneration.init();
  } catch {
    mongoAvailable = false;
  }
});
after(async () => {
  resetContentProviderOverride();
  if (mongoAvailable) await mongoose.connection.close();
});

const mockRes = () => ({
  statusCode: 200, body: null, headers: {},
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; },
  set(k, v) { this.headers[k] = v; return this; },
});

describe('AI content routes - wiring', () => {
  const routes = router.stack.filter((l) => l.route).map((l) => ({ path: l.route.path, methods: Object.keys(l.route.methods), layers: l.route.stack.map((s) => s.handle) }));
  const find = (path, method) => routes.find((r) => r.path === path && r.methods.includes(method));

  test('1: POST /generate has auth + project access + rate limiter + handler; GET /status has auth + project access + handler', () => {
    const gen = find('/generate', 'post');
    assert.equal(gen.layers.length, 4);
    assert.equal(gen.layers[2], socialAIContentGenerateRateLimiter, 'rate limit runs after auth + project access');
    assert.equal(gen.layers[3], generateAIContentHandler);
    const status = find('/status', 'get');
    assert.equal(status.layers.length, 3);
    assert.equal(status.layers[2], getAIContentStatusHandler);
  });

  test('2: the router has NO approve / schedule / publish / edit routes - exactly generate and status', () => {
    assert.deepEqual(routes.map((r) => `${r.methods.join()} ${r.path}`).sort(), ['get /status', 'post /generate']);
  });

  test('3: mounted at /social/ai-content', () => {
    const mounts = mainRouter.stack.filter((l) => !l.route && l.handle === router).map((l) => String(l.regexp));
    assert.equal(mounts.length, 1);
    assert.match(mounts[0], /social\\\/ai-content/);
  });

  test('4: the rate limiter answers 429 RATE_LIMITED + Retry-After once the budget is spent, is per user, and can be switched off', async () => {
    process.env.SOCIAL_AI_CONTENT_RATE_LIMIT_ENABLED = 'false';
    let passed = false;
    socialAIContentGenerateRateLimiter({ user: { _id: 'u-off' }, ip: '1.1.1.1' }, mockRes(), () => { passed = true; });
    assert.equal(passed, true);
    delete process.env.SOCIAL_AI_CONTENT_RATE_LIMIT_ENABLED;

    const hit = async (userKey) => {
      const res = mockRes();
      let next = false;
      await new Promise((resolve) => {
        const req = { user: { _id: userKey }, ip: '2.2.2.2', headers: {}, app: { get: () => false } };
        const origJson = res.json.bind(res);
        res.json = (p) => { origJson(p); resolve(); return res; };
        res.setHeader = () => {};
        res.getHeader = () => undefined;
        socialAIContentGenerateRateLimiter(req, res, () => { next = true; resolve(); });
      });
      return { res, next };
    };
    let blocked = null;
    for (let i = 0; i < CONTENT_RATE_LIMIT.max + 1; i += 1) { const r = await hit('u-limited'); if (!r.next) blocked = r.res; }
    assert.ok(blocked, 'the request after the budget was refused');
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.body.details.code, 'RATE_LIMITED');
    assert.ok(blocked.headers['Retry-After']);
    assert.equal((await hit('another-user')).next, true, 'one user\'s budget is not another\'s');
  });
});

describe('AI content endpoints (real MongoDB, scripted provider)', () => {
  let owner, stranger, project, otherProject, pid, created, fb;
  const track = (d) => { created.push(d); return d; };

  beforeEach(async () => {
    if (!mongoAvailable) return;
    created = [];
    owner = new mongoose.Types.ObjectId();
    stranger = new mongoose.Types.ObjectId();
    const mk = (u) => SeoProject.create({ user_id: u, project_name: `Content Ctrl ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'], description: 'A dental practice' });
    project = track(await mk(owner));
    otherProject = track(await mk(stranger));
    pid = project._id.toString();
    fb = await SocialAccount.create({ user_id: owner, project_id: project._id, platform: 'facebook', platformAccountId: 'pgc', platformAccountName: 'P', accountType: 'page', pageId: 'pgc', accessToken: 'FB-SECRET-TOKEN', status: 'active', isActive: true });
    await SocialAIStrategy.create({
      project_id: project._id, version: 1, status: 'ready', strategy: { ...validRawStrategy(), brandRules: { prohibitedPhrases: [] } },
      profileSnapshot: { generatedAt: new Date(), hash: 'h1', data: { business: { name: 'Acme Dental', location: {} }, audience: {}, toneOfVoice: {}, goals: [], uniqueSellingPoints: [], offers: [], competitors: [], prohibitedPhrases: [], brand: {} } },
    });
  });

  afterEach(async () => {
    resetContentProviderOverride();
    if (!mongoAvailable) return;
    const ids = created.map((d) => d._id);
    await Promise.all([
      SocialContentGeneration.deleteMany({ project_id: { $in: ids } }),
      SocialPublication.deleteMany({ project_id: { $in: ids } }),
      SocialAIStrategy.deleteMany({ project_id: { $in: ids } }),
      SocialAccount.deleteMany({ project_id: { $in: ids } }),
    ]);
    await SeoProject.deleteMany({ _id: { $in: ids } });
  });

  const body = (over = {}) => ({ platform: 'facebook', contentPillar: 'Dental tips', objective: 'educational', ...over });
  const post = async (payload = body(), projectId = pid, userId = owner) => { const res = mockRes(); await generateAIContentHandler({ projectId, userId: String(userId), query: { projectId }, body: { projectId, ...payload } }, res); return res; };
  const status = async (projectId = pid, userId = owner, query = {}) => { const res = mockRes(); await getAIContentStatusHandler({ projectId, userId: String(userId), query: { projectId, ...query }, body: {} }, res); return res; };
  const settled = async (projectId = pid) => { for (let i = 0; i < 150; i += 1) { if ((await getContentGenerationStatus(projectId)).status !== 'generating') return; await new Promise((r) => setTimeout(r, 20)); } throw new Error('generation did not finish'); };

  test('5: POST /generate -> 202 at once; a duplicate joins it; polling goes generating -> ready with the real draft', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    let release;
    const gate = new Promise((r) => { release = r; });
    const provider = mockContentProvider({ gate });
    setContentProviderOverride(provider);

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
    assert.equal(mid.body.data.publication, null, 'no draft is shown until a real one exists');

    release();
    await settled();
    const done = await status(pid, owner, { generationId: started.body.data.generationId });
    assert.equal(done.statusCode, 200);
    assert.equal(done.body.data.status, 'ready');
    const pub = done.body.data.publication;
    assert.equal(pub.status, 'draft');
    assert.equal(pub.platform, 'facebook');
    assert.equal(pub.approvalState, 'content_review');
    assert.equal(pub.contentVersion, 1);
    assert.equal(pub.generation.source, 'ai');
    assert.equal(pub.generation.contentPillar, 'Dental tips');
    assert.equal(provider.calls.length, 1);
  });

  test('6: validation errors map to HTTP statuses with a machine code and (where useful) the allowed values; the AI is not called', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const provider = mockContentProvider();
    setContentProviderOverride(provider);
    const cases = [
      [body({ platform: 'tiktok' }), 400, 'INVALID_PLATFORM'], [body({ platform: undefined }), 400, 'INVALID_PLATFORM'],
      [body({ objective: 'go_viral' }), 400, 'INVALID_OBJECTIVE'], [body({ contentPillar: '' }), 400, 'INVALID_PILLAR'],
      [body({ contentPillar: 'Unknown pillar' }), 400, 'INVALID_PILLAR'], [body({ objective: 'hard_sell' }), 422, 'OBJECTIVE_NOT_IN_STRATEGY'],
    ];
    for (const [payload, httpStatus, code] of cases) {
      const res = await post(payload);
      assert.equal(res.statusCode, httpStatus, code);
      assert.equal(res.body.details.code, code);
      assert.equal(res.body.success, false);
    }
    assert.deepEqual((await post(body({ contentPillar: 'Nope' }))).body.details.allowed, ['Dental tips', 'Meet the team', 'Offers']);
    assert.equal(provider.calls.length, 0);
  });

  test('7: platform not connected -> 409; no strategy -> 409; AI not configured -> 503; unknown project -> 404', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    setContentProviderOverride(mockContentProvider());
    const ig = await post(body({ platform: 'instagram' }));
    assert.equal(ig.statusCode, 409);
    assert.equal(ig.body.details.code, 'PLATFORM_NOT_CONNECTED');

    setContentProviderOverride(mockContentProvider({ available: false }));
    const off = await post();
    assert.equal(off.statusCode, 503);
    assert.equal(off.body.details.code, 'AI_UNAVAILABLE');

    setContentProviderOverride(mockContentProvider());
    await SocialAIStrategy.deleteMany({ project_id: project._id });
    const none = await post();
    assert.equal(none.statusCode, 409);
    assert.equal(none.body.details.code, 'NO_STRATEGY');

    assert.equal((await post(body(), new mongoose.Types.ObjectId().toString())).statusCode, 404);
    assert.equal(await SocialContentGeneration.countDocuments({ project_id: project._id }), 0);
  });

  test('8: the client controls only platform / pillar / objective - an injected account, connection flag, strategy, content or provenance is ignored', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const provider = mockContentProvider();
    setContentProviderOverride(provider);
    const res = await post(body({
      socialAccountId: new mongoose.Types.ObjectId().toString(), connected: true, content: 'CLIENT WRITTEN POST', caption: 'CLIENT CAPTION', scheduledAt: '2031-01-01T00:00:00Z', status: 'published',
      approvalState: 'design_approved', strategy: { summary: 'forged' }, profileSnapshot: { business: { name: 'Forged Name' } }, strategyVersion: 99, generation: { source: 'human' }, projectId: String(otherProject._id),
    }));
    assert.equal(res.statusCode, 202);
    await settled();
    const pub = await SocialPublication.findOne({ project_id: project._id }).lean();
    assert.ok(pub);
    assert.equal(pub.content.includes('CLIENT'), false);
    assert.equal(String(pub.social_account_id), String(fb._id), 'the account is chosen by the server');
    assert.equal(pub.status, 'draft');
    assert.equal(pub.scheduledAt ?? null, null);
    assert.equal(pub.approvalState, 'content_review');
    assert.equal(pub.generation.source, 'ai');
    assert.equal(pub.generation.strategyVersion, 1);
    assert.equal(provider.calls[0].user.includes('Forged'), false);
    assert.equal(provider.calls[0].user.includes('forged'), false);
    assert.equal(await SocialPublication.countDocuments({ project_id: otherProject._id }), 0);
  });

  test('9: a failed generation is reported with the safe failure; the API never shows provider detail, prompt, key or token', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    setContentProviderOverride(mockContentProvider({ behavior: () => { throw providerError('AI_PROVIDER_AUTH', { bodySnippet: 'sk-LEAK', message: 'sk-LEAK' }); } }));
    await post();
    await settled();
    const res = await status();
    assert.equal(res.body.data.status, 'failed');
    assert.equal(res.body.data.publication, null);
    assert.equal(res.body.data.generation.failure.code, 'AI_UNAVAILABLE');
    const text = JSON.stringify(res.body);
    for (const leak of ['sk-LEAK', 'CLAUDE_', 'AI_PROVIDER_', 'OPENAI', 'FB-SECRET-TOKEN', 'accessToken', 'system prompt', 'lockedBy', 'social_account_id']) assert.equal(text.includes(leak), false, leak);
  });

  test('10: cross-project access is blocked by validateProjectAccess() on generate and status, before any handler runs', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    setContentProviderOverride(mockContentProvider({ behavior: () => validRawPost({ caption: 'Owner private caption here. Book a check-up' }) }));
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
    const own = await status(otherProject._id.toString(), stranger);
    assert.equal(own.body.data.status, 'none');
    assert.equal(JSON.stringify(own.body).includes('Owner'), false);
    const theirs = await status(pid, owner);
    const foreign = await status(otherProject._id.toString(), stranger, { generationId: theirs.body.data.generation.id });
    assert.equal(foreign.statusCode, 404, 'a generation id from another project does not resolve');
  });

  test('11: status without a generation is a plain "none"; a malformed generationId is 404, never a 500', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = await status();
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.status, 'none');
    assert.equal(res.body.data.generation, null);
    assert.equal((await status(pid, owner, { generationId: '../../etc' })).statusCode, 404);
    assert.equal((await status(pid, owner, { generationId: { $ne: null } })).body.data.status, 'none', 'a non-string id is ignored, not interpreted as a query');
  });

  test('12: the existing HTTP create-post route cannot be used to forge AI provenance', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = mockRes();
    await createPublicationHandler({
      projectId: pid, userId: String(owner), user: { id: String(owner) }, query: { projectId: pid },
      body: { projectId: pid, platform: 'facebook', socialAccountId: fb._id.toString(), content: 'Forged', generation: { source: 'ai', type: 'social_content', strategyVersion: 7, contentPillar: 'Fake', objective: 'educational' } },
    }, res);
    assert.ok([200, 201].includes(res.statusCode), JSON.stringify(res.body));
    const stored = await SocialPublication.findOne({ project_id: project._id, content: 'Forged' }).lean();
    assert.ok(stored);
    assert.equal(stored.generation?.source ?? null, null);
    assert.equal(stored.generation?.strategyVersion ?? null, null);
  });

  test('13: a missing request body is a clean 400, never a crash that leaks error text', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = mockRes();
    await generateAIContentHandler({ projectId: pid, userId: String(owner), query: {}, body: null }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.details.code, 'INVALID_PLATFORM');
    assert.equal(JSON.stringify(res.body).includes('Cannot read'), false);
  });
});
