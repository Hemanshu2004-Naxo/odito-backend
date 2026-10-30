import mongoose from 'mongoose';
import { ResponseUtil } from '../../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';
import { SERP_DEVICES } from '../../../ranking/services/serpDevices.js';
import * as runs from '../services/runService.js';
import * as evidenceService from '../services/evidenceService.js';
import { startManualRun, previewRun } from '../services/startRunService.js';
import { QUESTIONS_PER_RUN } from '../config/googleAioConfig.js';

/**
 * Google AI Overview Visibility HTTP handlers. Mounted behind `auth` + validateProjectAccess() (req.project is proven to belong to
 * the caller) and every query is scoped by that project id, so a run or question id from another project is simply "not found".
 *
 * Responses are explicit DTOs: lease, worker identity, provider request ids and raw provider payloads are never returned. Overview
 * text is returned as plain text/markdown to be rendered ESCAPED by the client; reference URLs are restricted to http(s) by the parser.
 */

const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 10;

const REFUSALS = {
  DISABLED: [503, 'Google AI Overview Visibility is not enabled'],
  NO_APPROVED_QUESTION_SET: [409, 'This project has no approved question set. Generate and approve one first.'],
  NOT_ENOUGH_QUESTIONS: [422, null],
  QUESTION_COUNT_INVALID: [422, null],
  QUESTION_IDS_INVALID: [400, null],
  DUPLICATE_QUESTION: [422, null],
  QUESTION_NOT_ELIGIBLE: [422, null],
  DEVICE_NOT_SUPPORTED: [400, 'device must be "desktop" or "mobile"'],
  PROFILE_LOCATION_CONFLICT: [422, 'Confirm the target city in the business profile: the project has two different cities on record.'],
  LOCATION_COUNTRY_MISSING: [422, null],
  LOCATION_CITY_MISSING: [422, null],
  LOCATION_NOT_FOUND: [422, null],
  LOCATION_AMBIGUOUS: [422, null],
  LOCATION_LOOKUP_FAILED: [503, null],
  INVALID_LANGUAGE_CODE: [422, 'The project language is not valid for Google search.'],
  PROJECT_DAILY_LIMIT: [429, null],
};

const fail = (res, status, message, details = null) => res.status(status).json(ResponseUtil.error(message, status, details));
const objectIdOr404 = (res, id, label) => {
  if (!mongoose.isValidObjectId(id)) { fail(res, 404, `${label} not found`); return false; }
  return true;
};

export function parsePagination(query = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(query.limit, 10) || DEFAULT_PAGE_SIZE));
  return { page, limit, skip: (page - 1) * limit };
}

export function parseRange(query = {}) {
  const DAYS = { '30d': 30, '90d': 90, '365d': 365 };
  const range = query.range || '90d';
  if (range === 'all') return { from: null, to: null };
  if (!DAYS[range]) return { error: 'range must be 30d, 90d, 365d or all' };
  return { from: new Date(Date.now() - DAYS[range] * 86_400_000), to: null };
}

const parseDevice = (v) => (v === undefined ? 'desktop' : (Object.hasOwn(SERP_DEVICES, v) ? v : null));

// ── DTOs ──
export function toSummaryDto(run) {
  if (!run) return null;
  return {
    id: String(run._id),
    projectId: String(run.projectId),
    provider: 'google_aio',
    status: run.status,
    progress: run.progress ? { completed: run.progress.completed, total: run.progress.total, stage: run.progress.stage } : null,
    questionStats: run.questionStats || null,
    questionSetId: run.questionSetId ? String(run.questionSetId) : null,
    questionSetVersion: run.questionSetVersion ?? null,
    selectionMode: run.selectionMode ?? null,
    location: run.serp ? { code: run.serp.locationCode, name: run.serp.locationName ?? null, languageCode: run.serp.languageCode, device: run.serp.device, os: run.serp.os } : null,
    metrics: run.metrics ?? null,
    totalCost: run.totalCost ?? null,
    failureCode: run.failureCode ?? null,
    cancelRequested: Boolean(run.cancelRequested),
    startedAt: run.startedAt ?? null,
    completedAt: run.completedAt ?? null,
    failedAt: run.failedAt ?? null,
    createdAt: run.createdAt ?? null,
    sampled: true,
  };
}

export function toDetailDto(run) {
  if (!run) return null;
  return {
    ...toSummaryDto(run),
    target: run.target ? {
      businessName: run.target.brandNames?.[0] ?? null,
      nameVerified: run.target.nameVerified ?? null,
      brandMatchReliable: run.target.brandMatchReliable ?? null,
      knownCompetitors: run.target.competitors || [],
      ownedHost: run.target.targetHost ?? null,
    } : null,
    market: run.market ?? null,
    questions: (run.questionSnapshot || []).map((q, i) => ({ position: i + 1, questionId: q.questionId, intent: q.intent, question: q.text, service: q.service ?? null, location: q.location ?? null, language: q.language })),
    policy: run.policy ?? null,
  };
}

/** What the figure cards show: from the latest finished run's persisted metrics. Null when no run has produced results. */
export function toOverviewDto(run) {
  const m = run?.metrics;
  if (!run || !m) return null;
  return {
    runId: String(run._id),
    status: run.status,
    completedAt: run.completedAt ?? null,
    questionSetVersion: run.questionSetVersion ?? null,
    questionsPlanned: m.questionsPlanned ?? QUESTIONS_PER_RUN,
    questionsAnswered: m.questions?.answered ?? null,
    questionsFailed: m.questions?.failed ?? null,
    questionsSkipped: m.questions?.skipped ?? null,
    questionsCancelled: m.questions?.cancelled ?? 0,
    partial: Boolean(m.partial),
    location: run.serp ? { name: run.serp.locationName ?? null, device: run.serp.device, languageCode: run.serp.languageCode } : null,
    aiOverview: m.aiOverview,
    brandMention: m.brandMention,
    websiteCitation: m.websiteCitation,
    uniqueCitedPages: m.uniqueCitedPages,
    competitors: m.competitors || [],
    cost: m.cost ?? null,
    limitations: m.limitations || [],
    sampled: true,
  };
}

/** The honest one-word reading of one question: an absent AI Overview and a failed request are different things. */
export function observationOf(e) {
  if (e.status === 'succeeded') return e.aiOverview?.present ? 'ai_overview' : 'no_ai_overview';
  if (e.status === 'failed') return 'request_failed';
  if (e.status === 'skipped') return 'not_sent';
  if (e.status === 'cancelled') return 'cancelled';
  return 'pending';
}

export function toEvidenceDto(e, { detail = false } = {}) {
  if (!e) return null;
  const a = e.analysis;
  const refs = e.aiOverview?.references || [];
  const dto = {
    runId: String(e.runId),
    questionSetVersion: e.questionSetVersion,
    questionId: e.questionId,
    position: e.position,
    question: e.questionText,
    intent: e.intent ?? null,
    service: e.service ?? null,
    location: { code: e.locationCode ?? null, name: e.locationName ?? null },
    language: e.languageCode ?? e.language,
    device: e.device ?? null,
    os: e.os ?? null,
    status: e.status,
    observation: observationOf(e),
    attempts: e.attempts,
    aiOverviewPresent: e.status === 'succeeded' ? Boolean(e.aiOverview?.present) : null,
    brandMentioned: a?.mention?.mentioned ?? null,
    mentionStatus: a?.mention?.status ?? null,
    mentionExcerpt: a?.mention?.excerpt ?? null,
    websiteCited: a?.ownedCited ?? null,
    referencesStatus: a?.referencesStatus ?? null,
    referenceCount: refs.length,
    ownedPages: a?.ownedPages || [],
    competitors: (a?.competitors || []).map((c) => ({ name: c.name, mentioned: c.mentioned, cited: c.cited })),
    analysisStatus: e.analysisStatus ?? null,
    retrievedAt: e.serp?.datetime ?? e.completedAt ?? null,
    cost: e.cost ?? null,
    costStatus: e.costStatus,
    costUnit: e.costUnit ?? null,
    errorCode: e.errorCode ?? null,
    errorClass: e.errorClass ?? null,
    // For a question that was never sent because of another question's provider error: that error's code.
    skipCause: e.skipCause ?? null,
    retryable: e.retryable ?? null,
    startedAt: e.startedAt ?? null,
    completedAt: e.completedAt ?? null,
    durationMs: e.durationMs ?? null,
  };
  if (!detail) return dto;
  return {
    ...dto,
    overview: e.aiOverview?.present ? {
      text: e.aiOverview.text ?? null,
      markdown: e.aiOverview.markdown ?? null,
      elements: e.aiOverview.elements || [],
      asyncRequested: e.aiOverview.asyncRequested ?? null,
      asynchronous: e.aiOverview.asynchronous ?? null,
    } : null,
    references: refs.map((r) => ({ url: r.url, host: r.host ?? null, title: r.title ?? null, source: r.source ?? null, snippet: r.snippet ?? null, kind: r.kind, isOwned: Boolean(r.isOwned) })),
    rejectedReferences: e.aiOverview?.rejectedReferences ?? 0,
    serp: e.serp ? { checkUrl: e.serp.checkUrl ?? null, itemsCount: e.serp.itemsCount ?? null } : null,
    request: e.request ? { endpoint: 'serp/google/organic/live/advanced', ...e.request } : null,
    // What the provider said (HTTP status, task code and message, attempts, durations). Never credentials or headers.
    diagnostics: e.diagnostics ? {
      httpStatus: e.diagnostics.httpStatus ?? null, providerCode: e.diagnostics.providerCode ?? null, providerMessage: e.diagnostics.providerMessage ?? null,
      taskIdReturned: Boolean(e.diagnostics.taskIdReturned), durationMs: e.diagnostics.durationMs ?? null,
      attempts: (e.diagnostics.attemptLog || []).map((a) => ({ attempt: a.attempt, outcome: a.outcome, httpStatus: a.httpStatus ?? null, providerCode: a.providerCode ?? null, durationMs: a.durationMs ?? null })),
    } : null,
  };
}

// ── handlers ──
export async function startRun(req, res) {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const device = parseDevice(body.device);
    if (device === null) return fail(res, 400, 'device must be "desktop" or "mobile"');
    let questionIds = null;
    if (body.questionIds !== undefined) {
      if (!Array.isArray(body.questionIds) || body.questionIds.length > 20 || body.questionIds.some((id) => typeof id !== 'string' || !id || id.length > 100)) return fail(res, 400, 'questionIds must be a list of question ids');
      questionIds = body.questionIds;
    }
    const result = await startManualRun({ projectId: req.project._id, userId: req.project.user_id, questionIds, device });
    if (result.scheduled) return res.status(202).json(ResponseUtil.success(toSummaryDto(result.run), 'Google AI Overview run queued'));
    if (result.reason === 'ACTIVE_RUN_EXISTS') return res.status(409).json({ ...ResponseUtil.error('A visibility run is already in progress for this project', 409), data: toSummaryDto(result.run) });
    const refusal = REFUSALS[result.reason];
    if (refusal) return fail(res, refusal[0], refusal[1] || result.message || result.limit?.message || 'The run could not be started', { code: result.reason, ...(result.details || {}) });
    return fail(res, 500, 'Could not start the visibility run');
  } catch (error) {
    LoggerUtil.error('Google AI Overview visibility: start failed', { projectId: String(req.project?._id), code: error?.code });
    return fail(res, 500, 'Could not start the visibility run');
  }
}

/** What the next run would ask and where - no request is made and nothing is stored. */
export async function getQuestionSelection(req, res) {
  try {
    const device = parseDevice(req.query.device);
    if (device === null) return fail(res, 400, 'device must be "desktop" or "mobile"');
    const preview = await previewRun({ projectId: req.project._id, device });
    if (!preview.ok) {
      const refusal = REFUSALS[preview.reason];
      return res.json(ResponseUtil.success({ ready: false, required: QUESTIONS_PER_RUN, problem: { code: preview.reason, message: preview.message || refusal?.[1] || null, details: preview.details || null } }));
    }
    const { set, selection, location, locationError, serp } = preview;
    return res.json(ResponseUtil.success({
      ready: !locationError,
      required: QUESTIONS_PER_RUN,
      questionSetId: String(set._id),
      questionSetVersion: set.version,
      mode: selection.mode,
      questions: selection.snapshot.map((q, i) => ({ position: i + 1, questionId: q.questionId, intent: q.intent, question: q.text, service: q.service, location: q.location })),
      excludedCount: selection.excluded.length,
      location: location ? { code: location.locationCode, name: location.locationName, method: location.method } : null,
      languageCode: serp?.languageCode ?? null,
      device: serp?.device ?? device,
      problem: locationError ? { code: locationError.code, message: locationError.message, details: locationError.details || null } : null,
    }));
  } catch (error) {
    LoggerUtil.error('Google AI Overview visibility: selection failed', { projectId: String(req.project?._id), code: error?.code });
    return fail(res, 500, 'Could not prepare the question selection');
  }
}

export async function getSummary(req, res) {
  try {
    const [latest, active, finished] = await Promise.all([
      runs.getLatestRun({ projectId: req.project._id }), runs.getActiveRun({ projectId: req.project._id }), runs.getLatestFinishedRun({ projectId: req.project._id }),
    ]);
    return res.json(ResponseUtil.success({ latest: toSummaryDto(latest), active: toSummaryDto(active), overview: toOverviewDto(finished) }));
  } catch (error) {
    LoggerUtil.error('Google AI Overview visibility: summary failed', { projectId: String(req.project?._id) });
    return fail(res, 500, 'Could not load the visibility summary');
  }
}

export async function listRunHistory(req, res) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { items, total } = await runs.listRuns({ projectId: req.project._id, limit, skip });
    return res.json(ResponseUtil.success(items.map(toSummaryDto), 'Success', { page, limit, total, totalPages: Math.ceil(total / limit) }));
  } catch (error) {
    LoggerUtil.error('Google AI Overview visibility: history failed', { projectId: String(req.project?._id) });
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
    LoggerUtil.error('Google AI Overview visibility: run detail failed', { projectId: String(req.project?._id) });
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
    LoggerUtil.error('Google AI Overview visibility: cancel failed', { projectId: String(req.project?._id) });
    return fail(res, 500, 'Could not cancel the visibility run');
  }
}

/** The (at most five) evidence rows of one run, without overview text. */
export async function listRunEvidence(req, res) {
  try {
    if (!objectIdOr404(res, req.params.runId, 'Run')) return undefined;
    const run = await runs.getRun({ projectId: req.project._id, runId: req.params.runId });
    if (!run) return fail(res, 404, 'Run not found');
    const items = await evidenceService.listEvidence({ projectId: req.project._id, runId: run._id, status: req.query.status });
    return res.json(ResponseUtil.success(items.map((e) => toEvidenceDto(e))));
  } catch (error) {
    LoggerUtil.error('Google AI Overview visibility: evidence list failed', { projectId: String(req.project?._id) });
    return fail(res, 500, 'Could not load the evidence');
  }
}

export async function getRunEvidence(req, res) {
  try {
    if (!objectIdOr404(res, req.params.runId, 'Run')) return undefined;
    const e = await evidenceService.getEvidence({ projectId: req.project._id, runId: req.params.runId, questionId: String(req.params.questionId) });
    if (!e) return fail(res, 404, 'Evidence not found');
    return res.json(ResponseUtil.success(toEvidenceDto(e, { detail: true })));
  } catch (error) {
    LoggerUtil.error('Google AI Overview visibility: evidence failed', { projectId: String(req.project?._id) });
    return fail(res, 500, 'Could not load the evidence');
  }
}

export async function getQuestionHistory(req, res) {
  try {
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const items = await evidenceService.listQuestionHistory({ projectId: req.project._id, questionId: String(req.params.questionId), limit });
    return res.json(ResponseUtil.success(items.map((e) => toEvidenceDto(e))));
  } catch (error) {
    LoggerUtil.error('Google AI Overview visibility: question history failed', { projectId: String(req.project?._id) });
    return fail(res, 500, 'Could not load the question history');
  }
}

/** One point per finished run: the three rates over time. */
export async function getTrend(req, res) {
  try {
    const range = parseRange(req.query);
    if (range.error) return fail(res, 400, range.error);
    const items = await runs.listFinishedRunsInRange({ projectId: req.project._id, from: range.from, to: range.to });
    const points = items.map((r) => ({
      runId: String(r._id), at: r.completedAt ?? r.createdAt, status: r.status, questionSetVersion: r.questionSetVersion,
      aiOverviewRate: r.metrics?.aiOverview?.rate ?? null, brandMentionRate: r.metrics?.brandMention?.rate ?? null,
      websiteCitationRate: r.metrics?.websiteCitation?.rate ?? null, uniqueCitedPages: r.metrics?.uniqueCitedPages?.count ?? null,
    }));
    return res.json(ResponseUtil.success({ points, from: range.from, to: range.to }));
  } catch (error) {
    LoggerUtil.error('Google AI Overview visibility: trend failed', { projectId: String(req.project?._id) });
    return fail(res, 500, 'Could not load the visibility trend');
  }
}

export default { startRun, getQuestionSelection, getSummary, listRunHistory, getRunDetail, cancelRun, listRunEvidence, getRunEvidence, getQuestionHistory, getTrend };
