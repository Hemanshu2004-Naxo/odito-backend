import { resolveSerpDevice, DEFAULT_SERP_DEVICE } from '../../../ranking/services/serpDevices.js';
import { getGoogleAioConfig } from '../config/googleAioConfig.js';

/**
 * Request construction for POST /v3/serp/google/organic/live/advanced. Pure.
 *
 * Fields (docs.dataforseo.com/v3/serp/google/organic/live/advanced, checked 2026-10-28):
 *   keyword string (<= 700 chars) | location_code integer | language_code string | device "desktop"|"mobile" |
 *   os desktop: windows|macos, mobile: android|ios | depth integer (default 10, max 200) |
 *   load_async_ai_overview boolean (default false; true adds $0.002 per request, refunded when no overview element is returned) |
 *   tag string (<= 255 chars, echoed back in the response `data` object).
 * Nothing ChatGPT-specific (user_prompt, model_name, web_search ...) is ever sent here.
 */

export class RequestConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RequestConfigError';
    this.code = code;
  }
}

/** The per-run SERP settings stored on the run (resolved once, so every question of a run uses the same market and device). */
export function buildSerpSettings({ locationCode, languageCode, device = DEFAULT_SERP_DEVICE }, config = getGoogleAioConfig()) {
  if (!Number.isInteger(locationCode) || locationCode <= 0) throw new RequestConfigError('INVALID_LOCATION_CODE', 'A resolved location code is required');
  if (typeof languageCode !== 'string' || !/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(languageCode)) throw new RequestConfigError('INVALID_LANGUAGE_CODE', 'A valid language code is required');
  const d = resolveSerpDevice(device); // throws UNSUPPORTED_SERP_DEVICE for anything but desktop | mobile
  return {
    locationCode,
    languageCode,
    device: d.device,
    os: d.os,
    depth: config.depth,
    loadAsyncAiOverview: config.loadAsyncAiOverview,
  };
}

/** The request body (ONE task) for one question. */
export function buildGoogleAioRequest({ question, serp, tag }) {
  const keyword = typeof question === 'string' ? question.trim() : '';
  if (!keyword) throw new RequestConfigError('EMPTY_QUESTION', 'The question is empty');
  if (keyword.length > 700) throw new RequestConfigError('QUESTION_TOO_LONG', 'The question exceeds the provider limit of 700 characters');
  return {
    keyword,
    location_code: serp.locationCode,
    language_code: serp.languageCode,
    device: serp.device,
    os: serp.os,
    depth: serp.depth,
    load_async_ai_overview: Boolean(serp.loadAsyncAiOverview),
    tag: String(tag || 'odito-google-aio').slice(0, 255),
  };
}

/** What is stored as "provider request metadata": the body without the question text (stored separately) and without any credential. */
export function requestMetadata(body) {
  const { keyword, ...rest } = body; // eslint-disable-line no-unused-vars
  return { method: 'POST', ...rest };
}

export default { buildSerpSettings, buildGoogleAioRequest, requestMetadata, RequestConfigError };
