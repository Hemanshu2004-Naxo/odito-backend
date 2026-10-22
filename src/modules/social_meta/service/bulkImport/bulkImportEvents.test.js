import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  BULK_IMPORT_EVENTS,
  emitBulkImportStarted, emitBulkImportProgress, emitBulkImportCompleted, emitBulkImportError,
} from './bulkImportEvents.js';

/**
 * Bulk Upload — Phase 5. Real-time event emitter. Pure: a fake `global.io`
 * captures what would be sent to the `project-<id>` room.
 */

let sent;
let originalIo;

function fakeIo() {
  return {
    to(room) {
      return {
        emit(event, payload) {
          sent.push({ room, event, payload });
        },
      };
    },
  };
}

beforeEach(() => {
  sent = [];
  originalIo = global.io;
  global.io = fakeIo();
});

afterEach(() => {
  global.io = originalIo;
});

// Anything that could carry user content / secrets must never appear.
const FORBIDDEN_KEYS = ['content', 'media', 'mediaUrls', 'media_urls', 'url', 'raw', 'fileHash', 'token', 'accessToken', 'idempotencyKey', 'stack'];

function assertSafe(payload) {
  const json = JSON.stringify(payload);
  for (const k of FORBIDDEN_KEYS) {
    assert.equal(json.includes(`"${k}"`), false, `payload must not contain "${k}"`);
  }
}

describe('bulkImportEvents — payload contract', () => {
  test('started: correct event, project room, operational fields only', () => {
    emitBulkImportStarted({ projectId: 'p1', batchId: 'b1', total: 12, mode: 'valid-only' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].room, 'project-p1');
    assert.equal(sent[0].event, BULK_IMPORT_EVENTS.STARTED);
    const p = sent[0].payload;
    assert.equal(p.projectId, 'p1');
    assert.equal(p.batchId, 'b1');
    assert.equal(p.status, 'importing');
    assert.equal(p.total, 12);
    assert.equal(p.mode, 'valid-only');
    assert.equal(p.imported, 0);
    assert.ok(p.timestamp instanceof Date);
    assertSafe(p);
  });

  test('progress: carries the running counters + current row number, nothing else', () => {
    emitBulkImportProgress({
      projectId: 'p1', batchId: 'b1', total: 100,
      processed: 37, attempted: 35, imported: 30, failed: 5, drafts: 20, scheduled: 10,
      currentRowNumber: 38,
    });
    const p = sent[0].payload;
    assert.equal(sent[0].event, BULK_IMPORT_EVENTS.PROGRESS);
    assert.deepEqual(
      { processed: p.processed, attempted: p.attempted, imported: p.imported, failed: p.failed, drafts: p.drafts, scheduled: p.scheduled, currentRowNumber: p.currentRowNumber, total: p.total },
      { processed: 37, attempted: 35, imported: 30, failed: 5, drafts: 20, scheduled: 10, currentRowNumber: 38, total: 100 },
    );
    assertSafe(p);
  });

  test('completed: status completed, replay flag, final counts', () => {
    emitBulkImportCompleted({ projectId: 'p1', batchId: 'b1', total: 8, result: { attempted: 8, imported: 7, failed: 1, drafts: 5, scheduled: 2 }, replay: true });
    const p = sent[0].payload;
    assert.equal(sent[0].event, BULK_IMPORT_EVENTS.COMPLETED);
    assert.equal(p.status, 'completed');
    assert.equal(p.replay, true);
    assert.equal(p.imported, 7);
    assert.equal(p.failed, 1);
    assertSafe(p);
  });

  test('error: fixed safe message + code, never an exception message', () => {
    emitBulkImportError({ projectId: 'p1', batchId: 'b1', code: 'IMPORT_FAILED', message: 'The import could not be completed. It is safe to retry.' });
    const p = sent[0].payload;
    assert.equal(sent[0].event, BULK_IMPORT_EVENTS.ERROR);
    assert.equal(p.status, 'error');
    assert.equal(p.code, 'IMPORT_FAILED');
    assert.match(p.message, /safe to retry/);
    assertSafe(p);
  });

  test('two different projects get isolated rooms', () => {
    emitBulkImportProgress({ projectId: 'pA', batchId: 'bA', total: 1, processed: 1, attempted: 1, imported: 1, failed: 0, drafts: 1, scheduled: 0, currentRowNumber: 1 });
    emitBulkImportProgress({ projectId: 'pB', batchId: 'bB', total: 1, processed: 1, attempted: 1, imported: 1, failed: 0, drafts: 1, scheduled: 0, currentRowNumber: 1 });
    assert.deepEqual(sent.map((s) => s.room), ['project-pA', 'project-pB']);
  });

  test('no Socket.IO available → emit is a safe no-op, never throws', () => {
    global.io = null;
    assert.doesNotThrow(() => emitBulkImportStarted({ projectId: 'p1', batchId: 'b1', total: 1 }));
    assert.equal(emitBulkImportProgress({ projectId: 'p1', batchId: 'b1' }), false);
  });
});
