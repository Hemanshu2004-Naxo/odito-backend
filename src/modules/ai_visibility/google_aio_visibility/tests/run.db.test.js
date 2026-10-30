import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import GoogleAioRun from '../models/GoogleAioRun.js';
import GoogleAioEvidence from '../models/GoogleAioEvidence.js';
import AiVisibilityQuestionSet from '../../shared/questions/models/AiVisibilityQuestionSet.js';
import * as runs from '../services/runService.js';
import * as evidence from '../services/evidenceService.js';
import { startManualRun } from '../services/startRunService.js';
import { processClaimedRun } from '../workers/runWorker.js';
import { runOnce as sweepOnce } from '../workers/recoveryScheduler.js';
import { getGoogleAioConfig } from '../config/googleAioConfig.js';
import { GoogleAioProviderError, GOOGLE_AIO_ERROR } from '../provider/providerErrors.js';
import { buildEventPayload, EVENTS } from '../services/events.js';
import { toEvidenceDto, observationOf } from '../controllers/googleAioController.js';
import { generateQuestionSet } from '../../shared/questions/services/questionGenerationService.js';
import { makeProfile } from '../../shared/tests/fixtures.js';
import { connectTestDb, disconnectTestDb, dropTestCollections } from '../../shared/tests/testDb.js';
import { aioItem, organic, serpResponse } from './fixtures.js';
import { parseGoogleAioResponse } from '../provider/responseParser.js';

const COLLECTIONS = ['google_aio_visibility_runs', 'google_aio_visibility_evidence', 'ai_visibility_question_sets', 'chatgpt_visibility_runs'];
let up = false;
before(async () => {
  up = await connectTestDb();
  if (up) await Promise.all([GoogleAioRun.syncIndexes(), GoogleAioEvidence.syncIndexes(), AiVisibilityQuestionSet.syncIndexes()]);
});
after(async () => { if (up) await dropTestCollections(COLLECTIONS); await disconnectTestDb(); });
beforeEach(async () => { if (up) await dropTestCollections(COLLECTIONS); });

const oid = () => new mongoose.Types.ObjectId();
const cfg = (o = {}) => getGoogleAioConfig({ GOOGLE_AIO_VISIBILITY_ENABLED: 'true', GOOGLE_AIO_VISIBILITY_MAX_CONCURRENT_QUESTIONS: '1', GOOGLE_AIO_VISIBILITY_LEASE_MS: '60000', GOOGLE_AIO_VISIBILITY_MAX_CLAIMS: '3', ...o });
const profileFor = (projectId, over) => ({ ...makeProfile(over), projectId: String(projectId) });
const LOCATIONS = [
  { location_code: 2356, location_name: 'India', country_iso_code: 'IN', location_type: 'Country' },
  { location_code: 1007740, location_name: 'Nashik,Maharashtra,India', country_iso_code: 'IN', location_type: 'City' },
];
const nashik = { project: { verified_business: { placeId: 'p1', name: 'ASG Eye Hospital', city: 'Nashik', state: 'Maharashtra', countryCode: 'IN' }, target_city: 'Nashik', location_source: 'user_entered', location: 'Nashik, Maharashtra' } };

async function seedApprovedSet(projectId, profile = profileFor(projectId, nashik)) {
  const g = await generateQuestionSet(profile, { provider: { isAvailable: () => false } });
  return AiVisibilityQuestionSet.create({
    projectId, version: 1, status: 'approved', profileHash: g.profileHash, generatorVersion: g.generatorVersion, inputs: g.inputs, language: g.language,
    generatedBy: g.generatedBy, questions: g.questions,
  });
}

function startDeps(projectId, over = {}) {
  const events = [];
  const kicked = [];
  return {
    events, kicked,
    deps: {
      config: cfg(), buildProfile: async (id) => profileFor(id, nashik), loadLocations: async () => LOCATIONS,
      emit: (kind, run) => events.push({ kind, run }), kick: (id) => kicked.push(id), ...over,
    },
  };
}
async function startRun(projectId = oid(), over = {}, body = {}) {
  await seedApprovedSet(projectId);
  const s = startDeps(projectId, over);
  const res = await startManualRun({ projectId, userId: oid(), ...body }, s.deps);
  return { projectId, res, ...s };
}

/** Provider stand-in. plan: questionId-suffix(position) -> 'ok' | 'none' | 'noRefs' | Error. Records every call. */
function fakeFetch(plan = {}) {
  const calls = [];
  const fetch = async ({ question, serp, tag }) => {
    const questionId = tag.split(':')[2];
    calls.push({ questionId, question, serp });
    const step = plan[calls.length] ?? plan[questionId] ?? 'ok';
    if (step instanceof Error) throw step;
    const items = step === 'none' ? [organic] : [organic, aioItem(step === 'noRefs' ? { references: [], items: [{ type: 'ai_overview_element', text: 'ASG Eye Hospital offers LASIK in Nashik.' }] } : {})];
    return { ...parseGoogleAioResponse(serpResponse(items)), request: { keyword: question, location_code: serp.locationCode, language_code: serp.languageCode, device: serp.device, os: serp.os, depth: serp.depth, load_async_ai_overview: serp.loadAsyncAiOverview, tag }, attempts: 1, durationMs: 4 };
  };
  return { calls, fetch };
}
const providerError = (code, { fatal = false, retryable = false } = {}) => Object.assign(new GoogleAioProviderError(code), { fatal, retryable, attempts: 1 });

function workerDeps({ fetch, config = cfg(), workerId = 'worker-A', emit, profileOver = nashik } = {}) {
  const events = [];
  return { events, deps: { config, workerId, fetch, emit: emit || ((kind, run, extra) => events.push({ kind, run, extra })), buildProfile: async (id) => profileFor(id, profileOver) } };
}
const claim = (runId, workerId = 'worker-A', config = cfg()) => runs.claimRun({ runId, workerId, config });

describe('starting a run: exactly five questions, verified location', () => {
  test('creates a queued run with EXACTLY five unique questions and the resolved Nashik location', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { res, events, kicked } = await startRun();
    assert.equal(res.scheduled, true);
    const run = await GoogleAioRun.findById(res.run._id).lean();
    assert.equal(run.status, 'queued');
    assert.equal(run.questionSnapshot.length, 5);
    assert.equal(new Set(run.questionSnapshot.map((q) => q.questionId)).size, 5);
    assert.deepEqual([run.serp.locationCode, run.serp.locationName, run.serp.languageCode, run.serp.device, run.serp.os, run.serp.loadAsyncAiOverview], [1007740, 'Nashik,Maharashtra,India', 'en', 'desktop', 'windows', true]);
    assert.deepEqual(events.map((e) => e.kind), ['started']);
    assert.deepEqual(kicked, [String(run._id)]);
  });
  test('device choice is preserved (mobile -> android)', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { res } = await startRun(oid(), {}, { device: 'mobile' });
    assert.deepEqual([res.run.serp.device, res.run.serp.os], ['mobile', 'android']);
  });
  test('the database refuses a run whose snapshot is not exactly five questions', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const q = (i) => ({ questionId: `q${i}`, intent: 'discovery', text: `Which eye hospitals in Nashik number ${i}?` });
    const base = { projectId: oid(), userId: oid(), questionSetId: oid(), questionSetVersion: 1, selectionMode: 'auto', serp: { locationCode: 1, languageCode: 'en', device: 'desktop', os: 'windows', depth: 10, loadAsyncAiOverview: true } };
    await assert.rejects(() => runs.createRun({ ...base, questionSnapshot: [1, 2, 3, 4].map(q) }), /exactly 5/);
    await assert.rejects(() => runs.createRun({ ...base, questionSnapshot: [1, 2, 3, 4, 5, 6].map(q) }), /exactly 5/);
    await assert.rejects(() => runs.createRun({ ...base, questionSnapshot: [1, 2, 3, 4, 4].map(q) }), /exactly 5/);
  });
  test('refusals: disabled, no approved set, unresolvable city, wrong question count, second active run', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const projectId = oid();
    const noSet = await startManualRun({ projectId, userId: oid() }, startDeps(projectId).deps);
    assert.equal(noSet.reason, 'NO_APPROVED_QUESTION_SET');
    await seedApprovedSet(projectId);
    assert.equal((await startManualRun({ projectId, userId: oid() }, startDeps(projectId, { config: cfg({ GOOGLE_AIO_VISIBILITY_ENABLED: 'false' }) }).deps)).reason, 'DISABLED');
    assert.equal((await startManualRun({ projectId, userId: oid() }, startDeps(projectId, { loadLocations: async () => [LOCATIONS[0]] }).deps)).reason, 'LOCATION_NOT_FOUND');
    assert.equal(await GoogleAioRun.countDocuments({ projectId }), 0, 'a refused start creates nothing');
    const fewer = await startManualRun({ projectId, userId: oid(), questionIds: ['a', 'b', 'c'] }, startDeps(projectId).deps);
    assert.equal(fewer.reason, 'QUESTION_COUNT_INVALID');
    assert.equal((await startManualRun({ projectId, userId: oid() }, startDeps(projectId).deps)).scheduled, true);
    assert.equal((await startManualRun({ projectId, userId: oid() }, startDeps(projectId).deps)).reason, 'ACTIVE_RUN_EXISTS');
    assert.equal(await GoogleAioRun.countDocuments({ projectId }), 1);
  });
  test('a project without a configured country is a clear configuration error, never a guessed location', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const projectId = oid();
    await seedApprovedSet(projectId);
    const res = await startManualRun({ projectId, userId: oid() }, startDeps(projectId, { buildProfile: async (id) => profileFor(id, { project: { ...nashik.project, country: null, verified_business: { placeId: 'p1', name: 'ASG', city: 'Nashik' } } }) }).deps);
    assert.equal(res.reason, 'LOCATION_COUNTRY_MISSING');
  });
});

describe('executing a run', () => {
  async function queued() {
    const { res, projectId } = await startRun();
    const claimed = await claim(res.run._id);
    return { projectId, claimed };
  }

  test('five questions -> five requests -> five evidence documents -> completed with metrics from evidence', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { claimed } = await queued();
    const f = fakeFetch();
    const { deps, events } = workerDeps({ fetch: f.fetch });
    assert.equal(await processClaimedRun(claimed, deps), 'completed');
    assert.equal(f.calls.length, 5);
    assert.equal(new Set(f.calls.map((c) => c.questionId)).size, 5);
    assert.ok(f.calls.every((c) => c.serp.locationCode === 1007740 && c.serp.languageCode === 'en' && c.serp.device === 'desktop'));
    const docs = await GoogleAioEvidence.find({ runId: claimed._id }).sort({ position: 1 }).lean();
    assert.deepEqual(docs.map((d) => d.position), [1, 2, 3, 4, 5]);
    assert.ok(docs.every((d) => d.status === 'succeeded' && d.aiOverview.present === true && d.cost === 0.0112 && d.locationCode === 1007740));
    const run = await GoogleAioRun.findById(claimed._id).lean();
    assert.deepEqual([run.status, run.progress.completed, run.progress.total, run.lockedBy], ['completed', 5, 5, null]);
    assert.equal(run.metrics.aiOverview.count, 5);
    assert.equal(run.metrics.aiOverview.rate, 1);
    assert.equal(run.metrics.brandMention.count, 5);
    assert.equal(run.metrics.websiteCitation.count, 5);
    assert.equal(run.metrics.uniqueCitedPages.count, 1);
    assert.equal(run.metrics.uniqueCitedPages.citationOccurrences, 5);
    assert.deepEqual(run.totalCost, { amount: 0.056, unit: 'USD', unknownCount: 0 });
    // progress: started x5, question_started/completed x5 each, exactly one terminal event, and it is the last one
    const kinds = events.map((e) => e.kind);
    assert.equal(kinds.filter((k) => k === 'question_started').length, 5);
    assert.equal(kinds.filter((k) => k === 'question_completed').length, 5);
    assert.deepEqual(kinds.filter((k) => ['completed', 'partial', 'failed', 'cancelled'].includes(k)), ['completed']);
    assert.equal(kinds.at(-1), 'completed');
    assert.deepEqual(events.filter((e) => e.kind === 'question_completed').map((e) => e.extra.questionIndex).sort(), [1, 2, 3, 4, 5]);
    // the persisted evidence stores request metadata without the keyword or any credential
    assert.ok(!('keyword' in docs[0].request));
    assert.ok(!JSON.stringify(docs[0].request).toLowerCase().includes('authorization'));
  });

  test('a SERP without an AI Overview is a succeeded observation, not a failure', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { claimed } = await queued();
    const f = fakeFetch({ 2: 'none', 4: 'none' });
    assert.equal(await processClaimedRun(claimed, workerDeps({ fetch: f.fetch }).deps), 'completed');
    const docs = await GoogleAioEvidence.find({ runId: claimed._id }).sort({ position: 1 }).lean();
    assert.deepEqual(docs.map((d) => [d.status, d.aiOverview.present]), [['succeeded', true], ['succeeded', false], ['succeeded', true], ['succeeded', false], ['succeeded', true]]);
    assert.deepEqual(docs.map(observationOf), ['ai_overview', 'no_ai_overview', 'ai_overview', 'no_ai_overview', 'ai_overview']);
    const run = await GoogleAioRun.findById(claimed._id).lean();
    assert.deepEqual([run.metrics.aiOverview.count, run.metrics.aiOverview.denominator, run.metrics.aiOverview.rate], [3, 5, 0.6]);
    assert.equal(run.metrics.brandMention.denominator, 3, 'questions without an overview are not in the mention denominator');
  });

  test('an overview without references is excluded from the citation denominator (not counted as uncited)', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { claimed } = await queued();
    const f = fakeFetch({ 1: 'noRefs' });
    await processClaimedRun(claimed, workerDeps({ fetch: f.fetch }).deps);
    const run = await GoogleAioRun.findById(claimed._id).lean();
    assert.deepEqual([run.metrics.websiteCitation.count, run.metrics.websiteCitation.denominator, run.metrics.websiteCitation.excluded], [4, 4, 1]);
  });

  test('one failed question: run is partial, the failure is recorded, nothing replaces it, completed answers are kept', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { claimed } = await queued();
    const f = fakeFetch({ 3: providerError(GOOGLE_AIO_ERROR.TIMEOUT, { retryable: true }) });
    const { deps, events } = workerDeps({ fetch: f.fetch });
    assert.equal(await processClaimedRun(claimed, deps), 'partial');
    assert.equal(f.calls.length, 5, 'still exactly five requests: no replacement question was sent');
    const docs = await GoogleAioEvidence.find({ runId: claimed._id }).sort({ position: 1 }).lean();
    assert.equal(docs.filter((d) => d.status === 'succeeded').length, 4);
    const failed = docs.find((d) => d.status === 'failed');
    assert.deepEqual([failed.errorCode, failed.errorClass, failed.costStatus, failed.cost], [GOOGLE_AIO_ERROR.TIMEOUT, 'retryable', 'unknown', null]);
    assert.equal(observationOf(failed), 'request_failed');
    const run = await GoogleAioRun.findById(claimed._id).lean();
    assert.deepEqual([run.status, run.failureCode, run.questionStats.succeeded, run.questionStats.failed, run.metrics.partial], ['partial', GOOGLE_AIO_ERROR.TIMEOUT, 4, 1, true]);
    assert.equal(run.metrics.aiOverview.denominator, 4, 'the failed question is not in any denominator');
    assert.equal(events.filter((e) => e.kind === 'question_failed').length, 1);
    assert.equal(events.at(-1).kind, 'partial');
  });

  test('a fatal provider error (auth) stops the run: remaining questions are skipped with the reason and are not sent', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { claimed } = await queued();
    const f = fakeFetch({ 1: providerError(GOOGLE_AIO_ERROR.AUTH, { fatal: true }) });
    assert.equal(await processClaimedRun(claimed, workerDeps({ fetch: f.fetch }).deps), 'failed');
    assert.equal(f.calls.length, 1);
    const docs = await GoogleAioEvidence.find({ runId: claimed._id }).sort({ position: 1 }).lean();
    assert.deepEqual(docs.map((d) => d.status), ['failed', 'skipped', 'skipped', 'skipped', 'skipped']);
    // Not sent BECAUSE of the earlier account error: the reason says so, and the cause is the provider error code.
    assert.ok(docs.slice(1).every((d) => d.errorCode === 'NOT_SENT_PROVIDER_ACCOUNT_ERROR' && d.skipCause === GOOGLE_AIO_ERROR.AUTH));
    const run = await GoogleAioRun.findById(claimed._id).lean();
    assert.deepEqual([run.status, run.failureCode], ['failed', GOOGLE_AIO_ERROR.AUTH]);
  });

  test('the run cost guard stops sending once the known cost reaches the limit', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { claimed } = await queued();
    const f = fakeFetch();
    assert.equal(await processClaimedRun(claimed, workerDeps({ fetch: f.fetch, config: cfg({ GOOGLE_AIO_VISIBILITY_MAX_RUN_COST: '0.02' }) }).deps), 'partial');
    assert.equal(f.calls.length, 2);
    const run = await GoogleAioRun.findById(claimed._id).lean();
    assert.equal(run.failureCode, 'COST_LIMIT_REACHED');
  });

  test('cancellation before work starts: nothing is sent', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { claimed } = await queued();
    await runs.requestCancel({ projectId: claimed.projectId, runId: claimed._id });
    const f = fakeFetch();
    assert.equal(await processClaimedRun({ ...claimed, cancelRequested: true }, workerDeps({ fetch: f.fetch }).deps), 'cancelled');
    assert.equal(f.calls.length, 0);
    assert.equal((await GoogleAioRun.findById(claimed._id).lean()).status, 'cancelled');
  });

  test('cancellation requested mid-run: answered questions are kept, the rest are skipped, status cancelled', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { claimed } = await queued();
    const f = fakeFetch();
    const fetch = async (input, o) => {
      const r = await f.fetch(input, o);
      if (f.calls.length === 2) { await runs.requestCancel({ projectId: claimed.projectId, runId: claimed._id }); await new Promise((res) => setTimeout(res, 1500)); } // let one heartbeat (1s) observe it
      return r;
    };
    assert.equal(await processClaimedRun(claimed, workerDeps({ fetch, config: cfg({ GOOGLE_AIO_VISIBILITY_LEASE_MS: '3000' }) }).deps), 'cancelled');
    assert.equal(f.calls.length, 2);
    const docs = await GoogleAioEvidence.find({ runId: claimed._id }).sort({ position: 1 }).lean();
    assert.deepEqual(docs.map((d) => d.status), ['succeeded', 'succeeded', 'cancelled', 'cancelled', 'cancelled']);
    assert.ok(docs.slice(2).every((d) => d.errorCode === 'RUN_CANCELLED'));
    assert.equal((await GoogleAioRun.findById(claimed._id).lean()).status, 'cancelled');
  });

  test('a second worker cannot process a run it does not own: nothing is sent', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { claimed } = await queued();
    const f = fakeFetch();
    assert.equal(await processClaimedRun(claimed, workerDeps({ fetch: f.fetch, workerId: 'worker-B' }).deps), 'lease_lost');
    assert.equal(f.calls.length, 0);
    assert.equal((await GoogleAioRun.findById(claimed._id).lean()).lockedBy, 'worker-A');
    assert.equal(await runs.claimRun({ runId: claimed._id, workerId: 'worker-B', config: cfg() }), null, 'a live lease cannot be claimed');
  });

  test('crash recovery: only the still-pending questions are sent again; answered ones are never repeated', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { claimed } = await queued();
    const f = fakeFetch();
    let completedEvents = 0;
    const crashing = workerDeps({ fetch: f.fetch, emit: (kind) => { if (kind === 'question_completed' && ++completedEvents === 2) throw new Error('boom'); } });
    assert.equal(await processClaimedRun(claimed, crashing.deps), 'crashed');
    assert.equal(f.calls.length, 2);
    await GoogleAioRun.updateOne({ _id: claimed._id }, { $set: { 'lease.expiresAt': new Date(Date.now() - 1000) } });
    const reclaimed = await claim(claimed._id, 'worker-B');
    assert.equal(reclaimed.attempts, 2);
    assert.equal(await processClaimedRun(reclaimed, workerDeps({ fetch: f.fetch, workerId: 'worker-B' }).deps), 'completed');
    assert.equal(f.calls.length, 5, 'two before the crash + three after: five requests in total');
    assert.equal(new Set(f.calls.map((c) => c.questionId)).size, 5);
    assert.equal(await GoogleAioEvidence.countDocuments({ runId: claimed._id }), 5);
  });

  test('claim budget exhausted: the sweep finalizes the run from evidence (answers kept, interrupted failed, rest skipped)', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { claimed } = await queued();
    const f = fakeFetch();
    let n = 0;
    await processClaimedRun(claimed, workerDeps({ fetch: f.fetch, emit: (kind) => { if (kind === 'question_completed' && ++n === 1) throw new Error('boom'); } }).deps);
    await GoogleAioRun.updateOne({ _id: claimed._id }, { $set: { 'lease.expiresAt': new Date(Date.now() - 1000), attempts: 3 } });
    await GoogleAioEvidence.updateOne({ runId: claimed._id, position: 2 }, { $set: { status: 'running', lockedBy: 'dead' } });
    const summary = await sweepOnce({ config: cfg(), drain: async () => 0 });
    assert.equal(summary.finalizedExhausted, 1);
    const run = await GoogleAioRun.findById(claimed._id).lean();
    assert.deepEqual([run.status, run.failureCode], ['partial', 'RUN_ATTEMPTS_EXHAUSTED']);
    const docs = await GoogleAioEvidence.find({ runId: claimed._id }).sort({ position: 1 }).lean();
    assert.deepEqual(docs.map((d) => d.status), ['succeeded', 'failed', 'skipped', 'skipped', 'skipped']);
    assert.equal(docs[1].errorCode, 'WORKER_INTERRUPTED');
  });
});

describe('ownership, isolation and legacy data', () => {
  test('runs and evidence are only visible through their own project id', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { claimed, } = await (async () => { const { res } = await startRun(); return { claimed: await claim(res.run._id) }; })();
    await processClaimedRun(claimed, workerDeps({ fetch: fakeFetch().fetch }).deps);
    const other = oid();
    assert.ok(await runs.getRun({ projectId: claimed.projectId, runId: claimed._id }));
    assert.equal(await runs.getRun({ projectId: other, runId: claimed._id }), null);
    const qid = claimed.questionSnapshot[0].questionId;
    assert.ok(await evidence.getEvidence({ projectId: claimed.projectId, runId: claimed._id, questionId: qid }));
    assert.equal(await evidence.getEvidence({ projectId: other, runId: claimed._id, questionId: qid }), null);
    assert.deepEqual(await evidence.listEvidence({ projectId: other, runId: claimed._id }), []);
    assert.deepEqual(await evidence.listQuestionHistory({ projectId: other, questionId: qid }), []);
    assert.deepEqual((await runs.listRuns({ projectId: other })).items, []);
    assert.equal((await runs.requestCancel({ projectId: other, runId: claimed._id })).result, 'not_found');
  });

  test('legacy ChatGPT runs are never touched, listed or relabelled', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const projectId = oid();
    const legacy = { _id: oid(), projectId, userId: oid(), status: 'completed', executionMode: 'approved_questions', provider: 'chatgpt', metrics: { sentinel: true } };
    await mongoose.connection.db.collection('chatgpt_visibility_runs').insertOne(legacy);
    const { res } = await startRun(projectId);
    const claimed = await claim(res.run._id);
    await processClaimedRun(claimed, workerDeps({ fetch: fakeFetch().fetch }).deps);
    assert.deepEqual(await mongoose.connection.db.collection('chatgpt_visibility_runs').findOne({ _id: legacy._id }), legacy);
    assert.equal(await mongoose.connection.db.collection('chatgpt_visibility_runs').countDocuments({}), 1);
    const { items } = await runs.listRuns({ projectId });
    assert.ok(items.every((r) => r.provider === 'google_aio' && String(r._id) !== String(legacy._id)));
  });

  test('duplicate evidence cannot be created for a (run, question) and ensureEvidence is idempotent', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { res } = await startRun();
    const run = res.run;
    await evidence.ensureEvidence({ run });
    await evidence.ensureEvidence({ run });
    assert.equal(await GoogleAioEvidence.countDocuments({ runId: run._id }), 5);
    const existing = await GoogleAioEvidence.findOne({ runId: run._id }).lean();
    await assert.rejects(() => GoogleAioEvidence.create({ ...existing, _id: oid() }), /duplicate key|E11000/);
    const first = run.questionSnapshot[0].questionId;
    assert.ok(await evidence.claimQuestion({ runId: run._id, questionId: first, workerId: 'a' }));
    assert.equal(await evidence.claimQuestion({ runId: run._id, questionId: first, workerId: 'b' }), null, 'a question is claimed by exactly one worker');
  });
});

describe('DTOs and events expose no secrets', () => {
  test('evidence DTO: allow-listed fields, absent overview vs failure, no lease / provider id / raw payload', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const { res } = await startRun();
    const claimed = await claim(res.run._id);
    await processClaimedRun(claimed, workerDeps({ fetch: fakeFetch({ 2: 'none' }).fetch }).deps);
    const docs = await GoogleAioEvidence.find({ runId: claimed._id }).sort({ position: 1 }).lean();
    const detail = toEvidenceDto(docs[0], { detail: true });
    assert.equal(detail.observation, 'ai_overview');
    assert.ok(detail.overview.text.includes('ASG Eye Hospital'));
    assert.ok(detail.references.every((r) => /^https?:\/\//.test(r.url)), 'only http(s) reference URLs reach the client');
    assert.equal(detail.references.some((r) => /^javascript:/i.test(r.url)), false);
    assert.equal(toEvidenceDto(docs[1], { detail: true }).overview, null);
    assert.equal(toEvidenceDto(docs[1]).observation, 'no_ai_overview');
    const json = JSON.stringify(detail);
    for (const secret of ['lockedBy', 'providerRequestId', '10281234-1234', 'authorization', 'retainUntil']) assert.ok(!json.includes(secret), secret);
  });
  test('socket payload is an allow-list: ids, counters and codes only', () => {
    const run = { _id: oid(), projectId: oid(), status: 'running', progress: { completed: 1, total: 5, stage: 'running' }, questionSetVersion: 2 };
    const p = buildEventPayload(run, { questionId: 'q1', questionIndex: 2, questionText: 'SECRET', answer: 'SECRET', cost: 1, errorCode: 'X' });
    assert.deepEqual(Object.keys(p).sort(), ['completedAt', 'completedQuestions', 'errorCode', 'failureCode', 'projectId', 'questionId', 'questionIndex', 'questionSetVersion', 'runId', 'stage', 'status', 'timestamp', 'totalQuestions']);
    assert.ok(Object.values(EVENTS).every((e) => e.startsWith('google_aio_visibility:')));
  });
});
