import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import axios from 'axios';

dotenv.config();

import SerpStandardTask, { SerpStandardControl } from './SerpStandardTask.js';
import { createStandardService, serpTaskEvents, __setStandardServiceForTests } from './serpStandardService.js';
import { fetchSerpViaStandard } from './serpStandardFetcher.js';
import { readStandardConfig } from './config.js';
import { DataForSeoService } from '../services/DataForSeoService.js';
import { scanKeywordDevices, buildDeviceResult } from '../services/deviceSerpScan.js';
import { organicItems, organicItem, localPack, serpResponse } from '../services/fixtures/organicSerpFixtures.js';

/**
 * The Standard task lifecycle on a REAL MongoDB with a simulated DataForSEO (counted calls; nothing reaches the network).
 * Results come from the same realistic fixtures the Live tests use and go through the real ranking engine.
 */

const MARK = `serp-std-${Date.now()}`;
let mongoAvailable = false;
let dfs; let seq = 0;
const kw = (n) => `${MARK} keyword ${n}`;
const DOMAIN = 'asgeyecentre.example';

/** A simulated DataForSEO: tasks are created on task_post, finish when a test says so, and are listed by tasks_ready until collected. */
function simulatedDfs() {
  const tasks = new Map();
  let n = 0;
  const calls = { post: 0, ready: 0, get: 0, batches: [] };
  const behaviour = { postError: null, rejectKeyword: null, throttleKeyword: null, dropAnswerAfterCreate: false };
  const finish = (id, task) => { tasks.get(id).state = 'ready'; tasks.get(id).task = { ...task, id }; };
  const client = {
    async postTasks(items) {
      calls.post += 1; calls.batches.push(items);
      if (behaviour.postError) throw behaviour.postError;
      const out = items.map((it) => {
        if (it.keyword === behaviour.rejectKeyword) return { status_code: 40501, status_message: 'Invalid Field: depth.' };
        if (it.keyword === behaviour.throttleKeyword) return { status_code: 40209, status_message: 'Too many simultaneous queries.' };
        n += 1; const id = `dfs-${MARK}-${n}`;
        tasks.set(id, { item: it, state: 'queue', task: null });
        return { id, status_code: 20100, status_message: 'Task Created.', cost: 0.0006 * (it.depth / 10) };
      });
      if (behaviour.dropAnswerAfterCreate) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      return { tasks: out, cost: out.reduce((s, t) => s + (t.cost ?? 0), 0) };
    },
    async tasksReady() { calls.ready += 1; return [...tasks].filter(([, t]) => t.state === 'ready').map(([id, t]) => ({ id, tag: t.item.tag })); },
    async taskGet(id) {
      calls.get += 1;
      const t = tasks.get(id);
      if (!t) return { id, status_code: 40401, status_message: 'Task not found.' };
      if (t.state === 'queue') return { id, status_code: 40602, status_message: 'Task In Queue.' };
      t.state = 'collected';
      return t.task;
    },
  };
  return { client, calls, behaviour, tasks, finish };
}

/** The task object a finished SERP task has: the Live fixture's task, with the id set. */
const serpTask = (items, over = {}) => serpResponse({ items, ...over }).data.tasks[0];

const baseCfg = () => ({
  ...readStandardConfig({}), workerPollMs: 10, awaitPollMs: 10, waitMs: 1500, pollBaseMs: 1, pollMaxMs: 10, directPollAfterMs: 5, directPollMaxMs: 20,
  retryBaseMs: 40, retryMaxMs: 200, claimLeaseMs: 60_000, taskTimeoutMs: 60_000, reuseMs: 60_000, maxAttempts: 3, breakerOpenMs: 150,
});
let service; let cfgOverride;
const makeService = (over = {}) => createStandardService({ client: dfs.client, config: () => ({ ...baseCfg(), ...cfgOverride }), skipIndexes: false, ...over });
const request = (n, device = 'desktop', extra = {}) => service.requestTask({ keyword: kw(n), locationCode: 1007785, languageCode: 'en', device, depth: 100, ...extra });
const doc = (id) => SerpStandardTask.findById(id).lean();
const unblockPoller = () => SerpStandardControl.updateOne({ _id: 'poller' }, { $set: { nextPollAt: null } });
/** Runs worker steps until `done()` is true (tests drive time with tiny intervals instead of sleeping long). */
async function drive(done, { max = 80 } = {}) {
  for (let i = 0; i < max; i += 1) {
    await unblockPoller();
    await service.tick();
    if (await done()) return;
    await new Promise((r) => setTimeout(r, 12));
  }
  throw new Error('did not converge');
}

before(async () => {
  try { await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 }); mongoAvailable = true; } catch { /* skipped below */ }
});
after(async () => {
  if (mongoAvailable) {
    await SerpStandardTask.deleteMany({ keyword: new RegExp(MARK) });
    await SerpStandardControl.deleteMany({});
    await mongoose.connection.close();
  }
});
beforeEach(async () => {
  dfs = simulatedDfs(); cfgOverride = {}; seq += 1;
  if (!mongoAvailable) return;
  await SerpStandardTask.deleteMany({});
  await SerpStandardControl.deleteMany({});
  service = makeService();
});

describe('submission', () => {
  test('1/4/5. desktop and mobile are independent tasks with the exact documented parameters, our id as the tag, and the provider cost recorded', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const d = await request(1, 'desktop', { projectId: new mongoose.Types.ObjectId() });
    const m = await request(1, 'mobile');
    assert.notEqual(String(d.task._id), String(m.task._id));
    const r = await service.submitDue();
    assert.equal(r.submitted, 2);
    assert.equal(dfs.calls.post, 1, 'one batched task_post for both');
    const items = Object.fromEntries(dfs.calls.batches[0].map((i) => [i.device, i]));
    assert.deepEqual(items.desktop, { keyword: kw(1), location_code: 1007785, language_code: 'en', depth: 100, device: 'desktop', os: 'windows', tag: String(d.task._id) });
    assert.deepEqual(items.mobile, { keyword: kw(1), location_code: 1007785, language_code: 'en', depth: 100, device: 'mobile', os: 'android', tag: String(m.task._id) });
    const [dd, mm] = [await doc(d.task._id), await doc(m.task._id)];
    assert.deepEqual([dd.status, mm.status], ['submitted', 'submitted']);
    assert.notEqual(dd.dfsTaskId, mm.dfsTaskId);
    assert.equal(dd.attempts, 1);
    assert.ok(Math.abs(dd.cost - 0.006) < 1e-9, `10 SERP pages at 0.0006: ${dd.cost}`);
    assert.equal(String(dd.projectId), String(d.task.projectId));
  });

  test('2. a large scan is submitted in batches of at most 100 tasks', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    for (let i = 0; i < 150; i += 1) await request(i);
    await service.submitDue();
    await service.submitDue();
    assert.deepEqual(dfs.calls.batches.map((b) => b.length), [100, 50]);
    assert.equal(await SerpStandardTask.countDocuments({ status: 'submitted' }), 150);
  });

  test('3. a partially accepted batch: accepted tasks are tracked, a rejected one fails for good, a throttled one waits without using an attempt', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    dfs.behaviour.rejectKeyword = kw(2); dfs.behaviour.throttleKeyword = kw(3);
    const ids = {};
    for (const n of [1, 2, 3]) ids[n] = (await request(n)).task._id;
    const r = await service.submitDue();
    assert.deepEqual([r.submitted, r.rejected, r.throttled], [1, 1, 1]);
    const [a, rej, thr] = await Promise.all([doc(ids[1]), doc(ids[2]), doc(ids[3])]);
    assert.equal(a.status, 'submitted');
    assert.equal(rej.status, 'failed');
    assert.equal(rej.activeKey, undefined, 'a finished request releases its identity');
    assert.equal(thr.status, 'pending_submission');
    assert.equal(thr.attempts, 0, 'a refusal is not a submission');
    assert.ok(new Date(thr.nextAttemptAt) > new Date());
    assert.equal(thr.submitAttemptedAt, null);
  });

  test('a task_post that fails outright leaves every task pending and consumes no attempt; an account error opens the breaker', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const id = (await request(1)).task._id;
    dfs.behaviour.postError = Object.assign(new Error('x'), { isApiError: true, apiStatusCode: 40200 });
    const r = await service.submitDue();
    assert.equal(r.submitted, 0);
    assert.equal((await doc(id)).attempts, 0);
    assert.equal((await service.breakerState()).open, true);
    dfs.behaviour.postError = null;
    assert.equal((await service.submitDue()).skipped, 'breaker_open');
  });
});

describe('results', () => {
  test('6/7/8. still processing is not completed; when ready the result is fetched, persisted, and only then completed (tasks_ready + task_get)', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const id = (await request(1)).task._id;
    await service.submitDue();
    const sub = await doc(id);
    await service.retrieveDue();
    const processing = await doc(id);
    assert.equal(processing.status, 'processing');
    assert.equal(processing.result, null);
    assert.equal(processing.pollCount, 1);
    assert.ok(new Date(processing.nextPollAt) > new Date(), 'polled again later, not in a loop');

    dfs.finish(sub.dfsTaskId, serpTask(organicItems(100, { 4: organicItem(4, DOMAIN) })));
    await unblockPoller();
    const p = await service.pollReady();
    assert.equal(p.matched, 1);
    assert.equal((await doc(id)).readyHint, true);
    const getsBefore = dfs.calls.get;
    await service.retrieveDue();
    const done = await doc(id);
    assert.equal(done.status, 'completed');
    assert.equal(done.outcome, 'complete');
    assert.equal(done.activeKey, undefined);
    assert.equal(done.result.result[0].items.length, 100);
    assert.equal(dfs.calls.get, getsBefore + 1);
    assert.ok(done.purgeAt > new Date());
  });

  test('16/17/18/19/24. the stored result runs through the EXISTING ranking engine: same rank_group, strict domain match, local pack kept apart, Live-shaped output', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const items = [localPack(1, DOMAIN), ...organicItems(30, { 7: organicItem(7, `www.${DOMAIN}`, '/eye-care'), 9: organicItem(9, `${DOMAIN}.evil.example`) })];
    const standardEnvelope = await (async () => {
      const id = (await request(1)).task._id;
      await drive(async () => ['submitted', 'processing'].includes((await doc(id)).status));
      dfs.finish((await doc(id)).dfsTaskId, serpTask(items));
      await drive(async () => (await doc(id)).status === 'completed');
      return fetchSerpViaStandard({ keyword: kw(1), locationCode: 1007785, languageCode: 'en', device: 'desktop' }, { service });
    })();
    const live = serpResponse({ items }).data;
    const fromStandard = buildDeviceResult({ device: 'desktop', serpData: standardEnvelope, serpError: null, attempts: 1, serpMeta: standardEnvelope.dfsSerpMeta, scanned_at: new Date() }, DOMAIN);
    const fromLive = buildDeviceResult({ device: 'desktop', serpData: live, serpError: null, attempts: 1, serpMeta: null, scanned_at: new Date() }, DOMAIN);
    for (const key of ['best_rank', 'ranking_status', 'maps_rank', 'local_pack_rank', 'absolute_rank', 'tracked_depth', 'scan_error', 'completeness']) {
      assert.deepEqual(fromStandard[key], fromLive[key], key);
    }
    assert.deepEqual(fromStandard.ranking_urls, fromLive.ranking_urls);
    assert.equal(fromStandard.best_rank, 7, 'organic rank_group of the www. host; the look-alike domain at 9 is not a match');
    assert.equal(fromStandard.scan_error, null);
    assert.ok(fromStandard.local_pack_rank !== null || fromStandard.maps_rank !== null, 'local pack is separate from the organic rank');
    assert.equal(fromStandard.serp.outcome, 'complete');
  });

  test('9. a task_get that fails is not a task failure: it is read again later, and a task_get with no task object is treated as not available yet', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const id = (await request(1)).task._id;
    await service.submitDue();
    const original = dfs.client.taskGet;
    dfs.client.taskGet = async () => { throw Object.assign(new Error('boom'), { code: 'ECONNRESET' }); };
    await new Promise((r) => setTimeout(r, 12));
    await service.retrieveDue();
    let d = await doc(id);
    assert.equal(d.status, 'submitted');
    assert.equal(d.lastError, null);
    assert.ok(d.pollCount >= 1);
    dfs.client.taskGet = async () => null;
    await new Promise((r) => setTimeout(r, 40));
    await service.retrieveDue();
    d = await doc(id);
    assert.ok(['submitted', 'processing'].includes(d.status));
    dfs.client.taskGet = original;
  });

  test('12. 40106 with items completes as PARTIAL: a rank found is kept, "not found" is not_ranked_partial (never rank 101); 40106 with nothing is a failed attempt', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const found = (await request(1)).task._id;
    const missing = (await request(2)).task._id;
    const empty = (await request(3)).task._id;
    await service.submitDue();
    const [a, b, c] = await Promise.all([doc(found), doc(missing), doc(empty)]);
    dfs.finish(a.dfsTaskId, serpTask(organicItems(40, { 6: organicItem(6, DOMAIN) }), { code: 40106 }));
    dfs.finish(b.dfsTaskId, serpTask(organicItems(40), { code: 40106 }));
    dfs.finish(c.dfsTaskId, serpTask([], { code: 40106 }));
    await drive(async () => (await SerpStandardTask.countDocuments({ status: { $in: ['completed', 'retry_scheduled'] } })) === 3);
    const [fa, fb, fc] = await Promise.all([doc(found), doc(missing), doc(empty)]);
    assert.deepEqual([fa.status, fa.outcome], ['completed', 'partial']);
    assert.deepEqual([fb.status, fb.outcome], ['completed', 'partial']);
    assert.equal(fc.status, 'retry_scheduled', 'nothing usable: recovered later, not completed');
    const scan = (task) => ({ device: 'desktop', serpData: { status_code: 20000, tasks: [task.result] }, serpError: null, attempts: 1, serpMeta: { outcome: task.outcome, provider_code: 40106, requested_depth: 100, returned_results: 40 }, scanned_at: new Date() });
    const r1 = buildDeviceResult(scan(fa), DOMAIN);
    const r2 = buildDeviceResult(scan(fb), DOMAIN);
    assert.equal(r1.best_rank, 6);
    assert.equal(r1.completeness, 'partial');
    assert.equal(r2.best_rank, null);
    assert.equal(r2.ranking_status, 'unknown');
    assert.equal(r2.rank_state, 'not_ranked_partial', 'partial + not found: labelled partial, not a verified not-found');
    assert.equal(r2.scan_error, null);
  });

  test('40102 (no results) is a completed check', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const id = (await request(1)).task._id;
    await service.submitDue();
    dfs.finish((await doc(id)).dfsTaskId, serpTask([], { code: 40102 }));
    await drive(async () => (await doc(id)).status === 'completed');
    assert.equal((await doc(id)).outcome, 'no_results');
  });
});

describe('failure and recovery', () => {
  test('10/Phase 7. a final 40101 is NOT resubmitted at once: it waits (backoff + jitter), is resubmitted by the same record, and ends failed after the attempt limit', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    cfgOverride = { retryBaseMs: 60_000, retryMaxMs: 600_000 };
    const id = (await request(1)).task._id;
    await service.submitDue();
    let d = await doc(id);
    dfs.finish(d.dfsTaskId, { status_code: 40101, status_message: 'Internal SE Server Error.', result: null });
    await service.retrieveDue(); // hint-less: poll time has to come
    await new Promise((r) => setTimeout(r, 15));
    await service.retrieveDue();
    d = await doc(id);
    assert.equal(d.status, 'retry_scheduled');
    assert.equal(d.lastError.code, '40101');
    assert.ok(new Date(d.nextAttemptAt).getTime() - Date.now() > 40_000, 'delayed, not immediate');
    const posts = dfs.calls.post;
    await service.tick();
    assert.equal(dfs.calls.post, posts, 'no duplicate task while the backoff runs');
    assert.equal(await SerpStandardTask.countDocuments({}), 1, 'recovery re-uses the logical request');

    // attempt 2 and 3 (time moved forward by editing the due date)
    for (let attempt = 2; attempt <= 3; attempt += 1) {
      await SerpStandardTask.updateOne({ _id: id }, { $set: { nextAttemptAt: new Date(Date.now() - 1) } });
      await service.tick();
      d = await doc(id);
      assert.ok(['submitted', 'processing'].includes(d.status), `attempt ${attempt} submitted: ${d.status}`);
      assert.equal(d.attempts, attempt);
      dfs.finish(d.dfsTaskId, { status_code: 40101, status_message: 'Internal SE Server Error.', result: null });
      await SerpStandardTask.updateOne({ _id: id }, { $set: { nextPollAt: new Date(Date.now() - 1), readyHint: true } });
      await service.retrieveDue();
    }
    d = await doc(id);
    assert.equal(d.status, 'failed');
    assert.equal(d.attempts, 3);
    assert.equal(d.dfsTaskIds.length, 3);
    assert.equal(d.activeKey, undefined);
    await assert.rejects(() => service.awaitTask(id, { timeoutMs: 200 }), (e) => e.standardFinal === true && e.code === 'SERP_TASK_FAILED' && e.isApiError === true);
  });

  test('a task that never becomes ready is checked one last time, then retried; at the limit it expires (no rank is invented)', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    cfgOverride = { maxAttempts: 1, taskTimeoutMs: 1 };
    const id = (await request(1)).task._id;
    await service.submitDue();
    await new Promise((r) => setTimeout(r, 15));
    await SerpStandardTask.updateOne({ _id: id }, { $set: { nextPollAt: new Date(Date.now() - 1) } });
    await service.retrieveDue();
    const d = await doc(id);
    assert.equal(d.status, 'expired');
    assert.equal(d.lastError.kind, 'timeout');
    await assert.rejects(() => service.awaitTask(id, { timeoutMs: 100 }), (e) => e.code === 'SERP_TASK_EXPIRED' && e.standardFinal);
  });

  test('a permanently rejected task (not a transient code) is not retried', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const id = (await request(1)).task._id;
    await service.submitDue();
    dfs.finish((await doc(id)).dfsTaskId, { status_code: 40501, status_message: 'Invalid Field.', result: null });
    await drive(async () => (await doc(id)).status === 'failed');
    assert.equal((await doc(id)).attempts, 1);
  });

  test('13. backend restart: a NEW service instance continues tasks submitted by the old one, and a lapsed claim is taken over', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const id = (await request(1)).task._id;
    await service.submitDue();
    const stuck = (await request(2)).task._id;
    await SerpStandardTask.updateOne({ _id: stuck }, { $set: { claimUntil: new Date(Date.now() - 1000), claimToken: 'dead-worker' } }); // a worker died holding it
    const restarted = makeService(); // nothing in memory carried over
    dfs.finish((await doc(id)).dfsTaskId, serpTask(organicItems(20, { 3: organicItem(3, DOMAIN) })));
    service = restarted;
    await drive(async () => (await doc(id)).status === 'completed' && ['submitted', 'processing'].includes((await doc(stuck)).status));
    assert.equal((await doc(id)).result.result[0].items.length, 20);
  });

  test('a crash in the middle of task_post: the provider task is ADOPTED through its tag instead of being bought again', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    cfgOverride = { claimLeaseMs: 1 };
    dfs.behaviour.dropAnswerAfterCreate = true;
    const id = (await request(1)).task._id;
    await service.submitDue();
    dfs.behaviour.dropAnswerAfterCreate = false;
    let d = await doc(id);
    assert.equal(d.status, 'pending_submission');
    assert.ok(d.submitAttemptedAt, 'marked: the provider may hold a task for it');
    const [created] = [...dfs.tasks.keys()];
    // The ambiguous task is not resubmitted while it could still be revealed ...
    await SerpStandardTask.updateOne({ _id: id }, { $set: { nextAttemptAt: new Date(Date.now() - 1) } });
    const before = dfs.calls.post;
    await service.submitDue();
    assert.equal(dfs.calls.post, before, 'no second purchase during the grace period');
    // ... and tasks_ready reveals it by our tag.
    dfs.finish(created, serpTask(organicItems(10)));
    await unblockPoller();
    await service.pollReady();
    d = await doc(id);
    assert.equal(d.status, 'submitted');
    assert.equal(d.dfsTaskId, created);
    assert.equal(d.attempts, 1);
    await drive(async () => (await doc(id)).status === 'completed');
    assert.equal(dfs.tasks.size, 1, 'exactly one provider task was ever created');
  });

  test('11/14. result persistence is idempotent: concurrent retrievals write the result once and count one outcome', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const id = (await request(1)).task._id;
    await service.submitDue();
    dfs.finish((await doc(id)).dfsTaskId, serpTask(organicItems(10)));
    await SerpStandardTask.updateOne({ _id: id }, { $set: { readyHint: true } });
    await Promise.all([service.retrieveDue(), service.retrieveDue(), makeService().retrieveDue()]);
    const d = await doc(id);
    assert.equal(d.status, 'completed');
    const c = await SerpStandardControl.findById('breaker').lean();
    assert.equal((c?.outcomes ?? []).filter(Boolean).length, 1);
    assert.equal(dfs.calls.get, 1, 'only one reader got the claim');
  });
});

describe('duplicates, independence, queue, breaker', () => {
  test('15. an identical request never creates a second task: concurrent callers share one, and a recent completed result is reused', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const results = await Promise.all(Array.from({ length: 12 }, () => request(1)));
    assert.equal(new Set(results.map((r) => String(r.task._id))).size, 1);
    assert.equal(await SerpStandardTask.countDocuments({}), 1);
    await service.submitDue();
    assert.equal(dfs.calls.post, 1);
    dfs.finish((await SerpStandardTask.findOne({}).lean()).dfsTaskId, serpTask(organicItems(10)));
    await drive(async () => (await SerpStandardTask.findOne({}).lean()).status === 'completed');
    const again = await request(1);
    assert.equal(again.reused, 'completed');
    await service.tick();
    assert.equal(dfs.calls.post, 1, 'no new purchase');
    assert.equal(await SerpStandardTask.countDocuments({}), 1);
    const otherDevice = await request(1, 'mobile');
    assert.equal(otherDevice.reused, null, 'a different device is a different question');
  });

  test('20/21. Desktop and Mobile keep independent results and failures: one device failing does not touch the other', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    cfgOverride = { maxAttempts: 1 };
    const serpFetcher = (keyword, locationCode, languageCode, { device }) => fetchSerpViaStandard({ keyword, locationCode, languageCode, device }, { service, waitMs: 3000 });
    const scanning = scanKeywordDevices({ keyword: kw(1), locationCode: 1007785, languageCode: 'en', serpFetcher, mobileEnabled: true });
    await drive(async () => (await SerpStandardTask.countDocuments({ status: { $in: ['submitted', 'processing'] } })) === 2);
    const tasks = await SerpStandardTask.find({}).lean();
    const desk = tasks.find((x) => x.device === 'desktop'); const mob = tasks.find((x) => x.device === 'mobile');
    dfs.finish(desk.dfsTaskId, serpTask(organicItems(30, { 5: organicItem(5, DOMAIN) })));
    dfs.finish(mob.dfsTaskId, { status_code: 40101, status_message: 'Internal SE Server Error.', result: null });
    await SerpStandardTask.updateMany({}, { $set: { readyHint: true } });
    const { desktop, mobile } = await (async () => { await drive(async () => (await SerpStandardTask.countDocuments({ status: { $in: ['completed', 'failed'] } })) === 2); return scanning; })();
    const d = buildDeviceResult(desktop, DOMAIN); const m = buildDeviceResult(mobile, DOMAIN);
    assert.equal(d.best_rank, 5);
    assert.equal(d.scan_error, null);
    assert.equal(m.scan_error !== null, true);
    assert.equal(m.best_rank, null);
    assert.equal(m.ranking_status, 'unknown', 'failed is unknown - never "not found" and never rank 101');
  });

  test('22/23. the circuit breaker opens on a failing provider, stops submissions, then probes with a small batch', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    cfgOverride = { breakerWindow: 4, breakerMinFailures: 2, maxAttempts: 1, breakerOpenMs: 120 };
    const ids = [];
    for (const n of [1, 2]) ids.push((await request(n)).task._id);
    await service.submitDue();
    for (const id of ids) dfs.finish((await doc(id)).dfsTaskId, { status_code: 40101, status_message: 'Internal SE Server Error.', result: null });
    await SerpStandardTask.updateMany({}, { $set: { readyHint: true } });
    await service.retrieveDue();
    assert.equal((await service.breakerState()).open, true);
    for (let n = 3; n <= 12; n += 1) await request(n);
    const posts = dfs.calls.post;
    assert.equal((await service.submitDue()).skipped, 'breaker_open');
    assert.equal(dfs.calls.post, posts, 'nothing is bought while it is open');
    await new Promise((r) => setTimeout(r, 160));
    const probe = await service.submitDue();
    assert.equal(probe.submitted, 5, 'half-open: only a probe batch');
    assert.equal((await service.breakerState()).probing, true);
  });

  test('24. progress events follow the lifecycle and carry only allow-listed fields', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const seen = [];
    const on = (p) => seen.push(p);
    serpTaskEvents.on('update', on);
    const projectId = new mongoose.Types.ObjectId();
    const id = (await request(1, 'desktop', { projectId })).task._id;
    await service.submitDue();
    dfs.finish((await doc(id)).dfsTaskId, serpTask(organicItems(10)));
    await drive(async () => (await doc(id)).status === 'completed');
    serpTaskEvents.off('update', on);
    assert.deepEqual([...new Set(seen.map((p) => p.status))], ['pending_submission', 'submitted', 'completed']);
    for (const p of seen) {
      assert.deepEqual(Object.keys(p).filter((k) => !['taskId', 'status', 'device', 'attempts', 'outcome', 'projectId', 'keywordId', 'keyword', 'errorCode', 'timestamp'].includes(k)), []);
      assert.equal(p.projectId, String(projectId));
    }
  });

  test('cost tracking: provider-reported cost is stored per request (all attempts) and summarised; polling adds none', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const id = (await request(1)).task._id;
    await service.submitDue();
    const before = (await doc(id)).cost;
    for (let i = 0; i < 5; i += 1) await service.retrieveDue();
    assert.equal((await doc(id)).cost, before, 'task_get is not billed and not recorded');
    const summary = await service.costSummary();
    const row = summary.find((r) => r.device === 'desktop' && r.status !== 'completed');
    assert.ok(row && row.reportedCost > 0 && row.submissions === 1);
  });
});

describe('getSerpOrganic dispatch (Live stays available)', () => {
  const env = {};
  const set = (o) => { for (const k of Object.keys(env)) delete process.env[k]; Object.assign(env, o); Object.assign(process.env, o); };
  const realPost = axios.post;
  let liveCalls;
  beforeEach(() => { liveCalls = 0; axios.post = async () => { liveCalls += 1; return serpResponse({ items: organicItems(10, { 2: organicItem(2, DOMAIN) }) }); }; });
  after(() => { axios.post = realPost; set({}); __setStandardServiceForTests(null); });

  test('mode=live (default): exactly one Live request and no task is ever recorded', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    set({ DATAFORSEO_SERP_MODE: 'live' });
    __setStandardServiceForTests(service);
    const data = await DataForSeoService.getSerpOrganic(kw(1), 1007785, 'en', { device: 'desktop' });
    assert.equal(liveCalls, 1);
    assert.equal(data.tasks[0].status_code, 20000);
    assert.equal(await SerpStandardTask.countDocuments({}), 0);
  });

  test('mode=standard: NO Live request; a task is recorded; the caller gets a Live-shaped envelope', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    set({ DATAFORSEO_SERP_MODE: 'standard', DATAFORSEO_SERP_STANDARD_WAIT_MS: '4000' });
    __setStandardServiceForTests(service);
    const pending = DataForSeoService.getSerpOrganic(kw(1), 1007785, 'en', { device: 'mobile' });
    await drive(async () => (await SerpStandardTask.countDocuments({ status: { $in: ['submitted', 'processing'] } })) === 1);
    dfs.finish([...dfs.tasks.keys()][0], serpTask(organicItems(10, { 3: organicItem(3, DOMAIN) })));
    await drive(async () => (await SerpStandardTask.countDocuments({ status: 'completed' })) === 1);
    const data = await pending;
    assert.equal(liveCalls, 0);
    assert.equal(data.dfsSerpMeta.outcome, 'complete');
    assert.equal(buildDeviceResult({ device: 'mobile', serpData: data, serpError: null, serpMeta: data.dfsSerpMeta, scanned_at: new Date() }, DOMAIN).best_rank, 3);
  });

  test('an unfinished task is a retryable scan error (not final): no Live fallback, the previous ranking stays', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    set({ DATAFORSEO_SERP_MODE: 'standard', DATAFORSEO_SERP_STANDARD_WAIT_MS: '1000', DATAFORSEO_SERP_FALLBACK_TO_LIVE: 'true' });
    __setStandardServiceForTests(makeService());
    cfgOverride = { waitMs: 80 };
    __setStandardServiceForTests(makeService());
    await assert.rejects(() => fetchSerpViaStandard({ keyword: kw(1), locationCode: 1007785, languageCode: 'en', device: 'desktop' }, { service: makeService(), waitMs: 80 }), (e) => e.code === 'SERP_TASK_PENDING' && e.standardFinal === false);
    const err = await DataForSeoService.getSerpOrganic(kw(9), 1007785, 'en', { device: 'desktop' }).catch((e) => e);
    assert.equal(liveCalls, 0);
    assert.ok(err instanceof Error);
  });

  test('final failure: Live is used ONCE only when the fallback is explicitly enabled; otherwise the error stands', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    cfgOverride = { maxAttempts: 1 };
    const svc = makeService();
    __setStandardServiceForTests(svc);
    set({ DATAFORSEO_SERP_MODE: 'standard', DATAFORSEO_SERP_STANDARD_WAIT_MS: '4000', DATAFORSEO_SERP_FALLBACK_TO_LIVE: 'true' });
    const run = async (n) => {
      const p = DataForSeoService.getSerpOrganic(kw(n), 1007785, 'en', { device: 'desktop' }).catch((e) => e);
      await drive(async () => (await SerpStandardTask.countDocuments({ keyword: kw(n), status: { $in: ['submitted', 'processing'] } })) === 1);
      const task = await SerpStandardTask.findOne({ keyword: kw(n) }).lean();
      dfs.finish(task.dfsTaskId, { status_code: 40101, status_message: 'Internal SE Server Error.', result: null });
      await SerpStandardTask.updateOne({ _id: task._id }, { $set: { readyHint: true } });
      await drive(async () => (await SerpStandardTask.findOne({ keyword: kw(n) }).lean()).status === 'failed');
      return p;
    };
    const withFallback = await run(1);
    assert.equal(liveCalls, 1);
    assert.equal(withFallback.tasks[0].status_code, 20000);
    set({ DATAFORSEO_SERP_MODE: 'standard', DATAFORSEO_SERP_STANDARD_WAIT_MS: '4000', DATAFORSEO_SERP_FALLBACK_TO_LIVE: 'false' });
    const without = await run(2);
    assert.equal(liveCalls, 1, 'no second Live request');
    assert.ok(without instanceof Error);
    assert.equal(without.standardFinal, true);
  });
});
