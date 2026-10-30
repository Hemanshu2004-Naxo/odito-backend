import mongoose from 'mongoose';

/**
 * Per-question Google SERP evidence (collection `google_aio_visibility_evidence`): exactly one document per (run, question) —
 * the unique index makes "no duplicate processing" a database guarantee, and a question is only ever sent after its document is
 * atomically moved pending -> running by the worker that owns the run.
 *
 * Status vocabulary:  pending | running | succeeded | failed | skipped
 *   succeeded  the SERP request returned a valid response. `aiOverview.present` says whether Google showed an AI Overview:
 *              true = captured, false = Google showed none (a valid observation, NOT an error).
 *   failed     the request itself did not produce a valid response (auth, timeout, rate limit, malformed ...): errorCode/errorClass.
 *   skipped    never dispatched, with the reason in errorCode (+ skipCause: the provider error that stopped the run, when there was one).
 *   cancelled  the run was cancelled before this question was dispatched.
 * Every terminal status is final: nothing overwrites it.
 */
const referenceSchema = new mongoose.Schema({
  url: { type: String, required: true },
  normalizedUrl: { type: String, default: null },
  host: { type: String, default: null },
  title: { type: String, default: null },
  source: { type: String, default: null },
  domain: { type: String, default: null },
  snippet: { type: String, default: null },
  kind: { type: String, enum: ['reference', 'link'], default: 'reference' },
  isOwned: { type: Boolean, default: false },
}, { _id: false });

const evidenceSchema = new mongoose.Schema({
  provider: { type: String, enum: ['google_aio'], default: 'google_aio', required: true },
  runId: { type: mongoose.Schema.Types.ObjectId, ref: 'GoogleAioRun', required: true },
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'SeoProject', required: true },
  questionSetId: { type: mongoose.Schema.Types.ObjectId, required: true },
  questionSetVersion: { type: Number, required: true },
  questionId: { type: String, required: true },
  position: { type: Number, required: true, min: 1, max: 5 }, // 1-based place in the run's five
  questionText: { type: String, required: true },
  intent: { type: String, default: null },
  service: { type: String, default: null },
  language: { type: String, default: 'en' },

  // Where and how the SERP was requested (copied from the run so an evidence document is self-describing).
  locationCode: { type: Number, default: null },
  locationName: { type: String, default: null },
  languageCode: { type: String, default: null },
  device: { type: String, default: null },
  os: { type: String, default: null },

  status: { type: String, enum: ['pending', 'running', 'succeeded', 'failed', 'skipped', 'cancelled'], default: 'pending', required: true },
  lockedBy: { type: String, default: null },
  attempts: { type: Number, default: 0 },

  serp: {
    checkUrl: { type: String, default: null },
    datetime: { type: Date, default: null },
    itemsCount: { type: Number, default: null },
    itemTypes: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  aiOverview: {
    present: { type: Boolean, default: null }, // null = no response yet
    asyncRequested: { type: Boolean, default: null },
    asynchronous: { type: Boolean, default: null }, // the provider's asynchronous_ai_overview flag
    text: { type: String, default: null },
    markdown: { type: String, default: null },
    elements: { type: [new mongoose.Schema({ type: { type: String }, title: String, text: String, markdown: String }, { _id: false })], default: [] },
    references: { type: [referenceSchema], default: [] },
    rejectedReferences: { type: Number, default: 0 }, // references dropped because their URL was not a safe http(s) URL
  },
  analysis: { type: mongoose.Schema.Types.Mixed, default: null },
  analysisVersion: { type: String, default: null },
  analysisStatus: { type: String, enum: ['analysed', 'failed', null], default: null },

  request: { type: mongoose.Schema.Types.Mixed, default: null }, // body sent minus the keyword; never a credential
  providerRequestId: { type: String, default: null },
  cost: { type: Number, default: null },
  costStatus: { type: String, enum: ['reported', 'unknown'], default: 'unknown' },
  costUnit: { type: String, default: null },

  // Provider diagnostics (never a credential or header): httpStatus, providerCode, providerMessage, taskIdReturned, attemptLog[], durationMs.
  diagnostics: { type: mongoose.Schema.Types.Mixed, default: null },
  skipCause: { type: String, default: null },
  errorCode: { type: String, default: null },
  errorClass: { type: String, default: null },
  retryable: { type: Boolean, default: null },
  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  durationMs: { type: Number, default: null },
  retainUntil: { type: Date, default: null },
}, { collection: 'google_aio_visibility_evidence', timestamps: true });

evidenceSchema.index({ runId: 1, questionId: 1 }, { unique: true, name: 'unique_google_aio_evidence_per_run_question' });
evidenceSchema.index({ runId: 1, position: 1 }, { unique: true, name: 'unique_google_aio_evidence_per_run_position' });
evidenceSchema.index({ projectId: 1, runId: 1, status: 1 });
evidenceSchema.index({ projectId: 1, questionId: 1, createdAt: -1 });
evidenceSchema.index({ retainUntil: 1 }, { expireAfterSeconds: 0, name: 'google_aio_evidence_retention_ttl' });

const GoogleAioEvidence = mongoose.models.GoogleAioEvidence || mongoose.model('GoogleAioEvidence', evidenceSchema);
export default GoogleAioEvidence;
