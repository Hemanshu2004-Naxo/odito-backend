import multer from 'multer';
import path from 'path';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';

/**
 * multer's cheap FIRST layer for a social-post media upload — checks only
 * the client-supplied mimetype/extension, both spoofable. The authoritative
 * check is mediaValidationService.js, which inspects the real decoded
 * bytes before anything is written to disk. memoryStorage() is deliberate,
 * same reasoning as user/middleware/avatarUpload.js: the raw buffer is
 * only ever kept in memory for the duration of this one request.
 */
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4']);
const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.mp4']);
// A generous ceiling covering both images and video — the real, TYPE-
// SPECIFIC cap (8MB image / 100MB video) is enforced authoritatively by
// mediaValidationService once the real file type is known; multer's own
// limit can only apply a single number before that.
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (!ALLOWED_MIME_TYPES.has(file.mimetype) || !ALLOWED_EXTENSIONS.has(ext)) {
    return cb(new Error('Only JPEG, PNG, WEBP images or MP4 videos are allowed.'));
  }
  cb(null, true);
}

const socialMediaMulter = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter,
});

/**
 * POST /social/media/upload's upload middleware. Every multer failure mode
 * resolves to this module's normal JSON error shape instead of Express's
 * default error page. Must run BEFORE validateProjectAccess() on this
 * route specifically — unlike every other social_meta route, this request
 * is multipart/form-data, so req.body.projectId (which
 * validateProjectAccess() reads) only exists once multer has parsed the
 * form fields.
 */
export function handleSocialMediaUpload(req, res, next) {
  socialMediaMulter.single('file')(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json(ResponseUtil.error('File is too large.', 413, { code: 'MEDIA_TOO_LARGE' }));
      }
      return res.status(400).json(ResponseUtil.error('Malformed upload request.', 400, { code: 'MEDIA_UPLOAD_FAILED' }));
    }
    return res.status(400).json(ResponseUtil.error(err.message || 'Invalid file.', 400, { code: 'INVALID_MEDIA_TYPE' }));
  });
}
