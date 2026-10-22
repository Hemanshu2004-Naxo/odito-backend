import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import Task from '../model/Task.js';
import SeoProject from '../../app_user/model/SeoProject.js';
import Recommendation from '../../recommendations/model/Recommendation.js';
import { linkTaskRecommendation, getActiveTaskUrls } from './taskController.js';

/**
 * linkTaskRecommendation() — added to fix a real production bug: a Task
 * created BEFORE any AI recommendation existed (e.g. via the DIY flow)
 * never had its recommendationId backfilled when a recommendation was
 * later generated, because createTask()'s own idempotent "return the
 * existing task" path only ever sets recommendationId at INSERT time. The
 * frontend's WordPress apply-fix flow was — before this fix — trusting its
 * own local, ephemeral recommendation-generation state instead of the
 * Task's real, persisted recommendationId, so "Apply Fix" rendered enabled
 * while the backend correctly rejected with RECOMMENDATION_REQUIRED.
 *
 * Real controller functions (mock req/res, real Mongo), same convention as
 * taskAuthorization.e2e.test.js.
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

async function createRecommendation(projectId, ruleId = 'meta_description_missing') {
  return Recommendation.create({
    projectId,
    fingerprint: `fp-${ruleId}-${new mongoose.Types.ObjectId()}`,
    recommendationHash: `hash-${new mongoose.Types.ObjectId()}`,
    ruleId,
    category: 'on_page',
    sections: {
      whyThisMatters: 'test',
      recommendedFix: 'test',
      implementationExample: { type: 'text', content: 'test' },
      contentRewrite: { optimized: 'A real optimized meta description.' },
    },
  });
}

describe('linkTaskRecommendation() — links a recommendation onto an already-existing task', () => {
  let userA, userB, projectA, task;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    userA = new mongoose.Types.ObjectId();
    userB = new mongoose.Types.ObjectId();

    projectA = await SeoProject.create({
      user_id: userA,
      project_name: `Link Recommendation Test ${Date.now()}`,
      main_url: 'https://example-link-rec.test',
      seo_scope: 'local',
      keywords: ['link recommendation test'],
    });

    task = await Task.create({
      projectId: projectA._id,
      issueKey: 'meta_description_missing',
      issueName: 'Meta Description Missing',
      issueCategory: 'Content',
      pageUrl: 'https://example-link-rec.test/page',
      status: 'task_created',
      origin: 'manual',
      // No recommendationId — exactly the "created via DIY before any
      // recommendation existed" state this whole fix targets.
    });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    await Task.deleteMany({ projectId: projectA._id });
    await Recommendation.deleteMany({ projectId: projectA._id });
    await SeoProject.deleteOne({ _id: projectA._id });
  });

  test('successfully links a same-project recommendation to a task_created task', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const rec = await createRecommendation(projectA._id);
    const req = { params: { taskId: task._id.toString() }, body: { recommendationId: rec._id.toString() }, user: { _id: userA } };
    const res = mockRes();

    await linkTaskRecommendation(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.recommendationId.toString(), rec._id.toString());

    const reloaded = await Task.findById(task._id);
    assert.equal(reloaded.recommendationId.toString(), rec._id.toString());
  });

  test('rejects a recommendation belonging to a different project (422 RECOMMENDATION_REQUIRED)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const otherProject = await SeoProject.create({
      user_id: userA, project_name: 'Other Project', main_url: 'https://other.example.com',
      seo_scope: 'local', keywords: ['other'],
    });
    const foreignRec = await createRecommendation(otherProject._id);

    const req = { params: { taskId: task._id.toString() }, body: { recommendationId: foreignRec._id.toString() }, user: { _id: userA } };
    const res = mockRes();
    await linkTaskRecommendation(req, res);

    assert.equal(res.statusCode, 422);
    assert.equal(res.body.success, false);
    assert.equal(res.body.code, 'RECOMMENDATION_REQUIRED');

    const reloaded = await Task.findById(task._id);
    assert.equal(reloaded.recommendationId, null, 'must never link a cross-project recommendation');

    await SeoProject.deleteOne({ _id: otherProject._id });
    await Recommendation.deleteOne({ _id: foreignRec._id });
  });

  test('rejects linking once the task has progressed past task_created/reopened (409)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    task.status = 'implemented';
    await task.save();

    const rec = await createRecommendation(projectA._id);
    const req = { params: { taskId: task._id.toString() }, body: { recommendationId: rec._id.toString() }, user: { _id: userA } };
    const res = mockRes();
    await linkTaskRecommendation(req, res);

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.success, false);
  });

  test('a different user cannot link a recommendation onto a task belonging to another project (403)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const rec = await createRecommendation(projectA._id);
    const req = { params: { taskId: task._id.toString() }, body: { recommendationId: rec._id.toString() }, user: { _id: userB } };
    const res = mockRes();
    await linkTaskRecommendation(req, res);

    assert.equal(res.statusCode, 403);
    const reloaded = await Task.findById(task._id);
    assert.equal(reloaded.recommendationId, null);
  });

  test('rejects a missing/invalid recommendationId (400)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const req = { params: { taskId: task._id.toString() }, body: { recommendationId: 'not-a-real-id' }, user: { _id: userA } };
    const res = mockRes();
    await linkTaskRecommendation(req, res);

    assert.equal(res.statusCode, 400);
  });
});

describe('getActiveTaskUrls() — includes recommendationId so the frontend can gate on the real, persisted link', () => {
  let userA, projectA;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    userA = new mongoose.Types.ObjectId();
    projectA = await SeoProject.create({
      user_id: userA, project_name: `ActiveTaskUrls Test ${Date.now()}`,
      main_url: 'https://active-task-urls.test', seo_scope: 'local', keywords: ['x'],
    });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    await Task.deleteMany({ projectId: projectA._id });
    await Recommendation.deleteMany({ projectId: projectA._id });
    await SeoProject.deleteOne({ _id: projectA._id });
  });

  test('a task with a linked recommendation reports its real recommendationId, not null', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const rec = await createRecommendation(projectA._id);
    await Task.create({
      projectId: projectA._id, issueKey: 'meta_description_missing', pageUrl: 'https://active-task-urls.test/linked',
      status: 'task_created', origin: 'manual', recommendationId: rec._id,
    });

    const req = { query: { projectId: projectA._id.toString(), issueKey: 'meta_description_missing' } };
    const res = mockRes();
    await getActiveTaskUrls(req, res);

    assert.equal(res.statusCode, 200);
    const entry = res.body.data.taskMap['https://active-task-urls.test/linked'];
    assert.ok(entry, 'expected an entry for the linked task URL');
    assert.equal(entry.recommendationId?.toString(), rec._id.toString());
  });

  test('a task with no linked recommendation reports recommendationId: null, never undefined or omitted', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await Task.create({
      projectId: projectA._id, issueKey: 'meta_description_missing', pageUrl: 'https://active-task-urls.test/unlinked',
      status: 'task_created', origin: 'manual',
    });

    const req = { query: { projectId: projectA._id.toString(), issueKey: 'meta_description_missing' } };
    const res = mockRes();
    await getActiveTaskUrls(req, res);

    assert.equal(res.statusCode, 200);
    const entry = res.body.data.taskMap['https://active-task-urls.test/unlinked'];
    assert.ok(entry);
    assert.equal(entry.recommendationId, null);
  });
});
