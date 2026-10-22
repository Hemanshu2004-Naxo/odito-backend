import test from 'node:test';
import assert from 'node:assert/strict';
import { altImagesFromContext, normalizeImageAltProposals, MAX_ALT_IMAGES } from './imageAltProposals.js';

const FB = 'https://www.facebook.com/tr?id=1064713942451011&ev=PageView&noscript=1';
const A = 'https://site.example/wp-content/uploads/2025/12/david-peterson-120x120.webp';
const B = 'https://site.example/wp-content/uploads/2025/12/emily-tran-120x120.webp';
const rc = (srcs) => ({ currentState: { tableRows: srcs.map((s) => ({ Image: s, 'Current Alt': 'Missing', Status: 'Missing' })) } });

test('images asked about: exact URLs, no trackers, no repeats, capped', () => {
  assert.deepEqual(altImagesFromContext(rc([A, FB, B, A])), [A, B]);
  assert.deepEqual(altImagesFromContext({}), []);
  const many = Array.from({ length: 30 }, (_, i) => `https://site.example/wp-content/uploads/i${i}.jpg`);
  assert.equal(altImagesFromContext(rc(many)).length, MAX_ALT_IMAGES);
});

test('a proposal is kept only for an image that was actually listed, matched by EXACT url', () => {
  const out = normalizeImageAltProposals([
    { src: A, alt: 'David Peterson, client testimonial', basis: 'file name' },
    { src: A.replace('120x120', '300x300'), alt: 'a look-alike url', basis: '' },
    { src: 'https://other.example/x.jpg', alt: 'invented', basis: '' },
    { src: B, alt: 'Emily Tran, client testimonial', basis: 'file name' },
  ], [A, B]);
  assert.deepEqual(out.map((p) => p.src), [A, B]);
  assert.equal(out[0].alt, 'David Peterson, client testimonial');
});

test('a tracker can never be an entry, even if the model returns one for it', () => {
  assert.deepEqual(normalizeImageAltProposals([{ src: FB, alt: 'Facebook pixel' }], altImagesFromContext(rc([FB, A]))), []);
});

test('unpublishable or missing text keeps the entry with alt null (the person is asked instead)', () => {
  const out = normalizeImageAltProposals([
    { src: A, alt: 'photo', basis: '' },              // too generic
    { src: B, alt: null, basis: 'nothing to go on' }, // model declined
  ], [A, B]);
  assert.deepEqual(out.map((p) => p.alt), [null, null]);
  assert.match(out[0].rejected, /generic/i);
  assert.equal(out[1].rejected, null);
});

test('only the first entry for a url is kept; malformed input is ignored; basis is bounded', () => {
  const out = normalizeImageAltProposals([{ src: A, alt: 'First', basis: 'x'.repeat(500) }, { src: A, alt: 'Second' }, null, 'x', 5], [A]);
  assert.equal(out.length, 1);
  assert.equal(out[0].alt, 'First');
  assert.equal(out[0].basis.length, 200);
  assert.deepEqual(normalizeImageAltProposals('not an array', [A]), []);
});

test('no identity is ever taken from the model: ids and confidence in its output are dropped', () => {
  const [p] = normalizeImageAltProposals([{ src: A, alt: 'David Peterson', attachmentId: 99, findingId: 'f', confidence: 'high' }], [A]);
  assert.deepEqual(Object.keys(p).sort(), ['alt', 'basis', 'rejected', 'src']);
});
