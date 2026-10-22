import mongoose from 'mongoose';

/**
 * Records every admin-performed manual override on a user's subscription —
 * plan assignment, quota adjustment, or status update (Phase 15 Task 7).
 *
 * Deliberately NOT stored on Transaction: Transaction's `stripeEventId` is
 * required+unique because every Transaction is Stripe-webhook-sourced — an
 * admin action has no Stripe event behind it, so forcing it into that model
 * would mean either faking an event id or loosening a constraint that
 * exists specifically to guarantee Transaction is always traceable back to
 * a real Stripe event. Same reasoning Phase 13 used for why WebhookEvent
 * couldn't double as Transaction. This is a distinct concern — "what did an
 * admin change, for whom, and why" — with its own shape.
 *
 * Renamed from AdminAuditLog -> SystemAdminAuditLog (identifiers/collection
 * only — schema fields, enum values, and behavior are unchanged) so the
 * model name unambiguously matches the System Admin module it belongs to.
 * No explicit collection name is passed here, same as before the rename —
 * Mongoose's default lowercase+pluralize of 'SystemAdminAuditLog' already
 * derives exactly 'systemadminauditlogs'.
 */
const systemAdminAuditLogSchema = new mongoose.Schema({
  admin: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  targetUser: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  action: {
    type: String,
    // account_suspended/account_activated added in Phase 2C (System Admin
    // User Management) — distinct from status_update, which is
    // subscription.status, not the account-level isActive flag.
    // project_audit_started/project_deleted added in Phase 2H (System Admin
    // Projects) — targetUser is the PROJECT OWNER, not the admin.
    // project_restored/project_permanently_deleted added when System Admin
    // gained trash management — same targetUser convention.
    enum: [
      'plan_assignment', 'quota_adjustment', 'status_update',
      'account_suspended', 'account_activated',
      'project_audit_started', 'project_deleted',
      'project_restored', 'project_permanently_deleted',
    ],
    required: true,
  },
  // Free-form before/after snapshots — deliberately Mixed rather than a
  // rigid sub-schema, since each `action` type captures a different shape
  // (plan id vs {credits,pages} limits vs status string).
  before: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  after: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  reason: {
    type: String,
    default: null,
  },
}, {
  timestamps: true,
});

systemAdminAuditLogSchema.index({ targetUser: 1, createdAt: -1 });

const SystemAdminAuditLog = mongoose.model('SystemAdminAuditLog', systemAdminAuditLogSchema);
export default SystemAdminAuditLog;
