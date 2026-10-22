import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import SocialAccount from '../model/SocialAccount.js';
import SocialImportBatch from '../model/SocialImportBatch.js';
import SocialImportRow from '../model/SocialImportRow.js';
import SocialPublication from '../model/SocialPublication.js';
import {
  validateBulkImportHandler, importBulkUploadHandler, getBulkImportErrorsHandler,
} from './bulkImportController.js';

/**
 * Bulk Upload — Phase 3. HTTP behaviour of POST /bulk-upload/:batchId/import
 * and GET /bulk-upload/:batchId/errors. Handlers invoked directly with a
 * req/res stub, same technique as the Phase 2 controller test.
 */

let mongoAvailable = false;

before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    await SocialImportBatch.syncIndexes();
    await SocialImportRow.syncIndexes();
    await SocialPublication.syncIndexes();
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
    statusCode: null, body: null, headers: {}, sent: null,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    send(p) { this.sent = p; return this; },
  };
}

const HEADER = 'platform,content,media_urls,scheduled_at,timezone,action';
const csvFile = (body, name = 'posts.csv') => ({ originalname: name, mimetype: 'text/csv', buffer: Buffer.from(body, 'utf8') });

describe('POST /bulk-upload/:batchId/import', () => {
  let project, otherProject, userId;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    userId = new mongoose.Types.ObjectId();
    project = await SeoProject.create({
      user_id: userId, project_name: `Bulk Import Ctrl ${suffix}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['x'],
    });
    otherProject = await SeoProject.create({
      user_id: userId, project_name: `Bulk Import Ctrl Other ${suffix}`, main_url: 'https://other.example.com', seo_scope: 'local', keywords: ['y'],
    });
    await SocialAccount.create({
      user_id: userId, project_id: project._id, platform: 'facebook', platformAccountId: `pg_ic_${suffix}`,
      platformAccountName: 'IC Page', accountType: 'page', pageId: 'pg_ic', accessToken: 'real-token',
      status: 'active', isActive: true, scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
    });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    const ids = [project._id, otherProject._id];
    const batches = await SocialImportBatch.find({ project_id: { $in: ids } }).select('_id');
    await SocialImportRow.deleteMany({ batch_id: { $in: batches.map((b) => b._id) } });
    await SocialImportBatch.deleteMany({ project_id: { $in: ids } });
    await SocialPublication.deleteMany({ project_id: { $in: ids } });
    await SocialAccount.deleteMany({ project_id: { $in: ids } });
    await SeoProject.deleteMany({ _id: { $in: ids } });
  });

  async function validate(body) {
    const res = mockRes();
    await validateBulkImportHandler({ projectId: project._id.toString(), userId: userId.toString(), file: csvFile(body) }, res);
    return res;
  }
  function importReq(batchId, mode, projectId = project._id.toString()) {
    return { projectId, userId: userId.toString(), params: { batchId }, body: { mode } };
  }

  test('valid-only import → 200 with { batch, result, schedulerEnabled, warnings, rows } and no internal fields', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const v = await validate(`${HEADER}\r\nfacebook,Hello,,,,draft\r\nfacebook,World,,,,draft\r\n`);
    const batchId = v.body.data.batch.id;

    const res = mockRes();
    await importBulkUploadHandler(importReq(batchId, 'valid-only'), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.batch.status, 'completed');
    assert.deepEqual(res.body.data.result, { attempted: 2, imported: 2, failed: 0, drafts: 2, scheduled: 0 });
    assert.equal(typeof res.body.data.schedulerEnabled, 'boolean');
    assert.ok(Array.isArray(res.body.data.warnings));
    assert.equal(res.body.data.rows.length, 2);
    const blob = JSON.stringify(res.body);
    assert.equal(/fileHash|idempotencyKey|"raw"|accessToken/.test(blob), false);
  });

  test('an unknown mode → 400 INVALID_MODE', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const v = await validate(`${HEADER}\r\nfacebook,Hi,,,,draft\r\n`);
    const res = mockRes();
    await importBulkUploadHandler(importReq(v.body.data.batch.id, 'yeet'), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.details?.code, 'INVALID_MODE');
  });

  test('a second call replays the completed result — 200, no new publications', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const v = await validate(`${HEADER}\r\nfacebook,Once,,,,draft\r\n`);
    const batchId = v.body.data.batch.id;
    const r1 = mockRes(); await importBulkUploadHandler(importReq(batchId, 'valid-only'), r1);
    const r2 = mockRes(); await importBulkUploadHandler(importReq(batchId, 'valid-only'), r2);
    assert.equal(r2.statusCode, 200);
    assert.deepEqual(r2.body.data.result, r1.body.data.result);
    assert.equal(r1.body.data.replay, false, 'the first run is not a replay');
    assert.equal(r2.body.data.replay, true, 'the second run is an idempotent replay');
    assert.equal(await SocialPublication.countDocuments({ importBatchId: batchId }), 1);
  });

  test('a batch already importing → 409 IMPORT_ALREADY_IN_PROGRESS', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batch = await SocialImportBatch.create({
      project_id: project._id, createdBy: userId, filename: 'x.csv', fileHash: 'h', format: 'csv',
      status: 'importing', importMode: 'valid-only',
    });
    const res = mockRes();
    await importBulkUploadHandler(importReq(batch._id.toString(), 'valid-only'), res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.details?.code, 'IMPORT_ALREADY_IN_PROGRESS');
  });

  test('another project cannot import this batch → 404', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const v = await validate(`${HEADER}\r\nfacebook,Hi,,,,draft\r\n`);
    const res = mockRes();
    await importBulkUploadHandler(importReq(v.body.data.batch.id, 'valid-only', otherProject._id.toString()), res);
    assert.equal(res.statusCode, 404);
    assert.equal(await SocialPublication.countDocuments({ importBatchId: v.body.data.batch.id }), 0);
  });
});

describe('GET /bulk-upload/:batchId/errors', () => {
  let project, otherProject, userId;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    userId = new mongoose.Types.ObjectId();
    project = await SeoProject.create({
      user_id: userId, project_name: `Bulk Err Ctrl ${suffix}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['x'],
    });
    otherProject = await SeoProject.create({
      user_id: userId, project_name: `Bulk Err Ctrl Other ${suffix}`, main_url: 'https://other.example.com', seo_scope: 'local', keywords: ['y'],
    });
    await SocialAccount.create({
      user_id: userId, project_id: project._id, platform: 'facebook', platformAccountId: `pg_ec_${suffix}`,
      platformAccountName: 'EC Page', accountType: 'page', pageId: 'pg_ec', accessToken: 'real-token',
      status: 'active', isActive: true, scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
    });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    const ids = [project._id, otherProject._id];
    const batches = await SocialImportBatch.find({ project_id: { $in: ids } }).select('_id');
    await SocialImportRow.deleteMany({ batch_id: { $in: batches.map((b) => b._id) } });
    await SocialImportBatch.deleteMany({ project_id: { $in: ids } });
    await SocialPublication.deleteMany({ project_id: { $in: ids } });
    await SocialAccount.deleteMany({ project_id: { $in: ids } });
    await SeoProject.deleteMany({ _id: { $in: ids } });
  });

  async function validateAndImport(body) {
    const vres = mockRes();
    await validateBulkImportHandler({ projectId: project._id.toString(), userId: userId.toString(), file: csvFile(body) }, vres);
    const batchId = vres.body.data.batch.id;
    const ires = mockRes();
    await importBulkUploadHandler({ projectId: project._id.toString(), userId: userId.toString(), params: { batchId }, body: { mode: 'valid-only' } }, ires);
    return batchId;
  }

  test('CSV report includes invalid + failed rows, excludes imported rows, and is formula-safe', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const body = [
      HEADER,
      'facebook,Imported fine,,,,draft',                                   // -> imported, excluded
      'pinterest,"=1+1,danger",,,,draft',                                   // -> invalid (UNSUPPORTED_PLATFORM)
      'facebook,Needs media,https://cdn.evil.example.com/a.jpg,,,draft',    // -> valid at P2, MEDIA_NOT_OWNED at import -> failed
    ].join('\r\n');
    const batchId = await validateAndImport(body);

    const res = mockRes();
    await getBulkImportErrorsHandler({ projectId: project._id.toString(), params: { batchId }, query: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/csv/);
    assert.match(res.headers['content-disposition'], /attachment; filename="odito-bulk-upload-errors-[a-f0-9]{1,32}\.csv"/);
    assert.equal(res.headers['cache-control'], 'no-store');

    const lines = res.sent.trim().split('\r\n');
    assert.equal(lines[0], 'row_number,platform,content,status,error_codes,error_messages');
    assert.equal(lines.length, 3, 'header + 2 problem rows (imported row excluded)');
    assert.ok(res.sent.includes('UNSUPPORTED_PLATFORM'));
    assert.ok(res.sent.includes('MEDIA_NOT_OWNED'));
    // The "=1+1,danger" content must be neutralised: leading quote guard, then RFC-4180 quoting.
    assert.ok(res.sent.includes('"\'=1+1,danger"'), 'formula-injection guarded + quoted');
    assert.equal(/fileHash|idempotencyKey|"raw"/.test(res.sent), false);
    assert.ok(!res.sent.includes('Imported fine'), 'successfully-imported rows are not in the error report');
  });

  test('format other than csv → 400', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batchId = await validateAndImport(`${HEADER}\r\npinterest,bad,,,,draft\r\n`);
    const res = mockRes();
    await getBulkImportErrorsHandler({ projectId: project._id.toString(), params: { batchId }, query: { format: 'json' } }, res);
    assert.equal(res.statusCode, 400);
  });

  test('another project gets 404, never the report', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batchId = await validateAndImport(`${HEADER}\r\npinterest,bad,,,,draft\r\n`);
    const res = mockRes();
    await getBulkImportErrorsHandler({ projectId: otherProject._id.toString(), params: { batchId }, query: {} }, res);
    assert.equal(res.statusCode, 404);
  });
});
