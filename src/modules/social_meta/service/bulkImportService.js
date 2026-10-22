import mongoose from 'mongoose';
import crypto from 'crypto';
import path from 'path';
import SocialImportBatch, {
  canTransitionBatchStatus, STATUSES as BATCH_STATUSES, ACTIVE_STATUSES,
} from '../model/SocialImportBatch.js';
import SocialImportRow, { STATUSES as ROW_STATUSES } from '../model/SocialImportRow.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { getActiveFacebookAccount, getActiveInstagramAccount } from './facebookAccountService.js';
import { parseCsv } from './bulkImport/parsers/csvParser.js';
import { parseXlsx } from './bulkImport/parsers/xlsxParser.js';
import { analyzeHeaders, normalizeRow } from './bulkImport/bulkImportNormalizer.js';
import { validateRow } from './bulkImport/bulkImportValidator.js';
import { buildTemplateCsv, buildErrorReportCsv } from './bulkImport/bulkImportCsv.js';
import { importValidatedBatch } from './bulkImport/bulkImportExecutor.js';
import {
  BULK_IMPORT_LIMITS, SUPPORTED_PLATFORMS, BULK_ERROR,
} from './bulkImport/bulkImportConstants.js';

/**
 * BulkImportService — the ONLY place that reads or writes a
 * SocialImportBatch / SocialImportRow.
 *
 * Phase 1 (backend foundation): batch bookkeeping + ownership-safe reads
 * ONLY. No file parsing, no row validation, no publication creation —
 * those are later phases and this file must not grow them speculatively.
 *
 * Mirrors socialPublishingService.js's layering exactly: no HTTP here
 * (the controller owns that), no model access above this file. Every
 * function that touches a batch re-verifies batch.project_id ===
 * projectId — a batchId is never trusted on its own (same IDOR
 * discipline as socialPublishingService.findOwned). Rows inherit that
 * ownership: they are only ever read through a batch that has already
 * passed the check.
 *
 * Return shape matches this module's convention: `{ success: true, ... }`
 * or `{ success: false, error: { code, message } }` — never throws for an
 * ordinary caller/validation failure.
 */

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

const COUNT_KEYS = ['total', 'valid', 'invalid', 'imported', 'failed', 'drafts', 'scheduled'];

function toApiBatch(doc) {
  return {
    id: doc._id.toString(),
    filename: doc.filename,
    format: doc.format,
    status: doc.status,
    rowCount: doc.rowCount ?? 0,
    counts: {
      total: doc.counts?.total ?? 0,
      valid: doc.counts?.valid ?? 0,
      invalid: doc.counts?.invalid ?? 0,
      imported: doc.counts?.imported ?? 0,
      failed: doc.counts?.failed ?? 0,
      drafts: doc.counts?.drafts ?? 0,
      scheduled: doc.counts?.scheduled ?? 0,
    },
    errorSummary: doc.errorSummary ?? null,
    importMode: doc.importMode ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Row shape returned to the client. Deliberately omits `raw` (arbitrary
 * user-supplied cells, no consumer in this phase), `idempotencyKey`,
 * `batch_id`, `project_id` and `expiresAt` — none of which the caller
 * needs and some of which are internal bookkeeping.
 */
function toApiRow(doc) {
  return {
    rowNumber: doc.rowNumber,
    normalized: doc.normalized ?? null,
    status: doc.status,
    errors: Array.isArray(doc.errors)
      ? doc.errors.map((e) => ({ field: e.field ?? null, code: e.code, message: e.message }))
      : [],
    publication_id: doc.publication_id ? doc.publication_id.toString() : null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Loads a batch ONLY if it exists AND belongs to `projectId`. Returns
 * `{ success: true, batch: <Mongoose document> }` (the raw doc, not an
 * API shape — internal callers need to mutate/save it) or
 * `{ success: false, error }`. The single ownership choke point every
 * other function here goes through.
 */
export async function getImportBatchForProject({ projectId, batchId }) {
  if (!batchId || !mongoose.Types.ObjectId.isValid(batchId)) {
    return { success: false, error: { code: 'INVALID_BATCH_ID', message: 'That import batch id is not valid.' } };
  }
  const doc = await SocialImportBatch.findById(batchId);
  if (!doc || doc.project_id.toString() !== String(projectId)) {
    return { success: false, error: { code: 'NOT_FOUND', message: 'That import batch was not found for this project.' } };
  }
  return { success: true, batch: doc };
}

/**
 * Creates a batch in the initial `parsing` state with zeroed counts.
 * `fileHash` / `filename` / `format` are all produced upstream by the
 * (future) upload handler — this only persists them. The partial unique
 * index on the model rejects a second in-flight batch for the same
 * project; that E11000 is surfaced as BULK_IMPORT_IN_PROGRESS rather
 * than thrown.
 */
export async function createImportBatch({ projectId, userId, filename, fileHash, format }) {
  if (!projectId || !userId) {
    return { success: false, error: { code: 'INVALID_BATCH', message: 'projectId and userId are required.' } };
  }
  if (!filename || !fileHash || !format) {
    return { success: false, error: { code: 'INVALID_BATCH', message: 'filename, fileHash and format are all required.' } };
  }
  if (!['csv', 'xlsx'].includes(format)) {
    return { success: false, error: { code: 'INVALID_FORMAT', message: 'format must be "csv" or "xlsx".' } };
  }

  try {
    const doc = await SocialImportBatch.create({
      project_id: projectId,
      createdBy: userId,
      filename,
      fileHash,
      format,
      status: 'parsing',
    });
    LoggerUtil.service('BulkImport', 'createBatch', 'completed', {
      projectId: String(projectId), batchId: doc._id.toString(), format,
    });
    return { success: true, batch: toApiBatch(doc) };
  } catch (error) {
    if (error?.code === 11000) {
      return {
        success: false,
        error: {
          code: 'BULK_IMPORT_IN_PROGRESS',
          message: 'A bulk import is already in progress for this project. Wait for it to finish before starting another.',
        },
      };
    }
    throw error;
  }
}

export async function getImportBatch({ projectId, batchId }) {
  const owned = await getImportBatchForProject({ projectId, batchId });
  if (!owned.success) return owned;
  return { success: true, batch: toApiBatch(owned.batch) };
}

/**
 * Paginated rows for a batch. `filters.status`, when given, must be one
 * of the row status enum values. Always project-scoped (through the
 * batch ownership check) and always bounded by MAX_PAGE_SIZE.
 */
export async function getImportRows({ projectId, batchId, filters = {} }) {
  const owned = await getImportBatchForProject({ projectId, batchId });
  if (!owned.success) return owned;

  const query = { batch_id: owned.batch._id };
  if (filters.status !== undefined && filters.status !== null && filters.status !== '') {
    if (!ROW_STATUSES.includes(filters.status)) {
      return { success: false, error: { code: 'INVALID_STATUS', message: `status must be one of: ${ROW_STATUSES.join(', ')}.` } };
    }
    query.status = filters.status;
  }

  const page = Math.max(1, parseInt(filters.page, 10) || 1);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(filters.limit, 10) || DEFAULT_PAGE_SIZE));

  const [docs, total] = await Promise.all([
    SocialImportRow.find(query).sort({ rowNumber: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    SocialImportRow.countDocuments(query),
  ]);

  const pages = Math.max(1, Math.ceil(total / limit));
  return {
    success: true,
    data: docs.map(toApiRow),
    pagination: { page, limit, total, pages, hasNext: page < pages, hasPrev: page > 1 },
  };
}

/**
 * Moves a batch to `status`, enforcing the transition table on
 * SocialImportBatch (canTransitionBatchStatus). A no-op (same status) is
 * allowed. `errorSummary` is only written when explicitly provided.
 */
export async function updateImportBatchStatus({ projectId, batchId, status, errorSummary }) {
  const owned = await getImportBatchForProject({ projectId, batchId });
  if (!owned.success) return owned;

  if (!BATCH_STATUSES.includes(status)) {
    return { success: false, error: { code: 'INVALID_STATUS', message: `status must be one of: ${BATCH_STATUSES.join(', ')}.` } };
  }
  if (!canTransitionBatchStatus(owned.batch.status, status)) {
    return {
      success: false,
      error: {
        code: 'INVALID_STATUS_TRANSITION',
        message: `Cannot move an import batch from "${owned.batch.status}" to "${status}".`,
      },
    };
  }

  owned.batch.status = status;
  if (errorSummary !== undefined) owned.batch.errorSummary = errorSummary;
  await owned.batch.save();
  LoggerUtil.service('BulkImport', 'updateStatus', 'completed', { batchId: owned.batch._id.toString(), status });
  return { success: true, batch: toApiBatch(owned.batch) };
}

/**
 * Merges non-negative numeric values into `counts` (and optionally
 * `rowCount`). Only the seven known count keys are accepted; anything
 * else is ignored. Rejects a non-finite / negative value rather than
 * silently coercing it.
 */
export async function updateImportBatchCounts({ projectId, batchId, counts = {}, rowCount }) {
  const owned = await getImportBatchForProject({ projectId, batchId });
  if (!owned.success) return owned;

  if (!owned.batch.counts) owned.batch.counts = {};

  for (const key of COUNT_KEYS) {
    if (counts[key] === undefined) continue;
    const n = Number(counts[key]);
    if (!Number.isFinite(n) || n < 0) {
      return { success: false, error: { code: 'INVALID_COUNTS', message: `counts.${key} must be a non-negative number.` } };
    }
    owned.batch.counts[key] = n;
  }
  if (rowCount !== undefined) {
    const n = Number(rowCount);
    if (!Number.isFinite(n) || n < 0) {
      return { success: false, error: { code: 'INVALID_COUNTS', message: 'rowCount must be a non-negative number.' } };
    }
    owned.batch.rowCount = n;
  }

  owned.batch.markModified('counts');
  await owned.batch.save();
  return { success: true, batch: toApiBatch(owned.batch) };
}

// ─────────────────────────────────────────────────────────────────────
// Phase 2 — file upload -> parse -> normalize -> validate -> store rows.
// Still NO SocialPublication creation, NO publishing, NO scheduling.
// ─────────────────────────────────────────────────────────────────────

/** The project's currently-connected account for a platform, or null. */
async function resolveActiveAccount(projectId, platform) {
  if (platform === 'facebook') return getActiveFacebookAccount(projectId);
  if (platform === 'instagram') return getActiveInstagramAccount(projectId);
  return null;
}

/**
 * Deterministic per-row key. Combines project + batch + source row with
 * the row's meaningful content so it is stable across retries of THIS
 * batch. Never exposed via the API; never a substitute for the DB
 * uniqueness guarantees (SocialImportRow `{batch_id,rowNumber}` unique
 * and SocialPublication `{importBatchId,importRowNumber}` partial unique).
 */
function buildIdempotencyKey({ projectId, batchId, rowNumber, normalized }) {
  const mediaKey = (normalized.media || []).map((m) => `${m.type}:${m.url}`).join(',');
  const schedKey = normalized.scheduledAt ? new Date(normalized.scheduledAt).toISOString() : '';
  const material = [
    String(projectId), String(batchId), String(rowNumber),
    normalized.platform || '', normalized.content || '', mediaKey,
    schedKey, normalized.timezone || '', normalized.action || '',
  ].join('|');
  return crypto.createHash('sha256').update(material).digest('hex');
}

async function failBatch(projectId, batchId, errorSummary) {
  try {
    await updateImportBatchStatus({ projectId, batchId, status: 'failed', errorSummary: errorSummary?.slice(0, 2000) ?? null });
  } catch (e) {
    LoggerUtil.error('[BULK_IMPORT] could not mark batch failed', { message: e.message }, { batchId });
  }
}

/**
 * Validates an uploaded CSV/XLSX: creates a SocialImportBatch, parses the
 * file, normalizes + validates every row, persists all rows (valid AND
 * invalid) and leaves the batch `ready` with accurate counts.
 *
 * A structurally broken file (bad CSV/XLSX, missing/duplicate/unknown
 * columns, too many rows/columns, oversized cell, empty) fails the whole
 * upload: the batch goes to `failed` with an `errorSummary` and this
 * returns `{ success: false, error, batchId }`. Individual invalid rows
 * do NOT fail the batch — they are stored with `status: 'invalid'` and
 * their `errors[]`, and the batch still becomes `ready`.
 *
 * @returns {Promise<
 *   | { success: true, batch, validation: { total, valid, invalid } }
 *   | { success: false, error: { code, message }, batchId?: string }
 * >}
 */
export async function validateUpload({ projectId, userId, file }) {
  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    return { success: false, error: { code: BULK_ERROR.EMPTY_FILE, message: 'No file was uploaded, or the file is empty.' } };
  }

  const filename = String(file.originalname || 'upload').slice(0, 512);
  if (filename.length > BULK_IMPORT_LIMITS.MAX_FILENAME_CHARS) {
    return { success: false, error: { code: BULK_ERROR.FILENAME_TOO_LONG, message: `Filename is too long (max ${BULK_IMPORT_LIMITS.MAX_FILENAME_CHARS} characters).` } };
  }
  const ext = path.extname(filename).toLowerCase();
  const format = ext === '.csv' ? 'csv' : ext === '.xlsx' ? 'xlsx' : null;
  if (!format) {
    return { success: false, error: { code: BULK_ERROR.UNSUPPORTED_FILE_TYPE, message: 'Only .csv or .xlsx files are supported.' } };
  }
  if (file.buffer.length > BULK_IMPORT_LIMITS.MAX_FILE_BYTES) {
    return { success: false, error: { code: BULK_ERROR.FILE_TOO_LARGE, message: `File is larger than ${BULK_IMPORT_LIMITS.MAX_FILE_BYTES / (1024 * 1024)} MB.` } };
  }

  const fileHash = crypto.createHash('sha256').update(file.buffer).digest('hex');

  // One active import per project. This pre-check is a fast, friendly
  // rejection; createImportBatch's E11000 handling on the partial unique
  // index is the real guarantee against a concurrent race. A historical
  // completed/failed/expired batch with the same hash never blocks a
  // fresh upload.
  const active = await SocialImportBatch.findOne({ project_id: projectId, status: { $in: ACTIVE_STATUSES } }).select('_id').lean();
  if (active) {
    return { success: false, error: { code: BULK_ERROR.BULK_IMPORT_IN_PROGRESS, message: 'A bulk import is already in progress for this project. Wait for it to finish.' } };
  }

  const created = await createImportBatch({ projectId, userId, filename, fileHash, format });
  if (!created.success) return { success: false, error: created.error };
  const batchId = created.batch.id;

  LoggerUtil.service('BulkImport', 'validate', 'started', {
    projectId: String(projectId), batchId, format, bytes: file.buffer.length,
  });

  try {
    // 1 ── parse
    const parsed = format === 'csv' ? parseCsv(file.buffer) : await parseXlsx(file.buffer);
    if (parsed.error) {
      await failBatch(projectId, batchId, parsed.error.message);
      return { success: false, error: parsed.error, batchId };
    }
    LoggerUtil.service('BulkImport', 'parse', 'completed', { batchId, rows: parsed.rows.length });

    // 2 ── headers
    const headerInfo = analyzeHeaders(parsed.headers);
    if (!headerInfo.ok) {
      const summary = headerInfo.errors.map((e) => e.message).join(' ');
      await failBatch(projectId, batchId, summary);
      return { success: false, error: { code: headerInfo.errors[0].code, message: summary }, batchId };
    }

    // 3 ── validating
    await updateImportBatchStatus({ projectId, batchId, status: 'validating' });

    // 4 ── account context: ONE lookup per supported platform, reused for every row
    const accounts = {};
    for (const platform of SUPPORTED_PLATFORMS) {
      accounts[platform] = { account: await resolveActiveAccount(projectId, platform) };
    }
    const context = { now: new Date(), accounts };

    // 5 ── normalize + validate every row
    const rowDocs = [];
    let valid = 0;
    let invalid = 0;
    for (const { rowNumber, cells } of parsed.rows) {
      const norm = normalizeRow(cells, headerInfo.columnIndex);
      const verdict = validateRow(norm, context);
      if (verdict.status === 'valid') valid += 1;
      else invalid += 1;
      rowDocs.push({
        batch_id: batchId,
        project_id: projectId,
        rowNumber,
        raw: norm.raw,
        normalized: norm.normalized,
        status: verdict.status,
        errors: verdict.errors,
        idempotencyKey: buildIdempotencyKey({ projectId, batchId, rowNumber, normalized: norm.normalized }),
      });
    }

    // 6 ── persist ALL rows (valid and invalid) in one write
    try {
      await SocialImportRow.insertMany(rowDocs, { ordered: false });
    } catch (persistErr) {
      LoggerUtil.error('[BULK_IMPORT] row insertMany failed', { message: persistErr.message }, { batchId });
      await failBatch(projectId, batchId, 'Could not store the parsed rows. Please try again.');
      return { success: false, error: { code: BULK_ERROR.ROW_PERSIST_FAILED, message: 'Could not store the parsed rows.' }, batchId };
    }

    // 7 ── counts + ready
    await updateImportBatchCounts({
      projectId,
      batchId,
      rowCount: rowDocs.length,
      counts: { total: rowDocs.length, valid, invalid, imported: 0, failed: 0, drafts: 0, scheduled: 0 },
    });
    const ready = await updateImportBatchStatus({ projectId, batchId, status: 'ready' });

    LoggerUtil.service('BulkImport', 'validate', 'completed', {
      projectId: String(projectId), batchId, total: rowDocs.length, valid, invalid,
    });

    return { success: true, batch: ready.batch, validation: { total: rowDocs.length, valid, invalid } };
  } catch (err) {
    LoggerUtil.error('[BULK_IMPORT] validate failed unexpectedly', { message: err.message }, { batchId });
    await failBatch(projectId, batchId, 'Bulk validation failed unexpectedly.');
    return { success: false, error: { code: BULK_ERROR.INVALID_FILE, message: 'Bulk validation failed unexpectedly.' }, batchId };
  }
}

/**
 * Phase 3 — the error-report CSV for a batch: every row whose status is
 * `invalid` (Phase 2) or `failed` (Phase 3 import). Ownership-checked.
 * `imported` and un-attempted `valid` rows are excluded. Every cell is
 * formula-injection-escaped by buildErrorReportCsv / csvCell.
 */
export async function buildBatchErrorReport({ projectId, batchId }) {
  const owned = await getImportBatchForProject({ projectId, batchId });
  if (!owned.success) return owned;

  const rows = await SocialImportRow.find({ batch_id: owned.batch._id, status: { $in: ['invalid', 'failed'] } })
    .sort({ rowNumber: 1 })
    .select('rowNumber status normalized raw errors')
    .lean();

  return { success: true, csv: buildErrorReportCsv(rows), rowCount: rows.length };
}

export {
  // Phase 2 CSV template (implementation moved to bulkImport/bulkImportCsv.js).
  buildTemplateCsv,
  // Phase 3 executor (implementation in bulkImport/bulkImportExecutor.js).
  importValidatedBatch,
};

export default {
  createImportBatch,
  getImportBatch,
  getImportBatchForProject,
  getImportRows,
  updateImportBatchStatus,
  updateImportBatchCounts,
  validateUpload,
  buildTemplateCsv,
  importValidatedBatch,
  buildBatchErrorReport,
};
