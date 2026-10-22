import mongoose from 'mongoose';

// Metric snapshot shape shared by `before` and `after` — mirrors AuditRun's
// own established score/issue-count field names so computeVerificationDelta
// (Phase 3, not this task) can diff two identically-shaped objects.
const metricSnapshotSchema = new mongoose.Schema(
  {
    pageScore:      { type: Number, min: 0, max: 100, default: null },
    aisoScore:      { type: Number, min: 0, max: 100, default: null },
    aeoScore:       { type: Number, min: 0, max: 100, default: null },
    geoScore:       { type: Number, min: 0, max: 100, default: null },
    criticalIssues: { type: Number, min: 0, default: 0 },
    warningIssues:  { type: Number, min: 0, default: 0 },
    infoIssues:     { type: Number, min: 0, default: 0 }
  },
  { _id: false }
);

const deltaSchema = new mongoose.Schema(
  {
    pageScoreChange:  { type: Number, default: null },
    aisoScoreChange:  { type: Number, default: null },
    aeoScoreChange:   { type: Number, default: null },
    geoScoreChange:   { type: Number, default: null },
    issuesFixed:      { type: Number, min: 0, default: 0 },
    issuesIntroduced: { type: Number, min: 0, default: 0 },
    issuesUnchanged:  { type: Number, min: 0, default: 0 }
  },
  { _id: false }
);

const pageVerificationRunSchema = new mongoose.Schema(
  {
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SeoProject',
      required: true
    },

    // The terminal Job document that produced this run. Required for every
    // single-URL verification (today's only path) — populated the moment
    // the PAGE_SCRAPING job exists.
    //
    // F4-013: optional/nullable specifically for a batch-created run BEFORE
    // its jobs exist yet (batch creation, this phase, deliberately creates
    // no jobs) — a later phase updates this field in place once the job is
    // actually created, rather than replacing the document.
    jobId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Job',
      default: null
    },

    // Job.run_id — the execution's tracking id, minted once per verification.
    runId: {
      type: String,
      required: true
    },

    // The single URL this run verified (mirrors Job.input_data.target_url).
    pageUrl: {
      type: String,
      required: true
    },

    // F4-012 — infrastructure only, nothing sets this yet. Optional/nullable
    // link to a VerificationBatch (F4-010/F4-011): null means "not part of
    // any batch", which is exactly what every existing and future
    // non-batched single-URL run already is. No caller reads or writes this
    // field until F4-011 Phase 2 onward, so today's single-URL verification
    // behavior is completely unaffected.
    batchId: {
      type: String,
      default: null
    },

    status: {
      type: String,
      enum: ['pending', 'running', 'completed', 'failed'],
      default: 'pending'
    },

    // F4-013: nullable for the same reason as jobId above — a batch-created
    // run hasn't started (no job dispatched yet), so there is no start time
    // to record until a later phase actually dispatches it. Every
    // single-URL verification still always provides this immediately.
    startedAt:   { type: Date, default: null },
    completedAt: { type: Date, default: null },

    // P3-007: computed and stored ONCE by VerificationFinalizer, alongside
    // completedAt — not derived at read time, so the read-only history API
    // can return it without computing anything dynamically.
    durationMs: { type: Number, default: null },

    // Populated only when status='failed'.
    errorMessage: { type: String, default: null },

    // M1: what actually happened to THIS run's own AI_VISIBILITY job —
    // reused pipeline metadata (the Job's own status), not inferred from
    // ai_scores' values. Populated only on the completed-run path
    // (VerificationFinalizer._persistCompletion); stays null for a run that
    // fails before reaching that point. Whenever this is not 'SUCCESS',
    // after.aisoScore/aeoScore/geoScore are nulled — never a stale reused
    // value from an earlier run.
    aiVisibilityStatus: {
      type: String,
      // null must be listed explicitly — Mongoose's enum validator rejects
      // null (even the schema's own default) unless it's an allowed value.
      enum: ['SUCCESS', 'FAILED', 'SKIPPED', null],
      default: null
    },

    before: { type: metricSnapshotSchema, default: () => ({}) },
    after:  { type: metricSnapshotSchema, default: () => ({}) },
    delta:  { type: deltaSchema, default: () => ({}) },

    createdAt: { type: Date, default: Date.now }
  },
  {
    // No updatedAt — verification runs are immutable after finalization,
    // matching AuditRun's convention.
    timestamps: false,
    collection: 'page_verification_runs'
  }
);

// ── Indexes ────────────────────────────────────────────────────────────────
// One doc per run — also backs GET /seo/verification-runs/:runId (Phase 3, not this task).
pageVerificationRunSchema.index({ runId: 1 }, { unique: true });

// Backs GET /seo/pages/verification-history (Phase 3, not this task).
pageVerificationRunSchema.index({ projectId: 1, pageUrl: 1, createdAt: -1 });

// Project-wide verification history listing, mirrors AuditRun's latest-first index.
pageVerificationRunSchema.index({ projectId: 1, createdAt: -1 });

// Lookup from a Job back to its verification run doc.
pageVerificationRunSchema.index({ jobId: 1 });

// F4-012 — backs the future batch-barrier count query
// (PageVerificationRun.countDocuments({ batchId, status: { $in: [...] } })).
// Partial, and deliberately { $type: 'string' } rather than { $exists: true }:
// the schema's own `default: null` means Mongoose persists batchId=null on
// every non-batched document going forward (the field genuinely exists, just
// as null) — { $exists: true } would therefore match it and index the
// overwhelming majority of documents for a field almost nothing queries by
// yet. { $type: 'string' } indexes only documents that are actually part of
// a batch, which is the entire point of this index.
pageVerificationRunSchema.index(
  { batchId: 1, status: 1 },
  { partialFilterExpression: { batchId: { $type: 'string' } } }
);

const PageVerificationRun = mongoose.model('PageVerificationRun', pageVerificationRunSchema);

export default PageVerificationRun;
