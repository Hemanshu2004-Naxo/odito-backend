import multer from 'multer';
import path from 'path';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { BULK_IMPORT_LIMITS, SUPPORTED_EXTENSIONS, SUPPORTED_MIME_TYPES, BULK_ERROR } from '../service/bulkImport/bulkImportConstants.js';

/**
 * Dedicated multer config for `POST /social/publishing/bulk-upload/validate`.
 * Completely separate from middleware/socialMediaUpload.js (images/video)
 * — this one only accepts a single .csv / .xlsx and enforces the bulk-
 * import limits.
 *
 * memoryStorage: the file lives only as a Buffer for the duration of the
 * one request and is garbage-collected afterwards — nothing is ever
 * written to disk, so there is no temp file to name safely or clean up,
 * and the client-supplied filename is never used as a path.
 *
 * The extension + declared MIME are a cheap first gate only; the real
 * proof is csvParser / xlsxParser actually parsing the bytes.
 */

const ALLOWED_EXTENSIONS = new Set(SUPPORTED_EXTENSIONS);
const ALLOWED_MIME_TYPES = new Set(SUPPORTED_MIME_TYPES);

function fileFilter(req, file, cb) {
  const name = file.originalname || '';
  if (name.length > BULK_IMPORT_LIMITS.MAX_FILENAME_CHARS) {
    return cb(new Error(`FILENAME_TOO_LONG:Filename is too long (max ${BULK_IMPORT_LIMITS.MAX_FILENAME_CHARS} characters).`));
  }
  const ext = path.extname(name).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return cb(new Error('UNSUPPORTED_FILE_TYPE:Only .csv or .xlsx files are allowed.'));
  }
  if (!ALLOWED_MIME_TYPES.has(file.mimetype || '')) {
    return cb(new Error('UNSUPPORTED_FILE_TYPE:That file type is not allowed for bulk import.'));
  }
  return cb(null, true);
}

const bulkImportMulter = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: BULK_IMPORT_LIMITS.MAX_FILE_BYTES,
    files: 1,
    fields: 10,
  },
  fileFilter,
});

/**
 * Runs BEFORE validateProjectAccess() on the validate route — the request
 * is multipart/form-data, so req.body.projectId only exists once multer
 * has parsed the form. Every multer failure resolves to this module's
 * standard JSON error shape.
 */
export function handleBulkImportUpload(req, res, next) {
  bulkImportMulter.single('file')(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json(ResponseUtil.error(
          `File is larger than ${BULK_IMPORT_LIMITS.MAX_FILE_BYTES / (1024 * 1024)} MB.`,
          413,
          { code: BULK_ERROR.FILE_TOO_LARGE },
        ));
      }
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json(ResponseUtil.error('Upload exactly one file in the "file" field.', 400, { code: BULK_ERROR.INVALID_FILE }));
      }
      return res.status(400).json(ResponseUtil.error('Malformed upload request.', 400, { code: BULK_ERROR.INVALID_FILE }));
    }

    // fileFilter errors are prefixed "CODE:message".
    const raw = err.message || '';
    const sep = raw.indexOf(':');
    const code = sep > 0 ? raw.slice(0, sep) : BULK_ERROR.UNSUPPORTED_FILE_TYPE;
    const message = sep > 0 ? raw.slice(sep + 1) : (raw || 'Invalid file.');
    const status = code === BULK_ERROR.FILENAME_TOO_LONG ? 400 : 400;
    return res.status(status).json(ResponseUtil.error(message, status, { code }));
  });
}

export default { handleBulkImportUpload };
