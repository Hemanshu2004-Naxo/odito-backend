import crypto from 'crypto';
import { RecommendationRefusedError } from './recommendationRefusal.js';
import {
  RATING_UNAVAILABLE_MESSAGE,
  hashAggregateRating,
  parseAggregateRatingJsonLd,
} from '../../tasks/service/aggregateRatingSchema.js';

/**
 * Deterministic recommendation for the `aggregate_rating_schema` issue.
 *
 * Like faq_schema, this issue must NOT go through the LLM: the correct schema is
 * fully determined by the rating figures the page displays and by an entity that
 * already exists in the page's own structured data (see
 * aggregateRatingSchema.getRatingDetection). Any model involvement is a chance to
 * invent a rating, a review count or an entity name. Every prose field here is a
 * fixed template that only interpolates those verified values.
 *
 * Throws RatingRecommendationError (nothing stored) whenever there is nothing
 * safe to build, so a fabricated schema can never reach the apply flow.
 */

export class RatingRecommendationError extends RecommendationRefusedError {
  constructor(code, message, statusCode = 422) {
    super(code, message, statusCode);
    this.name = 'RatingRecommendationError';
  }
}

/**
 * @param {object} detection - IssueContext.ratingDetection (see getRatingDetection)
 * @throws {RatingRecommendationError}
 */
export function assertRatingDetectionUsable(detection) {
  if (!detection) {
    throw new RatingRecommendationError('RATING_DATA_UNAVAILABLE', RATING_UNAVAILABLE_MESSAGE);
  }
  if (detection.status === 'already_present') {
    throw new RatingRecommendationError('AGGREGATE_RATING_ALREADY_PRESENT', detection.message, 409);
  }
  if (detection.status === 'rating_ambiguous') {
    throw new RatingRecommendationError('RATING_DATA_AMBIGUOUS', detection.message);
  }
  if (detection.status === 'no_target_schema' || detection.status === 'target_not_mergeable') {
    throw new RatingRecommendationError('RATING_TARGET_UNAVAILABLE', detection.message);
  }
  if (detection.status !== 'ready' || !detection.generatedSchema?.jsonLd) {
    throw new RatingRecommendationError('RATING_DATA_UNAVAILABLE', RATING_UNAVAILABLE_MESSAGE);
  }
}

/** Keyed to the exact rating + target, so a re-crawl that changed either never serves a stale schema. */
export function ratingSchemaFingerprint(projectId, pageUrl, generated) {
  return crypto
    .createHash('sha256')
    .update(`aggregate_rating_schema|${projectId}|${pageUrl}|${hashAggregateRating(generated)}`)
    .digest('hex');
}

/** JSON-LD safe to paste inside a <script> element. */
function toScriptTag(jsonLd) {
  return `<script type="application/ld+json">\n${jsonLd.replace(/</g, '\\u003c')}\n</script>`;
}

/** The {target, rating} a usable detection would generate — parsed back from its own JSON-LD. */
export function generatedFromDetection(detection) {
  return parseAggregateRatingJsonLd(detection.generatedSchema.jsonLd);
}

/**
 * @param {object} detection - a detection that already passed assertRatingDetectionUsable
 * @returns {object} sections in the shape Recommendation.sections expects
 */
export function buildRatingSchemaSections(detection) {
  const generated = generatedFromDetection(detection);
  if (!generated) throw new RatingRecommendationError('RATING_DATA_UNAVAILABLE', RATING_UNAVAILABLE_MESSAGE);

  const { target, rating } = generated;
  const jsonLd = detection.generatedSchema.jsonLd;
  const count = rating.reviewCount !== undefined
    ? `${rating.reviewCount} review${rating.reviewCount === 1 ? '' : 's'}`
    : `${rating.ratingCount} rating${rating.ratingCount === 1 ? '' : 's'}`;
  const figure = `${rating.ratingValue} out of ${rating.bestRating} from ${count}`;
  const typeLabel = detection.targetSchemaType || 'schema';
  const selfServing = detection.warnings?.includes('self_serving_target');

  const expectedImpact = [
    'Search engines and AI answer engines can read the rating shown on this page as structured data.',
    'The values always match what visitors can see on the page.',
  ];
  if (selfServing) {
    expectedImpact.push(
      `Note: this rating is attached to an ${typeLabel} entity. Google's guidelines don't show star results for ratings a business gives about itself, so this may not produce star snippets.`
    );
  }

  return {
    whyThisMatters:
      'This page displays a rating and review count, but the matching AggregateRating structured data is missing, so ' +
      'search engines and AI answer engines have to infer the rating from page text. Marking up the rating that is already ' +
      'visible gives them an explicit, machine-readable version of it.',
    recommendedFix:
      `Add AggregateRating (${figure}) to the existing ${typeLabel} "${target.name}" on this page. The values are taken ` +
      'from the rating displayed on the page and the entity is the one already present in your structured data — nothing ' +
      'was estimated, rounded or added. Review the detected rating before applying.',
    implementationExample: { type: 'html', content: toScriptTag(jsonLd) },
    expectedImpact,
    difficulty: 'easy',
    estimatedFixTime: '5 minutes',
    recommendedVersion: jsonLd,
    changeSummary: {
      items: [{
        field: `aggregateRating on ${typeLabel} "${target.name}"`,
        changeType: 'add',
        before: 'No AggregateRating on the page',
        after: figure,
        reason: 'A rating and review count are displayed on the page but not marked up as AggregateRating.',
        priority: 'high',
      }],
    },
    sourceAttribution: {
      generatedBy: 'template',
      promptPath: 'deterministic_aggregate_rating_schema',
      promptGroup: null,
      contextSources: { detectedRating: true, targetSchemaType: typeLabel, llmUsed: false },
      modelUsed: null,
      cacheStatus: 'miss',
    },
  };
}

export default { RatingRecommendationError, assertRatingDetectionUsable, ratingSchemaFingerprint, buildRatingSchemaSections, generatedFromDetection };
