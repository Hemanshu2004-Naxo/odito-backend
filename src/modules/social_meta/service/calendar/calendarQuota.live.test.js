import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

// Limits are configuration, read when the config module is first imported - so they are set here, before any import of it (node --test runs each file in its own process).
process.env.SOCIAL_AI_CALENDAR_QUOTA_USER_POSTS_PER_MONTH = '40';
process.env.SOCIAL_AI_CALENDAR_QUOTA_PROJECT_POSTS_PER_MONTH = '30';
process.env.SOCIAL_AI_CALENDAR_QUOTA_MAX_IN_FLIGHT_PER_USER = '50';
process.env.SOCIAL_AI_COST_USD_PER_MTOK_INPUT = '3';
process.env.SOCIAL_AI_COST_USD_PER_MTOK_OUTPUT = '15';
process.env.SOCIAL_AI_CALENDAR_QUOTA_RECONCILE_AFTER_MS = '1000';

const { default: SeoProject } = await import('../../../app_user/model/SeoProject.js');
const { default: SocialAccount } = await import('../../model/SocialAccount.js');
const { default: SocialAIStrategy } = await import('../../model/SocialAIStrategy.js');
const { default: SocialBusinessProfile } = await import('../../model/SocialBusinessProfile.js');
const { default: SocialContentCalendar } = await import('../../model/SocialContentCalendar.js');
const { default: SocialContentCalendarItem } = await import('../../model/SocialContentCalendarItem.js');
const { default: SocialAIUsage } = await import('../../model/SocialAIUsage.js');
const { default: User } = await import('../../../user/model/User.js');
const { PLANS } = await import('../../../../config/plans.js');
const { deleteProjectCascade } = await import('../../../app_user/service/projectCascadeDeleteService.js');
const { updateProfile } = await import('../socialBusinessProfileService.js');
const { startGeneration: startStrategy, setProviderOverride: setStrategyProvider, resetProviderOverride: resetStrategyProvider } = await import('../aiStrategy/socialAIStrategyService.js');
const svc = await import('./socialContentCalendarService.js');
const { startCalendarGeneration, resumeCalendar, cancelCalendar, getCalendarState, previewCalendar, setCalendarProviderOverride, resetCalendarProviderOverride } = svc;
const quota = await import('./calendarQuotaService.js');
const { runOnce: sweepOnce } = await import('./calendarRecoveryScheduler.js');
const { generateContentCalendarHandler, previewContentCalendarHandler, getContentCalendarHandler } = await import('../../controller/socialContentCalendarController.js');
const { CALENDAR_BATCH_SIZE } = await import('./calendarConfig.js');
const { validRawStrategy, mockProvider, validRawCalendarBatch, parseSlotsFromPrompt } = await import('../../testSupport/aiStrategyFixtures.js');

/**
 * Usage limits and cost tracking: database-enforced reservations and idempotent settlement. Real MongoDB, scripted AI.
 * Limits here: 40 posts / month for the account, 30 for a project; token prices 3 / 15 USD per million (input / output).
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

describe('calendar usage limits and cost tracking (real MongoDB, scripted providers)', () => {
  let userId; let project; let pid; let created; let gates;
  const track = (d) => { created.push(d); return d; };
  const request = (over = {}) => ({ startDate: addDays(1), months: 1, endDate: undefined, postsPerWeek: 3, platforms: ['facebook'], distributionMode: 'balanced', ...over });
  const start = (provider, over = {}, options = {}, id = pid, uid = userId) => { setCalendarProviderOverride(provider); return startCalendarGeneration(id, uid, request(over), options); };
  const ledger = (scope, scopeId, period = quota.periodOf()) => SocialAIUsage.findOne({ scope, scope_id: scopeId, period }).lean();
  const userLedger = () => ledger('user', userId);
  const projectLedger = (p = project) => ledger('project', p._id);
  const calendarDoc = (id = project._id) => SocialContentCalendar.findOne({ project_id: id }).sort({ version: -1 }).lean();
  const items = (calendarId) => SocialContentCalendarItem.countDocuments({ calendar_id: calendarId });

  async function makeProject(name = 'Quota') {
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
    created = []; gates = [];
    userId = new mongoose.Types.ObjectId();
    project = await makeProject();
    pid = String(project._id);
  });

  afterEach(async () => {
    for (const g of gates) g.resolve();
    await sleep(60);
    resetCalendarProviderOverride();
    PLANS.starter.socialAi = { calendarPostsPerMonth: null }; // restore the canonical (undecided) entry
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

  test('Q1: a generation commits what it really produced - posts, AI calls, tokens and (with prices configured) an estimated cost - and holds no reservation afterwards', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const r = await start(scriptedProvider(), { postsPerWeek: 2 }, { background: false });
    assert.equal(r.generation.status, 'ready', JSON.stringify(r));
    const cal = await calendarDoc();
    const total = await items(cal._id);
    const batches = Math.ceil(total / CALENDAR_BATCH_SIZE);
    for (const l of [await userLedger(), await projectLedger()]) {
      assert.equal(l.committedPosts, total);
      assert.deepEqual(l.reservations, []);
      assert.equal(l.aiCalls, batches);
      assert.equal(l.inputTokens, batches * 1000);
      assert.equal(l.outputTokens, batches * 2000);
      assert.ok(Math.abs(l.estimatedCostUsd - ((batches * 1000) / 1e6 * 3 + (batches * 2000) / 1e6 * 15)) < 1e-9, `cost ${l.estimatedCostUsd}`);
    }
    const summary = await quota.getUsageSummary({ userId, projectId: pid, internal: true });
    assert.deepEqual([summary.user.limit, summary.user.used, summary.user.remaining], [40, total, 40 - total]);
    assert.deepEqual([summary.user.committed, summary.user.reserved], [total, 0], 'everything used is committed; nothing is held by a running calendar');
    assert.deepEqual([summary.project.limit, summary.project.used, summary.project.remaining], [30, total, 30 - total]);
    assert.equal(summary.inFlight, 0);
    assert.ok(summary.usage.estimatedCostUsd > 0);
  });

  test('Q2: a calendar that does not fit the allowance is refused BEFORE any AI call, with how much is left and when it resets; nothing is left behind', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const provider = scriptedProvider();
    const r = await start(provider, { months: 3, postsPerWeek: 3 }); // ~40 posts: the project allowance is 30
    assert.equal(r.success, false);
    assert.equal(r.error.code, 'QUOTA_EXCEEDED');
    assert.equal(r.error.scope, 'project');
    assert.equal(r.error.limit, 30);
    assert.equal(r.error.remaining, 30);
    assert.ok(r.error.requested >= 36);
    assert.match(r.error.message, /needs \d+ posts, but this project has 30 of 30 calendar posts left this month/);
    assert.match(r.error.message, /resets on 1 \w{3} \d{4}/);
    assert.equal(new Date(r.error.resetsAt).getUTCDate(), 1);
    assert.equal(provider.calls.length, 0, 'no AI call');
    assert.equal(await SocialContentCalendar.countDocuments({ project_id: project._id }), 0, 'the unstarted claim was withdrawn');
    assert.deepEqual((await projectLedger()).reservations, []);
    assert.deepEqual((await userLedger()).reservations, [], 'the account reservation is not left behind either');
  });

  test('Q3: the allowance is enforced under concurrency: 12 simultaneous reservations of 5 posts against 40 fit exactly 8', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const ids = Array.from({ length: 12 }, () => new mongoose.Types.ObjectId());
    const projects = ids.map(() => ({ _id: new mongoose.Types.ObjectId() })); // only ids are needed: the ledger does not read the projects
    const results = await Promise.all(ids.map((calendarId, i) => quota.reserveCalendarQuota({ userId, projectId: projects[i]._id, calendarId, posts: 5 })));
    assert.equal(results.filter((r) => r.success).length, 8, JSON.stringify(results.map((r) => r.error?.code || 'ok')));
    assert.ok(results.filter((r) => !r.success).every((r) => r.error.code === 'QUOTA_EXCEEDED' && r.error.scope === 'user'));
    const l = await userLedger();
    assert.equal(l.reservations.reduce((n, x) => n + x.posts, 0), 40);
    // the losers left nothing on their project's ledger
    const leftovers = await SocialAIUsage.countDocuments({ scope: 'project', scope_id: { $in: projects.map((p) => p._id) }, 'reservations.0': { $exists: true } });
    assert.equal(leftovers, 8);
    for (const calendarId of ids) await quota.settleCalendarQuota(calendarId);
    assert.deepEqual((await userLedger()).reservations, []);
  });

  test('Q4: settling is idempotent and race-safe: five simultaneous settles commit once', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const g = deferred(); gates.push(g);
    await start(scriptedProvider(async ({ n }) => { if (n === 2) await g.promise; return null; }), { postsPerWeek: 2 });
    for (let i = 0; i < 200 && (await items((await calendarDoc())._id)) < CALENDAR_BATCH_SIZE; i += 1) await sleep(15);
    const cal = await calendarDoc();
    const results = await Promise.all(Array.from({ length: 5 }, () => quota.settleCalendarQuota(cal._id)));
    assert.equal(results.reduce((n, r) => n + r.settled, 0), 2, 'one settlement per ledger (account + project), not five');
    const committed = (await userLedger()).committedPosts;
    assert.equal(committed, CALENDAR_BATCH_SIZE);
    assert.equal((await quota.settleCalendarQuota(cal._id)).settled, 0);
    assert.equal((await userLedger()).committedPosts, committed, 'a later settle changes nothing');
  });

  test('Q5: a generation that produces nothing costs no posts: the reservation is given back (the tokens it used are still recorded)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const denied = scriptedProvider(async () => { const e = new Error('x'); e.code = 'CLAUDE_AUTH'; throw e; });
    const r = await start(denied, { postsPerWeek: 2 }, { background: false });
    assert.equal(r.generation.status, 'failed');
    const l = await userLedger();
    assert.equal(l.committedPosts, 0);
    assert.deepEqual(l.reservations, []);
    assert.equal((await quota.getUsageSummary({ userId, projectId: pid })).user.remaining, 40, 'the whole allowance is available again');
    // and a good calendar can use all of it
    assert.equal((await start(scriptedProvider(), { postsPerWeek: 3 }, { background: false })).generation.status, 'ready');
  });

  test('Q6: resuming a partial calendar reserves and commits ONLY the missing posts - the saved ones are never charged twice', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const r = await start(scriptedProvider(async ({ n }) => (n >= 2 ? { items: [] } : null)), { postsPerWeek: 3 }, { background: false });
    assert.equal(r.generation.status, 'partial');
    const total = r.generation.progress.totalPosts;
    assert.equal((await userLedger()).committedPosts, CALENDAR_BATCH_SIZE, 'the saved batch is committed when the run stops');
    assert.deepEqual((await userLedger()).reservations, [], 'a stopped run holds no reservation');

    setCalendarProviderOverride(scriptedProvider());
    const res = await resumeCalendar(pid, { background: false, userId });
    assert.equal(res.success, true, JSON.stringify(res.error));
    const l = await userLedger();
    assert.equal(l.committedPosts, total, 'exactly the calendar\'s posts in total - not total + 4');
    assert.deepEqual(l.reservations, []);
    assert.equal((await projectLedger()).committedPosts, total);
  });

  test('Q7: resume is refused when the missing posts no longer fit the allowance, and nothing changes', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const r = await start(scriptedProvider(async ({ n }) => (n >= 2 ? { items: [] } : null)), { postsPerWeek: 3 }, { background: false });
    assert.equal(r.generation.status, 'partial');
    // the rest of the month is used up elsewhere
    await SocialAIUsage.updateOne({ scope: 'user', scope_id: userId, period: quota.periodOf() }, { $set: { committedPosts: 40 } });
    const provider = scriptedProvider();
    setCalendarProviderOverride(provider);
    const res = await resumeCalendar(pid, { background: false, userId });
    assert.equal(res.success, false);
    assert.equal(res.error.code, 'QUOTA_EXCEEDED');
    assert.equal(provider.calls.length, 0);
    assert.equal((await calendarDoc()).status, 'partial', 'still resumable later');
    assert.deepEqual((await userLedger()).reservations, []);
  });

  test('Q8: cancelling counts what was really generated before discarding it (the work was done); the rest of the reservation is freed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const g = deferred(); gates.push(g);
    await start(scriptedProvider(async ({ n }) => { if (n === 2) await g.promise; return null; }), { postsPerWeek: 3 });
    for (let i = 0; i < 200 && (await items((await calendarDoc())._id)) < CALENDAR_BATCH_SIZE; i += 1) await sleep(15);
    assert.equal((await userLedger()).reservations.length, 1, 'while it runs, its posts are reserved');
    const c = await cancelCalendar(pid);
    assert.equal(c.success, true);
    const l = await userLedger();
    assert.deepEqual(l.reservations, []);
    assert.equal(l.committedPosts, CALENDAR_BATCH_SIZE, 'the batch that was generated is counted');
    assert.equal(await SocialContentCalendarItem.countDocuments({ project_id: project._id }), 0, 'and discarded');
    g.resolve();
    await sleep(300);
    assert.equal((await userLedger()).committedPosts, CALENDAR_BATCH_SIZE, 'the worker that finishes later adds nothing');
  });

  test('Q9: limits are per project and per account: one project at its limit does not block another project, but the account total still applies', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const other = await makeProject('Other');
    await SocialAIUsage.updateOne({ scope: 'project', scope_id: project._id, period: quota.periodOf() }, { $set: { committedPosts: 30 }, $setOnInsert: { reservations: [] } }, { upsert: true });
    await SocialAIUsage.updateOne({ scope: 'user', scope_id: userId, period: quota.periodOf() }, { $set: { committedPosts: 38 }, $setOnInsert: { reservations: [] } }, { upsert: true });
    const blocked = await start(scriptedProvider(), { postsPerWeek: 1 }, {}, pid);
    assert.equal(blocked.error.code, 'QUOTA_EXCEEDED');
    assert.equal(blocked.error.scope, 'user', 'the account total applies to every project of the account');
    await SocialAIUsage.updateOne({ scope: 'user', scope_id: userId, period: quota.periodOf() }, { $set: { committedPosts: 10 } });
    assert.equal((await start(scriptedProvider(), { postsPerWeek: 1 }, {}, pid)).error.scope, 'project', 'the project that used its allowance is refused');
    const ok = await start(scriptedProvider(), { postsPerWeek: 1 }, { background: false }, String(other._id));
    assert.equal(ok.generation.status, 'ready', JSON.stringify(ok));
    // another account is untouched by all of it
    const stranger = new mongoose.Types.ObjectId();
    assert.equal((await quota.getUsageSummary({ userId: stranger, projectId: String(other._id) })).user.used, 0);
  });

  test('Q10: the allowance is monthly: the next UTC month starts fresh, and the reset date is the first of it', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    assert.equal(quota.periodOf(new Date('2026-12-31T23:59:59Z')), '2026-12');
    assert.equal(quota.periodResetsAt('2026-12').toISOString(), '2027-01-01T00:00:00.000Z');
    await SocialAIUsage.updateOne({ scope: 'user', scope_id: userId, period: '2026-12' }, { $set: { committedPosts: 40 }, $setOnInsert: { reservations: [] } }, { upsert: true });
    const december = await quota.reserveCalendarQuota({ userId, projectId: project._id, calendarId: new mongoose.Types.ObjectId(), posts: 5, now: new Date('2026-12-31T23:00:00Z') });
    assert.equal(december.success, false);
    assert.equal(december.error.period, '2026-12');
    const january = await quota.reserveCalendarQuota({ userId, projectId: project._id, calendarId: new mongoose.Types.ObjectId(), posts: 5, now: new Date('2027-01-01T00:00:01Z') });
    assert.equal(january.success, true);
    assert.equal(january.period, '2027-01');
  });

  test('Q11: a plan can carry the entitlement (PLANS[plan].socialAi.calendarPostsPerMonth) and then it wins over the platform setting; an unknown plan carries none', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await User.collection.insertOne({ _id: userId, email: `quota-${userId}@example.com`, subscription: { plan: 'starter', status: 'active' } });
    assert.deepEqual((({ userPosts, source }) => ({ userPosts, source }))(await quota.limitsFor(userId)), { userPosts: 40, source: 'platform' });
    PLANS.starter.socialAi = { calendarPostsPerMonth: 12 };
    assert.deepEqual((({ userPosts, source }) => ({ userPosts, source }))(await quota.limitsFor(userId)), { userPosts: 12, source: 'plan' });
    const refused = await start(scriptedProvider(), { postsPerWeek: 3 });
    assert.equal(refused.error.code, 'QUOTA_EXCEEDED');
    assert.equal(refused.error.limit, 12);
    await User.collection.updateOne({ _id: userId }, { $set: { 'subscription.plan': 'ghost-plan' } });
    assert.equal((await quota.limitsFor(userId)).source, 'platform', 'an unknown plan id is not an entitlement and not an error');
  });

  test('Q12: reconciliation releases reservations whose generation is gone or finished, and leaves the running one alone', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const ghost = new mongoose.Types.ObjectId();
    assert.equal((await quota.reserveCalendarQuota({ userId, projectId: project._id, calendarId: ghost, posts: 9, now: new Date(Date.now() - 60_000) })).success, true);
    // a real running generation, reserved long ago too
    const g = deferred(); gates.push(g);
    await start(scriptedProvider(async () => { await g.promise; return null; }), { postsPerWeek: 2 });
    await SocialAIUsage.updateMany({ scope: 'user', scope_id: userId }, { $set: { 'reservations.$[].at': new Date(Date.now() - 60_000) } });
    const swept = await sweepOnce();
    assert.ok(swept.quota.settled >= 1);
    const l = await userLedger();
    assert.deepEqual(l.reservations.map((r) => String(r.calendar_id)).includes(String(ghost)), false, 'the ghost reservation was released');
    assert.equal(l.reservations.length, 1, 'the running generation keeps its reservation');
    assert.equal(l.committedPosts, 0, 'a ghost commits nothing');
  });

  test('Q13: deleting a project removes its own monthly counters and keeps the account\'s ledger (the account still used that allowance)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await start(scriptedProvider(), { postsPerWeek: 2 }, { background: false });
    const used = (await userLedger()).committedPosts;
    assert.ok(used > 0);
    await SeoProject.updateOne({ _id: project._id }, { $set: { is_deleted: true } });
    await deleteProjectCascade(pid);
    assert.equal(await projectLedger(), null);
    assert.equal((await userLedger()).committedPosts, used);
  });

  test('Q14: HTTP: a refusal is 429 QUOTA_EXCEEDED with the numbers and the reset date, in generate AND preview; preview and the calendar read carry this month\'s usage', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const fakeRes = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
    const call = async (handler, body) => { const res = fakeRes(); await handler({ projectId: pid, userId, body: { projectId: pid, ...body } }, res); return res; };
    setCalendarProviderOverride(scriptedProvider());

    const tooBig = await call(generateContentCalendarHandler, { ...request({ months: 3, postsPerWeek: 3 }) });
    assert.equal(tooBig.code, 429);
    assert.equal(tooBig.body.details.code, 'QUOTA_EXCEEDED');
    assert.equal(tooBig.body.details.limit, 30);
    assert.ok(tooBig.body.details.resetsAt);
    const previewBig = await call(previewContentCalendarHandler, { ...request({ months: 3, postsPerWeek: 3 }) });
    assert.equal(previewBig.code, 429, 'the form is told before the click');
    assert.equal(previewBig.body.details.code, 'QUOTA_EXCEEDED');

    const fine = await call(previewContentCalendarHandler, { ...request({ months: 1, postsPerWeek: 2 }) });
    assert.equal(fine.code, 200);
    assert.deepEqual([fine.body.data.quota.project.limit, fine.body.data.quota.project.remaining], [30, 30]);
    assert.equal((await previewCalendar(request({ months: 1, postsPerWeek: 2 }), { userId, projectId: pid })).preview.quota.user.limit, 40);

    const state = await call(getContentCalendarHandler, {});
    assert.equal(state.code, 200);
    assert.equal(state.body.data.quota.user.limit, 40);
    assert.equal(state.body.data.quota.maxInFlight, 50);
    assert.ok(!JSON.stringify(state.body).includes('reservations'), 'no ledger internals are exposed');
    assert.doesNotMatch(JSON.stringify(state.body), /estimatedCostUsd|inputTokens|outputTokens|aiCalls|"usage"|"source"|"planId"/, 'no cost, token or plan-source data reaches the client');
    assert.doesNotMatch(JSON.stringify(fine.body), /estimatedCostUsd|inputTokens|outputTokens|aiCalls|"usage"|"source"/, 'nor in the preview');
  });

  test('Q15: a double click is still "already running" (one reservation, one calendar), never an error and never a second reservation', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const g = deferred(); gates.push(g);
    setCalendarProviderOverride(scriptedProvider(async () => { await g.promise; return null; }));
    const results = await Promise.all(Array.from({ length: 6 }, () => startCalendarGeneration(pid, userId, request({ postsPerWeek: 2 }))));
    assert.equal(results.filter((r) => r.success && r.started).length, 1);
    assert.equal(results.filter((r) => r.success && r.alreadyRunning).length, 5);
    assert.equal((await userLedger()).reservations.length, 1);
    assert.equal(await SocialContentCalendar.countDocuments({ project_id: project._id }), 1);
  });
});
