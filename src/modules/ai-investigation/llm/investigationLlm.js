/**
 * investigationLlm — thin adapter over the EXISTING Claude provider (recommendations/service/claudeService.js).
 * No second client, no second key handling. Tests inject a fake with the same `complete()` shape.
 *
 * Error codes are normalised to the engine's own vocabulary so the orchestrator never depends on provider details.
 */

import claudeService from '../../recommendations/service/claudeService.js';

export const LLM_ERROR = Object.freeze({
  NOT_CONFIGURED: 'LLM_NOT_CONFIGURED',
  TIMEOUT: 'LLM_TIMEOUT',
  RATE_LIMITED: 'LLM_RATE_LIMITED',
  OVERLOADED: 'LLM_OVERLOADED',
  TRUNCATED: 'LLM_TRUNCATED',
  PROVIDER: 'LLM_PROVIDER_ERROR',
  EMPTY: 'LLM_EMPTY_RESPONSE',
});

const RETRYABLE = new Set([LLM_ERROR.TIMEOUT, LLM_ERROR.OVERLOADED, LLM_ERROR.RATE_LIMITED]);
export const isRetryableLlmError = (code) => RETRYABLE.has(code);

export class LlmError extends Error {
  constructor(code, message, extra = {}) { super(message); this.name = 'LlmError'; this.code = code; Object.assign(this, extra); }
}

const MAX_TOKENS = Number(process.env.INVESTIGATION_MAX_OUTPUT_TOKENS ?? 6000);
export const MAX_TOKENS_CEILING = Number(process.env.INVESTIGATION_MAX_OUTPUT_TOKENS_CEILING ?? 9000);

export const claudeInvestigationLlm = {
  isAvailable: () => claudeService.isAvailable(),

  /** @returns {Promise<{ text: string, model: string|null, tokens: { input: number, output: number } }>} */
  async complete({ system, user, maxTokens = MAX_TOKENS }) {
    if (!claudeService.isAvailable()) throw new LlmError(LLM_ERROR.NOT_CONFIGURED, 'The AI provider is not configured.');
    try {
      const response = await claudeService._callAPI(user, maxTokens, `inv-${Date.now().toString(36)}`, { system });
      const block = (response.content || []).find((c) => c.type === 'text');
      if (!block?.text) throw new LlmError(LLM_ERROR.EMPTY, 'The AI provider returned no text.');
      if (response.stop_reason === 'max_tokens') throw new LlmError(LLM_ERROR.TRUNCATED, 'The AI answer was cut off.');
      return { text: block.text, model: response.model || null, tokens: { input: response.usage?.input_tokens || 0, output: response.usage?.output_tokens || 0 } };
    } catch (error) {
      if (error instanceof LlmError) throw error;
      const map = { CLAUDE_TIMEOUT: LLM_ERROR.TIMEOUT, CLAUDE_RATE_LIMITED: LLM_ERROR.RATE_LIMITED, CLAUDE_OVERLOADED: LLM_ERROR.OVERLOADED };
      const code = map[error.claudeErrorCode] || LLM_ERROR.PROVIDER;
      // The provider message can include request details; expose only a generic message.
      throw new LlmError(code, code === LLM_ERROR.PROVIDER ? 'The AI provider returned an error.' : `The AI provider reported: ${code}.`, { retryAfter: error.retryAfter });
    }
  },
};

export default claudeInvestigationLlm;
