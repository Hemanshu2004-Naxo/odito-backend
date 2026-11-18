import OpenAI, { toFile } from 'openai';
import { PROVIDER_ERROR, RETRYABLE_PROVIDER_ERRORS, providerError } from '../../aiContent/providers/contentProviderErrors.js';
import { classifyOpenAIError } from '../../aiContent/providers/openAIContentProvider.js';
import { DESIGN_MODEL, FALLBACK_DESIGN_MODEL, DESIGN_QUALITY, DESIGN_TIMEOUT_MS, DESIGN_PROVIDER_RETRIES, MAX_PROVIDER_B64_CHARS, MAX_REFERENCE_IMAGES } from '../designConfig.js';
import { LoggerUtil } from '../../../../../utils/LoggerUtil.js';

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

/** An OpenAI message as it may be LOGGED (server-side only, never returned): keys masked, bounded. */
export const safeProviderMessage = (message) => String(message || '').replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***').replace(/Bearer\s+\S+/gi, 'Bearer ***').slice(0, 300);

/** What OpenAI said about a failed request, for the logs and the stored diagnostics (codes and status, no message text). */
export const providerDiagnostics = (raw) => ({
  status: Number.isInteger(raw?.status) ? raw.status : null,
  providerCode: typeof raw?.code === 'string' ? raw.code.slice(0, 60) : null,
  providerType: typeof raw?.type === 'string' ? raw.type.slice(0, 60) : null,
  param: typeof raw?.param === 'string' ? raw.param.slice(0, 60) : null,
});

/**
 * SDK error -> code-only error. A safety refusal is its own category (the user should change the request, not retry). A model the key
 * cannot use - retired, renamed, or not enabled for the organisation (OpenAI answers 400 "The model '...' does not exist", param "model")
 * - is a CONFIGURATION problem (MISCONFIGURED, reason model_not_found), not a generic failure. The diagnostics travel on the error for
 * logging; nothing of the provider's text does.
 */
export function classifyImageError(error) {
  if (error?.provider === 'OPENAI' && error.code) return error;
  let classified;
  const refusal = error?.status === 400 && (REFUSAL_CODES.has(error?.code) || REFUSAL_CODES.has(error?.error?.code) || /safety system/i.test(String(error?.message || '')));
  const modelMissing = (error?.status === 400 || error?.status === 404) && (error?.param === 'model' || /model .* does not exist|does not have access to model/i.test(String(error?.message || '')));
  if (refusal) classified = providerError(IMAGE_REFUSED, { status: 400 });
  else if (modelMissing) classified = providerError(PROVIDER_ERROR.MISCONFIGURED, { status: error.status, reason: 'model_not_found' });
  else classified = classifyOpenAIError(error);
  Object.defineProperty(classified, 'diagnostics', { value: providerDiagnostics(error), enumerable: false });
  return classified;
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

/**
 * Dated snapshots pinned at boot (imageModelCheck): when the models list shows "gpt-image-2.6-flare-2026-12-01" for the configured
 * "gpt-image-2.6-flare", requests use the snapshot, so a silent upgrade of the alias cannot change the look of the designs.
 */
const pinnedSnapshots = new Map();
export function pinImageModelSnapshot(alias, snapshot) { if (alias && snapshot) pinnedSnapshots.set(alias, snapshot); else if (alias) pinnedSnapshots.delete(alias); }
export const pinnedSnapshotFor = (alias) => pinnedSnapshots.get(alias) || null;

/** Errors that the FALLBACK model may answer instead: the model is not available, or the provider failed (5xx). Never a refusal. */
export const fallbackAllowedFor = (error) => error?.reason === 'model_not_found' || error?.code === PROVIDER_ERROR.UNAVAILABLE;

export class OpenAIImageProvider {
  /**
   * @param {object} [options]  all optional; defaults come from designConfig + the environment
   * @param {string} [options.apiKey] @param {string} [options.model] @param {string} [options.quality]
   * @param {number} [options.timeoutMs] @param {number} [options.retries]
   * @param {(apiKey:string)=>object} [options.clientFactory]  builds the SDK client (tests inject a stubbed fetch)
   * @param {(ms:number)=>Promise<void>} [options.sleep]
   */
  constructor({ apiKey, model, fallbackModel, quality, timeoutMs, retries, clientFactory, sleep } = {}) {
    this._apiKey = apiKey;
    this._model = model;
    this._fallbackModel = fallbackModel;
    this._quality = quality;
    this._timeoutMs = timeoutMs;
    this._retries = retries;
    this._sleep = sleep || defaultSleep;
    this._clientFactory = clientFactory || ((key) => new OpenAI({ apiKey: key, timeout: this.timeoutMs, maxRetries: 0 }));
    this._client = null;
    this._clientKey = null;
  }

  get model() { return this._model || DESIGN_MODEL; }
  /** The id actually requested: the pinned dated snapshot of the configured model when there is one. */
  get requestModel() { return pinnedSnapshotFor(this.model) || this.model; }
  get fallbackModel() { const f = this._fallbackModel === undefined ? FALLBACK_DESIGN_MODEL : this._fallbackModel; return f && f !== this.model ? f : null; }
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

  /**
   * One image. The configured model first (its pinned snapshot when there is one); when it is NOT AVAILABLE or the provider fails (5xx)
   * after the retries, the fallback model once - logged as a warning. A refusal or any other failure is never answered by the fallback.
   * `quality` overrides the configured quality for this call (low previews, medium finals).
   * Returns { buffer, usage: { inputTokens, outputTokens, textInputTokens, imageInputTokens, imageOutputTokens }, model, modelReturned,
   * fallbackUsed, quality, size, durationMs, attempts }.
   */
  async generateImage({ prompt, size, referenceImages = [], quality = null }) {
    try {
      return await this._generateWith(this.requestModel, { prompt, size, referenceImages, quality });
    } catch (error) {
      const fallback = this.fallbackModel;
      if (!fallback || !fallbackAllowedFor(error)) throw error;
      LoggerUtil.warn('[SOCIAL_AI_DESIGN] image_model_fallback_used', { event: 'image_model_fallback_used', model: this.requestModel, fallbackModel: fallback, failureCode: error.code, reason: error.reason || null, ...(error.diagnostics || {}) });
      const result = await this._generateWith(fallback, { prompt, size, referenceImages, quality });
      return { ...result, fallbackUsed: true, fallbackFrom: this.requestModel };
    }
  }

  async _generateWith(model, { prompt, size, referenceImages = [], quality = null }) {
    const client = this._getClient();
    const q = quality || this.quality;
    const references = (Array.isArray(referenceImages) ? referenceImages : []).filter((r) => Buffer.isBuffer(r?.buffer) && r.buffer.length).slice(0, MAX_REFERENCE_IMAGES);
    const request = { model, prompt, size, quality: q, n: 1, output_format: 'jpeg', moderation: 'auto' };
    // editing from reference photos (a real product, or a carousel's hook slide): the same model and options, plus the files
    const editRequest = references.length
      ? {
        model, prompt, size, quality: q, n: 1, output_format: 'jpeg',
        image: await Promise.all(references.map((r, i) => toFile(r.buffer, `reference-${i + 1}.${/png/.test(r.mimeType || '') ? 'png' : 'jpg'}`, { type: r.mimeType || 'image/jpeg' }))),
        ...(/^gpt-image-1$/.test(model) ? { input_fidelity: 'high' } : {}),
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
        const u = response?.usage || {};
        return {
          buffer: extractImage(response),
          usage: {
            inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0,
            textInputTokens: u.input_tokens_details?.text_tokens ?? (u.input_tokens || 0), imageInputTokens: u.input_tokens_details?.image_tokens || 0,
            imageOutputTokens: u.output_tokens_details?.image_tokens ?? (u.output_tokens || 0),
          },
          // the id requested, and the one the response names (if it names one): recorded so a change of style can be traced
          model, modelReturned: typeof response?.model === 'string' ? response.model : null, fallbackUsed: false,
          quality: q, size, references: references.length,
          durationMs: Date.now() - started,
          attempts: attempt,
        };
      } catch (raw) {
        const error = classifyImageError(raw);
        lastError = error;
        // every failed image request is logged with what is needed to act on it (server-side only; the user sees a plain message)
        LoggerUtil.error('[SOCIAL_AI_DESIGN] image_request_failed', {
          event: 'image_request_failed', provider: 'openai', model, quality: q, size, promptLength: String(prompt || '').length,
          references: references.length, attempt, maxAttempts, durationMs: Date.now() - started, failureCode: error.code, reason: error.reason || null,
          ...error.diagnostics, message: safeProviderMessage(raw?.message),
          ...(error.reason === 'model_not_found' ? { hint: `Set SOCIAL_AI_DESIGN_MODEL to an image model this key can use (current: ${model}).` } : {}),
        });
        if (!RETRYABLE_PROVIDER_ERRORS.has(error.code) || attempt >= maxAttempts) throw error;
        await this._sleep(retryDelayMs(raw, attempt));
      }
    }
    throw lastError || providerError(PROVIDER_ERROR.FAILED);
  }
}

export default OpenAIImageProvider;
