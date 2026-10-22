/**
 * KeywordNoiseFilterService — Onboarding keyword noise removal.
 *
 * Discards keywords that are irrelevant to business SEO:
 *  - Employment/recruitment terms  (jobs, salary, vacancy…)
 *  - Educational/informational terms (tutorial, course, wiki…)
 *  - Software piracy terms (crack, download, free software…)
 *  - Generic noise that will never convert (valve, github…)
 *
 * Used ONLY by the onboarding keyword suggestion pipeline.
 */

// Every term is checked as a substring of the lowercase keyword.
const NOISE_TERMS = [
  // Employment
  'job', 'jobs', 'salary', 'internship', 'vacancy', 'vacancies',
  'recruitment', 'career', 'careers', 'hiring', 'resume', 'cv',
  // Education
  'course', 'courses', 'training', 'tutorial', 'tutorials', 'certification',
  'certificate', 'degree', 'diploma', 'exam', 'study',
  // Informational / non-commercial
  'pdf', 'wiki', 'wikipedia', 'definition', 'meaning', 'what is',
  'how to', 'example', 'examples', 'template', 'templates', 'list of',
  // Software piracy / downloads
  'download', 'crack', 'cracked', 'free software', 'keygen', 'serial key',
  'torrent', 'pirate',
  // Brand noise
  'valve', 'github', 'stackoverflow', 'reddit',
];

export const KeywordNoiseFilterService = {
  /**
   * Remove noise keywords from the list.
   *
   * @param {Array<{keyword: string, [key: string]: any}>} keywords
   * @returns {Array}
   */
  filter(keywords) {
    const before = keywords.length;

    const filtered = keywords.filter(kw => {
      if (!kw?.keyword) return false;
      const kl = kw.keyword.toLowerCase().trim();

      // Reject very short tokens
      if (kl.length < 4) return false;

      // Reject if any noise term is a substring
      if (NOISE_TERMS.some(term => kl.includes(term))) return false;

      return true;
    });

    const removed = before - filtered.length;
    console.log(`[KW_NOISE_FILTER] input=${before} | removed=${removed} | output=${filtered.length}`);
    return filtered;
  },
};
