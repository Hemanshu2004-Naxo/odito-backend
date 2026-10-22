import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SocialImportBatch, {
  canTransitionBatchStatus, FORMATS, STATUSES, ACTIVE_STATUSES, IMPORT_MODES,
} from './SocialImportBatch.js';

/**
 * Bulk Upload — Phase 1 (backend foundation). SocialImportBatch schema /
 * defaults / enums / status-transition helper (in-memory, no DB) plus
 * index guarantees (live MongoDB, auto-skip). Same two-tier pattern as
 * VerificationBatch.test.js. Nothing here is wired into any controller,
 * parser, validator or importer yet — those are later phases.
 */

const PROJECT_A = new mongoose.Types.ObjectId();
const PROJECT_B = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();

function batch(overrides = {}) {
  return new SocialImportBatch({
    project_id: PROJECT_A,
    createdBy: USER,
    filename: 'posts.csv',
    fileHash: 'a'.repeat(64),
    format: 'csv',
    ...overrides,
  });
}

describe('SocialImportBatch schema — required / defaults / enums', () => {
  test('accepts a minimal valid document (only required fields)', async () => {
    await assert.doesNotReject(() => batch().validate());
  });

  for (const field of ['project_id', 'createdBy', 'filename', 'fileHash', 'format']) {
    test(`required: ${field} missing is rejected`, async () => {
      await assert.rejects(() => batch({ [field]: undefined }).validate());
    });
  }

  test('format enum accepts every FORMATS value and rejects others', async () => {
    for (const format of FORMATS) {
      await assert.doesNotReject(() => batch({ format }).validate());
    }
    await assert.rejects(() => batch({ format: 'json' }).validate());
  });

  test('status defaults to "parsing" and the enum accepts every STATUSES value', async () => {
    assert.equal(batch().status, 'parsing');
    for (const status of STATUSES) {
      await assert.doesNotReject(() => batch({ status }).validate());
    }
    await assert.rejects(() => batch({ status: 'bogus' }).validate());
  });

  test('counts defaults to every key at 0', () => {
    const c = batch().counts;
    assert.equal(c.total, 0);
    assert.equal(c.valid, 0);
    assert.equal(c.invalid, 0);
    assert.equal(c.imported, 0);
    assert.equal(c.failed, 0);
    assert.equal(c.drafts, 0);
    assert.equal(c.scheduled, 0);
  });

  test('counts reject a negative value', async () => {
    await assert.rejects(() => batch({ counts: { valid: -1 } }).validate());
  });

  test('rowCount defaults to 0 and rejects a negative value', async () => {
    assert.equal(batch().rowCount, 0);
    await assert.rejects(() => batch({ rowCount: -5 }).validate());
  });

  test('errorSummary and importMode default to null', () => {
    const doc = batch();
    assert.equal(doc.errorSummary, null);
    assert.equal(doc.importMode, null);
  });

  test('importMode enum accepts every IMPORT_MODES value and rejects others', async () => {
    for (const mode of IMPORT_MODES) {
      await assert.doesNotReject(() => batch({ importMode: mode }).validate());
    }
    await assert.rejects(() => batch({ importMode: 'everything' }).validate());
  });

  test('collection name is socialimportbatches and timestamps are configured', () => {
    assert.equal(SocialImportBatch.collection.name, 'socialimportbatches');
    assert.equal(SocialImportBatch.schema.options.timestamps.createdAt, 'createdAt');
    assert.equal(SocialImportBatch.schema.options.timestamps.updatedAt, 'updatedAt');
  });
});

describe('canTransitionBatchStatus — the only permitted lifecycle moves', () => {
  test('the documented happy path is allowed step by step', () => {
    assert.equal(canTransitionBatchStatus('parsing', 'validating'), true);
    assert.equal(canTransitionBatchStatus('validating', 'ready'), true);
    assert.equal(canTransitionBatchStatus('ready', 'importing'), true);
    assert.equal(canTransitionBatchStatus('importing', 'completed'), true);
  });

  test('failure is reachable from parsing, validating and importing', () => {
    assert.equal(canTransitionBatchStatus('parsing', 'failed'), true);
    assert.equal(canTransitionBatchStatus('validating', 'failed'), true);
    assert.equal(canTransitionBatchStatus('importing', 'failed'), true);
  });

  test('a no-op (same status) is always allowed', () => {
    for (const s of STATUSES) assert.equal(canTransitionBatchStatus(s, s), true);
  });

  test('arbitrary jumps are rejected', () => {
    assert.equal(canTransitionBatchStatus('parsing', 'completed'), false);
    assert.equal(canTransitionBatchStatus('parsing', 'importing'), false);
    assert.equal(canTransitionBatchStatus('validating', 'importing'), false);
    assert.equal(canTransitionBatchStatus('completed', 'importing'), false);
    assert.equal(canTransitionBatchStatus('ready', 'completed'), false);
  });

  test('expired is terminal — no outgoing transitions', () => {
    for (const s of STATUSES) {
      if (s === 'expired') continue;
      assert.equal(canTransitionBatchStatus('expired', s), false);
    }
  });

  test('every non-terminal status may move to expired (retention cleanup)', () => {
    for (const s of ['parsing', 'validating', 'ready', 'importing', 'completed', 'failed']) {
      assert.equal(canTransitionBatchStatus(s, 'expired'), true);
    }
  });

  test('an unknown "from" status has no legal transitions', () => {
    assert.equal(canTransitionBatchStatus('nonsense', 'parsing'), false);
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
  if (mongoAvailable) await mongoose.connection.close();
});

afterEach(async () => {
  if (mongoAvailable) {
    await SocialImportBatch.deleteMany({ project_id: { $in: [PROJECT_A, PROJECT_B] } });
  }
});

describe('SocialImportBatch indexes (live Mongo, auto-skip)', () => {
  test('all four declared indexes exist with the expected keys', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialImportBatch.syncIndexes();
    const indexes = await SocialImportBatch.collection.indexes();

    assert.ok(indexes.find((i) => i.key.project_id === 1 && i.key.createdAt === -1), 'project_id + createdAt');
    assert.ok(indexes.find((i) => i.key.project_id === 1 && i.key.fileHash === 1), 'project_id + fileHash');
    assert.ok(
      indexes.find((i) => i.key.project_id === 1 && i.key.status === 1 && !i.partialFilterExpression),
      'project_id + status (plain)',
    );

    const active = indexes.find((i) => i.name === 'one_active_import_per_project');
    assert.ok(active, 'partial unique active-batch index must exist');
    assert.equal(active.unique, true);
    assert.deepEqual(active.key, { project_id: 1 });
    assert.deepEqual(active.partialFilterExpression, { status: { $in: ACTIVE_STATUSES } });
  });

  test('a project may have only ONE active (parsing/validating/importing) batch', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialImportBatch.syncIndexes();

    await batch().save(); // defaults to status: 'parsing'
    await assert.rejects(
      () => batch({ fileHash: 'b'.repeat(64) }).save(),
      (err) => err.code === 11000,
      'a second in-flight batch for the same project must be rejected',
    );
  });

  test('completed batches coexist freely (partial index excludes them)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialImportBatch.syncIndexes();

    await batch({ status: 'completed' }).save();
    await assert.doesNotReject(() => batch({ status: 'completed', fileHash: 'c'.repeat(64) }).save());
  });

  test('failed and expired batches coexist freely', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialImportBatch.syncIndexes();

    await batch({ status: 'failed' }).save();
    await batch({ status: 'failed', fileHash: 'd'.repeat(64) }).save();
    await batch({ status: 'expired', fileHash: 'e'.repeat(64) }).save();
    assert.equal(await SocialImportBatch.countDocuments({ project_id: PROJECT_A }), 3);
  });

  test('two DIFFERENT projects may each have an active batch at the same time', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialImportBatch.syncIndexes();

    await batch({ project_id: PROJECT_A }).save();
    await assert.doesNotReject(() => batch({ project_id: PROJECT_B }).save());
  });
});
