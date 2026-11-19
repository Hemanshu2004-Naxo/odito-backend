import sharp from 'sharp';
import { CONCEPT_SIZES, MAX_IMAGE_PIXELS } from '../designConfig.js';
import { SINGLE_LAYOUTS, BANNED_CLICHES, QC_MAX_RETRIES, MAX_WORDS_PER_IMAGE, STYLE_RULES, imageCostUsd, claudeCostUsd } from './conceptConfig.js';
import { generateCreativeBrief, reviseConcept, normalise } from './creativeBrief.js';
import { composeConcept } from './conceptLayouts.js';
import { stripWebAddresses } from './webAddress.js';
import { checkDesignQuality } from './conceptQuality.js';
import { assessRaster } from '../designQuality.js';

/**
 * The CONCEPT pipeline (replaces the rule-based design for single images):
 *
 *   creative brief (Claude, + headline judge) ─► image (gpt-image, the platform size, plain empty space where the text goes, no text,
 *   ONE style) ─► Odito's overlay (real fonts, brand mark, strict fitting, WCAG contrast, plate over busy pixels) ─► quality check
 *   (deterministic + Claude vision) ─► at most QC_MAX_RETRIES more attempts when it scores below 7 ─► the best result
 *
 * A retry is a NEW picture, except when the only problem is the headline: then the judge's next-best headline goes on the SAME picture
 * (no image cost). Every step is timed and costed; the result carries the brief, the exact image prompt, the model ids, quality, size
 * and QC. Nothing here stores or attaches anything.
 */

export const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean);

/** Where the text zone must be plain, for each layout the pipeline draws (single images and carousel slides). */
const ZONES = {
  ...Object.fromEntries(Object.entries(SINGLE_LAYOUTS).map(([id, l]) => [id, l])),
  carousel_point: { textZone: 'the bottom 45% of the frame', image: 'full' },
  carousel_cta: { textZone: 'the bottom 50% of the frame', image: 'full' },
};

/** The prompt actually sent to the image model: the brief's prompt plus Odito's non-negotiable rules for this layout. */
export function finalImagePrompt(concept, brand = {}, { reference = false } = {}) {
  const layout = ZONES[concept.layout] || SINGLE_LAYOUTS.full_bleed_bottom;
  const palette = [brand.primary, brand.secondary, brand.accent].filter(Boolean).join(', ');
  return [
    ...(reference ? ['Use the reference image ONLY for continuity: the same visual style, rendering, lighting, colour grading, palette and kind of setting. Create a NEW scene as described below - do not copy the reference composition, and keep any person consistent with the reference.', ''] : []),
    concept.image_prompt,
    '',
    // full-bleed layouts put text ON the picture, so the picture must leave that zone empty; the others show the picture on its own
    `Composition rule: ${layout.image === 'full'
      ? `${layout.textZone} must be calm, EMPTY background - the same scene continuing, darker and softly lit (a wall, floor, desk front or sky) with no objects, no people, no patterns and no fine detail (a headline is placed there later). Keep every object and person out of it. No hard horizontal edge or flat colour block across the frame - the picture stays one continuous photograph/illustration.`
      : 'the whole frame is the picture; keep one clear subject with breathing room around it (it is shown in a frame next to the text).'}`,
    STYLE_RULES[concept.visual_style] || '',
    palette ? `Colour palette: build the grading around ${palette}.` : '',
    'Absolutely no text, letters, numbers, signs, labels, logos, watermarks or user-interface elements anywhere in the image (simple pictogram icons are allowed).',
    `Avoid these clichés: ${BANNED_CLICHES.join('; ')}. Avoid any symbol with a political, religious or social-justice reading (e.g. a glass ceiling, chains, flags).`,
    'Natural anatomy: realistic hands and faces, no distortions, no extra fingers, no warped objects.',
  ].filter((l) => l !== '').join('\n');
}

/** A picture as a bounded, decoded raster (never trusted as it came). */
async function decodeImage(buffer) {
  return sharp(buffer, { failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS }).rotate().png().toBuffer();
}

/** A reference picture for the edit endpoint: a bounded JPEG (smaller upload, same look). */
export async function referenceFrom(picture) {
  return { buffer: await sharp(picture).resize({ width: 1088, height: 1360, fit: 'inside' }).jpeg({ quality: 88 }).toBuffer(), mimeType: 'image/jpeg' };
}

const costOf = (call) => (call.kind === 'image' ? imageCostUsd(call.usage) : claudeCostUsd(call.model, call.usage));
/**
 * WHY a design failed, which decides the retry:
 *   meaning    the idea does not land (does not match the big idea, does not support the headline's MESSAGE, unclear symbols, a strong sensitive reading, stock look, an invented
 *              fact) -> a CONCEPT retry: back to the brief with the QC feedback for a different, more literal idea, then a new picture
 *   execution  the idea is fine but the picture is not (hands / artifacts, mixed styles, text over detail, cut-off text) -> a PICTURE
 *              retry: the same concept, a new picture told what to fix
 *   headline   only the words are wrong -> the judge's next headline on the SAME picture (no image cost)
 */
export function classifyFailure(qc) {
  const c = qc.checks || {};
  const strongSensitive = (qc.issues || []).some((i) => /^sensitive reading:/.test(i));
  if (c.matches_big_idea === false || c.supports_message === false || (c.unclear_symbols || []).length || strongSensitive || c.looks_stock_or_template === true || (c.invented_facts || []).length) return 'meaning';
  if ((c.ai_artifacts || []).length || c.mixed_styles || c.text_over_busy_area || c.cut_off_text || c.readable_at_phone_size === false
    || (qc.deterministic?.problems || []).some((x) => /busy|cut off|shortened|outside/.test(x))) return 'execution';
  if (headlineOnly(qc)) return 'headline';
  return 'execution';
}

/** The reasons shown with a "needs attention" design: the strong problems, never the mild notes. */
export const attentionReasons = (qc) => (qc.issues || []).filter((i) => !/^possible \(mild\)/.test(i)).slice(0, 3);

const headlineOnly = (qc) => !qc.hardFail && (qc.checks?.headline_awkward || qc.deterministic.problems.some((p) => /riddle/.test(p)))
  && !qc.deterministic.problems.some((p) => !/riddle/.test(p)) && !(qc.checks?.ai_artifacts || []).length && !qc.checks?.mixed_styles && !qc.checks?.text_over_busy_area;

/**
 * Renders ONE concept (a single image or one carousel slide) to a finished design, with the quality check and at most QC_MAX_RETRIES
 * more attempts.
 * @param {object} a
 * @param {object} a.concept         { hook_headline, subline, cta, layout, visual_style, image_prompt, image_labels?, number?, big_idea, headline_ranked? }
 * @param {object} a.provider        the image provider (generateImage)
 * @param {object[]} [a.referenceImages]  [{ buffer, mimeType }] - the hook picture for carousel slides (edit endpoint)
 * @param {object} [a.slide]         { index, total } - a carousel slide (the counter)
 * @param {string} [a.qcContext]     extra context for the visual check (e.g. "slide 3 of 7")
 * @param {string[]} [a.extraExpected] texts on the image that are not words of the brief (the slide number, the counter)
 */
export async function renderConcept({
  concept, provider, brand, logo = null, caption, facts, shape = 'portrait', quality = 'medium', qcRetries = QC_MAX_RETRIES, kicker = null, onStage = null,
  referenceImages = [], slide = null, qcContext = '', extraExpected = [], step = 'image',
  reviseConcept = null, beforeCompose = null, conceptRetries = 1, skipQc = false,
}) {
  const stage = async (s) => { if (onStage) { try { await onStage(s); } catch { /* progress is best effort */ } } };
  const started = Date.now();
  const size = CONCEPT_SIZES[shape] || CONCEPT_SIZES.portrait;
  const calls = [];
  const attempts = [];
  let best = null;
  let promptExtra = [];
  let reuse = null; // { picture, image, imagePrompt } - the next attempt only changes the headline
  let current = concept;
  let composeReady = !beforeCompose;
  const ranked = (c) => [c.hook_headline, ...(c.headline_ranked || []).filter((h) => normalise(h) !== normalise(c.hook_headline))];
  let headlines = ranked(current);
  let retriesLeft = Math.max(0, qcRetries);
  let conceptRetriesLeft = reviseConcept ? Math.max(0, conceptRetries) : 0;
  let headlineSwaps = 2;
  let retryType = 'first';
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    let picture; let imageCall; let imagePrompt;
    const reused = !!reuse;
    if (reuse) {
      ({ picture, image: imageCall, imagePrompt } = reuse);
    } else {
      imagePrompt = [finalImagePrompt(current, brand, { reference: referenceImages.length > 0 }), ...(promptExtra.length ? ['', `Fix these problems of the previous attempt: ${promptExtra.join('; ')}.`] : [])].join('\n');
      // eslint-disable-next-line no-await-in-loop
      await stage('image');
      let img;
      try {
        // eslint-disable-next-line no-await-in-loop
        img = await provider.generateImage({ prompt: imagePrompt, size: size.request, quality, referenceImages });
      } catch (error) { if (error && typeof error === 'object') error.photoStep = true; throw error; }
      imageCall = { kind: 'image', step: retryType === 'first' ? step : `${step}_${retryType}_retry`, model: img.model, modelReturned: img.modelReturned || null, fallbackUsed: !!img.fallbackUsed, usage: img.usage, durationMs: img.durationMs, quality: img.quality || quality, size: size.request, references: referenceImages.length };
      calls.push(imageCall);
      // eslint-disable-next-line no-await-in-loop
      picture = await decodeImage(img.buffer);
      // eslint-disable-next-line no-await-in-loop
      if ((await assessRaster(picture)).blank) throw Object.assign(new Error('MEDIA_INVALID'), { code: 'MEDIA_INVALID', reason: 'visual_blank', photoStep: true });
    }
    reuse = null;
    // the headline may still be with the judge (it runs in parallel with the first picture): wait for it only now
    if (!composeReady) {
      // eslint-disable-next-line no-await-in-loop
      current = await beforeCompose(current);
      headlines = ranked(current);
      composeReady = true;
    }

    // the overlay: a subline that does not fit is dropped (never cut); a headline that does not fit fails the attempt
    const headline = headlines[0];
    const labelWords = (current.image_labels || []).reduce((s, l) => s + words(l.text).length, 0);
    const budget = words(headline).length + words(current.subline).length + words(current.cta).length + labelWords;
    // no web address is ever drawn as words: the brief's texts are cleaned, and a website the brief wanted shown becomes the bare
    // domain in small footer text - only on a single image or the carousel's CTA slide (once per post)
    const web = stripWebAddresses({ ...current, hook_headline: headline, kicker: kicker && budget + words(kicker).length <= MAX_WORDS_PER_IMAGE ? kicker : undefined });
    let brief = web.brief;
    const footerDomain = web.domain && (!slide || brief.layout === 'carousel_cta') ? web.domain : null;
    // eslint-disable-next-line no-await-in-loop
    await stage('text');
    let composed = null;
    let dropped = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      composed = await composeConcept({ brief, image: picture, size, brand, logo, slide, footerDomain });
    } catch (error) {
      if (error?.code !== 'TEXT_DOES_NOT_FIT') throw error;
      if (['subline', 'stack'].includes(error.reason) && brief.subline) {
        brief = { ...brief, subline: '' };
        dropped = 'subline';
        // eslint-disable-next-line no-await-in-loop
        composed = await composeConcept({ brief, image: picture, size, brand, logo, slide, footerDomain });
      } else if (error.reason === 'cta' && brief.cta) {
        brief = { ...brief, cta: '' };
        dropped = 'cta';
        // eslint-disable-next-line no-await-in-loop
        composed = await composeConcept({ brief, image: picture, size, brand, logo, slide, footerDomain });
      } else throw error;
    }
    // eslint-disable-next-line no-await-in-loop
    await stage('quality');
    const expected = composed.report.footerDomain ? [...extraExpected, composed.report.footerDomain] : extraExpected;
    // a Compare PREVIEW is not quality-checked (it is a low-quality sketch of a concept; the chosen one is rendered and checked)
    // eslint-disable-next-line no-await-in-loop
    const qc = skipQc
      ? { score: null, passed: true, hardFail: false, checks: null, issues: [], deterministic: { problems: [], wordCount: null }, call: null }
      : await checkDesignQuality({ png: composed.buffer, brief, report: composed.report, caption, facts, brand, context: qcContext, extraExpected: expected });
    if (qc.call) calls.push({ kind: 'text', ...qc.call });
    const result = { png: composed.buffer, brief, report: composed.report, imagePrompt, image: { ...imageCall }, qc, dropped, picture, concept: current };
    const kind = qc.passed ? null : classifyFailure(qc);
    attempts.push({ attempt, retry: retryType, score: qc.score, passed: qc.passed, failure: kind, issues: qc.issues, headline, idea: current.big_idea, newImage: !reused });
    const rank = (r) => (r.qc.hardFail ? -1 : (r.qc.score ?? 0));
    if (!best || rank(result) > rank(best)) best = result;
    if (qc.passed) break;
    if (kind === 'headline' && headlines.length > 1 && headlineSwaps > 0) {
      // only the words are wrong: the next-best judged headline on the same picture
      headlineSwaps -= 1;
      headlines = headlines.slice(1);
      reuse = { picture, image: imageCall, imagePrompt };
      retryType = 'headline';
      // eslint-disable-next-line no-continue
      continue;
    }
    if (retriesLeft <= 0) break;
    retriesLeft -= 1;
    if (kind === 'meaning' && conceptRetriesLeft > 0) {
      // the idea does not land: a DIFFERENT, more literal idea from the brief step, then a new picture
      conceptRetriesLeft -= 1;
      // eslint-disable-next-line no-await-in-loop
      const revised = await reviseConcept({ concept: current, qc });
      calls.push(...(revised.calls || []).map((c) => ({ kind: 'text', ...c })));
      current = { ...current, ...revised.concept };
      headlines = ranked(current);
      promptExtra = [];
      retryType = 'concept';
    } else {
      // the idea is fine, the picture is not: the same concept, a new picture told what to fix
      promptExtra = qc.issues.filter((i) => !/^possible \(mild\)/.test(i)).slice(0, 4);
      retryType = 'picture';
    }
  }
  const priced = calls.map((c) => ({ ...c, costUsd: costOf(c) }));
  return {
    png: best.png,
    picture: best.picture,
    concept: best.brief,
    imagePrompt: best.imagePrompt,
    image: best.image,
    report: best.report,
    dropped: best.dropped,
    qc: { score: best.qc.score, passed: best.qc.passed, hardFail: best.qc.hardFail, checks: best.qc.checks, issues: best.qc.issues, wordCount: best.qc.deterministic.wordCount },
    // never shipped below the bar without anyone knowing: the UI shows this badge with the reasons and a regenerate button
    needsAttention: best.qc.passed ? null : { score: best.qc.score, failure: classifyFailure(best.qc), reasons: attentionReasons(best.qc) },
    retries: attempts.slice(1).map((a) => a.retry),
    attempts,
    calls: priced,
    costUsd: Math.round(priced.reduce((s, c) => s + (c.costUsd || 0), 0) * 10_000) / 10_000,
    durationMs: Date.now() - started,
    size: { width: size.width, height: size.height, requested: size.request },
  };
}

/**
 * The creative brief for `count` concepts, then each rendered (in parallel). Returns { brief, options[], costUsd, durationMs }. A brief
 * that cannot be produced throws (BRIEF_INVALID / CLAUDE_*); one option failing does not fail the others (it carries `error`).
 */
export async function generateConceptOptions({ input, count = 1, provider, brand, logo = null, shape = 'portrait', quality = 'medium', qcRetries = QC_MAX_RETRIES, onStage = null }) {
  const started = Date.now();
  if (onStage) { try { await onStage('concept'); } catch { /* best effort */ } }
  const brief = await generateCreativeBrief({ ...input, count, brand });
  const briefCalls = brief.calls.map((c) => ({ kind: 'text', ...c, costUsd: claudeCostUsd(c.model, c.usage) }));
  const options = await Promise.all(brief.concepts.map(async (concept) => {
    try {
      return await renderConcept({
        concept, provider, brand, logo, caption: input.caption, facts: input.facts, shape, quality, qcRetries, kicker: input.pillar || null, onStage: count === 1 ? onStage : null,
        reviseConcept: ({ concept: cur, qc }) => reviseConcept({ concept: cur, problems: (qc.issues || []).filter((i) => !/^possible \(mild\)/.test(i)).slice(0, 6), input, brand }),
      });
    } catch (error) {
      return { concept, error: { code: error?.code || 'GENERATION_FAILED', reason: error?.reason || null, photoStep: !!error?.photoStep }, cause: error };
    }
  }));
  const briefCost = briefCalls.reduce((s, c) => s + (c.costUsd || 0), 0);
  return {
    brief: { version: brief.version, model: brief.model, adjusted: brief.adjusted, repaired: brief.repaired, durationMs: brief.durationMs, calls: briefCalls, costUsd: Math.round(briefCost * 10_000) / 10_000 },
    options,
    costUsd: Math.round((briefCost + options.reduce((s, o) => s + (o.costUsd || 0), 0)) * 10_000) / 10_000,
    durationMs: Date.now() - started,
  };
}

export const headlineWords = (c) => words(c.hook_headline).length;
export default { renderConcept, generateConceptOptions, finalImagePrompt, referenceFrom };
