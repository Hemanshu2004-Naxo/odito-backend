import { DataForSeoService } from '../../../ranking/services/DataForSeoService.js';
import { createLimiter } from '../../../ranking/services/serpDevices.js';
import { getGoogleAioConfig } from '../config/googleAioConfig.js';
import { buildGoogleAioRequest } from './requestBuilder.js';
import { parseGoogleAioResponse } from './responseParser.js';
import { GoogleAioProviderError, classifyProviderError } from './providerErrors.js';

/**
 * Google AI Overview provider: orchestrates ONE question = ONE paid SERP request (plus bounded retries of transient transport
 * failures). The pieces are separate modules: requestBuilder (body), DataForSeoService.postGoogleOrganicLiveAdvanced (transport),
 * responseParser (validation + SERP normalization + AI Overview extraction), providerErrors (classification).
 *
 * A response WITHOUT an ai_overview item is a successful observation ({ aiOverview: null }), never an error and never retried.
 */

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
let limiter = null;
let limiterSize = 0;
function getLimiter(size) {
  if (!limiter || limiterSize !== size) { limiter = createLimiter(size); limiterSize = size; }
  return limiter;
}

/** Delay before retry `attempt` (1-based = the attempt that just failed): Retry-After if given, else capped exponential backoff, both jittered. */
export function computeRetryDelayMs(error, attempt, config, random = Math.random) {
  const cap = config.retryMaxDelayMs;
  if (error.retryAfterMs != null) return Math.min(cap, Math.max(0, error.retryAfterMs));
  const exp = Math.min(cap, config.retryBaseDelayMs * 2 ** (attempt - 1));
  return Math.round(exp * (0.5 + random() * 0.5));
}

/**
 * @param {{question:string, serp:object, tag?:string}} input   serp = run-level settings (buildSerpSettings)
 * @param {{config?:object, send?:Function, sleep?:Function, random?:Function}} [deps]
 * @returns {Promise<object>} parsed SERP + { request: <body sent>, attempts, durationMs }
 * @throws {GoogleAioProviderError} with .attempts = number of requests actually sent
 */
export async function fetchGoogleAiOverview({ question, serp, tag }, deps = {}) {
  const config = deps.config || getGoogleAioConfig();
  const send = deps.send || ((body, opts) => DataForSeoService.postGoogleOrganicLiveAdvanced(body, opts));
  const sleep = deps.sleep || defaultSleep;
  const random = deps.random || Math.random;
  const body = buildGoogleAioRequest({ question, serp, tag });

  return getLimiter(config.maxConcurrentQuestions)(async () => {
    const maxAttempts = 1 + Math.max(0, config.maxRetries);
    const started = Date.now();
    let lastError = null;
    // One entry per request actually sent: what happened, how long it took. No body, no headers, no credentials.
    const attemptLog = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const t0 = Date.now();
      try {
        const data = await send(body, { timeoutMs: config.timeoutMs });
        const parsed = parseGoogleAioResponse(data);
        attemptLog.push({ attempt, outcome: 'ok', httpStatus: 200, providerCode: 20000, durationMs: Date.now() - t0 });
        return { ...parsed, request: body, attempts: attempt, attemptLog, durationMs: Date.now() - started };
      } catch (raw) {
        const error = classifyProviderError(raw);
        error.attempts = attempt;
        attemptLog.push({ attempt, outcome: error.code, httpStatus: error.httpStatus, providerCode: error.providerCode, providerMessage: error.providerMessage, durationMs: Date.now() - t0 });
        error.attemptLog = attemptLog;
        error.durationMs = Date.now() - started;
        lastError = error;
        if (!error.retryable || attempt >= maxAttempts) throw error;
        await sleep(computeRetryDelayMs(error, attempt, config, random));
      }
    }
    throw lastError || new GoogleAioProviderError('GOOGLE_AIO_UNEXPECTED_ERROR');
  });
}

export default { fetchGoogleAiOverview, computeRetryDelayMs };
