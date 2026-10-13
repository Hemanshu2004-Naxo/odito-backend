import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  chooseHeadline, boundedHeadline, ctaFromCaption, isCtaSentence, proseSentences, fitHeadline, buildDesignRequestFor,
} from './designHeadlineTestKit.js';
import { briefFailureCode, designFailureFor, DESIGN_FAILURE_MESSAGES } from './socialDesignGenerationService.js';

/**
 * Pure tests: how the headline and the call to action are chosen. A CTA ("Book a check-up this month") is not the subject of a post; a complete
 * opening sentence is preferred, with its punctuation; a long unpunctuated sentence gets a bounded excerpt at a word boundary; and a caption with
 * nothing to build a headline from is refused with a message that says what to add.
 */

const brief = (caption, extra = {}) => buildDesignRequestFor(caption, extra);

describe('headline: the post\'s subject, not its call to action', () => {
  test('1: a complete opening sentence is the headline; the CTA sentence is left for the button', () => {
    const caption = 'Fresh coffee, roasted daily in small batches. Visit us this weekend and taste the difference.';
    assert.deepEqual(chooseHeadline({ caption }), { headline: 'Fresh coffee, roasted daily in small batches', source: 'caption' });
    assert.equal(ctaFromCaption(caption), '', 'a long CTA sentence is not squeezed onto a button');
  });

  test('2: a long opening sentence (16 words) is kept whole - it is not replaced by the CTA that follows it', () => {
    const caption = 'Brushing for two minutes twice a day is still the simplest way to protect your smile. Book a check-up this month.';
    const r = chooseHeadline({ caption });
    assert.deepEqual([r.headline, r.source], ['Brushing for two minutes twice a day is still the simplest way to protect your smile', 'caption']);
    assert.equal(ctaFromCaption(caption), 'Book a check-up this month');
  });

  test('3: a longer one (19 words) is shortened at a clause, never replaced by the CTA, and marked as an excerpt', () => {
    const caption = 'Brushing for two minutes twice a day is still the simplest way to protect your smile every single day. Book a check-up this month.';
    const r = chooseHeadline({ caption });
    assert.deepEqual([r.headline, r.source], ['Brushing for two minutes twice a day is still the simplest way…', 'shortened']);
  });

  test('4: the plan\'s explicit headline wins over anything in the caption', () => {
    const r = chooseHeadline({ planItem: { onCreativeText: 'Is your agency ready for a fulfillment partner?' }, caption: 'Something else entirely. Book a call.' });
    assert.deepEqual(r, { headline: 'Is your agency ready for a fulfillment partner?', source: 'plan' });
    assert.equal(chooseHeadline({ planItem: { topic: 'Signs your agency has outgrown its team' }, caption: 'x y z. Book now.' }).headline, 'Signs your agency has outgrown its team');
  });

  test('5: a question stays a question; full stops and exclamation marks are dropped', () => {
    assert.equal(chooseHeadline({ caption: 'Is your agency ready for a fulfillment partner? Here is how to tell.' }).headline, 'Is your agency ready for a fulfillment partner?');
    assert.equal(chooseHeadline({ caption: 'We just opened a second studio! Come and see it.' }).headline, 'We just opened a second studio');
    assert.equal(fitHeadline('Ready for more??'), 'Ready for more?');
  });

  test('6: only when the post has NO subject sentence does a call to action become the headline (and it is said so)', () => {
    const r = chooseHeadline({ caption: 'Book your free check-up today.' });
    assert.deepEqual(r, { headline: 'Book your free check-up today', source: 'cta' });
    const b = brief('Book your free check-up today.', { objective: 'lead_generation', planItem: { objective: 'lead_generation', contentType: 'hard_sell' } }).brief;
    assert.equal(b.headline, 'Book your free check-up today');
    assert.ok(b.notes.includes('headline_is_cta'));
    assert.equal(b.cta, '', 'the headline is not shown a second time as the button');
  });

  test('7: list lines, hashtags and links are never taken as a headline or a call to action', () => {
    const caption = '1. Book a call with us\n2. Follow our page\nhttps://example.com/book-now\n#BookNow #Follow';
    assert.deepEqual(proseSentences(caption), []);
    assert.equal(chooseHeadline({ caption }).headline, '');
    assert.equal(ctaFromCaption(caption), '');
  });

  test('8: which sentences count as calls to action', () => {
    for (const cta of ['Book a check-up this month', 'Call us today', 'Visit our studio this weekend', 'Follow Sapphire for weekly insights', 'Sign up for the newsletter', 'Learn more on our site']) assert.equal(isCtaSentence(cta), true, cta);
    for (const subject of ['Booking a check-up early saves money', 'Get ready for winter', 'Start your day right', 'Good design is quiet', 'Visitors love our studio']) assert.equal(isCtaSentence(subject), false, subject);
  });
});

describe('the call to action is extracted separately and shown where the design supports it', () => {
  test('9: a service post shows the caption\'s CTA on its button, the headline is the subject, and the subtitle does not repeat either', () => {
    const caption = 'Our family check-up covers cleaning, scale and polish. Gentle care for every age. Call us today to book.';
    const b = brief(caption, { objective: 'lead_generation', planItem: { serviceName: 'Family check-up', objective: 'lead_generation', contentType: 'soft_sell' }, services: [{ name: 'Family check-up', features: ['Cleaning', 'Scale', 'Polish'] }, { name: 'Whitening', features: [] }] }).brief;
    assert.equal(b.headline, 'Our family check-up covers cleaning, scale and polish');
    assert.equal(b.cta, 'Call us today to book');
    assert.ok(![b.headline, b.cta].includes(b.subheadline));
    assert.equal(b.subheadline, 'Gentle care for every age');
  });

  test('10: the plan\'s own CTA is preferred over the caption\'s', () => {
    const b = brief('Introducing our new SEO Starter package, now open for new clients. Book your free consultation today.', { objective: 'lead_generation', planItem: { primaryCta: 'Request a free audit', objective: 'lead_generation', contentType: 'hard_sell' } }).brief;
    assert.equal(b.cta, 'Request a free audit');
    assert.equal(b.headline, 'Introducing our new SEO Starter package');
  });

  test('11: an editorial photo post draws no button; its CTA sentence stays available as the supporting line', () => {
    const b = brief('Brushing for two minutes twice a day protects your smile. Book a check-up this month.', { objective: 'educational' }).brief;
    assert.equal(b.layoutId, 'photo_hero');
    assert.equal(b.cta, '');
    assert.equal(b.headline, 'Brushing for two minutes twice a day protects your smile');
    assert.equal(b.subheadline, 'Book a check-up this month');
  });

  test('12: numbered lists are unchanged: the five points, a real headline, and the closing question is not a headline', () => {
    const caption = 'Most agencies hit a growth ceiling — not because of clients, but because of capacity.\n\n1. You\'re turning down requests.\n2. Delivery quality is slipping as volume grows.\n3. You spend more time managing tasks than clients.\n\nWhich of these signs sounds familiar? Drop a number in the comments.';
    const b = brief(caption, { objective: 'educational' }).brief;
    assert.deepEqual([b.layoutId, b.points.length, b.headline], ['infographic_points', 3, 'Most agencies hit a growth ceiling']);
  });

  test('13: the headline and the call to action are the business\'s own words: nothing is invented', () => {
    const caption = 'Fresh coffee, roasted daily in small batches. Visit us this weekend.';
    const b = brief(caption, { objective: 'lead_generation', planItem: { objective: 'lead_generation', contentType: 'hard_sell' } }).brief;
    for (const text of [b.headline, b.cta, b.subheadline].filter(Boolean)) assert.ok(caption.toLowerCase().includes(text.replace(/…$/, '').toLowerCase()), text);
  });
});

describe('long captions without punctuation: a bounded excerpt, or an explicit refusal', () => {
  const RUNON = 'so honestly it all depends on a lot of different things that tend to change from week to week for most of the teams that we talk to out there in the real world';

  test('14: enough real content: an excerpt at a clause, on whole words, from the caption itself, marked with an ellipsis', () => {
    const h = boundedHeadline(RUNON);
    assert.equal(h, 'so honestly it all depends on a lot of different things…');
    const words = h.replace(/…$/, '').split(' ');
    assert.ok(words.length >= 4 && words.length <= 12);
    for (const w of words) assert.ok(RUNON.split(' ').includes(w), `${w} is a whole word of the caption`);
    assert.doesNotMatch(h.replace(/…$/, ''), /\s(?:a|of|the|and|to|that)$/i, 'never ends on a joining word');
  });

  test('15: with no conjunction to break at, the first words up to a word boundary, never ending on a joining word', () => {
    const h = boundedHeadline('Marketingteams everywhere struggle consistently producing quality content because planning rarely survives contact with busy weeks anywhere');
    assert.match(h, /…$/);
    assert.ok(h.replace(/…$/, '').split(' ').length <= 12);
    const h2 = boundedHeadline('Sustainable packaging reduces waste dramatically across every channel while customers increasingly expect responsible choices from brands everywhere today');
    assert.equal(h2.endsWith('…'), true);
  });

  test('16: not enough content is NOT turned into a design: fewer than 8 words, filler, emoji, a link or nothing', () => {
    for (const bad of ['Hi!', 'Thanks so much everyone', 'ok ok ok ok ok ok ok ok ok ok ok ok', '🔥🔥🔥', '', 'https://example.com/x', 'a b c d e f g h i j k l']) assert.equal(boundedHeadline(bad), '', bad);
  });

  test('17: through the brief: the run-on caption gets a headline and notes it; filler / emoji / empty are refused with problems', () => {
    const ok = brief(RUNON, { objective: 'engagement' });
    assert.deepEqual(ok.problems, []);
    assert.equal(ok.brief.headline, 'so honestly it all depends on a lot of different things…');
    assert.ok(ok.brief.notes.includes('headline_shortened'));
    for (const bad of ['', '🔥🔥', 'ok ok ok ok ok ok ok ok ok ok ok ok ok ok ok ok', 'https://example.com/a-link']) {
      const refused = brief(bad, { objective: 'engagement' });
      assert.ok(refused.problems.includes('no headline'), JSON.stringify(bad));
    }
  });

  test('18: the refusal says what to add (its own message), and other brief problems keep the general message', () => {
    assert.equal(briefFailureCode(['no headline']), 'DESIGN_NEEDS_TEXT');
    assert.equal(briefFailureCode(['no headline: every candidate uses a prohibited phrase']), 'DESIGN_BRIEF_INVALID', 'a banned phrase is not "add an opening sentence"');
    assert.equal(briefFailureCode(['the figure 1 was not supplied']), 'DESIGN_BRIEF_INVALID');
    const f = designFailureFor({ code: 'DESIGN_NEEDS_TEXT' });
    assert.equal(f.code, 'DESIGN_NEEDS_TEXT');
    assert.match(f.message, /Add a short opening sentence/);
    assert.match(f.message, /upload your own design/);
    assert.ok(DESIGN_FAILURE_MESSAGES.DESIGN_NEEDS_TEXT);
  });
});
