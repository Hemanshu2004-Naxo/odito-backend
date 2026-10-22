import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import {
  OPTIMIZATION_OPERATIONS, OPTIMIZATION_TARGETS, RECOMMENDATION_STATUSES, RISK_LEVELS, CONFIDENCE_LEVELS,
} from '../constants/optimizationEnums.js';

/**
 * AiCampaignOptimizationRecommendation — Phase 7: a proposed ACTION, always
 * traceable back to the deterministic opportunity/opportunities that
 * motivated it. Claude drafts the `reason`/`expectedImpact` text and picks
 * `operation`/target from the closed vocabulary; the SERVER (not Claude)
 * fills in every trusted field — see recommendationValidator.js /
 * campaignOptimizationService.js. This document is the complete "what will
 * change" record the UI shows for approval (spec §19/§20) — the browser
 * never has to reconstruct it from raw Claude output.
 *
 * CORE RULE: Claude proposes. Odito validates. The user approves. Odito
 * executes. Nothing here is ever applied without an explicit
 * approve-then-execute call (campaignOptimizationService.approveRecommendation)
 * that re-validates the CURRENT live Google Ads state first (spec §18 Layer 2).
 */

const { Schema } = mongoose;

const proposedChangeSchema = new Schema(
  {
    field: { type: String, required: true, trim: true, maxlength: 100 }, // e.g. 'status', 'amountMicros', 'negativeKeyword'
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const aiMetadataSchema = new Schema(
  {
    provider: { type: String, trim: true, default: null },
    model: { type: String, trim: true, default: null },
    promptVersion: { type: String, trim: true, default: null },
    generationId: { type: String, trim: true, default: null },
    generatedAt: { type: Date, default: null },
    usage: {
      inputTokens: { type: Number, default: null },
      outputTokens: { type: Number, default: null },
    },
  },
  { _id: false },
);

const aiCampaignOptimizationRecommendationSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'SeoProject', required: true },
    draftId: { type: Schema.Types.ObjectId, ref: 'AiCampaignDraft', required: true },
    campaignResourceId: { type: String, required: true, trim: true },

    // The deterministic opportunities this recommendation responds to —
    // never empty; a recommendation Claude invents with no supporting
    // opportunity is rejected by recommendationValidator (spec §16).
    opportunityIds: { type: [{ type: Schema.Types.ObjectId, ref: 'AiCampaignOptimizationOpportunity' }], default: [] },

    operation: { type: String, required: true, enum: OPTIMIZATION_OPERATIONS },
    target: { type: String, required: true, enum: OPTIMIZATION_TARGETS },
    targetEntityId: { type: String, required: true, trim: true, maxlength: 300 },
    targetEntityLabel: { type: String, trim: true, maxlength: 300, default: null },
    // For ADD_NEGATIVE_KEYWORD, targetEntityId is the ad group id and this
    // carries the actual proposed negative keyword text/matchType — kept
    // out of proposedChange.after's Mixed blob so validators can read it typed.
    negativeKeywordText: { type: String, trim: true, maxlength: 250, default: null },
    negativeKeywordMatchType: { type: String, enum: ['BROAD', 'PHRASE', 'EXACT', null], default: null },

    proposedChange: { type: proposedChangeSchema, required: true },
    // The value the recommendation ASSUMES is currently live (compared
    // against a fresh read at approval time — Layer 2 staleness check).
    expectedCurrentValue: { type: Schema.Types.Mixed, default: null },

    reason: { type: String, required: true, trim: true, maxlength: 1000 },
    expectedImpact: { type: String, required: true, trim: true, maxlength: 500 }, // always phrased as an estimate, never a guarantee (spec §26) — enforced by recommendationValidator's language check
    confidence: { type: String, required: true, enum: CONFIDENCE_LEVELS },
    risk: { type: String, required: true, enum: RISK_LEVELS },
    supportingMetrics: { type: Schema.Types.Mixed, default: {} },

    // False for a recommendation that is informational/review-only (e.g. a
    // budget increase beyond MAX_BUDGET_INCREASE_PERCENT, or anything a
    // future operation type can't yet execute) — the UI shows it but never
    // offers an Approve-and-execute action for it (spec §24/§25).
    executable: { type: Boolean, required: true, default: true },

    status: { type: String, required: true, enum: RECOMMENDATION_STATUSES, default: 'pending' },
    decidedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },

    generationId: { type: String, trim: true, default: () => randomUUID() },
    aiMetadata: { type: aiMetadataSchema, default: () => ({}) },

    performanceDateRangeStart: { type: Date, required: true },
    performanceDateRangeEnd: { type: Date, required: true },

    // Phase 8 (additive): who produced this recommendation. A manually
    // triggered analysis (Phase 7) never sets these — default 'manual'
    // preserves every existing recommendation's meaning unchanged.
    source: { type: String, enum: ['manual', 'automation'], default: 'manual' },
    automationPolicyId: { type: Schema.Types.ObjectId, ref: 'AiCampaignAutomationPolicy', default: null },
    automationRunId: { type: Schema.Types.ObjectId, ref: 'AiCampaignAutomationRun', default: null },
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
    collection: 'ai_campaign_optimization_recommendations',
  },
);

aiCampaignOptimizationRecommendationSchema.index({ projectId: 1, draftId: 1, status: 1 }, { name: 'project_draft_status' });
aiCampaignOptimizationRecommendationSchema.index({ projectId: 1, draftId: 1, createdAt: -1 }, { name: 'project_draft_created' });
// MAX_RECOMMENDATIONS_PER_ENTITY enforcement — "does this entity already have an open recommendation".
aiCampaignOptimizationRecommendationSchema.index({ draftId: 1, target: 1, targetEntityId: 1, status: 1 }, { name: 'draft_target_entity_status' });

aiCampaignOptimizationRecommendationSchema.set('toJSON', {
  transform: (_doc, ret) => { delete ret.__v; return ret; },
});

const AiCampaignOptimizationRecommendation = mongoose.model('AiCampaignOptimizationRecommendation', aiCampaignOptimizationRecommendationSchema);

export default AiCampaignOptimizationRecommendation;
