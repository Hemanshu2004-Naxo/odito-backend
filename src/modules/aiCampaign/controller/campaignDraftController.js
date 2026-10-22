import { validationResult } from 'express-validator';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { AuthUtil } from '../../../utils/AuthUtil.js';
import campaignDraftService from '../service/campaignDraftService.js';

/**
 * AI Campaign Draft controller — THIN. Auth + request-shape gate + response
 * shaping only; all business logic lives in campaignDraftService.js.
 *
 * Mirrors modules/lead/controller/leadController.js exactly:
 *   - `firstValidationError` → repo-standard 400 body for express-validator.
 *   - `handleError` maps typed ErrorUtil / AuthUtil errors onto HTTP.
 *   - list/create routes carry projectId in query/body and are ownership-
 *     checked by validateProjectAccess() middleware BEFORE the handler runs.
 *   - :draftId routes have no projectId on the request, so ownership is
 *     resolved from the loaded draft's own projectId (assertDraftOwnership).
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
  LoggerUtil.error(`[AI_CAMPAIGN] ${fallbackMessage}`, error, { message: error.message });
  return res
    .status(error.statusCode || 500)
    .json(ResponseUtil.error(error.message || fallbackMessage, error.statusCode || 500));
}

function firstValidationError(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return null;
  return res.status(400).json(ResponseUtil.validationError(errors.array(), errors.array()[0].msg));
}

/**
 * For :draftId routes: the request carries no projectId, so ownership can
 * only be checked once the draft is loaded, from its own projectId — same
 * pattern as leadController.assertLeadOwnership / taskAuthz.assertTaskOwnership.
 * Writes the response itself on denial and returns false; callers must
 * `return` immediately when it returns false.
 */
async function assertDraftOwnership(req, res, draft) {
  try {
    await AuthUtil.validateProjectAccess(req.user._id, draft.projectId);
    return true;
  } catch (error) {
    handleError(res, error, 'Access check failed');
    return false;
  }
}

// POST /api/google-ads/ai-campaigns/drafts
// projectId travels in the body — ownership already validated by
// validateProjectAccess() before this handler runs.
export async function createDraft(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const draft = await campaignDraftService.createDraft({
      projectId: req.body.projectId,
      userId: req.user._id,
      googleAdsCustomerId: req.body.googleAdsCustomerId,
      campaign: req.body.campaign,
      adGroups: req.body.adGroups,
    });

    return res.status(201).json(ResponseUtil.created(draft, 'Campaign draft created successfully'));
  } catch (error) {
    return handleError(res, error, 'Failed to create campaign draft');
  }
}

// GET /api/google-ads/ai-campaigns/drafts?projectId=&status=&page=&limit=&sort=&sortOrder=
// projectId travels in the query — ownership already validated by
// validateProjectAccess() before this handler runs.
export async function listDrafts(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const { projectId, status, page, limit, sort, sortOrder } = req.query;
    const { drafts, pagination } = await campaignDraftService.listDrafts(projectId, {
      status,
      page,
      limit,
      sort,
      sortOrder,
    });

    return res.status(200).json({
      success: true,
      message: 'Campaign drafts retrieved successfully',
      data: drafts,
      pagination,
    });
  } catch (error) {
    return handleError(res, error, 'Failed to list campaign drafts');
  }
}

// GET /api/google-ads/ai-campaigns/drafts/:draftId
export async function getDraft(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const draft = await campaignDraftService.getDraft(req.params.draftId);
    if (!(await assertDraftOwnership(req, res, draft))) return;

    return res.status(200).json(ResponseUtil.success(draft, 'Campaign draft retrieved successfully'));
  } catch (error) {
    return handleError(res, error, 'Failed to fetch campaign draft');
  }
}

// PATCH /api/google-ads/ai-campaigns/drafts/:draftId
export async function updateDraft(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const existing = await campaignDraftService.getDraft(req.params.draftId);
    if (!(await assertDraftOwnership(req, res, existing))) return;

    const draft = await campaignDraftService.updateDraft(req.params.draftId, {
      updates: {
        campaign: req.body.campaign,
        adGroups: req.body.adGroups,
        googleAdsCustomerId: req.body.googleAdsCustomerId,
      },
      userId: req.user._id,
    });

    return res.status(200).json(ResponseUtil.updated(draft, 'Campaign draft updated successfully'));
  } catch (error) {
    return handleError(res, error, 'Failed to update campaign draft');
  }
}

// DELETE /api/google-ads/ai-campaigns/drafts/:draftId
export async function deleteDraft(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const existing = await campaignDraftService.getDraft(req.params.draftId);
    if (!(await assertDraftOwnership(req, res, existing))) return;

    await campaignDraftService.deleteDraft(req.params.draftId);
    return res.status(200).json(ResponseUtil.deleted('Campaign draft deleted successfully'));
  } catch (error) {
    return handleError(res, error, 'Failed to delete campaign draft');
  }
}

export default { createDraft, listDrafts, getDraft, updateDraft, deleteDraft };
