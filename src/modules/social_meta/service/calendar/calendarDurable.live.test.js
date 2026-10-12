import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../../app_user/model/SeoProject.js';
import SocialAccount from '../../model/SocialAccount.js';
import SocialAIStrategy from '../../model/SocialAIStrategy.js';
import SocialBusinessProfile from '../../model/SocialBusinessProfile.js';
import SocialContentCalendar from '../../model/SocialContentCalendar.js';
import SocialContentCalendarItem from '../../model/SocialContentCalendarItem.js';
import { deleteProjectCascade } from '../../../app_user/service/projectCascadeDeleteService.js';
import { updateProfile } from '../socialBusinessProfileService.js';
import { startGeneration as startStrategy, setProviderOverride as setStrategyProvider, resetProviderOverride as resetStrategyProvider } from '../aiStrategy/socialAIStrategyService.js';
import {
  startCalendarGeneration, resumeCalendar, cancelCalendar, getCalendarState, getCalendarGenerationStatus, recoverInterruptedCalendars,
  setCalendarProviderOverride, resetCalendarProviderOverride,
} from './socialContentCalendarService.js';
import { runOnce as sweepOnce } from './calendarRecoveryScheduler.js';
import { saveBatch, Semaphore } from './calendarGenerationRunner.js';
import { previewCalendarPlan } from './calendarPlanner.js';
import { CALENDAR_BATCH_SIZE, CALENDAR_MAX_RUN_ATTEMPTS } from './calendarConfig.js';
import { validRawStrategy, mockProvider, validRawCalendarBatch, parseSlotsFromPrompt } from '../../testSupport/aiStrategyFixtures.js';

/**
 * The DURABLE run, against a real MongoDB with scripted AI: batches are saved as they validate, a dead worker's generation is taken over
 * and continued, a stopped one is kept as a resumable partial calendar, nothing is generated or saved twice, and cancelling or deleting
 * the project stops the work. "Dying" is simulated the way it really looks to the database: the lease stops being renewed and expires.
 */

let mongoAvailable = false;
before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
    await Promise.all([SocialContentCalendar.init(), SocialContentCalendarItem.init(), SocialAIStrategy.init()]);
  } catch { mongoAvailable = false; }
});
after(async () => {
  resetCalendarProviderOverride();
  resetStrategyProvider();
  if (mongoAvailable) await mongoose.connection.close();
});

const addDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(15); }
  throw new Error('waitFor timed out');
};
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

/** A provider whose answer to every batch is decided by `script({ slots, n })`: return nothing for a valid batch, an object for a raw answer, or throw. */
function scriptedProvider(script = async () => null) {
  const calls = [];
  return {
    calls,
    isAvailable: () => true,
    async generateCalendarPlan({ user }) {
      const slots = parseSlotsFromPrompt(user);
      calls.push({ slots: slots.map((s) => s.index) });
      const out = await script({ slots, n: calls.length });
      return { parsed: out ?? validRawCalendarBatch(slots), usage: { inputTokens: 10, outputTokens: 20 }, model: 'mock-calendar-model', durationMs: 1, attempts: 1 };
    },
  };
}
const busy = () => Object.assign(new Error('upstream busy sk-secret'), { code: 'CLAUDE_OVERLOADED' });

describe('durable calendar generation (real MongoDB, scripted providers)', () => {
  let userId; let project; let pid; let created; let gates;
  const track = (d) => { created.push(d); return d; };
  const gate = () => { const g = deferred(); gates.push(g); return g; };

  // 3 posts a week for a month: ~14 posts, so 4 batches of 4 (the last of 2)
  const request = (over = {}) => ({ startDate: addDays(1), months: 1, endDate: undefined, postsPerWeek: 3, platforms: ['facebook'], distributionMode: 'balanced', ...over });
  const start = (provider, over = {}, options = {}) => { setCalendarProviderOverride(provider); return startCalendarGeneration(pid, userId, request(over), options); };
  const calendarDoc = () => SocialContentCalendar.findOne({ project_id: project._id }).sort({ version: -1 }).lean();
  const items = (filter = {}) => SocialContentCalendarItem.find({ project_id: project._id, ...filter }).sort({ slot: 1 }).lean();
  const itemCount = () => SocialContentCalendarItem.countDocuments({ project_id: project._id });
  const expire = (calendarId) => SocialContentCalendar.updateOne({ _id: calendarId }, { $set: { 'generation.lease.expiresAt': new Date(Date.now() - 1000) } });

  async function seedStrategy() {
    setStrategyProvider(mockProvider({ behavior: () => validRawStrategy() }));
    const r = await startStrategy(pid, userId, { background: false });
    resetStrategyProvider();
    assert.equal(r.generation.status, 'ready', JSON.stringify(r));
    return SocialAIStrategy.findOne({ project_id: project._id, status: 'ready' }).sort({ version: -1 }).lean();
  }

  beforeEach(async () => {
    if (!mongoAvailable) return;
    created = []; gates = [];
    userId = new mongoose.Types.ObjectId();
    project = track(await SeoProject.create({ user_id: userId, project_name: `Durable ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'], description: 'Family dental practice', industry: 'Dentist' }));
    pid = project._id.toString();
    await updateProfile(pid, userId, { audience: { primary: 'Young families' }, goals: ['More bookings'], toneOfVoice: { primary: 'Warm' } });
    track(await SocialAccount.create({ user_id: userId, project_id: project._id, platform: 'facebook', platformAccountId: `pg_${pid}`, platformAccountName: 'Page', accountType: 'page', pageId: `pg_${pid}`, accessToken: 'FB-SECRET-TOKEN', status: 'active', isActive: true }));
    await seedStrategy();
  });

  afterEach(async () => {
    for (const g of gates) g.resolve(); // let any held provider call finish, so no run lingers into the next test
    await sleep(60);
    resetCalendarProviderOverride();
    resetStrategyProvider();
    if (!mongoAvailable) return;
    const ids = created.map((d) => d.project_id || d._id);
    await Promise.all([
      SocialContentCalendarItem.deleteMany({ project_id: { $in: ids } }), SocialContentCalendar.deleteMany({ project_id: { $in: ids } }),
      SocialAIStrategy.deleteMany({ project_id: { $in: ids } }), SocialBusinessProfile.deleteMany({ project_id: { $in: ids } }),
      SocialAccount.deleteMany({ _id: { $in: created.map((d) => d._id) } }),
    ]);
    await SeoProject.deleteMany({ _id: { $in: created.map((d) => d._id) } });
  });

  // ── incremental persistence + progress ──────────────────────────────────
  test('D1: every batch is saved the moment it validates, and progress is reported while the run is still going', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const g = gate();
    const provider = scriptedProvider(async ({ n }) => { if (n === 2) await g.promise; return null; });
    const started = await start(provider);
    assert.equal(started.started, true);
    assert.equal(started.generation.progress.plannedPosts, 0);
    assert.ok(started.generation.progress.totalPosts >= 12 && started.generation.progress.totalPosts <= 14);

    await waitFor(async () => (await itemCount()) === CALENDAR_BATCH_SIZE);
    const mid = await getCalendarGenerationStatus(pid);
    assert.equal(mid.status, 'generating');
    assert.equal(mid.generation.progress.plannedPosts, CALENDAR_BATCH_SIZE, 'the first batch is already saved and counted');
    assert.equal(mid.generation.progress.completedBatches, 1);
    assert.equal((await getCalendarState(pid)).calendar, null, 'it is not shown as a finished calendar');

    g.resolve();
    await waitFor(async () => (await getCalendarGenerationStatus(pid)).status === 'ready');
    const doc = await calendarDoc();
    assert.equal(doc.plan.totalItems, doc.generation.progress.totalPosts);
    assert.equal(doc.generation.progress.plannedPosts, doc.plan.totalItems);
    assert.equal(doc.generation.progress.completedBatches, doc.generation.progress.totalBatches);
    assert.equal(doc.generation.lease.expiresAt, null, 'the lease is released');
  });

  test('D2: the lease is renewed while a run works (a live generation is never taken over)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const g = gate();
    const provider = scriptedProvider(async ({ n }) => { if (n === 2) await g.promise; return null; });
    await start(provider);
    await waitFor(async () => (await itemCount()) === CALENDAR_BATCH_SIZE);
    const doc = await calendarDoc();
    assert.ok(doc.generation.lease.expiresAt > new Date(), 'the lease is in the future');
    assert.equal((await recoverInterruptedCalendars({ projectId: pid, background: false })).resumed, 0);
    assert.equal((await calendarDoc()).generation.lockedBy, doc.generation.lockedBy);
  });

  // ── a worker dies ───────────────────────────────────────────────────────
  test('D3: a worker that dies mid-run: another instance takes the generation over and continues from the SAVED batches; nothing is regenerated or duplicated', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const g = gate();
    const first = scriptedProvider(async ({ n }) => { if (n === 2) await g.promise; return null; });
    await start(first);
    await waitFor(async () => (await itemCount()) === CALENDAR_BATCH_SIZE);
    const savedBefore = await items();
    const dead = await calendarDoc();
    await expire(dead._id); // the process "dies": the lease is no longer renewed and runs out

    const second = scriptedProvider();
    setCalendarProviderOverride(second);
    const recovered = await recoverInterruptedCalendars({ projectId: pid, background: false });
    assert.equal(recovered.resumed, 1);

    const doc = await calendarDoc();
    assert.equal(doc.status, 'ready');
    assert.equal(doc.generation.runAttempts, 2, 'a take-over is a second run');
    assert.notEqual(doc.generation.lockedBy, dead.generation.lockedBy);
    const requested = second.calls.flatMap((c) => c.slots);
    for (const s of savedBefore.map((i) => i.slot)) assert.ok(!requested.includes(s), `slot ${s} was already saved, so it is not asked for again`);
    assert.equal(new Set(requested).size, requested.length);
    const all = await items();
    assert.equal(all.length, doc.generation.progress.totalPosts);
    assert.equal(new Set(all.map((i) => i.slot)).size, all.length, 'one item per slot');
    assert.deepEqual(all.slice(0, savedBefore.length).map((i) => String(i._id)), savedBefore.map((i) => String(i._id)), 'the saved posts are untouched');

    // the dead worker wakes up later: it finds it no longer owns the generation and changes nothing
    g.resolve();
    await sleep(300);
    assert.equal(await itemCount(), all.length);
    assert.equal((await calendarDoc()).status, 'ready');
    assert.equal(first.calls.length, 2, 'the old worker made no further call');
  });

  test('D4: a crash AFTER a batch was saved but BEFORE its progress was recorded loses nothing and double-saves nothing', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const g = gate();
    await start(scriptedProvider(async ({ n }) => { if (n === 3) await g.promise; return null; }));
    await waitFor(async () => (await itemCount()) === CALENDAR_BATCH_SIZE * 2);
    const doc = await calendarDoc();
    // as if the process died between writing batch 2 and updating the counters
    await SocialContentCalendar.updateOne({ _id: doc._id }, { $set: { 'generation.progress.completedBatches': 1, 'generation.progress.plannedPosts': CALENDAR_BATCH_SIZE, 'generation.lease.expiresAt': new Date(Date.now() - 1000) } });
    const second = scriptedProvider();
    setCalendarProviderOverride(second);
    await recoverInterruptedCalendars({ projectId: pid, background: false });
    const requested = second.calls.flatMap((c) => c.slots);
    assert.ok(requested.every((s) => s >= CALENDAR_BATCH_SIZE * 2), 'only what was really missing is asked for');
    const final = await calendarDoc();
    assert.equal(final.status, 'ready');
    assert.equal((await items()).length, final.generation.progress.totalPosts);
  });

  test('D5: saving a batch is idempotent: the same slots again insert nothing and overwrite nothing', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await start(scriptedProvider(), {}, { background: false });
    const doc = await calendarDoc();
    const strategyDoc = await SocialAIStrategy.findOne({ project_id: project._id, status: 'ready' }).lean();
    const before = await items();
    const replay = before.slice(0, 3).map((i) => ({
      ...i, serviceId: null, productId: null, selectedMediaIds: [], topic: 'A DIFFERENT TOPIC THAT MUST NOT WIN', caption: 'different caption', hashtags: [], platformContent: [],
    }));
    await saveBatch(replay, doc, strategyDoc);
    await saveBatch(replay, doc, strategyDoc);
    const after = await items();
    assert.equal(after.length, before.length, 'no duplicate item');
    assert.deepEqual(after.map((i) => i.topic), before.map((i) => i.topic), 'nothing was overwritten');
    // and the database itself refuses a second item for a slot
    await assert.rejects(() => SocialContentCalendarItem.collection.insertOne({ ...before[0], _id: new mongoose.Types.ObjectId() }), /E11000|duplicate key/);
  });

  // ── stopping: transient, permanent, partial, resume ─────────────────────
  test('D6: a transient failure keeps the saved batches and the run continues by itself when the retry time comes', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const provider = scriptedProvider(async ({ n }) => { if (n === 2) throw busy(); return null; });
    const r = await start(provider, {}, { background: false });
    assert.equal(r.generation.status, 'generating', 'waiting, not failed');
    assert.equal(r.generation.retry.code, 'AI_BUSY');
    assert.equal(await itemCount(), CALENDAR_BATCH_SIZE, 'the first batch is kept');
    const doc = await calendarDoc();
    assert.ok(doc.generation.lease.expiresAt > new Date(Date.now() + 30_000), 'the retry is a while away (backoff), not immediate');
    assert.equal((await recoverInterruptedCalendars({ projectId: pid, background: false })).resumed, 0, 'not before its time');
    assert.equal(JSON.stringify(doc).includes('sk-secret'), false);

    await expire(doc._id); // the retry time arrives
    const healthy = scriptedProvider();
    setCalendarProviderOverride(healthy);
    await recoverInterruptedCalendars({ projectId: pid, background: false });
    const done = await calendarDoc();
    assert.equal(done.status, 'ready');
    assert.equal(done.generation.runAttempts, 2);
    assert.ok(healthy.calls.flatMap((c) => c.slots).every((s) => s >= CALENDAR_BATCH_SIZE));
  });

  test('D7: transient failures are retried only a bounded number of times; then the calendar is PARTIAL and the person decides', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const provider = scriptedProvider(async ({ n }) => { if (n >= 2) throw busy(); return null; });
    await start(provider, {}, { background: false });
    for (let attempt = 1; attempt < CALENDAR_MAX_RUN_ATTEMPTS; attempt += 1) {
      const doc = await calendarDoc();
      assert.equal(doc.status, 'generating', `run ${attempt} is waiting to retry`);
      await expire(doc._id);
      setCalendarProviderOverride(provider);
      await recoverInterruptedCalendars({ projectId: pid, background: false });
    }
    const last = await calendarDoc();
    assert.equal(last.status, 'partial');
    assert.equal(last.generation.runAttempts, CALENDAR_MAX_RUN_ATTEMPTS);
    assert.equal(last.failure.code, 'AI_BUSY');
    assert.equal(await itemCount(), CALENDAR_BATCH_SIZE, 'the saved batch survives all of it');
    // no further automatic attempt
    assert.equal((await recoverInterruptedCalendars({ projectId: pid, background: false })).resumed, 0);
  });

  test('D8: resuming a PARTIAL calendar generates only the missing posts; the saved ones are untouched; it ends READY and replaces the previous calendar', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await start(scriptedProvider(), {}, { background: false }); // calendar v1 (ready)
    const v1 = await calendarDoc();
    assert.equal(v1.status, 'ready');

    const failing = scriptedProvider(async ({ n }) => (n >= 2 ? { items: [] } : null)); // batch 1 fine, batch 2 refused twice (validation: the answer and its one repair)
    const r = await start(failing, { postsPerWeek: 2 }, { background: false });
    assert.equal(r.generation.status, 'partial');
    assert.equal(r.generation.version, 2);
    const partialItems = await items({ calendar_id: r.generation.id });
    assert.equal(partialItems.length, CALENDAR_BATCH_SIZE);
    const state = await getCalendarState(pid);
    assert.equal(state.calendar.version, 1, 'the last good calendar is still the current one');
    assert.equal(state.partial.items.length, CALENDAR_BATCH_SIZE);
    assert.equal(state.generation.canResume, true);

    const healthy = scriptedProvider();
    setCalendarProviderOverride(healthy);
    const resumed = await resumeCalendar(pid, { background: false });
    assert.equal(resumed.success, true);
    assert.equal(resumed.alreadyRunning, false);
    const doc = await calendarDoc();
    assert.equal(doc.status, 'ready');
    assert.equal(doc.version, 2);
    assert.equal(healthy.calls.flatMap((c) => c.slots).filter((s) => s < CALENDAR_BATCH_SIZE).length, 0, 'the saved posts were not generated again');
    const all = await items({ calendar_id: doc._id });
    assert.equal(all.length, doc.generation.progress.totalPosts);
    assert.deepEqual(all.slice(0, CALENDAR_BATCH_SIZE).map((i) => String(i._id)), partialItems.map((i) => String(i._id)));
    assert.equal((await SocialContentCalendar.findById(v1._id).lean()).status, 'archived');
    assert.equal(doc.failure.code, null, 'the old failure is cleared');
  });

  test('D9: resume refuses when there is nothing to resume, reports a run that is already going, and starting afresh replaces a partial one', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    assert.equal((await resumeCalendar(pid)).error.code, 'NOTHING_TO_RESUME');
    assert.equal((await cancelCalendar(pid)).error.code, 'NOTHING_TO_CANCEL');

    await start(scriptedProvider(async ({ n }) => (n >= 2 ? { items: [] } : null)), {}, { background: false });
    const partial = await calendarDoc();
    assert.equal(partial.status, 'partial');
    // a brand new request replaces the unfinished calendar (and only that)
    const fresh = await start(scriptedProvider(), { postsPerWeek: 2 }, { background: false });
    assert.equal(fresh.generation.status, 'ready');
    assert.equal((await SocialContentCalendar.findById(partial._id).lean()).status, 'cancelled');
    assert.equal(await SocialContentCalendarItem.countDocuments({ calendar_id: partial._id }), 0, 'its saved posts are discarded');

    const g = gate();
    setCalendarProviderOverride(scriptedProvider(async () => { await g.promise; return null; }));
    await startCalendarGeneration(pid, userId, request());
    const again = await resumeCalendar(pid);
    assert.equal(again.alreadyRunning, true);
  });

  // ── cancel / pause / delete ─────────────────────────────────────────────
  test('D10: cancelling stops the run, discards its posts, and leaves the last good calendar alone', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await start(scriptedProvider(), {}, { background: false });
    const good = await calendarDoc();
    const goodCount = await SocialContentCalendarItem.countDocuments({ calendar_id: good._id });

    const g = gate();
    const provider = scriptedProvider(async ({ n }) => { if (n === 2) await g.promise; return null; });
    await start(provider, { postsPerWeek: 2 });
    await waitFor(async () => (await SocialContentCalendarItem.countDocuments({ calendar_id: { $ne: good._id } })) === CALENDAR_BATCH_SIZE);
    const cancelled = await cancelCalendar(pid);
    assert.equal(cancelled.success, true);
    assert.equal(cancelled.generation.status, 'cancelled');
    assert.equal(await SocialContentCalendarItem.countDocuments({ calendar_id: { $ne: good._id } }), 0);

    g.resolve(); // the worker finishes its call, finds it no longer owns the generation and stops
    await sleep(300);
    assert.equal(await SocialContentCalendarItem.countDocuments({ calendar_id: { $ne: good._id } }), 0, 'nothing is written after the cancel');
    assert.equal(provider.calls.length, 2, 'no further batch was dispatched');
    const state = await getCalendarState(pid);
    assert.equal(state.status, 'ready');
    assert.equal(state.calendar.version, 1);
    assert.equal(state.items.length, goodCount);
    assert.equal(state.generation, null, 'a cancelled attempt is not shown as a failure');
  });

  test('D11: deleting the project stops the run: no further batch, no item left behind', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const g = gate();
    const provider = scriptedProvider(async ({ n }) => { if (n === 2) await g.promise; return null; });
    await start(provider);
    await waitFor(async () => (await itemCount()) === CALENDAR_BATCH_SIZE);
    const summary = await deleteProjectCascade(pid);
    assert.equal(summary.failures.length, 0);
    assert.equal(await SocialContentCalendar.countDocuments({ project_id: project._id }), 0);
    g.resolve();
    await sleep(300);
    assert.equal(await itemCount(), 0, 'the worker wrote nothing after the project was gone');
    assert.equal(provider.calls.length, 2);
  });

  test('D12: a project in the trash PAUSES its generation (no batch is saved or dispatched) and a restore continues it', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const g = gate();
    const provider = scriptedProvider(async ({ n }) => { if (n === 2) await g.promise; return null; });
    await start(provider);
    await waitFor(async () => (await itemCount()) === CALENDAR_BATCH_SIZE);
    await SeoProject.updateOne({ _id: project._id }, { $set: { is_deleted: true } });
    g.resolve();
    await waitFor(async () => (await calendarDoc()).generation.lease.expiresAt < new Date());
    assert.equal((await calendarDoc()).status, 'generating', 'paused, not failed');
    assert.equal(await itemCount(), CALENDAR_BATCH_SIZE, 'the batch that finished while trashed was not saved');
    assert.equal((await calendarDoc()).generation.runAttempts, 0, 'a pause gives its attempt back: it is not a failure');

    const healthy = scriptedProvider();
    setCalendarProviderOverride(healthy);
    assert.equal((await recoverInterruptedCalendars({ projectId: pid, background: false })).resumed, 0, 'not while trashed');
    assert.equal((await sweepOnce()).resumed, 0, 'nor by the sweep');
    assert.equal(healthy.calls.length, 0);

    await SeoProject.updateOne({ _id: project._id }, { $set: { is_deleted: false } }); // restored
    assert.equal((await recoverInterruptedCalendars({ projectId: pid, background: false })).resumed, 1);
    assert.equal((await calendarDoc()).status, 'ready');
    assert.equal((await calendarDoc()).generation.runAttempts, 1, 'the continuation is the first run that counts');
  });

  // ── coordination ────────────────────────────────────────────────────────
  test('D13: several instances recovering at once: exactly ONE takes the generation over', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const g = gate();
    await start(scriptedProvider(async ({ n }) => { if (n === 2) await g.promise; return null; }));
    await waitFor(async () => (await itemCount()) === CALENDAR_BATCH_SIZE);
    await expire((await calendarDoc())._id);
    const healthy = scriptedProvider();
    setCalendarProviderOverride(healthy);
    const results = await Promise.all(Array.from({ length: 5 }, () => recoverInterruptedCalendars({ projectId: pid, background: false })));
    assert.equal(results.reduce((n, r) => n + r.resumed, 0), 1, 'one winner');
    const all = await items();
    assert.equal(new Set(all.map((i) => i.slot)).size, all.length);
    assert.equal((await calendarDoc()).generation.runAttempts, 2);
    const slots = healthy.calls.flatMap((c) => c.slots);
    assert.equal(new Set(slots).size, slots.length, 'no slot was requested twice');
  });

  test('D14: the sweep finishes a generation that has used up its attempts as PARTIAL (never retried forever) and one with nothing saved as FAILED', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const g = gate();
    await start(scriptedProvider(async ({ n }) => { if (n === 2) await g.promise; return null; }));
    await waitFor(async () => (await itemCount()) === CALENDAR_BATCH_SIZE);
    const doc = await calendarDoc();
    await SocialContentCalendar.updateOne({ _id: doc._id }, { $set: { 'generation.runAttempts': CALENDAR_MAX_RUN_ATTEMPTS, 'generation.lease.expiresAt': new Date(Date.now() - 1000) } });
    const swept = await sweepOnce();
    assert.ok(swept.finished >= 1);
    const after = await calendarDoc();
    assert.equal(after.status, 'partial');
    assert.equal(after.failure.code, 'GENERATION_INTERRUPTED');
    assert.equal(after.generation.progress.plannedPosts, CALENDAR_BATCH_SIZE);

    await SocialContentCalendarItem.deleteMany({ calendar_id: doc._id });
    await SocialContentCalendar.updateOne({ _id: doc._id }, { $set: { status: 'generating', 'generation.runAttempts': CALENDAR_MAX_RUN_ATTEMPTS, 'generation.lease.expiresAt': new Date(Date.now() - 1000) } });
    await sweepOnce();
    assert.equal((await calendarDoc()).status, 'failed');
  });

  test('D15: a request that reads the calendar recovers a dead generation too (no waiting for the sweep, no permanent lockout)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const g = gate();
    await start(scriptedProvider(async ({ n }) => { if (n === 2) await g.promise; return null; }));
    await waitFor(async () => (await itemCount()) === CALENDAR_BATCH_SIZE);
    await expire((await calendarDoc())._id);
    setCalendarProviderOverride(scriptedProvider());
    await getCalendarGenerationStatus(pid); // what the page polls
    await waitFor(async () => (await calendarDoc()).status === 'ready', 8000);
  });

  test('D17: a THREE-MONTH calendar at 3 a week is interrupted by a provider outage part-way and resumes to the exact planned count, with the dates the planner set and no duplicates', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const expected = previewCalendarPlan({ ...request({ months: 3 }), platforms: ['facebook'] }, { today: addDays(1) });
    assert.equal(expected.error, undefined);
    const total = expected.value.totalPosts;
    assert.ok(total >= 36 && total <= 40, String(total));

    const outage = scriptedProvider(async ({ n }) => { if (n === 6) throw busy(); return null; });
    const r = await start(outage, { months: 3 }, { background: false });
    assert.equal(r.generation.status, 'generating');
    assert.equal(r.generation.progress.plannedPosts, CALENDAR_BATCH_SIZE * 5, 'five batches were saved before the outage');
    assert.equal(r.generation.progress.totalPosts, total);

    const doc = await calendarDoc();
    const datesBefore = (await items()).map((i) => [i.slot, i.contentDate]);
    await expire(doc._id);
    const healthy = scriptedProvider();
    setCalendarProviderOverride(healthy);
    await recoverInterruptedCalendars({ projectId: pid, background: false });

    const done = await calendarDoc();
    assert.equal(done.status, 'ready');
    const all = await items();
    assert.equal(all.length, total, 'exactly the planned count');
    assert.equal(done.plan.totalItems, total);
    assert.deepEqual(all.map((i) => i.slot), Array.from({ length: total }, (_, i) => i), 'one item per slot, none missing, none twice');
    assert.equal(new Set(all.map((i) => i.contentDate)).size, total, 'no date twice');
    assert.deepEqual(all.slice(0, datesBefore.length).map((i) => [i.slot, i.contentDate]), datesBefore, 'the dates saved before the outage did not move');
    assert.ok(all.every((i) => i.contentDate >= done.config.startDate && i.contentDate <= done.config.endDate));
    assert.equal(healthy.calls.flatMap((c) => c.slots).filter((s) => s < CALENDAR_BATCH_SIZE * 5).length, 0, 'the five saved batches were not generated again');
    assert.equal(done.config.months, 3);
    assert.equal(done.generation.usage.inputTokens > 0, true, 'usage is accumulated across both runs');
  });

  test('D16: the bounded-concurrency semaphore never lets more than N holders in, and hands slots over in order', async () => {
    const sem = new Semaphore(2);
    let active = 0; let peak = 0; const order = [];
    const job = async (id) => { await sem.acquire(); active += 1; peak = Math.max(peak, active); order.push(id); await sleep(10); active -= 1; sem.release(); };
    await Promise.all([1, 2, 3, 4, 5].map(job));
    assert.equal(peak, 2);
    assert.deepEqual(order, [1, 2, 3, 4, 5]);
  });
});
