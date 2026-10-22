/**
 * investigationOrchestrator — the pipeline (diagnosis only; it never executes a fix):
 *
 *   validate issue -> plan -> gather evidence -> resolve fix capabilities -> diagnose (master prompt)
 *     -> validate output (contract + grounding) -> persist
 *
 * plus the InvestigationRunner that owns concurrency, de-duplication of identical requests, cancellation,
 * an overall deadline and progress persistence.
 *
 * Execution and verification live in lifecycleService and the existing task / WordPress / verification paths.
 */

import { resolveInvestigationPlan } from '../evidence/investigationPlans.js';
import { collectEvidence, isOnSite } from '../evidence/evidenceCollector.js';
import { buildMasterPrompt, MASTER_PROMPT_VERSION } from '../prompt/masterPrompt.js';
import { validateModelOutput, buildEvidenceOnlyResult, CONTRACT_VERSION, extractJson } from '../contract/investigationContract.js';
import { LlmError, LLM_ERROR, isRetryableLlmError, MAX_TOKENS_CEILING } from '../llm/investigationLlm.js';
import { isDuplicateKeyError } from './investigationStore.js';
import { randomUUID } from 'node:crypto';
import { bindProposal } from './proposalBinding.js';

export const INVESTIGATION_ERROR = Object.freeze({
  INVALID_REQUEST: 'INVALID_REQUEST',
  OUT_OF_SCOPE: 'OUT_OF_SCOPE',
  CANCELLED: 'CANCELLED',
  DEADLINE: 'INVESTIGATION_TIMEOUT',
  INTERNAL: 'INVESTIGATION_FAILED',
  INTERRUPTED: 'INVESTIGATION_INTERRUPTED',
});

export class InvestigationError extends Error {
  constructor(code, message, statusCode = 400) { super(message); this.name = 'InvestigationError'; this.code = code; this.statusCode = statusCode; }
}

const ISSUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
const STAGES = ['validate', 'gather_evidence', 'capabilities', 'diagnose', 'validate_output'];

const defaults = {
  deadlineMs: Number(process.env.INVESTIGATION_DEADLINE_MS ?? 170_000),
  maxLlmRetries: 2,
  maxRepairAttempts: 1,
  maxConcurrent: Number(process.env.INVESTIGATION_MAX_CONCURRENT ?? 4),
  maxConcurrentPerProject: Number(process.env.INVESTIGATION_MAX_PER_PROJECT ?? 2),
};

/** Validates request shape. Throws InvestigationError (400/422); nothing is fetched yet. */
export function validateRequest({ issue }, project) {
  if (!issue || typeof issue.issueId !== 'string' || !ISSUE_ID_RE.test(issue.issueId)) {
    throw new InvestigationError(INVESTIGATION_ERROR.INVALID_REQUEST, 'A valid issueId is required.', 400);
  }
  let url;
  try { url = new URL(issue.pageUrl); } catch { throw new InvestigationError(INVESTIGATION_ERROR.INVALID_REQUEST, 'A valid pageUrl is required.', 400); }
  if (!['http:', 'https:'].includes(url.protocol) || issue.pageUrl.length > 2048) throw new InvestigationError(INVESTIGATION_ERROR.INVALID_REQUEST, 'pageUrl must be an http(s) URL.', 400);
  if (!isOnSite(issue.pageUrl, project.siteUrl)) {
    throw new InvestigationError(INVESTIGATION_ERROR.OUT_OF_SCOPE, 'This page is not part of the project\'s website.', 422);
  }
}

const clipText = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
export function sanitizeIssueMeta(issue) {
  return {
    issueId: issue.issueId, pageUrl: issue.pageUrl,
    title: clipText(issue.title, 300), description: clipText(issue.description, 800), category: clipText(issue.category, 100),
    severity: clipText(issue.severity, 30), difficulty: clipText(issue.difficulty, 30),
    issueSource: ['ai_visibility', 'on_page'].includes(issue.issueSource) ? issue.issueSource : null,
  };
}

/**
 * Runs one investigation to completion. Returns the patch to persist. Never throws for evidence/provider problems:
 * those become explicit, honest results. Throws only on cancellation / deadline.
 */
export async function runInvestigation({ record, project, issue, deps, signal, report, history = [] }) {
  const step = (stage, status = 'running', note) => { if (signal?.aborted) throw new InvestigationError(INVESTIGATION_ERROR.CANCELLED, 'Investigation cancelled.', 409); return report(stage, status, note); };
  const log = deps.log || (() => {});
  const warnings = [];

  await step('validate');
  const plan = resolveInvestigationPlan({ issueId: issue.issueId, category: issue.category, title: issue.title });
  await step('validate', 'done', `family=${plan.family}`);

  // ── Evidence ───────────────────────────────────────────────────────────────────────────
  await step('gather_evidence');
  const ledger = await collectEvidence({
    project, issue, plan, deps, signal,
    onStep: (s) => { if (!signal?.aborted) report('gather_evidence', 'running', s); },
  });
  await step('gather_evidence', ledger.ok.length ? 'done' : 'failed', `${ledger.ok.length} ok / ${ledger.failures.length} failed`);

  await step('capabilities');
  // What a fix would actually write (e.g. the Organization `address`) comes from the server-side analysis, never from the model.
  const operation = ledger.items.find((i) => i.kind === 'structured_analysis' && i.status === 'ok' && i.data?.operation)?.data.operation || null;
  const capabilities = await deps.resolveCapabilities({ issueId: issue.issueId, projectId: project.id, operation });
  await step('capabilities', 'done', capabilities.eligibility);

  const base = {
    planFamily: plan.family, promptVersion: MASTER_PROMPT_VERSION, contractVersion: CONTRACT_VERSION,
    evidenceTrace: ledger.toTrace(),
  };

  // ── Diagnosis ──────────────────────────────────────────────────────────────────────────
  // Nothing the model could say changes what we know when the page itself is unreachable and there is no stored evidence.
  const hasAnyEvidence = ledger.ok.some((i) => ['page', 'crawl_page', 'detector'].includes(i.kind));
  if (!hasAnyEvidence) {
    await step('diagnose', 'skipped', 'no usable evidence');
    const result = buildEvidenceOnlyResult({ ledger, capabilities, reasonCode: 'NO_EVIDENCE', reasonMessage: 'The page could not be inspected and no stored crawl evidence exists, so no diagnosis was attempted.' });
    result.proposal = bindProposal({ investigationId: record._id, projectId: project.id, issueId: issue.issueId, pageUrl: issue.pageUrl, result });
    return { ...base, result, warnings, lifecycle: result.lifecycle, tokens: { input: 0, output: 0 }, model: null };
  }

  let tokens = { input: 0, output: 0 }; let model = null; let validated = null; let lastProblems = [];
  let repair = null; let attempts = 0; let llmRetries = 0; let failure = null;
  let maxTokens; let boosted = false; // undefined = the adapter's default budget

  while (!validated && !failure && attempts <= defaults.maxRepairAttempts) {
    attempts += 1;
    await step('diagnose', 'running', attempts > 1 ? 'asking the model to correct its answer' : undefined);
    const prompt = buildMasterPrompt({ issue, site: { origin: new URL(issue.pageUrl).origin, siteUrl: project.siteUrl, cms: project.cms, framework: project.framework }, plan, ledger, capabilities, history, repair });

    let reply = null;
    for (;;) {
      try {
        reply = await deps.llm.complete({ system: prompt.system, user: prompt.user, ...(maxTokens ? { maxTokens } : {}) });
        break;
      } catch (error) {
        const code = error.code || LLM_ERROR.PROVIDER;
        // An answer cut off by the output limit is retried ONCE with a larger budget (the same request would be cut off again).
        if (code === LLM_ERROR.TRUNCATED && !boosted && !signal?.aborted) {
          boosted = true; maxTokens = MAX_TOKENS_CEILING;
          log('warn', 'llm_truncated_retry', { investigationId: record._id, maxTokens });
          continue;
        }
        if (isRetryableLlmError(code) && llmRetries < defaults.maxLlmRetries && !signal?.aborted) {
          llmRetries += 1;
          const wait = Math.min(15_000, (error.retryAfter ? error.retryAfter * 1000 : 1500 * 2 ** llmRetries));
          log('warn', 'llm_retry', { investigationId: record._id, code, attempt: llmRetries, waitMs: wait });
          await deps.sleep(wait);
          if (signal?.aborted) throw new InvestigationError(INVESTIGATION_ERROR.CANCELLED, 'Investigation cancelled.', 409);
          continue;
        }
        failure = { code, message: error instanceof LlmError ? error.message : 'The AI provider failed.' };
        break;
      }
    }
    if (failure) break;
    if (signal?.aborted) throw new InvestigationError(INVESTIGATION_ERROR.CANCELLED, 'Investigation cancelled.', 409);

    tokens = { input: tokens.input + (reply.tokens?.input || 0), output: tokens.output + (reply.tokens?.output || 0) };
    model = reply.model || model;

    await step('validate_output');
    let outcome;
    try { outcome = validateModelOutput(extractJson(reply.text), { ledger, capabilities, pageUrl: issue.pageUrl, siteUrl: project.siteUrl }); }
    catch (error) { outcome = { ok: false, errors: [error.message] }; }
    if (outcome.ok) { validated = outcome; await step('validate_output', 'done', `${outcome.warnings.length} warning(s)`); }
    else {
      lastProblems = outcome.errors;
      log('warn', 'invalid_model_output', { investigationId: record._id, errors: outcome.errors.slice(0, 5), attempt: attempts });
      repair = { previousOutput: reply.text.slice(0, 1500), problems: outcome.errors };
      await step('validate_output', 'failed', outcome.errors[0]);
    }
  }

  if (validated) {
    warnings.push(...validated.warnings);
    // The proposal is bound to this exact investigation/project/issue/page; approval is later given to this fingerprint only.
    validated.value.proposal = bindProposal({ investigationId: record._id, projectId: project.id, issueId: issue.issueId, pageUrl: issue.pageUrl, result: validated.value });
    return { ...base, result: validated.value, warnings, lifecycle: validated.value.lifecycle, tokens, model };
  }

  // Provider failure / unusable output: return the evidence and the capability, not an invented diagnosis.
  const reasonCode = failure?.code || 'INVALID_MODEL_OUTPUT';
  const reasonMessage = failure ? `${failure.message} The evidence below was still collected.` : `The AI answer failed validation (${lastProblems.slice(0, 2).join('; ')}) and was not used.`;
  const result = buildEvidenceOnlyResult({ ledger, capabilities, reasonCode, reasonMessage });
  result.proposal = bindProposal({ investigationId: record._id, projectId: project.id, issueId: issue.issueId, pageUrl: issue.pageUrl, result });
  return { ...base, result, warnings: [`${reasonCode}: ${reasonMessage}`], lifecycle: result.lifecycle, tokens, model, degraded: { code: reasonCode } };
}

/** Counting semaphore with FIFO waiters; a waiter can be abandoned (abort) without leaking a slot. */
export function createLimiter(max) {
  let active = 0; const queue = [];
  const release = () => { active -= 1; const next = queue.shift(); if (next) { active += 1; next.resolve(); } };
  return {
    get active() { return active; },
    get waiting() { return queue.length; },
    acquire(signal) {
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (active < max) { active += 1; return Promise.resolve(); }
      return new Promise((resolve, reject) => {
        const waiter = { resolve: () => { signal?.removeEventListener?.('abort', onAbort); resolve(); } };
        const onAbort = () => { const i = queue.indexOf(waiter); if (i !== -1) queue.splice(i, 1); reject(signal.reason); };
        signal?.addEventListener?.('abort', onAbort, { once: true });
        queue.push(waiter);
      });
    },
    release,
  };
}

const cancelled = () => new InvestigationError(INVESTIGATION_ERROR.CANCELLED, 'Investigation cancelled.', 409);
const terminal = (status, extra) => ({ status, stage: status, activeKey: null, ...extra });

export class InvestigationRunner {
  constructor(deps, options = {}) {
    this.deps = deps;
    this.opts = { ...defaults, ...options };
    if (!this.opts.staleAfterMs) this.opts.staleAfterMs = this.opts.deadlineMs + 60_000;
    this.runnerId = randomUUID();
    this.global = createLimiter(this.opts.maxConcurrent);
    this.perProject = new Map();
    this.controllers = new Map(); // investigationId -> AbortController
    this.running = new Map();     // investigationId -> Promise (tests await it)
    this._startLocks = new Map();
  }

  _projectLimiter(projectId) {
    const key = String(projectId);
    if (!this.perProject.has(key)) this.perProject.set(key, createLimiter(this.opts.maxConcurrentPerProject));
    return this.perProject.get(key);
  }

  /**
   * Starts (or joins) an investigation. An identical investigation already queued/running for the same project is returned
   * instead of starting a second one (double clicks, two tabs, other server instances: the database enforces one active run per
   * project+issue+page through a partial unique index). Once a run has finished, the next request starts a fresh investigation.
   */
  async start({ project, userId, issue }) {
    validateRequest({ issue }, project);
    const meta = sanitizeIssueMeta(issue);
    const requestKey = `${meta.issueId}|${meta.pageUrl}`;
    // In-process serialisation keeps the common case cheap; the unique index is the cross-instance guarantee.
    const lockKey = `${project.id}|${requestKey}`;
    const previous = this._startLocks.get(lockKey) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => this._startLocked({ project, userId, meta, requestKey }));
    this._startLocks.set(lockKey, current);
    current.catch(() => {}).finally(() => { if (this._startLocks.get(lockKey) === current) this._startLocks.delete(lockKey); });
    return current;
  }

  async _startLocked({ project, userId, meta, requestKey }) {
    const { store } = this.deps;
    const active = await this._activeOrReaped(project.id, requestKey);
    if (active) return { record: active, joined: true };

    // Earlier attempts for this exact issue/page, so the model sees what was already proposed, applied or verified.
    const prev = await store.findLatestByKey(project.id, requestKey);
    const history = prev && prev.result ? [{
      previousInvestigationAt: prev.finishedAt || null, issueStatus: prev.result.issueStatus, summary: String(prev.result.summary || '').slice(0, 300),
      fixApplied: !!prev.lifecycle?.fixApplied, fixVerified: !!prev.lifecycle?.fixVerified, verificationStatus: prev.lifecycle?.verificationStatus || 'not_started',
    }] : [];
    let record;
    try {
      record = await store.create({
        projectId: project.id, userId, issueId: meta.issueId, pageUrl: meta.pageUrl, requestKey, issueMeta: meta, runnerId: this.runnerId,
        status: 'queued', stage: 'queued', progress: [], lifecycle: { recommendationGenerated: false, fixProposed: false, fixApplied: false, fixVerified: false, verificationStatus: 'not_started' },
      });
    } catch (error) {
      // Another instance won the race for the same project+issue+page: join its run.
      if (isDuplicateKeyError(error)) {
        const winner = await store.findActiveByKey(project.id, requestKey);
        if (winner) return { record: winner, joined: true };
      }
      throw error;
    }
    // Any earlier unconsumed approval for this page is void from now on: the situation it was given for has been re-investigated.
    await store.invalidateOlderApprovals?.(project.id, requestKey, record._id, new Date(this.deps.now())).catch?.(() => {});
    const controller = new AbortController();
    this.controllers.set(String(record._id), controller);
    const promise = this._execute({ record, project, issue: meta, controller, history }).finally(() => { this.controllers.delete(String(record._id)); this.running.delete(String(record._id)); });
    this.running.set(String(record._id), promise);
    return { record, joined: false };
  }

  /** An "active" row that nobody is working on (crashed process) is failed and treated as not active, so it can never block new runs. */
  async _activeOrReaped(projectId, requestKey) {
    const active = await this.deps.store.findActiveByKey(projectId, requestKey);
    if (!active) return null;
    const reaped = await this.reapIfStale(active);
    return reaped ? null : active;
  }

  async _execute({ record, project, issue, controller, history = [] }) {
    const id = String(record._id); const pid = String(project.id);
    const { store, log = () => {} } = this.deps;
    const projectLimiter = this._projectLimiter(pid);
    const progress = [];
    // Every write goes through compare-and-set on "still active": an abandoned pipeline can never overwrite cancelled/failed/completed.
    const persistActive = (patch) => store.updateIfActive(id, pid, patch).catch((e) => { log('error', 'persist_failed', { id, message: e.message }); return null; });
    const report = (stage, status, note) => {
      progress.push({ stage, status, note: note || null, at: new Date(this.deps.now()) });
      return persistActive({ stage, progress: progress.slice(-40) });
    };
    const finish = async (patch) => {
      // A failed final write is retried once; if the database stays unavailable the stale-run recovery will close the row.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try { return await store.updateIfActive(id, pid, patch); } catch (e) { log('error', 'persist_final_failed', { id, attempt, message: e.message }); }
      }
      return null;
    };

    let timer; let heldProject = false; let heldGlobal = false;
    try {
      await projectLimiter.acquire(controller.signal); heldProject = true;
      await this.global.acquire(controller.signal); heldGlobal = true;
      if (controller.signal.aborted) throw cancelled();
      await persistActive({ status: 'running', startedAt: new Date(this.deps.now()) });
      timer = setTimeout(() => controller.abort(new InvestigationError(INVESTIGATION_ERROR.DEADLINE, 'The investigation took too long.', 504)), this.opts.deadlineMs);
      timer.unref?.();
      const outcome = await Promise.race([
        runInvestigation({ record, project, issue, deps: this.deps, signal: controller.signal, report, history }),
        new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason instanceof Error ? controller.signal.reason : cancelled()), { once: true })),
      ]);
      if (controller.signal.aborted) throw (controller.signal.reason instanceof Error ? controller.signal.reason : cancelled());
      const applied = await finish(terminal('completed', {
        finishedAt: new Date(this.deps.now()),
        planFamily: outcome.planFamily, promptVersion: outcome.promptVersion, contractVersion: outcome.contractVersion, model: outcome.model, tokens: outcome.tokens,
        evidenceTrace: outcome.evidenceTrace, result: outcome.result, warnings: outcome.warnings.slice(0, 20), lifecycle: outcome.lifecycle,
      }));
      if (!applied) log('warn', 'result_discarded', { id, projectId: pid, reason: 'run no longer active' });
      else log('info', 'completed', { id, projectId: pid, issueId: issue.issueId, family: outcome.planFamily, status: outcome.result.investigationStatus, degraded: outcome.degraded?.code });
    } catch (error) {
      const wasCancelled = error?.code === INVESTIGATION_ERROR.CANCELLED;
      const code = error?.code && Object.values(INVESTIGATION_ERROR).includes(error.code) ? error.code : INVESTIGATION_ERROR.INTERNAL;
      log(wasCancelled ? 'warn' : 'error', wasCancelled ? 'cancelled' : 'failed', { id, projectId: pid, code, message: error?.message });
      await finish(terminal(wasCancelled ? 'cancelled' : 'failed', {
        finishedAt: new Date(this.deps.now()),
        error: { code, message: wasCancelled || code === INVESTIGATION_ERROR.DEADLINE ? error.message : 'The investigation failed unexpectedly.' },
      }));
    } finally {
      clearTimeout(timer);
      if (heldGlobal) this.global.release();
      if (heldProject) projectLimiter.release();
    }
  }

  /**
   * Cancels an active investigation of THIS project and always reports an explicit outcome:
   *   cancelled   - stopped (running here) or marked cancelled (queued/running on another or a dead process)
   *   not_active  - it had already finished; nothing changed
   */
  async cancel(id, projectId) {
    const { store } = this.deps;
    const record = await store.findById(id, projectId);
    if (!record) return null;
    if (!['queued', 'running'].includes(record.status)) return { cancelled: false, outcome: 'not_active', record };
    const controller = this.controllers.get(String(id));
    if (controller) {
      controller.abort(cancelled());
      // The pipeline writes the terminal row itself; wait for it so the caller sees the final state.
      await this.running.get(String(id))?.catch(() => {});
    } else {
      // Not running in this process (another instance, or the process died): close the row directly.
      await store.updateIfActive(id, projectId, terminal('cancelled', { finishedAt: new Date(this.deps.now()), error: { code: INVESTIGATION_ERROR.CANCELLED, message: 'Investigation cancelled.' } }));
    }
    const after = await store.findById(id, projectId);
    return { cancelled: after?.status === 'cancelled', outcome: after?.status === 'cancelled' ? 'cancelled' : 'not_active', record: after };
  }

  /** Marks one stale active row as failed/INTERRUPTED unless this process is actually running it. Returns true if it was reaped. */
  async reapIfStale(record) {
    if (!record || !['queued', 'running'].includes(record.status)) return false;
    if (this.controllers.has(String(record._id))) return false; // alive in this process
    const stamp = record.updatedAt || record.createdAt;
    const last = stamp instanceof Date ? stamp.getTime() : Date.parse(stamp ?? ''); // (Date.parse(Date) would drop the milliseconds)
    if (!Number.isFinite(last) || this.deps.now() - last < this.opts.staleAfterMs) return false;
    const done = await this.deps.store.updateIfActive(record._id, record.projectId, terminal('failed', {
      finishedAt: new Date(this.deps.now()),
      error: { code: INVESTIGATION_ERROR.INTERRUPTED, message: 'The investigation was interrupted (server restart or crash) and did not finish. Start it again.' },
    }));
    if (done) this.deps.log?.('warn', 'reaped_stale', { id: String(record._id), projectId: String(record.projectId) });
    return !!done;
  }

  /** Startup/periodic recovery: fails every active run nobody has touched for `staleAfterMs`. Safe to call repeatedly and from several instances. */
  async recoverInterrupted() {
    const stale = await this.deps.store.findStale(this.opts.staleAfterMs, this.deps.now());
    let count = 0;
    for (const row of stale) {
      const full = await this.deps.store.findById(row._id, row.projectId);
      if (await this.reapIfStale(full)) count += 1;
    }
    return count;
  }
}

export { STAGES };
export default { InvestigationRunner, runInvestigation, validateRequest, sanitizeIssueMeta, InvestigationError, INVESTIGATION_ERROR };
