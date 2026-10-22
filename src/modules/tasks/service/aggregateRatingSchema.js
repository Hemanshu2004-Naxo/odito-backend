import crypto from 'crypto';

/**
 * AggregateRating schema helpers — the single place that knows how to:
 *   - read the rating figures the crawler saw DISPLAYED on a page,
 *   - choose which existing schema entity (Product / Service / LocalBusiness /
 *     Organization ...) the rating belongs to,
 *   - build the JSON-LD that attaches the rating to THAT entity,
 *   - read a rating back out of crawled structured data, and
 *   - decide whether two ratings are the same.
 *
 * Shared by the issue-context resolver (what the UI shows), the recommendation
 * service (what gets generated), the WordPress fix service (what gets written)
 * and TaskVerificationService (what counts as fixed) — the same design rule
 * faqSchema.js documents.
 *
 * Nothing here invents a value: a rating is generated only when the page shows
 * exactly one consistent set of {ratingValue, reviewCount|ratingCount,
 * bestRating}; the entity's @id / @type / name are copied verbatim from a schema
 * node that already exists on the page. If either is missing the result is
 * "cannot generate", never a guess.
 *
 * "Merge" means: the generated node carries the SAME @id as the existing
 * entity. The Bridge merges it into that entity's own JSON-LD where the active
 * SEO plugin exposes its graph (Rank Math, Yoast), and otherwise prints it as a
 * node with that @id — never as an unrelated new entity. A target without an
 * @id can't be merged safely and is refused.
 */

export const RATING_LIMITS = Object.freeze({ maxCount: 1_000_000_000, maxNameLength: 500 });

export const RATING_UNAVAILABLE_MESSAGE =
  'Reliable rating data is unavailable: a rating value and a review count could not both be extracted from this page, so no AggregateRating schema will be generated.';

// Rank: lower = preferred. Product-like, then Service, then LocalBusiness, then Organization.
const TARGET_RANKS = [
  { rank: 1, kind: 'product', types: ['Product', 'ProductGroup', 'SoftwareApplication', 'MobileApplication', 'WebApplication', 'Course'] },
  { rank: 2, kind: 'service', types: ['Service', 'ProfessionalService'] },
  { rank: 3, kind: 'local_business', types: ['LocalBusiness', 'Store', 'Restaurant', 'Dentist', 'Physician', 'MedicalBusiness', 'LegalService', 'RealEstateAgent', 'HomeAndConstructionBusiness', 'AutomotiveBusiness', 'FinancialService', 'HealthAndBeautyBusiness'] },
  { rank: 4, kind: 'organization', types: ['Organization', 'Corporation', 'OnlineBusiness', 'NGO'] },
];

const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const typesOf = (node) => asArray(node?.['@type']).filter((t) => typeof t === 'string');
const isAbsoluteId = (id) => typeof id === 'string' && /^https?:\/\/\S+$/i.test(id);

/** Every node of a crawler `structured_data` value (arrays, @graph, nested lists) as a flat list. */
export function flattenSchemaNodes(structuredData) {
  const nodes = [];
  const visit = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 4) return;
    if (Array.isArray(node)) { node.forEach((n) => visit(n, depth + 1)); return; }
    if (node['@graph']) visit(node['@graph'], depth + 1);
    if (node['@type'] || node.aggregateRating) nodes.push(node);
  };
  visit(structuredData);
  return nodes;
}

function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  return null;
}
function toCount(v) {
  const n = toNumber(v);
  return n !== null && Number.isInteger(n) && n >= 1 && n <= RATING_LIMITS.maxCount ? n : null;
}

/**
 * Canonical rating from crawler / schema data, or null when it isn't a usable
 * AggregateRating: needs a ratingValue inside its scale and at least one real
 * count. bestRating defaults to 5 only for values read out of schema (the
 * Schema.org default); crawler candidates always carry an explicit scale.
 */
export function sanitizeRating(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ratingValue = toNumber(raw.ratingValue);
  const bestRating = raw.bestRating == null ? 5 : toNumber(raw.bestRating);
  const worstRating = raw.worstRating == null ? undefined : toNumber(raw.worstRating);
  const reviewCount = raw.reviewCount == null ? undefined : toCount(raw.reviewCount);
  const ratingCount = raw.ratingCount == null ? undefined : toCount(raw.ratingCount);

  if (ratingValue === null || bestRating === null || bestRating <= 0) return null;
  if (worstRating === null) return null;
  if (worstRating !== undefined && (worstRating >= bestRating || ratingValue < worstRating)) return null;
  if (ratingValue <= 0 || ratingValue > bestRating) return null;
  if (raw.reviewCount != null && reviewCount === null) return null;
  if (raw.ratingCount != null && ratingCount === null) return null;
  if (reviewCount === undefined && ratingCount === undefined) return null;

  const rating = { ratingValue, bestRating };
  if (worstRating !== undefined) rating.worstRating = worstRating;
  if (reviewCount !== undefined) rating.reviewCount = reviewCount;
  if (ratingCount !== undefined) rating.ratingCount = ratingCount;
  return rating;
}

/** Same figures (value, scale, counts). Exact numeric equality — a rating is a fact, not a text. */
export function ratingsEqual(a, b) {
  const x = sanitizeRating(a);
  const y = sanitizeRating(b);
  if (!x || !y) return false;
  return x.ratingValue === y.ratingValue && x.bestRating === y.bestRating &&
    (x.worstRating ?? undefined) === (y.worstRating ?? undefined) &&
    (x.reviewCount ?? undefined) === (y.reviewCount ?? undefined) &&
    (x.ratingCount ?? undefined) === (y.ratingCount ?? undefined);
}

const fmt = (n) => String(n);

/** The AggregateRating object as it appears in JSON-LD (string values, as in Schema.org's own examples). */
export function buildAggregateRatingObject(rating) {
  const r = sanitizeRating(rating);
  if (!r) return null;
  const out = { '@type': 'AggregateRating', ratingValue: fmt(r.ratingValue) };
  if (r.reviewCount !== undefined) out.reviewCount = fmt(r.reviewCount);
  if (r.ratingCount !== undefined) out.ratingCount = fmt(r.ratingCount);
  out.bestRating = fmt(r.bestRating);
  if (r.worstRating !== undefined) out.worstRating = fmt(r.worstRating);
  return out;
}

/**
 * JSON-LD node attaching the rating to an EXISTING entity. type/id/name are the
 * existing node's own values, copied verbatim.
 * @param {{type: string|string[], id: string, name: string}} target
 */
export function buildAggregateRatingNode({ target, rating }) {
  const aggregateRating = buildAggregateRatingObject(rating);
  if (!target || !isAbsoluteId(target.id) || typeof target.name !== 'string' || !target.name.trim() || !target.type || !aggregateRating) return null;
  return {
    '@context': 'https://schema.org',
    '@type': target.type,
    '@id': target.id,
    name: target.name,
    aggregateRating,
  };
}

export function serializeAggregateRatingJsonLd(input) {
  const node = buildAggregateRatingNode(input);
  return node ? JSON.stringify(node, null, 2) : null;
}

/**
 * Strict inverse of serialize: {target:{type,id,name}, rating} from a stored
 * JSON-LD string/object, or null when it is not a well-formed rating node.
 */
export function parseAggregateRatingJsonLd(input) {
  let node = input;
  if (typeof input === 'string') {
    try { node = JSON.parse(input); } catch { return null; }
  }
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  const type = node['@type'];
  const typeOk = (typeof type === 'string' && type) || (Array.isArray(type) && type.length > 0 && type.every((t) => typeof t === 'string' && t));
  if (!typeOk || !isAbsoluteId(node['@id']) || typeof node.name !== 'string' || !node.name.trim()) return null;
  const ar = Array.isArray(node.aggregateRating) ? null : node.aggregateRating;
  if (!ar || asArray(ar['@type'])[0] !== 'AggregateRating') return null;
  const rating = sanitizeRating(ar);
  return rating ? { target: { type, id: node['@id'], name: node.name.trim() }, rating } : null;
}

/** Every AggregateRating the crawled page exposes: on any node's aggregateRating, or as a standalone AggregateRating node. */
export function extractAggregateRatings(structuredData) {
  const items = [];
  for (const node of flattenSchemaNodes(structuredData)) {
    const ownTypes = typesOf(node);
    if (ownTypes.includes('AggregateRating')) {
      const rating = sanitizeRating(node);
      items.push({ nodeTypes: ownTypes, nodeId: null, name: null, rating, valid: !!rating, standalone: true });
    }
    if (node.aggregateRating) {
      for (const ar of asArray(node.aggregateRating)) {
        const rating = sanitizeRating(ar);
        items.push({ nodeTypes: ownTypes, nodeId: typeof node['@id'] === 'string' ? node['@id'] : null, name: typeof node.name === 'string' ? node.name : null, rating, valid: !!rating, standalone: false });
      }
    }
  }
  return items;
}

/** True when the crawled page carries a valid AggregateRating on the target entity that equals `expected.rating`. */
export function crawledRatingMatches(expected, structuredData) {
  if (!expected?.target?.id || !expected.rating) return false;
  return extractAggregateRatings(structuredData).some(
    (item) => item.valid && item.nodeId === expected.target.id && ratingsEqual(item.rating, expected.rating)
  );
}

/** True when `rating` is one of the rating figures the crawler saw displayed on the page. */
export function ratingIsVisible(rating, candidates) {
  return asArray(candidates).some((c) => ratingsEqual(c, rating));
}

/** Short hash of a {target, rating} — keys a recommendation to the exact data it was built from. */
export function hashAggregateRating({ target, rating }) {
  const r = sanitizeRating(rating);
  return crypto.createHash('sha256').update(JSON.stringify({ id: target?.id, type: target?.type, name: target?.name, r })).digest('hex').slice(0, 16);
}

function rankOf(node) {
  const types = typesOf(node);
  let best = null;
  for (const group of TARGET_RANKS) {
    if (types.some((t) => group.types.includes(t)) && (best === null || group.rank < best.rank)) best = group;
  }
  return best;
}

/** Existing schema entities on the page, summarised for display. */
export function summarizeSchemas(nodes) {
  return nodes.slice(0, 25).map((node) => {
    const group = rankOf(node);
    return {
      types: typesOf(node),
      id: typeof node['@id'] === 'string' ? node['@id'] : null,
      name: typeof node.name === 'string' ? node.name : null,
      hasAggregateRating: !!node.aggregateRating,
      eligibleTarget: !!group,
      targetKind: group?.kind ?? null,
    };
  });
}

/**
 * Which existing entity the rating attaches to: the best-ranked eligible node
 * that has both an absolute @id (so the merge is well-defined) and a name.
 * @returns {{status: 'ok'|'no_target_schema'|'target_not_mergeable', target?: object, kind?: string}}
 */
export function pickTargetSchema(nodes) {
  const eligible = nodes
    .map((node, index) => ({ node, index, group: rankOf(node) }))
    .filter((e) => e.group)
    .sort((a, b) => a.group.rank - b.group.rank || a.index - b.index);
  if (eligible.length === 0) return { status: 'no_target_schema' };
  const usable = eligible.find((e) => isAbsoluteId(e.node['@id']) && typeof e.node.name === 'string' && e.node.name.trim() && e.node.name.length <= RATING_LIMITS.maxNameLength);
  if (!usable) return { status: 'target_not_mergeable' };
  const rawType = usable.node['@type'];
  return {
    status: 'ok',
    kind: usable.group.kind,
    target: { type: rawType, types: typesOf(usable.node), id: usable.node['@id'], name: usable.node.name.trim() },
  };
}

const STATUS_MESSAGES = {
  rating_unavailable: RATING_UNAVAILABLE_MESSAGE,
  rating_ambiguous: 'This page shows more than one different rating, so it is unclear which one to mark up. No AggregateRating schema will be generated.',
  no_target_schema: 'No Product, Service, LocalBusiness or Organization schema exists on this page to attach the rating to. Add one first — the rating cannot be added as an unrelated new entity.',
  target_not_mergeable: 'A Product, Service, LocalBusiness or Organization schema exists on this page, but it has no absolute @id and name, so the rating cannot be merged into it safely.',
  already_present: 'This page already has AggregateRating markup.',
};

/**
 * Everything the UI, the recommendation service and the apply flow need to know
 * about a page's AggregateRating situation.
 *
 * status: 'ready' | 'rating_unavailable' | 'rating_ambiguous' | 'no_target_schema'
 *       | 'target_not_mergeable' | 'already_present'
 * @param {{pageData?: object, issueDoc?: object}} input
 */
export function getRatingDetection({ pageData } = {}) {
  const signals = pageData?.rating_signals || {};
  const extractionRan = signals.rating_extracted === true;

  // ── Existing schema ────────────────────────────────────────────────────
  const nodes = flattenSchemaNodes(pageData?.structured_data);
  const existingSchemas = summarizeSchemas(nodes);
  const existingRatings = extractAggregateRatings(pageData?.structured_data);
  const micro = signals.microdata_aggregate_rating || null;
  const existingAggregateRating = existingRatings.length > 0
    ? { present: true, valid: existingRatings.some((r) => r.valid), source: 'json-ld', count: existingRatings.length }
    : micro
      ? { present: true, valid: !!sanitizeRating({ ...micro, bestRating: micro.bestRating ?? undefined }), source: 'microdata', count: 1 }
      : { present: false, valid: false, source: null, count: 0 };

  // ── Rating figures shown on the page ───────────────────────────────────
  const candidates = [];
  const seen = new Set();
  for (const raw of asArray(signals.rating_candidates)) {
    const rating = sanitizeRating(raw);
    if (!rating) continue;
    const key = JSON.stringify(rating);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ ...rating, source: typeof raw.source === 'string' ? raw.source : 'text', evidence: typeof raw.evidence === 'string' ? raw.evidence.replace(/\s+/g, ' ').trim().slice(0, 300) : null });
  }
  let ratingStatus;
  let ratingReason = null;
  if (candidates.length === 1) ratingStatus = 'extracted';
  else if (candidates.length > 1) ratingStatus = 'ambiguous';
  else { ratingStatus = 'unavailable'; ratingReason = extractionRan ? 'no_reliable_rating' : 'crawl_predates_extraction'; }
  const selected = ratingStatus === 'extracted' ? candidates[0] : null;

  // ── Target entity ───────────────────────────────────────────────────────
  const picked = pickTargetSchema(nodes.filter((n) => !n.aggregateRating));

  // ── Overall status ──────────────────────────────────────────────────────
  let status;
  if (existingAggregateRating.present) status = 'already_present';
  else if (ratingStatus === 'unavailable') status = 'rating_unavailable';
  else if (ratingStatus === 'ambiguous') status = 'rating_ambiguous';
  else if (picked.status !== 'ok') status = picked.status;
  else status = 'ready';

  const target = picked.status === 'ok' ? picked.target : null;
  const generatedNode = status === 'ready'
    ? buildAggregateRatingNode({ target: { type: target.type, id: target.id, name: target.name }, rating: selected })
    : null;

  const missingSchemaFields = [];
  if (!selected) missingSchemaFields.push('ratingValue', 'reviewCount');
  if (!existingAggregateRating.present) missingSchemaFields.push('aggregateRating');
  if (!target && !existingAggregateRating.present) missingSchemaFields.push('targetSchema');

  const warnings = [];
  if (status === 'ready' && (picked.kind === 'organization' || picked.kind === 'local_business')) warnings.push('self_serving_target');
  if (status === 'ready' && !selected?.evidence) warnings.push('no_evidence_text');

  return {
    status,
    canGenerate: status === 'ready' && !!generatedNode,
    message: STATUS_MESSAGES[status] || null,
    reason: status === 'rating_unavailable' ? ratingReason : null,
    warnings,
    detectedRatingData: { status: ratingStatus, reason: ratingReason, selected, candidates },
    existingSchemas,
    existingAggregateRating,
    targetSchemaType: target ? (typesOf({ '@type': target.type })[0] || null) : null,
    target: target ? { types: target.types, id: target.id, name: target.name, kind: picked.kind } : null,
    missingSchemaFields,
    generatedSchema: generatedNode ? { format: 'json-ld', jsonLd: JSON.stringify(generatedNode, null, 2), mergeMode: 'same_id_node' } : null,
  };
}

export default {
  RATING_LIMITS,
  RATING_UNAVAILABLE_MESSAGE,
  flattenSchemaNodes,
  sanitizeRating,
  ratingsEqual,
  buildAggregateRatingObject,
  buildAggregateRatingNode,
  serializeAggregateRatingJsonLd,
  parseAggregateRatingJsonLd,
  extractAggregateRatings,
  crawledRatingMatches,
  ratingIsVisible,
  hashAggregateRating,
  summarizeSchemas,
  pickTargetSchema,
  getRatingDetection,
};
