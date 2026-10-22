import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import ExcelJS from 'exceljs';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import SocialAccount from '../model/SocialAccount.js';
import SocialImportBatch from '../model/SocialImportBatch.js';
import SocialImportRow from '../model/SocialImportRow.js';
import { validateUpload, getImportBatch, getImportRows, buildTemplateCsv } from './bulkImportService.js';

/**
 * Bulk Upload — Phase 2 orchestration: validateUpload(). Real MongoDB,
 * no mocking library — same convention as socialPublishingService.test.js.
 * Still NO SocialPublication is ever created here.
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

const HEADER = 'platform,content,media_urls,scheduled_at,timezone,action';
const csvFile = (body, name = 'posts.csv') => ({ originalname: name, mimetype: 'text/csv', buffer: Buffer.from(body, 'utf8') });

async function xlsxFile(rows, name = 'posts.xlsx') {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Posts');
  ws.addRow(['platform', 'content', 'media_urls', 'scheduled_at', 'timezone', 'action']);
  for (const r of rows) ws.addRow(r);
  return {
    originalname: name,
    mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(await wb.xlsx.writeBuffer()),
  };
}

describe('validateUpload', () => {
  let project, otherProject, userId;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    userId = new mongoose.Types.ObjectId();
    project = await SeoProject.create({
      user_id: userId, project_name: `Bulk P2 ${Date.now()}`, main_url: 'https://example.com',
      seo_scope: 'local', keywords: ['bulk p2'],
    });
    otherProject = await SeoProject.create({
      user_id: userId, project_name: `Bulk P2 Other ${Date.now()}`, main_url: 'https://other.example.com',
      seo_scope: 'local', keywords: ['other'],
    });
    await SocialAccount.create({
      user_id: userId, project_id: project._id, platform: 'facebook', platformAccountId: 'pg_p2',
      platformAccountName: 'P2 Page', accountType: 'page', pageId: 'pg_p2', accessToken: 'real-token',
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

  const run = (file) => validateUpload({ projectId: project._id.toString(), userId: userId.toString(), file });

  test('a clean CSV becomes a ready batch with accurate counts and persisted rows', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const body = `${HEADER}\r\nfacebook,Hello world,,,,draft\r\nfacebook,Another one,,,,draft\r\n`;
    const result = await run(csvFile(body));

    assert.equal(result.success, true);
    assert.equal(result.batch.status, 'ready');
    assert.deepEqual(result.validation, { total: 2, valid: 2, invalid: 0 });
    assert.equal(result.batch.counts.total, 2);
    assert.equal(result.batch.counts.valid, 2);
    assert.equal(result.batch.rowCount, 2);

    const rows = await SocialImportRow.find({ batch_id: result.batch.id }).sort({ rowNumber: 1 });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].status, 'valid');
    assert.equal(rows[0].normalized.platform, 'facebook');
    assert.ok(rows[0].idempotencyKey, 'every row gets a deterministic idempotencyKey');
    assert.equal(rows[0].publication_id, null, 'Phase 2 never links a publication');
  });

  test('a mixed file stores ALL rows; one invalid row never hides the valid ones', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const body = [
      HEADER,
      'facebook,Valid one,,,,draft',
      'pinterest,Unsupported platform,,,,draft',
      'instagram,No IG account and no media,,,,draft',
      'facebook,Valid two,,,,draft',
    ].join('\r\n');
    const result = await run(csvFile(body));

    assert.equal(result.success, true);
    assert.equal(result.batch.status, 'ready');
    assert.equal(result.validation.total, 4);
    assert.equal(result.validation.valid, 2);
    assert.equal(result.validation.invalid, 2);

    const invalid = await SocialImportRow.find({ batch_id: result.batch.id, status: 'invalid' }).sort({ rowNumber: 1 });
    assert.equal(invalid.length, 2);
    assert.ok(invalid[0].errors.length > 0);
    assert.ok(invalid.every((r) => Array.isArray(r.errors) && r.errors.every((e) => e.code && e.message)));
  });

  test('an all-invalid file is still a READY batch (the file itself parsed fine)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const body = `${HEADER}\r\npinterest,x,,,,draft\r\ntiktok,y,,,,draft\r\n`;
    const result = await run(csvFile(body));
    assert.equal(result.success, true);
    assert.equal(result.batch.status, 'ready');
    assert.equal(result.validation.valid, 0);
    assert.equal(result.validation.invalid, 2);
  });

  test('a malformed CSV fails the batch with an errorSummary and stores no rows', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await run(csvFile(`${HEADER}\r\nfacebook,"never closed,,,,draft\r\n`));
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'MALFORMED_CSV');
    assert.ok(result.batchId);

    const batch = await getImportBatch({ projectId: project._id.toString(), batchId: result.batchId });
    assert.equal(batch.batch.status, 'failed');
    assert.ok(batch.batch.errorSummary);
    assert.equal(await SocialImportRow.countDocuments({ batch_id: result.batchId }), 0);
  });

  test('a missing required column fails the batch', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await run(csvFile('content,action\r\nHello,draft\r\n'));
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'MISSING_REQUIRED_COLUMN');
    const batch = await getImportBatch({ projectId: project._id.toString(), batchId: result.batchId });
    assert.equal(batch.batch.status, 'failed');
  });

  test('an unknown column fails the batch (never silently ignored)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await run(csvFile('platform,content,first_comment\r\nfacebook,Hi,hello\r\n'));
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'UNSUPPORTED_COLUMN');
  });

  test('a second upload while one is already in flight is BULK_IMPORT_IN_PROGRESS', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    // Leave a batch stuck in an active state to simulate concurrency.
    await SocialImportBatch.create({
      project_id: project._id, createdBy: userId, filename: 'inflight.csv', fileHash: 'deadbeef', format: 'csv', status: 'validating',
    });
    const result = await run(csvFile(`${HEADER}\r\nfacebook,Hi,,,,draft\r\n`));
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'BULK_IMPORT_IN_PROGRESS');
  });

  test('a historical completed batch with the same file hash does NOT block a re-upload', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const body = `${HEADER}\r\nfacebook,Same file,,,,draft\r\n`;
    const first = await run(csvFile(body));
    assert.equal(first.success, true);
    const second = await run(csvFile(body));
    assert.equal(second.success, true, 're-uploading an identical, already-completed file is allowed');
    assert.notEqual(second.batch.id, first.batch.id);
  });

  test('XLSX: a clean workbook validates the same way as CSV', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const file = await xlsxFile([
      ['facebook', 'From excel', '', '', '', 'draft'],
      ['facebook', 'Second', '', '', '', 'draft'],
    ]);
    const result = await run(file);
    assert.equal(result.success, true);
    assert.equal(result.batch.format, 'xlsx');
    assert.equal(result.validation.valid, 2);
  });

  test('a scheduled row resolves an absolute scheduledAt on the stored row', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const body = `${HEADER}\r\nfacebook,Later,,2099-01-02 10:00,Asia/Kolkata,schedule\r\n`;
    const result = await run(csvFile(body));
    assert.equal(result.success, true);
    const [row] = await SocialImportRow.find({ batch_id: result.batch.id });
    assert.equal(row.status, 'valid');
    assert.equal(new Date(row.normalized.scheduledAt).toISOString(), '2099-01-02T04:30:00.000Z');
    assert.equal(row.normalized.timezone, 'Asia/Kolkata');
  });

  test('an unsupported extension is rejected before a batch is created', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await run({ originalname: 'evil.js', mimetype: 'text/csv', buffer: Buffer.from('alert(1)') });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'UNSUPPORTED_FILE_TYPE');
    assert.equal(await SocialImportBatch.countDocuments({ project_id: project._id }), 0);
  });

  test('getImportRows after validation exposes the preview WITHOUT raw / idempotencyKey', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await run(csvFile(`${HEADER}\r\npinterest,bad,,,,draft\r\nfacebook,good,,,,draft\r\n`));
    const rows = await getImportRows({ projectId: project._id.toString(), batchId: result.batch.id, filters: {} });
    assert.equal(rows.success, true);
    assert.equal(rows.data.length, 2);
    assert.equal('raw' in rows.data[0], false);
    assert.equal('idempotencyKey' in rows.data[0], false);
    const bad = rows.data.find((r) => r.status === 'invalid');
    assert.ok(bad.errors.some((e) => e.code === 'UNSUPPORTED_PLATFORM'));
  });

  test('another project cannot read the rows of a batch this project created', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await run(csvFile(`${HEADER}\r\nfacebook,Hi,,,,draft\r\n`));
    const rows = await getImportRows({ projectId: otherProject._id.toString(), batchId: result.batch.id, filters: {} });
    assert.equal(rows.success, false);
    assert.equal(rows.error.code, 'NOT_FOUND');
  });
});

describe('buildTemplateCsv', () => {
  test('has the canonical header and worked example rows, and no formula-trigger cells', () => {
    const csv = buildTemplateCsv();
    const lines = csv.trim().split('\r\n');
    assert.equal(lines[0], 'platform,content,media_urls,scheduled_at,timezone,action');
    assert.ok(lines.length >= 4);
    for (const line of lines) {
      for (const cell of line.split(',')) {
        assert.ok(!/^["']?[=+\-@]/.test(cell), `template cell must not start with a formula trigger: ${cell}`);
      }
    }
  });
});
