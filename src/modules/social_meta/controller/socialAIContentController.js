import { startContentGeneration, getContentGenerationStatus } from '../service/aiContent/socialContentGenerationService.js';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * SocialAIContentController - HTTP only. Both routes run behind
 * auth + validateProjectAccess() (routes/socialAIContentRoutes.js), which sets
 * req.projectId / req.userId; those are the only identities used here, and the
 * service scopes every query by that project. Only { platform, contentPillar,
 * objective } is read from the request body - nothing else (no account id, no
 * "connected" flag, no strategy/profile data, no provenance) is client-controlled.
 * Responses carry the generation state and the saved draft - never a prompt, a
 * provider message, a key or a token.
 *
 * POST /generate  -> 202 { status:'generating', generationId, alreadyRunning, generation }
 * GET  /status    -> state of ?generationId=... or, without it, the project's latest generation
 */

const ERROR_STATUS = {
  INVALID_PLATFORM: 400,
  INVALID_OBJECTIVE: 400,
  INVALID_PILLAR: 400,
  NOT_FOUND: 404,
  NO_STRATEGY: 409,
  PLATFORM_NOT_CONNECTED: 409,
  OBJECTIVE_NOT_IN_STRATEGY: 422,
  PLATFORM_NOT_IN_STRATEGY: 422,
  AI_UNAVAILABLE: 503,
};

const serverError = (res, message) => res.status(500).json(ResponseUtil.error(message, 500, { code: 'SOCIAL_AI_CONTENT_FAILED' }));

export async function generateAIContentHandler(req, res) {
  const projectId = req.projectId;
  const { platform, contentPillar, objective } = req.body || {};
  try {
    const result = await startContentGeneration(projectId, req.userId, { platform, contentPillar, objective });
    if (!result.success) {
      const status = ERROR_STATUS[result.error.code] || 400;
      const { code, message, allowed } = result.error;
      return res.status(status).json(ResponseUtil.error(message, status, { code, ...(allowed ? { allowed } : {}) }));
    }
    return res.status(202).json(ResponseUtil.success({
      status: 'generating',
      generationId: result.generation?.id || null,
      alreadyRunning: result.alreadyRunning,
      generation: result.generation,
    }));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_AI_CONTENT] Failed to start generation', { message: error.message }, { projectId });
    return serverError(res, 'Failed to start the post generation');
  }
}

export async function getAIContentStatusHandler(req, res) {
  const projectId = req.projectId;
  const generationId = typeof req.query?.generationId === 'string' ? req.query.generationId : null;
  try {
    const result = await getContentGenerationStatus(projectId, { generationId });
    if (!result.success) {
      const status = ERROR_STATUS[result.error.code] || 400;
      return res.status(status).json(ResponseUtil.error(result.error.message, status, { code: result.error.code }));
    }
    const { status, generation, publication } = result;
    return res.json(ResponseUtil.success({ status, generation, publication }));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_AI_CONTENT] Failed to load status', { message: error.message }, { projectId });
    return serverError(res, 'Failed to load the post generation status');
  }
}

export default { generateAIContentHandler, getAIContentStatusHandler };
