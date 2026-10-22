import { REVIEW_THEMES, MIN_THEME_REVIEWS } from '../config/reviewThemeTaxonomy.js';
import { parseReviewText, foldToken } from './businessProfileReviewKeywordService.js';
import { pct } from './businessProfileReviewMetrics.js';

/**
 * Deterministic review themes / topics. A review belongs to EVERY theme it
 * mentions (never forced into exactly one). Matching is keyword based against
 * the configurable taxonomy in config/reviewThemeTaxonomy.js; theme sentiment
 * is the sentiment of the reviews that mention the theme, using the same rules
 * as the rest of the dashboard (stored label, else 4-5 positive / 3 neutral /
 * 1-2 negative) - this service never re-implements sentiment, callers pass the
 * resolved label.
 */

const SENTIMENTS = ['positive', 'neutral', 'negative'];

/** Compile a taxonomy once: fold terms with the same function reviews are folded with. */
export function compileThemes(themes = REVIEW_THEMES) {
  return themes.map((t) => ({
    id: t.id,
    name: t.name,
    terms: new Set((t.terms || []).map((term) => foldToken(term.toLowerCase()))),
    phrases: (t.phrases || [])
      .map((p) => parseReviewText(p).clauses.join(' '))
      .filter(Boolean),
  }));
}

/** Which theme ids does this parsed review mention? */
export function matchThemes(parsed, compiled) {
  const matched = [];
  for (const theme of compiled) {
    let hit = false;
    for (const term of theme.terms) {
      if (parsed.tokenSet.has(term)) { hit = true; break; }
    }
    if (!hit) {
      hit = theme.phrases.some((phrase) => parsed.clauses.some((c) => ` ${c} `.includes(` ${phrase} `)));
    }
    if (hit) matched.push(theme.id);
  }
  return matched;
}

export function createThemeAccumulator(themes = REVIEW_THEMES) {
  const compiled = compileThemes(themes);
  const stats = new Map(compiled.map((t) => [t.id, { reviews: 0, positive: 0, neutral: 0, negative: 0 }]));
  const baseline = { positive: 0, neutral: 0, negative: 0 };
  let reviews = 0;

  return {
    add(parsed, sentiment) {
      reviews += 1;
      const sent = SENTIMENTS.includes(sentiment) ? sentiment : 'neutral';
      baseline[sent] += 1;
      for (const id of matchThemes(parsed, compiled)) {
        const s = stats.get(id);
        s.reviews += 1;
        s[sent] += 1;
      }
    },

    finalize(minReviews = MIN_THEME_REVIEWS) {
      const N = reviews;
      const items = compiled
        .map((t) => ({ t, s: stats.get(t.id) }))
        .filter(({ s }) => s.reviews >= minReviews)
        .map(({ t, s }) => ({
          id: t.id,
          name: t.name,
          reviewCount: s.reviews,
          percentage: pct(s.reviews, N),
          positive: s.positive, neutral: s.neutral, negative: s.negative,
          positivePercent: pct(s.positive, s.reviews),
          neutralPercent: pct(s.neutral, s.reviews),
          negativePercent: pct(s.negative, s.reviews),
        }))
        .sort((a, b) => b.reviewCount - a.reviewCount || a.name.localeCompare(b.name));

      return {
        reviewsAnalysed: N,
        // How the whole period's text reviews feel - the yardstick for each theme.
        baseline: {
          positive: baseline.positive, neutral: baseline.neutral, negative: baseline.negative,
          positivePercent: pct(baseline.positive, N),
          neutralPercent: pct(baseline.neutral, N),
          negativePercent: pct(baseline.negative, N),
        },
        items,
      };
    },
  };
}

export default { compileThemes, matchThemes, createThemeAccumulator };
