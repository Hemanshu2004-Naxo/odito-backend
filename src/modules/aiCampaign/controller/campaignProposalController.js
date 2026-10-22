import { validationResult } from 'express-validator';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { AuthUtil } from '../../../utils/AuthUtil.js';
import campaignDraftService from '../service/campaignDraftService.js';
import campaignProposalService from '../service/campaignProposalService.js';

/**
 * AI Campaign Change Proposal controller (Phase 4) — THIN. Auth + ownership
 * + request-shape gate + response shaping only. Every domain decision
 * (Claude call, validation, apply, revision check) lives in
 * campaignProposalService.js and its collaborators.
 *
 * Ownership: every route here is nested under :draftId with no projectId on
 * the request, so ownership is resolved the same way as the Phase 1 draft
 * :draftId routes — load the draft, assertDraftOwnership. Proposal routes
 * additionally load the proposal through the service, which itself confirms
 * the proposal belongs to :draftId (404, never a cross-draft leak).
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
  if (error.type === 'CAMPAIGN_PROPOSAL_ERROR') {
    const body = { success: false, message: error.message, code: error.code };
    if (error.proposalId) body.data = { proposalId: error.proposalId };
    if (Array.isArray(error.details)) body.errors = error.details;
    if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
    return res.status(error.httpStatus || 500).json(body);
  }
  LoggerUtil.error(`[AI_CAMPAIGN_PROPOSAL] ${fallbackMessage}`, error, { message: error.message });
  return res
    .status(error.statusCode || 500)
    .json(ResponseUtil.error(error.message || fallbackMessage, error.statusCode || 500));
}

function firstValidationError(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return null;
  return res.status(400).json(ResponseUtil.validationError(errors.array(), errors.array()[0].msg));
}

/** Same pattern as campaignDraftController.assertDraftOwnership. */
async function assertDraftOwnership(req, res, draft) {
  try {
    await AuthUtil.validateProjectAccess(req.user._id, draft.projectId);
    return true;
  } catch (error) {
    handleError(res, error, 'Access check failed');
    return false;
  }
}

// POST /api/google-ads/ai-campaigns/drafts/:draftId/assistant
export async function generateProposal(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const draft = await campaignDraftService.getDraft(req.params.draftId);
    if (!(await assertDraftOwnership(req, res, draft))) return;

    const { proposal, generationId } = await campaignProposalService.generateProposal({
      draftId: req.params.draftId,
      userId: req.user._id,
      instruction: req.body.instruction,
    });

    return res.status(201).json(ResponseUtil.created({ proposal, generationId }, 'Change proposal generated successfully'));
  } catch (error) {
    return handleError(res, error, 'Failed to generate change proposal');
  }
}

// GET /api/google-ads/ai-campaigns/drafts/:draftId/proposals?limit=
export async function listProposals(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const draft = await campaignDraftService.getDraft(req.params.draftId);
    if (!(await assertDraftOwnership(req, res, draft))) return;

    const proposals = await campaignProposalService.listProposals(req.params.draftId, { limit: req.query.limit });
    return res.status(200).json(ResponseUtil.success(proposals, 'Change proposals retrieved successfully'));
  } catch (error) {
    return handleError(res, error, 'Failed to list change proposals');
  }
}

// GET /api/google-ads/ai-campaigns/drafts/:draftId/proposals/:proposalId
export async function getProposal(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const draft = await campaignDraftService.getDraft(req.params.draftId);
    if (!(await assertDraftOwnership(req, res, draft))) return;

    const proposal = await campaignProposalService.getProposal(req.params.proposalId, req.params.draftId);
    return res.status(200).json(ResponseUtil.success(proposal, 'Change proposal retrieved successfully'));
  } catch (error) {
    return handleError(res, error, 'Failed to fetch change proposal');
  }
}

// POST /api/google-ads/ai-campaigns/drafts/:draftId/proposals/:proposalId/accept
export async function acceptProposal(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const draft = await campaignDraftService.getDraft(req.params.draftId);
    if (!(await assertDraftOwnership(req, res, draft))) return;

    const result = await campaignProposalService.acceptProposal({
      proposalId: req.params.proposalId,
      draftId: req.params.draftId,
      userId: req.user._id,
    });

    return res.status(200).json(ResponseUtil.success(
      { draft: result.draft, proposal: result.proposal, alreadyApplied: result.alreadyApplied },
      'Change proposal accepted successfully',
    ));
  } catch (error) {
    return handleError(res, error, 'Failed to accept change proposal');
  }
}

// POST /api/google-ads/ai-campaigns/drafts/:draftId/proposals/:proposalId/reject
export async function rejectProposal(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const draft = await campaignDraftService.getDraft(req.params.draftId);
    if (!(await assertDraftOwnership(req, res, draft))) return;

    const { proposal } = await campaignProposalService.rejectProposal({
      proposalId: req.params.proposalId,
      draftId: req.params.draftId,
    });

    return res.status(200).json(ResponseUtil.success(proposal, 'Change proposal rejected'));
  } catch (error) {
    return handleError(res, error, 'Failed to reject change proposal');
  }
}

export default { generateProposal, listProposals, getProposal, acceptProposal, rejectProposal };
