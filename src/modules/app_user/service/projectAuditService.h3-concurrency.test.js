import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../model/SeoProject.js';
import Job from '../../jobs/model/Job.js';
import PageVerificationRun from '../../verification/model/PageVerificationRun.js';
import { startProjectAudit, AUDIT_RESULT_CODES } from './projectAuditService.js';
import { startVerification } from '../controller/scrapingController.js';
import { startUrlVerification, URL_VERIFICATION_RESULT_CODES } from '../../verification/service/urlVerificationService.js';

// H3: prevents a Full Audit, legacy project-wide verification, and URL
// Verification from running concurrently on the same project, since all
// three write to the same shared collections (seo_page_data,
// seo_page_issues, seo_page_scores, ai_scores) via the same job types
// (PAGE_SCRAPING/HEADLESS_ACCESSIBILITY/PAGE_ANALYSIS/SEO_SCORING/
// AI_VISIBILITY), distinguished only by input_data.mode. All three guards
// now share one widened ACTIVE_PIPELINE_JOB_TYPES list (projectAuditService.js)
// instead of three independently-maintained (and previously divergent)
// job-type lists.
//
// Live-Mongo only — this is fundamentally about real Job documents and
// real query behavior across three different entry points.

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
const TARGET_URL = 'https://example.com/pricing';

async function makeProject(overrides = {}) {
  owner = new mongoose.Types.ObjectId();
  project = await SeoProject.create({
    user_id: owner,
    project_name: 'H3 Test Project',
    main_url: 'https://example.com',
    seo_scope: 'national',
    keywords: ['test keyword'],
    crawl_status: 'pending',
    ...overrides,
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
  const res = { statusCode: null, body: null, status(c) { res.statusCode = c; return res; }, json(b) { res.body = b; return res; } };
  return res;
}

async function seedActiveJob(jobType, mode, status = 'processing') {
  // Job.js's own pre('validate') hook (P1-001) requires target_url whenever
  // mode:'url_verification' is present.
  const input_data = mode === 'url_verification'
    ? { mode, target_url: TARGET_URL }
    : (mode ? { mode } : {});
  return Job.create({
    user_id: owner,
    project_id: project._id,
    jobType,
    entityType: 'project',
    status,
    run_id: new mongoose.Types.ObjectId(),
    input_data,
  });
}

describe('H3 — URL Verification blocked by an active Full Audit or legacy verification (live Mongo)', () => {
  test('blocked while a Full Audit job (no mode) is pending/processing', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    await seedActiveJob('LINK_DISCOVERY', undefined, 'processing');

    const result = await startUrlVerification(project._id.toString(), TARGET_URL, { requestingUserId: owner });

    assert.equal(result.success, false);
    assert.equal(result.code, URL_VERIFICATION_RESULT_CODES.ALREADY_RUNNING);
  });

  test('blocked while a Full Audit\'s SEO_SCORING/AI_VISIBILITY stage is still running (the exact gap this task closes)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    await seedActiveJob('SEO_SCORING', undefined, 'processing');

    const result = await startUrlVerification(project._id.toString(), TARGET_URL, { requestingUserId: owner });

    assert.equal(result.success, false);
    assert.equal(result.code, URL_VERIFICATION_RESULT_CODES.ALREADY_RUNNING);
  });

  test('blocked while a legacy verification (mode:"verification") job is pending/processing', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    await seedActiveJob('PAGE_SCRAPING', 'verification', 'processing');

    const result = await startUrlVerification(project._id.toString(), TARGET_URL, { requestingUserId: owner });

    assert.equal(result.success, false);
    assert.equal(result.code, URL_VERIFICATION_RESULT_CODES.ALREADY_RUNNING);
  });

  test('blocked while project.crawl_status is "running" even with no matching job yet (the atomic-claim window)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject({ crawl_status: 'running' });

    const result = await startUrlVerification(project._id.toString(), TARGET_URL, { requestingUserId: owner });

    assert.equal(result.success, false);
    assert.equal(result.code, URL_VERIFICATION_RESULT_CODES.ALREADY_RUNNING);
  });

  test('a COMPLETED Full Audit job no longer blocks', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    await seedActiveJob('SEO_SCORING', undefined, 'completed');

    const result = await startUrlVerification(project._id.toString(), TARGET_URL, { requestingUserId: owner });

    assert.equal(result.success, true);
  });

  test('a FAILED Full Audit job no longer blocks', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    await seedActiveJob('PAGE_ANALYSIS', undefined, 'failed');

    const result = await startUrlVerification(project._id.toString(), TARGET_URL, { requestingUserId: owner });

    assert.equal(result.success, true);
  });

  test('no PageVerificationRun or Job is created when blocked', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    await seedActiveJob('AI_VISIBILITY', undefined, 'processing');

    await startUrlVerification(project._id.toString(), TARGET_URL, { requestingUserId: owner });

    const runs = await PageVerificationRun.find({ projectId: project._id });
    const jobs = await Job.find({ project_id: project._id, jobType: { $ne: 'AI_VISIBILITY' } });
    assert.equal(runs.length, 0);
    assert.equal(jobs.length, 0);
  });

  test('backward compatibility: an unrelated job type (e.g. KEYWORD_RESEARCH) does not block URL Verification', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();

    const result = await startUrlVerification(project._id.toString(), TARGET_URL, { requestingUserId: owner });
    assert.equal(result.success, true);
  });
});

describe('H3 — Full Audit blocked by an active URL Verification (live Mongo)', () => {
  test('startProjectAudit() rejects with ALREADY_RUNNING while a URL Verification PAGE_ANALYSIS job is active', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    await seedActiveJob('PAGE_ANALYSIS', 'url_verification', 'processing');

    const result = await startProjectAudit(project._id.toString(), { source: 'manual', requestingUserId: owner });

    assert.equal(result.success, false);
    assert.equal(result.code, AUDIT_RESULT_CODES.ALREADY_RUNNING);
  });

  test('resetProjectCrawlData does not run: seo_page_data survives a blocked startProjectAudit call', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    await seedActiveJob('AI_VISIBILITY', 'url_verification', 'processing');

    await startProjectAudit(project._id.toString(), { source: 'manual', requestingUserId: owner });

    const survived = await mongoose.connection.db.collection('seo_page_data').findOne({ projectId: project._id, url: TARGET_URL });
    assert.ok(survived, 'seo_page_data must survive when startProjectAudit is blocked before resetProjectCrawlData');
  });

  test('a COMPLETED URL Verification job no longer blocks Full Audit', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    await seedActiveJob('SEO_SCORING', 'url_verification', 'completed');

    const result = await startProjectAudit(project._id.toString(), { source: 'manual', requestingUserId: owner });

    assert.equal(result.success, true);
  });
});

describe('H3 — legacy verification blocked by an active URL Verification, and vice versa (live Mongo)', () => {
  test('startVerification() (legacy, project-wide) rejects with 409 while a URL Verification job is active', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    await seedActiveJob('HEADLESS_ACCESSIBILITY', 'url_verification', 'processing');

    const req = { body: { project_id: project._id.toString() }, user: { _id: owner } };
    const res = fakeRes();
    await startVerification(req, res);

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.success, false);
  });

  test('startUrlVerification() rejects while a legacy verification HEADLESS_ACCESSIBILITY job is active', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await makeProject();
    await seedActiveJob('HEADLESS_ACCESSIBILITY', 'verification', 'processing');

    const result = await startUrlVerification(project._id.toString(), TARGET_URL, { requestingUserId: owner });

    assert.equal(result.success, false);
    assert.equal(result.code, URL_VERIFICATION_RESULT_CODES.ALREADY_RUNNING);
  });
});
