import os from 'os';
import crypto from 'crypto';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';
import { getGoogleAioConfig, QUESTIONS_PER_RUN } from '../config/googleAioConfig.js';
import { fetchGoogleAiOverview } from '../provider/googleAioProvider.js';
import { GOOGLE_AIO_ERROR } from '../provider/providerErrors.js';
import * as runs from '../services/runService.js';
import * as evidence from '../services/evidenceService.js';
import { emitGoogleAioEvent } from '../services/events.js';
import { analyzeOverview, ANALYSIS_VERSION } from '../analysis/overviewAnalysis.js';
import { computeRunMetrics } from '../analysis/metrics.js';
import { requestMetadata } from '../provider/requestBuilder.js';
import { buildBusinessProfile } from '../../shared/services/businessProfileService.js';
import { findMentions, normalizeForMatching } from '../../shared/services/brandMatchingService.js';
import { normalizeHost } from '../../shared/services/citationNormalizationService.js';
import { containsUrlLike } from '../../shared/utils/text.js';

/**
 * Executes ONE Google AI Overview run to a terminal state, durably and independently of the SEO audit pipeline.
 *
 *   claim (atomic, leased) -> prepare (target from the profile, five evidence documents) -> send each PENDING question once with
 *   bounded concurrency, persisting each result before progress is reported -> metrics from persisted evidence -> finalize.
 *
 * Exactly five questions: the run's snapshot has five entries (schema-enforced), `ensureEvidence` creates five documents (unique
 * index), and a question is sent only after its document is atomically moved pending -> running by this worker. A failed question is
 * recorded as failed; it is never replaced by another question and never retried beyond the provider's bounded transient retries.
 * Completed questions are never re-sent because a later one failed or because the run was recovered.
 *
 * Crash behaviour: a dead worker stops renewing the lease; another worker re-claims the run (within maxClaims), keeps the target the
 * run started with, resets questions that were `running` to `pending` and asks ONLY what is still pending. Residual risk: a question
 * whose provider response arrived but was not yet written is asked (and billed) again on recovery.
 *
 * Limits are PER PROCESS (provider limiter, active runs); maxGlobalRunning is a best-effort database check, not a distributed lock.
 */

const SERVICE = 'GoogleAioVisibilityWorker';
export const WORKER_ID = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;

export function buildTarget(profile) {
  const host = profile.website.targetHost;
  return {
    brandNames: [profile.business.name, ...profile.business.aliases].filter(Boolean),
    nameSource: profile.business.nameSource,
    nameVerified: profile.business.nameVerified,
    brandMatchReliable: profile.business.nameReliability?.reliable !== false,
    competitors: profile.business.competitors,
    targetHost: host,
    // The verified domain policy: only the verified host itself (www-insensitive) is "owned"; subdomains are not.
    ownedHosts: host ? [host] : [],
  };
}

export function buildMarket(profile) {
  const m = profile.market;
  return { scope: m.scope, effectiveScope: m.effectiveScope, city: m.city, state: m.state, country: m.country, countryCode: m.countryCode, language: m.language };
}

/** Last gate before a PAID request: the question must not name the tracked business, a competitor, the website or carry a URL. */
export function blockedQuestionReason(text, target) {
  const names = (target.brandNames || []).filter((n, i) => n && !(i === 0 && target.brandMatchReliable === false));
  if (findMentions(text, names).length) return 'BRAND_IN_QUESTION';
  if (findMentions(text, target.competitors || []).length) return 'COMPETITOR_IN_QUESTION';
  const host = normalizeHost(target.targetHost || '');
  if (host && ` ${normalizeForMatching(text)} `.includes(` ${normalizeForMatching(host)} `)) return 'DOMAIN_IN_QUESTION';
  if (containsUrlLike(text)) return 'URL_IN_QUESTION';
  return null;
}

export const retainUntilFor = (config, now) => (config.evidenceRetentionDays > 0 ? new Date(now.getTime() + config.evidenceRetentionDays * 86_400_000) : null);

function resolveDeps(d = {}) {
  return {
    config: d.config || getGoogleAioConfig(),
    fetch: d.fetch || fetchGoogleAiOverview,
    buildProfile: d.buildProfile || buildBusinessProfile,
    emit: d.emit || emitGoogleAioEvent,
    now: d.now || (() => new Date()),
    workerId: d.workerId || WORKER_ID,
    Model: d.Model,
    EvidenceModel: d.EvidenceModel,
  };
}
const withModel = (d) => (d.Model ? { Model: d.Model } : {});
const withEv = (d) => (d.EvidenceModel ? { Model: d.EvidenceModel } : {});

const deriveStatus = ({ succeeded, total }, cancelled) => {
  if (cancelled) return 'cancelled';
  if (total > 0 && succeeded === total) return 'completed';
  return succeeded > 0 ? 'partial' : 'failed';
};
const totalCostOf = (counters, unit) => ({ amount: counters.cost.amount, unit: counters.cost.amount !== null ? unit : null, unknownCount: counters.cost.unknownCount });
const errorClassOf = (error) => {
  if (error?.fatal) return 'fatal';
  if (error?.code === GOOGLE_AIO_ERROR.MALFORMED_RESPONSE) return 'parse';
  return error?.retryable ? 'retryable' : 'non_retryable';
};
const eventExtra = (counters, extra = {}) => ({ succeeded: counters?.stats.succeeded, failed: counters?.stats.failed, skipped: counters?.stats.skipped, pending: counters?.stats.pending, ...extra });

async function summarizeRun(run, d) {
  const [counters, docs] = await Promise.all([evidence.getRunCounters({ runId: run._id, ...withEv(d) }), evidence.loadForMetrics({ runId: run._id, ...withEv(d) })]);
  const metrics = computeRunMetrics(docs, run.target || {}, { questionsPlanned: QUESTIONS_PER_RUN, costUnit: d.config.costUnit });
  return { counters, metrics };
}

async function failOwned(run, d, code, message) {
  const done = await runs.finalizeRun({
    runId: run._id, workerId: d.workerId, status: 'failed', metrics: null, totalCost: { amount: null, unit: null, unknownCount: 0 },
    failureCode: code, failureMessage: message, now: d.now(), ...withModel(d),
  });
  if (done) d.emit('failed', done);
  return done ? 'failed' : 'lease_lost';
}

/** The persisted result of one successfully parsed SERP response. */
export function buildSuccessPatch({ result, serp, target, config, now }) {
  const aio = result.aiOverview;
  const base = {
    status: 'succeeded',
    attempts: result.attempts || 1,
    serp: { checkUrl: result.checkUrl, datetime: result.datetime, itemsCount: result.itemsCount, itemTypes: result.itemTypes },
    request: requestMetadata(result.request),
    providerRequestId: result.requestId ?? null,
    diagnostics: { httpStatus: 200, providerCode: 20000, providerMessage: null, taskIdReturned: Boolean(result.requestId), attemptLog: result.attemptLog || [], durationMs: result.durationMs ?? null },
    cost: typeof result.cost === 'number' ? result.cost : null,
    costStatus: typeof result.cost === 'number' ? 'reported' : 'unknown',
    costUnit: typeof result.cost === 'number' ? config.costUnit : null,
    errorCode: null, errorClass: null, retryable: null,
    completedAt: now,
    durationMs: result.durationMs ?? null,
  };
  if (!aio) {
    // Google returned a SERP with no AI Overview: a valid observation, not an error.
    return { ...base, aiOverview: { present: false, asyncRequested: serp.loadAsyncAiOverview, asynchronous: null, text: null, markdown: null, elements: [], references: [], rejectedReferences: 0 }, analysis: null, analysisStatus: null, analysisVersion: null };
  }
  let analysis = null;
  let analysisStatus = 'analysed';
  try {
    analysis = analyzeOverview(aio, target);
  } catch (error) {
    LoggerUtil.warn(`${SERVICE}: overview analysis failed; the capture is kept`, { code: error?.message?.slice(0, 60) });
    analysisStatus = 'failed';
  }
  return {
    ...base,
    aiOverview: {
      present: true, asyncRequested: serp.loadAsyncAiOverview, asynchronous: aio.asynchronous, text: aio.text, markdown: aio.markdown, elements: aio.elements,
      references: analysis ? analysis.references : aio.references, rejectedReferences: aio.rejectedReferences,
    },
    analysis,
    analysisStatus,
    analysisVersion: analysis ? ANALYSIS_VERSION : null,
  };
}

/** Execute a run this worker has just claimed. Never throws. */
export async function processClaimedRun(claimed, deps = {}) {
  const d = resolveDeps(deps);
  const { config } = d;
  const runId = String(claimed._id);
  const state = { lost: false, cancel: Boolean(claimed.cancelRequested), fatal: null, costStop: false };

  const heartbeat = setInterval(async () => {
    try {
      const r = await runs.renewLease({ runId, workerId: d.workerId, now: d.now(), config, ...withModel(d) });
      if (!r.owned) state.lost = true;
      if (r.cancelRequested) state.cancel = true;
    } catch (error) {
      LoggerUtil.warn(`${SERVICE}: heartbeat failed`, { runId, code: error?.code });
    }
  }, Math.max(1_000, Math.floor(config.leaseMs / 3)));
  heartbeat.unref?.();

  try {
    let run = claimed;
    const total = run.questionSnapshot?.length || 0;
    if (total !== QUESTIONS_PER_RUN) return await failOwned(run, d, 'QUESTION_SNAPSHOT_INVALID', `A run must contain exactly ${QUESTIONS_PER_RUN} questions`);

    // ── prepare ──
    if (!run.target) {
      if (state.cancel) {
        const done = await runs.finalizeRun({ runId, workerId: d.workerId, status: 'cancelled', metrics: null, totalCost: { amount: null, unit: null, unknownCount: 0 }, failureCode: 'RUN_CANCELLED', now: d.now(), ...withModel(d) });
        if (done) d.emit('cancelled', done);
        return done ? 'cancelled' : 'lease_lost';
      }
      let profile;
      try {
        profile = await d.buildProfile(String(run.projectId));
      } catch (error) {
        return await failOwned(run, d, error?.code || 'VISIBILITY_PROFILE_UNAVAILABLE', 'The business profile could not be loaded');
      }
      const target = buildTarget(profile);
      const market = buildMarket(profile);
      if (!(await runs.setTarget({ runId, workerId: d.workerId, target, market, ...withModel(d) }))) return 'lease_lost';
      run = { ...run, target, market };
    }
    await evidence.ensureEvidence({ run, retainUntil: retainUntilFor(config, d.now()), ...withEv(d) });
    await evidence.resetInterrupted({ runId, ...withEv(d) });

    const { target, serp } = run;
    const blocked = new Map();
    for (const q of run.questionSnapshot) {
      const reason = blockedQuestionReason(q.text, target);
      if (reason) blocked.set(q.questionId, reason);
    }
    for (const [questionId, reason] of blocked) await evidence.skipQuestion({ runId, questionId, errorCode: reason, errorClass: 'not_executed', now: d.now(), ...withEv(d) });
    if (blocked.size) LoggerUtil.warn(`${SERVICE}: questions naming the tracked business were not sent`, { runId, count: blocked.size });

    const evRun = (patch) => ({ _id: run._id, projectId: run.projectId, questionSetVersion: run.questionSetVersion, ...patch });
    const byId = new Map(run.questionSnapshot.map((q, i) => [q.questionId, { ...q, index: i + 1 }]));
    let counters = await evidence.getRunCounters({ runId, ...withEv(d) });
    let spent = counters.cost.amount ?? 0;
    d.emit('progress', evRun({ status: 'running', progress: { completed: total - counters.stats.pending, total, stage: 'running' } }), eventExtra(counters));

    const refresh = async () => {
      counters = await evidence.getRunCounters({ runId, ...withEv(d) });
      const settled = total - counters.stats.pending;
      await runs.updateProgress({ runId, workerId: d.workerId, completed: settled, total, stage: 'running', totalCost: totalCostOf(counters, config.costUnit), questionStats: counters.stats, ...withModel(d) });
      return settled;
    };

    const runOne = async (questionId) => {
      if (state.lost || state.cancel || state.fatal) return;
      if (config.maxRunCost > 0 && spent >= config.maxRunCost) { state.costStop = true; return; }
      const question = byId.get(questionId);
      const claimedEv = await evidence.claimQuestion({ runId, questionId, workerId: d.workerId, now: d.now(), ...withEv(d) });
      if (!claimedEv) return; // not pending any more: another owner has it or it is already final
      const started = claimedEv.startedAt || d.now();
      d.emit('question_started', evRun({ status: 'running', progress: { completed: total - counters.stats.pending, total, stage: 'running' } }), eventExtra(counters, { questionId, questionIndex: question.index }));

      let patch;
      try {
        // The EXACT approved text is sent; location, language, device and depth come from the run's resolved settings only.
        const result = await d.fetch({ question: question.text, serp, tag: `odito-gaio:${runId}:${questionId}`.slice(0, 255) }, { config });
        if (typeof result.cost === 'number') spent += result.cost;
        patch = buildSuccessPatch({ result, serp, target, config, now: d.now() });
        patch.durationMs = result.durationMs ?? Math.max(0, d.now().getTime() - new Date(started).getTime());
      } catch (error) {
        const code = error?.code && String(error.code).startsWith('GOOGLE_AIO_') ? error.code : GOOGLE_AIO_ERROR.UNEXPECTED;
        if (error?.fatal) state.fatal = code;
        patch = {
          status: 'failed', attempts: error?.attempts || 1, errorCode: code, errorClass: errorClassOf(error), retryable: Boolean(error?.retryable),
          // Why it failed, exactly as the provider reported it (no credentials, no headers): kept so a failure can be diagnosed later.
          diagnostics: {
            httpStatus: error?.httpStatus ?? null, providerCode: error?.providerCode ?? null, providerMessage: error?.providerMessage ?? null,
            taskIdReturned: Boolean(error?.taskIdReturned), attemptLog: error?.attemptLog || [], durationMs: error?.durationMs ?? null,
          },
          // A failed request may still have been billed: its cost is unknown, never zero.
          costStatus: 'unknown', completedAt: d.now(), durationMs: Math.max(0, d.now().getTime() - new Date(started).getTime()),
        };
        LoggerUtil.warn(`${SERVICE}: question failed`, { runId, questionId, code, httpStatus: error?.httpStatus ?? null, providerCode: error?.providerCode ?? null, attempts: error?.attempts || 1 });
      }
      const written = await evidence.saveResult({ runId, questionId, workerId: d.workerId, patch, ...withEv(d) });
      if (!written) { state.lost = true; return; }
      const settled = await refresh();
      d.emit(patch.status === 'succeeded' ? 'question_completed' : 'question_failed', evRun({ status: 'running', progress: { completed: settled, total, stage: 'running' } }),
        eventExtra(counters, { questionId, questionIndex: question.index, questionStatus: patch.status, overviewPresent: patch.status === 'succeeded' ? patch.aiOverview.present : undefined, errorCode: patch.errorCode || undefined }));
    };

    const queue = (await evidence.listPending({ runId, ...withEv(d) })).map((e) => e.questionId);
    const lanes = Array.from({ length: Math.min(config.maxConcurrentQuestions, queue.length) }, async () => {
      while (queue.length && !state.lost) await runOne(queue.shift());
    });
    await Promise.all(lanes);
    if (state.lost) return 'lease_lost';

    // Anything still pending was deliberately not sent: record why, never leave it ambiguous.
    const cancelled = state.cancel;
    if (cancelled) await evidence.skipPending({ runId, status: 'cancelled', errorCode: 'RUN_CANCELLED', errorClass: 'cancelled', now: d.now(), ...withEv(d) });
    // Not sent BECAUSE the provider account reported a problem on another question: the reason says so, and names that error as the cause.
    else if (state.fatal) await evidence.skipPending({ runId, errorCode: 'NOT_SENT_PROVIDER_ACCOUNT_ERROR', errorClass: 'not_executed', skipCause: state.fatal, now: d.now(), ...withEv(d) });
    else if (state.costStop) await evidence.skipPending({ runId, errorCode: 'COST_LIMIT_REACHED', errorClass: 'budget', now: d.now(), ...withEv(d) });
    else await evidence.skipPending({ runId, errorCode: 'NOT_EXECUTED', errorClass: 'not_executed', now: d.now(), ...withEv(d) });
    LoggerUtil.info(`${SERVICE}: dispatch finished`, { runId, cancelled, fatal: state.fatal, costStop: state.costStop });

    // ── finalize (from persisted evidence) ── only when all five are terminal
    let { counters: final, metrics } = await summarizeRun(run, d);
    if (final.stats.pending > 0) {
      await evidence.failInterrupted({ runId, now: d.now(), ...withEv(d) });
      ({ counters: final, metrics } = await summarizeRun(run, d));
    }
    const status = deriveStatus({ succeeded: final.stats.succeeded, total }, cancelled);
    const firstFailure = (await evidence.loadForMetrics({ runId, ...withEv(d) })).find((e) => e.status === 'failed')?.errorCode;
    const finalDoc = await runs.finalizeRun({
      runId, workerId: d.workerId, status, metrics, totalCost: totalCostOf(final, config.costUnit), questionStats: final.stats,
      failureCode: status === 'failed' ? (state.fatal || (blocked.size === total ? 'ALL_QUESTIONS_NAME_TRACKED_BUSINESS' : firstFailure || 'ALL_QUESTIONS_FAILED'))
        : (status === 'partial' ? (state.fatal || (state.costStop ? 'COST_LIMIT_REACHED' : firstFailure || 'SOME_QUESTIONS_NOT_ANSWERED')) : null),
      now: d.now(), ...withModel(d),
    });
    if (!finalDoc) return 'lease_lost';
    d.emit(status, finalDoc, eventExtra(final));
    return status;
  } catch (error) {
    LoggerUtil.error(`${SERVICE}: run crashed`, { runId, message: error?.message?.slice(0, 200) });
    return 'crashed'; // the lease lapses and the recovery sweep re-claims it within the claim budget
  } finally {
    clearInterval(heartbeat);
  }
}

/** Recovery: finalize a run whose claim budget is exhausted. Interrupted questions become failed, the rest skipped; answers are kept. */
export async function finalizeExhaustedRun(run, { config = getGoogleAioConfig(), now = () => new Date(), Model = null, EvidenceModel = null } = {}) {
  const d = resolveDeps({ config, now, Model, EvidenceModel });
  await evidence.failInterrupted({ runId: run._id, now: now(), ...withEv(d) });
  await evidence.skipPending({ runId: run._id, errorCode: 'RUN_ATTEMPTS_EXHAUSTED', errorClass: 'not_executed', now: now(), ...withEv(d) });
  const { counters, metrics } = await summarizeRun(run, d);
  const status = deriveStatus({ succeeded: counters.stats.succeeded, total: run.questionSnapshot?.length || 0 }, false);
  const done = await runs.finalizeAbandoned({
    run, status, metrics: run.target ? metrics : null, totalCost: totalCostOf(counters, config.costUnit), questionStats: counters.stats,
    failureCode: status === 'completed' ? null : 'RUN_ATTEMPTS_EXHAUSTED', failureMessage: status === 'completed' ? null : 'The run was interrupted too many times',
    now: now(), ...withModel(d),
  });
  if (done) emitGoogleAioEvent(status, done, eventExtra(counters));
  return done;
}

/** Claim one run (a specific one, or the next eligible) and process it. */
export async function processRun({ runId = null, ...deps } = {}) {
  const d = resolveDeps(deps);
  const claimed = await runs.claimRun({ runId, workerId: d.workerId, now: d.now(), config: d.config, ...withModel(d) });
  if (!claimed) return 'not_claimed';
  return processClaimedRun(claimed, deps);
}

// ── in-process dispatch ──
let active = 0;
export const activeRunCount = () => active;

/** Start processing a freshly queued run without waiting for the next sweep. A latency optimisation only: durability is the database. */
export function kick(runId, deps = {}) {
  const config = deps.config || getGoogleAioConfig();
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

export default { processRun, processClaimedRun, finalizeExhaustedRun, kick, drainQueue, WORKER_ID };
