import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import ChatGptVisibilityRun from '../models/ChatGptVisibilityRun.js';
import AiVisibilityQuestionSet from '../../shared/questions/models/AiVisibilityQuestionSet.js';
import AiVisibilityEvidence from '../../shared/evidence/models/AiVisibilityEvidence.js';
import * as runs from '../services/runService.js';
import * as evidence from '../../shared/evidence/services/evidenceService.js';
import { startManualRun, buildQuestionSnapshot } from '../services/auditTriggerService.js';
import { processClaimedRun } from '../workers/runWorker.js';
import { runOnce as sweepOnce } from '../workers/recoveryScheduler.js';
import { getChatGptConfig } from '../config/chatgptConfig.js';
import { ChatGptProviderError, CHATGPT_ERROR } from '../providers/dataForSeoChatGptProvider.js';
import {
  startRun as startRunHandler, listRunEvidence, getRunEvidence, getSummary, toOverviewDto, toSummaryDto,
} from '../controllers/chatgptVisibilityController.js';
import { makeProfile } from '../../shared/tests/fixtures.js';
import { connectTestDb, disconnectTestDb, dropTestCollections } from '../../shared/tests/testDb.js';

const COLLECTIONS = ['chatgpt_visibility_runs', 'ai_visibility_question_sets', 'ai_visibility_evidence'];
let up = false;
before(async () => {
  up = await connectTestDb();
  if (up) await Promise.all([ChatGptVisibilityRun.syncIndexes(), AiVisibilityQuestionSet.syncIndexes(), AiVisibilityEvidence.syncIndexes()]);
});
after(async () => { if (up) await dropTestCollections(COLLECTIONS); await disconnectTestDb(); });
beforeEach(async () => { if (up) await dropTestCollections(COLLECTIONS); });

const oid = () => new mongoose.Types.ObjectId();
const cfg = (o = {}) => getChatGptConfig({
  CHATGPT_VISIBILITY_ENABLED: 'true', CHATGPT_VISIBILITY_MAX_CONCURRENT_PROMPTS: '1', CHATGPT_VISIBILITY_LEASE_MS: '60000',
  CHATGPT_VISIBILITY_MAX_CLAIMS: '3', CHATGPT_VISIBILITY_MAX_RUN_COST: '1', CHATGPT_VISIBILITY_COOLDOWN_MS: '0', ...o,
});
const noKick = { kick: () => true };

function makeQuestions(n = 6, { brand = 1 } = {}) {
  const intents = ['discovery', 'specific_requirements', 'problem_solving', 'comparison', 'buying_decision', 'local_discovery'];
  const q = Array.from({ length: n }, (_, i) => ({
    id: `q_${i}`, group: 'visibility', intent: intents[i % intents.length], text: `Which companies offer service number ${i} in Ahmedabad?`,
    service: 'LASIK surgery', location: i === 1 ? 'Surat' : null, language: 'en', templateId: 'disc_service_loc', priority: i % 2 ? 'medium' : 'high', selectionReason: 'r', source: 'template', enabled: true,
  }));
  for (let b = 0; b < brand; b += 1) {
    q.push({ id: `b_${b}`, group: 'brand_reputation', intent: 'brand_reputation', text: `What is ASG Eye Hospital known for variant ${b}?`, service: null, location: null, language: 'en', templateId: 'brand_known_for', priority: 'low', selectionReason: 'r', source: 'template', enabled: true });
  }
  return q;
}

async function makeSet(projectId, { status = 'approved', version = 1, questions = makeQuestions(), cities = ['Ahmedabad', 'Surat'] } = {}) {
  const doc = await AiVisibilityQuestionSet.create({
    projectId, version, status, profileHash: 'h', generatorVersion: '1.0.0', inputs: { cities }, generatedBy: 'template', questions,
    ...(status === 'approved' ? { approvedAt: new Date() } : {}),
  });
  return doc.toObject();
}

const profileFor = (projectId) => ({ ...makeProfile(), projectId: String(projectId) });

/** A provider stand-in. plan: questionId -> Error | { cost, answer }. Records calls and the peak number in flight. */
function fakeProvider(plan = {}, { delayMs = 0, onCall = null } = {}) {
  const calls = []; const markets = []; const prompts = [];
  let inFlight = 0; let peak = 0;
  const execute = async ({ prompt, market, tag }) => {
    const questionId = tag.split(':')[2];
    calls.push(questionId); markets.push(market); prompts.push(prompt);
    inFlight += 1; peak = Math.max(peak, inFlight);
    try {
      if (onCall) await onCall(questionId, calls.length);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const step = plan[questionId];
      if (step instanceof Error) throw step;
      const cost = step && 'cost' in step ? step.cost : 0.01;
      return {
        answerText: step?.answer ?? `Top options:\n1. **ASG Eye Hospital** for ${questionId}\n2. Other Clinic`,
        annotations: [{ title: 't', url: 'https://www.asgeye.example/page?utm_source=chatgpt.com' }, { title: 'x', url: 'https://other.example/a' }],
        cost, requestId: `req-${questionId}`, model: 'gpt-4o-mini-2024', usage: { inputTokens: 1, outputTokens: 2 }, attempts: 1, durationMs: 5,
      };
    } finally { inFlight -= 1; }
  };
  return { calls, markets, prompts, execute, peak: () => peak };
}
const providerError = (code, { retryable = false, fatal = false } = {}) => Object.assign(new ChatGptProviderError(code), { retryable, fatal, attempts: 1 });

function workerDeps({ execute, config = cfg(), workerId = 'worker-A', events = [], buildProfile } = {}) {
  return {
    events,
    deps: { config, workerId, execute, emit: (kind, run, extra) => events.push({ kind, run, extra }), buildProfile: buildProfile || (async (id) => profileFor(id)) },
  };
}

async function startApproved(projectId, over = {}, deps = {}) {
  return startManualRun({ projectId, userId: oid(), mode: 'approved_questions', ...over }, { config: cfg(), ...noKick, ...deps });
}
const claim = (runId, workerId = 'worker-A', extra = {}) => runs.claimRun({ runId, workerId, config: cfg(), ...extra });

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('approval enforcement', () => {
  test('an approved set executes: the run records the set id, version, mode and a snapshot of the enabled questions', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const projectId = oid();
    const set = await makeSet(projectId, { version: 4 });
    const r = await startApproved(projectId);
    assert.equal(r.scheduled, true);
    assert.equal(r.run.executionMode, 'approved_questions');
    assert.equal(String(r.run.questionSetId), String(set._id));
    assert.equal(r.run.questionSetVersion, 4);
    assert.equal(r.run.questionSnapshot.length, 7);
    assert.equal(r.run.progress.total, 7);
    assert.equal(r.run.policy.model, cfg().model);
  });

  test('draft, archived and other-project sets never execute; there is NO silent fall-back to the five prompts', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const projectId = oid();
    const draft = await makeSet(projectId, { status: 'draft', version: 1 });
    const archived = await makeSet(projectId, { status: 'archived', version: 2 });
    const foreign = await makeSet(oid(), { status: 'approved', version: 1 });
    assert.equal((await startApproved(projectId, { questionSetId: String(draft._id) })).reason, 'QUESTION_SET_NOT_APPROVED');
    assert.equal((await startApproved(projectId, { questionSetId: String(archived._id) })).reason, 'QUESTION_SET_NOT_APPROVED');
    assert.equal((await startApproved(projectId, { questionSetId: String(foreign._id) })).reason, 'QUESTION_SET_NOT_FOUND');
    assert.equal((await startApproved(projectId)).reason, 'NO_APPROVED_QUESTION_SET'); // only a draft + archived exist
    assert.equal(await ChatGptVisibilityRun.countDocuments({ projectId }), 0);
  });

  test('a superseded (archived) set cannot be run by id even though a newer approved set exists', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const projectId = oid();
    const old = await makeSet(projectId, { status: 'archived', version: 1 });
    await makeSet(projectId, { status: 'approved', version: 2 });
    assert.equal((await startApproved(projectId, { questionSetId: String(old._id) })).reason, 'QUESTION_SET_NOT_APPROVED');
    const ok = await startApproved(projectId);
    assert.equal(ok.run.questionSetVersion, 2);
  });

  test('the snapshot is immutable: later edits, disabling or archiving the set cannot change an existing run', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const projectId = oid();
    const set = await makeSet(projectId);
    const r = await startApproved(projectId);
    const before = JSON.stringify((await ChatGptVisibilityRun.findById(r.run._id).lean()).questionSnapshot);
    await AiVisibilityQuestionSet.updateOne({ _id: set._id }, { $set: { 'questions.0.text': 'EDITED AFTER THE RUN', 'questions.1.enabled': false, status: 'archived' } });
    const after = JSON.stringify((await ChatGptVisibilityRun.findById(r.run._id).lean()).questionSnapshot);
    assert.equal(after, before);
    assert.doesNotMatch(after, /EDITED AFTER/);
  });

  test('disabled questions are excluded and the per-run cap is enforced and reported', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const projectId = oid();
    const qs = makeQuestions(8); qs[2].enabled = false;
    await makeSet(projectId, { questions: qs });
    const r = await startApproved(projectId, {}, { config: cfg({ CHATGPT_VISIBILITY_MAX_QUESTIONS_PER_RUN: '5' }) });
    assert.equal(r.run.questionSnapshot.length, 5);
    assert.ok(!r.run.questionSnapshot.some((q) => q.questionId === 'q_2'));
    assert.equal(r.run.policy.truncatedQuestions, 3); // 8 visibility + 1 brand, one disabled -> 8 enabled; 5 kept, 3 did not fit
  });

  test('simultaneous starts create exactly one active run', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const projectId = oid();
    await makeSet(projectId);
    const results = await Promise.all(Array.from({ length: 12 }, () => startApproved(projectId)));
    assert.equal(results.filter((x) => x.scheduled).length, 1);
    assert.equal(await ChatGptVisibilityRun.countDocuments({ projectId }), 1);
  });

  test('the legacy five-prompt mode is the default and is unaffected', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const projectId = oid();
    const r = await startManualRun({ projectId, userId: oid() }, { config: cfg(), ...noKick });
    assert.equal(r.scheduled, true);
    const stored = await ChatGptVisibilityRun.findById(r.run._id).lean();
    assert.equal(stored.executionMode, 'legacy_prompts');
    assert.equal(stored.progress.total, 5);
    assert.equal(stored.questionSnapshot, undefined);
    assert.equal((await startManualRun({ projectId: oid(), userId: oid(), mode: 'made_up' }, { config: cfg(), ...noKick })).reason, 'INVALID_MODE');
  });
});

describe('start endpoint: client input cannot override the server', () => {
  const res = () => { const r = { statusCode: 200, body: null, status(c) { r.statusCode = c; return r; }, json(b) { r.body = b; return r; } }; return r; };

  test('model, limits, questions and settings in the body are ignored; only mode + questionSetId are read', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const projectId = oid();
    const set = await makeSet(projectId);
    process.env.CHATGPT_VISIBILITY_ENABLED = 'true';
    process.env.CHATGPT_VISIBILITY_COOLDOWN_MS = '0';
    const r = res();
    await startRunHandler({
      project: { _id: projectId, user_id: oid() },
      body: { mode: 'approved_questions', questionSetId: String(set._id), model: 'gpt-evil', maxRunCost: 9999, webSearch: false, questions: [{ text: 'INJECTED QUESTION' }], questionSnapshot: [{ text: 'INJECTED' }] },
    }, r);
    delete process.env.CHATGPT_VISIBILITY_ENABLED; delete process.env.CHATGPT_VISIBILITY_COOLDOWN_MS;
    assert.equal(r.statusCode, 202);
    const stored = await ChatGptVisibilityRun.findOne({ projectId }).lean();
    assert.equal(stored.policy.model, getChatGptConfig({}).model);
    assert.notEqual(stored.policy.model, 'gpt-evil');
    assert.equal(stored.policy.maxRunCost, getChatGptConfig({}).maxRunCost);
    assert.ok(!JSON.stringify(stored.questionSnapshot).includes('INJECTED'));
  });

  test('bad mode / bad id are 400; a draft id is 409; unknown id is 404 - never a silent legacy run', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    process.env.CHATGPT_VISIBILITY_ENABLED = 'true'; process.env.CHATGPT_VISIBILITY_COOLDOWN_MS = '0';
    try {
      const projectId = oid();
      const draft = await makeSet(projectId, { status: 'draft' });
      const call = async (body) => { const r = res(); await startRunHandler({ project: { _id: projectId, user_id: oid() }, body }, r); return r; };
      assert.equal((await call({ mode: 'bogus' })).statusCode, 400);
      assert.equal((await call({ mode: 'approved_questions', questionSetId: 'not-an-id' })).statusCode, 400);
      assert.equal((await call({ mode: 'approved_questions', questionSetId: String(draft._id) })).statusCode, 409);
      assert.equal((await call({ mode: 'approved_questions', questionSetId: String(oid()) })).statusCode, 404);
      assert.equal((await call({ mode: 'approved_questions' })).statusCode, 409);
      assert.equal(await ChatGptVisibilityRun.countDocuments({ projectId }), 0);
    } finally { delete process.env.CHATGPT_VISIBILITY_ENABLED; delete process.env.CHATGPT_VISIBILITY_COOLDOWN_MS; }
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('execution and persistence', () => {
  async function setupRun(over = {}, config = cfg()) {
    const projectId = oid();
    await makeSet(projectId, over);
    const r = await startApproved(projectId, {}, { config });
    const claimed = await claim(r.run._id, 'worker-A', { config });
    return { projectId, run: r.run, claimed };
  }

  test('every eligible question is executed with its EXACT approved text; results are persisted per question; metrics come from evidence', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { run, claimed } = await setupRun();
    const provider = fakeProvider();
    const { deps, events } = workerDeps({ execute: provider.execute });
    assert.equal(await processClaimedRun(claimed, deps), 'completed');

    assert.equal(provider.calls.length, 7);
    for (const q of run.questionSnapshot) assert.ok(provider.prompts.includes(q.text), `sent exact text for ${q.questionId}`);

    const docs = await AiVisibilityEvidence.find({ runId: run._id }).lean();
    assert.equal(docs.length, 7);
    assert.ok(docs.every((d) => d.status === 'succeeded' && d.answerText && d.questionSetVersion === 1 && d.schemaVersion === 1 && d.costStatus === 'reported'));
    const first = docs.find((d) => d.questionId === 'q_0');
    assert.equal(first.questionText, run.questionSnapshot.find((q) => q.questionId === 'q_0').text);
    assert.equal(first.modelReported, 'gpt-4o-mini-2024');
    assert.deepEqual(first.firstPartyPages, ['https://asgeye.example/page']); // utm_* removed, www removed
    assert.deepEqual(first.externalDomains, ['other.example']);
    assert.equal(first.analysis.brandMentioned, true);
    assert.equal(first.analysis.recommended, true);
    assert.equal(docs.find((d) => d.group === 'brand_reputation').analysis.recommended, null);

    const done = await ChatGptVisibilityRun.findById(run._id).lean();
    assert.equal(done.status, 'completed');
    assert.deepEqual([done.questionStats.total, done.questionStats.succeeded, done.questionStats.pending], [7, 7, 0]);
    assert.equal(done.metrics.visibility.succeeded, 6);
    assert.equal(done.metrics.visibility.answersMentioningBrand, 6);
    assert.equal(done.metrics.overview.mentions, 6);
    assert.equal(done.metrics.overview.citedPages, 1);
    assert.equal(done.metrics.brandReputation.questions, 1);
    assert.equal(done.totalCost.amount, 0.07);
    assert.equal(done.lockedBy, null);
    assert.ok(events.some((e) => e.kind === 'question_started') && events.some((e) => e.kind === 'question_completed') && events.at(-1).kind === 'completed');
  });

  test('a question naming a confirmed target city is searched with that city; others use the project city', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { claimed } = await setupRun();
    const provider = fakeProvider();
    await processClaimedRun(claimed, workerDeps({ execute: provider.execute }).deps);
    const idx = provider.calls.indexOf('q_1');
    assert.equal(provider.markets[idx].city, 'Surat');
    assert.equal(provider.markets[provider.calls.indexOf('q_0')].city, 'Ahmedabad');
  });

  test('bounded concurrency: never more than maxConcurrentPrompts questions in flight', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const config = cfg({ CHATGPT_VISIBILITY_MAX_CONCURRENT_PROMPTS: '2' });
    const { claimed } = await setupRun({}, config);
    const provider = fakeProvider({}, { delayMs: 15 });
    await processClaimedRun(claimed, workerDeps({ execute: provider.execute, config }).deps);
    assert.equal(provider.calls.length, 7);
    assert.equal(provider.peak(), 2);
  });

  test('a failed question does not erase successful evidence: partial status, classified errors, honest counters', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { run, claimed } = await setupRun();
    const provider = fakeProvider({
      q_1: providerError(CHATGPT_ERROR.TIMEOUT, { retryable: true }),
      q_2: providerError(CHATGPT_ERROR.MALFORMED_RESPONSE),
      q_3: providerError(CHATGPT_ERROR.REQUEST_REJECTED),
    });
    assert.equal(await processClaimedRun(claimed, workerDeps({ execute: provider.execute }).deps), 'partial');
    const by = Object.fromEntries((await AiVisibilityEvidence.find({ runId: run._id }).lean()).map((d) => [d.questionId, d]));
    assert.equal(by.q_0.status, 'succeeded');
    assert.ok(by.q_0.answerText);
    assert.deepEqual([by.q_1.status, by.q_1.errorClass, by.q_1.retryable], ['failed', 'retryable', true]);
    assert.deepEqual([by.q_2.errorClass, by.q_2.errorCode], ['parse', CHATGPT_ERROR.MALFORMED_RESPONSE]);
    assert.deepEqual([by.q_3.errorClass, by.q_3.retryable], ['non_retryable', false]);
    assert.equal(by.q_1.answerText, null);
    const done = await ChatGptVisibilityRun.findById(run._id).lean();
    assert.deepEqual([done.status, done.questionStats.succeeded, done.questionStats.failed], ['partial', 4, 3]);
    // a failed question is missing data, not "no visibility": denominators use the 3 answered visibility questions
    assert.equal(done.metrics.visibility.attempted, 6);
    assert.equal(done.metrics.visibility.succeeded, 3);
    assert.equal(done.metrics.visibility.brandMentionRate, 1);
    assert.ok(done.metrics.visibility.brandMentionRateOfAttempted < 1);
  });

  test('a fatal (account-level) provider error stops the run: the rest are skipped, answered ones are kept', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { run, claimed } = await setupRun();
    const provider = fakeProvider({ q_2: providerError(CHATGPT_ERROR.INSUFFICIENT_CREDITS, { fatal: true }) });
    assert.equal(await processClaimedRun(claimed, workerDeps({ execute: provider.execute }).deps), 'partial');
    const docs = await AiVisibilityEvidence.find({ runId: run._id }).lean();
    const count = (s) => docs.filter((d) => d.status === s).length;
    // snapshot order is high priority first (q_0, q_2, q_4), so q_2 is the 2nd question sent
    assert.deepEqual([count('succeeded'), count('failed'), count('skipped')], [1, 1, 5]);
    assert.ok(docs.filter((d) => d.status === 'skipped').every((d) => d.errorCode === CHATGPT_ERROR.INSUFFICIENT_CREDITS && d.errorClass === 'not_executed'));
    assert.equal(provider.calls.length, 2); // never sent the skipped ones
    const done = await ChatGptVisibilityRun.findById(run._id).lean();
    assert.equal(done.failureCode, CHATGPT_ERROR.INSUFFICIENT_CREDITS);
  });

  test('when nothing succeeds the run is failed', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { run, claimed } = await setupRun();
    const all = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [i < 6 ? `q_${i}` : 'b_0', providerError(CHATGPT_ERROR.REQUEST_REJECTED)]));
    assert.equal(await processClaimedRun(claimed, workerDeps({ execute: fakeProvider(all).execute }).deps), 'failed');
    const done = await ChatGptVisibilityRun.findById(run._id).lean();
    assert.equal(done.status, 'failed');
    assert.equal(done.questionStats.failed, 7);
    assert.ok(done.failedAt);
  });

  test('unknown provider cost is stored as unknown (null), never as zero, and is reported', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { run, claimed } = await setupRun();
    const provider = fakeProvider({ q_0: { cost: null }, q_1: { cost: 0.02 } });
    await processClaimedRun(claimed, workerDeps({ execute: provider.execute }).deps);
    const q0 = await AiVisibilityEvidence.findOne({ runId: run._id, questionId: 'q_0' }).lean();
    assert.equal(q0.cost, null);
    assert.equal(q0.costStatus, 'unknown');
    const done = await ChatGptVisibilityRun.findById(run._id).lean();
    assert.equal(done.totalCost.unknownCount, 1);
    assert.equal(done.metrics.cost.unknownCostCount, 1);
    assert.ok(done.metrics.limitations.includes('UNKNOWN_COST_PRESENT'));
    assert.ok(done.totalCost.amount > 0); // known costs still add up
  });

  test('the cost guard stops scheduling once known spend reaches the limit; the rest are skipped with a reason', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const config = cfg({ CHATGPT_VISIBILITY_MAX_RUN_COST: '0.015' });
    const { run, claimed } = await setupRun({}, config);
    const provider = fakeProvider();
    assert.equal(await processClaimedRun(claimed, workerDeps({ execute: provider.execute, config }).deps), 'partial');
    assert.equal(provider.calls.length, 2); // 0.01 then 0.02 >= 0.015
    const skipped = await AiVisibilityEvidence.find({ runId: run._id, status: 'skipped' }).lean();
    assert.equal(skipped.length, 5);
    assert.ok(skipped.every((d) => d.errorCode === 'COST_LIMIT_REACHED' && d.errorClass === 'budget'));
  });

  test('cancel before work starts: nothing is sent', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { run, claimed } = await setupRun();
    await ChatGptVisibilityRun.updateOne({ _id: run._id }, { $set: { cancelRequested: true } });
    const provider = fakeProvider();
    assert.equal(await processClaimedRun({ ...claimed, cancelRequested: true }, workerDeps({ execute: provider.execute }).deps), 'cancelled');
    assert.equal(provider.calls.length, 0);
    assert.equal((await ChatGptVisibilityRun.findById(run._id).lean()).status, 'cancelled');
  });

  test('cancel while running: answered questions are kept, the rest are skipped as cancelled', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const config = cfg({ CHATGPT_VISIBILITY_LEASE_MS: '3000' }); // heartbeat every 1s
    const { run, claimed } = await setupRun({}, config);
    const provider = fakeProvider({}, {
      onCall: async (id, n) => { if (n === 1) { await runs.requestCancel({ projectId: run.projectId, runId: run._id }); await new Promise((r) => setTimeout(r, 1500)); } },
    });
    assert.equal(await processClaimedRun(claimed, workerDeps({ execute: provider.execute, config }).deps), 'cancelled');
    assert.equal(provider.calls.length, 1);
    const docs = await AiVisibilityEvidence.find({ runId: run._id }).lean();
    assert.equal(docs.filter((d) => d.status === 'succeeded').length, 1);
    assert.ok(docs.filter((d) => d.status === 'skipped').every((d) => d.errorCode === 'RUN_CANCELLED' && d.errorClass === 'cancelled'));
    assert.equal((await ChatGptVisibilityRun.findById(run._id).lean()).status, 'cancelled');
  });

  test('an unusable profile fails the run before any provider call', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { run, claimed } = await setupRun();
    const provider = fakeProvider();
    const out = await processClaimedRun(claimed, workerDeps({ execute: provider.execute, buildProfile: async () => { throw Object.assign(new Error('x'), { code: 'VISIBILITY_PROJECT_NOT_FOUND' }); } }).deps);
    assert.equal(out, 'failed');
    assert.equal(provider.calls.length, 0);
    assert.equal((await ChatGptVisibilityRun.findById(run._id).lean()).failureCode, 'VISIBILITY_PROJECT_NOT_FOUND');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('recovery', () => {
  /** A run a worker started and then died in: target stored, 7 evidence docs, 2 succeeded, 1 running, 4 pending; lease expired. */
  async function crashedRun() {
    const projectId = oid();
    await makeSet(projectId);
    const r = await startApproved(projectId);
    const claimedA = await claim(r.run._id, 'worker-A');
    const target = { brandNames: ['ASG Eye Hospital'], nameSource: 'verified_business', nameVerified: true, brandMatchReliable: true, competitors: [], targetHost: 'asgeye.example' };
    const market = { scope: 'local', effectiveScope: 'local', city: 'Ahmedabad', state: 'Gujarat', country: 'India', countryCode: 'IN', language: 'en' };
    assert.equal(await runs.setApprovedTarget({ runId: r.run._id, workerId: 'worker-A', target, market }), true);
    await evidence.ensureEvidence({ run: { ...claimedA, questionSnapshot: r.run.questionSnapshot } });
    for (const id of ['q_0', 'q_1']) {
      await evidence.claimQuestion({ runId: r.run._id, questionId: id, workerId: 'worker-A' });
      await evidence.saveResult({ runId: r.run._id, questionId: id, workerId: 'worker-A', patch: { status: 'succeeded', answerText: `ORIGINAL ${id}`, cost: 0.01, costStatus: 'reported', completedAt: new Date(), analysis: { brandMentioned: true, brandMentionCount: 1, recommended: false, competitorMentions: [] }, firstPartyPages: [], citations: [], externalDomains: [] } });
    }
    await evidence.claimQuestion({ runId: r.run._id, questionId: 'q_2', workerId: 'worker-A' }); // taken, never finished
    await ChatGptVisibilityRun.updateOne({ _id: r.run._id }, { $set: { 'lease.expiresAt': new Date(Date.now() - 1000) } });
    return { runId: r.run._id, projectId };
  }

  test('a restarted worker resumes: succeeded evidence is not re-asked or duplicated, the interrupted question is re-asked, the target is kept', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { runId } = await crashedRun();
    const claimedB = await claim(runId, 'worker-B');
    assert.equal(claimedB.attempts, 2);
    const provider = fakeProvider();
    let profileCalls = 0;
    const out = await processClaimedRun(claimedB, workerDeps({ execute: provider.execute, workerId: 'worker-B', buildProfile: async (id) => { profileCalls += 1; return profileFor(id); } }).deps);
    assert.equal(out, 'completed');
    assert.equal(profileCalls, 0); // the run keeps the target it started with
    assert.deepEqual([...provider.calls].sort(), ['b_0', 'q_2', 'q_3', 'q_4', 'q_5']);
    assert.equal(await AiVisibilityEvidence.countDocuments({ runId }), 7); // no duplicates
    const q0 = await AiVisibilityEvidence.findOne({ runId, questionId: 'q_0' }).lean();
    assert.equal(q0.answerText, 'ORIGINAL q_0'); // untouched
    assert.equal((await ChatGptVisibilityRun.findById(runId).lean()).questionStats.succeeded, 7);
  });

  test('ensureEvidence is idempotent', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { runId } = await crashedRun();
    const run = await ChatGptVisibilityRun.findById(runId).lean();
    await evidence.ensureEvidence({ run });
    await evidence.ensureEvidence({ run });
    assert.equal(await AiVisibilityEvidence.countDocuments({ runId }), 7);
  });

  test('a worker that lost the question cannot overwrite it, and a final result is never overwritten', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { runId } = await crashedRun();
    const patch = { status: 'succeeded', answerText: 'HIJACK' };
    assert.equal(await evidence.saveResult({ runId, questionId: 'q_2', workerId: 'worker-X', patch }), false); // claimed by A
    assert.equal(await evidence.saveResult({ runId, questionId: 'q_0', workerId: 'worker-A', patch }), false); // already final
    assert.equal((await AiVisibilityEvidence.findOne({ runId, questionId: 'q_0' }).lean()).answerText, 'ORIGINAL q_0');
  });

  test('exhausted retries: the sweep finalizes the run, keeping answers (interrupted -> failed, pending -> skipped)', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { runId } = await crashedRun();
    await ChatGptVisibilityRun.updateOne({ _id: runId }, { $set: { attempts: 3 } });
    const summary = await sweepOnce({ config: cfg(), drain: async () => 0, repair: async () => 0 });
    assert.equal(summary.finalizedExhausted, 1);
    const done = await ChatGptVisibilityRun.findById(runId).lean();
    assert.equal(done.status, 'partial');
    assert.equal(done.failureCode, 'RUN_ATTEMPTS_EXHAUSTED');
    assert.deepEqual([done.questionStats.succeeded, done.questionStats.failed, done.questionStats.skipped], [2, 1, 4]);
    const q2 = await AiVisibilityEvidence.findOne({ runId, questionId: 'q_2' }).lean();
    assert.deepEqual([q2.status, q2.errorCode], ['failed', 'WORKER_INTERRUPTED']);
    assert.equal((await AiVisibilityEvidence.findOne({ runId, questionId: 'q_0' }).lean()).answerText, 'ORIGINAL q_0');
    assert.ok(done.metrics.visibility.succeeded === 2 && done.lockedBy === null);
  });

  test('a run with an expired lease but claims left is claimable by exactly one worker', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { runId } = await crashedRun();
    const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => claim(runId, `w-${i}`)));
    assert.equal(claims.filter(Boolean).length, 1);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('evidence API: authorization and shape', () => {
  const res = () => { const r = { statusCode: 200, body: null, status(c) { r.statusCode = c; return r; }, json(b) { r.body = b; return r; } }; return r; };

  async function finishedRun() {
    const projectId = oid();
    await makeSet(projectId);
    const r = await startApproved(projectId);
    const claimed = await claim(r.run._id);
    await processClaimedRun(claimed, workerDeps({ execute: fakeProvider().execute }).deps);
    return { projectId, runId: r.run._id };
  }

  test('list omits answers/citations; detail includes them; provider ids, claims and lease data are never returned', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { projectId, runId } = await finishedRun();
    const list = res();
    await listRunEvidence({ project: { _id: projectId }, params: { runId: String(runId) }, query: { limit: '3' } }, list);
    assert.equal(list.statusCode, 200);
    assert.equal(list.body.data.length, 3);
    assert.equal(list.body.meta.total, 7);
    const sample = JSON.stringify(list.body);
    assert.doesNotMatch(sample, /answer"|req-q_|claimedBy|worker-A|providerRequestId|lease/);

    const one = res();
    await getRunEvidence({ project: { _id: projectId }, params: { runId: String(runId), questionId: 'q_0' } }, one);
    assert.equal(one.statusCode, 200);
    assert.match(one.body.data.answer, /ASG Eye Hospital/);
    assert.equal(one.body.data.citations.find((c) => c.isTarget).normalizedUrl, 'https://asgeye.example/page');
    assert.doesNotMatch(JSON.stringify(one.body), /req-q_|claimedBy|worker-A|providerRequestId/);
  });

  test('another project cannot read this run or its evidence (404, not 403: existence is not revealed)', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { runId } = await finishedRun();
    const other = { _id: oid() };
    const a = res(); await listRunEvidence({ project: other, params: { runId: String(runId) }, query: {} }, a);
    const b = res(); await getRunEvidence({ project: other, params: { runId: String(runId), questionId: 'q_0' } }, b);
    assert.deepEqual([a.statusCode, b.statusCode], [404, 404]);
    const c = res(); await listRunEvidence({ project: other, params: { runId: 'not-an-id' }, query: {} }, c);
    assert.equal(c.statusCode, 404);
  });

  test('pagination is bounded', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { projectId, runId } = await finishedRun();
    const r = res();
    await listRunEvidence({ project: { _id: projectId }, params: { runId: String(runId) }, query: { limit: '100000', page: '-3' } }, r);
    assert.equal(r.body.meta.limit, 50);
    assert.equal(r.body.meta.page, 1);
  });

  test('summary exposes the card numbers from the latest approved run; legacy runs never feed it', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { projectId, runId } = await finishedRun();
    const r = res();
    await getSummary({ project: { _id: projectId } }, r);
    const o = r.body.data.overview;
    assert.equal(o.source, 'approved_questions');
    assert.equal(o.runId, String(runId));
    // 6 discovery answers (the 1 brand diagnostic answer never counts); every rate shares that denominator.
    assert.equal(o.eligibleAnswers, 6);
    assert.deepEqual(o.visibility, { rate: 1, answers: 6 });
    assert.deepEqual(o.recommendation, { rate: 1, answers: 6, method: 'heuristic_v1' });
    assert.deepEqual(o.websiteCitation, { rate: 1, answers: 6 });
    assert.equal(o.uniqueCitedPages, 1);
    assert.equal(o.citationOccurrences, 6); // the same page cited in 6 answers: 6 occurrences, 1 unique page
    assert.deepEqual(o.execution, { attempted: 6, answered: 6, failed: 0, skipped: 0 });
    assert.equal(o.competitors.configured, true); // the fixture profile tracks two competitors...
    assert.deepEqual(o.competitors.mentioned, []); // ...and no answer named either of them
    assert.equal(o.sampled, true);
    assert.equal(r.body.data.latest.executionMode, 'approved_questions');
    assert.equal(toOverviewDto({ executionMode: 'legacy_prompts', metrics: { overview: { mentions: 1 } } }), null);
    assert.equal(toSummaryDto({ _id: oid(), projectId: oid(), status: 'completed' }).executionMode, 'legacy_prompts'); // old documents read as legacy
  });

  test('evidence keeps the question-set version it was collected under after a newer set is approved', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { projectId, runId } = await finishedRun();
    await AiVisibilityQuestionSet.updateOne({ projectId, status: 'approved' }, { $set: { status: 'archived' } });
    await makeSet(projectId, { version: 2 });
    const docs = await AiVisibilityEvidence.find({ runId }).lean();
    assert.ok(docs.every((d) => d.questionSetVersion === 1));
    const history = await evidence.listQuestionHistory({ projectId, questionId: 'q_0' });
    assert.equal(history.length, 1);
    assert.equal(history[0].questionSetVersion, 1);
  });
});

describe('project deletion', () => {
  test('deleting a project removes its question sets, runs and evidence, and leaves other projects untouched', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { deleteProjectCascade } = await import('../../../app_user/service/projectCascadeDeleteService.js');
    const build = async () => {
      const projectId = oid();
      await makeSet(projectId);
      const r = await startApproved(projectId);
      const claimed = await claim(r.run._id);
      await processClaimedRun(claimed, workerDeps({ execute: fakeProvider().execute }).deps);
      return { projectId, runId: r.run._id };
    };
    const mine = await build();
    const other = await build();
    const out = await deleteProjectCascade(String(mine.projectId));
    assert.deepEqual([out.collectionCounts.ai_visibility_evidence, out.collectionCounts.ai_visibility_question_sets, out.collectionCounts.chatgpt_visibility_runs], [7, 1, 1]);
    assert.equal(await AiVisibilityEvidence.countDocuments({ projectId: mine.projectId }), 0);
    assert.equal(await AiVisibilityEvidence.countDocuments({ projectId: other.projectId }), 7);
    assert.equal(await AiVisibilityQuestionSet.countDocuments({ projectId: other.projectId }), 1);
  });
});

describe('snapshot builder (pure)', () => {
  test('orders visibility by priority then brand questions, keeps only enabled, and maps confirmed cities', () => {
    const set = { inputs: { cities: ['Surat'] }, questions: makeQuestions(4) };
    set.questions[3].enabled = false;
    const { snapshot, truncated } = buildQuestionSnapshot(set, cfg());
    assert.equal(truncated, 0);
    assert.deepEqual(snapshot.map((q) => q.questionId), ['q_0', 'q_2', 'q_1', 'b_0']); // high (0,2), medium (1), brand last
    assert.equal(snapshot.find((q) => q.questionId === 'q_1').searchCity, 'Surat');
    assert.equal(snapshot.find((q) => q.questionId === 'q_0').searchCity, null);
  });
});
