/**
 * KeywordIntentScoringService — Commercial intent scoring for onboarding keywords.
 *
 * Scores each keyword based on the presence of commercial-intent signals.
 * Higher score = stronger buyer/conversion intent = better for business SEO.
 *
 * Sorting: intentScore DESC, then search_volume DESC as tiebreaker.
 *
 * Used ONLY by the onboarding keyword suggestion pipeline.
 */

// [term, points] pairs — order does not matter; all matching terms accumulate.
const INTENT_SCORES = [
  ['company',       10],
  ['near me',       10],
  ['enterprise',     9],
  ['services',       8],
  ['agency',         8],
  ['solutions',      8],
  ['custom',         8],
  ['consulting',     7],
  ['development',    7],
  ['professional',   7],
  ['managed',        7],
  ['developer',      6],
  ['business',       6],
  ['provider',       6],
  ['local',          6],
  ['expert',         6],
  ['affordable',     6],
  ['best',           5],
  ['top',            5],
  ['hire',           5],
  ['firm',           5],
];

export const KeywordIntentScoringService = {
  /**
   * Compute commercial intent score for a single keyword string.
   *
   * @param {string} keyword
   * @returns {number}
   */
  scoreKeyword(keyword) {
    const kl = (keyword || '').toLowerCase().trim();
    return INTENT_SCORES.reduce(
      (acc, [term, pts]) => kl.includes(term) ? acc + pts : acc,
      0
    );
  },

  /**
   * Score, sort, and return top N keywords.
   *
   * @param {Array<{keyword: string, search_volume?: number, [key: string]: any}>} keywords
   * @param {number} limit - How many to return (default 5)
   * @returns {Array}
   */
  sortByIntent(keywords, limit = 5) {
    const scored = keywords.map(kw => ({
      ...kw,
      intentScore: this.scoreKeyword(kw.keyword),
    }));

    scored.sort((a, b) => {
      if (b.intentScore !== a.intentScore) return b.intentScore - a.intentScore;
      return (b.search_volume || 0) - (a.search_volume || 0);
    });

    const top = scored.slice(0, limit);

    console.log(
      `[KW_INTENT_SCORE] input=${keywords.length}` +
      ` | top${limit}=` +
      top.map(k => `"${k.keyword}"(score=${k.intentScore},vol=${k.search_volume ?? 0})`).join(' | ')
    );

    return top;
  },
};
