/**
 * KeywordDeduplicationService — Onboarding keyword deduplication.
 *
 * Normalises keywords before comparison so that variants like
 * "Software Company" and "software company " collapse to one entry.
 *
 * Normalisation rules:
 *  1. Lowercase
 *  2. Trim leading/trailing whitespace
 *  3. Collapse internal whitespace runs to a single space
 *
 * Used ONLY by the onboarding keyword suggestion pipeline.
 */

export const KeywordDeduplicationService = {
  /**
   * Remove duplicate keywords from a list, keeping the first occurrence.
   *
   * @param {Array<{keyword: string, [key: string]: any}>} keywords
   * @returns {Array}
   */
  deduplicate(keywords) {
    const seen   = new Set();
    const result = [];

    for (const kw of keywords) {
      if (!kw?.keyword) continue;
      const normalised = kw.keyword.toLowerCase().trim().replace(/\s+/g, ' ');
      if (seen.has(normalised)) continue;
      seen.add(normalised);
      result.push(kw);
    }

    const removed = keywords.length - result.length;
    console.log(`[KW_DEDUP] input=${keywords.length} | removed=${removed} | output=${result.length}`);
    return result;
  },
};
