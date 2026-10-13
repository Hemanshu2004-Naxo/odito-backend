import crypto from 'crypto';
import { LAYOUT_NEEDS, missingForLayout } from './compose/layoutNeeds.js';
import { chooseVisualConcept } from './designVisual.js';

/**
 * Design strategy - the DECISION layer between a post and a finished creative. Pure (no database, no network).
 *
 * Odito designs in two halves. The image model supplies a PHOTOGRAPH (when the layout wants one); Odito's composer draws every
 * word, the real logo and every contact detail. This module decides what the design IS and builds the structured DESIGN BRIEF
 * that both halves read - the single source of truth:
 *
 *   { creativeType, family, layoutId, headline, subheadline, points[], services[], servicesLabel, cta, contact{},
 *     figures[], product{}, photography{ required, scene }, brandColors, typography, logo, notes, ... }
 *
 * Honesty rules the brief enforces (a design may only say what the business supplied):
 *   - every string a design carries (headline, subheadline, points, services, call to action, figures) comes from the approved
 *     caption, the calendar plan, the live Business Profile or the product catalog - never written here, never invented; a
 *     candidate that contains a prohibited phrase is dropped;
 *   - contact details (phone, website, email) are the profile's real values, shown only when the design's purpose needs them;
 *   - a data design needs figures that appear in the caption or plan; a list design needs its points; a service design needs the
 *     business's real services; a product design needs the real product photo - otherwise a different, honest layout is chosen.
 */

export const DESIGN_BRIEF_VERSION = 'social-ai-design-brief-v2';

/**
 * What a creative type is. `family` groups the three directions Creative Studio offers (photography / showcase / infographic);
 * `layoutId` is the composer template it normally uses; `photo` says whether it carries an AI photograph.
 */
export const CREATIVE_TYPES = Object.freeze({
  premium_editorial: { label: 'Photography editorial', family: 'photo', layoutId: 'photo_hero', photo: true },
  team_story: { label: 'Team / behind the scenes', family: 'photo', layoutId: 'photo_hero', photo: true },
  brand_awareness: { label: 'Brand awareness', family: 'photo', layoutId: 'photo_hero', photo: true },
  service_promotion: { label: 'Service promotion', family: 'showcase', layoutId: 'service_list', photo: true, needsServices: true },
  lead_generation: { label: 'Lead generation', family: 'showcase', layoutId: 'service_list', photo: true, needsServices: true },
  service_expertise: { label: 'Service / expertise', family: 'showcase', layoutId: 'service_list', photo: true, needsServices: true },
  announcement: { label: 'Announcement', family: 'showcase', layoutId: 'announcement_banner', photo: true },
  product_showcase: { label: 'Product showcase', family: 'showcase', layoutId: 'product_hero', photo: false, needsProductAsset: true },
  educational_list: { label: 'Educational list', family: 'infographic', layoutId: 'infographic_points', photo: false, needsPoints: true },
  process_checklist: { label: 'Process / checklist', family: 'infographic', layoutId: 'infographic_points', photo: false, needsPoints: true },
  comparison: { label: 'Comparison', family: 'infographic', layoutId: 'infographic_points', photo: false, needsPoints: true },
  modern_saas: { label: 'Modern infographic', family: 'infographic', layoutId: 'infographic_points', photo: false },
  data_insight: { label: 'Data / insight', family: 'infographic', layoutId: 'insight_stats', photo: false, needsFigures: true },
  case_study: { label: 'Case study / results', family: 'infographic', layoutId: 'insight_stats', photo: false },
  quote: { label: 'Quote', family: 'infographic', layoutId: 'statement_quote', photo: false, needsQuote: true },
  statement: { label: 'Brand statement', family: 'infographic', layoutId: 'statement_quote', photo: false },
});

/** Visual patterns a photograph must never contain (see designVisual.VISUAL_AVOID for the provider wording). */
export const PROHIBITED_ELEMENTS = Object.freeze([
  'any readable text, letters, numbers, logos or watermarks in the photograph', 'cartoon, illustrated or 3D-rendered people or objects', 'distorted hands, faces or anatomy',
  'celebrities or recognisable real people', 'handshake clichés, lightbulbs, rockets, arrows', 'glowing "AI" imagery, circuit boards, holograms', 'unrelated people or scenes',
]);

const PLATFORM_BEHAVIOUR = Object.freeze({
  instagram: { orientation: 'square (1:1)' },
  facebook: { orientation: 'landscape (3:2)' },
});

// ── text helpers ─────────────────────────────────────────────────────────────

// angle brackets are dropped so a value can never imitate a delimiter tag
const clean = (v, max = 400) => String(v ?? '').replace(/[<>]/g, '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** At most `maxWords` words and `maxChars` characters, cut on a word boundary, without dangling punctuation. */
export function clampText(value, { maxWords, maxChars }) {
  let words = clean(value, 400).split(' ').filter(Boolean);
  if (words.length > maxWords) words = words.slice(0, maxWords);
  let text = words.join(' ');
  if (text.length > maxChars) text = text.slice(0, maxChars).replace(/\s+\S*$/, '');
  return text.replace(/[\s,;:–—-]+$/, '').trim();
}

/**
 * A headline that fits a thumbnail WITHOUT being cut mid-thought: the whole text when it is short enough, else its first
 * clause (up to a comma / colon / dash or a joining word), else the whole text when it still fits the relaxed limit, else ''
 * (the caller then tries the next candidate). Never "the first nine words of a longer sentence".
 */
export function fitHeadline(value) {
  // a closing full stop or exclamation mark is dropped on a headline; a QUESTION MARK is part of the meaning ("Is your agency ready?") and stays
  const text = clean(value, 300).replace(/[.!]+$/, '').replace(/\?{2,}$/, '?').trim();
  const words = (t) => t.split(' ').filter(Boolean).length;
  const fits = (t, maxWords, maxChars) => t && words(t) >= 2 && words(t) <= maxWords && t.length <= maxChars;
  if (fits(text, 9, 70)) return text;
  const clause = text.split(/[,;:–—]\s|\s-\s/)[0].trim(); // only a punctuation break is a real clause boundary
  if (clause && clause !== text && fits(clause, 9, 70) && words(clause) >= 3) return clause;
  if (fits(text, HEADLINE_MAX_WORDS, HEADLINE_MAX_CHARS)) return text;
  return '';
}

/** Headline room: a whole sentence up to this long (the composer shrinks the type to fit; anything longer is refused rather than cut). */
export const HEADLINE_MAX_WORDS = 16;
export const HEADLINE_MAX_CHARS = 100;

const sentences = (text) => String(text || '').split(/(?<=[.!?])\s+|\n+/).map((s) => clean(s, 240)).filter(Boolean);

/** An unambiguous call to action ("Book a check-up this month", "Follow us for..."): never the subject of a post, so never chosen as its headline while a real subject exists. */
const CTA_VERB_RE = /^(book|call|visit|contact|follow|shop|order|sign up|join|download|schedule|reserve|request|message|dm|subscribe|register|enquire|inquire|claim|learn more|tap|click|drop us|send us|reach out|get in touch|talk to|speak to)\b/i;
export const isCtaSentence = (s) => CTA_VERB_RE.test(String(s || '').trim());

/** The caption's own sentences with the structure removed: numbered / bulleted lines, the trailing hashtag block, links and hashtag lines. */
export function proseSentences(caption) {
  const prose = String(caption || '').split('\n').filter((l) => !/^\s*(?:\d{1,2}[.)]|\d{1,2}\s*[-–:]|[-•*▪✓✔→])\s/.test(l)).join('\n').replace(/(?:\s*#[\p{L}\p{N}_]+)+\s*$/u, '');
  return sentences(prose).filter((s) => !/https?:\/\//i.test(s) && !/^#/.test(s)).slice(0, 8);
}

/** The caption's own call to action when it is a short sentence ("Book a check-up this month"), so a button can carry it; '' when there is none. */
export function ctaFromCaption(caption) {
  const found = proseSentences(caption).find((s) => isCtaSentence(s) && s.replace(/[.!?]+$/, '').split(' ').length <= 6);
  return found ? found.replace(/[.!?]+$/, '').trim() : '';
}

/** Enough real words to be a headline: letters, and at least two different words. */
const isMeaningful = (t) => /\p{L}{3,}/u.test(t) && new Set(String(t).toLowerCase().split(/\s+/).filter(Boolean)).size >= 2;

const JOINERS_RE = /^(?:a|an|the|and|but|or|so|to|of|for|in|on|at|by|with|as|that|which|is|are|was|were|be|it|its|this|these|those|your|our|their|my|his|her|from|than|then|if|when|while|because|since|about)$/i;
// where a clause can end: a conjunction, or a preposition that starts the rest ("...the simplest way | to protect your smile")
const CONJUNCTION_RE = /\s(?:and|but|because|so|which|that|while|when|as|although|though|or|since|if|to|for|with|from|into|than)\s/gi;

/**
 * A safe, bounded headline from ONE long sentence that has no punctuation to cut at (the post is real; it just is not written for a thumbnail):
 * the longest clause that ends where a conjunction or preposition begins (4-12 words, 80 characters), else its first words up to a word boundary,
 * never ending on a joining word - always shown with an ellipsis so it reads as an excerpt. Never splits a word, never adds a word. '' when the sentence
 * is too short or too empty to carry a design (fewer than 8 words, fewer than 4 real words, or repeated filler).
 */
export function boundedHeadline(sentence) {
  const text = clean(sentence, 400).replace(/[.!]+$/, '').trim();
  const words = text.split(' ').filter(Boolean);
  const real = words.filter((w) => /\p{L}{4,}/u.test(w));
  if (words.length < 8 || real.length < 4 || new Set(words.map((w) => w.toLowerCase())).size < 5) return '';
  const trimTail = (list) => { const out = [...list]; while (out.length > 3 && JOINERS_RE.test(String(out[out.length - 1]).replace(/[,;:]+$/, ''))) out.pop(); return out; };
  let clause = '';
  for (const m of text.matchAll(CONJUNCTION_RE)) {
    const left = trimTail(text.slice(0, m.index).trim().split(' ').filter(Boolean));
    if (left.length >= 4 && left.length <= 12 && left.join(' ').length <= 80) clause = left.join(' ');
  }
  if (clause) return `${clause.replace(/[,;:\s–—-]+$/, '')}…`;
  const cut = trimTail(words.slice(0, 10));
  const out = cut.join(' ').replace(/[,;:\s–—-]+$/, '');
  return cut.length >= 4 && out.length <= 70 ? `${out}…` : '';
}

/**
 * The headline: (1) the plan's own text; (2) a complete, concise sentence of the caption that is not a call to action - the first one that
 * fits, with its punctuation (a question stays a question); (3) a bounded excerpt of a long unpunctuated sentence; (4) only then a call to
 * action, rather than nothing. Returns { headline, source: 'plan' | 'caption' | 'shortened' | 'cta' | null }.
 */
export function chooseHeadline({ planItem = null, caption = '', allowedText = () => true } = {}) {
  for (const candidate of [planItem?.onCreativeText, planItem?.topic]) {
    const h = fitHeadline(candidate);
    if (h && allowedText(h)) return { headline: h, source: 'plan' };
  }
  const all = proseSentences(caption);
  const subject = all.filter((s) => !isCtaSentence(s));
  for (const s of subject) {
    const h = fitHeadline(s);
    if (h && isMeaningful(h) && allowedText(h)) return { headline: h, source: 'caption' };
  }
  for (const s of subject) {
    const h = boundedHeadline(s);
    if (h && allowedText(h)) return { headline: h, source: 'shortened' };
  }
  for (const s of all.filter(isCtaSentence)) {
    const h = fitHeadline(s);
    if (h && isMeaningful(h) && allowedText(h)) return { headline: h, source: 'cta' };
  }
  return { headline: '', source: null };
}
const firstSentence = (text) => clean(sentences(text)[0] || '', 200).replace(/[.!?]+$/, '');

/** The caption's wording without the digits that are only structure: list numerals ("1." / "2)" / "3 -"), hashtags, links, e-mail addresses and phone numbers. */
export function withoutStructuralDigits(text) {
  return String(text || '')
    .replace(/(^|\n)[ \t]*(?:\d{1,2}[.)]|\d{1,2}[ \t]*[-–:])[ \t]+/g, '$1')
    .replace(/https?:\/\/\S+|www\.\S+|\S+@\S+\.\S+/gi, ' ')
    .replace(/#[\p{L}\p{N}_]+/gu, ' ')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, ' ');
}

/**
 * Whether a number is something a design may show BIG as a statistic: a percentage, an amount of money, a decimal or a thousands figure, or a whole
 * number of 10 or more that is not a year. A bare 1-9 is a count in a sentence ("3 tips", "step 2") or a list numeral - never a statistic.
 */
export function isStatFigure(value) {
  const v = String(value || '');
  if (/%|[$€£₹]/.test(v)) return true;
  if (/[.,]/.test(v)) return true;
  const n = Number(v);
  return Number.isInteger(n) && n >= 10 && !/^(19|20)\d{2}$/.test(v);
}

/** The statistics a text states (see isStatFigure). Used to know which figures the business actually supplied. */
export function extractFigures(text) {
  const found = withoutStructuralDigits(text).match(/(?:[$€£₹]\s?)?\d[\d,]*(?:\.\d+)?\s?%?/g) || [];
  return [...new Set(found.map((f) => f.replace(/\s+/g, '').replace(/[,.]+$/, '')).filter((f) => f && isStatFigure(f)))];
}

/** A line that explains a figure or a point in words: at least three words and some real letters (never just "1." or "42"). */
export const hasReadableContext = (s) => {
  const t = String(s || '').trim();
  return t.split(/\s+/).filter((w) => /\p{L}{2,}/u.test(w)).length >= 3;
};

/** A sentence of `text` that states `figure`, as the figure's context (so a big number is never shown without its meaning). */
function sentenceWith(text, figure) {
  const hay = withoutStructuralDigits(text).split(/(?<=[.!?])\s+|\n+/);
  const spaced = figure.replace(/(\d)(%)/, '$1 $2');
  const sentence = clean(hay.find((s) => s.includes(figure) || s.includes(spaced)) || '', 300).replace(/[.!?]+$/, '');
  if (sentence.length <= 110) return sentence;
  // too long for a card: the clause that states the figure, else the first words up to a word boundary
  const clause = sentence.split(/[,;]\s|\s[-–—]\s/).find((c) => c.includes(figure) || c.includes(spaced));
  return clause && hasReadableContext(clause) && clause.length <= 110 ? clause.trim() : clampText(sentence, { maxWords: 20, maxChars: 110 });
}

/** What one list card can carry: a whole sentence of a numbered list reads better than its first seven words ("... because your"). */
const POINT_MAX_WORDS = 16;
const POINT_MAX_CHARS = 100;

const WORD_NUMBERS = 'three|four|five|six|seven|eight|nine|ten|\\d+';
const LIST_RE = new RegExp(`\\b(${WORD_NUMBERS})\\b\\s+(?:\\w+\\s+){0,2}(mistakes|tips|ways|steps|signs|reasons|things|ideas|rules|habits|questions|myths|lessons|factors|pillars|strategies)\\b`, 'i');
const PROCESS_RE = /\b(steps?|process|how to|what'?s included|included in|what is included|checklist|framework|roadmap|audit|workflow)\b/i;
const CASE_RE = /\b(case study|client result|results? for (a|our) client|before (and|&) after|how we (helped|improved|grew|increased|reduced|doubled)|success story)\b/i;
const DATA_RE = /\b(stats?|statistics?|data|percent|percentage|growth|increase[ds]?|decrease[ds]?|metrics?|research|survey|report|benchmark|study)\b|%/i;
const COMPARE_RE = /\b(vs\.?|versus|myth|myths|compare|comparison|difference between|instead of|better than)\b/i;
const TEAM_RE = /\b(meet (the|our)|our team|team member|founder|behind the scenes|behind-the-scenes|welcome to the team|a day (at|in))\b/i;
const ANNOUNCE_RE = /\b(launch(ing|ed)?|introducing|now (open|available|live)|new (service|offer|product|feature|location|collection)|announc(e|ing|ement)|limited offer|discount|sale|free (consultation|check-?up|audit|trial|quote))\b/i;

// ── content extraction ───────────────────────────────────────────────────────

/**
 * The short points a list / process design may show: numbered or bulleted lines of the caption, or "Point N: ..." / "Slide N: ..."
 * entries of the plan's brief. Each is taken as written (only shortened), never composed here.
 */
export function fitPoint(value) {
  const text = clean(value, 300).replace(/[.!?]+$/, '').trim();
  const words = (t) => t.split(' ').filter(Boolean).length;
  const fits = (t) => t && words(t) <= POINT_MAX_WORDS && t.length <= POINT_MAX_CHARS;
  if (fits(text)) return text;
  const clause = text.split(/[,;]\s|\s[-–—]\s/)[0].trim();
  if (clause && words(clause) >= 3 && fits(clause)) return clause;
  return clampText(text, { maxWords: POINT_MAX_WORDS, maxChars: POINT_MAX_CHARS });
}

export function extractPoints({ caption, planItem }) {
  const found = [];
  const push = (raw) => {
    const head = String(raw).split(/\s[-–—:]\s|:\s/)[0];
    const point = fitPoint(head.length >= 3 ? head : raw);
    if (point.length >= 3 && !found.some((p) => p.toLowerCase() === point.toLowerCase())) found.push(point);
  };
  for (const lineText of String(caption || '').split(/\n+/)) {
    const m = lineText.match(/^\s*(?:\d{1,2}[.)]|\d{1,2}\s*[-–:]|[-•*▪✓✔→])\s+(.{3,160})$/);
    if (m) push(m[1]);
  }
  if (found.length < 3) {
    found.length = 0;
    const brief = String(planItem?.contentBrief || '');
    const re = /(?:point|slide|step)\s*\d+\s*[:.-]\s*([^;\n]+)/gi;
    let m = re.exec(brief);
    while (m) { push(m[1]); m = re.exec(brief); }
  }
  return found.length >= 3 ? found.slice(0, 6) : [];
}

/**
 * Key messages: the post's own short sentences (headline sentence excluded), used as cards when the post has no explicit list.
 * Each is the caption's sentence, shortened - never composed here.
 */
export function extractKeyMessages(caption, { skip = '' } = {}) {
  const body = String(caption || '').replace(/(?:\s*#[\p{L}\p{N}_]+)+\s*$/u, '');
  const out = [];
  for (const s of sentences(body)) {
    const text = clampText(s.replace(/[.!?]+$/, ''), { maxWords: 12, maxChars: 70 });
    if (text.split(' ').length < 3 || text.length < 14) continue;
    if (skip && text.toLowerCase() === String(skip).toLowerCase()) continue;
    if (out.some((o) => o.toLowerCase() === text.toLowerCase())) continue;
    out.push(text);
  }
  return out.length >= 3 ? out.slice(0, 5) : [];
}

/** A quoted sentence of the caption long enough to be a quote card. */
function extractQuote(caption) {
  const m = String(caption || '').match(/[“"]([^”"]{25,160})[”"]/);
  return m ? clampText(m[1], { maxWords: 22, maxChars: 150 }) : null;
}

const hex = (value) => {
  const v = String(value || '').trim();
  if (/^#?[0-9a-f]{6}$/i.test(v) || /^#?[0-9a-f]{3}$/i.test(v)) return `#${v.replace('#', '').toLowerCase()}`;
  return null;
};

/** The person's change request: one line, no angle brackets, bounded. */
export function cleanInstruction(value) {
  return clean(value, 400);
}

/** Text the person put in quotes in their request ("Make the headline say \"Start here\""): theirs to supply, set exactly as typed. */
export function quotedText(value) {
  const found = [];
  const text = String(value || '');
  // quote marks are paired in order (1st with 2nd, 3rd with 4th ...): the text BETWEEN two pairs is never mistaken for quoted text
  const marks = [...text.matchAll(/["“”]/g)].map((m) => m.index);
  for (let i = 0; i + 1 < marks.length && found.length < 3; i += 2) {
    const t = clean(text.slice(marks[i] + 1, marks[i + 1]), 80);
    if (t.length >= 2 && !found.includes(t)) found.push(t);
  }
  return found;
}

/**
 * What a plain-language change request asks for, as design parameters (the fallback when no AI interpretation is available, and
 * the guaranteed floor for the common asks): background tone, headline size, people in the photograph, and which element the
 * user's quoted text replaces. Anything else is passed to the photograph as a visual change note.
 */
export function parseChanges(instruction) {
  const text = String(instruction || '').toLowerCase();
  const patch = {};
  if (/\b(darker|dark|black|navy|deep)\b/.test(text) && !/\bnot (too )?dark\b/.test(text)) patch.tone = 'dark';
  else if (/\b(lighter|light|brighter|white|clean(er)? background|softer)\b/.test(text)) patch.tone = 'light';
  if (/\b(larger|bigger|increase|huge|bold(er)?)\b[^.]*\b(headline|title|heading|text)\b|\b(headline|title|heading)\b[^.]*\b(larger|bigger|bolder)\b/.test(text)) patch.headlineScale = 1.15;
  else if (/\b(smaller|reduce|less)\b[^.]*\b(headline|title|heading|text)\b|\b(headline|title|heading)\b[^.]*\bsmaller\b/.test(text)) patch.headlineScale = 0.88;
  if (/\b(remove|without|no|hide)\b[^.]*\b(person|people|man|woman|face|faces|human)\b/.test(text)) patch.allowPeople = false;
  const quoted = quotedText(instruction);
  if (quoted[0]) {
    if (/\b(button|cta|call to action)\b/.test(text)) patch.cta = quoted[0];
    else if (/\b(sub-?headline|sub-?title|tagline|supporting|subheading)\b/.test(text)) patch.subheadline = quoted[0];
    else if (/\b(headline|title|heading|say|says|text|reads?)\b/.test(text)) patch.headline = quoted[0];
  }
  return patch;
}

const seeded = (seed, n) => crypto.createHash('sha256').update(String(seed ?? '')).digest().readUInt32BE(0) % n;

/** A website as designers show it: no protocol, no trailing slash. */
export function displayWebsite(url) {
  const t = String(url || '').trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
  return /^[^\s/]+\.[^\s]{2,}$/.test(t) && t.length <= 60 ? t : '';
}

// ── classification ───────────────────────────────────────────────────────────

/** The services a post is about: the plan's service features ("what's included") when it has them, else the business's service names. */
export function pickServices({ services = [], planItem = null }) {
  const names = (list) => list.map((s) => clampText(s, { maxWords: 6, maxChars: 40 })).filter((s) => s.length >= 3);
  const named = planItem?.serviceName ? services.find((s) => s.name && s.name.toLowerCase() === String(planItem.serviceName).toLowerCase()) : null;
  const features = names(named?.features || []);
  if (named && features.length >= 2) return { items: features.slice(0, 5), label: "WHAT'S INCLUDED" };
  const all = [...new Set(names(services.map((s) => s.name).filter(Boolean)))];
  return { items: all.slice(0, 5), label: 'OUR SERVICES' };
}

/**
 * Chooses the creative type. Order: content-bound types first (a product, a case study, supplied data), then the format the
 * message needs (people story, comparison, list, process, announcement, quote), then the business purpose (service / lead
 * generation / awareness), then photography editorial. Returns { type, reason }.
 */
export function classifyCreative({ caption, planItem = null, pillar = '', objective = '', snapshotData = {}, hasProductAsset = false, hasProduct = false, services = [], recentTypes = [] }) {
  const text = [planItem?.topic, planItem?.angle, planItem?.contentBrief, planItem?.deliverable, pillar, firstSentence(caption), String(caption || '').slice(0, 500)].filter(Boolean).join(' . ');
  const points = extractPoints({ caption, planItem });
  const figures = extractFigures([caption, planItem?.topic, planItem?.angle, planItem?.hook, planItem?.contentBrief].filter(Boolean).join(' '));
  const contentType = planItem?.contentType || '';
  const goal = planItem?.objective || objective || '';
  const haveServices = pickServices({ services, planItem }).items.length >= 2;

  let type = 'premium_editorial';
  let reason = 'default';
  if (hasProduct && hasProductAsset) { type = 'product_showcase'; reason = 'product with a real photo'; }
  else if (CASE_RE.test(text)) { type = 'case_study'; reason = 'case-study wording'; }
  else if (figures.length && DATA_RE.test(text) && !LIST_RE.test(text) && points.length < 3) { type = 'data_insight'; reason = 'supplied figures in a data-led post'; }
  else if (extractQuote(caption)) { type = 'quote'; reason = 'quoted sentence'; }
  // a team story is a PEOPLE post: the plan says so, or the wording does - but keyword wording alone must not beat a numbered list of points
  // (a plan angle such as "a behind-the-scenes fulfillment partner" is a business phrase, not a team post)
  else if (contentType === 'behind_the_scenes' || (TEAM_RE.test(text) && points.length < 3)) { type = 'team_story'; reason = 'team / behind the scenes'; }
  else if (COMPARE_RE.test(text) && !LIST_RE.test(text) && points.length >= 3) { type = 'comparison'; reason = 'comparison wording'; }
  else if (points.length >= 3 && !PROCESS_RE.test(text)) { type = 'educational_list'; reason = 'numbered points'; }
  else if (points.length >= 3 && PROCESS_RE.test(text)) { type = 'process_checklist'; reason = 'process / checklist points'; }
  else if (goal === 'lead_generation' && haveServices) { type = 'lead_generation'; reason = 'lead-generation objective with real services'; }
  else if (planItem?.serviceName && haveServices) { type = 'service_promotion'; reason = 'a post about a named service'; }
  else if (ANNOUNCE_RE.test(text)) { type = 'announcement'; reason = 'announcement / offer'; }
  else if ((contentType === 'soft_sell' || contentType === 'hard_sell') && haveServices) { type = 'service_promotion'; reason = 'a post about the services'; }
  else if (contentType === 'hard_sell') { type = 'announcement'; reason = 'hard-sell post'; }
  else if (goal === 'awareness' && !planItem?.serviceName) { type = 'brand_awareness'; reason = 'awareness objective'; }
  void snapshotData; void recentTypes;
  return { type, reason };
}

// ── three directions for Creative Studio ──────────────────────────────────

const FAMILY_ORDER = ['photo', 'showcase', 'infographic'];

/**
 * The creative directions Creative Studio offers for ONE post: a photography-led editorial, a service / product showcase and an
 * infographic - three different families, hence three different layouts, each honestly supportable by the content (a list needs
 * its points, a data design its supplied figures, a service design the real services, a product design the real photo).
 * The family the content calls for comes first. Always `count` DISTINCT types when the families allow.
 * Returns [{ type, reason }].
 */
export function chooseCandidateTypes({ caption, planItem = null, pillar = '', objective = '', snapshotData = {}, hasProduct = false, hasProductAsset = false, services = [], count = 3 }) {
  const primary = classifyCreative({ caption, planItem, pillar, objective, snapshotData, hasProduct, hasProductAsset, services });
  const text = [planItem?.topic, planItem?.angle, planItem?.contentBrief, pillar, String(caption || '').slice(0, 500)].filter(Boolean).join(' . ');
  const points = extractPoints({ caption, planItem });
  const figures = extractFigures([caption, planItem?.topic, planItem?.angle, planItem?.hook, planItem?.contentBrief].filter(Boolean).join(' '));
  const serviceCount = pickServices({ services, planItem }).items.length;
  const keyMessages = extractKeyMessages(caption, { skip: firstSentence(caption) });
  const goal = planItem?.objective || objective || '';

  const ok = (type) => {
    switch (type) {
      case 'product_showcase': return hasProductAsset;
      case 'service_promotion': case 'service_expertise': return serviceCount >= 2;
      case 'lead_generation': return serviceCount >= 2 && goal === 'lead_generation';
      case 'educational_list': case 'process_checklist': return points.length >= 3;
      case 'comparison': return points.length >= 3 && COMPARE_RE.test(text);
      case 'modern_saas': return keyMessages.length >= 3;
      case 'data_insight': return figures.length > 0 && DATA_RE.test(text);
      case 'case_study': return figures.length > 0 && CASE_RE.test(text);
      case 'quote': return !!extractQuote(caption);
      case 'team_story': return TEAM_RE.test(text) || planItem?.contentType === 'behind_the_scenes';
      default: return true;
    }
  };
  const FAMILY_PREFERENCE = {
    photo: ['team_story', 'brand_awareness', 'premium_editorial'],
    showcase: ['product_showcase', 'lead_generation', 'service_promotion', 'service_expertise', 'announcement'],
    infographic: ['educational_list', 'process_checklist', 'data_insight', 'case_study', 'comparison', 'quote', 'modern_saas', 'statement'],
  };
  const best = (family) => {
    const primaryKind = CREATIVE_TYPES[primary.type];
    if (primaryKind.family === family && ok(primary.type)) return { type: primary.type, reason: primary.reason };
    const type = FAMILY_PREFERENCE[family].find((t) => ok(t) && (t !== 'team_story' || primary.type === 'team_story') && (t !== 'brand_awareness' || goal === 'awareness'));
    return { type: type || FAMILY_PREFERENCE[family].at(-1), reason: `a ${family} direction alongside ${primary.type}` };
  };
  const primaryFamily = CREATIVE_TYPES[primary.type].family;
  const order = [primaryFamily, ...FAMILY_ORDER.filter((f) => f !== primaryFamily)];
  return order.slice(0, Math.max(1, count)).map(best);
}

// ── the brief ────────────────────────────────────────────────────────────────

const WANTS_CONTACT = new Set(['service_promotion', 'lead_generation', 'service_expertise', 'announcement', 'brand_awareness']);
const WANTS_CTA = new Set(['service_promotion', 'lead_generation', 'service_expertise', 'announcement', 'product_showcase', 'brand_awareness']);

/** The layout a type uses for THIS content, with an honest downgrade when the content cannot fill it. */
function layoutFor(type, { points, keyMessages, services, figures, productAssetCount, hasQuote }, notes) {
  const kind = CREATIVE_TYPES[type];
  const need = (layoutId) => missingForLayout(layoutId, { points, services, figures }, { productImages: productAssetCount });
  let layoutId = kind.layoutId;
  let usePoints = points;
  if (layoutId === 'infographic_points' && type === 'modern_saas') usePoints = points.length >= 3 ? points : keyMessages;
  if (type === 'quote' && !hasQuote) layoutId = 'photo_hero';
  if (layoutId === 'infographic_points' && usePoints.length < 3) { notes.push('points_unavailable'); layoutId = type === 'comparison' ? 'statement_quote' : 'photo_hero'; }
  if (layoutId === 'insight_stats' && !figures.length) { notes.push('no_supplied_figures'); layoutId = type === 'case_study' ? 'statement_quote' : 'photo_hero'; }
  if (layoutId === 'service_list' && need('service_list')) layoutId = type === 'lead_generation' ? 'announcement_banner' : 'photo_hero';
  if (layoutId === 'product_hero' && need('product_hero')) { notes.push('product_photo_missing'); layoutId = 'photo_hero'; }
  return { layoutId, points: usePoints };
}

/**
 * @param {object} a
 * @param {string} a.caption  the approved post text
 * @param {'facebook'|'instagram'} a.platform
 * @param {string|null} [a.pillar] @param {string|null} [a.objective]
 * @param {object|null} [a.planItem]  the calendar item the post came from (topic, hook, onCreativeText, primaryCta, ...)
 * @param {object} a.snapshotData @param {object|null} [a.strategy]
 * @param {boolean} [a.hasLogo]  a real, decodable logo will be placed by the composer
 * @param {{ name: string, benefits?: string[], features?: string[] }|null} [a.product]  the planned product (real catalog data)
 * @param {number} [a.productAssetCount]  real product photos available
 * @param {{ name: string, features?: string[] }[]} [a.services]  the business's real, active services
 * @param {{ phone?: string, website?: string, email?: string }} [a.contact]  the business's real contact details
 * @param {string[]} [a.prohibitedPhrases]  phrases that must never appear on the design
 * @param {string} [a.seed]  e.g. the publication id (+ slot): varies the tone deterministically
 * @param {string} [a.variant]  changes ONLY the photograph's scene (a new revision asks for a different picture)
 * @param {string|null} [a.sceneSeed] @param {number} [a.sceneOffset]  the scene's stable base and its per-design shift (the designs of one post never share a photograph)
 * @param {string|null} [a.forceType]  Creative Studio asks for a specific direction
 * @param {string} [a.instruction]  what the person asked to change (refinement)
 * @param {object} [a.patch]  design parameters from an AI interpretation of the instruction (validated here)
 * @param {string|null} [a.visualChange]  what a NEW photograph should show (from the same interpretation)
 */
export function buildDesignBrief({
  caption, platform, pillar = null, objective = null, planItem = null, snapshotData = {}, strategy = null, hasLogo = false, product = null,
  productAssetCount = 0, services = [], contact = {}, prohibitedPhrases = [], recentTypes = [], seed = '', variant = '', sceneSeed = null, sceneOffset = 0, forceType = null, instruction = '', patch = {}, visualChange = null,
}) {
  const d = snapshotData || {};
  const brand = d.brand || {};
  const notes = [];
  const banned = prohibitedPhrases.map((p) => String(p).trim().toLowerCase()).filter(Boolean);
  const allowedText = (s) => !!s && !banned.some((b) => s.toLowerCase().includes(b));

  const hasProduct = !!product || !!planItem?.productId;
  const hasProductAsset = productAssetCount > 0;
  if (hasProduct && !hasProductAsset) notes.push('product_photo_missing');

  const changes = { ...parseChanges(instruction), ...(patch || {}) };
  const forced = forceType && CREATIVE_TYPES[forceType] ? forceType : null;
  const { type: classified, reason: classifiedReason } = classifyCreative({ caption, planItem, pillar: pillar || '', objective: objective || '', snapshotData: d, hasProduct, hasProductAsset, services, recentTypes: forced ? [] : recentTypes });
  const reason = forced ? `requested direction: ${forced}` : classifiedReason;
  let creativeType = forced || classified;

  // ── the words (all from the caption / plan / profile / catalog) ──
  const quote = creativeType === 'quote' ? extractQuote(caption) : null;
  let headline = quote || '';
  // The plan's own words, else a complete sentence of the caption that is not a call to action, else a bounded excerpt of a long unpunctuated one
  // (chooseHeadline). The call to action is taken separately below.
  if (!headline) {
    const chosen = chooseHeadline({ planItem, caption, allowedText });
    headline = chosen.headline;
    // nothing usable only BECAUSE of the business's prohibited phrases is a different problem from a caption with nothing to say
    if (!headline && banned.length && chooseHeadline({ planItem, caption }).headline) notes.push('headline_blocked_by_prohibited_phrase');
    if (chosen.source === 'shortened') notes.push('headline_shortened');
    if (chosen.source === 'cta') notes.push('headline_is_cta');
  }
  const prose = proseSentences(caption).join('\n');
  if (changes.headline && allowedText(changes.headline)) headline = clampText(changes.headline, { maxWords: 14, maxChars: 95 }) || headline;
  if (!headline) { creativeType = 'premium_editorial'; notes.push('no_safe_headline'); }

  const explicitPoints = extractPoints({ caption, planItem }).filter(allowedText);
  const keyMessages = extractKeyMessages(caption, { skip: headline }).filter(allowedText);
  const suppliedFigures = extractFigures([caption, planItem?.topic, planItem?.angle, planItem?.hook, planItem?.contentBrief].filter(Boolean).join(' '));
  const figureSource = [caption, planItem?.topic, planItem?.angle, planItem?.hook, planItem?.contentBrief].filter(Boolean).join(' . ');
  const figures = ['data_insight', 'case_study'].includes(creativeType)
    ? suppliedFigures.map((value) => ({ value, context: sentenceWith(figureSource, value) })).filter((f) => hasReadableContext(f.context) && allowedText(f.context)).slice(0, 3)
    : [];
  const serviceInfo = pickServices({ services, planItem });
  const serviceItems = serviceInfo.items.filter(allowedText);

  const { layoutId, points: layoutPoints } = layoutFor(creativeType, { points: explicitPoints, keyMessages, services: serviceItems, figures, productAssetCount, hasQuote: !!quote }, notes);
  const kind = CREATIVE_TYPES[creativeType];
  const effectiveType = layoutId === kind.layoutId ? creativeType : (layoutId === 'photo_hero' ? 'premium_editorial' : creativeType);
  const effKind = CREATIVE_TYPES[effectiveType];
  const usesPoints = layoutId === 'infographic_points';
  const points = usesPoints ? layoutPoints.slice(0, 5) : [];

  const goal = planItem?.objective || objective || '';
  const ctaOk = WANTS_CTA.has(effectiveType) || ['lead_generation', 'conversion', 'traffic'].includes(goal);
  const captionCta = ctaFromCaption(caption); // the post's own call to action, when it is a short sentence the button can carry

  // supporting line: the plan's hook, else the post's next sentence - never the headline again, never when points carry the message
  let subheadline = '';
  {
    // a supporting line is a WHOLE sentence that fits (never "... marketing felt"), and never one that repeats the headline (the headline is often the first clause of it)
    const whole = (s) => { const t = fitPoint(s); return t && t === clean(s, 300).replace(/[.!?]+$/, "").trim() ? t : ""; };
    const repeatsHeadline = (s) => { const a = s.toLowerCase(); const h = String(headline).toLowerCase(); const c = String(captionCta).toLowerCase(); return (!!h && (a === h || a.includes(h) || h.includes(a))) || (ctaOk && !!c && a === c); };
    const hook = whole(planItem?.hook);
    const next = sentences(prose).map(whole).find((s) => s && !repeatsHeadline(s) && !points.some((p) => p.toLowerCase() === s.toLowerCase()) && s.split(" ").length >= 4);
    subheadline = [hook, next].find((s) => s && !repeatsHeadline(s) && allowedText(s)) || '';
    if (['educational_list', 'process_checklist', 'comparison', 'data_insight', 'quote'].includes(effectiveType) && usesPoints) subheadline = '';
    if (effectiveType === 'quote') subheadline = '';
  }
  if (changes.subheadline && allowedText(changes.subheadline)) subheadline = clampText(changes.subheadline, { maxWords: 20, maxChars: 120 });

  // call to action: the plan's own CTA, else the post's own short call to action - only where a button belongs, and never the headline again
  let cta = ctaOk ? (clampText(planItem?.primaryCta, { maxWords: 5, maxChars: 40 }) || clampText(captionCta, { maxWords: 6, maxChars: 40 })) : '';
  if (cta && headline && cta.toLowerCase() === headline.toLowerCase()) cta = '';
  if (changes.cta && allowedText(changes.cta)) cta = clampText(changes.cta, { maxWords: 5, maxChars: 40 });

  // contact details: the profile's real values, only where the design's purpose needs them
  const wantsContact = WANTS_CONTACT.has(effectiveType) || ['lead_generation', 'conversion'].includes(goal);
  const phone = clean(contact?.phone, 40);
  const website = displayWebsite(contact?.website);
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(contact?.email || '').trim()) ? String(contact.email).trim().slice(0, 80) : '';
  const shownContact = wantsContact ? { phone: phone || null, website: website || null, email: email || null } : { phone: null, website: null, email: null };
  if (wantsContact && !phone && !website && !email) notes.push('contact_unavailable');

  const kicker = layoutId === 'product_hero' && /\b(introducing|new|launch)/i.test(`${planItem?.topic || ''} ${headline} ${caption || ''}`.slice(0, 400)) ? 'INTRODUCING' : '';
  const productInfo = layoutId === 'product_hero' && product
    ? { name: clean(product.name, 80), benefits: [...(product.benefits || []), ...(product.features || [])].map((b) => clampText(b, { maxWords: 7, maxChars: 44 })).filter((b) => b.length >= 3 && allowedText(b)).slice(0, 3) }
    : null;

  // photography: the AI photograph, only for layouts that carry one
  const needsPhoto = !!LAYOUT_NEEDS[layoutId]?.photo;
  const topic = clean(planItem?.topic || headline, 160);
  const concept = needsPhoto
    ? chooseVisualConcept({ category: d.business?.category || '', services: serviceItems, topic, pillar: pillar || '', creativeType: effectiveType, seed: `${sceneSeed ?? seed}:${variant}`, offset: sceneOffset, allowPeople: changes.allowPeople !== false })
    : null;

  const colors = { primary: hex(brand.primaryColor), secondary: hex(brand.secondaryColor), accent: hex(brand.accentColor) };
  const anyColor = Object.values(colors).some(Boolean);
  const platformInfo = PLATFORM_BEHAVIOUR[platform] || PLATFORM_BEHAVIOUR.facebook;
  const tone = ['light', 'dark'].includes(changes.tone) ? changes.tone : null; // null = the layout's own natural tone
  const scale = Number.isFinite(changes.headlineScale) ? Math.min(1.3, Math.max(0.75, changes.headlineScale)) : 1;

  return {
    version: DESIGN_BRIEF_VERSION,
    creativeType: effectiveType,
    label: effKind.label,
    family: effKind.family,
    layoutId,
    classification: reason,
    tone,
    headlineScale: scale,
    headline,
    subheadline,
    points,
    pointStyle: effectiveType === 'process_checklist' ? 'process' : 'numbered',
    services: layoutId === 'service_list' ? serviceItems : [],
    servicesLabel: layoutId === 'service_list' ? serviceInfo.label : null,
    figures: layoutId === 'insight_stats' ? figures : [],
    product: productInfo,
    kicker,
    cta: cta && allowedText(cta) ? cta : '',
    contact: shownContact,
    platform,
    format: planItem?.format || 'static_post',
    orientation: platformInfo.orientation,
    brandColors: colors,
    typography: { heading: clean(brand.fontHeading, 40) || null, body: clean(brand.fontBody, 40) || null },
    logo: { present: !!hasLogo },
    requiredAssets: [...(planItem?.requiredAssets || [])],
    productAssets: { count: layoutId === 'product_hero' ? productAssetCount : 0, productName: product?.name ? clean(product.name, 80) : null },
    photography: { required: needsPhoto, scene: concept?.scene || null, industry: concept?.industry || null, people: concept?.people ?? null },
    topic,
    visualGuidelines: (strategy?.brandRules?.visualGuidelines || []).map((v) => clean(v, 200)).filter(Boolean).slice(0, 6),
    colorsAvailable: anyColor,
    creativeDirection: clean(planItem?.creativeDirection, 260) || null,
    notes,
    userChanges: cleanInstruction(instruction),
    // what the NEW photograph should show, when the person asked for a different picture (the director's reading of the request)
    visualChange: visualChange ? cleanInstruction(visualChange) : null,
    userSuppliedText: quotedText(instruction),
  };
}

/** Deterministic sanity checks on a brief (the "quality check" that needs no image model). Returns a list of problems; empty = fine. */
export function checkBrief(brief, { prohibitedPhrases = [], caption = '', planItem = null } = {}) {
  const problems = [];
  if (!CREATIVE_TYPES[brief.creativeType]) problems.push('unknown creative type');
  if (!LAYOUT_NEEDS[brief.layoutId]) problems.push('unknown layout');
  if (!brief.headline && !brief.product?.name) problems.push((brief.notes || []).includes('headline_blocked_by_prohibited_phrase') ? 'no headline: every candidate uses a prohibited phrase' : 'no headline');
  else if (brief.headline.split(' ').length > HEADLINE_MAX_WORDS + 1 || brief.headline.length > HEADLINE_MAX_CHARS + 5) problems.push('headline too long to read as a thumbnail');
  const banned = prohibitedPhrases.map((p) => String(p).trim().toLowerCase()).filter(Boolean);
  const strings = [brief.headline, brief.subheadline, ...brief.points, ...(brief.services || []), brief.cta, ...(brief.figures || []).map((f) => f.context), ...(brief.product?.benefits || [])].filter(Boolean);
  for (const s of strings) if (banned.some((b) => s.toLowerCase().includes(b))) problems.push('a prohibited phrase would appear in the design');
  const supplied = new Set(extractFigures([caption, planItem?.topic, planItem?.angle, planItem?.hook, planItem?.contentBrief].filter(Boolean).join(' ')));
  for (const f of brief.figures || []) {
    if (!supplied.has(f.value)) problems.push(`the figure ${f.value} was not supplied`);
    if (!isStatFigure(f.value)) problems.push(`${f.value} is a count or a list number, not a statistic`);
    if (!hasReadableContext(f.context)) problems.push(`the figure ${f.value} has no readable context`);
  }
  for (const p of [...(brief.points || []), ...(brief.services || [])]) if (!hasReadableContext(p) && !/\p{L}{3,}/u.test(p)) problems.push('a list item has no readable text');
  const missing = LAYOUT_NEEDS[brief.layoutId] ? missingForLayout(brief.layoutId, brief, { productImages: brief.productAssets?.count || 0 }) : null;
  if (missing) problems.push(`the ${brief.layoutId} layout needs ${missing}`);
  if (brief.points.length > 6) problems.push('too many points to read');
  return problems;
}

export default { DESIGN_BRIEF_VERSION, CREATIVE_TYPES, PROHIBITED_ELEMENTS, classifyCreative, chooseCandidateTypes, buildDesignBrief, checkBrief, extractPoints, extractFigures, extractKeyMessages, clampText, fitHeadline, cleanInstruction, quotedText, parseChanges, pickServices, displayWebsite };
