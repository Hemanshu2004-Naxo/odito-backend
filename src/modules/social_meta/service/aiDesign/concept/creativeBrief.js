import claudeStrategyProvider from '../../aiStrategy/claudeStrategyProvider.js';
import {
  BRIEF_VERSION, MAX_WORDS_PER_IMAGE, MAX_HEADLINE_WORDS, MAX_SUBLINE_WORDS, MAX_SLIDE_LINE_WORDS, MAX_CTA_WORDS, MIN_CAROUSEL_SLIDES, MAX_CAROUSEL_SLIDES,
  VISUAL_STYLES, SINGLE_LAYOUTS, LAYOUT_IDS, NEVER_DEFAULT_LAYOUTS, BANNED_CLICHES, CLICHE_PATTERNS, CONCEPT_TEXT_MODEL, CONCEPT_TIMEOUT_MS, CONCEPT_MAX_OUTPUT_TOKENS,
  HEADLINE_CANDIDATES, MIN_HEADLINE_NATURAL, MIN_HEADLINE_CLEAR, AWKWARD_HEADLINE_PATTERNS, MAX_IMAGE_LABELS, MAX_IMAGE_LABEL_WORDS, COMPARISON_PATTERN, MAX_SYMBOLS, SYMBOL_CROWD_PATTERN,
  SENSITIVE_METAPHORS, SOLID_PANEL_LAYOUTS, SOLID_PANEL_WINDOW, PHOTOGRAPHIC_WORDS,
} from './conceptConfig.js';

/**
 * The CREATIVE BRIEF: Claude turns a post into one or more design concepts - the visual idea, a short headline written FOR the image,
 * the image prompt and the layout. The image supports the caption instead of repeating it. Every answer is validated here (Claude's
 * tool schema shapes it; this module decides whether it may be used), with ONE repair pass that is told exactly what was wrong.
 *
 * HARD RULES: no invented facts (a figure, result, client, award or promise only when the caption or the business profile states it);
 * no banned clichés; no metaphor with a strong social or political reading; ONE visual style per image; objects that stand for something
 * get a label and a comparison shows its direction; the headline is the most natural of FIVE candidates, as an independent judge
 * scores them; at most one solid-panel layout in any three designs.
 */

export const BRIEF_TOOL = 'emit_design_concepts';
export const JUDGE_TOOL = 'judge_headlines';

export const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean);
// NFKC first: "bold" caption letters (mathematical bold 𝗦𝗹𝗼𝘄) compare as the plain letters they stand for
export const normalise = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9%$€£ ]+/g, ' ').replace(/\s+/g, ' ').trim();
/** Removes negated clauses ("no handshake, no lightbulb", "never a glass ceiling") before a banned-word check. */
export const withoutNegations = (s) => String(s || '').replace(/\b(no|not|never|avoid|without|instead of|rather than|replace[sd]?)\b[^.;]*/gi, '');

const str = (description, maxLength) => ({ type: 'string', description, ...(maxLength ? { maxLength } : {}) });

/** The schema of the image labels (Odito draws them; the image model never draws text). */
export const imageLabelsSchema = () => ({
  type: 'array', maxItems: MAX_IMAGE_LABELS,
  description: `Labels Odito draws on the picture, at most ${MAX_IMAGE_LABELS}, each at most ${MAX_IMAGE_LABEL_WORDS} words: what an abstract object stands for, or "Before"/"After" for a comparison. [] when the picture explains itself.`,
  items: { type: 'object', additionalProperties: false, required: ['text', 'position'], properties: { text: str('1-2 words.', 24), position: { type: 'string', enum: ['left', 'right', 'top', 'bottom'] } } },
});

/** Objects that stand for something, declared so the code can count them (at most MAX_SYMBOLS). */
export const symbolsSchema = () => ({
  type: 'array', maxItems: MAX_SYMBOLS,
  description: `Objects in the picture that STAND FOR something (a service, a task, a problem), at most ${MAX_SYMBOLS}. Each must be obvious by itself or be named by an image label. [] for a literal scene (preferred).`,
  items: { type: 'object', additionalProperties: false, required: ['object', 'stands_for'], properties: { object: str('The object as it appears.', 80), stands_for: str('What it means.', 80) } },
});

export const headlineCandidatesSchema = () => ({
  type: 'array', minItems: HEADLINE_CANDIDATES, maxItems: HEADLINE_CANDIDATES,
  description: `${HEADLINE_CANDIDATES} different headline options for the image, each at most ${MAX_HEADLINE_WORDS} words. hook_headline must be one of them.`,
  items: str(`At most ${MAX_HEADLINE_WORDS} words.`, 80),
});

/** The tool schema Claude fills in (n concepts). */
export function briefToolSchema(count) {
  const concept = {
    type: 'object',
    additionalProperties: false,
    required: ['format', 'big_idea', 'headline_candidates', 'hook_headline', 'subline', 'slides', 'visual_style', 'image_prompt', 'image_labels', 'symbols', 'layout', 'cta', 'why_it_works'],
    properties: {
      format: { type: 'string', enum: ['single_image', 'carousel'] },
      big_idea: str('ONE sentence: the visual concept (a metaphor or a real scene that carries the message).', 220),
      headline_candidates: headlineCandidatesSchema(),
      hook_headline: str(`The best of the candidates: at most ${MAX_HEADLINE_WORDS} words, NOT copied from the caption.`, 80),
      subline: str(`Optional supporting line, at most ${MAX_SUBLINE_WORDS} words, or "" for none.`, 110),
      slides: {
        type: 'array', description: `Carousel only (${MIN_CAROUSEL_SLIDES}-${MAX_CAROUSEL_SLIDES} slides); [] for a single image.`,
        items: { type: 'object', additionalProperties: false, required: ['role', 'headline', 'visual'], properties: { role: { type: 'string', enum: ['hook', 'point', 'proof', 'cta'] }, headline: str(`At most ${MAX_HEADLINE_WORDS} words.`, 80), visual: str('The scene of this slide.', 300) } },
      },
      visual_style: { type: 'string', enum: [...VISUAL_STYLES] },
      image_prompt: str('The prompt for the image model: subject, setting, composition, lighting, style, colour palette using the brand hex codes, where the empty space for text is, and NO text in the image.', 2400),
      image_labels: imageLabelsSchema(),
      symbols: symbolsSchema(),
      layout: { type: 'string', enum: [...LAYOUT_IDS] },
      cta: str(`A short call to action for the image, at most ${MAX_CTA_WORDS} words, or "" for none.`, 50),
      why_it_works: str('One short sentence for the reviewer: why this concept fits the post.', 200),
    },
  };
  return { type: 'object', additionalProperties: false, required: ['concepts'], properties: { concepts: { type: 'array', minItems: count, maxItems: count, items: concept } } };
}

/** The rules every brief (single image or carousel) gives Claude. */
export const SHARED_RULES = `- NO MADE-UP FACTS. Never state a number, statistic, percentage, price, result, client name, award, ranking or promise ("guaranteed", "#1", "double your...") unless it appears in the caption or the business facts. When in doubt, leave it out.
- Banned visual clichés (never in an idea or an image prompt): ${BANNED_CLICHES.join('; ')}.
- NO SENSITIVE METAPHORS: never use an image with a strong social, political, religious or identity reading - e.g. a "glass ceiling" (reads as gender/racial discrimination, especially with a woman), chains or shackles, prison bars, border walls, flags, protests, weapons, disability as a metaphor. Choose a neutral, literal business scene that cannot be misread (a cramped low-ceilinged office, a stack of client work that has hit the ceiling).
- THE PICTURE CARRIES THE MESSAGE, NOT THE KEYWORDS: a viewer must take the headline's meaning from the picture. "Three things holding your website back" needs something held back, weighed down or blocked - not a three-legged stool (that reads as stability, the opposite). Never pick an object only because it matches a word or a number in the headline.
- NO WEB ADDRESSES as words in the idea: the website is never part of the picture or the headline (Odito adds the bare domain itself where it belongs).
- ONE STYLE PER IMAGE: a photo is a real photo throughout; an editorial illustration has an illustrated or solid-colour background (never a blurred photo, bokeh or depth of field); a 3D render has a rendered or solid background.
- READABLE SYMBOLS: prefer a literal scene whose meaning is obvious. Declare every object that stands for something in "symbols" - at most ${MAX_SYMBOLS} (never a row of five icons); when objects must stand for things (services, tasks, problems), use at most two, give each a clear, simple pictogram icon in the picture or name it with an image label of 1-2 words. Never build the idea on something that would need WRITING inside the picture (a sign, a sticky note, a "No Vacancy" card, a label on a folder) - the picture has no text, so it would be blank. A before/after or split comparison: the image_prompt must describe a picture split into two clearly different halves (left = before, right = after), and the concept gets two image labels ("Before" / "After" or similar) - Odito adds the arrow.
- HEADLINES: write ${HEADLINE_CANDIDATES} different candidates, then pick the most natural. Natural spoken English with a clear subject and verb, readable in one second. No riddles ("Your ceiling isn't clients."), no personified abstractions ("Delivery work is running you."), no puns that need the caption to make sense.
- image_prompt: subject, setting, composition, lighting, rendering style, a palette built on the brand hex codes, and exactly where the calm, EMPTY area for the text is (nothing detailed may sit there - it must be plain background). The image contains NO text, letters, numbers, signs, logos or watermarks; icons are fine. Never put the post's words or the business name in the prompt.`;

const SYSTEM = `You are the senior art director of a social media agency. You turn ONE post into design concepts that look like a strong agency made them: real imagery, ONE clear idea per visual, on brand, different from post to post.

RULES
1. The image SUPPORTS the caption; it does not repeat it. Turn the message into a visual metaphor or a real, specific scene (e.g. "capacity" -> an overflowing in-tray on a desk in a calm, empty office).
2. hook_headline: at most ${MAX_HEADLINE_WORDS} words, written for the image, NOT copied from the caption. subline: at most ${MAX_SUBLINE_WORDS} words or "". cta: at most ${MAX_CTA_WORDS} words or "". Headline + subline + cta + image labels together: at most ${MAX_WORDS_PER_IMAGE} words.
${SHARED_RULES}
- Rotate: do not reuse the visual_style + layout combination of the most recent design listed below, and prefer ones not used in the recent designs. Solid-colour text panels (${SOLID_PANEL_LAYOUTS.join(', ')}) at most once in any ${SOLID_PANEL_WINDOW} designs in a row.
- When several concepts are asked for, each must be a DIFFERENT idea (different metaphor or scene, different layout) - never colour or wording variations of one design.
- A list of 3+ points suits a carousel; a single image then carries ONE metaphor for the whole message. Follow the requested format when one is given.

LAYOUTS (choose one; respect its text zone)
${Object.entries(SINGLE_LAYOUTS).map(([id, l]) => `- ${id}: ${l.label}. Text zone: ${l.textZone}.${NEVER_DEFAULT_LAYOUTS.includes(id) ? ' Use only with a clear reason (proof_stat needs a real number from the caption or facts).' : ''}`).join('\n')}`;

/** The user message: the post and everything the concept may draw on. */
/**
 * A layout per concept that satisfies the rules up front (different layouts, at most one solid panel, none if one was used in the last
 * designs, never the default-excluded ones): the brief is TOLD it instead of guessing and being refused.
 */
export function suggestedLayouts(count, recent = []) {
  const solidRecently = recent.slice(0, SOLID_PANEL_WINDOW - 1).some((r) => SOLID_PANEL_LAYOUTS.includes(r.layout));
  const open = ['full_bleed_bottom', 'editorial_cover'];
  const solid = solidRecently ? [] : ['split_image_text'];
  const plan = [...open, ...solid];
  // a third concept when no solid panel is allowed: a full-bleed layout again, with a different visual style
  while (plan.length < count) plan.push(open[plan.length % open.length]);
  return plan.slice(0, count);
}

export function briefUserMessage({ caption, pillar, platform, objective, audience, brand, facts, recent = [], count = 1, format = null, avoid = [], feedback = [], direction = '' }) {
  const lines = [
    `<post platform="${platform}" pillar="${pillar || ''}" objective="${objective || ''}">`, caption, '</post>',
    `<audience>${audience || 'not stated'}</audience>`,
    `<brand name="${brand.name || ''}" primary="${brand.primary || ''}" secondary="${brand.secondary || ''}" accent="${brand.accent || ''}" heading_font="${brand.headingFont || ''}" tone="${brand.tone || ''}"/>`,
    `<business_facts>\n${facts || 'none'}\n</business_facts>`,
    `<recent_designs newest_first="true">\n${recent.length ? recent.map((r) => `- style=${r.visual_style} layout=${r.layout} idea=${r.big_idea || ''}`).join('\n') : 'none'}\n</recent_designs>`,
    ...(direction ? [`<art_direction from="the reviewer">\n${direction}\n</art_direction>`] : []),
    `Produce ${count} concept${count === 1 ? '' : 's'}.${format ? ` Format: ${format} for every concept.` : ''}`,
    ...(count > 1 ? [`Use these layouts, one per concept in this order: ${suggestedLayouts(count, recent).join(', ')}. Concepts that share a layout must use different visual styles.`] : []),
  ];
  if (avoid.length) lines.push(`Do NOT repeat these existing concepts:\n${avoid.map((a) => `- ${a}`).join('\n')}`);
  if (feedback.length) lines.push(`Your previous answer was refused for these reasons - fix every one:\n${feedback.map((f) => `- ${f}`).join('\n')}`);
  return lines.join('\n');
}

const FIGURE_RE = /(?:[$€£₹]\s?\d[\d,.]*|\d[\d,.]*\s?(?:%|percent|x\b|k\b|m\b)|\b\d[\d,.]*\b)/gi;
const PROMISE_RE = /\b(guarantee[ds]?|award(?:-winning|s)?|#\s?1|number one|no\.\s?1|world[- ]class|industry[- ]leading|best in|double your|triple your|10x)\b/gi;

/** Figures and promise words in `text` that the caption and the facts do not support. */
export function unsupportedClaims(text, sourceText) {
  const source = normalise(sourceText);
  const out = [];
  for (const m of String(text || '').match(FIGURE_RE) || []) {
    const digits = m.replace(/[^0-9]/g, '');
    if (digits && !source.replace(/[^0-9 ]/g, ' ').split(/\s+/).includes(digits) && !source.includes(normalise(m))) out.push(m.trim());
  }
  for (const m of String(text || '').match(PROMISE_RE) || []) if (!source.includes(normalise(m))) out.push(m.trim());
  return [...new Set(out)];
}

/** True when `headline` is lifted from the caption (4+ words appearing in it verbatim). */
export function copiedFromCaption(headline, caption) {
  const h = normalise(headline);
  return words(h).length >= 4 && normalise(caption).includes(h);
}

/** A sensitive metaphor in the visual text (negated mentions ignored): { reading, match } or null. */
export function sensitiveMetaphor(text) {
  const t = withoutNegations(text);
  for (const s of SENSITIVE_METAPHORS) { const m = t.match(s.pattern); if (m) return { reading: s.reading, match: m[0] }; }
  return null;
}

/** Problems of the visual side of a concept (idea + prompt): clichés, sensitive metaphors, mixed styles. */
export function visualProblems({ text, visualStyle, p }) {
  const errors = [];
  const clean = withoutNegations(text);
  const cliche = CLICHE_PATTERNS.find((re) => re.test(clean));
  if (cliche) errors.push(`${p}: uses a banned visual cliché (${String(cliche).slice(1, 40)}...) - choose a specific scene or metaphor instead`);
  const sensitive = sensitiveMetaphor(text);
  if (sensitive) errors.push(`${p}: "${sensitive.match}" has a strong social/political reading (${sensitive.reading}) and will be misread - use a neutral, literal scene instead`);
  if (['editorial_illustration', '3d_render', 'bold_typographic'].includes(visualStyle) && PHOTOGRAPHIC_WORDS.test(clean)) {
    errors.push(`${p}: mixes photographic elements (${clean.match(PHOTOGRAPHIC_WORDS)[0]}) into a ${visualStyle} - one style per image: use an illustrated / rendered / solid background`);
  }
  return errors;
}

/** Checks the image labels; returns { labels, errors }. A comparison (before/after, split) needs two labels on different sides. */
export function checkImageLabels(raw, { bigIdea = '', prompt = '', p }) {
  const errors = [];
  const labels = (Array.isArray(raw) ? raw : []).map((l) => ({ text: String(l?.text || '').trim(), position: l?.position })).filter((l) => l.text);
  if (labels.length > MAX_IMAGE_LABELS) errors.push(`${p}: at most ${MAX_IMAGE_LABELS} image labels`);
  for (const l of labels) {
    if (words(l.text).length > MAX_IMAGE_LABEL_WORDS) errors.push(`${p}: image label "${l.text}" has more than ${MAX_IMAGE_LABEL_WORDS} words`);
    if (!['left', 'right', 'top', 'bottom'].includes(l.position)) errors.push(`${p}: image label "${l.text}" needs a position (left, right, top, bottom)`);
  }
  if (COMPARISON_PATTERN.test(withoutNegations(`${bigIdea} ${prompt}`))) {
    const sides = new Set(labels.map((l) => l.position));
    if (labels.length < 2 || sides.size < 2) errors.push(`${p}: a comparison (before/after, split) must show its direction - give two image labels on different sides (e.g. "Before" left, "After" right)`);
  }
  // labels on the left AND right only make sense over a picture that really has two halves
  const sidesUsed = new Set(labels.map((l) => l.position));
  if (sidesUsed.has('left') && sidesUsed.has('right') && !/\b(left|split|two halves|half)\b/i.test(prompt)) errors.push(`${p}: left and right labels need an image_prompt that describes a picture split into a left half and a right half`);
  // the image has no text, so the idea may not depend on writing inside it
  if (/\b(signage|signpost|placard|a sign (saying|reading|that says)|sticky notes? (saying|reading|that says)|note (saying|reading|that says)|card (saying|reading|that says)|reads? ["'“]|labell?ed ["'“]|written on it)/i.test(withoutNegations(`${bigIdea} ${prompt}`))) {
    errors.push(`${p}: the idea depends on writing inside the picture (a sign / note / label) - the picture has no text, so show it without words`);
  }
  return { labels: labels.slice(0, MAX_IMAGE_LABELS), errors };
}

/**
 * The symbol rule: at most MAX_SYMBOLS declared symbols, no visual that lines up a crowd of symbolic objects, and a symbol whose meaning
 * is not obvious gets an image label. Returns errors.
 */
export function checkSymbols(raw, { bigIdea = '', prompt = '', labels = [], p }) {
  const errors = [];
  const symbols = (Array.isArray(raw) ? raw : []).filter((s) => s && String(s.object || '').trim());
  if (symbols.length > MAX_SYMBOLS) errors.push(`${p}: ${symbols.length} symbolic objects - at most ${MAX_SYMBOLS}; show a literal scene or keep the two that matter`);
  const crowd = withoutNegations(`${bigIdea} ${prompt}`).match(SYMBOL_CROWD_PATTERN);
  if (crowd) errors.push(`${p}: "${crowd[0]}" lines up more than ${MAX_SYMBOLS} symbolic objects - a viewer cannot read them without labels; use a literal scene or at most ${MAX_SYMBOLS} labelled objects`);
  if (symbols.length + labels.length > 0 && labels.length > MAX_SYMBOLS) errors.push(`${p}: at most ${MAX_SYMBOLS} labels`);
  return { symbols: symbols.slice(0, MAX_SYMBOLS).map((s) => ({ object: String(s.object).trim(), stands_for: String(s.stands_for || '').trim() })), errors };
}

/** A headline that reads as a riddle / odd personification (deterministic half; the judge catches the rest). */
export const awkwardHeadline = (h) => AWKWARD_HEADLINE_PATTERNS.some((re) => re.test(String(h || '').trim()));

/** Checks the five candidates; returns { candidates (usable ones, in order), errors }. */
export function checkHeadlineCandidates(raw, { chosen, caption, source, p, maxWords = MAX_HEADLINE_WORDS }) {
  const errors = [];
  const all = (Array.isArray(raw) ? raw : []).map((h) => String(h || '').trim()).filter(Boolean);
  const distinct = [...new Map(all.map((h) => [normalise(h), h])).values()];
  if (distinct.length < HEADLINE_CANDIDATES) errors.push(`${p}: write ${HEADLINE_CANDIDATES} DIFFERENT headline candidates (got ${distinct.length})`);
  if (chosen && !distinct.some((h) => normalise(h) === normalise(chosen))) errors.push(`${p}: the chosen headline must be one of the ${HEADLINE_CANDIDATES} candidates`);
  const usable = distinct.filter((h) => words(h).length && words(h).length <= maxWords && !copiedFromCaption(h, caption) && !unsupportedClaims(h, source).length && !awkwardHeadline(h));
  if (!usable.length) errors.push(`${p}: none of the headline candidates is usable (too long, copied from the caption, an unsupported claim, or an awkward riddle/personification) - write natural, plain ones`);
  return { candidates: usable, errors };
}

/**
 * Validates and cleans Claude's concepts. Returns { concepts, errors, adjusted }: errors are reasons to repair (sent back verbatim),
 * adjusted are harmless fixes made here (recorded). A concept is never "fixed" by inventing anything.
 */
export function validateConcepts(raw, { count, caption, facts = '', recent = [], format = null }) {
  const errors = [];
  const adjusted = [];
  const list = Array.isArray(raw?.concepts) ? raw.concepts : [];
  if (list.length !== count) errors.push(`exactly ${count} concept(s) are required, got ${list.length}`);
  const source = `${caption}\n${facts}`;
  const last = recent[0] || null;
  const solidRecently = recent.slice(0, SOLID_PANEL_WINDOW - 1).some((r) => SOLID_PANEL_LAYOUTS.includes(r.layout));
  const concepts = list.slice(0, count).map((c, i) => {
    const p = `concept ${i + 1}`;
    const out = {
      format: format || c.format, big_idea: String(c.big_idea || '').trim(), hook_headline: String(c.hook_headline || '').trim(), subline: String(c.subline || '').trim(),
      slides: Array.isArray(c.slides) ? c.slides.map((s) => ({ role: s.role, headline: String(s.headline || '').trim(), visual: String(s.visual || '').trim() })) : [],
      visual_style: c.visual_style, image_prompt: String(c.image_prompt || '').trim(), layout: c.layout, cta: String(c.cta || '').trim(), why_it_works: String(c.why_it_works || '').trim(),
    };
    if (format && c.format !== format) adjusted.push(`${p}: format set to the requested ${format}`);
    if (!['single_image', 'carousel'].includes(out.format)) errors.push(`${p}: format must be single_image or carousel`);
    if (!VISUAL_STYLES.includes(out.visual_style)) errors.push(`${p}: visual_style must be one of ${VISUAL_STYLES.join(', ')}`);
    if (!LAYOUT_IDS.includes(out.layout)) errors.push(`${p}: layout must be one of ${LAYOUT_IDS.join(', ')}`);
    if (!out.big_idea) errors.push(`${p}: big_idea is required`);
    const hw = words(out.hook_headline).length;
    if (!hw) errors.push(`${p}: hook_headline is required`);
    if (hw > MAX_HEADLINE_WORDS) errors.push(`${p}: hook_headline has ${hw} words, at most ${MAX_HEADLINE_WORDS}`);
    if (copiedFromCaption(out.hook_headline, caption)) errors.push(`${p}: hook_headline is copied from the caption - write a new one for the image`);
    const heads = checkHeadlineCandidates(c.headline_candidates, { chosen: out.hook_headline, caption, source, p });
    errors.push(...heads.errors);
    out.headline_candidates = heads.candidates;
    if (awkwardHeadline(out.hook_headline) && heads.candidates.length) {
      adjusted.push(`${p}: awkward headline "${out.hook_headline}" replaced by the candidate "${heads.candidates[0]}"`);
      out.hook_headline = heads.candidates[0];
    }
    if (words(out.subline).length > MAX_SUBLINE_WORDS) errors.push(`${p}: subline has more than ${MAX_SUBLINE_WORDS} words`);
    if (words(out.cta).length > MAX_CTA_WORDS) errors.push(`${p}: cta has more than ${MAX_CTA_WORDS} words`);
    const lab = checkImageLabels(c.image_labels, { bigIdea: out.big_idea, prompt: out.image_prompt, p });
    errors.push(...lab.errors);
    out.image_labels = lab.labels;
    const sym = checkSymbols(c.symbols, { bigIdea: out.big_idea, prompt: out.image_prompt, labels: out.image_labels, p });
    errors.push(...sym.errors);
    out.symbols = sym.symbols;
    const labelWords = out.image_labels.reduce((s, l) => s + words(l.text).length, 0);
    // the word budget of one image: a subline that breaks it is dropped (the headline and CTA carry the image)
    if (hw + words(out.subline).length + words(out.cta).length + labelWords > MAX_WORDS_PER_IMAGE && out.subline) {
      out.subline = '';
      adjusted.push(`${p}: subline dropped to keep the image at ${MAX_WORDS_PER_IMAGE} words or fewer`);
    }
    if (hw + words(out.cta).length + labelWords > MAX_WORDS_PER_IMAGE) errors.push(`${p}: headline + cta + labels exceed ${MAX_WORDS_PER_IMAGE} words`);
    if (out.format === 'carousel') {
      if (out.slides.length < MIN_CAROUSEL_SLIDES || out.slides.length > MAX_CAROUSEL_SLIDES) errors.push(`${p}: a carousel needs ${MIN_CAROUSEL_SLIDES}-${MAX_CAROUSEL_SLIDES} slides`);
      out.slides.forEach((s, j) => { if (words(s.headline).length > MAX_SLIDE_LINE_WORDS) errors.push(`${p} slide ${j + 1}: headline over ${MAX_SLIDE_LINE_WORDS} words`); });
    } else if (out.slides.length) {
      out.slides = [];
      adjusted.push(`${p}: slides removed (single image)`);
    }
    if (out.image_prompt.length < 200) errors.push(`${p}: image_prompt is too short - describe subject, setting, composition, lighting, style, palette and the empty text zone`);
    // no invented facts on the image
    const onImage = [out.hook_headline, out.subline, out.cta, ...out.image_labels.map((l) => l.text), ...out.slides.map((s) => s.headline)].join(' \n ');
    const claims = unsupportedClaims(onImage, source);
    if (claims.length) errors.push(`${p}: these are not stated in the caption or the business facts, so they may not appear: ${claims.join(', ')}`);
    errors.push(...visualProblems({ text: [out.big_idea, out.image_prompt, ...out.slides.map((s) => s.visual)].join(' \n '), visualStyle: out.visual_style, p }));
    if (last && last.visual_style === out.visual_style && last.layout === out.layout) errors.push(`${p}: repeats the visual_style + layout of the most recent design (${out.visual_style} + ${out.layout})`);
    if (solidRecently && SOLID_PANEL_LAYOUTS.includes(out.layout)) errors.push(`${p}: a solid-panel layout (${out.layout}) was used in the last ${SOLID_PANEL_WINDOW - 1} designs - at most one in ${SOLID_PANEL_WINDOW}; choose a layout with the text on the picture`);
    return out;
  });
  if (concepts.length > 1) {
    // variety: never the same style + layout twice, and at least two different layouts (three are not always possible: the solid-panel
    // layouts may be ruled out by the last designs)
    const layouts = new Set(concepts.map((c) => c.layout));
    const combos = new Set(concepts.map((c) => `${c.visual_style}+${c.layout}`));
    if (combos.size < concepts.length) errors.push('two concepts use the same visual_style + layout - every concept needs a different combination');
    if (layouts.size < Math.min(2, concepts.length)) errors.push('use at least two different layouts across the concepts');
    if (concepts.filter((c) => SOLID_PANEL_LAYOUTS.includes(c.layout)).length > 1) errors.push(`at most one concept may use a solid-panel layout (${SOLID_PANEL_LAYOUTS.join(', ')})`);
    for (let i = 0; i < concepts.length; i += 1) {
      for (let j = i + 1; j < concepts.length; j += 1) {
        const a = new Set(words(normalise(concepts[i].big_idea)).filter((w) => w.length > 4));
        const b = words(normalise(concepts[j].big_idea)).filter((w) => w.length > 4);
        const shared = b.filter((w) => a.has(w)).length;
        if (b.length && shared / b.length > 0.6) errors.push(`concepts ${i + 1} and ${j + 1} are the same idea - make them different concepts`);
      }
    }
  }
  return { concepts, errors, adjusted };
}

let providerOverride = null;
/** Test seam: substitute the Claude provider (same generateStructured contract). */
export const setBriefProviderOverride = (p) => { providerOverride = p || null; };
export const isBriefProviderOverridden = () => providerOverride !== null;
export const briefProvider = () => providerOverride || claudeStrategyProvider;

function judgeSchema() {
  const score = (d) => ({ type: 'integer', minimum: 1, maximum: 5, description: d });
  return {
    type: 'object', additionalProperties: false, required: ['sets'],
    properties: {
      sets: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: ['id', 'scores'],
          properties: {
            id: { type: 'string' },
            scores: {
              type: 'array',
              items: {
                type: 'object', additionalProperties: false, required: ['headline', 'natural', 'clear', 'fits', 'issue'],
                properties: {
                  headline: { type: 'string' },
                  natural: score('5 = a native copywriter would publish it as is; 1 = awkward, a riddle, an odd personification or broken grammar.'),
                  clear: score('5 = understood in one second without the caption; 1 = unclear what it means.'),
                  fits: score('5 = says exactly what the image / slide is about.'),
                  issue: { type: 'string', maxLength: 160, description: 'The main weakness in plain words, or "".' },
                },
              },
            },
          },
        },
      },
    },
  };
}

/**
 * The independent HEADLINE JUDGE: one Claude call scores every candidate set (natural / clear / fits) and the most natural usable one
 * wins (ties: the brief's own order). `sets` = [{ id, context, candidates[] }]. Returns { picks: { [id]: { headline, scores, rejected } }, call }.
 * A set with no candidate scoring >= MIN_HEADLINE_NATURAL natural and >= MIN_HEADLINE_CLEAR clear has `headline: null`.
 */
export async function judgeHeadlines({ sets, caption }) {
  const res = await briefProvider().generateStructured({
    system: 'You are a senior copy chief. You score short social media headlines strictly. Awkward, riddle-like or oddly personified lines score low on "natural" even when they are clever.',
    user: [
      `<caption>\n${caption}\n</caption>`,
      ...sets.map((s) => `<set id="${s.id}" context="${String(s.context || '').replace(/"/g, "'")}">\n${s.candidates.map((h) => `- ${h}`).join('\n')}\n</set>`),
      'Score every headline of every set.',
    ].join('\n'),
    tool: { name: JUDGE_TOOL, description: 'Report the headline scores. Call this exactly once.', schema: judgeSchema() },
    model: CONCEPT_TEXT_MODEL, maxTokens: 3000, timeoutMs: CONCEPT_TIMEOUT_MS, retries: 1,
  });
  const picks = {};
  for (const s of sets) {
    const got = (res.parsed?.sets || []).find((x) => String(x.id) === String(s.id));
    const scored = s.candidates.map((h, order) => {
      const sc = (got?.scores || []).find((x) => normalise(x.headline) === normalise(h)) || null;
      return { headline: h, order, natural: sc?.natural ?? 0, clear: sc?.clear ?? 0, fits: sc?.fits ?? 0, issue: sc?.issue || '' };
    });
    const ok = scored.filter((x) => x.natural >= MIN_HEADLINE_NATURAL && x.clear >= MIN_HEADLINE_CLEAR)
      .sort((a, b) => (b.natural + b.clear + b.fits) - (a.natural + a.clear + a.fits) || b.natural - a.natural || a.order - b.order);
    picks[s.id] = { headline: ok[0]?.headline || null, scores: scored, ranked: ok.map((x) => x.headline), rejected: scored.filter((x) => !ok.includes(x)).map((x) => ({ headline: x.headline, issue: x.issue })) };
  }
  return { picks, call: { step: 'headline_judge', model: res.model, usage: res.usage, durationMs: res.durationMs } };
}

/**
 * Asks Claude for `count` concepts and validates them (one repair pass), then lets the judge pick each headline from its candidates.
 * Throws { code: 'BRIEF_INVALID' | CLAUDE_* } when no usable brief comes back; the caller then falls back to the rule-based design.
 */
export async function generateCreativeBrief(input) {
  const count = Math.max(1, Math.min(3, input.count || 1));
  const tool = { name: BRIEF_TOOL, description: 'Emit the design concepts. Call this exactly once.', schema: briefToolSchema(count) };
  const calls = [];
  let feedback = [];
  const started = Date.now();
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await briefProvider().generateStructured({
      system: SYSTEM, user: briefUserMessage({ ...input, count, feedback }), tool,
      model: CONCEPT_TEXT_MODEL, maxTokens: CONCEPT_MAX_OUTPUT_TOKENS, timeoutMs: CONCEPT_TIMEOUT_MS, retries: 1,
    });
    calls.push({ step: attempt === 1 ? 'brief' : 'brief_repair', model: res.model, usage: res.usage, durationMs: res.durationMs });
    const checked = validateConcepts(res.parsed, { count, caption: input.caption, facts: input.facts, recent: input.recent || [], format: input.format || null });
    if (!checked.errors.length) {
      // the headline: the judge's most natural usable candidate
      // eslint-disable-next-line no-await-in-loop
      const judged = await judgeHeadlines({ caption: input.caption, sets: checked.concepts.map((c, i) => ({ id: String(i + 1), context: c.big_idea, candidates: c.headline_candidates })) });
      calls.push(judged.call);
      const unjudged = [];
      checked.concepts.forEach((c, i) => {
        const pick = judged.picks[String(i + 1)];
        c.headline_scores = pick.scores;
        c.headline_ranked = pick.ranked;
        if (!pick.headline) { unjudged.push(`concept ${i + 1}: every headline candidate was judged awkward or unclear (${pick.rejected.map((r) => `"${r.headline}": ${r.issue}`).join('; ').slice(0, 400)}) - write five plainer, natural headlines`); return; }
        if (normalise(pick.headline) !== normalise(c.hook_headline)) checked.adjusted.push(`concept ${i + 1}: headline "${c.hook_headline}" -> judge's pick "${pick.headline}"`);
        c.hook_headline = pick.headline;
      });
      if (!unjudged.length) return { version: BRIEF_VERSION, concepts: checked.concepts, adjusted: checked.adjusted, calls, model: res.model, durationMs: Date.now() - started, repaired: attempt > 1 };
      feedback = unjudged;
      // eslint-disable-next-line no-continue
      continue;
    }
    feedback = checked.errors.slice(0, 12);
  }
  throw Object.assign(new Error('BRIEF_INVALID'), { code: 'BRIEF_INVALID', errors: feedback, calls });
}

/**
 * A CONCEPT RETRY for a single image: the picture was made but its idea does not land (QC feedback). Claude writes a DIFFERENT, more
 * literal visual idea for the same headline; the code validates it like any brief (one repair). Returns { concept, calls }.
 */
export async function reviseConcept({ concept, problems, input, brand }) {
  const schema = {
    type: 'object', additionalProperties: false, required: ['big_idea', 'image_prompt', 'image_labels', 'symbols'],
    properties: { big_idea: str('ONE sentence: the new visual idea.', 220), image_prompt: str('The new image prompt.', 2400), image_labels: imageLabelsSchema(), symbols: symbolsSchema() },
  };
  const calls = [];
  let feedback = problems;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await briefProvider().generateStructured({
      system: SYSTEM,
      user: [
        `<post>\n${input.caption}\n</post>`,
        `<brand name="${brand?.name || ''}" primary="${brand?.primary || ''}" secondary="${brand?.secondary || ''}" accent="${brand?.accent || ''}"/>`,
        `<current_concept style="${concept.visual_style}" layout="${concept.layout}">\nidea: ${concept.big_idea}\nheadline: ${concept.hook_headline}\nimage_prompt: ${concept.image_prompt}\n</current_concept>`,
        attempt === 1
          ? `The picture was made, but its meaning does not land. Quality-check feedback:\n${feedback.map((f) => `- ${f}`).join('\n')}\nWrite a DIFFERENT, more LITERAL visual idea for the same headline, style and layout: a real, specific situation a viewer recognises at a glance.`
          : `Your revision breaks these rules - fix every one:\n${feedback.map((f) => `- ${f}`).join('\n')}`,
      ].join('\n'),
      tool: { name: 'emit_revised_concept', description: 'Emit the revised visual. Call this exactly once.', schema },
      model: CONCEPT_TEXT_MODEL, maxTokens: 2500, timeoutMs: CONCEPT_TIMEOUT_MS, retries: 1,
    });
    calls.push({ step: 'concept_retry', model: res.model, usage: res.usage, durationMs: res.durationMs });
    const merged = { ...concept, ...res.parsed, headline_candidates: concept.headline_candidates?.length ? concept.headline_candidates : [concept.hook_headline, 'a', 'b', 'c', 'd'] };
    const checked = validateConcepts({ concepts: [merged] }, { count: 1, caption: input.caption, facts: input.facts, recent: [], format: concept.format || 'single_image' });
    const errs = checked.errors.filter((e) => !/headline candidates|chosen headline/.test(e));
    if (!errs.length) return { concept: { ...checked.concepts[0], hook_headline: concept.hook_headline, headline_ranked: concept.headline_ranked || [], headline_candidates: concept.headline_candidates || [] }, calls };
    feedback = errs;
  }
  throw Object.assign(new Error('BRIEF_INVALID'), { code: 'BRIEF_INVALID', reason: 'concept_retry', errors: feedback, calls });
}

export default { reviseConcept, generateCreativeBrief, validateConcepts, unsupportedClaims, copiedFromCaption, briefToolSchema, judgeHeadlines, BRIEF_TOOL, JUDGE_TOOL };
