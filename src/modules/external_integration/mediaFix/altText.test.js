import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyImage, suggestionsFromEvidence, validateProposedAlt } from './altText.js';
import { inspectContentEmbedding } from './contentEmbedding.js';
import { snapshot } from './__fixtures__/media.js';

describe('validateProposedAlt — only publishable text', () => {
  test('a plain description is accepted and whitespace is normalised, never truncated', () => {
    const r = validateProposedAlt('  Dr  Rao examining a patient\n with a slit lamp  ');
    assert.equal(r.ok, true);
    assert.equal(r.value, 'Dr Rao examining a patient with a slit lamp');
  });
  test('empty / whitespace-only / non-string is refused (an informative image needs text)', () => {
    for (const v of ['', '   ', null, undefined, 42]) assert.equal(validateProposedAlt(v).ok, false);
  });
  test('HTML, control characters, URLs and file names are refused', () => {
    assert.match(validateProposedAlt('A <b>doctor</b>').errors.join(), /no HTML/);
    assert.match(validateProposedAlt('dr-rao-768x512.jpg').errors.join(), /file name/);
    assert.match(validateProposedAlt('https://clinic.example/a.jpg').errors.join(), /URL|file name/);
    assert.equal(validateProposedAlt('bad\u0007text').ok, false);
  });
  test('generic words are refused', () => {
    for (const v of ['image', 'Photo', 'picture image', 'untitled']) assert.equal(validateProposedAlt(v).ok, false, v);
  });
  test('keyword stuffing is refused: one word repeated, or mostly repeats', () => {
    assert.equal(validateProposedAlt('cataract surgery cataract surgery cataract surgery cataract surgery').ok, false);
    assert.equal(validateProposedAlt('Cheap LASIK cheap LASIK deals cheap LASIK Mumbai').ok, false);
    assert.equal(validateProposedAlt('Surgeon explaining the cataract procedure to a patient').ok, true);
  });
  test('length: over 125 is a warning, over 250 is an error — and the text is never truncated for you', () => {
    const distinct = (n) => Array.from({ length: n }, (_, i) => `detail${i}x`).join(' ');
    const warn = validateProposedAlt(distinct(20));
    assert.ok(distinct(20).length > 125 && distinct(20).length < 250);
    assert.equal(warn.ok, true);
    assert.match(warn.warnings.join(), /characters/);
    assert.equal(warn.value, distinct(20), 'kept whole');
    const huge = validateProposedAlt(distinct(60));
    assert.equal(huge.ok, false);
    assert.match(huge.errors.join(), /limit is 250/);
  });
  test('"image of" is a warning, not an error', () => {
    const r = validateProposedAlt('Image of a surgeon in the operating room');
    assert.equal(r.ok, true);
    assert.match(r.warnings.join(), /redundant/);
  });
});

describe('suggestionsFromEvidence — text the site already published, labelled, never applied', () => {
  test('caption, link title and the library caption are offered with their source; duplicates and unpublishable text are dropped', () => {
    const s = suggestionsFromEvidence(
      snapshot({ figcaption: 'Dr Rao with a patient', linkTitle: 'Dr Rao with a patient', linkText: 'img.jpg' }),
      { caption: { rendered: '<p>Our team in the clinic</p>' } },
    );
    assert.deepEqual(s.map((x) => [x.source, x.text]), [['figcaption', 'Dr Rao with a patient'], ['media_caption', 'Our team in the clinic']]);
  });
  test('the file name and the media title are never suggested; no evidence -> no suggestions (never invented)', () => {
    assert.deepEqual(suggestionsFromEvidence(snapshot(), { title: { raw: 'dr-rao' }, caption: { rendered: '' } }), []);
  });
});

describe('classifyImage — decorative only on evidence, never because the alt is empty', () => {
  test('aria-hidden / presentation roles are decorative; a plain missing alt is informative; alt="" alone is AMBIGUOUS, not decorative', () => {
    assert.equal(classifyImage(snapshot({ altState: 'missing', ariaHidden: true })).decorative, true);
    assert.equal(classifyImage(snapshot({ altState: 'missing', role: 'presentation' })).decorative, true);
    const empty = classifyImage(snapshot({ altState: 'empty' }));
    assert.equal(empty.decorative, false, 'a builder prints alt="" when its field is blank: that is not an author choice');
    assert.equal(empty.kind, 'ambiguous');
    const plain = classifyImage(snapshot({ altState: 'missing' }));
    assert.equal(plain.decorative, false);
    assert.equal(plain.kind, 'informative');
  });
  test('alt="" inside a link that has its own name is correct; the only content of an UNNAMED link is never decorative', () => {
    assert.equal(classifyImage(snapshot({ altState: 'empty', inLink: true, linkText: 'Read the case study' })).decorative, true);
    assert.equal(classifyImage(snapshot({ altState: 'empty', inLink: true, linkLabel: 'Home' })).decorativeBasis, 'named_link');
    for (const over of [{ altState: 'empty' }, { ariaHidden: true }, { role: 'presentation' }]) {
      assert.equal(classifyImage(snapshot({ inLink: true, ...over })).decorative, false, JSON.stringify(over));
    }
  });
  test('a finding crawled before the difference was recorded is honestly unknown', () => {
    assert.equal(classifyImage(snapshot({ altState: undefined })).kind, 'unknown');
  });
});

describe('inspectContentEmbedding — does the page content carry the alt itself?', () => {
  const paths = new Set(['2024/10/dr-rao.jpg', '2024/10/dr-rao-768x512.jpg']);
  const run = (raw) => inspectContentEmbedding(raw, { attachmentId: 42, exactPaths: paths });

  test('an <img> in the content (by class or by file) means a library write would NOT reach the page', () => {
    assert.equal(run('<p><img class="aligncenter wp-image-42" src="https://c.example/wp-content/uploads/2024/10/dr-rao-768x512.jpg" alt=""></p>').status, 'embedded');
    const byFile = run('<img src="/wp-content/uploads/2024/10/dr-rao.jpg">');
    assert.equal(byFile.status, 'embedded');
    assert.equal(byFile.hasAltAttr, false);
  });
  test('Gutenberg image / gallery blocks naming the attachment are embedded', () => {
    assert.equal(run('<!-- wp:image {"id":42,"sizeSlug":"large"} -->\n<figure></figure>\n<!-- /wp:image -->').status, 'embedded');
    assert.equal(run('<!-- wp:gallery {"ids":[1,42]} --><figure></figure><!-- /wp:gallery -->').status, 'embedded');
    assert.equal(run('<!-- wp:image {"id":43} --><figure></figure><!-- /wp:image -->').status, 'not_in_content');
  });
  test('a page-builder shortcode that names the file (no <img>) is a builder reference: unknown effect, allowed with a warning', () => {
    assert.equal(run('[et_pb_image src="https://c.example/wp-content/uploads/2024/10/dr-rao.jpg"]').status, 'builder_reference');
  });
  test('content that does not mention the image means the theme renders it from the library', () => {
    assert.equal(run('<p>Hello</p><img class="wp-image-7" src="/wp-content/uploads/2024/10/other.jpg" alt="x">').status, 'not_in_content');
  });
  test('unreadable content is unknown', () => { assert.equal(run(null).status, 'unknown'); });
});
