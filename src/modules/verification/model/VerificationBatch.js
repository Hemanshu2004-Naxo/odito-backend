import mongoose from 'mongoose';
import { BATCH_STATUS, BATCH_STATUSES } from '../constants/batchStatus.js';

/**
 * VerificationBatch (F4-012 — infrastructure only)
 *
 * Header document for a multi-URL Verification Batch (F4-010/F4-011). Owns
 * batch-wide state only — per-page state continues to live entirely on
 * PageVerificationRun, unchanged. One batch has many PageVerificationRuns
 * (linked via PageVerificationRun.batchId), each of which owns its own Jobs
 * exactly as today.
 *
 * This model is not yet referenced by any controller, service, chaining
 * logic, worker, or websocket emitter — nothing mints a batchId yet. It
 * exists so later phases (F4-011 Phase 2 onward) have a schema to build on
 * without a migration.
 */
const verificationBatchSchema = new mongoose.Schema(
  {
    // Minted by the caller before this document is created (mirrors
    // PageVerificationRun.runId's own mint-then-create convention) — a
    // stable external identity independent of the Mongo _id.
    batchId: {
      type: String,
      required: true,
      unique: true,
    },

    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SeoProject',
      required: true,
    },

    // The full selected set, captured up front — total is known even
    // before any PageVerificationRun exists for this batch.
    urls: {
      type: [String],
      required: true,
      validate: {
        validator: (value) => Array.isArray(value) && value.length > 0,
        message: 'VerificationBatch.urls must contain at least one URL',
      },
    },

    totalUrls: {
      type: Number,
      required: true,
      min: 0,
    },

    // Counts of member PageVerificationRuns that reached a terminal
    // per-page state. Not derived at read time in this phase — nothing
    // writes to these yet (no orchestration logic exists until F4-011
    // Phase 3/4).
    completedUrls: {
      type: Number,
      default: 0,
      min: 0,
    },
    failedUrls: {
      type: Number,
      default: 0,
      min: 0,
    },

    status: {
      type: String,
      enum: BATCH_STATUSES,
      default: BATCH_STATUS.PENDING,
    },

    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },

    aggregateStartedAt: { type: Date, default: null },
    aggregateCompletedAt: { type: Date, default: null },

    errorMessage: { type: String, default: null },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    // Unlike PageVerificationRun (immutable once finalized), a batch is
    // actively mutated over its lifecycle (status transitions, counters) —
    // matches Task.js's timestamps convention, not PageVerificationRun's.
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
    collection: 'verification_batches',
  }
);

// F4-018 §6: batch state validation. Mirrors Job.js's own pre('save')
// status-transition check exactly — logs an unexpected transition, does
// NOT reject the save or attempt to silently repair it (corrupted state
// must be visible, not hidden behind a validation error that could mask a
// legitimate-but-unanticipated recovery path).
const VALID_BATCH_TRANSITIONS = {
  // PENDING -> FAILED: startVerificationBatch (urlVerificationService.js)
  // sets this directly when zero URLs successfully dispatch — a
  // legitimate, tested outcome, not a corrupted-state case.
  [BATCH_STATUS.PENDING]: [BATCH_STATUS.RUNNING, BATCH_STATUS.FAILED],
  [BATCH_STATUS.RUNNING]: [BATCH_STATUS.AGGREGATING],
  [BATCH_STATUS.AGGREGATING]: [BATCH_STATUS.COMPLETED, BATCH_STATUS.PARTIAL, BATCH_STATUS.FAILED],
  [BATCH_STATUS.COMPLETED]: [],
  [BATCH_STATUS.PARTIAL]: [],
  [BATCH_STATUS.FAILED]: [],
};

verificationBatchSchema.pre('save', function (next) {
  if (!this.isNew && this.isModified('status')) {
    const previousStatus = this._doc.status;
    const allowedTransitions = VALID_BATCH_TRANSITIONS[previousStatus] || [];

    if (!allowedTransitions.includes(this.status)) {
      console.error(`[BATCH_VALIDATION] ❌ Invalid status transition | batchId=${this.batchId} | from=${previousStatus} | to=${this.status}`);
      console.error(`[BATCH_VALIDATION] Allowed transitions from ${previousStatus}:`, allowedTransitions);
    }
  }

  next();
});

// Every real status write in this codebase (the barrier, finalize, and
// VerificationBatch.updateBatch) goes through findOneAndUpdate, not
// .save() — document middleware (the pre('save') hook above) never fires
// for those. This is the hook that actually observes production
// transitions; kept separate (rather than replacing the save hook) so a
// direct .save() call is still checked too.
verificationBatchSchema.pre('findOneAndUpdate', async function (next) {
  const update = this.getUpdate() || {};
  const nextStatus = update.$set?.status ?? update.status;

  if (!nextStatus) {
    return next();
  }

  try {
    const current = await this.model.findOne(this.getQuery()).select('status batchId').lean();
    if (current && current.status !== nextStatus) {
      const allowedTransitions = VALID_BATCH_TRANSITIONS[current.status] || [];
      if (!allowedTransitions.includes(nextStatus)) {
        console.error(`[BATCH_VALIDATION] ❌ Invalid status transition | batchId=${current.batchId} | from=${current.status} | to=${nextStatus}`);
        console.error(`[BATCH_VALIDATION] Allowed transitions from ${current.status}:`, allowedTransitions);
      }
    }
  } catch (error) {
    console.error(`[BATCH_VALIDATION] transition check failed (non-fatal): ${error.message}`);
  }

  next();
});

// ── Indexes ──────────────────────────────────────────────────────────────

// Primary external lookup key — every future caller addresses a batch by
// batchId, never by Mongo _id (mirrors PageVerificationRun.runId's unique
// index for the identical reason).
verificationBatchSchema.index({ batchId: 1 }, { unique: true });

// "Is a batch already active for this project" / status-filtered listing —
// backs the findActiveBatch() helper below.
verificationBatchSchema.index({ projectId: 1, status: 1 });

// Project-wide batch history, latest first — mirrors PageVerificationRun's
// own { projectId, createdAt: -1 } listing index for the same future need.
verificationBatchSchema.index({ projectId: 1, createdAt: -1 });

// ── Statics (thin infrastructure helpers — no orchestration logic) ───────

/**
 * Create a batch document. totalUrls is derived from urls.length here so
 * callers never have to keep the two in sync themselves.
 */
verificationBatchSchema.statics.createBatch = function ({ batchId, projectId, urls, createdBy = null }) {
  return this.create({
    batchId,
    projectId,
    urls,
    totalUrls: urls.length,
    createdBy,
  });
};

/** Look up a batch by its external batchId. */
verificationBatchSchema.statics.findBatch = function (batchId) {
  return this.findOne({ batchId });
};

/** Apply a partial update to a batch by batchId, returning the updated document. */
verificationBatchSchema.statics.updateBatch = function (batchId, updates) {
  return this.findOneAndUpdate({ batchId }, { $set: updates }, { new: true });
};

/** The project's current non-terminal batch, if any (PENDING/RUNNING/AGGREGATING). */
verificationBatchSchema.statics.findActiveBatch = function (projectId) {
  return this.findOne({
    projectId,
    status: { $in: [BATCH_STATUS.PENDING, BATCH_STATUS.RUNNING, BATCH_STATUS.AGGREGATING] },
  });
};

const VerificationBatch = mongoose.model('VerificationBatch', verificationBatchSchema);

export default VerificationBatch;
