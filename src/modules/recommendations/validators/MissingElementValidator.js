/**
 * MissingElementValidator
 *
 * Context-aware validator for missing-element recommendations.
 * Runs when currentState.isAbsent === true.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REJECTION CRITERIA
 *   Hard errors (block storage):
 *     - Core sections missing or empty
 *     - recommendedVersion contains placeholder/template text
 *     - recommendedVersion is a generic instruction, not actual content
 *
 *   Warnings (logged, allow storage):
 *     - recommendedVersion doesn't reference detected page topic or business
 *     - Output suspiciously short for the element type
 *
 * SUCCESS CRITERIA
 *   satisfiesConstraint = true when:
 *     - recommendedVersion is non-empty, non-placeholder, and > 10 chars
 *     - No hard errors
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { BaseValidator } from './BaseValidator.js';
import { GROUP, resolveGroup } from '../prompts/GroupRegistry.js';

// Patterns that indicate a generic, placeholder, or template output.
// These patterns MUST NOT appear in recommendedVersion for missing elements.
const GENERIC_PATTERNS = [
  // Direct placeholder markers
  /your title here/i,
  /your heading here/i,
  /your h1 here/i,
  /your h2 here/i,
  /example title/i,
  /example heading/i,
  /example description/i,
  /\bplaceholder\b/i,
  /lorem ipsum/i,
  /sample company/i,
  /sample text/i,

  // Business/entity placeholders
  /your company name/i,
  /your business name/i,
  /your brand name/i,
  /\[company name\]/i,
  /\[business name\]/i,
  /\[brand name\]/i,
  /\[your company\]/i,
  /\[organization\]/i,

  // Service/topic placeholders
  /your service name/i,
  /\[service name\]/i,
  /\[service\]/i,
  /your page topic/i,
  /\[page topic\]/i,
  /\[topic\]/i,
  /\[keyword\]/i,
  /primary keyword/i,  // literal phrase "primary keyword" in generated content

  // Instruction-style outputs (not actual content)
  /^add (?:an?|your) h[1-6]/i,       // "Add an H1 tag"
  /^insert (?:an?|your) h[1-6]/i,    // "Insert your H1"
  /^write (?:an?|your) h[1-6]/i,
  /add your (?:title|heading|description)/i,
  /insert (?:your|a) (?:title|heading|description) here/i,
  /replace with your/i,
  /fill in (with )?your/i,

  // Generic schema values
  /\byour organization\b/i,
  /\byour website\b.*\bhere\b/i,
  /https?:\/\/(?:your-?(?:site|domain|website|url)|example)\.com/i,
  /\byour-domain\.com\b/i,
];

// Minimum character lengths by issue type to detect suspiciously thin output
const MIN_LENGTH_BY_ISSUE = {
  h1_missing:              3,   // At minimum a few words
  h2_missing:              3,
  title_missing:           10,  // Title needs real content
  meta_description_missing: 30, // Meta desc should be substantial
  faq_missing:             100, // FAQs should have actual Q&A pairs
  faq_section_5_to_10_questions: 200,
  schema_markup:           50,  // JSON-LD is always substantial
  organization_schema:     50,
  og_tags_missing:         30,
  images_missing_alt_text: 5,   // Alt text can be short
};

class MissingElementValidator extends BaseValidator {

  /**
   * Validate a missing-element recommendation.
   *
   * @param {object} sections              — normalized recommendation sections
   * @param {object} recommendationContext — RecommendationContext from Phase 2
   * @returns {{ valid, errors, warnings, satisfiesConstraint }}
   */
  validate(sections, recommendationContext) {
    const errors   = [];
    const warnings = [];

    // ── 1. Core sections structural check ────────────────────────────────────
    this._validateCoreSections(sections, errors);

    // ── 2. Placeholder check (inherited from BaseValidator) ───────────────────
    // For schema recommendations only the published code is checked: the surrounding prose is guidance to the owner
    // ("add your phone number", "needs your input: logo") and must not be rejected as an ungrounded placeholder.
    const isSchema = resolveGroup(recommendationContext?.identity?.issueId || '') === GROUP.SCHEMA;
    this._checkNoPlaceholders(
      isSchema ? { recommendedVersion: sections?.recommendedVersion, implementationExample: sections?.implementationExample } : sections,
      errors,
    );

    // ── 3. Generic output check for missing elements ──────────────────────────
    const rv = sections.recommendedVersion || '';
    if (!rv.trim()) warnings.push('recommendedVersion is empty — the generated element was not returned as text');
    if (rv) {
      const matchedPattern = GENERIC_PATTERNS.find(p => p.test(rv));
      if (matchedPattern) {
        errors.push(
          `recommendedVersion contains generic/placeholder content — output is not page-specific ` +
          `(matched pattern: ${matchedPattern.source})`
        );
      }
    }

    // ── 4. Minimum length check ───────────────────────────────────────────────
    const issueId = recommendationContext?.identity?.issueId || '';
    const minLen  = MIN_LENGTH_BY_ISSUE[issueId] ?? 5;
    if (rv && rv.trim().length < minLen) {
      warnings.push(
        `recommendedVersion is very short (${rv.trim().length} chars) for issue "${issueId}" — ` +
        `expected at least ${minLen} chars`
      );
    }

    // ── 5. Context grounding check ────────────────────────────────────────────
    // When MissingElementContextBuilder produced rich context, verify the output
    // references it — at least one of: primaryTopic fragment, businessName.
    const mec = recommendationContext?.missingElementContext;
    if (mec?.isRich && rv && rv.trim().length >= minLen) {
      const rvLower = rv.toLowerCase();
      const hasTopic    = mec.primaryTopic
        && rvLower.includes(mec.primaryTopic.toLowerCase().slice(0, Math.min(8, mec.primaryTopic.length)));
      const hasBusiness = mec.businessName
        && rvLower.includes(mec.businessName.toLowerCase());
      const hasService  = mec.serviceName
        && rvLower.includes(mec.serviceName.toLowerCase().slice(0, Math.min(8, mec.serviceName.length)));

      if (!hasTopic && !hasBusiness && !hasService) {
        warnings.push(
          `recommendedVersion may not reference the detected page context ` +
          `(topic: "${mec.primaryTopic}", business: "${mec.businessName}") — ` +
          `verify output is page-specific`
        );
      }
    }

    // ── satisfiesConstraint ───────────────────────────────────────────────────
    // True when: non-empty recommendedVersion, no hard errors, no generic patterns
    const satisfiesConstraint = errors.length === 0
      && this._absentSatisfiesConstraint(sections);

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      satisfiesConstraint,
    };
  }
}

export default new MissingElementValidator();
