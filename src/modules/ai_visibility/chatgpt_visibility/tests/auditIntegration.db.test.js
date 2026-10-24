import { describe, test, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import axios from 'axios';
import ChatGptVisibilityRun from '../models/ChatGptVisibilityRun.js';
import AiVisibilityPromptSet from '../../shared/prompts/models/AiVisibilityPromptSet.js';
import { scheduleChatGptVisibilityForAudit, startManualRun, repairMissingRuns, checkRunLimits } from '../services/auditTriggerService.js';
import { getChatGptConfig } from '../config/chatgptConfig.js';
import * as controller from '../controllers/chatgptVisibilityController.js';
import SeoProject from '../../../app_user/model/SeoProject.js';
import User from '../../../user/model/User.js';
import Job from '../../../jobs/model/Job.js';
import JobDispatcher from '../../../jobs/service/jobDispatcher.js';
import { startProjectAudit, AUDIT_RESULT_CODES } from '../../../app_user/service/projectAuditService.js';
import { connectTestDb, disconnectTestDb, dropTestCollections } from '../../shared/tests/testDb.js';

let up = false;
const COLLECTIONS = ['chatgpt_visibility_runs', 'ai_visibility_prompt_sets', 'seoprojects', 'jobs', 'users'];
const ENV_KEYS = ['CHATGPT_VISIBILITY_ENABLED', 'CHATGPT_VISIBILITY_AUTO_RUN', 'CHATGPT_VISIBILITY_AUTO_RUN_SOURCES', 'CHATGPT_VISIBILITY_COOLDOWN_MS',
  'CHATGPT_VISIBILITY_MAX_RUNS_PER_PROJECT', 'CHATGPT_VISIBILITY_DAILY_USER_LIMIT', 'AI_VISIBILITY_PROMPT_USE_OPENAI', 'AI_VISIBILITY_OPENAI_API_KEY',
  'OPENAI_API_KEY', 'OPENAI_POST_API_KEY', 'DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD', 'CHATGPT_VISIBILITY_MAX_CONCURRENT_RUNS'];
const savedEnv = {};

before(async () => {
  up = await connectTestDb();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  if (up) await Promise.all([ChatGptVisibilityRun.syncIndexes(), AiVisibilityPromptSet.syncIndexes()]);
});
after(async () => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  mock.restoreAll();
  if (up) await dropTestCollections(COLLECTIONS);
  await disconnectTestDb();
});
beforeEach(async () => {
  if (up) await dropTestCollections(COLLECTIONS);
  // No credentials of any kind may reach a provider from a test.
  process.env.AI_VISIBILITY_PROMPT_USE_OPENAI = 'false';
  delete process.env.AI_VISIBILITY_OPENAI_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.OPENAI_POST_API_KEY;
  process.env.DATAFORSEO_LOGIN = 'test-login'; process.env.DATAFORSEO_PASSWORD = 'test-password';
  for (const k of ['CHATGPT_VISIBILITY_ENABLED', 'CHATGPT_VISIBILITY_AUTO_RUN', 'CHATGPT_VISIBILITY_AUTO_RUN_SOURCES', 'CHATGPT_VISIBILITY_COOLDOWN_MS', 'CHATGPT_VISIBILITY_MAX_RUNS_PER_PROJECT', 'CHATGPT_VISIBILITY_DAILY_USER_LIMIT']) delete process.env[k];
});
afterEach(() => mock.restoreAll());

const oid = () => new mongoose.Types.ObjectId();
const cfg = (o = {}) => getChatGptConfig({ CHATGPT_VISIBILITY_ENABLED: 'true', CHATGPT_VISIBILITY_AUTO_RUN: 'true', CHATGPT_VISIBILITY_COOLDOWN_MS: '0', ...o });
const noKick = () => { const calls = []; const fn = (id) => { calls.push(id); return true; }; fn.calls = calls; return fn; };

const llmEnvelope = () => ({
  status_code: 20000,
  tasks: [{ id: 'task-1', status_code: 20000, cost: 0.02, result: [{ model_name: 'gpt-4o-mini', items: [{ type: 'message', sections: [{ type: 'text', text: 'Dental Smile Clinic is a good choice.', annotations: [{ title: 'site', url: 'https://smile.example/services' }] }] }] }] }],
});
/** Fails the test on any HTTP call that is not the (mocked) LLM Responses endpoint: nothing else may be reached. */
function mockProviderHttp() {
  return mock.method(axios, 'post', async (url) => {
    assert.equal(url, 'https://api.dataforseo.com/v3/ai_optimization/chat_gpt/llm_responses/live', `unexpected HTTP call to ${url}`);
    return { data: llmEnvelope() };
  });
}
async function waitFor(fn, { timeoutMs = 10_000 } = {}) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > timeoutMs) throw new Error('timeout waiting for condition'); await new Promise((r) => setTimeout(r, 40)); }
}

describe('automatic trigger policy', () => {
  test('off by default: nothing is created', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const r = await scheduleChatGptVisibilityForAudit({ projectId: oid(), userId: oid(), auditRunId: oid(), runSource: 'initial_audit' }, { config: getChatGptConfig({}), kick: noKick() });
    assert.deepEqual([r.scheduled, r.reason], [false, 'DISABLED']);
    assert.equal(await ChatGptVisibilityRun.countDocuments({}), 0);
    const enabledOnly = await scheduleChatGptVisibilityForAudit({ projectId: oid(), userId: oid(), auditRunId: oid(), runSource: 'initial_audit' }, { config: getChatGptConfig({ CHATGPT_VISIBILITY_ENABLED: 'true' }), kick: noKick() });
    assert.equal(enabledOnly.reason, 'DISABLED'); // auto-run is a separate switch
  });

  test('eligible sources create one queued run and hand it to the worker; ineligible sources do not', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const kick = noKick();
    const ids = { projectId: oid(), userId: oid(), auditRunId: oid() };
    const r = await scheduleChatGptVisibilityForAudit({ ...ids, runSource: 'manual_recrawl' }, { config: cfg(), kick });
    assert.equal(r.scheduled, true);
    assert.equal(r.run.status, 'queued');
    assert.equal(String(r.run.auditRunId), String(ids.auditRunId));
    assert.equal(r.run.trigger.source, 'audit');
    assert.deepEqual(kick.calls, [String(r.run._id)]);
    for (const source of ['admin_recrawl', 'manual_recheck', 'weekly_recheck', 'bogus']) {
      const x = await scheduleChatGptVisibilityForAudit({ projectId: oid(), userId: oid(), auditRunId: oid(), runSource: source }, { config: cfg(), kick });
      assert.equal(x.reason, 'RUN_SOURCE_NOT_ELIGIBLE', source);
    }
    assert.equal(await ChatGptVisibilityRun.countDocuments({}), 1);
  });

  test('the same accepted audit never produces two runs (duplicate start, retry, repair)', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const ids = { projectId: oid(), userId: oid(), auditRunId: oid(), runSource: 'initial_audit' };
    const results = await Promise.all(Array.from({ length: 10 }, () => scheduleChatGptVisibilityForAudit(ids, { config: cfg(), kick: noKick() })));
    assert.equal(results.filter((r) => r.scheduled).length, 1);
    assert.equal(await ChatGptVisibilityRun.countDocuments({ projectId: ids.projectId }), 1);
  });

  test('a refused trigger is recorded as skipped (so it is not re-attempted) and does not consume the daily budget', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const projectId = oid(); const userId = oid();
    const config = cfg({ CHATGPT_VISIBILITY_COOLDOWN_MS: '3600000' });
    assert.equal((await scheduleChatGptVisibilityForAudit({ projectId, userId, auditRunId: oid(), runSource: 'initial_audit' }, { config, kick: noKick() })).scheduled, true);
    await ChatGptVisibilityRun.updateMany({ projectId }, { $set: { status: 'completed' } });
    const second = { projectId, userId, auditRunId: oid(), runSource: 'manual_recrawl' };
    const refused = await scheduleChatGptVisibilityForAudit(second, { config, kick: noKick() });
    assert.deepEqual([refused.scheduled, refused.reason], [false, 'PROJECT_COOLDOWN']);
    assert.equal(refused.run.status, 'skipped');
    assert.equal(refused.run.failureCode, 'PROJECT_COOLDOWN');
    const again = await scheduleChatGptVisibilityForAudit(second, { config, kick: noKick() });
    assert.equal(again.reason, 'DUPLICATE_AUDIT_RUN');
    assert.equal(await ChatGptVisibilityRun.countDocuments({ projectId }), 2);
  });

  test('per-project and per-account daily limits', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const config = cfg({ CHATGPT_VISIBILITY_MAX_RUNS_PER_PROJECT: '2', CHATGPT_VISIBILITY_DAILY_USER_LIMIT: '3' });
    const userId = oid(); const projectId = oid();
    for (let i = 0; i < 2; i += 1) {
      await ChatGptVisibilityRun.create({ projectId, userId, auditRunId: oid(), trigger: { source: 'audit' }, status: 'completed' });
    }
    assert.equal((await checkRunLimits({ projectId, userId, config })).code, 'PROJECT_DAILY_LIMIT');
    const p2 = oid();
    await ChatGptVisibilityRun.create({ projectId: p2, userId, auditRunId: oid(), trigger: { source: 'audit' }, status: 'completed' });
    assert.equal((await checkRunLimits({ projectId: oid(), userId, config })).code, 'USER_DAILY_LIMIT');
    assert.equal(await checkRunLimits({ projectId: oid(), userId: oid(), config }), null);
    // skipped records never count
    await ChatGptVisibilityRun.deleteMany({});
    await ChatGptVisibilityRun.create({ projectId, userId, auditRunId: oid(), trigger: { source: 'audit' }, status: 'skipped' });
    assert.equal(await checkRunLimits({ projectId, userId, config }), null);
  });

  test('a scheduling failure never throws into the caller (the audit start)', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const exploding = { findOne: () => { throw new Error('db exploded'); }, countDocuments: () => { throw new Error('db exploded'); }, create: () => { throw new Error('db exploded'); } };
    const r = await scheduleChatGptVisibilityForAudit({ projectId: oid(), userId: oid(), auditRunId: oid(), runSource: 'initial_audit' }, { config: cfg(), Model: exploding, kick: noKick() });
    assert.deepEqual([r.scheduled, r.reason], [false, 'ERROR']);
  });
});

describe('crash-safety repair', () => {
  async function seed({ minutesAgo = 1, source = 'initial_audit', withJob = true, crawl_status = 'running' } = {}) {
    const runId = oid(); const userId = oid();
    const project = await SeoProject.create({ user_id: userId, project_name: 'Repair Test', main_url: 'https://smile.example', keywords: ['k'], seo_scope: 'national', crawl_status });
    await SeoProject.updateOne({ _id: project._id }, { $set: { current_run_id: runId, current_run_source: source, audit_started_at: new Date(Date.now() - minutesAgo * 60_000) } });
    if (withJob) await Job.create({ jobType: 'LINK_DISCOVERY', project_id: project._id, user_id: userId, run_id: runId, input_data: {} });
    return { project, runId, userId };
  }
  const repair = (extra = {}) => repairMissingRuns({ config: cfg(), ...extra });

  test('an accepted audit with no visibility record gets one; running it again changes nothing', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { project, runId } = await seed();
    assert.equal(await repair(), 1);
    const run = await ChatGptVisibilityRun.findOne({ projectId: project._id }).lean();
    assert.equal(String(run.auditRunId), String(runId));
    assert.equal(run.trigger.source, 'repair');
    assert.equal(await repair(), 0);
    assert.equal(await ChatGptVisibilityRun.countDocuments({ projectId: project._id }), 1);
  });

  test('not repaired: no seed job (start failed), ineligible source, outside the window, cancelled audit, existing record, disabled', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    await seed({ withJob: false });
    await seed({ source: 'weekly_recheck' });
    await seed({ minutesAgo: 60 * 5 });
    await seed({ crawl_status: 'cancelled' });
    const done = await seed();
    await ChatGptVisibilityRun.create({ projectId: done.project._id, userId: done.userId, auditRunId: done.runId, trigger: { source: 'audit' }, status: 'completed' });
    assert.equal(await repair(), 0);
    assert.equal(await ChatGptVisibilityRun.countDocuments({}), 1);
    await seed();
    assert.equal(await repairMissingRuns({ config: getChatGptConfig({}) }), 0);
  });
});

describe('startProjectAudit integration (real database, mocked providers)', () => {
  async function makeAuditProject() {
    const userId = oid();
    await User.collection.insertOne({ _id: userId, firstName: 'Vis', lastName: 'Tester', email: `vis-${userId}@example.test`, roleId: 2, subscription: { plan: 'starter', status: 'active', credits: { limit: 1, used: 1 }, pages: { limit: 100, used: 0 }, recrawls: { limit: 3, used: 0 } } });
    const project = await SeoProject.create({
      user_id: userId, project_name: 'Smile Clinic', main_url: 'https://smile.example', canonical_host: 'smile.example', keywords: ['dentist'],
      seo_scope: 'national', country: 'IN', industry: 'Dental care', business_name: 'Dental Smile Clinic', language: 'en',
    });
    return { userId, project };
  }
  const stubDispatcher = () => { for (const m of ['queueLinkDiscoveryJob', 'queueDomainPerformanceJob', 'dispatchTechnicalDomainJob']) mock.method(JobDispatcher.prototype, m, async () => {}); };

  test('flags off: the audit starts exactly as before and no visibility record exists', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    stubDispatcher();
    const { userId, project } = await makeAuditProject();
    const result = await startProjectAudit(String(project._id), { source: 'manual', requestingUserId: userId });
    assert.equal(result.code, AUDIT_RESULT_CODES.STARTED);
    assert.equal(result.data.jobs.length, 3);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(await ChatGptVisibilityRun.countDocuments({}), 0);
  });

  test('flags on: the audit is accepted, a run is recorded for ITS run id and completes in the background', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    stubDispatcher();
    const http = mockProviderHttp();
    process.env.CHATGPT_VISIBILITY_ENABLED = 'true'; process.env.CHATGPT_VISIBILITY_AUTO_RUN = 'true'; process.env.CHATGPT_VISIBILITY_COOLDOWN_MS = '0';
    const { userId, project } = await makeAuditProject();
    const result = await startProjectAudit(String(project._id), { source: 'manual', requestingUserId: userId });
    assert.equal(result.code, AUDIT_RESULT_CODES.STARTED);
    assert.equal(result.data.run_source, 'initial_audit');
    assert.equal(result.data.jobs.length, 3);
    const auditRunId = (await SeoProject.findById(project._id).lean()).current_run_id;

    const run = await waitFor(async () => {
      const r = await ChatGptVisibilityRun.findOne({ projectId: project._id }).lean();
      return r && ['completed', 'partial', 'failed'].includes(r.status) ? r : null;
    });
    assert.equal(String(run.auditRunId), String(auditRunId));
    assert.equal(run.status, 'completed');
    assert.equal(run.executions.length, 5);
    assert.equal(http.mock.callCount(), 5);
    const bodies = http.mock.calls.map((c) => c.arguments[1][0]);
    assert.ok(bodies.every((b) => b.web_search_country_iso_code === 'IN' && b.model_name === 'gpt-4o-mini' && !('web_search_city' in b) && b.user_prompt.length > 20));
    assert.ok(bodies.some((b) => b.user_prompt.includes('Dental Smile Clinic'))); // the branded prompts
    assert.equal(run.promptGeneratedBy, 'template');
    assert.equal(run.metrics.overall.brandMentionRate, 1);
    assert.equal(run.metrics.overall.uniqueCitedPages, 1);
    assert.equal(run.target.nameVerified, false); // customer-typed, not Places-verified
    // the SEO side is untouched by the feature: it still has its three seed jobs, in its own state
    assert.equal(await Job.countDocuments({ project_id: project._id }), 3);

    // a second start while the audit is running is rejected by the SEO guard and creates nothing
    const dup = await startProjectAudit(String(project._id), { source: 'manual', requestingUserId: userId });
    assert.equal(dup.code, AUDIT_RESULT_CODES.ALREADY_RUNNING);
    assert.equal(await ChatGptVisibilityRun.countDocuments({ projectId: project._id }), 1);
  });

  test('rejected starts (not found, wrong owner) never create a visibility run', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    stubDispatcher();
    mockProviderHttp();
    process.env.CHATGPT_VISIBILITY_ENABLED = 'true'; process.env.CHATGPT_VISIBILITY_AUTO_RUN = 'true';
    const { project } = await makeAuditProject();
    assert.equal((await startProjectAudit(String(project._id), { source: 'manual', requestingUserId: oid() })).code, AUDIT_RESULT_CODES.ACCESS_DENIED);
    assert.equal((await startProjectAudit(String(oid()), { source: 'manual', requestingUserId: oid() })).code, AUDIT_RESULT_CODES.NOT_FOUND);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(await ChatGptVisibilityRun.countDocuments({}), 0);
  });

  test('a visibility-store failure does not fail or alter the audit start', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    stubDispatcher();
    mockProviderHttp();
    process.env.CHATGPT_VISIBILITY_ENABLED = 'true'; process.env.CHATGPT_VISIBILITY_AUTO_RUN = 'true';
    mock.method(ChatGptVisibilityRun, 'create', async () => { throw new Error('visibility store down'); });
    const { userId, project } = await makeAuditProject();
    const result = await startProjectAudit(String(project._id), { source: 'manual', requestingUserId: userId });
    assert.equal(result.success, true);
    assert.equal(result.code, AUDIT_RESULT_CODES.STARTED);
    assert.equal(result.data.jobs.length, 3);
    assert.equal((await SeoProject.findById(project._id).lean()).crawl_status !== 'cancelled', true);
  });

  test('cancelling the SEO audit does not cancel the visibility run', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../../../app_user/controller/scrapingController.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /chatgpt|visibility_runs/i); // cancelAudit only touches `jobs` (project_id) and crawl_status
    const { project } = await makeAuditProject();
    const run = (await ChatGptVisibilityRun.create({ projectId: project._id, userId: project.user_id, auditRunId: oid(), trigger: { source: 'audit' }, status: 'queued' })).toObject();
    await SeoProject.findByIdAndUpdate(project._id, { status: 'draft', crawl_status: 'cancelled' }); // what cancelAudit writes
    await Job.updateMany({ project_id: project._id }, { $set: { status: 'failed' } });
    assert.equal((await ChatGptVisibilityRun.findById(run._id).lean()).status, 'queued');
  });
});

describe('API handlers: ownership, scoping and DTOs', () => {
  const res = () => {
    const r = { statusCode: 200, body: null, status(c) { r.statusCode = c; return r; }, json(b) { r.body = b; return r; } };
    return r;
  };
  const reqFor = (project, extra = {}) => ({ project, params: {}, query: {}, ...extra });

  async function twoProjects() {
    const a = await SeoProject.create({ user_id: oid(), project_name: 'Owner A', main_url: 'https://a.example', keywords: ['k'], seo_scope: 'national', industry: 'Dental care' });
    const b = await SeoProject.create({ user_id: oid(), project_name: 'Owner B', main_url: 'https://b.example', keywords: ['k'], seo_scope: 'national', industry: 'Dental care' });
    return { a, b };
  }
  const finishedRun = (project, over = {}) => ChatGptVisibilityRun.create({
    projectId: project._id, userId: project.user_id, auditRunId: oid(), trigger: { source: 'audit' }, status: 'completed', lockedBy: 'secret-worker-id', 'lease': { expiresAt: new Date() },
    executions: [{ category: 'industry_discovery', branded: false, promptText: 'Which dentists?', status: 'succeeded', answerText: 'Answer text', providerRequestId: 'internal-task-id', cost: 0.01, annotations: [{ title: 't', url: 'https://a.example/x' }], analysis: { brandMentioned: false, brandMentionCount: 0, targetCitationCount: 1, targetPages: ['https://a.example/x'], competitorMentions: [], citations: [] } }],
    metrics: { overall: { executionSuccessRate: 1 } }, ...over,
  });

  test('a run id from another project is "not found" for detail and cancel (no cross-project read or cancel)', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { a, b } = await twoProjects();
    const runA = await finishedRun(a);
    const detailOwn = res(); await controller.getRunDetail(reqFor(a, { params: { runId: String(runA._id) } }), detailOwn);
    assert.equal(detailOwn.statusCode, 200);
    const detailOther = res(); await controller.getRunDetail(reqFor(b, { params: { runId: String(runA._id) } }), detailOther);
    assert.equal(detailOther.statusCode, 404);
    const queuedA = await ChatGptVisibilityRun.create({ projectId: a._id, userId: a.user_id, auditRunId: oid(), trigger: { source: 'audit' }, status: 'queued' });
    const cancelOther = res(); await controller.cancelRun(reqFor(b, { params: { runId: String(queuedA._id) } }), cancelOther);
    assert.equal(cancelOther.statusCode, 404);
    assert.equal((await ChatGptVisibilityRun.findById(queuedA._id).lean()).status, 'queued');
    const bad = res(); await controller.getRunDetail(reqFor(a, { params: { runId: 'not-an-id' } }), bad);
    assert.equal(bad.statusCode, 404);
  });

  test('DTOs never expose lease, worker identity or provider request ids; history and summary carry no answers', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { a } = await twoProjects();
    const run = await finishedRun(a);
    const detail = res(); await controller.getRunDetail(reqFor(a, { params: { runId: String(run._id) } }), detail);
    const dump = JSON.stringify(detail.body);
    assert.ok(dump.includes('Answer text'));
    assert.ok(!/secret-worker-id|internal-task-id|lockedBy|lease|providerRequestId/.test(dump));
    const hist = res(); await controller.listRunHistory(reqFor(a), hist);
    assert.equal(hist.body.data.length, 1);
    assert.ok(!JSON.stringify(hist.body).includes('Answer text') && !/secret-worker-id/.test(JSON.stringify(hist.body)));
    const summary = res(); await controller.getSummary(reqFor(a), summary);
    assert.equal(summary.body.data.latest.id, String(run._id));
    assert.ok(!JSON.stringify(summary.body).includes('Answer text'));
  });

  test('history only lists the caller\'s project and pagination is bounded', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { a, b } = await twoProjects();
    await finishedRun(a); await finishedRun(b);
    const r = res(); await controller.listRunHistory(reqFor(a, { query: { limit: '9999', page: '-5' } }), r);
    assert.equal(r.body.meta.limit, 50);
    assert.equal(r.body.meta.page, 1);
    assert.equal(r.body.data.length, 1);
    assert.deepEqual(controller.parsePagination({ limit: 'abc', page: 'x' }), { page: 1, limit: 10, skip: 0 });
  });

  test('prompt sets are scoped to the project too', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { a, b } = await twoProjects();
    const set = await AiVisibilityPromptSet.create({ projectId: a._id, version: 1, profileHash: 'h', generatorVersion: '1.0.0', inputSnapshot: {}, generatedBy: 'template', prompts: ['industry_discovery', 'service_discovery', 'brand_recognition', 'competitor_comparison', 'local_market_intent'].map((category) => ({ category, text: 'x'.repeat(30), branded: false, usesService: false, usesCompetitors: false })) });
    const own = res(); await controller.getProjectPromptSet(reqFor(a, { params: { setId: String(set._id) } }), own);
    assert.equal(own.statusCode, 200);
    assert.equal(own.body.data.prompts.length, 5);
    const other = res(); await controller.getProjectPromptSet(reqFor(b, { params: { setId: String(set._id) } }), other);
    assert.equal(other.statusCode, 404);
    const list = res(); await controller.listProjectPromptSets(reqFor(b), list);
    assert.equal(list.body.data.length, 0);
  });

  test('manual start: disabled -> 503; limits -> 429; success -> 202 queued; second while active -> 409', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    mockProviderHttp();
    const { a } = await twoProjects();
    const disabled = res(); await controller.startRun(reqFor(a), disabled);
    assert.equal(disabled.statusCode, 503);

    process.env.CHATGPT_VISIBILITY_ENABLED = 'true'; process.env.CHATGPT_VISIBILITY_COOLDOWN_MS = '0';
    const ok = res(); await controller.startRun(reqFor(a), ok);
    assert.equal(ok.statusCode, 202);
    assert.ok(['queued', 'running'].includes(ok.body.data.status));
    assert.equal(ok.body.data.trigger.source, 'manual');
    const again = res(); await controller.startRun(reqFor(a), again);
    assert.equal(again.statusCode, 409);
    await waitFor(async () => (await ChatGptVisibilityRun.findOne({ projectId: a._id, status: { $in: ['completed', 'partial', 'failed'] } }).lean()));

    process.env.CHATGPT_VISIBILITY_MAX_RUNS_PER_PROJECT = '1';
    const limited = res(); await controller.startRun(reqFor(a), limited);
    assert.equal(limited.statusCode, 429);
    delete process.env.CHATGPT_VISIBILITY_MAX_RUNS_PER_PROJECT;
  });

  test('client input cannot influence the run: the manual start ignores the body entirely', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    mockProviderHttp();
    process.env.CHATGPT_VISIBILITY_ENABLED = 'true'; process.env.CHATGPT_VISIBILITY_COOLDOWN_MS = '0';
    const { a } = await twoProjects();
    const r = res();
    await controller.startRun(reqFor(a, { body: { model_name: 'gpt-5-expensive', prompts: ['free-form'], web_search: false, projectId: String(oid()) } }), r);
    assert.equal(r.statusCode, 202);
    const run = await waitFor(async () => (await ChatGptVisibilityRun.findOne({ projectId: a._id, status: { $in: ['completed', 'partial', 'failed'] } }).lean()));
    assert.equal(String(run.projectId), String(a._id));
    assert.ok(run.executions.every((e) => e.model === 'gpt-4o-mini' && e.webSearch === true && !e.promptText.includes('free-form')));
  });

  test('startManualRun reports a disabled feature without touching the database', async () => {
    const r = await startManualRun({ projectId: oid(), userId: oid() }, { config: getChatGptConfig({}) });
    assert.equal(r.reason, 'DISABLED');
  });
});
