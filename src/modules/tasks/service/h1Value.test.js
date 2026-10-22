import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeH1Value, extractH1TextValue, H1_ERRORS, H1_LIMITS } from './h1Value.js';
import taskHistoryService from './TaskHistoryService.js';
import taskVerificationService from './TaskVerificationService.js';

/**
 * The recommendation for h1_missing is model-generated and frequently arrives as markup. What
 * reaches WordPress — and what the task is later verified against — is plain text only.
 */
describe('normalizeH1Value — accepted', () => {
  test('the real recommendation from the naxonify.com task: a wrapped, indented <h1> becomes plain text', () => {
    const raw = '<h1>\n  SEO Reseller Services by Naxonify\n</h1>';
    assert.deepEqual(normalizeH1Value(raw), { ok: true, text: 'SEO Reseller Services by Naxonify' });
  });

  test('plain text is kept; whitespace is collapsed; entities are decoded to text', () => {
    assert.equal(normalizeH1Value('  White   Label &amp; SEO   ').text, 'White Label & SEO');
    assert.equal(normalizeH1Value('It&#39;s here').text, "It's here");
  });

  test('a wrapper with different casing/spacing is still just a wrapper', () => {
    assert.equal(normalizeH1Value('< H1 >Title</ H1 >').text, 'Title');
  });
});

describe('normalizeH1Value — refused (never "cleaned up")', () => {
  const cases = [
    ['a non-string', 42, H1_ERRORS.NOT_A_STRING],
    ['an empty value', '   ', H1_ERRORS.EMPTY],
    ['an empty wrapper', '<h1>  </h1>', H1_ERRORS.EMPTY],
    ['two H1s', '<h1>A</h1><h1>B</h1>', H1_ERRORS.MULTIPLE_H1],
    ['an H1 with attributes', '<h1 class="x">A</h1>', H1_ERRORS.ATTRIBUTES],
    ['an unclosed H1', '<h1>A', H1_ERRORS.MALFORMED],
    ['text before the wrapper', 'Intro <h1>A</h1>', H1_ERRORS.MALFORMED],
    ['a script', '<h1><script>alert(1)</script>A</h1>', H1_ERRORS.SCRIPT],
    ['an iframe', '<h1>A<iframe src="//x"></iframe></h1>', H1_ERRORS.IFRAME],
    ['an event handler', '<h1><b onclick="x()">A</b></h1>', H1_ERRORS.EVENT_HANDLER],
    ['nested markup', '<h1><strong>Bold</strong> title</h1>', H1_ERRORS.HTML_NOT_ALLOWED],
    ['an entity-encoded tag', '&lt;script&gt;alert(1)&lt;/script&gt;', H1_ERRORS.HTML_NOT_ALLOWED],
    ['control characters', 'A\u0007B', H1_ERRORS.CONTROL_CHARACTERS],
    ['square brackets (would break a Divi attribute)', 'Best [SEO] agency', H1_ERRORS.SHORTCODE_CHARACTERS],
    ['an over-long value', 'x'.repeat(H1_LIMITS.maxLength + 1), H1_ERRORS.TOO_LONG],
  ];
  for (const [label, input, code] of cases) {
    test(`refuses ${label}`, () => {
      const result = normalizeH1Value(input);
      assert.equal(result.ok, false);
      assert.equal(result.code, code);
      assert.ok(result.message);
    });
  }

  test('a value exactly at the length limit is accepted', () => {
    assert.equal(normalizeH1Value('x'.repeat(H1_LIMITS.maxLength)).ok, true);
  });

  test('extractH1TextValue returns null for anything refused', () => {
    assert.equal(extractH1TextValue('<h1 onclick="x">A</h1>'), null);
    assert.equal(extractH1TextValue('<h1>Fine</h1>'), 'Fine');
  });
});

describe('expected-after value recorded for the task', () => {
  const rec = (optimized) => ({ sections: { contentRewrite: { optimized } } });

  test('h1_missing freezes PLAIN TEXT and exactly one H1', () => {
    const expected = taskHistoryService._deriveExpectedAfterValue(rec('<h1>SEO Reseller Services by Naxonify</h1>'), 'h1_missing');
    assert.deepEqual(expected, { type: 'h1', h1Text: 'SEO Reseller Services by Naxonify', h1Count: 1 });
  });

  test('multiple_h1_tags keeps the text but does not claim a count', () => {
    const expected = taskHistoryService._deriveExpectedAfterValue(rec('<h1>One heading</h1>'), 'multiple_h1_tags');
    assert.deepEqual(expected, { type: 'h1', h1Text: 'One heading' });
  });

  test('a value that is not a valid plain-text H1 is kept as-is for the manual flow, with no count (the WordPress write refuses it separately)', () => {
    const expected = taskHistoryService._deriveExpectedAfterValue(rec('<h1><script>x()</script>A</h1>'), 'h1_missing');
    assert.equal(expected.h1Count, undefined);
    assert.equal(typeof expected.h1Text, 'string');
  });
});

describe('TaskVerificationService — h1 match requires the right count when one is recorded', () => {
  const match = (expected, actual) => taskVerificationService._valuesMatch({ type: 'h1', ...expected }, { type: 'h1', ...actual });

  test('exactly one H1 with the expected text matches', () => {
    assert.equal(match({ h1Text: 'SEO Reseller Services by Naxonify', h1Count: 1 }, { h1Text: ['SEO Reseller Services by Naxonify'] }), true);
  });

  test('the right text alongside a second H1 does NOT match when h1Count: 1 is expected', () => {
    assert.equal(match({ h1Text: 'A', h1Count: 1 }, { h1Text: ['A', 'B'] }), false);
  });

  test('no H1 on the page does not match', () => {
    assert.equal(match({ h1Text: 'A', h1Count: 1 }, { h1Text: [] }), false);
  });

  test('a different H1 does not match', () => {
    assert.equal(match({ h1Text: 'A', h1Count: 1 }, { h1Text: ['B'] }), false);
  });

  test('without h1Count (older tasks / multiple_h1_tags) the text-only behaviour is unchanged', () => {
    assert.equal(match({ h1Text: 'A' }, { h1Text: ['A', 'B'] }), true);
  });
});
