import { LoggerUtil } from '../../../../utils/LoggerUtil.js';
import { getChatGptConfig } from '../config/chatgptConfig.js';
import { executeChatGptPrompt, CHATGPT_ERROR } from '../providers/dataForSeoChatGptProvider.js';
import * as runs from '../services/runService.js';
import { emitVisibilityEvent } from '../services/visibilityEvents.js';
import * as evidence from '../../shared/evidence/services/evidenceService.js';
import { buildBusinessProfile } from '../../shared/services/businessProfileService.js';
import { analyzeAnswer } from '../../shared/services/visibilityMetricsService.js';
import { classifyCitations } from '../../shared/services/citationNormalizationService.js';
import { detectRecommendation } from '../../shared/services/recommendationDetection.js';
import { computeApprovedQuestionMetrics } from '../../shared/services/approvedQuestionMetrics.js';
import { GROUPS } from '../../shared/questions/config/questionConfig.js';

/**
 * Executes ONE approved-question run to a terminal state. It reuses the existing run lifecycle (atomic claim, lease, heartbeat,
 * cancellation, recovery sweep) and the existing DataForSEO ChatGPT provider; only WHAT is asked and WHERE the results go differ:
 *
 *   questions  the run's immutable `questionSnapshot` (taken from the approved set when the run was created)
 *   results    one `ai_visibility_evidence` document per question, written as each answer arrives
 *   metrics    computed from the persisted evidence at the end (computeApprovedQuestionMetrics)
 *
 * Crash behaviour: a worker that dies stops renewing the lease; after it lapses another worker re-claims the run, keeps the target it
 * started with, resets questions the dead worker had `running` to `pending` and asks ONLY what is still pending. Final evidence is never
 * re-asked. Residual risk: a question whose provider call completed but whose result was not yet written is asked (and paid) again.
 *
 * Limits (all PER PROCESS, as in the legacy worker): in-flight requests = maxConcurrentPrompts through the provider's limiter; the cost
 * guard is checked before each question is sent, so spend can exceed maxRunCost by what was in flight; the maxGlobalRunning cap is a
 * best-effort database check, not a distributed lock.
 */

const SERVICE = 'ChatGptApprovedRunWorker';

function resolveDeps(d = {}) {
  return {
    config: d.config || getChatGptConfig(),
    execute: d.execute || executeChatGptPrompt,
    buildProfile: d.buildProfile || buildBusinessProfile,
    emit: d.emit || emitVisibilityEvent,
    now: d.now || (() => new Date()),
    workerId: d.workerId,
    Model: d.Model,
    EvidenceModel: d.EvidenceModel,
  };
}
const withModel = (d) => (d.Model ? { Model: d.Model } : {});
const withEv = (d) => (d.EvidenceModel ? { Model: d.EvidenceModel } : {});

export function buildTarget(profile) {
  return {
    brandNames: [profile.business.name, ...profile.business.aliases].filter(Boolean),
    nameSource: profile.business.nameSource,
    nameVerified: profile.business.nameVerified,
    brandMatchReliable: profile.business.nameReliability?.reliable !== false,
    competitors: profile.business.competitors,
    targetHost: profile.website.targetHost,
  };
}

export function buildMarket(profile) {
  const m = profile.market;
  return { scope: m.scope, effectiveScope: m.effectiveScope, city: m.city, state: m.state, country: m.country, countryCode: m.countryCode, language: m.language };
}

export const retainUntilFor = (config, now) => (config.evidenceRetentionDays > 0 ? new Date(now.getTime() + config.evidenceRetentionDays * 86_400_000) : null);

const deriveStatus = ({ succeeded, total }, cancelled) => {
  if (cancelled) return 'cancelled';
  if (total > 0 && succeeded === total) return 'completed';
  return succeeded > 0 ? 'partial' : 'failed';
};

const totalCostOf = (counters, unit) => ({ amount: counters.cost.amount, unit: counters.cost.amount !== null ? unit : null, unknownCount: counters.cost.unknownCount });

/** The request-side market for ONE question: its confirmed target city when it names one, else the project's. */
function marketFor(market, question) {
  const city = question.searchCity || (market.effectiveScope === 'local' ? market.city : null);
  return { ...market, city, effectiveScope: city ? 'local' : market.effectiveScope };
}

const locationApplied = (config, m) => {
  if (!config.webSearch || !/^[A-Za-z]{2}$/.test(m.countryCode || '')) return 'none';
  return m.effectiveScope === 'local' && m.city ? 'provider_country_city' : 'provider_country';
};

const errorClassOf = (error) => {
  if (error?.fatal) return 'fatal';
  if (error?.code === CHATGPT_ERROR.MALFORMED_RESPONSE) return 'parse';
  return error?.retryable ? 'retryable' : 'non_retryable';
};

/** Final metrics + counters for a run, computed from the database. */
async function summarizeRun(run, d) {
  const [counters, docs] = await Promise.all([evidence.getRunCounters({ runId: run._id, ...withEv(d) }), evidence.loadForMetrics({ runId: run._id, ...withEv(d) })]);
  const metrics = computeApprovedQuestionMetrics(docs, run.target, { questionsPlanned: run.questionSnapshot.length, costUnit: d.config.costUnit, budget: d.config.maxRunCost });
  return { counters, metrics };
}

const eventExtra = (counters, extra = {}) => ({
  succeeded: counters?.stats.succeeded, failed: counters?.stats.failed, skipped: counters?.stats.skipped, pending: counters?.stats.pending, ...extra,
});

async function failOwned(run, d, code, message) {
  const done = await runs.finalizeRun({
    runId: run._id, workerId: d.workerId, status: 'failed', metrics: null, totalCost: { amount: null, unit: null, unknownCount: 0 },
    failureCode: code, failureMessage: message, now: d.now(), ...withModel(d),
  });
  if (done) d.emit('failed', done);
  return done ? 'failed' : 'lease_lost';
}

/** Execute an approved-question run this worker has just claimed. Never throws. */
export async function processApprovedRun(claimed, deps = {}) {
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
    if (!total) return await failOwned(run, d, 'QUESTION_SNAPSHOT_MISSING', 'The run has no questions to ask');

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
      if (!(await runs.setApprovedTarget({ runId, workerId: d.workerId, target, market, ...withModel(d) }))) return 'lease_lost';
      run = { ...run, target, market };
    }
    await evidence.ensureEvidence({ run, retainUntil: retainUntilFor(config, d.now()), now: d.now(), ...withEv(d) });
    await evidence.resetInterrupted({ runId, ...withEv(d) });

    const { target, market } = run;
    const evRun = (patch) => ({ _id: run._id, projectId: run.projectId, executionMode: 'approved_questions', questionSetId: run.questionSetId, questionSetVersion: run.questionSetVersion, ...patch });
    const byId = new Map(run.questionSnapshot.map((q) => [q.questionId, q]));
    let counters = await evidence.getRunCounters({ runId, ...withEv(d) });
    let spent = counters.cost.amount ?? 0;
    d.emit('progress', evRun({ status: 'running', progress: { completed: total - counters.stats.pending, total, stage: 'running' } }), eventExtra(counters));

    const refresh = async (extra) => {
      counters = await evidence.getRunCounters({ runId, ...withEv(d) });
      const settled = total - counters.stats.pending;
      await runs.updateProgress({ runId, workerId: d.workerId, completed: settled, total, stage: 'running', totalCost: totalCostOf(counters, config.costUnit), questionStats: counters.stats, ...withModel(d) });
      d.emit('progress', evRun({ status: 'running', progress: { completed: settled, total, stage: 'running' } }), eventExtra(counters, extra));
    };

    const runOne = async (questionId) => {
      if (state.lost || state.cancel || state.fatal) return;
      if (config.maxRunCost > 0 && spent >= config.maxRunCost) { state.costStop = true; return; }
      const question = byId.get(questionId);
      const claimedEv = await evidence.claimQuestion({ runId, questionId, workerId: d.workerId, now: d.now(), ...withEv(d) });
      if (!claimedEv) return; // no longer pending: another owner has it or it is already final
      const started = claimedEv.startedAt || d.now();
      const m = marketFor(market, question);
      d.emit('question_started', evRun({ status: 'running', progress: run.progress }), eventExtra(counters, { questionId, intent: question.intent }));

      const base = { model: config.model, webSearch: config.webSearch, country: config.webSearch ? m.countryCode : null, city: config.webSearch && m.effectiveScope === 'local' ? m.city : null, locationApplied: locationApplied(config, m) };
      let patch;
      try {
        // The EXACT approved text is what is sent; the model, search and token settings come from server config only.
        const result = await d.execute({ prompt: question.text, market: m, tag: `odito-cgv:${runId}:${questionId}` }, { config });
        if (typeof result.cost === 'number') spent += result.cost;
        const cls = classifyCitations({ answerText: result.answerText, annotations: result.annotations, targetHost: target.targetHost, brandNames: target.brandNames });
        const citations = cls.citations;
        const analysis = analyzeAnswer(result, target);
        const rec = question.group === GROUPS.VISIBILITY ? detectRecommendation(result.answerText, target.brandNames) : null;
        patch = {
          ...base,
          status: 'succeeded',
          attempts: result.attempts || 1,
          providerRequestId: result.requestId ?? null,
          modelReported: result.model ?? null,
          answerText: result.answerText,
          annotations: result.annotations,
          citations,
          firstPartyPages: analysis.targetPages,
          externalDomains: [...new Set(citations.filter((c) => c.valid && !c.isTarget).map((c) => c.host))],
          analysis: {
            brandMentioned: analysis.brandMentioned, brandMentionCount: analysis.brandMentionCount, recommended: rec ? rec.recommended : null, recommendationMethod: rec ? rec.method : null, competitorMentions: analysis.competitorMentions,
            officialCited: cls.officialCited, thirdPartyCited: cls.thirdPartyCited, officialDomainInText: cls.officialDomainInText, brandListPosition: cls.brandListPosition, officialDomain: target.targetHost || null,
          },
          cost: typeof result.cost === 'number' ? result.cost : null,
          costStatus: typeof result.cost === 'number' ? 'reported' : 'unknown',
          costUnit: typeof result.cost === 'number' ? config.costUnit : null,
          usage: { inputTokens: result.usage?.inputTokens ?? null, outputTokens: result.usage?.outputTokens ?? null },
          errorCode: null, errorClass: null, retryable: null,
          completedAt: d.now(),
          durationMs: result.durationMs ?? null,
        };
      } catch (error) {
        const code = error?.code && String(error.code).startsWith('CHATGPT_') ? error.code : 'CHATGPT_UNEXPECTED_ERROR';
        if (error?.fatal) state.fatal = code;
        patch = {
          ...base, status: 'failed', attempts: error?.attempts || 1, errorCode: code, errorClass: errorClassOf(error), retryable: Boolean(error?.retryable),
          costStatus: 'unknown', completedAt: d.now(), durationMs: Math.max(0, d.now().getTime() - new Date(started).getTime()),
        };
      }
      const written = await evidence.saveResult({ runId, questionId, workerId: d.workerId, patch, ...withEv(d) });
      if (!written) { state.lost = true; return; }
      await refresh({ questionId, intent: question.intent, questionStatus: patch.status, errorCode: patch.errorCode });
      d.emit(patch.status === 'succeeded' ? 'question_completed' : 'question_failed', evRun({ status: 'running', progress: { completed: total - counters.stats.pending, total, stage: 'running' } }), eventExtra(counters, { questionId, intent: question.intent, questionStatus: patch.status, errorCode: patch.errorCode }));
    };

    // Bounded in-run concurrency; guards are re-checked immediately before each request is sent.
    const queue = (await evidence.listPending({ runId, ...withEv(d) })).map((e) => e.questionId);
    const lanes = Array.from({ length: Math.min(config.maxConcurrentPrompts, queue.length) }, async () => {
      while (queue.length && !state.lost) await runOne(queue.shift());
    });
    await Promise.all(lanes);
    if (state.lost) return 'lease_lost';

    // Anything still pending was deliberately not sent: record why, never leave it ambiguous.
    const cancelled = state.cancel;
    if (cancelled) await evidence.skipPending({ runId, errorCode: 'RUN_CANCELLED', errorClass: 'cancelled', now: d.now(), ...withEv(d) });
    else if (state.fatal) await evidence.skipPending({ runId, errorCode: state.fatal, errorClass: 'not_executed', now: d.now(), ...withEv(d) });
    else if (state.costStop) await evidence.skipPending({ runId, errorCode: 'COST_LIMIT_REACHED', errorClass: 'budget', now: d.now(), ...withEv(d) });
    else await evidence.skipPending({ runId, errorCode: 'NOT_EXECUTED', errorClass: 'not_executed', now: d.now(), ...withEv(d) });

    // ── finalize (from persisted evidence) ──
    const { counters: final, metrics } = await summarizeRun(run, d);
    const status = deriveStatus({ succeeded: final.stats.succeeded, total }, cancelled);
    const finalDoc = await runs.finalizeRun({
      runId, workerId: d.workerId, status, metrics, totalCost: totalCostOf(final, config.costUnit), questionStats: final.stats,
      failureCode: status === 'failed' ? (state.fatal || 'ALL_EXECUTIONS_FAILED') : (status === 'partial' ? (state.fatal || (state.costStop ? 'COST_LIMIT_REACHED' : null)) : null),
      now: d.now(), ...withModel(d),
    });
    if (!finalDoc) return 'lease_lost';
    d.emit(status === 'completed' ? 'completed' : status, finalDoc, eventExtra(final));
    return status;
  } catch (error) {
    LoggerUtil.error(`${SERVICE}: run crashed`, { runId, message: error?.message?.slice(0, 200) });
    return 'crashed'; // the lease lapses and the recovery sweep re-claims it within the claim budget
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * Recovery: finalize an approved-question run whose claim budget is exhausted (nobody will claim it again). Questions a dead worker had
 * taken are recorded as failed (WORKER_INTERRUPTED), the rest as skipped; everything already answered is kept.
 */
export async function finalizeExhaustedApprovedRun(run, { config = getChatGptConfig(), now = () => new Date(), Model = null, EvidenceModel = null } = {}) {
  const d = resolveDeps({ config, now, Model, EvidenceModel });
  await evidence.failInterrupted({ runId: run._id, now: now(), ...withEv(d) });
  await evidence.skipPending({ runId: run._id, errorCode: 'RUN_ATTEMPTS_EXHAUSTED', errorClass: 'not_executed', now: now(), ...withEv(d) });
  const total = run.questionSnapshot?.length || 0;
  const target = run.target || { brandNames: [], competitors: [], targetHost: null };
  const { counters, metrics } = await summarizeRun({ ...run, target }, d);
  const status = deriveStatus({ succeeded: counters.stats.succeeded, total }, false);
  const done = await runs.finalizeAbandoned({
    run, status, metrics: run.target ? metrics : null, totalCost: totalCostOf(counters, config.costUnit), questionStats: counters.stats,
    failureCode: status === 'completed' ? null : 'RUN_ATTEMPTS_EXHAUSTED', failureMessage: status === 'completed' ? null : 'The run was interrupted too many times',
    now: now(), ...withModel(d),
  });
  if (done) emitVisibilityEvent(status === 'completed' ? 'completed' : status, done, eventExtra(counters));
  return done;
}

export default { processApprovedRun, finalizeExhaustedApprovedRun, buildTarget, buildMarket };
