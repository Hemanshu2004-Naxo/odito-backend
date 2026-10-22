import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import VerificationBatch from '../model/VerificationBatch.js';
import PageVerificationRun from '../model/PageVerificationRun.js';
import { BATCH_STATUS } from '../constants/batchStatus.js';
import { getVerificationBatch, getVerificationBatchRuns } from './VerificationBatchController.js';
import verificationHistoryRoutes from '../routes/verificationHistoryRoutes.js';

// F4-018 §8: read-only REST recovery API. Same live-Mongo, direct-
// controller-invocation convention as VerificationHistoryController.test.js
// (P3-007) — these are genuinely new endpoints, so exercised the same way.

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

let project;
let owner;

async function makeProject() {
  owner = new mongoose.Types.ObjectId();
  project = await SeoProject.create({
    user_id: owner,
    project_name: 'F4-018 Test Project',
    main_url: 'https://example.com',
    seo_scope: 'national',
    keywords: ['test keyword'],
    crawl_status: 'pending',
  });
  return project;
}

afterEach(async () => {
  if (mongoAvailable && project) {
    await VerificationBatch.deleteMany({ projectId: project._id });
    await PageVerificationRun.deleteMany({ projectId: project._id });
    await SeoProject.deleteOne({ _id: project._id });
    project = null;
  }
});

function fakeRes() {
  const res = { statusCode: null, body: null, status(c) { res.statusCode = c; return res; }, json(b) { res.body = b; return res; } };
  return res;
}

async function makeBatch(overrides = {}) {
  const batchId = new mongoose.Types.ObjectId().toString();
  return VerificationBatch.create({
    batchId,
    projectId: project._id,
    urls: ['https://example.com/a', 'https://example.com/b'],
    totalUrls: 2,
    status: BATCH_STATUS.COMPLETED,
    completedUrls: 2,
    failedUrls: 0,
    ...overrides,
  });
}

describe('getVerificationBatch (F4-018)', () => {
  test('returns the full persisted shape for an owned batch', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    const batch = await makeBatch();

    const req = { params: { batchId: batch.batchId }, user: { _id: owner } };
    const res = fakeRes();
    await getVerificationBatch(req, res);

    assert.equal(res.body.success, true);
    const data = res.body.data;
    assert.equal(data.batchId, batch.batchId);
    assert.equal(data.projectId, project._id.toString());
    assert.equal(data.status, BATCH_STATUS.COMPLETED);
    assert.equal(data.totalUrls, 2);
    assert.equal(data.completedUrls, 2);
    assert.equal(data.failedUrls, 0);
    assert.deepEqual(data.urls, ['https://example.com/a', 'https://example.com/b']);
  });

  test('not found: an unknown batchId returns 404', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const req = { params: { batchId: 'does-not-exist' }, user: { _id: new mongoose.Types.ObjectId() } };
    const res = fakeRes();
    await getVerificationBatch(req, res);

    assert.equal(res.statusCode, 404);
    assert.equal(res.body.success, false);
  });

  test('forbidden: a user who does not own the batch\'s project gets 403', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    const batch = await makeBatch();

    const req = { params: { batchId: batch.batchId }, user: { _id: new mongoose.Types.ObjectId() } };
    const res = fakeRes();
    await getVerificationBatch(req, res);

    assert.equal(res.statusCode, 403);
  });

  test('response shape does not expose internal implementation details (no raw Job IDs, no Mongoose internals)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    const batch = await makeBatch();

    const req = { params: { batchId: batch.batchId }, user: { _id: owner } };
    const res = fakeRes();
    await getVerificationBatch(req, res);

    const expectedKeys = [
      'batchId', 'projectId', 'status', 'totalUrls', 'completedUrls', 'failedUrls',
      'urls', 'startedAt', 'completedAt', 'aggregateStartedAt', 'aggregateCompletedAt',
      'errorMessage', 'createdAt', 'updatedAt',
    ].sort();
    assert.deepEqual(Object.keys(res.body.data).sort(), expectedKeys);
  });
});

describe('getVerificationBatchRuns (F4-018)', () => {
  test('returns every PageVerificationRun belonging to this batch, oldest first', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    const batch = await makeBatch();
    const runA = await PageVerificationRun.create({
      projectId: project._id, batchId: batch.batchId, runId: new mongoose.Types.ObjectId().toString(),
      pageUrl: 'https://example.com/a', status: 'completed',
    });
    await new Promise((r) => setTimeout(r, 10));
    const runB = await PageVerificationRun.create({
      projectId: project._id, batchId: batch.batchId, runId: new mongoose.Types.ObjectId().toString(),
      pageUrl: 'https://example.com/b', status: 'completed',
    });
    // A run belonging to a DIFFERENT batch must never leak in.
    await PageVerificationRun.create({
      projectId: project._id, batchId: 'some-other-batch', runId: new mongoose.Types.ObjectId().toString(),
      pageUrl: 'https://example.com/unrelated', status: 'completed',
    });

    const req = { params: { batchId: batch.batchId }, user: { _id: owner } };
    const res = fakeRes();
    await getVerificationBatchRuns(req, res);

    assert.equal(res.body.success, true);
    assert.equal(res.body.data.length, 2);
    assert.equal(res.body.data[0].runId, runA.runId);
    assert.equal(res.body.data[1].runId, runB.runId);
  });

  test('not found: an unknown batchId returns 404', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const req = { params: { batchId: 'does-not-exist' }, user: { _id: new mongoose.Types.ObjectId() } };
    const res = fakeRes();
    await getVerificationBatchRuns(req, res);

    assert.equal(res.statusCode, 404);
  });

  test('forbidden: a user who does not own the batch\'s project gets 403', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    const batch = await makeBatch();

    const req = { params: { batchId: batch.batchId }, user: { _id: new mongoose.Types.ObjectId() } };
    const res = fakeRes();
    await getVerificationBatchRuns(req, res);

    assert.equal(res.statusCode, 403);
  });

  test('a batch with no runs yet returns an empty array, not an error', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    const batch = await makeBatch({ status: BATCH_STATUS.RUNNING, completedUrls: 0 });

    const req = { params: { batchId: batch.batchId }, user: { _id: owner } };
    const res = fakeRes();
    await getVerificationBatchRuns(req, res);

    assert.deepEqual(res.body.data, []);
  });
});

describe('verificationHistoryRoutes — F4-018 route registration', () => {
  test('both new verification-batches routes are registered on the router, behind auth', () => {
    const paths = verificationHistoryRoutes.stack.filter((l) => l.route).map((l) => l.route.path);
    assert.ok(paths.includes('/verification-batches/:batchId'));
    assert.ok(paths.includes('/verification-batches/:batchId/runs'));

    const authLayer = verificationHistoryRoutes.stack.find((l) => !l.route && l.name === 'auth');
    assert.ok(authLayer, 'auth middleware must be registered on this router');
  });
});
