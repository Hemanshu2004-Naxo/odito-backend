import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import SocialBusinessProfile from '../model/SocialBusinessProfile.js';
import SocialAIStrategy from '../model/SocialAIStrategy.js';
import router from '../routes/socialAIStrategyRoutes.js';
import mainRouter from '../../../routes/index.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import { socialAIStrategyGenerateRateLimiter } from '../middleware/socialAIStrategyRateLimiter.js';
import { getAIStrategyHandler, getAIStrategyStatusHandler, generateAIStrategyHandler } from './socialAIStrategyController.js';
import { setProviderOverride, resetProviderOverride, getGenerationStatus } from '../service/aiStrategy/socialAIStrategyService.js';
import { updateProfile } from '../service/socialBusinessProfileService.js';
import { validRawStrategy, mockProvider } from '../testSupport/aiStrategyFixtures.js';

/**
 * HTTP layer of the AI Strategy: route wiring (auth + project access + rate limit), status codes,
 * response shape, cross-project blocking through the REAL validateProjectAccess() middleware,
 * and that nothing sensitive is returned. The state machine is covered in
 * service/aiStrategy/socialAIStrategyService.test.js.
 */

let mongoAvailable = false;
before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
    await SocialAIStrategy.init();
  } catch {
    mongoAvailable = false;
  }
});
after(async () => {
  resetProviderOverride();
  if (mongoAvailable) await mongoose.connection.close();
});

const mockRes = () => ({
  statusCode: 200, body: null, headers: {},
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; },
  set(k, v) { this.headers[k] = v; return this; },
});

describe('AI strategy routes — wiring', () => {
  const routes = router.stack.filter((l) => l.route).map((l) => ({ path: l.route.path, methods: Object.keys(l.route.methods), layers: l.route.stack.map((s) => s.handle) }));
  const find = (path, method) => routes.find((r) => r.path === path && r.methods.includes(method));

  test('1: GET /, GET /status and POST /generate exist behind auth + project access; generate also has the rate limiter', () => {
    assert.equal(find('/', 'get').layers.length, 3);
    assert.equal(find('/status', 'get').layers.length, 3);
    const gen = find('/generate', 'post');
    assert.equal(gen.layers.length, 4);
    assert.equal(gen.layers[2], socialAIStrategyGenerateRateLimiter, 'rate limit runs after auth + project access, before the handler');
    assert.equal(gen.layers[3], generateAIStrategyHandler);
  });

  test('2: the strategy is read-only over HTTP — no PUT / PATCH / DELETE and nothing else', () => {
    assert.equal(routes.length, 4, 'GET /, GET /status, POST /generate and the read-only POST /plan-preview');
    for (const r of routes) assert.ok(r.methods.every((m) => ['get', 'post'].includes(m)));
  });

  test('3: mounted at /social/ai-strategy', () => {
    const mounts = mainRouter.stack.filter((l) => !l.route && l.handle === router).map((l) => String(l.regexp));
    assert.equal(mounts.length, 1);
    assert.match(mounts[0], /social\\\/ai-strategy/);
  });

  test('4: the generate rate limiter answers 429 RATE_LIMITED with Retry-After once the budget is spent, and can be switched off', async () => {
    process.env.SOCIAL_AI_STRATEGY_RATE_LIMIT_ENABLED = 'false';
    let passed = false;
    socialAIStrategyGenerateRateLimiter({ user: { _id: 'u-off' }, ip: '1.1.1.1' }, mockRes(), () => { passed = true; });
    assert.equal(passed, true);
    delete process.env.SOCIAL_AI_STRATEGY_RATE_LIMIT_ENABLED;

    const { RATE_LIMIT } = await import('../service/aiStrategy/strategyConfig.js');
    let blocked = null;
    for (let i = 0; i < RATE_LIMIT.max + 1; i += 1) {
      const res = mockRes();
      let next = false;
      await new Promise((resolve) => {
        const req = { user: { _id: 'u-limited' }, ip: '2.2.2.2', headers: {}, app: { get: () => false } };
        const done = () => { next = true; resolve(); };
        const origJson = res.json.bind(res);
        res.json = (p) => { origJson(p); resolve(); return res; };
        res.setHeader = () => {};
        res.getHeader = () => undefined;
        socialAIStrategyGenerateRateLimiter(req, res, done);
      });
      if (!next) blocked = res;
    }
    assert.ok(blocked, 'the request after the budget was refused');
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.body.details.code, 'RATE_LIMITED');
    assert.ok(blocked.headers['Retry-After']);
  });
});

describe('AI strategy endpoints (real MongoDB, scripted provider)', () => {
  let owner, stranger, project, otherProject, pid, created;
  const track = (d) => { created.push(d); return d; };

  beforeEach(async () => {
    if (!mongoAvailable) return;
    created = [];
    owner = new mongoose.Types.ObjectId();
    stranger = new mongoose.Types.ObjectId();
    const mk = (u, extra = {}) => SeoProject.create({ user_id: u, project_name: `Strat Ctrl ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'], description: 'A dental practice', ...extra });
    project = track(await mk(owner));
    otherProject = track(await mk(stranger, { description: 'Stranger private business' }));
    pid = project._id.toString();
  });

  afterEach(async () => {
    resetProviderOverride();
    if (!mongoAvailable) return;
    const ids = created.map((d) => d._id);
    await SocialAIStrategy.deleteMany({ project_id: { $in: ids } });
    await SocialBusinessProfile.deleteMany({ project_id: { $in: ids } });
    await SeoProject.deleteMany({ _id: { $in: ids } });
  });

  const call = async (handler, projectId = pid, userId = owner) => { const res = mockRes(); await handler({ projectId, userId: String(userId), query: { projectId }, body: { projectId } }, res); return res; };
  const settled = async (projectId = pid) => { for (let i = 0; i < 100; i += 1) { if ((await getGenerationStatus(projectId)).status !== 'generating') return; await new Promise((r) => setTimeout(r, 20)); } throw new Error('generation did not finish'); };

  test('5: GET with no strategy → 200 status none with the live profile comparison', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = await call(getAIStrategyHandler);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.status, 'none');
    assert.equal(res.body.data.strategy, null);
    assert.equal(res.body.data.profile.canGenerate, true);
  });

  test('6: POST /generate → 202 immediately; polling status shows generating then ready; GET returns the strategy', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await updateProfile(pid, owner, { goals: ['More bookings'], audience: { primary: 'Families' } });
    let release;
    const gate = new Promise((r) => { release = r; });
    setProviderOverride(mockProvider({ gate, behavior: () => validRawStrategy() }));

    const started = await call(generateAIStrategyHandler);
    assert.equal(started.statusCode, 202);
    assert.equal(started.body.data.status, 'generating');
    assert.equal(started.body.data.alreadyRunning, false);
    assert.equal(started.body.data.generation.version, 1);

    const duplicate = await call(generateAIStrategyHandler);
    assert.equal(duplicate.statusCode, 202);
    assert.equal(duplicate.body.data.alreadyRunning, true);

    const mid = await call(getAIStrategyStatusHandler);
    assert.equal(mid.body.data.status, 'generating');

    release();
    await settled();
    const done = await call(getAIStrategyStatusHandler);
    assert.equal(done.body.data.status, 'ready');
    const full = await call(getAIStrategyHandler);
    assert.equal(full.body.data.strategy.version, 1);
    assert.equal(full.body.data.strategy.strategy.contentMix.length, 3);
  });

  test('7: a profile too thin to work from → 422 INSUFFICIENT_PROFILE with the blocker; AI not called', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const bare = track(await SeoProject.create({ user_id: owner, project_name: `Bare ${Date.now()}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'] }));
    const provider = mockProvider();
    setProviderOverride(provider);
    const res = await call(generateAIStrategyHandler, bare._id.toString());
    assert.equal(res.statusCode, 422);
    assert.equal(res.body.details.code, 'INSUFFICIENT_PROFILE');
    assert.equal(res.body.details.blockers[0].field, 'description');
    assert.equal(provider.calls.length, 0);
  });

  test('8: AI not configured → 503 AI_UNAVAILABLE and nothing is created', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    setProviderOverride(mockProvider({ available: false }));
    const res = await call(generateAIStrategyHandler);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.details.code, 'AI_UNAVAILABLE');
    assert.equal(await SocialAIStrategy.countDocuments({ project_id: project._id }), 0);
  });

  test('9: a failed generation is reported with the safe failure and the API never shows provider detail', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    setProviderOverride(mockProvider({ behavior: () => { const e = new Error('CLAUDE_AUTH'); e.code = 'CLAUDE_AUTH'; e.bodySnippet = 'sk-ant-LEAK'; throw e; } }));
    await call(generateAIStrategyHandler);
    await settled();
    const res = await call(getAIStrategyHandler);
    assert.equal(res.body.data.status, 'failed');
    assert.equal(res.body.data.strategy, null);
    assert.equal(res.body.data.generation.failure.code, 'AI_UNAVAILABLE');
    assert.equal(JSON.stringify(res.body).includes('sk-ant-LEAK'), false);
    assert.equal(JSON.stringify(res.body).includes('CLAUDE_'), false);
  });

  test('10: cross-project access is blocked by validateProjectAccess() on every route, before any handler runs', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await updateProfile(pid, owner, { goals: ['Owner secret goal'] });
    setProviderOverride(mockProvider({ behavior: () => ({ ...validRawStrategy(), summary: 'Owner private strategy summary.' }) }));
    await call(generateAIStrategyHandler);
    await settled();

    const mw = validateProjectAccess();
    for (const method of ['GET', 'POST']) {
      const res = mockRes();
      let nextCalled = false;
      await mw({ user: { id: String(stranger) }, query: { projectId: pid }, params: {}, body: { projectId: pid }, path: '/', method }, res, () => { nextCalled = true; });
      assert.equal(nextCalled, false);
      assert.ok([403, 404].includes(res.statusCode));
      assert.equal(JSON.stringify(res.body).includes('Owner private strategy summary.'), false);
    }
    // the stranger's own project sees none of the owner's data
    const own = await call(getAIStrategyHandler, otherProject._id.toString(), stranger);
    assert.equal(own.body.data.status, 'none');
    assert.equal(JSON.stringify(own.body).includes('Owner'), false);
    assert.equal((await call(getAIStrategyStatusHandler, otherProject._id.toString(), stranger)).body.data.status, 'none');
  });

  test('11: an unknown project is 404 on GET (never an empty success for someone else\'s id)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = await call(getAIStrategyHandler, new mongoose.Types.ObjectId().toString());
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.details.code, 'NOT_FOUND');
  });
});
