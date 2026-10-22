import mongoose from 'mongoose';
import { EXECUTION_STATUSES, OPTIMIZATION_OPERATIONS, OPTIMIZATION_TARGETS, OPTIMIZATION_ERROR_CODES } from '../constants/optimizationEnums.js';

/**
 * AiCampaignOptimizationExecution — Phase 7: the durable, idempotent record
 * of executing one approved AiCampaignOptimizationRecommendation.
 *
 * IDEMPOTENCY (spec §22): unique on `recommendationId` alone — a
 * recommendation's own identity already encodes project + draft + campaign
 * + target (it's a specific, immutable document referencing all of those),
 * and a recommendation is a one-way pending -> approved -> executed|failed
 * street (see optimizationEnums.RECOMMENDATION_TRANSITIONS: `executed` and
 * `failed` are both terminal, `pending`/`approved` can never recur once
 * left). So "at most one execution document per recommendation, ever" is
 * exactly "never apply the same optimization twice" (spec §22's own
 * example). A frontend-generated UUID is never trusted as the idempotency
 * key — only this server-enforced unique index is.
 *
 * CONCURRENCY (spec §23): the atomic lock is `findOneAndUpdate({_id,
 * status:{$in:RETRYABLE_EXECUTION_STATUSES}}, {$set:{status:'executing'}})`
 * — see optimizationExecutor.js — the same MongoDB single-document write
 * atomicity pattern as Phase 6's AiCampaignPublishAttempt.
 *
 * ROLLBACK-READY AUDIT (spec §33/§34): `beforeState`/`afterState` capture
 * exactly what changed, in Odito's own normalized shape — enough to
 * understand or manually reverse a change without a second Google Ads read.
 * Never stores OAuth tokens, raw credentials, or raw provider payloads.
 */

const { Schema } = mongoose;

const aiCampaignOptimizationExecutionSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'SeoProject', required: true },
    draftId: { type: Schema.Types.ObjectId, ref: 'AiCampaignDraft', required: true },
    recommendationId: { type: Schema.Types.ObjectId, ref: 'AiCampaignOptimizationRecommendation', required: true },
    campaignResourceId: { type: String, required: true, trim: true },

    operation: { type: String, required: true, enum: OPTIMIZATION_OPERATIONS },
    target: { type: String, required: true, enum: OPTIMIZATION_TARGETS },
    targetEntityId: { type: String, required: true, trim: true, maxlength: 300 },
    googleResourceName: { type: String, trim: true, maxlength: 300, default: null }, // set once the mutation succeeds (or is adopted via reconciliation)

    executedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    status: { type: String, required: true, enum: EXECUTION_STATUSES, default: 'pending' },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },

    beforeState: { type: Schema.Types.Mixed, default: null },
    afterState: { type: Schema.Types.Mixed, default: null },

    failureCode: { type: String, trim: true, enum: [...OPTIMIZATION_ERROR_CODES, null], default: null },
    failureMessage: { type: String, trim: true, maxlength: 500, default: null },

    // Phase 8 (additive): distinguishes a human's manual approve click from
    // an automation policy's own execute-mode action. Default 'manual'
    // preserves every existing execution's meaning unchanged.
    trigger: { type: String, enum: ['manual', 'automation'], default: 'manual' },
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
    collection: 'ai_campaign_optimization_executions',
  },
);

aiCampaignOptimizationExecutionSchema.index(
  { recommendationId: 1 },
  { unique: true, name: 'unique_recommendation' },
);
aiCampaignOptimizationExecutionSchema.index({ projectId: 1, draftId: 1, status: 1 }, { name: 'project_draft_status' });
aiCampaignOptimizationExecutionSchema.index({ projectId: 1, draftId: 1, createdAt: -1 }, { name: 'project_draft_created' });

aiCampaignOptimizationExecutionSchema.set('toJSON', {
  transform: (_doc, ret) => { delete ret.__v; return ret; },
});

const AiCampaignOptimizationExecution = mongoose.model('AiCampaignOptimizationExecution', aiCampaignOptimizationExecutionSchema);

export default AiCampaignOptimizationExecution;
