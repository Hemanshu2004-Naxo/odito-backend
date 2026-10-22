/**
 * ClaudeCampaignEditProvider — the ONLY code in Phase 4 that talks to the
 * Anthropic API for conversational campaign editing.
 *
 * Sibling of providers/claudeCampaignProvider.js (Phase 2) — same HTTP
 * conventions (env keys, `anthropic-version` header, AbortController
 * timeout, the same family of CLAUDE_* error codes, the undici TCP
 * keep-alive workaround), a SEPARATE purpose-built provider for a
 * different tool/output shape (proposed changes, not a whole campaign).
 * Not a second generic AI abstraction, and not a second Anthropic client
 * (still exactly one `fetch` target: api.anthropic.com) — just a second,
 * small, independently-testable provider class, the same relationship
 * Phase 2's provider already has to modules/recommendations/service/
 * claudeService.js. Deliberately does not import from or modify
 * claudeCampaignProvider.js, so Phase 2's tested provider is untouched.
 *
 * Structured output: an Anthropic tool (propose_campaign_changes) with a
 * forced tool_choice; isolated text-block JSON fallback. The caller
 * (campaignProposalService) ALWAYS re-validates the result with
 * proposalValidator — a tool_use result is never trusted just because it
 * is JSON.
 */

import { setGlobalDispatcher, Agent } from 'undici';
import { CLAUDE_API_URL, ANTHROPIC_VERSION } from '../constants/generationConfig.js';
import {
  CLAUDE_EDIT_MODEL,
  EDIT_TIMEOUT_MS,
  EDIT_MAX_OUTPUT_TOKENS,
  EDIT_MAX_RETRIES,
  EDIT_RETRY_BASE_MS,
} from '../constants/editingConfig.js';
import { EDIT_TOOL_NAME, buildProposalToolSchema } from '../prompts/proposalOutputSchema.js';

// Same rationale as claudeCampaignProvider.js: prevents NAT/firewall
// devices from silently dropping the long-idle TCP connection while Claude
// generates. Setting this again here is idempotent (last write wins) and
// harmless if Phase 2's provider already set it.
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

export class ClaudeCampaignEditProvider {
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
    const base = EDIT_RETRY_BASE_MS * 2 ** (attempt - 1);
    const jitter = Math.floor(Math.random() * 400);
    switch (error?.code) {
      case 'CLAUDE_TIMEOUT': return base + jitter;
      case 'CLAUDE_OVERLOADED': return Math.max(8_000, base) + jitter;
      case 'CLAUDE_RATE_LIMITED': return (error.retryAfter || 30) * 1000;
      case 'CLAUDE_NETWORK_ERROR': return 1_000 + jitter;
      // Never retried: CLAUDE_AUTH, CLAUDE_NOT_CONFIGURED, CLAUDE_BAD_OUTPUT,
      // CLAUDE_HTTP_4xx (invalid request) — same policy as Phase 2 (spec §31:
      // no retry for invalid instruction / auth / malformed output).
      default: return null;
    }
  }

  /**
   * Propose changes to a campaign from a system + user prompt.
   * @param {object} args
   * @param {string} args.system
   * @param {string} args.user
   * @param {string} [args.generationId]
   * @returns {Promise<{parsed:object, usage:object, model:string, stopReason:string, durationMs:number, attempts:number}>}
   */
  async proposeChanges({ system, user, generationId = null }) {
    if (!this.isAvailable()) throw providerError('CLAUDE_NOT_CONFIGURED');

    let attempt = 0;
    let lastError = null;
    while (attempt < 1 + EDIT_MAX_RETRIES) {
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
          model: data.model || CLAUDE_EDIT_MODEL,
          stopReason: data.stop_reason || null,
          durationMs: Date.now() - started,
          attempts: attempt,
        };
      } catch (error) {
        lastError = error;
        const delay = this.retryDelayFor(error, attempt);
        if (delay == null || attempt >= 1 + EDIT_MAX_RETRIES) throw error;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastError || providerError('CLAUDE_BAD_OUTPUT');
  }

  /** @private */
  async _callApi({ system, user, generationId, attempt }) {
    const apiKey = this._getApiKey();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), EDIT_TIMEOUT_MS);
    const started = Date.now();

    const body = JSON.stringify({
      model: CLAUDE_EDIT_MODEL,
      max_tokens: EDIT_MAX_OUTPUT_TOKENS,
      system,
      messages: [{ role: 'user', content: user }],
      tools: [{
        name: EDIT_TOOL_NAME,
        description: 'Emit the proposed campaign changes. Call this exactly once.',
        input_schema: buildProposalToolSchema(),
      }],
      tool_choice: { type: 'tool', name: EDIT_TOOL_NAME },
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
        `[AI_CAMPAIGN][claude-edit] ok | genId=${generationId || 'n/a'} | attempt=${attempt}` +
        ` | model=${data.model || CLAUDE_EDIT_MODEL} | stop=${data.stop_reason}` +
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
        throw providerError('CLAUDE_TIMEOUT', { timeoutMs: EDIT_TIMEOUT_MS });
      }
      throw providerError('CLAUDE_NETWORK_ERROR', {
        networkCode: error.cause?.code || error.cause?.constructor?.name || error.name || 'unknown',
      });
    }
  }

  /** @private Primary: forced tool_use input. Fallback: JSON in a text block. */
  _extractStructuredOutput(data) {
    const blocks = Array.isArray(data?.content) ? data.content : [];

    const toolUse = blocks.find((b) => b.type === 'tool_use' && b.name === EDIT_TOOL_NAME);
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

export default new ClaudeCampaignEditProvider();
