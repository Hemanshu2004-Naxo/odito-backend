import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../../app_user/model/SeoProject.js';
import SocialImportBatch from '../../model/SocialImportBatch.js';
import SocialPublication from '../../model/SocialPublication.js';
import { recoverStaleImportingBatches } from './bulkImportRecoveryService.js';

/**
 * Bulk Upload — Phase 5. Stale-import sweeper. Real MongoDB, no mocking.
 *
 * The sweeper is intentionally GLOBAL (one cron, every project), so
 * assertions check the SPECIFIC batch under test rather than the global
 * `recovered` tally (other test files may create `importing` batches in
 * parallel).
 */

let mongoAvailable = false;
const STALE_MS = 10 * 60 * 1000;
const old = (ms) => new Date(Date.now() - ms);

before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    await SocialImportBatch.syncIndexes();
    mongoAvailable = true;
  } catch { mongoAvailable = false; }
});
after(async () => { if (mongoAvailable) await mongoose.connection.close(); });

describe('recoverStaleImportingBatches', () => {
  let project;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    project = await SeoProject.create({
      user_id: new mongoose.Types.ObjectId(),
      project_name: `Bulk P5 Rec ${Date.now()}-${Math.random().toString(36).slice(2)}`,
      main_url: 'https://example.com', seo_scope: 'local', keywords: ['x'],
    });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    await SocialImportBatch.deleteMany({ project_id: project._id });
    await SocialPublication.deleteMany({ project_id: project._id });
    await SeoProject.deleteOne({ _id: project._id });
  });

  function batch(overrides = {}) {
    return SocialImportBatch.create({
      project_id: project._id, createdBy: new mongoose.Types.ObjectId(),
      filename: 'x.csv', fileHash: Math.random().toString(36).slice(2), format: 'csv',
      status: 'importing', importMode: 'valid-only',
      importClaimId: 'claim-1', importStartedAt: old(STALE_MS + 60_000), importHeartbeatAt: old(STALE_MS + 60_000),
      ...overrides,
    });
  }

  test('recovers a genuinely stale importing batch → failed, re-claimable, reason recorded', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const b = await batch();
    const res = await recoverStaleImportingBatches({ staleThresholdMs: STALE_MS });
    assert.ok(res.recovered >= 1);

    const after = await SocialImportBatch.findById(b._id);
    assert.equal(after.status, 'failed');
    assert.equal(after.importClaimId, null);
    assert.equal(after.recoveryReason, 'stale_importing_no_heartbeat');
    assert.ok(after.recoveredAt instanceof Date);
    assert.equal(after.importMode, 'valid-only', 'importMode stays set so the executor can re-claim it');
    assert.ok(after.errorSummary);
  });

  test('does NOT recover a fresh (recently-heartbeated) importing batch', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const b = await batch({ importHeartbeatAt: new Date() });
    await recoverStaleImportingBatches({ staleThresholdMs: STALE_MS });
    assert.equal((await SocialImportBatch.findById(b._id)).status, 'importing');
  });

  test('race guard: a worker heartbeat that lands before the recovery write leaves the batch alone', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const b = await batch();
    await SocialImportBatch.updateOne({ _id: b._id }, { $set: { importHeartbeatAt: new Date() } });
    await recoverStaleImportingBatches({ staleThresholdMs: STALE_MS });
    assert.equal((await SocialImportBatch.findById(b._id)).status, 'importing');
  });

  test('race guard: a worker RE-CLAIM landing between the sweep find and its conditional write is left alone', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const b = await batch(); // stale, importClaimId: 'claim-1'

    const origUpdateOne = SocialImportBatch.updateOne.bind(SocialImportBatch);
    let raced = false;
    SocialImportBatch.updateOne = async (filter, update, ...rest) => {
      // Intercept THIS batch's recovery write; just before it, a fresh
      // execution re-claims the batch (new id + fresh heartbeat).
      if (!raced && update?.$set?.recoveryReason === 'stale_importing_no_heartbeat'
        && String(filter?._id) === String(b._id)) {
        raced = true;
        await origUpdateOne({ _id: b._id }, { $set: { importClaimId: 'claim-2', importHeartbeatAt: new Date() } });
      }
      return origUpdateOne(filter, update, ...rest);
    };

    let res;
    try {
      res = await recoverStaleImportingBatches({ staleThresholdMs: STALE_MS });
    } finally {
      SocialImportBatch.updateOne = origUpdateOne;
    }

    assert.ok(raced, 'the interleave actually happened');
    const after = await SocialImportBatch.findById(b._id);
    assert.equal(after.status, 'importing', 'still owned by the live re-claim — not recovered');
    assert.equal(after.importClaimId, 'claim-2');
    assert.equal(res.skipped >= 1, true);
  });

  test('never touches SocialPublication rows', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const b = await batch();
    const pub = await SocialPublication.create({
      project_id: project._id, social_account_id: new mongoose.Types.ObjectId(), platform: 'facebook',
      content: 'x', status: 'draft', createdBy: new mongoose.Types.ObjectId(),
      importBatchId: b._id, importRowNumber: 1,
    });
    await recoverStaleImportingBatches({ staleThresholdMs: STALE_MS });
    const still = await SocialPublication.findById(pub._id);
    assert.ok(still, 'publication untouched');
    assert.equal(still.status, 'draft');
    assert.equal(await SocialPublication.countDocuments({ importBatchId: b._id }), 1);
  });

  test('safe to run repeatedly — a recovered batch is skipped on the next sweeps', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const b = await batch();
    await recoverStaleImportingBatches({ staleThresholdMs: STALE_MS });
    assert.equal((await SocialImportBatch.findById(b._id)).status, 'failed');

    // Two more sweeps must not re-touch it (no longer `importing`).
    const before = await SocialImportBatch.findById(b._id);
    await recoverStaleImportingBatches({ staleThresholdMs: STALE_MS });
    await recoverStaleImportingBatches({ staleThresholdMs: STALE_MS });
    const after = await SocialImportBatch.findById(b._id);
    assert.equal(after.recoveredAt.getTime(), before.recoveredAt.getTime(), 'recoveredAt is not rewritten');
  });

  test('a never-heartbeated legacy batch is caught via updatedAt', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const b = await SocialImportBatch.create({
      project_id: project._id, createdBy: new mongoose.Types.ObjectId(),
      filename: 'legacy.csv', fileHash: Math.random().toString(36).slice(2), format: 'csv',
      status: 'importing', importMode: 'valid-only',
      importClaimId: null, importHeartbeatAt: null,
    });
    await SocialImportBatch.collection.updateOne({ _id: b._id }, { $set: { updatedAt: old(STALE_MS + 60_000) } });
    await recoverStaleImportingBatches({ staleThresholdMs: STALE_MS });
    assert.equal((await SocialImportBatch.findById(b._id)).status, 'failed');
  });

  test('non-importing statuses (ready / completed / failed / expired) are never swept', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const made = [];
    for (const status of ['ready', 'completed', 'failed', 'expired']) {
      made.push(await SocialImportBatch.create({
        project_id: project._id, createdBy: new mongoose.Types.ObjectId(),
        filename: `${status}.csv`, fileHash: Math.random().toString(36).slice(2), format: 'csv',
        status, importHeartbeatAt: old(STALE_MS + 60_000),
      }));
    }
    await recoverStaleImportingBatches({ staleThresholdMs: STALE_MS });
    for (const m of made) {
      const after = await SocialImportBatch.findById(m._id);
      assert.equal(after.recoveredAt, null, `${after.status} batch must be untouched`);
    }
  });
});
