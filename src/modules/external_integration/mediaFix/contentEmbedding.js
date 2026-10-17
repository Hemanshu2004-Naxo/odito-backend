/**
 * contentEmbedding — does the PAGE'S OWN CONTENT carry this image's alt text, or is it read from the media library?
 *
 * This decides whether changing an attachment's alt text can change what the page renders. WordPress copies the media-library
 * alt into an image's markup only when the image is INSERTED; after that, the <img alt="…"> (or the image block's alt attribute)
 * inside the post content is what is rendered, and later edits to the library alt do not reach it. Images the theme renders
 * itself (featured image, galleries, widgets, listings) do read the library alt.
 *
 *   embedded           an <img> (or an image/gallery/cover block) in the content references this attachment: a library write would
 *                      NOT change the page — the fix is unsupported for this image and says so
 *   builder_reference  the content mentions the file without an <img> (a page-builder shortcode): whether the builder uses the
 *                      library alt is unknown, so a write is allowed but flagged, and the rendered check decides
 *   not_in_content     the content does not mention it: it is rendered from elsewhere (the library alt is what is used)
 *   unknown            the content could not be read
 *
 * Pure: takes the raw content string.
 */

const IMG_TAG = /<img\b[^>]*>/gi;
const BLOCK = /<!--\s*wp:(image|cover|gallery|media-text)\b([\s\S]*?)-->/gi;
const CLASS_ID = /\bclass\s*=\s*(?:"[^"]*|'[^']*)\bwp-image-(\d+)\b/i;
const ALT_ATTR = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

function blockMentions(attrsJson, attachmentId) {
  const id = Number(attachmentId);
  try {
    const attrs = JSON.parse(attrsJson.trim() || '{}');
    if (Number(attrs.id) === id) return true;
    if (Array.isArray(attrs.ids) && attrs.ids.some((n) => Number(n) === id)) return true;
  } catch { /* not JSON: ignore */ }
  return false;
}

export function inspectContentEmbedding(raw, { attachmentId, exactPaths }) {
  if (typeof raw !== 'string') return { status: 'unknown' };
  const files = [...(exactPaths || [])].filter(Boolean);
  const mentionsFile = (text) => files.some((f) => text.includes(f));

  const imgs = [];
  for (const m of raw.matchAll(IMG_TAG)) {
    const tag = m[0];
    const classId = CLASS_ID.exec(tag);
    const byClass = classId && Number(classId[1]) === Number(attachmentId);
    if (!byClass && !mentionsFile(tag)) continue;
    const alt = ALT_ATTR.exec(tag);
    imgs.push({ hasAltAttr: !!alt, altValue: alt ? (alt[1] ?? alt[2] ?? '') : null });
  }
  let block = false;
  for (const m of raw.matchAll(BLOCK)) { if (blockMentions(m[2], attachmentId)) { block = true; break; } }

  if (imgs.length || block) {
    return { status: 'embedded', kind: imgs.length ? 'img_tag' : 'block', occurrences: imgs.length || 1, embeddedAlt: imgs[0]?.altValue ?? null, hasAltAttr: imgs[0]?.hasAltAttr ?? null };
  }
  if (mentionsFile(raw)) return { status: 'builder_reference' };
  return { status: 'not_in_content' };
}

export default { inspectContentEmbedding };
