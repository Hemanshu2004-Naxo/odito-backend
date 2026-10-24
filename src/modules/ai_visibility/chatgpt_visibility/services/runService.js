import mongoose from 'mongoose';
import ChatGptVisibilityRun from '../models/ChatGptVisibilityRun.js';
import { getChatGptConfig } from '../config/chatgptConfig.js';

/**
 * Persistence and state transitions for ChatGPT visibility runs. Every transition is ONE conditional database update, so two
 * workers (or a worker and the recovery sweep) can never both win. Nothing here calls a provider.
 */

export const ACTIVE_STATUSES = Object.freeze(['queued', 'running']);
export const TERMINAL_STATUSES = Object.freeze(['completed', 'partial', 'failed', 'cancelled', 'skipped']);

const isDuplicateKey = (e) => e && (e.code === 11000 || e.code === 11001);
const oid = (v) => (v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(String(v)));

/**
 * Create a run. Idempotent per (project, auditRunId); refuses a second active run for the project.
 * @returns {Promise<{created:true,run:object}|{created:false,duplicate:true,run:object}|{created:false,activeRun:object}>}
 */
export async function createRun({ projectId, userId, auditRunId = null, triggerSource, auditRunSource = null, status = 'queued', failureCode = null, failureMessage = null, extra = null }, { Model = ChatGptVisibilityRun, now = () => new Date() } = {}) {
  const at = now();
  try {
    const doc = await Model.create({
      projectId: oid(projectId),
      userId: oid(userId),
      auditRunId: auditRunId ? oid(auditRunId) : null,
      trigger: { source: triggerSource, auditRunSource },
      status,
      progress: { completed: 0, total: extra?.questionSnapshot?.length || 5, stage: status === 'queued' ? 'queued' : status },
      // Approved-question runs pass executionMode / questionSetId / questionSnapshot / policy here; legacy callers pass nothing.
      ...(extra || {}),
      failureCode,
      failureMessage,
      ...(status === 'skipped' ? { completedAt: at } : {}),
    });
    return { created: true, run: doc.toObject() };
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    if (auditRunId) {
      const existing = await Model.findOne({ projectId: oid(projectId), auditRunId: oid(auditRunId) }).lean();
      if (existing) return { created: false, duplicate: true, run: existing };
    }
    const activeRun = await Model.findOne({ projectId: oid(projectId), status: { $in: ACTIVE_STATUSES } }).lean();
    if (activeRun) return { created: false, activeRun };
    throw error;
  }
}

/**
 * Atomically claim the next eligible run (or a specific one): `queued`, or `running` with an expired lease, and still within the
 * claim budget. Sets the lease, bumps `attempts`, stamps `startedAt` once. Returns the claimed run or null.
 */
export async function claimRun({ runId = null, workerId, now = new Date(), config = getChatGptConfig(), Model = ChatGptVisibilityRun }) {
  const filter = {
    attempts: { $lt: config.maxClaims },
    $or: [{ status: 'queued' }, { status: 'running', 'lease.expiresAt': { $lt: now } }],
  };
  if (runId) filter._id = oid(runId);
  return Model.findOneAndUpdate(
    filter,
    [{
      $set: {
        status: 'running',
        lockedBy: workerId,
        'lease.expiresAt': new Date(now.getTime() + config.leaseMs),
        heartbeatAt: now,
        attempts: { $add: ['$attempts', 1] },
        startedAt: { $ifNull: ['$startedAt', now] },
        'progress.stage': 'running',
      },
    }],
    { new: true, sort: { createdAt: 1 } },
  ).lean();
}

/** Renew the lease. owned=false means this worker no longer owns the run (lease lost / finalized elsewhere). */
export async function renewLease({ runId, workerId, now = new Date(), config = getChatGptConfig(), Model = ChatGptVisibilityRun }) {
  const doc = await Model.findOneAndUpdate(
    { _id: oid(runId), lockedBy: workerId, status: 'running' },
    { $set: { 'lease.expiresAt': new Date(now.getTime() + config.leaseMs), heartbeatAt: now } },
    { new: true, projection: { cancelRequested: 1 } },
  ).lean();
  return { owned: Boolean(doc), cancelRequested: Boolean(doc?.cancelRequested) };
}

/** Number of runs currently running with a live lease (best-effort cross-instance concurrency cap). */
export function countLiveRunning({ now = new Date(), Model = ChatGptVisibilityRun } = {}) {
  return Model.countDocuments({ status: 'running', 'lease.expiresAt': { $gte: now } });
}

/** Store the validated prompt set reference, the measurement target and the five pending executions (owner only, once). */
export async function initializeRun({ runId, workerId, promptSet, target, market, executions, Model = ChatGptVisibilityRun }) {
  const res = await Model.updateOne(
    { _id: oid(runId), lockedBy: workerId, status: 'running', 'executions.0': { $exists: false } },
    {
      $set: {
        promptSetId: promptSet._id,
        promptSetVersion: promptSet.version,
        promptGeneratedBy: promptSet.generatedBy,
        'promptTokenUsage.inputTokens': promptSet.tokenUsage?.inputTokens ?? null,
        'promptTokenUsage.outputTokens': promptSet.tokenUsage?.outputTokens ?? null,
        target,
        market,
        executions,
        'progress.total': executions.length,
        'progress.completed': 0,
      },
    },
  );
  return res.modifiedCount === 1;
}

/**
 * Store the measurement target and market of an approved-question run (owner only, once). A recovered run keeps the target it started
 * with, so one run is always measured against one brand/competitor/market definition even if the profile changes mid-run.
 */
export async function setApprovedTarget({ runId, workerId, target, market, Model = ChatGptVisibilityRun }) {
  const res = await Model.updateOne(
    { _id: oid(runId), lockedBy: workerId, status: 'running', target: null },
    { $set: { target, market } },
  );
  return res.modifiedCount === 1;
}

/**
 * Persist ONE execution result (owner only; only while that execution is still pending, so a result is never overwritten).
 * `patch` keys are execution field names. Returns true when written.
 */
export async function saveExecution({ runId, workerId, category, patch, Model = ChatGptVisibilityRun }) {
  const set = {};
  for (const [k, v] of Object.entries(patch)) set[`executions.$[e].${k}`] = v;
  const res = await Model.updateOne(
    { _id: oid(runId), lockedBy: workerId, status: 'running' },
    { $set: set },
    { arrayFilters: [{ 'e.category': category, 'e.status': 'pending' }] },
  );
  return res.modifiedCount === 1;
}

export async function updateProgress({ runId, workerId, completed, total, stage, totalCost, questionStats, Model = ChatGptVisibilityRun }) {
  const set = { 'progress.completed': completed, 'progress.total': total, 'progress.stage': stage };
  if (totalCost) set.totalCost = totalCost;
  if (questionStats) set.questionStats = questionStats;
  await Model.updateOne({ _id: oid(runId), lockedBy: workerId, status: 'running' }, { $set: set });
}

/** Finalize (owner only). Releases the lease. Returns the final document or null when ownership was lost. */
export function finalizeRun({ runId, workerId, status, metrics, totalCost, executions, questionStats, failureCode = null, failureMessage = null, now = new Date(), Model = ChatGptVisibilityRun }) {
  const failed = status === 'failed';
  return Model.findOneAndUpdate(
    { _id: oid(runId), lockedBy: workerId, status: 'running' },
    {
      $set: {
        status,
        metrics,
        totalCost,
        ...(executions ? { executions } : {}),
        ...(questionStats ? { questionStats } : {}),
        failureCode,
        failureMessage,
        completedAt: failed ? null : now,
        failedAt: failed ? now : null,
        lockedBy: null,
        'lease.expiresAt': null,
        'progress.stage': status,
      },
    },
    { new: true },
  ).lean();
}

/** Runs whose lease expired and whose claim budget is used up: nobody will ever claim them again. */
export function findExhausted({ now = new Date(), config = getChatGptConfig(), limit = 20, Model = ChatGptVisibilityRun }) {
  return Model.find({ status: 'running', 'lease.expiresAt': { $lt: now }, attempts: { $gte: config.maxClaims } }).limit(limit).lean();
}

/** Finalize a run no worker owns any more (recovery path). Conditional on the same expired-lease state it was found in. */
export function finalizeAbandoned({ run, status, metrics, totalCost, executions, questionStats, failureCode, failureMessage, now = new Date(), Model = ChatGptVisibilityRun }) {
  return Model.findOneAndUpdate(
    { _id: run._id, status: 'running', 'lease.expiresAt': run.lease.expiresAt },
    {
      $set: {
        status, metrics, totalCost, ...(executions ? { executions } : {}), ...(questionStats ? { questionStats } : {}), failureCode, failureMessage,
        completedAt: status === 'failed' ? null : now, failedAt: status === 'failed' ? now : null,
        lockedBy: null, 'lease.expiresAt': null, 'progress.stage': status,
      },
    },
    { new: true },
  ).lean();
}

/**
 * Cancel. A queued run is cancelled at once (nothing ran). A running run gets `cancelRequested`; its owner finalizes it as
 * `cancelled` at the next heartbeat / between prompts, keeping what already succeeded. Scoped to the project (ownership).
 */
export async function requestCancel({ projectId, runId, now = new Date(), Model = ChatGptVisibilityRun }) {
  const queued = await Model.findOneAndUpdate(
    { _id: oid(runId), projectId: oid(projectId), status: 'queued' },
    { $set: { status: 'cancelled', completedAt: now, 'progress.stage': 'cancelled', cancelRequested: true } },
    { new: true },
  ).lean();
  if (queued) return { result: 'cancelled', run: queued };
  const running = await Model.findOneAndUpdate(
    { _id: oid(runId), projectId: oid(projectId), status: 'running' },
    { $set: { cancelRequested: true } },
    { new: true },
  ).lean();
  if (running) return { result: 'cancel_requested', run: running };
  const existing = await Model.findOne({ _id: oid(runId), projectId: oid(projectId) }).lean();
  return existing ? { result: 'not_cancellable', run: existing } : { result: 'not_found', run: null };
}

export function getRun({ projectId, runId, Model = ChatGptVisibilityRun }) {
  if (!mongoose.isValidObjectId(runId)) return Promise.resolve(null);
  return Model.findOne({ _id: oid(runId), projectId: oid(projectId) }).lean();
}

export function getLatestRun({ projectId, Model = ChatGptVisibilityRun }) {
  return Model.findOne({ projectId: oid(projectId), status: { $in: ['completed', 'partial', 'failed'] } }).sort({ createdAt: -1 }).lean();
}

/** Finished approved-question runs (completed or partial) in a date range, oldest first: the points of the trend chart. */
export function listApprovedRunsInRange({ projectId, from = null, to = null, limit = 100, Model = ChatGptVisibilityRun }) {
  const q = { projectId: oid(projectId), executionMode: 'approved_questions', status: { $in: ['completed', 'partial'] } };
  if (from || to) q.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  return Model.find(q).select('status createdAt completedAt questionSetId questionSetVersion metrics questionStats').sort({ createdAt: 1 }).limit(limit).lean();
}

/** The latest finished approved-question run (completed or partial): what the overview card is built from. */
export function getLatestApprovedRun({ projectId, Model = ChatGptVisibilityRun }) {
  return Model.findOne({ projectId: oid(projectId), executionMode: 'approved_questions', status: { $in: ['completed', 'partial'] } }).sort({ createdAt: -1 }).select('-questionSnapshot').lean();
}

export function getActiveRun({ projectId, Model = ChatGptVisibilityRun }) {
  return Model.findOne({ projectId: oid(projectId), status: { $in: ACTIVE_STATUSES } }).lean();
}

export async function listRuns({ projectId, limit = 10, skip = 0, Model = ChatGptVisibilityRun }) {
  const filter = { projectId: oid(projectId) };
  const [items, total] = await Promise.all([
    Model.find(filter).select('-executions -questionSnapshot').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Model.countDocuments(filter),
  ]);
  return { items, total };
}

export default { createRun, claimRun, renewLease, initializeRun, setApprovedTarget, saveExecution, updateProgress, finalizeRun, findExhausted, finalizeAbandoned, requestCancel, getRun, getLatestRun, getLatestApprovedRun, getActiveRun, listRuns, countLiveRunning };
