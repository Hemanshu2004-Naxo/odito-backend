import mongoose from 'mongoose';
import { ResponseUtil } from '../../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';
import * as runs from '../services/runService.js';
import { startManualRun } from '../services/auditTriggerService.js';
import { listPromptSets, getPromptSet } from '../../shared/prompts/services/promptSetService.js';
import * as evidenceService from '../../shared/evidence/services/evidenceService.js';
import { buildTrend, compareRuns } from '../../shared/services/runComparisonService.js';

/**
 * ChatGPT visibility HTTP handlers. Every route is mounted behind `auth` + validateProjectAccess(), which loads the project and
 * proves the caller owns it (req.project). Handlers then scope EVERY query by that project id, so a run or prompt-set id from
 * another project can never be read, cancelled or listed (it is simply "not found").
 *
 * Responses are explicit DTOs: lease, worker identity, provider request ids and raw provider payloads are never returned. The
 * list/summary views carry no answer text; the single-run view does (it is the detailed result the owner asked for).
 */

const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 10;

// Why an approved-question run was refused. Never a silent fall-back to the legacy five prompts.
const QUESTION_SET_REFUSALS = {
  NO_APPROVED_QUESTION_SET: { status: 409, message: 'This project has no approved question set. Approve one before running approved questions.' },
  QUESTION_SET_NOT_APPROVED: { status: 409, message: 'Only an approved question set can be run (this one is a draft, discarded or superseded).' },
  QUESTION_SET_NOT_FOUND: { status: 404, message: 'Question set not found' },
  QUESTION_SET_EMPTY: { status: 422, message: 'The approved question set has no enabled questions' },
  INVALID_MODE: { status: 400, message: 'Unsupported run mode' },
  MODEL_NOT_SUPPORTED: { status: 422, message: 'The configured ChatGPT model is not supported by the data provider account. Check CHATGPT_VISIBILITY_MODEL.' },
  MODEL_WEB_SEARCH_UNSUPPORTED: { status: 422, message: 'The configured ChatGPT model does not support web search. Choose another model or disable web search.' },
};

const LIMIT_STATUS = { PROJECT_COOLDOWN: 429, PROJECT_DAILY_LIMIT: 429, USER_DAILY_LIMIT: 429 };

export function toSummaryDto(run) {
  if (!run) return null;
  return {
    id: String(run._id),
    projectId: String(run.projectId),
    auditRunId: run.auditRunId ? String(run.auditRunId) : null,
    trigger: run.trigger ? { source: run.trigger.source, auditRunSource: run.trigger.auditRunSource ?? null } : null,
    executionMode: run.executionMode || 'legacy_prompts',
    provider: run.provider || 'chatgpt',
    questionSetId: run.questionSetId ? String(run.questionSetId) : null,
    questionSetVersion: run.questionSetVersion ?? null,
    questionStats: run.executionMode === 'approved_questions' ? (run.questionStats || null) : null,
    status: run.status,
    progress: run.progress ? { completed: run.progress.completed, total: run.progress.total, stage: run.progress.stage } : null,
    promptSetVersion: run.promptSetVersion ?? null,
    promptGeneratedBy: run.promptGeneratedBy ?? null,
    metrics: run.metrics ?? null,
    totalCost: run.totalCost ?? null,
    failureCode: run.failureCode ?? null,
    cancelRequested: Boolean(run.cancelRequested),
    startedAt: run.startedAt ?? null,
    completedAt: run.completedAt ?? null,
    failedAt: run.failedAt ?? null,
    createdAt: run.createdAt ?? null,
    // The results are sampled observations from one provider, not a census of what ChatGPT says or cites.
    sampled: true,
  };
}

/**
 * The numbers behind an "AI Search" card: headline Mentions / Cited Pages / visibility score plus one row per platform. Built from the
 * latest finished APPROVED-question run's persisted metrics; null when none exists (legacy five-prompt runs are not included: five
 * hand-picked prompts are not a comparable question set). Only ChatGPT is collected today; other platforms will add rows.
 */
export function toOverviewDto(run) {
  const m = run?.metrics;
  const v = m?.visibility;
  if (!run || run.executionMode !== 'approved_questions' || !v) return null;
  const limitations = m.limitations || [];
  const eligible = v.succeeded;
  const rate = (n) => (eligible > 0 ? Math.round((n / eligible) * 10_000) / 10_000 : null);
  return {
    source: 'approved_questions',
    runId: String(run._id),
    questionSetVersion: run.questionSetVersion ?? null,
    status: run.status,
    completedAt: run.completedAt ?? null,
    questionsPlanned: m.questionsPlanned ?? null,
    partial: Boolean(m.partial),
    // Every rate below = count / eligibleAnswers (answered discovery questions; brand diagnostic, failed and skipped questions excluded).
    eligibleAnswers: eligible,
    execution: { attempted: v.attempted, answered: v.succeeded, failed: v.failed, skipped: v.skipped },
    visibility: { rate: v.brandMentionRate ?? null, answers: v.answersMentioningBrand },
    recommendation: { rate: v.recommendationRate ?? null, answers: v.answersRecommendingBrand, method: 'heuristic_v1' },
    websiteCitation: { rate: v.websiteCitationRate ?? null, answers: v.answersCitingWebsite },
    uniqueCitedPages: v.uniqueFirstPartyPages ?? null,
    citationOccurrences: v.firstPartyCitationOccurrences ?? null,
    competitors: {
      configured: !limitations.includes('NO_KNOWN_COMPETITORS'),
      mentioned: (v.competitorMentions?.competitors || []).map((c) => ({ name: c.name, answers: c.responses, rate: c.rate ?? rate(c.responses), occurrences: c.occurrences })),
    },
    cost: m.cost ?? null,
    limitations,
    sampled: true,
  };
}

/** `range` (30d | 90d | 365d | all) or explicit ISO `from` / `to`. Returns { from, to } Dates or null, or { error }. */
export function parseRange(query = {}) {
  const DAYS = { '30d': 30, '90d': 90, '365d': 365 };
  const iso = (v) => { if (typeof v !== 'string' || !v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? undefined : d; };
  const from = iso(query.from);
  const to = iso(query.to);
  if (from === undefined || to === undefined) return { error: 'from / to must be ISO dates' };
  if (from || to) return { from, to };
  const range = query.range || '90d';
  if (range === 'all') return { from: null, to: null };
  if (!DAYS[range]) return { error: 'range must be 30d, 90d, 365d or all' };
  return { from: new Date(Date.now() - DAYS[range] * 86_400_000), to: null };
}

/** Evidence DTO: explicit allow-list. List views omit the answer and citations. Provider request ids, claims and raw payloads are never returned. */
export function toEvidenceDto(e, { detail = false } = {}) {
  if (!e) return null;
  return {
    runId: String(e.runId),
    questionSetId: String(e.questionSetId),
    questionSetVersion: e.questionSetVersion,
    questionId: e.questionId,
    group: e.group,
    intent: e.intent,
    question: e.questionText,
    service: e.service ?? null,
    location: e.location ?? null,
    language: e.language,
    provider: e.provider,
    status: e.status,
    attempts: e.attempts,
    model: e.model ?? null,
    modelReported: e.modelReported ?? null,
    webSearch: e.webSearch ?? null,
    country: e.country ?? null,
    city: e.city ?? null,
    locationApplied: e.locationApplied ?? 'none',
    firstPartyPages: e.firstPartyPages || [],
    externalDomains: e.externalDomains || [],
    analysis: e.analysis ? {
      brandMentioned: e.analysis.brandMentioned ?? null,
      brandMentionCount: e.analysis.brandMentionCount ?? null,
      recommended: e.analysis.recommended ?? null,
      recommendationMethod: e.analysis.recommendationMethod ?? null,
      competitorMentions: e.analysis.competitorMentions || [],
    } : null,
    cost: e.cost ?? null,
    costStatus: e.costStatus,
    costUnit: e.costUnit ?? null,
    errorCode: e.errorCode ?? null,
    errorClass: e.errorClass ?? null,
    retryable: e.retryable ?? null,
    startedAt: e.startedAt ?? null,
    completedAt: e.completedAt ?? null,
    durationMs: e.durationMs ?? null,
    ...(detail ? {
      answer: e.answerText ?? null,
      citations: (e.citations || []).map((c) => ({ url: c.url, normalizedUrl: c.normalizedUrl ?? null, host: c.host ?? null, title: c.title ?? null, isTarget: Boolean(c.isTarget) })),
    } : {}),
  };
}

export function toExecutionDto(e) {
  return {
    category: e.category,
    branded: e.branded,
    prompt: e.promptText,
    status: e.status,
    attempts: e.attempts,
    model: e.model ?? null,
    webSearch: e.webSearch ?? null,
    country: e.country ?? null,
    city: e.city ?? null,
    answer: e.answerText ?? null,
    annotations: e.annotations || [],
    analysis: e.analysis ? {
      brandMentioned: e.analysis.brandMentioned,
      brandMentionCount: e.analysis.brandMentionCount,
      targetCitationCount: e.analysis.targetCitationCount,
      targetPages: e.analysis.targetPages,
      competitorMentions: e.analysis.competitorMentions,
    } : null,
    cost: e.cost ?? null,
    errorCode: e.errorCode ?? null,
    retryable: e.retryable ?? null,
    executedAt: e.executedAt ?? null,
  };
}

export function toDetailDto(run) {
  if (!run) return null;
  return {
    ...toSummaryDto(run),
    target: run.target ? {
      businessName: run.target.brandNames?.[0] ?? null,
      nameSource: run.target.nameSource ?? null,
      nameVerified: run.target.nameVerified ?? null,
      knownCompetitors: run.target.competitors || [],
      targetHost: run.target.targetHost ?? null,
    } : null,
    market: run.market ?? null,
    executions: (run.executions || []).map(toExecutionDto),
    // Approved-question runs: the exact questions asked (the immutable snapshot) and the server policy applied. Answers are in /evidence.
    questions: run.executionMode === 'approved_questions'
      ? (run.questionSnapshot || []).map((q) => ({ questionId: q.questionId, group: q.group, intent: q.intent, question: q.text, service: q.service ?? null, location: q.location ?? null, language: q.language }))
      : undefined,
    policy: run.executionMode === 'approved_questions' ? (run.policy ?? null) : undefined,
  };
}

export function toPromptSetDto(set) {
  if (!set) return null;
  return {
    id: String(set._id),
    version: set.version,
    generatorVersion: set.generatorVersion,
    generatedBy: set.generatedBy,
    fallbackReason: set.fallbackReason ?? null,
    model: set.model ?? null,
    promptLanguage: set.promptLanguage ?? 'en',
    prompts: (set.prompts || []).map((p) => ({ category: p.category, text: p.text, branded: p.branded, usesService: p.usesService, usesCompetitors: p.usesCompetitors })),
    createdAt: set.createdAt,
  };
}

/** Bounded, validated pagination. */
export function parsePagination(query = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(query.limit, 10) || DEFAULT_PAGE_SIZE));
  return { page, limit, skip: (page - 1) * limit };
}

const fail = (res, status, message, details = null) => res.status(status).json(ResponseUtil.error(message, status, details));
const objectIdOr404 = (res, id, label) => {
  if (!mongoose.isValidObjectId(id)) { fail(res, 404, `${label} not found`); return false; }
  return true;
};

export async function startRun(req, res) {
  try {
    // Only `mode` and `questionSetId` are read from the body. A question-set id is a lookup key that is re-validated against the database
    // (project-scoped, must be approved); model, search, limits and question text can never be supplied by a client.
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const mode = body.mode === undefined ? 'legacy_prompts' : body.mode;
    if (mode !== 'legacy_prompts' && mode !== 'approved_questions') return fail(res, 400, 'mode must be "legacy_prompts" or "approved_questions"');
    if (body.questionSetId !== undefined && (typeof body.questionSetId !== 'string' || !mongoose.isValidObjectId(body.questionSetId))) return fail(res, 400, 'questionSetId is not valid');
    const result = await startManualRun({ projectId: req.project._id, userId: req.project.user_id, mode, questionSetId: body.questionSetId || null });
    if (result.scheduled) return res.status(202).json(ResponseUtil.success(toSummaryDto(result.run), 'ChatGPT visibility run queued'));
    if (result.reason === 'DISABLED') return fail(res, 503, 'ChatGPT visibility is not enabled');
    if (QUESTION_SET_REFUSALS[result.reason]) { const r = QUESTION_SET_REFUSALS[result.reason]; return fail(res, r.status, r.message, { code: result.reason }); }
    if (result.reason === 'ACTIVE_RUN_EXISTS') return res.status(409).json({ ...ResponseUtil.error('A visibility run is already in progress for this project', 409), data: toSummaryDto(result.run) });
    if (LIMIT_STATUS[result.reason]) {
      return fail(res, LIMIT_STATUS[result.reason], result.limit?.message || 'Run limit reached', { code: result.reason, retryAfterMs: result.limit?.retryAfterMs ?? null });
    }
    return fail(res, 500, 'Could not start the visibility run');
  } catch (error) {
    LoggerUtil.error('ChatGPT visibility: start failed', { projectId: String(req.project?._id), code: error?.code });
    return fail(res, 500, 'Could not start the visibility run');
  }
}

/** The latest finished run plus the run currently in progress (if any). */
export async function getSummary(req, res) {
  try {
    const [latest, active, latestApproved] = await Promise.all([
      runs.getLatestRun({ projectId: req.project._id }), runs.getActiveRun({ projectId: req.project._id }), runs.getLatestApprovedRun({ projectId: req.project._id }),
    ]);
    return res.json(ResponseUtil.success({ latest: toSummaryDto(latest), active: toSummaryDto(active), overview: toOverviewDto(latestApproved) }));
  } catch (error) {
    LoggerUtil.error('ChatGPT visibility: summary failed', { projectId: String(req.project?._id) });
    return fail(res, 500, 'Could not load the visibility summary');
  }
}

export async function listRunHistory(req, res) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { items, total } = await runs.listRuns({ projectId: req.project._id, limit, skip });
    return res.json(ResponseUtil.success(items.map(toSummaryDto), 'Success', { page, limit, total, totalPages: Math.ceil(total / limit) }));
  } catch (error) {
    LoggerUtil.error('ChatGPT visibility: history failed', { projectId: String(req.project?._id) });
    return fail(res, 500, 'Could not load the visibility history');
  }
}

export async function getRunDetail(req, res) {
  try {
    if (!objectIdOr404(res, req.params.runId, 'Run')) return undefined;
    const run = await runs.getRun({ projectId: req.project._id, runId: req.params.runId });
    if (!run) return fail(res, 404, 'Run not found');
    return res.json(ResponseUtil.success(toDetailDto(run)));
  } catch (error) {
    LoggerUtil.error('ChatGPT visibility: run detail failed', { projectId: String(req.project?._id) });
    return fail(res, 500, 'Could not load the visibility run');
  }
}

export async function cancelRun(req, res) {
  try {
    if (!objectIdOr404(res, req.params.runId, 'Run')) return undefined;
    const { result, run } = await runs.requestCancel({ projectId: req.project._id, runId: req.params.runId });
    if (result === 'not_found') return fail(res, 404, 'Run not found');
    if (result === 'not_cancellable') return fail(res, 409, 'This run has already finished');
    return res.status(result === 'cancelled' ? 200 : 202).json(ResponseUtil.success(toSummaryDto(run), result === 'cancelled' ? 'Run cancelled' : 'Cancellation requested'));
  } catch (error) {
    LoggerUtil.error('ChatGPT visibility: cancel failed', { projectId: String(req.project?._id) });
    return fail(res, 500, 'Could not cancel the visibility run');
  }
}

export async function listProjectPromptSets(req, res) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const items = await listPromptSets(req.project._id, { limit, skip });
    return res.json(ResponseUtil.success(items.map(toPromptSetDto), 'Success', { page, limit }));
  } catch (error) {
    LoggerUtil.error('ChatGPT visibility: prompt sets failed', { projectId: String(req.project?._id) });
    return fail(res, 500, 'Could not load the prompt sets');
  }
}

export async function getProjectPromptSet(req, res) {
  try {
    if (!objectIdOr404(res, req.params.setId, 'Prompt set')) return undefined;
    const set = await getPromptSet(req.project._id, req.params.setId);
    if (!set) return fail(res, 404, 'Prompt set not found');
    return res.json(ResponseUtil.success(toPromptSetDto(set)));
  } catch (error) {
    LoggerUtil.error('ChatGPT visibility: prompt set failed', { projectId: String(req.project?._id) });
    return fail(res, 500, 'Could not load the prompt set');
  }
}

/** Visibility over time: one point per finished approved-question run in the range, flagged when the question set changed. */
export async function getTrend(req, res) {
  try {
    const range = parseRange(req.query);
    if (range.error) return fail(res, 400, range.error);
    const items = await runs.listApprovedRunsInRange({ projectId: req.project._id, from: range.from, to: range.to });
    return res.json(ResponseUtil.success({ points: buildTrend(items), from: range.from, to: range.to }));
  } catch (error) {
    LoggerUtil.error('ChatGPT visibility: trend failed', { projectId: String(req.project?._id) });
    return fail(res, 500, 'Could not load the visibility trend');
  }
}

/** The website's most-cited pages (distinct pages, occurrences, questions citing each) for one run or a date range. */
export async function getCitedPages(req, res) {
  try {
    let runId = null;
    if (req.query.runId !== undefined) {
      if (!mongoose.isValidObjectId(req.query.runId)) return fail(res, 400, 'runId is not valid');
      const run = await runs.getRun({ projectId: req.project._id, runId: req.query.runId });
      if (!run) return fail(res, 404, 'Run not found');
      runId = run._id;
    }
    const range = runId ? { from: null, to: null } : parseRange(req.query);
    if (range.error) return fail(res, 400, range.error);
    const group = req.query.group === 'brand_reputation' ? 'brand_reputation' : 'visibility';
    const pages = await evidenceService.aggregateCitedPages({ projectId: req.project._id, runId, from: range.from, to: range.to, group });
    return res.json(ResponseUtil.success({ pages, runId: runId ? String(runId) : null, group }));
  } catch (error) {
    LoggerUtil.error('ChatGPT visibility: cited pages failed', { projectId: String(req.project?._id) });
    return fail(res, 500, 'Could not load the cited pages');
  }
}

/** Compare two finished approved-question runs of this project; non-equivalent question sets are flagged, never silently compared. */
export async function compareProjectRuns(req, res) {
  try {
    const { runA, runB } = req.query;
    if (!mongoose.isValidObjectId(runA) || !mongoose.isValidObjectId(runB)) return fail(res, 400, 'runA and runB must be run ids');
    const [a, b] = await Promise.all([runs.getRun({ projectId: req.project._id, runId: runA }), runs.getRun({ projectId: req.project._id, runId: runB })]);
    if (!a || !b) return fail(res, 404, 'Run not found');
    if (a.executionMode !== 'approved_questions' || b.executionMode !== 'approved_questions') return fail(res, 422, 'Only approved-question runs can be compared', { code: 'NOT_COMPARABLE_MODE' });
    const [older, newer] = new Date(a.createdAt) <= new Date(b.createdAt) ? [a, b] : [b, a];
    return res.json(ResponseUtil.success(compareRuns(older, newer)));
  } catch (error) {
    LoggerUtil.error('ChatGPT visibility: compare failed', { projectId: String(req.project?._id) });
    return fail(res, 500, 'Could not compare the runs');
  }
}

/** Evidence of one approved-question run: paginated, no answer text in the list. */
export async function listRunEvidence(req, res) {
  try {
    if (!objectIdOr404(res, req.params.runId, 'Run')) return undefined;
    const run = await runs.getRun({ projectId: req.project._id, runId: req.params.runId });
    if (!run) return fail(res, 404, 'Run not found');
    const { page, limit, skip } = parsePagination(req.query);
    // Allow-listed and type-checked in buildEvidenceFilter (search text is escaped).
    const { status, group, intent, mentioned, recommended, cited, citedUrl, competitor, q } = req.query;
    const filter = { status, group, intent, mentioned, recommended, cited, citedUrl, competitor, q };
    const { items, total } = await evidenceService.listEvidence({ projectId: req.project._id, runId: run._id, filter, limit, skip });
    return res.json(ResponseUtil.success(items.map((e) => toEvidenceDto(e)), 'Success', { page, limit, total, totalPages: Math.ceil(total / limit) }));
  } catch (error) {
    LoggerUtil.error('ChatGPT visibility: evidence list failed', { projectId: String(req.project?._id) });
    return fail(res, 500, 'Could not load the evidence');
  }
}

/** One question's full evidence (answer + citations): the "View answer" view. */
export async function getRunEvidence(req, res) {
  try {
    if (!objectIdOr404(res, req.params.runId, 'Run')) return undefined;
    const e = await evidenceService.getEvidence({ projectId: req.project._id, runId: req.params.runId, questionId: String(req.params.questionId) });
    if (!e) return fail(res, 404, 'Evidence not found');
    return res.json(ResponseUtil.success(toEvidenceDto(e, { detail: true })));
  } catch (error) {
    LoggerUtil.error('ChatGPT visibility: evidence failed', { projectId: String(req.project?._id) });
    return fail(res, 500, 'Could not load the evidence');
  }
}

/** One question's history across runs: the same question over time. */
export async function getQuestionHistory(req, res) {
  try {
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const items = await evidenceService.listQuestionHistory({ projectId: req.project._id, questionId: String(req.params.questionId), limit });
    return res.json(ResponseUtil.success(items.map((e) => toEvidenceDto(e))));
  } catch (error) {
    LoggerUtil.error('ChatGPT visibility: question history failed', { projectId: String(req.project?._id) });
    return fail(res, 500, 'Could not load the question history');
  }
}

export default { listRunEvidence, getRunEvidence, getQuestionHistory, startRun, getSummary, listRunHistory, getRunDetail, cancelRun, listProjectPromptSets, getProjectPromptSet };
