import OpenAI from 'openai';
import { getPromptConfig, PROMPT_CATEGORIES } from '../config/promptConfig.js';
// Generic, provider-level helpers only (strict-schema conversion, SDK-error -> code-only error, structured-output
// extraction). Nothing social-media specific is imported.
import { toStrictSchema, classifyOpenAIError, extractStructuredOutput } from '../../../../social_meta/service/aiContent/providers/openAIContentProvider.js';
import { PROVIDER_ERROR, RETRYABLE_PROVIDER_ERRORS, providerError } from '../../../../social_meta/service/aiContent/providers/contentProviderErrors.js';

/**
 * OpenAI prompt-customization provider - the ONLY place the AI Visibility system talks to OpenAI.
 *
 * It sends one request to the Responses API with a strict JSON schema, `store:false`, a hard timeout and at most
 * `providerRetries` extra attempts for TRANSIENT failures (timeout, rate limit, 5xx, network). Authentication, quota,
 * configuration and bad-output errors are never retried. The SDK's own errors never leave this file: callers only ever
 * see a code-only error, so a key fragment in an SDK message cannot reach a log or a response.
 * The model, timeout and token ceiling come from server configuration; the model's output cannot change them.
 */

export const PROMPT_TOOL_NAME = 'ai_visibility_prompts';

export function buildPromptOutputSchema() {
  return {
    type: 'object',
    properties: {
      prompts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            category: { type: 'string', enum: [...PROMPT_CATEGORIES] },
            text: { type: 'string' },
          },
          required: ['category', 'text'],
        },
      },
    },
    required: ['prompts'],
  };
}

const RETRY_AFTER_CAP_MS = 5_000;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const retryDelayMs = (error, attempt) => {
  const seconds = Number(error?.headers?.get?.('retry-after'));
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
  return Math.min(1_000 * attempt, RETRY_AFTER_CAP_MS);
};

export class OpenAiPromptProvider {
  /**
   * @param {object} [options] all optional; defaults come from getPromptConfig()
   * @param {(apiKey:string)=>object} [options.clientFactory] builds the SDK client (tests inject a fake)
   * @param {(ms:number)=>Promise<void>} [options.sleep]
   * @param {object} [options.config] overrides getPromptConfig() (tests)
   */
  constructor({ clientFactory, sleep, config } = {}) {
    this._config = config || null;
    this._sleep = sleep || defaultSleep;
    this._clientFactory = clientFactory || ((key) => new OpenAI({ apiKey: key, timeout: this.config.timeoutMs, maxRetries: 0 }));
    this._client = null;
    this._clientKey = null;
  }

  get config() { return this._config || getPromptConfig(); }

  isAvailable() { return this.config.apiKey.length > 0; }

  _getClient() {
    const key = this.config.apiKey;
    if (!key) throw providerError(PROVIDER_ERROR.NOT_CONFIGURED);
    if (!this._client || this._clientKey !== key) {
      this._client = this._clientFactory(key);
      this._clientKey = key;
    }
    return this._client;
  }

  /**
   * @param {{system:string,user:string}} messages
   * @returns {Promise<{parsed:object,usage:{inputTokens:number,outputTokens:number},model:string,durationMs:number,attempts:number}>}
   * @throws code-only provider errors (see contentProviderErrors.js)
   */
  async customize({ system, user, output = null }) {
    const cfg = this.config;
    const client = this._getClient();
    // `output` lets another server-side caller (the question generator) reuse this guarded transport with its own strict
    // schema and token ceiling. It is only ever supplied by server code, never by a request.
    const request = {
      model: cfg.model,
      instructions: system,
      input: user,
      text: {
        format: {
          type: 'json_schema',
          name: output?.name || PROMPT_TOOL_NAME,
          description: output?.description || 'Exactly five search prompts, one per category.',
          strict: true,
          schema: toStrictSchema(output?.schema || buildPromptOutputSchema()),
        },
      },
      max_output_tokens: output?.maxOutputTokens || cfg.maxOutputTokens,
      store: false,
    };
    const maxAttempts = 1 + Math.max(0, cfg.providerRetries);
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const started = Date.now();
      try {
        const response = await client.responses.create(request, { timeout: cfg.timeoutMs, maxRetries: 0 });
        return {
          parsed: extractStructuredOutput(response),
          usage: { inputTokens: response?.usage?.input_tokens || 0, outputTokens: response?.usage?.output_tokens || 0 },
          model: response?.model || cfg.model,
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

export default OpenAiPromptProvider;
