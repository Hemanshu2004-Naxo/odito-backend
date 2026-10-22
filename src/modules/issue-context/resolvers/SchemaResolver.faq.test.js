import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import schemaResolver from './SchemaResolver.js';
import taskHistoryService from '../../tasks/service/TaskHistoryService.js';
import { FAQ_EXTRACTION_FAILED_MESSAGE, serializeFaqPageJsonLd } from '../../tasks/service/faqSchema.js';
import { assertFaqDetectionUsable, buildFaqSchemaSections, FaqRecommendationError, faqSchemaFingerprint } from '../../recommendations/service/faqSchemaRecommendation.js';

const PAIRS = [
  { question: 'What is SEO?', answer: 'SEO is the practice of improving search visibility.' },
  { question: 'How long does it take?', answer: 'Usually three to six months.' },
];

const issueDoc = { issue_code: 'faq_schema', context: { faq_pair_count: 2 } };

function resolveFaq(pageData) {
  return schemaResolver.resolve('faq_schema', 'code', { pageData, issuesByCode: { faq_schema: issueDoc } }, issueDoc);
}

describe('SchemaResolver faq_schema — detected FAQ content is surfaced next to the missing schema', () => {
  test('returns faqDetection with FAQ content DETECTED (with the pairs) and FAQPage schema NOT detected', () => {
    const result = resolveFaq({ faq_howto_signals: { faq_pairs_extracted: true, faq_pairs: PAIRS }, structured_data: [] });

    assert.equal(result.currentState.isAbsent, true);              // existing contract preserved
    const { faqDetection } = result.contextExtras;
    assert.equal(faqDetection.content.detected, true);
    assert.equal(faqDetection.content.status, 'extracted');
    assert.deepEqual(faqDetection.content.pairs, PAIRS);
    assert.equal(faqDetection.schema.detected, false);
    assert.equal(faqDetection.canGenerate, true);
    assert.ok(faqDetection.schemaPreview.jsonLd.includes('"@type": "FAQPage"'));
  });

  test('FAQ content detected but pairs not extractable -> the exact failure message, no preview, cannot generate', () => {
    const { faqDetection } = resolveFaq({ faq_howto_signals: { faq_pairs_extracted: true, faq_pairs: [], faq_section_count: 1 }, structured_data: [] }).contextExtras;
    assert.equal(faqDetection.content.detected, true);
    assert.equal(faqDetection.content.message, FAQ_EXTRACTION_FAILED_MESSAGE);
    assert.equal(faqDetection.schemaPreview, null);
    assert.equal(faqDetection.canGenerate, false);
  });

  test('other schema issues are untouched — no contextExtras', () => {
    const result = schemaResolver.resolve('article_schema', 'code', { pageData: { structured_data: [] } }, null);
    assert.equal(result.contextExtras, undefined);
  });

  test('faq_schema_matches_content (AI visibility) is untouched — no contextExtras', () => {
    const result = schemaResolver.resolve('faq_schema_matches_content', 'table', { pageData: { structured_data: [] }, visibilityData: {} }, null);
    assert.equal(result.contextExtras, undefined);
  });
});

describe('faq_schema recommendation — deterministic, only from detected pairs', () => {
  const detection = (overrides = {}) => resolveFaq({
    faq_howto_signals: { faq_pairs_extracted: true, faq_pairs: PAIRS }, structured_data: [], ...overrides,
  }).contextExtras.faqDetection;

  test('sections carry the exact JSON-LD built from the detected pairs — no LLM, no extra text', () => {
    const sections = buildFaqSchemaSections(detection());
    assert.equal(sections.recommendedVersion, serializeFaqPageJsonLd(PAIRS));
    assert.equal(JSON.parse(sections.recommendedVersion).mainEntity.length, 2);
    assert.equal(sections.sourceAttribution.contextSources.llmUsed, false);
    assert.equal(sections.implementationExample.type, 'html');
    assert.ok(sections.implementationExample.content.startsWith('<script type="application/ld+json">'));
  });

  test('extraction failure -> FaqRecommendationError with the exact message; nothing is built', () => {
    const failed = detection({ faq_howto_signals: { faq_pairs_extracted: true, faq_pairs: [], faq_section_count: 1 } });
    assert.throws(() => assertFaqDetectionUsable(failed), (e) => e instanceof FaqRecommendationError && e.code === 'FAQ_EXTRACTION_UNAVAILABLE' && e.message === FAQ_EXTRACTION_FAILED_MESSAGE && e.userFacing === true);
  });

  test('the fingerprint changes when the FAQ content changes, so a re-crawl never serves a stale schema', () => {
    const a = faqSchemaFingerprint('p1', 'https://x.com/', PAIRS);
    assert.equal(a, faqSchemaFingerprint('p1', 'https://x.com/', PAIRS.map((p) => ({ ...p }))));
    assert.notEqual(a, faqSchemaFingerprint('p1', 'https://x.com/', [PAIRS[0]]));
    assert.notEqual(a, faqSchemaFingerprint('p1', 'https://x.com/other', PAIRS));
  });

  test('the recommendation round-trips into the expectedAfterValue the WordPress write and the verifier both use', () => {
    const sections = buildFaqSchemaSections(detection());
    const expected = taskHistoryService._deriveExpectedAfterValue({ sections }, 'faq_schema');
    assert.deepEqual(expected, { type: 'faq_schema', pairs: PAIRS });
  });

  test('a recommendation that is not valid FAQPage JSON-LD derives no expected value (write is refused)', () => {
    const expected = taskHistoryService._deriveExpectedAfterValue({ sections: { recommendedVersion: 'Add FAQ schema markup.' } }, 'faq_schema');
    assert.equal(expected, null);
  });
});
