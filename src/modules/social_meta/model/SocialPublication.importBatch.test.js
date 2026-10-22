import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SocialPublication from './SocialPublication.js';

/**
 * Bulk Upload — Phase 1. Coverage for the ONLY change made to the
 * existing, production SocialPublication model: two additive, nullable
 * provenance fields (importBatchId / importRowNumber) and a partial
 * unique index that stops one import row producing two publications.
 *
 * A dedicated file (there is no pre-existing SocialPublication.test.js)
 * so none of the existing publishing tests are touched.
 */

const PROJECT = new mongoose.Types.ObjectId();
const ACCOUNT = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();
const BATCH = new mongoose.Types.ObjectId();

function publication(overrides = {}) {
  return new SocialPublication({
    project_id: PROJECT,
    social_account_id: ACCOUNT,
    platform: 'facebook',
    createdBy: USER,
    content: 'hello',
    ...overrides,
  });
}

describe('SocialPublication — bulk-upload provenance fields (in-memory)', () => {
  test('importBatchId and importRowNumber default to null', () => {
    const doc = publication();
    assert.equal(doc.importBatchId, null);
    assert.equal(doc.importRowNumber, null);
  });

  test('an ordinary publication with neither field set still validates (backward compatible)', async () => {
    await assert.doesNotReject(() => publication().validate());
  });

  test('the fields accept a real ObjectId / number when a bulk import sets them', async () => {
    const doc = publication({ importBatchId: BATCH, importRowNumber: 4 });
    await assert.doesNotReject(() => doc.validate());
    assert.equal(doc.importRowNumber, 4);
  });
});

// ─────────────────────────────────────────────────────────────────────────

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
  if (mongoAvailable) await SocialPublication.deleteMany({ project_id: PROJECT });
});

describe('SocialPublication — importBatch partial unique index (live Mongo, auto-skip)', () => {
  test('the partial unique index {importBatchId, importRowNumber} exists', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialPublication.syncIndexes();
    const indexes = await SocialPublication.collection.indexes();
    const idx = indexes.find((i) => i.key.importBatchId === 1 && i.key.importRowNumber === 1);
    assert.ok(idx, 'index must exist');
    assert.equal(idx.unique, true);
    assert.deepEqual(idx.partialFilterExpression, { importBatchId: { $type: 'objectId' } });
  });

  test('many manually-created publications (importBatchId null) coexist — the partial filter excludes them', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialPublication.syncIndexes();
    await publication().save();
    await publication().save();
    await assert.doesNotReject(() => publication().save());
    assert.equal(await SocialPublication.countDocuments({ project_id: PROJECT }), 3);
  });

  test('two publications for the SAME (importBatchId, importRowNumber) are rejected', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialPublication.syncIndexes();
    await publication({ importBatchId: BATCH, importRowNumber: 1 }).save();
    await assert.rejects(
      () => publication({ importBatchId: BATCH, importRowNumber: 1 }).save(),
      (err) => err.code === 11000,
    );
  });

  test('different rowNumbers under the same batch are allowed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialPublication.syncIndexes();
    await publication({ importBatchId: BATCH, importRowNumber: 1 }).save();
    await assert.doesNotReject(() => publication({ importBatchId: BATCH, importRowNumber: 2 }).save());
  });
});
