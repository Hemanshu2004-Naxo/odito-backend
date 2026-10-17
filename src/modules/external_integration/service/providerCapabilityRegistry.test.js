import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPABILITY_REGISTRY,
  getCapabilityForField,
  getCapabilityForIssue,
  listSupportedFields,
} from './providerCapabilityRegistry.js';
import { inferSnapshotType } from '../../tasks/service/issueSnapshotTypes.js';

/**
 * The centralized issue -> field capability matrix requested alongside the
 * WordPress Apply-fix expansion to robots + site-scoped schema (same_as,
 * breadcrumb_schema) + FAQPage schema + (deliberately withheld)
 * Organization-multi-field/Person. This is the one place a controller or the frontend can ask
 * "is this issue automatable, and through which field" without any
 * Rank-Math (or other provider) specific name ever appearing outside
 * providerCapabilityRegistry.js/oditoSeoBridgeService.js/the Bridge itself.
 */
describe('providerCapabilityRegistry — supported fields', () => {
  test('title, meta_description, canonical, robots, same_as, breadcrumb_schema, faq_schema, aggregate_rating are all marked supported', () => {
    for (const field of ['title', 'meta_description', 'canonical', 'robots', 'same_as', 'breadcrumb_schema', 'faq_schema', 'aggregate_rating']) {
      assert.equal(CAPABILITY_REGISTRY[field].supported, true, `expected ${field} to be supported`);
    }
  });

  test('listSupportedFields() returns exactly the 10 supported fields', () => {
    assert.deepEqual(
      listSupportedFields().sort(),
      ['aggregate_rating', 'breadcrumb_schema', 'canonical', 'faq_schema', 'h1', 'meta_description', 'organization_schema', 'robots', 'same_as', 'title']
    );
  });

  test('organization_schema is a TYPED multi-field fix: Rank Math only, site-scoped, gated on a Bridge capability, verified at both levels', () => {
    const c = CAPABILITY_REGISTRY.organization_schema;
    assert.equal(c.supported, true);
    assert.equal(c.typedFix, true);
    assert.equal(c.scope, 'site');
    assert.equal(c.provider, 'rank_math');
    assert.equal(c.minBridgeCapability, 'organization_type');
    assert.deepEqual(c.issueCodes, ['organization_schema']);
    assert.deepEqual(c.bridgeField.fields, ['name', 'logo', 'type', 'address']);
    assert.deepEqual(c.fieldMinBridgeCapability, { address: 'organization_address' });
    assert.equal(c.immediateVerificationSupported, true);
    assert.equal(c.crawlerVerificationSupported, true);
    assert.equal(typeof c.normalizeRecommendation, 'undefined', 'its value is planned from evidence, never parsed from recommendation text');
  });

  test('every single-value supported field declares a normalizeRecommendation and valuesMatch function', () => {
    for (const field of listSupportedFields().filter((f) => !CAPABILITY_REGISTRY[f].typedFix)) {
      const capability = CAPABILITY_REGISTRY[field];
      assert.equal(typeof capability.normalizeRecommendation, 'function', `${field} missing normalizeRecommendation`);
      assert.equal(typeof capability.valuesMatch, 'function', `${field} missing valuesMatch`);
      assert.equal(capability.immediateVerificationSupported, true);
      assert.equal(capability.crawlerVerificationSupported, true);
    }
  });

  test('same_as and breadcrumb_schema are explicitly SITE-scoped, distinct from every post-scoped field', () => {
    assert.equal(CAPABILITY_REGISTRY.same_as.scope, 'site');
    assert.equal(CAPABILITY_REGISTRY.breadcrumb_schema.scope, 'site');
    for (const field of ['title', 'meta_description', 'canonical', 'robots', 'faq_schema', 'aggregate_rating']) {
      assert.equal(CAPABILITY_REGISTRY[field].scope, undefined, `${field} should be post-scoped (no explicit scope)`);
    }
  });

  test('same_as.valuesMatch checks membership in the full current sameAs array, never array equality', () => {
    const { valuesMatch } = CAPABILITY_REGISTRY.same_as;
    assert.equal(valuesMatch('https://linkedin.com/company/x', ['https://twitter.com/x', 'https://linkedin.com/company/x']), true);
    assert.equal(valuesMatch('https://linkedin.com/company/x', ['https://twitter.com/x']), false);
    assert.equal(valuesMatch('', ['https://twitter.com/x']), false);
  });
});

describe('providerCapabilityRegistry — faq_schema', () => {
  const { normalizeRecommendation, valuesMatch } = CAPABILITY_REGISTRY.faq_schema;
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [{ '@type': 'Question', name: 'What is SEO?', acceptedAnswer: { '@type': 'Answer', text: 'Search engine optimization.' } }],
  });

  test('routes the faq_schema issue and is wired into the apply-flow gate (issueSnapshotTypes)', () => {
    assert.deepEqual(CAPABILITY_REGISTRY.faq_schema.issueCodes, ['faq_schema']);
    assert.equal(getCapabilityForIssue('faq_schema').field, 'faq_schema');
    assert.equal(inferSnapshotType('faq_schema'), 'faq_schema');
  });

  test('normalizeRecommendation only accepts a well-formed FAQPage and returns its pairs', () => {
    assert.deepEqual(normalizeRecommendation(jsonLd), [{ question: 'What is SEO?', answer: 'Search engine optimization.' }]);
    assert.equal(normalizeRecommendation('add FAQ schema please'), null);
    assert.equal(normalizeRecommendation('{"@type":"FAQPage","mainEntity":[]}'), null);
  });

  test('valuesMatch compares question AND answer, never just the count', () => {
    const a = [{ question: 'Q?', answer: 'A' }];
    assert.equal(valuesMatch(a, [{ question: 'Q?', answer: 'A' }]), true);
    assert.equal(valuesMatch(a, [{ question: 'Q?', answer: 'B' }]), false);
    assert.equal(valuesMatch(a, null), false);
  });
});

describe('providerCapabilityRegistry — aggregate_rating', () => {
  const { normalizeRecommendation, valuesMatch } = CAPABILITY_REGISTRY.aggregate_rating;
  const node = {
    '@context': 'https://schema.org', '@type': 'Service', '@id': 'https://example.com/#svc', name: 'Svc',
    aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.8', reviewCount: '127', bestRating: '5' },
  };

  test('routes the aggregate_rating_schema issue and is wired into the apply-flow gate (issueSnapshotTypes)', () => {
    assert.deepEqual(CAPABILITY_REGISTRY.aggregate_rating.issueCodes, ['aggregate_rating_schema']);
    assert.equal(getCapabilityForIssue('aggregate_rating_schema').field, 'aggregate_rating');
    assert.equal(inferSnapshotType('aggregate_rating_schema'), 'aggregate_rating');
  });

  test('normalizeRecommendation only accepts a well-formed rating node on an entity with @id + name', () => {
    assert.deepEqual(normalizeRecommendation(JSON.stringify(node)).rating, { ratingValue: 4.8, bestRating: 5, reviewCount: 127 });
    assert.equal(normalizeRecommendation('Add AggregateRating.'), null);
    assert.equal(normalizeRecommendation({ ...node, '@id': '#svc' }), null);
  });

  test('valuesMatch needs the same entity AND the same figures', () => {
    const a = normalizeRecommendation(node);
    assert.equal(valuesMatch(a, normalizeRecommendation(node)), true);
    assert.equal(valuesMatch(a, normalizeRecommendation({ ...node, '@id': 'https://example.com/#other' })), false);
    assert.equal(valuesMatch(a, normalizeRecommendation({ ...node, aggregateRating: { ...node.aggregateRating, reviewCount: '128' } })), false);
    assert.equal(valuesMatch(a, null), false);
  });
});

describe('providerCapabilityRegistry — remaining schema gaps are honestly unsupported, not fabricated', () => {
  const unsupportedFields = ['person_schema'];

  test('every remaining unsupported field has a real, non-empty reason', () => {
    for (const field of unsupportedFields) {
      const capability = CAPABILITY_REGISTRY[field];
      assert.ok(capability, `expected a registry entry for ${field}`);
      assert.equal(capability.supported, false);
      assert.equal(typeof capability.unsupportedReason, 'string');
      assert.ok(capability.unsupportedReason.length > 20, `${field}'s unsupportedReason should be a real explanation, not a stub`);
    }
  });

  test('person_schema documents its real issue code (author_info_missing) for reference even while unsupported', () => {
    assert.deepEqual(CAPABILITY_REGISTRY.person_schema.issueCodes, ['author_info_missing']);
  });

  test('defense in depth: author_info_missing is NOT wired into issueSnapshotTypes.js, the actual apply-flow gate — the registry entry above is documentation only, never an enforcement path of its own', () => {
    assert.equal(inferSnapshotType('author_info_missing'), null);
  });

  test('unsupported fields report both verification levels as unavailable', () => {
    for (const field of unsupportedFields) {
      const capability = CAPABILITY_REGISTRY[field];
      assert.equal(capability.immediateVerificationSupported, false);
      assert.equal(capability.crawlerVerificationSupported, false);
    }
  });

  test('listSupportedFields() never includes a remaining-unsupported field', () => {
    const supported = listSupportedFields();
    for (const field of unsupportedFields) {
      assert.ok(!supported.includes(field), `${field} must not appear in listSupportedFields()`);
    }
  });
});

describe('getCapabilityForField()', () => {
  test('returns the matching entry for a known field', () => {
    const result = getCapabilityForField('canonical');
    assert.equal(result.supported, true);
    assert.deepEqual(result.issueCodes, ['canonical_tag_errors']);
  });

  test('returns null for an unknown field — never fabricates an entry', () => {
    assert.equal(getCapabilityForField('some_future_field'), null);
  });
});

describe('getCapabilityForIssue()', () => {
  test('resolves every known issue code to its field', () => {
    assert.equal(getCapabilityForIssue('title_missing').field, 'title');
    assert.equal(getCapabilityForIssue('meta_description_too_long').field, 'meta_description');
    assert.equal(getCapabilityForIssue('canonical_tag_errors').field, 'canonical');
    assert.equal(getCapabilityForIssue('noindex_key_pages').field, 'robots');
    assert.equal(getCapabilityForIssue('noindex_tags').field, 'robots');
    assert.equal(getCapabilityForIssue('sameas_array').field, 'same_as');
    assert.equal(getCapabilityForIssue('breadcrumblist_schema').field, 'breadcrumb_schema');
  });

  test('h1_missing maps to the content-channel h1 capability; multiple_h1_tags deliberately does not', () => {
    const { field, capability } = getCapabilityForIssue('h1_missing');
    assert.equal(field, 'h1');
    assert.deepEqual(
      { channel: capability.channel, provider: capability.provider, scope: capability.scope, operation: capability.operation },
      { channel: 'content', provider: 'wordpress_content', scope: 'post', operation: 'set_h1' }
    );
    assert.equal(getCapabilityForIssue('multiple_h1_tags'), null);
  });

  test('h1 normalizeRecommendation strips a wrapping <h1> and refuses unsafe markup', () => {
    const { normalizeRecommendation } = CAPABILITY_REGISTRY.h1;
    assert.equal(normalizeRecommendation(['<h1>', '  SEO Reseller Services by Naxonify', '</h1>'].join('\n')), 'SEO Reseller Services by Naxonify');
    assert.equal(normalizeRecommendation('<h1><script>x()</script>Title</h1>'), null);
  });

  test('returns null for a completely unknown issue code — never guesses', () => {
    assert.equal(getCapabilityForIssue('some_unmapped_issue'), null);
  });
});
