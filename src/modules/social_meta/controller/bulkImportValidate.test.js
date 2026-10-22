import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import SocialAccount from '../model/SocialAccount.js';
import SocialImportBatch from '../model/SocialImportBatch.js';
import SocialImportRow from '../model/SocialImportRow.js';
import {
  validateBulkImportHandler, getBulkImportTemplateHandler, getBulkImportRowsHandler,
} from './bulkImportController.js';

/**
 * Bulk Upload — Phase 2. HTTP behaviour of the validate + template
 * endpoints. Handlers are invoked directly with a req/res stub — same
 * technique as socialPublishingController.test.js. req.file is shaped
 * like multer.memoryStorage() would produce it.
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
    headers: {},
    sent: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    send(payload) { this.sent = payload; return this; },
  };
}

const HEADER = 'platform,content,media_urls,scheduled_at,timezone,action';
const csvFile = (body, name = 'posts.csv') => ({ originalname: name, mimetype: 'text/csv', buffer: Buffer.from(body, 'utf8') });

describe('POST /bulk-upload/validate', () => {
  let project, otherProject, userId;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    userId = new mongoose.Types.ObjectId();
    project = await SeoProject.create({
      user_id: userId, project_name: `Bulk Ctrl P2 ${Date.now()}`, main_url: 'https://example.com',
      seo_scope: 'local', keywords: ['bulk ctrl p2'],
    });
    otherProject = await SeoProject.create({
      user_id: userId, project_name: `Bulk Ctrl P2 Other ${Date.now()}`, main_url: 'https://other.example.com',
      seo_scope: 'local', keywords: ['other'],
    });
    await SocialAccount.create({
      user_id: userId, project_id: project._id, platform: 'facebook', platformAccountId: 'pg_ctrl_p2',
      platformAccountName: 'Ctrl P2 Page', accountType: 'page', pageId: 'pg_ctrl_p2', accessToken: 'real-token',
      status: 'active', isActive: true, scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
    });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    const ids = [project._id, otherProject._id];
    const batches = await SocialImportBatch.find({ project_id: { $in: ids } }).select('_id');
    await SocialImportRow.deleteMany({ batch_id: { $in: batches.map((b) => b._id) } });
    await SocialImportBatch.deleteMany({ project_id: { $in: ids } });
    await SocialAccount.deleteMany({ project_id: { $in: ids } });
    await SeoProject.deleteMany({ _id: { $in: ids } });
  });

  const req = (file) => ({ projectId: project._id.toString(), userId: userId.toString(), file });

  test('no file -> 400 INVALID_FILE', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = mockRes();
    await validateBulkImportHandler({ projectId: project._id.toString(), userId: userId.toString() }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.details?.code, 'INVALID_FILE');
  });

  test('a clean CSV -> 201 with { batch, validation } and no internal fields leaked', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = mockRes();
    await validateBulkImportHandler(req(csvFile(`${HEADER}\r\nfacebook,Hello,,,,draft\r\nfacebook,World,,,,draft\r\n`)), res);

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.batch.status, 'ready');
    assert.deepEqual(res.body.data.validation, { total: 2, valid: 2, invalid: 0 });
    const keys = Object.keys(res.body.data.batch);
    assert.equal(keys.includes('fileHash'), false);
    assert.equal(keys.includes('createdBy'), false);
    assert.equal(keys.includes('project_id'), false);
  });

  test('a structurally valid file with some invalid rows -> 201 ready', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = mockRes();
    await validateBulkImportHandler(req(csvFile(`${HEADER}\r\nfacebook,ok,,,,draft\r\npinterest,bad,,,,draft\r\n`)), res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.data.validation.valid, 1);
    assert.equal(res.body.data.validation.invalid, 1);
  });

  test('a malformed file -> 400 with the file-level code and the failed batch id', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = mockRes();
    await validateBulkImportHandler(req(csvFile(`${HEADER}\r\nfacebook,"unterminated,,,,draft\r\n`)), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.details?.code, 'MALFORMED_CSV');
    assert.ok(res.body.details?.batchId);
  });

  test('a second concurrent import -> 409 BULK_IMPORT_IN_PROGRESS', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialImportBatch.create({
      project_id: project._id, createdBy: userId, filename: 'x.csv', fileHash: 'abc', format: 'csv', status: 'parsing',
    });
    const res = mockRes();
    await validateBulkImportHandler(req(csvFile(`${HEADER}\r\nfacebook,Hi,,,,draft\r\n`)), res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.details?.code, 'BULK_IMPORT_IN_PROGRESS');
  });

  test('the stored preview is reachable through GET /bulk-upload/:batchId/rows', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const vres = mockRes();
    await validateBulkImportHandler(req(csvFile(`${HEADER}\r\npinterest,bad,,,,draft\r\nfacebook,good,,,,draft\r\n`)), vres);
    const batchId = vres.body.data.batch.id;

    const rres = mockRes();
    await getBulkImportRowsHandler({ projectId: project._id.toString(), params: { batchId }, query: { status: 'invalid' } }, rres);
    assert.equal(rres.body.success, true);
    assert.equal(rres.body.data.length, 1);
    assert.equal(rres.body.data[0].status, 'invalid');
    assert.equal('raw' in rres.body.data[0], false);
    assert.ok(rres.body.data[0].errors[0].code);
  });

  test('another project cannot see the batch this project just created', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const vres = mockRes();
    await validateBulkImportHandler(req(csvFile(`${HEADER}\r\nfacebook,Hi,,,,draft\r\n`)), vres);
    const batchId = vres.body.data.batch.id;

    const rres = mockRes();
    await getBulkImportRowsHandler({ projectId: otherProject._id.toString(), params: { batchId }, query: {} }, rres);
    assert.equal(rres.statusCode, 404);
  });
});

describe('GET /bulk-upload/template', () => {
  test('serves a downloadable CSV with the canonical columns', () => {
    const res = mockRes();
    getBulkImportTemplateHandler({}, res);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/csv/);
    assert.match(res.headers['content-disposition'], /attachment; filename="odito-bulk-upload-template\.csv"/);
    assert.ok(res.sent.startsWith('platform,content,media_urls,scheduled_at,timezone,action'));
  });
});
