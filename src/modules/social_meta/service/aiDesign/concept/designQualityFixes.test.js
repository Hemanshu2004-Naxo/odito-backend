import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { setQualityProviderOverride, checkDesignQuality } from './conceptQuality.js';
import { composeConcept, accentRulePlacement } from './conceptLayouts.js';
import { renderConcept, classifyFailure } from './conceptPipeline.js';
import { stripWebAddresses, withoutWebAddresses, bareDomain } from './webAddress.js';
import { CONCEPT_SIZES } from '../designConfig.js';

/**
 * Design-quality fixes from a live post (Nov 2026, "Three things holding your website back"): a three-legged stool (= stability) under a
 * headline about problems passed QC; "https://…/" was printed on the image; a floating underline sat under the CTA.
 */

const CAPTION = 'Three things holding your website back. Slow pages, weak titles and no internal links. Which one is hurting yours?';
const BRAND = { name: 'Oditoai', primary: '#073B73', secondary: '#F4A62A', accent: '#E8590C', headingFont: 'Montserrat', bodyFont: 'Open Sans' };
async function photo(w, h, light = false) {
  // a gradient + one shape (a flat colour would be refused as a blank picture)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${light ? '#f1f5f9' : '#334155'}"/><stop offset="1" stop-color="${light ? '#cbd5e1' : '#0f172a'}"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><circle cx="${w * 0.6}" cy="${h * 0.3}" r="${w * 0.15}" fill="#f59e0b" opacity="0.6"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
const concept = (over = {}) => ({
  format: 'single_image', big_idea: 'A small website on a desk held down by three heavy anchors.', hook_headline: 'What is holding your site back?', subline: '', cta: 'See the three', visual_style: '3d_render', layout: 'editorial_cover', image_labels: [],
  headline_candidates: ['What is holding your site back?'], image_prompt: 'A 3D render of a small website window on a desk held down by three heavy anchors, solid navy background, the top 40% plain.', ...over,
});
const QC = (over = {}) => ({ score: 8, readable_at_phone_size: true, spelling_errors: [], word_count: 9, matches_big_idea: true, supports_message: true, message_mismatch: '', ai_artifacts: [], looks_stock_or_template: false, on_brand: true, invented_facts: [], cut_off_text: false, text_over_busy_area: false, sensitive_reading: [], mixed_styles: false, unclear_symbols: [], headline_awkward: false, issues: [], ...over });
const scriptedQc = (list) => { let n = 0; const seen = []; return { seen, async generateStructured(req) { seen.push(req); const parsed = list[Math.min(n, list.length - 1)]; n += 1; return { parsed, model: 'claude-sonnet-4-6', usage: { inputTokens: 1500, outputTokens: 200 }, durationMs: 1 }; } }; };
const imageProvider = (log = []) => ({ log, async generateImage({ prompt }) { log.push({ prompt }); return { buffer: await photo(1088, 1360), usage: { textInputTokens: 400, imageInputTokens: 0, imageOutputTokens: 1300 }, model: 'gpt-image-2.6-flare', modelReturned: null, durationMs: 1 }; } });

describe('QC: the visual must support the headline\'s MESSAGE, not just its keywords', () => {
  test('the QC tool asks it (with the stool example) and a "no" caps the score below passing', async () => {
    const qc = scriptedQc([QC({ score: 9, supports_message: false, message_mismatch: 'a three-legged stool means stability; the headline is about problems' })]);
    setQualityProviderOverride(qc);
    try {
      const out = await checkDesignQuality({ png: await photo(1080, 1350), brief: concept(), report: null, caption: CAPTION, facts: '', brand: BRAND });
      const schema = qc.seen[0].tool.schema;
      assert.ok(schema.required.includes('supports_message'));
      assert.match(schema.properties.supports_message.description, /three-legged stool/);
      assert.equal(out.passed, false);
      assert.ok(out.score <= 6);
      assert.ok(out.issues.some((i) => /meaning mismatch/.test(i) && /stability/.test(i)));
      assert.equal(classifyFailure(out), 'meaning');
    } finally { setQualityProviderOverride(null); }
  });

  test('a meaning mismatch triggers ONE concept retry (back to the brief), then a new picture', async () => {
    setQualityProviderOverride(scriptedQc([QC({ score: 8, supports_message: false, message_mismatch: 'stool = stability' }), QC({ score: 8 })]));
    const revisions = [];
    const prov = imageProvider();
    try {
      const out = await renderConcept({
        concept: concept({ big_idea: 'A three-legged stool.' }), provider: prov, brand: BRAND, caption: CAPTION, facts: '',
        reviseConcept: async ({ qc }) => { revisions.push(qc.issues); return { concept: { big_idea: 'A website weighed down by three anchors', image_prompt: `${concept().image_prompt} ANCHORS` }, calls: [] }; },
      });
      assert.equal(revisions.length, 1);
      assert.ok(revisions[0].some((i) => /meaning mismatch/.test(i)));
      assert.deepEqual(out.retries, ['concept']);
      assert.match(prov.log[1].prompt, /ANCHORS/);
      assert.equal(out.qc.passed, true);
    } finally { setQualityProviderOverride(null); }
  });
});

describe('no raw URL as text on the image', () => {
  test('addresses are removed from every drawn text, with the words that only pointed at them', () => {
    assert.deepEqual(withoutWebAddresses('Visit https://oditoai.com/'), { text: '', found: ['https://oditoai.com/'] });
    assert.equal(withoutWebAddresses('Book a free audit at www.oditoai.com today').text, 'Book a free audit today');
    assert.equal(withoutWebAddresses('Read more on oditoai.com/blog').text, 'Read more');
    assert.equal(withoutWebAddresses('Fix your titles first').text, 'Fix your titles first');
    assert.equal(bareDomain('https://www.OditoAI.com/seo/?x=1'), 'oditoai.com');
    const { brief, domain } = stripWebAddresses({ hook_headline: 'Fix it', subline: 'Details at https://oditoai.com/', cta: 'Visit oditoai.com', image_labels: [{ text: 'www.oditoai.com', position: 'top' }] });
    assert.deepEqual([brief.subline, brief.cta, brief.image_labels.length, domain], ['Details', '', 0, 'oditoai.com']);
  });

  test('a single image shows the bare domain small in the footer (once); a carousel point slide never does', async () => {
    setQualityProviderOverride(scriptedQc([QC()]));
    try {
      const single = await renderConcept({ concept: concept({ layout: 'full_bleed_bottom', cta: 'Visit https://oditoai.com/' }), provider: imageProvider(), brand: BRAND, caption: CAPTION, facts: '', qcRetries: 0 });
      assert.equal(single.concept.cta, '', 'the address is not drawn as the CTA');
      assert.ok(!single.report.texts.some((t) => t.label === 'cta'));
      const domains = single.report.texts.filter((t) => t.label === 'domain');
      assert.equal(domains.length, 1);
      assert.equal(single.report.footerDomain, 'oditoai.com');
      const d = domains[0];
      assert.ok(d.y > single.report.height * 0.9, 'in the footer');
      assert.ok(d.height < 40, 'small');
      const point = await renderConcept({ concept: concept({ layout: 'carousel_point', number: 1, cta: '', subline: 'More at oditoai.com' }), provider: imageProvider(), brand: BRAND, caption: CAPTION, facts: '', qcRetries: 0, slide: { index: 2, total: 5 } });
      assert.equal(point.report.footerDomain, null);
      assert.ok(!point.report.texts.some((t) => t.label === 'domain'));
      const cta = await renderConcept({ concept: concept({ layout: 'carousel_cta', cta: 'Book at oditoai.com' }), provider: imageProvider(), brand: BRAND, caption: CAPTION, facts: '', qcRetries: 0, slide: { index: 5, total: 5 } });
      assert.equal(cta.report.footerDomain, 'oditoai.com', 'the CTA slide is where the domain goes');
    } finally { setQualityProviderOverride(null); }
  });

  test('without an address in the brief, no domain is added', async () => {
    const { report } = await composeConcept({ brief: concept({ layout: 'full_bleed_bottom' }), image: await photo(1088, 1360), size: CONCEPT_SIZES.portrait, brand: BRAND });
    assert.equal(report.footerDomain, null);
  });
});

describe('the accent rule (underline) never floats under a CTA', () => {
  const r = (h) => ({ height: h });
  test('placement: only when the headline is the last line of the stack, directly under it', () => {
    assert.equal(accentRulePlacement({ parts: [{ label: 'headline', r: r(100) }, { label: 'cta', r: r(40) }] }, { x: 0, y: 0, gap: 10, u: 10 }), null);
    assert.equal(accentRulePlacement({ parts: [{ label: 'headline', r: r(100) }, { label: 'subline', r: r(40) }] }, { x: 0, y: 0, gap: 10, u: 10 }), null);
    const p = accentRulePlacement({ parts: [{ label: 'headline', r: r(100) }] }, { x: 5, y: 50, gap: 10, u: 10 });
    assert.deepEqual([p.under, p.y, p.x], ['headline', 50 + 100 + 24, 5]);
  });

  test('editorial cover with a CTA: no rule is drawn; headline alone on a calm picture: the rule sits right under the headline', async () => {
    const withCta = await composeConcept({ brief: concept({ cta: 'See the three' }), image: await photo(1088, 1360, true), size: CONCEPT_SIZES.portrait, brand: BRAND });
    assert.equal(withCta.report.rule, false);
    const alone = await composeConcept({ brief: concept({ cta: '', subline: '' }), image: await photo(1088, 1360, true), size: CONCEPT_SIZES.portrait, brand: BRAND });
    assert.equal(alone.report.rule, true);
    const head = alone.report.texts.find((t) => t.label === 'headline');
    const rule = alone.report.rulePlacement;
    assert.equal(rule.under, 'headline');
    assert.ok(rule.y >= head.y + head.height && rule.y - (head.y + head.height) <= 30, 'directly under the headline');
    assert.ok(!alone.report.texts.some((t) => t.label === 'cta'));
  });
});
