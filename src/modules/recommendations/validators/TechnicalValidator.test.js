import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import technicalValidator from './TechnicalValidator.js';

/**
 * Regression coverage for the production bug where a canonical_tag_errors
 * recommendation was generated with recommendedVersion containing the full
 * `<link rel="canonical" href="...">` HTML tag instead of a bare URL.
 * TechnicalValidator used to silently extract the href out of that tag and
 * validate just the href — meaning a full HTML-wrapped recommendedVersion
 * "passed" validation and never triggered Claude's repair/retry mechanism
 * (recommendationService._tryClaudeGeneration only re-prompts when
 * satisfiesConstraint is false on attempt 1). recommendedVersion is stored
 * and used DIRECTLY as the value written to WordPress — never rendered as
 * HTML — so silently accepting a wrapped tag let a literal HTML string
 * reach Rank Math's canonical meta field, which Rank Math accepted (HTTP
 * 200) but declined to render, leaving the public page with no canonical
 * tag at all. This validator must now flag ANY markup in recommendedVersion
 * as a hard satisfiesConstraint failure so the repair loop engages instead
 * of silently unwrapping it.
 */
function makeSections(overrides = {}) {
  return {
    whyThisMatters: 'Canonical tags prevent duplicate content issues.',
    recommendedFix: 'Add a self-referencing canonical tag.',
    implementationExample: { content: '<link rel="canonical" href="https://naxonify.com/about-naxonify/" />' },
    expectedImpact: ['Consolidates ranking signals'],
    estimatedRecovery: { min: 1, max: 3, unit: 'weeks' },
    recommendedVersion: 'https://naxonify.com/about-naxonify/',
    ...overrides,
  };
}

const rc = {
  identity: { issueId: 'canonical_tag_errors' },
  pageContext: { pageUrl: 'https://naxonify.com/about-naxonify/' },
};

describe('TechnicalValidator — canonical_tag_errors', () => {
  test('a clean, same-domain absolute URL satisfies the constraint with no warnings', () => {
    const result = technicalValidator.validate(makeSections(), rc);
    assert.equal(result.satisfiesConstraint, true);
    assert.deepEqual(result.warnings, []);
  });

  test('the exact production bug: recommendedVersion containing an HTML <link> tag fails the constraint and is flagged, not silently unwrapped', () => {
    const sections = makeSections({
      recommendedVersion: '<link rel="canonical" href="https://naxonify.com/about-naxonify/" />',
    });
    const result = technicalValidator.validate(sections, rc);
    assert.equal(result.satisfiesConstraint, false);
    assert.ok(
      result.warnings.some((w) => w.includes('plain URL') && w.includes('HTML markup')),
      `expected a markup-rejection warning, got: ${JSON.stringify(result.warnings)}`
    );
  });

  test('any HTML markup in recommendedVersion is rejected, not just a <link> tag', () => {
    const sections = makeSections({ recommendedVersion: 'See <b>https://naxonify.com/about-naxonify/</b>' });
    const result = technicalValidator.validate(sections, rc);
    assert.equal(result.satisfiesConstraint, false);
    assert.ok(result.warnings.some((w) => w.includes('HTML markup')));
  });

  test('an empty recommendedVersion fails the constraint', () => {
    const result = technicalValidator.validate(makeSections({ recommendedVersion: '' }), rc);
    assert.equal(result.satisfiesConstraint, false);
    assert.ok(result.warnings.some((w) => w.includes('recommendedVersion is empty')));
  });

  test('a relative path (not absolute) fails the constraint', () => {
    const result = technicalValidator.validate(makeSections({ recommendedVersion: '/about-naxonify/' }), rc);
    assert.equal(result.satisfiesConstraint, false);
    assert.ok(result.warnings.some((w) => w.includes('not an absolute URL')));
  });

  test('a cross-domain canonical (likely hallucinated) fails the constraint', () => {
    const result = technicalValidator.validate(
      makeSections({ recommendedVersion: 'https://some-other-site.com/about-naxonify/' }),
      rc
    );
    assert.equal(result.satisfiesConstraint, false);
    assert.ok(result.warnings.some((w) => w.includes('cross-domain mismatch')));
  });
});

/**
 * Regression coverage for the robots capability added alongside the WordPress
 * Apply-fix expansion (noindex_key_pages/noindex_tags -> Rank Math's
 * rank_math_robots field). Same rigor as canonical above: recommendedVersion
 * must be one of exactly 4 machine-parseable directive strings, reusing
 * valueNormalization.js's normalizeRobotsValue() so this validator's
 * pass/fail decision can never drift from what TaskHistoryService later
 * derives as the actual value written to WordPress.
 */
const robotsRc = { identity: { issueId: 'noindex_key_pages' }, pageContext: { pageUrl: 'https://example.com/key-page/' } };

describe('TechnicalValidator — noindex_key_pages / noindex_tags (robots)', () => {
  test('each of the 4 allowed directive strings satisfies the constraint with no warnings', () => {
    for (const value of ['index, follow', 'noindex, follow', 'index, nofollow', 'noindex, nofollow']) {
      const result = technicalValidator.validate(makeSections({ recommendedVersion: value }), robotsRc);
      assert.equal(result.satisfiesConstraint, true, `expected "${value}" to satisfy the constraint`);
      assert.deepEqual(result.warnings, []);
    }
  });

  test('noindex_tags is validated identically to noindex_key_pages', () => {
    const rc2 = { identity: { issueId: 'noindex_tags' }, pageContext: { pageUrl: 'https://example.com/key-page/' } };
    const result = technicalValidator.validate(makeSections({ recommendedVersion: 'index, follow' }), rc2);
    assert.equal(result.satisfiesConstraint, true);
  });

  test('free-form prose instead of an exact directive string fails the constraint and is flagged', () => {
    const result = technicalValidator.validate(
      makeSections({ recommendedVersion: 'Remove the noindex tag from this page' }),
      robotsRc
    );
    assert.equal(result.satisfiesConstraint, false);
    assert.ok(result.warnings.some((w) => w.includes('robots directive')));
  });

  test('an empty recommendedVersion fails the constraint', () => {
    const result = technicalValidator.validate(makeSections({ recommendedVersion: '' }), robotsRc);
    assert.equal(result.satisfiesConstraint, false);
    assert.ok(result.warnings.some((w) => w.includes('recommendedVersion is empty')));
  });

  test('an unsupported directive (e.g. "noarchive") fails the constraint — never smuggled through', () => {
    const result = technicalValidator.validate(makeSections({ recommendedVersion: 'noarchive, follow' }), robotsRc);
    assert.equal(result.satisfiesConstraint, false);
  });
});
