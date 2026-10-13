import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();
for (const name of ['SOCIAL_AI_CALENDAR_QUOTA_USER_POSTS_PER_MONTH', 'SOCIAL_AI_CALENDAR_QUOTA_PROJECT_POSTS_PER_MONTH', 'SOCIAL_AI_STARTER_CALENDAR_POSTS_PER_MONTH']) delete process.env[name];
process.env.SOCIAL_AI_CALENDAR_QUOTA_MAX_IN_FLIGHT_PER_USER = '50';

const { default: SeoProject } = await import('../../../app_user/model/SeoProject.js');
const { default: SocialAccount } = await import('../../model/SocialAccount.js');
const { default: SocialAIStrategy } = await import('../../model/SocialAIStrategy.js');
const { default: SocialBusinessProfile } = await import('../../model/SocialBusinessProfile.js');
const { default: SocialContentCalendar } = await import('../../model/SocialContentCalendar.js');
const { default: SocialContentCalendarItem } = await import('../../model/SocialContentCalendarItem.js');
const { default: SocialAIUsage } = await import('../../model/SocialAIUsage.js');
const { default: User } = await import('../../../user/model/User.js');
const { updateProfile } = await import('../socialBusinessProfileService.js');
const strategySvc = await import('./socialAIStrategyService.js');
const { startGeneration, getStrategyState, setProviderOverride, resetProviderOverride } = strategySvc;
const { validateStrategyPlanning, splitAcross, toApiPlanning } = await import('./strategyPlanning.js');
const { previewCalendarPlan } = await import('../calendar/calendarPlanner.js');
const { buildUserPrompt, buildSystemPrompt } = await import('./socialAIStrategyPromptBuilder.js');
const { startCalendarGeneration, getCalendarState, previewCalendar, setCalendarProviderOverride, resetCalendarProviderOverride } = await import('../calendar/socialContentCalendarService.js');
const { generateAIStrategyHandler, previewStrategyPlanHandler, getAIStrategyHandler } = await import('../../controller/socialAIStrategyController.js');
const { validRawStrategy, mockProvider, validRawCalendarBatch, parseSlotsFromPrompt } = await import('../../testSupport/aiStrategyFixtures.js');

/**
 * The strategy wizard's server side: the planning choice (posts per week, months, platforms) is validated by the calendar planner, stored with
 * the strategy version, sent to the prompt, enforced on the saved strategy, and becomes the default of the first calendar.
 * Pure parts first; then a real MongoDB with scripted AI.
 */

const addDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHOICE = { postsPerWeek: 3, months: 3, platforms: ['facebook'] };
/** A strategy that covers exactly the platforms the person chose (the platform rule refuses anything else). */
const strategyFor = (platforms, over = {}) => { const s = validRawStrategy(); s.platformStrategy = s.platformStrategy.filter((p) => platforms.includes(p.platform)); return Object.assign(s, over); };
const fbProvider = (options = {}) => mockProvider({ behavior: () => strategyFor(['facebook']), ...options });

describe('validateStrategyPlanning (pure: the planner is the authority)', () => {
  test('1: a supported choice gives the planner\'s exact count - the same number previewCalendarPlan gives for a calendar starting tomorrow', () => {
    const today = '2026-10-13';
    const r = validateStrategyPlanning(CHOICE, { today });
    assert.deepEqual([r.value.postsPerWeek, r.value.months, r.value.platforms], [3, 3, ['facebook']]);
    const direct = previewCalendarPlan({ startDate: '2026-10-14', months: 3, postsPerWeek: 3, platforms: ['facebook'], distributionMode: 'balanced' }, { today });
    assert.equal(r.value.estimatedPosts, direct.value.totalPosts, 'not recomputed here');
    assert.deepEqual([r.value.basisStartDate, r.value.basisEndDate], ['2026-10-14', direct.value.endDate]);
  });

  test('2: every frequency 1-7 and every duration 1-6 is accepted, and more weeks never mean fewer posts', () => {
    let last = 0;
    for (let months = 1; months <= 6; months += 1) {
      const n = validateStrategyPlanning({ ...CHOICE, months }).value.estimatedPosts;
      assert.ok(n > last, `${months} months`);
      last = n;
    }
    for (let ppw = 1; ppw <= 7; ppw += 1) assert.ok(validateStrategyPlanning({ ...CHOICE, postsPerWeek: ppw }).value);
  });

  test('3: unsupported or malformed values are refused with stable codes', () => {
    const code = (over) => validateStrategyPlanning({ ...CHOICE, ...over }).error?.code;
    assert.equal(code({ postsPerWeek: 0 }), 'INVALID_POSTS_PER_WEEK');
    assert.equal(code({ postsPerWeek: 8 }), 'INVALID_POSTS_PER_WEEK');
    assert.equal(code({ postsPerWeek: 2.5 }), 'INVALID_POSTS_PER_WEEK');
    assert.equal(code({ postsPerWeek: '3' }), 'INVALID_POSTS_PER_WEEK');
    assert.equal(code({ postsPerWeek: null }), 'INVALID_POSTS_PER_WEEK');
    assert.equal(code({ months: 0 }), 'INVALID_DURATION');
    assert.equal(code({ months: 7 }), 'INVALID_DURATION');
    assert.equal(code({ months: '3' }), 'INVALID_DURATION');
    assert.equal(code({ months: 1.5 }), 'INVALID_DURATION');
    assert.equal(code({ platforms: [] }), 'INVALID_PLATFORMS');
    assert.equal(code({ platforms: ['tiktok'] }), 'INVALID_PLATFORMS');
    assert.equal(code({ platforms: ['facebook', 'facebook'] }), 'INVALID_PLATFORMS');
    assert.equal(code({ platforms: 'facebook' }), 'INVALID_PLATFORMS');
    assert.equal(code({ estimatedPosts: 5 }), 'UNKNOWN_FIELD', 'a client-supplied count is never read');
    assert.equal(code({ startDate: '2026-10-14' }), 'UNKNOWN_FIELD');
    for (const bad of [null, [], 'x', 5]) assert.equal(validateStrategyPlanning(bad).error.code, 'INVALID_BODY');
    for (const missing of ['months', 'postsPerWeek', 'platforms']) {
      const { [missing]: _drop, ...rest } = CHOICE;
      assert.ok(validateStrategyPlanning(rest).error, missing);
    }
  });

  test('4: platforms come back in canonical order, whatever order was sent', () => {
    assert.deepEqual(validateStrategyPlanning({ ...CHOICE, platforms: ['instagram', 'facebook'] }).value.platforms, ['facebook', 'instagram']);
  });

  test('5: splitAcross always adds up to the total, with whole numbers', () => {
    for (const [weights, total] of [[[3, 1], 5], [[0, 0], 3], [[1], 7], [[2, 2, 2], 7], [[5, 0, 1], 1], [[], 0]]) {
      const out = splitAcross(weights, total);
      assert.equal(out.reduce((s, n) => s + n, 0), weights.length ? total : 0);
      assert.ok(out.every((n) => Number.isInteger(n) && n >= 0));
    }
    assert.deepEqual(splitAcross([3, 1], 4), [3, 1]);
  });

  test('6: toApiPlanning is null for a strategy saved before the wizard and for garbage, never throws', () => {
    for (const v of [null, undefined, {}, { postsPerWeek: 'x' }, { postsPerWeek: 3 }]) assert.equal(toApiPlanning(v), null);
    assert.deepEqual(toApiPlanning({ postsPerWeek: 3, months: 3, platforms: ['facebook', 'tiktok'], estimatedPosts: 39 }), { postsPerWeek: 3, months: 3, platforms: ['facebook'], estimatedPosts: 39, confirmedAt: null });
  });
});

describe('the strategy prompt receives the choice', () => {
  const data = { business: { name: 'Acme', description: 'Dentist', category: 'Dentist', location: {} }, audience: { primary: 'Families', secondary: [] }, toneOfVoice: { primary: 'Warm', secondary: [] }, goals: [], uniqueSellingPoints: [], offers: [], competitors: [], prohibitedPhrases: [], brand: {}, connectedPlatforms: { facebook: true, instagram: false } };

  test('7: with a choice the user message carries posts_per_week, months, planned_posts and platforms; without one there is no such block', () => {
    const planning = { postsPerWeek: 5, months: 6, totalPosts: 130, platforms: ['facebook', 'instagram'] };
    const user = buildUserPrompt({ snapshotData: data, planning });
    assert.match(user, /<planning_choice>[\s\S]*posts_per_week: 5[\s\S]*months: 6[\s\S]*planned_posts: 130[\s\S]*platforms: facebook, instagram[\s\S]*<\/planning_choice>/);
    assert.doesNotMatch(buildUserPrompt({ snapshotData: data }), /planning_choice/);
  });

  test('8: the fixed system prompt makes the choice binding and asks for the period outlook', () => {
    const system = buildSystemPrompt();
    assert.match(system, /posts_per_week and months are the person's DECISION/);
    assert.match(system, /Never suggest a different frequency or duration/);
    assert.match(system, /planOutlook/);
    assert.match(system, /never invent calendar dates/);
  });
});

let mongoAvailable = false;
before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
    await Promise.all([SocialContentCalendar.init(), SocialContentCalendarItem.init(), SocialAIStrategy.init(), SocialAIUsage.init()]);
  } catch { mongoAvailable = false; }
});
after(async () => {
  resetProviderOverride();
  resetCalendarProviderOverride();
  if (mongoAvailable) await mongoose.connection.close();
});

describe('strategy planning (real MongoDB, scripted AI)', () => {
  let userId; let project; let pid; let created;
  const track = (d) => { created.push(d); return d; };
  const fakeRes = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
  const call = async (handler, body) => { const res = fakeRes(); await handler({ projectId: pid, userId, body: { projectId: pid, ...body } }, res); return res; };
  const gen = (provider, options = {}) => { setProviderOverride(provider); return startGeneration(pid, userId, { background: false, ...options }); };
  const versions = () => SocialAIStrategy.find({ project_id: project._id }).sort({ version: 1 }).lean();
  const promptOf = (provider, n = 0) => provider.calls[n].user;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    created = [];
    userId = new mongoose.Types.ObjectId();
    await User.collection.insertOne({ _id: userId, email: `planning-${userId}@example.com`, subscription: { plan: 'starter', status: 'active' } });
    project = track(await SeoProject.create({ user_id: userId, project_name: `Planning ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'], description: 'Family dental practice', industry: 'Dentist' }));
    pid = String(project._id);
    await updateProfile(pid, userId, { audience: { primary: 'Young families' }, goals: ['More bookings'], toneOfVoice: { primary: 'Warm' } });
    track(await SocialAccount.create({ user_id: userId, project_id: project._id, platform: 'facebook', platformAccountId: `pg_${pid}`, platformAccountName: 'Page', accountType: 'page', pageId: `pg_${pid}`, accessToken: 'FB-SECRET-TOKEN', status: 'active', isActive: true }));
  });

  afterEach(async () => {
    resetProviderOverride(); resetCalendarProviderOverride();
    if (!mongoAvailable) return;
    await Promise.all([
      SocialContentCalendarItem.deleteMany({ project_id: project._id }), SocialContentCalendar.deleteMany({ project_id: project._id }),
      SocialAIStrategy.deleteMany({ project_id: project._id }), SocialBusinessProfile.deleteMany({ project_id: project._id }),
      SocialAccount.deleteMany({ project_id: project._id }), SocialAIUsage.deleteMany({ $or: [{ scope: 'user', scope_id: userId }, { scope: 'project', scope_id: project._id }] }),
      User.deleteMany({ _id: userId }),
    ]);
    await SeoProject.deleteMany({ _id: project._id });
  });

  test('P1: the choice is stored with the version, the prompt carries the planner\'s numbers, and it survives a reload (GET)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const provider = fbProvider();
    const r = await gen(provider, { planning: CHOICE });
    assert.equal(r.generation.status, 'ready', JSON.stringify(r));
    const expected = validateStrategyPlanning(CHOICE).value.estimatedPosts;
    const prompt = promptOf(provider);
    assert.match(prompt, new RegExp(`posts_per_week: 3[\\s\\S]*months: 3[\\s\\S]*planned_posts: ${expected}[\\s\\S]*platforms: facebook`));
    const doc = (await versions())[0];
    assert.deepEqual([doc.planning.postsPerWeek, doc.planning.months, doc.planning.platforms, doc.planning.estimatedPosts], [3, 3, ['facebook'], expected]);
    assert.ok(doc.planning.confirmedAt);
    const reloaded = await call(getAIStrategyHandler, {});
    assert.deepEqual(reloaded.body.data.strategy.planning, { postsPerWeek: 3, months: 3, platforms: ['facebook'], estimatedPosts: expected, confirmedAt: doc.planning.confirmedAt.toISOString() });
    assert.doesNotMatch(JSON.stringify(reloaded.body), /inputTokens|outputTokens|lockedBy|requestId/);
  });

  test('P2: the saved strategy states the CHOSEN frequency whatever the AI wrote, and the per-platform numbers add up to it', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const stray = strategyFor(['facebook', 'instagram']);
    stray.postingStrategy.postsPerWeek = 7;
    stray.postingStrategy.postsPerWeekRange = { min: 6, max: 7 };
    stray.platformStrategy = stray.platformStrategy.map((p) => ({ ...p, postsPerWeek: 6 }));
    await gen(mockProvider({ behavior: () => stray }), { planning: { postsPerWeek: 3, months: 1, platforms: ['facebook', 'instagram'] } });
    const saved = (await versions())[0].strategy;
    assert.equal(saved.postingStrategy.postsPerWeek, 3, 'the decision wins over the AI');
    assert.ok(saved.postingStrategy.postsPerWeekRange.min <= 3 && saved.postingStrategy.postsPerWeekRange.max >= 3);
    assert.equal(saved.platformStrategy.reduce((s, p) => s + p.postsPerWeek, 0), 3);
    assert.deepEqual(saved.platformStrategy.map((p) => p.platform).sort(), ['facebook', 'instagram']);
    assert.ok(saved.planOutlook.seasonalThemes.length > 0 && saved.planOutlook.successMetrics.length > 0, 'the period outlook is stored');
  });

  test('P3: the strategy must cover exactly the chosen platforms: a wrong answer is repaired with the reason, not saved', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const provider = mockProvider({ behavior: ({ callNumber }) => { const s = validRawStrategy(); if (callNumber === 2) s.platformStrategy = s.platformStrategy.filter((p) => p.platform === 'facebook'); return s; } });
    // call 1 covers facebook + instagram (the fixture); the person chose only facebook -> repaired on call 2 with facebook only
    const r = await gen(provider, { planning: { postsPerWeek: 3, months: 1, platforms: ['facebook'] } });
    assert.equal(r.generation.status, 'ready', JSON.stringify(r));
    assert.equal(provider.calls.length, 2);
    assert.match(provider.calls[1].user, /must cover exactly the platforms the business chose/);
    assert.deepEqual((await versions())[0].strategy.platformStrategy.map((p) => p.platform), ['facebook']);
  });

  test('P4: an AI failure keeps the choice: the failed attempt carries it, the last good strategy is untouched, and retrying with the same choice creates exactly one new ready version', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await gen(fbProvider(), { planning: CHOICE });
    const failing = mockProvider({ behavior: () => { throw Object.assign(new Error('x'), { code: 'CLAUDE_OVERLOADED' }); } });
    const fail = await gen(failing, { planning: { postsPerWeek: 5, months: 6, platforms: ['facebook'] } });
    assert.equal(fail.generation.status, 'failed');
    const state = await getStrategyState(pid);
    assert.equal(state.status, 'failed');
    assert.equal(state.strategy.version, 1, 'the last good strategy is unchanged');
    assert.equal(state.strategy.planning.postsPerWeek, 3);
    const failedDoc = (await versions()).find((v) => v.status === 'failed');
    assert.deepEqual([failedDoc.planning.postsPerWeek, failedDoc.planning.months], [5, 6], 'the selection is preserved on the attempt');
    const retry = await gen(fbProvider(), { planning: { postsPerWeek: 5, months: 6, platforms: ['facebook'] } });
    assert.equal(retry.generation.status, 'ready');
    assert.equal((await versions()).filter((v) => v.status === 'ready').length, 1, 'one current version, the earlier one archived');
    assert.equal((await getStrategyState(pid)).strategy.planning.months, 6);
  });

  test('P5: unsupported values are refused BEFORE anything is claimed or written, over HTTP with a stable code', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    setProviderOverride(fbProvider());
    const cases = [
      [{ planning: { ...CHOICE, postsPerWeek: 9 } }, 'INVALID_POSTS_PER_WEEK'], [{ planning: { ...CHOICE, months: 12 } }, 'INVALID_DURATION'],
      [{ planning: { ...CHOICE, platforms: ['tiktok'] } }, 'INVALID_PLATFORMS'], [{ planning: { ...CHOICE, estimatedPosts: 1 } }, 'UNKNOWN_FIELD'],
      [{ planning: 'lots' }, 'INVALID_BODY'], [{ bogus: 1 }, 'UNKNOWN_FIELD'], [{ requestId: 'x' }, 'INVALID_FIELD'], [{ expectedVersion: -1 }, 'INVALID_FIELD'],
    ];
    for (const [body, code] of cases) {
      const res = await call(generateAIStrategyHandler, body);
      assert.equal(res.code, 400, JSON.stringify(body));
      assert.equal(res.body.details.code, code, JSON.stringify(body));
    }
    assert.equal(await SocialAIStrategy.countDocuments({ project_id: project._id }), 0, 'nothing was created');
    const ok = await call(generateAIStrategyHandler, { planning: CHOICE });
    assert.equal(ok.code, 202, JSON.stringify(ok.body));
  });

  test('P6: pressing Generate twice (or sending the same request twice) is one version: concurrent starts, and a repeated requestId', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    let release; const gate = new Promise((r) => { release = r; });
    const provider = fbProvider({ gate });
    setProviderOverride(provider);
    const rid = `req_${Date.now()}_abcd`;
    const results = await Promise.all(Array.from({ length: 5 }, () => startGeneration(pid, userId, { planning: CHOICE, requestId: rid, background: true })));
    assert.equal(results.filter((r) => r.started).length, 1, 'exactly one run');
    assert.ok(results.filter((r) => !r.started).every((r) => r.alreadyRunning || r.alreadyDone));
    release();
    for (let i = 0; i < 100 && (await SocialAIStrategy.countDocuments({ project_id: project._id, status: 'generating' })); i += 1) await sleep(30);
    const again = await startGeneration(pid, userId, { planning: CHOICE, requestId: rid, background: false });
    assert.deepEqual([again.started, again.alreadyDone], [false, true], 'a lost response, sent again, is the same version');
    assert.equal((await versions()).length, 1);
    assert.equal(provider.calls.length, 1);
  });

  test('P7: a stale decision is refused: expectedVersion must be the current ready version (409 STRATEGY_CONFLICT with the current one) and nothing is written', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await gen(fbProvider(), { planning: CHOICE });
    setProviderOverride(fbProvider());
    const stale = await call(generateAIStrategyHandler, { planning: CHOICE, expectedVersion: 0 });
    assert.equal(stale.code, 409);
    assert.deepEqual([stale.body.details.code, stale.body.details.currentVersion], ['STRATEGY_CONFLICT', 1]);
    assert.equal((await versions()).length, 1);
    const fresh = await call(generateAIStrategyHandler, { planning: CHOICE, expectedVersion: 1 });
    assert.equal(fresh.code, 202, JSON.stringify(fresh.body));
  });

  test('P8: /plan-preview gives the planner\'s count, the platform states and the allowance fit, changes nothing and calls no AI', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const provider = mockProvider(); setProviderOverride(provider);
    const res = await call(previewStrategyPlanHandler, { postsPerWeek: 3, months: 3, platforms: ['facebook', 'instagram'] });
    assert.equal(res.code, 200, JSON.stringify(res.body));
    const d = res.body.data;
    assert.equal(d.estimatedPosts, validateStrategyPlanning({ postsPerWeek: 3, months: 3, platforms: ['facebook', 'instagram'] }).value.estimatedPosts);
    assert.deepEqual(d.platformStates, { facebook: 'connected', instagram: 'none' }, 'Instagram is not connected: said, not hidden');
    assert.equal(d.quotaCheck.fits, true);
    assert.doesNotMatch(JSON.stringify(res.body), /estimatedCostUsd|inputTokens|outputTokens|aiCalls|"source"|planId/);
    assert.equal(provider.calls.length, 0);
    assert.equal(await SocialAIStrategy.countDocuments({ project_id: project._id }), 0);
    assert.equal((await call(previewStrategyPlanHandler, { postsPerWeek: 3, months: 9, platforms: ['facebook'] })).body.details.code, 'INVALID_DURATION');
  });

  test('P9: the preview reports when the calendar would not fit the monthly allowance (and why), without refusing to preview', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    process.env.SOCIAL_AI_STARTER_CALENDAR_POSTS_PER_MONTH = '10';
    try {
      const res = await call(previewStrategyPlanHandler, CHOICE);
      assert.equal(res.code, 200);
      assert.deepEqual([res.body.data.quotaCheck.fits, res.body.data.quotaCheck.code], [false, 'QUOTA_EXCEEDED']);
      assert.equal(res.body.data.quota.user.limit, 10);
    } finally { delete process.env.SOCIAL_AI_STARTER_CALENDAR_POSTS_PER_MONTH; }
  });

  const calendarProvider = () => ({ calls: [], isAvailable: () => true, async generateCalendarPlan({ user }) { const slots = parseSlotsFromPrompt(user); return { parsed: validRawCalendarBatch(slots), usage: { inputTokens: 10, outputTokens: 20 }, model: 'mock', durationMs: 1, attempts: 1 }; } });

  test('P10: the first calendar INHERITS the strategy\'s choice when the request leaves it out; anything the request states wins; the strategy is never modified', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await gen(fbProvider(), { planning: { postsPerWeek: 2, months: 1, platforms: ['facebook'] } });
    const before = JSON.stringify((await versions())[0]);
    const state = await getCalendarState(pid, { userId });
    assert.deepEqual(state.strategy.planning, toApiPlanning((await versions())[0].planning));

    const preview = await previewCalendar({ startDate: addDays(1) }, { userId, projectId: pid });
    assert.equal(preview.success, true, JSON.stringify(preview));
    const exact = previewCalendarPlan({ startDate: addDays(1), months: 1, postsPerWeek: 2, platforms: ['facebook'] });
    assert.equal(preview.preview.totalPosts, exact.value.totalPosts, 'the planner counts the inherited values');

    setCalendarProviderOverride(calendarProvider());
    const run = await startCalendarGeneration(pid, userId, { startDate: addDays(1) }, { background: false });
    assert.equal(run.success, true, JSON.stringify(run));
    const cal = await SocialContentCalendar.findOne({ project_id: project._id }).lean();
    assert.deepEqual([cal.config.postsPerWeek, cal.config.months, cal.config.platforms, cal.status], [2, 1, ['facebook'], 'ready']);
    assert.equal(await SocialContentCalendarItem.countDocuments({ calendar_id: cal._id }), exact.value.totalPosts);

    // an explicit change wins, for THIS calendar only; the strategy keeps its choice
    const second = await startCalendarGeneration(pid, userId, { startDate: addDays(1), postsPerWeek: 4 }, { background: false });
    assert.equal(second.success, true, JSON.stringify(second));
    const cals = await SocialContentCalendar.find({ project_id: project._id }).sort({ version: 1 }).lean();
    assert.deepEqual(cals.map((c) => [c.config.postsPerWeek, c.config.months, c.status]), [[2, 1, 'archived'], [4, 1, 'ready']]);
    assert.equal(JSON.stringify((await versions())[0]), before, 'the strategy document is byte-for-byte unchanged');
  });

  test('P11: a strategy saved BEFORE the wizard (no planning) stays readable and a calendar request is validated exactly as before', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await gen(mockProvider());
    const doc = (await versions())[0];
    assert.equal(doc.planning ?? null, null);
    const state = await getStrategyState(pid);
    assert.equal(state.strategy.planning, null);
    assert.equal((await getCalendarState(pid, { userId })).strategy.planning, null);
    const r = await startCalendarGeneration(pid, userId, { startDate: addDays(1) }, { background: false });
    assert.equal(r.success, false);
    const { validateCalendarInput } = await import('../calendar/calendarPlanner.js');
    assert.equal(r.error.code, validateCalendarInput({ startDate: addDays(1) }).error.code, 'exactly the answer the planner always gave: nothing is invented for an old strategy');
    assert.equal(await SocialContentCalendar.countDocuments({ project_id: project._id }), 0);
  });

  test('P12: a new strategy version does not touch an existing calendar, its history or its edits', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await gen(fbProvider(), { planning: CHOICE });
    setCalendarProviderOverride(calendarProvider());
    await startCalendarGeneration(pid, userId, { startDate: addDays(1), months: 1 }, { background: false });
    const cal = await SocialContentCalendar.findOne({ project_id: project._id }).lean();
    const item = await SocialContentCalendarItem.findOne({ calendar_id: cal._id }).sort({ slot: 1 });
    await SocialContentCalendarItem.updateOne({ _id: item._id }, { $set: { caption: 'USER EDIT', status: 'plan_approved' }, $inc: { revision: 1 } });
    const itemsBefore = JSON.stringify(await SocialContentCalendarItem.find({ calendar_id: cal._id }).sort({ slot: 1 }).lean());
    const calBefore = JSON.stringify(await SocialContentCalendar.findById(cal._id).lean());

    await gen(fbProvider(), { planning: { postsPerWeek: 7, months: 6, platforms: ['facebook'] }, expectedVersion: 1 });
    assert.equal(JSON.stringify(await SocialContentCalendar.findById(cal._id).lean()), calBefore, 'the calendar (and its recorded config) is unchanged');
    assert.equal(JSON.stringify(await SocialContentCalendarItem.find({ calendar_id: cal._id }).sort({ slot: 1 }).lean()), itemsBefore, 'edits and approvals are unchanged');
    assert.deepEqual([cal.config.postsPerWeek, cal.config.months], [3, 1]);
    const state = await getCalendarState(pid, { userId });
    assert.equal(state.strategy.planning.postsPerWeek, 7, 'the NEXT calendar starts from the new choice');
    assert.equal(state.stale.strategyChanged, true, 'and the existing calendar is reported as built from an older strategy, not silently rewritten');
  });
});
