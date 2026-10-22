import { LoggerUtil } from '../../../../utils/LoggerUtil.js';

/**
 * Bulk Upload — Phase 5 real-time progress emitter.
 *
 * Reuses the EXISTING Socket.IO plumbing (global.io + the
 * `project-<projectId>` room the frontend already joins via
 * `join-project`) — same convention as auditProgressService.js's
 * verification:* / google_ads_sync:* event groups. No new namespace, no
 * second socket server, no per-batch rooms.
 *
 * Events (project/batch-scoped):
 *   bulk-import:started    — an import claimed a batch and began
 *   bulk-import:progress   — one row processed
 *   bulk-import:completed   — the batch reached `completed` (or replayed)
 *   bulk-import:error      — the import was interrupted / failed
 *
 * PAYLOADS CARRY OPERATIONAL METADATA ONLY: ids + counts + row number +
 * status. Never content, media URLs, tokens, credentials, raw upload
 * data, file hashes, or exception stacks. Events are emitted only from
 * bulkImportExecutor (the authoritative execution path) and the stale
 * sweeper — never fabricated elsewhere.
 */

export const BULK_IMPORT_EVENTS = Object.freeze({
  STARTED: 'bulk-import:started',
  PROGRESS: 'bulk-import:progress',
  COMPLETED: 'bulk-import:completed',
  ERROR: 'bulk-import:error',
});

function projectRoom(projectId) {
  return `project-${projectId}`;
}

function emit(projectId, event, payload) {
  const io = global.io;
  if (!io) {
    LoggerUtil.warn(`[BULK_IMPORT_EVENTS] ${event} dropped — Socket.IO not available`, { projectId: String(projectId) });
    return false;
  }
  io.to(projectRoom(projectId)).emit(event, {
    ...payload,
    projectId: String(projectId),
    timestamp: new Date(),
  });
  return true;
}

const ZERO = { processed: 0, attempted: 0, imported: 0, failed: 0, drafts: 0, scheduled: 0 };

export function emitBulkImportStarted({ projectId, batchId, total = 0, mode = null }) {
  return emit(projectId, BULK_IMPORT_EVENTS.STARTED, {
    batchId: String(batchId),
    status: 'importing',
    total,
    currentRowNumber: null,
    mode: mode || null,
    ...ZERO,
  });
}

export function emitBulkImportProgress({
  projectId, batchId, total,
  processed, attempted, imported, failed, drafts, scheduled,
  currentRowNumber,
}) {
  return emit(projectId, BULK_IMPORT_EVENTS.PROGRESS, {
    batchId: String(batchId),
    status: 'importing',
    total: total ?? 0,
    processed: processed ?? 0,
    attempted: attempted ?? 0,
    imported: imported ?? 0,
    failed: failed ?? 0,
    drafts: drafts ?? 0,
    scheduled: scheduled ?? 0,
    currentRowNumber: currentRowNumber ?? null,
  });
}

export function emitBulkImportCompleted({ projectId, batchId, total = 0, result = {}, replay = false }) {
  return emit(projectId, BULK_IMPORT_EVENTS.COMPLETED, {
    batchId: String(batchId),
    status: 'completed',
    replay: replay === true,
    total,
    processed: total,
    attempted: result.attempted ?? 0,
    imported: result.imported ?? 0,
    failed: result.failed ?? 0,
    drafts: result.drafts ?? 0,
    scheduled: result.scheduled ?? 0,
    currentRowNumber: null,
  });
}

/**
 * `message` MUST be a fixed, safe, user-facing string chosen by the
 * caller — never `err.message` from a caught exception.
 */
export function emitBulkImportError({ projectId, batchId, code = 'IMPORT_FAILED', message = 'The import could not be completed. It is safe to retry.' }) {
  return emit(projectId, BULK_IMPORT_EVENTS.ERROR, {
    batchId: String(batchId),
    status: 'error',
    code,
    message,
  });
}

export default {
  BULK_IMPORT_EVENTS,
  emitBulkImportStarted,
  emitBulkImportProgress,
  emitBulkImportCompleted,
  emitBulkImportError,
};
