import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import VerificationBatch from './VerificationBatch.js';
import { BATCH_STATUS, BATCH_STATUSES } from '../constants/batchStatus.js';

// F4-012: Verification Batch infrastructure — schema/validation/defaults/
// statics only. Nothing here is wired into any controller, service,
// chainingEngine, worker, or websocket path yet (that's F4-011 Phase 2+).
//
// Same two-tier pattern as PageVerificationRun.test.js: in-memory
// .validate() tests need no DB connection; index/statics-against-real-data
// tests need live MongoDB, auto-skipping rather than failing the suite.

const PROJECT_A = new mongoose.Types.ObjectId();
const PROJECT_B = new mongoose.Types.ObjectId();

function batch(overrides = {}) {
  return new VerificationBatch({
    batchId: 'batch-' + Math.random().toString(36).slice(2),
    projectId: PROJECT_A,
    urls: ['https://example.com/a', 'https://example.com/b'],
    totalUrls: 2,
    ...overrides,
  });
}

describe('VerificationBatch schema — required/optional/defaults/enum', () => {
  test('accepts a minimal valid document (only required fields)', async () => {
    const doc = batch();
    await assert.doesNotReject(() => doc.validate());
  });

  test('required: batchId missing is rejected', async () => {
    const doc = batch({ batchId: undefined });
    await assert.rejects(() => doc.validate());
  });

  test('required: projectId missing is rejected', async () => {
    const doc = batch({ projectId: undefined });
    await assert.rejects(() => doc.validate());
  });

  test('required: urls missing is rejected', async () => {
    const doc = batch({ urls: undefined });
    await assert.rejects(() => doc.validate());
  });

  test('urls must be non-empty — an empty array is rejected', async () => {
    const doc = batch({ urls: [] });
    await assert.rejects(() => doc.validate());
  });

  test('required: totalUrls missing is rejected', async () => {
    const doc = batch({ totalUrls: undefined });
    await assert.rejects(() => doc.validate());
  });

  test('totalUrls rejects a negative number', async () => {
    const doc = batch({ totalUrls: -1 });
    await assert.rejects(() => doc.validate());
  });

  test('status defaults to "pending" (BATCH_STATUS.PENDING)', async () => {
    const doc = batch();
    assert.equal(doc.status, BATCH_STATUS.PENDING);
    assert.equal(doc.status, 'pending');
  });

  test('status enum accepts every documented BATCH_STATUSES value', async () => {
    for (const status of BATCH_STATUSES) {
      const doc = batch({ status });
      await assert.doesNotReject(() => doc.validate());
    }
  });

  test('status enum rejects an undocumented value', async () => {
    const doc = batch({ status: 'bogus' });
    await assert.rejects(() => doc.validate());
  });

  test('completedUrls/failedUrls default to 0 and reject negative values', async () => {
    const doc = batch();
    assert.equal(doc.completedUrls, 0);
    assert.equal(doc.failedUrls, 0);

    const negative = batch({ completedUrls: -1 });
    await assert.rejects(() => negative.validate());
  });

  test('optional date fields (startedAt/completedAt/aggregateStartedAt/aggregateCompletedAt) default to null', () => {
    const doc = batch();
    assert.equal(doc.startedAt, null);
    assert.equal(doc.completedAt, null);
    assert.equal(doc.aggregateStartedAt, null);
    assert.equal(doc.aggregateCompletedAt, null);
  });

  test('optional: errorMessage and createdBy default to null', () => {
    const doc = batch();
    assert.equal(doc.errorMessage, null);
    assert.equal(doc.createdBy, null);
  });

  test('collection name is verification_batches', () => {
    assert.equal(VerificationBatch.collection.name, 'verification_batches');
  });

  test('createdAt/updatedAt timestamps exist (mutable document, unlike PageVerificationRun)', () => {
    const doc = batch();
    // Mongoose only stamps these on save, but the schema option itself is
    // what we're proving is configured correctly.
    assert.equal(VerificationBatch.schema.options.timestamps.createdAt, 'createdAt');
    assert.equal(VerificationBatch.schema.options.timestamps.updatedAt, 'updatedAt');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Live-Mongo tests. Auto-skip if MongoDB is unreachable.

let mongoAvailable = false;

before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch {
    mongoAvailable = false;
  }
});

after(async () => {
  if (mongoAvailable) {
    await mongoose.connection.close();
  }
});

afterEach(async () => {
  if (mongoAvailable) {
    await VerificationBatch.deleteMany({ projectId: { $in: [PROJECT_A, PROJECT_B] } });
  }
});

describe('VerificationBatch indexes (live Mongo, auto-skip)', () => {
  test('all three approved indexes exist with the expected keys', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await VerificationBatch.syncIndexes();
    const indexes = await VerificationBatch.collection.indexes();

    const batchIdIdx = indexes.find((i) => i.key.batchId === 1 && Object.keys(i.key).length === 1);
    assert.ok(batchIdIdx, 'unique batchId index must exist');
    assert.equal(batchIdIdx.unique, true);

    const activeIdx = indexes.find((i) => i.key.projectId === 1 && i.key.status === 1);
    assert.ok(activeIdx, 'projectId+status index must exist');

    const historyIdx = indexes.find(
      (i) => i.key.projectId === 1 && i.key.createdAt === -1 && !('status' in i.key)
    );
    assert.ok(historyIdx, 'projectId+createdAt index must exist');
  });

  test('duplicate batchId is rejected (one document per batch)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await VerificationBatch.syncIndexes();

    const sharedBatchId = 'batch-dup-' + Date.now();
    await batch({ batchId: sharedBatchId }).save();
    await assert.rejects(
      () => batch({ batchId: sharedBatchId, projectId: PROJECT_B }).save(),
      (err) => err.code === 11000
    );
  });
});

describe('VerificationBatch statics (live Mongo, auto-skip) — infrastructure only, no orchestration logic', () => {
  test('createBatch() derives totalUrls from urls.length', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const doc = await VerificationBatch.createBatch({
      batchId: 'batch-create-' + Date.now(),
      projectId: PROJECT_A,
      urls: ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'],
    });

    assert.equal(doc.totalUrls, 3);
    assert.equal(doc.status, BATCH_STATUS.PENDING);
  });

  test('findBatch() looks up by batchId', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const batchId = 'batch-find-' + Date.now();
    await VerificationBatch.createBatch({ batchId, projectId: PROJECT_A, urls: ['https://example.com/a'] });

    const found = await VerificationBatch.findBatch(batchId);
    assert.ok(found);
    assert.equal(found.batchId, batchId);
  });

  test('findBatch() returns null for an unknown batchId', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const found = await VerificationBatch.findBatch('does-not-exist');
    assert.equal(found, null);
  });

  test('updateBatch() applies a partial update and returns the updated document', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const batchId = 'batch-update-' + Date.now();
    await VerificationBatch.createBatch({ batchId, projectId: PROJECT_A, urls: ['https://example.com/a'] });

    const updated = await VerificationBatch.updateBatch(batchId, { status: BATCH_STATUS.RUNNING, completedUrls: 1 });
    assert.equal(updated.status, BATCH_STATUS.RUNNING);
    assert.equal(updated.completedUrls, 1);
  });

  test('findActiveBatch() finds a PENDING/RUNNING/AGGREGATING batch but not a COMPLETED one', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const activeId = 'batch-active-' + Date.now();
    const doneId = 'batch-done-' + Date.now();
    await VerificationBatch.createBatch({ batchId: activeId, projectId: PROJECT_A, urls: ['https://example.com/a'] });
    await VerificationBatch.createBatch({ batchId: doneId, projectId: PROJECT_B, urls: ['https://example.com/b'] });
    await VerificationBatch.updateBatch(doneId, { status: BATCH_STATUS.COMPLETED });

    const activeForA = await VerificationBatch.findActiveBatch(PROJECT_A);
    assert.equal(activeForA.batchId, activeId);

    const activeForB = await VerificationBatch.findActiveBatch(PROJECT_B);
    assert.equal(activeForB, null);
  });
});

describe('F4-018: VerificationBatch status-transition validation (live Mongo, auto-skip)', () => {
  function captureConsoleError() {
    const original = console.error;
    const messages = [];
    console.error = (...args) => messages.push(args.join(' '));
    return { messages, restore: () => { console.error = original; } };
  }

  test('legal transitions (PENDING -> RUNNING -> AGGREGATING -> COMPLETED) log nothing via findOneAndUpdate', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batchId = 'batch-legal-' + Date.now();
    await VerificationBatch.createBatch({ batchId, projectId: PROJECT_A, urls: ['https://example.com/a'] });

    const capture = captureConsoleError();
    try {
      await VerificationBatch.findOneAndUpdate({ batchId, status: BATCH_STATUS.PENDING }, { $set: { status: BATCH_STATUS.RUNNING } });
      await VerificationBatch.findOneAndUpdate({ batchId, status: BATCH_STATUS.RUNNING }, { $set: { status: BATCH_STATUS.AGGREGATING } });
      await VerificationBatch.findOneAndUpdate({ batchId, status: BATCH_STATUS.AGGREGATING }, { $set: { status: BATCH_STATUS.COMPLETED } });
    } finally {
      capture.restore();
    }

    assert.equal(capture.messages.filter((m) => m.includes('Invalid status transition')).length, 0);
    const final = await VerificationBatch.findBatch(batchId);
    assert.equal(final.status, BATCH_STATUS.COMPLETED);
  });

  test('PENDING -> FAILED (zero URLs dispatched) is a legal transition, not flagged', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batchId = 'batch-pending-failed-' + Date.now();
    await VerificationBatch.createBatch({ batchId, projectId: PROJECT_A, urls: ['https://example.com/a'] });

    const capture = captureConsoleError();
    try {
      await VerificationBatch.findOneAndUpdate({ batchId }, { $set: { status: BATCH_STATUS.FAILED } });
    } finally {
      capture.restore();
    }

    assert.equal(capture.messages.filter((m) => m.includes('Invalid status transition')).length, 0);
  });

  test('an illegal transition (COMPLETED -> RUNNING) is logged but NOT rejected — corrupted state is surfaced, not silently repaired', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batchId = 'batch-illegal-' + Date.now();
    await VerificationBatch.createBatch({ batchId, projectId: PROJECT_A, urls: ['https://example.com/a'] });
    await VerificationBatch.findOneAndUpdate({ batchId }, { $set: { status: BATCH_STATUS.COMPLETED } });

    const capture = captureConsoleError();
    let updated;
    try {
      updated = await VerificationBatch.findOneAndUpdate({ batchId }, { $set: { status: BATCH_STATUS.RUNNING } }, { new: true });
    } finally {
      capture.restore();
    }

    const invalidLog = capture.messages.find((m) => m.includes('Invalid status transition'));
    assert.ok(invalidLog, 'an illegal transition must be logged');
    assert.ok(invalidLog.includes('from=completed'));
    assert.ok(invalidLog.includes('to=running'));

    // Not silently repaired: the write is NOT blocked — the document really
    // does end up RUNNING, exactly as requested. Validation observes and
    // logs; it never overrides the caller's own intent.
    assert.equal(updated.status, BATCH_STATUS.RUNNING);
  });

  test('a terminal status (COMPLETED/PARTIAL/FAILED) has no further legal transitions', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batchId = 'batch-terminal-' + Date.now();
    await VerificationBatch.createBatch({ batchId, projectId: PROJECT_A, urls: ['https://example.com/a'] });
    await VerificationBatch.findOneAndUpdate({ batchId }, { $set: { status: BATCH_STATUS.PARTIAL } });

    const capture = captureConsoleError();
    try {
      await VerificationBatch.findOneAndUpdate({ batchId }, { $set: { status: BATCH_STATUS.AGGREGATING } });
    } finally {
      capture.restore();
    }

    assert.ok(capture.messages.some((m) => m.includes('Invalid status transition') && m.includes('from=partial')));
  });

  test('a no-op update (same status re-written) is not flagged as a transition at all', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batchId = 'batch-noop-' + Date.now();
    await VerificationBatch.createBatch({ batchId, projectId: PROJECT_A, urls: ['https://example.com/a'] });

    const capture = captureConsoleError();
    try {
      await VerificationBatch.findOneAndUpdate({ batchId }, { $set: { status: BATCH_STATUS.PENDING } });
    } finally {
      capture.restore();
    }

    assert.equal(capture.messages.filter((m) => m.includes('Invalid status transition')).length, 0);
  });

  test('an update with no status field at all is untouched by the validation hook', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batchId = 'batch-no-status-change-' + Date.now();
    await VerificationBatch.createBatch({ batchId, projectId: PROJECT_A, urls: ['https://example.com/a'] });

    const capture = captureConsoleError();
    let updated;
    try {
      updated = await VerificationBatch.findOneAndUpdate({ batchId }, { $set: { completedUrls: 1 } }, { new: true });
    } finally {
      capture.restore();
    }

    assert.equal(capture.messages.length, 0);
    assert.equal(updated.completedUrls, 1);
    assert.equal(updated.status, BATCH_STATUS.PENDING);
  });
});
