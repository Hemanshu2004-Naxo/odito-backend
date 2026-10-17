import test from 'node:test';
import assert from 'node:assert/strict';
import { ImageResolver } from './ImageResolver.js';

const PAGE = 'https://www.sapphiredigitalagency.com/';
const LOGO = 'https://sapphiredigitalagency.com/wp-content/uploads/2025/12/sapphire-digital-Agency-1.webp';
const resolve = (images) => new ImageResolver().resolve('images_missing_alt_text', 'table', { pageData: { url: PAGE, images }, issuesByCode: {} }, null);

test('the real #130 shape: header use empty, footer use with alt — ONE row, and it says the other use has alt text', () => {
  const r = resolve([{ src: LOGO, alt: '' }, { src: LOGO, alt: 'Sapphire Digital Agency' }]);
  assert.equal(r.currentState.affectedItems.length, 1);
  assert.equal(r.currentState.affectedItems[0].Status, 'Missing on 1 of 2 uses of this image (another use has alt text)');
  assert.equal(r.contextExtras.altFindingScope.actionable, 1);
});

test('every use empty: one row, "all uses"; a single use: plain Missing', () => {
  assert.equal(resolve([{ src: LOGO, alt: '' }, { src: LOGO, alt: '' }]).currentState.affectedItems[0].Status, 'Missing on all 2 uses of this image');
  assert.equal(resolve([{ src: LOGO, alt: '' }]).currentState.affectedItems[0].Status, 'Missing');
});

test('an image whose every use already has alt text is not listed at all', () => {
  const r = resolve([{ src: LOGO, alt: 'Sapphire Digital Agency' }, { src: LOGO, alt: 'Sapphire Digital Agency' }]);
  assert.deepEqual(r.currentState.affectedItems, []);
  assert.equal(r.currentState.isAbsent, true);
});

test('different image files stay separate rows', () => {
  const other = 'https://sapphiredigitalagency.com/wp-content/uploads/2025/12/other.webp';
  const r = resolve([{ src: LOGO, alt: '' }, { src: other, alt: '' }, { src: other, alt: '' }]);
  assert.deepEqual(r.currentState.affectedItems.map((x) => [x.Image.split('/').pop(), x.Status]), [['sapphire-digital-Agency-1.webp', 'Missing'], ['other.webp', 'Missing on all 2 uses of this image']]);
});
