/**
 * altRecommendation — reuses the alt text the AI recommendation already produced for a page, one image at a time.
 *
 * WHAT IS REUSED: the recommendation made for this page + `images_missing_alt_text` (the existing recommendation service; nothing is
 * generated here). Since per-image proposals exist (recommendations/service/imageAltProposals.js) each entry is keyed by the image's
 * EXACT URL; an older, text-only recommendation is read by a transitional parser that never guesses.
 *
 * HOW AN IMAGE IS MATCHED (never fuzzy):
 *   exact_src         the image's src (or its lazy/srcset URL) equals a proposal's src            -> may fill the text box
 *   legacy_position  "Image N (…): alt=…" in old prose, accepted ONLY when the numbering is 1..K with no gaps and K equals the number of
 *                     empty-alt images the page had — then entry N is image N. Offered as a suggestion that must be confirmed, never filled.
 *   anything else     no mapping: the person is told and asked for a description.
 *
 * WHAT THE MODEL NEVER DECIDES: identity (attachment, finding), evidence, confidence. Those are computed here from the crawl's own
 * facts. A proposal is always `needs_review`: Odito cannot see the picture, so a person approves the exact text before any write.
 *
 * Read-only: nothing in this module writes to WordPress or to the recommendation.
 */

import { normalizeAlt, validateProposedAlt } from './altText.js';
import { classifyImageUrl } from './imageResource.js';
import { observedUrlsOf } from './imageIdentity.js';

export const ALT_RULE_ID = 'images_missing_alt_text';

export const REC_STATUS = Object.freeze({
  AVAILABLE: 'available',                  // an exact-match proposal the person can edit and approve
  SUGGESTED_BY_POSITION: 'suggested_by_position', // legacy text mapped by position: confirm before using
  NOT_PROVIDED: 'not_provided',            // the recommendation had nothing usable for this image
  NOT_PUBLISHABLE: 'not_publishable',      // the proposal exists but could not be published as written
  NO_MATCH: 'no_match',                    // a structured recommendation exists but does not cover this image
  AMBIGUOUS_LEGACY: 'ambiguous_legacy',    // old text-only recommendation that cannot be mapped to images safely
  NONE: 'none',                            // no recommendation for this page at all
  UNAVAILABLE: 'unavailable',              // the recommendation could not be read right now
});

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'your', 'our', 'client', 'testimonial', 'testimonials', 'image', 'photo', 'picture', 'logo', 'hero', 'webp', 'jpeg', 'jpg', 'png', 'avif', 'old', 'new', 'scaled']);

const tokens = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w));

/** The file name of the image without folders, extension, size suffix (-768x512), -scaled or edit suffix, as readable words. */
export function fileNameStem(src) {
  let name = '';
  try { name = decodeURIComponent(new URL(src).pathname.split('/').pop() || ''); } catch { name = String(src || '').split('/').pop() || ''; }
  return name.replace(/\.[a-z0-9]+$/i, '').replace(/-\d+x\d+$/, '').replace(/-scaled$/, '').replace(/-e\d{10,}$/, '');
}

/**
 * The facts about THIS image that a proposal can be checked against, and how well the proposal agrees with them. Computed here from
 * the crawl's own data; the model's own claims ("basis") are shown to the person but never used to raise confidence.
 *   medium  the text shares a meaningful word with the image's file name, caption or link text
 *   low     nothing the site published about this image supports the text
 */
export function evidenceFor(snapshot, alt) {
  const facts = [];
  const stem = fileNameStem(snapshot?.src || snapshot?.imageUrl);
  if (stem) facts.push({ kind: 'file_name', text: stem, label: `The image file is named “${stem}”.` });
  if (snapshot?.figcaption) facts.push({ kind: 'caption', text: snapshot.figcaption, label: `The caption on the page reads “${snapshot.figcaption}”.` });
  if (snapshot?.linkTitle) facts.push({ kind: 'link_title', text: snapshot.linkTitle, label: `The link around the image is titled “${snapshot.linkTitle}”.` });
  if (snapshot?.linkText) facts.push({ kind: 'link_text', text: snapshot.linkText, label: `The link around the image reads “${snapshot.linkText}”.` });
  if (snapshot?.wpAttachmentId != null) facts.push({ kind: 'attachment_class', text: '', label: `The page marks the image as WordPress attachment ${Number(snapshot.wpAttachmentId)}.` });

  const mine = new Set(tokens(alt));
  const supported = facts.filter((f) => tokens(f.text).some((t) => mine.has(t)));
  return {
    evidence: facts.map((f) => f.label),
    supportedBy: supported.map((f) => f.kind),
    confidence: supported.length > 0 ? 'medium' : 'low',
  };
}

// ── legacy, text-only recommendations ───────────────────────────────────────

const LEGACY_ENTRY = /Image\s+(\d+)\s*(?:\(([^)]*)\))?\s*:\s*alt\s*=\s*"([^"]*)"/gi;

/** `Image 3 (David Peterson): alt="…"` entries, in the order they appear. */
export function parseLegacyAltText(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  for (const m of text.matchAll(LEGACY_ENTRY)) out.push({ n: Number(m[1]), label: (m[2] || '').trim(), alt: normalizeAlt(m[3]) });
  return out;
}

/**
 * Entry N is image N only when the numbering is exactly 1..K and K equals the number of images the old recommendation was written
 * for (the page's empty-alt images, in page order). Otherwise null: the mapping is ambiguous and nothing is offered.
 */
export function mapLegacyByPosition(entries, orderedSrcs) {
  if (!entries.length || !orderedSrcs.length || entries.length !== orderedSrcs.length) return null;
  const sorted = [...entries].sort((a, b) => a.n - b.n);
  if (!sorted.every((e, i) => e.n === i + 1)) return null;
  return new Map(sorted.map((e, i) => [orderedSrcs[i], e]));
}

// ── the source recommendation ───────────────────────────────────────────────

/**
 * The recommendation to reuse for a task: the newest valid one for this project + page + issue that carries structured proposals;
 * else the task's own linked recommendation (or the newest one) for the legacy parser. Never throws: a recommendation that cannot be
 * read is "unavailable", not a failed preview.
 */
export async function loadRecommendationSource(task, { Recommendation }) {
  const base = { projectId: task.projectId, ruleId: ALT_RULE_ID, invalidatedAt: null };
  const docs = await Recommendation.find({ ...base, pageUrl: task.pageUrl }).sort({ updatedAt: -1 }).limit(8).lean();
  let doc = docs.find((d) => Array.isArray(d.sections?.imageAltProposals)) || null;
  if (!doc && task.recommendationId) {
    const linked = await Recommendation.findOne({ _id: task.recommendationId, projectId: task.projectId, ruleId: ALT_RULE_ID, invalidatedAt: null }).lean();
    if (linked) doc = linked;
  }
  if (!doc) doc = docs[0] || null;
  if (!doc) return { found: false };
  return {
    found: true,
    recommendationId: String(doc._id),
    generatedAt: doc.updatedAt || doc.createdAt || null,
    proposals: Array.isArray(doc.sections?.imageAltProposals) ? doc.sections.imageAltProposals : null, // null = a legacy, text-only recommendation
    legacyText: doc.sections?.recommendedVersion || '',
  };
}

const matches = (snapshot, src) => observedUrlsOf(snapshot).includes(src);

/**
 * @param {object} p
 * @param {object} p.snapshot      the finding's before_snapshot
 * @param {object} p.source        loadRecommendationSource() result
 * @param {string[]} [p.orderedSrcs] the page's empty-alt images in page order (only needed for a legacy recommendation)
 */
export function recommendationForImage({ snapshot, source, orderedSrcs = [] }) {
  const base = { reviewStatus: 'needs_review', recommendationId: source?.recommendationId || null, generatedAt: source?.generatedAt || null };
  const empty = (status, message) => ({ ...base, status, alt: null, basis: null, match: null, needsConfirmation: false, confidence: null, evidence: [], message });

  if (!classifyImageUrl(snapshot?.src || snapshot?.imageUrl).actionable) return empty(REC_STATUS.NONE, null); // a tracker never has one
  if (!source) return empty(REC_STATUS.UNAVAILABLE, 'The AI recommendation could not be read right now. Write the description yourself, or try again.');
  if (!source.found) return empty(REC_STATUS.NONE, 'There is no AI recommendation for this page yet. Generate it above to get a suggested alt text, or write the description yourself.');

  // Structured proposals: exact URL only.
  if (source.proposals) {
    const p = source.proposals.find((x) => x && typeof x.src === 'string' && matches(snapshot, x.src));
    if (!p) return empty(REC_STATUS.NO_MATCH, 'The AI recommendation does not cover this image (it may have been added after it was written). Regenerate the recommendation, or write the description yourself.');
    if (!p.alt) {
      return { ...empty(REC_STATUS.NOT_PROVIDED, p.rejected ? `The AI suggestion for this image could not be used (${p.rejected}). Write the description yourself.` : 'The AI recommendation found nothing in the page to describe this image from. Write the description yourself.'), basis: p.basis || null };
    }
    return withText(base, snapshot, p.alt, p.basis, 'exact_src', false, REC_STATUS.AVAILABLE);
  }

  // Legacy prose: positional, only when unambiguous, and always to be confirmed.
  const entries = parseLegacyAltText(source.legacyText);
  const mapped = mapLegacyByPosition(entries, orderedSrcs);
  if (!entries.length || !mapped) {
    return empty(REC_STATUS.AMBIGUOUS_LEGACY, 'The existing AI recommendation is plain text and cannot be matched to this image with certainty. Regenerate the recommendation to get per-image suggestions, or write the description yourself.');
  }
  const hit = [...mapped.entries()].find(([src]) => matches(snapshot, src));
  if (!hit || !hit[1].alt) return empty(REC_STATUS.NO_MATCH, 'The existing AI recommendation has no usable text for this image. Write the description yourself.');
  return withText(base, snapshot, hit[1].alt, hit[1].label ? `Earlier recommendation, entry “${hit[1].label}”` : 'Earlier recommendation', 'legacy_position', true, REC_STATUS.SUGGESTED_BY_POSITION);
}

function withText(base, snapshot, alt, basis, match, needsConfirmation, status) {
  const check = validateProposedAlt(alt);
  if (!check.ok) {
    return { ...base, status: REC_STATUS.NOT_PUBLISHABLE, alt: null, basis: basis || null, match, needsConfirmation: false, confidence: null, evidence: [], message: `The AI suggestion could not be used as written: ${check.errors[0]} Write the description yourself.` };
  }
  const ev = evidenceFor(snapshot, check.value);
  return {
    ...base, status, alt: check.value, basis: basis || null, match, needsConfirmation,
    confidence: ev.confidence, evidence: ev.evidence, supportedBy: ev.supportedBy,
    validation: { warnings: check.warnings },
    message: needsConfirmation
      ? 'Taken from the earlier text-only recommendation and matched by position. Check that it describes THIS image before using it.'
      : 'Suggested by the AI recommendation from the page and file name — it cannot see the picture. Review and edit it before approving.',
  };
}

/**
 * Where the approved text came from, decided on the server by comparing it with the recommendation (never trusted from the client):
 * the exact AI text, the AI text edited by the person, or text the person wrote.
 */
export function provenanceOf(approvedAlt, rec) {
  const aiText = rec && ['available', 'suggested_by_position'].includes(rec.status) ? rec.alt : null;
  if (!aiText) return 'human_input';
  return normalizeAlt(approvedAlt) === normalizeAlt(aiText) ? 'ai_recommendation' : 'ai_recommendation_edited';
}

/** The page's empty-alt images in page order — the order an older text-only recommendation numbered them in. */
export function orderedEmptyAltSrcs(pageDoc) {
  const images = Array.isArray(pageDoc?.images) ? pageDoc.images : [];
  return images.filter((img) => !img?.alt || !String(img.alt).trim()).map((img) => img.src || img.url).filter((s) => typeof s === 'string' && s);
}

export default { REC_STATUS, evidenceFor, fileNameStem, parseLegacyAltText, mapLegacyByPosition, loadRecommendationSource, recommendationForImage, provenanceOf, orderedEmptyAltSrcs };
