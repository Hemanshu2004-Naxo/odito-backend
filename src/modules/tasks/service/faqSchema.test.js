import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FAQ_EXTRACTION_FAILED_MESSAGE,
  sanitizeFaqPairs,
  htmlToPlainText,
  findFaqPageSchemas,
  extractFaqPairsFromStructuredData,
  buildFaqPageJsonLd,
  serializeFaqPageJsonLd,
  parseFaqPageJsonLd,
  faqPairsMatch,
  faqPairsAreSubset,
  hashFaqPairs,
  getFaqDetection,
} from './faqSchema.js';

const PAIRS = [
  { question: 'What is SEO?', answer: 'SEO is the practice of improving search visibility.' },
  { question: 'How long does it take?', answer: 'Usually three to six months.' },
];

describe('buildFaqPageJsonLd', () => {
  test('produces exactly the Schema.org FAQPage shape, from the given pairs only', () => {
    assert.deepEqual(buildFaqPageJsonLd(PAIRS), {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: [
        { '@type': 'Question', name: 'What is SEO?', acceptedAnswer: { '@type': 'Answer', text: 'SEO is the practice of improving search visibility.' } },
        { '@type': 'Question', name: 'How long does it take?', acceptedAnswer: { '@type': 'Answer', text: 'Usually three to six months.' } },
      ],
    });
  });

  test('never invents entries: no pairs -> no JSON-LD string at all', () => {
    assert.equal(serializeFaqPageJsonLd([]), null);
    assert.equal(serializeFaqPageJsonLd([{ question: 'Q?', answer: '' }]), null);
    assert.equal(buildFaqPageJsonLd([]).mainEntity.length, 0);
  });

  test('quotes, backslashes, unicode and angle brackets survive a JSON round trip unchanged', () => {
    const tricky = [{ question: 'Why "quotes" & <b>tags</b>?', answer: 'Path C:\\dir — “smart” quotes ✓ and </script> text.' }];
    const json = serializeFaqPageJsonLd(tricky);
    assert.deepEqual(parseFaqPageJsonLd(json), tricky);
  });
});

describe('sanitizeFaqPairs', () => {
  test('collapses whitespace but does not reword or strip visible tag-like text', () => {
    const [pair] = sanitizeFaqPairs([{ question: '  What   does <br> do?\n', answer: 'It   breaks\tlines.' }]);
    assert.equal(pair.question, 'What does <br> do?');
    assert.equal(pair.answer, 'It breaks lines.');
  });

  test('drops empty / duplicate / oversized entries instead of repairing them', () => {
    const result = sanitizeFaqPairs([
      { question: 'A?', answer: 'one' },
      { question: 'a?', answer: 'duplicate question' },
      { question: 'B?', answer: '' },
      { question: '', answer: 'no question' },
      { question: 'C?'.padEnd(600, 'x'), answer: 'too long question' },
      { question: 'D?', answer: 'x'.repeat(10001) },
      null,
    ]);
    assert.deepEqual(result, [{ question: 'A?', answer: 'one' }]);
  });

  test('caps at 50 pairs', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ question: `Q${i}?`, answer: `A${i}` }));
    assert.equal(sanitizeFaqPairs(many).length, 50);
  });

  test('non-array input is an empty list', () => {
    assert.deepEqual(sanitizeFaqPairs(undefined), []);
    assert.deepEqual(sanitizeFaqPairs('nope'), []);
  });
});

describe('htmlToPlainText', () => {
  test('strips markup and decodes entities for externally-authored schema text', () => {
    assert.equal(htmlToPlainText('<p>Fish &amp; chips</p><ul><li>Salt</li><li>Vinegar</li></ul>'), 'Fish & chips Salt Vinegar');
    assert.equal(htmlToPlainText('Don&#39;t &nbsp;stop<script>alert(1)</script>'), "Don't stop");
  });
});

describe('parseFaqPageJsonLd', () => {
  test('rejects anything that is not a well-formed FAQPage', () => {
    assert.equal(parseFaqPageJsonLd('not json'), null);
    assert.equal(parseFaqPageJsonLd({ '@type': 'Article' }), null);
    assert.equal(parseFaqPageJsonLd({ '@type': 'FAQPage', mainEntity: [] }), null);
    assert.equal(parseFaqPageJsonLd({ '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'Q?' }] }), null);
    assert.equal(parseFaqPageJsonLd({ '@type': 'FAQPage', mainEntity: [{ '@type': 'Thing', name: 'Q?', acceptedAnswer: { text: 'A' } }] }), null);
  });

  test('finds a FAQPage inside @graph', () => {
    const graph = { '@graph': [{ '@type': 'WebPage' }, buildFaqPageJsonLd(PAIRS)] };
    assert.deepEqual(parseFaqPageJsonLd(graph), PAIRS);
  });
});

describe('structured data helpers', () => {
  test('findFaqPageSchemas handles @graph, arrays and @type arrays', () => {
    const data = [
      { '@type': ['WebPage', 'FAQPage'], mainEntity: [] },
      { '@graph': [{ '@type': 'Organization' }, { '@type': 'FAQPage' }] },
    ];
    assert.equal(findFaqPageSchemas(data).length, 2);
    assert.equal(findFaqPageSchemas(undefined).length, 0);
  });

  test('extractFaqPairsFromStructuredData strips HTML from acceptedAnswer text', () => {
    const data = [{
      '@type': 'FAQPage',
      mainEntity: [{ '@type': 'Question', name: 'Q?', acceptedAnswer: { '@type': 'Answer', text: '<p>Answer <b>text</b></p>' } }],
    }];
    assert.deepEqual(extractFaqPairsFromStructuredData(data), [{ question: 'Q?', answer: 'Answer text' }]);
  });
});

describe('faqPairsMatch / faqPairsAreSubset', () => {
  test('order-insensitive and tolerant of typographic differences', () => {
    const reordered = [PAIRS[1], { question: PAIRS[0].question, answer: PAIRS[0].answer.replace('practice', 'practice') }];
    assert.equal(faqPairsMatch(PAIRS, reordered), true);
    assert.equal(faqPairsMatch([{ question: "What's up?", answer: 'Not much' }], [{ question: 'What’s up?', answer: 'Not much' }]), true);
  });

  test('a changed answer, a missing pair or an extra pair is a mismatch', () => {
    assert.equal(faqPairsMatch(PAIRS, [PAIRS[0], { ...PAIRS[1], answer: 'Different.' }]), false);
    assert.equal(faqPairsMatch(PAIRS, [PAIRS[0]]), false);
    assert.equal(faqPairsMatch(PAIRS, [...PAIRS, { question: 'Extra?', answer: 'Invented.' }]), false);
    assert.equal(faqPairsMatch([], []), false);
  });

  test('subset check requires question AND answer to be visible', () => {
    assert.equal(faqPairsAreSubset([PAIRS[0]], PAIRS), true);
    assert.equal(faqPairsAreSubset([{ question: PAIRS[0].question, answer: 'Made up.' }], PAIRS), false);
    assert.equal(faqPairsAreSubset([], PAIRS), false);
  });
});

describe('hashFaqPairs', () => {
  test('is stable for identical content and changes when content changes', () => {
    assert.equal(hashFaqPairs(PAIRS), hashFaqPairs(PAIRS.map((p) => ({ ...p }))));
    assert.notEqual(hashFaqPairs(PAIRS), hashFaqPairs([PAIRS[0]]));
  });
});

describe('getFaqDetection', () => {
  const issueDoc = { issue_code: 'faq_schema' };

  test('FAQ content detected + pairs extracted + no schema -> can generate, previews JSON-LD', () => {
    const d = getFaqDetection({
      issueDoc,
      pageData: { faq_howto_signals: { faq_pairs_extracted: true, faq_pairs: PAIRS, qa_pattern_count: 2 }, structured_data: [] },
    });
    assert.equal(d.content.detected, true);
    assert.equal(d.content.status, 'extracted');
    assert.equal(d.content.pairCount, 2);
    assert.equal(d.schema.detected, false);
    assert.equal(d.canGenerate, true);
    assert.deepEqual(parseFaqPageJsonLd(d.schemaPreview.jsonLd), PAIRS);
  });

  test('content detected but no pairs -> extraction_failed, fixed message, never any preview', () => {
    const d = getFaqDetection({
      issueDoc,
      pageData: { faq_howto_signals: { faq_pairs_extracted: true, faq_pairs: [], faq_section_count: 1 } },
    });
    assert.equal(d.content.status, 'extraction_failed');
    assert.equal(d.content.reason, 'no_reliable_pairs');
    assert.equal(d.content.message, FAQ_EXTRACTION_FAILED_MESSAGE);
    assert.equal(d.schemaPreview, null);
    assert.equal(d.canGenerate, false);
  });

  test('a crawl that predates pair extraction is flagged so the UI can suggest a re-crawl', () => {
    const d = getFaqDetection({ issueDoc, pageData: { faq_howto_signals: { faq_section_count: 1 } } });
    assert.equal(d.content.status, 'extraction_failed');
    assert.equal(d.content.reason, 'crawl_predates_extraction');
  });

  test('an existing FAQPage schema is reported and blocks generation', () => {
    const d = getFaqDetection({
      issueDoc,
      pageData: { faq_howto_signals: { faq_pairs_extracted: true, faq_pairs: PAIRS }, structured_data: [buildFaqPageJsonLd(PAIRS)] },
    });
    assert.equal(d.schema.detected, true);
    assert.equal(d.schema.pairCount, 2);
    assert.equal(d.canGenerate, false);
  });

  test('fewer pairs extracted than FAQ-style questions detected -> partial_extraction warning', () => {
    const d = getFaqDetection({
      issueDoc,
      pageData: { faq_howto_signals: { faq_pairs_extracted: true, faq_pairs: [PAIRS[0]], qa_pattern_count: 5 } },
    });
    assert.deepEqual(d.content.warnings, ['partial_extraction']);
  });

  test('no signals and no issue -> no_faq_content', () => {
    const d = getFaqDetection({ pageData: {} });
    assert.equal(d.content.status, 'no_faq_content');
    assert.equal(d.content.detected, false);
    assert.equal(d.canGenerate, false);
    assert.equal(getFaqDetection().content.status, 'no_faq_content');
  });
});
