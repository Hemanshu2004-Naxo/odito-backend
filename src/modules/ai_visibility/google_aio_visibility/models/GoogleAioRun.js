import mongoose from 'mongoose';
import { QUESTIONS_PER_RUN } from '../config/googleAioConfig.js';

/**
 * One Google AI Overview Visibility run (collection `google_aio_visibility_runs`). Separate from the legacy ChatGPT runs
 * (`chatgpt_visibility_runs`), which are never read, written or relabelled by this feature.
 *
 * `questionSnapshot` is the immutable list of EXACTLY five questions the run asks (the schema rejects any other length). The
 * per-question results are `google_aio_visibility_evidence` documents; metrics are computed from them when the run finishes.
 * Ownership of a running run is a lease (lockedBy + lease.expiresAt) renewed by a heartbeat; every worker write is conditional on it.
 */
const questionSchema = new mongoose.Schema({
  questionId: { type: String, required: true },
  group: { type: String, default: 'visibility' },
  intent: { type: String, required: true },
  text: { type: String, required: true },
  service: { type: String, default: null },
  location: { type: String, default: null },
  language: { type: String, default: 'en' },
  templateId: { type: String, default: null },
  priority: { type: String, default: 'medium' },
}, { _id: false });

const runSchema = new mongoose.Schema({
  provider: { type: String, enum: ['google_aio'], default: 'google_aio', required: true },
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'SeoProject', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  trigger: { source: { type: String, enum: ['manual'], default: 'manual' } },

  status: { type: String, enum: ['queued', 'running', 'completed', 'partial', 'failed', 'cancelled'], default: 'queued', required: true },
  progress: { completed: { type: Number, default: 0 }, total: { type: Number, default: QUESTIONS_PER_RUN }, stage: { type: String, default: 'queued' } },
  questionStats: {
    total: { type: Number, default: QUESTIONS_PER_RUN }, succeeded: { type: Number, default: 0 }, failed: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 }, cancelled: { type: Number, default: 0 }, pending: { type: Number, default: QUESTIONS_PER_RUN },
  },

  questionSetId: { type: mongoose.Schema.Types.ObjectId, required: true },
  questionSetVersion: { type: Number, required: true },
  selectionMode: { type: String, enum: ['auto', 'user'], default: 'auto' },
  questionSnapshot: {
    type: [questionSchema],
    required: true,
    validate: { validator: (v) => Array.isArray(v) && v.length === QUESTIONS_PER_RUN && new Set(v.map((q) => q.questionId)).size === QUESTIONS_PER_RUN, message: `A run must contain exactly ${QUESTIONS_PER_RUN} unique questions` },
  },

  // Resolved ONCE when the run is created: every question of the run uses the same market and device.
  serp: {
    locationCode: { type: Number, required: true },
    locationName: { type: String, default: null },
    locationMethod: { type: String, default: null },
    languageCode: { type: String, required: true },
    device: { type: String, enum: ['desktop', 'mobile'], required: true },
    os: { type: String, required: true },
    depth: { type: Number, required: true },
    loadAsyncAiOverview: { type: Boolean, required: true },
  },
  // The measurement target, fixed at claim time so one run is always measured against one brand/competitor/domain definition.
  target: { type: mongoose.Schema.Types.Mixed, default: null },
  market: { type: mongoose.Schema.Types.Mixed, default: null },
  policy: { type: mongoose.Schema.Types.Mixed, default: null },

  metrics: { type: mongoose.Schema.Types.Mixed, default: null },
  totalCost: { amount: { type: Number, default: null }, unit: { type: String, default: null }, unknownCount: { type: Number, default: 0 } },

  lockedBy: { type: String, default: null },
  lease: { expiresAt: { type: Date, default: null } },
  heartbeatAt: { type: Date, default: null },
  attempts: { type: Number, default: 0 },
  cancelRequested: { type: Boolean, default: false },

  failureCode: { type: String, default: null },
  failureMessage: { type: String, default: null },
  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  failedAt: { type: Date, default: null },
}, { collection: 'google_aio_visibility_runs', timestamps: true });

runSchema.index({ projectId: 1 }, { unique: true, name: 'one_active_google_aio_run_per_project', partialFilterExpression: { status: { $in: ['queued', 'running'] } } });
runSchema.index({ projectId: 1, createdAt: -1 });
runSchema.index({ status: 1, 'lease.expiresAt': 1 });
runSchema.index({ userId: 1, createdAt: -1 });

const GoogleAioRun = mongoose.models.GoogleAioRun || mongoose.model('GoogleAioRun', runSchema);
export default GoogleAioRun;
