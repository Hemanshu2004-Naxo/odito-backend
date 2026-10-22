import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIND, classifyImageUrl, classifySnapshot, isTrackingEndpoint, UNSUPPORTED_REASON } from './imageResource.js';

// The SAME cases the crawler's Python classifier is tested against: the two implementations must agree on every one.
const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../python_workers/scraper/shared/fixtures/image_resource_cases.json');
const { pageUrl, cases } = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const PAGE = 'https://www.sapphiredigitalagency.com/about-us';

test('the shared fixture is present and non-trivial (a missing file must fail, not skip)', () => {
  assert.ok(cases.length >= 30);
});

for (const c of cases) {
  test(`shared case: ${c.name}`, () => {
    const got = classifyImageUrl(c.src, { pageUrl, width: c.width, height: c.height, lazySrc: c.lazy_src });
    assert.equal(got.kind, c.kind);
    assert.equal(got.actionable, c.kind !== KIND.TRACKING);
  });
}

test('the exact Facebook Pixel URL from the Sapphire crawl is a tracking endpoint', () => {
  const src = 'https://www.facebook.com/tr?id=1064713942451011&ev=PageView&noscript=1';
  assert.equal(classifyImageUrl(src, { pageUrl: PAGE }).kind, KIND.TRACKING);
  assert.equal(isTrackingEndpoint(src, PAGE), true);
});

test('a host alone never decides', () => {
  assert.equal(isTrackingEndpoint('https://www.facebook.com/sapphire/picture', PAGE), false);
  assert.equal(isTrackingEndpoint('https://www.facebook.com.evil.example/tr?id=1', PAGE), false);
});

test('classifySnapshot: a persisted record is judged by its URL, and a recorded kind can never CLEAR a tracker', () => {
  const fb = 'https://www.facebook.com/tr?id=1&ev=PageView&noscript=1';
  assert.equal(classifySnapshot({ src: fb }, PAGE).kind, KIND.TRACKING, 'an old record with no kind');
  assert.equal(classifySnapshot({ src: fb, resourceKind: KIND.WP_MEDIA }, PAGE).kind, KIND.TRACKING, 'a wrong recorded kind does not whitelist a tracker');
  assert.equal(classifySnapshot({ src: 'https://cdn.example.com/a.jpg', resourceKind: KIND.WP_MEDIA }, PAGE).kind, KIND.WP_MEDIA, 'the crawler verdict is kept for others');
  assert.equal(classifySnapshot({ src: 'https://cdn.example.com/a.jpg' }, PAGE).kind, KIND.EXTERNAL);
  assert.equal(classifySnapshot({ src: 'x', resourceKind: 'bogus' }, PAGE).kind, KIND.CONTENT, 'an unknown recorded kind is ignored');
});

test('user-facing reasons exist for every non-media kind and never carry a URL or tracking id', () => {
  for (const kind of [KIND.TRACKING, KIND.THEME_ASSET, KIND.PLUGIN_ASSET, KIND.CORE_ASSET, KIND.EXTERNAL, KIND.DATA_URL]) {
    const r = UNSUPPORTED_REASON[kind];
    assert.ok(r.code && r.message, kind);
    assert.ok(!/https?:|\d{8,}/.test(r.message), `${kind} message must not expose an address or identifier`);
  }
  assert.equal(UNSUPPORTED_REASON[KIND.WP_MEDIA], undefined);
});
