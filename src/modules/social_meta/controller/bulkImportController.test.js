import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import SocialImportBatch from '../model/SocialImportBatch.js';
import SocialImportRow from '../model/SocialImportRow.js';
import { createImportBatch } from '../service/bulkImportService.js';
import { getBulkImportBatchHandler, getBulkImportRowsHandler } from './bulkImportController.js';

/**
 * Bulk Upload — Phase 1. bulkImportController HTTP behaviour. Handlers
 * are called directly with a minimal req/res stub — same technique as
 * socialPublishingController.test.js. req.projectId is the value
 * validateProjectAccess() would have set; the controller trusts nothing
 * else.
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

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

describe('bulkImportController', () => {
  let project, otherProject, userId, batchId;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    userId = new mongoose.Types.ObjectId();
    project = await SeoProject.create({
      user_id: userId, project_name: `Bulk Ctrl Test ${Date.now()}`, main_url: 'https://example.com',
      seo_scope: 'local', keywords: ['bulk ctrl test'],
    });
    otherProject = await SeoProject.create({
      user_id: userId, project_name: `Bulk Ctrl Other ${Date.now()}`, main_url: 'https://other.example.com',
      seo_scope: 'local', keywords: ['other'],
    });
    const created = await createImportBatch({
      projectId: project._id.toString(), userId: userId.toString(),
      filename: 'posts.csv', fileHash: Math.random().toString(36).slice(2), format: 'csv',
    });
    batchId = created.batch.id;
    await SocialImportRow.insertMany([
      { batch_id: batchId, project_id: project._id, rowNumber: 1, raw: { a: 1 }, idempotencyKey: 'k1', status: 'valid' },
      { batch_id: batchId, project_id: project._id, rowNumber: 2, raw: { a: 2 }, idempotencyKey: 'k2', status: 'invalid', errors: [{ field: 'platform', code: 'PLATFORM_NOT_SUPPORTED', message: 'x is not supported.' }] },
    ]);
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    const ids = [project._id, otherProject._id];
    const batches = await SocialImportBatch.find({ project_id: { $in: ids } }).select('_id');
    await SocialImportRow.deleteMany({ batch_id: { $in: batches.map((b) => b._id) } });
    await SocialImportBatch.deleteMany({ project_id: { $in: ids } });
    await SeoProject.deleteMany({ _id: { $in: ids } });
  });

  test('GET batch: an invalid batch id returns 400 INVALID_BATCH_ID', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = mockRes();
    await getBulkImportBatchHandler({ projectId: project._id.toString(), params: { batchId: 'nope' } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.details?.code, 'INVALID_BATCH_ID');
  });

  test('GET batch: a batch from another project returns 404 NOT_FOUND (never cross-project data)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = mockRes();
    await getBulkImportBatchHandler({ projectId: otherProject._id.toString(), params: { batchId } }, res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.details?.code, 'NOT_FOUND');
  });

  test('GET batch: a valid request returns the safe batch projection', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = mockRes();
    await getBulkImportBatchHandler({ projectId: project._id.toString(), params: { batchId } }, res);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.batch.id, batchId);
    assert.equal(res.body.data.batch.status, 'parsing');
    assert.equal(res.body.data.batch.format, 'csv');
    assert.ok(res.body.data.batch.counts);
  });

  test('GET rows: an invalid status filter returns 400 INVALID_STATUS', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = mockRes();
    await getBulkImportRowsHandler({ projectId: project._id.toString(), params: { batchId }, query: { status: 'weird' } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.details?.code, 'INVALID_STATUS');
  });

  test('GET rows: returns a paginated envelope, sorted, with `raw` never exposed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = mockRes();
    await getBulkImportRowsHandler({ projectId: project._id.toString(), params: { batchId }, query: {} }, res);
    assert.equal(res.body.success, true);
    assert.equal(Array.isArray(res.body.data), true);
    assert.deepEqual(res.body.data.map((r) => r.rowNumber), [1, 2]);
    assert.equal('raw' in res.body.data[0], false);
    assert.equal(res.body.pagination.total, 2);
    assert.equal(res.body.pagination.page, 1);
  });

  test('GET rows: status filter + pagination params are honoured', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = mockRes();
    await getBulkImportRowsHandler({ projectId: project._id.toString(), params: { batchId }, query: { status: 'invalid', page: '1', limit: '1' } }, res);
    assert.equal(res.body.data.length, 1);
    assert.equal(res.body.data[0].status, 'invalid');
    assert.equal(res.body.data[0].errors[0].code, 'PLATFORM_NOT_SUPPORTED');
    assert.equal(res.body.pagination.limit, 1);
  });

  test('GET rows: another project gets 404, never the rows', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = mockRes();
    await getBulkImportRowsHandler({ projectId: otherProject._id.toString(), params: { batchId }, query: {} }, res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.details?.code, 'NOT_FOUND');
  });
});
