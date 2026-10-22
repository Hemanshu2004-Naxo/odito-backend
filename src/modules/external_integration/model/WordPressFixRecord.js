import mongoose from 'mongoose';

/**
 * WordPressFixRecord — the audit + recovery ledger for ONE approved WordPress schema fix.
 *
 * The Task already owns the user-facing lifecycle (task_created -> implemented -> verified_fixed) and the
 * crawler-based verification. What a Task cannot hold is what a multi-field site-wide write needs to be
 * safe and recoverable: the exact before/after of every field changed, who approved it, a key that makes a
 * duplicate request a no-op, the saved-state and rendered-page verification results kept SEPARATE, and the
 * rollback outcome. That is all this record is — it never replaces the Task and is never read to decide
 * whether an issue is fixed (only the crawler does that).
 *
 * Lifecycle (`status`):
 *   proposed -> validated -> awaiting_approval -> approved -> applying -> applied -> verifying -> verified
 * Failure states: validation_failed, permission_denied, conflict_detected, apply_failed, verification_failed, unsupported.
 * `rolled_back` is terminal and set only by an explicit rollback.
 *
 * Only the minimum is stored: field names, the small scalar values changed (name, logo URL, type, ...), identifiers.
 * Never credentials, page content, or a WordPress response body.
 */

export const FIX_STATUSES = Object.freeze([
  'proposed', 'validated', 'awaiting_approval', 'approved', 'applying', 'applied', 'verifying', 'verified',
  'validation_failed', 'permission_denied', 'conflict_detected', 'apply_failed', 'verification_failed', 'unsupported',
  'rolled_back',
  // The write was sent but its outcome could not be established (timeout / dropped connection) AND WordPress could not be
  // re-read to find out. Nothing is repeated blindly: the next apply / reverify / rollback reconciles real state first.
  'apply_uncertain',
]);

/** Statuses in which the same plan must NOT be executed again (idempotency). */
export const FIX_ACTIVE_STATUSES = Object.freeze(['applying', 'apply_uncertain', 'applied', 'verifying', 'verified', 'verification_failed']);

const changeSchema = new mongoose.Schema({
  field: { type: String, required: true },
  before: { type: String, default: '' },
  after: { type: String, default: '' },
  source: { type: String, default: null },
  // Set once the field was actually written / restored — what rollback and partial-failure recovery act on.
  applied: { type: Boolean, default: false },
  restored: { type: Boolean, default: false },
  // Crash-recovery bookkeeping, persisted BEFORE a write is sent so a crash leaves evidence of what was attempted:
  //   in_flight -> landed | not_written | unknown ; `attribution` says how `applied` was established
  //   (response = WordPress confirmed it; reconciled = a timeout/crash, then the live value was found to equal Odito's).
  writeState: { type: String, enum: ['pending', 'in_flight', 'landed', 'not_written', 'unknown'], default: 'pending' },
  attempts: { type: Number, default: 0 },
  startedAt: { type: Date, default: null },
  attribution: { type: String, enum: [null, 'response', 'reconciled'], default: null },
  operationId: { type: String, default: null },
  // true only when the Bridge reported a database-level conditional UPDATE. false/null = it was not (see writeMode).
  atomic: { type: Boolean, default: null },
  // How the value was really written, never rounded up:
  //   conditional_update  one conditional UPDATE of an existing row (the expected value is compared inside the statement)
  //   conditional_insert  the row did not exist: created only if still absent (check-then-insert; never overwrites, but not one atomic step)
  //   read_then_write     the value was read, compared and then written separately (no Bridge 1.5.0, or the core REST fallback)
  writeMode: { type: String, enum: [null, 'conditional_update', 'conditional_insert', 'read_then_write'], default: null },
  restoreState: { type: String, enum: [null, 'restored', 'already_restored', 'conflict'], default: null },
}, { _id: false });

const verificationPartSchema = new mongoose.Schema({
  status: { type: String, enum: ['pending', 'verified', 'failed', 'unverifiable'], default: 'pending' },
  // pending      = nothing can be said yet (e.g. no crawl newer than the write) - a later recrawl will settle it
  // unverifiable = it was looked at and cannot be judged (asset unreachable, page missing) - NOT a failure
  // failed       = the state was observed and is wrong
  reasonCode: { type: String, default: null },
  attempts: { type: Number, default: 0 },
  checkedAt: { type: Date, default: null },
  reasons: { type: [String], default: [] },
  // saved state: per-field expected/actual; rendered: the crawl the verdict is based on.
  fields: { type: [new mongoose.Schema({ field: String, expected: String, actual: String, ok: Boolean }, { _id: false })], default: [] },
  crawledAt: { type: Date, default: null },
}, { _id: false });

const wordPressFixRecordSchema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  connectionId: { type: mongoose.Schema.Types.ObjectId, required: true },
  taskId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  fixType: { type: String, required: true },
  targetUrl: { type: String, required: true },
  // Site-scoped fixes (Organization) have no single WordPress object; page-scoped ones will.
  targetWordPressObjectId: { type: mongoose.Schema.Types.Mixed, default: null },
  // What a per-object fix targets (image alt: the observed image URL, the resolved attachment id, how it was identified and how
  // confident that is). Null for site-scoped fixes. Never holds page content or credentials.
  target: { type: mongoose.Schema.Types.Mixed, default: null },
  scope: { type: String, enum: ['site', 'post'], default: 'site' },
  provider: { type: String, default: null },

  schemaIntent: {
    intent: { type: String, default: null },
    type: { type: String, default: null },
    action: { type: String, default: null },
  },
  // Which structured-data entities (@id + types, never content) the page carried BEFORE the change, so verification can prove
  // nothing else was removed. Null when the page had not been crawled.
  structuredDataBefore: { type: mongoose.Schema.Types.Mixed, default: null },
  planFingerprint: { type: String, required: true },
  // sha256(taskId + planFingerprint): a repeated request for the SAME plan can never execute twice.
  idempotencyKey: { type: String, required: true, unique: true },

  changes: { type: [changeSchema], default: [] },

  status: { type: String, enum: FIX_STATUSES, default: 'approved', index: true },
  failure: { code: { type: String, default: null }, message: { type: String, default: null } },

  approvedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
  approvedAt: { type: Date, default: null },
  appliedAt: { type: Date, default: null },

  verification: {
    saved: { type: verificationPartSchema, default: () => ({}) },
    rendered: { type: verificationPartSchema, default: () => ({}) },
  },

  rollback: {
    // none -> requested (intent saved before any write) -> applied (every field restored) -> verified (saved state read back).
    // `rolled_back` is the legacy "restored" value written before these stages existed; it stays readable.
    status: { type: String, enum: ['none', 'requested', 'applied', 'verified', 'rolled_back', 'partial_conflict', 'failed'], default: 'none' },
    requestedAt: { type: Date, default: null },
    at: { type: Date, default: null },
    saved: { type: verificationPartSchema, default: undefined },
    rendered: { type: verificationPartSchema, default: undefined },
    by: { type: mongoose.Schema.Types.ObjectId, default: null },
    restoredFields: { type: [String], default: [] },
    conflictFields: { type: [String], default: [] },
  },
}, { timestamps: true, collection: 'wordpress_fix_records' });

wordPressFixRecordSchema.index({ taskId: 1, createdAt: -1 });

const WordPressFixRecord = mongoose.models.WordPressFixRecord || mongoose.model('WordPressFixRecord', wordPressFixRecordSchema);
export default WordPressFixRecord;
