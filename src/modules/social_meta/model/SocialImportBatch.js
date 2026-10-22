import mongoose from 'mongoose';

/**
 * SocialImportBatch — one CSV/XLSX bulk-upload attempt for a project's
 * social publishing.
 *
 * Phase 1 (backend foundation) ONLY: the file parser, the row validator,
 * the importer, the upload middleware and every frontend surface are
 * explicitly OUT of scope here and land in later phases. Nothing writes a
 * batch past `parsing` yet.
 *
 * Deliberately a SEPARATE model from SocialPublication (the existing,
 * production publishing pipeline) — a batch is import bookkeeping, not a
 * post. Once a row is imported it produces a real SocialPublication
 * through the EXISTING createPublication()/publishNow() path
 * (socialPublishingService.js); this model never re-implements or
 * re-runs any of that. No token/secret of any kind lives here — same
 * discipline as every other model in this module.
 */

const FORMATS = ['csv', 'xlsx'];

// The batch lifecycle. `expired` is terminal (retention cleanup — see the
// TTL on SocialImportRow). The only transitions bulkImportService.js
// permits are enumerated in STATUS_TRANSITIONS below — never an arbitrary
// jump.
const STATUSES = ['parsing', 'validating', 'ready', 'importing', 'completed', 'failed', 'expired'];

// The subset of STATUSES meaning "a bulk import is currently in flight
// for this project". The partial unique index below uses exactly this
// list so a project can only ever have ONE active batch at a time, while
// any number of completed/failed/expired batches coexist as history.
const ACTIVE_STATUSES = ['parsing', 'validating', 'importing'];

const IMPORT_MODES = ['valid-only', 'all-as-draft'];

// Allowed forward transitions. A small local table (not a state-machine
// dependency) — mirrors the intent of VerificationBatch's own transition
// validation, but enforced in bulkImportService.js
// (updateImportBatchStatus) rather than a log-only hook, because this
// model is only ever written through that one service.
const STATUS_TRANSITIONS = {
  parsing: ['validating', 'failed', 'expired'],
  validating: ['ready', 'failed', 'expired'],
  ready: ['importing', 'failed', 'expired'],
  importing: ['completed', 'failed', 'expired'],
  completed: ['expired'],
  // A batch that FAILED mid-import (status was 'importing', so importMode
  // is set) may be re-claimed for another import attempt — this is only
  // safe because every row's publication creation is idempotent
  // (SocialImportRow.publication_id link + SocialPublication
  // `{importBatchId,importRowNumber}` partial-unique index + E11000
  // recovery), so a re-run recovers what was created and never
  // double-publishes. A batch that failed during PARSING (importMode
  // null, Phase 2) is NOT re-claimable — see bulkImportExecutor's claim
  // filter.
  failed: ['importing', 'expired'],
  expired: [],
};

/**
 * True if `to` is a permitted next status from `from`. A no-op
 * (`from === to`) is always allowed so an idempotent re-write of the same
 * status never trips the check. An unknown `from` has no legal
 * transitions.
 */
export function canTransitionBatchStatus(from, to) {
  if (from === to) return true;
  return (STATUS_TRANSITIONS[from] || []).includes(to);
}

const countsSchema = new mongoose.Schema({
  total: { type: Number, default: 0, min: 0 },
  valid: { type: Number, default: 0, min: 0 },
  invalid: { type: Number, default: 0, min: 0 },
  imported: { type: Number, default: 0, min: 0 },
  failed: { type: Number, default: 0, min: 0 },
  drafts: { type: Number, default: 0, min: 0 },
  scheduled: { type: Number, default: 0, min: 0 },
}, { _id: false });

const socialImportBatchSchema = new mongoose.Schema({
  project_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SeoProject',
    required: true,
    index: true,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  filename: {
    type: String,
    required: true,
    trim: true,
  },
  // SHA-256 (hex) of the uploaded file's raw bytes — computed by a later
  // phase's upload handler and stored here so a re-upload of the
  // identical file can be detected (indexed with project_id below).
  // Required on the schema; the value itself is produced upstream, never
  // here.
  fileHash: {
    type: String,
    required: true,
    trim: true,
  },
  format: {
    type: String,
    enum: FORMATS,
    required: true,
  },
  status: {
    type: String,
    enum: STATUSES,
    default: 'parsing',
    index: true,
  },
  rowCount: {
    type: Number,
    default: 0,
    min: 0,
  },
  counts: {
    type: countsSchema,
    default: () => ({}),
  },
  // A short, safe, user-facing summary of a file-/batch-level failure —
  // never a stack trace, never anything token-adjacent (same discipline
  // as SocialPublication.failureReason).
  errorSummary: {
    type: String,
    default: null,
  },
  importMode: {
    type: String,
    // `null` is explicitly permitted (a batch has no mode until the
    // import step chooses one) — this Mongoose version validates `null`
    // against `enum` unless it is listed here.
    enum: [...IMPORT_MODES, null],
    default: null,
  },

  // ── Phase 5: import execution liveness + stale recovery ──────────────
  // A token minted once per atomic claim (bulkImportExecutor). The
  // executor's heartbeat / completion / failure writes are all
  // conditioned on `importClaimId` still matching, so the stale-import
  // sweeper (bulkImportRecoveryService) can flip an abandoned `importing`
  // batch to `failed` WITHOUT ever racing a slow-but-alive worker: the
  // worker's own writes stop mattering the instant the sweeper clears
  // this. Cleared (null) on completion, failure, or recovery.
  importClaimId: {
    type: String,
    default: null,
  },
  importStartedAt: {
    type: Date,
    default: null,
  },
  // Bumped by the executor as it works (every N rows). "Genuinely stale"
  // = still `importing` with no heartbeat for the configured threshold.
  importHeartbeatAt: {
    type: Date,
    default: null,
  },
  recoveredAt: {
    type: Date,
    default: null,
  },
  // A short, machine-readable reason the sweeper recovered this batch
  // (e.g. 'stale_importing_no_heartbeat'). Never a stack trace.
  recoveryReason: {
    type: String,
    default: null,
  },
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
});

// Batch history for a project — newest first.
socialImportBatchSchema.index({ project_id: 1, createdAt: -1 });
// Duplicate-file detection foundation (the actual dedupe decision is a
// later phase; this only makes the lookup cheap).
socialImportBatchSchema.index({ project_id: 1, fileHash: 1 });
// Status filtering within a project.
socialImportBatchSchema.index({ project_id: 1, status: 1 });
// At most ONE in-flight batch per project. Partial, keyed on project_id
// ALONE (not project_id + status) so the constraint is "one active
// batch", not "one active batch per status". completed/failed/expired
// rows are excluded by the filter entirely and may accumulate freely.
// Same partial-`$in` technique already used by jobs/model/Job.js's
// in-flight-uniqueness indexes.
socialImportBatchSchema.index(
  { project_id: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ACTIVE_STATUSES } },
    name: 'one_active_import_per_project',
  },
);
// Phase 5: the stale-import sweeper scans `status: 'importing'` ordered
// by heartbeat age.
socialImportBatchSchema.index({ status: 1, importHeartbeatAt: 1 });

const SocialImportBatch = mongoose.model('SocialImportBatch', socialImportBatchSchema);
export default SocialImportBatch;
export { FORMATS, STATUSES, ACTIVE_STATUSES, IMPORT_MODES, STATUS_TRANSITIONS };
