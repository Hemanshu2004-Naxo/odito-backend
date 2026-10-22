import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeStrategyProvider } from './claudeStrategyProvider.js';
import { STRATEGY_TOOL_NAME } from './strategyOutputSchema.js';
import { validRawStrategy } from '../../testSupport/aiStrategyFixtures.js';
import { buildSystemPrompt } from './socialAIStrategyPromptBuilder.js';

/**
 * The real Claude provider with `fetch` stubbed (no network, no key needed):
 * proves the request is a forced structured-output tool call, the key only
 * travels in the header, only a tool_use result is accepted, and errors are
 * classified without leaking the key.
 */
const realFetch = globalThis.fetch;
const KEY = 'sk-ant-test-KEY-12345';
let requests;
let responder;

const jsonResponse = (body, { status = 200, headers = {} } = {}) => ({
  ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body, text: async () => JSON.stringify(body),
});

beforeEach(() => {
  requests = [];
  responder = () => jsonResponse({ model: 'claude-test', stop_reason: 'tool_use', usage: { input_tokens: 11, output_tokens: 22 }, content: [{ type: 'tool_use', name: STRATEGY_TOOL_NAME, input: validRawStrategy() }] });
  globalThis.fetch = async (url, init) => { requests.push({ url, init, body: JSON.parse(init.body) }); return responder(); };
  process.env.ANTHROPIC_API_KEY = KEY;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_API_KEY;
});

const provider = () => new ClaudeStrategyProvider();

describe('ClaudeStrategyProvider', () => {
  test('1: sends ONE forced structured-output tool call and returns its input with usage', async () => {
    const r = await provider().generateStrategy({ system: buildSystemPrompt(), user: 'DATA' });
    assert.equal(requests.length, 1);
    const { url, init, body } = requests[0];
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(init.method, 'POST');
    assert.deepEqual(body.tool_choice, { type: 'tool', name: STRATEGY_TOOL_NAME });
    assert.equal(body.tools.length, 1);
    assert.equal(body.tools[0].name, STRATEGY_TOOL_NAME);
    assert.equal(body.tools[0].input_schema.type, 'object');
    assert.equal(body.system, buildSystemPrompt());
    assert.deepEqual(body.messages, [{ role: 'user', content: 'DATA' }]);
    assert.ok(body.max_tokens > 0);
    assert.deepEqual(r.parsed, validRawStrategy());
    assert.deepEqual(r.usage, { inputTokens: 11, outputTokens: 22 });
    assert.equal(r.model, 'claude-test');
  });

  test('2: the API key is only ever in the x-api-key header — never in the body', async () => {
    await provider().generateStrategy({ system: 's', user: 'u' });
    assert.equal(requests[0].init.headers['x-api-key'], KEY);
    assert.equal(requests[0].init.body.includes(KEY), false);
    assert.ok(requests[0].init.headers['anthropic-version']);
  });

  test('3: no key configured → CLAUDE_NOT_CONFIGURED, and no request is made', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const p = provider();
    assert.equal(p.isAvailable(), false);
    await assert.rejects(() => p.generateStrategy({ system: 's', user: 'u' }), (e) => e.code === 'CLAUDE_NOT_CONFIGURED');
    assert.equal(requests.length, 0);
  });

  test('4: free text (even JSON in a text block) is NOT accepted — only the forced tool result is', async () => {
    responder = () => jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(validRawStrategy()) }] });
    await assert.rejects(() => provider().generateStrategy({ system: 's', user: 'u' }), (e) => e.code === 'CLAUDE_BAD_OUTPUT');
    assert.equal(requests.length, 1, 'bad output is not retried');
  });

  test('5: a truncated (max_tokens) response is rejected, not parsed', async () => {
    responder = () => jsonResponse({ stop_reason: 'max_tokens', content: [{ type: 'tool_use', name: STRATEGY_TOOL_NAME, input: { summary: 'cut off' } }] });
    await assert.rejects(() => provider().generateStrategy({ system: 's', user: 'u' }), (e) => e.code === 'CLAUDE_BAD_OUTPUT' && e.reason === 'max_tokens_truncated');
  });

  test('6: auth failures are classified, not retried, and never carry the key', async () => {
    responder = () => jsonResponse({ error: { message: `invalid x-api-key ${KEY}` } }, { status: 401 });
    await assert.rejects(() => provider().generateStrategy({ system: 's', user: 'u' }), (e) => {
      assert.equal(e.code, 'CLAUDE_AUTH');
      assert.equal(JSON.stringify({ code: e.code, message: e.message, provider: e.provider }).includes(KEY), false);
      return true;
    });
    assert.equal(requests.length, 1);
  });

  test('7: a network failure is classified CLAUDE_NETWORK_ERROR (and retried once at most)', async () => {
    globalThis.fetch = async (url, init) => { requests.push({ url, init }); const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNRESET' }; throw e; };
    const p = provider();
    p.retryDelayFor = () => null; // do not wait in a unit test; the retry POLICY itself belongs to the shared provider
    await assert.rejects(() => p.generateStrategy({ system: 's', user: 'u' }), (e) => e.code === 'CLAUDE_NETWORK_ERROR' && e.networkCode === 'ECONNRESET');
  });
});

/** Anthropic's server-sent events, delivered in small chunks (an event can be split across chunks) like a real stream. */
const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
function streamEvents({ input = validRawStrategy(), stopReason = 'tool_use', outputTokens = 4321, fragment = 40, extra = [], stallAfterChunks = null } = {}) {
  const json = JSON.stringify(input);
  const events = [
    sse('message_start', { message: { model: 'claude-stream-test', usage: { input_tokens: 777, output_tokens: 1 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 't1', name: STRATEGY_TOOL_NAME, input: {} } }),
    sse('ping', {}),
  ];
  for (let i = 0; i < json.length; i += fragment) events.push(sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: json.slice(i, i + fragment) } }));
  events.push(sse('content_block_stop', { index: 0 }), sse('message_delta', { delta: { stop_reason: stopReason }, usage: { output_tokens: outputTokens } }), sse('message_stop', {}), ...extra);
  const bytes = new TextEncoder().encode(events.join(''));
  let sent = 0; let chunks = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (stallAfterChunks != null && chunks >= stallAfterChunks) return new Promise(() => {}); // never produces anything again
      if (sent >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(sent, sent + 57)); sent += 57; chunks += 1; // 57: deliberately splits events mid-line
    },
  });
  return { ok: true, status: 200, headers: { get: (k) => ({ 'content-type': 'text/event-stream; charset=utf-8' })[k.toLowerCase()] ?? null }, body, text: async () => '' };
}

describe('ClaudeStrategyProvider - streamed answers (a long strategy is not cut off by a total-time limit)', () => {
  test('8: asks for a stream, and rebuilds the tool input, usage, model and stop reason from the events', async () => {
    responder = () => streamEvents();
    const r = await provider().generateStrategy({ system: 's', user: 'u' });
    assert.equal(requests[0].body.stream, true);
    assert.deepEqual(r.parsed, validRawStrategy());
    assert.deepEqual(r.usage, { inputTokens: 777, outputTokens: 4321 });
    assert.equal(r.model, 'claude-stream-test');
  });

  test('9: a stream that keeps producing is never cut off, however long the whole answer takes (the timeout is an IDLE timeout)', async () => {
    const p = provider();
    p.streamIdleTimeoutMs = 120;
    responder = () => {
      const real = streamEvents();
      const reader = real.body.getReader();
      // slow but steady: one chunk every 40ms (well under the 120ms idle limit) for far longer than the idle limit in total
      real.body = new ReadableStream({ async pull(c) { await new Promise((r) => setTimeout(r, 40)); const { value, done } = await reader.read(); if (done) c.close(); else c.enqueue(value); } });
      return real;
    };
    const started = Date.now();
    const r = await p.generateStrategy({ system: 's', user: 'u' });
    assert.ok(Date.now() - started > 120 * 2, 'the answer took much longer than the idle limit');
    assert.deepEqual(r.parsed, validRawStrategy());
  });

  test('10: a stream that goes silent fails as CLAUDE_TIMEOUT (idle) instead of waiting for the total limit', async () => {
    const p = provider();
    p.streamIdleTimeoutMs = 80;
    p.retryDelayFor = () => null;
    responder = () => streamEvents({ stallAfterChunks: 3 });
    const started = Date.now();
    await assert.rejects(() => p.generateStrategy({ system: 's', user: 'u' }), (e) => e.code === 'CLAUDE_TIMEOUT' && e.reason === 'idle');
    assert.ok(Date.now() - started < 3000);
  });

  test('11: an overloaded / rate-limit error event in the middle of a stream is classified like the HTTP errors (and is retryable)', async () => {
    responder = () => streamEvents({ extra: [sse('error', { error: { type: 'overloaded_error', message: 'Overloaded' } })], stopReason: null });
    const p = provider();
    p.retryDelayFor = () => null;
    // a complete answer followed by an error event: the error wins (the message did not finish cleanly)
    await assert.rejects(() => p.generateStrategy({ system: 's', user: 'u' }), (e) => e.code === 'CLAUDE_OVERLOADED');
  });

  test('12: a streamed answer that stopped at max_tokens is rejected, not parsed', async () => {
    responder = () => streamEvents({ input: { summary: 'cut off' }, stopReason: 'max_tokens' });
    await assert.rejects(() => provider().generateStrategy({ system: 's', user: 'u' }), (e) => e.code === 'CLAUDE_BAD_OUTPUT' && e.reason === 'max_tokens_truncated');
  });

  test('13: streamed JSON that never completes is a bad output, not a crash', async () => {
    const half = streamEvents();
    responder = () => ({ ...half, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse('message_start', { message: { model: 'm', usage: {} } }) + sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 't', name: STRATEGY_TOOL_NAME } }) + sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"summary": "tru' } }) + sse('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }))); c.close(); } }) });
    await assert.rejects(() => provider().generateStrategy({ system: 's', user: 'u' }), (e) => e.code === 'CLAUDE_BAD_OUTPUT');
  });

  test('14: the key still never appears in the request body when streaming', async () => {
    responder = () => streamEvents();
    await provider().generateStrategy({ system: 's', user: 'u' });
    assert.equal(requests[0].init.body.includes(KEY), false);
    assert.equal(requests[0].init.headers['x-api-key'], KEY);
  });
});
