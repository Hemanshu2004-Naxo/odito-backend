/**
 * Retry policy for the shared DataForSEO HTTP client (DataForSeoService.post).
 *
 * Pure helpers only — no I/O, no timers — so every rule is unit-testable.
 *
 * Why this exists: a task-level failure (HTTP 200, envelope 20000, tasks[0].status_code != 20000, e.g. 40101 with the
 * message "Internal SE Server Error") used to be thrown immediately as a permanent error, so a transient provider-side
 * failure was never retried. Meanwhile 4xx/auth/credit/validation errors must NOT be retried (they cannot succeed and
 * every attempt may be billed). classifyDataForSeoError decides which is which from the evidence on the error itself
 * (HTTP status, provider codes, provider message) and never from the numeric code alone.
 */

const NETWORK_CODES = new Set([
  'ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'ERR_NETWORK', 'ESOCKETTIMEDOUT',
]);

// Provider messages that mean "the provider (or the search engine behind it) failed", i.e. trying again can work.
const TRANSIENT_MESSAGE = /internal|server error|timeout|timed out|temporar|try again|unavailable|overload|busy|rate limit|too many|bad gateway|gateway/i;
// Messages that mean "this request / account can never succeed as sent". These win over TRANSIENT_MESSAGE.
const PERMANENT_MESSAGE = /authoriz|authenticat|credential|login|password|forbidden|insufficient|balance|payment|paused|unusual activity|invalid|not found|unsupported|missing|required|incorrect|wrong/i;

/**
 * Task status codes whose meaning DataForSEO documents precisely enough to act on directly (still checked AFTER the
 * permanent-message test, so an auth/credit message can never be retried because of its code).
 *   40101 "Internal SE Server Error"                -> transient, resubmit
 *   40103 "Task execution failed, please resubmit"  -> transient, resubmit
 *   40102 "No Search Results"                       -> the search ran and Google returned nothing: never retried
 *   40106 "Task completed with partial results"     -> the task COMPLETED (some pages were not retrieved and not billed);
 *                                                      never resubmitted, callers that opt in process the returned data
 */
export const DFS_TASK_CODES = Object.freeze({
  OK:            20000,
  SE_INTERNAL:   40101,
  NO_RESULTS:    40102,
  EXEC_FAILED:   40103,
  PARTIAL:       40106,
});
const TRANSIENT_TASK_CODES = new Set([DFS_TASK_CODES.SE_INTERNAL, DFS_TASK_CODES.EXEC_FAILED]);

export const DEFAULT_RETRY_CONFIG = Object.freeze({
  baseDelayMs: 2_000,
  maxDelayMs:  30_000,
});

function positiveInt(raw) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Operator-tunable limits, read at call time so tests / ops can change them without a restart of module state.
 *   DATAFORSEO_MAX_ATTEMPTS         hard upper bound on attempts per request (callers may ask for fewer)
 *   DATAFORSEO_RETRY_BASE_DELAY_MS  overrides the caller's base delay
 *   DATAFORSEO_RETRY_MAX_DELAY_MS   cap for any single backoff delay
 *   DATAFORSEO_RETRYABLE_CODES      extra provider status codes (comma separated) to treat as transient
 */
export function readRetryConfig(env = process.env) {
  const extra = String(env.DATAFORSEO_RETRYABLE_CODES ?? '')
    .split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);
  return {
    maxAttemptsCap:   positiveInt(env.DATAFORSEO_MAX_ATTEMPTS),
    baseDelayMs:      positiveInt(env.DATAFORSEO_RETRY_BASE_DELAY_MS),
    maxDelayMs:       positiveInt(env.DATAFORSEO_RETRY_MAX_DELAY_MS) ?? DEFAULT_RETRY_CONFIG.maxDelayMs,
    extraRetryableCodes: new Set(extra),
  };
}

/** Attempts actually allowed: the caller's request, bounded by the operator cap. Always >= 1. */
export function resolveMaxAttempts(requested, cap) {
  const asked = positiveInt(requested) ?? 1;
  return cap ? Math.min(asked, cap) : asked;
}

/**
 * Delay before retry number `attempt` (1 = the wait after the first failed attempt).
 * Exponential (base * 2^(attempt-1)) capped at maxDelayMs, then "equal jitter": half fixed + half random, so parallel
 * desktop/mobile/Maps retries never fire in lock-step but the wait never collapses to ~0.
 * `retryAfterMs` (a 429 Retry-After) is honoured as a floor, still capped by maxDelayMs.
 */
export function computeBackoffMs(attempt, { baseDelayMs, maxDelayMs = DEFAULT_RETRY_CONFIG.maxDelayMs, retryAfterMs = null, random = Math.random } = {}) {
  const base = positiveInt(baseDelayMs) ?? DEFAULT_RETRY_CONFIG.baseDelayMs;
  const exp  = Math.min(maxDelayMs, base * 2 ** Math.max(0, attempt - 1));
  const half = exp / 2;
  const jittered = Math.round(half + random() * half);
  if (retryAfterMs && retryAfterMs > 0) return Math.min(maxDelayMs, Math.max(jittered, retryAfterMs));
  return jittered;
}

function parseRetryAfterMs(headers) {
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (raw == null) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/**
 * @returns {{ retryable: boolean, kind: string, httpStatus: number|null, providerCode: number|null, retryAfterMs: number|null }}
 *   kind: auth | credits | rate_limited | http_4xx | http_5xx | network | timeout | provider_transient | provider_permanent |
 *         no_results | partial_results | malformed_response | unknown
 */
export function classifyDataForSeoError(err, { extraRetryableCodes = new Set() } = {}) {
  const httpStatus   = err?.response?.status ?? null;
  const providerCode = err?.taskStatusCode ?? err?.apiStatusCode ?? null;
  const out = (retryable, kind, extra = {}) => ({ retryable, kind, httpStatus, providerCode, retryAfterMs: null, ...extra });

  if (err?.isMalformedResponse) return out(true, 'malformed_response');

  if (httpStatus != null) {
    if (httpStatus === 401 || httpStatus === 403) return out(false, 'auth');
    if (httpStatus === 402) return out(false, 'credits');
    if (httpStatus === 429) return out(true, 'rate_limited', { retryAfterMs: parseRetryAfterMs(err.response?.headers) });
    if (httpStatus === 408) return out(true, 'timeout');
    if (httpStatus >= 500)  return out(true, 'http_5xx');
    return out(false, 'http_4xx');
  }

  if (err?.isApiError) {
    const message = `${err.taskStatusMessage ?? ''} ${err.apiStatusMessage ?? ''} ${err.message ?? ''}`;
    // Completed-task outcomes first: the 40106 message ("...could not be retrieved after several retry attempts. You have
    // not been charged...") must never be mistaken for either a transient or a permanent failure.
    if (err.taskStatusCode === DFS_TASK_CODES.PARTIAL)    return out(false, 'partial_results');
    if (err.taskStatusCode === DFS_TASK_CODES.NO_RESULTS) return out(false, 'no_results');
    if (PERMANENT_MESSAGE.test(message)) return out(false, 'provider_permanent');
    if (err.taskStatusCode != null && TRANSIENT_TASK_CODES.has(err.taskStatusCode)) return out(true, 'provider_transient');
    if (providerCode != null && extraRetryableCodes.has(providerCode)) return out(true, 'provider_transient');
    if (providerCode != null && providerCode >= 50000 && providerCode < 60000) return out(true, 'provider_transient');
    if (TRANSIENT_MESSAGE.test(message)) return out(true, 'provider_transient');
    return out(false, 'provider_permanent');
  }

  // No HTTP response and not a provider envelope: connection / timeout class errors (axios sets err.code).
  if (err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT' || /timeout/i.test(err?.message ?? '')) return out(true, 'timeout');
  if (NETWORK_CODES.has(err?.code)) return out(true, 'network');
  return out(true, 'unknown');
}

/**
 * Make sure a response body is a usable DataForSEO envelope. A proxy / gateway error page (HTML string), an empty body or
 * a truncated JSON string must not be read as "status undefined" and then treated as a permanent provider error.
 * Returns the parsed object, or throws an error flagged isMalformedResponse (retryable).
 */
export function parseEnvelope(raw) {
  let data = raw;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { data = null; }
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw Object.assign(new Error('DataForSEO returned a malformed (non-JSON-object) response'), { isMalformedResponse: true });
  }
  return data;
}
