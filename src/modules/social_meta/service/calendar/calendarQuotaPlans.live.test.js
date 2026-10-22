import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

// No platform-wide number here: every limit in this file comes from the plan settings under test (read when called, never at import).
for (const name of ['SOCIAL_AI_CALENDAR_QUOTA_USER_POSTS_PER_MONTH', 'SOCIAL_AI_CALENDAR_QUOTA_PROJECT_POSTS_PER_MONTH', 'SOCIAL_AI_STARTER_CALENDAR_POSTS_PER_MONTH', 'SOCIAL_AI_PRO_CALENDAR_POSTS_PER_MONTH', 'SOCIAL_AI_PREMIUM_CALENDAR_POSTS_PER_MONTH', 'SOCIAL_AI_NO_PLAN_CALENDAR_POSTS_PER_MONTH']) delete process.env[name];
process.env.SOCIAL_AI_CALENDAR_QUOTA_MAX_IN_FLIGHT_PER_USER = '50';

const { default: SeoProject } = await import('../../../app_user/model/SeoProject.js');
const { default: SocialAccount } = await import('../../model/SocialAccount.js');
const { default: SocialAIStrategy } = await import('../../model/SocialAIStrategy.js');
const { default: SocialBusinessProfile } = await import('../../model/SocialBusinessProfile.js');
const { default: SocialContentCalendar } = await import('../../model/SocialContentCalendar.js');
const { default: SocialContentCalendarItem } = await import('../../model/SocialContentCalendarItem.js');
const { default: SocialAIUsage } = await import('../../model/SocialAIUsage.js');
const { default: User } = await import('../../../user/model/User.js');
const { deleteProjectCascade } = await import('../../../app_user/service/projectCascadeDeleteService.js');
const { updateProfile } = await import('../socialBusinessProfileService.js');
const { startGeneration: startStrategy, setProviderOverride: setStrategyProvider, resetProviderOverride: resetStrategyProvider } = await import('../aiStrategy/socialAIStrategyService.js');
const { startCalendarGeneration, previewCalendar, getCalendarState, setCalendarProviderOverride, resetCalendarProviderOverride } = await import('./socialContentCalendarService.js');
const quota = await import('./calendarQuotaService.js');
const { generateContentCalendarHandler, previewContentCalendarHandler, getContentCalendarHandler } = await import('../../controller/socialContentCalendarController.js');
const { validRawStrategy, mockProvider, validRawCalendarBatch, parseSlotsFromPrompt } = await import('../../testSupport/aiStrategyFixtures.js');

/**
 * Plan allowances for the Social AI calendar, with a real MongoDB and scripted AI. Every supported plan; nothing decided in production
 * (the feature is refused, never unlimited); invalid settings; plan changes inside a month; deleting a project while it generates.
 */

let mongoAvailable = false;
before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
    await Promise.all([SocialContentCalendar.init(), SocialContentCalendarItem.init(), SocialAIStrategy.init(), SocialAIUsage.init()]);
  } catch { mongoAvailable = false; }
});
after(async () => {
  resetCalendarProviderOverride();
  resetStrategyProvider();
  if (mongoAvailable) await mongoose.connection.close();
});

const addDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

function scriptedProvider(script = async () => null) {
  const calls = [];
  return {
    calls,
    isAvailable: () => true,
    async generateCalendarPlan({ user }) {
      const slots = parseSlotsFromPrompt(user);
      calls.push({ slots: slots.map((s) => s.index) });
      const out = await script({ slots, n: calls.length });
      return { parsed: out ?? validRawCalendarBatch(slots), usage: { inputTokens: 1000, outputTokens: 2000 }, model: 'mock', durationMs: 1, attempts: 1 };
    },
  };
}

const PLAN_IDS = ['starter', 'pro', 'premium'];
const ENV_FOR = { starter: 'SOCIAL_AI_STARTER_CALENDAR_POSTS_PER_MONTH', pro: 'SOCIAL_AI_PRO_CALENDAR_POSTS_PER_MONTH', premium: 'SOCIAL_AI_PREMIUM_CALENDAR_POSTS_PER_MONTH' };
const NO_PLAN = 'SOCIAL_AI_NO_PLAN_CALENDAR_POSTS_PER_MONTH';

describe('Social AI plan allowances (real MongoDB, scripted providers)', () => {
  let userId; let project; let pid; let created; let gates; let envBackup;
  const track = (d) => { created.push(d); return d; };
  const setEnv = (vars) => { for (const [k, v] of Object.entries(vars)) { if (!(k in envBackup)) envBackup[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  const request = (over = {}) => ({ startDate: addDays(1), months: 1, endDate: undefined, postsPerWeek: 2, platforms: ['facebook'], distributionMode: 'balanced', ...over });
  const start = (provider, over = {}, options = {}, id = pid, uid = userId) => { setCalendarProviderOverride(provider); return startCalendarGeneration(id, uid, request(over), options); };
  const userLedger = () => SocialAIUsage.findOne({ scope: 'user', scope_id: userId, period: quota.periodOf() }).lean();
  const setPlan = (plan) => User.collection.updateOne({ _id: userId }, { $set: { 'subscription.plan': plan } });
  const fakeRes = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
  const call = async (handler, body) => { const res = fakeRes(); await handler({ projectId: pid, userId, body: { projectId: pid, ...body } }, res); return res; };

  async function makeProject(name = 'Plans') {
    const p = track(await SeoProject.create({ user_id: userId, project_name: `${name} ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'], description: 'Family dental practice', industry: 'Dentist' }));
    await updateProfile(String(p._id), userId, { audience: { primary: 'Young families' }, goals: ['More bookings'], toneOfVoice: { primary: 'Warm' } });
    track(await SocialAccount.create({ user_id: userId, project_id: p._id, platform: 'facebook', platformAccountId: `pg_${p._id}`, platformAccountName: 'Page', accountType: 'page', pageId: `pg_${p._id}`, accessToken: 'FB-SECRET-TOKEN', status: 'active', isActive: true }));
    setStrategyProvider(mockProvider({ behavior: () => validRawStrategy() }));
    const r = await startStrategy(String(p._id), userId, { background: false });
    resetStrategyProvider();
    assert.equal(r.generation.status, 'ready', JSON.stringify(r));
    return p;
  }

  beforeEach(async () => {
    if (!mongoAvailable) return;
    created = []; gates = []; envBackup = {};
    userId = new mongoose.Types.ObjectId();
    await User.collection.insertOne({ _id: userId, email: `plans-${userId}@example.com`, subscription: { plan: 'starter', status: 'active' } });
    project = await makeProject();
    pid = String(project._id);
  });

  afterEach(async () => {
    for (const g of gates) g.resolve();
    await sleep(60);
    resetCalendarProviderOverride();
    for (const [k, v] of Object.entries(envBackup || {})) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (!mongoAvailable) return;
    const ids = created.map((d) => d.project_id || d._id);
    await Promise.all([
      SocialContentCalendarItem.deleteMany({ project_id: { $in: ids } }), SocialContentCalendar.deleteMany({ project_id: { $in: ids } }),
      SocialAIStrategy.deleteMany({ project_id: { $in: ids } }), SocialBusinessProfile.deleteMany({ project_id: { $in: ids } }),
      SocialAccount.deleteMany({ _id: { $in: created.map((d) => d._id) } }),
      SocialAIUsage.deleteMany({ $or: [{ scope: 'user', scope_id: userId }, { scope: 'project', scope_id: { $in: ids } }] }),
      User.deleteMany({ _id: userId }),
    ]);
    await SeoProject.deleteMany({ _id: { $in: created.map((d) => d._id) } });
  });

  test('P1: EVERY supported plan enforces its own allowance - a calendar bigger than it is refused before any AI call, one that fits runs - and nothing leaks into another plan', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    setEnv({ [ENV_FOR.starter]: '5', [ENV_FOR.pro]: '40', [ENV_FOR.premium]: 'unlimited' });
    const expected = { starter: { limit: 5, source: 'env' }, pro: { limit: 40, source: 'env' }, premium: { limit: null, source: 'env' } };
    for (const plan of PLAN_IDS) {
      await setPlan(plan);
      const limits = await quota.limitsFor(userId);
      assert.deepEqual([limits.userPosts, limits.source, limits.planId, limits.blocked], [expected[plan].limit, expected[plan].source, plan, null], plan);
    }

    await setPlan('starter');
    const provider = scriptedProvider();
    const refused = await start(provider, { postsPerWeek: 2 }); // 8-9 posts against 5
    assert.equal(refused.success, false);
    assert.equal(refused.error.code, 'QUOTA_EXCEEDED');
    assert.equal(refused.error.limit, 5);
    assert.equal(provider.calls.length, 0, 'refused before any AI call');
    assert.equal(await SocialContentCalendar.countDocuments({ project_id: project._id }), 0, 'the claim was withdrawn');
    assert.deepEqual((await userLedger())?.reservations ?? [], [], 'nothing is left reserved');

    await setPlan('pro');
    const ran = await start(scriptedProvider(), { postsPerWeek: 2 }, { background: false });
    assert.equal(ran.success, true, JSON.stringify(ran));
    assert.equal((await SocialContentCalendar.findOne({ project_id: project._id }).lean()).status, 'ready');
    const afterPro = await userLedger();
    assert.ok(afterPro.committedPosts >= 8 && afterPro.committedPosts <= 40);

    await setPlan('premium'); // explicitly unlimited: a deliberate decision, not a missing one
    assert.equal((await quota.getUsageSummary({ userId, projectId: pid })).user.limit, null);
  });

  test('P2: in PRODUCTION a plan with no allowance decided refuses calendar generation (503 QUOTA_NOT_CONFIGURED) - it is never unlimited - and nothing is created or reserved', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    setEnv({ NODE_ENV: 'production', [ENV_FOR.starter]: undefined });
    const provider = scriptedProvider();
    setCalendarProviderOverride(provider);

    const limits = await quota.limitsFor(userId);
    assert.deepEqual([limits.blocked?.code, limits.userPosts], ['QUOTA_NOT_CONFIGURED', 0]);

    const generate = await call(generateContentCalendarHandler, request());
    assert.equal(generate.code, 503);
    assert.equal(generate.body.details.code, 'QUOTA_NOT_CONFIGURED');
    assert.doesNotMatch(JSON.stringify(generate.body), /SOCIAL_AI_|env|PLANS/i, 'the customer is not told which setting is missing');
    const preview = await call(previewContentCalendarHandler, request());
    assert.equal(preview.code, 503);
    assert.equal(provider.calls.length, 0);
    assert.equal(await SocialContentCalendar.countDocuments({ project_id: project._id }), 0);
    assert.equal(await SocialAIUsage.countDocuments({ scope: 'user', scope_id: userId }), 0, 'not even a ledger row');

    const state = await call(getContentCalendarHandler, {});
    assert.equal(state.code, 200, 'the page still loads');
    assert.equal(state.body.data.quota.unavailable.code, 'QUOTA_NOT_CONFIGURED', 'and says the allowance is unavailable instead of showing "unlimited"');
    assert.equal(state.body.data.quota.user.limit, 0);

    // the same account outside production keeps working without any setup (development, tests)
    setEnv({ NODE_ENV: 'test' });
    const dev = await quota.limitsFor(userId);
    assert.deepEqual([dev.blocked, dev.userPosts, dev.source], [null, null, 'none']);
  });

  test('P3: in production an account with NO plan is refused (403 PLAN_REQUIRED) unless a no-plan allowance is set - a number is a trial, 0 means none', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    setEnv({ NODE_ENV: 'production', [NO_PLAN]: undefined });
    await setPlan(null);
    const refused = await call(generateContentCalendarHandler, request());
    assert.equal(refused.code, 403);
    assert.equal(refused.body.details.code, 'PLAN_REQUIRED');

    await setPlan('ghost-plan'); // a retired / unknown plan id is "no plan", not "unlimited"
    assert.equal((await quota.limitsFor(userId)).blocked?.code, 'PLAN_REQUIRED');

    setEnv({ [NO_PLAN]: '5' });
    await setPlan(null);
    const trial = await start(scriptedProvider(), { postsPerWeek: 2 });
    assert.equal(trial.error.code, 'QUOTA_EXCEEDED');
    assert.equal(trial.error.limit, 5);

    setEnv({ [NO_PLAN]: '0' });
    const none = await start(scriptedProvider(), { postsPerWeek: 1 });
    assert.equal(none.error.code, 'QUOTA_EXCEEDED');
    assert.equal(none.error.limit, 0);
  });

  test('P4: an invalid setting is never read as "unlimited": the account is blocked, in production and outside it', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    for (const bad of ['abc', '-5', '1.5', '12 posts', '1e9']) {
      setEnv({ NODE_ENV: 'test', [ENV_FOR.starter]: bad });
      const limits = await quota.limitsFor(userId);
      assert.equal(limits.blocked?.code, 'QUOTA_NOT_CONFIGURED', bad);
      assert.equal(limits.userPosts, 0, bad);
    }
    setEnv({ NODE_ENV: 'test', [ENV_FOR.starter]: '8' });
    assert.equal((await quota.limitsFor(userId)).blocked, null);
  });

  test('P5: explicit "unlimited" is a decision and works in production; the platform-wide number covers a plan nobody configured', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    setEnv({ NODE_ENV: 'production', [ENV_FOR.starter]: 'unlimited' });
    const unlimited = await quota.limitsFor(userId);
    assert.deepEqual([unlimited.blocked, unlimited.userPosts, unlimited.source], [null, null, 'env']);
    const ran = await start(scriptedProvider(), { postsPerWeek: 2 }, { background: false });
    assert.equal(ran.success, true, JSON.stringify(ran));

    setEnv({ [ENV_FOR.starter]: undefined, SOCIAL_AI_CALENDAR_QUOTA_USER_POSTS_PER_MONTH: '30' });
    const platform = await quota.limitsFor(userId);
    assert.deepEqual([platform.blocked, platform.userPosts, platform.source], [null, 30, 'platform']);
  });

  test('P6: changing plan inside a month: a downgrade applies to what is left, an upgrade opens room at once, and what was generated stays counted', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    setEnv({ [ENV_FOR.starter]: '10', [ENV_FOR.pro]: '30' });
    await setPlan('pro');
    const first = await start(scriptedProvider(), { postsPerWeek: 2 }, { background: false });
    assert.equal(first.success, true, JSON.stringify(first));
    const used = (await userLedger()).committedPosts;
    assert.ok(used >= 8);

    await setPlan('starter'); // limit 10; 8-9 already used
    const downgraded = await quota.getUsageSummary({ userId, projectId: pid });
    assert.deepEqual([downgraded.user.limit, downgraded.user.used, downgraded.user.remaining], [10, used, 10 - used]);
    const refused = await start(scriptedProvider(), { postsPerWeek: 2 });
    assert.equal(refused.error.code, 'QUOTA_EXCEEDED');
    assert.equal(refused.error.remaining, 10 - used);

    await setPlan('pro');
    const upgraded = await start(scriptedProvider(), { postsPerWeek: 2 }, { background: false });
    assert.equal(upgraded.success, true, JSON.stringify(upgraded));
    assert.ok((await userLedger()).committedPosts >= used * 2 - 2, 'the first calendar is still counted');
  });

  test('P7: the usage view separates posts really generated from posts held by a calendar that is still running, and carries no billing data', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    setEnv({ [ENV_FOR.starter]: '50' });
    const g = deferred(); gates.push(g);
    const provider = scriptedProvider(async ({ n }) => { if (n === 2) await g.promise; return null; });
    const started = await start(provider, { postsPerWeek: 2 });
    assert.equal(started.started, true);
    for (let i = 0; i < 100 && provider.calls.length < 2; i += 1) await sleep(20); // first batch saved, second in flight
    const view = await quota.getUsageSummary({ userId, projectId: pid });
    assert.ok(view.user.reserved > 0, 'the running calendar holds its posts');
    assert.equal(view.user.used, view.user.committed + view.user.reserved);
    assert.equal(view.user.remaining, 50 - view.user.used);
    assert.equal(view.inFlight, 1);
    assert.doesNotMatch(JSON.stringify(view), /estimatedCostUsd|inputTokens|outputTokens|aiCalls|"usage"|"source"|"planId"/);
    g.resolve();
    for (let i = 0; i < 150; i += 1) { const c = await SocialContentCalendar.findOne({ project_id: project._id }).lean(); if (c?.status === 'ready') break; await sleep(40); }
    const done = await quota.getUsageSummary({ userId, projectId: pid });
    assert.equal(done.user.reserved, 0);
    assert.ok(done.user.committed >= 8);
  });

  test('P8: deleting a project WHILE its calendar generates counts the posts it already produced (they are not refunded) and releases the reservation at once', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    setEnv({ [ENV_FOR.starter]: '50' });
    const g = deferred(); gates.push(g);
    const provider = scriptedProvider(async ({ n }) => { if (n === 2) await g.promise; return null; });
    assert.equal((await start(provider, { postsPerWeek: 2 })).started, true);
    for (let i = 0; i < 100 && provider.calls.length < 2; i += 1) await sleep(20);
    const saved = await SocialContentCalendarItem.countDocuments({ project_id: project._id });
    assert.ok(saved > 0, 'the first batch is saved while the second is in flight');
    assert.equal((await userLedger()).reservations.length, 1);

    await SeoProject.updateOne({ _id: project._id }, { $set: { is_deleted: true } });
    await deleteProjectCascade(pid);
    const ledger = await userLedger();
    assert.equal(ledger.reservations.length, 0, 'the reservation does not wait for the sweep');
    assert.equal(ledger.committedPosts, saved, 'the generated posts stay on the account');
    assert.equal(await SocialContentCalendar.countDocuments({ project_id: project._id }), 0);
    g.resolve();
    await sleep(300);
    assert.equal((await userLedger()).committedPosts, saved, 'the worker that finds its project gone adds nothing');
  });

  test('P9: concurrent starts on one plan cannot exceed the allowance: 12 simultaneous reservations of 5 against a 40-post plan fit exactly 8', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    setEnv({ [ENV_FOR.starter]: '40' });
    const results = await Promise.all(Array.from({ length: 12 }, () => quota.reserveCalendarQuota({ userId, projectId: pid, calendarId: new mongoose.Types.ObjectId(), posts: 5 })));
    assert.equal(results.filter((r) => r.success).length, 8);
    assert.deepEqual([...new Set(results.filter((r) => !r.success).map((r) => r.error.code))], ['QUOTA_EXCEEDED']);
    assert.equal((await userLedger()).reservations.reduce((n, r) => n + r.posts, 0), 40);
  });

  test('P10: the preview and the calendar read do not need a plan to be configured in development, and never throw when the user row is missing', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    setEnv({ NODE_ENV: 'test' });
    await User.deleteMany({ _id: userId });
    const preview = await previewCalendar(request(), { userId, projectId: pid });
    assert.equal(preview.success, true, JSON.stringify(preview));
    assert.equal(preview.preview.quota.user.limit, null);
    const state = await getCalendarState(pid, { userId });
    assert.equal(state.quota.unavailable, null);
  });
});
