import crypto from 'crypto';
import { RecommendationRefusedError } from './recommendationRefusal.js';
import {
  FAQ_EXTRACTION_FAILED_MESSAGE,
  hashFaqPairs,
  serializeFaqPageJsonLd,
} from '../../tasks/service/faqSchema.js';

/**
 * Deterministic recommendation for the `faq_schema` issue.
 *
 * This issue is the one place the recommendation engine must NOT call the LLM:
 * the correct FAQPage schema is fully determined by the FAQ Q/A pairs the
 * crawler already detected on the page, and any model involvement is a chance
 * to invent, reword or drop a question. So the schema here is built purely from
 * those pairs (see faqSchema.js) and every prose field is a fixed template
 * that only interpolates counts.
 *
 * Thrown as FaqRecommendationError when there is nothing safe to build — the
 * controller relays code/message/statusCode as-is (userFacing), and no
 * recommendation document is stored, so a fabricated schema can never reach the
 * apply flow.
 */

export class FaqRecommendationError extends RecommendationRefusedError {
  constructor(code, message, statusCode = 422) {
    super(code, message, statusCode);
    this.name = 'FaqRecommendationError';
  }
}

/**
 * @param {object} detection - IssueContext.faqDetection (see faqSchema.getFaqDetection)
 * @throws {FaqRecommendationError}
 */
export function assertFaqDetectionUsable(detection) {
  if (!detection || detection.content?.status === 'no_faq_content') {
    throw new FaqRecommendationError(
      'FAQ_CONTENT_NOT_FOUND',
      'No FAQ content was detected on this page in the latest crawl, so there is nothing to convert into FAQPage schema.'
    );
  }
  if (detection.content.status !== 'extracted' || !detection.content.pairs?.length) {
    throw new FaqRecommendationError('FAQ_EXTRACTION_UNAVAILABLE', FAQ_EXTRACTION_FAILED_MESSAGE);
  }
  if (detection.schema?.detected) {
    throw new FaqRecommendationError(
      'FAQ_SCHEMA_ALREADY_PRESENT',
      'A FAQPage schema is already present on this page in the latest crawl.',
      409
    );
  }
}

/** Fingerprint keyed to the exact FAQ content, so a re-crawl that changed the FAQ never serves a stale schema. */
export function faqSchemaFingerprint(projectId, pageUrl, pairs) {
  return crypto
    .createHash('sha256')
    .update(`faq_schema|${projectId}|${pageUrl}|${hashFaqPairs(pairs)}`)
    .digest('hex');
}

/** JSON-LD safe to paste inside a <script> element (a literal "</script>" in text can't terminate the tag). */
function toScriptTag(jsonLd) {
  return `<script type="application/ld+json">\n${jsonLd.replace(/</g, '\\u003c')}\n</script>`;
}

/**
 * @param {object} detection - a detection that already passed assertFaqDetectionUsable
 * @returns {object} sections in the shape Recommendation.sections expects
 */
export function buildFaqSchemaSections(detection) {
  const pairs = detection.content.pairs;
  const jsonLd = serializeFaqPageJsonLd(pairs);
  if (!jsonLd) {
    throw new FaqRecommendationError('FAQ_EXTRACTION_UNAVAILABLE', FAQ_EXTRACTION_FAILED_MESSAGE);
  }
  const count = pairs.length;
  const noun = count === 1 ? 'question' : 'questions';

  return {
    whyThisMatters:
      'This page shows FAQ content but has no FAQPage structured data, so search engines and AI answer engines ' +
      'have to guess which text is a question and which is its answer. Marking up the FAQ that is already visible ' +
      'gives them an explicit, machine-readable version of it.',
    recommendedFix:
      `Add FAQPage JSON-LD built from the ${count} ${noun} detected on this page. Each question and answer is copied ` +
      'verbatim from the visible page content — nothing was added, reworded or removed. Review the list of detected ' +
      'questions before applying.',
    implementationExample: {
      type: 'html',
      content: toScriptTag(jsonLd),
    },
    expectedImpact: [
      'Search engines and AI answer engines can read this page\'s FAQ as structured question/answer data.',
      'The schema always matches what visitors can actually see on the page.',
    ],
    difficulty: 'easy',
    estimatedFixTime: '5 minutes',
    recommendedVersion: jsonLd,
    changeSummary: {
      items: [{
        field: 'FAQPage schema (JSON-LD)',
        changeType: 'add',
        before: 'No FAQPage schema on the page',
        after: `FAQPage schema with ${count} ${noun}, taken from the visible FAQ`,
        reason: 'FAQ content is visible on the page but is not marked up as FAQPage schema.',
        priority: 'medium',
      }],
    },
    sourceAttribution: {
      generatedBy: 'template',
      promptPath: 'deterministic_faq_schema',
      promptGroup: null,
      contextSources: { detectedFaqPairs: count, llmUsed: false },
      modelUsed: null,
      cacheStatus: 'miss',
    },
  };
}

export default { FaqRecommendationError, assertFaqDetectionUsable, faqSchemaFingerprint, buildFaqSchemaSections };
