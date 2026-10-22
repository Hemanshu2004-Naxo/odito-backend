/**
 * BaseValidator
 *
 * Abstract base class for all recommendation validators.
 * Provides shared constraint-checking utilities used by every
 * concrete validator.
 *
 * Contract returned by every validate() call:
 *   {
 *     valid:               boolean   — true when all hard rules pass
 *     errors:              string[]  — hard failures (block storage)
 *     warnings:            string[]  — soft issues (log but allow)
 *     satisfiesConstraint: boolean   — AfterState meets expectedState targets
 *   }
 */

// Patterns that indicate placeholder / non-grounded output from Claude
const PLACEHOLDER_PATTERNS = [
  /\[your [a-z ]+\]/i,
  /\[insert\b/i,
  /\[add\b/i,
  /\[placeholder/i,
  /\[business name\]/i,
  /\[company name\]/i,
  /\[enter\b/i,
  /your description here/i,
  /your title here/i,
  /add your [a-z]+/i,
  /\byour brand\b.*\bhere\b/i,
  /lorem ipsum/i,
  /sample text/i,
  /example\.com(?!\/[a-z0-9])/i,   // bare example.com but not example.com/real-path
  /fill in the/i,
  /replace this/i,
  /\[brand\]/i,
  /\[url\]/i,
  /\[phone\]/i,
  /\[email\]/i,
  /\[address\]/i,
];

// URL validation regex — must be an absolute URL
const ABSOLUTE_URL_RE = /^https?:\/\/.+/i;

// Valid relative URL — starts with /
const RELATIVE_URL_RE = /^\/[^\s]*/;

export class BaseValidator {

  /**
   * Concrete validators must implement this.
   *
   * @param {object} sections            — normalized sections from RecommendationNormalizer
   * @param {object} recommendationContext — RecommendationContext from Phase 2
   * @returns {{ valid, errors, warnings, satisfiesConstraint }}
   */
  validate(_sections, _recommendationContext) {
    throw new Error(`${this.constructor.name} must implement validate()`);
  }

  // ── Shared structural validation ─────────────────────────────────────────

  /**
   * Validate that the five core section fields are present and non-empty.
   * These are required by the existing RecommendationValidator and must always pass.
   */
  _validateCoreSections(sections, errors) {
    if (!sections) { errors.push('sections is null'); return; }
    if (!sections.whyThisMatters) errors.push('whyThisMatters is empty');
    if (!sections.recommendedFix)  errors.push('recommendedFix is empty');
    if (!sections.implementationExample?.content) errors.push('implementationExample.content is empty');
    if (!Array.isArray(sections.expectedImpact) || sections.expectedImpact.length === 0) {
      errors.push('expectedImpact is missing or empty');
    }
    if (!sections.estimatedRecovery || typeof sections.estimatedRecovery !== 'object') {
      errors.push('estimatedRecovery is missing');
    }
  }

  // ── Placeholder detection ─────────────────────────────────────────────────

  /**
   * Returns true if the text contains placeholder patterns.
   * @param {string} text
   */
  _hasPlaceholders(text) {
    if (!text || typeof text !== 'string') return false;
    return PLACEHOLDER_PATTERNS.some(p => p.test(text));
  }

  /**
   * Check the primary output fields for placeholder content.
   * Adds to errors[] if found (hard failure — Claude must not store placeholders).
   */
  _checkNoPlaceholders(sections, errors) {
    const fieldsToCheck = [
      ['recommendedVersion',         sections.recommendedVersion],
      ['whyThisMatters',             sections.whyThisMatters],
      ['recommendedFix',             sections.recommendedFix],
      ['implementationExample.content', sections.implementationExample?.content],
    ];
    for (const [name, value] of fieldsToCheck) {
      if (value && this._hasPlaceholders(value)) {
        errors.push(`${name} contains placeholder text — Claude output not grounded`);
      }
    }
  }

  // ── Constraint satisfaction ───────────────────────────────────────────────

  /**
   * Check that a text value's character count is within [min, max].
   * Returns { ok, message }.
   */
  _checkCharacterRange(text, min, max, fieldName) {
    if (!text || typeof text !== 'string') {
      return { ok: false, message: `${fieldName} is empty` };
    }
    const len = text.trim().length;
    if (min != null && len < min) {
      return { ok: false, message: `${fieldName} is ${len} chars — below minimum ${min}` };
    }
    if (max != null && len > max) {
      return { ok: false, message: `${fieldName} is ${len} chars — exceeds maximum ${max}` };
    }
    return { ok: true, message: null };
  }

  /**
   * Check that a value is an absolute URL.
   */
  _checkAbsoluteUrl(url, fieldName) {
    if (!url || typeof url !== 'string') {
      return { ok: false, message: `${fieldName} is empty` };
    }
    if (!ABSOLUTE_URL_RE.test(url.trim())) {
      return { ok: false, message: `${fieldName} is not an absolute URL: "${url.slice(0, 80)}"` };
    }
    return { ok: true, message: null };
  }

  /**
   * Check that a value is a valid URL (absolute or root-relative).
   */
  _checkUrl(url, fieldName) {
    if (!url || typeof url !== 'string') {
      return { ok: false, message: `${fieldName} is empty` };
    }
    const trimmed = url.trim();
    if (ABSOLUTE_URL_RE.test(trimmed) || RELATIVE_URL_RE.test(trimmed)) {
      return { ok: true, message: null };
    }
    return { ok: false, message: `${fieldName} is not a valid URL: "${trimmed.slice(0, 80)}"` };
  }

  /**
   * Attempt to parse a string as JSON.
   * Returns { ok, message, parsed }.
   */
  _checkValidJson(str, fieldName) {
    if (!str || typeof str !== 'string') {
      return { ok: false, message: `${fieldName} is empty`, parsed: null };
    }
    // Strip <script> wrappers if present
    const clean = str
      .replace(/<script[^>]*type="application\/ld\+json"[^>]*>/gi, '')
      .replace(/<\/script>/gi, '')
      .trim();
    try {
      const parsed = JSON.parse(clean);
      return { ok: true, message: null, parsed };
    } catch (e) {
      return { ok: false, message: `${fieldName} is not valid JSON: ${e.message}`, parsed: null };
    }
  }

  // ── satisfiesConstraint derivation ────────────────────────────────────────

  /**
   * Compute satisfiesConstraint from the recommendedVersion text vs expectedState.
   * Used by text-based validators (GROUP 1, 2).
   */
  _textSatisfiesConstraint(text, expectedState) {
    if (!text) return false;
    const len  = text.trim().length;
    const min  = expectedState?.targetMin;
    const max  = expectedState?.targetMax;
    if (min != null && len < min) return false;
    if (max != null && len > max) return false;
    return true;
  }

  /**
   * Compute satisfiesConstraint for absent issues — true when content was provided.
   */
  _absentSatisfiesConstraint(sections) {
    const v = sections.recommendedVersion;
    return Boolean(v && v.trim().length > 0 && !this._hasPlaceholders(v));
  }
}
