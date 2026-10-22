import { describe, test, before, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../model/SeoProject.js';
import User from '../../user/model/User.js';
import Job from '../../jobs/model/Job.js';
import AuditRun from '../../audit_history/model/AuditRun.js';
import JobDispatcher from '../../jobs/service/jobDispatcher.js';
import { JobService } from '../../jobs/service/jobService.js';
import { startProjectAudit, AUDIT_RESULT_CODES } from './projectAuditService.js';
import { deductRecrawls, hasRecrawls, refundRecrawls, summarizeQuota } from '../../../utils/creditService.js';
import { RUN_SOURCES } from '../../jobs/runSources.js';

// Manual Recrawl billing (B/E of the Recrawl-vs-Recheck split): a manual
// "Start Recrawl" reserves exactly ONE manual recrawl credit atomically,
// BEFORE any project data is reset; a project's first audit and admin-started
// audits are free. Live-Mongo (the h3-concurrency test's own convention) —
// the credit reservation and the crawl_status claim are both real atomic
// Mongo updates, so mocking them would prove nothing. Only the outbound
// job dispatch (HTTP to the Python workers) is stubbed.

let mongoAvailable = false;

before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch {
    mongoAvailable = false;
  }
  if (mongoAvailable) {
    // Never reach the real Python workers from a unit test.
    for (const method of ['queueLinkDiscoveryJob', 'queueDomainPerformanceJob', 'dispatchTechnicalDomainJob']) {
      mock.method(JobDispatcher.prototype, method, async () => {});
    }
  }
});

after(async () => {
  mock.restoreAll();
  if (mongoAvailable) await mongoose.connection.close();
});

const created = { users: [], projects: [] };

async function makeUser({ status = 'active', limit = 3, used = 0 } = {}) {
  const _id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({
    _id,
    firstName: 'Recrawl',
    lastName: 'Tester',
    email: `recrawl-billing-${_id}@example.test`,
    roleId: 2,
    subscription: {
      plan: 'starter',
      status,
      credits: { limit: 1, used: 1 },
      pages: { limit: 100, used: 0 },
      recrawls: { limit, used },
    },
  });
  created.users.push(_id);
  return _id;
}

// A project that has ALREADY completed an audit (last_scraped_at set), so a
// manual "Start Recrawl" on it is a real, billable recrawl.
async function makeProject(owner, overrides = {}) {
  const project = await SeoProject.create({
    user_id: owner,
    project_name: 'Recrawl Billing Test',
    main_url: 'https://example.com',
    seo_scope: 'national',
    keywords: ['test keyword'],
    crawl_status: 'completed',
    last_scraped_at: new Date(),
    ...overrides,
  });
  await mongoose.connection.db.collection('seo_page_data').insertOne({ projectId: project._id, url: 'https://example.com/keep-me' });
  created.projects.push(project._id);
  return project;
}

const recrawlsOf = async (userId) => (await User.findById(userId).select('subscription').lean()).subscription.recrawls;

afterEach(async () => {
  if (!mongoAvailable) return;
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

describe('Manual Recrawl billing (live Mongo)', () => {
  test('1+2+5: with credit available it starts the FULL pipeline and consumes exactly 1 credit', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const owner = await makeUser({ limit: 3, used: 0 });
    const project = await makeProject(owner);

    const result = await startProjectAudit(project._id.toString(), { source: 'manual', requestingUserId: owner });

    assert.equal(result.success, true);
    assert.equal(result.code, AUDIT_RESULT_CODES.STARTED);
    assert.equal(result.data.run_source, RUN_SOURCES.MANUAL_RECRAWL);
    assert.equal(result.data.recrawl_credit_consumed, true);
    assert.deepEqual(result.data.recrawls, { limit: 3, used: 1, remaining: 2 });
    assert.equal((await recrawlsOf(owner)).used, 1, 'exactly one credit consumed');

    // Full pipeline: LINK_DISCOVERY + DOMAIN_PERFORMANCE + TECHNICAL_DOMAIN, no verification mode.
    const jobs = await Job.find({ project_id: project._id }).lean();
    assert.deepEqual(jobs.map((j) => j.jobType).sort(), ['DOMAIN_PERFORMANCE', 'LINK_DISCOVERY', 'TECHNICAL_DOMAIN']);
    assert.ok(jobs.every((j) => j.input_data.mode === undefined), 'full audit must not be verification mode');
    assert.ok(jobs.every((j) => j.input_data.run_source === RUN_SOURCES.MANUAL_RECRAWL), 'every seed job carries the run source');
    const fresh = await SeoProject.findById(project._id).lean();
    assert.equal(fresh.current_run_source, RUN_SOURCES.MANUAL_RECRAWL);
  });

  test('3: with 0 credits left it is blocked BEFORE any project data is reset', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const owner = await makeUser({ limit: 3, used: 3 });
    const project = await makeProject(owner);

    const result = await startProjectAudit(project._id.toString(), { source: 'manual', requestingUserId: owner });

    assert.equal(result.success, false);
    assert.equal(result.code, AUDIT_RESULT_CODES.INSUFFICIENT_RECRAWLS);
    assert.equal((await recrawlsOf(owner)).used, 3, 'nothing consumed');
    assert.equal(await Job.countDocuments({ project_id: project._id }), 0, 'no jobs created');
    const survived = await mongoose.connection.db.collection('seo_page_data').findOne({ projectId: project._id });
    assert.ok(survived, 'seo_page_data must survive — no partial reset');
    const fresh = await SeoProject.findById(project._id).lean();
    assert.equal(fresh.crawl_status, 'completed', 'crawl_status untouched');
  });

  test('4: two simultaneous manual requests with ONE credit left → exactly one starts, one credit consumed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const owner = await makeUser({ limit: 3, used: 2 });
    const project = await makeProject(owner);

    const results = await Promise.all([
      startProjectAudit(project._id.toString(), { source: 'manual', requestingUserId: owner }),
      startProjectAudit(project._id.toString(), { source: 'manual', requestingUserId: owner }),
    ]);

    const started = results.filter((r) => r.success);
    const rejected = results.filter((r) => !r.success);
    assert.equal(started.length, 1, 'exactly one request may start');
    assert.equal(rejected.length, 1);
    assert.ok(
      [AUDIT_RESULT_CODES.ALREADY_RUNNING, AUDIT_RESULT_CODES.INSUFFICIENT_RECRAWLS].includes(rejected[0].code),
      `loser rejected with ${rejected[0].code}`
    );
    assert.equal((await recrawlsOf(owner)).used, 3, 'never more than the allowance');
    assert.equal(await Job.countDocuments({ project_id: project._id, jobType: 'LINK_DISCOVERY' }), 1, 'one pipeline, not two');
  });

  test('4b: a double click on a project with plenty of credit consumes only ONE (the duplicate loses at the lock)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const owner = await makeUser({ limit: 5, used: 0 });
    const project = await makeProject(owner);

    const results = await Promise.all([
      startProjectAudit(project._id.toString(), { source: 'manual', requestingUserId: owner }),
      startProjectAudit(project._id.toString(), { source: 'manual', requestingUserId: owner }),
    ]);

    assert.equal(results.filter((r) => r.success).length, 1);
    assert.ok(results.some((r) => r.code === AUDIT_RESULT_CODES.ALREADY_RUNNING));
    assert.equal((await recrawlsOf(owner)).used, 1, 'the duplicate click must not cost a credit');
  });

  test("a project's FIRST audit (onboarding / Pre-Audit) is free — even with 0 credits", async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const owner = await makeUser({ limit: 0, used: 0 });
    const project = await makeProject(owner, { last_scraped_at: null, crawl_status: 'pending' });

    const result = await startProjectAudit(project._id.toString(), { source: 'manual', requestingUserId: owner });

    assert.equal(result.success, true);
    assert.equal(result.data.run_source, RUN_SOURCES.INITIAL_AUDIT);
    assert.equal(result.data.recrawl_credit_consumed, false);
    assert.equal((await recrawlsOf(owner)).used, 0);
  });

  test('a project that already has an audit run in history is NOT a first audit (billed)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const owner = await makeUser({ limit: 1, used: 0 });
    const project = await makeProject(owner, { last_scraped_at: null, crawl_status: 'completed' });
    await AuditRun.create({ projectId: project._id, auditNumber: 1, startedAt: new Date(Date.now() - 1000), completedAt: new Date() });

    const result = await startProjectAudit(project._id.toString(), { source: 'manual', requestingUserId: owner });

    assert.equal(result.success, true);
    assert.equal(result.data.run_source, RUN_SOURCES.MANUAL_RECRAWL);
    assert.equal((await recrawlsOf(owner)).used, 1);
  });

  test('admin-started audits are never billed to the owner (and skip the ownership check)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const owner = await makeUser({ limit: 0, used: 0 });
    const project = await makeProject(owner);

    const result = await startProjectAudit(project._id.toString(), { source: RUN_SOURCES.ADMIN_RECRAWL });

    assert.equal(result.success, true);
    assert.equal(result.data.run_source, RUN_SOURCES.ADMIN_RECRAWL);
    assert.equal((await recrawlsOf(owner)).used, 0);
  });

  test('a subscription that cannot consume quota is rejected without touching the lock or the balance', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const owner = await makeUser({ status: 'past_due', limit: 3, used: 0 });
    const project = await makeProject(owner);

    const result = await startProjectAudit(project._id.toString(), { source: 'manual', requestingUserId: owner });

    assert.equal(result.success, false);
    assert.equal(result.code, AUDIT_RESULT_CODES.SUBSCRIPTION_NOT_ACTIVE);
    assert.equal((await recrawlsOf(owner)).used, 0);
    assert.equal((await SeoProject.findById(project._id).lean()).crawl_status, 'completed');
  });

  test('another user cannot spend the owner\'s credit (ACCESS_DENIED, balance untouched)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const owner = await makeUser({ limit: 3, used: 0 });
    const intruder = await makeUser({ limit: 3, used: 0 });
    const project = await makeProject(owner);

    const result = await startProjectAudit(project._id.toString(), { source: 'manual', requestingUserId: intruder });

    assert.equal(result.code, AUDIT_RESULT_CODES.ACCESS_DENIED);
    assert.equal((await recrawlsOf(owner)).used, 0);
    assert.equal((await recrawlsOf(intruder)).used, 0);
  });

  test('a full audit refuses recheck sources — the weekly scheduler cannot start a Recrawl through it', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const owner = await makeUser();
    const project = await makeProject(owner);

    await assert.rejects(() => startProjectAudit(project._id.toString(), { source: RUN_SOURCES.WEEKLY_RECHECK }), /invalid source/);
    await assert.rejects(() => startProjectAudit(project._id.toString(), { source: RUN_SOURCES.MANUAL_RECHECK }), /invalid source/);
    assert.equal(await Job.countDocuments({ project_id: project._id }), 0);
  });

  test('if the run fails to START (job creation throws) the credit is refunded and the lock released', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const owner = await makeUser({ limit: 3, used: 0 });
    const project = await makeProject(owner);
    const failing = mock.method(JobService.prototype, 'createJob', async () => { throw new Error('boom'); });

    try {
      await assert.rejects(() => startProjectAudit(project._id.toString(), { source: 'manual', requestingUserId: owner }), /boom/);
    } finally {
      failing.mock.restore();
    }

    assert.equal((await recrawlsOf(owner)).used, 0, 'reservation refunded');
    assert.equal((await SeoProject.findById(project._id).lean()).crawl_status, 'completed', 'lock released');
  });

  test('a run that already STARTED keeps its credit consumed (no automatic refund for pipeline failures)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const owner = await makeUser({ limit: 3, used: 0 });
    const project = await makeProject(owner);

    const started = await startProjectAudit(project._id.toString(), { source: 'manual', requestingUserId: owner });
    assert.equal(started.success, true);
    // Simulate the worker crashing / a job failing after the start.
    await Job.updateMany({ project_id: project._id }, { $set: { status: 'failed' } });
    await SeoProject.updateOne({ _id: project._id }, { $set: { crawl_status: 'pending' } });

    assert.equal((await recrawlsOf(owner)).used, 1, 'credit stays consumed');
  });
});

describe('creditService manual recrawl primitives (live Mongo)', () => {
  test('deductRecrawls: N concurrent calls against `remaining = 2` succeed exactly twice', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const owner = await makeUser({ limit: 5, used: 3 });

    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => deductRecrawls(owner, 1)));

    assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 2);
    assert.ok(outcomes.filter((o) => o.status === 'rejected').every((o) => o.reason.code === 'INSUFFICIENT_RECRAWLS'));
    assert.equal((await recrawlsOf(owner)).used, 5);
  });

  test('deductRecrawls tolerates a legacy user document with no recrawls field (treated as 0, rejected)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const _id = new mongoose.Types.ObjectId();
    await User.collection.insertOne({
      _id, firstName: 'Legacy', lastName: 'User', email: `legacy-${_id}@example.test`, roleId: 2,
      subscription: { plan: 'starter', status: 'active', credits: { limit: 1, used: 0 }, pages: { limit: 1, used: 0 } },
    });
    created.users.push(_id);

    await assert.rejects(() => deductRecrawls(_id, 1), (e) => e.code === 'INSUFFICIENT_RECRAWLS');
    const legacy = await User.findById(_id).lean();
    assert.equal(hasRecrawls(legacy), false);
    assert.deepEqual(summarizeQuota(legacy).recrawls, { limit: 0, used: 0, remaining: 0 });
  });

  test('refundRecrawls never drives `used` negative', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const owner = await makeUser({ limit: 3, used: 0 });
    await refundRecrawls(owner, 1);
    assert.equal((await recrawlsOf(owner)).used, 0);
  });
});
