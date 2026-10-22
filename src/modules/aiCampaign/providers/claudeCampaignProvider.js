/**
 * ClaudeCampaignProvider — the ONLY code in Phase 2 that talks to the
 * Anthropic API.
 *
 * Deliberately mirrors the battle-tested HTTP conventions of the existing
 * recommendations Claude integration (src/modules/recommendations/service/
 * claudeService.js): same env keys, same `anthropic-version` header, same
 * AbortController timeout, the same family of machine-readable error codes,
 * the same undici TCP keep-alive workaround. It is a SEPARATE, purpose-built
 * provider (campaign generation ≠ recommendation generation) — not a second
 * generic AI abstraction, and it imports nothing from the recommendations
 * module.
 *
 * Structured output (spec §11): primary path is an Anthropic *tool* with a
 * JSON `input_schema` and forced `tool_choice`; the model replies with a
 * `tool_use` block whose `input` is schema-shaped. Isolated fallback: parse
 * a text block as JSON. The caller ALWAYS re-validates the object with
 * campaignStructureValidator — a tool_use result is never trusted just
 * because it is JSON.
 *
 * This class exposes the provider INTERFACE the generation service depends
 * on (`isAvailable`, `generateCampaign`). MockClaudeCampaignProvider
 * implements the same interface for tests.
 */

import { setGlobalDispatcher, Agent } from 'undici';
import {
  CLAUDE_API_URL,
  ANTHROPIC_VERSION,
  CLAUDE_CAMPAIGN_MODEL,
  GENERATION_TIMEOUT_MS,
  GENERATION_MAX_OUTPUT_TOKENS,
  GENERATION_MAX_RETRIES,
  GENERATION_RETRY_BASE_MS,
} from '../constants/generationConfig.js';
import { TOOL_NAME, buildCampaignToolSchema } from '../prompts/campaignOutputSchema.js';

// Same rationale as recommendations/claudeService.js: Claude holds the TCP
// connection open with no bytes flowing for 20-70s while generating, and
// NAT/firewalls silently drop idle sessions. TCP keep-alive probes prevent
// the "fetch failed / ECONNRESET" that would otherwise look like a timeout.
setGlobalDispatcher(new Agent({
  connect: { keepAlive: true, keepAliveInitialDelay: 10_000, keepAliveMaxFailureCount: 3 },
}));

/** Error whose `.message` is a machine-readable code; `.code` mirrors it. */
function providerError(code, extra = {}) {
  const err = new Error(code);
  err.code = code;
  err.provider = 'CLAUDE';
  Object.assign(err, extra);
  return err;
}

export class ClaudeCampaignProvider {
  constructor() {
    // Do NOT read env at construction — the module singleton is created at
    // import time, possibly before dotenv finishes.
    this._apiKey = null;
    this._keyChecked = false;
  }

  _getApiKey() {
    if (!this._keyChecked) {
      this._apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || null;
      this._keyChecked = true;
    }
    return this._apiKey;
  }

  /** @returns {boolean} whether an API key is configured. */
  isAvailable() {
    return !!this._getApiKey();
  }

  /**
   * Decide whether/when to retry a failed attempt.
   * @returns {number|null} delay in ms, or null = do not retry.
   */
  retryDelayFor(error, attempt) {
    const base = GENERATION_RETRY_BASE_MS * 2 ** (attempt - 1);
    const jitter = Math.floor(Math.random() * 400);
    switch (error?.code) {
      case 'CLAUDE_TIMEOUT': return base + jitter;
      case 'CLAUDE_OVERLOADED': return Math.max(8_000, base) + jitter;
      case 'CLAUDE_RATE_LIMITED': return ((error.retryAfter || 30) * 1000);
      case 'CLAUDE_NETWORK_ERROR': return 1_000 + jitter;
      // Never retried: CLAUDE_AUTH, CLAUDE_NOT_CONFIGURED, CLAUDE_BAD_OUTPUT,
      // CLAUDE_HTTP_4xx (invalid request), and any structure-validation
      // failure (which happens in the service, not here).
      default: return null;
    }
  }

  /**
   * Generate a campaign object from a prepared system + user prompt.
   *
   * @param {object} args
   * @param {string} args.system  fixed system prompt (no user data)
   * @param {string} args.user    user message with delimited brief/context
   * @param {string} [args.generationId]  correlation id for logs
   * @returns {Promise<{parsed:object, usage:{inputTokens:number,outputTokens:number}, model:string, stopReason:string, durationMs:number, attempts:number}>}
   * @throws {Error} with `.code` in the CLAUDE_* family
   */
  async generateCampaign({ system, user, generationId = null }) {
    if (!this.isAvailable()) throw providerError('CLAUDE_NOT_CONFIGURED');

    let attempt = 0;
    let lastError = null;
    while (attempt < 1 + GENERATION_MAX_RETRIES) {
      attempt += 1;
      try {
        const started = Date.now();
        const data = await this._callApi({ system, user, generationId, attempt });
        const parsed = this._extractStructuredOutput(data);
        return {
          parsed,
          usage: {
            inputTokens: data.usage?.input_tokens || 0,
            outputTokens: data.usage?.output_tokens || 0,
          },
          model: data.model || CLAUDE_CAMPAIGN_MODEL,
          stopReason: data.stop_reason || null,
          durationMs: Date.now() - started,
          attempts: attempt,
        };
      } catch (error) {
        lastError = error;
        const delay = this.retryDelayFor(error, attempt);
        if (delay == null || attempt >= 1 + GENERATION_MAX_RETRIES) throw error;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastError || providerError('CLAUDE_BAD_OUTPUT');
  }

  /** @private single HTTP round-trip with timeout + classified errors. */
  async _callApi({ system, user, generationId, attempt }) {
    const apiKey = this._getApiKey();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS);
    const started = Date.now();

    const body = JSON.stringify({
      model: CLAUDE_CAMPAIGN_MODEL,
      max_tokens: GENERATION_MAX_OUTPUT_TOKENS,
      system,
      messages: [{ role: 'user', content: user }],
      tools: [{
        name: TOOL_NAME,
        description: 'Emit the generated Odito campaign draft. Call this exactly once.',
        input_schema: buildCampaignToolSchema(),
      }],
      tool_choice: { type: 'tool', name: TOOL_NAME },
    });

    try {
      const res = await fetch(CLAUDE_API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const durationMs = Date.now() - started;

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        if (res.status === 429) {
          throw providerError('CLAUDE_RATE_LIMITED', {
            retryAfter: parseInt(res.headers.get('retry-after') || '30', 10),
            httpStatus: 429,
          });
        }
        if (res.status === 529) throw providerError('CLAUDE_OVERLOADED', { httpStatus: 529 });
        if (res.status === 401 || res.status === 403) {
          throw providerError('CLAUDE_AUTH', { httpStatus: res.status });
        }
        throw providerError(`CLAUDE_HTTP_${res.status}`, {
          httpStatus: res.status,
          // truncated, never surfaced to the client
          bodySnippet: errBody.slice(0, 300),
        });
      }

      const data = await res.json();
      // eslint-disable-next-line no-console
      console.log(
        `[AI_CAMPAIGN][claude] ok | genId=${generationId || 'n/a'} | attempt=${attempt}` +
        ` | model=${data.model || CLAUDE_CAMPAIGN_MODEL} | stop=${data.stop_reason}` +
        ` | inTok=${data.usage?.input_tokens || 0} | outTok=${data.usage?.output_tokens || 0}` +
        ` | durationMs=${durationMs}`,
      );
      if (data.stop_reason === 'max_tokens') {
        throw providerError('CLAUDE_BAD_OUTPUT', { reason: 'max_tokens_truncated' });
      }
      return data;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.code && String(error.code).startsWith('CLAUDE_')) throw error;
      if (error.name === 'AbortError') {
        throw providerError('CLAUDE_TIMEOUT', { timeoutMs: GENERATION_TIMEOUT_MS });
      }
      throw providerError('CLAUDE_NETWORK_ERROR', {
        networkCode: error.cause?.code || error.cause?.constructor?.name || error.name || 'unknown',
      });
    }
  }

  /**
   * @private Pull the campaign object out of the response.
   * Primary: the forced tool_use block's `input`.
   * Fallback (isolated): a text block that parses as JSON.
   */
  _extractStructuredOutput(data) {
    const blocks = Array.isArray(data?.content) ? data.content : [];

    const toolUse = blocks.find((b) => b.type === 'tool_use' && b.name === TOOL_NAME);
    if (toolUse && toolUse.input && typeof toolUse.input === 'object') {
      return toolUse.input;
    }

    const textBlock = blocks.find((b) => b.type === 'text' && typeof b.text === 'string');
    if (textBlock) {
      let text = textBlock.text.trim();
      if (text.startsWith('```')) {
        text = text.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
      }
      try {
        return JSON.parse(text);
      } catch {
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
          try { return JSON.parse(match[0]); } catch { /* fall through */ }
        }
      }
    }

    throw providerError('CLAUDE_BAD_OUTPUT', { reason: 'no_structured_output' });
  }
}

export default new ClaudeCampaignProvider();
