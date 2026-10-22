import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import Job from '../../jobs/model/Job.js';
import PageVerificationRun from '../model/PageVerificationRun.js';
import VerificationBatch from '../model/VerificationBatch.js';
import { BATCH_STATUS } from '../constants/batchStatus.js';
import { startUrlVerification, startVerificationBatch, URL_VERIFICATION_RESULT_CODES } from './urlVerificationService.js';

// P3-003: URL Verification job creation pipeline.
//
// Live-Mongo only (no auto-skip fallback path makes sense here — this
// function's whole job is real DB writes across three collections).
// USE_PULL_MODEL=true in this repo's .env means dispatch is a harmless
// jobService.updateJobStatus() no-op, not a real network call — safe to
// exercise for real in these tests.

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

// H1: startUrlVerification now requires the target URL to belong to the
// project (main_url or a previously-discovered seo_page_data page). Every
// test below verifies job-creation/duplicate-protection/etc. behavior, not
// H1 itself (see the dedicated H1 describe block), so makeProject() seeds
// TARGET_URL into seo_page_data by default — matching what a real,
// previously-crawled project would already have.
async function seedPageData(projectId, url) {
  await mongoose.connection.db.collection('seo_page_data').insertOne({ projectId, url });
}

async function makeProject(overrides = {}) {
  owner = new mongoose.Types.ObjectId();
  project = await SeoProject.create({
    user_id: owner,
    project_name: 'P3003 Test Project',
    main_url: 'https://example.com',
    seo_scope: 'national',
    keywords: ['test keyword'],
    crawl_status: 'pending',
    ...overrides,
  });
  await seedPageData(project._id, TARGET_URL);
  return project;
}

afterEach(async () => {
  if (mongoAvailable && project) {
    await Job.deleteMany({ project_id: project._id });
    await PageVerificationRun.deleteMany({ projectId: project._id });
    await VerificationBatch.deleteMany({ projectId: project._id });
    await mongoose.connection.db.collection('seo_page_scores').deleteMany({ projectId: project._id });
    await mongoose.connection.db.collection('ai_scores').deleteMany({ project_id: project._id });
    await mongoose.connection.db.collection('seo_page_data').deleteMany({ projectId: project._id });
    await SeoProject.deleteOne({ _id: project._id });
    project = null;
  }
});

describe('startUrlVerification — happy path (live Mongo)', () => {
  test('verification run created with status transitioning pending -> running', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const result = await startUrlVerification(project._id.toString(), TARGET_URL, { requestingUserId: owner });

    assert.equal(result.success, true);
    assert.equal(result.code, URL_VERIFICATION_RESULT_CODES.STARTED);

    const run = await PageVerificationRun.findOne({ runId: result.data.runId });
    assert.ok(run);
    assert.equal(run.status, 'running');
    assert.equal(run.pageUrl, TARGET_URL);
    assert.equal(run.projectId.toString(), project._id.toString());
  });

  test('before snapshot is persisted from current seo_page_scores/ai_scores state', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    await mongoose.connection.db.collection('seo_page_scores').insertOne({
      projectId: project._id,
      page_url: TARGET_URL,
      page_score: 62,
      high_issues_count: 2,
      medium_issues_count: 1,
      low_issues_count: 0,
    });
    await mongoose.connection.db.collection('ai_scores').insertOne({
      project_id: project._id,
      url: TARGET_URL,
      hubs: { aiso: { score: 55 }, aeo: { score: 60 }, geo: { score: 65 } },
    });

    const result = await startUrlVerification(project._id.toString(), TARGET_URL, { requestingUserId: owner });
    const run = await PageVerificationRun.findOne({ runId: result.data.runId });

    assert.equal(run.before.pageScore, 62);
    assert.equal(run.before.criticalIssues, 2);
    assert.equal(run.before.warningIssues, 1);
    assert.equal(run.before.aisoScore, 55);
    assert.equal(run.before.aeoScore, 60);
    assert.equal(run.before.geoScore, 65);
  });

  test('before snapshot defaults safely when no prior data exists for this page', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const result = await startUrlVerification(project._id.toString(), TARGET_URL, { requestingUserId: owner });
    const run = await PageVerificationRun.findOne({ runId: result.data.runId });

    assert.equal(run.before.pageScore, null);
    assert.equal(run.before.criticalIssues, 0);
  });

  test('correct job graph created: exactly PAGE_SCRAPING + HEADLESS_ACCESSIBILITY, nothing else', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    await startUrlVerification(project._id.toString(), TARGET_URL, { requestingUserId: owner });

    const jobs = await Job.find({ project_id: project._id });
    const jobTypes = jobs.map((j) => j.jobType).sort();
    assert.deepEqual(jobTypes, ['HEADLESS_ACCESSIBILITY', 'PAGE_SCRAPING']);
  });

  test('correct mode and target_url on both seed jobs', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    await startUrlVerification(project._id.toString(), TARGET_URL, { requestingUserId: owner });

    const jobs = await Job.find({ project_id: project._id });
    for (const job of jobs) {
      assert.equal(job.input_data.mode, 'url_verification');
      assert.equal(job.input_data.target_url, TARGET_URL);
      assert.deepEqual(job.input_data.canonical_urls, [TARGET_URL]);
    }
  });

  test('both seed jobs share the same run_id, and it matches the returned runId', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const result = await startUrlVerification(project._id.toString(), TARGET_URL, { requestingUserId: owner });
    const jobs = await Job.find({ project_id: project._id });

    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].run_id.toString(), result.data.runId);
    assert.equal(jobs[1].run_id.toString(), result.data.runId);
  });

  test('PageVerificationRun.jobId references the real PAGE_SCRAPING job', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const result = await startUrlVerification(project._id.toString(), TARGET_URL, { requestingUserId: owner });
    const run = await PageVerificationRun.findOne({ runId: result.data.runId });
    const pageScrapingJob = await Job.findOne({ project_id: project._id, jobType: 'PAGE_SCRAPING' });

    assert.equal(run.jobId.toString(), pageScrapingJob._id.toString());
  });

  test('backward compatibility: does not claim the project-wide crawl_status lock', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject({ crawl_status: 'pending' });

    await startUrlVerification(project._id.toString(), TARGET_URL, { requestingUserId: owner });

    const reloaded = await SeoProject.findById(project._id);
    assert.equal(reloaded.crawl_status, 'pending');
  });

  test('does not run resetProjectCrawlData-style collection wipes (project data left alone)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    await mongoose.connection.db.collection('seo_page_data').insertOne({ projectId: project._id, url: 'https://example.com/untouched' });

    await startUrlVerification(project._id.toString(), TARGET_URL, { requestingUserId: owner });

    const untouched = await mongoose.connection.db.collection('seo_page_data').findOne({ projectId: project._id, url: 'https://example.com/untouched' });
    assert.ok(untouched, 'seo_page_data must not be wiped for a single-URL verification');
  });
});

describe('startUrlVerification — failure handling (live Mongo)', () => {
  test('invalid project (not found) returns NOT_FOUND without throwing', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await startUrlVerification(new mongoose.Types.ObjectId().toString(), TARGET_URL);
    assert.equal(result.success, false);
    assert.equal(result.code, URL_VERIFICATION_RESULT_CODES.NOT_FOUND);
  });

  test('malformed projectId is treated as not found, not a thrown CastError', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await startUrlVerification('not-a-valid-object-id', TARGET_URL);
    assert.equal(result.success, false);
    assert.equal(result.code, URL_VERIFICATION_RESULT_CODES.NOT_FOUND);
  });

  test('access denied when requestingUserId does not own the project', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    const result = await startUrlVerification(project._id.toString(), TARGET_URL, { requestingUserId: new mongoose.Types.ObjectId() });
    assert.equal(result.success, false);
    assert.equal(result.code, URL_VERIFICATION_RESULT_CODES.ACCESS_DENIED);
  });

  test('invalid URL (not http/https) is rejected', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    const result = await startUrlVerification(project._id.toString(), 'ftp://example.com/file', { requestingUserId: owner });
    assert.equal(result.success, false);
    assert.equal(result.code, URL_VERIFICATION_RESULT_CODES.INVALID_URL);
  });

  test('invalid URL (malformed string) is rejected', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    const result = await startUrlVerification(project._id.toString(), 'not a url at all', { requestingUserId: owner });
    assert.equal(result.success, false);
    assert.equal(result.code, URL_VERIFICATION_RESULT_CODES.INVALID_URL);
  });

  test('invalid URL (empty string) is rejected', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    const result = await startUrlVerification(project._id.toString(), '', { requestingUserId: owner });
    assert.equal(result.success, false);
    assert.equal(result.code, URL_VERIFICATION_RESULT_CODES.INVALID_URL);
  });

  test('a failed request does not create a PageVerificationRun or any Job', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    await startUrlVerification(project._id.toString(), 'not-a-url', { requestingUserId: owner });

    const jobs = await Job.find({ project_id: project._id });
    const runs = await PageVerificationRun.find({ projectId: project._id });
    assert.equal(jobs.length, 0);
    assert.equal(runs.length, 0);
  });
});

describe('startUrlVerification — duplicate protection (live Mongo)', () => {
  test('a second verification for the same URL while one is pending is rejected', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const first = await startUrlVerification(project._id.toString(), TARGET_URL, { requestingUserId: owner });
    assert.equal(first.success, true);

    const second = await startUrlVerification(project._id.toString(), TARGET_URL, { requestingUserId: owner });
    assert.equal(second.success, false);
    assert.equal(second.code, URL_VERIFICATION_RESULT_CODES.ALREADY_RUNNING);
  });

  test('a different URL on the same project is allowed concurrently', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    await seedPageData(project._id, 'https://example.com/other-page');

    const first = await startUrlVerification(project._id.toString(), TARGET_URL, { requestingUserId: owner });
    const second = await startUrlVerification(project._id.toString(), 'https://example.com/other-page', { requestingUserId: owner });

    assert.equal(first.success, true);
    assert.equal(second.success, true);
  });

  test('the same URL on a different project is allowed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    const otherOwner = new mongoose.Types.ObjectId();
    const otherProject = await SeoProject.create({
      user_id: otherOwner,
      project_name: 'P3003 Other Project',
      main_url: 'https://other-example.com',
      seo_scope: 'national',
      keywords: ['test keyword'],
      crawl_status: 'pending',
    });
    await seedPageData(otherProject._id, TARGET_URL);

    try {
      const first = await startUrlVerification(project._id.toString(), TARGET_URL, { requestingUserId: owner });
      const second = await startUrlVerification(otherProject._id.toString(), TARGET_URL, { requestingUserId: otherOwner });

      assert.equal(first.success, true);
      assert.equal(second.success, true);
    } finally {
      await Job.deleteMany({ project_id: otherProject._id });
      await PageVerificationRun.deleteMany({ projectId: otherProject._id });
      await mongoose.connection.db.collection('seo_page_data').deleteMany({ projectId: otherProject._id });
      await SeoProject.deleteOne({ _id: otherProject._id });
    }
  });

  test('a completed prior verification for the same URL does not block a new one', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const first = await startUrlVerification(project._id.toString(), TARGET_URL, { requestingUserId: owner });
    await Job.updateMany({ project_id: project._id }, { $set: { status: 'completed' } });

    const second = await startUrlVerification(project._id.toString(), TARGET_URL, { requestingUserId: owner });
    assert.equal(second.success, true);
    assert.notEqual(second.data.runId, first.data.runId);
  });
});

describe('startUrlVerification — H1 same-origin validation (live Mongo)', () => {
  test('a previously-discovered project page is accepted', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const result = await startUrlVerification(project._id.toString(), TARGET_URL, { requestingUserId: owner });
    assert.equal(result.success, true);
  });

  test('the project main_url itself is accepted even with zero discovered pages', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    owner = new mongoose.Types.ObjectId();
    project = await SeoProject.create({
      user_id: owner,
      project_name: 'P3003 No Crawl Yet',
      main_url: 'https://example.com',
      seo_scope: 'national',
      keywords: ['test keyword'],
      crawl_status: 'pending',
    });
    // Deliberately NOT seeding seo_page_data — main_url must still work.

    const result = await startUrlVerification(project._id.toString(), 'https://example.com', { requestingUserId: owner });
    assert.equal(result.success, true);
  });

  test('trailing slash variations normalize to the same eligible page', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    await seedPageData(project._id, 'https://example.com/services/');

    const result = await startUrlVerification(project._id.toString(), 'https://example.com/services', { requestingUserId: owner });
    assert.equal(result.success, true);
  });

  test('uppercase hostname normalizes to the same eligible page', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const result = await startUrlVerification(project._id.toString(), 'https://EXAMPLE.COM/pricing', { requestingUserId: owner });
    assert.equal(result.success, true);
  });

  test('a default-port URL normalizes to the same eligible page', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const result = await startUrlVerification(project._id.toString(), 'https://example.com:443/pricing', { requestingUserId: owner });
    assert.equal(result.success, true);
  });

  test('a fragment on the URL does not prevent matching an eligible page', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const result = await startUrlVerification(project._id.toString(), 'https://example.com/pricing#plans', { requestingUserId: owner });
    assert.equal(result.success, true);
  });

  test('a foreign domain is rejected as INVALID_URL', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const result = await startUrlVerification(project._id.toString(), 'https://not-this-project.com/page', { requestingUserId: owner });
    assert.equal(result.success, false);
    assert.equal(result.code, URL_VERIFICATION_RESULT_CODES.INVALID_URL);
  });

  test('an undiscovered page on the SAME hostname is rejected as INVALID_URL', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const result = await startUrlVerification(project._id.toString(), 'https://example.com/never-crawled', { requestingUserId: owner });
    assert.equal(result.success, false);
    assert.equal(result.code, URL_VERIFICATION_RESULT_CODES.INVALID_URL);
  });

  test('localhost is rejected as INVALID_URL', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const result = await startUrlVerification(project._id.toString(), 'http://localhost:3000/admin', { requestingUserId: owner });
    assert.equal(result.success, false);
    assert.equal(result.code, URL_VERIFICATION_RESULT_CODES.INVALID_URL);
  });

  test('a private IP (RFC1918) is rejected as INVALID_URL', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const result = await startUrlVerification(project._id.toString(), 'http://192.168.1.10/', { requestingUserId: owner });
    assert.equal(result.success, false);
    assert.equal(result.code, URL_VERIFICATION_RESULT_CODES.INVALID_URL);
  });

  test('a loopback address is rejected as INVALID_URL', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const result = await startUrlVerification(project._id.toString(), 'http://127.0.0.1:8080/', { requestingUserId: owner });
    assert.equal(result.success, false);
    assert.equal(result.code, URL_VERIFICATION_RESULT_CODES.INVALID_URL);
  });

  test('a cloud metadata endpoint is rejected as INVALID_URL', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const result = await startUrlVerification(project._id.toString(), 'http://169.254.169.254/latest/meta-data/', { requestingUserId: owner });
    assert.equal(result.success, false);
    assert.equal(result.code, URL_VERIFICATION_RESULT_CODES.INVALID_URL);
  });

  test('no PageVerificationRun or Job is created for a foreign-domain rejection', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    await startUrlVerification(project._id.toString(), 'https://not-this-project.com/page', { requestingUserId: owner });

    const jobs = await Job.find({ project_id: project._id });
    const runs = await PageVerificationRun.find({ projectId: project._id });
    assert.equal(jobs.length, 0);
    assert.equal(runs.length, 0);
  });

  test('no PageVerificationRun or Job is created for a private-IP rejection', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    await startUrlVerification(project._id.toString(), 'http://10.0.0.5/internal', { requestingUserId: owner });

    const jobs = await Job.find({ project_id: project._id });
    const runs = await PageVerificationRun.find({ projectId: project._id });
    assert.equal(jobs.length, 0);
    assert.equal(runs.length, 0);
  });

  test('error message does not leak internal validation reasoning', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const result = await startUrlVerification(project._id.toString(), 'http://192.168.1.10/', { requestingUserId: owner });
    assert.equal(result.success, false);
    assert.ok(!/private|ssrf|blocklist|internal|loopback/i.test(result.message));
  });
});

// F4-013: startVerificationBatch (Phase 2 — API/creation infrastructure
// only). Creates VerificationBatch + PageVerificationRun documents only —
// no Job, no dispatch. Reuses loadAuthorizedProject/validateTargetUrlFor
// Project internally (same functions startUrlVerification's own regression
// suite above already exercises for auth/format/eligibility), so this
// suite focuses on what's actually new: multi-URL acceptance/rejection,
// duplicate filtering, batch-document creation, and batchId propagation.
describe('startVerificationBatch — request validation (live Mongo)', () => {
  test('a non-array urls value is rejected as NO_VALID_URLS', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    const result = await startVerificationBatch(project._id.toString(), 'not-an-array', { requestingUserId: owner });
    assert.equal(result.success, false);
    assert.equal(result.code, URL_VERIFICATION_RESULT_CODES.NO_VALID_URLS);
  });

  test('an empty urls array is rejected as NO_VALID_URLS', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    const result = await startVerificationBatch(project._id.toString(), [], { requestingUserId: owner });
    assert.equal(result.success, false);
    assert.equal(result.code, URL_VERIFICATION_RESULT_CODES.NO_VALID_URLS);
  });

  test('invalid project (not found) returns NOT_FOUND without throwing', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await startVerificationBatch(new mongoose.Types.ObjectId().toString(), [TARGET_URL]);
    assert.equal(result.success, false);
    assert.equal(result.code, URL_VERIFICATION_RESULT_CODES.NOT_FOUND);
  });

  test('access denied when requestingUserId does not own the project', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    const result = await startVerificationBatch(project._id.toString(), [TARGET_URL], { requestingUserId: new mongoose.Types.ObjectId() });
    assert.equal(result.success, false);
    assert.equal(result.code, URL_VERIFICATION_RESULT_CODES.ACCESS_DENIED);
  });

  test('a project-wide audit already in progress blocks the whole batch (checked once, not per URL)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject({ crawl_status: 'running' });
    await seedPageData(project._id, 'https://example.com/other');

    const result = await startVerificationBatch(project._id.toString(), [TARGET_URL, 'https://example.com/other'], { requestingUserId: owner });
    assert.equal(result.success, false);
    assert.equal(result.code, URL_VERIFICATION_RESULT_CODES.ALREADY_RUNNING);

    const runs = await PageVerificationRun.find({ projectId: project._id });
    assert.equal(runs.length, 0, 'no runs should be created when the batch is rejected outright');
  });
});

describe('startVerificationBatch — happy path (live Mongo)', () => {
  test('F4-014: multiple valid URLs all succeed: correct counts, jobs created+dispatched, jobId/startedAt populated', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    await seedPageData(project._id, 'https://example.com/other');

    const urls = [TARGET_URL, 'https://example.com/other'];
    const result = await startVerificationBatch(project._id.toString(), urls, { requestingUserId: owner });

    assert.equal(result.success, true);
    assert.equal(result.data.status, BATCH_STATUS.RUNNING);
    assert.equal(result.data.totalUrls, 2);
    assert.equal(result.data.acceptedUrls, 2);
    assert.equal(result.data.rejectedUrls, 0);
    assert.equal(result.data.dispatchedUrls, 2);
    assert.equal(result.data.failedDispatchUrls, 0);
    assert.equal(result.data.runs.length, 2);
    assert.ok(result.data.runs.every((r) => r.dispatched === true));
    assert.ok(result.data.batchId);

    const runs = await PageVerificationRun.find({ projectId: project._id });
    assert.equal(runs.length, 2);
    for (const run of runs) {
      assert.equal(run.status, 'running');
      assert.ok(run.jobId, 'jobId must transition from null to the real PAGE_SCRAPING job id');
      assert.ok(run.startedAt instanceof Date, 'startedAt must transition from null to a real Date');
      assert.equal(run.batchId, result.data.batchId);
    }

    const jobs = await Job.find({ project_id: project._id });
    const jobTypes = jobs.map((j) => j.jobType).sort();
    assert.equal(jobs.length, 4, 'F4-014: 2 jobs (PAGE_SCRAPING + HEADLESS_ACCESSIBILITY) per accepted URL');
    assert.deepEqual(jobTypes, ['HEADLESS_ACCESSIBILITY', 'HEADLESS_ACCESSIBILITY', 'PAGE_SCRAPING', 'PAGE_SCRAPING']);
  });

  test('F4-014: VerificationBatch document is created with the correct fields (RUNNING, totalUrls, urls, createdBy)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    await seedPageData(project._id, 'https://example.com/other');

    const urls = [TARGET_URL, 'https://example.com/other'];
    const result = await startVerificationBatch(project._id.toString(), urls, { requestingUserId: owner });

    const batch = await VerificationBatch.findBatch(result.data.batchId);
    assert.ok(batch);
    assert.equal(batch.status, BATCH_STATUS.RUNNING, 'transitions PENDING -> RUNNING once >=1 URL dispatches (§5)');
    assert.ok(batch.startedAt instanceof Date);
    assert.equal(batch.totalUrls, 2);
    assert.deepEqual(batch.urls.slice().sort(), urls.slice().sort());
    assert.equal(batch.projectId.toString(), project._id.toString());
    assert.equal(batch.createdBy.toString(), owner.toString());
    assert.equal(batch.completedUrls, 0);
    assert.equal(batch.failedUrls, 0);
  });

  test('F4-014: every created job carries batchId in input_data, plus the unchanged existing fields (mode/target_url/canonical_urls/run_id)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const result = await startVerificationBatch(project._id.toString(), [TARGET_URL], { requestingUserId: owner });
    const jobs = await Job.find({ project_id: project._id });

    assert.equal(jobs.length, 2);
    for (const job of jobs) {
      assert.equal(job.input_data.batchId, result.data.batchId);
      assert.equal(job.input_data.mode, 'url_verification');
      assert.equal(job.input_data.target_url, TARGET_URL);
      assert.deepEqual(job.input_data.canonical_urls, [TARGET_URL]);
      assert.equal(job.run_id.toString(), result.data.runs[0].runId);
    }

    const headless = jobs.find((j) => j.jobType === 'HEADLESS_ACCESSIBILITY');
    const pageScraping = jobs.find((j) => j.jobType === 'PAGE_SCRAPING');
    assert.equal(headless.input_data.source_job_id, pageScraping._id.toString());
  });

  test('F4-014: verification:started fires once per dispatched URL (existing per-run websocket behavior, untouched)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    await seedPageData(project._id, 'https://example.com/other');

    const originalIo = global.io;
    const emitted = [];
    global.io = { to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) };

    try {
      const result = await startVerificationBatch(
        project._id.toString(), [TARGET_URL, 'https://example.com/other'], { requestingUserId: owner }
      );
      const startedEvents = emitted.filter((e) => e.event === 'verification:started');
      assert.equal(startedEvents.length, 2);
      assert.ok(startedEvents.every((e) => e.room === `project-${project._id}`));
      const runIds = result.data.runs.map((r) => r.runId).sort();
      const eventRunIds = startedEvents.map((e) => e.payload.runId).sort();
      assert.deepEqual(eventRunIds, runIds);
    } finally {
      global.io = originalIo;
    }
  });

  test('F4-014: a duplicate-run race (P1-001) during batch dispatch marks only that run failed, others still dispatch', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    await seedPageData(project._id, 'https://example.com/other');

    // Pre-seed an in-flight PAGE_SCRAPING job for TARGET_URL so the batch's
    // own attempt to create one collides with the existing partial unique
    // index — exactly the same race startUrlVerification's own duplicate-
    // protection test exercises, now proven non-fatal to the rest of a batch.
    await startVerificationBatch(project._id.toString(), [TARGET_URL], { requestingUserId: owner });

    const result = await startVerificationBatch(
      project._id.toString(), [TARGET_URL, 'https://example.com/other'], { requestingUserId: owner }
    );

    assert.equal(result.success, true);
    assert.equal(result.data.dispatchedUrls, 1);
    assert.equal(result.data.failedDispatchUrls, 1);
    assert.equal(result.data.status, BATCH_STATUS.RUNNING, 'still RUNNING — at least one URL did dispatch');

    const failedRun = await PageVerificationRun.findOne({ projectId: project._id, pageUrl: TARGET_URL, batchId: result.data.batchId });
    assert.equal(failedRun.status, 'failed');
    assert.ok(failedRun.errorMessage);
  });

  test('F4-014: every accepted URL failing job creation marks the batch FAILED (not NO_VALID_URLS)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    // Exhaust the partial-unique-index slot for the only submitted URL so
    // its PAGE_SCRAPING creation is guaranteed to collide.
    await startVerificationBatch(project._id.toString(), [TARGET_URL], { requestingUserId: owner });

    const result = await startVerificationBatch(project._id.toString(), [TARGET_URL], { requestingUserId: owner });

    assert.equal(result.success, true, 'the URL WAS accepted at validation time — this is not NO_VALID_URLS');
    assert.equal(result.data.status, BATCH_STATUS.FAILED);
    assert.equal(result.data.dispatchedUrls, 0);
    assert.equal(result.data.failedDispatchUrls, 1);

    const batch = await VerificationBatch.findBatch(result.data.batchId);
    assert.equal(batch.status, BATCH_STATUS.FAILED);
    assert.equal(batch.startedAt, null, 'startedAt is only stamped when something actually dispatched');
  });

  test('batchId propagates identically to the VerificationBatch document and every created PageVerificationRun', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    await seedPageData(project._id, 'https://example.com/other');

    const result = await startVerificationBatch(project._id.toString(), [TARGET_URL, 'https://example.com/other'], { requestingUserId: owner });

    const runs = await PageVerificationRun.find({ projectId: project._id });
    assert.equal(runs.length, 2);
    assert.ok(runs.every((r) => r.batchId === result.data.batchId));

    const batch = await VerificationBatch.findBatch(result.data.batchId);
    assert.equal(batch.batchId, result.data.batchId);
  });

  test('response runs[] entries carry url, runId, and verificationRunId matching the created documents', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const result = await startVerificationBatch(project._id.toString(), [TARGET_URL], { requestingUserId: owner });
    const entry = result.data.runs[0];
    const run = await PageVerificationRun.findOne({ runId: entry.runId });

    assert.equal(entry.url, TARGET_URL);
    assert.equal(run.pageUrl, TARGET_URL);
    assert.equal(run._id.toString(), entry.verificationRunId);
  });

  test('each accepted URL gets its own distinct runId (mirrors single-URL runId generation)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    await seedPageData(project._id, 'https://example.com/other');

    const result = await startVerificationBatch(project._id.toString(), [TARGET_URL, 'https://example.com/other'], { requestingUserId: owner });
    const runIds = result.data.runs.map((r) => r.runId);
    assert.equal(new Set(runIds).size, 2, 'runIds must be unique per URL');
  });
});

describe('startVerificationBatch — duplicate filtering (live Mongo)', () => {
  test('an exact duplicate URL in the same submission is rejected, the first occurrence is accepted', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const result = await startVerificationBatch(project._id.toString(), [TARGET_URL, TARGET_URL], { requestingUserId: owner });

    assert.equal(result.success, true);
    assert.equal(result.data.acceptedUrls, 1);
    assert.equal(result.data.rejectedUrls, 1);
    assert.equal(result.data.rejected[0].reason, 'DUPLICATE');

    const runs = await PageVerificationRun.find({ projectId: project._id });
    assert.equal(runs.length, 1);
  });

  test('a normalization-equivalent duplicate (trailing slash) is also rejected', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    await seedPageData(project._id, 'https://example.com/services');

    const result = await startVerificationBatch(
      project._id.toString(),
      ['https://example.com/services', 'https://example.com/services/'],
      { requestingUserId: owner }
    );

    assert.equal(result.data.acceptedUrls, 1);
    assert.equal(result.data.rejectedUrls, 1);
    assert.equal(result.data.rejected[0].reason, 'DUPLICATE');
  });
});

describe('startVerificationBatch — partial success and all-rejected (live Mongo)', () => {
  test('a mix of valid and foreign-domain URLs yields partial success with correct per-URL results', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const result = await startVerificationBatch(
      project._id.toString(),
      [TARGET_URL, 'https://not-this-project.com/page'],
      { requestingUserId: owner }
    );

    assert.equal(result.success, true);
    assert.equal(result.data.totalUrls, 1, 'rejected-at-creation-time URLs never count toward totalUrls');
    assert.equal(result.data.acceptedUrls, 1);
    assert.equal(result.data.rejectedUrls, 1);
    assert.equal(result.data.rejected[0].url, 'https://not-this-project.com/page');
    assert.equal(result.data.rejected[0].reason, URL_VERIFICATION_RESULT_CODES.INVALID_URL);

    const batch = await VerificationBatch.findBatch(result.data.batchId);
    assert.equal(batch.totalUrls, 1);
    assert.deepEqual(batch.urls, [TARGET_URL]);
  });

  test('every URL rejected returns NO_VALID_URLS and creates no VerificationBatch document', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const result = await startVerificationBatch(
      project._id.toString(),
      ['https://not-this-project.com/a', 'https://not-this-project.com/b'],
      { requestingUserId: owner }
    );

    assert.equal(result.success, false);
    assert.equal(result.code, URL_VERIFICATION_RESULT_CODES.NO_VALID_URLS);
    assert.equal(result.data.rejected.length, 2);

    const batches = await VerificationBatch.find({ projectId: project._id });
    assert.equal(batches.length, 0);
    const runs = await PageVerificationRun.find({ projectId: project._id });
    assert.equal(runs.length, 0);
  });

  test('an unparseable/non-string entry in urls is rejected per-item without aborting the batch', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const result = await startVerificationBatch(project._id.toString(), [TARGET_URL, null, 123, ''], { requestingUserId: owner });

    assert.equal(result.success, true);
    assert.equal(result.data.acceptedUrls, 1);
    assert.equal(result.data.rejectedUrls, 3);
  });
});
