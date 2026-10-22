import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../model/SeoProject.js';
import Job from '../../jobs/model/Job.js';
import PageVerificationRun from '../../verification/model/PageVerificationRun.js';
import { startUrlVerification } from './scrapingController.js';
import scrapingRoutes from '../routes/scrapingRoutes.js';

// P3-005: URL Verification backend API.
//
// This controller is a thin HTTP wrapper — all real logic lives in
// urlVerificationService.startUrlVerification() (P3-003), which is a plain
// exported function, not a mutable singleton method, so it cannot be
// monkey-patched the way class-instance services (VerificationFinalizer,
// AuditHistoryService) were in other test files. These tests instead call
// the real controller against a real project/DB (same live-Mongo convention
// as urlVerificationService.test.js) and verify HTTP-layer behavior:
// status/response-shape mapping and that no business logic is duplicated
// in the controller (proven by exactly one PageVerificationRun + job pair
// existing per successful call, matching the service's own contract).
//
// "Unauthorized" (no/invalid token) is auth.js middleware's responsibility,
// applied via router.use(auth) BEFORE this controller ever runs — not
// re-tested here. "Forbidden" (ACCESS_DENIED) is the meaningful equivalent
// reachable at this layer, exercised below.

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

// H1: startUrlVerification now requires the target URL to belong to the
// project (main_url or a previously-discovered seo_page_data page) — see
// urlVerificationService.test.js for H1's own dedicated coverage. Seeded
// here too so these HTTP-layer tests keep exercising what they actually
// test (status/response mapping), not H1's own rejection path.
async function makeProject() {
  owner = new mongoose.Types.ObjectId();
  project = await SeoProject.create({
    user_id: owner,
    project_name: 'P3005 Test Project',
    main_url: 'https://example.com',
    seo_scope: 'national',
    keywords: ['test keyword'],
    crawl_status: 'pending',
  });
  await mongoose.connection.db.collection('seo_page_data').insertOne({ projectId: project._id, url: TARGET_URL });
  return project;
}

afterEach(async () => {
  if (mongoAvailable && project) {
    await Job.deleteMany({ project_id: project._id });
    await PageVerificationRun.deleteMany({ projectId: project._id });
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

const TARGET_URL = 'https://example.com/pricing';

describe('startUrlVerification controller (live Mongo)', () => {
  test('authenticated request for a valid project/URL returns 201 with the expected response shape', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const req = { body: { projectId: project._id.toString(), url: TARGET_URL }, user: { _id: owner } };
    const res = fakeRes();

    await startUrlVerification(req, res);

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.success, true);
    assert.ok(res.body.data.verificationRunId);
    assert.ok(res.body.data.runId);
    assert.equal(res.body.data.status, 'running');
    assert.equal(res.body.data.pageUrl, TARGET_URL);
    assert.equal(res.body.data.jobs.length, 2);
  });

  test('service invoked exactly once: exactly one PageVerificationRun and one job pair created per call', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const req = { body: { projectId: project._id.toString(), url: TARGET_URL }, user: { _id: owner } };
    await startUrlVerification(req, fakeRes());

    const runs = await PageVerificationRun.find({ projectId: project._id });
    const jobs = await Job.find({ project_id: project._id });
    assert.equal(runs.length, 1);
    assert.equal(jobs.length, 2);
  });

  test('missing projectId is rejected with 400 and never calls the service (no records created)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const req = { body: { url: TARGET_URL }, user: { _id: owner } };
    const res = fakeRes();
    await startUrlVerification(req, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    const runs = await PageVerificationRun.find({ projectId: project._id });
    assert.equal(runs.length, 0);
  });

  test('missing url is rejected with 400', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const req = { body: { projectId: project._id.toString() }, user: { _id: owner } };
    const res = fakeRes();
    await startUrlVerification(req, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
  });

  test('invalid project (not found) maps to 404', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const req = { body: { projectId: new mongoose.Types.ObjectId().toString(), url: TARGET_URL }, user: { _id: new mongoose.Types.ObjectId() } };
    const res = fakeRes();
    await startUrlVerification(req, res);

    assert.equal(res.statusCode, 404);
    assert.equal(res.body.success, false);
  });

  test('invalid URL maps to 400 with the service-provided message', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const req = { body: { projectId: project._id.toString(), url: 'not-a-url' }, user: { _id: owner } };
    const res = fakeRes();
    await startUrlVerification(req, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
  });

  test('forbidden: a user who does not own the project gets 403', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const req = { body: { projectId: project._id.toString(), url: TARGET_URL }, user: { _id: new mongoose.Types.ObjectId() } };
    const res = fakeRes();
    await startUrlVerification(req, res);

    assert.equal(res.statusCode, 403);
    assert.equal(res.body.success, false);
  });

  test('duplicate verification already running maps to 409', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const req = { body: { projectId: project._id.toString(), url: TARGET_URL }, user: { _id: owner } };
    await startUrlVerification(req, fakeRes());

    const res2 = fakeRes();
    await startUrlVerification(req, res2);

    assert.equal(res2.statusCode, 409);
    assert.equal(res2.body.success, false);
  });

  test('requestingUserId always comes from req.user, not from client-supplied options', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    // A malicious/buggy client tries to pass a different requestingUserId via
    // options — the controller must ignore it and use req.user._id instead.
    const req = {
      body: { projectId: project._id.toString(), url: TARGET_URL, options: { requestingUserId: new mongoose.Types.ObjectId().toString() } },
      user: { _id: owner },
    };
    const res = fakeRes();
    await startUrlVerification(req, res);

    // Real owner (req.user) matches project owner, so this must succeed —
    // proving the spoofed options.requestingUserId was not used for the
    // ownership check (it would have caused a 403 if it had been).
    assert.equal(res.statusCode, 201);
  });
});

describe('scrapingRoutes — route registration (P3-005)', () => {
  test('POST /start-url-verification is registered on the router, behind auth', () => {
    const layer = scrapingRoutes.stack.find(
      (l) => l.route && l.route.path === '/start-url-verification' && l.route.methods.post
    );
    assert.ok(layer, 'POST /start-url-verification must be registered');

    // auth is applied via router.use(auth) as a separate stack layer before
    // any route-specific layer, not per-route — confirm it's present at all.
    const authLayer = scrapingRoutes.stack.find((l) => !l.route && l.name === 'auth');
    assert.ok(authLayer, 'auth middleware must be registered on this router');
  });
});
