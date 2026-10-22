import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitizeRating,
  ratingsEqual,
  buildAggregateRatingNode,
  parseAggregateRatingJsonLd,
  extractAggregateRatings,
  crawledRatingMatches,
  ratingIsVisible,
  hashAggregateRating,
  pickTargetSchema,
  flattenSchemaNodes,
  getRatingDetection,
  RATING_UNAVAILABLE_MESSAGE,
} from './aggregateRatingSchema.js';

const RATING = { ratingValue: 4.8, bestRating: 5, reviewCount: 127 };
const CANDIDATE = { ...RATING, worstRating: null, source: 'text', evidence: 'Rated 4.8/5 based on 127 reviews' };
const ORG = { '@type': 'Organization', '@id': 'https://example.com/#organization', name: 'Example Co' };
const SERVICE = { '@type': 'Service', '@id': 'https://example.com/seo/#service', name: 'SEO Service' };

const page = (over = {}) => ({
  structured_data: [ORG, { '@type': 'WebPage', '@id': 'https://example.com/#webpage' }],
  rating_signals: { rating_extracted: true, rating_candidates: [CANDIDATE], rating_candidate_count: 1, microdata_aggregate_rating: null },
  ...over,
});

describe('sanitizeRating', () => {
  test('accepts a value inside its scale with a real count; strings from schema are read as numbers', () => {
    assert.deepEqual(sanitizeRating(RATING), RATING);
    assert.deepEqual(sanitizeRating({ ratingValue: '4.5', reviewCount: '33' }), { ratingValue: 4.5, bestRating: 5, reviewCount: 33 });
    assert.deepEqual(sanitizeRating({ ratingValue: 4, ratingCount: 9, bestRating: 10, worstRating: 1 }), { ratingValue: 4, bestRating: 10, worstRating: 1, ratingCount: 9 });
  });

  test('refuses anything unreliable: no count, out of range, non-numeric, zero/negative/fractional counts', () => {
    for (const bad of [
      { ratingValue: 4.8 },
      { ratingValue: 6, reviewCount: 10 },
      { ratingValue: 0, reviewCount: 10 },
      { ratingValue: 'great', reviewCount: 10 },
      { ratingValue: 4.8, reviewCount: 0 },
      { ratingValue: 4.8, reviewCount: 2.5 },
      { ratingValue: 4.8, reviewCount: '120+' },
      { ratingValue: 4.8, reviewCount: 10, bestRating: 'five' },
      { ratingValue: 1, reviewCount: 10, worstRating: 3 },
      null, 'x', [],
    ]) assert.equal(sanitizeRating(bad), null, JSON.stringify(bad));
  });
});

describe('ratingsEqual', () => {
  test('exact numeric equality of value, scale and counts', () => {
    assert.equal(ratingsEqual(RATING, { ratingValue: '4.8', reviewCount: '127' }), true);
    assert.equal(ratingsEqual(RATING, { ...RATING, ratingValue: 4.9 }), false);
    assert.equal(ratingsEqual(RATING, { ...RATING, reviewCount: 128 }), false);
    assert.equal(ratingsEqual(RATING, { ratingValue: 4.8, reviewCount: 127, bestRating: 10 }), false);
    assert.equal(ratingsEqual(RATING, { ratingValue: 4.8, ratingCount: 127 }), false);
  });
});

describe('buildAggregateRatingNode / parseAggregateRatingJsonLd', () => {
  const target = { type: 'Service', id: SERVICE['@id'], name: SERVICE.name };

  test('produces the Schema.org shape, copying the existing entity verbatim and stringifying the figures', () => {
    assert.deepEqual(buildAggregateRatingNode({ target, rating: RATING }), {
      '@context': 'https://schema.org',
      '@type': 'Service',
      '@id': 'https://example.com/seo/#service',
      name: 'SEO Service',
      aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.8', reviewCount: '127', bestRating: '5' },
    });
  });

  test('a multi-typed entity keeps all of its types', () => {
    const node = buildAggregateRatingNode({ target: { ...target, type: ['LocalBusiness', 'ProfessionalService'] }, rating: RATING });
    assert.deepEqual(node['@type'], ['LocalBusiness', 'ProfessionalService']);
  });

  test('refuses to build without a mergeable target or a valid rating', () => {
    assert.equal(buildAggregateRatingNode({ target: { ...target, id: '#service' }, rating: RATING }), null);
    assert.equal(buildAggregateRatingNode({ target: { ...target, name: ' ' }, rating: RATING }), null);
    assert.equal(buildAggregateRatingNode({ target: null, rating: RATING }), null);
    assert.equal(buildAggregateRatingNode({ target, rating: { ratingValue: 4.8 } }), null);
  });

  test('round trip and strict parsing', () => {
    const node = buildAggregateRatingNode({ target, rating: RATING });
    assert.deepEqual(parseAggregateRatingJsonLd(JSON.stringify(node)), { target, rating: RATING });
    assert.equal(parseAggregateRatingJsonLd('Add AggregateRating schema.'), null);
    assert.equal(parseAggregateRatingJsonLd({ ...node, aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.8' } }), null);
    assert.equal(parseAggregateRatingJsonLd({ ...node, '@id': undefined }), null);
    assert.equal(parseAggregateRatingJsonLd({ ...node, aggregateRating: undefined }), null);
  });
});

describe('reading ratings out of crawled schema', () => {
  test('finds aggregateRating on any node (incl. @graph) and standalone AggregateRating nodes', () => {
    const data = [
      { '@graph': [{ '@type': 'WebPage' }, { ...SERVICE, aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.8', reviewCount: '127' } }] },
      { '@type': 'AggregateRating', ratingValue: 3, ratingCount: 4 },
    ];
    const items = extractAggregateRatings(data);
    assert.equal(items.length, 2);
    assert.equal(items[0].nodeId, SERVICE['@id']);
    assert.equal(items[1].standalone, true);
    assert.equal(flattenSchemaNodes(data).length, 3);
  });

  test('crawledRatingMatches: needs a VALID rating equal to the expected one, on the SAME @id', () => {
    const expected = { target: { id: SERVICE['@id'] }, rating: RATING };
    const withRating = (ar, id = SERVICE['@id']) => [{ ...SERVICE, '@id': id, aggregateRating: ar }];
    assert.equal(crawledRatingMatches(expected, withRating({ '@type': 'AggregateRating', ratingValue: '4.8', reviewCount: '127', bestRating: '5' })), true);
    assert.equal(crawledRatingMatches(expected, withRating({ '@type': 'AggregateRating', ratingValue: '4.7', reviewCount: '127' })), false);
    assert.equal(crawledRatingMatches(expected, withRating({ '@type': 'AggregateRating', ratingValue: '4.8' })), false, 'invalid (no count)');
    assert.equal(crawledRatingMatches(expected, withRating({ '@type': 'AggregateRating', ratingValue: '4.8', reviewCount: '127' }, 'https://example.com/other')), false, 'different entity');
    assert.equal(crawledRatingMatches(expected, []), false);
  });

  test('ratingIsVisible compares against the crawler candidates', () => {
    assert.equal(ratingIsVisible(RATING, [CANDIDATE]), true);
    assert.equal(ratingIsVisible({ ...RATING, reviewCount: 500 }, [CANDIDATE]), false);
    assert.equal(ratingIsVisible(RATING, undefined), false);
  });

  test('hashAggregateRating changes with the rating or the target', () => {
    const t = { id: 'https://e.com/#s', type: 'Service', name: 'S' };
    assert.equal(hashAggregateRating({ target: t, rating: RATING }), hashAggregateRating({ target: { ...t }, rating: { ...RATING } }));
    assert.notEqual(hashAggregateRating({ target: t, rating: RATING }), hashAggregateRating({ target: t, rating: { ...RATING, reviewCount: 1 } }));
    assert.notEqual(hashAggregateRating({ target: t, rating: RATING }), hashAggregateRating({ target: { ...t, id: 'https://e.com/#o' }, rating: RATING }));
  });
});

describe('pickTargetSchema', () => {
  test('prefers Product/Service over LocalBusiness over Organization, regardless of order on the page', () => {
    const nodes = [ORG, { '@type': 'LocalBusiness', '@id': 'https://example.com/#lb', name: 'LB' }, SERVICE];
    assert.equal(pickTargetSchema(nodes).target.id, SERVICE['@id']);
    assert.equal(pickTargetSchema([ORG, { '@type': 'Product', '@id': 'https://example.com/#p', name: 'P' }, SERVICE]).kind, 'product');
    assert.equal(pickTargetSchema([{ '@type': 'LocalBusiness', '@id': 'https://example.com/#lb', name: 'LB' }, ORG]).kind, 'local_business');
  });

  test('skips an eligible node that cannot be merged (no absolute @id / no name) and takes the next usable one', () => {
    const noId = { '@type': 'Service', name: 'No id' };
    assert.equal(pickTargetSchema([noId, ORG]).target.id, ORG['@id']);
    assert.equal(pickTargetSchema([noId]).status, 'target_not_mergeable');
    assert.equal(pickTargetSchema([{ '@type': 'Service', '@id': '#svc', name: 'Relative id' }]).status, 'target_not_mergeable');
  });

  test('no eligible entity at all', () => {
    assert.equal(pickTargetSchema([{ '@type': 'WebPage' }, { '@type': 'BreadcrumbList' }]).status, 'no_target_schema');
    assert.equal(pickTargetSchema([]).status, 'no_target_schema');
  });
});

describe('getRatingDetection', () => {
  test('ready: exposes every field of the API contract and a generated schema built only from page data', () => {
    const d = getRatingDetection({ pageData: page({ structured_data: [ORG, SERVICE] }) });
    assert.equal(d.status, 'ready');
    assert.equal(d.canGenerate, true);
    assert.deepEqual(d.detectedRatingData.selected, { ...RATING, source: 'text', evidence: 'Rated 4.8/5 based on 127 reviews' });
    assert.equal(d.detectedRatingData.status, 'extracted');
    assert.equal(d.existingSchemas.length, 2);
    assert.equal(d.existingAggregateRating.present, false);
    assert.equal(d.targetSchemaType, 'Service');
    assert.equal(d.target.id, SERVICE['@id']);
    assert.deepEqual(d.missingSchemaFields, ['aggregateRating']);
    const node = JSON.parse(d.generatedSchema.jsonLd);
    assert.equal(node.name, 'SEO Service');
    assert.equal(node.aggregateRating.ratingValue, '4.8');
    assert.equal(d.generatedSchema.mergeMode, 'same_id_node');
    assert.deepEqual(d.warnings, []);
  });

  test('an Organization/LocalBusiness target carries the self-serving-review warning', () => {
    assert.deepEqual(getRatingDetection({ pageData: page() }).warnings, ['self_serving_target']);
  });

  test('no rating extracted -> unavailable, exact message, NO schema (even though a target exists)', () => {
    const d = getRatingDetection({ pageData: page({ rating_signals: { rating_extracted: true, rating_candidates: [] } }) });
    assert.equal(d.status, 'rating_unavailable');
    assert.equal(d.message, RATING_UNAVAILABLE_MESSAGE);
    assert.equal(d.reason, 'no_reliable_rating');
    assert.equal(d.generatedSchema, null);
    assert.equal(d.canGenerate, false);
    assert.ok(d.missingSchemaFields.includes('ratingValue') && d.missingSchemaFields.includes('reviewCount'));
  });

  test('a crawl that predates rating extraction is flagged so the UI can suggest a re-crawl', () => {
    const d = getRatingDetection({ pageData: { structured_data: [ORG] } });
    assert.equal(d.status, 'rating_unavailable');
    assert.equal(d.reason, 'crawl_predates_extraction');
  });

  test('two different ratings on the page -> ambiguous, nothing generated', () => {
    const other = { ...CANDIDATE, ratingValue: 4.1, reviewCount: 30 };
    const d = getRatingDetection({ pageData: page({ rating_signals: { rating_extracted: true, rating_candidates: [CANDIDATE, other] } }) });
    assert.equal(d.status, 'rating_ambiguous');
    assert.equal(d.generatedSchema, null);
  });

  test('a candidate the backend cannot validate is dropped rather than repaired', () => {
    const d = getRatingDetection({ pageData: page({ rating_signals: { rating_extracted: true, rating_candidates: [{ ...CANDIDATE, ratingValue: 9, bestRating: 5 }] } }) });
    assert.equal(d.status, 'rating_unavailable');
  });

  test('rating is fine but there is nothing to attach it to -> no_target_schema, no schema', () => {
    const d = getRatingDetection({ pageData: page({ structured_data: [{ '@type': 'WebPage' }] }) });
    assert.equal(d.status, 'no_target_schema');
    assert.equal(d.generatedSchema, null);
    assert.ok(d.missingSchemaFields.includes('targetSchema'));
  });

  test('target without an absolute @id -> target_not_mergeable', () => {
    const d = getRatingDetection({ pageData: page({ structured_data: [{ '@type': 'Service', name: 'No id' }] }) });
    assert.equal(d.status, 'target_not_mergeable');
    assert.equal(d.generatedSchema, null);
  });

  test('an existing AggregateRating (JSON-LD or microdata) is reported and blocks generation — never a duplicate', () => {
    const ld = getRatingDetection({ pageData: page({ structured_data: [{ ...SERVICE, aggregateRating: { '@type': 'AggregateRating', ratingValue: '4', reviewCount: '9' } }] }) });
    assert.equal(ld.status, 'already_present');
    assert.equal(ld.existingAggregateRating.source, 'json-ld');
    assert.equal(ld.existingAggregateRating.valid, true);
    assert.equal(ld.generatedSchema, null);

    const micro = getRatingDetection({ pageData: page({ rating_signals: { rating_extracted: true, rating_candidates: [CANDIDATE], microdata_aggregate_rating: { ratingValue: '4.5', reviewCount: '33', bestRating: '5' } } }) });
    assert.equal(micro.status, 'already_present');
    assert.equal(micro.existingAggregateRating.source, 'microdata');
  });

  test('a rating counted as "ratingCount" is carried through as ratingCount, not renamed to reviewCount', () => {
    const c = { ratingValue: 4.7, bestRating: 5, ratingCount: 310, source: 'text', evidence: '4.7 stars · 310 ratings' };
    const d = getRatingDetection({ pageData: page({ structured_data: [SERVICE], rating_signals: { rating_extracted: true, rating_candidates: [c] } }) });
    const ar = JSON.parse(d.generatedSchema.jsonLd).aggregateRating;
    assert.equal(ar.ratingCount, '310');
    assert.equal(ar.reviewCount, undefined);
  });

  test('empty input never throws', () => {
    assert.equal(getRatingDetection().status, 'rating_unavailable');
  });
});
