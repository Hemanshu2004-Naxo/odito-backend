import mongoose from 'mongoose';
import GoogleAioRun from '../models/GoogleAioRun.js';
import { getGoogleAioConfig } from '../config/googleAioConfig.js';

/**
 * Persistence and state transitions for Google AI Overview runs. Every transition is ONE conditional database update, so two
 * workers (or a worker and the recovery sweep) can never both win. Nothing here calls a provider.
 */

export const ACTIVE_STATUSES = Object.freeze(['queued', 'running']);
export const TERMINAL_STATUSES = Object.freeze(['completed', 'partial', 'failed', 'cancelled']);

const isDuplicateKey = (e) => e && (e.code === 11000 || e.code === 11001);
const oid = (v) => (v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(String(v)));

/**
 * Create a queued run. The partial unique index refuses a second active run for the project.
 * @returns {Promise<{created:true,run:object}|{created:false,activeRun:object}>}
 */
export async function createRun({ projectId, userId, questionSetId, questionSetVersion, selectionMode, questionSnapshot, serp, policy }, { Model = GoogleAioRun } = {}) {
  try {
    const doc = await Model.create({
      projectId: oid(projectId), userId: oid(userId), questionSetId: oid(questionSetId), questionSetVersion, selectionMode,
      questionSnapshot, serp, policy,
      status: 'queued',
      progress: { completed: 0, total: questionSnapshot.length, stage: 'queued' },
      questionStats: { total: questionSnapshot.length, succeeded: 0, failed: 0, skipped: 0, pending: questionSnapshot.length },
    });
    return { created: true, run: doc.toObject() };
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const activeRun = await Model.findOne({ projectId: oid(projectId), status: { $in: ACTIVE_STATUSES } }).lean();
    if (activeRun) return { created: false, activeRun };
    throw error;
  }
}

/** Atomically claim the next eligible run (or a specific one): `queued`, or `running` with an expired lease, within the claim budget. */
export function claimRun({ runId = null, workerId, now = new Date(), config = getGoogleAioConfig(), Model = GoogleAioRun }) {
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

export async function renewLease({ runId, workerId, now = new Date(), config = getGoogleAioConfig(), Model = GoogleAioRun }) {
  const doc = await Model.findOneAndUpdate(
    { _id: oid(runId), lockedBy: workerId, status: 'running' },
    { $set: { 'lease.expiresAt': new Date(now.getTime() + config.leaseMs), heartbeatAt: now } },
    { new: true, projection: { cancelRequested: 1 } },
  ).lean();
  return { owned: Boolean(doc), cancelRequested: Boolean(doc?.cancelRequested) };
}

export const countLiveRunning = ({ now = new Date(), Model = GoogleAioRun } = {}) => Model.countDocuments({ status: 'running', 'lease.expiresAt': { $gte: now } });

/** Store the measurement target and market (owner only, once). A recovered run keeps the target it started with. */
export async function setTarget({ runId, workerId, target, market, Model = GoogleAioRun }) {
  const res = await Model.updateOne({ _id: oid(runId), lockedBy: workerId, status: 'running', target: null }, { $set: { target, market } });
  return res.modifiedCount === 1;
}

export async function updateProgress({ runId, workerId, completed, total, stage, totalCost, questionStats, Model = GoogleAioRun }) {
  const set = { 'progress.completed': completed, 'progress.total': total, 'progress.stage': stage };
  if (totalCost) set.totalCost = totalCost;
  if (questionStats) set.questionStats = questionStats;
  await Model.updateOne({ _id: oid(runId), lockedBy: workerId, status: 'running' }, { $set: set });
}

/** Finalize (owner only). Releases the lease. Returns the final document or null when ownership was lost. */
export function finalizeRun({ runId, workerId, status, metrics, totalCost, questionStats, failureCode = null, failureMessage = null, now = new Date(), Model = GoogleAioRun }) {
  const failed = status === 'failed';
  return Model.findOneAndUpdate(
    { _id: oid(runId), lockedBy: workerId, status: 'running' },
    {
      $set: {
        status, metrics, totalCost, ...(questionStats ? { questionStats, 'progress.completed': questionStats.total - questionStats.pending } : {}),
        failureCode, failureMessage,
        completedAt: failed ? null : now, failedAt: failed ? now : null,
        lockedBy: null, 'lease.expiresAt': null, 'progress.stage': status,
      },
    },
    { new: true },
  ).lean();
}

/** Runs whose lease expired and whose claim budget is used up: nobody will ever claim them again. */
export const findExhausted = ({ now = new Date(), config = getGoogleAioConfig(), limit = 20, Model = GoogleAioRun }) => (
  Model.find({ status: 'running', 'lease.expiresAt': { $lt: now }, attempts: { $gte: config.maxClaims } }).limit(limit).lean()
);

/** Finalize a run no worker owns any more (recovery path), conditional on the same expired-lease state it was found in. */
export function finalizeAbandoned({ run, status, metrics, totalCost, questionStats, failureCode, failureMessage, now = new Date(), Model = GoogleAioRun }) {
  return Model.findOneAndUpdate(
    { _id: run._id, status: 'running', 'lease.expiresAt': run.lease.expiresAt },
    {
      $set: {
        status, metrics, totalCost, questionStats, 'progress.completed': questionStats.total - questionStats.pending, failureCode, failureMessage,
        completedAt: status === 'failed' ? null : now, failedAt: status === 'failed' ? now : null,
        lockedBy: null, 'lease.expiresAt': null, 'progress.stage': status,
      },
    },
    { new: true },
  ).lean();
}

/** Cancel. A queued run is cancelled at once; a running run gets `cancelRequested` and its owner finalizes it between questions. */
export async function requestCancel({ projectId, runId, now = new Date(), Model = GoogleAioRun }) {
  const queued = await Model.findOneAndUpdate(
    { _id: oid(runId), projectId: oid(projectId), status: 'queued' },
    { $set: { status: 'cancelled', completedAt: now, 'progress.stage': 'cancelled', cancelRequested: true } },
    { new: true },
  ).lean();
  if (queued) return { result: 'cancelled', run: queued };
  const running = await Model.findOneAndUpdate({ _id: oid(runId), projectId: oid(projectId), status: 'running' }, { $set: { cancelRequested: true } }, { new: true }).lean();
  if (running) return { result: 'cancel_requested', run: running };
  const existing = await Model.findOne({ _id: oid(runId), projectId: oid(projectId) }).lean();
  return existing ? { result: 'not_cancellable', run: existing } : { result: 'not_found', run: null };
}

export function getRun({ projectId, runId, Model = GoogleAioRun }) {
  if (!mongoose.isValidObjectId(runId)) return Promise.resolve(null);
  return Model.findOne({ _id: oid(runId), projectId: oid(projectId) }).lean();
}

/** The latest run that produced results (completed or partial): what the overview is built from. */
export const getLatestFinishedRun = ({ projectId, Model = GoogleAioRun }) => (
  Model.findOne({ projectId: oid(projectId), status: { $in: ['completed', 'partial'] } }).sort({ createdAt: -1 }).lean()
);
export const getLatestRun = ({ projectId, Model = GoogleAioRun }) => (
  Model.findOne({ projectId: oid(projectId), status: { $in: TERMINAL_STATUSES } }).sort({ createdAt: -1 }).lean()
);
export const getActiveRun = ({ projectId, Model = GoogleAioRun }) => Model.findOne({ projectId: oid(projectId), status: { $in: ACTIVE_STATUSES } }).lean();

export async function listRuns({ projectId, limit = 10, skip = 0, Model = GoogleAioRun }) {
  const filter = { projectId: oid(projectId) };
  const [items, total] = await Promise.all([
    Model.find(filter).select('-questionSnapshot').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Model.countDocuments(filter),
  ]);
  return { items, total };
}

/** Finished runs in a date range, oldest first: the points of a trend chart. */
export const listFinishedRunsInRange = ({ projectId, from = null, to = null, limit = 100, Model = GoogleAioRun }) => {
  const q = { projectId: oid(projectId), status: { $in: ['completed', 'partial'] } };
  if (from || to) q.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  return Model.find(q).select('status createdAt completedAt questionSetVersion metrics').sort({ createdAt: 1 }).limit(limit).lean();
};

export async function countRunsSince({ projectId, since, Model = GoogleAioRun }) {
  return Model.countDocuments({ projectId: oid(projectId), createdAt: { $gte: since } });
}

export default { createRun, claimRun, renewLease, setTarget, updateProgress, finalizeRun, findExhausted, finalizeAbandoned, requestCancel, getRun, getLatestRun, getLatestFinishedRun, getActiveRun, listRuns, countLiveRunning };
