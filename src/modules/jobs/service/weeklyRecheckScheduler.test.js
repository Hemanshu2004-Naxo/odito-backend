import { describe, test, before, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import User from '../../user/model/User.js';
import Job from '../model/Job.js';
import AuditRun from '../../audit_history/model/AuditRun.js';
import JobDispatcher from './jobDispatcher.js';
import { JobService } from './jobService.js';
import { runOnce } from './weeklyRecheckScheduler.js';
import { startProjectAudit, AUDIT_RESULT_CODES } from '../../app_user/service/projectAuditService.js';
import { startProjectVerification, VERIFICATION_RESULT_CODES } from '../../app_user/service/projectVerificationService.js';
import { startVerification } from '../../app_user/controller/scrapingController.js';
import auditHistoryService from '../../audit_history/service/AuditHistoryService.js';
import { RUN_SOURCES } from '../runSources.js';

// Weekly Recheck (C/D/E/I/J/K of the Recrawl-vs-Recheck split): the scheduler
// runs the Quick Recheck (verification) pipeline through the SAME service the
// dashboard button uses, tagged 'weekly_recheck', never bills, never starts a
// full audit, and is idempotent/concurrency-safe via the project lock.
//
// Live-Mongo. runOnce() normally scans EVERY due project in the database —
// against a shared dev DB that would fire rechecks on real projects — so
// SeoProject.getProjectsNeedingScrape is stubbed to return only this test's
// own projects. The eligibility query itself is asserted separately, read-only.

let mongoAvailable = false;
let dueList = [];
// Captured BEFORE the file-wide stub below so the real eligibility query can be asserted.
const originalGetDue = SeoProject.getProjectsNeedingScrape;

before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch {
    mongoAvailable = false;
  }
  if (mongoAvailable) {
    for (const method of ['dispatchPageScrapingJob', 'dispatchHeadlessAccessibilityJob', 'queueLinkDiscoveryJob', 'queueDomainPerformanceJob', 'dispatchTechnicalDomainJob']) {
      mock.method(JobDispatcher.prototype, method, async () => {});
    }
  }
});

after(async () => {
  mock.restoreAll();
  if (mongoAvailable) await mongoose.connection.close();
});

const created = { users: [], projects: [] };
const eightDaysAgo = () => new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);

async function makeUser({ status = 'active', limit = 3, used = 3 } = {}) {
  const _id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({
    _id, firstName: 'Weekly', lastName: 'Tester', email: `weekly-recheck-${_id}@example.test`, roleId: 2,
    subscription: {
      plan: 'starter', status,
      credits: { limit: 1, used: 1 }, pages: { limit: 100, used: 0 },
      recrawls: { limit, used }, // default: ZERO manual recrawls left
    },
  });
  created.users.push(_id);
  return _id;
}

async function makeProject(owner, overrides = {}) {
  const project = await SeoProject.create({
    user_id: owner,
    project_name: `Weekly Recheck Test ${new mongoose.Types.ObjectId()}`,
    main_url: 'https://example.com',
    seo_scope: 'national',
    keywords: ['test keyword'],
    status: 'active',
    scrape_frequency: 'weekly',
    crawl_status: 'completed',
    last_scraped_at: eightDaysAgo(),
    ...overrides,
  });
  await mongoose.connection.db.collection('seo_page_data').insertOne({ projectId: project._id, url: 'https://example.com/page-a' });
  created.projects.push(project._id);
  return project;
}

const usedRecrawls = async (userId) => (await User.findById(userId).select('subscription').lean()).subscription.recrawls.used;
const jobsOf = (project) => Job.find({ project_id: project._id }).lean();

function fakeRes() {
  const res = { statusCode: null, body: null, status(c) { res.statusCode = c; return res; }, json(b) { res.body = b; return res; } };
  return res;
}

afterEach(async () => {
  if (!mongoAvailable) return;
  dueList = [];
  for (const projectId of created.projects) {
    await Job.deleteMany({ project_id: projectId });
    await AuditRun.deleteMany({ projectId });
    await mongoose.connection.db.collection('seo_page_data').deleteMany({ projectId });
    await SeoProject.deleteOne({ _id: projectId });
  }
  if (created.users.length) await User.collection.deleteMany({ _id: { $in: created.users } });
  created.users = [];
  created.projects = [];
});

// One stub for the whole file, reading the per-test `dueList`.
before(() => {
  mock.method(SeoProject, 'getProjectsNeedingScrape', async () => dueList);
});

describe('Weekly Recheck scheduler (live Mongo)', () => {
  test('6+7+8+9: triggers the Quick Recheck pipeline — NOT a full Recrawl — and consumes 0 credits even at 0 remaining', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const owner = await makeUser({ limit: 3, used: 3 }); // 0 manual recrawls left
    const project = await makeProject(owner);
    dueList = [project];

    const summary = await runOnce();

    assert.equal(summary.started, 1);
    assert.equal(summary.failed, 0);
    const jobs = await jobsOf(project);
    assert.deepEqual(jobs.map((j) => j.jobType).sort(), ['HEADLESS_ACCESSIBILITY', 'PAGE_SCRAPING']);
    assert.ok(jobs.every((j) => j.input_data.mode === 'verification'), 'verification pipeline');
    assert.ok(jobs.every((j) => j.input_data.run_source === RUN_SOURCES.WEEKLY_RECHECK));
    assert.equal(jobs.filter((j) => ['LINK_DISCOVERY', 'DOMAIN_PERFORMANCE', 'TECHNICAL_DOMAIN'].includes(j.jobType)).length, 0, 'no full-audit seed jobs');
    assert.equal(await usedRecrawls(owner), 3, 'manual recrawl balance untouched');
    const fresh = await SeoProject.findById(project._id).lean();
    assert.equal(fresh.current_run_source, RUN_SOURCES.WEEKLY_RECHECK);
    assert.equal(fresh.scrape_frequency, 'weekly', 'schedule stays enabled');
  });

  test('11+14: a duplicate scheduler invocation (concurrent ticks / two instances) starts ONE recheck', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const owner = await makeUser();
    const project = await makeProject(owner);
    dueList = [project];

    const [a, b] = await Promise.all([runOnce(), runOnce()]);

    assert.equal(a.started + b.started, 1, 'exactly one tick wins the atomic claim');
    assert.equal(a.skipped + b.skipped, 1);
    assert.equal(await Job.countDocuments({ project_id: project._id, jobType: 'PAGE_SCRAPING' }), 1);

    // And a later restart/tick while it is still running does not create another.
    const again = await runOnce();
    assert.equal(again.started, 0);
    assert.equal(await Job.countDocuments({ project_id: project._id, jobType: 'PAGE_SCRAPING' }), 1);
  });

  test('10: only projects the eligibility query returns run — manual/deleted/recent projects are excluded by getProjectsNeedingScrape', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const owner = await makeUser();
    const weekly = await makeProject(owner);
    const manual = await makeProject(owner, { scrape_frequency: 'manual' });
    const trashed = await makeProject(owner, { is_deleted: true });
    const recent = await makeProject(owner, { last_scraped_at: new Date() });

    const due = (await originalGetDue.call(SeoProject)).map((p) => p._id.toString());

    assert.ok(due.includes(weekly._id.toString()), 'enabled + 8 days old → due');
    assert.ok(!due.includes(manual._id.toString()), 'disabled (manual) must not run');
    assert.ok(!due.includes(trashed._id.toString()), 'deleted must not run');
    assert.ok(!due.includes(recent._id.toString()), 'scraped <7 days ago is not due yet');
  });

  test('a project whose owner subscription is not active is skipped (existing subscription rules), nothing started', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const owner = await makeUser({ status: 'canceled' });
    const project = await makeProject(owner);
    dueList = [project];

    const summary = await runOnce();

    assert.equal(summary.started, 0);
    assert.deepEqual(summary.skippedProjects, [{ projectId: project._id.toString(), reason: 'SUBSCRIPTION_NOT_ACTIVE' }]);
    assert.equal(await Job.countDocuments({ project_id: project._id }), 0);
  });

  test('12: a weekly recheck that FAILS to start consumes no credit, keeps the schedule, and does not run a full Recrawl', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const owner = await makeUser({ limit: 3, used: 1 });
    const project = await makeProject(owner);
    dueList = [project];
    const failing = mock.method(JobService.prototype, 'createJob', async () => { throw new Error('boom'); });

    let summary;
    try {
      summary = await runOnce();
    } finally {
      failing.mock.restore();
    }

    assert.equal(summary.failed, 1);
    assert.equal(summary.started, 0);
    assert.equal(await usedRecrawls(owner), 1, 'no manual recrawl consumed');
    const fresh = await SeoProject.findById(project._id).lean();
    assert.equal(fresh.scrape_frequency, 'weekly', 'scheduling not disabled by a failure');
    assert.equal(fresh.crawl_status, 'completed', 'lock released so the next tick / a manual run can proceed');
    assert.equal(await Job.countDocuments({ project_id: project._id, jobType: 'LINK_DISCOVERY' }), 0, 'no accidental full audit');
  });

  test('one failing project does not abort the rest of the run', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const owner = await makeUser();
    const p1 = await makeProject(owner);
    const p2 = await makeProject(owner, { project_name: 'Second' });
    dueList = [p1, p2];
    let calls = 0;
    const original = JobService.prototype.createJob;
    const flaky = mock.method(JobService.prototype, 'createJob', async function (...args) {
      calls += 1;
      if (calls <= 1) throw new Error('first project fails on its first job');
      return original.apply(this, args);
    });

    let summary;
    try {
      summary = await runOnce();
    } finally {
      flaky.mock.restore();
    }

    assert.equal(summary.failed, 1);
    assert.equal(summary.started, 1);
  });
});

describe('Weekly Recheck vs Manual Recrawl concurrency (live Mongo)', () => {
  test('13a: a Manual Recrawl in flight (running) blocks the Weekly Recheck', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const owner = await makeUser({ limit: 3, used: 0 });
    const project = await makeProject(owner);
    const manual = await startProjectAudit(project._id.toString(), { source: 'manual', requestingUserId: owner });
    assert.equal(manual.success, true);
    dueList = [project];

    const summary = await runOnce();

    assert.equal(summary.started, 0);
    assert.equal(summary.skippedProjects[0].reason, VERIFICATION_RESULT_CODES.ALREADY_RUNNING);
    assert.equal(await Job.countDocuments({ project_id: project._id, jobType: 'PAGE_SCRAPING' }), 0, 'recheck must not have reset or seeded anything');
    assert.equal(await Job.countDocuments({ project_id: project._id, jobType: 'LINK_DISCOVERY' }), 1, 'the manual run is intact');
  });

  test('13b: a Manual Recrawl parked at URL selection (no active job yet) still blocks the Weekly Recheck', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const owner = await makeUser();
    const project = await makeProject(owner, { crawl_status: 'awaiting_url_selection' });
    dueList = [project];

    const summary = await runOnce();

    assert.equal(summary.started, 0);
    assert.equal(summary.skippedProjects[0].reason, VERIFICATION_RESULT_CODES.ALREADY_RUNNING);
    const survived = await mongoose.connection.db.collection('seo_page_data').findOne({ projectId: project._id });
    assert.ok(survived, 'the soft reset must not run under a parked Recrawl');
    assert.equal((await SeoProject.findById(project._id).lean()).crawl_status, 'awaiting_url_selection');
  });

  test('13c: a Weekly Recheck in flight blocks a Manual Recrawl — and the blocked click costs no credit', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const owner = await makeUser({ limit: 3, used: 0 });
    const project = await makeProject(owner);
    dueList = [project];
    await runOnce();

    const manual = await startProjectAudit(project._id.toString(), { source: 'manual', requestingUserId: owner });

    assert.equal(manual.success, false);
    assert.equal(manual.code, AUDIT_RESULT_CODES.ALREADY_RUNNING);
    assert.equal(await usedRecrawls(owner), 0);
  });

  test('a manual Quick Recheck (dashboard button) is blocked with 409 while a Weekly Recheck runs, and is free', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const owner = await makeUser({ limit: 3, used: 3 });
    const project = await makeProject(owner);
    dueList = [project];
    await runOnce();

    const res = fakeRes();
    await startVerification({ body: { project_id: project._id.toString() }, user: { _id: owner } }, res);

    assert.equal(res.statusCode, 409);
    assert.equal(await usedRecrawls(owner), 3);
  });
});

describe('Quick Recheck service (shared by the dashboard button and the scheduler)', () => {
  test('manual recheck: owner-only, free at 0 credits, stamped manual_recheck', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const owner = await makeUser({ limit: 3, used: 3 });
    const project = await makeProject(owner);

    const denied = await startProjectVerification(project._id.toString(), { source: RUN_SOURCES.MANUAL_RECHECK, requestingUserId: new mongoose.Types.ObjectId() });
    assert.equal(denied.code, VERIFICATION_RESULT_CODES.ACCESS_DENIED);

    const res = fakeRes();
    await startVerification({ body: { project_id: project._id.toString() }, user: { _id: owner } }, res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.message, 'Quick Recheck started');
    assert.equal(res.body.data.mode, 'verification');
    assert.equal(res.body.data.source, RUN_SOURCES.MANUAL_RECHECK);
    assert.equal(await usedRecrawls(owner), 3, 'Quick Recheck is free');
  });

  test('NO_PREVIOUS_CRAWL is returned (and nothing is reset) when there is no page data to recheck', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const owner = await makeUser();
    const project = await makeProject(owner);
    await mongoose.connection.db.collection('seo_page_data').deleteMany({ projectId: project._id });

    const result = await startProjectVerification(project._id.toString(), { source: RUN_SOURCES.WEEKLY_RECHECK });

    assert.equal(result.code, VERIFICATION_RESULT_CODES.NO_PREVIOUS_CRAWL);
    assert.equal((await SeoProject.findById(project._id).lean()).crawl_status, 'completed', 'lock released');
  });

  test('rejects a source that is not a recheck source, and a trashed project is NOT_FOUND', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const owner = await makeUser();
    const project = await makeProject(owner, { is_deleted: true });

    await assert.rejects(() => startProjectVerification(project._id.toString(), { source: RUN_SOURCES.MANUAL_RECRAWL }), /invalid source/);
    const result = await startProjectVerification(project._id.toString(), { source: RUN_SOURCES.WEEKLY_RECHECK });
    assert.equal(result.code, VERIFICATION_RESULT_CODES.NOT_FOUND);
  });
});

describe('Audit history run source (live Mongo)', () => {
  test('the audit_runs snapshot records whether it was a manual Recrawl or a weekly Recheck', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const owner = await makeUser();
    const project = await makeProject(owner);
    dueList = [project];
    await runOnce();

    const live = await SeoProject.findById(project._id).lean();
    const snapshot = await auditHistoryService._buildSnapshot(live, project._id.toString(), 1);
    assert.equal(snapshot.source, RUN_SOURCES.WEEKLY_RECHECK);

    const run = await AuditRun.create(snapshot);
    assert.equal(run.source, 'weekly_recheck');
  });
});
