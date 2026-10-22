import mongoose from 'mongoose';
import {
  OPPORTUNITY_TYPES, OPPORTUNITY_SEVERITIES, OPPORTUNITY_ENTITY_TYPES, OPPORTUNITY_STATUSES, CONFIDENCE_LEVELS,
} from '../constants/optimizationEnums.js';

/**
 * AiCampaignOptimizationOpportunity — Phase 7: a DETERMINISTIC signal
 * computed from normalized Google Ads performance data, with zero AI
 * involvement (spec §13's "Opportunity = deterministic signal" vs
 * "Recommendation = proposed action"). Reproducible and explainable without
 * ever calling Claude — see service/optimization/opportunityDetector.js,
 * the only writer of `metrics`/`baseline`/`severity`.
 *
 * DEDUPLICATION (spec §12): unique on `{draftId, entityType, entityId,
 * opportunityType, dateRangeKey}` — re-running detection for the SAME
 * entity/type/date-range upserts the same document (refreshed metrics,
 * `detectedAt`) rather than accumulating duplicates. A different date range
 * is a genuinely new evaluation and gets its own row.
 */

const { Schema } = mongoose;

const optimizationOpportunitySchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'SeoProject', required: true },
    draftId: { type: Schema.Types.ObjectId, ref: 'AiCampaignDraft', required: true },
    campaignResourceId: { type: String, required: true, trim: true }, // the numeric Google Ads campaign id (AiCampaignDraft.googleAdsCampaignId) — the trusted association (spec §49)

    entityType: { type: String, required: true, enum: OPPORTUNITY_ENTITY_TYPES },
    // The Google Ads resource id (campaign_id / ad_group_id / criterion_id / ad_id / search-term composite key) this opportunity is about.
    entityId: { type: String, required: true, trim: true, maxlength: 300 },
    entityLabel: { type: String, trim: true, maxlength: 300, default: null }, // human-readable (keyword text, ad group name, ...) for display without a second lookup

    opportunityType: { type: String, required: true, enum: OPPORTUNITY_TYPES },
    severity: { type: String, required: true, enum: OPPORTUNITY_SEVERITIES },
    confidence: { type: String, required: true, enum: CONFIDENCE_LEVELS },

    // Plain-object snapshot of the metrics that triggered this opportunity
    // (already-normalized Odito performance shape — see performanceDataService.js).
    metrics: { type: Schema.Types.Mixed, default: {} },
    // What the metrics were compared AGAINST (e.g. { campaignAverageCpa: 42.5 }) — never a hardcoded external benchmark (spec §10).
    baseline: { type: Schema.Types.Mixed, default: {} },

    message: { type: String, required: true, trim: true, maxlength: 500 },

    dateRangeStart: { type: Date, required: true },
    dateRangeEnd: { type: Date, required: true },
    // Deterministic string key for the unique index — "YYYY-MM-DD_YYYY-MM-DD".
    dateRangeKey: { type: String, required: true, trim: true },

    status: { type: String, required: true, enum: OPPORTUNITY_STATUSES, default: 'open' },

    detectedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
    collection: 'ai_campaign_optimization_opportunities',
  },
);

optimizationOpportunitySchema.index(
  { draftId: 1, entityType: 1, entityId: 1, opportunityType: 1, dateRangeKey: 1 },
  { unique: true, name: 'unique_draft_entity_type_daterange' },
);
optimizationOpportunitySchema.index({ projectId: 1, draftId: 1, status: 1 }, { name: 'project_draft_status' });
optimizationOpportunitySchema.index({ projectId: 1, draftId: 1, createdAt: -1 }, { name: 'project_draft_created' });

optimizationOpportunitySchema.set('toJSON', {
  transform: (_doc, ret) => { delete ret.__v; return ret; },
});

const AiCampaignOptimizationOpportunity = mongoose.model('AiCampaignOptimizationOpportunity', optimizationOpportunitySchema);

export default AiCampaignOptimizationOpportunity;
