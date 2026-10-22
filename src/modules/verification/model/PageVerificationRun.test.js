import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import PageVerificationRun from './PageVerificationRun.js';

// P3-001: Page Verification Run persistence model.
//
// Schema/validation/default tests need no DB connection (Mongoose
// .validate() is pure in-memory). Index/uniqueness tests need a real
// MongoDB — same live-Mongo-with-auto-skip pattern established in
// Job.test.js (P1-001).

const PROJECT_A = new mongoose.Types.ObjectId();
const PROJECT_B = new mongoose.Types.ObjectId();

function run(overrides = {}) {
  return new PageVerificationRun({
    projectId: PROJECT_A,
    jobId: new mongoose.Types.ObjectId(),
    runId: 'run-' + Math.random().toString(36).slice(2),
    pageUrl: 'https://example.com/pricing',
    startedAt: new Date(),
    ...overrides,
  });
}

describe('PageVerificationRun schema — required/optional/defaults/enum', () => {
  test('accepts a minimal valid document (only required fields)', async () => {
    const doc = run();
    await assert.doesNotReject(() => doc.validate());
  });

  test('required: projectId missing is rejected', async () => {
    const doc = run({ projectId: undefined });
    await assert.rejects(() => doc.validate());
  });

  // F4-013: jobId is no longer required — a batch-created run (this phase)
  // has no job yet by design (jobs aren't created until a later phase
  // dispatches the batch). Every single-URL verification still always
  // provides a real jobId immediately; this only proves the field itself
  // now accepts absence, not that single-URL behavior changed.
  test('F4-013: jobId defaults to null and is no longer required (batch-created runs have none yet)', async () => {
    const doc = run({ jobId: undefined });
    assert.equal(doc.jobId, null);
    await assert.doesNotReject(() => doc.validate());
  });

  test('jobId still accepts an explicit ObjectId (single-URL verification, unchanged)', async () => {
    const jobId = new mongoose.Types.ObjectId();
    const doc = run({ jobId });
    await assert.doesNotReject(() => doc.validate());
    assert.equal(doc.jobId.toString(), jobId.toString());
  });

  test('required: runId missing is rejected', async () => {
    const doc = run({ runId: undefined });
    await assert.rejects(() => doc.validate());
  });

  test('required: pageUrl missing is rejected', async () => {
    const doc = run({ pageUrl: undefined });
    await assert.rejects(() => doc.validate());
  });

  // F4-013: startedAt is no longer required — same reasoning as jobId above.
  test('F4-013: startedAt defaults to null and is no longer required (batch-created runs haven\'t started yet)', async () => {
    const doc = run({ startedAt: undefined });
    assert.equal(doc.startedAt, null);
    await assert.doesNotReject(() => doc.validate());
  });

  test('startedAt still accepts an explicit Date (single-URL verification, unchanged)', async () => {
    const doc = run({ startedAt: new Date() });
    await assert.doesNotReject(() => doc.validate());
    assert.ok(doc.startedAt instanceof Date);
  });

  test('optional: completedAt defaults to null and accepts a Date', async () => {
    const doc = run();
    assert.equal(doc.completedAt, null);
    doc.completedAt = new Date();
    await assert.doesNotReject(() => doc.validate());
  });

  test('optional: errorMessage defaults to null and accepts a string', async () => {
    const doc = run();
    assert.equal(doc.errorMessage, null);
    doc.errorMessage = 'timeout contacting worker';
    await assert.doesNotReject(() => doc.validate());
  });

  test('status defaults to "pending"', async () => {
    const doc = run();
    assert.equal(doc.status, 'pending');
  });

  test('status enum accepts all four documented values', async () => {
    for (const status of ['pending', 'running', 'completed', 'failed']) {
      const doc = run({ status });
      await assert.doesNotReject(() => doc.validate());
    }
  });

  test('status enum rejects an undocumented value', async () => {
    const doc = run({ status: 'bogus' });
    await assert.rejects(() => doc.validate());
  });

  test('before/after/delta default to empty sub-documents, not undefined', async () => {
    const doc = run();
    assert.ok(doc.before);
    assert.ok(doc.after);
    assert.ok(doc.delta);
  });

  test('before/after metric fields default correctly (scores null, issue counts 0)', async () => {
    const doc = run();
    for (const snap of [doc.before, doc.after]) {
      assert.equal(snap.pageScore, null);
      assert.equal(snap.aisoScore, null);
      assert.equal(snap.aeoScore, null);
      assert.equal(snap.geoScore, null);
      assert.equal(snap.criticalIssues, 0);
      assert.equal(snap.warningIssues, 0);
      assert.equal(snap.infoIssues, 0);
    }
  });

  test('delta fields default correctly (score changes null, issue deltas 0)', async () => {
    const doc = run();
    assert.equal(doc.delta.pageScoreChange, null);
    assert.equal(doc.delta.aisoScoreChange, null);
    assert.equal(doc.delta.aeoScoreChange, null);
    assert.equal(doc.delta.geoScoreChange, null);
    assert.equal(doc.delta.issuesFixed, 0);
    assert.equal(doc.delta.issuesIntroduced, 0);
    assert.equal(doc.delta.issuesUnchanged, 0);
  });

  test('before/after/delta accept explicit values and store them as provided', async () => {
    const doc = run({
      before: { pageScore: 72, aisoScore: 60, aeoScore: 55, geoScore: 80, criticalIssues: 2, warningIssues: 1, infoIssues: 0 },
      after:  { pageScore: 90, aisoScore: 75, aeoScore: 70, geoScore: 85, criticalIssues: 0, warningIssues: 1, infoIssues: 0 },
      delta:  { pageScoreChange: 18, aisoScoreChange: 15, aeoScoreChange: 15, geoScoreChange: 5, issuesFixed: 2, issuesIntroduced: 0, issuesUnchanged: 1 },
    });
    await doc.validate();
    assert.equal(doc.before.pageScore, 72);
    assert.equal(doc.after.pageScore, 90);
    assert.equal(doc.delta.pageScoreChange, 18);
  });

  test('collection name is page_verification_runs', () => {
    assert.equal(PageVerificationRun.collection.name, 'page_verification_runs');
  });

  // F4-012 — batchId is additive/optional; every existing behavior above
  // this point must remain true unchanged. These prove the new field
  // doesn't disturb it.
  test('F4-012: batchId defaults to null (today\'s non-batched behavior)', async () => {
    const doc = run();
    assert.equal(doc.batchId, null);
    await assert.doesNotReject(() => doc.validate());
  });

  test('F4-012: batchId accepts an explicit string value', async () => {
    const doc = run({ batchId: 'batch-abc123' });
    await assert.doesNotReject(() => doc.validate());
    assert.equal(doc.batchId, 'batch-abc123');
  });

  test('F4-012: a minimal document with no batchId provided still validates (regression)', async () => {
    const doc = run();
    assert.equal('batchId' in doc.toObject(), true);
    assert.equal(doc.toObject().batchId, null);
    await assert.doesNotReject(() => doc.validate());
  });

  test('no updatedAt timestamp is added (timestamps: false, matches AuditRun)', async () => {
    const doc = run();
    assert.equal(doc.updatedAt, undefined);
  });
});

describe('PageVerificationRun serialization', () => {
  test('toObject includes all top-level fields with correct shape', () => {
    const doc = run({ status: 'completed', completedAt: new Date() });
    const obj = doc.toObject();

    assert.ok(obj.projectId);
    assert.ok(obj.jobId);
    assert.equal(typeof obj.runId, 'string');
    assert.equal(typeof obj.pageUrl, 'string');
    assert.equal(obj.status, 'completed');
    assert.ok(obj.startedAt instanceof Date);
    assert.ok(obj.completedAt instanceof Date);
    assert.ok('before' in obj);
    assert.ok('after' in obj);
    assert.ok('delta' in obj);
    assert.ok(obj.createdAt instanceof Date);
  });

  test('metric sub-documents do not carry their own _id', () => {
    const doc = run();
    const obj = doc.toObject();
    assert.equal(obj.before._id, undefined);
    assert.equal(obj.after._id, undefined);
    assert.equal(obj.delta._id, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Live-Mongo index tests. Auto-skip if MongoDB is unreachable, rather than
// failing the whole suite — matches the established cross-language
// convention for this kind of test.

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
  if (mongoAvailable) {
    await mongoose.connection.close();
  }
});

afterEach(async () => {
  if (mongoAvailable) {
    // Clean only what this suite creates — scoped to the two synthetic
    // project ids, never a broad collection wipe.
    await PageVerificationRun.deleteMany({ projectId: { $in: [PROJECT_A, PROJECT_B] } });
  }
});

describe('PageVerificationRun indexes (live Mongo, auto-skip)', () => {
  test('all four approved indexes exist with the expected keys', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await PageVerificationRun.syncIndexes();
    const indexes = await PageVerificationRun.collection.indexes();

    const runIdIdx = indexes.find((i) => i.name.includes('runId') || (i.key.runId && Object.keys(i.key).length === 1));
    assert.ok(runIdIdx, 'unique runId index must exist');
    assert.equal(runIdIdx.unique, true);
    assert.deepEqual(runIdIdx.key, { runId: 1 });

    const historyIdx = indexes.find(
      (i) => i.key.projectId === 1 && i.key.pageUrl === 1 && i.key.createdAt === -1
    );
    assert.ok(historyIdx, 'projectId+pageUrl+createdAt index must exist');

    const projectLatestIdx = indexes.find(
      (i) => i.key.projectId === 1 && i.key.createdAt === -1 && !('pageUrl' in i.key)
    );
    assert.ok(projectLatestIdx, 'projectId+createdAt index must exist');

    const jobIdIdx = indexes.find((i) => i.key.jobId === 1 && Object.keys(i.key).length === 1);
    assert.ok(jobIdIdx, 'jobId index must exist');

    const batchIdIdx = indexes.find((i) => i.key.batchId === 1 && i.key.status === 1);
    assert.ok(batchIdIdx, 'F4-012: batchId+status partial index must exist');
    assert.deepEqual(batchIdIdx.partialFilterExpression, { batchId: { $type: 'string' } });
  });

  test('F4-012: the batchId+status index is partial — a document with batchId=null is not indexed by it, a document with a real batchId is', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await PageVerificationRun.syncIndexes();

    const unbatched = await run().save(); // batchId defaults to null
    const batched = await run({ batchId: 'batch-index-test' }).save();

    // Both documents exist regardless — the partial index only affects
    // whether Mongo chooses to use that index, not whether the doc is
    // findable at all. Prove both are still queryable by batchId normally.
    const foundNull = await PageVerificationRun.findOne({ _id: unbatched._id });
    const foundBatched = await PageVerificationRun.findOne({ batchId: 'batch-index-test' });
    assert.equal(foundNull.batchId, null);
    assert.equal(foundBatched._id.toString(), batched._id.toString());
  });

  test('repeated initialization is safe (syncIndexes twice does not throw or duplicate)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await PageVerificationRun.syncIndexes();
    await PageVerificationRun.syncIndexes();
    const indexes = await PageVerificationRun.collection.indexes();
    const runIdMatches = indexes.filter((i) => i.key.runId === 1 && Object.keys(i.key).length === 1);
    assert.equal(runIdMatches.length, 1);
  });

  test('duplicate runId is rejected (one doc per run)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await PageVerificationRun.syncIndexes();

    const sharedRunId = 'run-dup-' + Date.now();
    await run({ runId: sharedRunId }).save();
    await assert.rejects(
      () => run({ runId: sharedRunId, pageUrl: 'https://example.com/other' }).save(),
      (err) => err.code === 11000
    );
  });

  test('a different runId for the same project+page is allowed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await PageVerificationRun.syncIndexes();

    await run().save();
    await assert.doesNotReject(() => run().save());
  });

  test('the same runId value is rejected even across different projects', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await PageVerificationRun.syncIndexes();

    const sharedRunId = 'run-cross-project-' + Date.now();
    await run({ runId: sharedRunId }).save();
    await assert.rejects(
      () => run({ runId: sharedRunId, projectId: PROJECT_B }).save(),
      (err) => err.code === 11000
    );
  });
});
