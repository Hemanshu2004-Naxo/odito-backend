import { findMentions } from './brandMatchingService.js';

/**
 * Is the brand RECOMMENDED in an answer, as opposed to merely mentioned? A deterministic heuristic, deliberately conservative: a
 * false "recommended" overstates visibility, so ambiguous cases resolve to false. It is labelled `heuristic_v1` wherever it is stored
 * so a better detector can replace it without rewriting history.
 *
 * A sentence/line counts when it names the brand AND either
 *   - it is presented as a list item / heading / bold option (a typical "top providers" list), or
 *   - the same sentence carries a recommendation cue ("recommended", "top choice", "worth considering", "leading", "best"...)
 * and it is NOT negated ("not recommended", "avoid", "unable to find information about ...").
 *
 * Three different things, never merged: brand MENTION (named anywhere), RECOMMENDATION (this detector), WEBSITE CITATION (a cited URL
 * on the target domain).
 */

export const RECOMMENDATION_METHOD = 'heuristic_v1';

const CUE = /\b(recommend(?:ed|s|ation)?|top[- ](?:rated|choice|pick|option)|leading|best|highly[- ]rated|well[- ]known|reputable|trusted|popular|worth considering|consider|ideal|good (?:option|choice)|great (?:option|choice)|stand[s]? out|suitable|go[- ]to|renowned|preferred)\b/i;
const NEGATION = /\b(not recommended|do(?:es)? not recommend|don't recommend|would not recommend|avoid|no (?:reliable )?information|cannot (?:find|verify|confirm)|can't (?:find|verify|confirm)|unable to (?:find|verify|confirm)|not (?:able|sure) to|i (?:do not|don't) have)\b/i;
const LIST_LINE = /^\s*(?:[-*•–]|\d{1,2}[.)]|#{1,4})\s+/;
const BOLD_LINE = /^\s*(?:\d{1,2}[.)]\s*)?\*\*/;

const splitUnits = (text) => String(text || '')
  .split(/\n+/)
  .flatMap((line) => (LIST_LINE.test(line) || BOLD_LINE.test(line) ? [line] : line.split(/(?<=[.?!])\s+/)))
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * @param {string} answerText
 * @param {string[]} brandNames verified brand names / aliases
 * @returns {{recommended:boolean, method:string, evidence:string|null}}
 */
export function detectRecommendation(answerText, brandNames) {
  for (const unit of splitUnits(answerText)) {
    if (findMentions(unit, brandNames || []).length === 0) continue;
    if (NEGATION.test(unit)) continue;
    const asOption = LIST_LINE.test(unit) || BOLD_LINE.test(unit);
    if (asOption || CUE.test(unit)) return { recommended: true, method: RECOMMENDATION_METHOD, evidence: unit.slice(0, 240) };
  }
  return { recommended: false, method: RECOMMENDATION_METHOD, evidence: null };
}

export default { detectRecommendation, RECOMMENDATION_METHOD };
