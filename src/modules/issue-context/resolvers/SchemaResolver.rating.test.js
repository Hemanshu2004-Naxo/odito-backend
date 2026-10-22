import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import schemaResolver from './SchemaResolver.js';
import taskHistoryService from '../../tasks/service/TaskHistoryService.js';
import { RATING_UNAVAILABLE_MESSAGE, parseAggregateRatingJsonLd } from '../../tasks/service/aggregateRatingSchema.js';
import {
  assertRatingDetectionUsable,
  buildRatingSchemaSections,
  ratingSchemaFingerprint,
  generatedFromDetection,
  RatingRecommendationError,
} from '../../recommendations/service/ratingSchemaRecommendation.js';

const SERVICE = { '@type': 'Service', '@id': 'https://example.com/seo/#service', name: 'SEO Service' };
const ORG = { '@type': 'Organization', '@id': 'https://example.com/#organization', name: 'Example Co' };
const CANDIDATE = { ratingValue: 4.8, bestRating: 5, reviewCount: 127, worstRating: null, source: 'text', evidence: 'Rated 4.8/5 based on 127 reviews' };

const resolve = (pageData) =>
  schemaResolver.resolve('aggregate_rating_schema', 'absent', { pageData }, null).contextExtras.ratingDetection;

const pageData = (over = {}) => ({
  structured_data: [ORG, SERVICE],
  rating_signals: { rating_extracted: true, rating_candidates: [CANDIDATE] },
  ...over,
});

describe('SchemaResolver aggregate_rating_schema — structured detection payload', () => {
  test('returns detectedRatingData, existingSchemas, targetSchemaType, missingSchemaFields, generatedSchema (and keeps the absent currentState)', () => {
    const result = schemaResolver.resolve('aggregate_rating_schema', 'absent', { pageData: pageData() }, null);
    assert.equal(result.currentState.isAbsent, true);
    const d = result.contextExtras.ratingDetection;
    assert.equal(d.detectedRatingData.selected.ratingValue, 4.8);
    assert.deepEqual(d.existingSchemas.map((s) => s.types[0]), ['Organization', 'Service']);
    assert.equal(d.targetSchemaType, 'Service');
    assert.deepEqual(d.missingSchemaFields, ['aggregateRating']);
    assert.equal(JSON.parse(d.generatedSchema.jsonLd).aggregateRating.ratingValue, '4.8');
  });

  test('other schema issues are untouched', () => {
    assert.equal(schemaResolver.resolve('article_schema', 'code', { pageData: { structured_data: [] } }, null).contextExtras, undefined);
  });
});

describe('aggregate_rating_schema recommendation — deterministic, only from verified data', () => {
  test('sections carry exactly the generated node; no LLM; figures/entity interpolated verbatim', () => {
    const d = resolve(pageData());
    assertRatingDetectionUsable(d);
    const s = buildRatingSchemaSections(d);
    assert.equal(s.recommendedVersion, d.generatedSchema.jsonLd);
    assert.match(s.recommendedFix, /4\.8 out of 5 from 127 reviews/);
    assert.match(s.recommendedFix, /Service "SEO Service"/);
    assert.equal(s.sourceAttribution.contextSources.llmUsed, false);
    assert.ok(s.implementationExample.content.startsWith('<script type="application/ld+json">'));
  });

  test('an Organization target adds an honest self-serving-review note', () => {
    const d = resolve(pageData({ structured_data: [ORG] }));
    assert.deepEqual(d.warnings, ['self_serving_target']);
    assert.ok(buildRatingSchemaSections(d).expectedImpact.some((t) => /Google's guidelines/.test(t)));
    assert.equal(buildRatingSchemaSections(resolve(pageData())).expectedImpact.some((t) => /Google's guidelines/.test(t)), false);
  });

  test('refusals: unavailable data / ambiguous / no target / already present — right code, nothing built', () => {
    const cases = [
      [pageData({ rating_signals: { rating_extracted: true, rating_candidates: [] } }), 'RATING_DATA_UNAVAILABLE', 422, RATING_UNAVAILABLE_MESSAGE],
      [pageData({ rating_signals: { rating_extracted: true, rating_candidates: [CANDIDATE, { ...CANDIDATE, ratingValue: 3.1 }] } }), 'RATING_DATA_AMBIGUOUS', 422],
      [pageData({ structured_data: [{ '@type': 'WebPage' }] }), 'RATING_TARGET_UNAVAILABLE', 422],
      [pageData({ structured_data: [{ ...SERVICE, aggregateRating: { '@type': 'AggregateRating', ratingValue: '4', reviewCount: '3' } }] }), 'AGGREGATE_RATING_ALREADY_PRESENT', 409],
    ];
    for (const [data, code, status, message] of cases) {
      assert.throws(
        () => assertRatingDetectionUsable(resolve(data)),
        (e) => e instanceof RatingRecommendationError && e.userFacing === true && e.code === code && e.statusCode === status && (!message || e.message === message),
        code
      );
    }
    assert.throws(() => assertRatingDetectionUsable(null), (e) => e.code === 'RATING_DATA_UNAVAILABLE');
  });

  test('fingerprint follows the rating and the target', () => {
    const g = generatedFromDetection(resolve(pageData()));
    const a = ratingSchemaFingerprint('p', 'https://x/', g);
    assert.equal(a, ratingSchemaFingerprint('p', 'https://x/', generatedFromDetection(resolve(pageData()))));
    const changed = generatedFromDetection(resolve(pageData({ rating_signals: { rating_extracted: true, rating_candidates: [{ ...CANDIDATE, reviewCount: 500 }] } })));
    assert.notEqual(a, ratingSchemaFingerprint('p', 'https://x/', changed));
  });

  test('round-trips into the expectedAfterValue the write and the verifier both use', () => {
    const s = buildRatingSchemaSections(resolve(pageData()));
    const expected = taskHistoryService._deriveExpectedAfterValue({ sections: s }, 'aggregate_rating_schema');
    assert.equal(expected.type, 'aggregate_rating');
    assert.equal(expected.target.id, SERVICE['@id']);
    assert.deepEqual(expected.rating, { ratingValue: 4.8, bestRating: 5, reviewCount: 127 });
    assert.deepEqual(parseAggregateRatingJsonLd(s.recommendedVersion).rating, expected.rating);
  });

  test('a recommendation that is not a well-formed rating node derives no expected value (write refused)', () => {
    assert.equal(taskHistoryService._deriveExpectedAfterValue({ sections: { recommendedVersion: 'Add AggregateRating schema.' } }, 'aggregate_rating_schema'), null);
  });
});
