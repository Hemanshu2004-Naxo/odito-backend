import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import ChatGptVisibilityRun from '../models/ChatGptVisibilityRun.js';
import AiVisibilityPromptSet from '../../shared/prompts/models/AiVisibilityPromptSet.js';
import * as runs from '../services/runService.js';
import { processClaimedRun } from '../workers/runWorker.js';
import { runOnce as sweepOnce } from '../workers/recoveryScheduler.js';
import { getChatGptConfig } from '../config/chatgptConfig.js';
import { ChatGptProviderError, CHATGPT_ERROR } from '../providers/dataForSeoChatGptProvider.js';
import { buildEventPayload, emitVisibilityEvent } from '../services/visibilityEvents.js';
import { getOrCreatePromptSet } from '../../shared/prompts/services/promptSetService.js';
import { generatePromptSet } from '../../shared/prompts/services/promptGenerationService.js';
import { resetProjectCrawlData } from '../../../app_user/service/projectAuditService.js';
import SeoProject from '../../../app_user/model/SeoProject.js';
import { makeProfile } from '../../shared/tests/fixtures.js';
import { connectTestDb, disconnectTestDb, dropTestCollections } from '../../shared/tests/testDb.js';

let up = false;
before(async () => {
  up = await connectTestDb();
  if (up) await Promise.all([ChatGptVisibilityRun.syncIndexes(), AiVisibilityPromptSet.syncIndexes()]);
});
after(async () => { if (up) await dropTestCollections(['chatgpt_visibility_runs', 'ai_visibility_prompt_sets', 'seoprojects', 'jobs']); await disconnectTestDb(); });
beforeEach(async () => { if (up) await dropTestCollections(['chatgpt_visibility_runs', 'ai_visibility_prompt_sets']); });

const oid = () => new mongoose.Types.ObjectId();
const cfg = (o = {}) => getChatGptConfig({
  CHATGPT_VISIBILITY_ENABLED: 'true', CHATGPT_VISIBILITY_MAX_CONCURRENT_PROMPTS: '1', CHATGPT_VISIBILITY_LEASE_MS: '60000',
  CHATGPT_VISIBILITY_MAX_CLAIMS: '3', CHATGPT_VISIBILITY_MAX_RUN_COST: '1', ...o,
});
const promptCfg = { useOpenAi: false, apiKey: '', repairAttempts: 1, fallbackReuseMs: 1000 };
const profileFor = (projectId, over) => ({ ...makeProfile(over), projectId: String(projectId) });

function workerDeps({ execute, config = cfg(), workerId = 'worker-A', now, profileOver, emit } = {}) {
  const events = [];
  return {
    events,
    deps: {
      config,
      workerId,
      execute,
      now,
      emit: emit || ((kind, run) => events.push({ kind, run })),
      buildProfile: async (id) => profileFor(id, profileOver),
      getPromptSet: (profile) => getOrCreatePromptSet(profile, { generate: (p) => generatePromptSet(p, { provider: { isAvailable: () => false }, config: promptCfg }), config: promptCfg }),
    },
  };
}

/** A provider stand-in. plan: category -> 'ok' | Error | {cost}. Records every call. */
function fakeProvider(plan = {}, defaults = { cost: 0.01 }) {
  const calls = [];
  const execute = async ({ prompt, tag }) => {
    const category = tag.split(':')[2];
    calls.push(category);
    const step = plan[category] ?? 'ok';
    if (step instanceof Error) throw step;
    const cost = typeof step === 'object' ? step.cost : defaults.cost;
    return {
      answerText: `ASG Eye Hospital answer for ${category}. SECRET-ANSWER-TEXT`,
      annotations: [{ title: 't', url: 'https://www.asgeye.example/page?utm_source=chatgpt.com' }],
      cost, requestId: `req-${category}`, model: 'gpt-4o-mini', usage: { inputTokens: 1, outputTokens: 2 }, attempts: 1, durationMs: 5, prompt,
    };
  };
  return { calls, execute };
}
const providerError = (code, retryable = false, fatal = false) => Object.assign(new ChatGptProviderError(code), { retryable, fatal, attempts: 1 });

const newRun = async (projectId = oid(), over = {}) => (await runs.createRun({ projectId, userId: oid(), auditRunId: oid(), triggerSource: 'audit', auditRunSource: 'initial_audit', ...over })).run;
const claim = (runId, workerId = 'worker-A', extra = {}) => runs.claimRun({ runId, workerId, config: cfg(), ...extra });

describe('run creation: duplicate prevention', () => {
  test('one run per (project, auditRunId); a second active run per project is refused', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const projectId = oid(); const auditRunId = oid(); const userId = oid();
    const first = await runs.createRun({ projectId, userId, auditRunId, triggerSource: 'audit' });
    assert.equal(first.created, true);
    const dup = await runs.createRun({ projectId, userId, auditRunId, triggerSource: 'audit' });
    assert.deepEqual([dup.created, dup.duplicate], [false, true]);
    assert.equal(String(dup.run._id), String(first.run._id));
    const other = await runs.createRun({ projectId, userId, auditRunId: oid(), triggerSource: 'audit' });
    assert.equal(other.created, false);
    assert.equal(String(other.activeRun._id), String(first.run._id));
    // a different project is unaffected; manual runs (no auditRunId) are allowed once the previous one is finished
    assert.equal((await runs.createRun({ projectId: oid(), userId, auditRunId, triggerSource: 'audit' })).created, true);
    await ChatGptVisibilityRun.updateOne({ _id: first.run._id }, { $set: { status: 'completed' } });
    assert.equal((await runs.createRun({ projectId, userId, auditRunId: null, triggerSource: 'manual' })).created, true);
    assert.equal(await ChatGptVisibilityRun.countDocuments({ projectId }), 2);
  });

  test('50 simultaneous creates for the same audit run yield exactly one document', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const projectId = oid(); const auditRunId = oid(); const userId = oid();
    const results = await Promise.all(Array.from({ length: 50 }, () => runs.createRun({ projectId, userId, auditRunId, triggerSource: 'audit' })));
    assert.equal(results.filter((r) => r.created).length, 1);
    assert.equal(await ChatGptVisibilityRun.countDocuments({ projectId }), 1);
  });
});

describe('claiming and leases', () => {
  test('concurrent claimers: exactly one wins', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const run = await newRun();
    const claims = await Promise.all(Array.from({ length: 12 }, (_, i) => claim(run._id, `worker-${i}`)));
    assert.equal(claims.filter(Boolean).length, 1);
    const stored = await ChatGptVisibilityRun.findById(run._id).lean();
    assert.equal(stored.status, 'running');
    assert.equal(stored.attempts, 1);
    assert.ok(stored.startedAt && stored.lease.expiresAt > new Date());
  });

  test('a live lease cannot be taken over; an expired one can, and the old owner can no longer write', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const run = await newRun();
    const a = await claim(run._id, 'worker-A');
    assert.ok(a);
    assert.equal(await claim(run._id, 'worker-B'), null); // lease valid
    const later = new Date(Date.now() + 120_000);
    const b = await claim(run._id, 'worker-B', { now: later });
    assert.ok(b);
    assert.equal(b.attempts, 2);
    assert.equal(b.lockedBy, 'worker-B');
    assert.equal((await runs.renewLease({ runId: run._id, workerId: 'worker-A' })).owned, false);
    assert.equal((await runs.renewLease({ runId: run._id, workerId: 'worker-B' })).owned, true);
  });

  test('the claim budget bounds crash loops', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const run = await newRun();
    let now = new Date();
    for (let i = 0; i < 3; i += 1) { assert.ok(await claim(run._id, `w${i}`, { now })); now = new Date(now.getTime() + 120_000); }
    assert.equal(await claim(run._id, 'w-late', { now }), null);
  });
});

describe('worker: execution outcomes', () => {
  test('all five succeed -> completed; each result persisted; metrics and cost recorded', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const run = await newRun();
    const provider = fakeProvider();
    const { deps, events } = workerDeps({ execute: provider.execute });
    const outcome = await processClaimedRun(await claim(run._id), deps);
    assert.equal(outcome, 'completed');
    const stored = await ChatGptVisibilityRun.findById(run._id).lean();
    assert.equal(stored.status, 'completed');
    assert.equal(stored.executions.length, 5);
    assert.ok(stored.executions.every((e) => e.status === 'succeeded' && e.answerText && e.cost === 0.01 && e.analysis));
    assert.equal(stored.lockedBy, null);
    assert.equal(stored.lease.expiresAt, null);
    assert.equal(stored.progress.completed, 5);
    assert.equal(stored.totalCost.amount, 0.05);
    assert.equal(stored.totalCost.unit, 'provider_reported'); // the API states no currency
    assert.equal(stored.metrics.overall.executionSuccessRate, 1);
    assert.equal(stored.metrics.overall.brandMentionRate, 1);
    assert.equal(stored.metrics.overall.uniqueCitedPages, 1);
    assert.equal(stored.metrics.overall.citationOccurrences, 5);
    assert.equal(stored.promptSetVersion, 1);
    assert.deepEqual(provider.calls.sort(), ['brand_recognition', 'competitor_comparison', 'industry_discovery', 'local_market_intent', 'service_discovery']);
    assert.equal(events.at(-1).kind, 'completed');
  });

  test('missing provider cost is recorded as unknown, never as zero', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const run = await newRun();
    const provider = fakeProvider({ industry_discovery: { cost: null }, service_discovery: { cost: null } });
    const { deps } = workerDeps({ execute: provider.execute });
    await processClaimedRun(await claim(run._id), deps);
    const stored = await ChatGptVisibilityRun.findById(run._id).lean();
    assert.equal(stored.totalCost.unknownCount, 2);
    assert.equal(stored.totalCost.amount, 0.03);
    assert.equal(stored.executions.find((e) => e.category === 'industry_discovery').cost, null);
  });

  test('partial: 3 of 5 succeed -> partial; rates use 3 responses; failures are not zero visibility', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const run = await newRun();
    const provider = fakeProvider({ brand_recognition: providerError(CHATGPT_ERROR.TIMEOUT, true), local_market_intent: providerError(CHATGPT_ERROR.UNAVAILABLE, true) });
    const { deps } = workerDeps({ execute: provider.execute });
    assert.equal(await processClaimedRun(await claim(run._id), deps), 'partial');
    const stored = await ChatGptVisibilityRun.findById(run._id).lean();
    assert.equal(stored.status, 'partial');
    assert.equal(stored.metrics.partial, true);
    assert.equal(stored.metrics.overall.attempted, 5);
    assert.equal(stored.metrics.overall.succeeded, 3);
    assert.equal(stored.metrics.overall.executionSuccessRate, 0.6);
    assert.equal(stored.metrics.overall.brandMentionRate, 1); // 3 of 3 successful answers, not 3 of 5
    const failed = stored.executions.filter((e) => e.status === 'failed');
    assert.deepEqual(failed.map((e) => e.errorCode).sort(), ['CHATGPT_PROVIDER_UNAVAILABLE', 'CHATGPT_TIMEOUT']);
    assert.ok(failed.every((e) => e.answerText === null && e.retryable === true));
  });

  test('every prompt fails -> failed, with the first error code; nothing is zero-scored', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const run = await newRun();
    const err = providerError(CHATGPT_ERROR.REQUEST_REJECTED);
    const provider = fakeProvider(Object.fromEntries(['industry_discovery', 'service_discovery', 'brand_recognition', 'competitor_comparison', 'local_market_intent'].map((c) => [c, err])));
    const { deps, events } = workerDeps({ execute: provider.execute });
    assert.equal(await processClaimedRun(await claim(run._id), deps), 'failed');
    const stored = await ChatGptVisibilityRun.findById(run._id).lean();
    assert.equal(stored.status, 'failed');
    assert.equal(stored.failureCode, CHATGPT_ERROR.REQUEST_REJECTED);
    assert.equal(stored.metrics.overall.brandMentionRate, null);
    assert.equal(stored.metrics.overall.executionSuccessRate, 0);
    assert.equal(stored.failedAt instanceof Date, true);
    assert.equal(events.at(-1).kind, 'failed');
  });

  test('an account-level error (auth) stops the run: no further paid requests, the rest are skipped', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const run = await newRun();
    const provider = fakeProvider({ industry_discovery: providerError(CHATGPT_ERROR.AUTH, false, true) });
    const { deps } = workerDeps({ execute: provider.execute });
    assert.equal(await processClaimedRun(await claim(run._id), deps), 'failed');
    assert.equal(provider.calls.length, 1);
    const stored = await ChatGptVisibilityRun.findById(run._id).lean();
    assert.equal(stored.failureCode, CHATGPT_ERROR.AUTH);
    assert.equal(stored.executions.filter((e) => e.status === 'skipped').length, 4);
    assert.ok(stored.executions.filter((e) => e.status === 'skipped').every((e) => e.errorCode === CHATGPT_ERROR.AUTH));
    assert.equal(stored.metrics.overall.attempted, 1);
  });

  test('the cost guard stops scheduling once the known cost reaches the limit', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const run = await newRun();
    const provider = fakeProvider({}, { cost: 0.015 });
    const { deps } = workerDeps({ execute: provider.execute, config: cfg({ CHATGPT_VISIBILITY_MAX_RUN_COST: '0.02' }) });
    assert.equal(await processClaimedRun(await claim(run._id), deps), 'partial');
    assert.equal(provider.calls.length, 2);
    const stored = await ChatGptVisibilityRun.findById(run._id).lean();
    assert.equal(stored.failureCode, 'COST_LIMIT_REACHED');
    assert.equal(stored.executions.filter((e) => e.status === 'skipped' && e.errorCode === 'COST_LIMIT_REACHED').length, 3);
    assert.equal(stored.metrics.overall.attempted, 2);
  });

  test('an unusable profile fails the run without a single provider call', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const run = await newRun();
    const provider = fakeProvider();
    const { deps } = workerDeps({ execute: provider.execute, profileOver: { project: { industry: null }, social: null } });
    assert.equal(await processClaimedRun(await claim(run._id), deps), 'failed');
    assert.equal(provider.calls.length, 0);
    const stored = await ChatGptVisibilityRun.findById(run._id).lean();
    assert.equal(stored.failureCode, 'VISIBILITY_INSUFFICIENT_PROFILE');
    assert.equal(stored.executions.length, 0);
  });
});

describe('recovery: successful paid prompts are never repeated', () => {
  test('a crashed run is re-claimed after lease expiry and only pending prompts are sent', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const run = await newRun();
    // Worker A prepares and completes two prompts, then "crashes" (never finalizes, never renews).
    const first = fakeProvider();
    let sent = 0;
    const crashing = async (args) => { sent += 1; if (sent > 2) throw new Error('process died'); return first.execute(args); };
    const a = workerDeps({ execute: crashing, workerId: 'worker-A' });
    await processClaimedRun(await claim(run._id, 'worker-A'), { ...a.deps, execute: crashing });
    // the simulated death surfaced as failed executions; reset those to pending to model "the process died mid-flight"
    await ChatGptVisibilityRun.updateOne({ _id: run._id }, { $set: { status: 'running', lockedBy: 'worker-A', 'lease.expiresAt': new Date(Date.now() - 1000), 'executions.$[f].status': 'pending', 'executions.$[f].errorCode': null, 'executions.$[f].attempts': 0 } }, { arrayFilters: [{ 'f.status': 'failed' }] });
    const before = await ChatGptVisibilityRun.findById(run._id).lean();
    const done = before.executions.filter((e) => e.status === 'succeeded').map((e) => e.category);
    assert.equal(done.length, 2);

    const second = fakeProvider();
    const b = workerDeps({ execute: second.execute, workerId: 'worker-B' });
    const reclaimed = await runs.claimRun({ runId: run._id, workerId: 'worker-B', config: cfg() });
    assert.ok(reclaimed);
    assert.equal(reclaimed.attempts, 2);
    assert.equal(await processClaimedRun(reclaimed, b.deps), 'completed');

    assert.equal(second.calls.length, 3);
    assert.ok(second.calls.every((c) => !done.includes(c)), 'a prompt that already succeeded was sent again');
    const stored = await ChatGptVisibilityRun.findById(run._id).lean();
    assert.equal(stored.status, 'completed');
    assert.equal(stored.promptSetVersion, 1); // prompt set not regenerated
    assert.equal(await AiVisibilityPromptSet.countDocuments({ projectId: run.projectId }), 1);
    for (const e of before.executions.filter((x) => x.status === 'succeeded')) {
      assert.equal(stored.executions.find((x) => x.category === e.category).providerRequestId, e.providerRequestId);
    }
  });

  test('a worker that lost its lease writes nothing and does not finalize', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const run = await newRun();
    const a = await claim(run._id, 'worker-A');
    // Another instance takes the run over while worker A is mid-call.
    const provider = {
      calls: 0,
      async execute(args) {
        this.calls += 1;
        await ChatGptVisibilityRun.updateOne({ _id: run._id }, { $set: { lockedBy: 'worker-B' } });
        return fakeProvider().execute(args);
      },
    };
    const { deps } = workerDeps({ execute: (args) => provider.execute(args), workerId: 'worker-A' });
    assert.equal(await processClaimedRun(a, deps), 'lease_lost');
    const stored = await ChatGptVisibilityRun.findById(run._id).lean();
    assert.equal(stored.status, 'running');
    assert.equal(stored.lockedBy, 'worker-B');
    assert.equal(stored.executions.filter((e) => e.status === 'succeeded').length, 0);
    assert.equal(provider.calls, 1); // it stopped after discovering the loss
  });

  test('the sweep finalizes a run whose claims are exhausted, keeping completed prompts and skipping the rest', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const run = await newRun();
    const stuckExecutions = ['industry_discovery', 'service_discovery', 'brand_recognition', 'competitor_comparison', 'local_market_intent'].map((category, i) => ({
      category, branded: i === 2 || i === 3, promptText: `prompt ${i} text long enough`, status: i < 2 ? 'succeeded' : 'pending',
      ...(i < 2 ? { answerText: 'ASG Eye Hospital here', annotations: [], cost: 0.01, attempts: 1, analysis: { brandMentioned: true, brandMentionCount: 1, competitorMentions: [], citationCount: 0, targetCitationCount: 0, targetPages: [], citations: [] } } : {}),
    }));
    await ChatGptVisibilityRun.updateOne({ _id: run._id }, { $set: {
      status: 'running', lockedBy: 'dead', attempts: 3, 'lease.expiresAt': new Date(Date.now() - 1000), executions: stuckExecutions,
      target: { brandNames: ['ASG Eye Hospital'], competitors: [], targetHost: 'asgeye.example', brandMatchReliable: true, nameVerified: true },
    } });
    const summary = await sweepOnce({ config: cfg(), drain: async () => 0, repair: async () => 0 });
    assert.equal(summary.finalizedExhausted, 1);
    const stored = await ChatGptVisibilityRun.findById(run._id).lean();
    assert.equal(stored.status, 'partial');
    assert.equal(stored.failureCode, 'RUN_ATTEMPTS_EXHAUSTED');
    assert.equal(stored.executions.filter((e) => e.status === 'skipped').length, 3);
    assert.equal(stored.metrics.overall.succeeded, 2);
    assert.equal(stored.lockedBy, null);
    assert.equal(stored.totalCost.amount, 0.02);
  });

  test('the sweep starts queued runs and leaves live leases alone', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const live = await newRun();
    const queued = await newRun(oid());
    await claim(live._id, 'worker-live');
    const claimedByDrain = [];
    const summary = await sweepOnce({
      config: cfg(), repair: async () => 0,
      drain: async () => {
        for (;;) { const c = await runs.claimRun({ workerId: 'drain', config: cfg() }); if (!c) break; claimedByDrain.push(String(c._id)); }
        return claimedByDrain.length;
      },
    });
    assert.equal(summary.started, 1);
    assert.deepEqual(claimedByDrain, [String(queued._id)]);
    assert.equal((await ChatGptVisibilityRun.findById(live._id).lean()).lockedBy, 'worker-live');
  });
});

describe('cancellation', () => {
  test('queued -> cancelled at once; running -> finalized as cancelled with completed prompts kept; scoped to the project', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const queued = await newRun();
    const r1 = await runs.requestCancel({ projectId: queued.projectId, runId: queued._id });
    assert.equal(r1.result, 'cancelled');
    assert.equal((await runs.requestCancel({ projectId: oid(), runId: queued._id })).result, 'not_found'); // another project's id cannot reach it

    const running = await newRun();
    const claimed = await claim(running._id);
    assert.equal((await runs.requestCancel({ projectId: running.projectId, runId: running._id })).result, 'cancel_requested');
    const provider = fakeProvider();
    const { deps } = workerDeps({ execute: provider.execute });
    const claimedWithFlag = { ...claimed, cancelRequested: true };
    assert.equal(await processClaimedRun(claimedWithFlag, deps), 'cancelled');
    assert.equal(provider.calls.length, 0);
    const stored = await ChatGptVisibilityRun.findById(running._id).lean();
    assert.equal(stored.status, 'cancelled');
    assert.equal(stored.lockedBy, null);
    assert.equal((await runs.requestCancel({ projectId: running.projectId, runId: running._id })).result, 'not_cancellable');
  });
});

describe('independence from the SEO audit', () => {
  test('a recrawl reset (which deletes all project jobs) leaves runs and prompt sets untouched', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const project = await SeoProject.create({ user_id: oid(), project_name: 'Recrawl Independence', main_url: 'https://example.com', keywords: ['k'], seo_scope: 'national' });
    const run = await newRun(project._id);
    const { deps } = workerDeps({ execute: fakeProvider().execute });
    await processClaimedRun(await claim(run._id), deps);
    assert.equal(await ChatGptVisibilityRun.countDocuments({ projectId: project._id }), 1);
    assert.equal(await AiVisibilityPromptSet.countDocuments({ projectId: project._id }), 1);

    await resetProjectCrawlData(String(project._id));

    assert.equal((await ChatGptVisibilityRun.findOne({ projectId: project._id }).lean()).status, 'completed');
    assert.equal(await AiVisibilityPromptSet.countDocuments({ projectId: project._id }), 1);
  });

  test('project deletion purges both collections (cascade registry)', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../../../app_user/service/projectCascadeDeleteService.js', import.meta.url), 'utf8');
    assert.match(src, /collection: 'chatgpt_visibility_runs', field: 'projectId'/);
    assert.match(src, /collection: 'ai_visibility_prompt_sets', field: 'projectId'/);
  });

  test('the SEO pipeline definition does not know about the feature', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const f of ['../../../jobs/pipelineConfig.js', '../../../jobs/chainingEngine.js', '../../../jobs/model/Job.js']) {
      const src = await readFile(new URL(f, import.meta.url), 'utf8');
      assert.doesNotMatch(src, /chatgpt/i, f);
    }
  });
});

describe('socket events', () => {
  test('payloads are allow-listed: no answers, prompts, annotations, costs or lease data', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const run = await newRun();
    const emitted = [];
    const rooms = [];
    global.io = { to: (room) => { rooms.push(room); return { emit: (event, payload) => emitted.push({ event, payload }) }; } };
    try {
      const { deps } = workerDeps({ execute: fakeProvider().execute, emit: emitVisibilityEvent });
      await processClaimedRun(await claim(run._id), deps);
    } finally { delete global.io; }
    assert.ok(emitted.length >= 6); // 5 progress (+1 prepare) and a completion
    assert.equal(emitted.at(-1).event, 'chatgpt_visibility:completed');
    assert.ok(emitted.some((e) => e.event === 'chatgpt_visibility:progress'));
    assert.ok(rooms.every((r) => r === `project-${run.projectId}`));
    const allowed = new Set(['projectId', 'runId', 'auditRunId', 'status', 'stage', 'completedPrompts', 'totalPrompts', 'completedAt', 'failureCode', 'timestamp']);
    for (const { payload } of emitted) {
      for (const key of Object.keys(payload)) assert.ok(allowed.has(key), `unexpected socket field: ${key}`);
      const dump = JSON.stringify(payload);
      assert.ok(!dump.includes('SECRET-ANSWER-TEXT') && !dump.includes('asgeye') && !/lockedBy|lease|cost/i.test(dump));
    }
    assert.equal(buildEventPayload({ _id: 'r', projectId: 'p', answerText: 'leak', executions: [{ answerText: 'leak' }] }).answerText, undefined);
  });

  test('emitting without a socket server never throws', () => {
    delete global.io;
    assert.equal(emitVisibilityEvent('started', { _id: 'r', projectId: 'p' }), false);
  });
});
