import mongoose from 'mongoose';

/**
 * Investigation — one run of the universal issue-investigation engine for (project, issue, page).
 *
 * Tenant-scoped: projectId + userId are always set from the authenticated request, and every read in the store
 * filters by projectId. `result` is the validated contract object only (never raw model text). `evidenceTrace` keeps
 * source/method/timestamp/status of each evidence item WITHOUT the bulky page data.
 */
const investigationSchema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'SeoProject', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  issueId: { type: String, required: true, maxlength: 120 },
  pageUrl: { type: String, required: true, maxlength: 2048 },
  // `${issueId}|${pageUrl}` — identifies "the same investigation" for de-duplication of concurrent requests.
  requestKey: { type: String, required: true },
  issueMeta: { type: mongoose.Schema.Types.Mixed, default: {} },
  // Equals requestKey while the run is queued/running and null once it ends. A partial UNIQUE index on (projectId, activeKey)
  // makes "one active investigation per project+issue+page" a database guarantee, so it also holds across server instances.
  activeKey: { type: String, default: null },
  // Which server process owns the run (diagnostics + recovery); heartbeat is refreshed by every progress write.
  runnerId: { type: String, default: null },

  status: { type: String, enum: ['queued', 'running', 'completed', 'failed', 'cancelled'], default: 'queued' },
  stage: { type: String, default: 'queued' },
  progress: [{ stage: String, status: { type: String, enum: ['running', 'done', 'skipped', 'failed'] }, note: String, at: Date, _id: false }],

  planFamily: { type: String, default: null },
  promptVersion: { type: String, default: null },
  contractVersion: { type: Number, default: null },
  model: { type: String, default: null },
  tokens: { input: { type: Number, default: 0 }, output: { type: Number, default: 0 } },

  evidenceTrace: { type: [mongoose.Schema.Types.Mixed], default: [] },
  result: { type: mongoose.Schema.Types.Mixed, default: null },
  warnings: { type: [String], default: [] },
  error: { code: { type: String, default: null }, message: { type: String, default: null } },

  // Approval of ONE exact proposal fingerprint: { fingerprint, userId, approvedAt, consumedAt, consumedByTaskId, invalidatedAt }.
  // Set only by approvalService; consumed by one compare-and-set when the write is attempted; invalidated when a newer investigation starts.
  approval: { type: mongoose.Schema.Types.Mixed, default: null },

  // Server-owned. 'applied'/'verified' are only ever derived from real task / verification records (see lifecycleService).
  lifecycle: {
    recommendationGenerated: { type: Boolean, default: false },
    fixProposed: { type: Boolean, default: false },
    fixApplied: { type: Boolean, default: false },
    fixVerified: { type: Boolean, default: false },
    verificationStatus: { type: String, enum: ['not_started', 'pending', 'passed', 'failed', 'unavailable'], default: 'not_started' },
    verificationRunId: { type: String, default: null },
    verificationCheckedAt: { type: Date, default: null },
  },

  startedAt: { type: Date, default: null },
  finishedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'ai_investigations' });

investigationSchema.index({ projectId: 1, requestKey: 1, createdAt: -1 });
investigationSchema.index({ projectId: 1, status: 1 });
investigationSchema.index({ projectId: 1, activeKey: 1 }, { unique: true, partialFilterExpression: { activeKey: { $type: 'string' } } });
investigationSchema.index({ status: 1, updatedAt: 1 });
// Investigations hold page evidence summaries: do not keep them forever.
investigationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export default mongoose.models.Investigation || mongoose.model('Investigation', investigationSchema);
