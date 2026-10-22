import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../../app_user/model/SeoProject.js';
import SocialAccount from '../../model/SocialAccount.js';
import SocialImportBatch from '../../model/SocialImportBatch.js';
import SocialImportRow from '../../model/SocialImportRow.js';
import SocialPublication from '../../model/SocialPublication.js';
import adapters from '../platformAdapters/index.js';
import { executeDuePublications } from '../socialPublishingService.js';
import { importValidatedBatch } from './bulkImportExecutor.js';
import { getServiceUrls } from '../../../../config/env.js';
import '../../testSupport/stubPermalinkLookup.js';

/**
 * Bulk Upload — Phase 3 executor. Real MongoDB, no mocking library
 * (adapters are swapped on their shared default export for the duration
 * of one test, always restored — same technique as
 * socialPublishingService.test.js). NO Meta call ever happens during
 * import.
 */

let mongoAvailable = false;
let ownedMediaUrl;

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

// Guard: the executor must never reach a platform adapter.
async function withAdaptersForbidden(fn) {
  const fb = adapters.facebook.publish;
  const ig = adapters.instagram.publish;
  adapters.facebook.publish = async () => { throw new Error('adapter must NOT be called during import'); };
  adapters.instagram.publish = async () => { throw new Error('adapter must NOT be called during import'); };
  try {
    return await fn();
  } finally {
    adapters.facebook.publish = fb;
    adapters.instagram.publish = ig;
  }
}

describe('bulkImportExecutor.importValidatedBatch', () => {
  let project, otherProject, userId;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    userId = new mongoose.Types.ObjectId();
    project = await SeoProject.create({
      user_id: userId, project_name: `Bulk P3 ${suffix}`, main_url: 'https://example.com',
      seo_scope: 'local', keywords: ['bulk p3'],
    });
    otherProject = await SeoProject.create({
      user_id: userId, project_name: `Bulk P3 Other ${suffix}`, main_url: 'https://other.example.com',
      seo_scope: 'local', keywords: ['other'],
    });
    await SocialAccount.create({
      user_id: userId, project_id: project._id, platform: 'facebook', platformAccountId: `pg_p3_${Date.now()}`,
      platformAccountName: 'P3 Page', accountType: 'page', pageId: 'pg_p3', accessToken: 'real-token',
      status: 'active', isActive: true, scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
    });
    ownedMediaUrl = `${getServiceUrls().backend}/storage/social_media/${project._id.toString()}/seed.jpg`;
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

  const rand = () => Math.random().toString(36).slice(2);

  async function seedBatch(rowSpecs, { status = 'ready', importMode = null } = {}) {
    const valid = rowSpecs.filter((s) => (s.status || 'valid') === 'valid').length;
    const batch = await SocialImportBatch.create({
      project_id: project._id, createdBy: userId, filename: 'x.csv', fileHash: rand(), format: 'csv',
      status, importMode,
      rowCount: rowSpecs.length,
      counts: { total: rowSpecs.length, valid, invalid: rowSpecs.length - valid, imported: 0, failed: 0, drafts: 0, scheduled: 0 },
    });
    await SocialImportRow.insertMany(rowSpecs.map((s, i) => ({
      batch_id: batch._id, project_id: project._id, rowNumber: i + 1,
      raw: { platform: s.platform ?? '' }, idempotencyKey: `${batch._id}-${i}`,
      status: s.status || 'valid', errors: s.errors || [],
      normalized: {
        platform: s.platform ?? null,
        socialAccountId: null,
        content: s.content ?? null,
        media: s.media ?? [],
        scheduledAt: s.scheduledAt ?? null,
        timezone: s.timezone ?? null,
        action: s.action ?? 'draft',
      },
    })));
    return batch;
  }

  const runImport = (batchId, mode = 'valid-only') =>
    withAdaptersForbidden(() => importValidatedBatch({ projectId: project._id.toString(), userId: userId.toString(), batchId: batchId.toString(), mode }));

  // ─────────────────────────── success ───────────────────────────

  test('a valid draft row becomes a draft SocialPublication, linked and stamped', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batch = await seedBatch([{ platform: 'facebook', content: 'Hello', action: 'draft' }]);
    const res = await runImport(batch._id);

    assert.equal(res.success, true);
    assert.equal(res.batch.status, 'completed');
    assert.deepEqual(res.result, { attempted: 1, imported: 1, failed: 0, drafts: 1, scheduled: 0 });

    const row = await SocialImportRow.findOne({ batch_id: batch._id, rowNumber: 1 });
    assert.equal(row.status, 'imported');
    assert.ok(row.publication_id);
    const pub = await SocialPublication.findById(row.publication_id);
    assert.equal(pub.status, 'draft');
    assert.equal(pub.importBatchId.toString(), batch._id.toString());
    assert.equal(pub.importRowNumber, 1);
    assert.equal(pub.content, 'Hello');
  });

  test('a valid schedule row becomes a scheduled SocialPublication with the right scheduledAt', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const when = new Date(Date.now() + 3600_000);
    const batch = await seedBatch([{ platform: 'facebook', content: 'Later', action: 'schedule', scheduledAt: when, timezone: 'Asia/Kolkata' }]);
    const res = await runImport(batch._id);

    assert.equal(res.result.scheduled, 1);
    const row = await SocialImportRow.findOne({ batch_id: batch._id });
    const pub = await SocialPublication.findById(row.publication_id);
    assert.equal(pub.status, 'scheduled');
    assert.equal(pub.scheduledAt.toISOString(), when.toISOString());
    assert.equal(pub.timezone, 'Asia/Kolkata');
  });

  test('a valid publish row becomes an immediately-due SCHEDULED publication — no Meta call', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batch = await seedBatch([{ platform: 'facebook', content: 'Go now', action: 'publish' }]);
    const res = await runImport(batch._id);

    assert.equal(res.result.scheduled, 1);
    assert.equal(res.result.drafts, 0);
    const row = await SocialImportRow.findOne({ batch_id: batch._id });
    const pub = await SocialPublication.findById(row.publication_id);
    assert.equal(pub.status, 'scheduled', 'publish rows are created as scheduled, never published inside the request');
    assert.ok(pub.scheduledAt.getTime() <= Date.now() + 5000, 'scheduled immediately-due');
  });

  test('a publish row is subsequently picked up by the EXISTING executeDuePublications() pipeline', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batch = await seedBatch([{ platform: 'facebook', content: 'Scheduler takes it', action: 'publish' }]);
    await runImport(batch._id);
    const row = await SocialImportRow.findOne({ batch_id: batch._id });

    // Now let the real scheduler pipeline run, with a mocked adapter.
    const original = adapters.facebook.publish;
    adapters.facebook.publish = async () => ({ success: true, externalPostId: 'fb_from_bulk_1', error: null });
    try {
      await new Promise((r) => setTimeout(r, 1100)); // let scheduledAt (now+1s) fall due
      await executeDuePublications({ projectId: project._id });
    } finally {
      adapters.facebook.publish = original;
    }

    const pub = await SocialPublication.findById(row.publication_id);
    assert.equal(pub.status, 'published');
    assert.equal(pub.externalPostId, 'fb_from_bulk_1');
  });

  test('mixed draft/schedule/publish all import with correct buckets', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batch = await seedBatch([
      { platform: 'facebook', content: 'D', action: 'draft' },
      { platform: 'facebook', content: 'S', action: 'schedule', scheduledAt: new Date(Date.now() + 3600_000), timezone: 'UTC' },
      { platform: 'facebook', content: 'P', action: 'publish' },
    ]);
    const res = await runImport(batch._id);
    assert.deepEqual(res.result, { attempted: 3, imported: 3, failed: 0, drafts: 1, scheduled: 2 });
  });

  test('all-as-draft forces every valid row (incl. schedule/publish) to a draft', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batch = await seedBatch([
      { platform: 'facebook', content: 'S', action: 'schedule', scheduledAt: new Date(Date.now() + 3600_000), timezone: 'UTC' },
      { platform: 'facebook', content: 'P', action: 'publish' },
    ]);
    const res = await runImport(batch._id, 'all-as-draft');
    assert.deepEqual(res.result, { attempted: 2, imported: 2, failed: 0, drafts: 2, scheduled: 0 });
    const pubs = await SocialPublication.find({ importBatchId: batch._id });
    assert.ok(pubs.every((p) => p.status === 'draft'));
  });

  test('owned media on a valid row imports (revalidated through the existing validateMedia contract)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batch = await seedBatch([{ platform: 'facebook', content: 'With media', action: 'draft', media: [{ url: ownedMediaUrl, type: 'image' }] }]);
    const res = await runImport(batch._id);
    assert.equal(res.result.imported, 1);
    const pub = await SocialPublication.findOne({ importBatchId: batch._id });
    assert.equal(pub.media[0].url, ownedMediaUrl);
  });

  // ─────────────────────── partial failures ───────────────────────

  test('media that is NOT an Odito-hosted URL fails the row (MEDIA_NOT_OWNED), never weakens validateMedia', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batch = await seedBatch([{ platform: 'facebook', content: 'x', action: 'draft', media: [{ url: 'https://cdn.evil.example.com/a.jpg', type: 'image' }] }]);
    const res = await runImport(batch._id);
    assert.equal(res.result.failed, 1);
    const row = await SocialImportRow.findOne({ batch_id: batch._id });
    assert.equal(row.status, 'failed');
    assert.equal(row.errors[0].code, 'MEDIA_NOT_OWNED');
    assert.equal(await SocialPublication.countDocuments({ importBatchId: batch._id }), 0);
  });

  test('account disconnected between validate and import → row failed ACCOUNT_NO_LONGER_AVAILABLE, others still import', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batch = await seedBatch([
      { platform: 'facebook', content: 'ok', action: 'draft' },
      { platform: 'instagram', content: 'no ig account', action: 'draft', media: [{ url: ownedMediaUrl, type: 'image' }] },
    ]);
    const res = await runImport(batch._id);
    assert.equal(res.result.imported, 1);
    assert.equal(res.result.failed, 1);
    const igRow = await SocialImportRow.findOne({ batch_id: batch._id, rowNumber: 2 });
    assert.equal(igRow.status, 'failed');
    assert.equal(igRow.errors[0].code, 'ACCOUNT_NO_LONGER_AVAILABLE');
  });

  test('a schedule row whose time became past → row failed PAST_SCHEDULE, never silently a draft', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batch = await seedBatch([{ platform: 'facebook', content: 'stale', action: 'schedule', scheduledAt: new Date(Date.now() - 60_000), timezone: 'UTC' }]);
    const res = await runImport(batch._id);
    assert.equal(res.result.failed, 1);
    const row = await SocialImportRow.findOne({ batch_id: batch._id });
    assert.equal(row.errors[0].code, 'PAST_SCHEDULE');
    assert.equal(await SocialPublication.countDocuments({ importBatchId: batch._id }), 0);
  });

  test('a valid row whose platform is no longer supported → row failed, batch still completed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batch = await seedBatch([{ platform: null, content: 'weird', action: 'draft' }]);
    const res = await runImport(batch._id);
    assert.equal(res.batch.status, 'completed');
    assert.equal(res.result.failed, 1);
    assert.equal((await SocialImportRow.findOne({ batch_id: batch._id })).errors[0].code, 'UNSUPPORTED_PLATFORM');
  });

  test('invalid rows are NEVER imported (both modes)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batch = await seedBatch([
      { platform: 'facebook', content: 'good', action: 'draft', status: 'valid' },
      // Phase 2 stores platform:null (schema enum) for an unsupported value; raw keeps 'pinterest'.
      { platform: null, content: 'bad', action: 'draft', status: 'invalid', errors: [{ field: 'platform', code: 'UNSUPPORTED_PLATFORM', message: 'x' }] },
    ]);
    const res = await runImport(batch._id, 'all-as-draft');
    assert.equal(res.result.attempted, 1);
    assert.equal(res.result.imported, 1);
    const badRow = await SocialImportRow.findOne({ batch_id: batch._id, rowNumber: 2 });
    assert.equal(badRow.status, 'invalid', 'still invalid, never imported');
  });

  // ─────────────────────── batch lifecycle ───────────────────────

  test('an invalid mode is rejected', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batch = await seedBatch([{ platform: 'facebook', content: 'x' }]);
    const res = await importValidatedBatch({ projectId: project._id.toString(), userId: userId.toString(), batchId: batch._id.toString(), mode: 'publish-everything' });
    assert.equal(res.success, false);
    assert.equal(res.error.code, 'INVALID_MODE');
  });

  test('a batch that is still validating cannot be imported', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batch = await seedBatch([{ platform: 'facebook', content: 'x' }], { status: 'validating' });
    const res = await runImport(batch._id);
    assert.equal(res.error.code, 'IMPORT_BATCH_NOT_READY');
  });

  test('a batch already importing → IMPORT_ALREADY_IN_PROGRESS', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batch = await seedBatch([{ platform: 'facebook', content: 'x' }], { status: 'importing', importMode: 'valid-only' });
    // Not the resumable "failed" state — genuinely in progress.
    const res = await runImport(batch._id);
    assert.equal(res.error.code, 'IMPORT_ALREADY_IN_PROGRESS');
  });

  test('a parse-failed batch (importMode null) cannot be imported', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batch = await seedBatch([], { status: 'failed', importMode: null });
    const res = await runImport(batch._id);
    assert.equal(res.error.code, 'IMPORT_BATCH_FAILED');
  });

  test('an expired batch cannot be imported', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batch = await seedBatch([{ platform: 'facebook', content: 'x' }], { status: 'expired' });
    const res = await runImport(batch._id);
    assert.equal(res.error.code, 'IMPORT_BATCH_EXPIRED');
  });

  test('another project cannot import this batch', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batch = await seedBatch([{ platform: 'facebook', content: 'x' }]);
    const res = await importValidatedBatch({ projectId: otherProject._id.toString(), userId: userId.toString(), batchId: batch._id.toString(), mode: 'valid-only' });
    assert.equal(res.error.code, 'NOT_FOUND');
    assert.equal(await SocialPublication.countDocuments({ importBatchId: batch._id }), 0);
  });

  // ─────────────────────────── idempotency ───────────────────────────

  test('calling import twice returns a replay and creates NO second publication', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batch = await seedBatch([
      { platform: 'facebook', content: 'A', action: 'draft' },
      { platform: 'facebook', content: 'B', action: 'schedule', scheduledAt: new Date(Date.now() + 3600_000), timezone: 'UTC' },
    ]);
    const first = await runImport(batch._id);
    const second = await runImport(batch._id);

    assert.equal(first.success, true);
    assert.equal(second.success, true);
    assert.equal(second.replay, true);
    assert.deepEqual(second.result, first.result);
    assert.equal(await SocialPublication.countDocuments({ importBatchId: batch._id }), 2, 'exactly one publication per row, no matter how many times import is called');
  });

  test('a row that already has publication_id is treated as imported (no new publication)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batch = await seedBatch([{ platform: 'facebook', content: 'pre-linked', action: 'draft' }]);
    // Pre-create a publication and link it, leaving the batch `ready`.
    const pub = await SocialPublication.create({
      project_id: project._id, social_account_id: new mongoose.Types.ObjectId(), platform: 'facebook',
      content: 'pre-linked', status: 'draft', createdBy: userId, importBatchId: batch._id, importRowNumber: 1,
    });
    await SocialImportRow.updateOne({ batch_id: batch._id, rowNumber: 1 }, { $set: { publication_id: pub._id, status: 'valid' } });

    const res = await runImport(batch._id);
    assert.equal(res.result.imported, 1);
    assert.equal(await SocialPublication.countDocuments({ importBatchId: batch._id }), 1);
    assert.equal((await SocialImportRow.findOne({ batch_id: batch._id })).publication_id.toString(), pub._id.toString());
  });

  test('a publication that exists by {importBatchId,importRowNumber} but is unlinked → the row link is repaired', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batch = await seedBatch([{ platform: 'facebook', content: 'orphan pub', action: 'draft' }]);
    const pub = await SocialPublication.create({
      project_id: project._id, social_account_id: new mongoose.Types.ObjectId(), platform: 'facebook',
      content: 'orphan pub', status: 'draft', createdBy: userId, importBatchId: batch._id, importRowNumber: 1,
    });
    // Row is NOT linked.
    const res = await runImport(batch._id);
    assert.equal(res.result.imported, 1);
    assert.equal(await SocialPublication.countDocuments({ importBatchId: batch._id }), 1);
    assert.equal((await SocialImportRow.findOne({ batch_id: batch._id })).publication_id.toString(), pub._id.toString());
  });

  test('two concurrent import calls: only one does the work, total publications == valid row count', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batch = await seedBatch([
      { platform: 'facebook', content: 'A', action: 'draft' },
      { platform: 'facebook', content: 'B', action: 'draft' },
      { platform: 'facebook', content: 'C', action: 'draft' },
    ]);
    const [a, b] = await Promise.all([runImport(batch._id), runImport(batch._id)]);
    // At least one call does the work; the loser of the atomic claim
    // either replays a completed batch or gets IMPORT_ALREADY_IN_PROGRESS
    // — never does a second round of creation.
    assert.ok(a.success || b.success, 'at least one call completes the import');
    for (const r of [a, b]) {
      if (!r.success) assert.equal(r.error.code, 'IMPORT_ALREADY_IN_PROGRESS');
    }
    assert.equal(await SocialPublication.countDocuments({ importBatchId: batch._id }), 3, 'no duplicates under concurrency');
    const finalBatch = await SocialImportBatch.findById(batch._id);
    assert.equal(finalBatch.status, 'completed');
  });

  test('counts are stable across repeated import calls', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batch = await seedBatch([
      { platform: 'facebook', content: 'D', action: 'draft' },
      { platform: 'facebook', content: 'P', action: 'publish' },
      { platform: 'instagram', content: 'fails - no ig', action: 'draft', media: [{ url: ownedMediaUrl, type: 'image' }] },
    ]);
    const first = await runImport(batch._id);
    const replay = await runImport(batch._id);
    const b1 = await SocialImportBatch.findById(batch._id);
    assert.deepEqual(
      { imported: b1.counts.imported, failed: b1.counts.failed, drafts: b1.counts.drafts, scheduled: b1.counts.scheduled },
      { imported: 2, failed: 1, drafts: 1, scheduled: 1 },
    );
    assert.deepEqual(replay.result, first.result);
  });

  // ─────────────────────── scheduler flag ───────────────────────

  test('when SOCIAL_SCHEDULER_ENABLED is not "true", a scheduled import carries a warning', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const prev = process.env.SOCIAL_SCHEDULER_ENABLED;
    process.env.SOCIAL_SCHEDULER_ENABLED = 'false';
    try {
      const batch = await seedBatch([{ platform: 'facebook', content: 'P', action: 'publish' }]);
      const res = await runImport(batch._id);
      assert.equal(res.schedulerEnabled, false);
      assert.ok(res.warnings.some((w) => /disabled/i.test(w)));
    } finally {
      process.env.SOCIAL_SCHEDULER_ENABLED = prev;
    }
  });
});
