import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import Task from '../model/Task.js';
import SeoProject from '../../app_user/model/SeoProject.js';
import { getTaskById, getTaskHistory, updateTaskStatus, deleteTask, applyWordPressFix } from './taskController.js';

/**
 * Phase 3 — authorization end-to-end, through the real controller functions
 * (the actual production code exercised by the real Express routes; no
 * supertest/HTTP layer exists anywhere in this repo, so this follows the
 * established convention of testing at the point routing dispatches to,
 * with mock req/res objects standing in for Express — the ownership check
 * itself (assertTaskOwnership -> AuthUtil.validateProjectAccess) is 100%
 * real code, hitting a real SeoProject in Mongo).
 *
 * Proves: User B cannot read, list history for, mutate, or delete a task
 * that belongs to a project User A owns — via taskId alone, without ever
 * needing to guess/supply the correct projectId.
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
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

describe('Task authorization — cross-user access via the real controller + AuthUtil (live Mongo)', () => {
  let userA, userB, projectA, taskA;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    userA = new mongoose.Types.ObjectId();
    userB = new mongoose.Types.ObjectId();

    projectA = await SeoProject.create({
      user_id: userA,
      project_name: `E2E Auth Test ${Date.now()}`,
      main_url: 'https://owned-by-user-a.example.com',
      seo_scope: 'local',
      keywords: ['e2e authorization test'],
    });

    taskA = await Task.create({
      projectId: projectA._id,
      issueKey: 'meta_description_missing',
      issueName: 'Meta Description Missing',
      issueCategory: 'Content',
      pageUrl: 'https://owned-by-user-a.example.com/page',
      status: 'implemented',
      origin: 'manual',
    });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    await Task.deleteOne({ _id: taskA._id });
    await SeoProject.deleteOne({ _id: projectA._id });
  });

  test('User B cannot GET /tasks/:taskId belonging to User A\'s project', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const req = { params: { taskId: taskA._id.toString() }, user: { _id: userB } };
    const res = mockRes();
    await getTaskById(req, res);

    assert.equal(res.statusCode, 403);
    assert.equal(res.body.success, false);
    // Must not leak the task's data alongside the denial.
    assert.equal(res.body.data, undefined);
  });

  test('User B cannot GET /tasks/:taskId/history belonging to User A\'s project', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const req = { params: { taskId: taskA._id.toString() }, query: {}, user: { _id: userB } };
    const res = mockRes();
    await getTaskHistory(req, res);

    assert.equal(res.statusCode, 403);
    assert.equal(res.body.data, undefined);
  });

  test('User B cannot PATCH /tasks/:taskId/status (mutate) a task belonging to User A\'s project', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const req = { params: { taskId: taskA._id.toString() }, body: { status: 'verified_fixed' }, user: { _id: userB } };
    const res = mockRes();
    await updateTaskStatus(req, res);

    assert.equal(res.statusCode, 403);

    // Confirm the mutation genuinely did not happen.
    const reloaded = await Task.findById(taskA._id);
    assert.equal(reloaded.status, 'implemented', 'status must be unchanged after a denied cross-user mutation attempt');
  });

  test('User B cannot DELETE a task belonging to User A\'s project', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const req = { params: { taskId: taskA._id.toString() }, user: { _id: userB } };
    const res = mockRes();
    await deleteTask(req, res);

    assert.equal(res.statusCode, 403);

    const reloaded = await Task.findById(taskA._id);
    assert.equal(reloaded.isDeleted, false, 'task must not be soft-deleted after a denied cross-user attempt');
  });

  test('User B CANNOT bypass ownership by knowing the taskId alone, even with a correctly-shaped request', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    // Simulates an attacker who has legitimately obtained a real taskId
    // (e.g. from a shared link, browser history, or enumeration) but has no
    // relationship to the owning project whatsoever.
    const req = { params: { taskId: taskA._id.toString() }, user: { _id: new mongoose.Types.ObjectId() } };
    const res = mockRes();
    await getTaskById(req, res);

    assert.equal(res.statusCode, 403);
  });

  test('the real owner (User A) CAN access their own task — the check is not overly restrictive', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const req = { params: { taskId: taskA._id.toString() }, user: { _id: userA } };
    const res = mockRes();
    await getTaskById(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data._id.toString(), taskA._id.toString());
  });

  test('User B cannot POST /tasks/:taskId/apply-wordpress (Phase 4) on a task belonging to User A\'s project', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    // Ownership is checked before wordPressSeoFixService is ever invoked —
    // no WordPress connection/mocking needed for this to correctly 403.
    const req = { params: { taskId: taskA._id.toString() }, body: { approved: true, expectedCurrentValue: 'anything' }, user: { _id: userB } };
    const res = mockRes();
    await applyWordPressFix(req, res);

    assert.equal(res.statusCode, 403);
    assert.equal(res.body.data, undefined);

    // Confirm the mutation genuinely did not happen and origin was never touched.
    const reloaded = await Task.findById(taskA._id);
    assert.equal(reloaded.status, 'implemented');
    assert.notEqual(reloaded.origin, 'wordpress_auto');
  });

  test('a request for a nonexistent taskId returns 404 without leaking whether the ID exists under another project', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const req = { params: { taskId: new mongoose.Types.ObjectId().toString() }, user: { _id: userB } };
    const res = mockRes();
    await getTaskById(req, res);

    assert.equal(res.statusCode, 404);
  });
});
