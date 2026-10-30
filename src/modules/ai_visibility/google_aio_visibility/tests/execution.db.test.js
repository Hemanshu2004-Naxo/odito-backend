import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import GoogleAioRun from '../models/GoogleAioRun.js';
import GoogleAioEvidence from '../models/GoogleAioEvidence.js';
import AiVisibilityQuestionSet from '../../shared/questions/models/AiVisibilityQuestionSet.js';
import * as runs from '../services/runService.js';
import { startManualRun } from '../services/startRunService.js';
import { processClaimedRun } from '../workers/runWorker.js';
import { fetchGoogleAiOverview } from '../provider/googleAioProvider.js';
import { GOOGLE_AIO_ERROR } from '../provider/providerErrors.js';
import { getGoogleAioConfig } from '../config/googleAioConfig.js';
import { toEvidenceDto, observationOf } from '../controllers/googleAioController.js';
import { generateQuestionSet } from '../../shared/questions/services/questionGenerationService.js';
import { makeProfile } from '../../shared/tests/fixtures.js';
import { connectTestDb, disconnectTestDb, dropTestCollections } from '../../shared/tests/testDb.js';
import { aioItem, organic, serpResponse } from './fixtures.js';

/**
 * Execution regressions found in production-like use: one transient provider failure must not abort or skip the other questions, every
 * question must reach a terminal state with an accurate reason, and the provider's own diagnostics must be stored. The REAL provider
 * (request building, retries, error classification, parsing) runs here; only the HTTP send is replaced. No paid request is made.
 */
const COLLECTIONS = ['google_aio_visibility_runs', 'google_aio_visibility_evidence', 'ai_visibility_question_sets'];
let up = false;
before(async () => {
  up = await connectTestDb();
  if (up) await Promise.all([GoogleAioRun.syncIndexes(), GoogleAioEvidence.syncIndexes(), AiVisibilityQuestionSet.syncIndexes()]);
});
after(async () => { if (up) await dropTestCollections(COLLECTIONS); await disconnectTestDb(); });
beforeEach(async () => { if (up) await dropTestCollections(COLLECTIONS); });

const oid = () => new mongoose.Types.ObjectId();
const cfg = (o = {}) => getGoogleAioConfig({ GOOGLE_AIO_VISIBILITY_ENABLED: 'true', GOOGLE_AIO_VISIBILITY_MAX_CONCURRENT_QUESTIONS: '2', GOOGLE_AIO_VISIBILITY_MAX_RETRIES: '1', GOOGLE_AIO_VISIBILITY_LEASE_MS: '60000', ...o });
const LOCATIONS = [{ location_code: 1007740, location_name: 'Nashik,Maharashtra,India', country_iso_code: 'IN', location_type: 'City' }];
const nashik = { project: { verified_business: { placeId: 'p1', name: 'ASG Eye Hospital', city: 'Nashik', state: 'Maharashtra', countryCode: 'IN' }, target_city: 'Nashik', location_source: 'user_entered', location: 'Nashik, Maharashtra' } };
const profileFor = (projectId) => ({ ...makeProfile(nashik), projectId: String(projectId) });

async function queuedRun() {
  const projectId = oid();
  const g = await generateQuestionSet(profileFor(projectId), { provider: { isAvailable: () => false } });
  await AiVisibilityQuestionSet.create({ projectId, version: 1, status: 'approved', profileHash: g.profileHash, generatorVersion: g.generatorVersion, inputs: g.inputs, language: g.language, generatedBy: g.generatedBy, questions: g.questions });
  const res = await startManualRun({ projectId, userId: oid() }, { config: cfg(), buildProfile: async (id) => profileFor(id), loadLocations: async () => LOCATIONS, emit: () => {}, kick: () => {} });
  assert.equal(res.scheduled, true);
  const claimed = await runs.claimRun({ runId: res.run._id, workerId: 'worker-A', config: cfg() });
  return { projectId, claimed };
}

const taskError = (code, message) => Object.assign(new Error(`DataForSEO task error: ${message} (code ${code})`), { isApiError: true, isTaskError: true, taskStatusCode: code, taskStatusMessage: message, taskId: '09281234-5678-0000-0000-abcdefabcdef' });
const httpError = (status) => Object.assign(new Error(`Request failed with status code ${status}`), { isAxiosError: true, response: { status, headers: {} } });
const timeoutError = () => Object.assign(new Error('timeout of 90000ms exceeded'), { code: 'ECONNABORTED', isAxiosError: true });

/**
 * Drives the REAL provider with a scripted transport. plan[position] = array of per-attempt outcomes, each: 'aio' | 'none' | Error | object (raw response).
 * The question text -> position map comes from the run so scripts are written in terms of "question 2".
 */
function scripted(run, plan = {}) {
  const sends = new Map(); // position -> number of requests sent
  const positionOf = new Map(run.questionSnapshot.map((q, i) => [q.text, i + 1]));
  const send = async (body) => {
    const pos = positionOf.get(body.keyword);
    const n = (sends.get(pos) || 0) + 1;
    sends.set(pos, n);
    const script = plan[pos] || ['aio'];
    const step = script[Math.min(n, script.length) - 1];
    if (step instanceof Error) throw step;
    if (step === 'aio') return serpResponse([organic, aioItem()]);
    if (step === 'none') return serpResponse([organic]);
    return step;
  };
  const fetch = (input, o) => fetchGoogleAiOverview(input, { ...o, send, sleep: async () => {}, random: () => 0 });
  return { sends, fetch };
}
function workerDeps({ fetch, config = cfg(), events = [] }) {
  return { config, workerId: 'worker-A', fetch, emit: (kind, r, extra) => events.push({ kind, completed: r.progress?.completed, status: r.status, extra }), buildProfile: async (id) => profileFor(id) };
}
const docsOf = (runId) => GoogleAioEvidence.find({ runId }).sort({ position: 1 }).lean();
const assertAllTerminal = async (runId) => {
  const docs = await docsOf(runId);
  assert.equal(docs.length, 5);
  assert.ok(docs.every((d) => ['succeeded', 'failed', 'skipped', 'cancelled'].includes(d.status)), docs.map((d) => d.status).join());
  const run = await GoogleAioRun.findById(runId).lean();
  assert.equal(run.questionStats.pending, 0);
  assert.equal(run.progress.completed, 5);
  return { docs, run };
};

describe('one failed question never blocks the others', () => {
  test('a persistent 40101 (search-engine error) on question 2 fails ONLY question 2; question 5 is still attempted', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { claimed } = await queuedRun();
    const s = scripted(claimed, { 2: [taskError(40101, 'Internal SE server error.')] });
    const events = [];
    assert.equal(await processClaimedRun(claimed, workerDeps({ fetch: s.fetch, events })), 'partial');
    const { docs, run } = await assertAllTerminal(claimed._id);
    assert.deepEqual(docs.map((d) => d.status), ['succeeded', 'failed', 'succeeded', 'succeeded', 'succeeded']);
    assert.ok(docs.every((d) => d.status !== 'skipped'), 'nothing was left "not sent"');
    assert.equal(s.sends.get(5), 1, 'question 5 was dispatched');
    // the failure is a search-engine error, NOT a credentials error, and it was retried once (bounded) before being recorded
    assert.equal(docs[1].errorCode, GOOGLE_AIO_ERROR.SEARCH_ENGINE_ERROR);
    assert.notEqual(docs[1].errorCode, GOOGLE_AIO_ERROR.AUTH);
    assert.equal(docs[1].errorClass, 'retryable');
    assert.equal(s.sends.get(2), 2);
    assert.deepEqual([run.status, run.failureCode, run.questionStats.succeeded, run.questionStats.failed, run.questionStats.skipped], ['partial', GOOGLE_AIO_ERROR.SEARCH_ENGINE_ERROR, 4, 1, 0]);
  });

  test('the provider diagnostics of a failed question are stored and exposed (no credentials)', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { claimed } = await queuedRun();
    const s = scripted(claimed, { 3: [taskError(40101, 'Internal SE server error.')] });
    await processClaimedRun(claimed, workerDeps({ fetch: s.fetch }));
    const failed = (await docsOf(claimed._id))[2];
    assert.equal(failed.status, 'failed');
    assert.deepEqual([failed.diagnostics.httpStatus, failed.diagnostics.providerCode, failed.diagnostics.providerMessage, failed.diagnostics.taskIdReturned], [null, 40101, 'Internal SE server error.', true]);
    assert.equal(failed.diagnostics.attemptLog.length, 2);
    assert.ok(failed.diagnostics.attemptLog.every((a) => a.outcome === GOOGLE_AIO_ERROR.SEARCH_ENGINE_ERROR && a.providerCode === 40101 && typeof a.durationMs === 'number'));
    assert.ok(typeof failed.diagnostics.durationMs === 'number' && failed.durationMs >= 0);
    const dto = toEvidenceDto(failed, { detail: true });
    assert.equal(dto.diagnostics.providerCode, 40101);
    assert.equal(dto.diagnostics.attempts.length, 2);
    assert.equal(observationOf(failed), 'request_failed');
    const stored = JSON.stringify(failed).toLowerCase();
    for (const secret of ['authorization', 'basic ', 'password', process.env.DATAFORSEO_PASSWORD?.toLowerCase()].filter(Boolean)) assert.ok(!stored.includes(secret), secret);
    // successful questions carry diagnostics too
    assert.equal((await docsOf(claimed._id))[0].diagnostics.providerCode, 20000);
  });

  test('a transient failure that succeeds on the retry is a success; completed questions are never re-sent', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { claimed } = await queuedRun();
    const s = scripted(claimed, { 2: [taskError(40103, 'Task execution failed, please try to resubmit the task.'), 'aio'] });
    assert.equal(await processClaimedRun(claimed, workerDeps({ fetch: s.fetch })), 'completed');
    const { docs } = await assertAllTerminal(claimed._id);
    assert.ok(docs.every((d) => d.status === 'succeeded'));
    assert.equal(docs[1].attempts, 2);
    assert.deepEqual([...s.sends.entries()].sort(), [[1, 1], [2, 2], [3, 1], [4, 1], [5, 1]], 'only the failing question was sent twice');
  });

  test('a timeout is a FAILED question (with diagnostics), never "no AI Overview"; the rest still run', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { claimed } = await queuedRun();
    const s = scripted(claimed, { 4: [timeoutError()] });
    await processClaimedRun(claimed, workerDeps({ fetch: s.fetch }));
    const { docs } = await assertAllTerminal(claimed._id);
    assert.equal(docs[3].status, 'failed');
    assert.equal(docs[3].errorCode, GOOGLE_AIO_ERROR.TIMEOUT);
    assert.equal(docs[3].aiOverview?.present ?? null, null, 'no overview verdict was recorded for a failed request');
    assert.equal(observationOf(docs[3]), 'request_failed');
    assert.equal(docs[4].status, 'succeeded');
    assert.equal(docs[3].diagnostics.attemptLog.length, 2);
  });

  test('a malformed provider response fails that question safely and the others continue', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { claimed } = await queuedRun();
    const s = scripted(claimed, { 1: [{ tasks: [{ result: null }] }] });
    assert.equal(await processClaimedRun(claimed, workerDeps({ fetch: s.fetch })), 'partial');
    const { docs } = await assertAllTerminal(claimed._id);
    assert.deepEqual([docs[0].status, docs[0].errorCode, docs[0].errorClass], ['failed', GOOGLE_AIO_ERROR.MALFORMED_RESPONSE, 'parse']);
    assert.equal(s.sends.get(1), 1, 'a malformed response is not retried');
    assert.ok(docs.slice(1).every((d) => d.status === 'succeeded'));
  });

  test('"no search results" (40102) is a failure with its own code, not "No AI Overview"', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { claimed } = await queuedRun();
    const s = scripted(claimed, { 5: [taskError(40102, 'No Search Results.')] });
    await processClaimedRun(claimed, workerDeps({ fetch: s.fetch }));
    const { docs } = await assertAllTerminal(claimed._id);
    assert.deepEqual([docs[4].status, docs[4].errorCode], ['failed', GOOGLE_AIO_ERROR.NO_SEARCH_RESULTS]);
    assert.equal(s.sends.get(5), 1);
  });

  test('five answered questions of mixed outcome: with overview, without overview, with overview', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { claimed } = await queuedRun();
    const s = scripted(claimed, { 1: ['none'], 4: ['none'] });
    assert.equal(await processClaimedRun(claimed, workerDeps({ fetch: s.fetch })), 'completed');
    const { docs, run } = await assertAllTerminal(claimed._id);
    assert.deepEqual(docs.map((d) => d.aiOverview.present), [false, true, true, false, true]);
    assert.deepEqual(docs.map(observationOf), ['no_ai_overview', 'ai_overview', 'ai_overview', 'no_ai_overview', 'ai_overview']);
    assert.deepEqual([run.metrics.aiOverview.count, run.metrics.aiOverview.denominator], [3, 5]);
  });
});

describe('a real account-level error stops dispatch and says exactly why', () => {
  test('HTTP 401: the failed question is auth-failed; the rest are "not sent" because of it (with the cause), all terminal', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { claimed } = await queuedRun();
    const s = scripted(claimed, { 1: [httpError(401)] });
    const events = [];
    const status = await processClaimedRun(claimed, workerDeps({ fetch: s.fetch, config: cfg({ GOOGLE_AIO_VISIBILITY_MAX_CONCURRENT_QUESTIONS: '1' }), events }));
    assert.equal(status, 'failed');
    const { docs, run } = await assertAllTerminal(claimed._id);
    assert.deepEqual(docs.map((d) => d.status), ['failed', 'skipped', 'skipped', 'skipped', 'skipped']);
    assert.deepEqual([docs[0].errorCode, docs[0].diagnostics.httpStatus, docs[0].attempts], [GOOGLE_AIO_ERROR.AUTH, 401, 1]);
    for (const d of docs.slice(1)) {
      assert.deepEqual([d.errorCode, d.skipCause, d.attempts], ['NOT_SENT_PROVIDER_ACCOUNT_ERROR', GOOGLE_AIO_ERROR.AUTH, 0]);
      assert.equal(observationOf(d), 'not_sent');
      assert.equal(toEvidenceDto(d).skipCause, GOOGLE_AIO_ERROR.AUTH);
    }
    assert.equal(run.status, 'failed');
    assert.deepEqual([...s.sends.keys()], [1], 'no request was sent for the unsent questions');
  });
});

describe('completion and progress are driven by persisted terminal states', () => {
  test('progress never moves backwards, the run is not terminal before all five settled, and exactly one terminal event is last', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { claimed } = await queuedRun();
    const s = scripted(claimed, { 2: [taskError(40101, 'x')] });
    const events = [];
    await processClaimedRun(claimed, workerDeps({ fetch: s.fetch, events }));
    const progress = events.map((e) => e.completed).filter((n) => typeof n === 'number');
    assert.deepEqual(progress, [...progress].sort((a, b) => a - b), 'completed count is monotonic');
    const terminal = events.filter((e) => ['completed', 'partial', 'failed', 'cancelled'].includes(e.kind));
    assert.equal(terminal.length, 1);
    assert.equal(events.at(-1), terminal[0]);
    assert.equal(terminal[0].completed, 5, 'the terminal event reports 5/5 because all five are terminal');
    // 5/5 settled may be reported by the last question's own event, but the RUN is only marked terminal by the single final event.
    assert.ok(events.filter((e) => e.completed === 5 && !['completed', 'partial', 'failed', 'cancelled'].includes(e.kind)).every((e) => e.status === 'running'));
    assert.ok(events.slice(0, -1).every((e) => e.completed < 5 || e.status === 'running'));
  });

  test('a run whose question was left running by a dead worker is not completed until that question is settled', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { claimed } = await queuedRun();
    const s = scripted(claimed);
    let n = 0;
    const crashing = workerDeps({ fetch: s.fetch });
    crashing.deps = crashing;
    const deps = { ...crashing, emit: (kind) => { if (kind === 'question_completed' && ++n === 2) throw new Error('boom'); } };
    assert.equal(await processClaimedRun(claimed, deps), 'crashed');
    const mid = await GoogleAioRun.findById(claimed._id).lean();
    assert.equal(mid.status, 'running', 'a crashed run is not reported complete');
    assert.ok(mid.questionStats.pending > 0 || mid.progress.completed < 5);
    await GoogleAioRun.updateOne({ _id: claimed._id }, { $set: { 'lease.expiresAt': new Date(Date.now() - 1000) } });
    const again = await runs.claimRun({ runId: claimed._id, workerId: 'worker-B', config: cfg() });
    assert.equal(await processClaimedRun(again, { ...workerDeps({ fetch: s.fetch }), workerId: 'worker-B' }), 'completed');
    await assertAllTerminal(claimed._id);
    assert.deepEqual([...s.sends.values()].reduce((a, b) => a + b, 0), 5, 'five requests in total across the crash');
  });
});

describe('metrics only count what was actually searched', () => {
  test('failed and not-sent questions are not "no AI Overview" and are outside every denominator', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { claimed } = await queuedRun();
    const s = scripted(claimed, { 1: [httpError(401)] });
    await processClaimedRun(claimed, workerDeps({ fetch: s.fetch, config: cfg({ GOOGLE_AIO_VISIBILITY_MAX_CONCURRENT_QUESTIONS: '1' }) }));
    const run = await GoogleAioRun.findById(claimed._id).lean();
    assert.deepEqual([run.metrics.aiOverview.denominator, run.metrics.aiOverview.rate, run.metrics.aiOverview.noOverviewCount], [0, null, 0]);
    assert.deepEqual([run.metrics.questions.failed, run.metrics.questions.skipped, run.metrics.questions.answered], [1, 4, 0]);
    assert.equal(run.metrics.brandMention.rate, null);
    assert.equal(run.metrics.websiteCitation.rate, null);
  });
});
