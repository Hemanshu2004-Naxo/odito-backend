import { getStrategyState, getGenerationStatus, startGeneration } from '../service/aiStrategy/socialAIStrategyService.js';
import { previewStrategyPlanning } from '../service/aiStrategy/strategyPlanningPreview.js';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * SocialAIStrategyController — HTTP only. Every route runs behind
 * auth + validateProjectAccess() (routes/socialAIStrategyRoutes.js), which sets
 * req.projectId / req.userId; those are the only identities used here, and every
 * query below is scoped by that project. Responses carry the strategy and safe
 * generation metadata only — never a prompt, a provider message, a key or a token.
 *
 * GET  /            -> current strategy + latest attempt + live profile comparison
 * GET  /status      -> cheap generation status for polling (no profile resolution)
 * POST /generate    -> starts a generation (202) or reports the one already running.
 *                     Generating again is how a strategy is regenerated: it creates the next version.
 *                     Body (all optional, nothing else is read): { planning: { postsPerWeek, months, platforms }, expectedVersion, requestId }.
 *                     `planning` is validated by the calendar planner; `expectedVersion` rejects a stale decision (409 STRATEGY_CONFLICT);
 *                     `requestId` makes a repeated send the same version.
 * POST /plan-preview -> the planner's exact count + platform states + allowance fit for a planning choice (read-only, no AI)
 */

const ERROR_STATUS = {
  NOT_FOUND: 404,
  INSUFFICIENT_PROFILE: 422,
  AI_UNAVAILABLE: 503,
  CONFLICT: 409,
  STRATEGY_CONFLICT: 409,
  // planning validation (the calendar planner's codes)
  INVALID_BODY: 400,
  UNKNOWN_FIELD: 400,
  INVALID_DURATION: 400,
  INVALID_POSTS_PER_WEEK: 400,
  INVALID_PLATFORMS: 400,
  INVALID_FIELD: 400,
  INVALID_DATE_RANGE: 400,
  CALENDAR_TOO_LARGE: 422,
};

const BODY_KEYS = ['projectId', 'planning', 'expectedVersion', 'requestId'];
/** A body with a key this endpoint does not know is refused, so a misspelt setting is never silently ignored. */
const unknownKey = (body) => (body && typeof body === 'object' ? Object.keys(body).find((k) => !BODY_KEYS.includes(k)) : null);

const serverError = (res, message, code) => res.status(500).json(ResponseUtil.error(message, 500, { code }));

export async function getAIStrategyHandler(req, res) {
  const projectId = req.projectId;
  try {
    const state = await getStrategyState(projectId);
    if (!state) return res.status(404).json(ResponseUtil.error('Project not found.', 404, { code: 'NOT_FOUND' }));
    return res.json(ResponseUtil.success(state));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_AI_STRATEGY] Failed to load strategy', { message: error.message }, { projectId });
    return serverError(res, 'Failed to load the AI strategy', 'SOCIAL_AI_STRATEGY_FAILED');
  }
}

export async function getAIStrategyStatusHandler(req, res) {
  const projectId = req.projectId;
  try {
    return res.json(ResponseUtil.success(await getGenerationStatus(projectId)));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_AI_STRATEGY] Failed to load status', { message: error.message }, { projectId });
    return serverError(res, 'Failed to load the AI strategy status', 'SOCIAL_AI_STRATEGY_FAILED');
  }
}

export async function generateAIStrategyHandler(req, res) {
  const projectId = req.projectId;
  try {
    const body = req.body || {};
    const stray = unknownKey(body);
    if (stray) return res.status(400).json(ResponseUtil.error(`"${stray}" is not a strategy setting.`, 400, { code: 'UNKNOWN_FIELD' }));
    const result = await startGeneration(projectId, req.userId, { planning: body.planning, expectedVersion: body.expectedVersion, requestId: body.requestId });
    if (!result.success) {
      const status = ERROR_STATUS[result.error.code] || 400;
      const { code, message, blockers, currentVersion, field } = result.error;
      return res.status(status).json(ResponseUtil.error(message, status, { code, ...(blockers ? { blockers } : {}), ...(currentVersion !== undefined ? { currentVersion } : {}), ...(field ? { field } : {}) }));
    }
    // 202: accepted, finished later. alreadyRunning is not an error — the caller just follows the existing run.
    return res.status(202).json(ResponseUtil.success({ status: result.alreadyDone ? 'ready' : 'generating', alreadyRunning: !!result.alreadyRunning, alreadyDone: !!result.alreadyDone, generation: result.generation }));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_AI_STRATEGY] Failed to start generation', { message: error.message }, { projectId });
    return serverError(res, 'Failed to start the AI strategy generation', 'SOCIAL_AI_STRATEGY_FAILED');
  }
}

/** POST /plan-preview -> the planner's answer for a planning choice. Same validation and error codes as /generate; changes nothing. */
export async function previewStrategyPlanHandler(req, res) {
  const projectId = req.projectId;
  try {
    const body = req.body || {};
    const { projectId: _routing, ...choice } = body;
    const result = await previewStrategyPlanning(projectId, req.userId, choice);
    if (!result.success) {
      const status = ERROR_STATUS[result.error.code] || 400;
      return res.status(status).json(ResponseUtil.error(result.error.message, status, { code: result.error.code }));
    }
    return res.json(ResponseUtil.success(result.preview));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_AI_STRATEGY] Failed to preview the plan', { message: error.message }, { projectId });
    return serverError(res, 'Failed to work out the plan', 'SOCIAL_AI_STRATEGY_FAILED');
  }
}

export default { getAIStrategyHandler, getAIStrategyStatusHandler, generateAIStrategyHandler, previewStrategyPlanHandler };
