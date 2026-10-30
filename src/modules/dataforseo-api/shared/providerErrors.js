/**
 * Failure vocabulary shared by every DataForSEO feature. A failure is classified into a CODE ONLY: the provider's body, headers and
 * credentials never reach the browser (the provider's own short status message is kept for server logs). The code strings match
 * the ones the Referring Domains module already uses, so the frontend handles them the same way.
 */

export const DATAFORSEO_ERROR = Object.freeze({
  NOT_CONFIGURED: 'DATAFORSEO_NOT_CONFIGURED',
  AUTH: 'PROVIDER_AUTH_FAILED',
  INSUFFICIENT_CREDITS: 'PROVIDER_INSUFFICIENT_CREDITS',
  ACCOUNT_RESTRICTED: 'PROVIDER_ACCOUNT_RESTRICTED',
  RATE_LIMITED: 'PROVIDER_RATE_LIMITED',
  TIMEOUT: 'PROVIDER_TIMEOUT',
  NETWORK: 'PROVIDER_NETWORK_ERROR',
  UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  REQUEST_REJECTED: 'PROVIDER_REQUEST_REJECTED',
  MALFORMED_RESPONSE: 'PROVIDER_MALFORMED_RESPONSE',
});

/** HTTP status our API answers with for each code. */
export const DATAFORSEO_HTTP_STATUS = Object.freeze({
  [DATAFORSEO_ERROR.NOT_CONFIGURED]: 503,
  [DATAFORSEO_ERROR.AUTH]: 502,
  [DATAFORSEO_ERROR.INSUFFICIENT_CREDITS]: 503,
  [DATAFORSEO_ERROR.ACCOUNT_RESTRICTED]: 503,
  [DATAFORSEO_ERROR.RATE_LIMITED]: 429,
  [DATAFORSEO_ERROR.TIMEOUT]: 504,
  [DATAFORSEO_ERROR.NETWORK]: 502,
  [DATAFORSEO_ERROR.UNAVAILABLE]: 502,
  [DATAFORSEO_ERROR.REQUEST_REJECTED]: 502,
  [DATAFORSEO_ERROR.MALFORMED_RESPONSE]: 502,
});

/** What a user is told. Deliberately generic about the provider account (credits, auth): that is an Odito problem, not theirs. */
export const DATAFORSEO_USER_MESSAGE = Object.freeze({
  [DATAFORSEO_ERROR.NOT_CONFIGURED]: 'This data source is not configured on this server yet.',
  [DATAFORSEO_ERROR.AUTH]: 'The data service is temporarily unavailable. Please try again later.',
  [DATAFORSEO_ERROR.INSUFFICIENT_CREDITS]: 'The data service is temporarily unavailable. Please try again later.',
  [DATAFORSEO_ERROR.ACCOUNT_RESTRICTED]: 'The data service is temporarily unavailable. Please try again later.',
  [DATAFORSEO_ERROR.RATE_LIMITED]: 'The data service is busy. Please wait a minute and try again.',
  [DATAFORSEO_ERROR.TIMEOUT]: 'The data service took too long to respond. Please try again.',
  [DATAFORSEO_ERROR.NETWORK]: 'Could not reach the data service. Please try again.',
  [DATAFORSEO_ERROR.UNAVAILABLE]: 'The data service is temporarily unavailable. Please try again later.',
  [DATAFORSEO_ERROR.REQUEST_REJECTED]: 'The data service could not process this domain.',
  [DATAFORSEO_ERROR.MALFORMED_RESPONSE]: 'The data service returned an unexpected response. Please try again.',
});

export class DataForSeoApiError extends Error {
  constructor(code, { httpStatus = null, providerCode = null, providerMessage = null } = {}) {
    super(code);
    this.name = 'DataForSeoApiError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.providerCode = providerCode;
    this.providerMessage = providerMessage;
  }
}

const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH', 'ERR_NETWORK']);
const TIMEOUT_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ERR_CANCELED']);

export function hasCredentials(env = process.env) {
  return Boolean(env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD);
}

/** Map any thrown error (axios error, envelope/task error from DataForSeoService, our own) to a DataForSeoApiError. */
export function classifyProviderError(err) {
  if (err instanceof DataForSeoApiError) return err;
  const httpStatus = Number.isInteger(err?.response?.status) ? err.response.status : null;
  const providerCode = Number.isInteger(err?.taskStatusCode) ? err.taskStatusCode : (Number.isInteger(err?.apiStatusCode) ? err.apiStatusCode : null);
  const message = String(err?.message || '').toLowerCase();
  const providerMessage = providerCode != null ? String(err?.message || '').slice(0, 300) : null;
  const make = (code) => new DataForSeoApiError(code, { httpStatus, providerCode, providerMessage });

  if (httpStatus != null) {
    if (httpStatus === 401 || httpStatus === 403) return make(DATAFORSEO_ERROR.AUTH);
    if (httpStatus === 402) return make(DATAFORSEO_ERROR.INSUFFICIENT_CREDITS);
    if (httpStatus === 429) return make(DATAFORSEO_ERROR.RATE_LIMITED);
    if (httpStatus >= 500) return make(DATAFORSEO_ERROR.UNAVAILABLE);
    return make(DATAFORSEO_ERROR.REQUEST_REJECTED);
  }
  if (providerCode != null) {
    if (providerCode === 40201) return make(DATAFORSEO_ERROR.ACCOUNT_RESTRICTED);
    if (providerCode >= 40100 && providerCode < 40200) return make(DATAFORSEO_ERROR.AUTH);
    if (providerCode === 40200 || /insufficient|balance|funds|credit/.test(message)) return make(DATAFORSEO_ERROR.INSUFFICIENT_CREDITS);
    if (providerCode === 40202 || /rate limit|too many requests/.test(message)) return make(DATAFORSEO_ERROR.RATE_LIMITED);
    if (providerCode >= 50000 && providerCode < 60000) return make(DATAFORSEO_ERROR.UNAVAILABLE);
    return make(DATAFORSEO_ERROR.REQUEST_REJECTED);
  }
  if (TIMEOUT_CODES.has(err?.code) || /timeout/.test(message)) return make(DATAFORSEO_ERROR.TIMEOUT);
  if (NETWORK_CODES.has(err?.code) || err?.isAxiosError) return make(DATAFORSEO_ERROR.NETWORK);
  return make(DATAFORSEO_ERROR.UNAVAILABLE);
}

/**
 * Validate the envelope of a DataForSEO v3 response and return `tasks[0]`. status_code must be 20000 BOTH at the top level and on
 * the task: HTTP 200 with a failed task is a failure, never an empty success. Throws a DataForSeoApiError otherwise.
 */
export function requireOkTask(data) {
  const malformed = () => new DataForSeoApiError(DATAFORSEO_ERROR.MALFORMED_RESPONSE);
  if (!data || typeof data !== 'object' || typeof data.status_code !== 'number') throw malformed();
  if (data.status_code !== 20000) throw classifyProviderError({ apiStatusCode: data.status_code, message: data.status_message });
  const task = Array.isArray(data.tasks) ? data.tasks[0] : null;
  if (!task || typeof task !== 'object') throw malformed();
  if (task.status_code !== 20000) throw classifyProviderError({ taskStatusCode: task.status_code, message: task.status_message });
  return task;
}
