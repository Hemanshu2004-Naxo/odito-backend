import {
  ALL_COLUMNS, REQUIRED_COLUMNS, MEDIA_URL_SEPARATOR, MEDIA_EXTENSION_TYPE,
  DEFAULT_ACTION, IMPORT_ACTIONS, SUPPORTED_PLATFORMS, BULK_ERROR,
} from './bulkImportConstants.js';

/**
 * Bulk Upload — Phase 2 normalization: pure, no DB, no network.
 *
 *  - `analyzeHeaders` turns a raw header row into the canonical column
 *    map and reports every file-level header problem (missing required,
 *    duplicate, unsupported).
 *  - `normalizeRow` turns one raw cell array into a SCHEMA-VALID
 *    `normalized` object plus a small `raw` snapshot and any
 *    normalization-time errors (a value that cannot even be represented,
 *    e.g. an unknown platform string — the enum on
 *    SocialImportRow.normalized would reject it, so it is coerced to
 *    `null` and the real value is reported in the error message).
 *
 * Business validation (account connected, schedule in the future, …)
 * lives in bulkImportValidator.js.
 */

/**
 * Deterministic header normalization: trim, lower-case, collapse runs of
 * whitespace / hyphens to a single underscore, drop everything that is
 * not `[a-z0-9_]`, and squeeze repeated / edge underscores.
 *   " Scheduled At "  -> "scheduled_at"
 *   "Media URLs"      -> "media_urls"
 *   "CONTENT"         -> "content"
 */
export function normalizeHeader(header) {
  return String(header ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * @returns {{ ok: boolean, errors: Array<{code,message}>, columnIndex: Object<string,number>, headers: string[] }}
 * `columnIndex` maps a canonical column name -> its 0-based position in a
 * row's cell array. Present only when `ok` is true.
 */
export function analyzeHeaders(rawHeaders) {
  const errors = [];
  const headers = (Array.isArray(rawHeaders) ? rawHeaders : []).map(normalizeHeader);

  if (headers.length === 0 || headers.every((h) => h === '')) {
    errors.push({ code: BULK_ERROR.MISSING_REQUIRED_COLUMN, message: 'The file has no header row.' });
    return { ok: false, errors, columnIndex: {}, headers };
  }

  const columnIndex = {};
  const seen = new Set();
  headers.forEach((h, idx) => {
    if (h === '') return; // a blank header cell is ignored, not an error on its own
    if (seen.has(h)) {
      errors.push({ code: BULK_ERROR.DUPLICATE_COLUMN, message: `Column "${h}" appears more than once.` });
      return;
    }
    seen.add(h);
    if (!ALL_COLUMNS.includes(h)) {
      errors.push({ code: BULK_ERROR.UNSUPPORTED_COLUMN, message: `Unsupported column "${h}". Allowed columns: ${ALL_COLUMNS.join(', ')}.` });
      return;
    }
    columnIndex[h] = idx;
  });

  for (const required of REQUIRED_COLUMNS) {
    if (!(required in columnIndex)) {
      errors.push({ code: BULK_ERROR.MISSING_REQUIRED_COLUMN, message: `Required column "${required}" is missing.` });
    }
  }

  return { ok: errors.length === 0, errors, columnIndex, headers };
}

function cellAt(cells, columnIndex, name) {
  const idx = columnIndex[name];
  if (idx === undefined) return '';
  const v = cells[idx];
  return v === undefined || v === null ? '' : String(v);
}

/** Strip a query string / fragment, then return the lower-cased extension incl. the dot ("" if none). */
function urlExtension(url) {
  try {
    const u = new URL(url);
    const path = u.pathname;
    const dot = path.lastIndexOf('.');
    return dot === -1 ? '' : path.slice(dot).toLowerCase();
  } catch {
    const clean = String(url).split(/[?#]/)[0];
    const dot = clean.lastIndexOf('.');
    return dot === -1 ? '' : clean.slice(dot).toLowerCase();
  }
}

/**
 * @param {string[]} cells         one raw row, aligned to the header order
 * @param {Object<string,number>} columnIndex  from analyzeHeaders
 * @returns {{ raw: Object, normalized: Object, mediaInputs: string[], errors: Array<{field,code,message}> }}
 *   `normalized` is always safe to persist against SocialImportRow's
 *   schema. `mediaInputs` is the split, trimmed list of media URL strings
 *   (validated for real in bulkImportValidator.js). `errors` are
 *   normalization-time problems only.
 */
export function normalizeRow(cells, columnIndex) {
  const errors = [];

  const raw = {};
  for (const col of ALL_COLUMNS) {
    if (col in columnIndex) raw[col] = cellAt(cells, columnIndex, col);
  }

  // ── platform ──
  const platformRaw = cellAt(cells, columnIndex, 'platform').trim();
  const platformLc = platformRaw.toLowerCase();
  let platform = null;
  if (SUPPORTED_PLATFORMS.includes(platformLc)) {
    platform = platformLc;
  } else if (platformRaw !== '') {
    errors.push({
      field: 'platform',
      code: BULK_ERROR.UNSUPPORTED_PLATFORM,
      message: `Unsupported platform "${platformRaw}". Supported: ${SUPPORTED_PLATFORMS.join(', ')}.`,
    });
  } else {
    errors.push({ field: 'platform', code: BULK_ERROR.UNSUPPORTED_PLATFORM, message: 'platform is required.' });
  }

  // ── content ──
  const contentRaw = cellAt(cells, columnIndex, 'content');
  const contentTrimmed = contentRaw.trim();
  const content = contentTrimmed === '' ? null : contentRaw;

  // ── media_urls (split; real URL / type checks happen in the validator) ──
  const mediaCell = cellAt(cells, columnIndex, 'media_urls');
  const mediaInputs = mediaCell
    .split(MEDIA_URL_SEPARATOR)
    .map((s) => s.trim())
    .filter((s) => s !== '');

  const media = [];
  for (const url of mediaInputs) {
    const ext = urlExtension(url);
    const type = MEDIA_EXTENSION_TYPE[ext] || null;
    // Only fully-typed items go into `normalized.media` (the schema
    // requires a valid image|video type). Everything else is reported by
    // the validator against `mediaInputs`.
    if (type) media.push({ url, type });
  }

  // ── action ──
  const actionRaw = cellAt(cells, columnIndex, 'action').trim().toLowerCase();
  let action = DEFAULT_ACTION;
  if (actionRaw === '') {
    action = DEFAULT_ACTION;
  } else if (IMPORT_ACTIONS.includes(actionRaw)) {
    action = actionRaw;
  } else {
    action = null; // schema-safe; the real value is in the error
    errors.push({
      field: 'action',
      code: BULK_ERROR.INVALID_ACTION,
      message: `Unknown action "${actionRaw}". Use one of: ${IMPORT_ACTIONS.join(', ')}.`,
    });
  }

  // ── timezone / scheduled_at (carried as raw strings for the validator) ──
  const timezone = cellAt(cells, columnIndex, 'timezone').trim() || null;

  const normalized = {
    platform,
    socialAccountId: null, // filled by the validator once the account resolves
    content,
    media,
    scheduledAt: null, // filled by the validator once parsed & checked
    timezone,
    action,
  };

  return {
    raw,
    normalized,
    mediaInputs,
    scheduledAtInput: cellAt(cells, columnIndex, 'scheduled_at').trim(),
    errors,
  };
}
