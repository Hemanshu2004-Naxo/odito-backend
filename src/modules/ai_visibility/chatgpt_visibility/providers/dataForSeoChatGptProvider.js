import { DataForSeoService } from '../../../ranking/services/DataForSeoService.js';
import { createLimiter } from '../../../ranking/services/serpDevices.js';
import { getChatGptConfig } from '../config/chatgptConfig.js';

/**
 * ChatGPT provider: DataForSEO  POST /v3/ai_optimization/chat_gpt/llm_responses/live
 *
 * It reuses the existing DataForSeoService (authentication, base URL, envelope + task-level checks); it adds ONLY what is
 * ChatGPT-specific: the request body, error classification, a paced retry policy, and response parsing.
 *
 * VERIFIED by one live request (see tests/fixtures/chatgptLiveResponse.sanitized.json, same structure, text/URLs/ids replaced):
 *   - envelope: status_code 20000 / "Ok."; tasks[0].status_code 20000; tasks[0].id is a 36-char request id.
 *   - cost: tasks[0].cost (== envelope `cost`) is what the request cost. result[0].money_spent is a DIFFERENT, slightly smaller
 *     number (0.0266131 vs 0.027213 observed), so it is never used as a substitute. NO field or endpoint states a currency or unit.
 *   - answer: result[0].items[0] {type:"message"} -> sections[0] {type:"text", text, annotations[]}.
 *   - annotations: {title, url, start_index, end_index, text}; no `type` field - every one observed was a URL citation. `text` is the
 *     cited answer span, not link text. URLs carry ?utm_source=chatgpt.com. For a local query all 7 pointed at google.com/maps/search.
 *   - other result[0] fields: model_name (dated variant, e.g. gpt-4o-mini-2024-07-18), input/output/reasoning_tokens, web_search, datetime, fan_out_queries.
 *   - errors: an invalid field is HTTP 200 with tasks[0].status_code 40501 ("Invalid Field: 'user_prompt'") and result null; bad credentials
 *     are HTTP 401. Both classify correctly below.
 * STILL UNVERIFIED (cannot be provoked safely): the codes DataForSEO uses for rate limiting, insufficient funds and server-side failures.
 * Those rows of classifyProviderError() are an assumed reading of the code families; 40201 comes from a real task error quoted in DataForSeoService.js.
 */

export const CHATGPT_ERROR = Object.freeze({
  AUTH: 'CHATGPT_AUTH_FAILED',
  INSUFFICIENT_CREDITS: 'CHATGPT_INSUFFICIENT_CREDITS',
  ACCOUNT_RESTRICTED: 'CHATGPT_ACCOUNT_RESTRICTED',
  RATE_LIMITED: 'CHATGPT_RATE_LIMITED',
  TIMEOUT: 'CHATGPT_TIMEOUT',
  NETWORK: 'CHATGPT_NETWORK',
  UNAVAILABLE: 'CHATGPT_PROVIDER_UNAVAILABLE',
  REQUEST_REJECTED: 'CHATGPT_REQUEST_REJECTED',
  MALFORMED_RESPONSE: 'CHATGPT_MALFORMED_RESPONSE',
});

const RETRYABLE = new Set([CHATGPT_ERROR.RATE_LIMITED, CHATGPT_ERROR.TIMEOUT, CHATGPT_ERROR.NETWORK, CHATGPT_ERROR.UNAVAILABLE]);
/** Errors about the ACCOUNT, not the prompt: continuing would only repeat the same paid failure for the remaining prompts. */
const FATAL = new Set([CHATGPT_ERROR.AUTH, CHATGPT_ERROR.INSUFFICIENT_CREDITS, CHATGPT_ERROR.ACCOUNT_RESTRICTED]);

/** A code-only error: never carries the request (it holds the prompt), the response body or any header. */
export class ChatGptProviderError extends Error {
  constructor(code, { httpStatus = null, providerCode = null, retryAfterMs = null, attempts = 1 } = {}) {
    super(code);
    this.name = 'ChatGptProviderError';
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    this.fatal = FATAL.has(code);
    this.httpStatus = httpStatus;
    this.providerCode = providerCode;
    this.retryAfterMs = retryAfterMs;
    this.attempts = attempts;
  }
}

const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH', 'ERR_NETWORK']);
const TIMEOUT_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ERR_CANCELED']);

function parseRetryAfterMs(headers) {
  const raw = headers?.['retry-after'] ?? headers?.get?.('retry-after');
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

/** Map any thrown error (axios error, envelope/task error, our own) to a ChatGptProviderError. */
export function classifyProviderError(err) {
  if (err instanceof ChatGptProviderError) return err;
  const httpStatus = Number.isInteger(err?.response?.status) ? err.response.status : null;
  const providerCode = Number.isInteger(err?.taskStatusCode) ? err.taskStatusCode : (Number.isInteger(err?.apiStatusCode) ? err.apiStatusCode : null);
  const retryAfterMs = parseRetryAfterMs(err?.response?.headers);
  const message = String(err?.message || '').toLowerCase();
  const make = (code) => new ChatGptProviderError(code, { httpStatus, providerCode, retryAfterMs });

  if (httpStatus != null) {
    if (httpStatus === 401 || httpStatus === 403) return make(CHATGPT_ERROR.AUTH);
    if (httpStatus === 402) return make(CHATGPT_ERROR.INSUFFICIENT_CREDITS);
    if (httpStatus === 429) return make(CHATGPT_ERROR.RATE_LIMITED);
    if (httpStatus >= 500) return make(CHATGPT_ERROR.UNAVAILABLE);
    return make(CHATGPT_ERROR.REQUEST_REJECTED);
  }
  if (providerCode != null) {
    // 40201: "temporarily paused for unusual activity" - quoted in DataForSeoService.js from a real task error. The rest of the table is
    // an UNVERIFIED reading of DataForSEO's code families (401xx auth, 402xx billing, 5xxxx server side).
    if (providerCode === 40201) return make(CHATGPT_ERROR.ACCOUNT_RESTRICTED);
    if (providerCode >= 40100 && providerCode < 40200) return make(CHATGPT_ERROR.AUTH);
    if (providerCode === 40200 || /insufficient|balance|funds|credit/.test(message)) return make(CHATGPT_ERROR.INSUFFICIENT_CREDITS);
    if (providerCode === 40202 || /rate limit|too many requests/.test(message)) return make(CHATGPT_ERROR.RATE_LIMITED);
    if (providerCode >= 50000 && providerCode < 60000) return make(CHATGPT_ERROR.UNAVAILABLE);
    return make(CHATGPT_ERROR.REQUEST_REJECTED); // any other provider code: do not retry a paid request blindly
  }
  if (TIMEOUT_CODES.has(err?.code) || /timeout/.test(message)) return make(CHATGPT_ERROR.TIMEOUT);
  if (NETWORK_CODES.has(err?.code)) return make(CHATGPT_ERROR.NETWORK);
  // An axios error with no response and no known code is a connectivity failure (retryable). Anything else is not an HTTP
  // problem at all (a bug on our side): never retry a paid request for it.
  return make(err?.isAxiosError ? CHATGPT_ERROR.NETWORK : CHATGPT_ERROR.REQUEST_REJECTED);
}

/** The request body for one prompt. Pure. Country/city come from the business profile; everything else from server config. */
export function buildChatGptRequest({ prompt, market = {}, tag = 'odito-chatgpt-visibility' }, config = getChatGptConfig()) {
  const body = {
    user_prompt: prompt,
    model_name: config.model,
    web_search: config.webSearch,
    max_output_tokens: config.maxOutputTokens,
    tag: String(tag).slice(0, 255),
  };
  if (config.webSearch) {
    if (typeof market.countryCode === 'string' && /^[A-Za-z]{2}$/.test(market.countryCode)) body.web_search_country_iso_code = market.countryCode.toUpperCase();
    if (market.effectiveScope === 'local' && typeof market.city === 'string' && market.city) body.web_search_city = market.city;
  }
  return body;
}

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * Normalize a provider response to { answerText, annotations, cost, requestId, model, usage }.
 * Throws MALFORMED_RESPONSE (not retryable) when there is no task/result or no answer text.
 * `cost` is null - never 0 - when the provider did not report one; its currency is not stated by the API (see config costUnit).
 */
export function parseChatGptResponse(data) {
  const task = data?.tasks?.[0];
  const result = Array.isArray(task?.result) ? task.result[0] : null;
  if (!task || !result || typeof result !== 'object') throw new ChatGptProviderError(CHATGPT_ERROR.MALFORMED_RESPONSE);

  const texts = [];
  const annotations = [];
  const collect = (list) => {
    for (const a of Array.isArray(list) ? list : []) {
      if (a && typeof a === 'object' && typeof a.url === 'string' && a.url.trim()) {
        annotations.push({ title: typeof a.title === 'string' ? a.title.slice(0, 300) : null, url: a.url.trim().slice(0, 2000) });
      }
    }
  };
  for (const item of Array.isArray(result.items) ? result.items : []) {
    if (!item || typeof item !== 'object') continue;
    if (item.type && item.type !== 'message') continue; // e.g. reasoning / tool items are not part of the answer
    let usedSections = false;
    for (const section of Array.isArray(item.sections) ? item.sections : []) {
      if (!section || typeof section !== 'object') continue;
      if (section.type && section.type !== 'text') continue;
      if (typeof section.text === 'string' && section.text.trim()) { texts.push(section.text.trim()); usedSections = true; }
      collect(section.annotations);
    }
    if (!usedSections && typeof item.text === 'string' && item.text.trim()) texts.push(item.text.trim());
    collect(item.annotations);
  }
  const answerText = texts.join('\n\n').trim();
  if (!answerText) throw new ChatGptProviderError(CHATGPT_ERROR.MALFORMED_RESPONSE);

  return {
    answerText,
    annotations: annotations.slice(0, 200),
    // Only the task cost: result.money_spent is a different quantity (verified live), so a missing cost stays null, never a substitute.
    cost: finite(task.cost),
    requestId: typeof task.id === 'string' ? task.id : null,
    model: typeof result.model_name === 'string' ? result.model_name : null,
    usage: { inputTokens: finite(result.input_tokens), outputTokens: finite(result.output_tokens) },
  };
}

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
 * Run one prompt: concurrency-limited (per process), bounded retries for TRANSIENT failures only.
 * Never retries auth, credits, account restrictions, rejected requests or malformed responses.
 *
 * @returns {Promise<{answerText,annotations,cost,requestId,model,usage,attempts,durationMs}>}
 * @throws {ChatGptProviderError} with .attempts set to the number of requests actually sent
 */
export async function executeChatGptPrompt({ prompt, market, tag }, deps = {}) {
  const config = deps.config || getChatGptConfig();
  const send = deps.send || ((body, opts) => DataForSeoService.postChatGptLlmResponse(body, opts));
  const sleep = deps.sleep || defaultSleep;
  const random = deps.random || Math.random;
  const body = buildChatGptRequest({ prompt, market, tag }, config);

  return getLimiter(config.maxConcurrentPrompts)(async () => {
    const maxAttempts = 1 + Math.max(0, config.maxRetries);
    const started = Date.now();
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const data = await send(body, { timeoutMs: config.timeoutMs });
        const parsed = parseChatGptResponse(data);
        return { ...parsed, attempts: attempt, durationMs: Date.now() - started };
      } catch (raw) {
        const error = classifyProviderError(raw);
        error.attempts = attempt;
        lastError = error;
        if (!error.retryable || attempt >= maxAttempts) throw error;
        await sleep(computeRetryDelayMs(error, attempt, config, random));
      }
    }
    throw lastError;
  });
}

export default { executeChatGptPrompt, buildChatGptRequest, parseChatGptResponse, classifyProviderError, ChatGptProviderError, CHATGPT_ERROR };
