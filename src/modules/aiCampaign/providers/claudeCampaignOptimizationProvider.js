/**
 * ClaudeCampaignOptimizationProvider — the ONLY code in Phase 7 that talks
 * to the Anthropic API for optimization recommendations.
 *
 * Sibling of claudeCampaignProvider.js (Phase 2) and
 * claudeCampaignEditProvider.js (Phase 4) — same HTTP conventions (env
 * keys, `anthropic-version` header, AbortController timeout, the same
 * family of CLAUDE_* error codes, the undici TCP keep-alive workaround). A
 * separate, independently-testable provider class for a different
 * tool/output shape (optimization recommendations, not a whole campaign or
 * a campaign edit). Deliberately does not import from or modify either
 * earlier provider.
 *
 * Structured output: an Anthropic tool (emit_optimization_recommendations)
 * with a forced tool_choice; isolated text-block JSON fallback. The caller
 * (campaignOptimizationService) ALWAYS re-validates the result with
 * recommendationValidator — a tool_use result is never trusted just
 * because it is JSON, and Claude never controls a trusted field (spec §16).
 */

import { setGlobalDispatcher, Agent } from 'undici';
import { CLAUDE_API_URL, ANTHROPIC_VERSION } from '../constants/generationConfig.js';
import {
  CLAUDE_OPTIMIZATION_MODEL, OPTIMIZATION_TIMEOUT_MS, OPTIMIZATION_MAX_OUTPUT_TOKENS,
  OPTIMIZATION_MAX_RETRIES, OPTIMIZATION_RETRY_BASE_MS,
} from '../constants/optimizationConfig.js';
import { OPTIMIZATION_TOOL_NAME, buildOptimizationToolSchema } from '../prompts/optimizationOutputSchema.js';

setGlobalDispatcher(new Agent({
  connect: { keepAlive: true, keepAliveInitialDelay: 10_000, keepAliveMaxFailureCount: 3 },
}));

function providerError(code, extra = {}) {
  const err = new Error(code);
  err.code = code;
  err.provider = 'CLAUDE';
  Object.assign(err, extra);
  return err;
}

export class ClaudeCampaignOptimizationProvider {
  constructor() {
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

  isAvailable() {
    return !!this._getApiKey();
  }

  retryDelayFor(error, attempt) {
    const base = OPTIMIZATION_RETRY_BASE_MS * 2 ** (attempt - 1);
    const jitter = Math.floor(Math.random() * 400);
    switch (error?.code) {
      case 'CLAUDE_TIMEOUT': return base + jitter;
      case 'CLAUDE_OVERLOADED': return Math.max(8_000, base) + jitter;
      case 'CLAUDE_RATE_LIMITED': return (error.retryAfter || 30) * 1000;
      case 'CLAUDE_NETWORK_ERROR': return 1_000 + jitter;
      default: return null; // CLAUDE_AUTH / CLAUDE_NOT_CONFIGURED / CLAUDE_BAD_OUTPUT / CLAUDE_HTTP_4xx never retried
    }
  }

  /**
   * @param {object} args
   * @param {string} args.system
   * @param {string} args.user
   * @param {string} [args.generationId]
   * @returns {Promise<{parsed:object, usage:object, model:string, stopReason:string, durationMs:number, attempts:number}>}
   */
  async generateRecommendations({ system, user, generationId = null }) {
    if (!this.isAvailable()) throw providerError('CLAUDE_NOT_CONFIGURED');

    let attempt = 0;
    let lastError = null;
    while (attempt < 1 + OPTIMIZATION_MAX_RETRIES) {
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
          model: data.model || CLAUDE_OPTIMIZATION_MODEL,
          stopReason: data.stop_reason || null,
          durationMs: Date.now() - started,
          attempts: attempt,
        };
      } catch (error) {
        lastError = error;
        const delay = this.retryDelayFor(error, attempt);
        if (delay == null || attempt >= 1 + OPTIMIZATION_MAX_RETRIES) throw error;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastError || providerError('CLAUDE_BAD_OUTPUT');
  }

  /** @private */
  async _callApi({ system, user, generationId, attempt }) {
    const apiKey = this._getApiKey();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OPTIMIZATION_TIMEOUT_MS);
    const started = Date.now();

    const body = JSON.stringify({
      model: CLAUDE_OPTIMIZATION_MODEL,
      max_tokens: OPTIMIZATION_MAX_OUTPUT_TOKENS,
      system,
      messages: [{ role: 'user', content: user }],
      tools: [{
        name: OPTIMIZATION_TOOL_NAME,
        description: 'Emit the proposed optimization recommendations. Call this exactly once.',
        input_schema: buildOptimizationToolSchema(),
      }],
      tool_choice: { type: 'tool', name: OPTIMIZATION_TOOL_NAME },
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
        throw providerError(`CLAUDE_HTTP_${res.status}`, { httpStatus: res.status, bodySnippet: errBody.slice(0, 300) });
      }

      const data = await res.json();
      // eslint-disable-next-line no-console
      console.log(
        `[AI_CAMPAIGN][claude-optimization] ok | genId=${generationId || 'n/a'} | attempt=${attempt}` +
        ` | model=${data.model || CLAUDE_OPTIMIZATION_MODEL} | stop=${data.stop_reason}` +
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
        throw providerError('CLAUDE_TIMEOUT', { timeoutMs: OPTIMIZATION_TIMEOUT_MS });
      }
      throw providerError('CLAUDE_NETWORK_ERROR', {
        networkCode: error.cause?.code || error.cause?.constructor?.name || error.name || 'unknown',
      });
    }
  }

  /** @private Primary: forced tool_use input. Fallback: JSON in a text block. */
  _extractStructuredOutput(data) {
    const blocks = Array.isArray(data?.content) ? data.content : [];

    const toolUse = blocks.find((b) => b.type === 'tool_use' && b.name === OPTIMIZATION_TOOL_NAME);
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

export default new ClaudeCampaignOptimizationProvider();
