import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../model/SeoProject.js';
import Job from '../../jobs/model/Job.js';
import PageVerificationRun from '../../verification/model/PageVerificationRun.js';
import VerificationBatch from '../../verification/model/VerificationBatch.js';
import { startVerificationBatch } from './scrapingController.js';
import scrapingRoutes from '../routes/scrapingRoutes.js';

// F4-013: Verification Batch backend API — controller/route layer.
//
// Same convention as scrapingController.startUrlVerification.test.js: this
// controller is a thin HTTP wrapper (all real logic lives in
// urlVerificationService.startVerificationBatch(), already covered in depth
// by urlVerificationService.test.js) — these tests verify only the
// HTTP-layer contract: status/response-shape mapping, and that "unauthorized"
// is auth.js middleware's job (not re-tested here; ACCESS_DENIED is the
// meaningful equivalent reachable at this layer).

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

let project;
let owner;

const TARGET_URL = 'https://example.com/pricing';
const OTHER_URL = 'https://example.com/other';

async function makeProject() {
  owner = new mongoose.Types.ObjectId();
  project = await SeoProject.create({
    user_id: owner,
    project_name: 'F4013 Test Project',
    main_url: 'https://example.com',
    seo_scope: 'national',
    keywords: ['test keyword'],
    crawl_status: 'pending',
  });
  await mongoose.connection.db.collection('seo_page_data').insertOne({ projectId: project._id, url: TARGET_URL });
  await mongoose.connection.db.collection('seo_page_data').insertOne({ projectId: project._id, url: OTHER_URL });
  return project;
}

afterEach(async () => {
  if (mongoAvailable && project) {
    await Job.deleteMany({ project_id: project._id });
    await PageVerificationRun.deleteMany({ projectId: project._id });
    await VerificationBatch.deleteMany({ projectId: project._id });
    await mongoose.connection.db.collection('seo_page_data').deleteMany({ projectId: project._id });
    await SeoProject.deleteOne({ _id: project._id });
    project = null;
  }
});

function fakeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res.body = body;
      return res;
    },
  };
  return res;
}

describe('startVerificationBatch controller (live Mongo)', () => {
  test('authenticated request with valid URLs returns 201 with the flat response shape', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const req = { body: { projectId: project._id.toString(), urls: [TARGET_URL, OTHER_URL] }, user: { _id: owner } };
    const res = fakeRes();
    await startVerificationBatch(req, res);

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.success, true);
    assert.ok(res.body.batchId);
    assert.equal(res.body.totalUrls, 2);
    assert.equal(res.body.acceptedUrls, 2);
    assert.equal(res.body.rejectedUrls, 0);
    assert.equal(res.body.runs.length, 2);
    // Flat shape — no `data` wrapper, unlike startUrlVerification's response.
    assert.equal(res.body.data, undefined);
  });

  test('F4-014: exactly one VerificationBatch, one PageVerificationRun, and two Jobs (PAGE_SCRAPING+HEADLESS) per accepted URL', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const req = { body: { projectId: project._id.toString(), urls: [TARGET_URL, OTHER_URL] }, user: { _id: owner } };
    const res = fakeRes();
    await startVerificationBatch(req, res);

    const batches = await VerificationBatch.find({ projectId: project._id });
    const runs = await PageVerificationRun.find({ projectId: project._id });
    const jobs = await Job.find({ project_id: project._id });
    assert.equal(batches.length, 1);
    assert.equal(batches[0].status, 'running');
    assert.equal(runs.length, 2);
    assert.equal(jobs.length, 4);
    assert.equal(res.body.dispatchedUrls, 2);
  });

  test('missing projectId is rejected with 400 and creates nothing', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const req = { body: { urls: [TARGET_URL] }, user: { _id: owner } };
    const res = fakeRes();
    await startVerificationBatch(req, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    const runs = await PageVerificationRun.find({ projectId: project._id });
    assert.equal(runs.length, 0);
  });

  test('missing/empty urls is rejected with 400', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const req1 = { body: { projectId: project._id.toString() }, user: { _id: owner } };
    const res1 = fakeRes();
    await startVerificationBatch(req1, res1);
    assert.equal(res1.statusCode, 400);

    const req2 = { body: { projectId: project._id.toString(), urls: [] }, user: { _id: owner } };
    const res2 = fakeRes();
    await startVerificationBatch(req2, res2);
    assert.equal(res2.statusCode, 400);
  });

  test('invalid project (not found) maps to 404', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const req = { body: { projectId: new mongoose.Types.ObjectId().toString(), urls: [TARGET_URL] }, user: { _id: new mongoose.Types.ObjectId() } };
    const res = fakeRes();
    await startVerificationBatch(req, res);

    assert.equal(res.statusCode, 404);
    assert.equal(res.body.success, false);
  });

  test('forbidden: a user who does not own the project gets 403', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const req = { body: { projectId: project._id.toString(), urls: [TARGET_URL] }, user: { _id: new mongoose.Types.ObjectId() } };
    const res = fakeRes();
    await startVerificationBatch(req, res);

    assert.equal(res.statusCode, 403);
    assert.equal(res.body.success, false);
  });

  test('every URL rejected maps to 400 with a rejected[] breakdown', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const req = { body: { projectId: project._id.toString(), urls: ['https://not-this-project.com/x'] }, user: { _id: owner } };
    const res = fakeRes();
    await startVerificationBatch(req, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    assert.equal(res.body.rejected.length, 1);
  });

  test('mixed valid/invalid URLs still return 201 (partial success), with rejected[] populated', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const req = {
      body: { projectId: project._id.toString(), urls: [TARGET_URL, 'https://not-this-project.com/x'] },
      user: { _id: owner },
    };
    const res = fakeRes();
    await startVerificationBatch(req, res);

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.acceptedUrls, 1);
    assert.equal(res.body.rejectedUrls, 1);
    assert.equal(res.body.rejected.length, 1);
  });

  test('requestingUserId always comes from req.user, never from the request body', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const req = {
      body: { projectId: project._id.toString(), urls: [TARGET_URL], requestingUserId: new mongoose.Types.ObjectId().toString() },
      user: { _id: owner },
    };
    const res = fakeRes();
    await startVerificationBatch(req, res);

    // Real owner (req.user) matches project owner, so this must succeed —
    // proving a spoofed body field was not used for the ownership check.
    assert.equal(res.statusCode, 201);
  });
});

describe('scrapingRoutes — route registration (F4-013)', () => {
  test('POST /start-verification-batch is registered on the router, behind auth', () => {
    const layer = scrapingRoutes.stack.find(
      (l) => l.route && l.route.path === '/start-verification-batch' && l.route.methods.post
    );
    assert.ok(layer, 'POST /start-verification-batch must be registered');

    const authLayer = scrapingRoutes.stack.find((l) => !l.route && l.name === 'auth');
    assert.ok(authLayer, 'auth middleware must be registered on this router');
  });

  test('POST /start-url-verification is still registered (regression — existing endpoint untouched)', () => {
    const layer = scrapingRoutes.stack.find(
      (l) => l.route && l.route.path === '/start-url-verification' && l.route.methods.post
    );
    assert.ok(layer, 'POST /start-url-verification must still be registered');
  });
});
