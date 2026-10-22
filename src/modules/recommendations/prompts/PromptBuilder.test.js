import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import promptBuilder from './PromptBuilder.js';

/**
 * Regression coverage for the repair-prompt branch added to fix the
 * production bug where a canonical_tag_errors recommendation was generated
 * with recommendedVersion containing a full `<link rel="canonical"
 * href="...">` HTML tag instead of a bare URL. TechnicalValidator.js now
 * flags this as a validation failure (satisfiesConstraint: false), which
 * triggers this repair prompt on retry. The branch ordering matters: the
 * validator's warning text ("canonical recommendedVersion must be a plain
 * URL, not HTML markup") contains the substring "canonical", which would
 * otherwise match the pre-existing cross-domain branch below it and give
 * Claude the WRONG guidance (about domain mismatch, not about markup) — so
 * the markup/html branch must be checked first.
 *
 * _buildRepairBlock is exercised directly (rather than through the public
 * buildRepair(), which requires building a full group-3 prompt from an
 * elaborate RecommendationContext) since it's the isolated unit that
 * contains the branch-selection logic under test.
 */
describe('PromptBuilder._buildRepairBlock() — canonical markup repair branch', () => {
  const rc = { pageContext: { pageUrl: 'https://naxonify.com/about-naxonify/' } };

  test('a markup validation failure produces bare-URL repair guidance, not cross-domain guidance', () => {
    const failureReasons = [
      'canonical recommendedVersion must be a plain URL, not HTML markup: "<link rel=\\"canonical\\" href=\\"https://naxonify.com/about-naxonify/\\" />"',
    ];
    const block = promptBuilder._buildRepairBlock(rc, '', failureReasons);

    assert.match(block, /bare URL string/i);
    assert.match(block, /https:\/\/naxonify\.com\/about-naxonify\//);
    assert.doesNotMatch(block, /wrong domain/i);
  });

  test('a genuine cross-domain failure (no markup mention) still produces domain-mismatch guidance', () => {
    const failureReasons = [
      'canonical cross-domain mismatch: page="naxonify.com" vs recommended="some-other-site.com" — likely hallucinated URL',
    ];
    const block = promptBuilder._buildRepairBlock(rc, '', failureReasons);

    assert.match(block, /wrong domain/i);
    assert.match(block, /naxonify\.com/);
    assert.doesNotMatch(block, /bare URL string/i);
  });
});

describe('PromptBuilder — schema group (organization_schema): implementationCode is always the JSON-LD script block', () => {
  const rc = (over = {}) => ({
    identity: { issueId: 'organization_schema' },
    currentState: { isAbsent: false, codeContent: '{"@type":"Organization","name":"Naxonify"}' },
    expectedState: {},
    pageContext: { pageUrl: 'https://naxonify.com/', framework: 'unknown', cms: 'wordpress', pageType: 'Homepage', ...over.pageContext },
    recommendationObjective: { action: 'add', target: 'address', constraint: 'valid JSON-LD', successCriteria: 's', preserveContext: 'p' },
    ...over,
  });
  const build = (over) => promptBuilder.build(rc(over)).prompt;

  test('a WordPress site (cms only) is told to keep PHP out of implementationCode', () => {
    const prompt = build();
    assert.match(prompt, /implementationCode": ONLY the complete JSON-LD inside a <script type="application\/ld\+json">/);
    assert.match(prompt, /never PHP, JavaScript or any other language/);
    assert.match(prompt, /do NOT write PHP/);
    assert.doesNotMatch(prompt, /wp_head\(\) hook in functions\.php/);
  });

  test('other platforms keep placement guidance in implementationNotes, not in the code field', () => {
    assert.match(build({ pageContext: { cms: null, framework: 'nextjs' } }), /Next\.js Script component/);
    assert.match(build({ pageContext: { cms: null, framework: 'unknown' } }), /place the <script type="application\/ld\+json"> block in the <head>/);
  });

  test('missing values (e.g. address) are omitted and flagged as needing input — never invented', () => {
    const prompt = build();
    assert.match(prompt, /OMIT it from the JSON-LD/);
    assert.match(prompt, /needs your input/);
    assert.doesNotMatch(prompt, /Required fields for the schema type must ALL be present/);
  });

  test('an existing schema is to be extended, and is passed in full (not cut at 800 chars)', () => {
    const long = JSON.stringify({ '@type': 'Organization', name: 'Naxonify', description: 'x'.repeat(2500), tail: 'END-OF-SCHEMA' });
    const prompt = build({ currentState: { isAbsent: false, codeContent: long } });
    assert.match(prompt, /keep every existing property unchanged and only add what is missing/);
    assert.ok(prompt.includes('END-OF-SCHEMA'), 'schema longer than 800 chars must reach the model');
  });
});
