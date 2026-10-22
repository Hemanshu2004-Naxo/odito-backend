import multer from 'multer';
import path from 'path';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { MAX_IMAGE_BYTES } from '../service/media/mediaValidationService.js';

/**
 * multer's cheap FIRST layer for a catalog image (product image or brand logo). Same two-layer design as
 * socialMediaUpload.js: this only checks the client-supplied mimetype / extension, both spoofable — the
 * authoritative check is the shared media pipeline (service/media/catalogMedia.js), which decodes the real bytes
 * before anything is written. Unlike post media there is no video here, and the ceiling is the image cap (a little
 * above it, so an over-size image reaches the validator and gets the precise MEDIA_TOO_LARGE message).
 * memoryStorage() is deliberate: the raw buffer lives only for this one request.
 *
 * Exactly ONE file in the field `file`; anything else is a malformed request. The client's file name is never used.
 *
 * Must run BEFORE validateProjectAccess() on these routes: the request is multipart/form-data, so
 * req.body.projectId only exists once multer has parsed the form fields.
 */
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (!ALLOWED_MIME_TYPES.has(file.mimetype) || !ALLOWED_EXTENSIONS.has(ext)) {
    return cb(new Error('Only JPEG, PNG or WEBP images are allowed.'));
  }
  cb(null, true);
}

const catalogImageMulter = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES + 64 * 1024, files: 1, fields: 10, parts: 12 },
  fileFilter,
});

export function handleCatalogImageUpload(req, res, next) {
  catalogImageMulter.single('file')(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json(ResponseUtil.error('Images must be 8MB or smaller.', 413, { code: 'MEDIA_TOO_LARGE' }));
      }
      return res.status(400).json(ResponseUtil.error('Malformed upload request.', 400, { code: 'MEDIA_UPLOAD_FAILED' }));
    }
    return res.status(400).json(ResponseUtil.error(err.message || 'Invalid file.', 400, { code: 'INVALID_MEDIA_TYPE' }));
  });
}

export default { handleCatalogImageUpload };
