import { CONTENT_LIMITS, IMPLEMENTATION_TYPES, DIFFICULTY } from '../constants/recommendationTypes.js';
import { altImagesFromContext, normalizeImageAltProposals } from './imageAltProposals.js';
import BeforeAfterBuilder   from '../normalizers/BeforeAfterBuilder.js';
import ChangeSummaryBuilder from '../normalizers/ChangeSummaryBuilder.js';

/**
 * Recommendation Normalizer
 * 
 * CRITICAL LAYER between AI output and database storage.
 * 
 * Claude returns PARTIAL intelligence (raw text).
 * This normalizer:
 * 1. Sanitizes (trim, remove markdown artifacts, fix casing)
 * 2. Structures (enforce types, arrays, nested objects)
 * 3. Enforces limits (max lengths, max items)
 * 4. Cleans code blocks (remove triple backticks, normalize indentation)
 * 5. Enriches (adds metadata like recovery scores, difficulty, timestamps)
 * 
 * Claude should NEVER return the final DB shape.
 * Claude returns: { whyThisMatters, recommendedFix, implementationCode, impacts }
 * Normalizer builds: full sections object matching the Recommendation schema.
 */

/**
 * The schema prompts ask for "the actual JSON-LD object", so a model quite naturally returns
 * `recommendedVersion` / `implementationCode` as a JSON OBJECT instead of a string — and `implementationNotes` as a
 * list of steps. Every consumer here assumes strings: _sanitizeText() turns a non-string into '' (the recommendation
 * silently lost its content and failed validation with no reason given) and BeforeAfterBuilder crashed on
 * `content.trim`. Structured values are converted ONCE, up front, to the text they stand for.
 * Returns a copy; the input is never mutated.
 */
export function coerceStructuredFields(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const toText = (v, joiner = '\n') => {
    if (v == null || typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : toText(x))).filter((x) => x != null && x !== '').join(joiner);
    if (typeof v === 'object') return JSON.stringify(v, null, 2);
    return String(v);
  };
  const out = { ...raw };
  for (const key of ['recommendedVersion', 'implementationCode', 'optimizedText']) {
    const v = out[key];
    if (v == null || typeof v === 'string') continue;
    // A list of JSON-LD objects is ONE JSON array (valid JSON-LD); only a list of strings is joined as lines.
    out[key] = Array.isArray(v) && v.some((x) => x && typeof x === 'object') ? JSON.stringify(v, null, 2) : toText(v, '\n');
  }
  for (const key of ['implementationNotes', 'issueAnalysis', 'whyThisMatters', 'recommendedFix']) {
    if (out[key] != null && typeof out[key] !== 'string') out[key] = toText(out[key], '\n');
  }
  if (out.beforeAfter && typeof out.beforeAfter === 'object') {
    out.beforeAfter = { ...out.beforeAfter };
    for (const key of ['before', 'after']) {
      if (out.beforeAfter[key] != null && typeof out.beforeAfter[key] !== 'string') out.beforeAfter[key] = toText(out.beforeAfter[key]);
    }
  }
  return out;
}

class RecommendationNormalizer {

  /**
   * Normalize Claude's raw output into the final recommendation sections shape.
   * 
   * @param {Object} rawAIOutput - Partial intelligence from Claude
   * @param {Object} context - Issue context (for enrichment)
   * @param {Object} ruleMetadata - Rule catalog data (for fallback values)
   * @returns {Object} Normalized sections ready for DB storage
   */
  normalize(rawAIOutput, context = {}, ruleMetadata = {}, recommendationContext = null) {
    rawAIOutput = coerceStructuredFields(rawAIOutput);
    // ── Phase 3 context-aware output path ─────────────────────────────────────
    // The context-aware PromptBuilder returns these fields:
    //   issueAnalysis, recommendedVersion, beforeAfter, implementationNotes,
    //   implementationCode, impacts, recovery, difficulty, estimatedFixTime
    //
    // The legacy prompt path returns:
    //   whyThisMatters, (optimizedText | recommendedFix), implementationCode,
    //   impacts, recovery, difficulty, estimatedFixTime
    //
    // Both paths produce the same sections shape for DB storage.
    const isContextAware    = Boolean(rawAIOutput.issueAnalysis);
    const isContentImprovement = !isContextAware && Boolean(rawAIOutput.optimizedText);

    // ── whyThisMatters: issueAnalysis (Phase 3) or whyThisMatters (legacy) ────
    const whyThisMatters = isContextAware
      ? this._normalizeWhyThisMatters(rawAIOutput.issueAnalysis)
      : this._normalizeWhyThisMatters(rawAIOutput.whyThisMatters);

    // ── recommendedFix: implementationNotes (Phase 3) or legacy paths ─────────
    let recommendedFix;
    if (isContextAware) {
      recommendedFix = this._normalizeRecommendedFix(rawAIOutput.implementationNotes);
    } else if (isContentImprovement) {
      recommendedFix = this._buildContentRecommendedFix(rawAIOutput.changeExplanation, rawAIOutput.recommendedFix);
    } else {
      recommendedFix = this._normalizeRecommendedFix(rawAIOutput.recommendedFix);
    }

    // ── implementationCode ────────────────────────────────────────────────────
    const implementationCode = rawAIOutput.implementationCode
      || (isContentImprovement ? rawAIOutput.optimizedText : null);

    const sections = {
      whyThisMatters,
      recommendedFix,
      implementationExample: this._normalizeImplementation(implementationCode, context),
      expectedImpact:        this._normalizeExpectedImpact(rawAIOutput.impacts),
      estimatedRecovery:     this._normalizeRecovery(rawAIOutput.recovery, context, ruleMetadata),
      difficulty:            this._normalizeDifficulty(rawAIOutput.difficulty, ruleMetadata),
      estimatedFixTime:      this._normalizeFixTime(rawAIOutput.estimatedFixTime, ruleMetadata),
    };

    // ── contentRewrite: beforeAfter (Phase 3) or optimizedText (legacy) ───────
    if (isContextAware && rawAIOutput.beforeAfter) {
      sections.contentRewrite = this._normalizeBeforeAfter(rawAIOutput);
    } else if (isContentImprovement) {
      sections.contentRewrite = this._normalizeContentRewrite(rawAIOutput);
    }

    // ── Phase 3 extended fields (additive — stored alongside existing sections) ─
    if (isContextAware) {
      if (rawAIOutput.recommendedVersion) {
        // FULL_CONTENT, not IMPLEMENTATION_EXAMPLE (a code/HTML snippet cap
        // that's far too small for a full rewritten paragraph/page).
        sections.recommendedVersion = this._sanitizeText(rawAIOutput.recommendedVersion, CONTENT_LIMITS.FULL_CONTENT);
      }
    }

    // ── images_missing_alt_text: structured per-image proposals ───────────────
    // Kept only for the exact images the prompt listed; see imageAltProposals.js. Always present (possibly empty) for this
    // issue once a context exists, so a recommendation made before this field existed can be told apart from one with no proposals.
    if (recommendationContext?.identity?.issueId === 'images_missing_alt_text') {
      sections.imageAltProposals = normalizeImageAltProposals(rawAIOutput.imageAlts, altImagesFromContext(recommendationContext));
    }

    // ── BeforeState / AfterState / ChangeSummary (deterministic — not from Claude) ──
    // Only built when we have a RecommendationContext (Phase 3 path).
    // The system derives these from the context + Claude's content output — never
    // allows Claude to define the structured diff.
    if (recommendationContext && (isContextAware || isContentImprovement)) {
      try {
        const { beforeState, afterState } = BeforeAfterBuilder.build(recommendationContext, rawAIOutput);
        sections.beforeState = beforeState;
        sections.afterState  = afterState;

        const { items } = ChangeSummaryBuilder.build(beforeState, afterState, recommendationContext);
        if (items.length > 0) {
          sections.changeSummary = { items };
        }
      } catch (err) {
        console.warn('[NORMALIZER] BeforeAfterBuilder/ChangeSummaryBuilder failed (non-fatal):', err.message);
      }

      // ── Detected context — surface for frontend when element was absent ───
      // Allows the UI to show "Detected Context" card explaining what signals
      // were used to generate the recommendation.
      if (recommendationContext.missingElementContext) {
        sections.detectedContext = recommendationContext.missingElementContext;
      }
    }

    return sections;
  }

  /**
   * Normalize template output (already structured, just needs sanitization).
   * 
   * @param {Object} templateSections - Resolved template sections
   * @returns {Object} Sanitized sections
   */
  normalizeTemplate(templateSections) {
    return {
      whyThisMatters: this._sanitizeText(templateSections.whyThisMatters, CONTENT_LIMITS.WHY_THIS_MATTERS),
      recommendedFix: this._sanitizeText(templateSections.recommendedFix, CONTENT_LIMITS.RECOMMENDED_FIX),
      implementationExample: this._normalizeImplementation(
        templateSections.implementationExample?.content || templateSections.implementationExample,
        {},
        templateSections.implementationExample?.type
      ),
      expectedImpact: this._normalizeExpectedImpact(templateSections.expectedImpact),
      estimatedRecovery: this._normalizeRecovery(templateSections.estimatedRecovery),
      difficulty: this._normalizeDifficulty(templateSections.difficulty),
      estimatedFixTime: this._normalizeFixTime(templateSections.estimatedFixTime),
    };
  }

  // ── Private Normalizers ─────────────────────────────────────────────────────

  _normalizeWhyThisMatters(raw) {
    if (!raw) return 'This issue impacts your AI visibility and search engine understanding.';
    return this._sanitizeText(raw, CONTENT_LIMITS.WHY_THIS_MATTERS);
  }

  _normalizeRecommendedFix(raw) {
    if (!raw) return 'Address this issue to improve AI citation probability.';
    return this._sanitizeText(raw, CONTENT_LIMITS.RECOMMENDED_FIX);
  }

  _normalizeImplementation(raw, context = {}, explicitType = null) {
    if (!raw) {
      return {
        type: 'text',
        content: 'No implementation example available for this context.',
      };
    }

    // Detect type if not explicit
    const type = explicitType || this._detectImplementationType(raw, context);
    const content = this._cleanCodeBlock(raw, CONTENT_LIMITS.IMPLEMENTATION_EXAMPLE);

    return { type, content };
  }

  _normalizeExpectedImpact(raw) {
    if (!raw) return ['Improves AI visibility and search engine understanding'];

    // If already an array, sanitize each item
    if (Array.isArray(raw)) {
      return raw
        .filter(item => item && typeof item === 'string')
        .map(item => this._sanitizeText(item, CONTENT_LIMITS.EXPECTED_IMPACT_ITEM))
        .slice(0, CONTENT_LIMITS.EXPECTED_IMPACT_MAX_ITEMS);
    }

    // If string with bullet points or newlines, split
    if (typeof raw === 'string') {
      const items = raw
        .split(/[\n•\-\*]/)
        .map(s => s.trim())
        .filter(Boolean)
        .map(item => this._sanitizeText(item, CONTENT_LIMITS.EXPECTED_IMPACT_ITEM))
        .slice(0, CONTENT_LIMITS.EXPECTED_IMPACT_MAX_ITEMS);
      return items.length > 0 ? items : [this._sanitizeText(raw, CONTENT_LIMITS.EXPECTED_IMPACT_ITEM)];
    }

    return ['Improves AI visibility and search engine understanding'];
  }

  _normalizeRecovery(raw, context = {}, ruleMetadata = {}) {
    const defaults = {
      aiVisibility: 0,
      semanticTrust: 0,
      freshness: 0,
      accessibility: 0,
    };

    if (!raw) {
      // Derive from rule metadata/severity if available
      return this._deriveRecoveryFromMetadata(ruleMetadata);
    }

    if (typeof raw === 'object' && !Array.isArray(raw)) {
      return {
        aiVisibility: this._clampScore(raw.aiVisibility || raw.ai_visibility || 0),
        semanticTrust: this._clampScore(raw.semanticTrust || raw.semantic_trust || 0),
        freshness: this._clampScore(raw.freshness || 0),
        accessibility: this._clampScore(raw.accessibility || 0),
      };
    }

    return defaults;
  }

  _normalizeDifficulty(raw, ruleMetadata = {}) {
    if (!raw) return ruleMetadata.difficulty || DIFFICULTY.MEDIUM;

    const normalized = String(raw).toLowerCase().trim();
    if (Object.values(DIFFICULTY).includes(normalized)) return normalized;

    // Map common alternatives
    if (['simple', 'trivial', 'quick'].includes(normalized)) return DIFFICULTY.EASY;
    if (['moderate', 'intermediate'].includes(normalized)) return DIFFICULTY.MEDIUM;
    if (['complex', 'difficult', 'advanced'].includes(normalized)) return DIFFICULTY.HARD;

    return ruleMetadata.difficulty || DIFFICULTY.MEDIUM;
  }

  _normalizeFixTime(raw, ruleMetadata = {}) {
    if (!raw) return ruleMetadata.estimatedFixTime || '15 minutes';
    return this._sanitizeText(String(raw), CONTENT_LIMITS.ESTIMATED_FIX_TIME);
  }

  // ── Utility Methods ─────────────────────────────────────────────────────────

  /**
   * Sanitize text: trim, remove markdown artifacts, enforce max length.
   */
  _sanitizeText(text, maxLength = 500) {
    if (!text || typeof text !== 'string') return '';

    let clean = text
      .trim()
      // Remove markdown headers
      .replace(/^#{1,6}\s+/gm, '')
      // Remove bold/italic markers (keep content)
      .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
      // Remove inline code markers for non-code sections
      .replace(/`([^`]+)`/g, '$1')
      // Normalize whitespace
      .replace(/\s+/g, ' ')
      .trim();

    if (clean.length > maxLength) {
      clean = clean.substring(0, maxLength - 3) + '...';
    }

    return clean;
  }

  /**
   * Clean a code block: remove triple backticks, normalize indentation.
   */
  _cleanCodeBlock(code, maxLength = 2000) {
    if (!code || typeof code !== 'string') return '';

    let clean = code
      .trim()
      // Remove opening code fence (```html, ```json, etc.)
      .replace(/^```[\w]*\n?/gm, '')
      // Remove closing code fence
      .replace(/\n?```$/gm, '')
      .trim();

    if (clean.length > maxLength) {
      clean = clean.substring(0, maxLength - 20) + '\n// ... (truncated)';
    }

    return clean;
  }

  /**
   * Detect implementation type from content and context.
   */
  _detectImplementationType(content, context = {}) {
    if (!content) return 'text';

    const lower = content.toLowerCase();

    // Check for JSX patterns
    if (lower.includes('classname=') || lower.includes('import react') || lower.includes('export default')) {
      return IMPLEMENTATION_TYPES.JSX;
    }

    // Check for JSON-LD / JSON patterns
    if (lower.includes('"@context"') || lower.includes('"@type"') || (lower.startsWith('{') && lower.includes('"'))) {
      return IMPLEMENTATION_TYPES.JSON;
    }

    // Check for HTML patterns
    if (lower.includes('</') || lower.includes('/>') || lower.includes('<script')) {
      return IMPLEMENTATION_TYPES.HTML;
    }

    // Context-based detection
    if (context.framework === 'nextjs' || context.framework === 'react') {
      return IMPLEMENTATION_TYPES.JSX;
    }

    return IMPLEMENTATION_TYPES.HTML;
  }

  /**
   * Derive recovery scores from rule metadata when Claude doesn't provide them.
   */
  _deriveRecoveryFromMetadata(ruleMetadata) {
    const category = (ruleMetadata.category || '').toLowerCase();
    const severity = (ruleMetadata.severity || 'medium').toLowerCase();

    const baseScore = severity === 'critical' ? 25 : severity === 'high' ? 18 : severity === 'medium' ? 12 : 5;

    return {
      aiVisibility: category.includes('ai') || category.includes('citation') ? baseScore : Math.round(baseScore * 0.6),
      semanticTrust: category.includes('schema') || category.includes('entity') ? baseScore : Math.round(baseScore * 0.5),
      freshness: category.includes('content') || category.includes('date') ? baseScore : Math.round(baseScore * 0.3),
      accessibility: category.includes('voice') || category.includes('aeo') ? baseScore : Math.round(baseScore * 0.4),
    };
  }

  /**
   * Clamp a score between 0 and 100.
   */
  _clampScore(value) {
    const num = Number(value) || 0;
    return Math.max(0, Math.min(100, Math.round(num)));
  }

  /**
   * Build recommendedFix for content improvement responses.
   * Prepends the change explanation so the user immediately sees what changed.
   */
  _buildContentRecommendedFix(changeExplanation, recommendedFix) {
    const explanation = changeExplanation
      ? this._sanitizeText(changeExplanation, 300)
      : null;
    const fix = recommendedFix
      ? this._sanitizeText(recommendedFix, CONTENT_LIMITS.RECOMMENDED_FIX)
      : 'Replace the current content with the optimized version shown below.';
    return explanation ? `${explanation} ${fix}` : fix;
  }

  /**
   * Normalize the contentRewrite section (before/after comparison data).
   * Stores the original and optimized text for UI rendering.
   */
  _normalizeContentRewrite(rawAIOutput) {
    const optimized = (rawAIOutput.optimizedText || '').trim();
    const count = typeof rawAIOutput.characterCount === 'number'
      ? rawAIOutput.characterCount
      : optimized.length;
    return {
      optimized,
      characterCount: count,
      changeExplanation: this._sanitizeText(rawAIOutput.changeExplanation || '', 300),
    };
  }

  /**
   * Normalize the Phase 3 beforeAfter section.
   * The context-aware prompt returns { before, after } instead of optimizedText.
   * Maps to the same contentRewrite shape so the frontend renders it identically.
   */
  _normalizeBeforeAfter(rawAIOutput) {
    const ba      = rawAIOutput.beforeAfter || {};
    // before = the CURRENT (already-short) content — 500 is a reasonable cap.
    // after  = the actual rewritten content — needs FULL_CONTENT, not 500,
    // for the same reason as recommendedVersion/afterState.rawText above.
    const before  = this._sanitizeText(String(ba.before  || ''), 500);
    const after   = this._sanitizeText(String(ba.after   || rawAIOutput.recommendedVersion || ''), CONTENT_LIMITS.FULL_CONTENT);
    return {
      before,
      after,
      // Keep legacy fields so existing UI components still render
      optimized:         after,
      characterCount:    after.length,
      changeExplanation: '',
    };
  }
}


export default new RecommendationNormalizer();
