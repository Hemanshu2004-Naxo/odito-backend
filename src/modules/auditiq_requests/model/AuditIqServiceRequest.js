import mongoose from 'mongoose';

/**
 * A request for hands-on help with one issue, raised from the AuditIQ tab of an
 * issue detail page (Express Fix / Technical Audit + Fix / Request Expert Fix).
 *
 * Deliberately its OWN small collection: CustomPlanRequest is a plan-sales lead
 * (company, team size, project count) and Lead is a project's own website leads —
 * neither describes "fix this issue on my project", and neither is project-scoped
 * the way this is. Nothing here touches Stripe, credits, pages, or Task — a
 * request is a record for a human to act on, not an automated fix.
 *
 * `status` is the truth about the request: 'submitted' means a person has not
 * started on it, and only 'completed' means the work is done. The user-facing UI
 * must never describe a submitted request as fixed.
 *
 * One OPEN request per (project, issue, requestType) — enforced by a partial
 * unique index, not just a pre-check, so two concurrent clicks cannot both win.
 */

export const REQUEST_TYPES = ['express_fix', 'technical_audit_fix', 'expert_fix'];
export const OPEN_STATUSES = ['submitted', 'in_review', 'in_progress'];
export const REQUEST_STATUSES = [...OPEN_STATUSES, 'completed', 'cancelled'];

const auditIqServiceRequestSchema = new mongoose.Schema({
  // Tenant + ownership: always taken from the authenticated user and the
  // access-checked project — never from the request body.
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'SeoProject', required: true },

  requestType: { type: String, enum: REQUEST_TYPES, required: true },

  // ── Issue context (what the user was looking at) ─────────────────────────
  issueKey: { type: String, required: true, trim: true, maxlength: 200 },
  issueTitle: { type: String, trim: true, default: '', maxlength: 300 },
  issueCategory: { type: String, trim: true, default: '', maxlength: 100 },
  // As shown in the UI when the request was made — a snapshot, not a live count.
  affectedPageCount: { type: Number, default: null, min: 0, max: 1000000 },
  // The page the user had selected, if any. Context only; the request covers the issue.
  pageUrl: { type: String, trim: true, default: null, maxlength: 2000 },

  // ── Project snapshot (so staff see it without a join) ────────────────────
  projectName: { type: String, trim: true, default: '', maxlength: 300 },
  projectUrl: { type: String, trim: true, default: '', maxlength: 2000 },

  // ── What the user wrote ──────────────────────────────────────────────────
  message: { type: String, trim: true, default: null, maxlength: 2000 },

  // ── Contact: copied from the account, never asked for again ─────────────
  contactEmail: { type: String, trim: true, lowercase: true, default: '', maxlength: 254 },
  contactName: { type: String, trim: true, default: '', maxlength: 200 },

  // ── Lifecycle ────────────────────────────────────────────────────────────
  status: { type: String, enum: REQUEST_STATUSES, default: 'submitted', index: true },
  // Derived from `status` (see the pre-validate hook); exists only so the partial
  // unique index below can use a plain equality filter, which every MongoDB
  // version supports for partialFilterExpression.
  isOpen: { type: Boolean, default: true },

  // Whether the staff notification email actually went out. A request whose email
  // failed is still stored — this flag is how it can be found and followed up.
  staffNotified: { type: Boolean, default: false },
}, {
  timestamps: true,
  collection: 'auditiq_service_requests',
});

auditIqServiceRequestSchema.pre('validate', function syncIsOpen(next) {
  this.isOpen = OPEN_STATUSES.includes(this.status);
  next();
});

// At most one open request per (project, issue, type). Closed requests never block a new one.
auditIqServiceRequestSchema.index(
  { projectId: 1, issueKey: 1, requestType: 1 },
  { unique: true, partialFilterExpression: { isOpen: true } },
);
// The AuditIQ tab's read: everything for one issue of one project, newest first.
auditIqServiceRequestSchema.index({ projectId: 1, issueKey: 1, createdAt: -1 });

const AuditIqServiceRequest = mongoose.models.AuditIqServiceRequest
  || mongoose.model('AuditIqServiceRequest', auditIqServiceRequestSchema);
export default AuditIqServiceRequest;
