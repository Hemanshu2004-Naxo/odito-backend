import mongoose from 'mongoose';

/**
 * SocialImportRow — one source row from a bulk-upload file (see
 * SocialImportBatch.js).
 *
 * Phase 1 (backend foundation) ONLY: rows are NOT populated from a real
 * file, validated, or imported yet — those are later phases. This model
 * only defines the shape and its guarantees.
 *
 * `normalized` holds the post-parse, pre-publish interpretation of the
 * row. Every field in it is nullable because a row is stored BEFORE it
 * is validated: an invalid row still gets a document (with `errors`
 * populated) so the eventual preview / error report can show exactly
 * what was wrong, line by line.
 *
 * When a row is imported it produces a real SocialPublication through the
 * EXISTING createPublication() path; `publication_id` links back to it.
 * A single row must never create two publications — enforced by a
 * partial unique index on SocialPublication (importBatchId +
 * importRowNumber), added in that model.
 */

const PLATFORMS = ['facebook', 'instagram'];
const MEDIA_TYPES = ['image', 'video'];
const ACTIONS = ['draft', 'schedule', 'publish'];
const STATUSES = ['valid', 'invalid', 'imported', 'failed', 'skipped'];

// 7-day retention. A bulk import is transient bookkeeping: once it has
// been reviewed and imported (or abandoned), the per-row scratch data
// has no long-term value — the resulting SocialPublication documents are
// the real, permanent record. Same TTL technique as this module's own
// PendingMetaConnection.js and the OTP / RefreshToken /
// PasswordResetSession models elsewhere in the codebase. Conservative
// window; nothing shortens it.
const ROW_TTL_SECONDS = 7 * 24 * 60 * 60;

// `null` is listed alongside the real values on every enum below: a row
// is stored BEFORE it is validated, so an un-parsed field is genuinely
// null, and this Mongoose version validates `null` against `enum` unless
// it is permitted explicitly.
const normalizedSchema = new mongoose.Schema({
  platform: { type: String, enum: [...PLATFORMS, null], default: null },
  socialAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'SocialAccount', default: null },
  content: { type: String, default: null },
  media: {
    type: [{
      url: { type: String, required: true },
      type: { type: String, enum: MEDIA_TYPES, required: true },
    }],
    default: [],
  },
  scheduledAt: { type: Date, default: null },
  timezone: { type: String, default: null },
  action: { type: String, enum: [...ACTIONS, null], default: null },
}, { _id: false });

const rowErrorSchema = new mongoose.Schema({
  field: { type: String, default: null },
  code: { type: String, required: true },
  message: { type: String, required: true },
}, { _id: false });

const socialImportRowSchema = new mongoose.Schema({
  batch_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SocialImportBatch',
    required: true,
    index: true,
  },
  // Denormalized from the batch so every row-scoped query is a single
  // collection read, never a join back through SocialImportBatch. Same
  // denormalization discipline as SocialPost.project_id. Ownership is
  // still verified through the parent batch in bulkImportService.js — a
  // rowNumber/batchId is never trusted on its own.
  project_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SeoProject',
    required: true,
  },
  // 1-based line number in the source file (header row excluded). Unique
  // within a batch (index below) so the same physical row can never be
  // inserted twice.
  rowNumber: {
    type: Number,
    required: true,
    min: 1,
  },
  // The raw parsed cells, exactly as read from the file. Mixed because
  // the column set varies. NEVER returned by the read API in this phase
  // (see bulkImportController.js / bulkImportService.js toApiRow) — it is
  // arbitrary user input and has no consumer yet.
  raw: {
    type: mongoose.Schema.Types.Mixed,
    required: true,
  },
  normalized: {
    type: normalizedSchema,
    default: () => ({}),
  },
  status: {
    type: String,
    enum: STATUSES,
    default: 'valid',
    index: true,
  },
  errors: {
    type: [rowErrorSchema],
    default: [],
  },
  // Deterministic hash of the row's meaningful content — the foundation
  // for row-level duplicate detection in a later phase. Required so the
  // column always exists; the value is produced upstream.
  idempotencyKey: {
    type: String,
    required: true,
    trim: true,
  },
  publication_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SocialPublication',
    default: null,
  },
  // TTL anchor — see ROW_TTL_SECONDS. Defaults to 7 days from creation;
  // never refreshed in this phase.
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + ROW_TTL_SECONDS * 1000),
  },
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  // `errors` is the field name the bulk-upload spec (and the row read
  // API) uses for the per-row validation problem list. Mongoose also
  // exposes a transient `doc.errors` after a failed .validate(); the two
  // do not actually collide for how this model is used (we only ever
  // assign the array explicitly and never read `doc.errors` for
  // validation state — .validate() still throws a real ValidationError),
  // so the reserved-key warning is acknowledged and silenced rather than
  // renaming a spec-defined, API-facing field.
  suppressReservedKeysWarning: true,
});

// Primary read path: rows of a batch, filtered by status, in file order.
socialImportRowSchema.index({ batch_id: 1, status: 1, rowNumber: 1 });
// One document per physical source row.
socialImportRowSchema.index({ batch_id: 1, rowNumber: 1 }, { unique: true });
// 7-day retention (see ROW_TTL_SECONDS) — same shape as
// PendingMetaConnection.js's own TTL index.
socialImportRowSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const SocialImportRow = mongoose.model('SocialImportRow', socialImportRowSchema);
export default SocialImportRow;
export { PLATFORMS, MEDIA_TYPES, ACTIONS, STATUSES, ROW_TTL_SECONDS };
