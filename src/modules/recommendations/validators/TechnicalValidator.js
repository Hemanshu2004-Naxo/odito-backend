/**
 * TechnicalValidator — GROUP 3 (Technical SEO)
 *
 * Validates recommendations for technical SEO issues:
 *   canonical, OG tags, redirects, orphan pages, click depth,
 *   internal links, broken links, URL structure.
 *
 * Key rules:
 *   - canonical:    recommendedVersion must be a valid absolute URL
 *   - OG tags:      missing fields must be addressed in recommendedVersion
 *   - redirects:    implementation must target the detected chain
 *   - URLs:         recommended URL must be valid format
 *   - Link fixes:   at least one link must be provided (not generic advice)
 */

import { BaseValidator } from './BaseValidator.js';
import { normalizeRobotsValue } from '../../tasks/service/valueNormalization.js';

// Issues where recommendedVersion must be a valid URL
const URL_REQUIRED_ISSUES = new Set([
  'canonical_tag_errors',
  'non_seo_friendly_urls',
  'long_urls',
  'double_slash_urls',
]);

// Issues where implementationCode must be non-empty
const CODE_REQUIRED_ISSUES = new Set([
  'canonical_tag_errors',
  'og_tags_incomplete',
  'og_tags_missing',
  'meta_refresh',
  'redirect_chains',
  'redirect_chains_crawlability',
]);

// Max allowed chain length for redirect / click depth fixes
const MAX_ACCEPTABLE_DEPTH = 3;

export class TechnicalValidator extends BaseValidator {

  validate(sections, rc) {
    const errors   = [];
    const warnings = [];

    this._validateCoreSections(sections, errors);
    this._checkNoPlaceholders(sections, errors);

    const issueId      = rc?.identity?.issueId || '';
    const recommended  = sections.recommendedVersion || '';
    const implCode     = sections.implementationExample?.content || '';

    let satisfiesConstraint = true;

    // ── Canonical: recommended must be a valid absolute URL, same domain as page ─
    if (issueId === 'canonical_tag_errors') {
      if (!recommended) {
        warnings.push('canonical_tag_errors: recommendedVersion is empty — URL fix not provided');
        satisfiesConstraint = false;
      } else if (/<[a-z][\s\S]*>/i.test(recommended)) {
        // Bug fix (production): this used to EXTRACT the href out of an
        // HTML tag like <link rel="canonical" href="..."> and validate
        // just that — silently treating a full HTML tag as an acceptable
        // recommendedVersion. recommendedVersion is stored and used
        // DIRECTLY as the value written to WordPress (see
        // TaskHistoryService._deriveExpectedAfterValue), never rendered as
        // HTML — so accepting a wrapped tag here let a literal HTML string
        // reach Rank Math's canonical meta field, which Rank Math silently
        // declined to render (no error, just no <link> tag on the public
        // page). recommendedVersion must be a bare URL; markup belongs
        // only in implementationCode. Flagging this here (rather than
        // unwrapping and accepting) engages the SAME repair-prompt retry
        // the cross-domain check below already uses.
        warnings.push(`canonical recommendedVersion must be a plain URL, not HTML markup: "${recommended}"`);
        satisfiesConstraint = false;
      } else {
        const urlToCheck = recommended.trim();
        const result = this._checkAbsoluteUrl(urlToCheck, 'canonical recommendedVersion');
        if (!result.ok) {
          warnings.push(result.message);
          satisfiesConstraint = false;
        } else {
          // Cross-domain hallucination guard: canonical domain must match page domain
          const pageUrl = rc?.pageContext?.pageUrl || rc?.technicalContext?.pageUrl || '';
          if (pageUrl) {
            const pageDomain  = this._extractDomain(pageUrl);
            const canonDomain = this._extractDomain(urlToCheck);
            if (pageDomain && canonDomain && pageDomain !== canonDomain) {
              warnings.push(
                `canonical cross-domain mismatch: page="${pageDomain}" vs recommended="${canonDomain}" — likely hallucinated URL`
              );
              satisfiesConstraint = false;
            }
          }
        }
      }
    }

    // ── Robots: recommended must be exactly one of the 4 allowed directive
    // strings — reuses valueNormalization.js's normalizeRobotsValue() so
    // this validator's pass/fail decision and TaskHistoryService's later
    // derivation of the actual write value can never disagree about what
    // counts as a valid robots recommendation (the exact same class of bug
    // the canonical HTML production incident was caused by: a validator
    // that tolerated a shape the write path could not safely use).
    if (issueId === 'noindex_key_pages' || issueId === 'noindex_tags') {
      if (!recommended) {
        warnings.push(`${issueId}: recommendedVersion is empty — robots directive fix not provided`);
        satisfiesConstraint = false;
      } else if (!normalizeRobotsValue(recommended)) {
        warnings.push(
          `${issueId}: recommendedVersion must be an exact robots directive string ("index, follow" | "noindex, follow" | "index, nofollow" | "noindex, nofollow"), not: "${recommended}"`
        );
        satisfiesConstraint = false;
      }
    }

    // ── OG tags: at least the missing fields must be addressed ────────────
    if (issueId === 'og_tags_incomplete' || issueId === 'og_tags_missing') {
      const missingFields = rc?.technicalContext?.ogFieldsMissing || [];
      if (missingFields.length > 0 && recommended) {
        // Check that each missing field is mentioned in the output
        const unaddressed = missingFields.filter(f => {
          const bareKey = f.replace('og:', '');
          return !recommended.includes(f) && !recommended.includes(bareKey) && !implCode.includes(f) && !implCode.includes(bareKey);
        });
        if (unaddressed.length > 0) {
          warnings.push(`OG tags not addressed in output: ${unaddressed.join(', ')}`);
          satisfiesConstraint = unaddressed.length < missingFields.length; // partial credit
        }
      } else if (missingFields.length > 0 && !recommended) {
        warnings.push('OG tags: recommendedVersion is empty — missing fields not addressed');
        satisfiesConstraint = false;
      }
    }

    // ── URL issues: recommended URL must be valid ─────────────────────────
    if (URL_REQUIRED_ISSUES.has(issueId) && issueId !== 'canonical_tag_errors') {
      if (recommended) {
        const result = this._checkUrl(recommended, 'recommendedVersion URL');
        if (!result.ok) {
          warnings.push(result.message);
          satisfiesConstraint = false;
        }
      } else {
        warnings.push(`${issueId}: no recommended URL provided`);
        satisfiesConstraint = false;
      }
    }

    // ── Code-required issues ──────────────────────────────────────────────
    if (CODE_REQUIRED_ISSUES.has(issueId) && !implCode) {
      warnings.push(`${issueId}: implementation code not provided — may be non-actionable`);
    }

    // ── Redirect depth: chain should be shorter ───────────────────────────
    if ((issueId === 'redirect_chains' || issueId === 'redirect_chains_crawlability') && recommended) {
      const hopCount = (recommended.match(/→/g) || []).length;
      if (hopCount >= (rc?.currentState?.chainHops?.length ?? MAX_ACCEPTABLE_DEPTH + 1)) {
        warnings.push('Redirect fix does not appear to reduce the chain length');
        satisfiesConstraint = false;
      }
    }

    // ── Click depth: depth should be ≤3 ──────────────────────────────────
    if (issueId === 'click_depth') {
      satisfiesConstraint = Boolean(recommended || implCode);
      if (!satisfiesConstraint) {
        warnings.push('click_depth: no actionable fix provided');
      }
    }

    // ── Orphan / internal links: must name specific pages ─────────────────
    if (issueId === 'orphan_pages' || issueId === 'topic_clusters_internal_links') {
      satisfiesConstraint = Boolean(recommended && recommended.length > 30);
      if (!satisfiesConstraint) {
        warnings.push(`${issueId}: recommendation too short — may not name specific pages`);
      }
    }

    // ── Absent issues ─────────────────────────────────────────────────────
    if (rc?.currentState?.isAbsent) {
      satisfiesConstraint = this._absentSatisfiesConstraint(sections);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      satisfiesConstraint,
    };
  }

  /** Extract hostname from a URL string, lowercase, without www. prefix. */
  _extractDomain(url) {
    try {
      const { hostname } = new URL(url);
      return hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return null;
    }
  }
}

export default new TechnicalValidator();
