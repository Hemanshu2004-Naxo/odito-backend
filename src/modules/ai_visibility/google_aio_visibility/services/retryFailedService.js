import mongoose from 'mongoose';
import GoogleAioRun from '../models/GoogleAioRun.js';
import GoogleAioEvidence from '../models/GoogleAioEvidence.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';
import { getGoogleAioConfig } from '../config/googleAioConfig.js';
import { emitGoogleAioEvent } from './events.js';
import { kick } from '../workers/runWorker.js';

/**
 * Retry ONLY the questions of a finished run whose request failed.
 *
 * It re-opens the SAME run (same five questions, same target, same market) rather than creating a new one: the failed evidence
 * documents go back to `pending`, the run goes back to `queued`, and the existing worker then sends exactly the pending questions
 * (succeeded / skipped / cancelled ones are never touched or re-billed). When it finishes, the run's metrics are recomputed from all
 * five stored results, so the dashboard figures include the recovered answers.
 *
 * Order matters for safety: the run is moved first, conditionally. The partial unique index "one active run per project" refuses the
 * move when another run is in progress, and nothing has been changed yet. A crash between the two writes is harmless: the worker finds
 * nothing pending and simply re-finalizes from the stored results.
 *
 * The previous failure of each question is kept in `retryHistory`, so a retry never erases the diagnostics of what went wrong.
 */

export const MAX_RETRY_ROUNDS = 3;
const RETRYABLE_RUN_STATUSES = ['partial', 'failed'];
const oid = (v) => (v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(String(v)));
const isDuplicateKey = (e) => e && (e.code === 11000 || e.code === 11001);
const refuse = (reason, extra = {}) => ({ scheduled: false, reason, ...extra });

export async function retryFailedQuestions({ projectId, runId, now = () => new Date() }, deps = {}) {
  const config = deps.config || getGoogleAioConfig();
  const Run = deps.Model || GoogleAioRun;
  const Evidence = deps.EvidenceModel || GoogleAioEvidence;
  if (!config.enabled) return refuse('DISABLED');
  if (!mongoose.isValidObjectId(runId)) return refuse('RUN_NOT_FOUND');

  const run = await Run.findOne({ _id: oid(runId), projectId: oid(projectId) }).lean();
  if (!run) return refuse('RUN_NOT_FOUND');
  if (!RETRYABLE_RUN_STATUSES.includes(run.status)) {
    const active = ['queued', 'running'].includes(run.status);
    return refuse(active ? 'ACTIVE_RUN_EXISTS' : 'RUN_NOT_RETRYABLE', { run });
  }
  if ((run.retryCount || 0) >= MAX_RETRY_ROUNDS) return refuse('RETRY_LIMIT_REACHED', { run, limit: MAX_RETRY_ROUNDS });

  const failed = await Evidence.find({ runId: run._id, status: 'failed' }).lean();
  if (!failed.length) return refuse('NO_FAILED_QUESTIONS', { run });

  let moved;
  try {
    moved = await Run.findOneAndUpdate(
      { _id: run._id, projectId: oid(projectId), status: { $in: RETRYABLE_RUN_STATUSES },
        // `$not $gte` (not `$lt`): runs created before this field existed have NO retryCount and must stay retryable.
        retryCount: { $not: { $gte: MAX_RETRY_ROUNDS } } },
      {
        $set: {
          status: 'queued', attempts: 0, lockedBy: null, 'lease.expiresAt': null, cancelRequested: false,
          failureCode: null, failureMessage: null, failedAt: null, 'progress.stage': 'queued',
          'progress.completed': Math.max(0, (run.progress?.total ?? run.questionSnapshot.length) - failed.length),
        },
        $inc: { retryCount: 1 },
      },
      { new: true },
    ).lean();
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const activeRun = await Run.findOne({ projectId: oid(projectId), status: { $in: ['queued', 'running'] } }).lean();
    return refuse('ACTIVE_RUN_EXISTS', { run: activeRun });
  }
  if (!moved) return refuse('RUN_NOT_RETRYABLE', { run });

  const at = now();
  for (const e of failed) {
    await Evidence.updateOne(
      { _id: e._id, status: 'failed' },
      {
        $push: { retryHistory: { failedAt: e.completedAt ?? null, retriedAt: at, errorCode: e.errorCode ?? null, errorClass: e.errorClass ?? null, attempts: e.attempts ?? 0, diagnostics: e.diagnostics ?? null } },
        $set: {
          status: 'pending', lockedBy: null, attempts: 0, serp: {}, request: null, providerRequestId: null, cost: null, costStatus: 'unknown', costUnit: null,
          diagnostics: null, skipCause: null, errorCode: null, errorClass: null, retryable: null, startedAt: null, completedAt: null, durationMs: null,
          analysis: null, analysisStatus: null, analysisVersion: null,
          aiOverview: { present: null, asyncRequested: null, asynchronous: null, text: null, markdown: null, elements: [], references: [], rejectedReferences: 0 },
        },
      },
    );
  }

  LoggerUtil.info('Google AI Overview visibility: retrying failed questions', { projectId: String(projectId), runId: String(run._id), questions: failed.length, round: moved.retryCount });
  (deps.emit || emitGoogleAioEvent)('started', moved);
  (deps.kick || kick)(String(moved._id));
  return { scheduled: true, reason: null, run: moved, retried: failed.map((e) => e.questionId) };
}

export default { retryFailedQuestions, MAX_RETRY_ROUNDS };
