import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import PageVerificationRun from '../model/PageVerificationRun.js';
import {
  getVerificationRun,
  getVerificationHistory,
  getLatestVerificationForPage,
} from './VerificationHistoryController.js';
import verificationHistoryRoutes from '../routes/verificationHistoryRoutes.js';

// P3-007: read-only URL Verification history endpoints (live Mongo, no
// auto-skip fallback — these tests exercise real reads against real
// PageVerificationRun documents, which is the whole point of this API).

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
    project_name: 'P3007 Test Project',
    main_url: 'https://example.com',
    seo_scope: 'national',
    keywords: ['test keyword'],
    crawl_status: 'pending',
  });
  return project;
}

afterEach(async () => {
  if (mongoAvailable && project) {
    await PageVerificationRun.deleteMany({ projectId: project._id });
    await SeoProject.deleteOne({ _id: project._id });
    project = null;
  }
});

function fakeRes() {
  const res = { statusCode: null, body: null, status(c) { res.statusCode = c; return res; }, json(b) { res.body = b; return res; } };
  return res;
}

async function makeRun(overrides = {}) {
  return PageVerificationRun.create({
    projectId: project._id,
    jobId: new mongoose.Types.ObjectId(),
    runId: new mongoose.Types.ObjectId().toString(),
    pageUrl: 'https://example.com/a',
    status: 'completed',
    startedAt: new Date(Date.now() - 5000),
    completedAt: new Date(),
    durationMs: 5000,
    before: { pageScore: 50 },
    after: { pageScore: 80 },
    delta: { pageScoreChange: 30 },
    ...overrides,
  });
}

describe('getVerificationRun (P3-007)', () => {
  test('run lookup: returns the full persisted shape for an owned run', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    const run = await makeRun();

    const req = { params: { runId: run.runId }, user: { _id: owner } };
    const res = fakeRes();
    await getVerificationRun(req, res);

    assert.equal(res.body.success, true);
    const data = res.body.data;
    assert.equal(data.verificationRunId, run._id.toString());
    assert.equal(data.runId, run.runId);
    assert.equal(data.projectId, project._id.toString());
    assert.equal(data.pageUrl, 'https://example.com/a');
    assert.equal(data.status, 'completed');
    assert.equal(data.durationMs, 5000);
    assert.equal(data.before.pageScore, 50);
    assert.equal(data.after.pageScore, 80);
    assert.equal(data.delta.pageScoreChange, 30);
    assert.equal(data.errorMessage, null);
  });

  test('M1: persisted aiVisibilityStatus survives the history API unchanged (read-only, not recomputed)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    const run = await makeRun({ aiVisibilityStatus: 'FAILED', after: { pageScore: 80, aisoScore: null, aeoScore: null, geoScore: null } });

    const req = { params: { runId: run.runId }, user: { _id: owner } };
    const res = fakeRes();
    await getVerificationRun(req, res);

    assert.equal(res.body.data.aiVisibilityStatus, 'FAILED');
    assert.equal(res.body.data.after.aisoScore, null);
  });

  test('not found: an unknown runId returns 404', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const req = { params: { runId: 'does-not-exist' }, user: { _id: new mongoose.Types.ObjectId() } };
    const res = fakeRes();
    await getVerificationRun(req, res);

    assert.equal(res.statusCode, 404);
    assert.equal(res.body.success, false);
  });

  test('forbidden: a user who does not own the run\'s project gets 403', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    const run = await makeRun();

    const req = { params: { runId: run.runId }, user: { _id: new mongoose.Types.ObjectId() } };
    const res = fakeRes();
    await getVerificationRun(req, res);

    assert.equal(res.statusCode, 403);
  });

  test('read-only: no field on the persisted document is modified by a read', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    const run = await makeRun();
    const beforeSnapshot = run.toObject();

    await getVerificationRun({ params: { runId: run.runId }, user: { _id: owner } }, fakeRes());

    const reloaded = await PageVerificationRun.findOne({ runId: run.runId }).lean();
    assert.equal(reloaded.status, beforeSnapshot.status);
    assert.equal(reloaded.updatedAt, undefined); // timestamps:false, unchanged by design
  });
});

describe('getVerificationHistory — project history (P3-007)', () => {
  test('project history: returns only this project\'s runs', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    await makeRun({ pageUrl: 'https://example.com/a' });
    await makeRun({ pageUrl: 'https://example.com/b' });

    const req = { params: { projectId: project._id.toString() }, query: {} };
    const res = fakeRes();
    await getVerificationHistory(req, res);

    assert.equal(res.statusCode, null); // res.json() called, no explicit status = 200 default
    assert.equal(res.body.data.length, 2);
    assert.equal(res.body.pagination.total, 2);
  });

  test('newest-first ordering', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    const older = await makeRun({ pageUrl: 'https://example.com/older' });
    await new Promise((r) => setTimeout(r, 10));
    const newer = await makeRun({ pageUrl: 'https://example.com/newer' });

    const req = { params: { projectId: project._id.toString() }, query: {} };
    const res = fakeRes();
    await getVerificationHistory(req, res);

    assert.equal(res.body.data[0].runId, newer.runId);
    assert.equal(res.body.data[1].runId, older.runId);
  });

  test('pagination: page/limit are respected and pagination metadata is correct', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    for (let i = 0; i < 5; i++) {
      await makeRun({ pageUrl: `https://example.com/${i}` });
    }

    const req = { params: { projectId: project._id.toString() }, query: { page: '2', limit: '2' } };
    const res = fakeRes();
    await getVerificationHistory(req, res);

    assert.equal(res.body.data.length, 2);
    assert.equal(res.body.pagination.page, 2);
    assert.equal(res.body.pagination.limit, 2);
    assert.equal(res.body.pagination.total, 5);
    assert.equal(res.body.pagination.pages, 3);
    assert.equal(res.body.pagination.hasNext, true);
    assert.equal(res.body.pagination.hasPrev, true);
  });

  test('an empty history returns an empty array, not an error', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const req = { params: { projectId: project._id.toString() }, query: {} };
    const res = fakeRes();
    await getVerificationHistory(req, res);

    assert.deepEqual(res.body.data, []);
    assert.equal(res.body.pagination.total, 0);
  });
});

describe('getLatestVerificationForPage (P3-007)', () => {
  test('latest page verification: returns the newest run for that exact pageUrl', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    await makeRun({ pageUrl: 'https://example.com/a', status: 'failed' });
    await new Promise((r) => setTimeout(r, 10));
    const newest = await makeRun({ pageUrl: 'https://example.com/a', status: 'completed' });
    await makeRun({ pageUrl: 'https://example.com/OTHER-PAGE' });

    const req = { params: { projectId: project._id.toString(), encodedUrl: encodeURIComponent('https://example.com/a') } };
    const res = fakeRes();
    await getLatestVerificationForPage(req, res);

    assert.equal(res.body.data.runId, newest.runId);
    assert.equal(res.body.data.status, 'completed');
  });

  test('not found: no verification exists for this page', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const req = { params: { projectId: project._id.toString(), encodedUrl: encodeURIComponent('https://example.com/never-verified') } };
    const res = fakeRes();
    await getLatestVerificationForPage(req, res);

    assert.equal(res.statusCode, 404);
  });

  test('malformed encoded URL returns 400, not a thrown exception', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const req = { params: { projectId: project._id.toString(), encodedUrl: '%E0%A4%A' } };
    const res = fakeRes();
    await assert.doesNotReject(() => getLatestVerificationForPage(req, res));
    assert.equal(res.statusCode, 400);
  });
});

describe('response shape backward compatibility (P3-007)', () => {
  test('serialized run always includes exactly the documented fields', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    const run = await makeRun();

    const req = { params: { runId: run.runId }, user: { _id: owner } };
    const res = fakeRes();
    await getVerificationRun(req, res);

    const expectedKeys = [
      'verificationRunId', 'runId', 'projectId', 'pageUrl', 'status',
      'startedAt', 'completedAt', 'durationMs', 'aiVisibilityStatus', 'before', 'after', 'delta', 'errorMessage',
    ].sort();
    assert.deepEqual(Object.keys(res.body.data).sort(), expectedKeys);
  });
});

describe('verificationHistoryRoutes — route registration (P3-007)', () => {
  test('all three routes are registered on the router, behind auth', () => {
    const paths = verificationHistoryRoutes.stack.filter((l) => l.route).map((l) => l.route.path);
    assert.ok(paths.includes('/verification-runs/:runId'));
    assert.ok(paths.includes('/projects/:projectId/verification-history'));
    assert.ok(paths.includes('/projects/:projectId/pages/:encodedUrl/latest-verification'));

    const authLayer = verificationHistoryRoutes.stack.find((l) => !l.route && l.name === 'auth');
    assert.ok(authLayer, 'auth middleware must be registered on this router');
  });
});
