import { getCalendarState, getCalendarGenerationStatus, startCalendarGeneration, previewCalendar, resumeCalendar, cancelCalendar, listVersions, getVersion, restoreVersion } from '../service/calendar/socialContentCalendarService.js';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * SocialContentCalendarController — HTTP only. Every route runs behind auth + validateProjectAccess()
 * (routes/socialContentCalendarRoutes.js), which sets req.projectId / req.userId; those are the only identities used
 * here, and every query in the service is scoped by that project. The client sends ONLY its own choices (dates,
 * posts per week, platforms, distribution): the strategy, profile and catalog the plan is built from are always loaded
 * by the server. Responses carry the calendar and safe generation metadata only — never a prompt, a provider
 * message, a key or a token.
 *
 * GET  /            -> current calendar + items + latest attempt + what the user can choose + staleness
 * GET  /status      -> cheap generation status for polling (no items, no profile resolution)
 * POST /generate    -> starts a generation (202) or reports the one already running.
 *                     Generating again is how a calendar is regenerated: it creates the next version and keeps the old one.
 */

const ERROR_STATUS = {
  NOT_FOUND: 404,
  NO_STRATEGY: 422,
  INSUFFICIENT_PROFILE: 422,
  PLATFORM_NOT_CONNECTED: 422,
  PLATFORM_NOT_IN_STRATEGY: 422,
  AI_UNAVAILABLE: 503,
  CONFLICT: 409,
  NOTHING_TO_RESUME: 409,
  NOTHING_TO_CANCEL: 409,
  ALREADY_CURRENT: 409,
  GENERATION_IN_PROGRESS: 409,
  // every input-validation code (INVALID_BODY, UNKNOWN_FIELD, INVALID_DATE, INVALID_DATE_RANGE, DATE_IN_PAST, INVALID_POSTS_PER_WEEK, INVALID_PLATFORMS, INVALID_DISTRIBUTION) is a 400
};

const serverError = (res, message, code) => res.status(500).json(ResponseUtil.error(message, 500, { code }));

export async function getContentCalendarHandler(req, res) {
  const projectId = req.projectId;
  try {
    const state = await getCalendarState(projectId);
    if (!state) return res.status(404).json(ResponseUtil.error('Project not found.', 404, { code: 'NOT_FOUND' }));
    return res.json(ResponseUtil.success(state));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_CALENDAR] Failed to load calendar', { message: error.message }, { projectId });
    return serverError(res, 'Failed to load the content calendar', 'SOCIAL_CALENDAR_FAILED');
  }
}

export async function getContentCalendarStatusHandler(req, res) {
  const projectId = req.projectId;
  try {
    return res.json(ResponseUtil.success(await getCalendarGenerationStatus(projectId)));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_CALENDAR] Failed to load status', { message: error.message }, { projectId });
    return serverError(res, 'Failed to load the content calendar status', 'SOCIAL_CALENDAR_FAILED');
  }
}

export async function generateContentCalendarHandler(req, res) {
  const projectId = req.projectId;
  try {
    const result = await startCalendarGeneration(projectId, req.userId, req.body);
    if (!result.success) {
      const status = ERROR_STATUS[result.error.code] || 400;
      const { code, message, ...extra } = result.error;
      return res.status(status).json(ResponseUtil.error(message, status, { code, ...extra }));
    }
    // 202: accepted, finished later. alreadyRunning is not an error — the caller just follows the existing run.
    return res.status(202).json(ResponseUtil.success({ status: 'generating', alreadyRunning: result.alreadyRunning, generation: result.generation }));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_CALENDAR] Failed to start generation', { message: error.message }, { projectId });
    return serverError(res, 'Failed to start the content calendar generation', 'SOCIAL_CALENDAR_FAILED');
  }
}

/**
 * POST /preview -> what a set of choices means (end date, exact post count), computed by the server's planner with no AI call
 * and no write: the form shows it before the person generates. Same validation (and error codes) as /generate.
 */
export async function previewContentCalendarHandler(req, res) {
  try {
    const result = await previewCalendar(req.body);
    if (!result.success) {
      const status = ERROR_STATUS[result.error.code] || 400;
      return res.status(status).json(ResponseUtil.error(result.error.message, status, { code: result.error.code }));
    }
    return res.json(ResponseUtil.success(result.preview));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_CALENDAR] Failed to preview', { message: error.message }, { projectId: req.projectId });
    return serverError(res, 'Failed to work out the content calendar', 'SOCIAL_CALENDAR_FAILED');
  }
}

/**
 * POST /resume -> continues an unfinished (partial) calendar: only the posts that are missing are generated. 202 like /generate; if a
 * generation is already running it is reported (alreadyRunning), not an error.
 */
export async function resumeContentCalendarHandler(req, res) {
  const projectId = req.projectId;
  try {
    const result = await resumeCalendar(projectId);
    if (!result.success) {
      const status = ERROR_STATUS[result.error.code] || 400;
      return res.status(status).json(ResponseUtil.error(result.error.message, status, { code: result.error.code }));
    }
    return res.status(202).json(ResponseUtil.success({ status: 'generating', alreadyRunning: result.alreadyRunning, generation: result.generation }));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_CALENDAR] Failed to resume generation', { message: error.message }, { projectId });
    return serverError(res, 'Failed to resume the content calendar generation', 'SOCIAL_CALENDAR_FAILED');
  }
}

/** POST /cancel -> stops an unfinished calendar (running, waiting to retry, or partial) and discards what it saved. The last ready calendar is untouched. */
export async function cancelContentCalendarHandler(req, res) {
  const projectId = req.projectId;
  try {
    const result = await cancelCalendar(projectId);
    if (!result.success) {
      const status = ERROR_STATUS[result.error.code] || 400;
      return res.status(status).json(ResponseUtil.error(result.error.message, status, { code: result.error.code }));
    }
    return res.json(ResponseUtil.success({ status: 'cancelled', generation: result.generation }));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_CALENDAR] Failed to cancel generation', { message: error.message }, { projectId });
    return serverError(res, 'Failed to stop the content calendar generation', 'SOCIAL_CALENDAR_FAILED');
  }
}

/** GET /history -> every version of the calendar that can be opened (current + archived), with how much of each was edited, approved or turned into posts. */
export async function listCalendarVersionsHandler(req, res) {
  const projectId = req.projectId;
  try {
    const result = await listVersions(projectId);
    return res.json(ResponseUtil.success({ versions: result.versions, currentVersion: result.currentVersion }));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_CALENDAR] Failed to list versions', { message: error.message }, { projectId });
    return serverError(res, 'Failed to load the calendar history', 'SOCIAL_CALENDAR_FAILED');
  }
}

/** GET /history/:calendarId -> one version's posts, read-only. A calendar of another project is simply not found. */
export async function getCalendarVersionHandler(req, res) {
  const projectId = req.projectId;
  try {
    const result = await getVersion(projectId, req.params.calendarId);
    if (!result.success) {
      const status = ERROR_STATUS[result.error.code] || 400;
      return res.status(status).json(ResponseUtil.error(result.error.message, status, { code: result.error.code }));
    }
    return res.json(ResponseUtil.success({ version: result.version, items: result.items }));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_CALENDAR] Failed to load a version', { message: error.message }, { projectId });
    return serverError(res, 'Failed to load that calendar version', 'SOCIAL_CALENDAR_FAILED');
  }
}

/** POST /restore { calendarId } -> brings an archived version back as the current calendar, whole. */
export async function restoreCalendarVersionHandler(req, res) {
  const projectId = req.projectId;
  try {
    const result = await restoreVersion(projectId, req.body?.calendarId);
    if (!result.success) {
      const status = ERROR_STATUS[result.error.code] || 400;
      return res.status(status).json(ResponseUtil.error(result.error.message, status, { code: result.error.code }));
    }
    return res.json(ResponseUtil.success({ status: 'restored', restoredVersion: result.restoredVersion, replacedVersion: result.replacedVersion }));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_CALENDAR] Failed to restore a version', { message: error.message }, { projectId });
    return serverError(res, 'Failed to restore that calendar version', 'SOCIAL_CALENDAR_FAILED');
  }
}

export default { listCalendarVersionsHandler, getCalendarVersionHandler, restoreCalendarVersionHandler, getContentCalendarHandler, getContentCalendarStatusHandler, generateContentCalendarHandler, previewContentCalendarHandler, resumeContentCalendarHandler, cancelContentCalendarHandler };
