import sharp from 'sharp';
import { validateImage } from '../media/mediaValidationService.js';
import mediaStorageService from '../media/mediaStorageService.js';
import { PLATFORM_DESIGN, MIN_IMAGE_SIDE, MAX_IMAGE_PIXELS, JPEG_QUALITY, LOGO_MAX_WIDTH_RATIO, LOGO_MAX_HEIGHT_RATIO, LOGO_MARGIN_RATIO } from './designConfig.js';

/**
 * The media pipeline for a generated design: inspect -> re-encode -> validate -> store. Nothing the provider
 * returned is stored as it came:
 *   1. sharp decodes the BYTES (the provider's MIME type / extension are never consulted) with a pixel ceiling;
 *   2. the format must be a raster image (JPEG/PNG/WebP - an SVG, a PDF or a polyglot fails to decode as one);
 *   3. size and aspect ratio must be acceptable for the platform (Instagram: 4:5 .. 1.91:1);
 *   4. the image is re-encoded as a fresh JPEG - EXIF/ICC/other metadata and anything appended to the file
 *      are dropped, transparency is flattened onto white, and both Meta platforms accept JPEG;
 *   5. the re-encoded bytes go through the SAME validator uploads use (8 MB cap, real format check);
 *   6. mediaStorageService writes it under storage/social_media/<projectId>/<uuid>.jpg - the filename is a
 *      fresh UUID, never derived from the provider or the client.
 *
 * The REAL logo is never drawn by the model: it is composited here, after generation, from the stored file - scaled down
 * (never enlarged, never distorted), in the bottom-right safe zone the prompt left empty, on a small contrast chip only when
 * the logo would otherwise disappear into the background. Real product photos sent to the provider as references go through
 * prepareReferenceImage first (decoded, resized, re-encoded, metadata stripped).
 * Failures carry a code only (MEDIA_INVALID / STORAGE_FAILED).
 */

const ALLOWED_INPUT = new Set(['jpeg', 'png', 'webp']);
const mediaError = (code, reason) => Object.assign(new Error(code), { code, reason });

/** A real photo for the provider to build on: a decodable raster, bounded in size, re-encoded as a fresh JPEG without metadata. null when unusable. */
export async function prepareReferenceImage(buffer) {
  try {
    const meta = await sharp(buffer, { failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
    if (!ALLOWED_INPUT.has(meta.format)) return null;
    const out = await sharp(buffer, { failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS }).rotate().resize({ width: 1536, height: 1536, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer();
    return { buffer: out, mimeType: 'image/jpeg' };
  } catch {
    return null;
  }
}

/** The stored logo as a bounded PNG with its transparency kept, or null when it is not a usable raster. */
export async function prepareLogo(buffer) {
  try {
    const meta = await sharp(buffer, { failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
    if (!ALLOWED_INPUT.has(meta.format) || !meta.width || !meta.height) return null;
    return await sharp(buffer, { failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS }).rotate().ensureAlpha().resize({ width: 600, height: 600, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  } catch {
    return null;
  }
}

const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Places the real logo (a prepared PNG) in the bottom-right corner. Sized by the picture, aspect ratio untouched, never
 * larger than its own pixels. A chip (white behind a dark logo, near-black behind a light one) is added only when the logo's
 * brightness is close to the background's there. Returns { buffer, applied }; on any problem the picture is returned as it was.
 */
export async function compositeLogo(buffer, logoPng) {
  try {
    const { width, height } = await sharp(buffer, { failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
    const box = { width: Math.round(width * LOGO_MAX_WIDTH_RATIO), height: Math.round(height * LOGO_MAX_HEIGHT_RATIO) };
    const fitted = await sharp(logoPng).resize({ ...box, fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
    const lw = fitted.info.width;
    const lh = fitted.info.height;
    const margin = Math.round(width * LOGO_MARGIN_RATIO);
    const left = width - lw - margin;
    const top = height - lh - margin;
    if (left < 0 || top < 0 || lw < 8 || lh < 8) return { buffer, applied: false };

    // brightness of the logo's opaque pixels vs. the picture behind it
    const raw = await sharp(fitted.data).ensureAlpha().raw().toBuffer();
    let sum = 0; let n = 0;
    for (let i = 0; i < raw.length; i += 4) if (raw[i + 3] > 128) { sum += luminance(raw[i], raw[i + 1], raw[i + 2]); n += 1; }
    const logoLum = n ? sum / n : 128;
    // sharp's stats() ignores a preceding extract(), so the patch behind the logo is cut out first and measured on its own
    const patch = await sharp(buffer, { failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS }).extract({ left, top, width: lw, height: lh }).png().toBuffer();
    const bg = await sharp(patch).stats();
    const bgLum = luminance(bg.channels[0].mean, bg.channels[1]?.mean ?? bg.channels[0].mean, bg.channels[2]?.mean ?? bg.channels[0].mean);

    const layers = [];
    if (Math.abs(bgLum - logoLum) < 70) {
      const pad = Math.max(4, Math.round(lh * 0.22));
      const w = lw + pad * 2;
      const h = lh + pad * 2;
      const fill = logoLum < 128 ? '#ffffff' : '#111827';
      const chip = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${Math.round(pad * 0.9)}" fill="${fill}" fill-opacity="0.92"/></svg>`);
      layers.push({ input: chip, left: left - pad, top: top - pad });
    }
    layers.push({ input: fitted.data, left, top });
    const out = await sharp(buffer, { failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS }).composite(layers).png().toBuffer();
    return { buffer: out, applied: true };
  } catch {
    return { buffer, applied: false };
  }
}

export async function inspectImage(buffer, platform) {
  const spec = PLATFORM_DESIGN[platform];
  if (!spec) throw mediaError('MEDIA_INVALID', 'unsupported_platform');
  let meta;
  try {
    meta = await sharp(buffer, { failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
  } catch {
    throw mediaError('MEDIA_INVALID', 'not_decodable');
  }
  if (!ALLOWED_INPUT.has(meta.format)) throw mediaError('MEDIA_INVALID', 'unsupported_format');
  const { width, height } = meta;
  if (!width || !height || Math.min(width, height) < MIN_IMAGE_SIDE) throw mediaError('MEDIA_INVALID', 'too_small');
  const aspect = width / height;
  if (aspect < spec.minAspect || aspect > spec.maxAspect) throw mediaError('MEDIA_INVALID', 'aspect_ratio');
  return { width, height, aspect, format: meta.format };
}

/**
 * @returns {Promise<{ url: string, width: number, height: number, bytes: number }>}
 * @throws code-only errors: MEDIA_INVALID | STORAGE_FAILED
 */
export async function processAndStoreDesign({ buffer, projectId, platform, logo = null }) {
  await inspectImage(buffer, platform);
  let source = buffer;
  let logoApplied = false;
  if (logo) ({ buffer: source, applied: logoApplied } = await compositeLogo(buffer, logo));

  let jpeg;
  try {
    jpeg = await sharp(source, { failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS }).flatten({ background: '#ffffff' }).jpeg({ quality: JPEG_QUALITY }).toBuffer();
  } catch {
    throw mediaError('MEDIA_INVALID', 'reencode_failed');
  }

  const checked = await validateImage(jpeg);
  if (checked.error) throw mediaError('MEDIA_INVALID', checked.error.code === 'MEDIA_TOO_LARGE' ? 'too_large' : 'validation_failed');
  await inspectImage(jpeg, platform); // the stored bytes, not just the input, satisfy the platform rules

  try {
    const stored = await mediaStorageService.upload({ buffer: jpeg, projectId, extension: checked.extension });
    return { url: stored.url, width: checked.width, height: checked.height, bytes: jpeg.length, logoApplied };
  } catch {
    throw mediaError('STORAGE_FAILED', 'write_failed');
  }
}

export default { inspectImage, processAndStoreDesign, prepareReferenceImage, prepareLogo, compositeLogo };
