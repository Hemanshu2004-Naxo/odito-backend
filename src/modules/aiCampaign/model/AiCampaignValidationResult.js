import mongoose from 'mongoose';
import { ISSUE_SEVERITIES, ISSUE_CATEGORIES, READINESS_STATUSES } from '../constants/validationEnums.js';

/**
 * AiCampaignValidationResult — Phase 5: the persisted outcome of running
 * pre-publish readiness validation against one AiCampaignDraft at one
 * specific version.
 *
 * Dedicated collection (spec §44), not embedded in AiCampaignDraft: results
 * are independently queried (history, "latest for this draft"), and most
 * are superseded the moment the user makes another edit — embedding would
 * mean rewriting the draft document itself just to record a read-only
 * check.
 *
 * STALE-RESULT PROTECTION (spec §24/§25): `draftVersion` records the exact
 * AiCampaignDraft.version this result was computed against. A result is
 * only ever "current" when it matches the draft's LIVE version — computed
 * server-side on every read (see campaignValidationService.getLatestResult),
 * never inferred client-side from a cached value alone.
 *
 * IDEMPOTENCY (spec §45): unique on {projectId, draftId, draftVersion} —
 * re-running validation for the same draft version upserts the SAME
 * document rather than accumulating duplicates. A genuinely new document is
 * only created when the version changes (i.e. the draft actually changed).
 */

const { Schema } = mongoose;

const issueSchema = new Schema(
  {
    code: { type: String, required: true, trim: true, maxlength: 100 },
    severity: { type: String, required: true, enum: ISSUE_SEVERITIES },
    category: { type: String, required: true, enum: ISSUE_CATEGORIES },
    // Dot/bracket path into the draft this issue concerns, e.g.
    // "adGroups[0].ads[0].headlines". Display/audit only — never parsed.
    path: { type: String, trim: true, maxlength: 300, default: null },
    message: { type: String, required: true, trim: true, maxlength: 500 },
    recommendation: { type: String, trim: true, maxlength: 500, default: null },
  },
  { _id: false },
);

/** One category's roll-up for the "✓ Campaign structure / ✓ Budget / …" checklist. */
const checkSchema = new Schema(
  {
    category: { type: String, required: true, enum: ISSUE_CATEGORIES },
    passed: { type: Boolean, required: true }, // true when this category has zero errors (warnings don't fail a check)
    errorCount: { type: Number, required: true, default: 0 },
    warningCount: { type: Number, required: true, default: 0 },
  },
  { _id: false },
);

const aiCampaignValidationResultSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'SeoProject', required: true },
    draftId: { type: Schema.Types.ObjectId, ref: 'AiCampaignDraft', required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    // The AiCampaignDraft.version this result was computed against — the
    // staleness fingerprint (see file header).
    draftVersion: { type: Number, required: true, min: 1 },

    // READY only when errorCount === 0 across every category, including
    // google_ads account readiness — spec §22's "do not conflate valid
    // with publishable" is satisfied by folding account readiness into the
    // SAME error count, not by a second flag.
    status: { type: String, required: true, enum: READINESS_STATUSES },

    summary: {
      errorCount: { type: Number, required: true, default: 0 },
      warningCount: { type: Number, required: true, default: 0 },
      infoCount: { type: Number, required: true, default: 0 },
      passedCount: { type: Number, required: true, default: 0 },
    },

    issues: { type: [issueSchema], default: [] },
    checks: { type: [checkSchema], default: [] },

    validationVersion: { type: String, required: true, trim: true, maxlength: 100 },
    validatedAt: { type: Date, required: true, default: Date.now },
    durationMs: { type: Number, default: null },
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
    collection: 'ai_campaign_validation_results',
  },
);

// The one index this module needs: idempotent upsert key AND "latest result
// for this draft" read (sort draftVersion desc, limit 1) — both served by
// the same compound unique index. projectId is included for tenant-scoped
// defence in depth, matching AiCampaignChangeProposal's own convention.
aiCampaignValidationResultSchema.index(
  { projectId: 1, draftId: 1, draftVersion: 1 },
  { unique: true, name: 'unique_project_draft_version' },
);

aiCampaignValidationResultSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

const AiCampaignValidationResult = mongoose.model('AiCampaignValidationResult', aiCampaignValidationResultSchema);

export default AiCampaignValidationResult;
