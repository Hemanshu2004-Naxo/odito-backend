import multer from 'multer';
import path from 'path';

// No upload middleware existed anywhere in the codebase before this (see
// Phase 3's forensic check) — this is a new, reusable one, scoped to
// avatars only. memoryStorage() is deliberate: the file is never written to
// disk as-is. It only ever reaches disk after authService.js's
// uploadAvatar() has run it through sharp (resize/crop/re-encode as WebP) —
// the raw upload buffer is discarded once the request ends.
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB

// First layer only — both mimetype and extension are client-supplied and
// therefore spoofable. The authoritative check is authService.js's
// uploadAvatar(), which inspects the actual decoded image bytes via sharp
// before ever writing anything to disk. This layer exists purely to reject
// obviously-wrong uploads (a .pdf, a .zip, a mislabeled .svg) cheaply,
// before spending any CPU on image decoding.
function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (!ALLOWED_MIME_TYPES.has(file.mimetype) || !ALLOWED_EXTENSIONS.has(ext)) {
    return cb(new Error('Only JPEG, PNG, or WEBP images are allowed.'));
  }
  cb(null, true);
}

const avatarMulter = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter,
});

/**
 * POST /auth/avatar's upload middleware. Wraps multer's single-file parse
 * so every failure mode — oversized file, wrong type, or a malformed
 * multipart body — resolves to a clean 400 JSON response instead of
 * Express's default error page (multer errors otherwise bypass this app's
 * normal JSON error responses entirely).
 */
export function handleAvatarUpload(req, res, next) {
  avatarMulter.single('avatar')(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, message: 'Image must be 2 MB or smaller.' });
      }
      // Any other MulterError (unexpected field, too many parts, a
      // malformed multipart body, etc.) — one generic, professional message
      // rather than leaking multer's internal error codes to the client.
      return res.status(400).json({ success: false, message: 'Malformed upload request.' });
    }

    // Our own fileFilter's rejection.
    return res.status(400).json({ success: false, message: err.message || 'Invalid file.' });
  });
}
