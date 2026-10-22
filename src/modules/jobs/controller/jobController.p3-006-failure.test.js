import { describe, test, before, after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import Job from '../model/Job.js';
import SeoProject from '../../app_user/model/SeoProject.js';
import PageVerificationRun from '../../verification/model/PageVerificationRun.js';
import verificationFinalizer from '../../verification/service/VerificationFinalizer.js';
import auditProgressService from '../service/auditProgressService.js';
import { failJob } from './jobController.js';

// P3-006: job-failure handling for URL Verification.
//
// Discovered gap this task fixes: failJob() (the /fail endpoint) previously
// reset the project's crawl_status/status to 'draft' and emitted a generic
// audit:error for ANY terminal job failure, regardless of mode — P3-004 only
// isolated the SUCCESS path (chainingEngine.process()) from Full Audit
// side effects, never this failure path. These tests prove: url_verification
// failures (except AI_VISIBILITY, gracefully tolerated) no longer touch
// crawl_status/status or emit audit:error, instead routing to
// VerificationFinalizer's explicit-failure path and emitting
// verification:failed; Full Audit failures are completely unchanged.

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
let ioCalls;
let originalFinalizeVerification;

beforeEach(() => {
  ioCalls = [];
  global.io = {
    to(room) {
      return { emit: (event, payload) => ioCalls.push({ room, event, payload }) };
    },
  };
  originalFinalizeVerification = verificationFinalizer.finalizeVerification;
});

afterEach(async () => {
  verificationFinalizer.finalizeVerification = originalFinalizeVerification;
  global.io = undefined;
  if (mongoAvailable && project) {
    await Job.deleteMany({ project_id: project._id });
    await PageVerificationRun.deleteMany({ projectId: project._id });
    await SeoProject.deleteOne({ _id: project._id });
    project = null;
  }
});

async function makeProject(crawlStatus = 'running') {
  project = await SeoProject.create({
    user_id: new mongoose.Types.ObjectId(),
    project_name: 'P3006 Test Project',
    main_url: 'https://example.com',
    seo_scope: 'national',
    keywords: ['test keyword'],
    crawl_status: crawlStatus,
    status: 'active',
  });
  return project;
}

function fakeRes() {
  const res = { statusCode: null, body: null, status(c) { res.statusCode = c; return res; }, json(b) { res.body = b; return res; } };
  return res;
}

describe('failJob — URL Verification isolation (P3-006, live Mongo)', () => {
  test('a url_verification PAGE_SCRAPING failure does not reset crawl_status/status and does not emit audit:error', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject('running');
    const runId = new mongoose.Types.ObjectId();
    const run = await PageVerificationRun.create({
      projectId: project._id, jobId: new mongoose.Types.ObjectId(), runId: runId.toString(),
      pageUrl: 'https://example.com/a', status: 'running', startedAt: new Date(),
    });
    const job = await Job.create({
      user_id: project.user_id, project_id: project._id, jobType: 'PAGE_SCRAPING', entityType: 'project',
      status: 'processing', max_attempts: 1, run_id: runId,
      input_data: { mode: 'url_verification', target_url: 'https://example.com/a' },
    });

    verificationFinalizer.finalizeVerification = async () => {
      run.status = 'failed';
      run.errorMessage = 'scrape failed';
      run.completedAt = new Date();
      await run.save();
      return run;
    };

    const req = { params: { jobId: job._id.toString() }, body: { error: { message: 'scrape failed' } } };
    await failJob(req, fakeRes());

    const reloadedProject = await SeoProject.findById(project._id);
    assert.equal(reloadedProject.crawl_status, 'running', 'crawl_status must NOT be reset for url_verification');
    assert.equal(reloadedProject.status, 'active', 'status must NOT be reset for url_verification');

    assert.equal(ioCalls.filter((c) => c.event === 'audit:error').length, 0);
    const failedEvents = ioCalls.filter((c) => c.event === 'verification:failed');
    assert.equal(failedEvents.length, 1);
    assert.equal(failedEvents[0].payload.errorMessage, 'scrape failed');
  });

  test('an AI_VISIBILITY failure under url_verification mode neither resets crawl_status nor emits verification:failed (gracefully tolerated)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject('running');
    const runId = new mongoose.Types.ObjectId();
    await PageVerificationRun.create({
      projectId: project._id, jobId: new mongoose.Types.ObjectId(), runId: runId.toString(),
      pageUrl: 'https://example.com/a', status: 'running', startedAt: new Date(),
    });
    const job = await Job.create({
      user_id: project.user_id, project_id: project._id, jobType: 'AI_VISIBILITY', entityType: 'project',
      status: 'processing', max_attempts: 1, run_id: runId,
      input_data: { mode: 'url_verification', target_url: 'https://example.com/a' },
    });

    let finalizeCalled = false;
    verificationFinalizer.finalizeVerification = async () => { finalizeCalled = true; };

    const req = { params: { jobId: job._id.toString() }, body: { error: { message: 'ai crashed' } } };
    await failJob(req, fakeRes());

    const reloadedProject = await SeoProject.findById(project._id);
    assert.equal(reloadedProject.crawl_status, 'running');
    assert.equal(finalizeCalled, false);
    assert.equal(ioCalls.filter((c) => c.event.startsWith('verification:')).length, 0);
    assert.equal(ioCalls.filter((c) => c.event === 'audit:error').length, 0);
  });

  test('Full Audit (no mode) failure is completely unchanged: crawl_status/status reset to draft, audit:error emitted', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject('running');
    const job = await Job.create({
      user_id: project.user_id, project_id: project._id, jobType: 'PAGE_SCRAPING', entityType: 'project',
      status: 'processing', max_attempts: 1, run_id: new mongoose.Types.ObjectId(),
      input_data: {},
    });

    const req = { params: { jobId: job._id.toString() }, body: { error: { message: 'full audit scrape failed' } } };
    await failJob(req, fakeRes());

    const reloadedProject = await SeoProject.findById(project._id);
    assert.equal(reloadedProject.crawl_status, 'draft');
    assert.equal(reloadedProject.status, 'draft');

    assert.equal(ioCalls.filter((c) => c.event === 'audit:error').length, 1);
    assert.equal(ioCalls.filter((c) => c.event.startsWith('verification:')).length, 0);
  });

  test('legacy mode:"verification" failure is also unchanged (crawl_status reset, audit:error) — only url_verification is isolated', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject('running');
    const job = await Job.create({
      user_id: project.user_id, project_id: project._id, jobType: 'PAGE_SCRAPING', entityType: 'project',
      status: 'processing', max_attempts: 1, run_id: new mongoose.Types.ObjectId(),
      input_data: { mode: 'verification', canonical_urls: ['https://example.com/a'] },
    });

    const req = { params: { jobId: job._id.toString() }, body: { error: { message: 'legacy verification failed' } } };
    await failJob(req, fakeRes());

    const reloadedProject = await SeoProject.findById(project._id);
    assert.equal(reloadedProject.crawl_status, 'draft');
    assert.equal(ioCalls.filter((c) => c.event === 'audit:error').length, 1);
  });
});
