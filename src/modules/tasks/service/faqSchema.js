import crypto from 'crypto';
import { normalizeTextValue } from './valueNormalization.js';

/**
 * FAQ schema helpers — the single place that knows how to:
 *   - read the FAQ Q/A pairs the crawler detected on a page,
 *   - turn ONLY those pairs into Schema.org FAQPage JSON-LD,
 *   - read pairs back out of a FAQPage JSON-LD object, and
 *   - decide whether two pair lists describe the same FAQ.
 *
 * Shared by the issue-context resolver (what the UI shows), the recommendation
 * service (what gets generated), the WordPress fix service (what gets written)
 * and TaskVerificationService (what counts as fixed) — so "what Odito shows",
 * "what Odito writes" and "what Odito verifies" can never drift apart, the same
 * design rule valueNormalization.js documents for the other fix types.
 *
 * Nothing here ever invents a question or an answer: every function either
 * passes crawler-detected text through untouched (whitespace-collapsed only) or
 * refuses (returns null / an empty list).
 */

export const FAQ_LIMITS = Object.freeze({
  maxPairs: 50,
  maxQuestionLength: 500,
  maxAnswerLength: 10000,
});

export const FAQ_EXTRACTION_FAILED_MESSAGE =
  'FAQ content detected, but the question/answer pairs could not be reliably extracted.';

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeHtmlEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return match; }
      }
      return match;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named !== undefined ? named : match;
  });
}

// C0/C1 control characters except tab/newline (collapsed to spaces below).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * Plain crawler text -> JSON-safe text. ONLY collapses whitespace and drops
 * control characters. Deliberately does not strip tag-like text: the crawler
 * already hands over visible text, so a literal "<br>" in it is the visitor's
 * own content (e.g. an FAQ about HTML), not markup to remove.
 */
export function sanitizePlainFaqText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim();
}

/**
 * HTML -> plain text, for text that comes from OUTSIDE the crawler's own
 * visible-text extraction (an existing FAQPage schema's acceptedAnswer.text,
 * which Schema.org allows to contain HTML). Used only when comparing.
 */
export function htmlToPlainText(value) {
  if (typeof value !== 'string') return '';
  const withoutBlocks = value.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');
  const spaced = withoutBlocks.replace(/<\/?(p|div|br|li|ul|ol|h[1-6]|tr|td|th|table|blockquote)\b[^>]*>/gi, ' ');
  return sanitizePlainFaqText(decodeHtmlEntities(spaced.replace(/<[^>]+>/g, '')));
}

const pairKey = (question) => normalizeTextValue(question);

/**
 * Validates + cleans a raw pair list. Drops (never repairs) anything unusable:
 * empty / over-long question or answer, duplicate questions (first wins).
 * @returns {{question: string, answer: string}[]}
 */
export function sanitizeFaqPairs(rawPairs, { stripHtml = false } = {}) {
  if (!Array.isArray(rawPairs)) return [];
  const clean = stripHtml ? htmlToPlainText : sanitizePlainFaqText;
  const seen = new Set();
  const pairs = [];
  for (const raw of rawPairs) {
    const question = clean(raw?.question);
    const answer = clean(raw?.answer);
    if (!question || !answer) continue;
    if (question.length > FAQ_LIMITS.maxQuestionLength || answer.length > FAQ_LIMITS.maxAnswerLength) continue;
    const key = pairKey(question);
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ question, answer });
    if (pairs.length >= FAQ_LIMITS.maxPairs) break;
  }
  return pairs;
}

function schemaTypes(node) {
  const t = node?.['@type'];
  return Array.isArray(t) ? t : [t];
}

/** Every FAQPage node in a crawler `structured_data` array (also inside @graph / nested arrays). */
export function findFaqPageSchemas(structuredData) {
  const found = [];
  const visit = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 4) return;
    if (Array.isArray(node)) {
      node.forEach((child) => visit(child, depth + 1));
      return;
    }
    if (schemaTypes(node).includes('FAQPage')) found.push(node);
    if (node['@graph']) visit(node['@graph'], depth + 1);
  };
  visit(structuredData);
  return found;
}

/**
 * Pairs out of ONE FAQPage schema object. Returns null when the object is not
 * a well-formed FAQPage (missing/empty mainEntity, a non-Question entry, an
 * entry without an answer text) — never a partial guess.
 */
export function extractFaqPairsFromSchema(schema, { stripHtml = true } = {}) {
  if (!schema || typeof schema !== 'object' || !schemaTypes(schema).includes('FAQPage')) return null;
  const entities = Array.isArray(schema.mainEntity) ? schema.mainEntity : (schema.mainEntity ? [schema.mainEntity] : []);
  if (entities.length === 0) return null;

  const raw = [];
  for (const entity of entities) {
    if (!entity || !schemaTypes(entity).includes('Question')) return null;
    const answer = Array.isArray(entity.acceptedAnswer) ? entity.acceptedAnswer[0] : entity.acceptedAnswer;
    if (typeof entity.name !== 'string' || typeof answer?.text !== 'string') return null;
    raw.push({ question: entity.name, answer: answer.text });
  }
  const pairs = sanitizeFaqPairs(raw, { stripHtml });
  // A pair that got dropped means the schema was not what it claimed to be.
  return pairs.length === raw.length ? pairs : null;
}

/** All FAQ pairs the page's crawled structured data currently exposes (across every FAQPage block). */
export function extractFaqPairsFromStructuredData(structuredData) {
  const combined = [];
  for (const schema of findFaqPageSchemas(structuredData)) {
    const pairs = extractFaqPairsFromSchema(schema);
    if (pairs) combined.push(...pairs);
  }
  return sanitizeFaqPairs(combined);
}

/** Schema.org FAQPage JSON-LD object built from pairs — and nothing else. */
export function buildFaqPageJsonLd(pairs) {
  const clean = sanitizeFaqPairs(pairs);
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: clean.map(({ question, answer }) => ({
      '@type': 'Question',
      name: question,
      acceptedAnswer: { '@type': 'Answer', text: answer },
    })),
  };
}

/** Pretty-printed JSON-LD string (what the UI previews and the recommendation stores). Null when there are no usable pairs. */
export function serializeFaqPageJsonLd(pairs) {
  const schema = buildFaqPageJsonLd(pairs);
  return schema.mainEntity.length > 0 ? JSON.stringify(schema, null, 2) : null;
}

/**
 * Parses a stored/serialized FAQPage JSON-LD string (or object) back into
 * pairs. Strict — see extractFaqPairsFromSchema. Used to derive the value to
 * write from a Recommendation and to validate anything before it is sent.
 * @returns {{question: string, answer: string}[]|null}
 */
export function parseFaqPageJsonLd(input, { stripHtml = false } = {}) {
  let parsed = input;
  if (typeof input === 'string') {
    try { parsed = JSON.parse(input); } catch { return null; }
  }
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  const target = findFaqPageSchemas(candidates)[0];
  return target ? extractFaqPairsFromSchema(target, { stripHtml }) : null;
}

/** Order-insensitive, typography/entity-tolerant equality of two pair lists (same rules as every other verified field). */
export function faqPairsMatch(expected, actual) {
  const a = sanitizeFaqPairs(expected);
  const b = sanitizeFaqPairs(actual);
  if (a.length === 0 || a.length !== b.length) return false;
  const key = (p) => `${normalizeTextValue(p.question)}\u0000${normalizeTextValue(p.answer)}`;
  const remaining = new Map();
  for (const p of a) remaining.set(key(p), (remaining.get(key(p)) || 0) + 1);
  for (const p of b) {
    const k = key(p);
    const n = remaining.get(k);
    if (!n) return false;
    remaining.set(k, n - 1);
  }
  return true;
}

/** True when every pair in `subset` also appears (same question AND answer) in `superset`. */
export function faqPairsAreSubset(subset, superset) {
  const a = sanitizeFaqPairs(subset);
  if (a.length === 0) return false;
  const key = (p) => `${normalizeTextValue(p.question)}\u0000${normalizeTextValue(p.answer)}`;
  const pool = new Set(sanitizeFaqPairs(superset).map(key));
  return a.every((p) => pool.has(key(p)));
}

/** Stable short hash of a pair list — used to key a recommendation to the exact FAQ content it was built from. */
export function hashFaqPairs(pairs) {
  return crypto.createHash('sha256').update(JSON.stringify(sanitizeFaqPairs(pairs))).digest('hex').slice(0, 16);
}

/**
 * What the crawler found on a page, in the shape the UI and the recommendation
 * service consume.
 *
 * status:
 *   'extracted'          FAQ content detected AND usable Q/A pairs extracted
 *   'extraction_failed'  FAQ content detected, but no pairs could be reliably
 *                        extracted (also: page crawled before pair extraction
 *                        existed — `reason: 'crawl_predates_extraction'`)
 *   'no_faq_content'     the crawler saw no FAQ content on this page
 *
 * @param {{pageData?: object, issueDoc?: object}} input
 */
export function getFaqDetection({ pageData, issueDoc } = {}) {
  const signals = pageData?.faq_howto_signals || {};
  const pairs = sanitizeFaqPairs(signals.faq_pairs);
  const pairsExtractionRan = signals.faq_pairs_extracted === true;

  const schemaBlocks = findFaqPageSchemas(pageData?.structured_data);
  const schemaPairs = extractFaqPairsFromStructuredData(pageData?.structured_data);
  const schemaDetected = schemaBlocks.length > 0 || signals.faq_schema_present === true;

  const heuristicQuestionCount = Number(signals.qa_pattern_count) || 0;
  const contentDetected =
    pairs.length > 0 ||
    Boolean(issueDoc) ||
    (Number(signals.faq_section_count) || 0) > 0 ||
    heuristicQuestionCount >= 3;

  let status;
  let reason = null;
  if (!contentDetected) {
    status = 'no_faq_content';
  } else if (pairs.length > 0) {
    status = 'extracted';
  } else {
    status = 'extraction_failed';
    reason = pairsExtractionRan ? 'no_reliable_pairs' : 'crawl_predates_extraction';
  }

  const warnings = [];
  if (status === 'extracted' && heuristicQuestionCount > pairs.length) {
    warnings.push('partial_extraction');
  }

  const jsonLd = status === 'extracted' ? serializeFaqPageJsonLd(pairs) : null;

  return {
    content: {
      detected: contentDetected,
      status,
      reason,
      pairCount: pairs.length,
      pairs,
      heuristicQuestionCount,
      warnings,
      message: status === 'extraction_failed' ? FAQ_EXTRACTION_FAILED_MESSAGE : null,
    },
    schema: {
      detected: schemaDetected,
      pairCount: schemaPairs.length,
    },
    schemaPreview: jsonLd ? { format: 'json-ld', jsonLd } : null,
    canGenerate: status === 'extracted' && !schemaDetected,
  };
}

export default {
  FAQ_LIMITS,
  FAQ_EXTRACTION_FAILED_MESSAGE,
  sanitizePlainFaqText,
  htmlToPlainText,
  sanitizeFaqPairs,
  findFaqPageSchemas,
  extractFaqPairsFromSchema,
  extractFaqPairsFromStructuredData,
  buildFaqPageJsonLd,
  serializeFaqPageJsonLd,
  parseFaqPageJsonLd,
  faqPairsMatch,
  faqPairsAreSubset,
  hashFaqPairs,
  getFaqDetection,
};
