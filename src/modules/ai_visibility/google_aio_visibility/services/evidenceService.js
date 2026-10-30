import mongoose from 'mongoose';
import GoogleAioEvidence from '../models/GoogleAioEvidence.js';

/**
 * Evidence persistence for Google AI Overview runs. One document per (run, question); every state change is a conditional update so a
 * question is sent by exactly one worker and its result can never be overwritten.
 *
 *   ensureEvidence   idempotent: creates the five pending documents ($setOnInsert, unique index)
 *   claimQuestion    pending -> running (atomic; null when someone else has it or it is final)
 *   saveResult       running -> succeeded | failed, only for the worker that claimed it
 *   skipQuestion / skipPending   pending -> skipped, with the reason
 *   resetInterrupted / failInterrupted   recovery of questions a dead worker had `running`
 */

const oid = (v) => (v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(String(v)));
const FINAL = ['succeeded', 'failed', 'skipped', 'cancelled'];

export async function ensureEvidence({ run, retainUntil = null, Model = GoogleAioEvidence }) {
  const ops = run.questionSnapshot.map((q, i) => ({
    updateOne: {
      filter: { runId: run._id, questionId: q.questionId },
      update: {
        $setOnInsert: {
          provider: 'google_aio', runId: run._id, projectId: run.projectId, questionSetId: run.questionSetId, questionSetVersion: run.questionSetVersion,
          questionId: q.questionId, position: i + 1, questionText: q.text, intent: q.intent, service: q.service ?? null, language: q.language || 'en',
          locationCode: run.serp.locationCode, locationName: run.serp.locationName ?? null, languageCode: run.serp.languageCode, device: run.serp.device, os: run.serp.os,
          status: 'pending', attempts: 0, retainUntil,
        },
      },
      upsert: true,
    },
  }));
  await Model.bulkWrite(ops, { ordered: false });
}

export const claimQuestion = ({ runId, questionId, workerId, now = new Date(), Model = GoogleAioEvidence }) => Model.findOneAndUpdate(
  { runId: oid(runId), questionId, status: 'pending' },
  { $set: { status: 'running', lockedBy: workerId, startedAt: now } },
  { new: true },
).lean();

/** Persist ONE result (owner only, only while the question is still `running` and claimed by this worker). */
export async function saveResult({ runId, questionId, workerId, patch, Model = GoogleAioEvidence }) {
  const res = await Model.updateOne(
    { runId: oid(runId), questionId, status: 'running', lockedBy: workerId },
    { $set: { ...patch, lockedBy: null } },
  );
  return res.modifiedCount === 1;
}

export const skipQuestion = ({ runId, questionId, errorCode, errorClass, skipCause = null, status = 'skipped', now = new Date(), Model = GoogleAioEvidence }) => Model.updateOne(
  { runId: oid(runId), questionId, status: 'pending' },
  { $set: { status, errorCode, errorClass, skipCause, completedAt: now } },
);

/** Every question still `pending` becomes terminal: `skipped` (never dispatched, with the reason) or `cancelled` (the run was cancelled). */
export const skipPending = ({ runId, errorCode, errorClass, skipCause = null, status = 'skipped', now = new Date(), Model = GoogleAioEvidence }) => Model.updateMany(
  { runId: oid(runId), status: 'pending' },
  { $set: { status, errorCode, errorClass, skipCause, completedAt: now } },
);

/** A new owner takes over: questions the previous (dead) owner had `running` go back to `pending`. */
export const resetInterrupted = ({ runId, Model = GoogleAioEvidence }) => Model.updateMany(
  { runId: oid(runId), status: 'running' },
  { $set: { status: 'pending', lockedBy: null }, $inc: { attempts: 0 } },
);

/** No owner will ever come back: record the interrupted questions as failed. */
export const failInterrupted = ({ runId, now = new Date(), Model = GoogleAioEvidence }) => Model.updateMany(
  { runId: oid(runId), status: 'running' },
  { $set: { status: 'failed', lockedBy: null, errorCode: 'WORKER_INTERRUPTED', errorClass: 'retryable', retryable: true, costStatus: 'unknown', completedAt: now } },
);

export const listPending = ({ runId, Model = GoogleAioEvidence }) => Model.find({ runId: oid(runId), status: 'pending' }).sort({ position: 1 }).select('questionId position').lean();

export async function getRunCounters({ runId, Model = GoogleAioEvidence }) {
  const rows = await Model.aggregate([
    { $match: { runId: oid(runId) } },
    { $group: { _id: '$status', n: { $sum: 1 }, cost: { $sum: { $ifNull: ['$cost', 0] } }, known: { $sum: { $cond: [{ $isNumber: '$cost' }, 1, 0] } } } },
  ]);
  const stats = { total: 0, succeeded: 0, failed: 0, skipped: 0, cancelled: 0, pending: 0 };
  let amount = 0;
  let known = 0;
  let unknownCount = 0;
  for (const r of rows) {
    stats.total += r.n;
    if (r._id === 'succeeded' || r._id === 'failed' || r._id === 'skipped' || r._id === 'cancelled') stats[r._id] = r.n;
    else stats.pending += r.n; // pending + running are both "not settled"
    amount += r.cost;
    known += r.known;
    if (r._id === 'succeeded') unknownCount += r.n - r.known;
  }
  return { stats, cost: { amount: known > 0 ? Math.round(amount * 1e6) / 1e6 : null, unknownCount } };
}

export const loadForMetrics = ({ runId, Model = GoogleAioEvidence }) => Model.find({ runId: oid(runId) }).sort({ position: 1 }).lean();

// ── read side (always project-scoped) ──
export function listEvidence({ projectId, runId, status = null, Model = GoogleAioEvidence }) {
  const filter = { projectId: oid(projectId), runId: oid(runId) };
  if (['succeeded', 'failed', 'skipped', 'cancelled', 'pending', 'running'].includes(status)) filter.status = status;
  return Model.find(filter).sort({ position: 1 }).lean();
}

export function getEvidence({ projectId, runId, questionId, Model = GoogleAioEvidence }) {
  if (!mongoose.isValidObjectId(runId)) return Promise.resolve(null);
  return Model.findOne({ projectId: oid(projectId), runId: oid(runId), questionId }).lean();
}

export const listQuestionHistory = ({ projectId, questionId, limit = 20, Model = GoogleAioEvidence }) => (
  Model.find({ projectId: oid(projectId), questionId, status: { $in: FINAL } }).sort({ createdAt: -1 }).limit(limit).lean()
);

export default { ensureEvidence, claimQuestion, saveResult, skipQuestion, skipPending, resetInterrupted, failInterrupted, listPending, getRunCounters, loadForMetrics, listEvidence, getEvidence, listQuestionHistory };
