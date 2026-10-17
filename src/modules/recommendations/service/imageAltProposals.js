import { classifyImageUrl } from '../../external_integration/mediaFix/imageResource.js';
import { normalizeAlt, validateProposedAlt } from '../../external_integration/mediaFix/altText.js';

/**
 * Structured per-image alt-text proposals for `images_missing_alt_text`.
 *
 * The recommendation used to carry its alt texts only inside one block of prose ("Image 1 (…): alt=…"), which nothing downstream
 * could map back to a specific image. The same generation call now also returns `imageAlts` — one entry per image, keyed by the
 * image's EXACT URL — and this module is the only place that turns that model output into stored data:
 *
 *   - an entry is kept only if its `src` is exactly one of the images Odito listed in the prompt (never an invented or "similar" URL);
 *   - a tracker is never an entry, and a repeated src keeps the first;
 *   - the text must itself be publishable (altText.validateProposedAlt); otherwise the entry stays but with `alt: null`, so the
 *     person is asked for a description instead of being handed text that could not be written;
 *   - nothing about identity is taken from the model: no attachment id, no finding id, no confidence. Those are derived at READ time
 *     by the WordPress fix service from the crawl's own evidence (mediaFix/altRecommendation.js).
 */

export const MAX_ALT_IMAGES = 10;
export const MAX_BASIS = 200;

/** The exact image URLs an alt recommendation is asked to cover (what the prompt lists and what `imageAlts` may refer to). */
export function altImagesFromContext(recommendationContext) {
  const rows = recommendationContext?.currentState?.tableRows;
  if (!Array.isArray(rows)) return [];
  const seen = new Set(); const out = [];
  for (const row of rows) {
    const src = typeof row?.Image === 'string' ? row.Image.trim() : '';
    if (!src || seen.has(src)) continue;
    if (!classifyImageUrl(src).actionable) continue;
    seen.add(src); out.push(src);
    if (out.length >= MAX_ALT_IMAGES) break;
  }
  return out;
}

const cleanBasis = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, MAX_BASIS) : '');

/**
 * @param {unknown} raw          the model's `imageAlts`
 * @param {string[]} allowedSrcs exact URLs the prompt listed
 * @returns {{src: string, alt: string|null, basis: string, rejected: string|null}[]}
 */
export function normalizeImageAltProposals(raw, allowedSrcs) {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set(allowedSrcs || []);
  const seen = new Set(); const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const src = typeof item.src === 'string' ? item.src.trim() : '';
    if (!src || !allowed.has(src) || seen.has(src)) continue;
    seen.add(src);
    const text = typeof item.alt === 'string' ? normalizeAlt(item.alt) : '';
    if (!text) { out.push({ src, alt: null, basis: cleanBasis(item.basis), rejected: null }); continue; }
    const check = validateProposedAlt(text);
    out.push({ src, alt: check.ok ? check.value : null, basis: cleanBasis(item.basis), rejected: check.ok ? null : check.errors[0] });
  }
  return out;
}

export default { MAX_ALT_IMAGES, altImagesFromContext, normalizeImageAltProposals };
