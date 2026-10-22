/**
 * Bulk Upload — Phase 2 constants: limits, canonical columns, error
 * codes. Single source of truth shared by the parsers, the normalizer,
 * the validator, the multer config, the controller and the service.
 *
 * Nothing here creates a SocialPublication, publishes, or schedules —
 * Phase 2 is file -> parse -> normalize -> validate -> store rows only.
 */

export const BULK_IMPORT_LIMITS = Object.freeze({
  MAX_FILE_BYTES: 10 * 1024 * 1024, // 10 MB
  MAX_ROWS: 200, // matches SocialPublicationService.MAX_BULK_ROWS
  MAX_COLUMNS: 20,
  MAX_CELL_CHARS: 10_000,
  MAX_FILENAME_CHARS: 255,
  // Facebook and Instagram adapters both accept a SINGLE media item per
  // post today (see platformAdapters/*.js — >1 is MEDIA_NOT_SUPPORTED).
  MAX_MEDIA_PER_ROW: 1,
});

export const SUPPORTED_FORMATS = Object.freeze(['csv', 'xlsx']);
export const SUPPORTED_EXTENSIONS = Object.freeze(['.csv', '.xlsx']);

// Browsers are inconsistent about the MIME they attach to a .csv / .xlsx
// upload — the real content is always verified by actually parsing it
// (csvParser / xlsxParser), so this list only has to be permissive
// enough not to reject a legitimate spreadsheet.
export const SUPPORTED_MIME_TYPES = Object.freeze([
  'text/csv',
  'application/csv',
  'text/plain',
  'application/vnd.ms-excel', // some browsers label .csv this way
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/octet-stream', // generic fallback — content still verified
  '', // no MIME provided
]);

// ── Canonical import format (post header-normalization) ──────────────
// ONE ROW = ONE PLATFORM POST.
export const REQUIRED_COLUMNS = Object.freeze(['platform', 'content']);
export const OPTIONAL_COLUMNS = Object.freeze(['media_urls', 'scheduled_at', 'timezone', 'action']);
export const ALL_COLUMNS = Object.freeze([...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS]);

// Multiple media URLs are separated by a SEMICOLON, never a comma — a
// URL / query string can legitimately contain commas.
export const MEDIA_URL_SEPARATOR = ';';

export const IMPORT_ACTIONS = Object.freeze(['draft', 'schedule', 'publish']);
export const DEFAULT_ACTION = 'draft';

// Platforms with a real publish adapter today (mirrors
// service/platformAdapters/index.js). X / LinkedIn / TikTok have NO
// adapter — a row targeting them is UNSUPPORTED_PLATFORM, never silently
// accepted.
export const SUPPORTED_PLATFORMS = Object.freeze(['facebook', 'instagram']);

// Media file extensions Odito already accepts for a social post
// (mediaValidationService.js / middleware/socialMediaUpload.js). Used to
// infer normalized.media[].type from a URL WITHOUT fetching it.
export const MEDIA_EXTENSION_TYPE = Object.freeze({
  '.jpg': 'image',
  '.jpeg': 'image',
  '.png': 'image',
  '.webp': 'image',
  '.mp4': 'video',
});

export const BULK_ERROR = Object.freeze({
  // ── file-level ──
  INVALID_FILE: 'INVALID_FILE',
  UNSUPPORTED_FILE_TYPE: 'UNSUPPORTED_FILE_TYPE',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  FILENAME_TOO_LONG: 'FILENAME_TOO_LONG',
  EMPTY_FILE: 'EMPTY_FILE',
  MALFORMED_CSV: 'MALFORMED_CSV',
  MALFORMED_XLSX: 'MALFORMED_XLSX',
  MISSING_REQUIRED_COLUMN: 'MISSING_REQUIRED_COLUMN',
  DUPLICATE_COLUMN: 'DUPLICATE_COLUMN',
  UNSUPPORTED_COLUMN: 'UNSUPPORTED_COLUMN',
  TOO_MANY_ROWS: 'TOO_MANY_ROWS',
  TOO_MANY_COLUMNS: 'TOO_MANY_COLUMNS',
  CELL_TOO_LARGE: 'CELL_TOO_LARGE',
  ROW_PERSIST_FAILED: 'ROW_PERSIST_FAILED',
  // ── row-level ──
  UNSUPPORTED_PLATFORM: 'UNSUPPORTED_PLATFORM',
  ACCOUNT_NOT_CONNECTED: 'ACCOUNT_NOT_CONNECTED',
  ACCOUNT_NOT_PUBLISH_READY: 'ACCOUNT_NOT_PUBLISH_READY',
  CONTENT_REQUIRED: 'CONTENT_REQUIRED',
  INVALID_CONTENT: 'INVALID_CONTENT',
  MEDIA_REQUIRED: 'MEDIA_REQUIRED',
  TOO_MANY_MEDIA: 'TOO_MANY_MEDIA',
  INVALID_MEDIA_URL: 'INVALID_MEDIA_URL',
  INVALID_MEDIA_TYPE: 'INVALID_MEDIA_TYPE',
  INVALID_ACTION: 'INVALID_ACTION',
  INVALID_SCHEDULE: 'INVALID_SCHEDULE',
  PAST_SCHEDULE: 'PAST_SCHEDULE',
  INVALID_TIMEZONE: 'INVALID_TIMEZONE',
  // ── orchestration ──
  BULK_IMPORT_IN_PROGRESS: 'BULK_IMPORT_IN_PROGRESS',
  // ── Phase 3: import into SocialPublication ──
  INVALID_MODE: 'INVALID_MODE',
  IMPORT_BATCH_NOT_READY: 'IMPORT_BATCH_NOT_READY',
  IMPORT_ALREADY_IN_PROGRESS: 'IMPORT_ALREADY_IN_PROGRESS',
  IMPORT_BATCH_FAILED: 'IMPORT_BATCH_FAILED',
  IMPORT_BATCH_EXPIRED: 'IMPORT_BATCH_EXPIRED',
  IMPORT_FAILED: 'IMPORT_FAILED',
  // row-level, import stage
  MEDIA_NOT_OWNED: 'MEDIA_NOT_OWNED',
  ACCOUNT_NO_LONGER_AVAILABLE: 'ACCOUNT_NO_LONGER_AVAILABLE',
  ROW_IMPORT_FAILED: 'ROW_IMPORT_FAILED',
});
// NOTE: the valid import `mode` values ('valid-only' | 'all-as-draft')
// are IMPORT_MODES, exported from model/SocialImportBatch.js (the same
// enum that column uses) — not redefined here.

// File-level error codes → these fail the whole upload (batch -> failed,
// no usable preview). Everything else is a per-row problem and leaves
// the batch `ready` with the row marked invalid.
export const FILE_LEVEL_ERROR_CODES = Object.freeze([
  BULK_ERROR.INVALID_FILE,
  BULK_ERROR.UNSUPPORTED_FILE_TYPE,
  BULK_ERROR.FILE_TOO_LARGE,
  BULK_ERROR.FILENAME_TOO_LONG,
  BULK_ERROR.EMPTY_FILE,
  BULK_ERROR.MALFORMED_CSV,
  BULK_ERROR.MALFORMED_XLSX,
  BULK_ERROR.MISSING_REQUIRED_COLUMN,
  BULK_ERROR.DUPLICATE_COLUMN,
  BULK_ERROR.UNSUPPORTED_COLUMN,
  BULK_ERROR.TOO_MANY_ROWS,
  BULK_ERROR.TOO_MANY_COLUMNS,
  BULK_ERROR.CELL_TOO_LARGE,
  BULK_ERROR.ROW_PERSIST_FAILED,
]);
