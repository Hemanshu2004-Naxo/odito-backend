/**
 * investigationStore — persistence for investigations. Every read is scoped by projectId (tenant boundary).
 * The orchestrator only sees this interface, so tests can use createMemoryStore().
 *
 * Writes that must not resurrect or overwrite a finished run use `updateIfActive` (compare-and-set on status), so an abandoned
 * in-flight pipeline can never overwrite a `cancelled` / `failed` row with a late result.
 */

import mongoose from 'mongoose';
import Investigation from '../model/Investigation.js';

const oid = (id) => new mongoose.Types.ObjectId(String(id));
const ACTIVE = ['queued', 'running'];
export const isDuplicateKeyError = (e) => e && (e.code === 11000 || /E11000/.test(e.message || ''));

export function createMongoStore() {
  return {
    /** Creates the run. Throws a duplicate-key error when an active run for the same project+key exists. */
    async create(doc) {
      return (await Investigation.create({ ...doc, activeKey: doc.requestKey, projectId: oid(doc.projectId), userId: oid(doc.userId) })).toObject();
    },
    async update(id, projectId, patch) {
      return Investigation.findOneAndUpdate({ _id: oid(id), projectId: oid(projectId) }, { $set: patch }, { new: true }).lean();
    },
    /** Applies `patch` only while the run is still queued/running. Terminal patches should include `activeKey: null`. Returns null if not applied. */
    async updateIfActive(id, projectId, patch) {
      return Investigation.findOneAndUpdate({ _id: oid(id), projectId: oid(projectId), status: { $in: ACTIVE } }, { $set: patch }, { new: true }).lean();
    },
    async findById(id, projectId) {
      if (!mongoose.isValidObjectId(id)) return null;
      return Investigation.findOne({ _id: oid(id), projectId: oid(projectId) }).lean();
    },
    async findActiveByKey(projectId, requestKey) {
      return Investigation.findOne({ projectId: oid(projectId), requestKey, status: { $in: ACTIVE } }).sort({ createdAt: -1 }).lean();
    },
    async findLatestByKey(projectId, requestKey) {
      return Investigation.findOne({ projectId: oid(projectId), requestKey }).sort({ createdAt: -1 }).lean();
    },
    /** Active runs whose last write is older than `olderThanMs` (heartbeat = every progress write). Used for crash recovery. */
    async findStale(olderThanMs, now = Date.now()) {
      return Investigation.find({ status: { $in: ACTIVE }, updatedAt: { $lt: new Date(now - olderThanMs) } }).select('_id projectId').lean();
    },
    // ── approval (compare-and-set; see approvalService) ──
    async setApproval(id, projectId, approval) {
      return Investigation.findOneAndUpdate({ _id: oid(id), projectId: oid(projectId), status: 'completed', 'approval.consumedAt': null }, { $set: { approval } }, { new: true }).lean();
    },
    async claimApproval(id, projectId, fingerprint, taskId, at) {
      return Investigation.findOneAndUpdate(
        { _id: oid(id), projectId: oid(projectId), status: 'completed', 'approval.fingerprint': fingerprint, 'approval.consumedAt': null, 'approval.invalidatedAt': null },
        { $set: { 'approval.consumedAt': at, 'approval.consumedByTaskId': String(taskId) } }, { new: true },
      ).lean();
    },
    async releaseApproval(id, projectId, fingerprint, taskId, failure = null) {
      return Investigation.findOneAndUpdate(
        { _id: oid(id), projectId: oid(projectId), 'approval.fingerprint': fingerprint, 'approval.consumedByTaskId': String(taskId) },
        { $set: { 'approval.consumedAt': null, 'approval.consumedByTaskId': null, ...(failure ? { 'approval.lastFailure': { at: new Date(), code: String(failure.code || 'APPLY_FAILED').slice(0, 60), message: String(failure.message || '').slice(0, 300), taskId: String(taskId) } } : {}) } }, { new: true },
      ).lean();
    },
    /** A new investigation for the same page makes every earlier unconsumed approval void. */
    async invalidateOlderApprovals(projectId, requestKey, exceptId, at) {
      const r = await Investigation.updateMany(
        { projectId: oid(projectId), requestKey, _id: { $ne: oid(exceptId) }, 'approval.fingerprint': { $exists: true }, 'approval.consumedAt': null, 'approval.invalidatedAt': null },
        { $set: { 'approval.invalidatedAt': at } },
      );
      return r.modifiedCount || 0;
    },
    async ensureIndexes() { await Investigation.init(); },
  };
}

/** Same interface, in memory (tests). Emulates the unique active-key guarantee. */
export function createMemoryStore({ now = () => Date.now() } = {}) {
  const rows = new Map(); let seq = 0;
  const clone = (r) => (r ? JSON.parse(JSON.stringify(r)) : null);
  const touch = (r) => { r.updatedAt = new Date(now()).toISOString(); };
  return {
    rows,
    async create(doc) {
      const dup = [...rows.values()].find((r) => String(r.projectId) === String(doc.projectId) && r.activeKey && r.activeKey === doc.requestKey);
      if (dup) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      seq += 1; const _id = `inv${seq}`;
      const row = { ...clone(doc), activeKey: doc.requestKey, _id, createdAt: new Date(now()).toISOString() }; touch(row); rows.set(_id, row); return clone(row);
    },
    async update(id, projectId, patch) {
      const row = rows.get(String(id)); if (!row || String(row.projectId) !== String(projectId)) return null;
      Object.assign(row, clone(patch)); touch(row); return clone(row);
    },
    async updateIfActive(id, projectId, patch) {
      const row = rows.get(String(id)); if (!row || String(row.projectId) !== String(projectId) || !ACTIVE.includes(row.status)) return null;
      Object.assign(row, clone(patch)); touch(row); return clone(row);
    },
    async findById(id, projectId) { const r = rows.get(String(id)); return r && String(r.projectId) === String(projectId) ? clone(r) : null; },
    async findActiveByKey(projectId, key) {
      return clone([...rows.values()].reverse().find((r) => String(r.projectId) === String(projectId) && r.requestKey === key && ACTIVE.includes(r.status)));
    },
    async findLatestByKey(projectId, key) { return clone([...rows.values()].reverse().find((r) => String(r.projectId) === String(projectId) && r.requestKey === key)); },
    async findStale(olderThanMs, at = now()) {
      return [...rows.values()].filter((r) => ACTIVE.includes(r.status) && Date.parse(r.updatedAt) < at - olderThanMs).map((r) => ({ _id: r._id, projectId: r.projectId }));
    },
    async setApproval(id, projectId, approval) {
      const row = rows.get(String(id)); if (!row || String(row.projectId) !== String(projectId) || row.status !== 'completed' || row.approval?.consumedAt) return null;
      row.approval = clone(approval); touch(row); return clone(row);
    },
    async claimApproval(id, projectId, fingerprint, taskId, at) {
      const row = rows.get(String(id));
      if (!row || String(row.projectId) !== String(projectId) || row.status !== 'completed' || row.approval?.fingerprint !== fingerprint || row.approval.consumedAt || row.approval.invalidatedAt) return null;
      row.approval.consumedAt = new Date(at).toISOString(); row.approval.consumedByTaskId = String(taskId); touch(row); return clone(row);
    },
    async releaseApproval(id, projectId, fingerprint, taskId, failure = null) {
      const row = rows.get(String(id));
      if (!row || String(row.projectId) !== String(projectId) || row.approval?.fingerprint !== fingerprint || row.approval.consumedByTaskId !== String(taskId)) return null;
      row.approval.consumedAt = null; row.approval.consumedByTaskId = null;
      if (failure) row.approval.lastFailure = { at: new Date(now()).toISOString(), code: String(failure.code || 'APPLY_FAILED'), message: String(failure.message || ''), taskId: String(taskId) };
      touch(row); return clone(row);
    },
    async invalidateOlderApprovals(projectId, requestKey, exceptId, at) {
      let n = 0;
      for (const row of rows.values()) {
        if (String(row.projectId) === String(projectId) && row.requestKey === requestKey && String(row._id) !== String(exceptId) && row.approval?.fingerprint && !row.approval.consumedAt && !row.approval.invalidatedAt) { row.approval.invalidatedAt = new Date(at).toISOString(); n += 1; }
      }
      return n;
    },
    async ensureIndexes() {},
  };
}

export default { createMongoStore, createMemoryStore, isDuplicateKeyError };
