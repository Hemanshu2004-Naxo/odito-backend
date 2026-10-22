import { validationResult } from 'express-validator';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { AuthUtil } from '../../../utils/AuthUtil.js';
import campaignDraftService from '../service/campaignDraftService.js';
import campaignValidationService from '../service/campaignValidationService.js';

/**
 * AI Campaign Validation controller (Phase 5) — THIN. Auth + ownership +
 * request-shape gate + response shaping only. All rule logic lives in
 * campaignValidationService.js and its service/validation/* collaborators.
 *
 * Same ownership pattern as the Phase 4 proposal controller: routes are
 * nested under :draftId with no projectId on the request, so the draft is
 * loaded first and AuthUtil.validateProjectAccess resolves + re-checks
 * ownership from the draft's own projectId (never trusted from the client).
 *
 * NEVER calls anything that mutates Google Ads — this controller only ever
 * reaches campaignValidationService, which is itself read-only by design
 * (see that file's header).
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
  LoggerUtil.error(`[AI_CAMPAIGN_VALIDATION] ${fallbackMessage}`, error, { message: error.message });
  return res
    .status(error.statusCode || 500)
    .json(ResponseUtil.error(error.message || fallbackMessage, error.statusCode || 500));
}

function firstValidationError(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return null;
  return res.status(400).json(ResponseUtil.validationError(errors.array(), errors.array()[0].msg));
}

/** Same pattern as campaignProposalController.assertDraftOwnership, but returns the project so callers can reuse it. */
async function loadOwnedDraftAndProject(req, res) {
  const draft = await campaignDraftService.getDraft(req.params.draftId);
  const project = await AuthUtil.validateProjectAccess(req.user._id, draft.projectId);
  return { draft, project };
}

// POST /api/google-ads/ai-campaigns/drafts/:draftId/validate
export async function runValidation(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const { draft, project } = await loadOwnedDraftAndProject(req, res);

    const result = await campaignValidationService.validateCampaignForPublishing({
      draftId: draft._id,
      userId: req.user._id,
      projectId: draft.projectId,
      project,
    });

    return res.status(200).json(ResponseUtil.success(result, 'Campaign validation completed'));
  } catch (error) {
    return handleError(res, error, 'Failed to validate campaign');
  }
}

// GET /api/google-ads/ai-campaigns/drafts/:draftId/validation
export async function getValidation(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const { draft } = await loadOwnedDraftAndProject(req, res);

    const result = await campaignValidationService.getLatestValidationResult({
      draftId: draft._id,
      projectId: draft.projectId,
    });

    return res.status(200).json(ResponseUtil.success(result, result ? 'Latest validation result retrieved' : 'This campaign has not been validated yet'));
  } catch (error) {
    return handleError(res, error, 'Failed to fetch validation result');
  }
}

export default { runValidation, getValidation };
