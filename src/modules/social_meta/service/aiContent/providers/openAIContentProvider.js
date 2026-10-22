import OpenAI from 'openai';
import { PROVIDER_ERROR, RETRYABLE_PROVIDER_ERRORS, providerError } from './contentProviderErrors.js';
import { CONTENT_MODEL, CONTENT_MAX_OUTPUT_TOKENS, CONTENT_TIMEOUT_MS, CONTENT_PROVIDER_RETRIES } from '../contentConfig.js';
import { CONTENT_TOOL_NAME, buildContentToolSchema } from '../contentOutputSchema.js';

/**
 * OpenAIContentProvider - the ONLY place that talks to OpenAI for single-post generation.
 *
 * Contract (what socialContentGenerationService depends on - nothing OpenAI-specific):
 *   isAvailable(): boolean
 *   generateContent({ system, user }) -> { parsed, usage:{inputTokens,outputTokens}, model, durationMs, attempts }
 *
 * What it does: one call to the Responses API with Structured Outputs (a strict JSON schema derived from
 * the SAME contentOutputSchema the server validates with), `store:false` (the request is not retained by
 * OpenAI for later retrieval), a hard timeout and at most `retries` extra attempts for transient failures.
 * What it never does: validate business rules (the service does - the server stays authoritative), trust the
 * output, log a prompt or key, or throw an SDK error outward (those can echo the key; every failure leaves
 * as a code-only error from contentProviderErrors.js).
 *
 * The API key is read from OPENAI_POST_API_KEY (fallback OPENAI_API_KEY) at call time on the server. It is only ever handed to the SDK,
 * which sends it in the Authorization header. It is never part of a request body, a log line or an error.
 */

// Structured Outputs (strict) supports a subset of JSON Schema. Length / pattern / format keywords are
// outside it, so they are removed from the model-facing copy; the server-side validator enforces them.
const UNSUPPORTED_STRICT_KEYWORDS = new Set(['minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'format', 'minimum', 'maximum', 'default']);

/** Strict-mode copy of a schema: unsupported keywords dropped; every property required; no extra properties anywhere. */
export function toStrictSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toStrictSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_STRICT_KEYWORDS.has(key)) continue;
    out[key] = key === 'properties' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toStrictSchema(v)])) : toStrictSchema(value);
  }
  if (out.type === 'object' && out.properties) {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties);
  }
  return out;
}

const RETRY_AFTER_CAP_MS = 5_000;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function retryDelayMs(error, attempt) {
  const header = error?.headers?.get?.('retry-after');
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
  return Math.min(1_000 * attempt, RETRY_AFTER_CAP_MS);
}

/** SDK error -> code-only provider error. The SDK error itself is dropped (no message, body, headers or cause). */
export function classifyOpenAIError(error) {
  if (error?.provider === 'OPENAI' && error.code) return error; // already ours
  const status = Number.isInteger(error?.status) ? error.status : null;
  const name = error?.constructor?.name;
  if (name === 'APIConnectionTimeoutError') return providerError(PROVIDER_ERROR.TIMEOUT);
  if (name === 'APIUserAbortError') return providerError(PROVIDER_ERROR.TIMEOUT);
  if (name === 'APIConnectionError') return providerError(PROVIDER_ERROR.NETWORK);
  if (status === 401 || status === 403) return providerError(PROVIDER_ERROR.AUTH, { status });
  if (status === 404) return providerError(PROVIDER_ERROR.MISCONFIGURED, { status });
  if (status === 429) return providerError(error?.code === 'insufficient_quota' || error?.type === 'insufficient_quota' ? PROVIDER_ERROR.QUOTA : PROVIDER_ERROR.RATE_LIMITED, { status });
  if (status === 408) return providerError(PROVIDER_ERROR.TIMEOUT, { status });
  if (status && status >= 500) return providerError(PROVIDER_ERROR.UNAVAILABLE, { status });
  if (status && status >= 400) return providerError(PROVIDER_ERROR.FAILED, { status });
  return providerError(PROVIDER_ERROR.FAILED);
}

/** The structured JSON the model produced, or a BAD_OUTPUT error. Anything that is not a single JSON object is refused. */
export function extractStructuredOutput(response) {
  if (!response || typeof response !== 'object') throw providerError(PROVIDER_ERROR.BAD_OUTPUT, { reason: 'empty_response' });
  if (response.status === 'failed' || response.error) throw providerError(PROVIDER_ERROR.UNAVAILABLE, { reason: 'response_failed' });
  if (response.status === 'incomplete') throw providerError(PROVIDER_ERROR.BAD_OUTPUT, { reason: response.incomplete_details?.reason || 'incomplete' });
  const parts = (Array.isArray(response.output) ? response.output : []).flatMap((item) => (Array.isArray(item?.content) ? item.content : []));
  if (parts.some((p) => p?.type === 'refusal')) throw providerError(PROVIDER_ERROR.BAD_OUTPUT, { reason: 'refusal' });
  const text = typeof response.output_text === 'string' ? response.output_text : parts.filter((p) => p?.type === 'output_text').map((p) => p.text).join('');
  if (!text || !text.trim()) throw providerError(PROVIDER_ERROR.BAD_OUTPUT, { reason: 'no_text' });
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw providerError(PROVIDER_ERROR.BAD_OUTPUT, { reason: 'not_json' }); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw providerError(PROVIDER_ERROR.BAD_OUTPUT, { reason: 'not_an_object' });
  return parsed;
}

export class OpenAIContentProvider {
  /**
   * @param {object} [options]  all optional; defaults come from contentConfig + the environment
   * @param {string} [options.apiKey]            default: OPENAI_POST_API_KEY, then OPENAI_API_KEY (read per call)
   * @param {string} [options.model] @param {number} [options.maxOutputTokens] @param {number} [options.timeoutMs] @param {number} [options.retries]
   * @param {(apiKey:string)=>object} [options.clientFactory]  builds the SDK client (tests inject a fake / a stubbed fetch)
   * @param {(ms:number)=>Promise<void>} [options.sleep]
   */
  constructor({ apiKey, model, maxOutputTokens, timeoutMs, retries, clientFactory, sleep } = {}) {
    this._apiKey = apiKey;
    this._model = model;
    this._maxOutputTokens = maxOutputTokens;
    this._timeoutMs = timeoutMs;
    this._retries = retries;
    this._sleep = sleep || defaultSleep;
    this._clientFactory = clientFactory || ((key) => new OpenAI({ apiKey: key, timeout: this.timeoutMs, maxRetries: 0 }));
    this._client = null;
    this._clientKey = null;
  }

  get model() { return this._model || CONTENT_MODEL; }
  get maxOutputTokens() { return this._maxOutputTokens ?? CONTENT_MAX_OUTPUT_TOKENS; }
  get timeoutMs() { return this._timeoutMs ?? CONTENT_TIMEOUT_MS; }
  get retries() { return this._retries ?? CONTENT_PROVIDER_RETRIES; }

  /** OPENAI_POST_API_KEY (dedicated to post generation) wins; OPENAI_API_KEY is the generic fallback. Blank values count as unset. */
  _key() {
    const fromEnv = [process.env.OPENAI_POST_API_KEY, process.env.OPENAI_API_KEY].map((v) => (v ?? '').trim()).find(Boolean);
    return (this._apiKey ?? fromEnv ?? '').trim();
  }

  isAvailable() { return this._key().length > 0; }

  _getClient() {
    const key = this._key();
    if (!key) throw providerError(PROVIDER_ERROR.NOT_CONFIGURED);
    if (!this._client || this._clientKey !== key) {
      this._client = this._clientFactory(key);
      this._clientKey = key;
    }
    return this._client;
  }

  async generateContent({ system, user }) {
    const client = this._getClient();
    const request = {
      model: this.model,
      instructions: system,
      input: user,
      text: {
        format: {
          type: 'json_schema',
          name: CONTENT_TOOL_NAME,
          description: 'The single social media post. Return exactly one object in this shape.',
          strict: true,
          schema: toStrictSchema(buildContentToolSchema()),
        },
      },
      max_output_tokens: this.maxOutputTokens,
      store: false,
    };

    const maxAttempts = 1 + Math.max(0, this.retries);
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const started = Date.now();
      try {
        const response = await client.responses.create(request, { timeout: this.timeoutMs, maxRetries: 0 });
        return {
          parsed: extractStructuredOutput(response),
          usage: { inputTokens: response?.usage?.input_tokens || 0, outputTokens: response?.usage?.output_tokens || 0 },
          model: response?.model || this.model,
          durationMs: Date.now() - started,
          attempts: attempt,
        };
      } catch (raw) {
        const error = classifyOpenAIError(raw);
        lastError = error;
        if (!RETRYABLE_PROVIDER_ERRORS.has(error.code) || attempt >= maxAttempts) throw error;
        await this._sleep(retryDelayMs(raw, attempt));
      }
    }
    throw lastError || providerError(PROVIDER_ERROR.FAILED);
  }
}

export default OpenAIContentProvider;
