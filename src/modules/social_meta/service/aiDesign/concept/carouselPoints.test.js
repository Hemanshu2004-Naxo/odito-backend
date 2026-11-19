import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { captionPoints, carouselEligibility, outlineCaptionPoints } from './carousel.js';
import { setBriefProviderOverride } from './creativeBrief.js';

/**
 * Carousel points. Live report (Nov 2026): a real Odito caption listed its points as BULLETS (4 on-page + 3 off-page), so the Carousel
 * option was disabled ("needs 3 to 6 numbered points"), the click did nothing, and Compare made single images. Now bullets count, and a
 * caption without a clean 3-6 list is split into 3-6 points by Claude (checked: every point quotes the caption, adds no figure).
 */

const REAL_CAPTION = `SEO has two sides — and most businesses are only working on one of them.

If you want your website to rank well in search, you need to understand both on-page and off-page SEO — and how they work together.

On-page SEO is everything you control directly on your website:
• Page titles and meta descriptions
• Content quality, structure and relevance
• Internal linking and URL structure
• Page speed and mobile-friendliness

Off-page SEO is about how the wider web perceives your site:
• Backlinks from other reputable websites
• Brand mentions and citations
• Domain authority built over time

Here's the thing: on-page SEO without off-page signals limits how far you can grow. And off-page efforts built on a weak on-page foundation rarely stick.

Both pillars matter. And both need consistent attention.

Which side of SEO do you focus on more — on-page or off-page? Tell us in the comments.

#SEO #DigitalMarketing #OnPageSEO`;

afterEach(() => setBriefProviderOverride(null));

const scripted = (...answers) => {
  const calls = [];
  setBriefProviderOverride({
    async generateStructured(req) {
      calls.push(req);
      const parsed = answers[Math.min(calls.length - 1, answers.length - 1)];
      return { parsed, model: 'claude-test', usage: { inputTokens: 100, outputTokens: 50 }, durationMs: 5 };
    },
  });
  return calls;
};

test('numbered points still work, in order', () => {
  assert.deepEqual(captionPoints('Intro\n1. One thing\n2. Two things\n3. Three things\nBye'), [
    { number: 1, text: 'One thing' }, { number: 2, text: 'Two things' }, { number: 3, text: 'Three things' },
  ]);
});

test('a bulleted list of 3-6 counts as the points (•, -, *, ✅)', () => {
  for (const marker of ['•', '-', '*', '✅', '→']) {
    const pts = captionPoints(`Why it matters:\n${marker} Faster pages\n${marker} Clearer titles\n${marker} Better links\nThat is all.`);
    assert.deepEqual(pts.map((p) => p.text), ['Faster pages', 'Clearer titles', 'Better links'], marker);
    assert.deepEqual(pts.map((p) => p.number), [1, 2, 3]);
  }
});

test('the real caption (7 bullets in two groups) is now a 7-point list: one slide per bullet (Instagram room: 8 points + hook + CTA)', () => {
  assert.equal(captionPoints(REAL_CAPTION).length, 7);
  assert.deepEqual(carouselEligibility(REAL_CAPTION), { allowed: true, points: 7, source: 'caption', style: 'bullets' });
});

test('eligibility: own list -> caption; too short -> not allowed (hashtags do not count as words)', () => {
  assert.deepEqual(carouselEligibility('Tips:\n• A b\n• C d\n• E f'), { allowed: true, points: 3, source: 'caption', style: 'bullets' });
  assert.equal(carouselEligibility('Short caption. #a #b #c #d #e #f #g #h #i #j #k #l #m #n #o #p #q #r #s #t #u #v #w #x #y #z #aa #bb #cc #dd #ee #ff #gg #hh #ii #jj #kk #ll #mm #nn').allowed, false);
});

test('outline: 3-6 points that quote the caption are accepted, in order, numbered', async () => {
  const calls = scripted({ points: [
    { text: 'On-page SEO is what you control on your site', source: 'everything you control directly on your website' },
    { text: 'Off-page SEO is how the web sees your site', source: 'how the wider web perceives your site' },
    { text: 'You need both to keep growing', source: 'Both pillars matter' },
  ] });
  const out = await outlineCaptionPoints({ caption: REAL_CAPTION });
  assert.deepEqual(out.points.map((p) => p.number), [1, 2, 3]);
  assert.equal(out.points[0].text, 'On-page SEO is what you control on your site');
  assert.equal(calls.length, 1);
  assert.equal(out.calls[0].step, 'carousel_outline');
  assert.equal(calls[0].tool.schema.properties.points.minItems, 3);
});

test('outline: an invented figure or a source not in the caption is repaired once, then refused', async () => {
  const bad = { points: [
    { text: 'Backlinks lift rankings by 40%', source: 'Backlinks from other reputable websites' },
    { text: 'Page speed is a ranking factor', source: 'this sentence is not in the caption' },
    { text: 'Both pillars matter', source: 'Both pillars matter' },
  ] };
  const good = { points: [
    { text: 'Backlinks from reputable sites build trust', source: 'Backlinks from other reputable websites' },
    { text: 'Page speed is part of on-page SEO', source: 'Page speed and mobile-friendliness' },
    { text: 'Both pillars matter', source: 'Both pillars matter' },
  ] };
  const calls = scripted(bad, good);
  const out = await outlineCaptionPoints({ caption: REAL_CAPTION });
  assert.equal(calls.length, 2);
  assert.match(calls[1].user, /40%/);
  assert.match(calls[1].user, /source must copy/);
  assert.equal(out.points.length, 3);
  assert.deepEqual(out.calls.map((c) => c.step), ['carousel_outline', 'carousel_outline_repair']);

  scripted(bad, bad);
  await assert.rejects(outlineCaptionPoints({ caption: REAL_CAPTION }), (e) => e.code === 'CAROUSEL_NEEDS_POINTS' && e.calls.length === 2);
});

test('outline: too few points or duplicates are refused', async () => {
  scripted({ points: [{ text: 'Both pillars matter', source: 'Both pillars matter' }, { text: 'Both pillars matter', source: 'Both pillars matter' }] });
  await assert.rejects(outlineCaptionPoints({ caption: REAL_CAPTION }), (e) => e.code === 'CAROUSEL_NEEDS_POINTS' && /3 to 6 points|repeats/.test(e.errors.join(' ')));
});
