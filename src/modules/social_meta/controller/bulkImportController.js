import {
  getImportBatch, getImportRows, validateUpload, buildTemplateCsv,
  importValidatedBatch, buildBatchErrorReport,
} from '../service/bulkImportService.js';
import { STATUSES as ROW_STATUSES } from '../model/SocialImportRow.js';
import { BULK_ERROR } from '../service/bulkImport/bulkImportConstants.js';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * BulkImportController — HTTP only. No DB access, no business logic (all
 * of that is bulkImportService.js). Every route is mounted behind auth +
 * validateProjectAccess() (see routes/socialPublishingRoutes.js), which
 * sets req.projectId — the ONLY source of project identity this
 * controller trusts. The batch id route param is `:batchId` (never
 * `:id`, never `:publicationId`) so it can never be confused with the
 * project id or a publication id by validateProjectAccess()'s own
 * `req.params.id` lookup.
 *
 * Phase 1: read/status endpoints only. The validate, import, template
 * and upload endpoints are later phases.
 */

const ERROR_STATUS = {
  INVALID_BATCH_ID: 400,
  INVALID_STATUS: 400,
  NOT_FOUND: 404,
  [BULK_ERROR.BULK_IMPORT_IN_PROGRESS]: 409,
  [BULK_ERROR.FILE_TOO_LARGE]: 413,
  // Phase 3 import
  [BULK_ERROR.INVALID_MODE]: 400,
  [BULK_ERROR.IMPORT_BATCH_NOT_READY]: 409,
  [BULK_ERROR.IMPORT_ALREADY_IN_PROGRESS]: 409,
  [BULK_ERROR.IMPORT_BATCH_FAILED]: 409,
  [BULK_ERROR.IMPORT_BATCH_EXPIRED]: 409,
  [BULK_ERROR.IMPORT_FAILED]: 500,
};

function statusFor(code) {
  return ERROR_STATUS[code] || 400;
}

/**
 * GET /api/social/publishing/bulk-upload/:batchId
 * Returns a safe projection of the batch (never the raw document).
 */
export async function getBulkImportBatchHandler(req, res) {
  const projectId = req.projectId;
  const { batchId } = req.params;
  try {
    const result = await getImportBatch({ projectId, batchId });
    if (!result.success) {
      const status = statusFor(result.error.code);
      return res.status(status).json(ResponseUtil.error(result.error.message, status, { code: result.error.code }));
    }
    return res.json(ResponseUtil.success({ batch: result.batch }));
  } catch (error) {
    LoggerUtil.error('[BULK_IMPORT] Failed to load import batch', { message: error.message }, { projectId, batchId });
    return res.status(500).json(ResponseUtil.error('Failed to load that import batch', 500, { code: 'BULK_IMPORT_BATCH_GET_FAILED' }));
  }
}

/**
 * GET /api/social/publishing/bulk-upload/:batchId/rows
 * Query: status (row status enum), page, limit. Always paginated,
 * always project-scoped, `raw` is never exposed.
 */
export async function getBulkImportRowsHandler(req, res) {
  const projectId = req.projectId;
  const { batchId } = req.params;
  const { status, page, limit } = req.query;

  if (status !== undefined && status !== '' && !ROW_STATUSES.includes(status)) {
    return res.status(400).json(ResponseUtil.error('Invalid row status filter', 400, { code: 'INVALID_STATUS' }));
  }

  try {
    const result = await getImportRows({ projectId, batchId, filters: { status, page, limit } });
    if (!result.success) {
      const s = statusFor(result.error.code);
      return res.status(s).json(ResponseUtil.error(result.error.message, s, { code: result.error.code }));
    }
    return res.json(ResponseUtil.paginated(result.data, result.pagination));
  } catch (error) {
    LoggerUtil.error('[BULK_IMPORT] Failed to load import rows', { message: error.message }, { projectId, batchId });
    return res.status(500).json(ResponseUtil.error('Failed to load import rows', 500, { code: 'BULK_IMPORT_ROWS_GET_FAILED' }));
  }
}

/**
 * POST /api/social/publishing/bulk-upload/validate
 * multipart/form-data, single `file` field. Parses + validates a CSV/XLSX
 * and stores the row-by-row preview. Never creates a SocialPublication.
 *
 * A structurally broken file → 4xx with the file-level error code (the
 * failed batch id is still returned so the client can GET it). A
 * structurally valid file with some invalid rows → 201 with the `ready`
 * batch and a `{ total, valid, invalid }` summary.
 */
export async function validateBulkImportHandler(req, res) {
  const projectId = req.projectId;
  const userId = req.userId;

  if (!req.file) {
    return res.status(400).json(ResponseUtil.error('No file was uploaded. Send it as multipart/form-data in the "file" field.', 400, { code: BULK_ERROR.INVALID_FILE }));
  }

  try {
    const result = await validateUpload({ projectId, userId, file: req.file });

    if (!result.success) {
      // statusFor() already maps BULK_IMPORT_IN_PROGRESS -> 409 and
      // FILE_TOO_LARGE -> 413; every other file-/row-level code is a 400.
      const status = statusFor(result.error.code);
      return res.status(status).json(ResponseUtil.error(result.error.message, status, {
        code: result.error.code,
        // The failed batch id is still handed back for a file-level
        // failure so the client can GET /bulk-upload/:batchId for detail.
        ...(result.batchId ? { batchId: result.batchId } : {}),
      }));
    }

    return res.status(201).json(ResponseUtil.success({ batch: result.batch, validation: result.validation }));
  } catch (error) {
    LoggerUtil.error('[BULK_IMPORT] validate handler failed', { message: error.message }, { projectId });
    return res.status(500).json(ResponseUtil.error('Failed to validate the uploaded file', 500, { code: 'BULK_IMPORT_VALIDATE_FAILED' }));
  }
}

/**
 * GET /api/social/publishing/bulk-upload/template
 * Downloadable CSV template. Contains no credentials or project data;
 * every cell is literal, formula-injection-safe text.
 */
export function getBulkImportTemplateHandler(req, res) {
  const csv = buildTemplateCsv();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="odito-bulk-upload-template.csv"');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(csv);
}

/**
 * POST /api/social/publishing/bulk-upload/:batchId/import
 * body: { projectId, mode: 'valid-only' | 'all-as-draft' }
 *
 * Turns a READY batch's valid rows into real SocialPublication records
 * (draft / scheduled / immediately-due scheduled for `publish`). NEVER
 * calls Meta. Idempotent — a repeat call on a completed batch replays
 * the stored result.
 */
export async function importBulkUploadHandler(req, res) {
  const projectId = req.projectId;
  const userId = req.userId;
  const { batchId } = req.params;
  const { mode } = req.body || {};

  try {
    const result = await importValidatedBatch({ projectId, userId, batchId, mode });
    if (!result.success) {
      const status = statusFor(result.error.code);
      return res.status(status).json(ResponseUtil.error(result.error.message, status, {
        code: result.error.code,
        ...(result.batchId ? { batchId: result.batchId } : {}),
      }));
    }
    // 200 (not 201): the import operation completed. `replay: true` means
    // this was an idempotent replay of an already-completed batch (no new
    // records created) — additive, purely informational for the client's
    // "already imported" messaging; a fresh run omits it / sends false.
    return res.status(200).json(ResponseUtil.success({
      batch: result.batch,
      result: result.result,
      schedulerEnabled: result.schedulerEnabled,
      warnings: result.warnings || [],
      rows: result.rows || [],
      replay: result.replay === true,
    }));
  } catch (error) {
    LoggerUtil.error('[BULK_IMPORT] import handler failed', { message: error.message }, { projectId, batchId });
    return res.status(500).json(ResponseUtil.error('Failed to run the import', 500, { code: 'BULK_IMPORT_RUN_FAILED' }));
  }
}

/**
 * GET /api/social/publishing/bulk-upload/:batchId/errors?format=csv
 * Downloadable CSV of every invalid (Phase 2) / failed (Phase 3) row.
 * Ownership re-checked in the service. No raw / idempotencyKey /
 * fileHash. Every cell formula-injection-escaped.
 */
export async function getBulkImportErrorsHandler(req, res) {
  const projectId = req.projectId;
  const { batchId } = req.params;
  const format = String(req.query.format || 'csv').toLowerCase();

  if (format !== 'csv') {
    return res.status(400).json(ResponseUtil.error('Only format=csv is supported.', 400, { code: 'UNSUPPORTED_FORMAT' }));
  }

  try {
    const result = await buildBatchErrorReport({ projectId, batchId });
    if (!result.success) {
      const status = statusFor(result.error.code);
      return res.status(status).json(ResponseUtil.error(result.error.message, status, { code: result.error.code }));
    }
    // filename uses only the Mongo batch id (hex) — never the
    // user-supplied upload filename.
    const safeBatchId = String(batchId).replace(/[^a-f0-9]/gi, '').slice(0, 32) || 'batch';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="odito-bulk-upload-errors-${safeBatchId}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(result.csv);
  } catch (error) {
    LoggerUtil.error('[BULK_IMPORT] error-report handler failed', { message: error.message }, { projectId, batchId });
    return res.status(500).json(ResponseUtil.error('Failed to build the error report', 500, { code: 'BULK_IMPORT_ERROR_REPORT_FAILED' }));
  }
}

export default {
  getBulkImportBatchHandler,
  getBulkImportRowsHandler,
  validateBulkImportHandler,
  getBulkImportTemplateHandler,
  importBulkUploadHandler,
  getBulkImportErrorsHandler,
};
