import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import Task from '../model/Task.js';
import SeoProject from '../../app_user/model/SeoProject.js';
import { getTaskById, getTaskHistory } from './taskController.js';

/**
 * Phase 4 — proves the MongoDB-aggregation-based getTaskById/getTaskHistory
 * (replacing "fetch full fixHistory, slice in Node") produce byte-identical
 * output/ordering/counts to the original JS-slice implementation, against
 * real Mongo, with a task that has a genuinely meaningful number of
 * attempts (5) so ordering and cursor-pagination bugs can't hide in a
 * 1-attempt fixture.
 */

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

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function makeAttempt(n, result) {
  return {
    attemptNumber: n,
    attemptKind: 'fix_attempt',
    origin: 'manual',
    status: result || 'pending_verification',
    before: { capturedAt: new Date(), source: 'diagnostic_string', dataPath: null, value: `before-${n}` },
    fixApplied: { capturedAt: new Date(), recommendationId: null, recommendationVersion: null, snapshot: { recommendedFix: `fix-${n}` }, expectedAfterValue: null },
    implementedAt: new Date(2026, 0, n),
    verification: {
      verifiedAt: new Date(2026, 0, n, 1),
      method: 'presence_fallback',
      result,
      matched: null,
      after: { source: 'unavailable', value: null },
      triggerJobId: null,
    },
  };
}

describe('getTaskById / getTaskHistory — MongoDB-side aggregation matches original JS-slice semantics (live Mongo)', () => {
  let userId, project, task;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    userId = new mongoose.Types.ObjectId();
    project = await SeoProject.create({
      user_id: userId,
      project_name: `History Query Test ${Date.now()}`,
      main_url: 'https://history-query-test.example.com',
      seo_scope: 'local',
      keywords: ['history query test'],
    });

    // 5 attempts, alternating outcomes, attemptNumber 1..5 matching array
    // position — exactly what TaskHistoryService/TaskVerificationService
    // guarantee in production.
    const fixHistory = [
      makeAttempt(1, 'verified_fixed'),
      makeAttempt(2, 'reopened'),
      makeAttempt(3, 'verified_fixed'),
      makeAttempt(4, 'reopened'),
      makeAttempt(5, 'verified_fixed'), // latest
    ];

    task = await Task.create({
      projectId: project._id,
      issueKey: 'meta_description_missing',
      issueName: 'Meta Description Missing',
      issueCategory: 'Content',
      pageUrl: 'https://history-query-test.example.com/page',
      status: 'verified_fixed',
      origin: 'manual',
      fixHistory,
    });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    await Task.deleteOne({ _id: task._id });
    await SeoProject.deleteOne({ _id: project._id });
  });

  test('getTaskById returns the correct latestAttempt (#5), counts, and excludes the raw array', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const req = { params: { taskId: task._id.toString() }, user: { _id: userId } };
    const res = mockRes();
    await getTaskById(req, res);

    assert.equal(res.statusCode, 200);
    const data = res.body.data;
    assert.equal(data.attemptCount, 5);
    assert.equal(data.hasOlderAttempts, true);
    assert.equal(data.historyAvailable, true);
    assert.equal(data.latestAttempt.attemptNumber, 5);
    assert.equal(data.latestAttempt.status, 'verified_fixed');
    assert.equal(data.fixHistory, undefined, 'raw fixHistory array must not be present in the response');
    // Every other task field must still be present (exclusion projection, not a hardcoded field list).
    assert.equal(data.issueKey, 'meta_description_missing');
    assert.equal(data.pageUrl, 'https://history-query-test.example.com/page');
    assert.equal(data.status, 'verified_fixed');
  });

  test('getTaskHistory returns older attempts (excluding #5) in newest-first order, unfiltered', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const req = { params: { taskId: task._id.toString() }, query: {}, user: { _id: userId } };
    const res = mockRes();
    await getTaskHistory(req, res);

    assert.equal(res.statusCode, 200);
    const attemptNumbers = res.body.data.attempts.map(a => a.attemptNumber);
    // Newest-first, excluding #5 (the latest, already on the detail endpoint).
    assert.deepEqual(attemptNumbers, [4, 3, 2, 1]);
    assert.equal(res.body.data.hasMore, false);
  });

  test('getTaskHistory respects limit — returns only the N most recent older attempts, still newest-first', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const req = { params: { taskId: task._id.toString() }, query: { limit: '2' }, user: { _id: userId } };
    const res = mockRes();
    await getTaskHistory(req, res);

    const attemptNumbers = res.body.data.attempts.map(a => a.attemptNumber);
    assert.deepEqual(attemptNumbers, [4, 3]);
    assert.equal(res.body.data.hasMore, true, 'attempt #2 and #1 remain beyond the limit');
  });

  test('getTaskHistory\'s before-cursor excludes attempts at or after the cursor, preserving newest-first order', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    // Cursor = 3: only attempts strictly older than #3 (i.e. #2, #1) qualify.
    const req = { params: { taskId: task._id.toString() }, query: { before: '3' }, user: { _id: userId } };
    const res = mockRes();
    await getTaskHistory(req, res);

    const attemptNumbers = res.body.data.attempts.map(a => a.attemptNumber);
    assert.deepEqual(attemptNumbers, [2, 1]);
    assert.equal(res.body.data.hasMore, false);
  });

  test('getTaskHistory\'s before-cursor combined with limit paginates correctly across multiple pages', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    // Page 1: newest 2 older attempts.
    const req1 = { params: { taskId: task._id.toString() }, query: { limit: '2' }, user: { _id: userId } };
    const res1 = mockRes();
    await getTaskHistory(req1, res1);
    assert.deepEqual(res1.body.data.attempts.map(a => a.attemptNumber), [4, 3]);
    assert.equal(res1.body.data.hasMore, true);

    // Page 2: cursor = the last attemptNumber seen on page 1 (3).
    const req2 = { params: { taskId: task._id.toString() }, query: { limit: '2', before: '3' }, user: { _id: userId } };
    const res2 = mockRes();
    await getTaskHistory(req2, res2);
    assert.deepEqual(res2.body.data.attempts.map(a => a.attemptNumber), [2, 1]);
    assert.equal(res2.body.data.hasMore, false, 'exactly 1 attempt (#1) remained, within the limit of 2 — no further page');
  });

  test('a task with exactly 1 attempt has zero older attempts (empty page, not an error)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const singleAttemptTask = await Task.create({
      projectId: project._id,
      issueKey: 'h1_missing',
      pageUrl: 'https://history-query-test.example.com/single',
      status: 'implemented',
      origin: 'manual',
      fixHistory: [makeAttempt(1, null)],
    });

    const detailReq = { params: { taskId: singleAttemptTask._id.toString() }, user: { _id: userId } };
    const detailRes = mockRes();
    await getTaskById(detailReq, detailRes);
    assert.equal(detailRes.body.data.attemptCount, 1);
    assert.equal(detailRes.body.data.hasOlderAttempts, false);

    const historyReq = { params: { taskId: singleAttemptTask._id.toString() }, query: {}, user: { _id: userId } };
    const historyRes = mockRes();
    await getTaskHistory(historyReq, historyRes);
    assert.deepEqual(historyRes.body.data.attempts, []);
    assert.equal(historyRes.body.data.hasMore, false);

    await Task.deleteOne({ _id: singleAttemptTask._id });
  });

  test('a legacy task with no fixHistory at all returns graceful empty results, not a crash', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const legacyTask = await Task.create({
      projectId: project._id,
      issueKey: 'canonical_tag_errors',
      pageUrl: 'https://history-query-test.example.com/legacy',
      status: 'verified_fixed',
      origin: 'manual',
    });

    const detailReq = { params: { taskId: legacyTask._id.toString() }, user: { _id: userId } };
    const detailRes = mockRes();
    await getTaskById(detailReq, detailRes);
    assert.equal(detailRes.statusCode, 200);
    assert.equal(detailRes.body.data.attemptCount, 0);
    assert.equal(detailRes.body.data.latestAttempt, null);
    assert.equal(detailRes.body.data.historyAvailable, false);

    const historyReq = { params: { taskId: legacyTask._id.toString() }, query: {}, user: { _id: userId } };
    const historyRes = mockRes();
    await getTaskHistory(historyReq, historyRes);
    assert.equal(historyRes.statusCode, 200);
    assert.deepEqual(historyRes.body.data.attempts, []);

    await Task.deleteOne({ _id: legacyTask._id });
  });

  test('an invalid taskId format returns 400, not a 500 CastError leak', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const req = { params: { taskId: 'not-a-valid-object-id' }, user: { _id: userId } };
    const res = mockRes();
    await getTaskById(req, res);
    assert.equal(res.statusCode, 400);
  });

  test('authorization is still enforced on the aggregation-based endpoints — a different user is denied', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const req = { params: { taskId: task._id.toString() }, user: { _id: new mongoose.Types.ObjectId() } };
    const res = mockRes();
    await getTaskById(req, res);
    assert.equal(res.statusCode, 403);

    const historyReq = { params: { taskId: task._id.toString() }, query: {}, user: { _id: new mongoose.Types.ObjectId() } };
    const historyRes = mockRes();
    await getTaskHistory(historyReq, historyRes);
    assert.equal(historyRes.statusCode, 403);
  });
});
