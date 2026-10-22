import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SocialImportRow, { STATUSES, ACTIONS, ROW_TTL_SECONDS } from './SocialImportRow.js';

/**
 * Bulk Upload — Phase 1 (backend foundation). SocialImportRow schema /
 * defaults / enums (in-memory) plus index + TTL guarantees (live Mongo,
 * auto-skip). Rows are not populated from a real file, validated, or
 * imported yet.
 */

const BATCH_A = new mongoose.Types.ObjectId();
const BATCH_B = new mongoose.Types.ObjectId();
const PROJECT = new mongoose.Types.ObjectId();

function row(overrides = {}) {
  return new SocialImportRow({
    batch_id: BATCH_A,
    project_id: PROJECT,
    rowNumber: 1,
    raw: { platform: 'facebook', content: 'Hello' },
    idempotencyKey: 'k1',
    ...overrides,
  });
}

describe('SocialImportRow schema — required / defaults / enums', () => {
  test('accepts a minimal valid document (only required fields)', async () => {
    await assert.doesNotReject(() => row().validate());
  });

  for (const field of ['batch_id', 'project_id', 'rowNumber', 'raw', 'idempotencyKey']) {
    test(`required: ${field} missing is rejected`, async () => {
      await assert.rejects(() => row({ [field]: undefined }).validate());
    });
  }

  test('rowNumber must be >= 1', async () => {
    await assert.rejects(() => row({ rowNumber: 0 }).validate());
    await assert.doesNotReject(() => row({ rowNumber: 1 }).validate());
  });

  test('status defaults to "valid" and the enum accepts every STATUSES value', async () => {
    assert.equal(row().status, 'valid');
    for (const status of STATUSES) {
      await assert.doesNotReject(() => row({ status }).validate());
    }
    await assert.rejects(() => row({ status: 'pending' }).validate());
  });

  test('normalized defaults: all fields null, media an empty array', () => {
    const n = row().normalized;
    assert.equal(n.platform, null);
    assert.equal(n.socialAccountId, null);
    assert.equal(n.content, null);
    assert.equal(n.scheduledAt, null);
    assert.equal(n.timezone, null);
    assert.equal(n.action, null);
    assert.deepEqual(n.media.toObject ? n.media.toObject() : [...n.media], []);
  });

  test('normalized.platform enum rejects an unknown platform', async () => {
    await assert.rejects(() => row({ normalized: { platform: 'tiktok' } }).validate());
    await assert.doesNotReject(() => row({ normalized: { platform: 'facebook' } }).validate());
  });

  test('normalized.action enum accepts draft/schedule/publish only', async () => {
    for (const action of ACTIONS) {
      await assert.doesNotReject(() => row({ normalized: { action } }).validate());
    }
    await assert.rejects(() => row({ normalized: { action: 'post-now' } }).validate());
  });

  test('normalized.media items require a url and an image|video type', async () => {
    await assert.doesNotReject(() => row({ normalized: { media: [{ url: 'https://x/y.jpg', type: 'image' }] } }).validate());
    await assert.rejects(() => row({ normalized: { media: [{ url: 'https://x/y.jpg', type: 'gif' }] } }).validate());
    await assert.rejects(() => row({ normalized: { media: [{ type: 'image' }] } }).validate());
  });

  test('errors defaults to an empty array; each error requires code and message', async () => {
    assert.deepEqual([...row().errors], []);
    await assert.doesNotReject(() => row({ errors: [{ field: 'platform', code: 'X', message: 'bad' }] }).validate());
    await assert.rejects(() => row({ errors: [{ field: 'platform' }] }).validate());
  });

  test('publication_id defaults to null', () => {
    assert.equal(row().publication_id, null);
  });

  test('expiresAt defaults to roughly ROW_TTL_SECONDS in the future', () => {
    const ms = row().expiresAt.getTime() - Date.now();
    const expected = ROW_TTL_SECONDS * 1000;
    assert.ok(Math.abs(ms - expected) < 60_000, 'expiresAt should be ~7 days out');
  });

  test('collection name is socialimportrows and timestamps are configured', () => {
    assert.equal(SocialImportRow.collection.name, 'socialimportrows');
    assert.equal(SocialImportRow.schema.options.timestamps.createdAt, 'createdAt');
    assert.equal(SocialImportRow.schema.options.timestamps.updatedAt, 'updatedAt');
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
    await SocialImportRow.deleteMany({ batch_id: { $in: [BATCH_A, BATCH_B] } });
  }
});

describe('SocialImportRow indexes + TTL (live Mongo, auto-skip)', () => {
  test('declared indexes exist: {batch_id,status,rowNumber}, unique {batch_id,rowNumber}, TTL {expiresAt}', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialImportRow.syncIndexes();
    const indexes = await SocialImportRow.collection.indexes();

    assert.ok(
      indexes.find((i) => i.key.batch_id === 1 && i.key.status === 1 && i.key.rowNumber === 1),
      'batch_id + status + rowNumber',
    );

    const uniqueRow = indexes.find(
      (i) => i.key.batch_id === 1 && i.key.rowNumber === 1 && !('status' in i.key),
    );
    assert.ok(uniqueRow, 'batch_id + rowNumber index must exist');
    assert.equal(uniqueRow.unique, true);

    const ttl = indexes.find((i) => JSON.stringify(i.key) === JSON.stringify({ expiresAt: 1 }));
    assert.ok(ttl, 'TTL index on expiresAt must exist');
    assert.equal(ttl.expireAfterSeconds, 0);
  });

  test('rowNumber is unique within a batch', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialImportRow.syncIndexes();

    await row({ rowNumber: 7 }).save();
    await assert.rejects(
      () => row({ rowNumber: 7, idempotencyKey: 'k-dup' }).save(),
      (err) => err.code === 11000,
    );
  });

  test('the same rowNumber in a DIFFERENT batch is allowed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialImportRow.syncIndexes();

    await row({ batch_id: BATCH_A, rowNumber: 3 }).save();
    await assert.doesNotReject(() => row({ batch_id: BATCH_B, rowNumber: 3 }).save());
  });
});
