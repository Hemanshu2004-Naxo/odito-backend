import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

// A short lease and retry so recovery can be exercised in a test; read when the config module is first imported.
process.env.SOCIAL_AI_CALENDAR_LEASE_MS = '3000';
process.env.SOCIAL_AI_CALENDAR_HEARTBEAT_MS = '1000';
process.env.SOCIAL_AI_CALENDAR_RETRY_BACKOFF_MS = '60000';
process.env.SOCIAL_AI_CALENDAR_QUOTA_MAX_IN_FLIGHT_PER_USER = '50';
process.env.SOCIAL_AI_CALENDAR_QUOTA_RECONCILE_AFTER_MS = '1000';
for (const name of ['SOCIAL_AI_CALENDAR_QUOTA_USER_POSTS_PER_MONTH', 'SOCIAL_AI_STARTER_CALENDAR_POSTS_PER_MONTH']) delete process.env[name];

const { default: SeoProject } = await import('../modules/app_user/model/SeoProject.js');
const { default: SocialAccount } = await import('../modules/social_meta/model/SocialAccount.js');
const { default: SocialAIStrategy } = await import('../modules/social_meta/model/SocialAIStrategy.js');
const { default: SocialBusinessProfile } = await import('../modules/social_meta/model/SocialBusinessProfile.js');
const { default: SocialContentCalendar } = await import('../modules/social_meta/model/SocialContentCalendar.js');
const { default: SocialContentCalendarItem } = await import('../modules/social_meta/model/SocialContentCalendarItem.js');
const { default: SocialAIUsage } = await import('../modules/social_meta/model/SocialAIUsage.js');
const { default: User } = await import('../modules/user/model/User.js');
const { updateProfile } = await import('../modules/social_meta/service/socialBusinessProfileService.js');
const { startGeneration: startStrategy, setProviderOverride: setStrategyProvider, resetProviderOverride: resetStrategyProvider } = await import('../modules/social_meta/service/aiStrategy/socialAIStrategyService.js');
const { startCalendarGeneration, setCalendarProviderOverride, resetCalendarProviderOverride } = await import('../modules/social_meta/service/calendar/socialContentCalendarService.js');
const { recoverInterruptedCalendars } = await import('../modules/social_meta/service/calendar/calendarGenerationRunner.js');
const { runOnce: sweepOnce } = await import('../modules/social_meta/service/calendar/calendarRecoveryScheduler.js');
const quota = await import('../modules/social_meta/service/calendar/calendarQuotaService.js');
const { renderMetrics } = await import('./metrics.js');
const { refreshGauges } = await import('./socialAiMetrics.js');
const { validRawStrategy, mockProvider, validRawCalendarBatch, parseSlotsFromPrompt } = await import('../modules/social_meta/testSupport/aiStrategyFixtures.js');

/**
 * The operational metrics, driven by REAL generations (real MongoDB, scripted AI): every event an operator must be told about moves the
 * right series, gauges read the shared state, and the logs of one run share one runId. The counters are process-wide, so each test compares
 * before and after.
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
const providerError = (code) => Object.assign(new Error(`scripted ${code}`), { code });

/** The value of one series in the Prometheus text. */
const series = (text, name, label, value) => {
  const wanted = label ? `${name}{${label}="${value}"}` : name;
  const line = text.split('\n').find((l) => l.startsWith(`${wanted} `));
  if (!line) throw new Error(`series not found: ${wanted}`);
  return Number(line.slice(wanted.length + 1));
};
const scrape = async () => { await refreshGauges({ force: true }); return renderMetrics(); };

describe('Social AI operational metrics (real MongoDB, scripted providers)', () => {
  let userId; let project; let pid; let created; let captured; let originals;
  const track = (d) => { created.push(d); return d; };
  const request = (over = {}) => ({ startDate: addDays(1), months: 1, endDate: undefined, postsPerWeek: 2, platforms: ['facebook'], distributionMode: 'balanced', ...over });
  const start = (provider, over = {}, options = {}) => { setCalendarProviderOverride(provider); return startCalendarGeneration(pid, userId, request(over), options); };
  const latest = () => SocialContentCalendar.findOne({ project_id: project._id }).sort({ version: -1 }).lean();

  async function makeProject() {
    const p = track(await SeoProject.create({ user_id: userId, project_name: `Metrics ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'], description: 'Family dental practice', industry: 'Dentist' }));
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
    created = [];
    userId = new mongoose.Types.ObjectId();
    await User.collection.insertOne({ _id: userId, email: `metrics-${userId}@example.com`, subscription: { plan: 'starter', status: 'active' } });
    project = await makeProject();
    pid = String(project._id);
    // capture structured log lines of this test
    captured = [];
    originals = { log: console.log, warn: console.warn, error: console.error };
    for (const level of ['log', 'warn', 'error']) console[level] = (...args) => { const line = args.map(String).join(' '); try { captured.push(JSON.parse(line)); } catch { /* not a structured line */ } };
  });

  afterEach(async () => {
    if (originals) Object.assign(console, originals);
    resetCalendarProviderOverride();
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

  test('M1: a successful calendar moves "ready", the run-duration histogram, "reserved" and "settled" - and nothing that means trouble', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const before = await scrape();
    assert.equal((await start(scriptedProvider(), {}, { background: false })).success, true);
    const after = await scrape();
    const delta = (name, label, value) => series(after, name, label, value) - series(before, name, label, value);
    assert.equal(delta('odito_social_calendar_runs_total', 'outcome', 'ready'), 1);
    assert.equal(delta('odito_social_calendar_runs_total', 'outcome', 'failed'), 0);
    assert.equal(delta('odito_social_quota_events_total', 'event', 'reserved'), 1);
    assert.equal(delta('odito_social_quota_events_total', 'event', 'settled'), 1, 'one settlement per calendar, not per ledger');
    assert.equal(delta('odito_social_quota_events_total', 'event', 'settle_failed'), 0);
    assert.equal(series(after, 'odito_social_calendar_run_duration_seconds_count') - series(before, 'odito_social_calendar_run_duration_seconds_count'), 1);
  });

  test('M2: a permanent AI failure moves "failed" and the provider-error series by its Odito failure code (not the raw provider message)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const before = await scrape();
    await start(scriptedProvider(async () => { throw providerError('CLAUDE_AUTH'); }), {}, { background: false });
    assert.equal((await latest()).status, 'failed');
    const after = await scrape();
    assert.equal(series(after, 'odito_social_calendar_runs_total', 'outcome', 'failed') - series(before, 'odito_social_calendar_runs_total', 'outcome', 'failed'), 1);
    assert.equal(series(after, 'odito_social_calendar_provider_errors_total', 'code', 'AI_UNAVAILABLE') - series(before, 'odito_social_calendar_provider_errors_total', 'code', 'AI_UNAVAILABLE'), 1);
    assert.equal(series(after, 'odito_social_calendar_provider_errors_total', 'code', 'other') - series(before, 'odito_social_calendar_provider_errors_total', 'code', 'other'), 0);
    assert.doesNotMatch(after, /CLAUDE_AUTH|scripted/);
  });

  test('M3: a transient failure is a retry (retry_scheduled + the code), the calendar shows as retry_waiting, and once its lease is long gone it shows as OVERDUE until a takeover resumes it', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const before = await scrape();
    await start(scriptedProvider(async ({ n }) => { if (n === 1) throw providerError('CLAUDE_OVERLOADED'); return null; }), {}, { background: false });
    const waiting = await latest();
    assert.equal(waiting.status, 'generating', 'waiting out the retry');
    const mid = await scrape();
    assert.equal(series(mid, 'odito_social_calendar_runs_total', 'outcome', 'retry_scheduled') - series(before, 'odito_social_calendar_runs_total', 'outcome', 'retry_scheduled'), 1);
    assert.equal(series(mid, 'odito_social_calendar_provider_errors_total', 'code', 'AI_BUSY') - series(before, 'odito_social_calendar_provider_errors_total', 'code', 'AI_BUSY'), 1);
    assert.ok(series(mid, 'odito_social_calendar_generations', 'state', 'retry_waiting') >= 1);

    // the worker never comes back: the lease expired ten minutes ago and the sweep has not been running
    await SocialContentCalendar.updateOne({ _id: waiting._id }, { $set: { 'generation.lease.expiresAt': new Date(Date.now() - 10 * 60_000) } });
    const stuck = await scrape();
    assert.ok(series(stuck, 'odito_social_calendar_generations', 'state', 'overdue') >= 1, 'a stuck calendar is visible');

    setCalendarProviderOverride(scriptedProvider());
    const r = await recoverInterruptedCalendars({ projectId: pid, background: false });
    assert.equal(r.resumed, 1);
    assert.equal((await latest()).status, 'ready');
    const after = await scrape();
    assert.equal(series(after, 'odito_social_calendar_takeovers_total', 'result', 'resumed') - series(before, 'odito_social_calendar_takeovers_total', 'result', 'resumed'), 1);
    assert.equal(series(after, 'odito_social_calendar_runs_total', 'outcome', 'ready') - series(before, 'odito_social_calendar_runs_total', 'outcome', 'ready'), 1);
    assert.equal(series(after, 'odito_social_calendar_generations', 'state', 'overdue'), 0, 'nothing is stuck any more');
  });

  test('M4: a calendar that stops part-way is a "partial" run and a partial-calendars gauge, with its failure code', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const before = await scrape();
    await start(scriptedProvider(async ({ n }) => (n === 2 || n === 3 ? { items: [] } : null)), {}, { background: false });
    assert.equal((await latest()).status, 'partial');
    const after = await scrape();
    assert.equal(series(after, 'odito_social_calendar_runs_total', 'outcome', 'partial') - series(before, 'odito_social_calendar_runs_total', 'outcome', 'partial'), 1);
    assert.equal(series(after, 'odito_social_calendar_provider_errors_total', 'code', 'AI_BAD_OUTPUT') - series(before, 'odito_social_calendar_provider_errors_total', 'code', 'AI_BAD_OUTPUT'), 1);
    assert.ok(series(after, 'odito_social_calendar_partial') >= 1);
  });

  test('M5: allowance events: a refusal, a blocked configuration (production, nothing decided) and a stale-reservation release each move their own series; a leaked reservation shows in the gauge until the sweep releases it', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const before = await scrape();
    process.env.SOCIAL_AI_STARTER_CALENDAR_POSTS_PER_MONTH = '3';
    try {
      assert.equal((await start(scriptedProvider())).error.code, 'QUOTA_EXCEEDED');
    } finally { delete process.env.SOCIAL_AI_STARTER_CALENDAR_POSTS_PER_MONTH; }
    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      assert.equal((await start(scriptedProvider())).error.code, 'QUOTA_NOT_CONFIGURED');
    } finally { if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv; }

    // a reservation for a calendar that no longer exists, made 7 hours ago: a settlement that never happened
    const ghost = new mongoose.Types.ObjectId();
    await quota.reserveCalendarQuota({ userId, projectId: project._id, calendarId: ghost, posts: 5, now: new Date(Date.now() - 7 * 3600_000) });
    const leaked = await scrape();
    assert.ok(series(leaked, 'odito_social_quota_leaked_reservations') >= 1);

    const swept = await sweepOnce();
    assert.ok(swept.quota.settled >= 1);
    const after = await scrape();
    const delta = (event) => series(after, 'odito_social_quota_events_total', 'event', event) - series(before, 'odito_social_quota_events_total', 'event', event);
    assert.equal(delta('refused_quota'), 1);
    assert.equal(delta('blocked_config'), 1);
    assert.ok(delta('released_stale') >= 1);
    assert.equal(series(after, 'odito_social_quota_leaked_reservations'), 0, 'released');
    assert.ok(series(after, 'odito_social_calendar_recovery_sweeps_total', 'result', 'ok') - series(before, 'odito_social_calendar_recovery_sweeps_total', 'result', 'ok') >= 1);
    assert.ok(series(after, 'odito_social_calendar_recovery_last_ok_timestamp_seconds') > Date.now() / 1000 - 60, 'the sweep reports when it last worked');
  });

  test('M6: in production the gauge says how many plans have no usable allowance (their calendars are refused); outside production it is 0', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const nodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      assert.equal(series(await scrape(), 'odito_social_quota_plans_unconfigured'), 4, 'starter, pro, premium and the no-plan group');
      process.env.SOCIAL_AI_PRO_CALENDAR_POSTS_PER_MONTH = '100';
      assert.equal(series(await scrape(), 'odito_social_quota_plans_unconfigured'), 3);
      process.env.NODE_ENV = 'development';
      assert.equal(series(await scrape(), 'odito_social_quota_plans_unconfigured'), 0);
    } finally {
      delete process.env.SOCIAL_AI_PRO_CALENDAR_POSTS_PER_MONTH;
      if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv;
    }
  });

  test('M7: every log line of one run carries the same runId, a takeover logs a NEW runId for the same calendar, and no log line contains a token', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await start(scriptedProvider(async ({ n }) => { if (n === 1) throw providerError('CLAUDE_OVERLOADED'); return null; }), {}, { background: false });
    const waiting = await latest();
    const firstRunId = waiting.generation.lockedBy;
    const transient = captured.find((l) => /Transient failure/.test(l.message));
    assert.equal(transient.runId, firstRunId, 'the retry line carries the run that failed');

    await SocialContentCalendar.updateOne({ _id: waiting._id }, { $set: { 'generation.lease.expiresAt': new Date(Date.now() - 1000) } });
    setCalendarProviderOverride(scriptedProvider());
    await recoverInterruptedCalendars({ projectId: pid, background: false });
    const done = await latest();
    const secondRunId = done.generation.lockedBy;
    assert.notEqual(secondRunId, firstRunId);
    const takeover = captured.find((l) => /Taking over/.test(l.message));
    const ready = captured.find((l) => /Calendar ready/.test(l.message));
    assert.equal(takeover.runId, secondRunId);
    assert.equal(ready.runId, secondRunId, 'the takeover and its result are one run');
    assert.equal(takeover.calendarId, String(waiting._id));
    assert.equal(ready.calendarId, String(waiting._id), 'calendarId ties both runs together');
    assert.ok(!JSON.stringify(captured).includes('FB-SECRET-TOKEN'), 'no credential in any log line');
  });
});
