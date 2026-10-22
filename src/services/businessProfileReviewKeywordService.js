import {
  STOP_WORDS_BY_LANGUAGE, SCRIPT_LANGUAGE, TOKEN_RULES, PLURAL_FOLD_EXCEPTIONS, KEYWORD_RULES,
} from '../config/reviewTextStopWords.js';
import { pct } from './businessProfileReviewMetrics.js';

/**
 * Deterministic keyword + phrase extraction for review text. No AI, no external
 * NLP dependency; plain functions over strings.
 *
 * Pipeline (per review):
 *   cleanReviewText -> clauses -> tokens -> (lowercase, collapse elongation,
 *   strip apostrophes, fold plurals) -> stop-word / length filtering ->
 *   unique words + adjacent-word phrases.
 *
 * COUNTING: the main metric is REVIEW frequency - a review that says "doctor"
 * three times counts once ("how many customers mentioned it"). Raw occurrences
 * are kept as `mentions` and only break ties.
 *
 * RANKING SCORE (documented, deterministic):
 *     score = reviewCount x ln(1 + N / reviewCount)
 *   N = reviews with text in the period. Ranks by how many customers mention a
 *   term, but a term present in nearly EVERY review (e.g. the business name)
 *   is discounted relative to a term that distinguishes a large minority.
 *   Ties: reviewCount desc, then mentions desc, then term A-Z.
 *
 * PHRASES: adjacent kept words inside one clause (a comma / full stop / dash
 * breaks the pair). Stop words never take part, which removes "the doctor",
 * "very good", "was very". A phrase must (1) appear in >= minPhraseReviews
 * reviews and (2) cohesion = phraseReviews / min(reviews(word1), reviews(word2))
 * >= minPhraseCohesion, which drops accidental neighbours of common words.
 */

// ── text normalization ──────────────────────────────────────────────────────

const HTML_ENTITIES = { '&amp;': '&', '&nbsp;': ' ', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>' };

/**
 * Google wraps translated reviews as
 *   "(Translated by Google) <english>\n\n(Original)\n<other language>".
 * Keep the translation (that is the text a reader of the dashboard can
 * understand) and drop the duplicated original + the marker words themselves.
 */
function unwrapGoogleTranslation(text) {
  const translated = /\(Translated by Google\)/i;
  const original = /\(Original\)/i;
  if (translated.test(text)) {
    const afterMarker = text.split(translated).slice(1).join(' ');
    const [translation, ...rest] = afterMarker.split(original);
    // translation-only wrapper with an empty translation: fall back to the original text
    return translation.trim() ? translation : rest.join(' ');
  }
  if (original.test(text)) return text.split(original).join(' ');
  return text;
}

/** Strip wrappers, HTML, URLs and e-mail addresses; normalize Unicode. */
export function cleanReviewText(raw) {
  if (typeof raw !== 'string') return '';
  let t = unwrapGoogleTranslation(raw);
  t = t.replace(/<[^>]*>/g, ' ');
  t = t.replace(/&(?:amp|nbsp|quot|lt|gt|#39);/g, (e) => HTML_ENTITIES[e] || ' ');
  t = t.replace(/https?:\/\/\S+|www\.\S+/gi, ' ');
  t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, ' ');
  return t.normalize('NFC').toLowerCase();
}

// ── token handling ──────────────────────────────────────────────────────────

const IRREGULAR_PLURALS = { lenses: 'lens' };

/** Conservative plural folding so "doctors"/"doctor" and "surgeries"/"surgery" count together. */
export function foldToken(w) {
  if (IRREGULAR_PLURALS[w]) return IRREGULAR_PLURALS[w];
  if (w.length <= 3 || PLURAL_FOLD_EXCEPTIONS.has(w)) return w;
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (/(ss|us|is)$/.test(w)) return w;
  if (/(sses|shes|ches|xes|zes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s')) return w.slice(0, -1);
  return w;
}

const CLAUSE_SPLIT = /[.!?;:,\n\r()[\]{}"“”|/\\—–\-•*]+/;
const WORD = /[\p{L}\p{M}][\p{L}\p{M}'’]*/gu;
const LATIN_ONLY = /^[\p{Script=Latin}\p{M}]+$/u;

/** "soooo" -> "so": collapse every run of a repeated letter to one letter. */
function collapseRuns(token) {
  return token.replace(/(\p{L})\1+/gu, '$1');
}

function languageOf(token) {
  if (LATIN_ONLY.test(token)) return SCRIPT_LANGUAGE.Latin;
  return null; // other script: kept, but no stop-word list yet
}

function isUsable(token, lang) {
  if (token.length > TOKEN_RULES.maxLength) return false;
  const min = lang ? TOKEN_RULES.minLatinLength : TOKEN_RULES.minOtherScriptLength;
  return token.length >= min || TOKEN_RULES.shortTermAllowList.has(token);
}

/**
 * Parse one review's text.
 * `ignoreWords` (Set of folded tokens) is hidden from words/phrases exactly like a
 * stop word - used for the business's own name - but still present in `tokenSet`
 * so theme matching is unaffected.
 * @returns {{
 *   tokenSet: Set<string>,      every folded word incl. stop words / titles (theme matching)
 *   clauses: string[],          folded words per clause joined by ' ' (theme phrase matching)
 *   words: {key:string, surface:string}[],   kept words in order (duplicates preserved)
 *   phrases: string[]           adjacent kept-word pairs "a b" (duplicates preserved)
 * }}
 */
export function parseReviewText(raw, { ignoreWords = null } = {}) {
  const tokenSet = new Set();
  const clauses = [];
  const words = [];
  const phrases = [];

  for (const clause of cleanReviewText(raw).split(CLAUSE_SPLIT)) {
    const tokens = clause.match(WORD);
    if (!tokens) continue;

    const folded = [];
    let prevKept = null;
    for (const original of tokens) {
      // apostrophes out (don't -> dont, doctor's -> doctors), 3+ repeated letters -> 2 (soooo -> soo)
      // possessives are stripped explicitly ("rani's" -> "rani", "doctors'" -> "doctors"): relying on
      // plural folding would miss names ending in -i/-us/-is. Other apostrophes just vanish (don't -> dont).
      const surface = original.replace(/['’]s?$/i, '').replace(/['’]/g, '').replace(/(\p{L})\1{2,}/gu, '$1$1');
      if (!surface) continue;
      const lang = languageOf(surface);
      const key = lang ? foldToken(surface) : surface;
      tokenSet.add(key);
      folded.push(key);

      const stops = lang ? STOP_WORDS_BY_LANGUAGE[lang] : null;
      // an elongated stop word ("soooo", "veryyy") collapses to its single-letter-run form
      const singleRun = collapseRuns(surface);
      const stopped = (stops && (stops.has(surface) || stops.has(key) || stops.has(singleRun))) || (ignoreWords && ignoreWords.has(key));
      if (stopped || !isUsable(key, lang)) { prevKept = null; continue; }

      words.push({ key, surface });
      if (prevKept) phrases.push(`${prevKept} ${key}`);
      prevKept = key;
    }
    if (folded.length) clauses.push(folded.join(' '));
  }
  return { tokenSet, clauses, words, phrases };
}

// ── accumulation + ranking ──────────────────────────────────────────────────

const SENTIMENTS = ['positive', 'neutral', 'negative'];
const newStat = () => ({ reviews: 0, mentions: 0, positive: 0, neutral: 0, negative: 0 });

function touch(map, key) {
  let s = map.get(key);
  if (!s) { s = newStat(); map.set(key, s); }
  return s;
}

/**
 * Streaming accumulator: add reviews one at a time (memory is bounded by the
 * vocabulary, never by the number of reviews), then finalize().
 */
export function createKeywordAccumulator() {
  const wordStats = new Map();
  const phraseStats = new Map();
  const surfaces = new Map(); // key -> Map(surface -> count), to display the commonest form
  let reviews = 0;

  return {
    /** @param parsed parseReviewText() output  @param sentiment 'positive'|'neutral'|'negative' */
    add(parsed, sentiment) {
      reviews += 1;
      const sent = SENTIMENTS.includes(sentiment) ? sentiment : 'neutral';

      const seenWords = new Set();
      for (const { key, surface } of parsed.words) {
        const stat = touch(wordStats, key);
        stat.mentions += 1;
        let forms = surfaces.get(key);
        if (!forms) { forms = new Map(); surfaces.set(key, forms); }
        forms.set(surface, (forms.get(surface) || 0) + 1);
        if (!seenWords.has(key)) { seenWords.add(key); stat.reviews += 1; stat[sent] += 1; }
      }

      const seenPhrases = new Set();
      for (const phrase of parsed.phrases) {
        const stat = touch(phraseStats, phrase);
        stat.mentions += 1;
        if (!seenPhrases.has(phrase)) { seenPhrases.add(phrase); stat.reviews += 1; stat[sent] += 1; }
      }
    },

    get reviewCount() { return reviews; },

    finalize(rules = KEYWORD_RULES) {
      const N = reviews;
      const display = (key) => {
        const forms = surfaces.get(key);
        if (!forms) return key;
        return [...forms].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
      };
      const score = (s) => Math.round(s.reviews * Math.log(1 + N / s.reviews) * 100) / 100;
      const shape = (term, s) => ({
        term,
        reviewCount: s.reviews,
        percentage: pct(s.reviews, N),
        mentions: s.mentions,
        positive: s.positive, neutral: s.neutral, negative: s.negative,
        score: score(s),
      });
      const rank = (a, b) => b.score - a.score || b.reviewCount - a.reviewCount || b.mentions - a.mentions || a.term.localeCompare(b.term);

      if (N < rules.minTextReviews) return { reviewsAnalysed: N, words: [], phrases: [] };

      const words = [...wordStats]
        .filter(([, s]) => s.reviews >= rules.minWordReviews)
        .map(([key, s]) => shape(display(key), s))
        .sort(rank)
        .slice(0, rules.maxWords);

      const minPhraseReviews = N < rules.smallPeriodTextReviews ? rules.minPhraseReviewsSmallPeriod : rules.minPhraseReviews;
      const phrases = [...phraseStats]
        .filter(([phrase, s]) => {
          if (s.reviews < minPhraseReviews) return false;
          const [a, b] = phrase.split(' ');
          const rarer = Math.min(wordStats.get(a)?.reviews || Infinity, wordStats.get(b)?.reviews || Infinity);
          return s.reviews / rarer >= rules.minPhraseCohesion;
        })
        .map(([phrase, s]) => shape(phrase.split(' ').map(display).join(' '), s))
        .sort(rank)
        .slice(0, rules.maxPhrases);

      return { reviewsAnalysed: N, words, phrases };
    },
  };
}

/** Convenience for tests / ad-hoc use: [{ text, sentiment }] -> { words, phrases }. */
export function extractKeywords(reviews, rules = KEYWORD_RULES) {
  const acc = createKeywordAccumulator();
  for (const r of reviews) acc.add(parseReviewText(r.text), r.sentiment);
  return acc.finalize(rules);
}

export default { cleanReviewText, parseReviewText, foldToken, createKeywordAccumulator, extractKeywords };
