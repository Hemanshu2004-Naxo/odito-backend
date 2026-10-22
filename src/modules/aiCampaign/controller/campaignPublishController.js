import { validationResult } from 'express-validator';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { AuthUtil } from '../../../utils/AuthUtil.js';
import campaignDraftService from '../service/campaignDraftService.js';
import campaignPublishService from '../service/campaignPublishService.js';

/**
 * AI Campaign Publish controller (Phase 6) — THIN. Auth + ownership +
 * request-shape gate + response shaping only. Every publish decision
 * (readiness, account resolution, locking, plan, mutation, persistence)
 * lives in campaignPublishService.js and its collaborators.
 *
 * Same ownership pattern as Phase 4/5: the draft is loaded first, then
 * AuthUtil.validateProjectAccess resolves + re-checks ownership from the
 * draft's own projectId — the client never supplies a trusted projectId,
 * customerId, or Google resource id here (spec §4/§30).
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
  if (error.type === 'CAMPAIGN_PUBLISH_ERROR') {
    // Never a raw Google Ads / gRPC error reaches the browser — only the
    // already-classified { code, message } pair (spec §19/§27/§35).
    return res.status(error.httpStatus || 500).json({ success: false, message: error.message, code: error.code });
  }
  LoggerUtil.error(`[AI_CAMPAIGN_PUBLISH] ${fallbackMessage}`, error, { message: error.message });
  return res
    .status(error.statusCode || 500)
    .json(ResponseUtil.error(error.message || fallbackMessage, error.statusCode || 500));
}

function firstValidationError(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return null;
  return res.status(400).json(ResponseUtil.validationError(errors.array(), errors.array()[0].msg));
}

async function loadOwnedDraft(req, res) {
  const draft = await campaignDraftService.getDraft(req.params.draftId);
  await AuthUtil.validateProjectAccess(req.user._id, draft.projectId);
  return draft;
}

// POST /api/google-ads/ai-campaigns/drafts/:draftId/publish
export async function publishDraft(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const draft = await loadOwnedDraft(req, res);

    const result = await campaignPublishService.publishDraft({
      draftId: draft._id,
      userId: req.user._id,
      projectId: draft.projectId,
    });

    return res.status(200).json(ResponseUtil.success(
      { draft: result.draft, attempt: result.attempt, alreadyPublished: !!result.alreadyPublished },
      result.alreadyPublished ? 'This campaign was already published' : 'Campaign published successfully',
    ));
  } catch (error) {
    return handleError(res, error, 'Failed to publish campaign');
  }
}

// GET /api/google-ads/ai-campaigns/drafts/:draftId/publish
export async function getPublishStatus(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const draft = await loadOwnedDraft(req, res);

    const result = await campaignPublishService.getPublishStatus({ draftId: draft._id, projectId: draft.projectId });

    return res.status(200).json(ResponseUtil.success(
      { draft: result.draft, attempt: result.attempt },
      result.attempt ? 'Latest publish status retrieved' : 'This campaign has not been published yet',
    ));
  } catch (error) {
    return handleError(res, error, 'Failed to fetch publish status');
  }
}

export default { publishDraft, getPublishStatus };
