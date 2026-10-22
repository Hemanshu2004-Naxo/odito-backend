/**
 * Test-only: OpenAI Responses API payloads and a scripted `fetch`, so the REAL OpenAIContentProvider and the REAL
 * OpenAI SDK run in tests with no network and no key. Nothing here is used at runtime.
 */
import OpenAI from 'openai';

/** A completed Responses API body whose structured output is `parsed` (an object, or a raw string to send as-is). */
export function openAIResponseBody(parsed, { model = 'gpt-test-model', inputTokens = 40, outputTokens = 90, status = 'completed', extraOutput = [] } = {}) {
  const text = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
  return {
    id: 'resp_test', object: 'response', created_at: 1_760_000_000, status, model, error: null, incomplete_details: null,
    output: [{ type: 'message', id: 'msg_test', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }, ...extraOutput],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
  };
}

export const refusalBody = () => ({
  ...openAIResponseBody('x'),
  output: [{ type: 'message', id: 'msg_r', status: 'completed', role: 'assistant', content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] }],
});

export const incompleteBody = () => ({ ...openAIResponseBody('{"cap'), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } });

/** An OpenAI-style error response. */
export const openAIErrorResponse = (status, message, { code = null, type = 'invalid_request_error', headers = {} } = {}) => new Response(
  JSON.stringify({ error: { message, type, code, param: null } }),
  { status, headers: { 'content-type': 'application/json', ...headers } },
);

export const okResponse = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/**
 * A scripted fetch. `responder(callNumber, { url, init, body })` returns a Response (or throws / returns a
 * promise). Every request is recorded in `requests` with its parsed JSON body.
 */
export function scriptedFetch(responder) {
  const requests = [];
  const fn = async (url, init = {}) => {
    const record = { url: String(url), init, headers: init.headers, body: typeof init.body === 'string' ? JSON.parse(init.body) : (init.body ?? null) }; // multipart (an image edit) is kept as the FormData it is
    requests.push(record);
    return responder(requests.length, record);
  };
  fn.requests = requests;
  return fn;
}

/** Builds the SDK client factory a provider takes, wired to a scripted fetch (no retries inside the SDK). */
export const clientFactoryFor = (fetchFn, timeoutMs = 60_000) => (apiKey) => new OpenAI({ apiKey, fetch: fetchFn, maxRetries: 0, timeout: timeoutMs });
