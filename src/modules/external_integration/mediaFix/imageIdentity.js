/**
 * imageIdentity — decides WHICH WordPress media attachment an observed page image is. Pure (no I/O).
 *
 * The rule that makes a write safe: an observed image is an attachment only when one of its observed URLs EXACTLY equals one
 * of that attachment's own files — the full upload path (year/month folder and exact file name, including a size suffix such
 * as -768x512) of the original, a generated size, or the scaled copy. Never a file-name search hit, never "looks similar", never a
 * position on the page. A `wp-image-<id>` class is only a hint that tells us which attachment to CHECK; the URL still has to agree.
 *
 * Outcomes: resolved | ambiguous_target | unsupported (with a code that says exactly what evidence is missing).
 */

import { KIND, UNSUPPORTED_REASON, classifySnapshot } from './imageResource.js';

const UPLOADS = /\/wp-content\/uploads\/(.+)$/i;

export const hostKey = (url) => {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
};

/** The path below wp-content/uploads (multisite `sites/<n>/` removed), decoded, without query or fragment — or null. */
export function uploadsPath(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  let pathname = u.pathname;
  try { pathname = decodeURIComponent(pathname); } catch { /* keep as is */ }
  const m = UPLOADS.exec(pathname);
  if (!m) return null;
  return m[1].replace(/\/{2,}/g, '/').replace(/^sites\/\d+\//, '');
}

const dirname = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const join = (dir, file) => (dir ? `${dir}/${file}` : file);

/** Every file WordPress itself lists for an attachment (REST `media_details`): the exact paths an observed URL may equal. */
export function attachmentExactPaths(media) {
  const out = new Set();
  const add = (p) => { if (typeof p === 'string' && p) out.add(p.replace(/^sites\/\d+\//, '')); };
  const md = media?.media_details || {};
  const file = typeof md.file === 'string' ? md.file : null;
  add(file);
  const dir = file ? dirname(file) : '';
  if (typeof md.original_image === 'string') add(join(dir, md.original_image));
  for (const size of Object.values(md.sizes || {})) {
    if (typeof size?.file === 'string') add(join(dir, size.file));
    if (typeof size?.source_url === 'string') add(uploadsPath(size.source_url));
  }
  if (typeof media?.source_url === 'string') add(uploadsPath(media.source_url));
  return out;
}

/** The URLs a rendered <img> was observed with (src, the real URL behind a lazy loader, every srcset entry). */
export function observedUrlsOf(snapshot) {
  const urls = [snapshot?.src || snapshot?.imageUrl, snapshot?.lazySrc, ...(snapshot?.srcsetUrls || [])];
  return [...new Set(urls.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)))];
}

/** Observed URLs that exactly equal one of the attachment's files. */
export function exactMatches(observedUrls, media) {
  const files = attachmentExactPaths(media);
  return observedUrls.filter((u) => { const p = uploadsPath(u); return !!p && files.has(p); });
}

const reason = (status, code, message, extra = {}) => ({ status, code, message, ...extra });

/**
 * @param {object} p
 * @param {object} p.snapshot     the finding's before_snapshot (src, wpAttachmentId, srcsetUrls, lazySrc, ...)
 * @param {string} p.siteHost     the connected site's host
 * @param {object|null} p.hinted  the media item for snapshot.wpAttachmentId (null when WordPress has no such attachment)
 * @param {object[]} p.candidates media items from a search (used only when there is no id hint)
 */
export function evaluateIdentity({ snapshot, siteHost, hinted = null, candidates = [] }) {
  const observed = observedUrlsOf(snapshot);
  if (!observed.length) {
    const kind = classifySnapshot(snapshot).kind;
    if (kind === KIND.DATA_URL) return reason('unsupported', UNSUPPORTED_REASON[kind].code, UNSUPPORTED_REASON[kind].message);
    return reason('unsupported', 'NO_IMAGE_URL', 'The finding has no usable image URL, so the image cannot be identified.');
  }
  if (!observed.some((u) => uploadsPath(u))) {
    // Say WHAT it is (tracker, theme/plugin file, another site's image) rather than one catch-all. A tracker is never an image to fix.
    const pageUrl = siteHost ? `https://${siteHost}/` : null;
    const kind = classifySnapshot(snapshot, pageUrl).kind;
    if (UNSUPPORTED_REASON[kind]) return reason('unsupported', UNSUPPORTED_REASON[kind].code, UNSUPPORTED_REASON[kind].message);
    return reason('unsupported', 'NOT_A_MEDIA_LIBRARY_FILE', 'This image is not served from the WordPress uploads folder, so it has no media-library alt text to change.');
  }
  const site = String(siteHost || '').toLowerCase().replace(/^www\./, '');
  const confidenceFor = (urls) => (urls.some((u) => hostKey(u) === site) ? 'high' : 'medium');
  const describe = (media, urls, method) => ({
    attachmentId: media.id, confidence: confidenceFor(urls), method, matchedUrls: urls,
    evidence: [
      method === 'attachment_id_class'
        ? `The image carries the WordPress class wp-image-${media.id}, and that attachment lists the observed file.`
        : 'Exactly one media-library attachment lists the observed file path.',
      `Matched file: ${uploadsPath(urls[0])}`,
      confidenceFor(urls) === 'high' ? 'The image is served from the connected site.' : 'The image is served from another host (a CDN) with the same uploads path.',
    ],
  });

  if (snapshot?.wpAttachmentId != null) {
    const id = Number(snapshot.wpAttachmentId);
    if (!hinted || hinted.id !== id) {
      return reason('ambiguous_target', 'ATTACHMENT_NOT_FOUND', `The page marks this image as attachment ${id}, but the WordPress media library has no such attachment. Nothing was guessed.`);
    }
    const urls = exactMatches(observed, hinted);
    if (!urls.length) {
      return reason('ambiguous_target', 'ID_AND_URL_DISAGREE', `The page marks this image as attachment ${id}, but none of its observed URLs is a file of that attachment (a theme resize, a CDN rewrite or a different image). The target cannot be confirmed.`);
    }
    return { status: 'resolved', ...describe(hinted, urls, 'attachment_id_class') };
  }

  const hits = candidates.map((m) => ({ media: m, urls: exactMatches(observed, m) })).filter((h) => h.urls.length);
  const unique = [...new Map(hits.map((h) => [h.media.id, h])).values()];
  if (unique.length === 0) {
    return reason('unsupported', 'NOT_IN_MEDIA_LIBRARY', 'No media-library attachment lists this exact file, and the page does not name the attachment (no wp-image class). Without one of the two the image cannot be targeted safely.');
  }
  if (unique.length > 1) {
    return reason('ambiguous_target', 'MULTIPLE_ATTACHMENTS_MATCH', `More than one attachment (${unique.map((h) => h.media.id).join(', ')}) lists this file, so the exact target is ambiguous.`);
  }
  return { status: 'resolved', ...describe(unique[0].media, unique[0].urls, 'exact_source_url') };
}

/** The file-name stem to SEARCH the media library with. A search only produces candidates; acceptance is exactMatches(). */
export function searchTermFor(snapshot) {
  for (const url of observedUrlsOf(snapshot)) {
    const p = uploadsPath(url);
    if (!p) continue;
    const file = p.split('/').pop().replace(/\.[a-z0-9]+$/i, '');
    const stem = file.replace(/-\d+x\d+$/, '').replace(/-scaled$/, '').replace(/-e\d{10,}$/, '');
    if (stem) return stem;
  }
  return null;
}

/**
 * The rendered <img> elements of a crawl that ARE this attachment — by the wp-image class or by an exact file path, never by
 * file-name similarity. An element whose class names ANOTHER attachment is excluded even if a URL matches (conflicting evidence).
 */
export function matchRenderedImages(images, { attachmentId, exactPaths }) {
  const files = exactPaths instanceof Set ? exactPaths : new Set(exactPaths || []);
  const matched = []; const conflicting = [];
  for (const img of images || []) {
    const urls = observedUrlsOf({ src: img?.src, lazySrc: img?.lazy_src, srcsetUrls: img?.srcset_urls });
    const byUrl = urls.some((u) => { const p = uploadsPath(u); return !!p && files.has(p); });
    const hint = img?.wp_attachment_id;
    if (hint != null && Number(hint) !== Number(attachmentId)) { if (byUrl) conflicting.push(img); continue; }
    if (byUrl || (hint != null && Number(hint) === Number(attachmentId))) matched.push(img);
  }
  return { matched, conflicting };
}

export default { hostKey, uploadsPath, attachmentExactPaths, observedUrlsOf, exactMatches, evaluateIdentity, searchTermFor, matchRenderedImages };
