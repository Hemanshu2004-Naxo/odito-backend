import { IMPLEMENTATION_TYPES, DIFFICULTY } from '../constants/recommendationTypes.js';

/**
 * Recommendation Validator
 * 
 * Validates the final normalized sections before DB storage.
 * Ensures structural integrity of the recommendation object.
 * 
 * Returns { valid: boolean, errors: string[] }
 */

class RecommendationValidator {

  /**
   * Validate final sections object before storage.
   * 
   * @param {Object} sections - Normalized sections object
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validate(sections) {
    const errors = [];

    if (!sections) {
      return { valid: false, errors: ['Sections object is null/undefined'] };
    }

    // Required string fields
    if (!sections.whyThisMatters || typeof sections.whyThisMatters !== 'string') {
      errors.push('whyThisMatters is missing or not a string');
    }

    if (!sections.recommendedFix || typeof sections.recommendedFix !== 'string') {
      errors.push('recommendedFix is missing or not a string');
    }

    // implementationExample must be { type, content }
    if (!sections.implementationExample || typeof sections.implementationExample !== 'object') {
      errors.push('implementationExample is missing or not an object');
    } else {
      if (!Object.values(IMPLEMENTATION_TYPES).includes(sections.implementationExample.type)) {
        errors.push(`implementationExample.type is invalid: ${sections.implementationExample.type}`);
      }
      if (!sections.implementationExample.content || typeof sections.implementationExample.content !== 'string') {
        errors.push('implementationExample.content is missing or not a string');
      }
    }

    // expectedImpact must be array of strings
    if (!Array.isArray(sections.expectedImpact)) {
      errors.push('expectedImpact must be an array');
    } else if (sections.expectedImpact.length === 0) {
      errors.push('expectedImpact array is empty');
    } else {
      const invalidItems = sections.expectedImpact.filter(i => typeof i !== 'string');
      if (invalidItems.length > 0) {
        errors.push(`expectedImpact contains ${invalidItems.length} non-string items`);
      }
    }

    // estimatedRecovery must be structured object with numbers
    if (!sections.estimatedRecovery || typeof sections.estimatedRecovery !== 'object') {
      errors.push('estimatedRecovery is missing or not an object');
    } else {
      const requiredKeys = ['aiVisibility', 'semanticTrust', 'freshness', 'accessibility'];
      for (const key of requiredKeys) {
        if (typeof sections.estimatedRecovery[key] !== 'number') {
          errors.push(`estimatedRecovery.${key} is not a number`);
        }
      }
    }

    // difficulty must be valid enum
    if (!Object.values(DIFFICULTY).includes(sections.difficulty)) {
      errors.push(`difficulty is invalid: ${sections.difficulty}`);
    }

    // estimatedFixTime must be string
    if (!sections.estimatedFixTime || typeof sections.estimatedFixTime !== 'string') {
      errors.push('estimatedFixTime is missing or not a string');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate Claude's raw output structure (before normalization).
   * Loose validation — normalizer handles cleanup.
   * 
   * @param {Object} rawOutput - Claude's partial intelligence
   * @returns {{ usable: boolean, missingFields: string[] }}
   */
  validateRawAIOutput(rawOutput) {
    const missingFields = [];

    if (!rawOutput || typeof rawOutput !== 'object') {
      return { usable: false, missingFields: ['entire_response'] };
    }

    // Check critical fields that normalizer needs.
    // For content improvement responses, optimizedText replaces implementationCode.
    if (!rawOutput.whyThisMatters) missingFields.push('whyThisMatters');
    if (!rawOutput.recommendedFix) missingFields.push('recommendedFix');
    if (!rawOutput.implementationCode && !rawOutput.optimizedText) missingFields.push('implementationCode');

    // If all critical fields are missing, output is not usable
    const usable = missingFields.length < 3;

    return { usable, missingFields };
  }
}

export default new RecommendationValidator();
