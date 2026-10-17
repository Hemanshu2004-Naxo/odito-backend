import { RecommendationRefusedError } from './recommendationRefusal.js';

/**
 * images_missing_alt_text: when the only thing the audit flagged was an analytics/advertising tracker (the Facebook Pixel's
 * <noscript> fallback and the like), there is no picture to describe. A model asked anyway invents file names and alt texts, and the
 * generic "I have implemented this" checklist would let a person mark a task done for something that cannot be fixed.
 *
 * The decision is the issue-context resolver's `altFindingScope` (actionable === 0 with ignoredTracking > 0). With no scope (an
 * older client context, no page URL) nothing is refused: this only ever blocks on positive evidence.
 */
export class ImageAltRecommendationError extends RecommendationRefusedError {
  constructor(code, message, statusCode = 422) {
    super(code, message, statusCode);
    this.name = 'ImageAltRecommendationError';
  }
}

export const ALT_NOT_APPLICABLE_MESSAGE = 'The only item flagged on this page is an analytics or advertising tracker, not a picture, so there is no alt text to write and no recommendation was generated. The audit stops reporting it on the next recrawl; nothing needs to be fixed.';

export function isAltFindingNotApplicable(issueContext) {
  const scope = issueContext?.altFindingScope;
  return !!scope && scope.actionable === 0 && scope.ignoredTracking > 0;
}

/** @throws {ImageAltRecommendationError} */
export function assertAltFindingActionable(issueContext) {
  if (isAltFindingNotApplicable(issueContext)) throw new ImageAltRecommendationError('ALT_FINDING_NOT_APPLICABLE', ALT_NOT_APPLICABLE_MESSAGE);
}

export default { ImageAltRecommendationError, ALT_NOT_APPLICABLE_MESSAGE, isAltFindingNotApplicable, assertAltFindingActionable };
