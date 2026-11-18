import { startDesignGeneration, getDesignGenerationStatus } from '../service/aiDesign/socialDesignGenerationService.js';
import { getStudioState, startStudioGeneration, selectStudioCandidate } from '../service/aiDesign/socialDesignStudioService.js';
import {
  studioPipelineFor, startConceptCompare, regenerateConceptPreview, startConceptRender, regenerateCarouselSlide, reorderCarouselSlides, deleteCarouselSlide,
  getCarouselSlides, getDesignCosts, getDesignJobs,
} from '../service/aiDesign/conceptStudioService.js';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * SocialAIDesignController - HTTP only. Both routes run behind auth + validateProjectAccess()
 * (routes/socialAIDesignRoutes.js), which sets req.projectId / req.userId; those are the only identities used
 * here, and the service scopes every query by that project. Only { publicationId, contentVersion,
 * replaceApproved } is read from the request body - nothing else (no approval state, design version, account,
 * platform, strategy, prompt, provenance) is client-controlled. Responses carry the generation state and the
 * real publication - never a prompt, a provider message, a key or a token.
 *
 * POST /generate -> 202 { status:'generating', generationId, alreadyRunning, generation }
 * GET  /status   -> state of ?generationId=... or, without it, the publication's latest generation
 *
 * Creative Studio (same record, same pipeline; candidates are stored but NOT attached until selected):
 * GET  /studio             -> the real post, its brand / product / service / format, the approval gate and the latest candidates
 * POST /studio/generate    -> 202 three distinct designs for the post { publicationId, contentVersion, productMediaIds?, replaceApproved? }
 * POST /studio/regenerate  -> 202 one candidate again, or refined from { instruction } { publicationId, generationId, candidateId, contentVersion, instruction?, replaceApproved? }
 * POST /studio/select      -> 200 attach a candidate as the post's design (to Design Review) { publicationId, generationId, candidateId, contentVersion, designVersion, replaceApproved? }
 */

const ERROR_STATUS = {
  INVALID_PUBLICATION: 400,
  INVALID_VERSION: 400,
  NOT_FOUND: 404,
  CONTENT_NOT_APPROVED: 409,
  DESIGN_NOT_ALLOWED: 409,
  VERSION_MISMATCH: 409,
  DESIGN_ALREADY_APPROVED: 409,
  PLATFORM_NOT_CONNECTED: 409,
  PLATFORM_NOT_SUPPORTED: 422,
  AI_UNAVAILABLE: 503,
  INVALID_ACTION: 400,
  INVALID_INSTRUCTION: 400,
  INVALID_PRODUCT_ASSET: 400,
  CANDIDATE_STALE: 409,
  GENERATION_SUPERSEDED: 409,
  GENERATION_IN_PROGRESS: 409,
  DESIGN_VERSION_MISMATCH: 409,
  DESIGN_FILE_MISSING: 409,
  CAROUSEL_NEEDS_POINTS: 422,
  CANDIDATE_NOT_READY: 409,
  SLIDE_NOT_FOUND: 404,
  TOO_FEW_SLIDES: 422,
  ORDER_INVALID: 400,
  NOT_A_CAROUSEL: 409,
};

const serverError = (res, message) => res.status(500).json(ResponseUtil.error(message, 500, { code: 'SOCIAL_AI_DESIGN_FAILED' }));

export async function generateAIDesignHandler(req, res) {
  const projectId = req.projectId;
  const { publicationId, contentVersion, replaceApproved } = req.body || {};
  try {
    const result = await startDesignGeneration(projectId, req.userId, { publicationId, contentVersion, replaceApproved });
    if (!result.success) {
      const status = ERROR_STATUS[result.error.code] || 400;
      const { code, message, currentContentVersion } = result.error;
      return res.status(status).json(ResponseUtil.error(message, status, { code, ...(currentContentVersion ? { currentContentVersion } : {}) }));
    }
    return res.status(202).json(ResponseUtil.success({
      status: 'generating',
      generationId: result.generation?.id || null,
      alreadyRunning: result.alreadyRunning,
      generation: result.generation,
    }));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_AI_DESIGN] Failed to start generation', { message: error.message }, { projectId });
    return serverError(res, 'Failed to start the design generation');
  }
}

export async function getAIDesignStatusHandler(req, res) {
  const projectId = req.projectId;
  const publicationId = typeof req.query?.publicationId === 'string' ? req.query.publicationId : null;
  const generationId = typeof req.query?.generationId === 'string' ? req.query.generationId : null;
  try {
    const result = await getDesignGenerationStatus(projectId, { publicationId, generationId });
    if (!result.success) {
      const status = ERROR_STATUS[result.error.code] || 400;
      return res.status(status).json(ResponseUtil.error(result.error.message, status, { code: result.error.code }));
    }
    const { status, generation, publication } = result;
    return res.json(ResponseUtil.success({ status, generation, publication }));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_AI_DESIGN] Failed to load status', { message: error.message }, { projectId });
    return serverError(res, 'Failed to load the design generation status');
  }
}

/** Maps a service failure to HTTP with only safe fields. */
function sendFailure(res, error) {
  const status = ERROR_STATUS[error.code] || 400;
  const { code, message, currentContentVersion, currentDesignVersion } = error;
  return res.status(status).json(ResponseUtil.error(message, status, { code, ...(currentContentVersion ? { currentContentVersion } : {}), ...(currentDesignVersion ? { currentDesignVersion } : {}) }));
}

export async function getStudioHandler(req, res) {
  const projectId = req.projectId;
  const publicationId = typeof req.query?.publicationId === 'string' ? req.query.publicationId : null;
  try {
    const { success, error, ...state } = await getStudioState(projectId, publicationId);
    if (!success) return sendFailure(res, error);
    return res.json(ResponseUtil.success(state));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_AI_DESIGN] Failed to load Creative Studio', { message: error.message }, { projectId });
    return serverError(res, 'Failed to load Creative Studio');
  }
}

/** Only these fields are read from a body; everything else about the post, the account, the product and the versions is decided on the server. */
const pick = (body, keys) => Object.fromEntries(keys.filter((k) => body && body[k] !== undefined).map((k) => [k, body[k]]));

export async function studioGenerateHandler(req, res) {
  const projectId = req.projectId;
  try {
    // Concept Studio: Compare = 3 concepts as low previews, single image or carousel
    if (await studioPipelineFor(projectId, req.body?.publicationId) === 'concept') {
      const r = await startConceptCompare(projectId, req.userId, pick(req.body, ['publicationId', 'contentVersion', 'format', 'replaceApproved']));
      if (!r.success) return sendFailure(res, r.error);
      return res.status(202).json(ResponseUtil.success({ status: 'generating', generationId: r.generation?.id || null, alreadyRunning: r.alreadyRunning, generation: r.generation }));
    }
    const result = await startStudioGeneration(projectId, req.userId, { ...pick(req.body, ['publicationId', 'contentVersion', 'productMediaIds', 'replaceApproved']), action: 'generate_all' });
    if (!result.success) return sendFailure(res, result.error);
    return res.status(202).json(ResponseUtil.success({ status: 'generating', generationId: result.generation?.id || null, alreadyRunning: result.alreadyRunning, generation: result.generation }));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_AI_DESIGN] Failed to start the studio generation', { message: error.message }, { projectId });
    return serverError(res, 'Failed to start the design generation');
  }
}

export async function studioRegenerateHandler(req, res) {
  const projectId = req.projectId;
  try {
    if (await studioPipelineFor(projectId, req.body?.publicationId) === 'concept') {
      const r = await regenerateConceptPreview(projectId, req.userId, pick(req.body, ['publicationId', 'contentVersion', 'generationId', 'candidateId', 'instruction']));
      if (!r.success) return sendFailure(res, r.error);
      return res.status(202).json(ResponseUtil.success({ status: 'generating', generationId: r.generation?.id || null, alreadyRunning: false, generation: r.generation }));
    }
    const result = await startStudioGeneration(projectId, req.userId, { ...pick(req.body, ['publicationId', 'contentVersion', 'generationId', 'candidateId', 'instruction', 'productMediaIds', 'replaceApproved']), action: 'regenerate' });
    if (!result.success) return sendFailure(res, result.error);
    return res.status(202).json(ResponseUtil.success({ status: 'generating', generationId: result.generation?.id || null, alreadyRunning: result.alreadyRunning, generation: result.generation }));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_AI_DESIGN] Failed to start the studio regeneration', { message: error.message }, { projectId });
    return serverError(res, 'Failed to start the design generation');
  }
}

export async function studioSelectHandler(req, res) {
  const projectId = req.projectId;
  try {
    // Concept Studio: picking a concept renders it at medium (single or carousel) and attaches it - a background job (202)
    if (await studioPipelineFor(projectId, req.body?.publicationId) === 'concept') {
      const r = await startConceptRender(projectId, req.userId, pick(req.body, ['publicationId', 'generationId', 'candidateId', 'contentVersion', 'designVersion', 'replaceApproved', 'format']));
      if (!r.success) return sendFailure(res, r.error);
      return res.status(202).json(ResponseUtil.success({ status: 'generating', rendering: true, generationId: r.generation?.id || null, generation: r.generation }));
    }
    const result = await selectStudioCandidate(projectId, req.userId, pick(req.body, ['publicationId', 'generationId', 'candidateId', 'contentVersion', 'designVersion', 'replaceApproved']));
    if (!result.success) return sendFailure(res, result.error);
    const { success: _s, ...data } = result;
    return res.json(ResponseUtil.success(data));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_AI_DESIGN] Failed to select the design', { message: error.message }, { projectId });
    return serverError(res, 'Failed to select the design');
  }
}

/** GET /slides?publicationId - the post's carousel slides (order, files, QC, needs attention). */
export async function getSlidesHandler(req, res) {
  const projectId = req.projectId;
  try {
    const r = await getCarouselSlides(projectId, typeof req.query?.publicationId === 'string' ? req.query.publicationId : null);
    if (!r.success) return sendFailure(res, r.error);
    const { success: _s, ...data } = r;
    return res.json(ResponseUtil.success(data));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_AI_DESIGN] Failed to load the slides', { message: error.message }, { projectId });
    return serverError(res, 'Failed to load the slides');
  }
}

const slideAction = (fn, keys, accepted = 200) => async (req, res) => {
  const projectId = req.projectId;
  try {
    const r = await fn(projectId, req.userId, pick(req.body, keys));
    if (!r.success) return sendFailure(res, r.error);
    const { success: _s, ...data } = r;
    return res.status(accepted).json(ResponseUtil.success(data));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_AI_DESIGN] Slide action failed', { message: error.message }, { projectId });
    return serverError(res, 'The slide could not be changed');
  }
};
export const slideRegenerateHandler = slideAction(regenerateCarouselSlide, ['publicationId', 'contentVersion', 'designVersion', 'slideKey'], 202);
export const slideReorderHandler = slideAction(reorderCarouselSlides, ['publicationId', 'contentVersion', 'designVersion', 'order']);
export const slideDeleteHandler = slideAction(deleteCarouselSlide, ['publicationId', 'contentVersion', 'designVersion', 'slideKey']);

/** GET /costs?publicationId - design costs of the post and of the brand this month. */
export async function getCostsHandler(req, res) {
  const projectId = req.projectId;
  try {
    const r = await getDesignCosts(projectId, { publicationId: typeof req.query?.publicationId === 'string' ? req.query.publicationId : null });
    const { success: _s, ...data } = r;
    return res.json(ResponseUtil.success(data));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_AI_DESIGN] Failed to load costs', { message: error.message }, { projectId });
    return serverError(res, 'Failed to load the design costs');
  }
}

/** GET /jobs - running design jobs of the project and the ones that just finished (for the "done" notification). */
export async function getJobsHandler(req, res) {
  const projectId = req.projectId;
  try {
    const r = await getDesignJobs(projectId);
    return res.json(ResponseUtil.success({ jobs: r.jobs }));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_AI_DESIGN] Failed to load jobs', { message: error.message }, { projectId });
    return serverError(res, 'Failed to load the design jobs');
  }
}

export default { getSlidesHandler, slideRegenerateHandler, slideReorderHandler, slideDeleteHandler, getCostsHandler, getJobsHandler, generateAIDesignHandler, getAIDesignStatusHandler, getStudioHandler, studioGenerateHandler, studioRegenerateHandler, studioSelectHandler };
