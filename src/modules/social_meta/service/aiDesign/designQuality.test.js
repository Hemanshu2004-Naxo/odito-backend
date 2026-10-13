import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import {
  classifyCreative, buildDesignBrief, checkBrief, extractFigures, extractPoints, fitPoint, isStatFigure, hasReadableContext, withoutStructuralDigits,
} from './designStrategy.js';
import { assessRaster, checkComposition, expectedLabels, BLANK_STDEV } from './designQuality.js';
import { composeDesign } from './compose/designComposer.js';
import { produceDesign } from './designProducer.js';
import { makeImage } from '../../testSupport/designFixtures.js';
import { designFailureFor, DESIGN_FAILURE_MESSAGES } from './socialDesignGenerationService.js';

/**
 * Pure tests (no database, no network, no AI): why a numbered-list post once became three empty cards with giant numerals, and the gates that now
 * make that impossible - what counts as a statistic, whole-sentence points, the composition check, and the blank-image check.
 */

const NUMBERED = [
  'Most agencies hit a growth ceiling — not because of clients, but because of capacity. Here\'s what changes that.', '',
  'If any of these feel familiar, your agency may already be ready for a white-label fulfillment partner:', '',
  '1. You\'re turning down service requests because your team can\'t cover them.', '2. Delivery quality is slipping as client volume grows.',
  '3. You\'re spending more time managing tasks than managing clients.', '4. Hiring feels like the only option — but the overhead doesn\'t add up.',
  '5. A client just asked for a service you don\'t offer yet.', '', 'Which of these signs sounds familiar to your agency right now? Drop a number in the comments.', '',
  'Follow Sapphire Digital Agency for weekly insights.', '', '#SapphireDigitalAgency #AgencyGrowth',
].join('\n');
const SNAPSHOT = { brand: { primaryColor: '#0B3A75', accentColor: '#E8590C' }, business: { name: 'Sapphire Digital Agency' } };
const brief = (caption, extra = {}) => buildDesignBrief({ caption, platform: 'facebook', pillar: 'Agency Growth', objective: 'educational', snapshotData: SNAPSHOT, ...extra });

describe('what counts as a statistic (the root cause)', () => {
  test('1: list numerals, years, hashtags, phone numbers, links and small counts are never figures', () => {
    assert.deepEqual(extractFigures(NUMBERED), [], 'the reported caption states no statistic at all');
    assert.deepEqual(extractFigures('1. First\n2) Second\n3 - Third'), []);
    assert.deepEqual(extractFigures('Since 2019 and in 2026, call +91 98765 43210 or visit https://example.com/offer-2025 #Top10Tips'), []);
    assert.deepEqual(extractFigures('We help in 3 ways and 9 steps'), [], 'a count in a sentence is not a statistic');
  });

  test('2: real statistics are kept: percentages, money, decimals, thousands and whole numbers from 10', () => {
    assert.deepEqual(extractFigures('Up 42% from $1,200 to 3.5x, 250 clients'), ['42%', '$1,200', '3.5', '250']);
    for (const stat of ['87%', '$5', '€1,000', '99.9', '1,250', '10', '250']) assert.equal(isStatFigure(stat), true, stat);
    for (const notStat of ['1', '2', '9', '2026', '1999']) assert.equal(isStatFigure(notStat), false, notStat);
  });

  test('3: list numerals are removed only where they are structure (line start), not inside a sentence', () => {
    assert.equal(withoutStructuralDigits('1. Alpha\n2) Beta'), 'Alpha\nBeta');
    assert.match(withoutStructuralDigits('Save 40% today'), /40%/);
  });

  test('4: a context must say something: three real words, never "1." or "42"', () => {
    for (const bad of ['', '1.', '42', 'ok', 'a b', '12 34 56']) assert.equal(hasReadableContext(bad), false, bad);
    assert.equal(hasReadableContext('Revenue grew 42% in a year'), true);
  });
});

describe('the reported caption now makes the right design', () => {
  test('5: it is a numbered list: educational_list on the infographic layout with all five points, and no figures', () => {
    assert.deepEqual(classifyCreative({ caption: NUMBERED, pillar: 'Agency Growth', objective: 'educational' }), { type: 'educational_list', reason: 'numbered points' });
    const b = brief(NUMBERED);
    assert.deepEqual([b.creativeType, b.layoutId, b.figures.length, b.points.length], ['educational_list', 'infographic_points', 0, 5]);
    assert.deepEqual(checkBrief(b, { caption: NUMBERED }), []);
  });

  test('6: points are whole sentences - never cut mid-thought ("... because your", "... than")', () => {
    const points = extractPoints({ caption: NUMBERED });
    assert.equal(points.length, 5);
    assert.equal(points[0], 'You\'re turning down service requests because your team can\'t cover them');
    assert.equal(points[2], 'You\'re spending more time managing tasks than managing clients');
    for (const p of points) assert.doesNotMatch(p, /\b(because|than|as|your|the|a|to|for|and|of)$/i, p);
  });

  test('7: a point that is too long for a card is shortened at a clause, then at a word boundary - never in the middle of a word', () => {
    assert.equal(fitPoint('Hiring feels like the only option, but the overhead never adds up for small teams'), 'Hiring feels like the only option, but the overhead never adds up for small teams', 'a sentence that fits a card is kept whole');
    assert.equal(fitPoint('Hiring feels like the only option, but the overhead never adds up for small teams that are growing quickly across several markets this year'), 'Hiring feels like the only option');
    const long = fitPoint('One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen');
    assert.ok(long.split(' ').length <= 16 && !/\s$/.test(long));
  });

  test('8: a genuine data post is still a data design, with each figure explained by its own sentence', () => {
    const caption = 'Agencies that automate delivery grow faster.\n\nRevenue per client rose 42% in a year when delivery was standardised.\n\nAverage turnaround fell from 9 days to 4 days after the move.';
    const b = brief(caption, { planItem: { contentType: 'educational' } });
    assert.equal(b.creativeType, 'data_insight');
    assert.deepEqual(b.figures.map((f) => f.value), ['42%']);
    assert.match(b.figures[0].context, /Revenue per client rose 42% in a year/);
    assert.deepEqual(checkBrief(b, { caption }), []);
  });

  test('9: a data design never carries a figure that has no readable sentence (it falls back to another layout)', () => {
    const caption = 'Results speak.\n\n42%\n\nBook a call today.';
    const b = brief(caption);
    assert.notEqual(b.layoutId, 'insight_stats');
    assert.deepEqual(b.figures, []);
  });

  test('10: checkBrief refuses a degenerate brief outright (before any image is paid for)', () => {
    const good = brief(NUMBERED);
    assert.ok(checkBrief({ ...good, layoutId: 'insight_stats', figures: [{ value: '1', context: '1.' }] }, { caption: NUMBERED }).some((p) => /not a statistic|no readable context/.test(p)));
    assert.ok(checkBrief({ ...good, points: ['1', '2', '3'] }, { caption: NUMBERED }).some((p) => /no readable text/.test(p)));
  });
});

describe('a headline always exists when the caption has any sentence that fits', () => {
  test('18: a long opening sentence falls back to the next sentence that fits - never a design with no headline', () => {
    const caption = 'Brushing for two minutes twice a day is still the simplest way to protect your smile every single day. Book a check-up this month.\n\n#Dentist';
    const b = brief(caption);
    assert.equal(b.headline, 'Brushing for two minutes twice a day is still the simplest way…', 'the post\'s subject, shortened at a clause - not its call to action');
    assert.ok(b.notes.includes('headline_shortened'));
    assert.deepEqual(checkBrief(b, { caption }), []);
    // list lines, hashtags and links are never taken as the headline
    const only = brief('Averyveryverylongopeningsentence that goes on and on and on and on and on and on and on and on and on and on and on forever.\n1. First point here\n#tag https://example.com');
    assert.ok(!/First point|example\.com|#tag/.test(only.headline));
  });
});

describe('composition check: what the layout must show, was drawn', () => {
  test('11: the expected labels follow the layout', () => {
    const b = brief(NUMBERED);
    assert.deepEqual(expectedLabels(b), ['headline', 'point:0', 'point:1', 'point:2', 'point:3', 'point:4']);
    assert.deepEqual(expectedLabels({ layoutId: 'insight_stats', headline: 'H', figures: [{ value: '42%', context: 'x y z' }] }), ['headline', 'figure:0', 'context:0']);
    assert.deepEqual(expectedLabels({ layoutId: 'photo_hero', headline: 'H' }), ['headline']);
  });

  test('12: a missing, zero-size or overflowing required text is reported with its slot; a complete report passes', () => {
    const b = brief(NUMBERED);
    const full = [{ label: 'headline', width: 10, height: 10 }, ...[0, 1, 2, 3, 4].map((i) => ({ label: `point:${i}`, width: 10, height: 10 }))];
    assert.equal(checkComposition(b, { texts: full }), null);
    assert.equal(checkComposition(b, { texts: full.filter((t) => t.label !== 'point:3') }), 'missing_point_3');
    assert.equal(checkComposition(b, { texts: full.map((t) => (t.label === 'point:1' ? { ...t, width: 0 } : t)) }), 'invisible_point_1');
    assert.equal(checkComposition(b, { texts: full, overflow: ['point:2'] }), 'overflow_point_2');
    assert.equal(checkComposition({ ...b, points: ['one', '', 'three', 'four', 'five'] }, { texts: full }), 'empty_point_1');
  });

  test('13: the composer renders the reported caption as a real infographic: every point drawn, nothing shortened or overflowing', async () => {
    const b = brief(NUMBERED);
    const { buffer, report } = await composeDesign({ brief: b, size: { width: 1536, height: 1024 }, visual: null, logo: null, productImages: [] });
    assert.deepEqual([report.layout, report.shortened, report.overflow], ['infographic_points', [], []]);
    assert.equal(report.texts.filter((t) => t.label.startsWith('point:')).length, 5);
    const quality = await assessRaster(buffer);
    assert.equal(quality.blank, false);
    assert.ok(quality.stdev > 20);
    const square = await composeDesign({ brief: b, size: { width: 1024, height: 1024 }, visual: null });
    assert.deepEqual(square.report.overflow, []);
  });

  test('14: the composer REFUSES a statistics design whose figures have nothing to say (COMPOSE_INCOMPLETE), instead of drawing empty cards', async () => {
    const b = { ...brief(NUMBERED), layoutId: 'insight_stats', creativeType: 'data_insight', figures: [{ value: '1', context: '' }, { value: '2', context: '' }, { value: '3', context: '' }], points: [] };
    await assert.rejects(() => composeDesign({ brief: b, size: { width: 1536, height: 1024 } }), (e) => e.code === 'COMPOSE_INCOMPLETE' && /empty_context_0/.test(e.reason));
  });

  test('15: the producer turns that into DESIGN_COMPOSE_FAILED with the reason - never a stored success', async () => {
    const b = { ...brief(NUMBERED), layoutId: 'insight_stats', creativeType: 'data_insight', figures: [{ value: '1', context: '' }], points: [], photography: { required: false } };
    await assert.rejects(() => produceDesign({ request: { brief: b, visualPrompt: '', visualSize: '1024x1024', size: { width: 1536, height: 1024 } }, provider: null, generationId: 'g' }), (e) => e.code === 'DESIGN_COMPOSE_FAILED' && /empty_context_0/.test(e.reason));
  });
});

describe('what the person is told', () => {
  test('19: an incomplete or blank design has its own plain message (not a generic failure) and says the current design is unchanged', () => {
    for (const code of ['DESIGN_COMPOSE_FAILED']) {
      const f = designFailureFor({ code, reason: 'empty_context_0' });
      assert.equal(f.code, code);
      assert.match(f.message, /nothing was saved and your current design is unchanged/);
      assert.doesNotMatch(f.message, /empty_context|reason/);
    }
    assert.equal(designFailureFor({ code: 'MEDIA_INVALID', reason: 'visual_blank' }).message, DESIGN_FAILURE_MESSAGES.MEDIA_INVALID);
  });
});

describe('raster check: a picture that decodes but shows nothing', () => {
  test('16: a flat colour is blank, a gradient or a real-looking picture is not', async () => {
    const flat = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#f5f5f5' } }).png().toBuffer();
    const flatResult = await assessRaster(flat);
    assert.deepEqual([flatResult.blank, flatResult.flatShare], [true, 1]);
    const picture = await makeImage({ width: 800, height: 600 });
    const result = await assessRaster(picture);
    assert.equal(result.blank, false);
    assert.ok(result.stdev > BLANK_STDEV);
  });

  test('17: the producer refuses a blank provider photograph (MEDIA_INVALID / visual_blank) before composing anything', async () => {
    const flat = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const b = brief('Brushing twice a day protects your smile. Book a check-up this month.', { snapshotData: { ...SNAPSHOT } });
    const request = { brief: { ...b, photography: { required: true, scene: 'a bright dental clinic' } }, visualPrompt: 'A bright dental clinic', visualSize: '1024x1024', size: { width: 1536, height: 1024 } };
    const provider = { generateImage: async () => ({ buffer: flat, usage: {}, model: 'm', durationMs: 1, attempts: 1 }) };
    await assert.rejects(() => produceDesign({ request, provider, generationId: 'g' }), (e) => e.code === 'MEDIA_INVALID' && e.reason === 'visual_blank');
  });
});
