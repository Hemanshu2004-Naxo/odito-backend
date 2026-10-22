import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import SocialImportBatch from '../model/SocialImportBatch.js';
import SocialImportRow from '../model/SocialImportRow.js';
import {
  createImportBatch, getImportBatch, getImportBatchForProject, getImportRows,
  updateImportBatchStatus, updateImportBatchCounts,
} from './bulkImportService.js';

/**
 * Bulk Upload — Phase 1. bulkImportService: batch bookkeeping +
 * ownership-safe reads only. Real MongoDB, no mocking library — same
 * convention as socialPublishingService.test.js. Auto-skips when local
 * MongoDB is unreachable.
 */

let mongoAvailable = false;

before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    await SocialImportBatch.syncIndexes();
    await SocialImportRow.syncIndexes();
    mongoAvailable = true;
  } catch {
    mongoAvailable = false;
  }
});

after(async () => {
  if (mongoAvailable) await mongoose.connection.close();
});

describe('bulkImportService', () => {
  let project, otherProject, userId;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    userId = new mongoose.Types.ObjectId();
    project = await SeoProject.create({
      user_id: userId, project_name: `Bulk Import Test ${Date.now()}`, main_url: 'https://example.com',
      seo_scope: 'local', keywords: ['bulk import test'],
    });
    otherProject = await SeoProject.create({
      user_id: userId, project_name: `Bulk Import Other ${Date.now()}`, main_url: 'https://other.example.com',
      seo_scope: 'local', keywords: ['other'],
    });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    const ids = [project._id, otherProject._id];
    const batches = await SocialImportBatch.find({ project_id: { $in: ids } }).select('_id');
    await SocialImportRow.deleteMany({ batch_id: { $in: batches.map((b) => b._id) } });
    await SocialImportBatch.deleteMany({ project_id: { $in: ids } });
    await SeoProject.deleteMany({ _id: { $in: ids } });
  });

  function newBatch(overrides = {}) {
    return createImportBatch({
      projectId: project._id.toString(), userId: userId.toString(),
      filename: 'posts.csv', fileHash: Math.random().toString(36).slice(2), format: 'csv', ...overrides,
    });
  }

  async function seedRows(batchId, specs) {
    await SocialImportRow.insertMany(specs.map((s, i) => ({
      batch_id: batchId, project_id: project._id, rowNumber: i + 1,
      raw: { line: i + 1 }, idempotencyKey: `k${i}`, status: s.status || 'valid',
      normalized: s.normalized || {}, errors: s.errors || [],
    })));
  }

  test('createImportBatch: creates a "parsing" batch with zeroed counts', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await newBatch();
    assert.equal(result.success, true);
    assert.equal(result.batch.status, 'parsing');
    assert.equal(result.batch.format, 'csv');
    assert.deepEqual(result.batch.counts, { total: 0, valid: 0, invalid: 0, imported: 0, failed: 0, drafts: 0, scheduled: 0 });
    assert.equal(result.batch.rowCount, 0);
  });

  test('createImportBatch: missing filename/fileHash/format is rejected', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await createImportBatch({ projectId: project._id.toString(), userId: userId.toString(), filename: 'x.csv' });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'INVALID_BATCH');
  });

  test('createImportBatch: a second in-flight batch for the same project is BULK_IMPORT_IN_PROGRESS', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const first = await newBatch();
    assert.equal(first.success, true);
    const second = await newBatch();
    assert.equal(second.success, false);
    assert.equal(second.error.code, 'BULK_IMPORT_IN_PROGRESS');
  });

  test('getImportBatchForProject: wrong project is NOT_FOUND, never cross-project data', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { batch } = await newBatch();
    const result = await getImportBatchForProject({ projectId: otherProject._id.toString(), batchId: batch.id });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'NOT_FOUND');
  });

  test('getImportBatch: an invalid batch id is INVALID_BATCH_ID (400-class), not a 500', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await getImportBatch({ projectId: project._id.toString(), batchId: 'not-an-objectid' });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'INVALID_BATCH_ID');
  });

  test('getImportBatch: returns a safe projection (id + declared fields only, no __v / project_id / raw doc)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { batch } = await newBatch();
    const result = await getImportBatch({ projectId: project._id.toString(), batchId: batch.id });
    assert.equal(result.success, true);
    assert.deepEqual(
      Object.keys(result.batch).sort(),
      ['counts', 'createdAt', 'errorSummary', 'filename', 'format', 'id', 'importMode', 'rowCount', 'status', 'updatedAt'].sort(),
    );
  });

  test('getImportRows: paginates, sorts by rowNumber, and never exposes `raw`', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { batch } = await newBatch();
    await seedRows(batch.id, Array.from({ length: 5 }, () => ({ status: 'valid' })));

    const page1 = await getImportRows({ projectId: project._id.toString(), batchId: batch.id, filters: { page: 1, limit: 2 } });
    assert.equal(page1.success, true);
    assert.equal(page1.data.length, 2);
    assert.deepEqual(page1.data.map((r) => r.rowNumber), [1, 2]);
    assert.equal(page1.pagination.total, 5);
    assert.equal(page1.pagination.pages, 3);
    assert.equal(page1.pagination.hasNext, true);
    assert.equal(page1.pagination.hasPrev, false);
    assert.equal('raw' in page1.data[0], false);
    assert.equal('idempotencyKey' in page1.data[0], false);
  });

  test('getImportRows: caps limit at the maximum page size (50)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { batch } = await newBatch();
    const result = await getImportRows({ projectId: project._id.toString(), batchId: batch.id, filters: { limit: 9999 } });
    assert.equal(result.pagination.limit, 50);
  });

  test('getImportRows: a status filter narrows the result; an unknown status is INVALID_STATUS', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { batch } = await newBatch();
    await seedRows(batch.id, [{ status: 'valid' }, { status: 'invalid' }, { status: 'valid' }]);

    const invalidOnly = await getImportRows({ projectId: project._id.toString(), batchId: batch.id, filters: { status: 'invalid' } });
    assert.equal(invalidOnly.data.length, 1);
    assert.equal(invalidOnly.data[0].status, 'invalid');

    const bad = await getImportRows({ projectId: project._id.toString(), batchId: batch.id, filters: { status: 'weird' } });
    assert.equal(bad.success, false);
    assert.equal(bad.error.code, 'INVALID_STATUS');
  });

  test('getImportRows: another project cannot read a batch\'s rows', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { batch } = await newBatch();
    await seedRows(batch.id, [{ status: 'valid' }]);
    const result = await getImportRows({ projectId: otherProject._id.toString(), batchId: batch.id, filters: {} });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'NOT_FOUND');
  });

  test('updateImportBatchStatus: a legal transition is applied', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { batch } = await newBatch();
    const result = await updateImportBatchStatus({ projectId: project._id.toString(), batchId: batch.id, status: 'validating' });
    assert.equal(result.success, true);
    assert.equal(result.batch.status, 'validating');
  });

  test('updateImportBatchStatus: an illegal transition is rejected with INVALID_STATUS_TRANSITION', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { batch } = await newBatch();
    const result = await updateImportBatchStatus({ projectId: project._id.toString(), batchId: batch.id, status: 'completed' });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'INVALID_STATUS_TRANSITION');
    const reread = await getImportBatch({ projectId: project._id.toString(), batchId: batch.id });
    assert.equal(reread.batch.status, 'parsing', 'the batch must be untouched after a rejected transition');
  });

  test('updateImportBatchStatus: an unknown status value is INVALID_STATUS', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { batch } = await newBatch();
    const result = await updateImportBatchStatus({ projectId: project._id.toString(), batchId: batch.id, status: 'banana' });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'INVALID_STATUS');
  });

  test('updateImportBatchStatus: re-writing the same status is a permitted no-op', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { batch } = await newBatch();
    const result = await updateImportBatchStatus({ projectId: project._id.toString(), batchId: batch.id, status: 'parsing' });
    assert.equal(result.success, true);
    assert.equal(result.batch.status, 'parsing');
  });

  test('updateImportBatchStatus: failed carries an errorSummary through', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { batch } = await newBatch();
    const result = await updateImportBatchStatus({
      projectId: project._id.toString(), batchId: batch.id, status: 'failed', errorSummary: 'Could not parse the file.',
    });
    assert.equal(result.success, true);
    assert.equal(result.batch.status, 'failed');
    assert.equal(result.batch.errorSummary, 'Could not parse the file.');
  });

  test('updateImportBatchStatus: another project cannot mutate the batch', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { batch } = await newBatch();
    const result = await updateImportBatchStatus({ projectId: otherProject._id.toString(), batchId: batch.id, status: 'validating' });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'NOT_FOUND');
  });

  test('updateImportBatchCounts: merges valid counts and rowCount', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { batch } = await newBatch();
    const result = await updateImportBatchCounts({
      projectId: project._id.toString(), batchId: batch.id,
      counts: { total: 10, valid: 8, invalid: 2 }, rowCount: 10,
    });
    assert.equal(result.success, true);
    assert.equal(result.batch.counts.total, 10);
    assert.equal(result.batch.counts.valid, 8);
    assert.equal(result.batch.counts.invalid, 2);
    assert.equal(result.batch.counts.imported, 0);
    assert.equal(result.batch.rowCount, 10);
  });

  test('updateImportBatchCounts: a negative value is rejected with INVALID_COUNTS', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { batch } = await newBatch();
    const result = await updateImportBatchCounts({ projectId: project._id.toString(), batchId: batch.id, counts: { valid: -3 } });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'INVALID_COUNTS');
  });
});
