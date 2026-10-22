import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { OpenAIContentProvider, toStrictSchema, classifyOpenAIError, extractStructuredOutput } from './openAIContentProvider.js';
import { PROVIDER_ERROR, PROVIDER_FAILURE_CODE } from './contentProviderErrors.js';
import { getDefaultContentProvider } from './index.js';
import { buildContentToolSchema, CONTENT_TOOL_NAME } from '../contentOutputSchema.js';
import { buildSystemPrompt } from '../socialContentPromptBuilder.js';
import { CONTENT_MODEL, DEFAULT_CONTENT_MODEL, CONTENT_MAX_OUTPUT_TOKENS } from '../contentConfig.js';
import { validRawPost } from '../../../testSupport/aiStrategyFixtures.js';
import {
  openAIResponseBody, refusalBody, incompleteBody, openAIErrorResponse, okResponse, scriptedFetch, clientFactoryFor,
} from '../../../testSupport/openAIFixtures.js';

/**
 * The REAL OpenAIContentProvider with the REAL OpenAI SDK, `fetch` scripted (no network, no real key):
 * proves the request is a Structured Outputs call that carries the key only in the Authorization header,
 * that every failure becomes a code-only error, and that retries are bounded and never repeat an auth/quota/bad-output failure.
 */
const KEY = 'sk-test-OPENAI-KEY-1234567890';
const realKeys = { post: process.env.OPENAI_POST_API_KEY, generic: process.env.OPENAI_API_KEY };
const realModelEnv = { content: process.env.SOCIAL_AI_CONTENT_MODEL, openai: process.env.OPENAI_MODEL };
const noSleep = async () => {};

const restore = (name, value) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };
beforeEach(() => { delete process.env.OPENAI_POST_API_KEY; process.env.OPENAI_API_KEY = KEY; });
afterEach(() => { restore('OPENAI_POST_API_KEY', realKeys.post); restore('OPENAI_API_KEY', realKeys.generic); });

const make = (responder, options = {}) => {
  const fetchFn = scriptedFetch(responder);
  const provider = new OpenAIContentProvider({ clientFactory: clientFactoryFor(fetchFn, options.timeoutMs), sleep: noSleep, ...options });
  return { provider, fetchFn };
};
const ok = (parsed = validRawPost(), opts) => okResponse(openAIResponseBody(parsed, opts));
const call = (provider, extra = {}) => provider.generateContent({ system: buildSystemPrompt(), user: 'DATA', ...extra });

describe('OpenAIContentProvider - the request', () => {
  test('1: ONE Structured Outputs call to the Responses API with the content schema, store:false and the configured budget', async () => {
    const { provider, fetchFn } = make(() => ok());
    const r = await call(provider);
    assert.equal(fetchFn.requests.length, 1);
    const { url, body } = fetchFn.requests[0];
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(body.model, CONTENT_MODEL);
    assert.equal(body.instructions, buildSystemPrompt());
    assert.equal(body.input, 'DATA');
    assert.equal(body.store, false);
    assert.equal(body.max_output_tokens, CONTENT_MAX_OUTPUT_TOKENS);
    assert.equal(body.text.format.type, 'json_schema');
    assert.equal(body.text.format.strict, true);
    assert.equal(body.text.format.name, CONTENT_TOOL_NAME);
    assert.equal(body.tools, undefined, 'no tools: the schema alone constrains the output');
    assert.deepEqual(r.parsed, validRawPost());
    assert.deepEqual(r.usage, { inputTokens: 40, outputTokens: 90 });
    assert.equal(r.model, 'gpt-test-model');
    assert.equal(r.attempts, 1);
  });

  test('2: the schema sent is the content contract in strict form: exactly the contract fields, all required, no extras anywhere', async () => {
    const { provider, fetchFn } = make(() => ok());
    await call(provider);
    const schema = fetchFn.requests[0].body.text.format.schema;
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(Object.keys(schema.properties).sort(), Object.keys(validRawPost()).sort());
    assert.deepEqual([...schema.required].sort(), Object.keys(validRawPost()).sort());
    for (const forbidden of ['scheduledAt', 'status', 'externalPostId', 'media', 'approvalState', 'projectId', 'userId', 'accessToken']) assert.equal(forbidden in schema.properties, false, forbidden);
    assert.deepEqual(schema.properties.platform.enum, ['facebook', 'instagram']);
    assert.deepEqual(schema.properties.callToAction.type, ['string', 'null']);
    assert.equal(/maxLength|minLength|maxItems|minItems|pattern|format/.test(JSON.stringify(schema)), false, 'only keywords strict mode supports');
  });

  test('3: the key is only in the Authorization header - never in the body, the instructions or the URL', async () => {
    const { provider, fetchFn } = make(() => ok());
    await call(provider);
    const { init, url, body } = fetchFn.requests[0];
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), `Bearer ${KEY}`);
    assert.equal(init.body.includes(KEY), false);
    assert.equal(url.includes(KEY), false);
    assert.equal(JSON.stringify(body).includes('sk-'), false);
  });

  test('4: the model comes from server configuration only: SOCIAL_AI_CONTENT_MODEL -> OPENAI_MODEL -> built-in default; a caller cannot pick one', async () => {
    const importConfig = async (env) => {
      const saved = { c: process.env.SOCIAL_AI_CONTENT_MODEL, o: process.env.OPENAI_MODEL };
      for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      try { return (await import(`../contentConfig.js?model=${Math.random()}`)).CONTENT_MODEL; } finally {
        if (saved.c === undefined) delete process.env.SOCIAL_AI_CONTENT_MODEL; else process.env.SOCIAL_AI_CONTENT_MODEL = saved.c;
        if (saved.o === undefined) delete process.env.OPENAI_MODEL; else process.env.OPENAI_MODEL = saved.o;
      }
    };
    assert.equal(await importConfig({ SOCIAL_AI_CONTENT_MODEL: 'gpt-content-x', OPENAI_MODEL: 'gpt-other' }), 'gpt-content-x');
    assert.equal(await importConfig({ SOCIAL_AI_CONTENT_MODEL: undefined, OPENAI_MODEL: 'gpt-other' }), 'gpt-other');
    assert.equal(await importConfig({ SOCIAL_AI_CONTENT_MODEL: undefined, OPENAI_MODEL: undefined }), DEFAULT_CONTENT_MODEL);
    assert.equal(/claude/i.test(DEFAULT_CONTENT_MODEL), false, 'never a Claude model name');

    const { provider, fetchFn } = make(() => ok(), { model: 'gpt-configured' });
    await call(provider, { model: 'gpt-evil', maxOutputTokens: 999_999, apiKey: 'sk-evil' });
    assert.equal(fetchFn.requests[0].body.model, 'gpt-configured');
    assert.equal(fetchFn.requests[0].body.max_output_tokens, CONTENT_MAX_OUTPUT_TOKENS);
    assert.equal(new Headers(fetchFn.requests[0].init.headers).get('authorization'), `Bearer ${KEY}`);
    void realModelEnv;
  });

  test('5: no key -> unavailable, a NOT_CONFIGURED error and NO request; a whitespace-only key counts as no key', async () => {
    const { provider, fetchFn } = make(() => ok());
    delete process.env.OPENAI_API_KEY;
    assert.equal(provider.isAvailable(), false);
    await assert.rejects(() => call(provider), (e) => e.code === PROVIDER_ERROR.NOT_CONFIGURED);
    process.env.OPENAI_POST_API_KEY = '  ';
    process.env.OPENAI_API_KEY = '   ';
    assert.equal(provider.isAvailable(), false);
    assert.equal(fetchFn.requests.length, 0);
    process.env.OPENAI_API_KEY = KEY;
    assert.equal(provider.isAvailable(), true);
    await call(provider);
    assert.equal(fetchFn.requests.length, 1);
  });

  test('5b: OPENAI_POST_API_KEY is used when set (it wins over OPENAI_API_KEY); a blank one falls back to the generic key', async () => {
    const POST_KEY = 'sk-test-POST-KEY-0000000000';
    process.env.OPENAI_POST_API_KEY = POST_KEY;
    const { provider, fetchFn } = make(() => ok());
    await call(provider);
    assert.equal(new Headers(fetchFn.requests[0].init.headers).get('authorization'), `Bearer ${POST_KEY}`);
    process.env.OPENAI_POST_API_KEY = '   ';
    await call(provider);
    assert.equal(new Headers(fetchFn.requests[1].init.headers).get('authorization'), `Bearer ${KEY}`);
    delete process.env.OPENAI_API_KEY;
    process.env.OPENAI_POST_API_KEY = POST_KEY;
    assert.equal(provider.isAvailable(), true, 'the post key alone is enough');
  });

  test('6: the default provider is OpenAI (the content path no longer uses Claude)', () => {
    assert.ok(getDefaultContentProvider() instanceof OpenAIContentProvider);
    assert.equal(getDefaultContentProvider(), getDefaultContentProvider());
  });
});

describe('OpenAIContentProvider - failures become code-only errors', () => {
  const cases = [
    ['401 invalid key', () => openAIErrorResponse(401, `Incorrect API key provided: ${KEY}`, { code: 'invalid_api_key' }), PROVIDER_ERROR.AUTH, 1],
    ['403 forbidden', () => openAIErrorResponse(403, 'forbidden'), PROVIDER_ERROR.AUTH, 1],
    ['404 unknown model', () => openAIErrorResponse(404, 'The model gpt-x does not exist', { code: 'model_not_found' }), PROVIDER_ERROR.MISCONFIGURED, 1],
    ['429 insufficient quota', () => openAIErrorResponse(429, 'You exceeded your current quota', { code: 'insufficient_quota', type: 'insufficient_quota' }), PROVIDER_ERROR.QUOTA, 1],
    ['400 bad request', () => openAIErrorResponse(400, 'Invalid schema for response_format'), PROVIDER_ERROR.FAILED, 1],
    ['429 rate limit (retried once)', () => openAIErrorResponse(429, 'Rate limit reached', { code: 'rate_limit_exceeded', type: 'requests' }), PROVIDER_ERROR.RATE_LIMITED, 2],
    ['500 server error (retried once)', () => openAIErrorResponse(500, 'The server had an error'), PROVIDER_ERROR.UNAVAILABLE, 2],
    ['503 overloaded (retried once)', () => openAIErrorResponse(503, 'overloaded'), PROVIDER_ERROR.UNAVAILABLE, 2],
  ];
  for (const [label, responder, expectedCode, expectedRequests] of cases) {
    test(`7: ${label} -> ${expectedCode} after ${expectedRequests} request(s); the error carries no provider text, body or key`, async () => {
      const { provider, fetchFn } = make(responder);
      await assert.rejects(() => call(provider), (e) => {
        assert.equal(e.code, expectedCode);
        assert.equal(e.message, expectedCode, 'the message is the code - never the provider\'s words');
        assert.equal(e.cause, undefined);
        const dump = JSON.stringify({ ...e, message: e.message, stack: String(e.stack).split('\n')[0] });
        for (const leak of [KEY, 'sk-', 'Incorrect API key', 'quota', 'does not exist', 'response_format', 'Rate limit reached']) assert.equal(dump.includes(leak), false, leak);
        return true;
      });
      assert.equal(fetchFn.requests.length, expectedRequests);
    });
  }

  test('8: every provider error code maps to one of Odito\'s user-safe failure codes', () => {
    for (const code of Object.values(PROVIDER_ERROR)) assert.ok(PROVIDER_FAILURE_CODE[code], code);
    assert.equal(PROVIDER_FAILURE_CODE[PROVIDER_ERROR.AUTH], 'AI_UNAVAILABLE');
    assert.equal(PROVIDER_FAILURE_CODE[PROVIDER_ERROR.RATE_LIMITED], 'AI_BUSY');
    assert.equal(PROVIDER_FAILURE_CODE[PROVIDER_ERROR.TIMEOUT], 'AI_TIMEOUT');
    assert.equal(PROVIDER_FAILURE_CODE[PROVIDER_ERROR.NETWORK], 'AI_UNREACHABLE');
    assert.equal(PROVIDER_FAILURE_CODE[PROVIDER_ERROR.BAD_OUTPUT], 'AI_BAD_OUTPUT');
  });

  test('9: a transient failure then success is ONE retry: two requests, attempts = 2, result returned', async () => {
    const { provider, fetchFn } = make((n) => (n === 1 ? openAIErrorResponse(429, 'slow down', { code: 'rate_limit_exceeded' }) : ok()));
    const r = await call(provider);
    assert.equal(fetchFn.requests.length, 2);
    assert.equal(r.attempts, 2);
    assert.deepEqual(r.parsed, validRawPost());
  });

  test('10: retries are bounded by configuration (0 retries -> one request) and honour Retry-After up to a cap', async () => {
    const none = make(() => openAIErrorResponse(503, 'x'), { retries: 0 });
    await assert.rejects(() => call(none.provider), (e) => e.code === PROVIDER_ERROR.UNAVAILABLE);
    assert.equal(none.fetchFn.requests.length, 1);

    const waits = [];
    const { provider } = make((n) => (n === 1 ? openAIErrorResponse(429, 'x', { headers: { 'retry-after': '120' } }) : ok()), { sleep: async (ms) => { waits.push(ms); } });
    await call(provider);
    assert.deepEqual(waits, [5_000], 'a huge Retry-After is capped');
  });

  test('11: a timeout is TIMEOUT and is retried once; a network failure is NETWORK and is retried once', async () => {
    const hang = (_n, { init }) => new Promise((_, reject) => { init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
    const timeouts = make(hang, { timeoutMs: 30, retries: 1 });
    await assert.rejects(() => call(timeouts.provider), (e) => e.code === PROVIDER_ERROR.TIMEOUT);
    assert.equal(timeouts.fetchFn.requests.length, 2);

    const net = make(() => { throw new TypeError('fetch failed'); });
    await assert.rejects(() => call(net.provider), (e) => e.code === PROVIDER_ERROR.NETWORK);
    assert.equal(net.fetchFn.requests.length, 2);
  });

  const bad = [
    ['not JSON', () => ok('this is not json')],
    ['a JSON array', () => ok('[1,2,3]')],
    ['a JSON string', () => ok('"just text"')],
    ['null', () => ok('null')],
    ['empty text', () => ok('')],
    ['a refusal', () => okResponse(refusalBody())],
    ['a truncated (max_output_tokens) response', () => okResponse(incompleteBody())],
    ['no output at all', () => okResponse({ id: 'r', object: 'response', status: 'completed', model: 'm', output: [] })],
  ];
  for (const [label, responder] of bad) {
    test(`12: ${label} -> an unusable-output error, NOT retried`, async () => {
      const { provider, fetchFn } = make(responder);
      await assert.rejects(() => call(provider), (e) => [PROVIDER_ERROR.BAD_OUTPUT, PROVIDER_ERROR.UNAVAILABLE].includes(e.code) && e.message === e.code);
      assert.equal(fetchFn.requests.length, 1);
    });
  }

  test('12b: a response whose own status is "failed" is a provider-side failure: UNAVAILABLE, retried once, message not exposed', async () => {
    const { provider, fetchFn } = make(() => okResponse({ ...openAIResponseBody(validRawPost()), status: 'failed', error: { code: 'server_error', message: 'boom-secret-detail' } }));
    await assert.rejects(() => call(provider), (e) => e.code === PROVIDER_ERROR.UNAVAILABLE && !JSON.stringify(e).includes('boom-secret-detail') && !e.message.includes('boom'));
    assert.equal(fetchFn.requests.length, 2);
  });

  test('12c: a refusal or truncation is refused even when the text that came back happens to be valid JSON', async () => {
    const valid = JSON.stringify(validRawPost());
    const refused = { ...openAIResponseBody(valid), output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }, { type: 'output_text', text: valid, annotations: [] }] }] };
    const truncated = { ...openAIResponseBody(valid), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } };
    for (const [body, reason] of [[refused, 'refusal'], [truncated, 'max_output_tokens']]) {
      const { provider, fetchFn } = make(() => okResponse(body));
      await assert.rejects(() => call(provider), (e) => e.code === PROVIDER_ERROR.BAD_OUTPUT && e.reason === reason);
      assert.equal(fetchFn.requests.length, 1);
    }
  });

  test('13: extra fields in a (schema-violating) output are passed through to the SERVER validator, which is the authority - the provider never trusts or edits them', async () => {
    const dirty = { ...validRawPost(), scheduledAt: '2031-01-01', status: 'published', accessToken: 'x' };
    const { provider } = make(() => ok(dirty));
    const r = await call(provider);
    assert.deepEqual(r.parsed, dirty);
  });
});

describe('OpenAIContentProvider - helpers', () => {
  test('14: toStrictSchema drops unsupported keywords, requires every property, forbids extras at every object level, and does not mutate the contract', () => {
    const contract = buildContentToolSchema();
    const before = JSON.stringify(contract);
    const strict = toStrictSchema({ type: 'object', properties: { a: { type: 'string', maxLength: 5 }, b: { type: 'object', properties: { c: { type: 'array', maxItems: 2, items: { type: 'string', pattern: 'x' } } } } } });
    assert.deepEqual(strict, { type: 'object', additionalProperties: false, required: ['a', 'b'], properties: { a: { type: 'string' }, b: { type: 'object', additionalProperties: false, required: ['c'], properties: { c: { type: 'array', items: { type: 'string' } } } } } });
    assert.equal(JSON.stringify(contract), before);
  });

  test('15: classifyOpenAIError never returns the original error and passes our own errors through unchanged', () => {
    const own = classifyOpenAIError(Object.assign(new Error('x'), { status: 401, message: `bad key ${KEY}` }));
    assert.equal(own.code, PROVIDER_ERROR.AUTH);
    assert.equal(own.message.includes(KEY), false);
    assert.equal(classifyOpenAIError(own), own);
    assert.equal(classifyOpenAIError(new Error('weird')).code, PROVIDER_ERROR.FAILED);
    const unknown = classifyOpenAIError(Object.assign(new Error(`weird failure with ${KEY}`), { body: { secret: KEY } }));
    assert.equal(unknown.code, PROVIDER_ERROR.FAILED);
    assert.equal(unknown.message, PROVIDER_ERROR.FAILED, 'an unrecognised error never forwards its own text');
    assert.equal(JSON.stringify({ ...unknown, message: unknown.message }).includes(KEY), false);
    assert.equal(classifyOpenAIError(null).code, PROVIDER_ERROR.FAILED);
  });

  test('16: extractStructuredOutput reads output_text or the output parts, and refuses anything that is not a single JSON object', () => {
    assert.deepEqual(extractStructuredOutput({ status: 'completed', output_text: '{"a":1}' }), { a: 1 });
    assert.deepEqual(extractStructuredOutput({ status: 'completed', output: [{ content: [{ type: 'output_text', text: '{"b":2}' }] }] }), { b: 2 });
    for (const badResponse of [null, undefined, 'x', {}, { output_text: '' }, { output_text: '5' }, { output_text: '[]' }]) assert.throws(() => extractStructuredOutput(badResponse), (e) => e.code === PROVIDER_ERROR.BAD_OUTPUT);
  });
});
