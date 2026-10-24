/**
 * Brand / competitor mention detection. Provider-independent, pure.
 *
 * Matching is case-insensitive, Unicode-aware and BOUNDARY-aware: both sides are reduced to the same canonical
 * form (NFKD, diacritics removed, lower-case, apostrophes dropped, "&" -> "and", every other non-letter/number
 * -> a single space) and the needle must line up with whole tokens. "Apollo" is found in "Apollo Hospitals" and
 * in "apollo-hospitals", but not in "Apollonia" or "Pineapollo".
 *
 * Scripts written without spaces (Han, Hiragana, Katakana, Hangul, Thai, ...) have no token boundaries, so for a
 * needle in such a script a plain substring match on the canonical text is used instead. That is the best that
 * can be done without a dictionary; it is documented here rather than hidden.
 */

const NO_SPACE_SCRIPTS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/** Canonical form used on both sides of every comparison. */
export function normalizeForMatching(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '') // diacritics
    .toLocaleLowerCase('en-US')
    .replace(/['’`´ʼ]/g, '') // Joe's -> joes
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Occurrences of one needle in a text (0 when the needle is empty). Overlapping occurrences are not double counted. */
export function countMentions(text, needle) {
  const h = normalizeForMatching(text);
  const n = normalizeForMatching(needle);
  if (!h || !n) return 0;

  if (NO_SPACE_SCRIPTS.test(n)) {
    const compactH = h.replace(/ /g, '');
    const compactN = n.replace(/ /g, '');
    if (!compactN) return 0;
    let count = 0;
    for (let i = compactH.indexOf(compactN); i !== -1; i = compactH.indexOf(compactN, i + compactN.length)) count += 1;
    return count;
  }

  const paddedH = ` ${h} `;
  const paddedN = ` ${n} `;
  let count = 0;
  let from = 0;
  for (;;) {
    const i = paddedH.indexOf(paddedN, from);
    if (i === -1) break;
    count += 1;
    from = i + paddedN.length - 1; // the closing space may open the next match
  }
  return count;
}

export function mentions(text, needle) {
  return countMentions(text, needle) > 0;
}

/** Which of `names` (strings) occur in `text`, with counts. Names that normalise to nothing are ignored. */
export function findMentions(text, names) {
  const out = [];
  const seen = new Set();
  for (const name of Array.isArray(names) ? names : []) {
    const key = normalizeForMatching(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const count = countMentions(text, name);
    if (count > 0) out.push({ name, count });
  }
  return out;
}

// A deliberately small list: words that, alone, say nothing about WHICH business is meant.
const GENERIC_NAME_WORDS = new Set([
  'the', 'and', 'of', 'a', 'an', 'group', 'company', 'co', 'inc', 'ltd', 'llc', 'services', 'service', 'solutions',
  'global', 'digital', 'online', 'international', 'india', 'systems', 'technologies', 'technology', 'hospital',
  'hospitals', 'clinic', 'clinics', 'center', 'centre', 'agency', 'studio', 'consulting', 'partners', 'associates',
  'enterprises', 'industries', 'store', 'shop', 'home', 'best', 'new', 'first', 'one', 'pro', 'plus',
]);

/**
 * Can this business name be matched reliably in free text? Returns { reliable, reason }. A name is NOT reliable when it
 * is very short, consists only of generic words, or is entirely made of words that also describe the business's industry
 * or services (then a plain description would "mention" the brand). Unreliable names are reported, never silently scored.
 */
export function assessNameReliability(name, contextTexts = []) {
  const n = normalizeForMatching(name);
  if (!n) return { reliable: false, reason: 'empty' };
  const tokens = n.split(' ');
  if (!NO_SPACE_SCRIPTS.test(n) && n.replace(/ /g, '').length < 3) return { reliable: false, reason: 'too_short' };
  if (tokens.every((t) => GENERIC_NAME_WORDS.has(t))) return { reliable: false, reason: 'generic_words' };
  const context = new Set(normalizeForMatching((Array.isArray(contextTexts) ? contextTexts : []).filter(Boolean).join(' ')).split(' ').filter(Boolean));
  if (context.size && tokens.every((t) => context.has(t) || GENERIC_NAME_WORDS.has(t))) return { reliable: false, reason: 'overlaps_industry_terms' };
  return { reliable: true, reason: null };
}

export default { normalizeForMatching, countMentions, mentions, findMentions, assessNameReliability };
