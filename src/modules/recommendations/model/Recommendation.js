import mongoose from 'mongoose';

/**
 * Recommendation Model
 *
 * Stores cached AI-generated recommendations.
 * Keyed by fingerprint (ruleId + pageType + framework + promptGroup + scopeDiscriminator).
 *
 * For element_add / list_fix / structural_fix modes, fingerprint is URL-scoped,
 * so each page gets its own document. pageUrl is stored for reference and filtering.
 */

const recommendationSchema = new mongoose.Schema({
  // ── Identity ──────────────────────────────────────────────────────────────
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SeoProject',
    required: true,
    index: true,
  },
  fingerprint: {
    type: String,
    required: true,
    index: true,
  },
  recommendationHash: {
    type: String,
    required: true,
    index: true,
  },
  recommendationVersion: {
    type: Number,
    required: true,
    default: 1,
  },

  // ── Source Issue ──────────────────────────────────────────────────────────
  ruleId: { type: String, required: true, index: true },
  issueCode: { type: String },
  category: { type: String, required: true },
  severity: { type: String, enum: ['critical', 'high', 'medium', 'low'] },

  // ── Page URL (for URL-scoped modes: element_add, list_fix, structural_fix) ──
  pageUrl: { type: String, default: null, index: true },

  // ── Context (drives fingerprint) ──────────────────────────────────────────
  context: {
    pageType: { type: String, default: 'Unknown' },
    framework: { type: String, default: 'unknown' },
    cms: { type: String, default: null },
    detectedSchemas: { type: [String], default: [] },
    wordCount: { type: Number, default: 0 },
  },

  // ── Sample URLs (reference only, not part of fingerprint) ─────────────────
  sampleUrls: { type: [String], default: [] },

  // ── Recommendation Content (core sections) ────────────────────────────────
  sections: {
    whyThisMatters: { type: String, required: true },
    recommendedFix: { type: String, required: true },
    implementationExample: {
      type: {
        type: String,
        enum: ['html', 'jsx', 'json', 'text', 'css'],
        default: 'html',
      },
      content: { type: String, required: true },
    },
    expectedImpact: { type: [String], default: [] },
    estimatedRecovery: {
      aiVisibility:  { type: Number, default: 0 },
      semanticTrust: { type: Number, default: 0 },
      freshness:     { type: Number, default: 0 },
      accessibility: { type: Number, default: 0 },
    },
    difficulty:      { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium' },
    estimatedFixTime:{ type: String, default: '15 minutes' },

    // Phase 3 context-aware fields — present when generated from IssueContext
    recommendedVersion: { type: String, default: null },
    // images_missing_alt_text only: one proposal per image, keyed by the image's exact URL (see service/imageAltProposals.js).
    // undefined (not []) on every other recommendation, and on alt recommendations made before this existed.
    imageAltProposals: { type: [mongoose.Schema.Types.Mixed], default: undefined },
    contentRewrite: {
      optimized:         { type: String },
      characterCount:    { type: Number },
      changeExplanation: { type: String },
      before:            { type: String },
      after:             { type: String },
    },

    // Deterministic before/after states (never from Claude)
    beforeState: { type: mongoose.Schema.Types.Mixed, default: null },
    afterState:  { type: mongoose.Schema.Types.Mixed, default: null },

    // Structured change summary (field-level diff)
    changeSummary: {
      items: [{
        field:      { type: String },
        changeType: { type: String, enum: ['add', 'modify', 'remove', 'fix'] },
        before:     { type: String },
        after:      { type: String },
        reason:     { type: String },
        priority:   { type: String, enum: ['critical', 'high', 'medium', 'low'] },
      }],
    },

    // Confidence score from ConfidenceCalculator
    confidence: {
      overall:  { type: Number },
      tier:     { type: String, enum: ['grounded', 'contextual', 'generic'] },
      breakdown: { type: mongoose.Schema.Types.Mixed },
      warnings:  { type: [String], default: [] },
    },

    // Source attribution for audit trail
    sourceAttribution: {
      generatedBy:    { type: String },
      promptPath:     { type: String },
      promptGroup:    { type: Number },
      contextSources: { type: mongoose.Schema.Types.Mixed },
      modelUsed:      { type: String },
      tokensUsed:     { type: mongoose.Schema.Types.Mixed },
      generationMs:   { type: Number },
      cacheStatus:    { type: String },
    },
  },

  // ── Generation Metadata ───────────────────────────────────────────────────
  generatedBy: {
    type: String,
    enum: ['template', 'claude', 'hybrid', 'fallback'],
    default: 'template',
  },
  claudeModelUsed: { type: String, default: null },
  tokensUsed: {
    input: { type: Number, default: 0 },
    output: { type: Number, default: 0 },
  },
  generationTimeMs: { type: Number, default: 0 },

  // ── Versioning & Invalidation ─────────────────────────────────────────────
  ruleVersion: { type: Number, default: 1 },
  templateVersion: { type: Number, default: 1 },
  invalidatedAt: { type: Date, default: null },
  invalidationReason: { type: String, default: null },

  // ── Cache Control ─────────────────────────────────────────────────────────
  expiresAt: { type: Date, index: { expireAfterSeconds: 0 } },

}, {
  timestamps: true,
  collection: 'recommendations',
});

// ── Indexes ───────────────────────────────────────────────────────────────────
recommendationSchema.index({ projectId: 1, fingerprint: 1 }, { unique: true });
recommendationSchema.index({ ruleId: 1, 'context.pageType': 1, 'context.framework': 1 });
recommendationSchema.index({ recommendationVersion: 1 });
recommendationSchema.index({ invalidatedAt: 1 });

// ── Statics ───────────────────────────────────────────────────────────────────

/**
 * Find a valid (non-invalidated, non-expired) recommendation by fingerprint.
 */
recommendationSchema.statics.findValid = function (projectId, fingerprint, currentVersion) {
  return this.findOne({
    projectId,
    fingerprint,
    recommendationVersion: currentVersion,
    invalidatedAt: null,
    $or: [
      { expiresAt: null },
      { expiresAt: { $gt: new Date() } },
    ],
  });
};

/**
 * Invalidate all recommendations for a given rule (when rule logic changes).
 */
recommendationSchema.statics.invalidateByRule = function (ruleId, reason = 'rule_version_change') {
  return this.updateMany(
    { ruleId, invalidatedAt: null },
    {
      $set: {
        invalidatedAt: new Date(),
        invalidationReason: reason,
      },
    }
  );
};

/**
 * Invalidate all recommendations for a project (force full refresh).
 */
recommendationSchema.statics.invalidateByProject = function (projectId, reason = 'manual') {
  return this.updateMany(
    { projectId, invalidatedAt: null },
    {
      $set: {
        invalidatedAt: new Date(),
        invalidationReason: reason,
      },
    }
  );
};

const Recommendation = mongoose.model('Recommendation', recommendationSchema);

export default Recommendation;
