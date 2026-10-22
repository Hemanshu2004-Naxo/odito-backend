import OpenAI, { toFile } from 'openai';
import { PROVIDER_ERROR, RETRYABLE_PROVIDER_ERRORS, providerError } from '../../aiContent/providers/contentProviderErrors.js';
import { classifyOpenAIError } from '../../aiContent/providers/openAIContentProvider.js';
import { DESIGN_MODEL, DESIGN_QUALITY, DESIGN_TIMEOUT_MS, DESIGN_PROVIDER_RETRIES, MAX_PROVIDER_B64_CHARS, MAX_REFERENCE_IMAGES } from '../designConfig.js';

/**
 * OpenAIImageProvider - the ONLY place that talks to OpenAI for design images.
 *
 * Contract (what socialDesignGenerationService depends on - nothing OpenAI-specific):
 *   isAvailable(): boolean
 *   generateImage({ prompt, size, referenceImages? }) -> { buffer, usage:{inputTokens,outputTokens}, model, durationMs, attempts }
 *   `referenceImages` ([{ buffer, mimeType }], at most MAX_REFERENCE_IMAGES) are REAL photos the picture must be built from
 *   (a product): with them the call is the Images API's edit endpoint, without them the generate endpoint. The buffers are
 *   prepared by the media pipeline (re-encoded, metadata stripped) before they get here.
 *
 * One call to the Images API (`images.generate`, GPT Image models), n = 1, JPEG requested. GPT Image models
 * always answer with base64 image data; if a response carries only a remote URL it is REFUSED, never fetched -
 * Odito never downloads from a provider-supplied address (no SSRF surface). The decoded bytes are returned
 * untouched: the media pipeline (aiDesign/designMedia.js) is what inspects, re-encodes and stores them.
 *
 * Errors leave as code-only errors (aiContent/providers/contentProviderErrors.js) plus IMAGE_REFUSED for the
 * provider's own safety refusal; an SDK error can echo request details or part of the key, so none of its
 * text is ever forwarded. Retries are bounded and apply only to transient failures.
 *
 * The key is read per call, server-side: OPENAI_IMAGE_API_KEY -> OPENAI_POST_API_KEY -> OPENAI_API_KEY.
 */

export const IMAGE_REFUSED = 'AI_PROVIDER_IMAGE_REFUSED';

const REFUSAL_CODES = new Set(['moderation_blocked', 'content_policy_violation']);
const RETRY_AFTER_CAP_MS = 5_000;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function retryDelayMs(error, attempt) {
  const seconds = Number(error?.headers?.get?.('retry-after'));
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
  return Math.min(1_000 * attempt, RETRY_AFTER_CAP_MS);
}

/** SDK error -> code-only error. A safety refusal is its own category (the user should change the request, not retry). */
export function classifyImageError(error) {
  if (error?.provider === 'OPENAI' && error.code) return error;
  const refusal = error?.status === 400 && (REFUSAL_CODES.has(error?.code) || REFUSAL_CODES.has(error?.error?.code) || /safety system/i.test(String(error?.message || '')));
  if (refusal) return providerError(IMAGE_REFUSED, { status: 400 });
  return classifyOpenAIError(error);
}

/** The image bytes from an Images API response, or a BAD_OUTPUT error. */
export function extractImage(response) {
  const first = Array.isArray(response?.data) ? response.data[0] : null;
  if (!first || typeof first !== 'object') throw providerError(PROVIDER_ERROR.BAD_OUTPUT, { reason: 'no_image' });
  const b64 = first.b64_json;
  if (typeof b64 !== 'string' || !b64) throw providerError(PROVIDER_ERROR.BAD_OUTPUT, { reason: first.url ? 'url_only_not_fetched' : 'no_image_data' });
  if (b64.length > MAX_PROVIDER_B64_CHARS) throw providerError(PROVIDER_ERROR.BAD_OUTPUT, { reason: 'too_large' });
  const buffer = Buffer.from(b64, 'base64');
  if (!buffer.length) throw providerError(PROVIDER_ERROR.BAD_OUTPUT, { reason: 'empty_image' });
  return buffer;
}

export class OpenAIImageProvider {
  /**
   * @param {object} [options]  all optional; defaults come from designConfig + the environment
   * @param {string} [options.apiKey] @param {string} [options.model] @param {string} [options.quality]
   * @param {number} [options.timeoutMs] @param {number} [options.retries]
   * @param {(apiKey:string)=>object} [options.clientFactory]  builds the SDK client (tests inject a stubbed fetch)
   * @param {(ms:number)=>Promise<void>} [options.sleep]
   */
  constructor({ apiKey, model, quality, timeoutMs, retries, clientFactory, sleep } = {}) {
    this._apiKey = apiKey;
    this._model = model;
    this._quality = quality;
    this._timeoutMs = timeoutMs;
    this._retries = retries;
    this._sleep = sleep || defaultSleep;
    this._clientFactory = clientFactory || ((key) => new OpenAI({ apiKey: key, timeout: this.timeoutMs, maxRetries: 0 }));
    this._client = null;
    this._clientKey = null;
  }

  get model() { return this._model || DESIGN_MODEL; }
  get quality() { return this._quality || DESIGN_QUALITY; }
  get timeoutMs() { return this._timeoutMs ?? DESIGN_TIMEOUT_MS; }
  get retries() { return this._retries ?? DESIGN_PROVIDER_RETRIES; }

  _key() {
    const fromEnv = [process.env.OPENAI_IMAGE_API_KEY, process.env.OPENAI_POST_API_KEY, process.env.OPENAI_API_KEY].map((v) => (v ?? '').trim()).find(Boolean);
    return (this._apiKey ?? fromEnv ?? '').trim();
  }

  isAvailable() { return this._key().length > 0 && /^gpt-image/.test(this.model); }

  _getClient() {
    const key = this._key();
    if (!key) throw providerError(PROVIDER_ERROR.NOT_CONFIGURED);
    if (!/^gpt-image/.test(this.model)) throw providerError(PROVIDER_ERROR.MISCONFIGURED, { reason: 'unsupported_image_model' });
    if (!this._client || this._clientKey !== key) {
      this._client = this._clientFactory(key);
      this._clientKey = key;
    }
    return this._client;
  }

  async generateImage({ prompt, size, referenceImages = [] }) {
    const client = this._getClient();
    const references = (Array.isArray(referenceImages) ? referenceImages : []).filter((r) => Buffer.isBuffer(r?.buffer) && r.buffer.length).slice(0, MAX_REFERENCE_IMAGES);
    const request = { model: this.model, prompt, size, quality: this.quality, n: 1, output_format: 'jpeg', moderation: 'auto' };
    // editing from the real product photo: the same model and options, plus the files (and high input fidelity where the model supports it)
    const editRequest = references.length
      ? {
        model: this.model, prompt, size, quality: this.quality, n: 1, output_format: 'jpeg',
        image: await Promise.all(references.map((r, i) => toFile(r.buffer, `reference-${i + 1}.${/png/.test(r.mimeType || '') ? 'png' : 'jpg'}`, { type: r.mimeType || 'image/jpeg' }))),
        ...(/^gpt-image-1$/.test(this.model) ? { input_fidelity: 'high' } : {}),
      }
      : null;

    const maxAttempts = 1 + Math.max(0, this.retries);
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const started = Date.now();
      try {
        const response = editRequest
          ? await client.images.edit(editRequest, { timeout: this.timeoutMs, maxRetries: 0 })
          : await client.images.generate(request, { timeout: this.timeoutMs, maxRetries: 0 });
        return {
          buffer: extractImage(response),
          usage: { inputTokens: response?.usage?.input_tokens || 0, outputTokens: response?.usage?.output_tokens || 0 },
          model: this.model,
          durationMs: Date.now() - started,
          attempts: attempt,
        };
      } catch (raw) {
        const error = classifyImageError(raw);
        lastError = error;
        if (!RETRYABLE_PROVIDER_ERRORS.has(error.code) || attempt >= maxAttempts) throw error;
        await this._sleep(retryDelayMs(raw, attempt));
      }
    }
    throw lastError || providerError(PROVIDER_ERROR.FAILED);
  }
}

export default OpenAIImageProvider;
