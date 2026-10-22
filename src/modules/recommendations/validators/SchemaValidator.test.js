import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import schemaValidator from './SchemaValidator.js';

/**
 * Regression coverage for the sameas_array / breadcrumblist_schema
 * special-case branches added alongside the site-level Rank Math
 * Knowledge Graph/breadcrumbs Bridge capability. Without these branches,
 * the GENERIC schema validator (which requires recommendedVersion to be
 * full, valid JSON-LD) would reject the single bare-value format
 * providerCapabilityRegistry.js's same_as/breadcrumb_schema capabilities
 * actually need — a plain URL, or the literal strings "not provided in
 * context"/"enabled" — since none of those parse as JSON at all.
 */
function makeSections(overrides = {}) {
  return {
    whyThisMatters: 'sameAs links this business to its verified social profiles for entity recognition.',
    recommendedFix: 'Add the missing sameAs URL.',
    implementationExample: { content: '{"@context":"https://schema.org","@type":"Organization","sameAs":["https://linkedin.com/company/example"]}' },
    expectedImpact: ['Improves entity recognition'],
    estimatedRecovery: { aiVisibility: 10, semanticTrust: 10, freshness: 0, accessibility: 0 },
    recommendedVersion: 'https://linkedin.com/company/example',
    ...overrides,
  };
}

describe('SchemaValidator — sameas_array', () => {
  const rc = { identity: { issueId: 'sameas_array' } };

  test('a clean, real-looking absolute URL satisfies the constraint', () => {
    const result = schemaValidator.validate(makeSections(), rc);
    assert.equal(result.satisfiesConstraint, true);
  });

  test('the honest "not provided in context" refusal is a VALID, satisfying answer, not a failure', () => {
    const result = schemaValidator.validate(makeSections({ recommendedVersion: 'not provided in context' }), rc);
    assert.equal(result.satisfiesConstraint, true);
    assert.deepEqual(result.warnings, []);
  });

  test('the refusal phrase is case/whitespace-insensitive', () => {
    const result = schemaValidator.validate(makeSections({ recommendedVersion: '  Not Provided In Context  ' }), rc);
    assert.equal(result.satisfiesConstraint, true);
  });

  test('free-form prose (neither a URL nor the exact refusal phrase) fails the constraint', () => {
    const result = schemaValidator.validate(makeSections({ recommendedVersion: 'The business has no listed social profiles.' }), rc);
    assert.equal(result.satisfiesConstraint, false);
  });

  test('HTML markup fails the constraint', () => {
    const result = schemaValidator.validate(makeSections({ recommendedVersion: '<a href="https://linkedin.com/company/example">link</a>' }), rc);
    assert.equal(result.satisfiesConstraint, false);
  });

  test('an empty recommendedVersion fails as a hard error', () => {
    const result = schemaValidator.validate(makeSections({ recommendedVersion: '' }), rc);
    assert.equal(result.valid, false);
    assert.equal(result.satisfiesConstraint, false);
  });

  test('never attempts JSON parsing on the bare-URL/refusal value (would otherwise always fail)', () => {
    // If this test ever starts failing with a JSON-parse-related error
    // message, the early-return branch has regressed and the generic
    // full-JSON-LD path is running again for this issue.
    const result = schemaValidator.validate(makeSections(), rc);
    assert.ok(!result.errors.some((e) => /JSON/i.test(e)));
  });
});

describe('SchemaValidator — breadcrumblist_schema', () => {
  const rc = { identity: { issueId: 'breadcrumblist_schema' } };

  test('the exact literal "enabled" satisfies the constraint', () => {
    const result = schemaValidator.validate(makeSections({ recommendedVersion: 'enabled' }), rc);
    assert.equal(result.satisfiesConstraint, true);
  });

  test('anything else (including boolean-ish strings) fails the constraint', () => {
    for (const bad of ['true', '1', 'yes', 'Turn on breadcrumbs']) {
      const result = schemaValidator.validate(makeSections({ recommendedVersion: bad }), rc);
      assert.equal(result.satisfiesConstraint, false, `expected "${bad}" to fail`);
    }
  });

  test('an empty recommendedVersion fails as a hard error', () => {
    const result = schemaValidator.validate(makeSections({ recommendedVersion: '' }), rc);
    assert.equal(result.valid, false);
  });
});

describe('SchemaValidator — regression: the generic full-JSON-LD path is unaffected for other schema issues', () => {
  test('organization_schema still requires valid JSON-LD with @context/@type/required props', () => {
    const rc = { identity: { issueId: 'organization_schema' } };
    // Deliberately NOT example.com — BaseValidator's placeholder detection
    // flags a bare "https://example.com" URL as ungrounded content.
    const json = '{"@context":"https://schema.org","@type":"Organization","name":"Naxonify","url":"https://naxonify.com"}';
    const sections = makeSections({
      recommendedVersion: json,
      implementationExample: { content: json },
    });
    const result = schemaValidator.validate(sections, rc);
    assert.equal(result.satisfiesConstraint, true);
  });

  test('organization_schema still rejects malformed JSON', () => {
    const rc = { identity: { issueId: 'organization_schema' } };
    const sections = makeSections({
      recommendedVersion: 'not json at all',
      implementationExample: { content: 'not json at all' },
    });
    const result = schemaValidator.validate(sections, rc);
    assert.equal(result.valid, false);
  });
});

describe('SchemaValidator — JSON-LD is found wherever it legitimately is (organization_schema PHP regression)', () => {
  const rc = { identity: { issueId: 'organization_schema' } };
  const good = { '@context': 'https://schema.org', '@type': 'Organization', name: 'Naxonify', url: 'https://naxonify.com' };
  const goodJson = JSON.stringify(good, null, 2);
  // What production actually returned for implementationCode: a PHP wp_head snippet.
  const php = '<?php\nfunction odito_org_schema() {\n  $schema = array("@context" => "https://schema.org", "@type" => "Organization");\n  echo \'<script type="application/ld+json">\' . json_encode($schema) . \'</script>\';\n}\nadd_action("wp_head", "odito_org_schema");';
  const sections = (impl, recommended) => makeSections({ recommendedVersion: recommended, implementationExample: { content: impl } });

  test('PHP implementationCode + valid JSON-LD in recommendedVersion -> valid (this exact case used to fail twice and fall back)', () => {
    const r = schemaValidator.validate(sections(php, goodJson), rc);
    assert.equal(r.valid, true);
    assert.equal(r.satisfiesConstraint, true);
    assert.deepEqual(r.errors, []);
    assert.ok(r.warnings.some((w) => /not plain JSON-LD/.test(w)));
  });

  test('a <script type="application/ld+json"> block as implementationCode is accepted without a warning', () => {
    const r = schemaValidator.validate(sections(`<script type="application/ld+json">\n${goodJson}\n</script>`, goodJson), rc);
    assert.equal(r.satisfiesConstraint, true);
    assert.deepEqual(r.warnings, []);
  });

  test('JSON-LD embedded in a larger snippet (JSX / inline script) is found', () => {
    const jsx = `export default function P(){ return <script type="application/ld+json" dangerouslySetInnerHTML={{__html: ${JSON.stringify(goodJson)}}} /> }\nconst data = ${goodJson};`;
    const r = schemaValidator.validate(sections(jsx, 'see implementation'), rc);
    assert.equal(r.valid, true);
  });

  test('when implementationCode holds the JSON-LD, its content is what gets checked (a bad recommendedVersion does not mask it)', () => {
    const r = schemaValidator.validate(sections(goodJson, 'plain words'), rc);
    assert.equal(r.satisfiesConstraint, true);
  });

  test('a PHP snippet with NO JSON-LD anywhere is still rejected with the JSON error', () => {
    const r = schemaValidator.validate(sections(php, 'no schema here either'), rc);
    assert.equal(r.valid, false);
    assert.equal(r.satisfiesConstraint, false);
    assert.ok(r.errors.some((e) => /not valid JSON/.test(e)));
  });

  test('the fallback does not weaken the schema checks: recommendedVersion with a wrong @context or a placeholder still fails', () => {
    const wrongCtx = JSON.stringify({ ...good, '@context': 'https://example.org/vocab' });
    assert.equal(schemaValidator.validate(sections(php, wrongCtx), rc).satisfiesConstraint, false);
    const placeholder = JSON.stringify({ ...good, name: '[Business Name]' });
    assert.equal(schemaValidator.validate(sections(php, placeholder), rc).satisfiesConstraint, false);
  });

  test('brace-like text that is not JSON-LD (a PHP function body) is ignored, not mistaken for a schema', () => {
    const r = schemaValidator.validate(sections('function f() { return {"a": 1}; }', goodJson), rc);
    assert.equal(r.satisfiesConstraint, true);
    assert.ok(r.warnings.some((w) => /recommendedVersion/.test(w)));
  });
});
