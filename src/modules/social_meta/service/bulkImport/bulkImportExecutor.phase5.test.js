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
import { importValidatedBatch } from './bulkImportExecutor.js';
import { BULK_IMPORT_EVENTS } from './bulkImportEvents.js';
import '../../testSupport/stubPermalinkLookup.js';

/**
 * Bulk Upload — Phase 5. Executor real-time events + crash / claim-loss /
 * concurrency hardening. Real MongoDB. A fake `global.io` captures every
 * bulk-import:* payload.
 */

let mongoAvailable = false;
let events;
let originalIo;

before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    await Promise.all([SocialImportBatch.syncIndexes(), SocialImportRow.syncIndexes(), SocialPublication.syncIndexes()]);
    mongoAvailable = true;
  } catch { mongoAvailable = false; }
});
after(async () => { if (mongoAvailable) await mongoose.connection.close(); });

function installFakeIo() {
  originalIo = global.io;
  events = [];
  global.io = {
    to(room) {
      return { emit(event, payload) { events.push({ room, event, payload }); } };
    },
  };
}
function restoreIo() { global.io = originalIo; }

async function noAdapters(fn) {
  const fb = adapters.facebook.publish;
  adapters.facebook.publish = async () => { throw new Error('adapter must NOT run during import'); };
  try { return await fn(); } finally { adapters.facebook.publish = fb; }
}

const FORBIDDEN = ['content', 'media', 'media_urls', 'url', 'raw', 'fileHash', 'token', 'accessToken', 'idempotencyKey', 'stack'];
function assertNoSensitive() {
  const json = JSON.stringify(events);
  for (const k of FORBIDDEN) assert.equal(json.includes(`"${k}"`), false, `event payloads must not contain "${k}"`);
}

describe('bulkImportExecutor — Phase 5', () => {
  let project, userId;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    installFakeIo();
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    userId = new mongoose.Types.ObjectId();
    project = await SeoProject.create({
      user_id: userId, project_name: `Bulk P5 Exec ${suffix}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['x'],
    });
    await SocialAccount.create({
      user_id: userId, project_id: project._id, platform: 'facebook', platformAccountId: `pg_p5_${suffix}`,
      platformAccountName: 'P5 Page', accountType: 'page', pageId: 'pg_p5', accessToken: 'real-token',
      status: 'active', isActive: true, scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
    });
  });

  afterEach(async () => {
    restoreIo();
    if (!mongoAvailable) return;
    const batches = await SocialImportBatch.find({ project_id: project._id }).select('_id');
    await SocialImportRow.deleteMany({ batch_id: { $in: batches.map((b) => b._id) } });
    await SocialImportBatch.deleteMany({ project_id: project._id });
    await SocialPublication.deleteMany({ project_id: project._id });
    await SocialAccount.deleteMany({ project_id: project._id });
    await SeoProject.deleteOne({ _id: project._id });
  });

  async function seed(n, { status = 'ready', importMode = null } = {}) {
    const batch = await SocialImportBatch.create({
      project_id: project._id, createdBy: userId, filename: 'x.csv',
      fileHash: Math.random().toString(36).slice(2), format: 'csv',
      status, importMode, rowCount: n,
      counts: { total: n, valid: n, invalid: 0, imported: 0, failed: 0, drafts: 0, scheduled: 0 },
    });
    await SocialImportRow.insertMany(Array.from({ length: n }, (_, i) => ({
      batch_id: batch._id, project_id: project._id, rowNumber: i + 1,
      raw: { platform: 'facebook' }, idempotencyKey: `${batch._id}-${i}`, status: 'valid', errors: [],
      normalized: { platform: 'facebook', socialAccountId: null, content: `Row ${i + 1}`, media: [], scheduledAt: null, timezone: null, action: 'draft' },
    })));
    return batch;
  }

  const run = (id, mode = 'valid-only') =>
    noAdapters(() => importValidatedBatch({ projectId: project._id.toString(), userId: userId.toString(), batchId: id.toString(), mode }));

  const ev = (name) => events.filter((e) => e.event === name);

  // ── real-time events ──

  test('emits started → one progress per row → completed, to the project room, with safe payloads', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batch = await seed(3);
    const res = await run(batch._id);
    assert.equal(res.success, true);

    assert.equal(ev(BULK_IMPORT_EVENTS.STARTED).length, 1);
    assert.equal(ev(BULK_IMPORT_EVENTS.PROGRESS).length, 3);
    assert.equal(ev(BULK_IMPORT_EVENTS.COMPLETED).length, 1);
    assert.equal(ev(BULK_IMPORT_EVENTS.ERROR).length, 0);

    for (const e of events) {
      assert.equal(e.room, `project-${project._id.toString()}`);
      assert.equal(e.payload.batchId, batch._id.toString());
      assert.equal(e.payload.projectId, project._id.toString());
    }
    const started = ev(BULK_IMPORT_EVENTS.STARTED)[0].payload;
    assert.equal(started.total, 3);
    const lastProgress = ev(BULK_IMPORT_EVENTS.PROGRESS).at(-1).payload;
    assert.equal(lastProgress.processed, 3);
    assert.equal(lastProgress.imported, 3);
    assert.equal(lastProgress.currentRowNumber, 3);
    const completed = ev(BULK_IMPORT_EVENTS.COMPLETED)[0].payload;
    assert.equal(completed.status, 'completed');
    assert.equal(completed.replay, false);
    assert.equal(completed.imported, 3);
    assertNoSensitive();
  });

  test('progress counters are monotonic non-decreasing', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batch = await seed(5);
    await run(batch._id);
    const seq = ev(BULK_IMPORT_EVENTS.PROGRESS).map((e) => e.payload.processed);
    assert.deepEqual(seq, [1, 2, 3, 4, 5]);
    const imp = ev(BULK_IMPORT_EVENTS.PROGRESS).map((e) => e.payload.imported);
    for (let i = 1; i < imp.length; i += 1) assert.ok(imp[i] >= imp[i - 1]);
  });

  test('an idempotent replay emits a completed event with replay:true and creates nothing new', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batch = await seed(2);
    await run(batch._id);
    const pubsAfterFirst = await SocialPublication.countDocuments({ importBatchId: batch._id });
    events = [];
    const replay = await run(batch._id);
    assert.equal(replay.replay, true);
    assert.equal(ev(BULK_IMPORT_EVENTS.COMPLETED).length, 1);
    assert.equal(ev(BULK_IMPORT_EVENTS.COMPLETED)[0].payload.replay, true);
    assert.equal(await SocialPublication.countDocuments({ importBatchId: batch._id }), pubsAfterFirst);
  });

  // ── crash between publication creation and row persistence ──

  test('a publication exists but its row was never linked (crash mid-row) → row is linked & marked imported, NO second publication', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batch = await seed(2);
    // Simulate the post-crash state for row 1: publication created &
    // stamped, but the row.save() that marks it imported never ran.
    const orphan = await SocialPublication.create({
      project_id: project._id, social_account_id: new mongoose.Types.ObjectId(), platform: 'facebook',
      content: 'Row 1', status: 'draft', createdBy: userId, importBatchId: batch._id, importRowNumber: 1,
    });

    const res = await run(batch._id);
    assert.equal(res.success, true);
    assert.equal(res.result.imported, 2);

    const row1 = await SocialImportRow.findOne({ batch_id: batch._id, rowNumber: 1 });
    assert.equal(row1.status, 'imported');
    assert.equal(row1.publication_id.toString(), orphan._id.toString(), 'linked to the EXISTING publication');
    assert.equal(await SocialPublication.countDocuments({ importBatchId: batch._id, importRowNumber: 1 }), 1, 'exactly one publication for row 1');
    assert.equal(await SocialPublication.countDocuments({ importBatchId: batch._id }), 2);
  });

  test('a row already marked imported+linked is a no-op on retry — no duplicate publication', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batch = await seed(1);
    await run(batch._id);
    const pub = await SocialPublication.findOne({ importBatchId: batch._id });
    // Re-claim by forcing the batch back to failed (as the sweeper would).
    await SocialImportBatch.updateOne({ _id: batch._id }, { $set: { status: 'failed', importClaimId: null } });
    events = [];
    const res = await run(batch._id);
    assert.equal(res.success, true);
    assert.equal(await SocialPublication.countDocuments({ importBatchId: batch._id }), 1);
    assert.equal((await SocialPublication.findOne({ importBatchId: batch._id }))._id.toString(), pub._id.toString());
  });

  // ── claim loss (sweeper recovers a batch while the executor is mid-run) ──

  test('the completion write is claim-conditional: if the batch was recovered mid-run, the executor reports IMPORT_FAILED and does NOT stomp the recovered state — no duplicates, retry finishes', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batch = await seed(3);

    const origUpdateOne = SocialImportBatch.updateOne.bind(SocialImportBatch);
    let stolen = false;
    SocialImportBatch.updateOne = async (filter, update, ...rest) => {
      if (!stolen && update?.$set?.status === 'completed') {
        stolen = true;
        // The sweeper recovers this "stale" batch a beat before the
        // executor's own completion write lands.
        await origUpdateOne(
          { _id: batch._id, status: 'importing' },
          { $set: { status: 'failed', importClaimId: null, recoveryReason: 'stale_importing_no_heartbeat', recoveredAt: new Date() } },
        );
      }
      return origUpdateOne(filter, update, ...rest);
    };

    let res;
    try {
      res = await run(batch._id);
    } finally {
      SocialImportBatch.updateOne = origUpdateOne;
    }

    assert.equal(res.success, false);
    assert.equal(res.error.code, 'IMPORT_FAILED');

    const after = await SocialImportBatch.findById(batch._id);
    assert.equal(after.status, 'failed', 'the sweeper-recovered state was NOT overwritten to completed');
    assert.equal(after.recoveryReason, 'stale_importing_no_heartbeat');
    assert.equal(ev(BULK_IMPORT_EVENTS.COMPLETED).length, 0, 'no completed event on a claim-lost run');

    // The rows were still imported idempotently — a retry finishes cleanly with no duplicates.
    const retry = await run(batch._id);
    assert.equal(retry.success, true);
    assert.equal(retry.result.imported, 3);
    assert.equal(await SocialPublication.countDocuments({ importBatchId: batch._id }), 3);
  });

  // ── concurrency: one owner only ──

  test('two concurrent import requests for the same batch → exactly one owns it, exactly one set of publications', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batch = await seed(4);
    const [a, b] = await Promise.all([run(batch._id), run(batch._id)]);

    assert.ok(a.success || b.success, 'at least one completes');
    for (const r of [a, b]) {
      if (!r.success) assert.equal(r.error.code, 'IMPORT_ALREADY_IN_PROGRESS');
    }
    assert.equal(await SocialPublication.countDocuments({ importBatchId: batch._id }), 4, 'no duplicates under concurrency');
    assert.equal((await SocialImportBatch.findById(batch._id)).status, 'completed');
    // Only one execution emitted a `started`.
    assert.equal(ev(BULK_IMPORT_EVENTS.STARTED).length, 1);
  });

  test('the atomic claim stamps a fresh importClaimId + heartbeat; they are cleared on completion', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const batch = await seed(2);
    await run(batch._id);
    const after = await SocialImportBatch.findById(batch._id);
    assert.equal(after.status, 'completed');
    assert.equal(after.importClaimId, null);
    assert.ok(after.importStartedAt instanceof Date);
    assert.ok(after.importHeartbeatAt instanceof Date);
  });
});
