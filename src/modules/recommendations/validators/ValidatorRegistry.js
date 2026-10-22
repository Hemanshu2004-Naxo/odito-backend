/**
 * ValidatorRegistry
 *
 * Routes to the correct context-aware validator by prompt group.
 * Provides a unified validate() entry point for the recommendation service.
 *
 * IMPORTANT: The ValidatorRegistry supplements (does not replace) the existing
 * RecommendationValidator in service/recommendationValidator.js.
 *
 * Flow:
 *   1. Existing RecommendationValidator checks structural integrity (sections shape)
 *   2. ValidatorRegistry checks content correctness (constraints, grounding, hallucinations)
 */

import { GROUP } from '../prompts/GroupRegistry.js';
import textValidator            from './TextValidator.js';
import technicalValidator       from './TechnicalValidator.js';
import schemaValidator          from './SchemaValidator.js';
import accessibilityValidator   from './AccessibilityValidator.js';
import aiVisibilityValidator    from './AIVisibilityValidator.js';
import missingElementValidator  from './MissingElementValidator.js';

const VALIDATOR_MAP = {
  [GROUP.TEXT_OPTIMIZATION]:    textValidator,
  [GROUP.CONTENT_OPTIMIZATION]: textValidator,       // text rules apply to content too
  [GROUP.TECHNICAL_SEO]:        technicalValidator,
  [GROUP.SCHEMA]:               schemaValidator,
  [GROUP.ACCESSIBILITY]:        accessibilityValidator,
  [GROUP.AI_VISIBILITY]:        aiVisibilityValidator,
  [GROUP.ENTITY_EEAT]:          aiVisibilityValidator, // strictest hallucination guard
  [GROUP.AEO_VOICE]:            aiVisibilityValidator,
};

const mergeResults = (a, b) => {
  const errors = [...new Set([...a.errors, ...b.errors])];
  return {
    valid: errors.length === 0 && a.valid && b.valid,
    errors,
    warnings: [...new Set([...a.warnings, ...b.warnings])],
    satisfiesConstraint: a.satisfiesConstraint && b.satisfiesConstraint && errors.length === 0,
  };
};

class ValidatorRegistry {

  /**
   * Run the context-aware validator for a given prompt group.
   *
   * @param {object} sections              — normalized recommendation sections
   * @param {object} recommendationContext — RecommendationContext from Phase 2
   * @param {number} group                 — GROUP constant from GroupRegistry
   * @returns {{ valid, errors, warnings, satisfiesConstraint }}
   */
  validate(sections, recommendationContext, group) {
    // Missing-element issues (isAbsent) always run MissingElementValidator
    // regardless of group, because the constraint is fundamentally different:
    // "did you generate real page-specific content?" not "is the length correct?"
    const isAbsent = recommendationContext?.currentState?.isAbsent === true;
    const validator = isAbsent ? missingElementValidator : VALIDATOR_MAP[group];

    if (!validator) {
      console.warn(`[VALIDATOR] No validator for group ${group} — skipping context-aware validation`);
      return { valid: true, errors: [], warnings: [`No validator for group ${group}`], satisfiesConstraint: true };
    }

    if (isAbsent) {
      console.log(`[VALIDATOR] Absent element — routing to MissingElementValidator | group=${group} | issueId=${recommendationContext?.identity?.issueId}`);
    }

    try {
      let result = validator.validate(sections, recommendationContext);

      // A missing schema (isAbsent) used to be validated ONLY by MissingElementValidator, which
      // checks for placeholder text and never parses the JSON-LD - so an absent-Organization
      // recommendation with a fabricated logo URL, a duplicate @id or a malformed breadcrumb
      // passed. Schema-group output always gets the schema validator as well.
      if (isAbsent && group === GROUP.SCHEMA) {
        result = mergeResults(result, schemaValidator.validate(sections, recommendationContext));
      } else if (recommendationContext?.schemaEvidence && validator !== schemaValidator) {
        // Entity/E-E-A-T and AI-visibility recommendations for an Organization / Article (AISO-A1,
        // GEO-S5, GEO-S2, ...) may carry JSON-LD too: whatever it contains is checked against the
        // verified evidence. Prose-only output has nothing to check and passes through unchanged.
        const ev = schemaValidator.validateEvidence(sections, recommendationContext);
        result = mergeResults(result, { valid: ev.errors.length === 0, errors: ev.errors, warnings: ev.warnings, satisfiesConstraint: ev.errors.length === 0 });
      }

      if (result.errors.length > 0) {
        console.warn(`[VALIDATOR] GROUP ${group} | ${result.errors.length} error(s) | satisfies=${result.satisfiesConstraint}`);
        result.errors.forEach(e => console.warn(`  ✗ ${e}`));
      }
      if (result.warnings.length > 0) {
        result.warnings.forEach(w => console.log(`  ⚠ ${w}`));
      }

      return result;
    } catch (err) {
      console.error(`[VALIDATOR] Validator threw for group ${group}:`, err.message);
      // Validation errors must not block generation — return valid=true with warning
      return {
        valid: true,
        errors: [],
        warnings: [`Validator exception (group ${group}): ${err.message}`],
        satisfiesConstraint: true,
      };
    }
  }

  /**
   * Quick check: does this group have a registered validator?
   *
   * @param {number} group
   * @returns {boolean}
   */
  hasValidator(group) {
    return Boolean(VALIDATOR_MAP[group]);
  }
}

export default new ValidatorRegistry();
