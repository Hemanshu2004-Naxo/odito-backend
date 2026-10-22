import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import {
  PROPOSAL_OPERATIONS,
  PROPOSAL_TARGETS,
  PROPOSAL_STATUSES,
  DEFAULT_PROPOSAL_STATUS,
} from '../constants/proposalEnums.js';
import { AI_PROVIDERS } from '../constants/aiCampaignEnums.js';
import { INSTRUCTION_MAX_LENGTH } from '../constants/editingConfig.js';

/**
 * AiCampaignChangeProposal — Phase 4: a structured, reviewable set of
 * changes Claude proposed for one AiCampaignDraft, in response to a user's
 * conversational instruction.
 *
 * Dedicated collection (spec §50) rather than embedding proposals inside
 * AiCampaignDraft: proposals can grow independently of the draft (many
 * proposals per draft over a conversation, most rejected/superseded), and
 * embedding them would bloat every draft read with data the workspace
 * doesn't need on every load.
 *
 * CORE DESIGN RULE (spec §2): Claude never mutates MongoDB directly. This
 * document is the STRUCTURED PROPOSAL — inert data — never applied until a
 * user explicitly accepts it (campaignProposalService.acceptProposal),
 * which re-validates everything and writes to AiCampaignDraft through the
 * existing campaignDraftService, not through this model.
 *
 * STALE-DRAFT PROTECTION (spec §9): `baseVersion` records
 * AiCampaignDraft.version at generation time. Acceptance is only permitted
 * when the draft's CURRENT version still equals `baseVersion` — enforced
 * atomically via the `version` filter on the draft's own findOneAndUpdate
 * (optimistic concurrency control), not by a separate read-then-compare
 * step. No new field was needed on AiCampaignDraft: `version` already
 * existed (Phase 1) for exactly this purpose; Phase 4 additionally makes
 * campaignDraftService.updateDraft() increment it on every accepted manual
 * edit, so a manual edit made while Claude was "thinking" reliably
 * invalidates an in-flight proposal.
 *
 * NO ARBITRARY PATHS (spec §7): a change is never a string path that gets
 * parsed/traversed. `target` is a closed enum (constants/proposalEnums.js);
 * `adGroupId`/`adId` are plain string fields (never used as object keys);
 * `path` is a SERVER-COMPUTED display string for the UI/audit trail, built
 * only after a change is validated against the real draft — never trusted
 * from Claude and never executed.
 */

const { Schema } = mongoose;

// ── one proposed change ─────────────────────────────────────────────────
const proposedChangeSchema = new Schema(
  {
    id: { type: String, required: true, default: () => randomUUID() },
    operation: { type: String, required: true, enum: PROPOSAL_OPERATIONS },
    target: { type: String, required: true, enum: PROPOSAL_TARGETS },
    // Parent identifiers — plain data, NEVER used as an object/Mongo key.
    // Only the target-specific applier code in campaignProposalApplier.js
    // decides what to do with them.
    adGroupId: { type: String, trim: true, default: null },
    adId: { type: String, trim: true, default: null },
    // The value being replaced/removed (for `replace`/`remove`) and the new
    // value (for `add`/`replace`). Shape depends on `target` — validated by
    // proposalValidator.js before this document is ever written. Mixed
    // because a change can touch a string (a headline), a number (budget),
    // or a whole object (a new ad group / ad / keyword).
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    // Claude's short justification — shown in the diff UI. Never business
    // fact content on its own; the campaign fields above carry the actual
    // change.
    reason: { type: String, trim: true, maxlength: 300, default: null },
    // Server-computed, human-readable path for display/audit ONLY (e.g.
    // "adGroups[1].ads[0].headlines[2]") — built by proposalValidator.js
    // from the resolved indices, never parsed back into a traversal.
    path: { type: String, trim: true, maxlength: 300, default: null },
  },
  { _id: false },
);

// ── AI metadata (same shape/rationale as AiCampaignDraft.aiMetadata) ─────
const proposalAiMetadataSchema = new Schema(
  {
    provider: { type: String, enum: [...AI_PROVIDERS, null], default: null },
    model: { type: String, trim: true, default: null },
    promptVersion: { type: String, trim: true, default: null },
    generationId: { type: String, trim: true, default: null },
    generatedAt: { type: Date, default: null },
    usage: {
      inputTokens: { type: Number, default: null },
      outputTokens: { type: Number, default: null },
    },
    generationDurationMs: { type: Number, default: null },
  },
  { _id: false },
);

const lastErrorSchema = new Schema(
  {
    code: { type: String, trim: true, default: null },
    message: { type: String, trim: true, default: null },
    at: { type: Date, default: null },
  },
  { _id: false },
);

const aiCampaignChangeProposalSchema = new Schema(
  {
    // Tenant boundary — kept alongside draftId (not derived-only) so every
    // query here can filter on projectId directly, matching the rest of the
    // module's tenant-aware convention (spec §29/§50), rather than requiring
    // a join back to AiCampaignDraft just to scope a read.
    projectId: { type: Schema.Types.ObjectId, ref: 'SeoProject', required: true },
    draftId: { type: Schema.Types.ObjectId, ref: 'AiCampaignDraft', required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    // The untrusted user instruction (spec §14). Stored as plain text only
    // — never interpreted, never concatenated into a system prompt.
    instruction: { type: String, required: true, trim: true, maxlength: INSTRUCTION_MAX_LENGTH },

    // Optimistic-concurrency fingerprint — see file header.
    baseVersion: { type: Number, required: true, min: 1 },

    status: { type: String, enum: PROPOSAL_STATUSES, default: DEFAULT_PROPOSAL_STATUS, required: true },

    // Claude's short explanation of the proposal as a whole (spec §18/§19).
    // Capped and trimmed — never raw markdown/HTML rendered as such.
    summary: {
      explanation: { type: String, trim: true, maxlength: 1000, default: null },
    },

    changes: { type: [proposedChangeSchema], default: [] },

    aiMetadata: { type: proposalAiMetadataSchema, default: () => ({}) },
    lastError: { type: lastErrorSchema, default: () => ({}) },

    // Freshness (spec §27) — a plain expiry timestamp, checked at read/accept
    // time. No scheduled cleanup job.
    expiresAt: { type: Date, required: true },

    acceptedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
    // The draft's `version` immediately after this proposal was applied —
    // audit trail only (spec §34).
    resultingVersion: { type: Number, default: null },
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
    collection: 'ai_campaign_change_proposals',
  },
);

// One index: the only real query pattern this module has — "this draft's
// proposals, newest first", already scoped by projectId for defence in
// depth. No per-status or per-user index added speculatively (spec §50).
aiCampaignChangeProposalSchema.index({ projectId: 1, draftId: 1, createdAt: -1 });

aiCampaignChangeProposalSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

const AiCampaignChangeProposal = mongoose.model('AiCampaignChangeProposal', aiCampaignChangeProposalSchema);

export default AiCampaignChangeProposal;
