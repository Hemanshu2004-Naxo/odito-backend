import {
  CAROUSEL_BRIEF_VERSION, MAX_HEADLINE_WORDS, MAX_SUBLINE_WORDS, MAX_CTA_WORDS, MAX_POINT_SLIDE_WORDS, MIN_CAROUSEL_POINTS, MAX_CAROUSEL_POINTS, MAX_WORDS_PER_IMAGE,
  VISUAL_STYLES, CONCEPT_TEXT_MODEL, CONCEPT_TIMEOUT_MS, CONCEPT_MAX_OUTPUT_TOKENS, QC_MAX_RETRIES, CAROUSEL_CONCURRENCY, CAROUSEL_RATE_LIMITED_CONCURRENCY, claudeCostUsd,
} from './conceptConfig.js';
import {
  SHARED_RULES, words, normalise, unsupportedClaims, copiedFromCaption, visualProblems, checkImageLabels, checkHeadlineCandidates, awkwardHeadline, checkSymbols,
  headlineCandidatesSchema, imageLabelsSchema, symbolsSchema, judgeHeadlines, briefProvider,
} from './creativeBrief.js';
import { renderConcept, referenceFrom } from './conceptPipeline.js';
import { PROVIDER_ERROR } from '../../aiContent/providers/contentProviderErrors.js';

/**
 * CAROUSELS: hook slide -> one slide per point of the caption (one visual idea each, a big number, at most 12 words) -> CTA slide.
 *
 *   carousel brief (Claude; every point quotes the caption line it comes from, so no point is invented) -> headline judge (5 candidates
 *   per slide) -> the HOOK picture first -> the hook picture is the REFERENCE image (edit endpoint) for every other slide, which keeps
 *   the style, light, palette and setting continuous -> each slide composed and quality-checked on its own (max 1 retry each).
 */

export const CAROUSEL_TOOL = 'emit_carousel';
const str = (description, maxLength) => ({ type: 'string', description, ...(maxLength ? { maxLength } : {}) });

/** The numbered points of a caption ("1. ...", "2) ..."), in order - the carousel gets one slide per point. */
// A bullet line: "• ...", "- ...", "* ...", "– ...", "✓ ...", "✅ ...", "→ ..." (the marker, then a space).
const BULLET_RE = /^(?:[•●▪◦‣∙·*✓✔✅➤►→▶-]|[–—])️?\s+(.+)$/u;

export function captionPoints(caption) {
  const lines = String(caption || '').split(/\n/).map((l) => l.trim());
  const numbered = [];
  for (const line of lines) {
    const m = line.match(/^(\d{1,2})[.)]\s+(.+)$/);
    if (m) numbered.push({ number: Number(m[1]), text: m[2].trim() });
  }
  const inOrder = numbered.filter((p, i) => p.number === i + 1);
  if (inOrder.length >= MIN_CAROUSEL_POINTS && inOrder.length <= MAX_CAROUSEL_POINTS) return inOrder;
  // A bulleted list counts the same way (most captions use bullets, not numbers).
  const bullets = lines.map((l) => l.match(BULLET_RE)?.[1]?.trim()).filter(Boolean);
  if (bullets.length >= MIN_CAROUSEL_POINTS && bullets.length <= MAX_CAROUSEL_POINTS) return bullets.map((text, i) => ({ number: i + 1, text }));
  return inOrder;
}

/** A caption with no 3-6 point list can still become a carousel when it says enough to split into slides. */
export const MIN_OUTLINE_WORDS = 40;

/**
 * Can this caption become a carousel, and how: { allowed, points, source: 'caption' | 'outline' | null }.
 * 'caption' = its own numbered/bulleted 3-6 points; 'outline' = Claude splits the caption into 3-6 points (outlineCaptionPoints).
 */
export function carouselEligibility(caption) {
  const listed = captionPoints(caption);
  if (listed.length >= MIN_CAROUSEL_POINTS && listed.length <= MAX_CAROUSEL_POINTS) return { allowed: true, points: listed.length, source: 'caption' };
  const body = String(caption || '').replace(/(^|\s)#\S+/g, ' ');
  if (words(body).length >= MIN_OUTLINE_WORDS) return { allowed: true, points: null, source: 'outline' };
  return { allowed: false, points: listed.length, source: null };
}

const OUTLINE_TOOL = 'emit_carousel_points';
const OUTLINE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['points'],
  properties: {
    points: {
      type: 'array', minItems: MIN_CAROUSEL_POINTS, maxItems: MAX_CAROUSEL_POINTS,
      items: {
        type: 'object', additionalProperties: false, required: ['text', 'source'],
        properties: {
          text: str(`The point, at most ${MAX_POINT_SLIDE_WORDS} words: a plain restatement of ONE idea of the caption.`, 120),
          source: str('The caption words this point comes from, copied exactly (at least 3 words).', 300),
        },
      },
    },
  },
};

/**
 * Splits a caption that has no 3-6 point list into 3-6 carousel points, in the caption's order. Checked in code: every point must
 * quote the caption words it comes from (verbatim), add no figure the caption doesn't have, stay short, and not repeat another point.
 * One repair. Returns { points: [{ number, text }], calls }. Throws CAROUSEL_NEEDS_POINTS (with calls) when it can't.
 */
export async function outlineCaptionPoints({ caption }) {
  const calls = [];
  let feedback = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await briefProvider().generateStructured({
      system: `You split a social media caption into the points of an Instagram/Facebook carousel: ${MIN_CAROUSEL_POINTS} to ${MAX_CAROUSEL_POINTS} points, one slide each, in the caption's order. Each point restates ONE idea that the caption itself makes - no new facts, figures, names, promises or advice. Skip the hook line, the call to action, questions to the audience and hashtags. Group small related items (e.g. a list of examples) into one point rather than dropping them.`,
      user: `<caption>\n${caption}\n</caption>${feedback.length ? `\n\nYour previous answer broke these rules - fix them:\n- ${feedback.join('\n- ')}` : ''}`,
      tool: { name: OUTLINE_TOOL, description: 'Emit the carousel points. Call this exactly once.', schema: OUTLINE_SCHEMA },
      model: CONCEPT_TEXT_MODEL, maxTokens: 1200, timeoutMs: CONCEPT_TIMEOUT_MS, retries: 1,
    });
    calls.push({ step: attempt === 1 ? 'carousel_outline' : 'carousel_outline_repair', model: res.model, usage: res.usage, durationMs: res.durationMs });
    const raw = Array.isArray(res.parsed?.points) ? res.parsed.points : [];
    const errors = [];
    if (raw.length < MIN_CAROUSEL_POINTS || raw.length > MAX_CAROUSEL_POINTS) errors.push(`give ${MIN_CAROUSEL_POINTS} to ${MAX_CAROUSEL_POINTS} points (you gave ${raw.length})`);
    const seen = new Set();
    const points = raw.map((p, i) => {
      const text = String(p?.text || '').trim();
      const quote = normalise(p?.source || '');
      if (!text) errors.push(`point ${i + 1}: empty`);
      if (words(text).length > MAX_POINT_SLIDE_WORDS) errors.push(`point ${i + 1}: more than ${MAX_POINT_SLIDE_WORDS} words`);
      if (words(quote).length < 3 || !normalise(caption).includes(quote)) errors.push(`point ${i + 1}: source must copy at least 3 words of the caption exactly`);
      const claims = unsupportedClaims(text, caption);
      if (claims.length) errors.push(`point ${i + 1}: states ${claims.join(', ')}, which the caption does not`);
      const key = normalise(text);
      if (seen.has(key)) errors.push(`point ${i + 1}: repeats another point`);
      seen.add(key);
      return { number: i + 1, text };
    });
    if (!errors.length) return { points, calls };
    feedback = errors.slice(0, 8);
  }
  throw Object.assign(new Error('NOT_A_LIST'), { code: 'CAROUSEL_NEEDS_POINTS', reason: 'outline_invalid', errors: feedback, calls });
}

function carouselSchema(points) {
  const slide = (extra = {}, required = []) => ({
    type: 'object', additionalProperties: false,
    required: ['headline_candidates', 'headline', 'image_prompt', 'image_labels', 'symbols', ...required],
    properties: { headline_candidates: headlineCandidatesSchema(), headline: str('The best candidate.', 120), image_prompt: str('The prompt for this slide\'s picture.', 1800), image_labels: imageLabelsSchema(), symbols: symbolsSchema(), ...extra },
  });
  return {
    type: 'object', additionalProperties: false, required: ['big_idea', 'visual_style', 'world', 'hook', 'points', 'cta_slide'],
    properties: {
      big_idea: str('ONE sentence: the visual concept of the whole carousel.', 240),
      visual_style: { type: 'string', enum: [...VISUAL_STYLES] },
      world: str('The shared world every slide lives in (setting, character, light, palette) so the slides read as one series.', 400),
      hook: slide({ subline: str(`At most ${MAX_SUBLINE_WORDS} words or "".`, 110), cta: str(`A swipe prompt, at most ${MAX_CTA_WORDS} words.`, 50) }, ['subline', 'cta']),
      points: {
        type: 'array', minItems: points || MIN_CAROUSEL_POINTS, maxItems: points || MAX_CAROUSEL_POINTS,
        items: slide({
          number: { type: 'integer', minimum: 1, maximum: MAX_CAROUSEL_POINTS },
          from_caption: str('The exact words of the caption point this slide shows (copied verbatim from the caption).', 200),
          visual_idea: str('ONE sentence: the single visual idea of this slide.', 200),
        }, ['number', 'from_caption', 'visual_idea']),
      },
      cta_slide: slide({ subline: str(`At most ${MAX_SUBLINE_WORDS} words or "".`, 110), cta: str(`The call to action from the caption, at most ${MAX_CTA_WORDS} words.`, 50) }, ['subline', 'cta']),
    },
  };
}

const SYSTEM = `You are the senior art director of a social media agency. You turn ONE post into an agency-quality CAROUSEL: a hook slide, one slide per point of the caption, and a closing call-to-action slide. The slides are one series: the same world, style, light and palette - the hook picture is used as the reference image for every other slide.

RULES
- Hook slide: a strong visual metaphor or real scene for the whole message. headline: at most ${MAX_HEADLINE_WORDS} words, NOT copied from the caption; subline at most ${MAX_SUBLINE_WORDS} words or ""; cta = a short swipe prompt.
- Point slides: exactly one per numbered point of the caption, in the caption's order. Each shows ONE visual idea for its point; from_caption quotes the caption words it comes from; headline at most ${MAX_POINT_SLIDE_WORDS} words, a plain restatement of that point (no new claims). Odito adds the big number.
- CTA slide: the caption's own call to action (at most ${MAX_CTA_WORDS} words), headline at most ${MAX_HEADLINE_WORDS} words.
- Every image prompt: the slide's own scene inside the shared world, in the same visual style, with the bottom 45-50% of the frame plain and empty for the text.
- At most ${MAX_WORDS_PER_IMAGE} words on any slide (labels included).
${SHARED_RULES}`;

function userMessage({ caption, pillar, platform, audience, brand, facts, points, direction, feedback = [] }) {
  return [
    `<post platform="${platform}" pillar="${pillar || ''}">`, caption, '</post>',
    `<audience>${audience || 'not stated'}</audience>`,
    `<brand name="${brand.name || ''}" primary="${brand.primary || ''}" secondary="${brand.secondary || ''}" accent="${brand.accent || ''}" heading_font="${brand.headingFont || ''}"/>`,
    `<business_facts>\n${facts || 'none'}\n</business_facts>`,
    ...(direction ? [`<art_direction from="the reviewer">\n${direction}\n</art_direction>`] : []),
    `The caption has ${points.length} numbered points: make exactly ${points.length} point slides.`,
    ...(feedback.length ? [`Your previous answer was refused for these reasons - fix every one:\n${feedback.map((f) => `- ${f}`).join('\n')}`] : []),
  ].join('\n');
}

/** Validates a carousel brief. Returns { carousel, errors, adjusted }. */
export function validateCarousel(raw, { caption, facts = '', points }) {
  const errors = [];
  const adjusted = [];
  const source = `${caption}\n${facts}`;
  const style = raw?.visual_style;
  if (!VISUAL_STYLES.includes(style)) errors.push(`visual_style must be one of ${VISUAL_STYLES.join(', ')}`);
  if (!String(raw?.big_idea || '').trim()) errors.push('big_idea is required');

  const slide = (s, p, { maxWords, kind }) => {
    const out = {
      headline: String(s?.headline || '').trim(), subline: String(s?.subline || '').trim(), cta: String(s?.cta || '').trim(),
      image_prompt: String(s?.image_prompt || '').trim(),
    };
    const heads = checkHeadlineCandidates(s?.headline_candidates, { chosen: out.headline, caption, source, p, maxWords });
    // point slides restate the caption, so a candidate close to its point is fine - only the hook/CTA must be new words
    if (kind === 'point') {
      const all = (Array.isArray(s?.headline_candidates) ? s.headline_candidates : []).map((h) => String(h || '').trim()).filter((h) => h && words(h).length <= maxWords && !unsupportedClaims(h, source).length && !awkwardHeadline(h));
      out.headline_candidates = [...new Map(all.map((h) => [normalise(h), h])).values()];
      errors.push(...heads.errors.filter((e) => !/none of the headline candidates/.test(e)));
      if (!out.headline_candidates.length) errors.push(`${p}: no usable headline candidate (at most ${maxWords} words, no unsupported claims, not awkward)`);
    } else {
      out.headline_candidates = heads.candidates;
      errors.push(...heads.errors);
      if (copiedFromCaption(out.headline, caption)) errors.push(`${p}: headline is copied from the caption - write a new one`);
    }
    const hw = words(out.headline).length;
    if (!hw) errors.push(`${p}: headline is required`);
    if (hw > maxWords) errors.push(`${p}: headline has ${hw} words, at most ${maxWords}`);
    if (words(out.subline).length > MAX_SUBLINE_WORDS) errors.push(`${p}: subline over ${MAX_SUBLINE_WORDS} words`);
    if (words(out.cta).length > MAX_CTA_WORDS) errors.push(`${p}: cta over ${MAX_CTA_WORDS} words`);
    const lab = checkImageLabels(s?.image_labels, { bigIdea: s?.visual_idea || '', prompt: out.image_prompt, p });
    errors.push(...lab.errors);
    out.image_labels = lab.labels;
    const sym = checkSymbols(s?.symbols, { bigIdea: s?.visual_idea || '', prompt: out.image_prompt, labels: out.image_labels, p });
    errors.push(...sym.errors);
    out.symbols = sym.symbols;
    const total = hw + words(out.subline).length + words(out.cta).length + out.image_labels.reduce((n, l) => n + words(l.text).length, 0);
    if (total > MAX_WORDS_PER_IMAGE && out.subline) { out.subline = ''; adjusted.push(`${p}: subline dropped (word budget)`); }
    if (hw + words(out.cta).length + out.image_labels.reduce((n, l) => n + words(l.text).length, 0) > MAX_WORDS_PER_IMAGE) errors.push(`${p}: more than ${MAX_WORDS_PER_IMAGE} words on the slide`);
    if (out.image_prompt.length < 120) errors.push(`${p}: image_prompt is too short - describe the scene, composition, light, style and the empty text area`);
    const claims = unsupportedClaims([out.headline, out.subline, out.cta, ...out.image_labels.map((l) => l.text)].join(' \n '), source);
    if (claims.length) errors.push(`${p}: not stated in the caption or the facts, so it may not appear: ${claims.join(', ')}`);
    errors.push(...visualProblems({ text: [s?.visual_idea || '', out.image_prompt].join(' \n '), visualStyle: style, p }));
    return out;
  };

  const hook = slide(raw?.hook, 'hook slide', { maxWords: MAX_HEADLINE_WORDS, kind: 'hook' });
  const list = Array.isArray(raw?.points) ? raw.points : [];
  if (list.length !== points.length) errors.push(`exactly ${points.length} point slides are required (one per numbered point of the caption), got ${list.length}`);
  const seenQuotes = new Set();
  const pointSlides = list.slice(0, points.length).map((s, i) => {
    const p = `point slide ${i + 1}`;
    const out = { ...slide(s, p, { maxWords: MAX_POINT_SLIDE_WORDS, kind: 'point' }), number: i + 1, from_caption: String(s?.from_caption || '').trim(), visual_idea: String(s?.visual_idea || '').trim() };
    if (s?.number !== i + 1) adjusted.push(`${p}: number set to ${i + 1} (the caption's order)`);
    const quote = normalise(out.from_caption);
    if (words(quote).length < 3 || !normalise(caption).includes(quote)) errors.push(`${p}: from_caption must quote the caption's words for point ${i + 1} verbatim`);
    else if (!normalise(points[i].text).includes(quote) && !quote.includes(normalise(points[i].text).slice(0, 30))) {
      // the quote may come from the point's explanation line too; it must at least be nearer this point than any other
      const other = points.findIndex((pt, j) => j !== i && normalise(pt.text).includes(quote));
      if (other >= 0) errors.push(`${p}: from_caption quotes point ${other + 1}, not point ${i + 1}`);
    }
    if (seenQuotes.has(quote)) errors.push(`${p}: repeats another slide's caption point`);
    seenQuotes.add(quote);
    if (!out.visual_idea) errors.push(`${p}: visual_idea is required`);
    return out;
  });
  for (let i = 0; i < pointSlides.length; i += 1) {
    for (let j = i + 1; j < pointSlides.length; j += 1) {
      const a = new Set(words(normalise(pointSlides[i].visual_idea)).filter((w) => w.length > 4));
      const b = words(normalise(pointSlides[j].visual_idea)).filter((w) => w.length > 4);
      if (b.length && b.filter((w) => a.has(w)).length / b.length > 0.6) errors.push(`point slides ${i + 1} and ${j + 1} have the same visual idea - one distinct idea per slide`);
    }
  }
  const cta = slide(raw?.cta_slide, 'CTA slide', { maxWords: MAX_HEADLINE_WORDS, kind: 'cta' });
  if (!cta.cta) errors.push('CTA slide: cta is required (the caption\'s call to action)');
  errors.push(...visualProblems({ text: `${raw?.big_idea || ''}\n${raw?.world || ''}`, visualStyle: style, p: 'carousel' }));
  return {
    carousel: { version: CAROUSEL_BRIEF_VERSION, big_idea: String(raw?.big_idea || '').trim(), visual_style: style, world: String(raw?.world || '').trim(), hook, points: pointSlides, cta },
    errors, adjusted,
  };
}

// ── slide ids, error routing, revision ──────────────────────────────────────

export const REVISE_TOOL = 'emit_revised_slide';

/** Which slide an error from validateCarousel belongs to ('hook' | 'p<n>' | 'cta'), or null for the whole carousel. */
export function slideOfError(e) {
  if (/^hook slide/.test(e)) return 'hook';
  if (/^CTA slide/.test(e)) return 'cta';
  const one = e.match(/^point slide (\d+)\b/);
  if (one) return `p${one[1]}`;
  const pair = e.match(/^point slides \d+ and (\d+)/);
  if (pair) return `p${pair[1]}`;
  return null;
}

const slideIds = (c) => ['hook', ...c.points.map((p) => `p${p.number}`), 'cta'];
const getSlide = (c, id) => (id === 'hook' ? c.hook : id === 'cta' ? c.cta : c.points.find((p) => `p${p.number}` === id));
/** The cleaned carousel back in the shape validateCarousel reads (to re-check a revised slide in context). */
const toRaw = (c) => ({ big_idea: c.big_idea, visual_style: c.visual_style, world: c.world, hook: c.hook, points: c.points, cta_slide: c.cta });
const withSlide = (c, id, slide) => (id === 'hook' ? { ...c, hook: slide } : id === 'cta' ? { ...c, cta: slide } : { ...c, points: c.points.map((p) => (`p${p.number}` === id ? { ...p, ...slide, number: p.number, from_caption: p.from_caption } : p)) });

function reviseSchema() {
  return {
    type: 'object', additionalProperties: false, required: ['visual_idea', 'image_prompt', 'image_labels', 'symbols', 'headline_candidates', 'headline'],
    properties: {
      visual_idea: str('ONE sentence: the new visual idea of this slide.', 220),
      image_prompt: str('The new prompt for this slide\'s picture.', 1800),
      image_labels: imageLabelsSchema(),
      symbols: symbolsSchema(),
      headline_candidates: headlineCandidatesSchema(),
      headline: str('The best candidate (keep the current headline when the problem is only the picture).', 120),
    },
  };
}

/**
 * Sends ONE slide back to the brief step. mode 'rules' = the brief broke a rule (the code's own check, before any image);
 * mode 'meaning' = the picture was made but its idea does not land (QC feedback): ask for a DIFFERENT, more literal idea.
 * Returns { slide (merged, validated in the carousel's context), calls }. Throws BRIEF_INVALID when the slide still breaks a rule.
 */
export async function reviseSlide({ carousel, id, problems, mode, caption, facts, points, brand }) {
  const current = getSlide(carousel, id);
  const kind = id === 'hook' ? 'the hook slide' : id === 'cta' ? 'the closing call-to-action slide' : `point slide ${current.number} ("${current.from_caption}")`;
  const calls = [];
  let feedback = problems;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await briefProvider().generateStructured({
      system: SYSTEM,
      user: [
        `<post>\n${caption}\n</post>`,
        `<brand name="${brand?.name || ''}" primary="${brand?.primary || ''}" secondary="${brand?.secondary || ''}" accent="${brand?.accent || ''}"/>`,
        `<series style="${carousel.visual_style}">\n${carousel.world}\n</series>`,
        `<slide>${kind}\ncurrent idea: ${current.visual_idea || carousel.big_idea}\ncurrent headline: ${current.headline}\ncurrent image_prompt: ${current.image_prompt}\n</slide>`,
        mode === 'meaning'
          ? `The picture for this slide was made, but its meaning does not land. Quality-check feedback:\n${feedback.map((f) => `- ${f}`).join('\n')}\nWrite a DIFFERENT, more LITERAL visual idea: a real, specific situation a viewer recognises at a glance, with no symbolic props (or at most ${2} labelled ones). Keep the current headline unless it is the problem.`
          : `This slide breaks these rules - fix every one:\n${feedback.map((f) => `- ${f}`).join('\n')}`,
        'Return only this slide.',
      ].join('\n'),
      tool: { name: REVISE_TOOL, description: 'Emit the revised slide. Call this exactly once.', schema: reviseSchema() },
      model: CONCEPT_TEXT_MODEL, maxTokens: 2500, timeoutMs: CONCEPT_TIMEOUT_MS, retries: 1,
    });
    calls.push({ step: mode === 'meaning' ? `concept_retry_${id}` : `slide_repair_${id}`, model: res.model, usage: res.usage, durationMs: res.durationMs });
    const r = res.parsed || {};
    const keepHeadline = mode === 'meaning' && !feedback.some((f) => /headline/i.test(f));
    const merged = {
      ...current, visual_idea: String(r.visual_idea || '').trim(), image_prompt: String(r.image_prompt || '').trim(), image_labels: r.image_labels || [], symbols: r.symbols || [],
      ...(keepHeadline ? {} : { headline_candidates: r.headline_candidates || current.headline_candidates, headline: String(r.headline || current.headline).trim() }),
    };
    const checked = validateCarousel(toRaw(withSlide(carousel, id, merged)), { caption, facts, points });
    const mine = checked.errors.filter((e) => slideOfError(e) === id);
    if (!mine.length) return { slide: getSlide(checked.carousel, id), calls, headlineChanged: !keepHeadline };
    feedback = mine;
  }
  throw Object.assign(new Error('BRIEF_INVALID'), { code: 'BRIEF_INVALID', reason: `slide_${id}`, errors: feedback, calls });
}

/** Runs `tasks` (functions returning promises) with at most `limit` at a time; results in order. */
export async function withConcurrency(tasks, limit) {
  const out = new Array(tasks.length);
  let next = 0;
  const worker = async () => { while (next < tasks.length) { const i = next; next += 1; out[i] = await tasks[i](); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker));
  return out;
}

/**
 * The carousel brief, validated IN CODE before any image: a broken rule on one slide sends only that slide back (in parallel, no image
 * cost); a problem of the whole carousel repairs the whole brief once. The headline judge is NOT awaited here: `judge` is a promise
 * that runs while the hook picture is being made. Throws BRIEF_INVALID / CLAUDE_*.
 */
export { slideIds, getSlide };

export async function generateCarouselBrief(input) {
  // input.points: the carousel's stored points (an outlined caption); else the caption's own list
  const points = Array.isArray(input.points) && input.points.length ? input.points : captionPoints(input.caption);
  if (points.length < MIN_CAROUSEL_POINTS || points.length > MAX_CAROUSEL_POINTS) throw Object.assign(new Error('NOT_A_LIST'), { code: 'CAROUSEL_NEEDS_POINTS', reason: `points_${points.length}` });
  const tool = { name: CAROUSEL_TOOL, description: 'Emit the carousel. Call this exactly once.', schema: carouselSchema(points.length) };
  const calls = [];
  const adjusted = [];
  const repairs = [];
  let feedback = [];
  const started = Date.now();
  let checked = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await briefProvider().generateStructured({
      system: SYSTEM, user: userMessage({ ...input, points, feedback }), tool, model: CONCEPT_TEXT_MODEL, maxTokens: Math.max(CONCEPT_MAX_OUTPUT_TOKENS, 9000), timeoutMs: CONCEPT_TIMEOUT_MS, retries: 1,
    });
    calls.push({ step: attempt === 1 ? 'carousel_brief' : 'carousel_brief_repair', model: res.model, usage: res.usage, durationMs: res.durationMs });
    checked = validateCarousel(res.parsed, { caption: input.caption, facts: input.facts, points });
    const global = checked.errors.filter((e) => !slideOfError(e));
    if (!global.length) break;
    feedback = global.slice(0, 14);
    if (attempt === 2) throw Object.assign(new Error('BRIEF_INVALID'), { code: 'BRIEF_INVALID', errors: feedback, calls });
  }
  adjusted.push(...checked.adjusted);
  let c = checked.carousel;
  // slide-level rule breaks: only those slides go back to the brief step, all at once
  const bySlide = {};
  for (const e of checked.errors) { const id = slideOfError(e); if (id) (bySlide[id] ||= []).push(e); }
  const fixes = await Promise.all(Object.entries(bySlide).map(async ([id, problems]) => ({ id, problems, ...(await reviseSlide({ carousel: c, id, problems, mode: 'rules', caption: input.caption, facts: input.facts, points, brand: input.brand })) })));
  for (const f of fixes) { c = withSlide(c, f.id, f.slide); calls.push(...f.calls); repairs.push({ slide: f.id, problems: f.problems }); }

  // the headline judge, in parallel with the hook picture
  const sets = slideIds(c).map((id) => ({ id, context: id === 'hook' ? `hook slide: ${c.big_idea}` : id === 'cta' ? 'closing call-to-action slide' : `point ${getSlide(c, id).number}: ${getSlide(c, id).from_caption}`, candidates: getSlide(c, id).headline_candidates }));
  const judge = judgeHeadlines({ caption: input.caption, sets }).catch((error) => ({ failed: error?.code || 'error', picks: {}, call: { step: 'headline_judge', model: CONCEPT_TEXT_MODEL, usage: { inputTokens: 0, outputTokens: 0 } } }));
  return { carousel: c, points, judge, adjusted, repairs, calls, durationMs: Date.now() - started };
}

// ── the SPLIT brief: the look + hook first, every other slide written in parallel ─

export const LOOK_TOOL = 'emit_carousel_look';
export const SLIDE_TOOL = 'emit_carousel_slide';

function lookSchema(points) {
  const full = carouselSchema(points);
  return { type: 'object', additionalProperties: false, required: ['big_idea', 'visual_style', 'world', 'hook'], properties: { big_idea: full.properties.big_idea, visual_style: full.properties.visual_style, world: full.properties.world, hook: full.properties.hook } };
}
function slideOnlySchema(points, kind) {
  const full = carouselSchema(points);
  return { type: 'object', additionalProperties: false, required: ['slide'], properties: { slide: kind === 'cta' ? full.properties.cta_slide : full.properties.points.items } };
}

const seriesBlock = (look) => `<series style="${look.visual_style}" big_idea="${String(look.big_idea).replace(/"/g, "'")}">\n${look.world}\n</series>\n<hook headline="${String(look.hook.headline).replace(/"/g, "'")}">\n${look.hook.image_prompt}\n</hook>`;

/** One slide of the series (a point or the CTA), written on its own from the look. */
async function writeSlide({ input, points, look, kind, point = null }) {
  const others = points.filter((p) => !point || p.number !== point.number).map((p) => `${p.number}. ${p.text}`).join('\n');
  const res = await briefProvider().generateStructured({
    system: SYSTEM,
    user: [
      `<post platform="${input.platform}">`, input.caption, '</post>',
      `<brand name="${input.brand?.name || ''}" primary="${input.brand?.primary || ''}" secondary="${input.brand?.secondary || ''}" accent="${input.brand?.accent || ''}"/>`,
      `<business_facts>\n${input.facts || 'none'}\n</business_facts>`,
      seriesBlock(look),
      kind === 'cta'
        ? 'Write ONLY the closing call-to-action slide of this series (the caption\'s own call to action).'
        : `Write ONLY point slide ${point.number} of this series, for the caption point: "${point.text}". number = ${point.number}. The other point slides (written separately) cover:\n${others}\nGive this slide its own, different visual idea.`,
    ].join('\n'),
    tool: { name: SLIDE_TOOL, description: 'Emit this one slide. Call this exactly once.', schema: slideOnlySchema(points.length, kind) },
    model: CONCEPT_TEXT_MODEL, maxTokens: 2500, timeoutMs: CONCEPT_TIMEOUT_MS, retries: 1,
  });
  return { slide: res.parsed?.slide || null, call: { step: kind === 'cta' ? 'slide_brief_cta' : `slide_brief_p${point.number}`, model: res.model, usage: res.usage, durationMs: res.durationMs } };
}

/**
 * The SPLIT carousel brief. Call A (small) writes the look (big idea, style, world) and the hook - returned as soon as it passes the
 * code's rules, so the hook picture can start at once (with its headline judge in parallel). Meanwhile every point slide and the CTA slide
 * are written IN PARALLEL from that look, checked by the same rules together (a broken slide is repaired on its own) and judged.
 * Returns { look, partial, points, hookJudge, rest: Promise<{ carousel, judge, repairs, calls }>, calls, durationMs }. Throws BRIEF_INVALID / CLAUDE_*.
 */
export async function planCarousel(input) {
  // input.points: the carousel's stored points (an outlined caption); else the caption's own list
  const points = Array.isArray(input.points) && input.points.length ? input.points : captionPoints(input.caption);
  if (points.length < MIN_CAROUSEL_POINTS || points.length > MAX_CAROUSEL_POINTS) throw Object.assign(new Error('NOT_A_LIST'), { code: 'CAROUSEL_NEEDS_POINTS', reason: `points_${points.length}` });
  const started = Date.now();
  const calls = [];
  let feedback = [];
  let look = null;
  for (let attempt = 1; attempt <= 2 && !look; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await briefProvider().generateStructured({
      system: `${SYSTEM}\n\nWrite ONLY the look of the series (big_idea, visual_style, world) and the HOOK slide now. The other slides are written next, in parallel, from your world description - make it specific enough to keep them one series.`,
      user: userMessage({ ...input, points, feedback }),
      tool: { name: LOOK_TOOL, description: 'Emit the look and the hook slide. Call this exactly once.', schema: lookSchema(points.length) },
      model: CONCEPT_TEXT_MODEL, maxTokens: 3500, timeoutMs: CONCEPT_TIMEOUT_MS, retries: 1,
    });
    calls.push({ step: attempt === 1 ? 'carousel_look' : 'carousel_look_repair', model: res.model, usage: res.usage, durationMs: res.durationMs });
    const checked = validateCarousel({ ...(res.parsed || {}), points: [], cta_slide: {} }, { caption: input.caption, facts: input.facts, points: [] });
    const errs = checked.errors.filter((e) => { const id = slideOfError(e); return id === 'hook' || id === null; });
    if (!errs.length) look = { version: CAROUSEL_BRIEF_VERSION, big_idea: checked.carousel.big_idea, visual_style: checked.carousel.visual_style, world: checked.carousel.world, hook: checked.carousel.hook };
    else feedback = errs.slice(0, 10);
  }
  if (!look) throw Object.assign(new Error('BRIEF_INVALID'), { code: 'BRIEF_INVALID', errors: feedback, calls });
  const lookMs = Date.now() - started;

  const judgeCatch = (error) => ({ failed: error?.code || 'error', picks: {}, call: { step: 'headline_judge', model: CONCEPT_TEXT_MODEL, usage: { inputTokens: 0, outputTokens: 0 } } });
  const hookJudge = judgeHeadlines({ caption: input.caption, sets: [{ id: 'hook', context: `hook slide: ${look.big_idea}`, candidates: look.hook.headline_candidates }] }).catch(judgeCatch);

  const rest = (async () => {
    const t0 = Date.now();
    const written = await Promise.all([...points.map((point) => writeSlide({ input, points, look, kind: 'point', point })), writeSlide({ input, points, look, kind: 'cta' })]);
    const restCalls = written.map((w) => w.call);
    const raw = { big_idea: look.big_idea, visual_style: look.visual_style, world: look.world, hook: look.hook, points: written.slice(0, points.length).map((w, i) => ({ ...(w.slide || {}), number: i + 1 })), cta_slide: written[points.length].slide || {} };
    const checked = validateCarousel(raw, { caption: input.caption, facts: input.facts, points });
    let c = { ...checked.carousel, hook: look.hook };
    const bySlide = {};
    for (const e of checked.errors) { const id = slideOfError(e); if (id && id !== 'hook') (bySlide[id] ||= []).push(e); }
    const fixes = await Promise.all(Object.entries(bySlide).map(async ([id, problems]) => ({ id, problems, ...(await reviseSlide({ carousel: c, id, problems, mode: 'rules', caption: input.caption, facts: input.facts, points, brand: input.brand })) })));
    const repairs = [];
    for (const f of fixes) { c = withSlide(c, f.id, f.slide); restCalls.push(...f.calls); repairs.push({ slide: f.id, problems: f.problems }); }
    const sets = slideIds(c).filter((id) => id !== 'hook').map((id) => ({ id, context: id === 'cta' ? 'closing call-to-action slide' : `point ${getSlide(c, id).number}: ${getSlide(c, id).from_caption}`, candidates: getSlide(c, id).headline_candidates }));
    const judge = judgeHeadlines({ caption: input.caption, sets }).catch(judgeCatch);
    return { carousel: c, judge, repairs, calls: restCalls, adjusted: checked.adjusted, durationMs: Date.now() - t0 };
  })();

  return {
    look, points, hookJudge, rest, calls, lookMs,
    partial: { version: CAROUSEL_BRIEF_VERSION, big_idea: look.big_idea, visual_style: look.visual_style, world: look.world, hook: look.hook, points: [], cta: null },
    total: points.length + 2,
  };
}

/** Applies the judge's pick to a slide (the brief's own headline stays when the judge failed or found nothing natural). */
function applyPick(slide, pick) {
  if (!pick?.headline) return { ...slide, headline_ranked: pick?.ranked || [], headlineNote: pick ? 'judge_found_no_natural_candidate' : 'judge_unavailable' };
  return { ...slide, headline: pick.headline, headline_ranked: pick.ranked, headline_scores: pick.scores };
}

const conceptOf = (s, { layout, style, bigIdea, number = null }) => ({
  hook_headline: s.headline, headline_ranked: s.headline_ranked || [], subline: s.subline || '', cta: s.cta || '', layout, visual_style: style,
  image_prompt: s.image_prompt, image_labels: s.image_labels || [], symbols: s.symbols || [], big_idea: bigIdea, ...(number != null ? { number } : {}),
});

/** The render job of one slide, with its concept retry wired to reviseSlide. */
function slideJob({ c, id, index, total, common, reference, judgeFor, ctx }) {
  const s = getSlide(c, id);
  const kind = id === 'hook' ? 'hook' : id === 'cta' ? 'cta' : 'point';
  const layout = kind === 'hook' ? 'full_bleed_bottom' : kind === 'cta' ? 'carousel_cta' : 'carousel_point';
  const bigIdea = kind === 'hook' ? c.big_idea : kind === 'cta' ? 'closing call to action' : s.visual_idea;
  const concept = conceptOf(s, { layout, style: c.visual_style, bigIdea, number: s.number ?? null });
  let revisedSlide = null;
  return renderConcept({
    ...common, concept, referenceImages: reference ? [reference] : [], slide: { index, total }, step: `slide_${index}`,
    extraExpected: [...(concept.number != null ? [String(concept.number).padStart(2, '0')] : []), `${index}/${total}`],
    qcContext: `This is slide ${index} of ${total} of a carousel (${kind === 'point' ? `point ${s.number}: "${s.from_caption}"` : kind === 'hook' ? 'the hook' : 'the closing call to action'}). It must look like one series: ${c.world}`,
    beforeCompose: judgeFor ? async (cur) => { const pick = await judgeFor(id); const ap = applyPick({ headline: cur.hook_headline, headline_ranked: cur.headline_ranked }, pick); return { ...cur, hook_headline: ap.headline, headline_ranked: ap.headline_ranked || [] }; } : null,
    reviseConcept: async ({ concept: cur, qc }) => {
      const problems = (qc.issues || []).filter((i) => !/^possible \(mild\)/.test(i)).slice(0, 6);
      const base = withSlide(c, id, { ...s, headline: cur.hook_headline });
      const r = await reviseSlide({ carousel: base, id, problems, mode: 'meaning', caption: ctx.caption, facts: ctx.facts, points: ctx.points, brand: common.brand });
      revisedSlide = r.slide;
      return { concept: { image_prompt: r.slide.image_prompt, image_labels: r.slide.image_labels, symbols: r.slide.symbols, big_idea: kind === 'point' ? r.slide.visual_idea : bigIdea, ...(r.headlineChanged ? { hook_headline: r.slide.headline, headline_ranked: [] } : {}) }, calls: r.calls };
    },
  }).then((out) => ({ index, kind, id, ...out, revisedSlide }));
}

/**
 * Renders the given slides of a carousel from a reference picture (the hook's): all at once up to `concurrency`; a slide the image API
 * rate-limited is tried again afterwards at CAROUSEL_RATE_LIMITED_CONCURRENCY. Used by generateCarousel and to regenerate single slides.
 */
export async function regenerateSlides({ carousel, ids, reference, provider, brand, logo = null, input, points, shape = 'portrait', quality = 'medium', qcRetries = QC_MAX_RETRIES, concurrency = CAROUSEL_CONCURRENCY, judgeFor = null, onSlideStart = null, onSlideDone = null, total: totalOverride = null }) {
  const c = carousel;
  const all = slideIds(c);
  const total = totalOverride || all.length;
  const common = { provider, brand, logo, caption: input.caption, facts: input.facts, shape, quality, qcRetries };
  const ctx = { caption: input.caption, facts: input.facts, points: points || captionPoints(input.caption) };
  const safe = async (fn, arg) => { if (fn) { try { await fn(arg); } catch { /* progress is best effort */ } } };
  const run = (id) => async () => {
    await safe(onSlideStart, id);
    const out = await slideJob({ c, id, index: all.indexOf(id) + 1, total, common, reference, judgeFor, ctx })
      .catch((error) => ({ index: all.indexOf(id) + 1, id, kind: id === 'hook' ? 'hook' : id === 'cta' ? 'cta' : 'point', error: { code: error?.code || 'GENERATION_FAILED', reason: error?.reason || null } }));
    await safe(onSlideDone, out);
    return out;
  };
  const first = await withConcurrency(ids.map(run), concurrency);
  const limited = first.filter((r) => r.error?.code === PROVIDER_ERROR.RATE_LIMITED).map((r) => r.id);
  if (!limited.length) return first;
  const again = await withConcurrency(limited.map(run), CAROUSEL_RATE_LIMITED_CONCURRENCY);
  return first.map((r) => again.find((a) => a.id === r.id) || r);
}

const priced = (calls) => calls.map((x) => ({ kind: 'text', ...x, costUsd: claudeCostUsd(x.model, x.usage) }));
const round4 = (n) => Math.round(n * 10_000) / 10_000;

/**
 * The whole carousel: brief (rules checked in code, broken slides repaired before any image) -> hook picture while the judge runs ->
 * every other slide from the hook picture as reference, in parallel. A slide below the bar after its retry is marked needsAttention.
 * Returns { brief, slides[], costUsd, durationMs, needsAttention[] }.
 */
export async function generateCarousel({ input, provider, brand, logo = null, shape = 'portrait', quality = 'medium', qcRetries = QC_MAX_RETRIES, onStage = null, concurrency = CAROUSEL_CONCURRENCY }) {
  const started = Date.now();
  if (onStage) { try { await onStage('concept'); } catch { /* best effort */ } }
  // the SPLIT brief: the look + hook first; the hook picture starts at once while the other slides are written in parallel
  const plan = await planCarousel({ ...input, brand });
  const common = { provider, brand, logo, caption: input.caption, facts: input.facts, shape, quality, qcRetries };
  const ctx = { caption: input.caption, facts: input.facts, points: plan.points };
  const hookJudgeFor = async (id) => (await plan.hookJudge).picks?.[id] || null;
  const [hook, rest] = await Promise.all([
    slideJob({ c: plan.partial, id: 'hook', index: 1, total: plan.total, common, reference: null, judgeFor: hookJudgeFor, ctx }),
    plan.rest,
  ]);
  const c = rest.carousel;
  const judgeFor = async (id) => (await rest.judge).picks?.[id] || null;
  const reference = await referenceFrom(hook.picture);
  const others = await regenerateSlides({ carousel: c, ids: slideIds(c).slice(1), reference, provider, brand, logo, input, points: plan.points, shape, quality, qcRetries, concurrency, judgeFor });
  const slides = [hook, ...others].sort((a, b) => a.index - b.index);

  const [hj, rj] = await Promise.all([plan.hookJudge, rest.judge]);
  const briefCalls = priced([...plan.calls, ...rest.calls, hj.call, rj.call]);
  const briefCost = briefCalls.reduce((s, x) => s + (x.costUsd || 0), 0);
  return {
    brief: { version: CAROUSEL_BRIEF_VERSION, carousel: c, adjusted: rest.adjusted, repairs: rest.repairs, lookMs: plan.lookMs, slidesBriefMs: rest.durationMs, calls: briefCalls, costUsd: round4(briefCost), judge: hj.failed || rj.failed ? { failed: hj.failed || rj.failed } : { ok: true } },
    slides,
    reference: { from: 'slide_1_picture', bytes: reference.buffer.length },
    needsAttention: slides.filter((s) => s.needsAttention || s.error).map((s) => ({ index: s.index, ...(s.error ? { error: s.error } : s.needsAttention) })),
    costUsd: round4(briefCost + slides.reduce((s, x) => s + (x.costUsd || 0), 0)),
    durationMs: Date.now() - started,
  };
}

export default { planCarousel, generateCarousel, generateCarouselBrief, regenerateSlides, reviseSlide, validateCarousel, captionPoints, carouselEligibility, outlineCaptionPoints, slideOfError, CAROUSEL_TOOL };
