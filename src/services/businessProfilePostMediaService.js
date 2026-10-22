import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import multer from 'multer';
import { getServiceUrls } from '../config/env.js';
import { ResponseUtil } from '../utils/ResponseUtil.js';
import { LoggerUtil } from '../utils/LoggerUtil.js';

/**
 * Business Profile Post Media Service
 *
 * Dedicated, modular media storage and validation service for Google Business Profile posts.
 * Follows the storage pattern established by authService (avatars) and mediaStorageService (social media):
 * - Files stored under storage/business_profile_posts/<projectId>/<uuid>.<ext>
 * - Served statically via server.js's app.use('/storage', express.static(storagePath))
 * - Real byte validation using sharp (JPEG, PNG, WEBP, max 8MB)
 * - Safe path traversal protection
 */

export const MAX_POST_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB

const ALLOWED_IMAGE_FORMATS = {
  jpeg: { extension: '.jpg', mimeType: 'image/jpeg' },
  png: { extension: '.png', mimeType: 'image/png' },
  webp: { extension: '.webp', mimeType: 'image/webp' },
};

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const ROOT_DIR = path.resolve(process.cwd(), 'storage', 'business_profile_posts');
const MEDIA_PATH = '/storage/business_profile_posts/';

/**
 * Returns public origin for uploaded media (reads PUBLIC_MEDIA_BASE_URL if set, else backend URL).
 */
export function publicMediaOrigin() {
  const configured = (process.env.PUBLIC_MEDIA_BASE_URL || '').trim().replace(/\/+$/, '');
  return configured || getServiceUrls().backend;
}

function urlPrefix() {
  return `${publicMediaOrigin()}${MEDIA_PATH}`;
}

function ownedPrefixes() {
  return [...new Set([urlPrefix(), `${getServiceUrls().backend}${MEDIA_PATH}`])];
}

export function isOwnedUrl(url) {
  return typeof url === 'string' && ownedPrefixes().some((prefix) => url.startsWith(prefix));
}

function safeFilePath(url) {
  const prefix = ownedPrefixes().find((p) => url.startsWith(p));
  if (!prefix) return null;
  const rel = url.slice(prefix.length);
  const segments = rel.split('/');
  if (segments.length !== 2) return null;
  const [projectSegment, filename] = segments;
  if (!/^[a-f0-9]{24}$/i.test(projectSegment)) return null;
  if (!filename || filename.includes('..') || filename.includes('\\') || filename.includes('/')) return null;
  return path.join(ROOT_DIR, projectSegment, filename);
}

/**
 * Authoritative byte-level validation using sharp.
 */
export async function validatePostImage(buffer) {
  if (!buffer || !buffer.length) {
    return { error: { code: 'MEDIA_REQUIRED', message: 'Please select an image.' } };
  }

  if (buffer.length > MAX_POST_IMAGE_BYTES) {
    return {
      error: {
        code: 'MEDIA_TOO_LARGE',
        message: `Image is too large. Maximum allowed size is ${MAX_POST_IMAGE_BYTES / (1024 * 1024)}MB.`
      }
    };
  }

  let metadata;
  try {
    metadata = await sharp(buffer, { failOn: 'error' }).metadata();
  } catch {
    return { error: { code: 'INVALID_MEDIA_TYPE', message: 'The uploaded file is not a valid image.' } };
  }

  const format = ALLOWED_IMAGE_FORMATS[metadata.format];
  if (!format) {
    return {
      error: {
        code: 'INVALID_MEDIA_TYPE',
        message: 'Unsupported image format. Allowed formats: JPG, PNG, WEBP.'
      }
    };
  }

  return {
    valid: true,
    mimeType: format.mimeType,
    extension: format.extension,
    width: metadata.width,
    height: metadata.height,
    size: buffer.length
  };
}

/**
 * Saves validated image buffer to project directory with random UUID.
 */
export async function uploadPostImage({ buffer, projectId, extension, originalFilename }) {
  const projectDir = path.join(ROOT_DIR, String(projectId));
  await fs.mkdir(projectDir, { recursive: true });

  const filename = `${randomUUID()}${extension}`;
  const filePath = path.join(projectDir, filename);

  await fs.writeFile(filePath, buffer);

  const url = `${urlPrefix()}${projectId}/${filename}`;

  return {
    url,
    filename,
    originalFilename: path.basename(originalFilename || filename),
    size: buffer.length
  };
}

/**
 * Safe cleanup of an owned media URL.
 */
export async function deletePostImageByUrl(url) {
  if (!isOwnedUrl(url)) return false;
  const filePath = safeFilePath(url);
  if (!filePath) return false;

  try {
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      LoggerUtil.warn('Failed to delete post image file', { message: error.message, url });
    }
    return false;
  }
}

/**
 * Multer middleware for single file upload with field 'file'.
 */
function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (!ALLOWED_MIME_TYPES.has(file.mimetype) || !ALLOWED_EXTENSIONS.has(ext)) {
    return cb(new Error('Unsupported image format. Allowed formats: JPG, PNG, WEBP.'));
  }
  cb(null, true);
}

const postImageMulter = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_POST_IMAGE_BYTES + 64 * 1024,
    files: 1,
    fields: 10,
    parts: 12
  },
  fileFilter
});

export function handlePostImageUpload(req, res, next) {
  postImageMulter.single('file')(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json(
          ResponseUtil.error(
            `Image is too large. Maximum allowed size is ${MAX_POST_IMAGE_BYTES / (1024 * 1024)}MB.`,
            413,
            'MEDIA_TOO_LARGE'
          )
        );
      }
      return res.status(400).json(
        ResponseUtil.error('Malformed upload request.', 400, 'MEDIA_UPLOAD_FAILED')
      );
    }

    return res.status(400).json(
      ResponseUtil.error(err.message || 'Invalid file.', 400, 'INVALID_MEDIA_TYPE')
    );
  });
}

export default {
  validatePostImage,
  uploadPostImage,
  deletePostImageByUrl,
  handlePostImageUpload,
  publicMediaOrigin,
  MAX_POST_IMAGE_BYTES
};

