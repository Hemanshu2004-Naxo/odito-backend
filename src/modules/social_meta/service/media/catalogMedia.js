import sharp from 'sharp';
import { validateImage } from './mediaValidationService.js';
import mediaStorageService from './mediaStorageService.js';

/**
 * Catalog media pipeline — product images and the user's brand logo. It is the SAME pipeline a generated design
 * goes through (aiDesign/designMedia.js): the shared validator, then the shared storage. It only adds the step
 * those uploads skip, because here the bytes come straight from a browser:
 *
 *   1. mediaValidationService.validateImage() decodes the BYTES (the client's MIME type / extension are never
 *      trusted) and enforces the 8 MB cap and the JPEG / PNG / WEBP allow-list — an SVG, a PDF, an HTML file
 *      renamed .png or a polyglot does not decode as one of those and is refused (SVG is NOT a supported type);
 *   2. sharp re-decodes with a pixel ceiling (decompression-bomb guard) and the image must be large enough to use;
 *   3. the image is RE-ENCODED in its own format: EXIF / GPS / ICC and anything appended to the file are dropped,
 *      and the EXIF rotation is applied first so a phone photo does not turn sideways;
 *   4. the re-encoded bytes go through the validator again;
 *   5. mediaStorageService writes it under storage/social_media/<projectId>/<uuid>.<ext> — the filename is a
 *      fresh UUID, never anything the client sent.
 *
 * Returns { media } or { error: { code, message, status } } — never throws for bad input.
 */

export const MAX_CATALOG_IMAGE_PIXELS = 40_000_000;
export const MIN_CATALOG_IMAGE_SIDE = 200;
const QUALITY = 90;

const refuse = (code, message, status = 400) => ({ error: { code, message, status } });

const encoders = {
  jpeg: (s) => s.jpeg({ quality: QUALITY }),
  png: (s) => s.png(),
  webp: (s) => s.webp({ quality: QUALITY }),
};

export async function processAndStoreCatalogImage({ buffer, projectId }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return refuse('MEDIA_REQUIRED', 'No file was uploaded.');

  const checked = await validateImage(buffer);
  if (checked.error) return refuse(checked.error.code, checked.error.message, checked.error.code === 'MEDIA_TOO_LARGE' ? 413 : 400);

  let meta;
  try {
    meta = await sharp(buffer, { failOn: 'error', limitInputPixels: MAX_CATALOG_IMAGE_PIXELS }).metadata();
  } catch {
    return refuse('INVALID_MEDIA_TYPE', 'The uploaded file is not a valid image.');
  }
  const format = meta.format;
  if (!encoders[format]) return refuse('INVALID_MEDIA_TYPE', 'Only JPEG, PNG, or WEBP images are allowed.');
  if (!meta.width || !meta.height || Math.min(meta.width, meta.height) < MIN_CATALOG_IMAGE_SIDE) {
    return refuse('MEDIA_TOO_SMALL', `Images must be at least ${MIN_CATALOG_IMAGE_SIDE}px on their shortest side.`);
  }

  let clean;
  try {
    clean = await encoders[format](sharp(buffer, { failOn: 'error', limitInputPixels: MAX_CATALOG_IMAGE_PIXELS }).rotate()).toBuffer();
  } catch {
    return refuse('INVALID_MEDIA_TYPE', 'The uploaded file is not a valid image.');
  }

  const recheck = await validateImage(clean);
  if (recheck.error) return refuse(recheck.error.code, recheck.error.message, recheck.error.code === 'MEDIA_TOO_LARGE' ? 413 : 400);

  try {
    const stored = await mediaStorageService.upload({ buffer: clean, projectId, extension: recheck.extension });
    return {
      media: {
        url: stored.url,
        storageKey: `${projectId}/${stored.filename}`,
        mimeType: recheck.mimeType,
        width: recheck.width,
        height: recheck.height,
        size: clean.length,
      },
    };
  } catch {
    return refuse('MEDIA_UPLOAD_FAILED', 'Failed to store the uploaded file.', 500);
  }
}

export default { processAndStoreCatalogImage, MAX_CATALOG_IMAGE_PIXELS, MIN_CATALOG_IMAGE_SIDE };
