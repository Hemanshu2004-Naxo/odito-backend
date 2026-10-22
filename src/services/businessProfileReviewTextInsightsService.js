import BusinessProfileReview from '../modules/app_user/model/BusinessProfileReview.js';
import { resolveSentiment } from './businessProfileReviewSentimentService.js';
import { createKeywordAccumulator, parseReviewText } from './businessProfileReviewKeywordService.js';
import { createThemeAccumulator } from './businessProfileReviewThemeService.js';
import { KEYWORD_RULES, SUPPORTED_LANGUAGES } from '../config/reviewTextStopWords.js';
import { LoggerUtil } from '../utils/LoggerUtil.js';

/**
 * Keyword cloud + review themes for one project/location/date range.
 *
 * SCALE: reviews are STREAMED from MongoDB through a cursor with a 3-field
 * projection (comment, rating, stored sentiment label) and folded into two
 * accumulators one at a time, so memory is bounded by the vocabulary and never
 * by the number of reviews - nothing is loaded into the browser and there are
 * no per-keyword / per-theme queries.
 *
 * CACHE: the result only changes when reviews are re-synced (or the day/range
 * window moves), so it is cached in-process under
 *   project + location + range + timezone + window dates + last-sync stamp.
 * A sync changes the stamp and so invalidates implicitly; replies don't affect
 * text or ratings. Bounded size + TTL. (Single backend instance today; when that
 * changes this is the one place to swap for a shared cache or a persisted
 * pre-computed result.)
 *
 * SENTIMENT: resolved with the shared rule (stored label, else from stars) -
 * this service has no sentiment logic of its own.
 */

const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX_ENTRIES = 100;
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null; }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
  while (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value); // oldest first
}

/**
 * Words of the business's own name (e.g. "Krishna Eye Centre - Parel"): they
 * appear in most reviews and say nothing about what customers talk about, so
 * they are excluded from the keyword cloud / phrases (never from themes).
 * "centre"/"center" are treated as the same word.
 */
export function brandTokensFromName(name) {
  if (!name || typeof name !== 'string') return new Set();
  const tokens = new Set(parseReviewText(name).tokenSet);
  if (tokens.has('centre')) tokens.add('center');
  if (tokens.has('center')) tokens.add('centre');
  return tokens;
}

/** Test hook. */
export function clearTextInsightsCache() { cache.clear(); }

/**
 * @param {object} p
 * @param {string} p.projectId
 * @param {string} p.locationId   already authorised by the caller (stored connection)
 * @param {object} p.range        resolveRange() output (same window as every other module)
 * @param {number|string} [p.version] last review-sync stamp; part of the cache key
 * @returns {Promise<{ keywords: object, themes: object }>}
 */
export async function getReviewTextInsights({ projectId, locationId, range, version = 0, businessName = null }) {
  const key = [projectId, locationId, range.key, range.timezone, range.startKey, range.endKey, version, businessName || ''].join('|');
  const cached = cacheGet(key);
  if (cached) return cached;

  const startedAt = Date.now();
  const keywordAcc = createKeywordAccumulator();
  const themeAcc = createThemeAccumulator();
  const brandTokens = brandTokensFromName(businessName);
  let reviewsInPeriod = 0;

  const cursor = BusinessProfileReview.find(
    {
      project_id: projectId,
      business_location_id: locationId,
      is_deleted: false,
      review_create_time: { $gte: range.start, $lte: range.end },
      comment: { $nin: [null, ''] },
    },
    { comment: 1, star_rating: 1, sentiment_label: 1 }
  ).lean().cursor();

  for await (const doc of cursor) {
    // Same definition of "has text" as the Review Distribution module.
    if (typeof doc.comment !== 'string' || !doc.comment.trim()) continue;
    reviewsInPeriod += 1;
    const sentiment = resolveSentiment({ storedLabel: doc.sentiment_label, rating: doc.star_rating });
    // One parse feeds both: brand words are hidden from `words`/`phrases` (keywords)
    // but stay in `tokenSet`/`clauses`, which is all theme matching reads.
    const parsed = parseReviewText(doc.comment, { ignoreWords: brandTokens });
    keywordAcc.add(parsed, sentiment);
    themeAcc.add(parsed, sentiment);
  }

  const k = keywordAcc.finalize();
  const t = themeAcc.finalize();
  const result = {
    keywords: {
      status: k.words.length ? 'ok' : 'insufficient_text',
      basis: {
        reviewsWithText: k.reviewsAnalysed,
        minWordReviews: KEYWORD_RULES.minWordReviews,
        languages: SUPPORTED_LANGUAGES,
        excludedBrandTerms: [...brandTokens].filter((t) => t.length >= 3).sort(),
      },
      words: k.words,
      phrases: k.phrases,
    },
    themes: {
      status: t.items.length ? 'ok' : 'no_themes',
      reviewsAnalysed: t.reviewsAnalysed,
      baseline: t.baseline,
      items: t.items,
    },
  };

  cacheSet(key, result);
  LoggerUtil.info('Review text insights computed', {
    projectId: String(projectId), locationId, range: range.key, reviews: reviewsInPeriod,
    words: k.words.length, phrases: k.phrases.length, themes: t.items.length, durationMs: Date.now() - startedAt,
  });
  return result;
}

export default { getReviewTextInsights, clearTextInsightsCache };
