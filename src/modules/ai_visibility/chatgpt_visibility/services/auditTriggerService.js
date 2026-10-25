import { LoggerUtil } from '../../../../utils/LoggerUtil.js';
import SeoProject from '../../../app_user/model/SeoProject.js';
import Job from '../../../jobs/model/Job.js';
import ChatGptVisibilityRun from '../models/ChatGptVisibilityRun.js';
import AiVisibilityQuestionSet from '../../shared/questions/models/AiVisibilityQuestionSet.js';
import { QUESTION_STATUS, GROUPS } from '../../shared/questions/config/questionConfig.js';
import { getChatGptConfig } from '../config/chatgptConfig.js';
import * as runs from './runService.js';
import { emitVisibilityEvent } from './visibilityEvents.js';
import { kick } from '../workers/runWorker.js';
import { checkModel as defaultCheckModel } from '../providers/modelCatalog.js';

/**
 * Starting visibility runs: from an accepted full audit (automatic), from the repair sweep (crash safety), or by a user (manual).
 * All three share one policy gate and one creation path.
 *
 * Why this is independent of the SEO audit: it is called AFTER startProjectAudit() has committed to the audit, it is
 * fire-and-forget, it never throws, and everything it writes lives in its own collection. It adds nothing to pipelineConfig or the
 * chaining engine, and an audit that is cancelled, recrawled or failing does not touch it.
 *
 * Crash safety: the audit claim stamps current_run_id / current_run_source on the project atomically. If the process dies before
 * the run record below is written, the recovery sweep (repairMissingRuns) finds that project - audit started recently, seed jobs
 * exist for that run id, no visibility record for it - and creates the run. A policy refusal is itself recorded (status `skipped`)
 * so the sweep does not re-attempt a decision that was already made. The repair window is bounded (CHATGPT_VISIBILITY_REPAIR_WINDOW_MS):
 * an outage longer than that loses the automatic run for that audit (a user can still start one manually).
 */

const SERVICE = 'ChatGptVisibilityTrigger';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Cost / abuse limits. Returns null when allowed, otherwise { code, message, retryAfterMs? }. Skipped runs are not counted.
 * No subscription allowance exists in a reliable form in this codebase, so these are flat, configurable, conservative limits.
 */
export async function checkRunLimits({ projectId, userId, now = new Date(), config = getChatGptConfig(), Model = ChatGptVisibilityRun }) {
  if (!config.limitsEnabled) return null; // limits switched off (CHATGPT_VISIBILITY_LIMITS_ENABLED)
  const counted = { status: { $ne: 'skipped' } };
  const last = await Model.findOne({ projectId, ...counted }).sort({ createdAt: -1 }).select('createdAt').lean();
  if (config.cooldownMs > 0 && last && now.getTime() - new Date(last.createdAt).getTime() < config.cooldownMs) {
    return { code: 'PROJECT_COOLDOWN', message: 'A visibility run was started for this project very recently', retryAfterMs: config.cooldownMs - (now.getTime() - new Date(last.createdAt).getTime()) };
  }
  const since = new Date(now.getTime() - DAY_MS);
  const perProject = await Model.countDocuments({ projectId, createdAt: { $gte: since }, ...counted });
  if (perProject >= config.maxRunsPerProjectPerDay) return { code: 'PROJECT_DAILY_LIMIT', message: 'The daily visibility run limit for this project has been reached' };
  const perUser = await Model.countDocuments({ userId, createdAt: { $gte: since }, ...counted });
  if (perUser >= config.dailyUserLimit) return { code: 'USER_DAILY_LIMIT', message: 'The daily visibility run limit for this account has been reached' };
  return null;
}

/** Shared creation path. `enforceLimits` refusals are recorded as `skipped` for automatic triggers, returned as an error for manual ones. */
async function startRun({ projectId, userId, auditRunId, triggerSource, auditRunSource, extra = null }, { config, now, Model, recordRefusal }) {
  // Idempotency first: an audit run that already has a record (queued, finished or a recorded refusal) is never evaluated again.
  if (auditRunId) {
    const existing = await Model.findOne({ projectId, auditRunId }).lean();
    if (existing) return { scheduled: false, reason: 'DUPLICATE_AUDIT_RUN', run: existing };
  }
  const limit = await checkRunLimits({ projectId, userId, now: now(), config, Model });
  if (limit) {
    if (recordRefusal) {
      const rec = await runs.createRun({ projectId, userId, auditRunId, triggerSource, auditRunSource, status: 'skipped', failureCode: limit.code, failureMessage: limit.message }, { Model, now });
      return { scheduled: false, reason: limit.code, run: rec.run };
    }
    return { scheduled: false, reason: limit.code, limit };
  }
  const created = await runs.createRun({ projectId, userId, auditRunId, triggerSource, auditRunSource, extra }, { Model, now });
  if (!created.created) {
    return created.duplicate
      ? { scheduled: false, reason: 'DUPLICATE_AUDIT_RUN', run: created.run }
      : { scheduled: false, reason: 'ACTIVE_RUN_EXISTS', run: created.activeRun };
  }
  emitVisibilityEvent('started', created.run);
  return { scheduled: true, reason: null, run: created.run };
}

/**
 * Called by startProjectAudit() once an audit has been accepted. NEVER throws and is safe to not await.
 * @returns {Promise<{scheduled:boolean, reason:string|null, run?:object}>}
 */
export async function scheduleChatGptVisibilityForAudit({ projectId, userId, auditRunId, runSource }, deps = {}) {
  const config = deps.config || getChatGptConfig();
  const now = deps.now || (() => new Date());
  const Model = deps.Model || ChatGptVisibilityRun;
  try {
    if (!config.enabled || !config.autoRun) return { scheduled: false, reason: 'DISABLED' };
    if (!config.autoRunSources.includes(runSource)) return { scheduled: false, reason: 'RUN_SOURCE_NOT_ELIGIBLE' };
    if (!projectId || !userId || !auditRunId) return { scheduled: false, reason: 'MISSING_IDENTIFIERS' };
    const result = await startRun(
      { projectId, userId, auditRunId, triggerSource: deps.triggerSource || 'audit', auditRunSource: runSource },
      { config, now, Model, recordRefusal: true },
    );
    if (result.scheduled) (deps.kick || kick)(String(result.run._id));
    return result;
  } catch (error) {
    // Never let visibility scheduling surface into the audit start.
    LoggerUtil.error(`${SERVICE}: scheduling failed (audit unaffected)`, { projectId: String(projectId), code: error?.code, message: error?.message?.slice(0, 200) });
    return { scheduled: false, reason: 'ERROR' };
  }
}

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

/**
 * Resolve the question set an approved-question run may execute. The id (if any) is only ever a lookup key: the set is loaded from the
 * database scoped to the project and must be in the `approved` state. A draft, discarded or archived (superseded) set never executes,
 * and a missing approved set is an explicit refusal - never a silent fall-back to the legacy five prompts.
 * @returns {Promise<{ok:true,set:object}|{ok:false,reason:string}>}
 */
export async function resolveApprovedQuestionSet({ projectId, questionSetId = null }, { QuestionSetModel = AiVisibilityQuestionSet } = {}) {
  if (questionSetId) {
    const set = await QuestionSetModel.findOne({ _id: questionSetId, projectId }).lean();
    if (!set) return { ok: false, reason: 'QUESTION_SET_NOT_FOUND' };
    if (set.status !== QUESTION_STATUS.APPROVED) return { ok: false, reason: 'QUESTION_SET_NOT_APPROVED' };
    return { ok: true, set };
  }
  const set = await QuestionSetModel.findOne({ projectId, status: QUESTION_STATUS.APPROVED }).lean();
  return set ? { ok: true, set } : { ok: false, reason: 'NO_APPROVED_QUESTION_SET' };
}

/**
 * The immutable copy of what a run asks: enabled questions of the approved set (visibility first, high priority first, then brand
 * reputation), capped at the server's maxQuestionsPerRun. `truncated` reports how many enabled questions did not fit.
 */
export function buildQuestionSnapshot(set, config = getChatGptConfig()) {
  const cities = (set.inputs?.cities || []).map((c) => String(c));
  const enabled = (set.questions || []).filter((q) => q.enabled && typeof q.text === 'string' && q.text.trim());
  const rank = (q) => PRIORITY_RANK[q.priority] ?? 1;
  const ordered = [
    ...enabled.filter((q) => q.group === GROUPS.VISIBILITY).map((q, i) => ({ q, i })).sort((a, b) => rank(a.q) - rank(b.q) || a.i - b.i).map((x) => x.q),
    // Brand-name questions are no longer asked, even when an older approved set still contains them.
  ];
  const kept = ordered.slice(0, config.maxQuestionsPerRun);
  const snapshot = kept.map((q) => ({
    questionId: q.id,
    group: q.group,
    intent: q.intent,
    text: q.text.trim(),
    service: q.service ?? null,
    location: q.location ?? null,
    language: q.language || 'en',
    templateId: q.templateId ?? null,
    priority: q.priority || 'medium',
    searchCity: q.location ? (cities.find((c) => c.toLowerCase() === String(q.location).toLowerCase()) || null) : null,
  }));
  return { snapshot, truncated: ordered.length - kept.length };
}

/**
 * User-initiated run for a project the caller already proved ownership of (route middleware).
 * mode 'legacy_prompts' (default) is the original five-prompt run, unchanged. mode 'approved_questions' runs a snapshot of the
 * project's approved question set.
 */
export async function startManualRun({ projectId, userId, mode = 'legacy_prompts', questionSetId = null }, deps = {}) {
  const config = deps.config || getChatGptConfig();
  const now = deps.now || (() => new Date());
  const Model = deps.Model || ChatGptVisibilityRun;
  if (!config.enabled) return { scheduled: false, reason: 'DISABLED' };

  let extra = null;
  if (mode === 'approved_questions') {
    const resolved = await resolveApprovedQuestionSet({ projectId, questionSetId }, { QuestionSetModel: deps.QuestionSetModel });
    if (!resolved.ok) return { scheduled: false, reason: resolved.reason };
    const { snapshot, truncated } = buildQuestionSnapshot(resolved.set, config);
    if (!snapshot.length) return { scheduled: false, reason: 'QUESTION_SET_EMPTY' };
    // The configured model must be one the provider account actually supports; it is never silently swapped for another.
    const model = await (deps.checkModel || defaultCheckModel)(config.model, { webSearch: config.webSearch });
    if (model.supported === false) return { scheduled: false, reason: model.reason, model: config.model };
    LoggerUtil.info('ChatGPT visibility: approved-question run requested', { projectId: String(projectId), model: config.model, webSearch: config.webSearch, modelVerified: model.supported === true });
    extra = {
      executionMode: 'approved_questions',
      provider: 'chatgpt',
      questionSetId: resolved.set._id,
      questionSetVersion: resolved.set.version,
      questionSnapshot: snapshot,
      questionStats: { total: snapshot.length, succeeded: 0, failed: 0, skipped: 0, pending: snapshot.length },
      // What the SERVER applied; nothing here can come from a request.
      policy: {
        model: config.model, webSearch: config.webSearch, maxOutputTokens: config.maxOutputTokens, timeoutMs: config.timeoutMs,
        maxRetries: config.maxRetries, maxConcurrentPrompts: config.maxConcurrentPrompts, maxRunCost: config.maxRunCost,
        maxQuestionsPerRun: config.maxQuestionsPerRun, truncatedQuestions: truncated, costUnit: config.costUnit,
      },
    };
  } else if (mode !== 'legacy_prompts') {
    return { scheduled: false, reason: 'INVALID_MODE' };
  }

  const result = await startRun({ projectId, userId, auditRunId: null, triggerSource: 'manual', auditRunSource: null, extra }, { config, now, Model, recordRefusal: false });
  if (result.scheduled) (deps.kick || kick)(String(result.run._id));
  return result;
}

/**
 * Crash-safety repair: create the run for any recent full audit that has none. Idempotent and bounded.
 * @returns {Promise<number>} runs created or recorded
 */
export async function repairMissingRuns({ config = getChatGptConfig(), now = () => new Date(), Model = ChatGptVisibilityRun, limit = 50 } = {}) {
  if (!config.enabled || !config.autoRun) return 0;
  const since = new Date(now().getTime() - config.repairWindowMs);
  const candidates = await SeoProject.find({
    is_deleted: { $ne: true },
    current_run_id: { $ne: null },
    current_run_source: { $in: config.autoRunSources },
    audit_started_at: { $gte: since },
    crawl_status: { $nin: ['cancelled', 'failed', 'draft'] },
  }).select('_id user_id current_run_id current_run_source').limit(limit).lean();

  let handled = 0;
  for (const p of candidates) {
    try {
      if (await Model.exists({ projectId: p._id, auditRunId: p.current_run_id })) continue;
      // The audit really started: its seed jobs carry this run id (a start that failed and released its lock created none).
      if (!(await Job.exists({ project_id: p._id, run_id: p.current_run_id }))) continue;
      const result = await scheduleChatGptVisibilityForAudit(
        { projectId: p._id, userId: p.user_id, auditRunId: p.current_run_id, runSource: p.current_run_source },
        { config, now, Model, triggerSource: 'repair' },
      );
      if (result.scheduled || result.reason === 'PROJECT_COOLDOWN' || result.run) handled += 1;
    } catch (error) {
      LoggerUtil.error(`${SERVICE}: repair failed for a project`, { projectId: String(p._id), message: error?.message?.slice(0, 200) });
    }
  }
  return handled;
}

export default { scheduleChatGptVisibilityForAudit, startManualRun, repairMissingRuns, checkRunLimits };
