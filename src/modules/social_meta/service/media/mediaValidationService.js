import sharp from 'sharp';

/**
 * MediaValidationService — the AUTHORITATIVE type/size check for an
 * uploaded social-post media file. The multer fileFilter (see
 * ../../middleware/socialMediaUpload.js) only checks the client-supplied
 * mimetype/extension, which are both spoofable; this is the real check,
 * performed on the actual decoded bytes, before anything is ever written
 * to disk — same discipline as authService.js's uploadAvatar().
 */

const IMAGE_FORMATS = {
  jpeg: { extension: '.jpg', mimeType: 'image/jpeg' },
  png: { extension: '.png', mimeType: 'image/png' },
  webp: { extension: '.webp', mimeType: 'image/webp' },
};

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024; // 100MB

/**
 * An MP4 (and every other ISO-BMFF-based container: MOV, M4V) begins with
 * a size field followed by the literal ASCII bytes "ftyp" at offset 4 —
 * true regardless of which specific brand/codec follows. This is the
 * closest thing to an authoritative video check available without an
 * ffmpeg/ffprobe dependency (none exists anywhere in odito_backend's
 * package.json) — it proves the file is a real MP4 container by its
 * actual file signature rather than trusting the client-supplied
 * mimetype/extension alone, even though it cannot decode codec/resolution/
 * duration the way sharp does for images.
 */
function isRealMp4(buffer) {
  return buffer.length > 12 && buffer.toString('ascii', 4, 8) === 'ftyp';
}

export async function validateImage(buffer) {
  if (buffer.length > MAX_IMAGE_BYTES) {
    return { error: { code: 'MEDIA_TOO_LARGE', message: `Images must be ${MAX_IMAGE_BYTES / (1024 * 1024)}MB or smaller.` } };
  }
  let metadata;
  try {
    metadata = await sharp(buffer, { failOn: 'error' }).metadata();
  } catch {
    return { error: { code: 'INVALID_MEDIA_TYPE', message: 'The uploaded file is not a valid image.' } };
  }
  const format = IMAGE_FORMATS[metadata.format];
  if (!format) {
    return { error: { code: 'INVALID_MEDIA_TYPE', message: 'Only JPEG, PNG, or WEBP images are allowed.' } };
  }
  return { type: 'image', mimeType: format.mimeType, extension: format.extension, width: metadata.width, height: metadata.height };
}

export async function validateVideo(buffer) {
  if (buffer.length > MAX_VIDEO_BYTES) {
    return { error: { code: 'MEDIA_TOO_LARGE', message: `Videos must be ${MAX_VIDEO_BYTES / (1024 * 1024)}MB or smaller.` } };
  }
  if (!isRealMp4(buffer)) {
    return { error: { code: 'INVALID_MEDIA_TYPE', message: 'Only MP4 video files are allowed.' } };
  }
  // Honest limitation: no video-decoding dependency exists in this
  // codebase, so width/height/duration are reported as null rather than
  // fabricated (never invent metadata the file signature check alone
  // cannot actually prove).
  return { type: 'video', mimeType: 'video/mp4', extension: '.mp4', width: null, height: null };
}

export default { validateImage, validateVideo, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES };
