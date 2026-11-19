import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { detectCaptionList, carouselEligibility, outlineCaptionPoints } from './carousel.js';
import { resolveDesignFormat, formatMismatch, calendarFormatAfter, currentDesignFormat, FORMAT_MESSAGES } from './designFormat.js';
import { conceptInput, produceConceptDesign } from './conceptDesign.js';
import { normalise } from './creativeBrief.js';
import { setBriefProviderOverride } from './creativeBrief.js';

/**
 * Format of a post's design (live bug, Nov 2026: posts planned as Carousel on the content calendar were designed as single images,
 * because Approvals' Generate/Regenerate could only make one image and nothing read the plan). Rule: the person's choice -> the plan
 * -> the caption's list; never a quiet single image for a carousel that cannot be made.
 */

afterEach(() => setBriefProviderOverride(null));

const HEAD = 'Three things holding your website back.';
const TAIL = 'Which one is hurting yours? Tell us below. #SEO #WebDesign';
const LIST = ['Slow pages', 'Weak titles', 'No internal links'];

// ── detection ───────────────────────────────────────────────────────────────

const STYLES = {
  numbered: `${HEAD}\n1. Slow pages\n2. Weak titles\n3. No internal links\n${TAIL}`,
  emoji_numbers: `${HEAD}\n1️⃣ Slow pages\n2️⃣ Weak titles\n3️⃣ No internal links\n${TAIL}`,
  steps: `${HEAD}\nStep 1: Slow pages\nStep 2 - Weak titles\nStep 3. No internal links\n${TAIL}`,
  bullets: `${HEAD}\n• Slow pages\n✅ Weak titles\n👉No internal links\n${TAIL}`,
  bold_headings: `${HEAD}\n\n**Slow pages**\nVisitors leave before the page loads, and they rarely come back to try again.\n\n**Weak titles**\nSearch results skip you because nothing tells people what the page is about.\n\n**No internal links**\nGoogle cannot find your best pages because nothing on the site points to them.\n\n${TAIL}`,
  unicode_bold: `${HEAD}\n\n𝗦𝗹𝗼𝘄 𝗽𝗮𝗴𝗲𝘀\nVisitors leave before the page loads.\n\n𝗪𝗲𝗮𝗸 𝘁𝗶𝘁𝗹𝗲𝘀\nSearch results skip you.\n\n𝗡𝗼 𝗶𝗻𝘁𝗲𝗿𝗻𝗮𝗹 𝗹𝗶𝗻𝗸𝘀\nGoogle cannot find your pages.\n\n${TAIL}`,
  plain_list: `${HEAD}\n\nSlow pages\nWeak titles\nNo internal links\n\n${TAIL}`,
};

test('every list style is detected, in order, with the marker removed', () => {
  for (const [name, caption] of Object.entries(STYLES)) {
    const d = detectCaptionList(caption);
    assert.deepEqual(d.points.map((p) => p.text), LIST, name);
    assert.deepEqual(d.points.map((p) => p.number), [1, 2, 3], name);
    assert.equal(carouselEligibility(caption).source, 'caption', name);
  }
  assert.equal(detectCaptionList(STYLES.unicode_bold).style, 'bold_headings');
});

test('repeated label lines ("Speed: ...") are a list; a single "Here is the thing:" is not', () => {
  const labels = `${HEAD}\n\nSpeed: visitors leave first.\nTitles: search skips you.\nLinks: Google cannot find pages.\n\n${TAIL}`;
  assert.deepEqual(detectCaptionList(labels).points.map((p) => p.text), ['Speed: visitors leave first.', 'Titles: search skips you.', 'Links: Google cannot find pages.']);
  assert.equal(detectCaptionList(`${HEAD}\nHere is the thing: speed matters.\nSo does content.\n${TAIL}`).points.length, 0);
});

test('prose paragraphs are not a "plain list"; numbering out of order is not a numbered list', () => {
  assert.equal(detectCaptionList('Big news this week.\n\nWe opened a new office and the team is growing.\n\nCome and say hello.').points.length, 0);
  assert.equal(detectCaptionList('Intro\n1. A thing\n3. Another\n2. Third').points.length, 0);
});

test('3-8 items: one slide each; 9-10 items: merged by Claude; 11+: no list (the outline fallback applies to a long caption)', () => {
  const bullets = (n) => `${HEAD}\n${Array.from({ length: n }, (_, i) => `• point number ${i + 1}`).join('\n')}\n${TAIL}`;
  assert.deepEqual(carouselEligibility(bullets(8)), { allowed: true, points: 8, source: 'caption', style: 'bullets' });
  assert.deepEqual(carouselEligibility(bullets(10)), { allowed: true, points: 10, source: 'merge', style: 'bullets' });
  assert.equal(detectCaptionList(bullets(11)).points.length, 0);
  assert.equal(carouselEligibility(bullets(11)).source, 'outline');
  assert.equal(carouselEligibility(bullets(2)).allowed, false);
});

test('merging 10 items: the outline prompt says so and the answer must still be at most 8 points', async () => {
  const calls = [];
  setBriefProviderOverride({ async generateStructured(req) { calls.push(req); return { parsed: { points: Array.from({ length: 4 }, (_, i) => ({ text: `Point ${i + 1} merged`, source: `point number ${i + 1}` })) }, model: 'claude-test', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 }; } });
  const caption = `${HEAD}\n${Array.from({ length: 10 }, (_, i) => `• point number ${i + 1}`).join('\n')}\n${TAIL}`;
  const out = await outlineCaptionPoints({ caption, listed: detectCaptionList(caption).points });
  assert.equal(out.points.length, 4);
  assert.match(calls[0].system, /lists 10 items/);
  assert.equal(calls[0].tool.schema.properties.points.maxItems, 8);
});

test('unicode-bold caption text compares as plain letters (a slide may quote it)', () => {
  assert.equal(normalise('𝗦𝗹𝗼𝘄 𝗽𝗮𝗴𝗲𝘀'), 'slow pages');
});

// ── the format rule ─────────────────────────────────────────────────────────

const PROSE_SHORT = 'Big news this week. Stay tuned.';
const PROSE_LONG = 'Most agencies hit a growth ceiling, not because of clients but because of capacity. You turn down new requests because the team cannot take on more delivery. The team is stretched across too many services and quality slips under volume. Which of these signs sounds familiar? Tell us.';

test('planned Carousel -> carousel (even when the caption has no list, if it can be outlined)', () => {
  const r = resolveDesignFormat({ plannedFormat: 'carousel', caption: PROSE_LONG });
  assert.equal(r.format, 'carousel'); assert.equal(r.source, 'plan'); assert.equal(r.needsChoice, false); assert.equal(r.carousel.source, 'outline');
});

test('bullet / emoji list without a plan -> carousel; no list -> single', () => {
  assert.equal(resolveDesignFormat({ caption: STYLES.bullets }).format, 'carousel');
  assert.equal(resolveDesignFormat({ caption: STYLES.emoji_numbers }).format, 'carousel');
  assert.deepEqual([resolveDesignFormat({ caption: PROSE_LONG }).format, resolveDesignFormat({ caption: PROSE_LONG }).source], ['single', 'caption']);
});

test('the person\'s explicit choice overrides the plan, both ways', () => {
  assert.equal(resolveDesignFormat({ explicit: 'single', plannedFormat: 'carousel', caption: STYLES.bullets }).format, 'single');
  const c = resolveDesignFormat({ explicit: 'carousel', plannedFormat: 'static_post', caption: STYLES.numbered });
  assert.deepEqual([c.format, c.source], ['carousel', 'choice']);
  // junk is not a choice
  assert.equal(resolveDesignFormat({ explicit: 'banana', plannedFormat: 'carousel', caption: STYLES.numbered }).source, 'plan');
});

test('a planned photo / reel / text post is a single image even when the caption has a list (the plan wins over detection)', () => {
  for (const planned of ['static_post', 'reel', 'video', 'text_post']) assert.equal(resolveDesignFormat({ plannedFormat: planned, caption: STYLES.numbered }).format, 'single', planned);
});

test('planned carousel with no clear points -> the question, never a quiet single image', () => {
  const r = resolveDesignFormat({ plannedFormat: 'carousel', caption: PROSE_SHORT });
  assert.equal(r.format, 'carousel'); assert.equal(r.needsChoice, true); assert.equal(r.code, 'CAROUSEL_NEEDS_POINTS');
  assert.equal(r.message, FORMAT_MESSAGES.PLANNED_NO_POINTS);
  assert.equal(r.message, 'Planned as carousel, but the caption has no clear points. Make a single image or edit the caption?');
  const chosen = resolveDesignFormat({ explicit: 'carousel', caption: PROSE_SHORT });
  assert.equal(chosen.message, FORMAT_MESSAGES.CHOSEN_NO_POINTS);
  // the person answers "single image": that is a choice, and nothing is asked again
  assert.equal(resolveDesignFormat({ explicit: 'single', plannedFormat: 'carousel', caption: PROSE_SHORT }).needsChoice, false);
});

test('a carousel the pipeline cannot make (product photos) asks too', () => {
  const r = resolveDesignFormat({ plannedFormat: 'carousel', caption: STYLES.numbered, carouselAvailable: false });
  assert.deepEqual([r.needsChoice, r.code], [true, 'CAROUSEL_UNAVAILABLE']);
});

test('mismatch: planned carousel, current design one image; the calendar follows the format that was made', () => {
  assert.equal(formatMismatch({ media: [{ url: 'a' }] }, 'carousel'), true);
  assert.equal(formatMismatch({ media: [{ url: 'a' }, { url: 'b' }] }, 'carousel'), false);
  assert.equal(formatMismatch({ media: [] }, 'carousel'), false);
  assert.equal(formatMismatch({ media: [{ url: 'a' }] }, 'static_post'), false);
  assert.equal(currentDesignFormat({ media: [] }), null);
  assert.equal(calendarFormatAfter('carousel', 'static_post'), 'carousel');
  assert.equal(calendarFormatAfter('single', 'carousel'), 'static_post');
  assert.equal(calendarFormatAfter('single', 'reel'), null);
  assert.equal(calendarFormatAfter('carousel', 'carousel'), null);
  assert.equal(calendarFormatAfter('carousel', null), null);
});

test('the one-image concept path takes the resolved format and refuses a carousel (no hard-coded single_image)', async () => {
  assert.equal(conceptInput({ content: 'x', platform: 'instagram' }, {}, [], { format: 'carousel' }).designFormat, 'carousel');
  assert.throws(() => conceptInput({ content: 'x' }, {}, [], { format: 'gif' }));
  await assert.rejects(produceConceptDesign({ pub: { content: 'x' }, format: 'carousel' }), (e) => e.code === 'DESIGN_FORMAT_INVALID');
  await assert.rejects(produceConceptDesign({ pub: { content: 'x' } }), (e) => e.code === 'DESIGN_FORMAT_INVALID');
});
