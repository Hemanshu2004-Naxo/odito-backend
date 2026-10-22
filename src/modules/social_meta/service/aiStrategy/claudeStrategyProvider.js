/**
 * ClaudeStrategyProvider — the only code that sends Social Media AI requests
 * (AI Strategy, and single-post AI content) to Anthropic.
 *
 * It REUSES the existing Claude integration instead of adding another client:
 * it extends the AI Campaign provider for API-key handling (ANTHROPIC_API_KEY /
 * CLAUDE_API_KEY, read lazily), `isAvailable()`, the transient-failure retry
 * policy (`retryDelayFor`), the machine-readable CLAUDE_* error family and the
 * undici keep-alive dispatcher that module installs.
 *
 * What is generic here: `generateStructured({ system, user, tool, ... })` sends
 * ONE forced tool call (structured output) and returns the tool's `input`. The
 * tool (name + JSON schema), model, token budget, timeout and retry count are
 * arguments, so the strategy and the post generator share this single HTTP path.
 * `generateStrategy` is the strategy's thin wrapper.
 *
 * Structured output: a forced `tool_use` whose `input` follows the tool schema.
 * The caller still re-validates it - a tool result is never trusted because it
 * is JSON. Free text is never accepted (no JSON scraping).
 *
 * Errors carry `.code` in the CLAUDE_* family. The services map them to
 * user-safe messages; a provider body snippet is never forwarded to clients.
 */
import { ClaudeCampaignProvider } from '../../../aiCampaign/providers/claudeCampaignProvider.js';
import { CLAUDE_API_URL, ANTHROPIC_VERSION } from '../../../aiCampaign/constants/generationConfig.js';
import { STRATEGY_MODEL, STRATEGY_TIMEOUT_MS, STRATEGY_MAX_OUTPUT_TOKENS, STRATEGY_PROVIDER_RETRIES, STREAM_ENABLED, STREAM_IDLE_TIMEOUT_MS } from './strategyConfig.js';
import { STRATEGY_TOOL_NAME, buildStrategyToolSchema } from './strategyOutputSchema.js';
import { CALENDAR_MODEL, CALENDAR_MAX_OUTPUT_TOKENS, CALENDAR_TIMEOUT_MS, CALENDAR_PROVIDER_RETRIES } from '../calendar/calendarConfig.js';
import { CALENDAR_TOOL_NAME } from '../calendar/calendarOutputSchema.js';

function providerError(code, extra = {}) {
  const err = new Error(code);
  err.code = code;
  err.provider = 'CLAUDE';
  Object.assign(err, extra);
  return err;
}

export class ClaudeStrategyProvider extends ClaudeCampaignProvider {
  /**
   * @param {object} args
   * @param {string} args.system
   * @param {string} args.user
   * @param {{ name: string, description: string, schema: object }} args.tool
   * @param {string} [args.model] @param {number} [args.maxTokens] @param {number} [args.timeoutMs] @param {number} [args.retries]
   * @returns {Promise<{ parsed: object, usage: {inputTokens:number,outputTokens:number}, model: string, durationMs: number, attempts: number }>}
   */
  async generateStructured({ system, user, tool, model = STRATEGY_MODEL, maxTokens = STRATEGY_MAX_OUTPUT_TOKENS, timeoutMs = STRATEGY_TIMEOUT_MS, retries = STRATEGY_PROVIDER_RETRIES }) {
    if (!this.isAvailable()) throw providerError('CLAUDE_NOT_CONFIGURED');

    let attempt = 0;
    let lastError = null;
    while (attempt < 1 + retries) {
      attempt += 1;
      try {
        const started = Date.now();
        const data = await this._callApiFor({ system, user, tool, model, maxTokens, timeoutMs });
        return {
          parsed: this._extractToolInput(data, tool.name),
          usage: { inputTokens: data.usage?.input_tokens || 0, outputTokens: data.usage?.output_tokens || 0 },
          model: data.model || model,
          durationMs: Date.now() - started,
          attempts: attempt,
        };
      } catch (error) {
        lastError = error;
        const delay = this.retryDelayFor(error, attempt);
        if (delay == null || attempt >= 1 + retries) throw error;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastError || providerError('CLAUDE_BAD_OUTPUT');
  }

  /** The AI Strategy call: the strategy tool with the strategy budget. */
  async generateStrategy({ system, user }) {
    return this.generateStructured({
      system,
      user,
      tool: { name: STRATEGY_TOOL_NAME, description: 'Emit the structured social media strategy. Call this exactly once.', schema: buildStrategyToolSchema() },
    });
  }

  /**
   * The Content Calendar planning call: ONE batch of slots, the calendar tool (schema built by the caller for this
   * request) with the calendar budget. Same single HTTP path as the strategy; only the tool and the limits differ.
   */
  async generateCalendarPlan({ system, user, schema }) {
    return this.generateStructured({
      system,
      user,
      tool: { name: CALENDAR_TOOL_NAME, description: 'Emit the planning metadata for the requested calendar slots. Call this exactly once.', schema },
      model: CALENDAR_MODEL,
      maxTokens: CALENDAR_MAX_OUTPUT_TOKENS,
      timeoutMs: CALENDAR_TIMEOUT_MS,
      retries: CALENDAR_PROVIDER_RETRIES,
    });
  }

  /**
   * @private one HTTP round-trip with classified errors.
   *
   * The request is STREAMED: a long structured answer (thousands of tokens) takes minutes, and a plain request can only be
   * bounded by its total time - which either cuts good answers off or waits forever on a dead connection. Streamed, two
   * limits apply instead: `timeoutMs` is the ceiling for the whole call, and STREAM_IDLE_TIMEOUT_MS is how long the model
   * may go without producing ANYTHING (a hung connection fails in a minute, a slow-but-working answer is never cut off).
   * The result has the same shape a non-streamed response has, so nothing downstream changes. A response that is not an
   * event stream (a proxy, a test double) is read as plain JSON.
   */
  async _callApiFor({ system, user, tool, model, maxTokens, timeoutMs }) {
    const controller = new AbortController();
    let abortReason = 'total';
    const abort = (reason) => { abortReason = reason; controller.abort(); };
    const totalTimer = setTimeout(() => abort('total'), timeoutMs);
    let idleTimer = null;
    const armIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => abort('idle'), this.streamIdleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS); };
    const done = () => { clearTimeout(totalTimer); clearTimeout(idleTimer); };
    try {
      armIdle();
      const res = await fetch(CLAUDE_API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this._getApiKey(), 'anthropic-version': ANTHROPIC_VERSION },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          ...(STREAM_ENABLED ? { stream: true } : {}),
          system,
          messages: [{ role: 'user', content: user }],
          tools: [{ name: tool.name, description: tool.description, input_schema: tool.schema }],
          tool_choice: { type: 'tool', name: tool.name },
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        if (res.status === 429) throw providerError('CLAUDE_RATE_LIMITED', { retryAfter: parseInt(res.headers.get('retry-after') || '30', 10), httpStatus: 429 });
        if (res.status === 529) throw providerError('CLAUDE_OVERLOADED', { httpStatus: 529 });
        if (res.status === 401 || res.status === 403) throw providerError('CLAUDE_AUTH', { httpStatus: res.status });
        throw providerError(`CLAUDE_HTTP_${res.status}`, { httpStatus: res.status, bodySnippet: errBody.slice(0, 300) });
      }
      const isStream = /text\/event-stream/i.test(res.headers?.get?.('content-type') || '');
      const data = isStream ? await this._readStream(res, armIdle, controller.signal) : await res.json();
      if (data.stop_reason === 'max_tokens') throw providerError('CLAUDE_BAD_OUTPUT', { reason: 'max_tokens_truncated' });
      return data;
    } catch (error) {
      if (error.code && String(error.code).startsWith('CLAUDE_')) throw error;
      if (error.name === 'AbortError') throw providerError('CLAUDE_TIMEOUT', { timeoutMs, reason: abortReason });
      throw providerError('CLAUDE_NETWORK_ERROR', { networkCode: error.cause?.code || error.name || 'unknown' });
    } finally {
      done();
    }
  }

  /**
   * @private Reads Anthropic's server-sent events into the message a non-streamed call returns: the model, the usage, the
   * stop reason and the content blocks (a tool_use block's `input` is rebuilt from its streamed JSON fragments).
   * `onActivity` is called for every chunk received (it re-arms the idle timeout).
   */
  async _readStream(res, onActivity, signal) {
    // a body that ignores the abort signal must still not be able to hang a generation: every read races the abort
    const aborted = new Promise((_, reject) => {
      const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (signal?.aborted) fail(); else signal?.addEventListener('abort', fail, { once: true });
    });
    aborted.catch(() => {});
    const message = { model: null, usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: null, content: [] };
    const fragments = new Map();
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let buffer = '';

    const handle = (raw) => {
      const dataLine = raw.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) return;
      let event;
      try { event = JSON.parse(dataLine.slice(5).trim()); } catch { return; }
      switch (event.type) {
        case 'message_start':
          message.model = event.message?.model || null;
          message.usage.input_tokens = event.message?.usage?.input_tokens || 0;
          break;
        case 'content_block_start':
          message.content[event.index] = { ...event.content_block, ...(event.content_block?.type === 'tool_use' ? { input: {} } : {}) };
          if (event.content_block?.type === 'tool_use') fragments.set(event.index, []);
          break;
        case 'content_block_delta':
          if (event.delta?.type === 'input_json_delta') fragments.get(event.index)?.push(event.delta.partial_json || '');
          else if (event.delta?.type === 'text_delta' && message.content[event.index]) message.content[event.index].text = (message.content[event.index].text || '') + (event.delta.text || '');
          break;
        case 'message_delta':
          if (event.delta?.stop_reason) message.stop_reason = event.delta.stop_reason;
          if (event.usage?.output_tokens != null) message.usage.output_tokens = event.usage.output_tokens;
          break;
        case 'error': {
          const type = event.error?.type;
          if (type === 'overloaded_error') throw providerError('CLAUDE_OVERLOADED', { httpStatus: 529 });
          if (type === 'rate_limit_error') throw providerError('CLAUDE_RATE_LIMITED', { retryAfter: 30, httpStatus: 429 });
          throw providerError('CLAUDE_NETWORK_ERROR', { networkCode: type || 'stream_error' });
        }
        default: // ping, content_block_stop, message_stop
      }
    };

    for (;;) {
      const { value, done } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      onActivity();
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let split;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        handle(buffer.slice(0, split));
        buffer = buffer.slice(split + 2);
      }
    }
    if (buffer.trim()) handle(buffer);

    for (const [index, parts] of fragments) {
      const block = message.content[index];
      const json = parts.join('');
      if (!block) continue;
      try { block.input = json ? JSON.parse(json) : {}; } catch { block.input = null; }
    }
    message.content = message.content.filter(Boolean);
    return message;
  }

  /** @private the forced tool call's `input`; nothing else is accepted. */
  _extractToolInput(data, toolName) {
    const blocks = Array.isArray(data?.content) ? data.content : [];
    const toolUse = blocks.find((b) => b.type === 'tool_use' && b.name === toolName);
    if (toolUse && toolUse.input && typeof toolUse.input === 'object') return toolUse.input;
    throw providerError('CLAUDE_BAD_OUTPUT', { reason: 'no_structured_output' });
  }
}

export default new ClaudeStrategyProvider();
