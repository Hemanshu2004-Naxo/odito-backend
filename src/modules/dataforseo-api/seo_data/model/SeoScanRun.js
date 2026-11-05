import mongoose from 'mongoose';

export const SCAN_STATUSES = Object.freeze(['pending', 'queued', 'running', 'partially_completed', 'completed', 'failed', 'cancelled']);
export const DATASET_STATUSES = Object.freeze(['pending', 'running', 'completed', 'failed', 'skipped']);
export const ACTIVE_STATUSES = Object.freeze(['pending', 'queued', 'running']);

/**
 * One SEO data collection (a "scan") for a project, and the audit trail of what it bought.
 *
 * THE QUEUE. The web request only inserts the scan (`queued`); a worker (worker/seoScanWorker.js, in this process or a separate one) claims it
 * with one atomic update, so two workers can never process the same scan, and resumes it from the datasets not yet completed if the worker dies.
 *
 * THE LOCK. `lockKey` holds the project id while the scan is active and is REMOVED (never set to null) when it ends; the partial unique
 * index below lets MongoDB allow exactly one active scan per project across every backend instance. Starting a scan is one insert, so
 * there is no read-then-write race. `leaseUntil` is extended by a heartbeat while the process works; a crashed worker stops
 * extending it, and the next start (or status read) ends the dead scan as failed and frees the lock.
 *
 * Per-dataset state lives in `datasets` (bounded: a scan has at most ~20). Only codes are stored for errors: never a provider body,
 * request or credential.
 */
const datasetSchema = new mongoose.Schema({
  id: { type: String, required: true, maxlength: 60 },
  section: { type: String, required: true, maxlength: 60 },
  status: { type: String, enum: DATASET_STATUSES, default: 'pending' },
  // true = answered from a fresh stored entry (no provider request was made for it).
  cached: { type: Boolean, default: null },
  fetchedAt: { type: Date, default: null },
  // The provider's reported charge for the call, when it said so; null = unknown (never a guess).
  cost: { type: Number, default: null },
  durationMs: { type: Number, default: null },
  errorCode: { type: String, default: null, maxlength: 60 },
  // How many tries the dataset needed in the attempt that finished it (transient provider errors are retried with backoff).
  attempts: { type: Number, default: 0 },
  startedAt: { type: Date, default: null },
  finishedAt: { type: Date, default: null },
}, { _id: false });

const scanRunSchema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'SeoProject', required: true },
  domain: { type: String, required: true, maxlength: 253 },
  market: { type: new mongoose.Schema({ location: String, language: String }, { _id: false }), default: null },
  scope: { type: String, required: true, maxlength: 40 },
  status: { type: String, enum: SCAN_STATUSES, required: true, default: 'pending' },
  triggerType: { type: String, enum: ['manual', 'retry', 'scheduled'], default: 'manual' },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // true = fresh stored entries were bought again as well (a complete refresh); false = only missing / stale data was bought.
  force: { type: Boolean, default: false },
  retryOf: { type: mongoose.Schema.Types.ObjectId, default: null },
  retryCount: { type: Number, default: 0 },
  datasetsRequested: { type: [String], default: [] },
  datasets: { type: [datasetSchema], default: [] },
  datasetsCompleted: { type: Number, default: 0 },
  datasetsFailed: { type: Number, default: 0 },
  // REAL provider requests this scan caused (cache hits are not counted) and the sum of the costs the provider reported for them.
  providerRequestsCount: { type: Number, default: 0 },
  reportedCost: { type: Number, default: 0 },
  error: { type: new mongoose.Schema({ code: String }, { _id: false }), default: null },
  lockKey: { type: String, default: undefined },
  leaseUntil: { type: Date, default: null },
  // The queue: a scan is created `queued`, claimed atomically by one worker (status -> running, workerId, lease), and re-claimed by another
  // worker when that one stops extending the lease. `attempts` counts claims; `nextAttemptAt` delays a requeued scan (backoff).
  workerId: { type: String, default: null, maxlength: 120 },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: null },
  startedAt: { type: Date, default: null },
  finishedAt: { type: Date, default: null },
}, { collection: 'seo_scan_runs', timestamps: true, minimize: false });

scanRunSchema.index({ lockKey: 1 }, { unique: true, name: 'seo_scan_runs_active_lock', partialFilterExpression: { lockKey: { $type: 'string' } } });
scanRunSchema.index({ projectId: 1, createdAt: -1 }, { name: 'seo_scan_runs_project_time' });
scanRunSchema.index({ projectId: 1, scope: 1, status: 1 }, { name: 'seo_scan_runs_project_scope_status' });
scanRunSchema.index({ status: 1, leaseUntil: 1 }, { name: 'seo_scan_runs_status_lease' });
// What a worker looks for: queued scans that are due, oldest first.
scanRunSchema.index({ status: 1, nextAttemptAt: 1, createdAt: 1 }, { name: 'seo_scan_runs_queue' });

const SeoScanRun = mongoose.models.SeoScanRun || mongoose.model('SeoScanRun', scanRunSchema);
export default SeoScanRun;
