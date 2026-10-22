import mongoose from 'mongoose';

/**
 * A Custom Plan lead — submitted via the Choose Plan page's "Custom" card
 * when Starter/Pro/Premium's fixed tiers don't fit. Deliberately its OWN
 * collection, not a Transaction/Stripe-adjacent record: nothing here ever
 * touches Stripe, User.subscription, or credits/pages — it is purely a
 * sales lead captured for a human to follow up on (see
 * service/customPlanRequestService.js and, in Phase 5, the admin panel
 * that will manage `status`/`adminNotes`).
 *
 * One user may have MULTIPLE requests over time (history is preserved, not
 * overwritten) — service-layer duplicate-prevention (not a unique index)
 * blocks a second 'pending'/'contacted' request while one is already open;
 * a 'closed' request never blocks a new one. See
 * submitCustomPlanRequest()/getLatestCustomPlanRequest() in the service layer.
 */
const customPlanRequestSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },

  // ── Company & contact ──────────────────────────────────────────────────
  companyName: {
    type: String,
    required: true,
    trim: true,
    maxlength: 200,
  },
  companyWebsite: {
    type: String,
    trim: true,
    default: null,
    maxlength: 500,
  },
  contactName: {
    type: String,
    required: true,
    trim: true,
    maxlength: 150,
  },
  contactEmail: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    maxlength: 254,
  },
  contactPhone: {
    type: String,
    trim: true,
    default: null,
    maxlength: 40,
  },
  teamSize: {
    type: String,
    required: true,
    enum: ['1-10', '11-50', '51-200', '200+'],
  },

  // ── Requirements ────────────────────────────────────────────────────────
  projectCount: {
    type: Number,
    required: true,
    min: 1,
    max: 100000,
  },
  requiredCredits: {
    type: Number,
    default: null,
    min: 0,
    max: 1000000,
  },
  requiredPages: {
    type: Number,
    default: null,
    min: 0,
    max: 100000000,
  },
  // Free-form multi-select — kept as an array of short enum strings rather
  // than free text, matching config/plans.js's own philosophy of enums as
  // the source of truth over loose strings, so this stays filterable by a
  // future admin view (Phase 5) without text parsing.
  featureRequirements: {
    type: [String],
    default: [],
    validate: {
      validator: (arr) => (arr || []).every((v) =>
        ['white_label', 'api_access', 'sso_saml', 'dedicated_account_manager', 'custom_integrations'].includes(v)
      ),
      message: 'featureRequirements contains an unknown value',
    },
  },
  // `null` must be listed explicitly in each enum — Mongoose's enum
  // validator only skips `undefined`, not `null`, so a bare `default: null`
  // against an enum that doesn't include it fails validation the moment
  // this field is actually omitted (exactly the bug User.js's
  // subscription.plan field comment already documents and fixes).
  budgetRange: {
    type: String,
    enum: ['not_sure', '500_1000', '1000_5000', '5000_plus', null],
    default: null,
  },
  timeline: {
    type: String,
    enum: ['immediately', 'within_30_days', 'exploring', null],
    default: null,
  },
  additionalRequirements: {
    type: String,
    trim: true,
    default: null,
    maxlength: 2000,
  },

  // ── Lifecycle (managed by Phase 5's admin panel; this phase only ever
  //    writes 'pending' at creation) ───────────────────────────────────────
  // Phase 4 only ever writes 'pending'. Phase 5's admin panel will manage
  // the rest of the lifecycle — this enum is deliberately the minimal set
  // STEP 8's CTA logic actually branches on (Request Pending / View Request
  // / allow-another-request), not a speculative full sales pipeline; extending
  // it later (e.g. a 'negotiating' state) is a config-only enum change, same
  // extensibility philosophy as config/plans.js.
  status: {
    type: String,
    enum: ['pending', 'contacted', 'closed'],
    default: 'pending',
    index: true,
  },
  // { note, addedBy, addedAt } — internal-only, never returned by the
  // customer-facing GET /custom-request/me endpoint. Embedded rather than a
  // separate collection: realistically a handful of notes per request, not
  // worth a second collection's overhead (same reasoning already applied to
  // this codebase's other small embedded-note patterns).
  adminNotes: {
    type: [{
      note: { type: String, required: true, trim: true, maxlength: 2000 },
      addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
      addedAt: { type: Date, default: Date.now },
    }],
    default: [],
  },
  // Phase 5 — the Timeline card's status-change events. Deliberately its OWN
  // embedded log, NOT SystemAdminAuditLog: that model's `targetUser` field is a
  // required ref to User specifically (see its own doc comment — designed
  // for per-user admin overrides), not generalizable to a CustomPlanRequest
  // without either faking a User id or loosening a constraint other admin
  // flows depend on. Same "handful of entries, not worth a second
  // collection" reasoning as adminNotes above.
  statusHistory: {
    type: [{
      fromStatus: { type: String, default: null },
      toStatus: { type: String, required: true },
      changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
      changedAt: { type: Date, default: Date.now },
    }],
    default: [],
  },
}, {
  timestamps: true,
});

// A user's own request history, newest first (GET /custom-request/me and
// the duplicate-prevention check in the service layer).
customPlanRequestSchema.index({ userId: 1, createdAt: -1 });
// Phase 5's admin list view, filtered by status, newest first.
customPlanRequestSchema.index({ status: 1, createdAt: -1 });

const CustomPlanRequest = mongoose.model('CustomPlanRequest', customPlanRequestSchema);
export default CustomPlanRequest;
