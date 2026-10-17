import { BaseResolver } from './BaseResolver.js';
import { classifyImageUrl } from '../../external_integration/mediaFix/imageResource.js';

/**
 * ImageResolver
 *
 * Handles all image-related issue types:
 *   alt text, file size, WebP format, dimensions, lazy loading.
 */
export class ImageResolver extends BaseResolver {
  resolve(issueId, _displayType, extracted, _issueDoc) {
    const { pageData, issuesByCode, visibilityData } = extracted;
    const onPageIssue = issuesByCode?.[issueId];
    const detectedFromDoc = onPageIssue?.detected_value ?? null;

    // Normalise image arrays from either pipeline
    const images = pageData?.images
      || visibilityData?.images
      || [];

    switch (issueId) {

      case 'images_missing_alt_text': {
        // Filter to images with empty/missing alt — but never an analytics/advertising tracker (the Facebook Pixel's <noscript>
        // fallback and the like): it is not a picture, so listing it would make the recommendation describe an image that does not
        // exist. Same classifier as the crawler and the WordPress fix (imageResource.js).
        // Row keys must exactly match the column names so TableRenderer can look them up.
        const pageUrl = pageData?.url || pageData?.page_url || null;
        const trackers = new Set();
        const isActionable = (src, img = {}) => {
          const ok = classifyImageUrl(src, { pageUrl, width: img.width, height: img.height, lazySrc: img.lazy_src }).actionable;
          if (!ok && src) trackers.add(src);
          return ok;
        };
        // The same image file can be used more than once on a page (a header logo and a footer logo), each with its own alt. One row per
        // image file, and the status says how its uses split, so "Missing" is never read as "no use of this image has alt text".
        const uses = new Map();
        for (const img of images) {
          const key = img.src || img.url || '';
          const u = uses.get(key) || { total: 0, withAlt: 0 };
          u.total += 1;
          if (img.alt && img.alt.trim() !== '') u.withAlt += 1;
          uses.set(key, u);
        }
        const statusFor = (src) => {
          const u = uses.get(src);
          if (!u || u.total < 2) return 'Missing';
          const without = u.total - u.withAlt;
          return u.withAlt > 0
            ? `Missing on ${without} of ${u.total} uses of this image (another use has alt text)`
            : `Missing on all ${u.total} uses of this image`;
        };
        const seenSrc = new Set();
        const affected = images
          .filter(img => !img.alt || img.alt.trim() === '')
          .filter(img => isActionable(img.src || img.url || '', img))
          .filter(img => { const k = img.src || img.url || ''; if (seenSrc.has(k)) return false; seenSrc.add(k); return true; })
          .map(img => ({
            'Image':       img.src || img.url || '',
            'Current Alt': img.alt || 'Missing',
            'Status':      statusFor(img.src || img.url || ''),
          }));

        const fallback = affected.length > 0 ? [] : _parseDetectedImages(detectedFromDoc)
          .filter(item => isActionable(item.src || item.url || String(item)))
          .map(item => ({
            'Image':       item.src || item.url || String(item),
            'Current Alt': 'Missing',
            'Status':      'Missing',
          }));
        const rows = affected.length > 0 ? affected : fallback;

        return {
          currentState: this._tableState(['Image', 'Current Alt', 'Status'], rows),
          expectedState: this._expectedState(
            'All content images have a descriptive alt attribute'
          ),
          // What the finding really covers: how many pictures are left to describe, and how many flagged addresses were set aside as
          // trackers. actionable === 0 with ignoredTracking > 0 means the finding was only ever a tracker (nothing to fix).
          contextExtras: { altFindingScope: { actionable: rows.length, ignoredTracking: trackers.size } },
        };
      }

      case 'broken_images': {
        const broken = images
          .filter(img => img.status_code >= 400 || img.is_broken)
          .map(img => img.src || img.url || String(img));

        return {
          currentState: this._listState(
            broken.length > 0 ? broken : _toStringArray(detectedFromDoc)
          ),
          expectedState: this._expectedState(
            'All images return a 200 HTTP status'
          ),
        };
      }

      case 'image_file_size': {
        const oversized = images
          .filter(img => img.file_size_kb > 100 || img.size_kb > 100)
          .map(img => ({
            'Image':     img.src || img.url || '',
            'File Size': `${img.file_size_kb || img.size_kb || '?'} KB`,
            'Limit':     '100 KB',
          }));

        return {
          currentState: this._tableState(
            ['Image', 'File Size', 'Limit'],
            oversized.length > 0 ? oversized : _parseDetectedImages(detectedFromDoc)
          ),
          expectedState: this._expectedState(
            'Images under 100 KB each', null, 100, 'KB'
          ),
        };
      }

      case 'images_not_webp_format':
      case 'webp_avif_images_lazy_loading': {
        const nonWebp = images
          .filter(img => {
            const fmt = (img.format || img.extension || '').toLowerCase();
            return fmt && fmt !== 'webp' && fmt !== 'avif';
          })
          .map(img => ({
            'Image':   img.src || img.url || '',
            'Format':  img.format || img.extension || 'unknown',
            'Loading': img.loading || 'not set',
          }));

        return {
          currentState: this._tableState(
            ['Image', 'Format', 'Loading'],
            nonWebp.length > 0 ? nonWebp : _parseDetectedImages(detectedFromDoc)
          ),
          expectedState: this._expectedState(
            'All images in WebP or AVIF format with loading="lazy" on below-fold images'
          ),
        };
      }

      case 'images_missing_dimensions': {
        const noDims = images
          .filter(img => !img.width || !img.height)
          .map(img => ({
            'Image':  img.src || img.url || '',
            'Width':  img.width || 'Missing',
            'Height': img.height || 'Missing',
          }));

        return {
          currentState: this._tableState(
            ['Image', 'Width', 'Height'],
            noDims.length > 0 ? noDims : _parseDetectedImages(detectedFromDoc)
          ),
          expectedState: this._expectedState(
            'All images have explicit width and height attributes to prevent layout shift'
          ),
        };
      }

      case 'images_without_lazy_loading': {
        const noLazy = images
          .filter(img => img.loading !== 'lazy' && !img.is_above_fold)
          .map(img => ({
            'Image':             img.src || img.url || '',
            'Loading Attribute': img.loading || 'not set',
          }));

        return {
          currentState: this._tableState(
            ['Image', 'Loading Attribute'],
            noLazy.length > 0 ? noLazy : _parseDetectedImages(detectedFromDoc)
          ),
          expectedState: this._expectedState(
            'Below-fold images have loading="lazy" attribute'
          ),
        };
      }

      default: {
        return {
          currentState: this._listState(_toStringArray(detectedFromDoc)),
          expectedState: this._expectedState('See issue description'),
        };
      }
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _parseDetectedImages(detected) {
  if (!detected) return [];
  if (Array.isArray(detected)) return detected;
  if (typeof detected === 'string') return [{ src: detected }];
  return [detected];
}

function _toStringArray(detected) {
  if (!detected) return [];
  if (Array.isArray(detected)) return detected.map(String);
  return [String(detected)];
}

export default new ImageResolver();
