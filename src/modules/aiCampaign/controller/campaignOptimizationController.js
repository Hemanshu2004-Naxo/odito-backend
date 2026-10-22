import { validationResult } from 'express-validator';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { AuthUtil } from '../../../utils/AuthUtil.js';
import { resolveGoogleAdsDateRange } from '../../../utils/googleAdsDateRange.js';
import GoogleAdsCampaignMetrics from '../../app_user/model/GoogleAdsCampaignMetrics.js';
import campaignDraftService from '../service/campaignDraftService.js';
import campaignOptimizationService from '../service/campaignOptimizationService.js';

/**
 * AI Campaign Performance + Optimization controller (Phase 7) — THIN. Auth
 * + ownership + request-shape gate + response shaping only. Every
 * optimization decision (performance read, opportunity detection, AI
 * recommendation, validation, execution) lives in
 * campaignOptimizationService.js and its collaborators.
 *
 * Same ownership pattern as Phase 4/5/6: the draft is loaded first, then
 * AuthUtil.validateProjectAccess resolves + re-checks ownership from the
 * draft's own projectId — a recommendation id alone never grants access
 * (spec §37); every lookup below stays scoped to the owned draft.
 */

function handleError(res, error, fallbackMessage) {
  if (error.type === 'NOT_FOUND') {
    return res.status(404).json(ResponseUtil.notFound(error.message));
  }
  if (error.type === 'ACCESS_DENIED') {
    return res.status(403).json(ResponseUtil.accessDenied(error.message));
  }
  if (error.type === 'VALIDATION_ERROR') {
    return res.status(400).json(ResponseUtil.validationError(error.details, error.message));
  }
  if (error.type === 'CONFLICT') {
    return res.status(409).json(ResponseUtil.conflict(error.message));
  }
  if (error.type === 'CAMPAIGN_OPTIMIZATION_ERROR') {
    // Never a raw Google Ads / gRPC error reaches the browser — only the
    // already-classified { code, message } pair (spec §35/§36).
    return res.status(error.httpStatus || 500).json({ success: false, message: error.message, code: error.code });
  }
  LoggerUtil.error(`[AI_CAMPAIGN_OPTIMIZATION] ${fallbackMessage}`, error, { message: error.message });
  return res
    .status(error.statusCode || 500)
    .json(ResponseUtil.error(error.message || fallbackMessage, error.statusCode || 500));
}

function firstValidationError(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return null;
  return res.status(400).json(ResponseUtil.validationError(errors.array(), errors.array()[0].msg));
}

async function loadOwnedDraft(req) {
  const draft = await campaignDraftService.getDraft(req.params.draftId);
  await AuthUtil.validateProjectAccess(req.user._id, draft.projectId);
  return draft;
}

/** Explicitly-supplied business targets only (spec §11) — never invented, allow-listed field-by-field. */
function extractTargets(body) {
  const t = body?.targets;
  if (!t || typeof t !== 'object') return {};
  const out = {};
  for (const key of ['targetCPA', 'targetROAS', 'minCTR', 'maxCPA', 'minConversions']) {
    if (t[key] !== undefined && t[key] !== null) out[key] = Number(t[key]);
  }
  return out;
}

// POST /api/google-ads/ai-campaigns/drafts/:draftId/optimization/analyze
export async function analyze(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const draft = await loadOwnedDraft(req);
    const { startDate, endDate } = await resolveGoogleAdsDateRange(req, {
      getEarliestDate: () => GoogleAdsCampaignMetrics.getEarliestDate(draft.projectId, draft.googleAdsCustomerId),
    });

    const result = await campaignOptimizationService.analyzeOptimization({
      draftId: draft._id, userId: req.user._id, projectId: draft.projectId,
      startDate, endDate, targets: extractTargets(req.body),
    });

    return res.status(200).json(ResponseUtil.success(result, 'Optimization analysis completed'));
  } catch (error) {
    return handleError(res, error, 'Failed to analyze campaign performance');
  }
}

// GET /api/google-ads/ai-campaigns/drafts/:draftId/optimization/analysis
export async function getAnalysis(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const draft = await loadOwnedDraft(req);
    const result = await campaignOptimizationService.getLatestAnalysis({ draftId: draft._id, projectId: draft.projectId });

    return res.status(200).json(ResponseUtil.success(result, 'Latest optimization analysis retrieved'));
  } catch (error) {
    return handleError(res, error, 'Failed to fetch optimization analysis');
  }
}

// POST /api/google-ads/ai-campaigns/drafts/:draftId/optimization/recommendations/:recommendationId/approve
export async function approve(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const draft = await loadOwnedDraft(req);
    const result = await campaignOptimizationService.approveRecommendation({
      draftId: draft._id, recommendationId: req.params.recommendationId, userId: req.user._id, projectId: draft.projectId,
    });

    return res.status(200).json(ResponseUtil.success(result, result.alreadyExecuted ? 'This recommendation was already executed' : 'Recommendation approved and executed'));
  } catch (error) {
    return handleError(res, error, 'Failed to approve recommendation');
  }
}

// POST /api/google-ads/ai-campaigns/drafts/:draftId/optimization/recommendations/:recommendationId/reject
export async function reject(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const draft = await loadOwnedDraft(req);
    const result = await campaignOptimizationService.rejectRecommendation({
      draftId: draft._id, recommendationId: req.params.recommendationId, userId: req.user._id, projectId: draft.projectId,
    });

    return res.status(200).json(ResponseUtil.success(result, 'Recommendation rejected'));
  } catch (error) {
    return handleError(res, error, 'Failed to reject recommendation');
  }
}

// GET /api/google-ads/ai-campaigns/drafts/:draftId/optimization/history
export async function getHistory(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const draft = await loadOwnedDraft(req);
    const history = await campaignOptimizationService.getOptimizationHistory({ draftId: draft._id, projectId: draft.projectId });

    return res.status(200).json(ResponseUtil.success(history, 'Optimization history retrieved'));
  } catch (error) {
    return handleError(res, error, 'Failed to fetch optimization history');
  }
}

export default { analyze, getAnalysis, approve, reject, getHistory };
