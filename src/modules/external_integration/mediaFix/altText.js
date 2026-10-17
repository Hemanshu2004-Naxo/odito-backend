/**
 * altText — what may be written as alt text, and how a finding's own evidence is turned into SUGGESTIONS.
 *
 * Odito has no image-recognition step: it cannot see a picture, so it never describes one. The text to publish is written (or
 * confirmed) by a person; the only help Odito gives is surfacing text the site ALREADY published about the same image (its
 * caption, the title of the link around it, the media-library caption) — each labelled with its source and never applied on its own.
 */

export const ALT_RECOMMENDED_MAX = 125;
export const ALT_HARD_MAX = 250;

const FILE_NAME_LIKE = /\.(jpe?g|png|gif|webp|avif|svg|bmp|tiff?)(\b|$)/i;
const GENERIC = new Set(['image', 'img', 'photo', 'picture', 'pic', 'graphic', 'untitled', 'banner', 'logo', 'icon', 'thumbnail', 'screenshot']);
const LEADING_FILLER = /^(an? )?(image|picture|photo|photograph|graphic)( of| showing)\b/i;
const STOP = new Set(['a', 'an', 'the', 'of', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'is']);

export const normalizeAlt = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

/**
 * @returns {{ok: boolean, value: string, errors: string[], warnings: string[]}}
 *   Errors block the fix; warnings are shown to the person who approves it.
 */
export function validateProposedAlt(input) {
  const errors = []; const warnings = [];
  const value = normalizeAlt(input);

  if (typeof input !== 'string' || !value) return { ok: false, value: '', errors: ['Alt text is required for an informative image.'], warnings };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(input.replace(/[\n\r\t]/g, ' '))) errors.push('Alt text cannot contain control characters.');
  if (/[<>]/.test(value)) errors.push('Alt text must be plain text — no HTML.');
  if (value.length > ALT_HARD_MAX) errors.push(`Alt text is ${value.length} characters; the limit is ${ALT_HARD_MAX}. Shorten it (it is never truncated for you).`);
  else if (value.length > ALT_RECOMMENDED_MAX) warnings.push(`Alt text is ${value.length} characters; under ${ALT_RECOMMENDED_MAX} reads best with screen readers.`);
  if (FILE_NAME_LIKE.test(value)) errors.push('Alt text looks like a file name. Describe what the image shows.');
  if (/^https?:\/\//i.test(value)) errors.push('Alt text cannot be a URL.');

  const words = value.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter(Boolean);
  if (words.length && words.every((w) => GENERIC.has(w))) errors.push('Alt text is too generic ("image", "photo", …). Describe what the image shows.');

  // Keyword stuffing: one content word repeated, or most of the text being repeats.
  const content = words.filter((w) => !STOP.has(w) && w.length > 2);
  const counts = new Map();
  for (const w of content) counts.set(w, (counts.get(w) || 0) + 1);
  const repeats = [...counts.values()].reduce((sum, n) => sum + Math.max(0, n - 1), 0);
  if ([...counts.values()].some((n) => n >= 4) || (content.length >= 6 && repeats / content.length > 0.4)) {
    errors.push('Alt text repeats the same words (keyword stuffing). Write one natural description.');
  }
  if (LEADING_FILLER.test(value)) warnings.push('Starting with "image of" / "photo of" is usually redundant: screen readers already announce an image.');
  if (value.endsWith('.') === false && value.split(' ').length > 14) warnings.push('A long description is easier to read as a sentence ending in a full stop.');

  return { ok: errors.length === 0, value, errors, warnings };
}

const plain = (html) => normalizeAlt(String(html || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;/g, "'").replace(/&nbsp;/g, ' '));

/**
 * Text the site already published about THIS image, with its source. Never used automatically; each is shown to the person,
 * who may adopt, edit or ignore it. File names and the media title (usually the file name) are deliberately not suggested.
 */
export function suggestionsFromEvidence(snapshot, media) {
  const candidates = [
    { source: 'figcaption', label: 'The caption shown under the image on the page', text: snapshot?.figcaption },
    { source: 'link_title', label: "The title of the link around the image", text: snapshot?.linkTitle },
    { source: 'link_text', label: 'The text of the link around the image', text: snapshot?.linkText },
    { source: 'media_caption', label: 'The caption stored in the WordPress media library', text: plain(media?.caption?.rendered ?? media?.caption?.raw ?? media?.caption) },
  ];
  const seen = new Set(); const out = [];
  for (const c of candidates) {
    const text = normalizeAlt(c.text);
    if (!text || seen.has(text.toLowerCase())) continue;
    if (!validateProposedAlt(text).ok) continue; // a suggestion must itself be publishable
    seen.add(text.toLowerCase());
    out.push({ source: c.source, label: c.label, text });
  }
  return out;
}

/**
 * Why an image is decorative ON ITS OWN EVIDENCE — or null. Mirror of the crawler's decorative_by_evidence (python image_classifier.py).
 *
 * An empty alt attribute ALONE is not evidence: a theme or page builder prints alt="" whenever its field is blank, which is a missing
 * description, not an author's choice. Only these count:
 *   explicit   role="presentation"/"none" or aria-hidden="true" — the author removed the image from the accessibility tree
 *   named_link alt="" on an image inside a link that already has its own name (text, title or aria-label) — the standard pattern
 * An image that is the ONLY content of an unnamed link is never decorative: with no alt the link has no accessible name.
 */
export function decorativeEvidence(snapshot) {
  const linkName = normalizeAlt(snapshot?.linkLabel || snapshot?.linkTitle || snapshot?.linkText);
  if (snapshot?.inLink && !linkName) return null;
  if (snapshot?.ariaHidden) return { code: 'explicit', signal: 'The image is marked aria-hidden="true".' };
  if (['presentation', 'none'].includes(snapshot?.role)) return { code: 'explicit', signal: `The image has role="${snapshot.role}".` };
  if (snapshot?.altState === 'empty' && snapshot?.inLink) return { code: 'named_link', signal: 'The image sits inside a link that already has its own name, so alt="" is correct here.' };
  return null;
}

/**
 * What the finding says the image is.
 *   decorative  explicit evidence (see decorativeEvidence) — not "alt is empty"
 *   ambiguous   alt="" and nothing in the markup says whether that was deliberate: a person decides
 *   informative no alt attribute (or blank) — a description is needed
 *   unknown     crawled before the crawler recorded missing-vs-empty
 */
export function classifyImage(snapshot) {
  const altState = snapshot?.altState || 'unknown';
  const evidence = decorativeEvidence(snapshot);
  const signals = evidence ? [evidence.signal] : [];
  const decorative = !!evidence;
  const kind = decorative ? 'decorative' : altState === 'unknown' ? 'unknown' : altState === 'empty' ? 'ambiguous' : 'informative';
  return { altState, decorative, kind, signals, decorativeBasis: evidence?.code || null };
}

export default { validateProposedAlt, suggestionsFromEvidence, classifyImage, decorativeEvidence, normalizeAlt, ALT_RECOMMENDED_MAX, ALT_HARD_MAX };
