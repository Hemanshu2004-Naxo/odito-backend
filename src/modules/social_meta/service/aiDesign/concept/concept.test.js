import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { validateConcepts, unsupportedClaims, setBriefProviderOverride, judgeHeadlines, awkwardHeadline } from './creativeBrief.js';
import { captionPoints, validateCarousel, generateCarousel, withConcurrency, slideOfError } from './carousel.js';
import { setQualityProviderOverride } from './conceptQuality.js';
import { composeConcept } from './conceptLayouts.js';
import { deterministicChecks, imageText } from './conceptQuality.js';
import { finalImagePrompt, renderConcept, classifyFailure } from './conceptPipeline.js';
import { conceptPipelineActive, recentConcepts } from './conceptDesign.js';
import { MAX_WORDS_PER_IMAGE, SINGLE_LAYOUTS } from './conceptConfig.js';
import { CONCEPT_SIZES } from '../designConfig.js';

/** The concept pipeline's own rules, without any provider: the brief validator, the strict overlay (never cuts text) and the QC's deterministic half. */


/** Scripted answer of the SPLIT carousel brief: the look + hook, or the ONE slide the prompt asks for. */
function splitAnswer(full, req) {
  if (req.tool.name === 'emit_carousel_look') return { big_idea: full.big_idea, visual_style: full.visual_style, world: full.world, hook: full.hook };
  const m = req.user.match(/Write ONLY point slide (\d+)/);
  return { slide: m ? full.points[Number(m[1]) - 1] : full.cta_slide };
}

const CAPTION = 'Most agencies hit a growth ceiling. Delivery work eats the hours that should go into selling. Here are the signs.';
const concept = (over = {}) => ({
  format: 'single_image', big_idea: 'A founder at a desk under a stack of client work that has hit the ceiling of a cramped office.',
  hook_headline: 'Out of room to grow?', subline: 'It\'s capacity.', cta: 'Read the signs', slides: [], visual_style: 'photo', layout: 'full_bleed_bottom', image_labels: [],
  headline_candidates: ['Out of room to grow?', 'Your agency has hit its limit.', 'Too busy delivering to grow.', 'Capacity, not clients, is the limit.', 'Growth needs room to breathe.'],
  image_prompt: 'Editorial photograph of a founder in a navy shirt at a desk under a towering stack of client folders that touches the low ceiling of a cramped office at dusk, warm window light, '
    + 'shallow depth of field, cinematic grading in navy and amber, the bottom 40% of the frame is calm dark floor for the headline.',
  why_it_works: 'A specific metaphor for the caption.', ...over,
});
const check = (list, opts = {}) => validateConcepts({ concepts: list }, { count: list.length, caption: CAPTION, ...opts });

async function photo(w, h, light = false) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${light ? '#f1f5f9' : '#334155'}"/><stop offset="1" stop-color="${light ? '#cbd5e1' : '#0f172a'}"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><circle cx="${w * 0.6}" cy="${h * 0.3}" r="${w * 0.15}" fill="#f59e0b" opacity="0.6"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
const BRAND = { name: 'Sapphire Digital Agency', primary: '#073B73', secondary: '#F4A62A', accent: '#E8590C', headingFont: 'Montserrat', bodyFont: 'Open Sans' };

describe('creative brief validation', () => {
  test('1: a good concept passes', () => {
    const r = check([concept()]);
    assert.deepEqual(r.errors, []);
  });
  test('2: a headline over 8 words, or copied from the caption, is rejected', () => {
    assert.ok(check([concept({ hook_headline: 'This is a very long headline with far too many words' })]).errors.some((e) => /at most 8/.test(e)));
    assert.ok(check([concept({ hook_headline: 'Most agencies hit a growth ceiling.', headline_candidates: ['Most agencies hit a growth ceiling.', ...concept().headline_candidates.slice(1)] })]).errors.some((e) => /copied from the caption/.test(e)));
  });
  test('3: a figure or promise not in the caption/facts is rejected; one that is stated passes', () => {
    assert.ok(check([concept({ hook_headline: 'Grow 3x in 90 days.', headline_candidates: ['Grow 3x in 90 days.', ...concept().headline_candidates.slice(1)] })]).errors.some((e) => /not stated/.test(e)));
    assert.ok(unsupportedClaims('Guaranteed results', CAPTION).length > 0);
    assert.deepEqual(unsupportedClaims('Serving 40 agencies', `${CAPTION}\nWe work with 40 agencies.`), []);
  });
  test('4: clichés (incl. generic stock group photos) are rejected, but a prompt that says to AVOID one is fine', () => {
    assert.ok(check([concept({ image_prompt: `${concept().image_prompt} Two business people shaking hands in a handshake.` })]).errors.some((e) => /cliché/.test(e)));
    assert.ok(check([concept({ image_prompt: `${concept().image_prompt} A diverse team smiling around a laptop.` })]).errors.some((e) => /cliché/.test(e)));
    assert.deepEqual(check([concept({ image_prompt: `${concept().image_prompt} No handshake, no lightbulb.` })]).errors, []);
  });
  test('5: the word budget: a subline that breaks 15 words is dropped, not cut', () => {
    const r = check([concept({ hook_headline: 'Your agency is out of room.', headline_candidates: ['Your agency is out of room.', ...concept().headline_candidates.slice(1)], subline: 'Here is what really breaks through it today, step by step.', cta: 'See the signs now' })]);
    assert.equal(r.concepts[0].subline, '');
    assert.ok(r.adjusted.some((a) => /subline dropped/.test(a)));
  });
  test('6: rotation: the same style + layout as the most recent design is rejected; several concepts need different layouts', () => {
    assert.ok(check([concept()], { recent: [{ visual_style: 'photo', layout: 'full_bleed_bottom' }] }).errors.some((e) => /repeats/.test(e)));
    assert.ok(check([concept(), concept({ big_idea: 'An overflowing in-tray on a desk at midnight, the founder\'s hands sorting it.' })]).errors.some((e) => /different layout/.test(e)));
  });
});

describe('the overlay never cuts text', () => {
  for (const layout of Object.keys(SINGLE_LAYOUTS).filter((l) => !['proof_stat', 'infographic_image'].includes(l))) {
    test(`7 (${layout}): every text is drawn whole, inside the canvas, at the platform size`, async () => {
      const size = CONCEPT_SIZES.portrait;
      const { buffer, report } = await composeConcept({ brief: concept({ layout }), image: await photo(1088, 1360), size, brand: BRAND });
      const meta = await sharp(buffer).metadata();
      assert.deepEqual([meta.width, meta.height], [size.width, size.height]);
      const det = deterministicChecks({ brief: concept({ layout }), report, caption: CAPTION, facts: '' });
      assert.deepEqual(det.problems, []);
      assert.ok(report.texts.some((t) => t.label === 'headline'));
      assert.ok(report.texts.find((t) => t.label === 'headline').size >= 64);
    });
  }
  test('8: a headline that cannot fit is a TEXT_DOES_NOT_FIT error, never a shortened headline', async () => {
    const long = 'Unbelievablyextraordinarilylongword Incomprehensibilitiesnessly Antidisestablishmentarianism Pneumonoultramicroscopic';
    await assert.rejects(composeConcept({ brief: concept({ hook_headline: long, layout: 'split_image_text' }), image: await photo(1088, 1360), size: CONCEPT_SIZES.portrait, brand: BRAND }), (e) => e.code === 'TEXT_DOES_NOT_FIT');
  });
  test('9: the wordmark gets a plate when the picture behind it is too light for its colour', async () => {
    const { report } = await composeConcept({ brief: concept({ layout: 'full_bleed_bottom' }), image: await photo(1088, 1360, true), size: CONCEPT_SIZES.portrait, brand: BRAND });
    assert.equal(report.mark.kind, 'wordmark');
    assert.ok(report.mark.plate || report.mark.color !== '#ffffff', 'a light background never gets a bare white wordmark');
  });
});

describe('quality check - the deterministic half', () => {
  test('10: only what was DRAWN is counted and expected (a kicker the layout did not draw is not)', () => {
    const brief = { ...concept(), kicker: 'Agency Growth & White-Label' };
    const report = { width: 1080, height: 1350, texts: [{ label: 'headline', x: 60, y: 900, width: 800, height: 200 }, { label: 'subline', x: 60, y: 1110, width: 400, height: 40 }, { label: 'cta', x: 60, y: 1170, width: 300, height: 40 }] };
    assert.doesNotMatch(imageText(brief, report), /Agency Growth/);
    assert.match(imageText(brief, null), /Agency Growth/);
  });
  test('11: more than 15 words, text outside the canvas, or an unsupported figure are problems; cut-off text is a hard problem', () => {
    const many = { ...concept(), hook_headline: 'one two three four five six seven eight', subline: 'nine ten eleven twelve thirteen fourteen', cta: 'fifteen sixteen' };
    assert.ok(deterministicChecks({ brief: many, report: null, caption: CAPTION }).problems.some((p) => new RegExp(`max ${MAX_WORDS_PER_IMAGE}`).test(p)));
    const off = { width: 1080, height: 1350, texts: [{ label: 'headline', x: 60, y: 1300, width: 800, height: 120 }] };
    assert.ok(deterministicChecks({ brief: concept(), report: off, caption: CAPTION }).problems.some((p) => /cut off/.test(p)));
    assert.ok(deterministicChecks({ brief: concept({ hook_headline: 'Double revenue by 200%.' }), report: null, caption: CAPTION }).problems.some((p) => /not supported/.test(p)));
  });
});

describe('the image prompt and the switches', () => {
  test('12: the prompt sent to the model forbids text, names the empty zone, the palette and the clichés', () => {
    const p = finalImagePrompt(concept(), BRAND);
    assert.match(p, /Absolutely no text/);
    assert.match(p, /bottom 40%/);
    assert.match(p, /#073B73/);
    assert.match(p, /handshake/i);
  });
  test('13: SOCIAL_AI_DESIGN_PIPELINE=rules switches it off; a substituted image provider needs a substituted brief provider', () => {
    const saved = process.env.SOCIAL_AI_DESIGN_PIPELINE;
    try {
      delete process.env.SOCIAL_AI_DESIGN_PIPELINE;
      assert.equal(conceptPipelineActive(), true);
      assert.equal(conceptPipelineActive({ imageProviderOverridden: true }), false);
      process.env.SOCIAL_AI_DESIGN_PIPELINE = 'rules';
      assert.equal(conceptPipelineActive(), false);
    } finally { if (saved === undefined) delete process.env.SOCIAL_AI_DESIGN_PIPELINE; else process.env.SOCIAL_AI_DESIGN_PIPELINE = saved; }
  });
  test('14: recent designs for rotation come from stored concepts only', () => {
    assert.deepEqual(recentConcepts([{ creative: { concept: { layout: 'editorial_cover', visual_style: 'photo', big_idea: 'x' } } }, { creative: { concept: {} } }, {}]), [{ layout: 'editorial_cover', visual_style: 'photo', big_idea: 'x' }]);
  });
});

describe('step 3 review fixes', () => {
  test('15: sensitive metaphors are refused (a glass ceiling reads as discrimination); a prompt that rules one OUT is fine', () => {
    const glass = check([concept({ big_idea: 'A woman pressing against a glass ceiling.', image_prompt: `${concept().image_prompt} She presses both palms against a low glass ceiling.` })]);
    assert.ok(glass.errors.some((e) => /glass ceiling/.test(e) && /discrimination/.test(e)));
    assert.ok(check([concept({ image_prompt: `${concept().image_prompt} Chains around the desk.` })]).errors.some((e) => /slavery/.test(e)));
    assert.deepEqual(check([concept({ image_prompt: `${concept().image_prompt} No glass ceiling, no flags.` })]).errors, []);
  });
  test('16: one style per image - an illustration with a blurred photo background is refused', () => {
    const mixed = check([concept({ visual_style: 'editorial_illustration', image_prompt: 'A flat editorial illustration of an overflowing in-tray on a desk, navy and orange shapes, grain texture, in front of a blurred photo of an open-plan office with bokeh lights, the top 35% empty for the headline text.' })]);
    assert.ok(mixed.errors.some((e) => /one style per image/.test(e)));
    assert.deepEqual(check([concept({ visual_style: 'editorial_illustration', image_prompt: 'A flat editorial illustration of an overflowing in-tray on a desk, navy and orange geometric shapes, grain texture, on a solid pale-blue illustrated background, no photographic elements, the top 35% empty for the headline text.' })]).errors, []);
  });
  test('17: readable symbols - a before/after needs two labels on different sides, a split picture for left/right labels, and nothing that needs writing in the picture', () => {
    const split = 'A 3D split composition: the left half a tangled corkboard of tasks, the right half the same board, calm and in order, soft studio light, navy and amber, the bottom 40% of the frame is a calm, empty, softly lit studio floor for the text.';
    assert.ok(check([concept({ visual_style: '3d_render', layout: 'split_image_text', big_idea: 'Before and after: chaos vs order.', image_prompt: split })]).errors.some((e) => /two image labels/.test(e)));
    assert.deepEqual(check([concept({ visual_style: '3d_render', layout: 'split_image_text', big_idea: 'Before and after: chaos vs order.', image_prompt: split, image_labels: [{ text: 'Before', position: 'left' }, { text: 'After', position: 'right' }] })]).errors, []);
    assert.ok(check([concept({ image_prompt: `${concept().image_prompt} A note saying No Vacancy is pinned to the door.` })]).errors.some((e) => /writing inside the picture/.test(e)));
    assert.deepEqual(check([concept({ image_prompt: `${concept().image_prompt} Soft light from a window on the left.` })]).errors, [], 'lighting "on the left" is not a comparison');
  });
  test('18: awkward headlines (riddles, personified abstractions) are recognised; plain ones are not', () => {
    assert.equal(awkwardHeadline("Your ceiling isn't clients."), true);
    assert.equal(awkwardHeadline('Delivery work is running you.'), true);
    assert.equal(awkwardHeadline('Your agency is out of room to grow'), false);
    const r = check([concept({ hook_headline: "Your ceiling isn't clients.", headline_candidates: ["Your ceiling isn't clients.", ...concept().headline_candidates.slice(1)] })]);
    assert.equal(r.concepts[0].hook_headline, 'Your agency has hit its limit.');
  });
  test('19: the judge picks the most natural usable candidate; a set with no natural one has no pick', async () => {
    setBriefProviderOverride({ async generateStructured() { return { parsed: { sets: [
      { id: 'a', scores: [{ headline: 'A one', natural: 3, clear: 5, fits: 5, issue: 'stiff' }, { headline: 'A two', natural: 5, clear: 4, fits: 4, issue: '' }] },
      { id: 'b', scores: [{ headline: 'B one', natural: 2, clear: 2, fits: 2, issue: 'riddle' }] },
    ] }, model: 'claude-sonnet-4-6', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 }; } });
    try {
      const r = await judgeHeadlines({ caption: CAPTION, sets: [{ id: 'a', candidates: ['A one', 'A two'] }, { id: 'b', candidates: ['B one'] }] });
      assert.equal(r.picks.a.headline, 'A two');
      assert.equal(r.picks.b.headline, null);
      assert.equal(r.call.step, 'headline_judge');
    } finally { setBriefProviderOverride(null); }
  });
  test('20: at most one solid-panel layout in any three designs, and among compared concepts', () => {
    const solid = concept({ layout: 'split_image_text' });
    assert.ok(check([solid], { recent: [{ visual_style: '3d_render', layout: 'full_bleed_bottom' }, { visual_style: 'photo', layout: 'big_type_statement' }] }).errors.some((e) => /solid-panel/.test(e)));
    assert.deepEqual(check([solid], { recent: [{ visual_style: '3d_render', layout: 'full_bleed_bottom' }, { visual_style: 'photo', layout: 'editorial_cover' }, { visual_style: 'photo', layout: 'big_type_statement' }] }).errors, []);
    const two = check([concept({ layout: 'split_image_text' }), concept({ layout: 'big_type_statement', big_idea: 'An hourglass on an empty desk beside an unfilled chair at night.' })]);
    assert.ok(two.errors.some((e) => /at most one concept may use a solid-panel/.test(e)));
  });
  test('21: text over busy pixels gets a plate; the accent rule is not drawn over detail', async () => {
    const W = 1088; const H = 1360;
    const stripes = Array.from({ length: 80 }, (_, i) => `<rect x="0" y="${i * 17}" width="${W}" height="8" fill="${i % 2 ? '#111827' : '#f8fafc'}"/>`).join('');
    const busy = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${stripes}</svg>`)).png().toBuffer();
    const { report } = await composeConcept({ brief: concept({ layout: 'editorial_cover' }), image: busy, size: CONCEPT_SIZES.portrait, brand: BRAND });
    assert.equal(report.plate, true);
    assert.equal(report.rule, false);
    const calm = await composeConcept({ brief: concept({ layout: 'editorial_cover' }), image: await photo(1088, 1360, true), size: CONCEPT_SIZES.portrait, brand: BRAND });
    assert.equal(calm.report.plate, false);
  });
});

describe('carousel', () => {
  const POST = ['Most agencies hit a growth ceiling.', '', '1. You\'re turning down new service requests', 'Not because of fit.', '2. Your team is stretched across too many services', '3. Delivery quality is slipping under volume',
    '4. Hiring feels too slow and too costly', '5. You\'re doing delivery work instead of sales work', '', 'Which of these signs sounds familiar? Drop your answer in the comments.'].join('\n');
  const slideOf = (headline, extra = {}) => ({ headline_candidates: [headline, `${headline} today`, `So: ${headline}`, `Now ${headline}`, `${headline} again`], headline, image_prompt: 'The same cramped low-ceilinged office at dusk, warm desk lamp and cool window light, navy and orange palette, one clear subject on the desk, the bottom 45% a darker calm desk front with no objects.', image_labels: [], ...extra });
  const QUOTES = ["You're turning down new service requests", 'Your team is stretched across too many services', 'Delivery quality is slipping under volume', 'Hiring feels too slow and too costly', "You're doing delivery work instead of sales work"];
  const RAW = () => ({
    big_idea: 'A cramped low-ceilinged agency office where client work has hit the ceiling.', visual_style: 'photo', world: 'One cramped office at dusk, warm lamp, navy walls.',
    hook: slideOf('Your agency is out of room to grow', { subline: '', cta: 'Swipe for the signs' }),
    points: QUOTES.map((q, i) => slideOf(['Turning down work you could win', 'One team, too many services', 'Quality slips under the volume', 'Hiring takes months and money', 'Doing delivery instead of selling'][i], { number: i + 1, from_caption: q, visual_idea: ['A phone left ringing on a full desk', 'One small desk buried under work for every service', 'A coffee-stained draft on top of a pile', 'An hourglass beside an empty chair', 'A founder typing while the sales folder gathers dust'][i] })),
    cta_slide: slideOf('Which sign sounds familiar?', { subline: '', cta: 'Tell us in the comments' }),
  });

  test('22: the caption\'s numbered points are found in order', () => {
    assert.deepEqual(captionPoints(POST).map((p) => p.number), [1, 2, 3, 4, 5]);
  });
  test('23: a valid carousel passes; a point not quoted from the caption, an invented figure or a missing slide is refused', () => {
    const points = captionPoints(POST);
    assert.deepEqual(validateCarousel(RAW(), { caption: POST, points }).errors, []);
    const bad = RAW(); bad.points[2] = { ...bad.points[2], from_caption: 'Clients love fast turnaround' };
    assert.ok(validateCarousel(bad, { caption: POST, points }).errors.some((e) => /quote the caption/.test(e)));
    const figure = RAW(); figure.points[0] = { ...figure.points[0], headline: 'Lose 40% of new requests', headline_candidates: ['Lose 40% of new requests', ...figure.points[0].headline_candidates.slice(1)] };
    assert.ok(validateCarousel(figure, { caption: POST, points }).errors.some((e) => /40%/.test(e)));
    const short = RAW(); short.points.pop();
    assert.ok(validateCarousel(short, { caption: POST, points }).errors.some((e) => /exactly 5 point slides/.test(e)));
    const long = RAW(); long.points[1] = { ...long.points[1], headline: 'One small team is now stretched across far too many specialist services every week', headline_candidates: ['One small team is now stretched across far too many specialist services every week'] };
    assert.ok(validateCarousel(long, { caption: POST, points }).errors.some((e) => /at most 12/.test(e)));
  });
  test('24: the HOOK picture is made first and is the reference image of every other slide; 7 slides, a QC per slide, costs add up', async () => {
    const judge = (req) => ({ sets: (req.user.match(/<set id="([^"]+)"/g) || []).map((m) => m.match(/"([^"]+)"/)[1]).map((id) => {
      const block = req.user.split(`<set id="${id}"`)[1].split('</set>')[0];
      return { id, scores: block.split('\n').filter((l) => l.startsWith('- ')).map((l) => ({ headline: l.slice(2), natural: 5, clear: 5, fits: 5, issue: '' })) };
    }) });
    setBriefProviderOverride({ async generateStructured(req) { return { parsed: req.tool.name === 'judge_headlines' ? judge(req) : splitAnswer(RAW(), req), model: 'claude-sonnet-4-6', usage: { inputTokens: 1000, outputTokens: 500 }, durationMs: 1 }; } });
    setQualityProviderOverride({ async generateStructured() { return { parsed: { score: 8, readable_at_phone_size: true, spelling_errors: [], word_count: 9, matches_big_idea: true, ai_artifacts: [], looks_stock_or_template: false, on_brand: true, invented_facts: [], cut_off_text: false, text_over_busy_area: false, sensitive_reading: [], mixed_styles: false, unclear_symbols: [], headline_awkward: false, issues: [] }, model: 'claude-sonnet-4-6', usage: { inputTokens: 1500, outputTokens: 200 }, durationMs: 1 }; } });
    const order = [];
    const provider = { async generateImage({ prompt, referenceImages }) {
      order.push({ refs: referenceImages.length, ref: /reference image ONLY for continuity/.test(prompt) });
      return { buffer: await photo(1088, 1360), usage: { textInputTokens: 400, imageInputTokens: referenceImages.length ? 1500 : 0, imageOutputTokens: 1300, inputTokens: 400, outputTokens: 1300 }, model: 'gpt-image-2.6-flare', modelReturned: null, durationMs: 1 };
    } };
    try {
      const run = await generateCarousel({ input: { caption: POST, facts: '', platform: 'instagram' }, provider, brand: BRAND });
      assert.equal(run.slides.length, 7);
      assert.deepEqual(order[0], { refs: 0, ref: false }, 'the hook is generated first, without a reference');
      assert.equal(order.slice(1).every((o) => o.refs === 1 && o.ref), true, 'every other slide uses the hook as its reference');
      assert.deepEqual(run.slides.map((x) => x.kind), ['hook', 'point', 'point', 'point', 'point', 'point', 'cta']);
      assert.equal(run.slides.every((x) => x.qc.passed && x.qc.score === 8), true);
      assert.deepEqual(run.slides[2].report.texts.map((t) => t.label).sort(), ['counter', 'headline', 'number', 'wordmark']);
      assert.ok(run.costUsd > 0);
      assert.equal(Math.round((run.brief.costUsd + run.slides.reduce((s, x) => s + x.costUsd, 0)) * 10_000) / 10_000, run.costUsd);
    } finally { setBriefProviderOverride(null); setQualityProviderOverride(null); }
  });
});

describe('retries, needs-attention, brief repair before images, speed', () => {
  const QC = (over = {}) => ({ score: 8, readable_at_phone_size: true, spelling_errors: [], word_count: 9, matches_big_idea: true, ai_artifacts: [], looks_stock_or_template: false, on_brand: true, invented_facts: [], cut_off_text: false, text_over_busy_area: false, sensitive_reading: [], mixed_styles: false, unclear_symbols: [], headline_awkward: false, issues: [], ...over });
  const scriptedQc = (list) => { let n = 0; return { async generateStructured() { const parsed = list[Math.min(n, list.length - 1)]; n += 1; return { parsed, model: 'claude-sonnet-4-6', usage: { inputTokens: 1500, outputTokens: 200 }, durationMs: 1 }; } }; };
  const imageProvider = (log = []) => ({ log, async generateImage({ prompt, referenceImages = [] }) { log.push({ prompt, refs: referenceImages.length, at: Date.now() }); return { buffer: await photo(1088, 1360), usage: { textInputTokens: 400, imageInputTokens: 0, imageOutputTokens: 1300 }, model: 'gpt-image-2.6-flare', modelReturned: null, durationMs: 1 }; } });

  test('25: why a design failed decides the retry: meaning -> concept, execution -> picture, headline -> words', () => {
    const qc = (checks, extra = {}) => ({ passed: false, hardFail: false, checks, issues: [], deterministic: { problems: [] }, ...extra });
    assert.equal(classifyFailure(qc(QC({ matches_big_idea: false }))), 'meaning');
    assert.equal(classifyFailure(qc(QC({ unclear_symbols: ['five unlabelled icons'] }))), 'meaning');
    assert.equal(classifyFailure(qc(QC(), { issues: ['sensitive reading: reads as discrimination'] })), 'meaning');
    assert.equal(classifyFailure(qc(QC({ ai_artifacts: ['fused fingers'] }))), 'execution');
    assert.equal(classifyFailure(qc(QC({ text_over_busy_area: true }))), 'execution');
    assert.equal(classifyFailure(qc(QC({ headline_awkward: true }))), 'headline');
    assert.equal(classifyFailure(qc(QC({ matches_big_idea: false, ai_artifacts: ['hands'] }))), 'meaning', 'a new idea also gets a new picture');
  });

  test('26: meaning failure -> ONE concept retry (back to the brief with the QC feedback), then a new picture', async () => {
    setQualityProviderOverride(scriptedQc([QC({ score: 6, unclear_symbols: ['the phone does not say "turned away"'], issues: ['the idea does not land'] }), QC({ score: 8 })]));
    const revisions = [];
    const prov = imageProvider();
    try {
      const out = await renderConcept({
        concept: concept(), provider: prov, brand: BRAND, caption: CAPTION, facts: '',
        reviseConcept: async ({ qc }) => { revisions.push(qc.issues); return { concept: { big_idea: 'A founder saying no on the phone', image_prompt: `${concept().image_prompt} LITERAL-VERSION` }, calls: [{ step: 'concept_retry', model: 'claude-sonnet-4-6', usage: { inputTokens: 10, outputTokens: 10 } }] }; },
      });
      assert.equal(revisions.length, 1);
      assert.ok(revisions[0].some((i) => /unclear symbols/.test(i)));
      assert.equal(prov.log.length, 2);
      assert.match(prov.log[1].prompt, /LITERAL-VERSION/);
      assert.deepEqual(out.retries, ['concept']);
      assert.deepEqual(out.calls.map((c) => c.step), ['image', 'quality_check', 'concept_retry', 'image_concept_retry', 'quality_check']);
      assert.equal(out.qc.score, 8);
      assert.equal(out.needsAttention, null);
    } finally { setQualityProviderOverride(null); }
  });

  test('27: execution failure -> a picture retry of the SAME concept (no brief call); still below 8 -> needs attention with the reason', async () => {
    setQualityProviderOverride(scriptedQc([QC({ score: 6, ai_artifacts: ['fused fingers'], issues: ['hands look wrong'] }), QC({ score: 7, ai_artifacts: ['fused fingers'], issues: ['hands still look wrong'] })]));
    let revised = 0;
    const prov = imageProvider();
    try {
      const out = await renderConcept({ concept: concept(), provider: prov, brand: BRAND, caption: CAPTION, facts: '', reviseConcept: async () => { revised += 1; return { concept: {}, calls: [] }; } });
      assert.equal(revised, 0);
      assert.equal(prov.log.length, 2);
      assert.match(prov.log[1].prompt, /Fix these problems/);
      assert.deepEqual(out.retries, ['picture']);
      assert.equal(out.qc.passed, false);
      assert.deepEqual(out.needsAttention, { score: 7, failure: 'execution', reasons: out.needsAttention.reasons });
      assert.ok(out.needsAttention.reasons.some((r) => /hands/.test(r)));
    } finally { setQualityProviderOverride(null); }
  });

  test('28: a slide that breaks a rule is repaired in the BRIEF step, before any image; the judge runs while the hook picture is made', async () => {
    const POST = ['Most agencies hit a growth ceiling.', '1. You\'re turning down new service requests', '2. Your team is stretched across too many services', '3. Delivery quality is slipping under volume', '', 'Drop your answer in the comments.'].join('\n');
    const slide = (h, extra = {}) => ({ headline_candidates: [h, `${h} now`, `So, ${h}`, `${h} today`, `${h} again`], headline: h, image_prompt: 'The same cramped office at dusk, warm desk lamp, navy walls, one clear subject on the desk, the bottom 45% a darker calm desk front with no objects.', image_labels: [], symbols: [], ...extra });
    const raw = {
      big_idea: 'A cramped office where client work has hit the ceiling.', visual_style: 'photo', world: 'One cramped office at dusk.',
      hook: slide('Your agency is out of room to grow', { subline: '', cta: 'Swipe for the signs' }),
      points: [
        slide('Turning down work you could win', { number: 1, from_caption: "You're turning down new service requests", visual_idea: 'A founder declining a call at a full desk' }),
        slide('One team, too many services', { number: 2, from_caption: 'Your team is stretched across too many services', visual_idea: 'Five service icons lined up on one desk' }),
        slide('Quality slips under the volume', { number: 3, from_caption: 'Delivery quality is slipping under volume', visual_idea: 'A coffee-stained draft on top of a tall pile' }),
      ],
      cta_slide: slide('Which sign sounds familiar?', { subline: '', cta: 'Tell us in the comments' }),
    };
    const timeline = [];
    let releaseJudge;
    const judgeGate = new Promise((r) => { releaseJudge = r; });
    setBriefProviderOverride({ async generateStructured(req) {
      const done = (parsed) => ({ parsed, model: 'claude-sonnet-4-6', usage: { inputTokens: 1000, outputTokens: 300 }, durationMs: 1 });
      if (req.tool.name === 'emit_carousel_look') { timeline.push('brief'); return done(splitAnswer(raw, req)); }
      if (req.tool.name === 'emit_carousel_slide') { timeline.push('slide-brief'); return done(splitAnswer(raw, req)); }
      if (req.tool.name === 'emit_revised_slide') { timeline.push('repair'); return done({ visual_idea: 'One person at a small desk buried under work for every service', image_prompt: slide('x').image_prompt, image_labels: [], symbols: [], headline_candidates: raw.points[1].headline_candidates, headline: raw.points[1].headline }); }
      if (req.tool.name === 'judge_headlines') {
        timeline.push('judge-start');
        await judgeGate;
        timeline.push('judge-end');
        const ids = [...req.user.matchAll(/<set id="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/set>/g)];
        return done({ sets: ids.map((m) => ({ id: m[1], scores: m[2].split('\n').map((l) => ({ headline: l.replace(/^- /, ''), natural: 5, clear: 5, fits: 5, issue: '' })) })) });
      }
      throw new Error(`unexpected tool ${req.tool.name}`);
    } });
    setQualityProviderOverride(scriptedQc([QC()]));
    const prov = { async generateImage(a) { timeline.push(`image${a.referenceImages?.length ? '-ref' : ''}`); if (timeline.filter((t) => t === 'image').length === 1) setTimeout(() => releaseJudge(), 5); return imageProvider().generateImage(a); } };
    try {
      const run = await generateCarousel({ input: { caption: POST, facts: '', platform: 'instagram' }, provider: prov, brand: BRAND });
      // split brief: the hook picture starts while the point slides are written; a broken slide is repaired before ITS image (no image wasted)
      assert.ok(timeline.indexOf('repair') > timeline.indexOf('slide-brief') && timeline.indexOf('repair') < timeline.indexOf('image-ref'), 'the rule break is fixed before the image of that slide');
      assert.ok(timeline.indexOf('image') < timeline.lastIndexOf('slide-brief') || timeline.indexOf('image') < timeline.indexOf('repair'), 'the hook picture starts before the other slides are ready');
      assert.ok(timeline.indexOf('image') < timeline.indexOf('judge-end'), 'the hook picture is made while the judge runs');
      assert.deepEqual(run.brief.repairs.map((r) => r.slide), ['p2']);
      assert.equal(run.slides.length, 5);
      assert.equal(run.needsAttention.length, 0);
      assert.equal(slideOfError('point slide 2: x'), 'p2');
      assert.equal(slideOfError('visual_style must be one of'), null);
    } finally { setBriefProviderOverride(null); setQualityProviderOverride(null); }
  });

  test('29: slides run in parallel, never more than the concurrency limit at once', async () => {
    let running = 0; let peak = 0;
    const task = () => async () => { running += 1; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 15)); running -= 1; return peak; };
    await withConcurrency(Array.from({ length: 6 }, task), 3);
    assert.equal(peak, 3);
    running = 0; peak = 0;
    await withConcurrency(Array.from({ length: 6 }, task), 6);
    assert.equal(peak, 6);
  });
});
