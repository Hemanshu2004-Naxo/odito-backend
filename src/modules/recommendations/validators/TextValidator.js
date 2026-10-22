/**
 * TextValidator — GROUP 1 (Text Optimization) + GROUP 2 (Content Optimization)
 *
 * Validates recommendations for all text-based issues:
 *   title, meta description, H1, keyword density, thin_content,
 *   heading hierarchy, keyword placement.
 *
 * Key constraints:
 *   - Title:           30–60 characters
 *   - Meta description:120–160 characters
 *   - H1:              10–100 characters, not duplicate of title
 *   - recommendedVersion must not be placeholder text
 *   - Character counts are measured on the actual text, not the surrounding code
 */

import { BaseValidator } from './BaseValidator.js';

// Issues with character-range constraints (issueId → [min, max])
const CHAR_RANGE_BY_ISSUE = {
  title_too_short:            [30,  60],
  title_too_long:             [30,  60],
  title_missing:              [30,  60],
  title_pixel_length:         [30,  60],
  meta_description_too_short: [120, 160],
  meta_description_too_long:  [120, 160],
  meta_description_missing:   [120, 160],
  meta_description_ctr:       [120, 160],
  h1_missing:                 [10,  100],
  keyword_not_in_h1:          [10,  100],
};

// Issues where we just check non-empty and non-placeholder
const NON_EMPTY_ISSUES = new Set([
  'multiple_title_tags',
  'multiple_meta_descriptions',
  'multiple_h1_tags',
  'heading_hierarchy_skipped',
  'thin_content',
  'service_pages_800_words',
  'duplicate_content',
  'short_paragraphs_3_to_5_lines',
]);

// Brand-name duplication patterns (e.g. "Naxonify | Naxonify Services")
const BRAND_DUPE_RE = /(\b\w{3,}\b).+\1/i;

export class TextValidator extends BaseValidator {

  validate(sections, rc) {
    const errors   = [];
    const warnings = [];

    this._validateCoreSections(sections, errors);
    this._checkNoPlaceholders(sections, errors);

    const issueId       = rc?.identity?.issueId || '';
    const expectedState = rc?.expectedState || {};
    const recommended   = sections.recommendedVersion || sections.contentRewrite?.after || '';

    let satisfiesConstraint = true;

    // ── Character range check ─────────────────────────────────────────────
    const range = CHAR_RANGE_BY_ISSUE[issueId];
    if (range && recommended) {
      const [min, max] = range;
      const result = this._checkCharacterRange(recommended, min, max, 'recommendedVersion');
      if (!result.ok) {
        warnings.push(result.message);
        satisfiesConstraint = false;
      }
    } else if (range && !recommended) {
      // Range issue but no recommended text produced
      warnings.push(`recommendedVersion is empty for issue requiring ${range[0]}–${range[1]} chars`);
      satisfiesConstraint = false;
    }

    // ── expectedState fallback range check ────────────────────────────────
    // When the issue isn't in CHAR_RANGE_BY_ISSUE, use expectedState if available
    if (!range && recommended && (expectedState.targetMin || expectedState.targetMax)) {
      satisfiesConstraint = this._textSatisfiesConstraint(recommended, expectedState);
      if (!satisfiesConstraint) {
        warnings.push(`recommendedVersion does not satisfy target range: ${expectedState.targetRange || JSON.stringify(expectedState)}`);
      }
    }

    // ── Non-empty issues ──────────────────────────────────────────────────
    if (NON_EMPTY_ISSUES.has(issueId)) {
      satisfiesConstraint = this._absentSatisfiesConstraint(sections);
      if (!satisfiesConstraint) {
        warnings.push(`recommendedVersion is empty or placeholder for issue: ${issueId}`);
      }
    }

    // ── Absent issues → any non-placeholder content satisfies ────────────
    if (rc?.currentState?.isAbsent && !range && !NON_EMPTY_ISSUES.has(issueId)) {
      satisfiesConstraint = this._absentSatisfiesConstraint(sections);
    }

    // ── Brand name duplication check (title issues) ───────────────────────
    if (issueId.startsWith('title_') && recommended && BRAND_DUPE_RE.test(recommended)) {
      warnings.push('recommendedVersion may contain a duplicated brand name — review before publishing');
    }

    // ── H1 should not be identical to title ───────────────────────────────
    if (issueId.startsWith('h1_') || issueId === 'keyword_not_in_h1') {
      const pageTitle = rc?.contentContext?.pageTitle;
      if (pageTitle && recommended && recommended.trim().toLowerCase() === pageTitle.trim().toLowerCase()) {
        warnings.push('H1 is identical to the page title — consider making it distinct');
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      satisfiesConstraint,
    };
  }
}

export default new TextValidator();
