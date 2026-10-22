import { validationResult } from 'express-validator';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import campaignGenerationService from '../service/campaignGenerationService.js';

/**
 * AI Campaign Generation controller (Phase 2) — THIN.
 *
 * Responsibilities: run the express-validator gate, hand off to
 * campaignGenerationService.generateCampaign(), and shape the response /
 * errors. It does NOT build prompts, call Claude, validate campaign
 * structure, or touch MongoDB (spec §32).
 *
 * Auth + project ownership are already enforced by the route stack
 * (`auth` + `validateProjectAccess()`), same as the Phase 1 draft routes.
 */

function firstValidationError(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return null;
  return res.status(400).json(ResponseUtil.validationError(errors.array(), errors.array()[0].msg));
}

/**
 * Map a thrown error to a safe HTTP response. Never exposes raw Claude
 * errors or stack traces (spec §27).
 */
function handleError(res, error) {
  // Brief validation / "no Google Ads account" etc.
  if (error.type === 'VALIDATION_ERROR') {
    return res.status(400).json(ResponseUtil.validationError(error.details, error.message));
  }
  if (error.type === 'NOT_FOUND') {
    return res.status(404).json(ResponseUtil.notFound(error.message));
  }
  if (error.type === 'ACCESS_DENIED') {
    return res.status(403).json(ResponseUtil.accessDenied(error.message));
  }

  // Classified generation failure — carries a safe message + http status.
  if (error.type === 'CAMPAIGN_GENERATION_ERROR') {
    const body = {
      success: false,
      message: error.message,
      code: error.code,
    };
    // Include the draft id + state so the client can inspect the failed
    // draft (it was persisted with status='failed').
    if (error.draftId) body.data = { draftId: error.draftId, status: 'failed', code: error.code };
    // Our own validator messages are safe to return; provider text is not.
    if (error.code === 'CAMPAIGN_STRUCTURE_INVALID' && Array.isArray(error.details)) {
      body.errors = error.details;
    }
    if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
    return res.status(error.httpStatus || 500).json(body);
  }

  LoggerUtil.error('[AI_CAMPAIGN] Unhandled generation error', error, { message: error.message });
  return res.status(500).json(ResponseUtil.error('Campaign generation failed. Please try again.', 500));
}

/**
 * POST /api/google-ads/ai-campaigns/generate
 * Body: { projectId, brief, googleAdsCustomerId? }
 * Success: 201 { success, data: { draft, generation } }
 */
export async function generateCampaign(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const { draft, generationId, generation } = await campaignGenerationService.generateCampaign({
      projectId: req.body.projectId,
      userId: req.user._id,
      project: req.project, // attached by validateProjectAccess()
      brief: req.body.brief,
      googleAdsCustomerId: req.body.googleAdsCustomerId || null,
    });

    return res.status(201).json(
      ResponseUtil.created(
        { draft, generation: { ...generation, generationId } },
        'Campaign draft generated successfully',
      ),
    );
  } catch (error) {
    return handleError(res, error);
  }
}

export default { generateCampaign };
