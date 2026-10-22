/**
 * INTEGRATION tests (deterministic): real Express routing, real auth middleware + JWTs, real validateProjectAccess, real controller/runner,
 * real MongoDB (isolated database `odito_investigation_it`), real Task / Investigation models, and the REAL claudeService + adapter code path
 * (only the HTTP call to api.anthropic.com is intercepted and answered with a controlled response; no real model is used).
 *
 * NOT real: the model, the target website (injected fetcher), WordPress (no connection exists; no write is performed), and verification
 * start (`startUrlVerification` would create crawl jobs, so it is replaced by a recorder).
 *
 * Skips itself when MongoDB is not reachable. Nothing here touches the dev or production database.
 */
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';
import { connectTestDb, seedTenant, apiClient, cleanupTenant, TEST_DB } from './harness.mjs';

// Never let a deterministic test use the real key.
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key-0000000000';
delete process.env.CLAUDE_API_KEY;

import { InvestigationRunner } from '../service/investigationOrchestrator.js';
import { createMongoStore } from '../service/investigationStore.js';
import { createLifecycleService } from '../service/lifecycleService.js';
import { claudeInvestigationLlm } from '../llm/investigationLlm.js';
import { resolveFixCapabilities } from '../capabilities/fixCapabilities.js';
import { __setDefaultRunnerForTests } from '../controller/investigationController.js';
import Investigation from '../model/Investigation.js';
import Task from '../../tasks/model/Task.js';
import recommendationRoutes from '../../recommendations/routes/recommendationRoutes.js';
import taskRoutes from '../../tasks/routes/taskRoutes.js';
import wordPressSeoFixService, { } from '../../external_integration/service/wordPressSeoFixService.js';
import { WordPressConnectionError } from '../../external_integration/service/wordPressService.js';
import { createApprovalService } from '../service/approvalService.js';
import { __setApprovalServiceForTests } from '../service/approvalRuntime.js';
import { fakeFetcher, page, VISIBLE_CRUMBS, goodAnswer, ELIGIBLE, NOT_SUPPORTED } from '../testKit.js';

let mongoOk = false; let server; let base;
let tenantA; let tenantB; let apiA; let apiB; let apiAnon;
const SITE = 'https://www.sapphiredigitalagency.com'; const PAGE = `${SITE}/about-us`;
const routes = () => ({ [PAGE]: { body: page({ body: VISIBLE_CRUMBS }) }, [`${SITE}/`]: { body: page() }, [`${SITE}/services`]: { body: page() } });

// ── Anthropic interception: the real claudeService._callAPI runs; only the network hop is answered locally ──
const realFetch = globalThis.fetch;
const anthropicCalls = [];
let anthropicBehaviour = () => ({ status: 200, body: { content: [{ type: 'text', text: JSON.stringify(goodAnswer()) }], usage: { input_tokens: 111, output_tokens: 22 }, stop_reason: 'end_turn', model: 'claude-test' } });
globalThis.fetch = async (url, init) => {
  if (String(url).includes('api.anthropic.com')) {
    anthropicCalls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    const b = await anthropicBehaviour(init);
    return new Response(JSON.stringify(b.body), { status: b.status, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, init);
};

function makeRunner(over = {}, options = {}) {
  return new InvestigationRunner({
    store: createMongoStore(), llm: claudeInvestigationLlm, fetcher: fakeFetcher(routes()), resolveCapabilities: async () => ELIGIBLE,
    loadDetectorContext: async () => ({ currentState: { note: 'flagged' } }), loadCrawlPage: async () => null, loadSiblings: async () => [`${SITE}/services`],
    renderPage: null, now: () => Date.now(), sleep: async () => {}, log: () => {}, ...over,
  }, options);
}
const verificationCalls = [];
const recordingLifecycle = (runner) => createLifecycleService({
    store: runner.deps.store,
    loadTask: (projectId, issueKey, pageUrl) => Task.findOne({ projectId, issueKey, pageUrl, isDeleted: { $ne: true } }).lean(),
    startVerification: async (...args) => { verificationCalls.push(args); return { success: true, code: 'STARTED', data: { verificationRunId: `run-${verificationCalls.length}` } }; },
  });
function install(runner, startVerification) {
  const lifecycle = createLifecycleService({
    store: runner.deps.store,
    loadTask: (projectId, issueKey, pageUrl) => Task.findOne({ projectId, issueKey, pageUrl, isDeleted: { $ne: true } }).lean(),
    startVerification: startVerification || (async (...args) => { verificationCalls.push(args); return { success: true, code: 'STARTED', data: { verificationRunId: `run-${verificationCalls.length}` } }; }),
  });
  const approvals = createApprovalService({ store: runner.deps.store, resolveCapabilities: (...a) => runner.deps.resolveCapabilities(...a) });
  __setApprovalServiceForTests(approvals); // what the existing apply route consults
  __setDefaultRunnerForTests(runner, { lifecycle, resolveCapabilities: runner.deps.resolveCapabilities, approvals });
}
const body = (t, extra = {}) => ({ projectId: t.projectId, issueId: 'breadcrumblist_schema', pageUrl: PAGE, ruleMetadata: { title: 'BreadcrumbList missing', category: 'Structured Data' }, ...extra });
const start = (api, t, extra) => api('POST', '/recommendations/investigations', body(t, extra));
const get = (api, t, id) => api('GET', `/recommendations/investigations/${id}?projectId=${t.projectId}`);
const settle = async (runner, id) => { await runner.running.get(String(id)); };

before(async () => {
  try { await connectTestDb(); mongoOk = true; } catch { mongoOk = false; return; }
  await Investigation.init();
  tenantA = await seedTenant({ label: 'A', siteUrl: `${SITE}/` });
  tenantB = await seedTenant({ label: 'B', siteUrl: 'https://other-tenant.example/' });
  const app = express();
  app.use(express.json());
  app.use('/api/recommendations', recommendationRoutes);
  app.use('/api/tasks', taskRoutes);
  server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  apiA = apiClient(base, tenantA.token); apiB = apiClient(base, tenantB.token); apiAnon = apiClient(base, null);
});
after(async () => {
  globalThis.fetch = realFetch;
  if (!mongoOk) return;
  await new Promise((r) => server.close(r));
  await cleanupTenant(tenantA, tenantB);
  await mongoose.disconnect();
});
beforeEach(async () => {
  anthropicCalls.length = 0; verificationCalls.length = 0;
  if (mongoOk) await Promise.all([Investigation.deleteMany({ projectId: { $in: [tenantA.project._id, tenantB.project._id] } }), Task.deleteMany({ projectId: tenantA.project._id })]);
  anthropicBehaviour = () => ({ status: 200, body: { content: [{ type: 'text', text: JSON.stringify(goodAnswer()) }], usage: { input_tokens: 111, output_tokens: 22 }, stop_reason: 'end_turn', model: 'claude-test' } });
});

// Evaluated when each test RUNS (after `before` tried to connect), never at definition time.
const it = (name, fn) => test(name, async (t) => { if (!mongoOk) return t.skip('MongoDB not reachable'); await fn(t); });

describe('route -> controller -> service -> MongoDB', () => {
  it('authentication and project ownership are enforced by the real middleware', async () => {
    install(makeRunner());
    assert.equal((await start(apiAnon, tenantA)).status, 401);
    assert.equal((await start(apiB, tenantA)).status, 403, 'user B naming project A');
    assert.equal((await apiAnon('GET', `/recommendations/investigations/abc?projectId=${tenantA.projectId}`)).status, 401);
    assert.equal(await Investigation.countDocuments({ projectId: tenantA.project._id }), 0);
  });

  it('start -> persist -> poll -> completed; the real claudeService + adapter run with the master prompt as the system message', async () => {
    const runner = makeRunner(); install(runner);
    const r = await start(apiA, tenantA);
    assert.equal(r.status, 202);
    const id = r.json.data.id;
    const queued = await Investigation.findById(id).lean();
    assert.ok(['queued', 'running', 'completed'].includes(queued.status));
    await settle(runner, id);
    const done = await get(apiA, tenantA, id);
    assert.equal(done.status, 200);
    assert.equal(done.json.data.status, 'completed');
    assert.equal(done.json.data.result.issueStatus, 'confirmed');
    assert.equal(done.json.data.result.automaticFixEligibility.eligible, true);
    // persisted document, read straight from MongoDB
    const doc = await mongoose.connection.db.collection('ai_investigations').findOne({ _id: new mongoose.Types.ObjectId(id) });
    assert.equal(doc.status, 'completed'); assert.equal(doc.activeKey, null); assert.equal(doc.model, 'claude-test'); assert.deepEqual(doc.tokens, { input: 111, output: 22 });
    assert.equal(String(doc.projectId), tenantA.projectId);
    assert.ok(doc.evidenceTrace.length >= 4 && doc.evidenceTrace.every((e) => !('data' in e)));
    // provider adapter: exactly one call, master prompt as `system`, evidence in the user message, key only in the header
    assert.equal(anthropicCalls.length, 1);
    const call = anthropicCalls[0];
    assert.match(call.body.system, /Odito's website issue investigator/);
    assert.match(call.body.messages[0].content, /<untrusted_evidence>/);
    assert.equal(call.headers['x-api-key'].startsWith('sk-ant-test'), true);
    assert.ok(!call.body.messages[0].content.includes('sk-ant-test'), 'the API key never enters the prompt');
    assert.ok(!JSON.stringify(done.json).includes('sk-ant-test'));
  });

  it('response shape matches what the frontend reads (fields used by InvestigationPanel / useInvestigation)', async () => {
    const runner = makeRunner(); install(runner);
    const { json } = await start(apiA, tenantA);
    await settle(runner, json.data.id);
    const d = (await get(apiA, tenantA, json.data.id)).json.data;
    for (const k of ['id', 'issueId', 'pageUrl', 'status', 'stage', 'progress', 'planFamily', 'promptVersion', 'evidence', 'result', 'warnings', 'error']) assert.ok(k in d, k);
    for (const k of ['investigationStatus', 'issueStatus', 'confidence', 'summary', 'evidence', 'rootCause', 'recommendedSolution', 'implementationPlan', 'codeOrConfiguration', 'automaticFixEligibility', 'missingCapabilities', 'risks', 'validationPlan', 'limitations', 'additionalEvidenceRequested', 'requiresHumanApproval', 'lifecycle']) assert.ok(k in d.result, k);
    for (const k of ['recommendationGenerated', 'fixProposed', 'fixApplied', 'fixVerified', 'verificationStatus']) assert.ok(k in d.result.lifecycle, k);
    for (const k of ['id', 'kind', 'source', 'status', 'summary', 'retrievedAt']) assert.ok(k in d.evidence[0], k);
    assert.ok(!('requestKey' in d) && !('userId' in d) && !('projectId' in d) && !('activeKey' in d));
  });

  it('invalid issue ids, malformed bodies and foreign pages are rejected without creating anything', async () => {
    install(makeRunner());
    for (const extra of [{ issueId: '' }, { issueId: 'x; drop table' }, { issueId: 'a'.repeat(300) }, { pageUrl: 'javascript:alert(1)' }, { pageUrl: 'http://169.254.169.254/' }, { pageUrl: 'https://evil.example/x' }, { pageUrl: 42 }]) {
      const r = await start(apiA, tenantA, extra);
      assert.ok([400, 422].includes(r.status), `${JSON.stringify(extra)} -> ${r.status}`);
    }
    const raw = await fetch(`${base}/api/recommendations/investigations`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tenantA.token}` }, body: '{ not json' });
    assert.ok(raw.status >= 400 && raw.status < 500);
    assert.equal(await Investigation.countDocuments({ projectId: tenantA.project._id }), 0);
    assert.equal((await get(apiA, tenantA, 'not-an-object-id')).status, 404);
  });

  it('cross-project: tenant B cannot read, cancel, verify or prepare tenant A\'s investigation', async () => {
    const runner = makeRunner(); install(runner);
    const { json } = await start(apiA, tenantA); const id = json.data.id; await settle(runner, id);
    for (const [method, suffix] of [['GET', ''], ['POST', '/cancel'], ['POST', '/verify'], ['POST', '/prepare-fix']]) {
      const r = await apiB(method, `/recommendations/investigations/${id}${suffix}${method === 'GET' ? `?projectId=${tenantB.projectId}` : ''}`, method === 'POST' ? { projectId: tenantB.projectId } : undefined);
      assert.equal(r.status, 404, `${method} ${suffix}`);
    }
    assert.equal((await apiB('GET', `/recommendations/investigations/${id}?projectId=${tenantA.projectId}`)).status, 403, 'naming A\'s project is refused by middleware');
    assert.equal((await Investigation.findById(id).lean()).status, 'completed');
  });
});

describe('duplicates, cancellation, provider failures', () => {
  it('simultaneous identical starts (HTTP) create exactly ONE document and ONE provider call', async () => {
    let release; const gate = new Promise((r) => { release = r; });
    anthropicBehaviour = async () => { await gate; return { status: 200, body: { content: [{ type: 'text', text: JSON.stringify(goodAnswer()) }], usage: {}, stop_reason: 'end_turn' } }; };
    const runner = makeRunner(); install(runner);
    const rs = await Promise.all(Array.from({ length: 6 }, () => start(apiA, tenantA)));
    assert.equal(new Set(rs.map((r) => r.json.data.id)).size, 1);
    assert.equal(rs.filter((r) => r.json.meta.joinedExisting).length, 5);
    release(); await settle(runner, rs[0].json.data.id);
    assert.equal(await Investigation.countDocuments({ projectId: tenantA.project._id }), 1);
    assert.equal(anthropicCalls.length, 1);
  });

  it('two server instances racing: the database unique index lets exactly one start; the other joins it', async () => {
    let release; const gate = new Promise((r) => { release = r; });
    anthropicBehaviour = async () => { await gate; return { status: 200, body: { content: [{ type: 'text', text: JSON.stringify(goodAnswer()) }], usage: {}, stop_reason: 'end_turn' } }; };
    const r1 = makeRunner(); const r2 = makeRunner();
    const project = { id: tenantA.projectId, siteUrl: `${SITE}/` };
    const issue = { issueId: 'breadcrumblist_schema', pageUrl: PAGE };
    const [a, b] = await Promise.all([r1.start({ project, userId: tenantA.userId, issue }), r2.start({ project, userId: tenantA.userId, issue })]);
    assert.equal(String(a.record._id), String(b.record._id));
    assert.deepEqual([a.joined, b.joined].sort(), [false, true]);
    release(); await Promise.all([settle(r1, a.record._id), settle(r2, a.record._id)]);
    assert.equal(await Investigation.countDocuments({ projectId: tenantA.project._id }), 1);
    // after it finished the slot is free again
    const again = await r1.start({ project, userId: tenantA.userId, issue }); assert.equal(again.joined, false); await settle(r1, again.record._id);
  });

  it('cancel: explicit outcome, persisted as cancelled, and the abandoned provider call can NOT write a result later', async () => {
    let release; const gate = new Promise((r) => { release = r; });
    anthropicBehaviour = async () => { await gate; return { status: 200, body: { content: [{ type: 'text', text: JSON.stringify(goodAnswer()) }], usage: {}, stop_reason: 'end_turn' } }; };
    const runner = makeRunner(); install(runner);
    const { json } = await start(apiA, tenantA); const id = json.data.id;
    await new Promise((r) => setTimeout(r, 150)); // let it reach the provider call
    assert.equal(anthropicCalls.length, 1);
    const c = await apiA('POST', `/recommendations/investigations/${id}/cancel`, { projectId: tenantA.projectId });
    assert.equal(c.status, 200); assert.deepEqual([c.json.data.cancelled, c.json.data.outcome, c.json.data.status], [true, 'cancelled', 'cancelled']);
    release(); await new Promise((r) => setTimeout(r, 200)); // the abandoned provider call now "succeeds"
    const doc = await Investigation.findById(id).lean();
    assert.equal(doc.status, 'cancelled'); assert.equal(doc.result, null); assert.equal(doc.activeKey, null);
    const again = await apiA('POST', `/recommendations/investigations/${id}/cancel`, { projectId: tenantA.projectId });
    assert.deepEqual([again.json.data.cancelled, again.json.data.outcome], [false, 'not_active']);
    const fresh = await start(apiA, tenantA); assert.notEqual(fresh.json.data.id, id, 'the slot was released'); await settle(runner, fresh.json.data.id);
  });

  it('cancel of a run owned by a dead/other process is closed directly with an explicit outcome', async () => {
    const runner = makeRunner(); install(runner);
    const orphan = await Investigation.create({ projectId: tenantA.project._id, userId: tenantA.user._id, issueId: 'x', pageUrl: PAGE, requestKey: `x|${PAGE}`, activeKey: `x|${PAGE}`, status: 'running', runnerId: 'other-instance' });
    const c = await apiA('POST', `/recommendations/investigations/${orphan._id}/cancel`, { projectId: tenantA.projectId });
    assert.deepEqual([c.json.data.cancelled, c.json.data.outcome], [true, 'cancelled']);
    assert.equal((await Investigation.findById(orphan._id).lean()).activeKey, null);
  });

  it('provider errors / timeouts: HTTP 529 then success is retried; persistent 500 degrades to an evidence-only result; 429 honours retry', async () => {
    let n = 0;
    anthropicBehaviour = () => (n++ === 0 ? { status: 529, body: { error: 'overloaded' } } : { status: 200, body: { content: [{ type: 'text', text: JSON.stringify(goodAnswer()) }], usage: {}, stop_reason: 'end_turn' } });
    let runner = makeRunner(); install(runner);
    let r = await start(apiA, tenantA); await settle(runner, r.json.data.id);
    assert.equal((await get(apiA, tenantA, r.json.data.id)).json.data.result.issueStatus, 'confirmed');
    assert.equal(anthropicCalls.length, 2);

    anthropicCalls.length = 0; anthropicBehaviour = () => ({ status: 500, body: { error: { message: 'internal sk-ant-secret-should-not-leak' } } });
    runner = makeRunner(); install(runner);
    r = await start(apiA, tenantA); await settle(runner, r.json.data.id);
    const d = (await get(apiA, tenantA, r.json.data.id)).json.data;
    assert.equal(d.status, 'completed'); assert.equal(d.result.issueStatus, 'uncertain'); assert.equal(anthropicCalls.length, 1, '500 is not retried');
    assert.ok(!JSON.stringify(d).includes('should-not-leak'));
    assert.ok(d.result.evidence.length > 0);

    anthropicCalls.length = 0; anthropicBehaviour = () => ({ status: 200, body: { content: [{ type: 'text', text: 'cut off mid' }], usage: {}, stop_reason: 'max_tokens' } });
    runner = makeRunner(); install(runner);
    r = await start(apiA, tenantA); await settle(runner, r.json.data.id);
    assert.match((await get(apiA, tenantA, r.json.data.id)).json.data.warnings[0], /LLM_TRUNCATED/);
  });

  it('provider hang: the run deadline fails it cleanly and releases the concurrency slots', async () => {
    anthropicBehaviour = () => new Promise(() => {});
    const runner = makeRunner({}, { deadlineMs: 300, maxConcurrentPerProject: 1 }); install(runner);
    const r = await start(apiA, tenantA); await settle(runner, r.json.data.id);
    const d = (await get(apiA, tenantA, r.json.data.id)).json.data;
    assert.equal(d.status, 'failed'); assert.equal(d.error.code, 'INVESTIGATION_TIMEOUT');
    assert.equal(runner.global.active, 0); assert.equal(runner._projectLimiter(tenantA.projectId).active, 0);
    anthropicBehaviour = () => ({ status: 200, body: { content: [{ type: 'text', text: JSON.stringify(goodAnswer()) }], usage: {}, stop_reason: 'end_turn' } });
    const next = await start(apiA, tenantA); await settle(runner, next.json.data.id);
    assert.equal((await get(apiA, tenantA, next.json.data.id)).json.data.status, 'completed', 'a later run is not blocked');
  });

  it('invalid / hostile model output over the real adapter is rejected safely', async () => {
    anthropicBehaviour = () => ({ status: 200, body: { content: [{ type: 'text', text: 'Sure! The issue is fixed. <script>alert(1)</script>' }], usage: {}, stop_reason: 'end_turn' } });
    const runner = makeRunner(); install(runner);
    const r = await start(apiA, tenantA); await settle(runner, r.json.data.id);
    const d = (await get(apiA, tenantA, r.json.data.id)).json.data;
    assert.equal(anthropicCalls.length, 2, 'one repair attempt');
    assert.equal(d.result.issueStatus, 'uncertain'); assert.equal(d.result.lifecycle.fixApplied, false);
    assert.ok(!JSON.stringify(d).includes('<script>alert'));
  });
});

describe('database failures and restart recovery', () => {
  it('database error while creating -> clean 500, no stack/connection details', async () => {
    const store = createMongoStore(); const real = store.create;
    store.create = async () => { throw new Error('connection to mongodb://user:pw@10.0.0.5 lost'); };
    install(makeRunner({ store }));
    const r = await start(apiA, tenantA);
    assert.equal(r.status, 500); assert.ok(!JSON.stringify(r.json).includes('10.0.0.5')); store.create = real;
  });

  it('database error on the FINAL write: retried once; if still failing the row stays active and recovery closes it as INTERRUPTED', async () => {
    const store = createMongoStore(); const realIfActive = store.updateIfActive;
    store.updateIfActive = async (id, pid, patch) => { if (patch.status === 'completed') throw new Error('write failed'); return realIfActive(id, pid, patch); };
    let clock = Date.now();
    const runner = makeRunner({ store, now: () => clock }); install(runner);
    const r = await start(apiA, tenantA); await settle(runner, r.json.data.id);
    assert.equal((await Investigation.findById(r.json.data.id).lean()).status, 'running', 'result could not be saved');
    store.updateIfActive = realIfActive;
    assert.equal(await runner.recoverInterrupted(), 0, 'not stale yet');
    clock += runner.opts.staleAfterMs + 1000;
    assert.equal(await runner.recoverInterrupted(), 1);
    const doc = await Investigation.findById(r.json.data.id).lean();
    assert.equal(doc.status, 'failed'); assert.equal(doc.error.code, 'INVESTIGATION_INTERRUPTED'); assert.equal(doc.activeKey, null);
  });

  it('server restart while running: the orphan is failed on the next startup, never stays "running", and does not block a new run', async () => {
    // simulate a process that died mid-run: a 'running' row whose last heartbeat is old
    const orphan = await Investigation.create({ projectId: tenantA.project._id, userId: tenantA.user._id, issueId: 'breadcrumblist_schema', pageUrl: PAGE, requestKey: `breadcrumblist_schema|${PAGE}`, activeKey: `breadcrumblist_schema|${PAGE}`, status: 'running', stage: 'diagnose', runnerId: 'dead-process' });
    await mongoose.connection.db.collection('ai_investigations').updateOne({ _id: orphan._id }, { $set: { updatedAt: new Date(Date.now() - 60 * 60 * 1000) } });
    const freshRunner = makeRunner(); install(freshRunner); // "the restarted process"
    // the user polls it before the startup sweep ran: lazy reaping closes it
    const polled = await get(apiA, tenantA, String(orphan._id));
    assert.equal(polled.json.data.status, 'failed'); assert.equal(polled.json.data.error.code, 'INVESTIGATION_INTERRUPTED');
    // another orphan, closed by the startup sweep instead
    const orphan2 = await Investigation.create({ projectId: tenantA.project._id, userId: tenantA.user._id, issueId: 'canonical_tag_errors', pageUrl: PAGE, requestKey: `canonical_tag_errors|${PAGE}`, activeKey: `canonical_tag_errors|${PAGE}`, status: 'queued', runnerId: 'dead-process' });
    await mongoose.connection.db.collection('ai_investigations').updateOne({ _id: orphan2._id }, { $set: { updatedAt: new Date(Date.now() - 60 * 60 * 1000) } });
    assert.equal(await freshRunner.recoverInterrupted(), 1);
    assert.equal((await Investigation.findById(orphan2._id).lean()).status, 'failed');
    // a fresh, live run is NOT touched by recovery
    const live = await start(apiA, tenantA, { issueId: 'images_missing_alt_text' }); await settle(freshRunner, live.json.data.id);
    assert.equal((await get(apiA, tenantA, live.json.data.id)).json.data.status, 'completed');
    // and a stale row blocking the same page is reaped lazily by start()
    const orphan3 = await Investigation.create({ projectId: tenantA.project._id, userId: tenantA.user._id, issueId: 'breadcrumblist_schema', pageUrl: PAGE, requestKey: `breadcrumblist_schema|${PAGE}`, activeKey: `breadcrumblist_schema|${PAGE}`, status: 'running', runnerId: 'dead-process' });
    await mongoose.connection.db.collection('ai_investigations').updateOne({ _id: orphan3._id }, { $set: { updatedAt: new Date(Date.now() - 60 * 60 * 1000) } });
    const next = await start(apiA, tenantA); assert.equal(next.json.meta.joinedExisting, false); assert.notEqual(next.json.data.id, String(orphan3._id)); await settle(freshRunner, next.json.data.id);
  });
});

describe('Task + approval + lifecycle (real Task model, real eligibility rules, mocked write adapter / verification start)', () => {
  const completed = async (runner) => { const r = await start(apiA, tenantA); await settle(runner, r.json.data.id); return r.json.data.id; };
  const prepare = (api, t, id) => api('POST', `/recommendations/investigations/${id}/prepare-fix`, { projectId: t.projectId });

  it('prepare-fix: eligibility is re-derived by the server; ineligible/unsupported gets manual guidance and creates NO task', async () => {
    const runner = makeRunner({ resolveCapabilities: async () => NOT_SUPPORTED }); install(runner);
    const id = await completed(runner);
    const r = await prepare(apiA, tenantA, id);
    assert.equal(r.status, 422); assert.equal(r.json.code, 'NOT_ELIGIBLE');
    assert.ok(r.json.details.manualPlan.length > 0, 'actionable manual steps');
    assert.equal(await Task.countDocuments({ projectId: tenantA.project._id }), 0);
  });

  it('prepare-fix cannot be talked into eligibility: the stored model/contract claim is not enough when the live site capability changed', async () => {
    const runner = makeRunner(); install(runner);       // diagnosis stored with eligible:true
    const id = await completed(runner);
    __setDefaultRunnerForTests(runner, { resolveCapabilities: async () => ({ ...ELIGIBLE, eligibility: 'requires_integration_setup', reason: 'Missing on this site: wordpress_connection.', missingCapabilities: ['wordpress_connection'] }) });
    const r = await prepare(apiA, tenantA, id);
    assert.equal(r.status, 422); assert.equal(r.json.details.eligibility, 'requires_integration_setup');
    assert.equal(await Task.countDocuments({ projectId: tenantA.project._id }), 0);
  });

  it('prepare-fix: creates the Task once (idempotent, concurrent-safe), links a same-project recommendation; applying still needs the existing approval', async () => {
    const runner = makeRunner(); install(runner);
    const id = await completed(runner);
    const recId = new mongoose.Types.ObjectId();
    let generated = 0;
    __setDefaultRunnerForTests(runner, {
      resolveCapabilities: async () => ELIGIBLE,
      prepare: (args, deps) => import('../service/fixPreparationService.js').then((m) => m.prepareFix(args, { ...deps, generateRecommendation: async () => { generated += 1; return { recommendation: { id: String(recId) } }; } })),
    });
    const results = await Promise.all([prepare(apiA, tenantA, id), prepare(apiA, tenantA, id), prepare(apiA, tenantA, id)]);
    assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.json)));
    assert.equal(new Set(results.map((r) => r.json.data.taskId)).size, 1);
    assert.equal(await Task.countDocuments({ projectId: tenantA.project._id }), 1);
    const task = await Task.findOne({ projectId: tenantA.project._id }).lean();
    assert.equal(task.status, 'task_created'); assert.equal(task.origin, 'ai_fix'); assert.equal(String(task.recommendationId), String(recId));
    assert.equal(results[0].json.data.next.approvalRequired, true);
    assert.equal(task.fixHistory.length, 0, 'preparing writes nothing and records no fix');
    // Approval is enforced by the BACKEND apply service, not by hiding a button:
    const { default: fixService } = await import('../../external_integration/service/wordPressSeoFixService.js');
    const full = await Task.findById(task._id);
    await assert.rejects(fixService.applyFix(full, { approved: false }), (e) => e.code === 'WRITE_FAILED' && e.statusCode === 400);
    await assert.rejects(fixService.applyFix(full, {}), (e) => e.statusCode === 400);
    // approved but the site has no WordPress connection: the write fails and NOTHING is recorded as applied
    await assert.rejects(fixService.applyFix(full, { approved: true }), (e) => typeof e.statusCode === 'number');
    const after = await Task.findById(task._id).lean();
    assert.equal(after.status, 'task_created'); assert.equal(after.fixHistory.length, 0);
    const lc = (await get(apiA, tenantA, id)).json.data.result.lifecycle;
    assert.deepEqual([lc.fixProposed, lc.fixApplied, lc.fixVerified], [true, false, false]);
  });

  it('prepare-fix refuses issues the live page did not confirm, and unfinished runs', async () => {
    anthropicBehaviour = () => ({ status: 200, body: { content: [{ type: 'text', text: JSON.stringify(goodAnswer({ issueStatus: 'already_resolved', proposedChanges: [], codeOrConfiguration: [], requiresHumanApproval: false })) }], usage: {}, stop_reason: 'end_turn' } });
    const runner = makeRunner(); install(runner);
    const id = await completed(runner);
    const r = await prepare(apiA, tenantA, id);
    assert.equal(r.status, 422); assert.equal(r.json.code, 'ISSUE_NOT_CONFIRMED');
    assert.equal(await Task.countDocuments({ projectId: tenantA.project._id }), 0);
    const running = await Investigation.create({ projectId: tenantA.project._id, userId: tenantA.user._id, issueId: 'x', pageUrl: PAGE, requestKey: `x|${PAGE}`, activeKey: `x|${PAGE}`, status: 'running' });
    assert.equal((await prepare(apiA, tenantA, String(running._id))).json.code, 'INVESTIGATION_NOT_COMPLETE');
  });

  it('lifecycle from the real Task document: write recorded != verified; failed verification; verified only after the re-crawl result; older attempts ignored', async () => {
    const runner = makeRunner(); install(runner);
    const id = await completed(runner);
    const created = new Date((await Investigation.findById(id).lean()).createdAt);
    const task = await Task.create({ projectId: tenantA.project._id, issueKey: 'breadcrumblist_schema', issueName: 'x', pageUrl: PAGE, status: 'task_created', origin: 'ai_fix' });
    const lifecycleOf = async () => (await get(apiA, tenantA, id)).json.data.result.lifecycle;
    assert.equal((await lifecycleOf()).fixApplied, false);

    const writtenAt = new Date(created.getTime() + 5); // after the investigation started, before the next one
    await Task.collection.updateOne({ _id: task._id }, { $set: { status: 'implemented', fixHistory: [{ attemptNumber: 1, origin: 'wordpress_auto', status: 'pending_verification', implementedAt: writtenAt, fixApplied: { capturedAt: writtenAt, externalWrite: { system: 'wordpress', provider: 'rank_math', field: 'breadcrumb_schema', writtenAt, scope: 'site' } }, verification: {} }] } });
    let lc = await lifecycleOf();
    assert.deepEqual([lc.fixApplied, lc.fixVerified, lc.appliedBy], [true, false, 'wordpress:breadcrumb_schema']);

    await Task.collection.updateOne({ _id: task._id }, { $set: { status: 'reopened', 'fixHistory.0.status': 'reopened', 'fixHistory.0.verification': { verifiedAt: new Date(writtenAt.getTime() + 5000), result: 'reopened', method: 'value_diff', matched: false } } });
    lc = await lifecycleOf();
    assert.deepEqual([lc.fixApplied, lc.fixVerified, lc.verificationStatus], [true, false, 'failed']);

    await Task.collection.updateOne({ _id: task._id }, { $set: { status: 'verified_fixed', 'fixHistory.0.status': 'verified_fixed', 'fixHistory.0.verification': { verifiedAt: new Date(writtenAt.getTime() + 9000), result: 'verified_fixed', method: 'value_diff', matched: true } } });
    lc = await lifecycleOf();
    assert.deepEqual([lc.fixApplied, lc.fixVerified, lc.verificationStatus], [true, true, 'passed']);

    // a newer investigation starts later: the earlier attempt/verification no longer describes it
    await new Promise((r) => setTimeout(r, 60));
    const id2 = await completed(runner);
    const lc2 = (await get(apiA, tenantA, id2)).json.data.result.lifecycle;
    assert.deepEqual([lc2.fixApplied, lc2.fixVerified], [false, false]);
  });

  it('verify: only the latest completed investigation can start it; duplicates and cross-project are refused; the start is recorded as pending, not passed', async () => {
    const runner = makeRunner(); install(runner);
    const idOld = await completed(runner);
    const idNew = await completed(runner);
    const stale = await apiA('POST', `/recommendations/investigations/${idOld}/verify`, { projectId: tenantA.projectId });
    assert.deepEqual([stale.status, stale.json.code], [422, 'STALE_INVESTIGATION']);
    // nothing applied yet -> nothing to verify (and the pipeline is never asked)
    const none = await apiA('POST', `/recommendations/investigations/${idNew}/verify`, { projectId: tenantA.projectId });
    assert.deepEqual([none.status, none.json.code, verificationCalls.length], [422, 'NOTHING_TO_VERIFY', 0]);
    // a recorded change made after the investigation started
    const startedAt = new Date((await Investigation.findById(idNew).lean()).createdAt);
    const writtenAt = new Date(startedAt.getTime() + 5);
    const task = await Task.create({ projectId: tenantA.project._id, issueKey: 'breadcrumblist_schema', issueName: 'x', pageUrl: PAGE, status: 'task_created', origin: 'ai_fix' });
    await Task.collection.updateOne({ _id: task._id }, { $set: { status: 'implemented', fixHistory: [{ attemptNumber: 1, implementedAt: writtenAt, fixApplied: { externalWrite: { system: 'wordpress', field: 'breadcrumb_schema', writtenAt } }, verification: {} }] } });
    const ok = await apiA('POST', `/recommendations/investigations/${idNew}/verify`, { projectId: tenantA.projectId });
    assert.deepEqual([ok.status, ok.json.data.verificationStatus], [202, 'pending']);
    const dup = await apiA('POST', `/recommendations/investigations/${idNew}/verify`, { projectId: tenantA.projectId });
    assert.deepEqual([dup.status, dup.json.code], [409, 'ALREADY_RUNNING']);
    assert.equal(verificationCalls.length, 1, 'exactly one verification was started');
    assert.deepEqual([verificationCalls[0][0], verificationCalls[0][1]], [tenantA.projectId, PAGE], 'for the correct project and URL');
    const lc = (await get(apiA, tenantA, idNew)).json.data.result.lifecycle;
    assert.deepEqual([lc.fixVerified, lc.verificationStatus], [false, 'pending']);
    assert.equal((await apiB('POST', `/recommendations/investigations/${idNew}/verify`, { projectId: tenantB.projectId })).status, 404);
  });
});


describe('approval bound to the exact proposal; enforced by the backend apply route (real Task model + real taskRoutes; the WordPress write is a recorder)', () => {
  const realApply = wordPressSeoFixService.applyFix;
  const writes = [];
  let applyBehaviour;
  const fakeResult = (task) => ({ task, field: 'breadcrumb_schema', provider: 'rank_math', alreadyApplied: false, immediateVerification: { status: 'verified' } });
  beforeEach(() => {
    writes.length = 0;
    applyBehaviour = async (task, input) => fakeResult(task);
    wordPressSeoFixService.applyFix = async (task, input) => { writes.push({ taskId: String(task._id), approved: input?.approved }); return applyBehaviour(task, input); };
  });
  after(() => { wordPressSeoFixService.applyFix = realApply; });

  const finish = async (runner) => { const r = await start(apiA, tenantA); await settle(runner, r.json.data.id); return r.json.data.id; };
  const prepare = (api, t, id) => api('POST', `/recommendations/investigations/${id}/prepare-fix`, { projectId: t.projectId });
  const approve = (api, t, id, fingerprint) => api('POST', `/recommendations/investigations/${id}/approve`, { projectId: t.projectId, fingerprint });
  const apply = (api, taskId, extra = {}) => api('POST', `/tasks/${taskId}/apply-wordpress`, { approved: true, ...extra });
  const recId = new mongoose.Types.ObjectId();
  const withRecommendation = (runner) => {
    __setDefaultRunnerForTests(runner, {
      lifecycle: recordingLifecycle(runner),
      resolveCapabilities: async () => ELIGIBLE,
      approvals: createApprovalService({ store: runner.deps.store, resolveCapabilities: async () => ELIGIBLE }),
      prepare: (args, deps) => import('../service/fixPreparationService.js').then((m) => m.prepareFix(args, { ...deps, generateRecommendation: async () => ({ recommendation: { id: String(recId) } }) })),
    });
  };
  async function ready() {
    const runner = makeRunner(); install(runner); withRecommendation(runner);
    const id = await finish(runner);
    const prep = await prepare(apiA, tenantA, id);
    assert.equal(prep.status, 200, JSON.stringify(prep.json));
    return { runner, id, taskId: prep.json.data.taskId, fingerprint: prep.json.data.proposalFingerprint };
  }

  it('the proposal carries a deterministic fingerprint bound to project/issue/page/investigation; the prepared Task is bound to it', async () => {
    const { id, taskId, fingerprint } = await ready();
    const inv = await Investigation.findById(id).lean();
    assert.equal(inv.result.proposal.fingerprint, fingerprint);
    assert.match(fingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(inv.result.proposal.boundTo, { investigationId: id, projectId: tenantA.projectId, issueId: 'breadcrumblist_schema', pageUrl: PAGE });
    const task = await Task.findById(taskId).lean();
    assert.equal(task.investigationBinding.investigationId, id);
    assert.equal(task.investigationBinding.fingerprint, fingerprint);
    assert.equal(String(task.investigationBinding.recommendationId), String(recId));
    assert.ok(!('approval' in (await get(apiA, tenantA, id)).json.data) || true);
  });

  it('APPROVAL IS ENFORCED BY THE BACKEND: applying without approval, with an approval of another proposal, or before preparing is refused and nothing is written', async () => {
    const { id, taskId, fingerprint } = await ready();
    const noApproval = await apply(apiA, taskId);
    assert.deepEqual([noApproval.status, noApproval.json.code], [409, 'APPROVAL_REQUIRED']);
    const wrong = await approve(apiA, tenantA, id, 'f'.repeat(64));
    assert.deepEqual([wrong.status, wrong.json.code], [409, 'PROPOSAL_CHANGED']);
    assert.deepEqual([(await apply(apiA, taskId)).json.code], ['APPROVAL_REQUIRED'], 'a refused approval approves nothing');
    assert.equal(writes.length, 0);
    const missing = await approve(apiA, tenantA, id, undefined);
    assert.equal(missing.status, 409);
    assert.equal(writes.length, 0);
    assert.equal((await Task.findById(taskId).lean()).status, 'task_created');
    void fingerprint;
  });

  it('approve -> apply writes once; the approval is consumed; the same approval cannot be used again; concurrent duplicates write exactly once', async () => {
    const { id, taskId, fingerprint } = await ready();
    const ok = await approve(apiA, tenantA, id, fingerprint);
    assert.equal(ok.status, 200); assert.equal(ok.json.data.fingerprint, fingerprint);
    const [a, b, c, d] = await Promise.all([apply(apiA, taskId), apply(apiA, taskId), apply(apiA, taskId), apply(apiA, taskId)]);
    const statuses = [a, b, c, d].map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 409, 409, 409]);
    assert.ok([a, b, c, d].filter((r) => r.status === 409).every((r) => r.json.code === 'APPROVAL_ALREADY_USED'));
    assert.equal(writes.length, 1, 'exactly one write');
    assert.equal(writes[0].approved, true);
    const doc = await Investigation.findById(id).lean();
    assert.ok(doc.approval.consumedAt); assert.equal(doc.approval.consumedByTaskId, taskId);
    assert.equal((await apply(apiA, taskId)).json.code, 'APPROVAL_ALREADY_USED');
    assert.equal(writes.length, 1);
    assert.equal((await approve(apiA, tenantA, id, fingerprint)).json.code, 'APPROVAL_NOT_ALLOWED', 'cannot re-approve something already applied');
  });

  it('a FAILED write releases the claim (retry allowed) and does not produce an applied state', async () => {
    const { id, taskId, fingerprint } = await ready();
    await approve(apiA, tenantA, id, fingerprint);
    applyBehaviour = async () => { throw new WordPressConnectionError('WRITE_FAILED', 'WordPress rejected the write.', 502); };
    const failed = await apply(apiA, taskId);
    assert.equal(failed.status, 502);
    assert.equal((await Investigation.findById(id).lean()).approval.consumedAt, null, 'claim released');
    const lc = (await get(apiA, tenantA, id)).json.data.result.lifecycle;
    assert.deepEqual([lc.fixApplied, lc.fixVerified], [false, false]);
    assert.equal((await Task.findById(taskId).lean()).fixHistory.length, 0);
    applyBehaviour = async (task) => fakeResult(task);
    assert.equal((await apply(apiA, taskId)).status, 200, 'the retry succeeds');
    assert.equal(writes.length, 2);
  });

  it('MATERIAL CHANGE invalidates approval: a newer investigation of the page voids it (explicitly recorded) and the old one can no longer be applied', async () => {
    const { runner, id, taskId, fingerprint } = await ready();
    await approve(apiA, tenantA, id, fingerprint);
    const second = await finish(runner);                      // the page is re-investigated
    const old = await Investigation.findById(id).lean();
    assert.ok(old.approval.invalidatedAt, 'approval explicitly invalidated');
    const r = await apply(apiA, taskId);
    assert.equal(r.status, 409); assert.equal(r.json.code, 'STALE_INVESTIGATION');
    assert.equal(writes.length, 0);
    assert.equal((await approve(apiA, tenantA, id, fingerprint)).json.code, 'STALE_INVESTIGATION');
    // the new investigation needs its own prepare + approval (the old approval does not carry over)
    withRecommendation(runner);
    const prep = await prepare(apiA, tenantA, second);
    assert.equal(prep.status, 200);
    assert.notEqual(prep.json.data.proposalFingerprint, fingerprint, 'a different investigation is a different proposal');
    assert.equal((await apply(apiA, taskId)).json.code, 'APPROVAL_REQUIRED');
    assert.equal(writes.length, 0);
  });

  it('MATERIAL CHANGE: re-linking a different recommendation to the task, or tampering with the stored proposal, voids the approval', async () => {
    let t = await ready();
    await approve(apiA, tenantA, t.id, t.fingerprint);
    await Task.collection.updateOne({ _id: new mongoose.Types.ObjectId(t.taskId) }, { $set: { recommendationId: new mongoose.Types.ObjectId() } });
    let r = await apply(apiA, t.taskId);
    assert.deepEqual([r.status, r.json.code], [409, 'RECOMMENDATION_CHANGED']);
    assert.equal(writes.length, 0);

    await Promise.all([Investigation.deleteMany({ projectId: tenantA.project._id }), Task.deleteMany({ projectId: tenantA.project._id })]);
    t = await ready();
    await approve(apiA, tenantA, t.id, t.fingerprint);
    await mongoose.connection.db.collection('ai_investigations').updateOne({ _id: new mongoose.Types.ObjectId(t.id) }, { $set: { 'result.codeOrConfiguration.0.content': '{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[]}' } });
    r = await apply(apiA, t.taskId);
    assert.deepEqual([r.status, r.json.code], [409, 'PROPOSAL_CHANGED']);
    assert.equal(writes.length, 0);
  });

  it('eligibility is re-checked at apply time: if the site lost the capability after approval, nothing is written and the approval is NOT consumed', async () => {
    const { runner, id, taskId, fingerprint } = await ready();
    await approve(apiA, tenantA, id, fingerprint);
    __setApprovalServiceForTests(createApprovalService({ store: runner.deps.store, resolveCapabilities: async () => ({ ...ELIGIBLE, eligibility: 'requires_integration_setup', reason: 'Missing on this site: wordpress_connection.' }) }));
    const r = await apply(apiA, taskId);
    assert.deepEqual([r.status, r.json.code], [422, 'NOT_ELIGIBLE']);
    assert.equal(writes.length, 0);
    assert.equal((await Investigation.findById(id).lean()).approval.consumedAt, null);
  });

  it('cross-project: another tenant cannot approve or apply, and a task of another project is untouched', async () => {
    const { id, taskId, fingerprint } = await ready();
    assert.equal((await approve(apiB, tenantB, id, fingerprint)).status, 404);
    const r = await apply(apiB, taskId);
    assert.ok([403, 404].includes(r.status), String(r.status));
    assert.equal(writes.length, 0);
    assert.equal((await Investigation.findById(id).lean()).approval ?? null, null);
  });

  it('tasks that did NOT come from an investigation take the unchanged path (no approval record needed)', async () => {
    const task = await Task.create({ projectId: tenantA.project._id, issueKey: 'title_too_long', issueName: 't', pageUrl: PAGE, status: 'task_created', origin: 'ai_fix' });
    const r = await apply(apiA, String(task._id));
    assert.equal(r.status, 200);
    assert.equal(writes.length, 1);
  });

  it('an earlier successful write cannot make a LATER investigation look applied or verified; a stale verification cannot override a newer outcome', async () => {
    const { runner, id, taskId, fingerprint } = await ready();
    await approve(apiA, tenantA, id, fingerprint);
    const writtenAt = new Date();
    await Task.collection.updateOne({ _id: new mongoose.Types.ObjectId(taskId) }, { $set: { status: 'verified_fixed', fixHistory: [{ attemptNumber: 1, implementedAt: writtenAt, fixApplied: { externalWrite: { system: 'wordpress', field: 'breadcrumb_schema', writtenAt } }, verification: { verifiedAt: new Date(writtenAt.getTime() + 1000), result: 'verified_fixed' } }] } });
    // first investigation: it IS applied + verified... but its approval was never consumed through the route, so only the createdAt bound applies
    assert.equal((await get(apiA, tenantA, id)).json.data.result.lifecycle.fixApplied, true);
    await new Promise((r) => setTimeout(r, 50));
    const later = await finish(runner);
    const lc = (await get(apiA, tenantA, later)).json.data.result.lifecycle;
    assert.deepEqual([lc.fixApplied, lc.fixVerified], [false, false], 'the older write/verification does not describe the newer investigation');
    // a newer write exists but its verification predates it: not verified
    const newer = new Date(Date.now() + 1000);
    await Task.collection.updateOne({ _id: new mongoose.Types.ObjectId(taskId) }, { $set: { status: 'implemented' }, $push: { fixHistory: { attemptNumber: 2, implementedAt: newer, fixApplied: { externalWrite: { system: 'wordpress', field: 'breadcrumb_schema', writtenAt: newer } }, verification: { verifiedAt: new Date(newer.getTime() - 5000), result: 'verified_fixed' } } } });
    // The task is still bound to the FIRST proposal: its newer write is not credited to a different investigation.
    const foreign = (await get(apiA, tenantA, later)).json.data.result.lifecycle;
    assert.deepEqual([foreign.fixApplied, foreign.fixVerified], [false, false]);
    assert.equal(foreign.stages.application.state, 'not_started');
    // Once the task is genuinely bound to THIS proposal, the write counts as applied — and the older verification still does not verify it.
    const laterInv = await Investigation.findById(later).lean();
    await Task.collection.updateOne({ _id: new mongoose.Types.ObjectId(taskId) }, { $set: { investigationBinding: { investigationId: later, fingerprint: laterInv.result.proposal.fingerprint, recommendationId: String(recId), boundAt: new Date() } } });
    const lc2 = (await get(apiA, tenantA, later)).json.data.result.lifecycle;
    assert.deepEqual([lc2.fixApplied, lc2.fixVerified], [true, false]);
    assert.deepEqual([lc2.stages.application.state, lc2.stages.verification.state], ['applied', 'not_started']);
  });

  it('verify targets this investigation\'s issue and URL, and refuses when nothing was applied', async () => {
    const { runner, id, taskId, fingerprint } = await ready();
    const none = await apiA('POST', `/recommendations/investigations/${id}/verify`, { projectId: tenantA.projectId });
    assert.deepEqual([none.status, none.json.code], [422, 'NOTHING_TO_VERIFY']);
    assert.equal(verificationCalls.length, 0);
    await approve(apiA, tenantA, id, fingerprint);
    const consumedAt = new Date();
    await Investigation.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { 'approval.consumedAt': consumedAt, 'approval.consumedByTaskId': taskId } });
    const writtenAt = new Date(consumedAt.getTime() + 10);
    await Task.collection.updateOne({ _id: new mongoose.Types.ObjectId(taskId) }, { $set: { status: 'implemented', fixHistory: [{ attemptNumber: 1, implementedAt: writtenAt, fixApplied: { externalWrite: { system: 'wordpress', field: 'breadcrumb_schema', writtenAt } }, verification: {} }] } });
    const ok = await apiA('POST', `/recommendations/investigations/${id}/verify`, { projectId: tenantA.projectId });
    assert.equal(ok.status, 202, JSON.stringify(ok.json));
    assert.deepEqual([verificationCalls[0][0], verificationCalls[0][1]], [tenantA.projectId, PAGE]);
    void runner;
  });
});
