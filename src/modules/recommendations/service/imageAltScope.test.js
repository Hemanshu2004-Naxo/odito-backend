import test from 'node:test';
import assert from 'node:assert/strict';
import { ImageAltRecommendationError, assertAltFindingActionable, isAltFindingNotApplicable } from './imageAltScope.js';
import { ImageResolver } from '../../issue-context/resolvers/ImageResolver.js';

const FB = 'https://www.facebook.com/tr?id=1064713942451011&ev=PageView&noscript=1';
const PAGE = 'https://www.sapphiredigitalagency.com/about-us';
const resolve = (pageImages, detected = null) => new ImageResolver().resolve('images_missing_alt_text', 'table', {
  pageData: { url: PAGE, images: pageImages }, issuesByCode: { images_missing_alt_text: detected ? { detected_value: detected } : undefined },
}, null);

test('resolver: a tracker is never listed, and the scope says the finding was only a tracker', () => {
  const r = resolve([{ src: FB, alt: '' }], FB);
  assert.deepEqual(r.currentState.affectedItems, []);
  assert.equal(r.currentState.isAbsent, true);
  assert.deepEqual(r.contextExtras.altFindingScope, { actionable: 0, ignoredTracking: 1 });
});

test('resolver: the same tracker reported by both the crawl and the finding is counted once', () => {
  assert.equal(resolve([{ src: FB, alt: '' }], FB).contextExtras.altFindingScope.ignoredTracking, 1);
});

test('resolver: only the finding (page data has no images) is classified too', () => {
  const r = resolve([], FB);
  assert.deepEqual(r.contextExtras.altFindingScope, { actionable: 0, ignoredTracking: 1 });
});

test('resolver: real images stay listed next to a tracker — legitimate external, upload and theme images are NOT dropped', () => {
  const r = resolve([
    { src: FB, alt: '' },
    { src: 'https://www.sapphiredigitalagency.com/wp-content/uploads/2024/10/team.jpg', alt: '' },
    { src: 'https://images.example.org/stock/hero.jpg', alt: '' },
    { src: 'https://www.sapphiredigitalagency.com/wp-content/themes/x/logo.png', alt: '' },
    { src: 'https://www.sapphiredigitalagency.com/wp-content/uploads/2024/10/ok.jpg', alt: 'Has alt' },
  ]);
  assert.deepEqual(r.currentState.affectedItems.map((x) => x.Image.split('/').pop()), ['team.jpg', 'hero.jpg', 'logo.png']);
  assert.deepEqual(r.contextExtras.altFindingScope, { actionable: 3, ignoredTracking: 1 });
});

test('resolver: a Facebook image that is not the pixel is a legitimate external image and stays', () => {
  const r = resolve([{ src: 'https://www.facebook.com/sapphire/picture?type=large', alt: '' }]);
  assert.equal(r.contextExtras.altFindingScope.actionable, 1);
});

test('resolver: a declared 1x1 image from an unknown host is set aside', () => {
  const r = resolve([{ src: 'https://stats.example.net/p.gif', alt: '', width: 1, height: 1 }]);
  assert.deepEqual(r.contextExtras.altFindingScope, { actionable: 0, ignoredTracking: 1 });
});

test('guard: refuses only on positive evidence that the finding was only a tracker', () => {
  assert.throws(() => assertAltFindingActionable({ altFindingScope: { actionable: 0, ignoredTracking: 1 } }),
    (e) => e instanceof ImageAltRecommendationError && e.code === 'ALT_FINDING_NOT_APPLICABLE' && e.statusCode === 422 && e.userFacing === true);
  for (const ctx of [null, {}, { altFindingScope: { actionable: 2, ignoredTracking: 1 } }, { altFindingScope: { actionable: 0, ignoredTracking: 0 } }]) {
    assert.doesNotThrow(() => assertAltFindingActionable(ctx));
    assert.equal(isAltFindingNotApplicable(ctx), false);
  }
});

test('guard: the refusal message never contains the tracking address or id', () => {
  try { assertAltFindingActionable({ altFindingScope: { actionable: 0, ignoredTracking: 1 } }); } catch (e) { assert.ok(!/facebook|\d{8,}|https?:/i.test(e.message)); }
});
