import mongoose from 'mongoose';

/**
 * Lead Model
 *
 * A single captured lead (manual entry today; future phases add
 * website-form/WordPress-plugin/tracker.js sources that write through the
 * same leadService.createLead()). Always project-scoped — projectId is the
 * tenant boundary, matching Task.js/AuditFixLog.js's convention for
 * project-scoped feature collections (camelCase fields, not SeoProject's
 * older snake_case core-model convention).
 *
 * email is intentionally NOT unique (even per-project) — the same person
 * can submit multiple forms/inquiries over time; duplicate handling is a
 * later-phase concern, not a schema constraint.
 */

const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'follow_up', 'won', 'lost'];
const LEAD_PRIORITIES = ['low', 'medium', 'high'];

function isValidOptionalUrl(value) {
  if (!value) return true;
  try {
    // eslint-disable-next-line no-new
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * One note left on a lead by a user. Appended (never mutated) via
 * leadService.updateLead()'s $push — full-array replacement isn't exposed
 * through the update API, so history can't be silently overwritten.
 */
const leadNoteSchema = new mongoose.Schema(
  {
    text: {
      type: String,
      required: true,
      trim: true,
      maxlength: [2000, 'Note cannot exceed 2000 characters'],
    },
    authorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: false }
);

const leadSchema = new mongoose.Schema(
  {
    // ── Tenant boundary ─────────────────────────────────────────────────
    // No inline `index: true` — every compound index below is prefixed by
    // projectId, which already covers a projectId-only query; a standalone
    // single-field index on top would be redundant write overhead.
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SeoProject',
      required: true,
    },

    // ── Contact info ────────────────────────────────────────────────────
    name: {
      type: String,
      trim: true,
      maxlength: [200, 'Name cannot exceed 200 characters'],
      default: null,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: [254, 'Email cannot exceed 254 characters'],
      default: null,
      validate: {
        validator: (v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
        message: 'Please provide a valid email address',
      },
    },
    phone: {
      // No country-specific format assumptions — trimmed/length-capped only,
      // per the range of formats real website contact forms actually submit.
      type: String,
      trim: true,
      maxlength: [30, 'Phone cannot exceed 30 characters'],
      default: null,
    },
    company: {
      type: String,
      trim: true,
      maxlength: [200, 'Company cannot exceed 200 characters'],
      default: null,
    },
    message: {
      type: String,
      trim: true,
      maxlength: [5000, 'Message cannot exceed 5000 characters'],
      default: null,
    },

    // ── Capture context (schema-only in Phase 1 — nothing populates these
    // yet; reserved so the future public capture API can write into the
    // same Lead shape via leadService.createLead() without a migration) ──
    formName: {
      type: String,
      trim: true,
      maxlength: [200, 'formName cannot exceed 200 characters'],
      default: null,
    },
    pageUrl: {
      type: String,
      trim: true,
      maxlength: [2000, 'pageUrl cannot exceed 2000 characters'],
      default: null,
      validate: { validator: isValidOptionalUrl, message: 'pageUrl must be a valid URL' },
    },
    source: {
      type: String,
      trim: true,
      maxlength: [50, 'source cannot exceed 50 characters'],
      default: 'manual',
    },
    referrer: {
      type: String,
      trim: true,
      maxlength: [2000, 'referrer cannot exceed 2000 characters'],
      default: null,
      validate: { validator: isValidOptionalUrl, message: 'referrer must be a valid URL' },
    },
    utmSource: { type: String, trim: true, maxlength: 200, default: null },
    utmMedium: { type: String, trim: true, maxlength: 200, default: null },
    utmCampaign: { type: String, trim: true, maxlength: 200, default: null },
    utmTerm: { type: String, trim: true, maxlength: 200, default: null },
    utmContent: { type: String, trim: true, maxlength: 200, default: null },

    // Idempotency key for machine-generated leads (Phase 3B — WordPress
    // plugin submissions). null for every manually-created lead; a real
    // string only for leads created through leadService.createLeadIdempotent().
    // The partial unique index below (projectId + externalEventId, only
    // where externalEventId is an actual string) means any number of manual
    // leads can all sit at externalEventId: null without colliding, while a
    // retried WordPress submission with the same eventId is guaranteed by
    // MongoDB itself — not application logic — to produce at most one Lead.
    externalEventId: {
      type: String,
      trim: true,
      maxlength: 200,
      default: null,
    },

    // ── Sales workflow ──────────────────────────────────────────────────
    // No inline `index: true` here — every real query filters by projectId
    // first (see leadService.js), so the compound { projectId, status } /
    // { projectId, priority } indexes below cover this field; a standalone
    // single-field index would just be dead write overhead.
    status: {
      type: String,
      enum: LEAD_STATUSES,
      default: 'new',
      required: true,
    },
    priority: {
      type: String,
      enum: LEAD_PRIORITIES,
      default: 'medium',
      required: true,
    },
    notes: {
      type: [leadNoteSchema],
      default: [],
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    lastContactAt: { type: Date, default: null },
    nextFollowUpAt: { type: Date, default: null },

    // ── Actors ──────────────────────────────────────────────────────────
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    // ── Soft delete (matches Task.js's isDeleted/deletedAt convention) ──
    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
    collection: 'leads',
  }
);

// ── Indexes ──────────────────────────────────────────────────────────────
// Each maps to a concrete query pattern from leadService.js — no index is
// added speculatively. isDeleted is deliberately NOT independently indexed:
// it's a low-cardinality equality filter that rides along inside each of
// these already project-scoped compound indexes (same reasoning Task.js
// applies — it has no dedicated isDeleted index either).

// Default list view: newest-first within a project.
leadSchema.index({ projectId: 1, createdAt: -1 });
// Status filter/board view.
leadSchema.index({ projectId: 1, status: 1 });
// Priority filter.
leadSchema.index({ projectId: 1, priority: 1 });
// Email lookup within a project (future duplicate-detection UX) —
// intentionally NOT unique; the same person may submit more than once.
leadSchema.index({ projectId: 1, email: 1 });
// Idempotency: at most one Lead per (project, externalEventId). Partial —
// only applies where externalEventId is an actual string — so the
// countless manual leads with externalEventId: null never collide with
// each other (a plain unique index would treat every null as a duplicate
// of every other null).
leadSchema.index(
  { projectId: 1, externalEventId: 1 },
  { unique: true, partialFilterExpression: { externalEventId: { $type: 'string' } } }
);

export { LEAD_STATUSES, LEAD_PRIORITIES };

const Lead = mongoose.model('Lead', leadSchema);
export default Lead;
