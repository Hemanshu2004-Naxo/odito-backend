/**
 * The concept-design pipeline (creative brief -> image -> Odito's own text overlay -> quality check): every rule and price in one place.
 */

const num = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

export const BRIEF_VERSION = 'social-ai-concept-brief-v2';
export const CAROUSEL_BRIEF_VERSION = 'social-ai-carousel-brief-v1';

/** Words on ONE image (headline + subline + CTA + kicker): more is not a social post, it is a page. */
export const MAX_WORDS_PER_IMAGE = 15;
export const MAX_HEADLINE_WORDS = 8;
export const MAX_SUBLINE_WORDS = 12;
export const MAX_SLIDE_LINE_WORDS = 15;
export const MAX_CTA_WORDS = 5;
export const MIN_CAROUSEL_SLIDES = 4;
export const MAX_CAROUSEL_SLIDES = 8;
/** A carousel "point" slide: one idea, at most this many words (its big number not counted). */
export const MAX_POINT_SLIDE_WORDS = 12;
export const MIN_CAROUSEL_POINTS = 3;
/** Point slides in one carousel: Instagram allows 10 slides, and the hook + CTA take two of them. */
export const MAX_CAROUSEL_POINTS = 8;
/** A caption list of up to this many items is still a carousel: 9-10 items are merged (by Claude) into at most MAX_CAROUSEL_POINTS. */
export const MAX_LISTED_POINTS = 10;

/** The brief writes this many headline candidates per image; an independent judge picks the most natural one. */
export const HEADLINE_CANDIDATES = 5;
/** The judge's minimum (1-5) for a headline to be used: it must read as natural English and be clear on first read. */
export const MIN_HEADLINE_NATURAL = 4;
export const MIN_HEADLINE_CLEAR = 4;

/**
 * Headline shapes that read as riddles or odd personifications (they were the weak ones in review: "Your ceiling isn't clients.",
 * "Delivery work is running you."). The judge catches the rest.
 */
export const AWKWARD_HEADLINE_PATTERNS = Object.freeze([
  /^(your|the|my|our|their)\s+[a-z'-]+\s+(isn'?t|is not|aren'?t|are not)\s+(?:[a-z'-]+\s?){1,2}[.!?]?$/i,
  /\b(work|delivery|growth|capacity|time|business|admin|busywork)\s+(is|are)\s+(running|eating|owning|killing|managing|controlling)\s+(you|your)\b/i,
]);

/**
 * Small words labelling what an abstract object stands for (drawn by Odito, never by the image model): at most this many per image,
 * each at most this many words.
 */
export const MAX_IMAGE_LABELS = 2;
/** Objects in the picture that STAND FOR something (a service, a task, a problem): at most this many, each declared in the brief. */
export const MAX_SYMBOLS = 2;
/** A visual that lines up many symbolic objects ("five service icons", "a row of 6 tiles") - more than MAX_SYMBOLS. */
export const SYMBOL_CROWD_PATTERN = /\b(three|four|five|six|seven|eight|nine|ten|several|multiple|many|numerous|a dozen|[3-9]|1\d)\s+(?:[a-z-]+\s+){0,3}(icons?|symbols?|cards?|tiles?|tokens?|badges?|pictograms?|emblems?|labels?|signs? for)\b/i;
export const MAX_IMAGE_LABEL_WORDS = 2;
/** A concept that compares two states (before/after, split, versus) must make the direction obvious: two labels (and an arrow). */
export const COMPARISON_PATTERN = /\b(before[- ]and[- ]after|before\s*(\/|vs\.?|versus|and)\s*after|split[- ]?(screen|scene|panel|image|composition|frame)|two (clearly )?(different )?halves|side[- ]by[- ]side|versus|vs\.|(left|right) half)\b/i;

/**
 * Metaphors with a strong social or political reading: on a business post they get misread (a woman under a "glass ceiling" reads as
 * gender discrimination, not capacity). The brief must not use them; the QC looks for any other misreading.
 */
export const SENSITIVE_METAPHORS = Object.freeze([
  { pattern: /glass[- ]ceiling/i, reading: 'gender or racial discrimination at work (the "glass ceiling")' },
  { pattern: /\b(chains?|chained|shackles?|shackled|manacles?)\b/i, reading: 'slavery or imprisonment' },
  { pattern: /\b(handcuff\w*|prison|jail|behind bars|cell bars)\b/i, reading: 'crime and punishment' },
  { pattern: /\b(border wall|barbed[- ]wire|border fence|refugee)\b/i, reading: 'immigration politics' },
  { pattern: /\b(national flag|flags?\b|protest\w*|picket\w*|riot\w*|ballot\w*|election)\b/i, reading: 'politics or national identity' },
  { pattern: /\b(crucifix|church|mosque|temple|prayer|praying|halo)\b/i, reading: 'religion' },
  { pattern: /\b(wheelchair|crutch(es)?|blindfold\w*)\b/i, reading: 'disability used as a metaphor' },
  { pattern: /\b(noose|gun|rifle|pistol|weapon|drowning|grave|coffin)\b/i, reading: 'violence, death or self-harm' },
  { pattern: /\b(sweatshop|whip(ped|ping)?)\b/i, reading: 'exploitation' },
]);

/** Layouts that put the text on a solid colour panel: at most ONE in any three designs in a row (and among compared concepts). */
export const SOLID_PANEL_LAYOUTS = Object.freeze(['split_image_text', 'big_type_statement']);
export const SOLID_PANEL_WINDOW = 3;

/**
 * ONE style per image: what the image model is told for each visual style, and the words that mean another style crept in
 * (an illustration with a blurred photo background was the review's example).
 */
export const STYLE_RULES = Object.freeze({
  photo: 'One style only: a real photograph throughout - no illustrated, cartoon or 3D-rendered elements.',
  '3d_render': 'One style only: a 3D render throughout - a rendered set and a rendered or solid-colour background; no photographic background, no blurred real photo.',
  editorial_illustration: 'One style only: a flat editorial illustration throughout - an illustrated or solid-colour background; no photographic elements, no blurred photo background, no bokeh, no depth-of-field blur.',
  bold_typographic: 'One style only: simple graphic shapes on a solid brand-colour background; no photograph and no illustration of people.',
});
export const PHOTOGRAPHIC_WORDS = /\b(blur(red|ry)?|bokeh|depth[- ]of[- ]field|photograph\w*|photo-?real\w*|photoreal\w*|\d{2,3}\s?mm|lens|dslr|out[- ]of[- ]focus)\b/i;

/** A text zone is BUSY when more than this share of its small tiles (32 px) vary more than BUSY_TILE_STDEV (grey levels). Calibrated on
 *  the step-2 pictures: under the readable text 0-1% of tiles vary, under option 2's overlapping subline/CTA 20-90%. */
export const BUSY_TILE_PX = 32;
export const BUSY_TILE_STDEV = 12;
export const BUSY_FRACTION = 0.15;

/** The smallest headline the renderer may draw, in px at a 1080 px wide canvas (scaled for other widths). */
export const MIN_HEADLINE_PX_AT_1080 = 64;

export const VISUAL_STYLES = Object.freeze(['photo', '3d_render', 'editorial_illustration', 'bold_typographic']);

/** The single-image layouts (see conceptLayouts.js). Each says where the image must leave calm, empty space for the text. */
export const SINGLE_LAYOUTS = Object.freeze({
  full_bleed_bottom: { label: 'Full-bleed photo, headline at the bottom', textZone: 'the bottom 40% of the frame', image: 'full' },
  editorial_cover: { label: 'Editorial magazine cover', textZone: 'the top 35% of the frame', image: 'full' },
  split_image_text: { label: 'Split: image above, text panel below', textZone: 'no text on the image (the text sits on a separate panel); keep the subject centred', image: 'top' },
  big_type_statement: { label: 'Big-type statement with a small image', textZone: 'no text on the image (it is shown small, in a frame); one clear subject', image: 'inset' },
  proof_stat: { label: 'Proof / stat: one big real number and one line', textZone: 'the left 55% of the frame', image: 'full' },
  infographic_image: { label: 'Infographic over an image: headline and up to 3 short labels', textZone: 'the left half of the frame', image: 'full' },
});
export const LAYOUT_IDS = Object.freeze(Object.keys(SINGLE_LAYOUTS));
/** Never the default layout: only when the brief has a clear reason (and it always carries an image). */
export const NEVER_DEFAULT_LAYOUTS = Object.freeze(['infographic_image', 'proof_stat']);

/**
 * Visual clichés the brief must never use, and the image prompt always forbids. "Generic stock group photo" covers the look the
 * old pipeline produced: a smiling diverse team around a table / laptop / papers in a bright office.
 */
export const BANNED_CLICHES = Object.freeze([
  'handshake', 'lightbulb', 'rocket ship', 'rocket', 'people in suits pointing at a laptop or screen', 'fake UI dashboards or charts on screens',
  'generic stock group photo: a smiling team gathered around a table, laptop, papers or whiteboard', 'diverse group posing or high-fiving',
  'people looking at a laptop together', 'thumbs up', 'puzzle pieces', 'target with arrow', 'chess pieces', 'stock meeting-room scene',
]);
/** Patterns that, in an image prompt or a visual description, mean a cliché crept in. */
export const CLICHE_PATTERNS = Object.freeze([
  /hand\s*shake/i, /light\s*bulb/i, /\brocket/i, /pointing at (a |the )?(laptop|screen|monitor)/i, /dashboard/i, /high[- ]fiv/i, /thumbs? up/i,
  /puzzle piece/i, /\bchess\b/i, /\b(team|group|colleagues|coworkers|people)\b[^.]{0,60}\b(around|at|gathered|huddled)\b[^.]{0,30}\b(table|laptop|desk|whiteboard)/i,
  /\bdiverse (team|group)\b/i, /\bsmiling (team|group|colleagues)\b/i, /\bmeeting room\b/i,
]);

/** Claude for the brief and the visual check (the existing Social AI integration and key). */
export const CONCEPT_TEXT_MODEL = process.env.SOCIAL_AI_CONCEPT_MODEL || process.env.SOCIAL_AI_STRATEGY_MODEL || process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
export const CONCEPT_TIMEOUT_MS = num(process.env.SOCIAL_AI_CONCEPT_TIMEOUT_MS, 120_000);
export const CONCEPT_MAX_OUTPUT_TOKENS = num(process.env.SOCIAL_AI_CONCEPT_MAX_OUTPUT_TOKENS, 6_000);

/** A design scoring below this is regenerated once (QC_MAX_RETRIES), then the best result is kept. */
export const QC_PASS_SCORE = 8; // the user's bar: nothing below 8 ships without a "needs attention" mark
/** How many carousel slides are generated at the same time after the hook (3 when the image API rate-limits). */
export const CAROUSEL_CONCURRENCY = num(process.env.SOCIAL_AI_CAROUSEL_CONCURRENCY, 6);
export const CAROUSEL_RATE_LIMITED_CONCURRENCY = 3;
export const QC_MAX_RETRIES = num(process.env.SOCIAL_AI_DESIGN_QC_RETRIES, 1);

/**
 * Prices (USD per 1M tokens) for the cost log. Sources: OpenAI pricing page (gpt-image-2 / 2.5 / 2.6 families, Standard tier, checked
 * 2026-11-17) and Anthropic's published Sonnet pricing. Update when a price changes; an unknown model is logged with cost null.
 */
export const PRICES_PER_MTOK = Object.freeze({
  image: Object.freeze({ textInput: 5, imageInput: 8, imageOutput: 30 }),
  claude: Object.freeze({
    'claude-sonnet-4-6': { input: 3, output: 15 },
    'claude-sonnet-4-5': { input: 3, output: 15 },
    'claude-opus-4-1': { input: 15, output: 75 },
  }),
});

const round4 = (n) => Math.round(n * 10_000) / 10_000;

/** USD of one image call from its usage (gpt-image families share one price). */
export function imageCostUsd(usage = {}) {
  const p = PRICES_PER_MTOK.image;
  const text = usage.textInputTokens ?? 0;
  const imageIn = usage.imageInputTokens ?? 0;
  const out = usage.imageOutputTokens ?? usage.outputTokens ?? 0;
  return round4((text * p.textInput + imageIn * p.imageInput + out * p.imageOutput) / 1_000_000);
}

/** USD of one Claude call, or null when the model's price is not known. */
export function claudeCostUsd(model, usage = {}) {
  const key = Object.keys(PRICES_PER_MTOK.claude).find((m) => String(model || '').startsWith(m));
  if (!key) return null;
  const p = PRICES_PER_MTOK.claude[key];
  return round4(((usage.inputTokens || 0) * p.input + (usage.outputTokens || 0) * p.output) / 1_000_000);
}
