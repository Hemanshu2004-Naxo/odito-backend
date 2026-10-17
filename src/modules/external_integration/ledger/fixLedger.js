/**
 * fixLedger — the parts of the WordPressFixRecord ledger every typed WordPress fix shares: claiming a record exactly once per plan
 * (idempotency), recognising an abandoned in-flight record, deciding what a failed write call tells us, and describing the record
 * for the API. Fix-specific logic (what is written, how it is verified) stays in each fix's service.
 */

import crypto from 'crypto';
import { FIX_ACTIVE_STATUSES } from '../model/WordPressFixRecord.js';

export const STALE_APPLYING_MS = 5 * 60 * 1000;

/**
 * How long an approval can still be RESUMED after a crash. Within this window a half-finished apply may be completed with the
 * remaining fields of the SAME approved plan; after it the written fields are put back and a fresh approval is required —
 * an approval is never silently honoured hours later.
 */
export const RESUME_WINDOW_MS = 30 * 60 * 1000;

/** Statuses of a record whose write may still be happening, or whose outcome is not known. */
export const IN_FLIGHT_STATUSES = Object.freeze(['applying', 'apply_uncertain']);

export const idempotencyKey = (...parts) => crypto.createHash('sha256').update(parts.map(String).join('|')).digest('hex');

/** true when an `applying` record has not been touched for long enough that its worker is presumed dead. */
export function isAbandoned(record, now = new Date()) {
  if (!record) return false;
  if (record.status === 'apply_uncertain') return true; // already known to need reconciliation
  if (record.status !== 'applying') return false;
  const touched = record.updatedAt ? new Date(record.updatedAt).getTime() : 0;
  return now.getTime() - touched >= STALE_APPLYING_MS;
}

export function isResumable(record, now = new Date()) {
  const approved = record?.approvedAt ? new Date(record.approvedAt).getTime() : 0;
  return approved > 0 && now.getTime() - approved <= RESUME_WINDOW_MS;
}

const DEFINITE_FAILURE_CODES = new Set([
  'PERMISSION_DENIED', 'INVALID_CREDENTIALS', 'FIELD_NOT_WRITABLE', 'PLUGIN_NOT_SUPPORTED', 'VALIDATION_FAILED',
  'SITE_UNREACHABLE', 'SSL_ERROR', 'EXPECTED_STATE_REQUIRED',
]);

/**
 * What a failed write call proves:
 *   conflict   the Bridge refused it because the stored value was not the expected one -> nothing was written
 *   definite   the request was rejected or never reached WordPress -> nothing was written
 *   ambiguous  timeout, dropped connection, server error, anything unclassified -> WordPress MAY have committed the change
 * An ambiguous outcome is never answered by repeating the write: the live value is read and compared first.
 */
export function classifyWriteError(error) {
  const code = error?.code;
  if (code === 'CONFLICT') return 'conflict';
  if (DEFINITE_FAILURE_CODES.has(code)) return 'definite';
  if (code === 'WRITE_FAILED' && error?.statusCode === 422) return 'definite'; // a 4xx rejection (validation) from WordPress
  return 'ambiguous';
}

/**
 * Claims the record for `data.idempotencyKey`. A previous attempt of the SAME plan that ended in a non-active state (failed, rolled
 * back, validation) is revived. A record that is still in flight — or died mid-apply — is NEVER revived here: whether its writes
 * landed is a question for WordPress, so the caller reconciles it first (see `isAbandoned`).
 * @returns {{record: object, claimed: boolean}} claimed=false means somebody else holds it (read its status to decide what to say).
 */
export async function claimFixRecord(deps, data) {
  const reset = {
    ...data, status: 'applying', failure: { code: null, message: null },
    verification: { saved: { status: 'pending', reasons: [], fields: [] }, rendered: { status: 'pending', reasons: [], fields: [] } },
    rollback: { status: 'none', restoredFields: [], conflictFields: [] },
    appliedAt: null,
  };
  const revived = await deps.Record.findOneAndUpdate(
    { idempotencyKey: data.idempotencyKey, status: { $nin: FIX_ACTIVE_STATUSES } },
    { $set: reset },
    { new: true },
  );
  if (revived) return { record: revived, claimed: true };
  try {
    return { record: await deps.Record.create({ ...data, status: 'applying' }), claimed: true };
  } catch (e) {
    if (e?.code === 11000) return { record: await deps.Record.findOne({ idempotencyKey: data.idempotencyKey }), claimed: false };
    throw e;
  }
}

/** The newest record of this task+fix whose write may still be in flight (or whose outcome is unknown), if any. */
export async function findInFlightRecord(deps, { taskId, fixType }) {
  return deps.Record.findOne({ taskId, fixType, status: { $in: IN_FLIGHT_STATUSES } }).sort({ createdAt: -1 });
}

export function describeFixRecord(record) {
  if (!record) return null;
  return {
    id: record._id,
    status: record.status,
    approvedAt: record.approvedAt,
    appliedAt: record.appliedAt,
    target: record.target || null,
    changes: (record.changes || []).map((c) => ({
      field: c.field, before: c.before, after: c.after, applied: c.applied, restored: c.restored,
      writeState: c.writeState || 'pending', attribution: c.attribution || null, atomic: c.atomic ?? null, writeMode: c.writeMode || null,
    })),
    verification: { saved: record.verification?.saved || null, rendered: record.verification?.rendered || null },
    rollback: record.rollback || { status: 'none' },
    failure: record.failure?.code ? record.failure : null,
  };
}

export default { STALE_APPLYING_MS, RESUME_WINDOW_MS, IN_FLIGHT_STATUSES, idempotencyKey, isAbandoned, isResumable, classifyWriteError, claimFixRecord, findInFlightRecord, describeFixRecord };
