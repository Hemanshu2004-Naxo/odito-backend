import mongoose from 'mongoose';
import {
  AUTOMATION_MODES, RULE_METRICS, RULE_OPERATORS, AUTOMATION_OPERATIONS, AUTOMATION_FREQUENCIES,
} from '../constants/automationEnums.js';
import { USER_LIMIT_CEILING } from '../constants/automationConfig.js';

/**
 * AiCampaignAutomationPolicy — Phase 8: a user-authored, closed-schema
 * automation policy for ONE published campaign (scoped by `draftId`, the
 * same trusted Odito-draft -> Google-Ads-campaign association Phase 6/7
 * already established — never a raw client-supplied Google campaign id).
 *
 * Deliberately NOT a rules engine with eval/expressions/raw code: every
 * rule is a closed (metric, operator, threshold) triple against Phase 7's
 * own normalized metric vocabulary (see automationEnums.RULE_METRICS),
 * paired with one of Phase 7's own closed OPTIMIZATION_OPERATIONS. There is
 * no way to express anything this schema doesn't already enumerate.
 *
 * `enabled` defaults false and `mode` defaults 'observe' — a policy does
 * NOTHING until a user explicitly turns it on (spec: "default: disabled +
 * observe"). Neither field is ever written by the scheduler/orchestrator —
 * only by automationPolicyService, itself only ever called from an explicit
 * user request.
 *
 * `version` is bumped on every structural edit (rules/limits/schedule/
 * allowedOperations) — same optimistic-concurrency convention as
 * AiCampaignDraft.version — so a stale "run now" preview or a race between
 * two edits from two tabs is detectable, though the running scheduler
 * itself always reads the latest document fresh per tick rather than
 * caching it.
 */

const { Schema } = mongoose;

const ruleSchema = new Schema(
  {
    operation: { type: String, required: true, enum: AUTOMATION_OPERATIONS },
    metric: { type: String, required: true, enum: RULE_METRICS },
    operator: { type: String, required: true, enum: RULE_OPERATORS },
    threshold: { type: Number, required: true },
    // Data-sufficiency floor for THIS rule — a matched entity with fewer
    // clicks than this never produces a candidate action, regardless of how
    // strongly the metric condition is met (clamped server-side against
    // MIN_ALLOWED_RULE_MINIMUM_CLICKS at write time — see automationPolicyService.js).
    minimumClicks: { type: Number, required: true },
    priority: { type: Number, required: true, default: 0 }, // lower runs first when the action limit is reached
  },
  { _id: false },
);

const limitsSchema = new Schema(
  {
    maxActionsPerRun: { type: Number, required: true, min: 1, max: USER_LIMIT_CEILING.maxActionsPerRun },
    cooldownHours: { type: Number, required: true, min: 1, max: USER_LIMIT_CEILING.cooldownHours },
    maxBudgetChangePercent: { type: Number, required: true, min: 1, max: USER_LIMIT_CEILING.maxBudgetChangePercent },
  },
  { _id: false },
);

const scheduleSchema = new Schema(
  {
    frequency: { type: String, required: true, enum: AUTOMATION_FREQUENCIES },
    // Only meaningful for 'daily'/'weekly' (wall-clock-anchored frequencies)
    // — ignored for 'every_6_hours'/'every_12_hours', which are pure
    // elapsed-time cadences (see automationScheduleCalculator.js).
    hourOfDay: { type: Number, min: 0, max: 23, default: 9 },
    dayOfWeek: { type: Number, min: 0, max: 6, default: 1 }, // 0=Sunday, only used for 'weekly'
    timezone: { type: String, trim: true, default: 'UTC' }, // validated as a real IANA zone at write time (automationPolicyService.js)
  },
  { _id: false },
);

const aiCampaignAutomationPolicySchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'SeoProject', required: true },
    draftId: { type: Schema.Types.ObjectId, ref: 'AiCampaignDraft', required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    name: { type: String, required: true, trim: true, maxlength: 150 },

    enabled: { type: Boolean, required: true, default: false },
    mode: { type: String, required: true, enum: AUTOMATION_MODES, default: 'observe' },

    rules: {
      type: [ruleSchema],
      default: [],
      validate: {
        validator: (v) => v.length <= 10,
        message: 'A policy may define at most 10 rules.',
      },
    },
    // Subset of AUTOMATION_OPERATIONS this policy may ever act on — every
    // rule's `operation` must already be a member (enforced at write time,
    // not just here) and every candidate action is re-checked against this
    // list again at run time (defense in depth — see automationGuardrails.js).
    allowedOperations: {
      type: [{ type: String, enum: AUTOMATION_OPERATIONS }],
      default: [],
    },
    highRiskOperationsEnabled: { type: Boolean, required: true, default: false },

    limits: { type: limitsSchema, required: true },
    schedule: { type: scheduleSchema, required: true },
    dateRangePreset: { type: String, trim: true, default: '30d' }, // reuses the same preset vocabulary as Phase 7's /optimization/analyze (resolveGoogleAdsDateRange)

    nextRunAt: { type: Date, default: null },
    lastRunAt: { type: Date, default: null },
    lastRunStatus: { type: String, default: null },

    version: { type: Number, required: true, default: 1 },
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
    collection: 'ai_campaign_automation_policies',
  },
);

aiCampaignAutomationPolicySchema.index({ projectId: 1, draftId: 1, createdAt: -1 }, { name: 'project_draft_created' });
// The scheduler's own due-policy scan (automationScheduler.js).
aiCampaignAutomationPolicySchema.index({ enabled: 1, nextRunAt: 1 }, { name: 'enabled_next_run' });

aiCampaignAutomationPolicySchema.set('toJSON', {
  transform: (_doc, ret) => { delete ret.__v; return ret; },
});

const AiCampaignAutomationPolicy = mongoose.model('AiCampaignAutomationPolicy', aiCampaignAutomationPolicySchema);

export default AiCampaignAutomationPolicy;
