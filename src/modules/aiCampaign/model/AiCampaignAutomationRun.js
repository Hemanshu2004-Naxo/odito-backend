import mongoose from 'mongoose';
import {
  AUTOMATION_RUN_STATUSES, AUTOMATION_MODES, AUTOMATION_ACTION_STATUSES, AUTOMATION_SKIP_REASONS,
  AUTOMATION_OPERATIONS, OPERATION_TARGET, AUTOMATION_ERROR_CODES,
} from '../constants/automationEnums.js';

/**
 * AiCampaignAutomationRun — Phase 8: the durable, idempotent audit record
 * of one scheduler tick evaluating one policy.
 *
 * IDEMPOTENCY: unique on `{projectId, policyId, scheduledWindow}`.
 * `scheduledWindow` is the ISO string of `policy.nextRunAt` AS READ by the
 * scheduler at claim time — a server-derived, deterministic value, never a
 * client-supplied id (the same idempotency-key discipline as Phase 6's
 * `{projectId,draftId,draftVersion}` and Phase 7's `recommendationId`
 * alone). Two scheduler ticks (same process racing itself, or two app
 * instances) that both observe the same policy as due for the same
 * scheduled window can create at most one run document between them — the
 * unique index rejects the loser outright.
 *
 * CONCURRENCY / CRASH RECOVERY: `claimRun` (automationRunService.js) is the
 * one atomic `findOneAndUpdate` that may move a run into `'running'`,
 * mirroring Phase 6's `claimPublishLock` / Phase 7's `claimExecutionLock`
 * exactly, including the stale-lock `$or` reclaim clause.
 *
 * `mode` is a SNAPSHOT of `policy.mode` at the moment this run started — a
 * policy edited mid-run never changes an already-in-flight run's behavior.
 */

const { Schema } = mongoose;

const automationActionSchema = new Schema(
  {
    ruleIndex: { type: Number, required: true },
    operation: { type: String, required: true, enum: AUTOMATION_OPERATIONS },
    target: { type: String, required: true, enum: Object.values(OPERATION_TARGET) },
    targetEntityId: { type: String, trim: true, maxlength: 300, default: null },
    targetEntityLabel: { type: String, trim: true, maxlength: 300, default: null },

    matchedMetric: { type: String, trim: true, default: null },
    matchedValue: { type: Schema.Types.Mixed, default: null },
    threshold: { type: Schema.Types.Mixed, default: null },

    status: { type: String, required: true, enum: AUTOMATION_ACTION_STATUSES },
    skipReason: { type: String, enum: [...AUTOMATION_SKIP_REASONS, null], default: null },

    // References into Phase 7's own recommendation/execution collections —
    // an automation-produced recommendation is a REAL AiCampaignOptimizationRecommendation
    // (source:'automation'), not a parallel record type.
    recommendationId: { type: Schema.Types.ObjectId, ref: 'AiCampaignOptimizationRecommendation', default: null },
    executionId: { type: Schema.Types.ObjectId, ref: 'AiCampaignOptimizationExecution', default: null },

    errorCode: { type: String, trim: true, default: null },
    errorMessage: { type: String, trim: true, maxlength: 500, default: null },
  },
  { _id: false },
);

const aiCampaignAutomationRunSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'SeoProject', required: true },
    draftId: { type: Schema.Types.ObjectId, ref: 'AiCampaignDraft', required: true },
    policyId: { type: Schema.Types.ObjectId, ref: 'AiCampaignAutomationPolicy', required: true },
    campaignResourceId: { type: String, trim: true, default: null },

    scheduledWindow: { type: String, required: true, trim: true },
    mode: { type: String, required: true, enum: AUTOMATION_MODES },
    trigger: { type: String, required: true, enum: ['automation'], default: 'automation' },

    status: { type: String, required: true, enum: AUTOMATION_RUN_STATUSES, default: 'pending' },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },

    actionsPlanned: { type: Number, default: 0 },
    actionsExecuted: { type: Number, default: 0 },
    actionsRecommended: { type: Number, default: 0 },
    actionsSkipped: { type: Number, default: 0 },
    actionsFailed: { type: Number, default: 0 },

    actions: {
      type: [automationActionSchema],
      default: [],
      validate: { validator: (v) => v.length <= 100, message: 'A single run may not record more than 100 actions.' },
    },

    // Run-level failure — the whole run aborted before evaluating any rule
    // (e.g. no performance data available yet), distinct from a single
    // action's own failure inside `actions[]`.
    failureCode: { type: String, trim: true, enum: [...AUTOMATION_ERROR_CODES, null], default: null },
    failureMessage: { type: String, trim: true, maxlength: 500, default: null },
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
    collection: 'ai_campaign_automation_runs',
  },
);

aiCampaignAutomationRunSchema.index(
  { projectId: 1, policyId: 1, scheduledWindow: 1 },
  { unique: true, name: 'unique_policy_scheduled_window' },
);
aiCampaignAutomationRunSchema.index({ projectId: 1, draftId: 1, createdAt: -1 }, { name: 'project_draft_created' });
aiCampaignAutomationRunSchema.index({ policyId: 1, createdAt: -1 }, { name: 'policy_created' });

aiCampaignAutomationRunSchema.set('toJSON', {
  transform: (_doc, ret) => { delete ret.__v; return ret; },
});

const AiCampaignAutomationRun = mongoose.model('AiCampaignAutomationRun', aiCampaignAutomationRunSchema);

export default AiCampaignAutomationRun;
