import os from 'os';
import crypto from 'crypto';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';
import { getChatGptConfig } from '../config/chatgptConfig.js';
import { executeChatGptPrompt } from '../providers/dataForSeoChatGptProvider.js';
import * as runs from '../services/runService.js';
import { processApprovedRun } from './approvedRunWorker.js';
import { emitVisibilityEvent } from '../services/visibilityEvents.js';
import { buildBusinessProfile } from '../../shared/services/businessProfileService.js';
import { getOrCreatePromptSet } from '../../shared/prompts/services/promptSetService.js';
import { analyzeAnswer, computeVisibilityMetrics } from '../../shared/services/visibilityMetricsService.js';

/**
 * ChatGPT visibility worker: executes ONE run to a terminal state, durably and independently of the SEO audit pipeline.
 *
 *   claim (atomic, leased) -> prepare (profile + versioned prompt set, first claim only) -> execute pending prompts with bounded
 *   concurrency, persisting EACH result before the next is started -> finalize (metrics, cost) -> release the lease.
 *
 * Crash behaviour: a worker that dies stops renewing the lease; after it expires another worker (the recovery sweep) re-claims the
 * run and executes ONLY executions still `pending`. Succeeded and failed executions are final, so successful paid calls are never
 * repeated. The remaining gap is unavoidable without provider idempotency: if the process dies after DataForSEO answered but before
 * the result was written, that one prompt is sent (and billed) again on recovery. No idempotency key is used because the provider
 * behaviour for `tag` is not verified; the tag only labels the request for reconciliation.
 *
 * Concurrency limits are PER PROCESS (in-flight prompts: provider limiter; runs: `active` below). Across several server instances the
 * effective limits multiply; maxGlobalRunning is a best-effort database check, not an atomic cap. No shared limiter infrastructure
 * (Redis etc.) exists in this repository, so none is introduced.
 */

const SERVICE = 'ChatGptVisibilityWorker';
export const WORKER_ID = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;

function sumCost(executions, unit) {
  let amount = 0;
  let known = 0;
  let unknownCount = 0;
  for (const e of executions) {
    if (e.status !== 'succeeded') continue;
    if (typeof e.cost === 'number') { amount += e.cost; known += 1; } else unknownCount += 1;
  }
  return { amount: known > 0 ? Math.round(amount * 1e6) / 1e6 : null, unit: known > 0 ? unit : null, unknownCount };
}

function deriveStatus(executions, { cancelled }) {
  const succeeded = executions.filter((e) => e.status === 'succeeded').length;
  if (cancelled) return 'cancelled';
  if (succeeded === executions.length && executions.length > 0) return 'completed';
  return succeeded > 0 ? 'partial' : 'failed';
}

function buildTarget(profile) {
  return {
    brandNames: [profile.business.name, ...profile.business.aliases].filter(Boolean),
    nameSource: profile.business.nameSource,
    nameVerified: profile.business.nameVerified,
    brandMatchReliable: profile.business.nameReliability?.reliable !== false,
    competitors: profile.business.competitors,
    targetHost: profile.website.targetHost,
  };
}

function buildMarket(profile) {
  const m = profile.market;
  return { scope: m.scope, effectiveScope: m.effectiveScope, city: m.city, state: m.state, country: m.country, countryCode: m.countryCode, language: m.language };
}

function resolveDeps(d = {}) {
  return {
    config: d.config || getChatGptConfig(),
    execute: d.execute || executeChatGptPrompt,
    buildProfile: d.buildProfile || buildBusinessProfile,
    getPromptSet: d.getPromptSet || getOrCreatePromptSet,
    emit: d.emit || emitVisibilityEvent,
    now: d.now || (() => new Date()),
    workerId: d.workerId || WORKER_ID,
    Model: d.Model,
  };
}
const withModel = (d) => (d.Model ? { Model: d.Model } : {});

/** Fail a run this worker owns before/without any provider call (unusable profile, invalid prompts, ...). */
async function failOwned(run, d, code, message) {
  const done = await runs.finalizeRun({
    runId: run._id, workerId: d.workerId, status: 'failed', metrics: null, totalCost: { amount: null, unit: null, unknownCount: 0 },
    failureCode: code, failureMessage: message, now: d.now(), ...withModel(d),
  });
  if (done) d.emit('failed', done);
  return done ? 'failed' : 'lease_lost';
}

/** Execute a run this worker has just claimed. Never throws. */
export async function processClaimedRun(claimed, deps = {}) {
  const d = resolveDeps(deps);
  // Approved-question runs share the claim / lease / recovery machinery but ask a snapshot of questions and write evidence documents.
  if (claimed.executionMode === 'approved_questions') return processApprovedRun(claimed, { ...deps, workerId: d.workerId });
  const { config } = d;
  const runId = String(claimed._id);
  const state = { lost: false, cancel: Boolean(claimed.cancelRequested), fatal: null, costStop: false };

  const heartbeat = setInterval(async () => {
    try {
      const r = await runs.renewLease({ runId, workerId: d.workerId, now: d.now(), config, ...withModel(d) });
      if (!r.owned) state.lost = true;
      if (r.cancelRequested) state.cancel = true;
    } catch (error) {
      LoggerUtil.warn(`${SERVICE}: heartbeat failed`, { runId, code: error?.code }); // a blip: the lease may lapse, in which case a take-over is safe
    }
  }, Math.max(1_000, Math.floor(config.leaseMs / 3)));
  heartbeat.unref?.();

  try {
    let run = claimed;

    // Cancelled before any work began: nothing was sent, nothing needs preparing.
    if (state.cancel && !run.executions?.length) {
      const done = await runs.finalizeRun({
        runId, workerId: d.workerId, status: 'cancelled', metrics: null, totalCost: { amount: null, unit: null, unknownCount: 0 },
        failureCode: 'RUN_CANCELLED', now: d.now(), ...withModel(d),
      });
      if (done) d.emit('failed', done);
      return done ? 'cancelled' : 'lease_lost';
    }

    // ── prepare (first claim only; a recovered run already has its prompt set and executions) ──
    if (!run.executions?.length) {
      let profile;
      try {
        profile = await d.buildProfile(String(run.projectId));
      } catch (error) {
        return await failOwned(run, d, error?.code || 'VISIBILITY_PROFILE_UNAVAILABLE', 'The business profile could not be loaded');
      }
      let promptSet;
      try {
        ({ promptSet } = await d.getPromptSet(profile));
      } catch (error) {
        return await failOwned(run, d, error?.code || 'VISIBILITY_PROMPT_SET_FAILED', error?.code ? error.message : 'Prompts could not be prepared');
      }
      const market = buildMarket(profile);
      const executions = promptSet.prompts.map((p) => ({
        category: p.category, branded: p.branded, promptText: p.text, status: 'pending', attempts: 0,
        model: config.model, webSearch: config.webSearch,
        country: config.webSearch ? market.countryCode : null,
        city: config.webSearch && market.effectiveScope === 'local' ? market.city : null,
      }));
      const ok = await runs.initializeRun({ runId, workerId: d.workerId, promptSet, target: buildTarget(profile), market, executions, ...withModel(d) });
      if (!ok) return 'lease_lost';
      run = { ...run, promptSetId: promptSet._id, executions, target: buildTarget(profile), market, progress: { ...run.progress, total: executions.length, completed: 0 } };
      d.emit('progress', { ...run, status: 'running', progress: { completed: 0, total: executions.length, stage: 'running' } });
    }

    const target = run.target;
    const market = run.market;
    const total = run.executions.length;
    const knownCostAtStart = sumCost(run.executions, config.costUnit).amount ?? 0;
    let spent = knownCostAtStart;

    const settledCount = () => run.executions.filter((e) => e.status !== 'pending').length;

    const persistAndReport = async (category, patch) => {
      const written = await runs.saveExecution({ runId, workerId: d.workerId, category, patch, ...withModel(d) });
      if (!written) { state.lost = true; return; }
      const idx = run.executions.findIndex((e) => e.category === category);
      run.executions[idx] = { ...run.executions[idx], ...patch };
      const totalCost = sumCost(run.executions, config.costUnit);
      await runs.updateProgress({ runId, workerId: d.workerId, completed: settledCount(), total, stage: 'running', totalCost, ...withModel(d) });
      d.emit('progress', { _id: run._id, projectId: run.projectId, auditRunId: run.auditRunId, status: 'running', progress: { completed: settledCount(), total, stage: 'running' } });
    };

    const runOne = async (exec) => {
      if (state.lost) return;
      if (state.cancel) return; // left pending; finalization turns it into a skip
      if (state.fatal) return;
      if (config.maxRunCost > 0 && spent >= config.maxRunCost) { state.costStop = true; return; }

      const startedAt = d.now();
      try {
        const result = await d.execute({ prompt: exec.promptText, market, tag: `odito-cgv:${runId}:${exec.category}` }, { config });
        if (typeof result.cost === 'number') spent += result.cost;
        await persistAndReport(exec.category, {
          status: 'succeeded',
          attempts: (exec.attempts || 0) + (result.attempts || 1),
          providerRequestId: result.requestId,
          model: result.model || config.model,
          answerText: result.answerText,
          annotations: result.annotations,
          analysis: analyzeAnswer(result, target),
          cost: result.cost,
          usage: { inputTokens: result.usage?.inputTokens ?? null, outputTokens: result.usage?.outputTokens ?? null },
          errorCode: null,
          retryable: null,
          executedAt: startedAt,
          durationMs: result.durationMs ?? null,
        });
      } catch (error) {
        const code = error?.code && String(error.code).startsWith('CHATGPT_') ? error.code : 'CHATGPT_UNEXPECTED_ERROR';
        if (error?.fatal) state.fatal = code;
        await persistAndReport(exec.category, {
          status: 'failed',
          attempts: (exec.attempts || 0) + (error?.attempts || 1),
          errorCode: code,
          retryable: Boolean(error?.retryable),
          executedAt: startedAt,
        });
      }
    };

    // Bounded in-run concurrency; guards are re-checked immediately before each request is sent.
    const queue = run.executions.filter((e) => e.status === 'pending');
    const lanes = Array.from({ length: Math.min(config.maxConcurrentPrompts, queue.length) }, async () => {
      while (queue.length && !state.lost) await runOne(queue.shift());
    });
    await Promise.all(lanes);

    if (state.lost) return 'lease_lost';

    // Anything still pending was deliberately not sent: record why, never leave it ambiguous.
    const skipCode = state.cancel ? 'RUN_CANCELLED' : (state.fatal || (state.costStop ? 'COST_LIMIT_REACHED' : null));
    for (const e of run.executions.filter((x) => x.status === 'pending')) {
      await persistAndReport(e.category, { status: 'skipped', errorCode: skipCode || 'NOT_EXECUTED', executedAt: d.now() });
      if (state.lost) return 'lease_lost';
    }

    // ── finalize ──
    const status = deriveStatus(run.executions, { cancelled: state.cancel });
    const firstFailure = run.executions.find((e) => e.status === 'failed')?.errorCode;
    const metrics = computeVisibilityMetrics(run.executions, target);
    const finalDoc = await runs.finalizeRun({
      runId, workerId: d.workerId, status, metrics, totalCost: sumCost(run.executions, config.costUnit),
      failureCode: status === 'failed' ? (state.fatal || firstFailure || 'ALL_EXECUTIONS_FAILED') : (status === 'partial' ? (state.fatal || (state.costStop ? 'COST_LIMIT_REACHED' : null)) : null),
      now: d.now(), ...withModel(d),
    });
    if (!finalDoc) return 'lease_lost';
    d.emit(status === 'failed' ? 'failed' : 'completed', finalDoc);
    return status;
  } catch (error) {
    LoggerUtil.error(`${SERVICE}: run crashed`, { runId, message: error?.message?.slice(0, 200) });
    // Leave the run `running`: the lease lapses and the recovery sweep re-claims it within the claim budget.
    return 'crashed';
  } finally {
    clearInterval(heartbeat);
  }
}

/** Claim one run (a specific one, or the next eligible) and process it. */
export async function processRun({ runId = null, ...deps } = {}) {
  const d = resolveDeps(deps);
  const claimed = await runs.claimRun({ runId, workerId: d.workerId, now: d.now(), config: d.config, ...withModel(d) });
  if (!claimed) return 'not_claimed';
  return processClaimedRun(claimed, deps);
}

// ── in-process dispatch ────────────────────────────────────────────────────────────────────────────────────────────────────
let active = 0;
export const activeRunCount = () => active;

/** Start processing a freshly queued run without waiting for the next sweep. A latency optimisation only: durability is the database. */
export function kick(runId, deps = {}) {
  const config = deps.config || getChatGptConfig();
  if (!config.enabled || active >= config.maxConcurrentRuns) return false;
  active += 1;
  setImmediate(() => {
    processRun({ runId, ...deps })
      .catch((error) => LoggerUtil.error(`${SERVICE}: kick failed`, { message: error?.message?.slice(0, 200) }))
      .finally(() => { active -= 1; });
  });
  return true;
}

/** Claim and start queued / lease-expired runs while capacity allows (called by the sweep). */
export async function drainQueue(deps = {}) {
  const d = resolveDeps(deps);
  let started = 0;
  while (d.config.enabled && active < d.config.maxConcurrentRuns) {
    const live = await runs.countLiveRunning({ now: d.now(), ...withModel(d) });
    if (live >= d.config.maxGlobalRunning) break;
    const claimed = await runs.claimRun({ workerId: d.workerId, now: d.now(), config: d.config, ...withModel(d) });
    if (!claimed) break;
    active += 1;
    started += 1;
    processClaimedRun(claimed, deps).finally(() => { active -= 1; });
  }
  return started;
}

export default { processRun, processClaimedRun, kick, drainQueue, WORKER_ID };
