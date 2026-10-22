import mongoose from 'mongoose';

/**
 * RecommendationTemplate Model
 * 
 * Pre-written recommendation templates keyed by rule_id + pageType + framework.
 * Template-first architecture: ~75% of recommendations resolved without AI calls.
 * 
 * Templates use interpolation slots: {{pageType}}, {{framework}}, {{ruleId}}
 * Resolved at runtime by templateService.
 */

const recommendationTemplateSchema = new mongoose.Schema({
  // ── Identity ──────────────────────────────────────────────────────────────
  ruleId: { type: String, required: true, index: true },
  pageType: { type: String, default: '_default' }, // _default = any page type
  framework: { type: String, default: '_default' }, // _default = any framework

  // ── Template Content ──────────────────────────────────────────────────────
  sections: {
    whyThisMatters: { type: String, required: true },
    recommendedFix: { type: String, required: true },
    implementationExample: {
      type: { type: String, enum: ['html', 'jsx', 'json', 'text'], default: 'html' },
      content: { type: String, required: true },
    },
    expectedImpact: { type: [String], default: [] },
    estimatedRecovery: {
      aiVisibility: { type: Number, default: 0 },
      semanticTrust: { type: Number, default: 0 },
      freshness: { type: Number, default: 0 },
      accessibility: { type: Number, default: 0 },
    },
    difficulty: { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium' },
    estimatedFixTime: { type: String, default: '15 minutes' },
  },

  // ── Versioning ────────────────────────────────────────────────────────────
  version: { type: Number, default: 1 },
  isActive: { type: Boolean, default: true, index: true },

}, {
  timestamps: true,
  collection: 'recommendation_templates',
});

// ── Indexes ───────────────────────────────────────────────────────────────────
recommendationTemplateSchema.index(
  { ruleId: 1, pageType: 1, framework: 1 },
  { unique: true }
);

// ── Statics ───────────────────────────────────────────────────────────────────

/**
 * Find best-matching template with fallback chain:
 * 1. Exact match (ruleId + pageType + framework)
 * 2. Rule + pageType + _default framework
 * 3. Rule + _default pageType + _default framework
 */
recommendationTemplateSchema.statics.findBestMatch = async function (ruleId, pageType, framework) {
  // Try exact match first
  let template = await this.findOne({
    ruleId,
    pageType,
    framework,
    isActive: true,
  });
  if (template) return template;

  // Try rule + pageType + any framework
  template = await this.findOne({
    ruleId,
    pageType,
    framework: '_default',
    isActive: true,
  });
  if (template) return template;

  // Try rule + any page type + any framework
  template = await this.findOne({
    ruleId,
    pageType: '_default',
    framework: '_default',
    isActive: true,
  });

  return template;
};

const RecommendationTemplate = mongoose.model('RecommendationTemplate', recommendationTemplateSchema);

export default RecommendationTemplate;
