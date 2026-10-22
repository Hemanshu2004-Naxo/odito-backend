/**
 * ConfidenceCalculator
 *
 * Computes a ConfidenceScore for a generated recommendation.
 *
 * Score = weighted composite of four inputs:
 *   contextCompleteness (35%) — how much actual page data was available
 *   groundingScore      (30%) — % of output grounded in supplied context
 *   issueClarity        (20%) — how well-defined the issue is for this engine
 *   actionability       (15%) — how specific the fix can be given promptMode
 *
 * Adjustment: fieldCoverageScore (±10 pts)
 *   Measures available contextual fields vs actually used fields.
 *   Confidence decreases when context is ignored.
 *
 * Tiers:
 *   grounded   80–100  — uses actual page content
 *   contextual 50–79   — uses page/framework context but not content
 *   generic    0–49    — uses only issue metadata (fallback quality)
 *
 * IMPORTANT: ConfidenceCalculator does not make DB queries or API calls.
 * All inputs come from RecommendationContext (Phase 2) and Claude's rawOutput.
 */

import { PROMPT_MODE } from '../context/RecommendationContextSchema.js';

// Weights must sum to 100
const WEIGHTS = {
  contextCompleteness: 35,
  groundingScore:      30,
  issueClarity:        20,
  actionability:       15,
};

// Contextual fields we can check for coverage in the output
const CONTEXT_FIELDS_BY_SECTION = {
  contentContext:      ['pageTitle', 'h1Text', 'primaryKeyword', 'contentPreview'],
  technicalContext:    ['canonicalUrl', 'pageUrl', 'ogFieldsPresent', 'inboundLinkCount'],
  aiVisibilityContext: ['schemaTypes', 'entityName'],
  entityContext:       ['businessName', 'address', 'phone', 'authorName'],
  aeoContext:          ['faqCount', 'h2List', 'readabilityScore'],
};

// Actionability score by promptMode
const ACTIONABILITY_BY_MODE = {
  [PROMPT_MODE.CONTENT_REWRITE]: 95,
  [PROMPT_MODE.COMPARISON_FIX]:  90,
  [PROMPT_MODE.ELEMENT_ADD]:     80,
  [PROMPT_MODE.STRUCTURAL_FIX]:  70,
  [PROMPT_MODE.LIST_FIX]:        70,
};

// Generic phrase patterns that indicate low grounding
const GENERIC_PHRASES = [
  'your description here',
  'add more content',
  'improve your',
  'optimize your',
  'update your',
  'address this issue to improve',
  'no implementation example available',
  'see issue description',
  'as per seo best practices',
  'generally speaking',
  'typically',
  'in general',
];

export class ConfidenceCalculator {

  /**
   * Calculate confidence for a recommendation.
   *
   * @param {object} rc        — RecommendationContext
   * @param {object} rawOutput — Claude's parsed JSON response
   * @returns {object} ConfidenceScore
   */
  calculate(rc, rawOutput) {
    const completeness     = this._contextCompleteness(rc);
    const grounding        = this._groundingScore(rc, rawOutput);
    const clarity          = this._issueClarity(rc);
    const actionability    = this._actionability(rc);
    const fieldCoverage    = this._fieldCoverageScore(rc, rawOutput);

    const weighted = Math.round(
      (completeness  * WEIGHTS.contextCompleteness / 100) +
      (grounding     * WEIGHTS.groundingScore      / 100) +
      (clarity       * WEIGHTS.issueClarity        / 100) +
      (actionability * WEIGHTS.actionability       / 100)
    );

    // fieldCoverageScore is an adjustment factor: +10 when all fields used, -10 when many ignored
    const fieldAdjustment = Math.round((fieldCoverage - 50) / 5);  // −10 … +10
    const overall = Math.max(0, Math.min(100, weighted + fieldAdjustment));

    return {
      overall,
      tier:     this._deriveTier(overall),
      breakdown: {
        contextCompleteness: completeness,
        groundingScore:      grounding,
        issueClarity:        clarity,
        actionability,
        fieldCoverageScore:  fieldCoverage,
      },
      warnings: this._buildWarnings(rc, grounding, completeness, fieldCoverage),
    };
  }

  /**
   * fieldCoverageScore (adjustment factor)
   * Measures what % of the available contextual fields were actually referenced
   * in Claude's output. When context is supplied but ignored, the score drops.
   */
  _fieldCoverageScore(rc, rawOutput) {
    if (!rc || !rawOutput) return 50; // neutral

    const fullOutput = [
      rawOutput.recommendedVersion   || '',
      rawOutput.issueAnalysis        || '',
      rawOutput.implementationNotes  || '',
      rawOutput.implementationCode   || '',
    ].join(' ').toLowerCase();

    if (!fullOutput.trim()) return 20;

    let available = 0;
    let referenced = 0;

    for (const [section, fields] of Object.entries(CONTEXT_FIELDS_BY_SECTION)) {
      const ctx = rc[section];
      if (!ctx) continue;

      for (const field of fields) {
        const value = ctx[field];
        if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) continue;

        available++;
        // Check if the value (or a key term from it) appears in the output
        const strValue = Array.isArray(value) ? value.join(' ') : String(value);
        const terms = strValue.toLowerCase().split(/\s+/).filter(t => t.length > 4);
        const firstTerm = terms[0] || strValue.toLowerCase().slice(0, 20);
        if (firstTerm && fullOutput.includes(firstTerm)) {
          referenced++;
        }
      }
    }

    if (available === 0) return 50; // no fields to measure
    return Math.round((referenced / available) * 100);
  }

  // ── Input calculators ─────────────────────────────────────────────────────

  /**
   * contextCompleteness (35%)
   * Directly from builderMeta.issueContextReadiness (0-100).
   */
  _contextCompleteness(rc) {
    return rc?.builderMeta?.issueContextReadiness ?? 50;
  }

  /**
   * groundingScore (30%)
   * Measures whether Claude's output references actual page data.
   */
  _groundingScore(rc, rawOutput) {
    if (!rawOutput) return 20;

    const fullOutput = [
      rawOutput.recommendedVersion || '',
      rawOutput.issueAnalysis      || '',
      rawOutput.implementationNotes|| '',
      rawOutput.implementationCode || '',
    ].join(' ').toLowerCase();

    if (!fullOutput.trim()) return 10;

    // ── Negative signals — generic content ──────────────────────────────
    const genericHits = GENERIC_PHRASES.filter(p => fullOutput.includes(p)).length;
    if (genericHits >= 3) return 15;

    let score = 80; // baseline — non-empty, non-generic output

    // ── Positive signals — actual values from context ────────────────────

    // Did the output reference the page URL?
    const pageUrl = rc?.pageContext?.pageUrl?.toLowerCase() || '';
    if (pageUrl && fullOutput.includes(pageUrl.split('/').pop() || pageUrl)) {
      score += 5;
    }

    // Did the output reference the page title?
    const pageTitle = (rc?.contentContext?.pageTitle || '').toLowerCase();
    if (pageTitle && pageTitle.length > 5 && fullOutput.includes(pageTitle.slice(0, 20))) {
      score += 5;
    }

    // Did the output reference the primary keyword?
    const keyword = (rc?.contentContext?.primaryKeyword || '').toLowerCase();
    if (keyword && keyword.length > 3 && fullOutput.includes(keyword)) {
      score += 5;
    }

    // Did the output reference the actual rawText being optimized?
    const rawText = (rc?.currentState?.rawText || '').toLowerCase();
    if (rawText && rawText.length > 10) {
      // For content_rewrite, the output should be clearly derived from rawText
      // Check for shared word overlap (Jaccard-like)
      const rawWords    = new Set(rawText.split(/\s+/).filter(w => w.length > 3));
      const outputWords = new Set(fullOutput.split(/\s+/).filter(w => w.length > 3));
      const overlap = [...rawWords].filter(w => outputWords.has(w)).length;
      const overlapRatio = rawWords.size > 0 ? overlap / rawWords.size : 0;
      if (overlapRatio >= 0.4) score += 5;    // 40%+ word overlap → grounded
      else if (overlapRatio < 0.1 && rc?.recommendationObjective?.promptMode === PROMPT_MODE.CONTENT_REWRITE) {
        score -= 15;  // content_rewrite but no word overlap → likely hallucinated
      }
    }

    // ── Penalty for generic hits ─────────────────────────────────────────
    score -= genericHits * 8;

    // ── Penalty for placeholder detection ───────────────────────────────
    const placeholders = [/\[your [a-z ]+\]/i, /\[insert\b/i, /\[placeholder/i];
    const placeholderHits = placeholders.filter(p => p.test(fullOutput)).length;
    score -= placeholderHits * 20;

    return Math.max(0, Math.min(100, score));
  }

  /**
   * issueClarity (20%)
   * How well-defined is this issue type for our engine?
   */
  _issueClarity(rc) {
    // Use pre-computed value from builderMeta if available
    if (rc?.builderMeta?.confidenceInputs?.issueClarity != null) {
      return rc.builderMeta.confidenceInputs.issueClarity;
    }

    // Derive from whether the issue has a known strategy
    const issueId = rc?.identity?.issueId || '';
    if (!issueId) return 30;

    // Known issue types by prefix/category
    const wellKnown = [
      'title_', 'meta_description_', 'h1_', 'heading_', 'canonical_',
      'og_tags_', 'keyword_', 'thin_content', 'schema_', 'organization_',
      'faq_schema', 'orphan_', 'click_depth', 'redirect_', 'broken_',
    ];
    const isKnown = wellKnown.some(prefix => issueId.startsWith(prefix) || issueId === prefix.replace('_', ''));
    if (isKnown) return 100;

    // AI visibility rules are defined but less precise
    if (rc?.identity?.issueType === 'ai_visibility') return 75;

    return 50; // unknown but in registry
  }

  /**
   * actionability (15%)
   * How specific can the fix be, given the promptMode?
   */
  _actionability(rc) {
    // Use pre-computed value from builderMeta if available
    if (rc?.builderMeta?.confidenceInputs?.actionability != null) {
      return rc.builderMeta.confidenceInputs.actionability;
    }

    const mode = rc?.recommendationObjective?.promptMode;
    return ACTIONABILITY_BY_MODE[mode] ?? 65;
  }

  // ── Tier and warnings ─────────────────────────────────────────────────────

  _deriveTier(overall) {
    if (overall >= 80) return 'grounded';
    if (overall >= 50) return 'contextual';
    return 'generic';
  }

  _buildWarnings(rc, groundingScore, completeness, fieldCoverage = 50) {
    const warnings = [];

    if (completeness < 40) {
      warnings.push(`Low context readiness (${completeness}%) — recommendation may not be page-specific`);
    }

    if (groundingScore < 50) {
      warnings.push('Low grounding score — output may contain generic advice rather than page-specific fixes');
    }

    const pageType = rc?.pageContext?.pageType || 'Unknown';
    if (pageType === 'Unknown') {
      warnings.push('Page type unknown — framework-specific implementation advice may not apply');
    }

    const fw = rc?.pageContext?.framework || 'unknown';
    if (fw === 'unknown' && !rc?.pageContext?.cms) {
      warnings.push('Framework not detected — implementation code defaults to generic HTML');
    }

    const keyword = rc?.contentContext?.primaryKeyword;
    if (!keyword && rc?.recommendationObjective?.promptMode === PROMPT_MODE.CONTENT_REWRITE) {
      warnings.push('Primary keyword not detected — keyword density and placement advice is estimated');
    }

    if (fieldCoverage < 30) {
      warnings.push(`Low field coverage (${fieldCoverage}%) — supplied context was largely not referenced in the output`);
    }

    return warnings;
  }
}

export default new ConfidenceCalculator();
