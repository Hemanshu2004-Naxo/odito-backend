import { countMentions, findMentions, normalizeForMatching } from './brandMatchingService.js';
import { classifyCitations } from './citationNormalizationService.js';

/**
 * Deterministic analysis of ONE saved provider answer. Pure, provider-independent, no network: the same stored answer always gives the
 * same result, so it can be re-run (scripts/reanalyzeEvidence.js) whenever the rules improve, without a new paid request.
 *
 * The tracked business (names, aliases, competitors, host) is used ONLY here, after the answer was collected - it is never sent to the
 * answering provider.
 *
 * MENTION   the business is explicitly named in the answer PROSE. URLs, markdown link targets and link labels that are only a host
 *           ("[asgeye.com](https://...)") are masked first, so a name that appears only inside citation metadata never counts. The
 *           question is never analysed. Status:
 *             mentioned       a reliable name / alias occurs in the prose
 *             ambiguous       only an unreliable (generic) name matched, or every occurrence is part of a longer KNOWN competitor name
 *                             ("Apollo" inside "Apollo Spectra") - reported, never counted as a mention
 *             not_mentioned   no occurrence
 *           Several occurrences in one answer are still ONE answer mentioning the business. `excerpt` is an exact substring of the answer.
 *
 * RECOMMENDATION (only evaluated for a confirmed mention in a discovery answer). Each sentence / list item naming the business is read:
 *             negative      "not recommended", "avoid", "poor reviews", "complaints" ...
 *             recommended   an explicit recommendation cue in the same sentence ("I recommend", "worth considering", "a good option",
 *                           "you could consider"), or a list item under an intro line that explicitly recommends the list
 *                           ("Here are the top options:", "I'd recommend these:")
 *             positive      described favourably without a recommendation ("well-known", "reputable", "highly rated")
 *             neutral       named without any stance - INCLUDING appearing in a plain list (a list alone is not a recommendation)
 *             ambiguous     contradictory signals (a negative and a positive/recommending one)
 *           Every non-neutral status carries the exact excerpt(s) that support it, validated to exist in the answer.
 *
 * CITATIONS come only from the provider's structured annotations (never from URLs written in the text); see classifyCitations().
 */

export const ANALYSIS_VERSION = 'answer_analysis_v2';
export const RECOMMENDATION_METHOD = 'rules_v2';

export const MENTION_STATUS = Object.freeze({ MENTIONED: 'mentioned', AMBIGUOUS: 'ambiguous', NOT_MENTIONED: 'not_mentioned' });
export const RECOMMENDATION_STATUS = Object.freeze({
  RECOMMENDED: 'recommended', POSITIVE: 'positive', NEUTRAL: 'neutral', NEGATIVE: 'negative', AMBIGUOUS: 'ambiguous',
  NOT_MENTIONED: 'not_mentioned', NOT_EVALUATED: 'not_evaluated',
});
export const CITATION_METADATA = Object.freeze({ AVAILABLE: 'available', UNAVAILABLE: 'unavailable', NOT_REQUESTED: 'not_requested' });

const MAX_EXCERPT = 400;

// ── masking: same length as the input, so offsets in the masked text are offsets in the original ──
const blank = (s) => s.replace(/[^\n]/g, ' ');
const HOST_LIKE = /^\s*(?:https?:\/\/)?(?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?\s*$/i;

/** Remove citation markup from answer text (URLs, link targets, host-only link labels) without changing its length. */
export function maskCitationMarkup(text) {
  if (typeof text !== 'string') return '';
  return text
    // [label](url): the target always goes; the label too when it is only a host / URL (a citation chip, not prose)
    .replace(/\[([^\]\n]{0,300})\]\((?:[^()\s]|\([^()\s]*\))+\)/g, (m, label) => {
      const target = m.slice(label.length + 2);
      return HOST_LIKE.test(label) ? blank(m) : `[${label}]${blank(target)}`;
    })
    .replace(/\bhttps?:\/\/[^\s<>)\]]+/gi, blank)
    .replace(/\bwww\.[^\s<>)\]]+/gi, blank);
}

const LIST_LINE = /^\s*(?:[-*•–]|\d{1,2}[.)])\s+/;
const BOLD_LINE = /^\s*(?:\d{1,2}[.)]\s*)?\*\*/;
const HEADING_LINE = /^\s*#{1,6}\s+/;

/** Sentences and list items with their offsets. List items / headings are whole units; prose lines are split into sentences. */
export function splitUnits(text) {
  const units = [];
  for (const lm of String(text || '').matchAll(/[^\n]+/g)) {
    const line = lm[0];
    const base = lm.index;
    const isItem = LIST_LINE.test(line) || BOLD_LINE.test(line) || HEADING_LINE.test(line);
    const push = (s, e) => {
      while (s < e && /\s/.test(line[s])) s += 1;
      while (e > s && /\s/.test(line[e - 1])) e -= 1;
      if (e > s) units.push({ start: base + s, end: base + e, item: isItem });
    };
    if (isItem) { push(0, line.length); continue; }
    let s = 0;
    for (const m of line.matchAll(/[.?!]+\s+/g)) {
      push(s, m.index + m[0].trimEnd().length);
      s = m.index + m[0].length;
    }
    push(s, line.length);
  }
  return units;
}

const excerptOf = (text, u) => text.slice(u.start, Math.min(u.end, u.start + MAX_EXCERPT));

/** Every excerpt must be an exact substring of the answer. */
export function excerptsSupported(answerText, excerpts) {
  if (typeof answerText !== 'string') return false;
  return (excerpts || []).every((x) => typeof x === 'string' && x.length > 0 && answerText.includes(x));
}

/**
 * Brand mention analysis of one answer.
 * @param {string} answerText
 * @param {{brandNames:string[], brandMatchReliable?:boolean, competitors?:string[]}} target
 *        brandNames[0] is the business name (its reliability is brandMatchReliable); the rest are aliases that passed the reliability check.
 */
export function analyzeMention(answerText, target) {
  const text = typeof answerText === 'string' ? answerText : '';
  const masked = maskCitationMarkup(text);
  const names = (target.brandNames || []).filter(Boolean);
  const unreliable = new Set(target.brandMatchReliable === false && names[0] ? [normalizeForMatching(names[0])] : []);
  const competitors = (target.competitors || []).filter(Boolean);
  // A known competitor whose name CONTAINS one of the brand names ("Apollo Spectra" for "Apollo").
  const supersOf = (name) => competitors.filter((c) => normalizeForMatching(c) !== normalizeForMatching(name) && countMentions(c, name) > 0);
  // A longer brand name containing this one ("ASG Eye Hospital" for the alias "ASG Eye"): the same words are one occurrence, not two.
  const longerBrandOf = (name) => names.filter((n) => normalizeForMatching(n) !== normalizeForMatching(name) && countMentions(n, name) > 0);

  let confirmed = 0;
  let ambiguousHits = 0;
  let excerpt = null;
  let matchedName = null;
  let ambiguousReason = null;
  const units = [];
  for (const u of splitUnits(masked)) {
    const unitText = masked.slice(u.start, u.end);
    let unitConfirmed = 0;
    for (const name of names) {
      const hits = countMentions(unitText, name) - longerBrandOf(name).reduce((n, l) => n + countMentions(unitText, l), 0);
      if (hits <= 0) continue;
      const inCompetitor = supersOf(name).reduce((n, c) => n + countMentions(unitText, c), 0);
      const own = Math.max(0, hits - inCompetitor);
      if (unreliable.has(normalizeForMatching(name))) { ambiguousHits += hits; ambiguousReason ||= 'GENERIC_BUSINESS_NAME'; continue; }
      if (own === 0) { ambiguousHits += hits; ambiguousReason ||= 'PART_OF_COMPETITOR_NAME'; continue; }
      unitConfirmed += own;
      if (!matchedName) matchedName = name;
    }
    if (unitConfirmed > 0) {
      confirmed += unitConfirmed;
      units.push(u);
      if (!excerpt) excerpt = excerptOf(text, u);
    }
  }
  if (confirmed > 0) return { status: MENTION_STATUS.MENTIONED, occurrences: confirmed, excerpt, matchedName, ambiguousReason: null, units, masked };
  if (ambiguousHits > 0) return { status: MENTION_STATUS.AMBIGUOUS, occurrences: 0, excerpt: null, matchedName: null, ambiguousReason, units: [], masked };
  return { status: MENTION_STATUS.NOT_MENTIONED, occurrences: 0, excerpt: null, matchedName: null, ambiguousReason: null, units: [], masked };
}

// ── recommendation rules ──
const NEGATIVE = /\b(not recommended|(?:do|does|would|wouldn'?t|don'?t|doesn'?t)\s+(?:not\s+)?recommend|avoid|poor (?:reviews?|ratings?|service|care|hygiene)|negative (?:reviews?|feedback)|bad (?:reviews?|experiences?)|complaints?|overpriced|permanently closed|has closed|is closed|not (?:a )?(?:good|great|reliable) (?:option|choice)|mixed reviews)\b/i;
// "I cannot find / verify information about X" names X but takes no stance: neutral, never negative.
const NO_INFO = /\b(no (?:reliable |specific )?information|(?:cannot|can'?t|could not|couldn'?t|unable to) (?:find|verify|confirm)|i (?:do not|don'?t) have (?:any |specific )?(?:information|details|data))\b/i;
// Bare "consider" is deliberately absent: "consider the surgeon's experience" is advice, not a recommendation of a business.
const RECOMMEND = /\b(recommend(?:ed|s|ing)?|top (?:choice|pick|option|recommendation)s?|worth (?:considering|a visit|checking out)|(?:you|patients|customers|people|clients) (?:could|can|may|might|should) (?:consider|try|visit|contact|choose)|(?:a |an )?(?:good|great|excellent|strong|solid|ideal|top) (?:option|choice|fit|pick)s?|best (?:option|choice|bet)s?|go-to|one option|options? (?:to|you can|you could) consider|(?:is|are) (?:also )?(?:a |an )?(?:viable |reliable )?options?)\b/i;
// Imperative advice that names the business: "Consider ASG Eye Hospital if ...", "Try X for ...". Only at the start of the sentence.
const IMPERATIVE = /^[\s*_>#\-\d.)•]*(?:consider|try|visit|check out|contact|choose|go to)\b/i;
// A list INTRO that ranks what follows as the best / top / recommended ones ("Top eye hospitals in Mumbai:"). Used for intros only:
// "ASG is among the top hospitals" in prose is a favourable description, not a recommendation.
const RANKED_INTRO = /\b(top|best|recommended|recommendations?)\b/i;
const POSITIVE = /\b(well[- ]known|well[- ]regarded|well[- ]established|reputable|renowned|trusted|popular|leading|highly[- ](?:rated|regarded)|top[- ]rated|respected|praised|positive reviews?|known for|experienced|established|state[- ]of[- ]the[- ]art|advanced|stands? out)\b/i;
const NEGATIVE_ALL = new RegExp(NEGATIVE.source, 'gi');

/** recommended | positive | neutral | negative | ambiguous, for ONE sentence / list item. */
export function stanceOf(unitText) {
  if (NEGATIVE.test(unitText)) {
    // "not recommended" itself contains "recommended": look for an OPPOSING signal only in what is left.
    const rest = unitText.replace(NEGATIVE_ALL, ' ');
    return RECOMMEND.test(rest) || POSITIVE.test(rest) ? 'ambiguous' : 'negative';
  }
  if (NO_INFO.test(unitText)) return 'neutral';
  if (RECOMMEND.test(unitText) || IMPERATIVE.test(unitText)) return 'recommended';
  if (POSITIVE.test(unitText)) return 'positive';
  return 'neutral';
}

/** The closest preceding prose line (not a list item) before a list item: the list's intro, e.g. "Here are the top options:". */
function introFor(allUnits, unit) {
  const idx = allUnits.findIndex((u) => u.start === unit.start);
  for (let i = idx - 1; i >= 0; i -= 1) if (!allUnits[i].item) return allUnits[i];
  return null;
}

/**
 * @param {string} answerText
 * @param {{status:string, units:object[], masked:string}} mention  analyzeMention() result
 * @returns {{status:string, recommended:boolean|null, excerpts:string[], method:string}}
 */
export function classifyRecommendation(answerText, mention) {
  const text = typeof answerText === 'string' ? answerText : '';
  const out = (status, excerpts = []) => ({
    status, recommended: status === RECOMMENDATION_STATUS.NOT_EVALUATED ? null : status === RECOMMENDATION_STATUS.RECOMMENDED, excerpts, method: RECOMMENDATION_METHOD,
  });
  if (mention.status === MENTION_STATUS.NOT_MENTIONED) return out(RECOMMENDATION_STATUS.NOT_MENTIONED);
  if (mention.status !== MENTION_STATUS.MENTIONED) return out(RECOMMENDATION_STATUS.NOT_EVALUATED);

  const all = splitUnits(mention.masked);
  const found = { recommended: [], positive: [], negative: [], ambiguous: [] };
  for (const u of mention.units) {
    let stance = stanceOf(mention.masked.slice(u.start, u.end));
    const ex = [excerptOf(text, u)];
    if (u.item && (stance === 'neutral' || stance === 'positive')) {
      const intro = introFor(all, u);
      if (intro) {
        const introText = mention.masked.slice(intro.start, intro.end);
        let introStance = stanceOf(introText);
        if (introStance !== 'negative' && introStance !== 'ambiguous' && RANKED_INTRO.test(introText)) introStance = 'recommended';
        if (introStance === 'recommended') { stance = 'recommended'; ex.unshift(excerptOf(text, intro)); }
        else if (introStance === 'positive' && stance === 'neutral') { stance = 'positive'; ex.unshift(excerptOf(text, intro)); }
      }
    }
    if (found[stance]) found[stance].push(...ex);
  }
  const has = (k) => found[k].length > 0;
  let status;
  let excerpts;
  if (has('ambiguous') || (has('negative') && (has('recommended') || has('positive')))) {
    status = RECOMMENDATION_STATUS.AMBIGUOUS; excerpts = [...found.ambiguous, ...found.negative, ...found.recommended, ...found.positive];
  } else if (has('negative')) { status = RECOMMENDATION_STATUS.NEGATIVE; excerpts = found.negative; }
  else if (has('recommended')) { status = RECOMMENDATION_STATUS.RECOMMENDED; excerpts = found.recommended; }
  else if (has('positive')) { status = RECOMMENDATION_STATUS.POSITIVE; excerpts = found.positive; }
  else { status = RECOMMENDATION_STATUS.NEUTRAL; excerpts = mention.excerpt ? [mention.excerpt] : []; }
  excerpts = [...new Set(excerpts)].slice(0, 5);
  // A classification without verifiable support is never stored as a finding.
  if (status !== RECOMMENDATION_STATUS.NEUTRAL && !excerptsSupported(text, excerpts)) return out(RECOMMENDATION_STATUS.AMBIGUOUS);
  return out(status, excerpts);
}

/**
 * Full analysis of one saved answer -> the derived fields stored on the evidence document. Never mutates or rewrites the answer.
 * @param {{answerText:string, annotations:object[], citationMetadata?:string, group:string}} answer
 * @param {{brandNames:string[], brandMatchReliable?:boolean, competitors?:string[], targetHost?:string|null}} target
 */
export function analyzeEvidenceAnswer({ answerText, annotations, citationMetadata = null, group }, target) {
  if (typeof answerText !== 'string' || !answerText.trim()) throw new Error('ANSWER_TEXT_MISSING');
  const mention = analyzeMention(answerText, target);
  const recommendation = group === 'visibility'
    ? classifyRecommendation(answerText, mention)
    : { status: RECOMMENDATION_STATUS.NOT_EVALUATED, recommended: null, excerpts: [], method: RECOMMENDATION_METHOD };
  const cls = classifyCitations({ answerText, annotations, targetHost: target.targetHost, brandNames: target.brandNames || [] });
  return {
    analysisStatus: 'analysed',
    analysisVersion: ANALYSIS_VERSION,
    // Passed through unchanged: null for evidence collected before the provider parser recorded it (unknown, never guessed).
    citationMetadata: citationMetadata || null,
    citations: cls.citations,
    firstPartyPages: cls.officialPages,
    externalDomains: cls.thirdPartyHosts,
    analysis: {
      mentionStatus: mention.status,
      // true only for a confirmed mention; null when ambiguous (never silently "not mentioned")
      brandMentioned: mention.status === MENTION_STATUS.MENTIONED ? true : (mention.status === MENTION_STATUS.AMBIGUOUS ? null : false),
      brandMentionCount: mention.occurrences,
      mentionExcerpt: mention.excerpt,
      mentionAmbiguousReason: mention.ambiguousReason,
      recommendationStatus: recommendation.status,
      recommended: recommendation.recommended,
      recommendationExcerpts: recommendation.excerpts,
      recommendationMethod: group === 'visibility' ? recommendation.method : null,
      competitorMentions: findMentions(mention.masked, target.competitors || []),
      officialCited: cls.officialCited,
      thirdPartyCited: cls.thirdPartyCited,
      officialDomainInText: cls.officialDomainInText,
      brandListPosition: cls.brandListPosition,
      officialDomain: target.targetHost || null,
    },
  };
}

export default { analyzeEvidenceAnswer, analyzeMention, classifyRecommendation, maskCitationMarkup, splitUnits, excerptsSupported, ANALYSIS_VERSION };
