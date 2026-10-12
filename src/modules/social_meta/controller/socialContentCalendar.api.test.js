import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import mongoose from 'mongoose';
import express from 'express';
import apiRoutes from '../../../routes/index.js';
import calendarRouter from '../routes/socialContentCalendarRoutes.js';
import User from '../../user/model/User.js';
import SeoProject from '../../app_user/model/SeoProject.js';
import SocialAccount from '../model/SocialAccount.js';
import SocialAIStrategy from '../model/SocialAIStrategy.js';
import SocialBusinessProfile from '../model/SocialBusinessProfile.js';
import SocialContentCalendar from '../model/SocialContentCalendar.js';
import SocialContentCalendarItem from '../model/SocialContentCalendarItem.js';
import SocialPublication from '../model/SocialPublication.js';
import { signAuthToken } from '../../user/service/tokenService.js';
import { updateProfile } from '../service/socialBusinessProfileService.js';
import { startGeneration as startStrategy, setProviderOverride as setStrategyProvider, resetProviderOverride as resetStrategyProvider } from '../service/aiStrategy/socialAIStrategyService.js';
import { setCalendarProviderOverride, resetCalendarProviderOverride } from '../service/calendar/socialContentCalendarService.js';
import { CALENDAR_RATE_LIMIT } from '../service/calendar/calendarConfig.js';
import { validRawStrategy, mockProvider, mockCalendarProvider, validRawCalendarItem } from '../testSupport/aiStrategyFixtures.js';

/**
 * The Content Calendar API end to end: a real Express app mounting the real /api router (real JWT auth, real
 * validateProjectAccess), real MongoDB, the AI providers scripted. Every case is a no-op pass when MongoDB is unreachable.
 */

let server; let base; let mongoAvailable = false;
let owner; let stranger; let projectA; let projectB; let tokenA; let tokenB;
const accounts = [];
const addDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

before(async () => {
  // the flow tests send many requests as one user; the limiter has its own dedicated test at the end (this env switch is read per request)
  process.env.SOCIAL_AI_CALENDAR_RATE_LIMIT_ENABLED = 'false';
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch { mongoAvailable = false; }
  const app = express();
  app.use(express.json());
  app.use('/api', apiRoutes);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  if (!mongoAvailable) return;
  const mkUser = (tag) => User.create({ firstName: 'Cal', lastName: tag, email: `calendar-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`, password: 'password123', roleId: 5, isActive: true, isEmailVerified: true });
  owner = await mkUser('A'); stranger = await mkUser('B');
  const mkProject = (u, tag) => SeoProject.create({ user_id: u._id, project_name: `Calendar API ${tag} ${Date.now()} ${Math.random().toString(36).slice(2, 7)}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'], description: 'Family dental practice', industry: 'Dentist' });
  projectA = await mkProject(owner, 'A'); projectB = await mkProject(stranger, 'B');
  tokenA = signAuthToken(owner); tokenB = signAuthToken(stranger);
  for (const [p, u] of [[projectA, owner], [projectB, stranger]]) {
    await updateProfile(String(p._id), u._id, { audience: { primary: 'Families' }, goals: ['Bookings'] });
    const pageId = `pg_${Math.random().toString(36).slice(2, 8)}`;
    accounts.push(await SocialAccount.create({ user_id: u._id, project_id: p._id, platform: 'facebook', platformAccountId: pageId, platformAccountName: 'Page', accountType: 'page', pageId, accessToken: 'FB-SECRET-TOKEN', status: 'active', isActive: true }));
  }
  // only Project A has a strategy
  setStrategyProvider(mockProvider({ behavior: () => validRawStrategy() }));
  await startStrategy(String(projectA._id), owner._id, { background: false });
  resetStrategyProvider();
});

after(async () => {
  delete process.env.SOCIAL_AI_CALENDAR_RATE_LIMIT_ENABLED;
  server?.close();
  resetCalendarProviderOverride();
  if (!mongoAvailable) return;
  const ids = [projectA?._id, projectB?._id].filter(Boolean);
  await Promise.all([
    SocialContentCalendarItem.deleteMany({ project_id: { $in: ids } }), SocialContentCalendar.deleteMany({ project_id: { $in: ids } }), SocialAIStrategy.deleteMany({ project_id: { $in: ids } }),
    SocialBusinessProfile.deleteMany({ project_id: { $in: ids } }), SocialPublication.deleteMany({ project_id: { $in: ids } }), SocialAccount.deleteMany({ _id: { $in: accounts.map((a) => a._id) } }),
  ]);
  await SeoProject.deleteMany({ _id: { $in: ids } });
  await User.deleteMany({ _id: { $in: [owner?._id, stranger?._id].filter(Boolean) } });
  await mongoose.connection.close();
});

async function call(method, path, { token = tokenA, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + path, { method, headers, body: payload });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}
const pidA = () => String(projectA._id);
const pidB = () => String(projectB._id);
const q = (pid) => `projectId=${encodeURIComponent(pid)}`;
const request = (over = {}, pid = pidA()) => ({ projectId: pid, startDate: addDays(1), endDate: addDays(7), postsPerWeek: 3, platforms: ['facebook'], distributionMode: 'balanced', ...over });
const waitReady = async (pid, token = tokenA) => {
  for (let i = 0; i < 100; i += 1) {
    const s = await call('GET', `/api/social/content-calendar/status?${q(pid)}`, { token });
    if (s.body.data.status !== 'generating') return s.body.data;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('timed out');
};

describe('Content Calendar API — wiring, authentication and isolation', () => {
  test('1: the calendar-level routes are GET /, GET /status, POST /generate (the per-item routes are covered by socialContentCalendarItem.api.test.js); generate has auth + access + rate limit + handler', () => {
    const routes = calendarRouter.stack.filter((l) => l.route && !l.route.path.startsWith('/items') && l.route.path !== '/options').map((l) => ({ id: `${Object.keys(l.route.methods)[0]} ${l.route.path}`, layers: l.route.stack.length }));
    assert.deepEqual(routes.map((r) => r.id).sort(), ['get /', 'get /history', 'get /history/:calendarId', 'get /status', 'post /cancel', 'post /generate', 'post /preview', 'post /restore', 'post /resume']);
    assert.equal(routes.find((r) => r.id === 'post /generate').layers, 4);
    assert.equal(routes.find((r) => r.id === 'post /resume').layers, 4, 'resume spends AI tokens: auth + access + rate limit + handler');
    assert.equal(routes.find((r) => r.id === 'post /cancel').layers, 3);
    assert.equal(routes.find((r) => r.id === 'post /preview').layers, 3, 'preview: auth + access + handler (no AI call, so no rate limit)');
    assert.equal(routes.find((r) => r.id === 'get /').layers, 3);
  });

  test('2: no JWT -> 401 on every route', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    for (const [method, path, body] of [['GET', `/api/social/content-calendar?${q(pidA())}`], ['GET', `/api/social/content-calendar/status?${q(pidA())}`], ['POST', '/api/social/content-calendar/generate', request()]]) {
      assert.equal((await call(method, path, { token: null, body })).status, 401, `${method} ${path}`);
    }
  });

  test('3: a user cannot read or generate a calendar for someone else\'s project (403/404 before any handler runs)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    setCalendarProviderOverride(mockCalendarProvider());
    const before = await SocialContentCalendar.countDocuments({ project_id: projectA._id });
    for (const [method, path, body] of [['GET', `/api/social/content-calendar?${q(pidA())}`], ['GET', `/api/social/content-calendar/status?${q(pidA())}`], ['POST', '/api/social/content-calendar/generate', request()]]) {
      const res = await call(method, path, { token: tokenB, body });
      assert.ok([403, 404].includes(res.status), `${method} ${path} -> ${res.status}`);
    }
    assert.equal(await SocialContentCalendar.countDocuments({ project_id: projectA._id }), before);
  });

  test('4: an operator-shaped projectId never returns data', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = await call('GET', '/api/social/content-calendar?projectId[$ne]=x');
    assert.ok(res.status >= 400, String(res.status));
  });
});

describe('Content Calendar API — generation flow', () => {
  test('5: input errors are 400 with a code; unknown fields (a client-supplied strategy!) are rejected; nothing is created', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const provider = mockCalendarProvider();
    setCalendarProviderOverride(provider);
    for (const [over, code] of [
      [{ postsPerWeek: 0 }, 'INVALID_POSTS_PER_WEEK'], [{ postsPerWeek: 'many' }, 'INVALID_POSTS_PER_WEEK'], [{ platforms: [] }, 'INVALID_PLATFORMS'], [{ platforms: ['myspace'] }, 'INVALID_PLATFORMS'],
      [{ startDate: '2020-01-01', endDate: '2020-02-01' }, 'DATE_IN_PAST'], [{ endDate: addDays(-3) }, 'INVALID_DATE_RANGE'], [{ startDate: '31/12/2026' }, 'INVALID_DATE'],
      [{ distributionMode: 'chaos' }, 'INVALID_DISTRIBUTION'], [{ strategy: { contentPillars: [{ name: 'Free cars', suggestedPercentage: 100 }] } }, 'UNKNOWN_FIELD'], [{ $where: '1' }, 'UNKNOWN_FIELD'], [{ items: [] }, 'UNKNOWN_FIELD'],
    ]) {
      const res = await call('POST', '/api/social/content-calendar/generate', { body: request(over) });
      assert.equal(res.status, 400, JSON.stringify(over));
      assert.equal(res.body.details.code, code, JSON.stringify(over));
    }
    assert.equal(provider.calls.length, 0);
    assert.equal(await SocialContentCalendar.countDocuments({ project_id: projectA._id }), 0);
  });

  test('6: a project with no strategy is a 422 NO_STRATEGY; a platform that is not connected is a 422 naming it', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    setCalendarProviderOverride(mockCalendarProvider());
    const none = await call('POST', '/api/social/content-calendar/generate', { token: tokenB, body: request({}, pidB()) });
    assert.equal(none.status, 422);
    assert.equal(none.body.details.code, 'NO_STRATEGY');
    const ig = await call('POST', '/api/social/content-calendar/generate', { body: request({ platforms: ['facebook', 'instagram'] }) });
    assert.equal(ig.status, 422);
    assert.equal(ig.body.details.code, 'PLATFORM_NOT_CONNECTED');
    assert.deepEqual(ig.body.details.platforms, ['instagram']);
  });

  test('7: POST /generate is 202 and starts ONE generation; the status endpoint follows it; GET returns the calendar with its items', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    let open; const gate = new Promise((r) => { open = r; });
    const provider = mockCalendarProvider({ gate });
    setCalendarProviderOverride(provider);
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => call('POST', '/api/social/content-calendar/generate', { body: request() })));
    for (const r of [a, b, c]) {
      assert.equal(r.status, 202, JSON.stringify(r.body));
      assert.equal(r.body.data.status, 'generating');
    }
    assert.equal([a, b, c].filter((r) => r.body.data.alreadyRunning === false).length, 1, 'exactly one request started the run');
    assert.equal((await call('GET', `/api/social/content-calendar/status?${q(pidA())}`)).body.data.status, 'generating');
    assert.equal(await SocialContentCalendar.countDocuments({ project_id: projectA._id, status: 'generating' }), 1);
    open();
    const done = await waitReady(pidA());
    assert.equal(done.status, 'ready');
    assert.equal(done.currentVersion, 1);

    const state = (await call('GET', `/api/social/content-calendar?${q(pidA())}`)).body.data;
    assert.equal(state.status, 'ready');
    assert.equal(state.calendar.version, 1);
    assert.equal(state.items.length, 3);
    assert.equal(state.calendar.plan.totalItems, 3);
    assert.equal(state.strategy.available, true);
    assert.deepEqual(state.connectedPlatforms, { facebook: true, instagram: false });
    assert.equal(state.stale.strategyChanged, false);
    assert.equal(provider.calls.length, 1);
  });

  test('8: the response never carries tokens, prompts, keys or internal Mongo fields', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const state = await call('GET', `/api/social/content-calendar?${q(pidA())}`);
    const json = JSON.stringify(state.body);
    for (const leak of ['FB-SECRET-TOKEN', 'accessToken', '"__v"', '"_id"', 'project_id', 'lockedBy', 'systemPrompt', 'sk-ant', 'api_key', 'profileSnapshot']) assert.equal(json.includes(leak), false, leak);
    for (const item of state.body.data.items) for (const hidden of ['_id', 'project_id', 'calendar_id', 'strategyId']) assert.equal(hidden in item, false, hidden);
  });

  test('9: regenerating through the API creates version 2 and keeps version 1 archived; another project\'s calendar list is unaffected', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    setCalendarProviderOverride(mockCalendarProvider());
    const res = await call('POST', '/api/social/content-calendar/generate', { body: request({ postsPerWeek: 2 }) });
    assert.equal(res.status, 202);
    await waitReady(pidA());
    const state = (await call('GET', `/api/social/content-calendar?${q(pidA())}`)).body.data;
    assert.equal(state.calendar.version, 2);
    assert.equal(state.items.length, 2);
    assert.equal(await SocialContentCalendar.countDocuments({ project_id: projectA._id, status: 'archived' }), 1);
    const other = (await call('GET', `/api/social/content-calendar?${q(pidB())}`, { token: tokenB })).body.data;
    assert.equal(other.status, 'none');
    assert.deepEqual(other.items, []);
  });

  test('10: the API never publishes: no publication exists after planning', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    assert.equal(await SocialPublication.countDocuments({ project_id: { $in: [projectA._id, projectB._id] } }), 0);
  });

  test('10b: POST /preview needs a JWT and the owner of the project, like every other route', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const body = request({ months: 3, endDate: undefined });
    assert.equal((await call('POST', '/api/social/content-calendar/preview', { token: null, body })).status, 401);
    const other = await call('POST', '/api/social/content-calendar/preview', { token: tokenB, body });
    assert.ok([403, 404].includes(other.status), String(other.status));
  });

  test('10c: POST /preview answers the exact period and post count with NO write and NO AI call; errors carry the same codes as /generate', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const provider = mockCalendarProvider();
    setCalendarProviderOverride(provider);
    const before = await SocialContentCalendar.countDocuments({ project_id: projectA._id });
    const ok = await call('POST', '/api/social/content-calendar/preview', { body: request({ months: 3, endDate: undefined, postsPerWeek: 3 }) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const p = ok.body.data;
    assert.equal(p.months, 3);
    assert.ok(p.totalPosts >= 36 && p.totalPosts <= 40, String(p.totalPosts));
    assert.ok(p.days >= 89 && p.days <= 92);
    assert.ok(p.endDate > p.startDate);
    assert.equal(p.steps, Math.ceil(p.totalPosts / 4));
    assert.ok(Array.isArray(p.partialWeeks));
    assert.equal(await SocialContentCalendar.countDocuments({ project_id: projectA._id }), before, 'nothing was written');
    assert.equal(provider.calls.length, 0, 'no AI call');
    for (const [over, code] of [[{ months: 7, endDate: undefined }, 'INVALID_DURATION'], [{ months: 0, endDate: undefined }, 'INVALID_DURATION'], [{ months: 2, endDate: addDays(3) }, 'INVALID_DATE_RANGE'], [{ postsPerWeek: 9, months: 1, endDate: undefined }, 'INVALID_POSTS_PER_WEEK']]) {
      const res = await call('POST', '/api/social/content-calendar/preview', { body: request(over) });
      assert.equal(res.status, 400, JSON.stringify(over));
      assert.equal(res.body.details.code, code, JSON.stringify(over));
    }
  });

  test('10d: POST /resume and /cancel need a JWT and the owner of the project', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    for (const path of ['/api/social/content-calendar/resume', '/api/social/content-calendar/cancel']) {
      assert.equal((await call('POST', path, { token: null, body: { projectId: pidA() } })).status, 401, path);
      const other = await call('POST', path, { token: tokenB, body: { projectId: pidA() } });
      assert.ok([403, 404].includes(other.status), `${path} -> ${other.status}`);
    }
  });

  test('10e: a calendar that stopped part-way is PARTIAL over HTTP: its posts are kept, resume continues it (202), and cancel discards a stopped one', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    // nothing unfinished yet
    assert.equal((await call('POST', '/api/social/content-calendar/resume', { body: { projectId: pidA() } })).body.details.code, 'NOTHING_TO_RESUME');
    assert.equal((await call('POST', '/api/social/content-calendar/cancel', { body: { projectId: pidA() } })).body.details.code, 'NOTHING_TO_CANCEL');

    // a month at 3 a week is several batches; the second batch is refused by Odito's checks, so the run stops after saving the first
    setCalendarProviderOverride(mockCalendarProvider({ behavior: ({ slots, callNumber }) => (callNumber >= 2 ? { items: [] } : { items: slots.map((s) => validRawCalendarItem(s)) }) }));
    const started = await call('POST', '/api/social/content-calendar/generate', { body: request({ months: 1, endDate: undefined, postsPerWeek: 3 }) });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const stopped = await waitReady(pidA());
    assert.equal(stopped.status, 'partial');
    assert.equal(stopped.generation.canResume, true);
    assert.equal(stopped.generation.failure.code, 'AI_BAD_OUTPUT');

    const state = (await call('GET', `/api/social/content-calendar?${q(pidA())}`)).body.data;
    assert.equal(state.status, 'partial');
    assert.equal(state.partial.items.length, 4, 'the saved posts are visible, read-only');
    assert.ok(state.generation.progress.totalPosts > 4);
    assert.equal(state.calendar.version, 2, 'the previous ready calendar is still the current one');
    const json = JSON.stringify(state);
    for (const leak of ['lockedBy', 'expiresAt', 'heartbeatAt', 'project_id', 'accessToken', 'FB-SECRET-TOKEN']) assert.equal(json.includes(leak), false, leak);

    // resume continues from the saved posts
    setCalendarProviderOverride(mockCalendarProvider());
    const resumed = await call('POST', '/api/social/content-calendar/resume', { body: { projectId: pidA() } });
    assert.equal(resumed.status, 202, JSON.stringify(resumed.body));
    assert.equal(resumed.body.data.status, 'generating');
    assert.equal((await waitReady(pidA())).status, 'ready');
    const done = (await call('GET', `/api/social/content-calendar?${q(pidA())}`)).body.data;
    assert.equal(done.calendar.version, 3);
    assert.equal(done.items.length, done.calendar.plan.totalItems);
    assert.equal(done.partial, null);

    // cancel: a new run stopped part-way is discarded and the ready calendar stays
    setCalendarProviderOverride(mockCalendarProvider({ behavior: ({ slots, callNumber }) => (callNumber >= 2 ? { items: [] } : { items: slots.map((s) => validRawCalendarItem(s)) }) }));
    await call('POST', '/api/social/content-calendar/generate', { body: request({ months: 1, endDate: undefined, postsPerWeek: 3 }) });
    assert.equal((await waitReady(pidA())).status, 'partial');
    const cancelled = await call('POST', '/api/social/content-calendar/cancel', { body: { projectId: pidA() } });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    const after = (await call('GET', `/api/social/content-calendar?${q(pidA())}`)).body.data;
    assert.equal(after.status, 'ready');
    assert.equal(after.calendar.version, 3);
    assert.equal(after.partial, null);
    assert.equal(after.generation, null);
  });

  test('10f: the history is reachable over HTTP: versions are listed, one can be opened read-only and restored; another user and another project get nothing', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    for (const [method, path, body] of [['GET', `/api/social/content-calendar/history?${q(pidA())}`], ['GET', `/api/social/content-calendar/history/${new mongoose.Types.ObjectId()}?${q(pidA())}`], ['POST', '/api/social/content-calendar/restore', { projectId: pidA(), calendarId: String(new mongoose.Types.ObjectId()) }]]) {
      assert.equal((await call(method, path, { token: null, body })).status, 401, `${method} ${path}`);
      const stranger = await call(method, path, { token: tokenB, body });
      assert.ok([403, 404].includes(stranger.status), `${method} ${path} -> ${stranger.status}`);
    }
    const list = await call('GET', `/api/social/content-calendar/history?${q(pidA())}`);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const versions = list.body.data.versions;
    assert.ok(versions.length >= 2, 'earlier tests made several versions');
    assert.deepEqual(versions.map((v) => v.version), [...versions.map((v) => v.version)].sort((a, b) => b - a), 'newest first');
    assert.equal(versions.filter((v) => v.isCurrent).length, 1);
    assert.equal(list.body.data.currentVersion, versions.find((v) => v.isCurrent).version);
    const json = JSON.stringify(list.body);
    for (const leak of ['lockedBy', 'accessToken', 'project_id', 'profileSnapshot', '"__v"']) assert.equal(json.includes(leak), false, leak);

    const old = versions.find((v) => !v.isCurrent);
    const opened = await call('GET', `/api/social/content-calendar/history/${old.id}?${q(pidA())}`);
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.equal(opened.body.data.version.id, old.id);
    assert.ok(opened.body.data.items.length > 0 && opened.body.data.items.every((i) => i.locked === true), 'read-only');
    assert.equal((await call('GET', `/api/social/content-calendar/history/${old.id}?${q(pidB())}`, { token: tokenB })).status, 404, 'another project cannot open it by id');
    assert.equal((await call('GET', `/api/social/content-calendar/history/not-an-id?${q(pidA())}`)).status, 404);

    const same = await call('POST', '/api/social/content-calendar/restore', { body: { projectId: pidA(), calendarId: versions.find((v) => v.isCurrent).id } });
    assert.equal(same.status, 409);
    assert.equal(same.body.details.code, 'ALREADY_CURRENT');
    const restored = await call('POST', '/api/social/content-calendar/restore', { body: { projectId: pidA(), calendarId: old.id } });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.data.restoredVersion, old.version);
    const state = (await call('GET', `/api/social/content-calendar?${q(pidA())}`)).body.data;
    assert.equal(state.calendar.version, old.version);
    // the restore left a consistent state for what follows
    const back = await call('POST', '/api/social/content-calendar/restore', { body: { projectId: pidA(), calendarId: versions.find((v) => v.isCurrent).id } });
    assert.equal(back.status, 200, JSON.stringify(back.body));
  });

  test('11: generation is rate limited per user (it spends paid AI tokens): after the budget, 429 RATE_LIMITED with Retry-After — and a different user is unaffected', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    process.env.SOCIAL_AI_CALENDAR_RATE_LIMIT_ENABLED = 'true';
    try {
      const bad = request({ postsPerWeek: 0 }, pidB()); // cheap, always rejected by validation, but each call still counts against the budget
      const statuses = [];
      for (let i = 0; i < CALENDAR_RATE_LIMIT.max + 1; i += 1) statuses.push((await call('POST', '/api/social/content-calendar/generate', { token: tokenB, body: bad })).status);
      assert.deepEqual(statuses.slice(0, CALENDAR_RATE_LIMIT.max), Array(CALENDAR_RATE_LIMIT.max).fill(400));
      assert.equal(statuses.at(-1), 429);
      const limited = await fetch(base + '/api/social/content-calendar/generate', { method: 'POST', headers: { authorization: `Bearer ${tokenB}`, 'content-type': 'application/json' }, body: JSON.stringify(bad) });
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get('retry-after')) > 0);
      assert.equal((await limited.json()).details.code, 'RATE_LIMITED');
      // reading is not limited, and another user has their own budget
      assert.equal((await call('GET', `/api/social/content-calendar?${q(pidB())}`, { token: tokenB })).status, 200);
      assert.equal((await call('POST', '/api/social/content-calendar/generate', { token: tokenA, body: request({ postsPerWeek: 0 }) })).status, 400);
    } finally {
      process.env.SOCIAL_AI_CALENDAR_RATE_LIMIT_ENABLED = 'false';
    }
  });
});
