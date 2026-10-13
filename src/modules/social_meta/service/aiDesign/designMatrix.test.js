import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { buildDesignRequest } from './designBrief.js';
import { composeDesign } from './compose/designComposer.js';
import { expectedLabels, assessRaster } from './designQuality.js';
import { produceDesign } from './designProducer.js';

/**
 * Pure tests (no database, no network, no AI): ten kinds of caption go through the real brief builder and the real composer. For each, the right
 * rendering path is chosen (a photograph is requested ONLY where the layout carries one), the headline is real, every slot the layout must show is
 * drawn, nothing overflows or is shortened, and the picture is not blank. Plus pixel checks for two layout defects the matrix found (quote marks
 * over the first line; promotional copy running into the photograph's ring) and the subtitle rules (a whole sentence, never the headline again).
 */

const NUMBERED = ['Most agencies hit a growth ceiling — not because of clients, but because of capacity. Here\'s what changes that.', '', 'If any of these feel familiar, your agency may already be ready for a white-label fulfillment partner:', '', '1. You\'re turning down service requests because your team can\'t cover them.', '2. Delivery quality is slipping as client volume grows.', '3. You\'re spending more time managing tasks than managing clients.', '4. Hiring feels like the only option — but the overhead doesn\'t add up.', '5. A client just asked for a service you don\'t offer yet.', '', 'Which of these signs sounds familiar? Drop a number in the comments.', '', '#AgencyGrowth #WhiteLabel'].join('\n');
const LONG = 'We started this agency because small businesses kept telling us the same thing: marketing felt confusing, expensive and impossible to measure. So we built a simple way of working. First we listen to how the business actually earns money. Then we choose only the channels that can move that number. Every month we show the results in plain language, and every quarter we decide together what to stop, what to keep and what to try next. Nothing here is complicated, but it does take discipline, honest reporting and a willingness to say no to shiny ideas that do not fit. If that sounds like the partner you have been looking for, we would love to hear what you are working on and where you feel stuck right now.';

// photo: whether the layout carries a provider photograph; structured layouts never ask for one
const CASES = {
  numbered: { caption: NUMBERED, objective: 'educational', type: 'educational_list', layout: 'infographic_points', photo: false, headline: 'Most agencies hit a growth ceiling' },
  statistics: { caption: 'Agencies that standardise delivery grow faster.\n\nRevenue per client rose 42% in a year when delivery was standardised.\n\nAverage turnaround fell from 9 days to 4 days after the move.', objective: 'educational', type: 'data_insight', layout: 'insight_stats', photo: false, headline: 'Agencies that standardise delivery grow faster' },
  quote: { caption: 'As our founder likes to say: "Great marketing is not louder, it is clearer and kinder to the customer."\n\nThat idea guides every campaign we run.', objective: 'awareness', type: 'quote', layout: 'statement_quote', photo: false, headline: 'Great marketing is not louder, it is clearer and kinder to the customer.' },
  promotional: { caption: 'Introducing our new SEO Starter package, now open for new clients. Limited offer this month: a free site audit with every booking. Book your free consultation today.', objective: 'lead_generation', planItem: { primaryCta: 'Book a free consultation', contentType: 'hard_sell', objective: 'lead_generation' }, type: 'announcement', layout: 'announcement_banner', photo: true, headline: 'Introducing our new SEO Starter package', cta: 'Book a free consultation' },
  photo: { caption: 'Brushing for two minutes twice a day is still the simplest way to protect your smile. Book a check-up this month.', objective: 'educational', type: 'premium_editorial', layout: 'photo_hero', photo: true, headline: 'Brushing for two minutes twice a day is still the simplest way to protect your smile' },
  long: { caption: LONG, objective: 'awareness', type: 'brand_awareness', layout: 'photo_hero', photo: true, headline: 'So we built a simple way of working' },
  withCta: { caption: 'Fresh coffee, roasted daily in small batches. Visit us this weekend and taste the difference.', objective: 'engagement', planItem: { primaryCta: 'Visit us this weekend', contentType: 'soft_sell' }, type: 'premium_editorial', layout: 'photo_hero', photo: true, headline: 'Fresh coffee, roasted daily in small batches' },
  noNumbers: { caption: 'Good design is quiet. It removes the noise so people can find what they came for. That is the whole job.', objective: 'awareness', type: 'brand_awareness', layout: 'photo_hero', photo: true, headline: 'Good design is quiet' },
};
const REFUSED = {
  tooLittle: '🔥🔥',
  empty: '',
  repeatedFiller: 'ok ok ok ok ok ok ok ok ok ok ok ok ok ok ok ok ok ok ok ok',
  linkOnly: 'https://example.com/a-very-long-link-that-is-not-a-sentence-at-all-and-never-will-be',
};
const BASE = { platform: 'facebook', pillar: 'Brand', snapshotData: { business: { name: 'Sample Studio', category: 'Agency' }, brand: { primaryColor: '#0B3A75', accentColor: '#E8590C' } }, seed: 'matrix' };

let photograph;
before(async () => {
  photograph = await sharp({ create: { width: 1024, height: 1536, channels: 3, background: '#4a7aa8' } }).composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1536"><circle cx="600" cy="500" r="300" fill="#e3b04b"/><rect x="100" y="900" width="700" height="400" fill="#2d4a6b"/></svg>'), left: 0, top: 0 }]).png().toBuffer();
});

const request = (c, extra = {}) => buildDesignRequest({ ...BASE, caption: c.caption, objective: c.objective, planItem: c.planItem || null, ...extra });
const render = async (req, size = req.size) => composeDesign({ brief: req.brief, size, visual: req.brief.photography.required ? photograph : null });

describe('design-type matrix: path, headline, content, layout', () => {
  for (const [name, c] of Object.entries(CASES)) {
    test(`${name}: ${c.type} on ${c.layout}; ${c.photo ? 'asks for a photograph' : 'is composed without any image request'}; complete and not blank`, async () => {
      const req = request(c);
      assert.deepEqual(req.problems, [], 'a valid brief');
      const b = req.brief;
      assert.deepEqual([b.creativeType, b.layoutId], [c.type, c.layout]);
      assert.equal(b.photography.required, c.photo, 'a photograph is requested only where the layout carries one');
      assert.equal(!!req.visualPrompt, c.photo);
      assert.equal(b.headline, c.headline);
      if (c.cta) assert.equal(b.cta, c.cta);
      // every slot the layout must show was drawn, in both the platform's size and the other shape, with nothing cut or overflowing
      for (const size of [req.size, { width: 1024, height: 1024 }, { width: 1080, height: 1350 }]) {
        const r = await render(req, size);
        const drawn = new Set(r.report.texts.map((t) => t.label));
        for (const label of expectedLabels(b)) assert.ok(drawn.has(label), `${name} ${size.width}x${size.height}: ${label} was drawn`);
        assert.deepEqual([r.report.overflow, r.report.shortened], [[], []], `${name} ${size.width}x${size.height}`);
        const q = await assessRaster(r.buffer);
        assert.equal(q.blank, false);
        assert.ok(q.stdev > 25, `${name}: stdev ${q.stdev}`);
        const meta = await sharp(r.buffer).metadata();
        assert.deepEqual([meta.width, meta.height], [size.width, size.height]);
      }
    });
  }

  test('numbered: all five whole points are on the design; statistics: the figure is explained by its own sentence', () => {
    const n = request(CASES.numbered).brief;
    assert.equal(n.points.length, 5);
    assert.equal(n.figures.length, 0);
    const s = request(CASES.statistics).brief;
    assert.deepEqual(s.figures.map((f) => f.value), ['42%']);
    assert.match(s.figures[0].context, /Revenue per client rose 42% in a year/);
  });

  for (const [name, caption] of Object.entries(REFUSED)) {
    test(`${name}: there is nothing to build a headline from, so the brief is REFUSED before any image is paid for (never an empty design)`, async () => {
      const req = request({ caption, objective: 'engagement' });
      assert.ok(req.problems.length > 0, 'refused');
      assert.ok(req.problems.some((p) => /no headline/.test(p)));
      let called = 0;
      const provider = { generateImage: async () => { called += 1; throw new Error('must not be called'); } };
      // the service refuses on request.problems before producing; the producer itself also refuses a headline-less brief
      await assert.rejects(() => produceDesign({ request: { ...req, brief: { ...req.brief, photography: { ...req.brief.photography, required: false } } }, provider, generationId: 'g' }), (e) => e.code === 'DESIGN_COMPOSE_FAILED');
      assert.equal(called, 0);
    });
  }
});

describe('the real plan behind the reported post (a plan angle with "behind-the-scenes" in it)', () => {
  const PLAN = {
    contentType: 'educational', objective: 'awareness', contentPillar: 'Agency Growth & White-Label', topic: 'Signs your agency is ready for a white-label fulfillment partner', onCreativeText: 'Is your agency ready for a fulfillment partner?',
    angle: 'Help agency owners recognize the operational signals that mean it\'s time to bring in a behind-the-scenes fulfillment partner — before growth becomes a bottleneck.',
    deliverable: 'Educational carousel', hook: 'Most agencies hit a growth ceiling — not because of clients, but because of capacity. Here\'s what changes that.', primaryCta: 'Follow for weekly digital marketing insights',
    contentBrief: 'A six-slide carousel listing concrete signs that an agency\'s delivery capacity is falling behind its growth. Each slide covers one sign with a brief explanation.',
  };

  test('a numbered list stays a numbered infographic even though the plan\'s angle says "behind-the-scenes" (a business phrase, not a team post)', () => {
    const req = request({ caption: NUMBERED, objective: 'educational', planItem: PLAN });
    assert.deepEqual([req.brief.creativeType, req.brief.layoutId, req.brief.photography.required, req.brief.points.length, req.brief.figures.length], ['educational_list', 'infographic_points', false, 5, 0]);
    assert.equal(req.brief.headline, 'Is your agency ready for a fulfillment partner?', 'a question stays a question');
    assert.deepEqual(req.problems, []);
  });

  test('a real team post is still a team story: the plan says behind_the_scenes, or the caption is about the team and has no numbered list', () => {
    assert.equal(request({ caption: NUMBERED, objective: 'engagement', planItem: { contentType: 'behind_the_scenes' } }).brief.creativeType, 'team_story');
    assert.equal(request({ caption: 'Meet our team: the people who answer your calls every morning and make sure nothing slips.', objective: 'engagement' }).brief.creativeType, 'team_story');
  });
});

describe('optional elements are optional; required content is required', () => {
  test('a design with no logo, no contact line and no call to action is valid (nothing optional is demanded)', async () => {
    const req = request(CASES.photo);
    assert.equal(!!req.brief.cta, false, 'no call to action in the plan');
    assert.equal(Object.values(req.brief.contact || {}).filter(Boolean).length, 0, 'no contact details were supplied');
    const r = await composeDesign({ brief: req.brief, size: req.size, visual: photograph, logo: null });
    assert.equal(r.report.logoApplied, false);
    assert.deepEqual(req.problems, []);
  });

  test('with a call to action in the plan, an announcement shows it; a missing one is simply not drawn', async () => {
    const withCta = request(CASES.promotional);
    const r = await render(withCta);
    assert.ok(r.report.texts.some((t) => t.label === 'cta'));
    // no plan CTA: the post's own short call to action carries the button
    const fromCaption = request({ ...CASES.promotional, planItem: { contentType: 'hard_sell', objective: 'lead_generation' } });
    assert.equal(fromCaption.brief.cta, 'Book your free consultation today');
    // neither the plan nor the caption has one: no button is drawn (it is optional)
    const without = request({ caption: 'Introducing our new SEO Starter package, now open for new clients. Limited offer this month: a free site audit with every booking.', objective: 'lead_generation', planItem: { contentType: 'hard_sell', objective: 'lead_generation' } });
    assert.equal(!!without.brief.cta, false);
    assert.deepEqual(without.problems, []);
    assert.ok(!(await render(without)).report.texts.some((t) => t.label === 'cta'));
  });

  test('a photograph is never a hidden fallback: a structured design makes no provider request, and a photo design whose provider fails FAILS (no composed stand-in)', async () => {
    let calls = 0;
    const provider = { generateImage: async () => { calls += 1; throw Object.assign(new Error('AI_PROVIDER_TIMEOUT'), { code: 'AI_PROVIDER_TIMEOUT' }); } };
    const structured = request(CASES.numbered);
    const done = await produceDesign({ request: structured, provider, generationId: 'g' });
    assert.ok(done.png.length > 1000);
    assert.equal(calls, 0, 'composed programmatically: the image provider is not asked at all');
    const photoReq = request(CASES.photo);
    await assert.rejects(() => produceDesign({ request: photoReq, provider, generationId: 'g' }), (e) => e.code === 'AI_PROVIDER_TIMEOUT');
    assert.equal(calls, 1, 'asked once, failed, and nothing was composed in its place');
  });
});

describe('subtitles: whole sentences that add something', () => {
  test('a long caption\'s supporting line is a whole sentence (never "... marketing felt")', () => {
    const b = request(CASES.long).brief;
    assert.ok(b.subheadline === '' || /[a-z]$/.test(b.subheadline));
    assert.doesNotMatch(b.subheadline, /marketing felt$/);
    assert.ok(b.subheadline.split(' ').length <= 16);
  });

  test('a promotion\'s supporting line never repeats the headline (the headline is the first clause of its sentence)', () => {
    const b = request(CASES.promotional).brief;
    assert.equal(b.headline, 'Introducing our new SEO Starter package');
    assert.ok(!b.subheadline.toLowerCase().includes('introducing our new seo starter package'));
    assert.equal(b.subheadline, 'Limited offer this month: a free site audit with every booking');
  });
});

describe('layout defects found by the matrix stay fixed (pixel checks)', () => {
  const scan = async (buffer, fn) => {
    const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const out = [];
    for (let y = 0; y < info.height; y += 1) for (let x = 0; x < info.width; x += 1) { const i = (y * info.width + x) * info.channels; if (fn(data[i], data[i + 1], data[i + 2], x, y)) out.push([x, y]); }
    return out;
  };
  const orange = (r, g, b) => r > 210 && g > 70 && g < 120 && b < 40;
  const white = (r, g, b) => r > 238 && g > 238 && b > 238;

  test('quote: the opening quotation marks end ABOVE the first line of the quote', async () => {
    const req = request(CASES.quote);
    const { buffer } = await render(req);
    const marks = await scan(buffer, (r, g, b, x, y) => orange(r, g, b) && x < 400 && y < 560);
    const text = await scan(buffer, (r, g, b, x, y) => white(r, g, b) && y < 700);
    assert.ok(marks.length > 1000, 'the marks are drawn');
    const marksBottom = Math.max(...marks.map((p) => p[1]));
    const textTop = Math.min(...text.map((p) => p[1]));
    assert.ok(marksBottom < textTop, `marks end at ${marksBottom}, text starts at ${textTop}`);
  });

  test('promotion (wide): copy never reaches the photograph\'s ring', async () => {
    const req = request(CASES.promotional);
    const { buffer } = await render(req);
    const u = Math.min(req.size.width, req.size.height) / 100;
    const photoD = req.size.height * 0.62;
    const ringLeft = req.size.width * 0.78 - photoD / 2 - 1.4 * u;
    const textPixels = await scan(buffer, (r, g, b, x, y) => white(r, g, b) && x < ringLeft + 200 && y > req.size.height * 0.5 && y < req.size.height * 0.68);
    assert.ok(textPixels.length > 200, 'the supporting line is drawn');
    assert.ok(Math.max(...textPixels.map((p) => p[0])) < ringLeft - 8, `text reaches x=${Math.max(...textPixels.map((p) => p[0]))}, the ring starts at ${Math.round(ringLeft)}`);
  });
});
