import { LoggerUtil } from '../../../../utils/LoggerUtil.js';
import AiVisibilityQuestionSet from '../../shared/questions/models/AiVisibilityQuestionSet.js';
import { QUESTION_STATUS } from '../../shared/questions/config/questionConfig.js';
import { buildBusinessProfile } from '../../shared/services/businessProfileService.js';
import { getGoogleAioConfig, QUESTIONS_PER_RUN } from '../config/googleAioConfig.js';
import { selectQuestions, QuestionSelectionError } from '../selection/questionSelection.js';
import { resolveLocation, LocationConfigError } from '../location/locationResolver.js';
import { buildSerpSettings, RequestConfigError } from '../provider/requestBuilder.js';
import * as runs from './runService.js';
import { emitGoogleAioEvent } from './events.js';
import { kick } from '../workers/runWorker.js';

/**
 * Starting a run (user-initiated; there is no automatic trigger for paid Google SERP requests). Everything that can be checked
 * WITHOUT a paid request is checked here, so a bad configuration is refused with a clear reason before anything is queued:
 *
 *   enabled -> daily limit -> profile (no city conflict) -> approved question set -> EXACTLY five valid unique questions
 *   -> verified location code -> device/language -> create (one active run per project) -> kick
 *
 * A client can only name a device and (optionally) exactly five question ids from the approved set. Location, language, depth and
 * every limit come from the stored profile and server configuration.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const refuse = (reason, extra = {}) => ({ scheduled: false, reason, ...extra });

export async function checkRunLimits({ projectId, now = new Date(), config = getGoogleAioConfig(), Model }) {
  if (!config.limitsEnabled) return null;
  const count = await runs.countRunsSince({ projectId, since: new Date(now.getTime() - DAY_MS), ...(Model ? { Model } : {}) });
  return count >= config.maxRunsPerProjectPerDay ? { code: 'PROJECT_DAILY_LIMIT', message: 'The daily Google AI Overview run limit for this project has been reached' } : null;
}

/** The approved set a run may use. The id is only a lookup key, scoped to the project and required to be approved. */
export async function resolveApprovedQuestionSet({ projectId }, { QuestionSetModel = AiVisibilityQuestionSet } = {}) {
  const set = await QuestionSetModel.findOne({ projectId, status: QUESTION_STATUS.APPROVED }).lean();
  return set ? { ok: true, set } : { ok: false, reason: 'NO_APPROVED_QUESTION_SET' };
}

/**
 * Dry run of everything start does except creating the run: what the next run WOULD ask and where. Used by the Questions page.
 * Never calls the paid provider (the location list is a free, cached call).
 */
export async function previewRun({ projectId, questionIds = null, device = 'desktop' }, deps = {}) {
  const config = deps.config || getGoogleAioConfig();
  const build = deps.buildProfile || buildBusinessProfile;
  const profile = await build(String(projectId));
  if ((profile.warnings || []).includes('location_conflict')) return refuse('PROFILE_LOCATION_CONFLICT', { details: { conflicts: profile.market.conflicts } });
  const resolved = await resolveApprovedQuestionSet({ projectId }, { QuestionSetModel: deps.QuestionSetModel });
  if (!resolved.ok) return refuse(resolved.reason);
  let selection;
  try {
    selection = selectQuestions(resolved.set, profile, { questionIds });
  } catch (error) {
    if (error instanceof QuestionSelectionError) return refuse(error.code, { message: error.message, details: error.details });
    throw error;
  }
  let location;
  let location_error = null;
  try {
    location = await resolveLocation(profile.market, { loadLocations: deps.loadLocations });
  } catch (error) {
    if (!(error instanceof LocationConfigError)) throw error;
    location_error = { code: error.code, message: error.message, details: error.details };
  }
  let serp = null;
  if (location) {
    try {
      serp = buildSerpSettings({ locationCode: location.locationCode, languageCode: languageOf(resolved.set, profile), device }, config);
    } catch (error) {
      if (!(error instanceof RequestConfigError) && error?.code !== 'UNSUPPORTED_SERP_DEVICE') throw error;
      return refuse(error.code === 'UNSUPPORTED_SERP_DEVICE' ? 'DEVICE_NOT_SUPPORTED' : error.code, { message: error.message });
    }
  }
  return { ok: true, set: resolved.set, profile, selection, location, locationError: location_error, serp };
}

/** DataForSEO language codes are primary subtags ("en", "hi"). The set's language is what the questions are actually written in. */
const languageOf = (set, profile) => String(set.language || profile.market.language || 'en').toLowerCase().slice(0, 2);

export async function startManualRun({ projectId, userId, questionIds = null, device = 'desktop' }, deps = {}) {
  const config = deps.config || getGoogleAioConfig();
  const now = deps.now || (() => new Date());
  if (!config.enabled) return refuse('DISABLED');

  const limit = await checkRunLimits({ projectId, now: now(), config, Model: deps.Model });
  if (limit) return refuse(limit.code, { limit });

  const preview = await previewRun({ projectId, questionIds, device }, deps);
  if (!preview.ok) return preview;
  if (preview.locationError) return refuse(preview.locationError.code, { message: preview.locationError.message, details: preview.locationError.details });

  const { set, selection, serp, location } = preview;
  // Defence in depth: the schema enforces this too, but a wrong count must never reach the database.
  if (selection.snapshot.length !== QUESTIONS_PER_RUN) return refuse('QUESTION_COUNT_INVALID', { details: { required: QUESTIONS_PER_RUN, received: selection.snapshot.length } });

  const created = await runs.createRun({
    projectId, userId, questionSetId: set._id, questionSetVersion: set.version, selectionMode: selection.mode, questionSnapshot: selection.snapshot,
    serp: { ...serp, locationName: location.locationName, locationMethod: location.method },
    policy: {
      questionsPerRun: QUESTIONS_PER_RUN, endpoint: 'serp/google/organic/live/advanced', maxRetries: config.maxRetries, timeoutMs: config.timeoutMs,
      maxConcurrentQuestions: config.maxConcurrentQuestions, maxRunCost: config.maxRunCost, costUnit: config.costUnit,
    },
  }, { Model: deps.Model });
  if (!created.created) return refuse('ACTIVE_RUN_EXISTS', { run: created.activeRun });

  LoggerUtil.info('Google AI Overview visibility: run queued', { projectId: String(projectId), device: serp.device, locationCode: serp.locationCode, questions: QUESTIONS_PER_RUN });
  (deps.emit || emitGoogleAioEvent)('started', created.run);
  (deps.kick || kick)(String(created.run._id));
  return { scheduled: true, reason: null, run: created.run };
}

export default { startManualRun, previewRun, resolveApprovedQuestionSet, checkRunLimits };
