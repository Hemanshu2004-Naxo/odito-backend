import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import mongoose from 'mongoose';
import SerpStandardTask, { SerpStandardControl, ACTIVE_TASK_STATUSES } from './SerpStandardTask.js';
import { createStandardClient } from './serpStandardClient.js';
import { readStandardConfig } from './config.js';
import {
  dedupeKeyOf, buildTaskPostItem, classifyPostItem, classifyTaskGet, retryDelayMs, directPollDelayMs, nextPollIntervalMs, breakerShouldOpen,
} from './serpStandardCore.js';
import { summarizeOrganicResponse, assessOrganicOutcome, ORGANIC_OUTCOMES } from '../services/serpResponseOutcome.js';
import { resolveSerpDevice, resolveSerpDepth } from '../services/serpDevices.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * Persistent lifecycle of DataForSEO Standard organic-SERP tasks.
 *
 *   requestTask   (any caller) records ONE logical request and returns it; an identical active request, or a recently completed one, is
 *                 shared - never a second purchase.
 *   awaitTask     (interactive callers) reads the record until it ends or the wait is over; the wait never owns the task.
 *   tick          (worker) submits due tasks in batches, learns which are ready (tasks_ready, pingback, a direct task_get with backoff),
 *                 fetches and PERSISTS results (status completed is written in the same update as the result), schedules recovery.
 *
 * Every step is an atomic MongoDB update, so any number of workers / instances can run tick() at once, and a restart loses nothing.
 * Billing (docs): only task_post is charged; tasks_ready / task_get are free, so polling costs requests, not money. 40106 partial pages
 * are not charged. A failed task's refund is not documented: Odito therefore resubmits only after the provider has finally given up,
 * at most `maxAttempts` times per request, never in parallel.
 */

export const serpTaskEvents = new EventEmitter();
const PROJECT_SAFE = (t) => ({
  taskId: String(t._id), status: t.status, device: t.device, attempts: t.attempts, outcome: t.outcome ?? null,
  ...(t.projectId ? { projectId: String(t.projectId) } : {}), ...(t.keywordId ? { keywordId: String(t.keywordId) } : {}),
  keyword: t.keyword, errorCode: t.lastError?.code ?? null, timestamp: new Date(),
});
/** Progress for the project's room (same transport as scans); allow-listed fields only. Never throws. */
function emitTaskEvent(task) {
  try {
    const payload = PROJECT_SAFE(task);
    serpTaskEvents.emit('update', payload);
    if (task.projectId && global.io) global.io.to(`project-${String(task.projectId)}`).emit('serp_task:updated', payload);
  } catch { /* progress is best effort */ }
}

export class SerpTaskError extends Error {
  /** code: SERP_TASK_PENDING (still running; ask again later) | SERP_TASK_FAILED | SERP_TASK_EXPIRED | SERP_BREAKER_OPEN */
  constructor(message, { code, task = null, final = false } = {}) {
    super(message);
    this.name = 'SerpTaskError';
    this.code = code;
    this.isApiError = true; // handled like every other provider failure: a scan_error, the previous ranking is kept
    this.isTaskError = true;
    this.standardFinal = final; // true: no more attempts will be made for this request (a configured Live fallback may apply)
    this.taskStatusCode = task?.providerStatusCode ?? task?.lastError?.code ?? null;
    this.taskId = task ? String(task._id) : null;
    this.attempts = task?.attempts ?? null;
  }
}

const DUPLICATE_KEY = 11000;
let indexesReady = null;
const ensureIndexes = () => {
  indexesReady ??= Promise.all([SerpStandardTask.createIndexes(), SerpStandardControl.createIndexes()]).catch((err) => { indexesReady = null; throw err; });
  return indexesReady;
};

export function createStandardService({
  client = createStandardClient(), now = () => new Date(), random = Math.random, config = () => readStandardConfig(),
  Task = SerpStandardTask, Control = SerpStandardControl, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), skipIndexes = false,
} = {}) {
  const add = (d, ms) => new Date(d.getTime() + ms);
  const log = (level, msg, fields) => LoggerUtil[level](msg, fields);

  // ── circuit breaker (shared by every instance through the control document) ─────────────────────────────────────────────────────
  async function breakerState() {
    const c = await Control.findById('breaker').lean();
    const cfg = config();
    const open = Boolean(c?.breakerOpenUntil) && new Date(c.breakerOpenUntil) > now();
    // After the open period the first submissions are a small probe until a success is recorded.
    const probing = !open && Boolean(c?.breakerOpenUntil) && !(c.outcomes ?? []).includes(true);
    return { open, probing, openUntil: c?.breakerOpenUntil ?? null, probeSize: Math.min(5, cfg.batchSize) };
  }
  async function openBreaker(reason) {
    const cfg = config();
    await Control.updateOne({ _id: 'breaker' }, { $set: { breakerOpenUntil: add(now(), cfg.breakerOpenMs), outcomes: [] } }, { upsert: true });
    log('warn', 'SERP standard: circuit breaker OPEN', { reason, forMs: cfg.breakerOpenMs });
  }
  async function recordOutcome(ok) {
    const cfg = config();
    const c = await Control.findOneAndUpdate({ _id: 'breaker' }, { $push: { outcomes: { $each: [ok], $slice: -cfg.breakerWindow } } }, { upsert: true, new: true }).lean();
    if (!ok && breakerShouldOpen(c.outcomes ?? [], cfg)) await openBreaker('failure rate');
  }

  // ── requests ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  /**
   * Records (or joins) the logical request. Returns { task, reused: 'active'|'completed'|null }.
   * Identical = same keyword, market, device and depth. The project / keyword ids only label the first request that created the task.
   */
  async function requestTask({ keyword, locationCode, languageCode, device, depth = resolveSerpDepth(), projectId = null, keywordId = null }) {
    if (!skipIndexes) await ensureIndexes();
    const cfg = config();
    const dev = resolveSerpDevice(device);
    const spec = { keyword: String(keyword), locationCode, languageCode: String(languageCode).toLowerCase(), device: dev.device, depth };
    const dedupeKey = dedupeKeyOf(spec);
    const t = now();

    if (cfg.reuseMs > 0) {
      const done = await Task.findOne({ dedupeKey, status: 'completed', completedAt: { $gte: new Date(t.getTime() - cfg.reuseMs) } }).sort({ completedAt: -1 }).lean();
      if (done) return { task: done, reused: 'completed' };
    }
    const active = await Task.findOne({ activeKey: dedupeKey }).lean();
    if (active) return { task: active, reused: 'active' };
    try {
      const created = await Task.create({
        ...spec, os: dev.os, dedupeKey, activeKey: dedupeKey, status: 'pending_submission', nextAttemptAt: t, priority: cfg.priority,
        projectId: mongoose.isValidObjectId(projectId) ? projectId : null, keywordId: mongoose.isValidObjectId(keywordId) ? keywordId : null,
      });
      emitTaskEvent(created);
      return { task: created.toObject(), reused: null };
    } catch (err) {
      if (err?.code !== DUPLICATE_KEY) throw err;
      const again = await Task.findOne({ activeKey: dedupeKey }).lean();
      if (again) return { task: again, reused: 'active' };
      throw err;
    }
  }

  /** Waits (reading MongoDB only) for the task to end. Completed -> the task; failed / expired -> SerpTaskError(final); still running -> SERP_TASK_PENDING. */
  async function awaitTask(taskId, { timeoutMs = config().waitMs, pollMs = config().awaitPollMs } = {}) {
    const deadline = now().getTime() + timeoutMs;
    for (;;) {
      const task = await Task.findById(taskId).lean();
      if (!task) throw new SerpTaskError('The ranking task no longer exists.', { code: 'SERP_TASK_FAILED', final: true });
      if (task.status === 'completed') return task;
      if (task.status === 'failed' || task.status === 'expired') {
        throw new SerpTaskError(`DataForSEO task error: ${task.lastError?.message ?? 'the task did not complete'} (${task.status})`, { code: task.status === 'expired' ? 'SERP_TASK_EXPIRED' : 'SERP_TASK_FAILED', task, final: true });
      }
      if (now().getTime() >= deadline) {
        const b = await breakerState();
        throw new SerpTaskError(
          b.open ? 'DataForSEO Standard is paused after repeated failures; the ranking will be retried automatically.' : 'The ranking task is still running at DataForSEO; the result will be used by the next check.',
          { code: b.open ? 'SERP_BREAKER_OPEN' : 'SERP_TASK_PENDING', task, final: false },
        );
      }
      await sleep(pollMs);
    }
  }

  // ── terminal transitions ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  const ended = (cfg, status) => ({ $unset: { activeKey: 1 }, $set: { status, claimUntil: null, claimToken: null, nextAttemptAt: null, nextPollAt: null, readyHint: false, purgeAt: add(now(), status === 'completed' ? cfg.purgeCompletedMs : cfg.purgeFailedMs) } });

  /** The provider finally gave up on this attempt: schedule Odito-level recovery (backoff + jitter) or end the request. */
  async function failAttempt(task, { code, message, kind }, { finalStatus = 'failed', permanent = false } = {}) {
    const cfg = config();
    const lastError = { code: String(code ?? 'UNKNOWN').slice(0, 60), message: String(message ?? '').slice(0, 300), kind, at: now() };
    await recordOutcome(false);
    const canRetry = !permanent && task.attempts < cfg.maxAttempts;
    const update = canRetry
      ? { $set: { status: 'retry_scheduled', lastError, nextAttemptAt: add(now(), retryDelayMs(task.attempts, cfg, random)), claimUntil: null, claimToken: null, nextPollAt: null, readyHint: false, providerStatusCode: Number.isFinite(code) ? code : null } }
      : (() => { const e = ended(cfg, finalStatus); return { $set: { ...e.$set, lastError, providerStatusCode: Number.isFinite(code) ? code : null }, $unset: e.$unset }; })();
    const out = await Task.findOneAndUpdate({ _id: task._id, status: { $in: ['submitted', 'processing', 'pending_submission'] } }, update, { new: true }).lean();
    if (out) emitTaskEvent(out);
    return out;
  }

  // ── submission ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  async function claim(filter, limit, leaseMs) {
    const token = randomUUID();
    const t = now();
    const ids = (await Task.find({ ...filter, $or: [{ claimUntil: null }, { claimUntil: { $lt: t } }] }).sort({ nextAttemptAt: 1 }).limit(limit).select('_id').lean()).map((d) => d._id);
    if (!ids.length) return [];
    await Task.updateMany({ _id: { $in: ids }, ...filter, $or: [{ claimUntil: null }, { claimUntil: { $lt: t } }] }, { $set: { claimUntil: add(t, leaseMs), claimToken: token } });
    return Task.find({ claimToken: token, ...filter }).lean();
  }

  async function release(tasks, { delayMs, markAttempted = false }) {
    const t = now();
    await Task.updateMany({ _id: { $in: tasks.map((x) => x._id) } }, { $set: { claimUntil: null, claimToken: null, nextAttemptAt: add(t, delayMs), ...(markAttempted ? {} : { submitAttemptedAt: null }) } });
  }

  /** Submits due tasks in one task_post of at most `batchSize` (<= 100). Returns { submitted, throttled, rejected }. */
  async function submitDue() {
    const cfg = config();
    const t = now();
    const b = await breakerState();
    if (b.open) return { submitted: 0, skipped: 'breaker_open' };
    const inFlight = await Task.countDocuments({ status: { $in: ['submitted', 'processing'] } });
    const room = cfg.maxInFlight - inFlight;
    if (room <= 0) return { submitted: 0, skipped: 'max_in_flight' };
    const limit = Math.min(cfg.batchSize, room, b.probing ? b.probeSize : cfg.batchSize);
    // A task whose earlier submission may have reached the provider (a crash mid-request) waits out the adoption grace period.
    const grace = new Date(t.getTime() - Math.max(cfg.claimLeaseMs, 10 * 60_000));
    const tasks = await claim({ status: 'pending_submission', nextAttemptAt: { $lte: t }, $and: [{ $or: [{ submitAttemptedAt: null }, { submitAttemptedAt: { $lt: grace } }] }] }, limit, cfg.claimLeaseMs);
    if (!tasks.length) return { submitted: 0 };
    await Task.updateMany({ _id: { $in: tasks.map((x) => x._id) } }, { $set: { submitAttemptedAt: t } });

    let res;
    try {
      res = await client.postTasks(tasks.map((x) => buildTaskPostItem(x, cfg)));
    } catch (err) {
      const code = err?.apiStatusCode ?? err?.response?.status ?? err?.code ?? 'NETWORK';
      // Envelope-level refusals (auth, payment, paused account) mean nothing was accepted: release without an attempt and stop for a while.
      const refused = err?.isApiError === true || (err?.response?.status >= 400 && err?.response?.status < 500);
      log('warn', 'SERP standard: task_post failed', { code, tasks: tasks.length, refused });
      await release(tasks, { delayMs: retryDelayMs(1, { retryBaseMs: Math.min(60_000, cfg.retryBaseMs), retryMaxMs: cfg.retryMaxMs }, random), markAttempted: !refused });
      if (refused && [40100, 40200, 40201, 401, 402, 403].includes(Number(code))) await openBreaker(`account error ${code}`);
      return { submitted: 0, error: String(code) };
    }

    const stats = { submitted: 0, throttled: 0, rejected: 0, unanswered: 0 };
    const sub = [];
    const rel = [];
    for (let i = 0; i < tasks.length; i += 1) {
      const task = tasks[i];
      const item = res.tasks[i];
      if (!item) { stats.unanswered += 1; rel.push(task); continue; } // answer missing: the provider may hold it; adoption by tag recovers
      const v = classifyPostItem(item);
      if (v.kind === 'accepted') {
        stats.submitted += 1;
        sub.push({ updateOne: { filter: { _id: task._id, claimToken: task.claimToken }, update: {
          $set: { status: 'submitted', dfsTaskId: v.id, submittedAt: t, nextPollAt: add(t, cfg.directPollAfterMs), pollCount: 0, readyHint: false, claimUntil: null, claimToken: null, submitAttemptedAt: null, nextAttemptAt: null },
          $inc: { attempts: 1, cost: v.cost }, $push: { dfsTaskIds: v.id },
        } } });
      } else if (v.kind === 'rejected') {
        stats.rejected += 1;
        await failAttempt({ ...task, attempts: task.attempts + 1 }, { code: v.code, message: v.message ?? 'The provider rejected the task.', kind: 'rejected' }, { permanent: true });
      } else {
        stats.throttled += 1;
        rel.push({ ...task, __refused: true });
      }
    }
    if (sub.length) await Task.bulkWrite(sub, { ordered: false });
    const refusedOnes = rel.filter((x) => x.__refused);
    if (refusedOnes.length) await release(refusedOnes, { delayMs: 60_000 });
    const unanswered = rel.filter((x) => !x.__refused);
    if (unanswered.length) await release(unanswered, { delayMs: 60_000, markAttempted: true });
    if (sub.length) for (const task of await Task.find({ _id: { $in: tasks.map((x) => x._id) }, status: 'submitted' }).lean()) emitTaskEvent(task);
    return stats;
  }

  // ── readiness ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  /** Marks `ids` ready. Unknown ids whose tag is one of OUR unsubmitted tasks are adopted (a task_post whose answer was lost). */
  async function applyReady(list) {
    if (!list.length) return 0;
    const t = now();
    const res = await Task.updateMany({ dfsTaskId: { $in: list.map((r) => r.id) }, status: { $in: ['submitted', 'processing'] } }, { $set: { readyHint: true, nextPollAt: t } });
    let matched = res.modifiedCount ?? res.nModified ?? 0;
    const known = new Set((await Task.find({ dfsTaskId: { $in: list.map((r) => r.id) } }).select('dfsTaskId').lean()).map((d) => d.dfsTaskId));
    for (const r of list) {
      if (known.has(r.id) || !r.tag || !mongoose.isValidObjectId(r.tag)) continue;
      const adopted = await Task.findOneAndUpdate(
        { _id: r.tag, status: { $in: ['pending_submission', 'retry_scheduled'] }, submitAttemptedAt: { $ne: null }, dfsTaskIds: { $ne: r.id } },
        { $set: { status: 'submitted', dfsTaskId: r.id, submittedAt: t, readyHint: true, nextPollAt: t, claimUntil: null, claimToken: null, submitAttemptedAt: null, nextAttemptAt: null }, $inc: { attempts: 1 }, $push: { dfsTaskIds: r.id } },
        { new: true },
      ).lean();
      if (adopted) { matched += 1; log('warn', 'SERP standard: adopted an orphaned provider task', { taskId: String(adopted._id) }); emitTaskEvent(adopted); }
    }
    return matched;
  }

  /** At most one tasks_ready call per interval across ALL instances (the provider allows 20 per minute); the interval backs off while idle. */
  async function pollReady() {
    const cfg = config();
    const t = now();
    const waiting = await Task.countDocuments({ $or: [{ status: { $in: ['submitted', 'processing'] } }, { status: 'pending_submission', submitAttemptedAt: { $ne: null } }, { status: 'retry_scheduled', submitAttemptedAt: { $ne: null } }] });
    if (!waiting) return { polled: false, reason: 'nothing_waiting' };
    let slot;
    try {
      slot = await Control.findOneAndUpdate({ _id: 'poller', $or: [{ nextPollAt: null }, { nextPollAt: { $lte: t } }] }, { $set: { nextPollAt: add(t, cfg.pollBaseMs) }, $setOnInsert: { pollIntervalMs: 0 } }, { upsert: true, new: false }).lean();
    } catch (err) {
      if (err?.code === DUPLICATE_KEY) return { polled: false, reason: 'not_due' }; // the document exists and is not due: someone polled recently
      throw err;
    }
    let ready = [];
    try {
      ready = await client.tasksReady();
    } catch (err) {
      log('warn', 'SERP standard: tasks_ready failed', { code: err?.apiStatusCode ?? err?.response?.status ?? err?.code });
      const next = nextPollIntervalMs(slot?.pollIntervalMs ?? 0, false, cfg);
      await Control.updateOne({ _id: 'poller' }, { $set: { pollIntervalMs: next, nextPollAt: add(t, next) } });
      return { polled: true, error: true };
    }
    const matched = await applyReady(ready);
    const next = nextPollIntervalMs(slot?.pollIntervalMs ?? 0, matched > 0, cfg);
    await Control.updateOne({ _id: 'poller' }, { $set: { pollIntervalMs: next, nextPollAt: add(t, next) } });
    return { polled: true, ready: ready.length, matched };
  }

  /** A pingback (DataForSEO -> us) hints that a task is ready. Verified by the fetch itself, so a false hint costs one free task_get. */
  async function markReadyByDfsId(dfsTaskId) {
    const r = await Task.updateOne({ dfsTaskId: String(dfsTaskId), status: { $in: ['submitted', 'processing'] } }, { $set: { readyHint: true, nextPollAt: now() } });
    return (r.modifiedCount ?? r.nModified ?? 0) > 0;
  }

  // ── retrieval ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  async function retrieveOne(task) {
    const cfg = config();
    const t = now();
    let got;
    try {
      got = await client.taskGet(task.dfsTaskId);
    } catch (err) {
      // A failed read says nothing about the task: look again later (the read is free), unless it has run out of time.
      log('warn', 'SERP standard: task_get failed', { taskId: String(task._id), code: err?.apiStatusCode ?? err?.response?.status ?? err?.code });
      return afterPending(task, cfg, t, { status: task.status });
    }
    if (!got) return afterPending(task, cfg, t, { status: task.status }); // no task object in the answer: treated as not available yet
    const verdict = classifyTaskGet(got);

    if (verdict.kind === 'ready') {
      const summary = summarizeOrganicResponse({ status_code: 20000, tasks: [got] }, { requestedDepth: task.depth });
      const outcome = assessOrganicOutcome(summary);
      if (outcome === ORGANIC_OUTCOMES.PARTIAL_WITHOUT_RESULTS) {
        return failAttempt(task, { code: verdict.code, message: 'Partial results with no organic items (40106).', kind: 'partial_results' });
      }
      const cfg2 = config();
      const e = ended(cfg2, 'completed');
      // Persisted BEFORE the task counts as completed: one update writes both, and only the first writer matches (idempotent).
      const done = await Task.findOneAndUpdate(
        { _id: task._id, status: { $in: ['submitted', 'processing'] }, dfsTaskId: task.dfsTaskId },
        { $set: { ...e.$set, result: got, outcome, providerStatusCode: verdict.code, completedAt: t, lastError: null }, $unset: e.$unset },
        { new: true },
      ).lean();
      if (done) { await recordOutcome(true); emitTaskEvent(done); }
      return done;
    }
    if (verdict.kind === 'pending') return afterPending(task, cfg, t, { status: 'processing' });
    if (verdict.kind === 'permanent') return failAttempt(task, { code: verdict.code, message: got.status_message, kind: 'rejected' }, { permanent: true });
    return failAttempt(task, { code: verdict.code, message: got.status_message, kind: verdict.kind });
  }

  /** Still running: poll again later with backoff; past the task timeout it is retried (or expired) instead. */
  async function afterPending(task, cfg, t, { status }) {
    if (task.submittedAt && t.getTime() - new Date(task.submittedAt).getTime() > cfg.taskTimeoutMs) {
      return failAttempt(task, { code: 'TASK_TIMEOUT', message: 'The task was not ready within the allowed time.', kind: 'timeout' }, { finalStatus: 'expired' });
    }
    const out = await Task.findOneAndUpdate(
      { _id: task._id, status: { $in: ['submitted', 'processing'] } },
      { $set: { status, readyHint: false, claimUntil: null, claimToken: null, nextPollAt: add(t, directPollDelayMs(task.pollCount ?? 0, cfg, 15_000, random)) }, $inc: { pollCount: 1 } },
      { new: true },
    ).lean();
    if (out && out.status !== task.status) emitTaskEvent(out);
    return out;
  }

  /** Fetches the tasks that are ready (hinted) or whose own poll time has come. Bounded per tick. */
  async function retrieveDue() {
    const cfg = config();
    const t = now();
    const filter = { status: { $in: ['submitted', 'processing'] }, $and: [{ $or: [{ readyHint: true }, { nextPollAt: { $lte: t } }] }] };
    const tasks = await claim(filter, cfg.directPollsPerTick + cfg.getConcurrency, cfg.claimLeaseMs);
    let i = 0;
    const results = [];
    await Promise.all(Array.from({ length: Math.min(cfg.getConcurrency, tasks.length) }, async () => {
      while (i < tasks.length) { const task = tasks[i]; i += 1; try { results.push(await retrieveOne(task)); } catch (err) { log('error', 'SERP standard: retrieval failed', { taskId: String(task._id), message: err.message }); await Task.updateOne({ _id: task._id }, { $set: { claimUntil: null, claimToken: null } }); } }
    }));
    return { retrieved: tasks.length, completed: results.filter((r) => r?.status === 'completed').length };
  }

  async function promoteRetries() {
    const r = await Task.updateMany({ status: 'retry_scheduled', nextAttemptAt: { $lte: now() } }, { $set: { status: 'pending_submission', dfsTaskId: null, readyHint: false, nextPollAt: null } });
    return r.modifiedCount ?? r.nModified ?? 0;
  }

  /** One worker step. Never throws; each stage is independent. */
  async function tick() {
    const out = {};
    for (const [name, fn] of [['promoted', promoteRetries], ['submit', submitDue], ['poll', pollReady], ['retrieve', retrieveDue]]) {
      try { out[name] = await fn(); } catch (err) { out[name] = { error: err.message }; log('error', `SERP standard: ${name} failed`, { message: err.message }); }
    }
    return out;
  }

  async function costSummary({ since = new Date(Date.now() - 30 * 86_400_000), projectId = null } = {}) {
    const match = { createdAt: { $gte: since }, ...(projectId ? { projectId: new mongoose.Types.ObjectId(String(projectId)) } : {}) };
    const rows = await Task.aggregate([{ $match: match }, { $group: { _id: { status: '$status', device: '$device' }, tasks: { $sum: 1 }, attempts: { $sum: '$attempts' }, cost: { $sum: '$cost' } } }]);
    return rows.map((r) => ({ status: r._id.status, device: r._id.device, tasks: r.tasks, submissions: r.attempts, reportedCost: r.cost }));
  }

  return { requestTask, awaitTask, tick, submitDue, pollReady, retrieveDue, promoteRetries, markReadyByDfsId, applyReady, breakerState, costSummary, ACTIVE_TASK_STATUSES };
}

let shared = null;
export const getStandardService = () => (shared ??= createStandardService());
export const __setStandardServiceForTests = (svc) => { shared = svc; };
