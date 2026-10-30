/**
 * Provider error vocabulary and classification for Google AI Overview Visibility. Code-only errors plus a short provider message and
 * diagnostics: they never carry the request (it holds the question), the response body or any header.
 *
 * The code table below is DataForSEO's documented one (docs.dataforseo.com/v3/appendix/errors, checked 2026-10-28). Notably:
 *   40100 "you are not authorized"                    -> credentials (fatal)
 *   40101 "internal se server error"                  -> the SEARCH ENGINE failed to process this one request. NOT authentication.
 *   40102 "no search results"                         -> that search produced no SERP at all
 *   40103 "task execution failed, please try to resubmit" -> transient, resubmit
 * An earlier version mapped 40100 AND 40101 to a fatal auth error; one transient 40101 then aborted the whole run. 40101 is now a
 * retryable, non-fatal, per-question failure.
 * Which code a given real failure carried is only known for evidence recorded after diagnostics were added (diagnostics.providerCode).
 */

export const GOOGLE_AIO_ERROR = Object.freeze({
  AUTH: 'GOOGLE_AIO_AUTH_FAILED',
  INSUFFICIENT_CREDITS: 'GOOGLE_AIO_INSUFFICIENT_CREDITS',
  COST_LIMIT_EXCEEDED: 'GOOGLE_AIO_COST_LIMIT_EXCEEDED',
  ACCOUNT_RESTRICTED: 'GOOGLE_AIO_ACCOUNT_RESTRICTED',
  RATE_LIMITED: 'GOOGLE_AIO_RATE_LIMITED',
  DUPLICATE_TASK_LIMIT: 'GOOGLE_AIO_DUPLICATE_TASK_LIMIT',
  TIMEOUT: 'GOOGLE_AIO_TIMEOUT',
  NETWORK: 'GOOGLE_AIO_NETWORK',
  UNAVAILABLE: 'GOOGLE_AIO_PROVIDER_UNAVAILABLE',
  SEARCH_ENGINE_ERROR: 'GOOGLE_AIO_SEARCH_ENGINE_ERROR',
  TASK_EXECUTION_FAILED: 'GOOGLE_AIO_TASK_EXECUTION_FAILED',
  NO_SEARCH_RESULTS: 'GOOGLE_AIO_NO_SEARCH_RESULTS',
  REQUEST_REJECTED: 'GOOGLE_AIO_REQUEST_REJECTED',
  TASK_FAILED: 'GOOGLE_AIO_TASK_FAILED',
  MALFORMED_RESPONSE: 'GOOGLE_AIO_MALFORMED_RESPONSE',
  UNEXPECTED: 'GOOGLE_AIO_UNEXPECTED_ERROR',
});
const E = GOOGLE_AIO_ERROR;

/** Transient: the same question may be sent again (bounded by maxRetries). */
const RETRYABLE = new Set([E.RATE_LIMITED, E.TIMEOUT, E.NETWORK, E.UNAVAILABLE, E.SEARCH_ENGINE_ERROR, E.TASK_EXECUTION_FAILED]);
/**
 * Problems with the ACCOUNT (credentials, balance, spending limit, restriction), documented system-level limits: every further request
 * would fail the same way, so the run stops dispatching and records the remaining questions as NOT SENT with this as the reason.
 */
const FATAL = new Set([E.AUTH, E.INSUFFICIENT_CREDITS, E.COST_LIMIT_EXCEEDED, E.ACCOUNT_RESTRICTED]);

/** DataForSEO status code -> our code (envelope `status_code` and task `status_code` use the same table). */
const BY_PROVIDER_CODE = new Map([
  [40100, E.AUTH],
  [40101, E.SEARCH_ENGINE_ERROR],
  [40102, E.NO_SEARCH_RESULTS],
  [40103, E.TASK_EXECUTION_FAILED],
  [40104, E.ACCOUNT_RESTRICTED], // account not verified
  [40200, E.INSUFFICIENT_CREDITS],
  [40210, E.INSUFFICIENT_CREDITS],
  [40201, E.ACCOUNT_RESTRICTED],
  [40202, E.RATE_LIMITED],
  [40203, E.COST_LIMIT_EXCEEDED],
  [40204, E.ACCOUNT_RESTRICTED], // subscription required
  [40205, E.DUPLICATE_TASK_LIMIT],
  [40206, E.DUPLICATE_TASK_LIMIT],
  [40207, E.ACCOUNT_RESTRICTED], // IP not whitelisted
  [40208, E.ACCOUNT_RESTRICTED],
  [40209, E.RATE_LIMITED], // too many simultaneous queries
  [40601, E.UNAVAILABLE],
  [40602, E.UNAVAILABLE],
  [50401, E.TIMEOUT],
  [50402, E.TIMEOUT],
]);

const clean = (v, max = 300) => (typeof v === 'string' ? v.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) || null : null);

export class GoogleAioProviderError extends Error {
  constructor(code, { httpStatus = null, providerCode = null, providerMessage = null, taskId = null, retryAfterMs = null, attempts = 1, attemptLog = [] } = {}) {
    super(code);
    this.name = 'GoogleAioProviderError';
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    this.fatal = FATAL.has(code);
    this.httpStatus = httpStatus;
    this.providerCode = providerCode;
    this.providerMessage = clean(providerMessage);
    this.taskIdReturned = Boolean(taskId);
    this.retryAfterMs = retryAfterMs;
    this.attempts = attempts;
    this.attemptLog = attemptLog;
  }
}

const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH', 'ERR_NETWORK']);
const TIMEOUT_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ERR_CANCELED']);

function parseRetryAfterMs(headers) {
  const raw = headers?.['retry-after'] ?? headers?.get?.('retry-after');
  if (raw == null) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

/** Map any thrown error (axios error, envelope/task error, our own) to a GoogleAioProviderError carrying the useful diagnostics. */
export function classifyProviderError(err) {
  if (err instanceof GoogleAioProviderError) return err;
  const httpStatus = Number.isInteger(err?.response?.status) ? err.response.status : null;
  const providerCode = Number.isInteger(err?.taskStatusCode) ? err.taskStatusCode : (Number.isInteger(err?.apiStatusCode) ? err.apiStatusCode : null);
  const providerMessage = err?.taskStatusMessage ?? err?.apiStatusMessage ?? err?.response?.data?.status_message ?? null;
  const retryAfterMs = parseRetryAfterMs(err?.response?.headers);
  const message = String(err?.message || '').toLowerCase();
  const make = (code) => new GoogleAioProviderError(code, { httpStatus, providerCode, providerMessage, taskId: err?.taskId, retryAfterMs });

  if (httpStatus != null) {
    if (httpStatus === 401 || httpStatus === 403) return make(E.AUTH);
    if (httpStatus === 402) return make(E.INSUFFICIENT_CREDITS);
    if (httpStatus === 429) return make(E.RATE_LIMITED);
    if (httpStatus >= 500) return make(E.UNAVAILABLE);
    return make(E.REQUEST_REJECTED);
  }
  if (providerCode != null) {
    const mapped = BY_PROVIDER_CODE.get(providerCode);
    if (mapped) return make(mapped);
    if (providerCode >= 50000 && providerCode < 60000) return make(E.UNAVAILABLE);
    // Any other task-level failure (e.g. 40501 invalid field): not retried blindly, every request is billed.
    return make(err?.isTaskError ? E.TASK_FAILED : E.REQUEST_REJECTED);
  }
  if (TIMEOUT_CODES.has(err?.code) || /timeout/.test(message)) return make(E.TIMEOUT);
  if (NETWORK_CODES.has(err?.code)) return make(E.NETWORK);
  return make(err?.isAxiosError ? E.NETWORK : E.REQUEST_REJECTED);
}

export default { GoogleAioProviderError, GOOGLE_AIO_ERROR, classifyProviderError };
