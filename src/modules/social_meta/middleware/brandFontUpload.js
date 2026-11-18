import multer from 'multer';
import path from 'path';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { MAX_FONT_BYTES } from '../service/brandFontService.js';

/**
 * multer's cheap FIRST layer for a brand font file (.ttf / .otf / .woff2). The client's extension is checked here only to refuse the
 * obvious; the authoritative check is brandFontService (the file's own signature, its family name, a test render). memoryStorage():
 * the bytes live only for this request. Exactly ONE file in the field `file`. Runs before validateProjectAccess() (multipart body).
 */
const ALLOWED_EXTENSIONS = new Set(['.ttf', '.otf', '.woff2']);

const fontMulter = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FONT_BYTES + 64 * 1024, files: 1, fields: 10, parts: 12 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_EXTENSIONS.has(path.extname(file.originalname || '').toLowerCase())) return cb(new Error('Upload a TTF, OTF or WOFF2 font file.'));
    return cb(null, true);
  },
});

export function handleBrandFontUpload(req, res, next) {
  fontMulter.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json(ResponseUtil.error(`Font files must be ${MAX_FONT_BYTES / 1024 / 1024} MB or smaller.`, 413, { code: 'FONT_TOO_LARGE' }));
      return res.status(400).json(ResponseUtil.error('Malformed upload request.', 400, { code: 'MEDIA_UPLOAD_FAILED' }));
    }
    return res.status(400).json(ResponseUtil.error(err.message || 'Invalid font file.', 400, { code: 'INVALID_FONT' }));
  });
}

export default { handleBrandFontUpload };
