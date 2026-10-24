import mongoose from 'mongoose';
import AiVisibilityEvidence, { EVIDENCE_STATUS, EVIDENCE_SCHEMA_VERSION } from '../models/AiVisibilityEvidence.js';

/**
 * Evidence persistence. Every function is one conditional database operation, so two workers (or a worker and the recovery sweep)
 * can never both write a question's result. Nothing here calls a provider.
 *
 * Known, unavoidable gap (no provider idempotency key is verified): a worker that dies AFTER the provider answered but BEFORE the result
 * is written leaves that question `running`; the next owner resets it to `pending` and asks again, so that one request is paid twice.
 * Completed (succeeded / failed / skipped) evidence is never re-asked.
 */

const oid = (v) => (v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(String(v)));
const isDuplicateKey = (e) => e && (e.code === 11000 || e.code === 11001 || (Array.isArray(e.writeErrors) && e.writeErrors.every((w) => w.code === 11000)));

/**
 * Create one `pending` evidence document per snapshotted question. Idempotent (unique {runId, questionId}): a recovered run calls it
 * again and only missing documents are created.
 */
export async function ensureEvidence({ run, retainUntil = null, now = new Date(), Model = AiVisibilityEvidence }) {
  const docs = run.questionSnapshot.map((q) => ({
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    projectId: oid(run.projectId),
    runId: oid(run._id),
    provider: run.provider || 'chatgpt',
    questionSetId: oid(run.questionSetId),
    questionSetVersion: run.questionSetVersion,
    questionId: q.questionId,
    group: q.group,
    intent: q.intent,
    questionText: q.text,
    service: q.service ?? null,
    location: q.location ?? null,
    language: q.language || 'en',
    templateId: q.templateId ?? null,
    status: EVIDENCE_STATUS.PENDING,
    createdAt: now,
    retainUntil,
  }));
  try {
    await Model.insertMany(docs, { ordered: false });
  } catch (error) {
    if (!isDuplicateKey(error)) throw error; // some/all already existed: exactly what recovery expects
  }
}

/** A previous owner died holding these: they are asked again by the current owner (see the gap above). Returns how many were reset. */
export async function resetInterrupted({ runId, Model = AiVisibilityEvidence }) {
  const res = await Model.updateMany(
    { runId: oid(runId), status: EVIDENCE_STATUS.RUNNING },
    { $set: { status: EVIDENCE_STATUS.PENDING, claimedBy: null, claimedAt: null } },
  );
  return res.modifiedCount;
}

/**
 * Used when a run's claim budget is exhausted: questions a dead worker had taken were SENT (their result is unknown), so they are recorded
 * as failed - honest, not "skipped" - and are not asked again.
 */
export async function failInterrupted({ runId, now = new Date(), Model = AiVisibilityEvidence }) {
  const res = await Model.updateMany(
    { runId: oid(runId), status: EVIDENCE_STATUS.RUNNING },
    { $set: { status: EVIDENCE_STATUS.FAILED, errorCode: 'WORKER_INTERRUPTED', errorClass: 'retryable', retryable: true, costStatus: 'unknown', completedAt: now } },
  );
  return res.modifiedCount;
}

/** Evidence still to ask, in snapshot (question) order. */
export function listPending({ runId, Model = AiVisibilityEvidence }) {
  return Model.find({ runId: oid(runId), status: EVIDENCE_STATUS.PENDING }).sort({ _id: 1 }).select('questionId').lean();
}

/** Claim one question: pending -> running. null when it is no longer pending (someone else has it / it is final). */
export function claimQuestion({ runId, questionId, workerId, now = new Date(), Model = AiVisibilityEvidence }) {
  return Model.findOneAndUpdate(
    { runId: oid(runId), questionId, status: EVIDENCE_STATUS.PENDING },
    { $set: { status: EVIDENCE_STATUS.RUNNING, claimedBy: workerId, claimedAt: now, startedAt: now } },
    { new: true },
  ).lean();
}

/** Store a question's final result. Only the worker that claimed it, only while it is still `running`; a result is never overwritten. */
export async function saveResult({ runId, questionId, workerId, patch, Model = AiVisibilityEvidence }) {
  const res = await Model.updateOne(
    { runId: oid(runId), questionId, status: EVIDENCE_STATUS.RUNNING, claimedBy: workerId },
    { $set: patch },
  );
  return res.modifiedCount === 1;
}

/** Mark every still-pending question as deliberately not sent, with the reason. Returns how many. */
export async function skipPending({ runId, errorCode, errorClass, now = new Date(), Model = AiVisibilityEvidence }) {
  const res = await Model.updateMany(
    { runId: oid(runId), status: EVIDENCE_STATUS.PENDING },
    { $set: { status: EVIDENCE_STATUS.SKIPPED, errorCode, errorClass, completedAt: now } },
  );
  return res.modifiedCount;
}

/** Status counters + known cost for a run, from the database. */
export async function getRunCounters({ runId, Model = AiVisibilityEvidence }) {
  const rows = await Model.aggregate([
    { $match: { runId: oid(runId) } },
    {
      $group: {
        _id: '$status',
        n: { $sum: 1 },
        cost: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'succeeded'] }, { $isNumber: '$cost' }] }, '$cost', 0] } },
        known: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'succeeded'] }, { $isNumber: '$cost' }] }, 1, 0] } },
      },
    },
  ]);
  const by = Object.fromEntries(rows.map((r) => [r._id, r]));
  const n = (s) => by[s]?.n || 0;
  const succeeded = n('succeeded');
  const known = by.succeeded?.known || 0;
  return {
    stats: { total: rows.reduce((a, r) => a + r.n, 0), succeeded, failed: n('failed'), skipped: n('skipped'), pending: n('pending') + n('running') },
    cost: { amount: known ? Math.round((by.succeeded.cost) * 1e6) / 1e6 : null, knownCount: known, unknownCount: succeeded - known },
  };
}

/** Everything metrics need (no answer text), lean. */
export function loadForMetrics({ runId, Model = AiVisibilityEvidence }) {
  return Model.find({ runId: oid(runId) })
    .select('status group intent analysis citations firstPartyPages externalDomains cost questionId')
    .lean();
}

const LIST_FIELDS = '-answerText -annotations -citations -claimedBy -claimedAt -schemaVersion';

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ALLOWED_STATUS = new Set(Object.values(EVIDENCE_STATUS));

/**
 * Turn the (untrusted) query string into a MongoDB filter. Every value is type-checked and allow-listed; free text is escaped and
 * length-capped before it becomes a case-insensitive regex, so a search can never inject an operator or an expensive pattern.
 */
export function buildEvidenceFilter(filter = {}) {
  const q = {};
  if (typeof filter.status === 'string' && ALLOWED_STATUS.has(filter.status)) q.status = filter.status;
  if (filter.group === 'visibility' || filter.group === 'brand_reputation') q.group = filter.group;
  if (typeof filter.intent === 'string' && /^[a-z_]{1,40}$/.test(filter.intent)) q.intent = filter.intent;
  const bool = (v) => (v === 'true' || v === true ? true : v === 'false' || v === false ? false : undefined);
  const mentioned = bool(filter.mentioned);
  if (mentioned !== undefined) { q.status = 'succeeded'; q['analysis.brandMentioned'] = mentioned; }
  const recommended = bool(filter.recommended);
  if (recommended !== undefined) { q.status = 'succeeded'; q['analysis.recommended'] = recommended; }
  const cited = bool(filter.cited);
  if (cited !== undefined) { q.status = 'succeeded'; q['firstPartyPages.0'] = { $exists: cited }; }
  if (typeof filter.citedUrl === 'string' && filter.citedUrl.length <= 2000 && /^https:\/\//.test(filter.citedUrl)) q.firstPartyPages = filter.citedUrl;
  if (typeof filter.competitor === 'string' && filter.competitor.trim() && filter.competitor.length <= 100) q['analysis.competitorMentions.name'] = filter.competitor.trim();
  if (typeof filter.q === 'string' && filter.q.trim()) q.questionText = { $regex: escapeRegExp(filter.q.trim().slice(0, 100)), $options: 'i' };
  return q;
}

export async function listEvidence({ projectId, runId, filter = {}, limit = 20, skip = 0, Model = AiVisibilityEvidence }) {
  const q = { ...buildEvidenceFilter(filter), projectId: oid(projectId), runId: oid(runId) };
  const [items, total] = await Promise.all([
    Model.find(q).select(LIST_FIELDS).sort({ _id: 1 }).skip(skip).limit(limit).lean(),
    Model.countDocuments(q),
  ]);
  return { items, total };
}

export function getEvidence({ projectId, runId, questionId, Model = AiVisibilityEvidence }) {
  return Model.findOne({ projectId: oid(projectId), runId: oid(runId), questionId }).select('-claimedBy -claimedAt').lean();
}

/**
 * The website's most-cited pages, from stored evidence: one row per DISTINCT normalized first-party URL, with its citation occurrences
 * (repeats included), the number of distinct questions citing it, and the most recent citation. Scoped to the project, to one run or a
 * date range, and by default to discovery questions (brand diagnostic answers are reported separately).
 */
export async function aggregateCitedPages({ projectId, runId = null, from = null, to = null, group = 'visibility', limit = 25, Model = AiVisibilityEvidence }) {
  const match = { projectId: oid(projectId), status: EVIDENCE_STATUS.SUCCEEDED, group };
  if (runId) match.runId = oid(runId);
  if (from || to) match.completedAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const rows = await Model.aggregate([
    { $match: match },
    { $unwind: '$citations' },
    { $match: { 'citations.isTarget': true, 'citations.valid': { $ne: false }, 'citations.normalizedUrl': { $type: 'string' } } },
    {
      $group: {
        _id: '$citations.normalizedUrl',
        occurrences: { $sum: 1 },
        questions: { $addToSet: '$questionId' },
        runs: { $addToSet: '$runId' },
        lastCitedAt: { $max: '$completedAt' },
        title: { $first: '$citations.title' },
      },
    },
    { $project: { _id: 0, url: '$_id', occurrences: 1, questionCount: { $size: '$questions' }, runCount: { $size: '$runs' }, lastCitedAt: 1, title: 1 } },
    { $sort: { occurrences: -1, questionCount: -1, url: 1 } },
    { $limit: Math.min(100, Math.max(1, limit)) },
  ]);
  return rows;
}

/** One question's history across runs (and question-set versions) for a project. */
export function listQuestionHistory({ projectId, questionId, limit = 20, Model = AiVisibilityEvidence }) {
  return Model.find({ projectId: oid(projectId), questionId }).select(LIST_FIELDS).sort({ createdAt: -1 }).limit(limit).lean();
}

export default { aggregateCitedPages, buildEvidenceFilter, ensureEvidence, resetInterrupted, failInterrupted, listPending, claimQuestion, saveResult, skipPending, getRunCounters, loadForMetrics, listEvidence, getEvidence, listQuestionHistory };
