/**
 * Review sentiment rules (Business Profile reviews).
 *
 * There is NO text-sentiment / AI system for reviews in Odito today (the only
 * "sentiment" elsewhere is AI-visibility brand sentiment, unrelated), so:
 *
 *   1. A review's STORED label (BusinessProfileReview.sentiment_label) wins when
 *      present. That field is reserved for a real analysis (e.g. a future AI
 *      pass over the review text) and nothing writes it yet.
 *   2. Otherwise the label is DERIVED from the star rating:
 *        4-5 stars -> positive,  3 stars -> neutral,  1-2 stars -> negative.
 *
 * Consequence (documented limitation): a 5-star review whose text is a
 * complaint is still counted positive until text analysis exists. The
 * analytics response reports how many reviews are stored vs derived
 * (sentiment.basis) so this is never hidden.
 *
 * The derived label is computed inside the aggregation (no per-review writes,
 * no LLM call on page load) via sentimentLabelExpr().
 */

export const SENTIMENT_LABELS = ['positive', 'neutral', 'negative'];

export function ratingToSentiment(stars) {
  if (stars >= 4) return 'positive';
  if (stars === 3) return 'neutral';
  return 'negative';
}

/** stored label if any, else derived from rating - for in-memory use. */
export function resolveSentiment({ storedLabel, rating }) {
  return SENTIMENT_LABELS.includes(storedLabel) ? storedLabel : ratingToSentiment(rating);
}

/** MongoDB aggregation expression equivalent to resolveSentiment(). */
export function sentimentLabelExpr() {
  return {
    $ifNull: [
      '$sentiment_label',
      {
        $switch: {
          branches: [
            { case: { $gte: ['$star_rating', 4] }, then: 'positive' },
            { case: { $eq: ['$star_rating', 3] }, then: 'neutral' },
          ],
          default: 'negative',
        },
      },
    ],
  };
}

export default { SENTIMENT_LABELS, ratingToSentiment, resolveSentiment, sentimentLabelExpr };
