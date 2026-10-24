import { describe, test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { DataForSeoService } from '../../../ranking/services/DataForSeoService.js';
import {
  executeChatGptPrompt, buildChatGptRequest, parseChatGptResponse, classifyProviderError, computeRetryDelayMs, CHATGPT_ERROR,
} from '../providers/dataForSeoChatGptProvider.js';
import { getChatGptConfig } from '../config/chatgptConfig.js';
import { readFileSync } from 'node:fs';

const liveFixture = () => JSON.parse(readFileSync(new URL('./fixtures/chatgptLiveResponse.sanitized.json', import.meta.url), 'utf8'));

afterEach(() => mock.restoreAll());

const cfg = (o = {}) => ({ ...getChatGptConfig({}), maxRetries: 2, retryBaseDelayMs: 100, retryMaxDelayMs: 1000, timeoutMs: 5000, ...o });
const SECRET_PROMPT = 'PROMPT-TEXT-SHOULD-NOT-LEAK';

// The ASSUMED provider layout (see the provider header): the parser is isolated so this fixture is the one place to correct.
const okEnvelope = (overrides = {}) => ({
  status_code: 20000,
  tasks: [{
    id: 'task-123', status_code: 20000, cost: 0.0123,
    result: [{
      model_name: 'gpt-4o-mini', input_tokens: 40, output_tokens: 300,
      items: [
        { type: 'reasoning', sections: [{ type: 'text', text: 'internal thoughts' }] },
        { type: 'message', sections: [
          { type: 'text', text: 'ASG Eye Hospital is a leading option.', annotations: [{ title: 'ASG', url: 'https://asgeye.example/' }, { title: 'dup', url: 'https://asgeye.example/' }, { title: 'no url' }] },
          { type: 'text', text: 'Second paragraph.' },
        ] },
      ],
    }],
    ...overrides,
  }],
});
const axiosError = (status, headers = {}, extra = {}) => Object.assign(new Error(`HTTP ${status}`), { isAxiosError: true, response: { status, headers, data: { secret: 'BODY' } }, ...extra });

describe('request construction', () => {
  test('local project: country + city from the profile, model/limits from server config', () => {
    const body = buildChatGptRequest({ prompt: 'P', market: { effectiveScope: 'local', city: 'Ahmedabad', countryCode: 'IN' }, tag: 'odito-x' }, cfg());
    assert.deepEqual(body, { user_prompt: 'P', model_name: 'gpt-4o-mini', web_search: true, max_output_tokens: 2048, tag: 'odito-x', web_search_country_iso_code: 'IN', web_search_city: 'Ahmedabad' });
  });

  test('national project sends no city; missing country sends none either', () => {
    const national = buildChatGptRequest({ prompt: 'P', market: { effectiveScope: 'national', city: 'Ignored', countryCode: 'in' } }, cfg());
    assert.equal(national.web_search_country_iso_code, 'IN');
    assert.ok(!('web_search_city' in national));
    assert.ok(!('web_search_country_iso_code' in buildChatGptRequest({ prompt: 'P', market: {} }, cfg())));
  });

  test('web search off: no location fields; model/limits follow config, nothing is client-supplied', () => {
    const body = buildChatGptRequest({ prompt: 'P', market: { effectiveScope: 'local', city: 'X', countryCode: 'IN' } }, cfg({ webSearch: false, model: 'm2', maxOutputTokens: 100 }));
    assert.equal(body.web_search, false);
    assert.equal(body.model_name, 'm2');
    assert.equal(body.max_output_tokens, 100);
    assert.ok(!('web_search_city' in body));
  });
});

describe('response parsing', () => {
  test('answer text, annotations (repeats kept), cost, request id, model, usage', () => {
    const r = parseChatGptResponse(okEnvelope());
    assert.equal(r.answerText, 'ASG Eye Hospital is a leading option.\n\nSecond paragraph.');
    assert.deepEqual(r.annotations, [{ title: 'ASG', url: 'https://asgeye.example/' }, { title: 'dup', url: 'https://asgeye.example/' }]);
    assert.equal(r.cost, 0.0123);
    assert.equal(r.requestId, 'task-123');
    assert.equal(r.model, 'gpt-4o-mini');
    assert.deepEqual(r.usage, { inputTokens: 40, outputTokens: 300 });
  });

  test('missing cost is null, never 0; money_spent is a different quantity and is never substituted', () => {
    assert.equal(parseChatGptResponse(okEnvelope({ cost: undefined })).cost, null);
    const withSpent = okEnvelope({ cost: undefined });
    withSpent.tasks[0].result[0].money_spent = 0.5;
    assert.equal(parseChatGptResponse(withSpent).cost, null);
    assert.equal(parseChatGptResponse(okEnvelope({ cost: -1 })).cost, null);
    assert.equal(parseChatGptResponse(okEnvelope({ cost: 0 })).cost, 0); // a reported zero is a real zero
  });

  test('malformed responses raise a non-retryable MALFORMED_RESPONSE', () => {
    for (const bad of [null, {}, { tasks: [] }, { tasks: [{ result: null }] }, { tasks: [{ result: [{ items: [] }] }] }, { tasks: [{ result: [{ items: [{ type: 'message', sections: [{ type: 'text', text: '   ' }] }] }] }] }]) {
      assert.throws(() => parseChatGptResponse(bad), (e) => e.code === CHATGPT_ERROR.MALFORMED_RESPONSE && e.retryable === false);
    }
  });
});

describe('verified against a real DataForSEO response (sanitized fixture)', () => {
  test('layout, annotations, cost, ids and usage parse exactly as observed live', () => {
    const live = liveFixture();
    // the fixture itself keeps the two cost-like fields different, as observed: billed cost != money_spent
    assert.notEqual(live.tasks[0].cost, live.tasks[0].result[0].money_spent);
    assert.equal(live.cost, live.tasks[0].cost);
    const r = parseChatGptResponse(live);
    assert.equal(r.cost, 0.027213); // tasks[0].cost, not money_spent (0.0266131)
    assert.equal(r.requestId.length, 36);
    assert.equal(r.model, 'gpt-4o-mini-2024-07-18');
    assert.deepEqual(r.usage, { inputTokens: 8174, outputTokens: 645 });
    assert.match(r.answerText, /^Here are some well-regarded eye hospitals/);
    assert.equal(r.annotations.length, 2);
    assert.deepEqual(Object.keys(r.annotations[0]).sort(), ['title', 'url']);
    assert.match(r.annotations[0].url, /utm_source=chatgpt\.com$/);
  });

  test('live annotations carry no type field and every one is a URL citation (so none is dropped by type)', () => {
    const anns = liveFixture().tasks[0].result[0].items[0].sections[0].annotations;
    assert.ok(anns.every((a) => !('type' in a) && typeof a.url === 'string' && typeof a.title === 'string'));
    assert.equal(parseChatGptResponse(liveFixture()).annotations.length, anns.length);
  });

  test('a live-shaped provider task error (HTTP 200, task 40501, result null) is rejected without retry; HTTP 401 is fatal', () => {
    const invalid = Object.assign(new Error("DataForSEO task error: Invalid Field: 'user_prompt'. (code 40501)"), { isApiError: true, isTaskError: true, taskStatusCode: 40501 });
    const c = classifyProviderError(invalid);
    assert.deepEqual([c.code, c.retryable, c.fatal], [CHATGPT_ERROR.REQUEST_REJECTED, false, false]);
    const unauth = classifyProviderError(axiosError(401));
    assert.deepEqual([unauth.code, unauth.retryable, unauth.fatal], [CHATGPT_ERROR.AUTH, false, true]);
  });

  test('cost units: the default label does not claim a currency', () => {
    assert.equal(getChatGptConfig({}).costUnit, 'provider_reported');
    assert.equal(getChatGptConfig({ CHATGPT_VISIBILITY_COST_UNIT: 'USD' }).costUnit, 'USD');
  });
});

describe('error classification', () => {
  const table = [
    [axiosError(401), CHATGPT_ERROR.AUTH, false, true],
    [axiosError(403), CHATGPT_ERROR.AUTH, false, true],
    [axiosError(402), CHATGPT_ERROR.INSUFFICIENT_CREDITS, false, true],
    [axiosError(429, { 'retry-after': '3' }), CHATGPT_ERROR.RATE_LIMITED, true, false],
    [axiosError(500), CHATGPT_ERROR.UNAVAILABLE, true, false],
    [axiosError(503), CHATGPT_ERROR.UNAVAILABLE, true, false],
    [axiosError(400), CHATGPT_ERROR.REQUEST_REJECTED, false, false],
    [Object.assign(new Error('timeout of 5000ms exceeded'), { isAxiosError: true, code: 'ECONNABORTED' }), CHATGPT_ERROR.TIMEOUT, true, false],
    [Object.assign(new Error('x'), { isAxiosError: true, code: 'ECONNRESET' }), CHATGPT_ERROR.NETWORK, true, false],
    [Object.assign(new Error('x'), { isApiError: true, isTaskError: true, taskStatusCode: 40201 }), CHATGPT_ERROR.ACCOUNT_RESTRICTED, false, true],
    [Object.assign(new Error('x'), { isApiError: true, apiStatusCode: 40101 }), CHATGPT_ERROR.AUTH, false, true],
    [Object.assign(new Error('Insufficient funds'), { isApiError: true, isTaskError: true, taskStatusCode: 40210 }), CHATGPT_ERROR.INSUFFICIENT_CREDITS, false, true],
    [Object.assign(new Error('x'), { isApiError: true, isTaskError: true, taskStatusCode: 50000 }), CHATGPT_ERROR.UNAVAILABLE, true, false],
    [Object.assign(new Error('x'), { isApiError: true, isTaskError: true, taskStatusCode: 40501 }), CHATGPT_ERROR.REQUEST_REJECTED, false, false],
    [new TypeError('bug'), CHATGPT_ERROR.REQUEST_REJECTED, false, false],
  ];
  for (const [err, code, retryable, fatal] of table) {
    test(`${err.message.slice(0, 30)} -> ${code}`, () => {
      const c = classifyProviderError(err);
      assert.equal(c.code, code);
      assert.equal(c.retryable, retryable);
      assert.equal(c.fatal, fatal);
    });
  }

  test('classified errors carry no response body, request or headers', () => {
    const c = classifyProviderError(axiosError(500, { authorization: 'Basic SECRET' }));
    assert.ok(!JSON.stringify(c).includes('SECRET'));
    assert.ok(!JSON.stringify(c).includes('BODY'));
  });
});

describe('retry policy', () => {
  test('Retry-After wins and is capped; otherwise capped exponential backoff with jitter', () => {
    const c = cfg();
    assert.equal(computeRetryDelayMs({ retryAfterMs: 400 }, 1, c, () => 0), 400);
    assert.equal(computeRetryDelayMs({ retryAfterMs: 999_999 }, 1, c, () => 0), 1000);
    assert.equal(computeRetryDelayMs({}, 1, c, () => 1), 100);
    assert.equal(computeRetryDelayMs({}, 1, c, () => 0), 50);
    assert.equal(computeRetryDelayMs({}, 3, c, () => 1), 400);
    assert.equal(computeRetryDelayMs({}, 10, c, () => 1), 1000);
  });

  test('transient failures are retried up to the limit then surface with attempt count', async () => {
    let calls = 0; const sleeps = [];
    await assert.rejects(
      executeChatGptPrompt({ prompt: SECRET_PROMPT, market: {} }, { config: cfg(), send: async () => { calls += 1; throw axiosError(503); }, sleep: async (ms) => sleeps.push(ms), random: () => 1 }),
      (e) => e.code === CHATGPT_ERROR.UNAVAILABLE && e.attempts === 3,
    );
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [100, 200]);
  });

  test('429 honours Retry-After and then succeeds', async () => {
    const results = [() => { throw axiosError(429, { 'retry-after': '1' }); }, () => okEnvelope()];
    const sleeps = [];
    const r = await executeChatGptPrompt({ prompt: 'p', market: {} }, { config: cfg(), send: async () => results.shift()(), sleep: async (ms) => sleeps.push(ms) });
    assert.equal(r.attempts, 2);
    assert.deepEqual(sleeps, [1000]);
    assert.equal(r.cost, 0.0123);
  });

  for (const [name, err] of [
    ['401', axiosError(401)], ['402', axiosError(402)], ['400', axiosError(400)],
    ['task 40201', Object.assign(new Error('paused'), { isApiError: true, isTaskError: true, taskStatusCode: 40201 })],
  ]) {
    test(`${name} is never retried (a paid request is not repeated)`, async () => {
      let calls = 0;
      await assert.rejects(executeChatGptPrompt({ prompt: 'p', market: {} }, { config: cfg(), send: async () => { calls += 1; throw err; }, sleep: async () => {} }), (e) => e.attempts === 1);
      assert.equal(calls, 1);
    });
  }

  test('a malformed 200 response is not retried', async () => {
    let calls = 0;
    await assert.rejects(executeChatGptPrompt({ prompt: 'p', market: {} }, { config: cfg(), send: async () => { calls += 1; return { tasks: [{ result: [{ items: [] }] }] }; }, sleep: async () => {} }), { code: CHATGPT_ERROR.MALFORMED_RESPONSE });
    assert.equal(calls, 1);
  });

  test('maxRetries 0 means a single attempt', async () => {
    let calls = 0;
    await assert.rejects(executeChatGptPrompt({ prompt: 'p', market: {} }, { config: cfg({ maxRetries: 0 }), send: async () => { calls += 1; throw axiosError(500); }, sleep: async () => {} }));
    assert.equal(calls, 1);
  });
});

describe('integration with the existing DataForSeoService (axios mocked, no network)', () => {
  test('uses the shared endpoint, Basic auth header and wraps the task in an array; envelope/task errors keep provider codes', async () => {
    process.env.DATAFORSEO_LOGIN = 'login-x'; process.env.DATAFORSEO_PASSWORD = 'pw-x';
    const post = mock.method(axios, 'post', async () => ({ data: okEnvelope() }));
    const out = await executeChatGptPrompt({ prompt: 'hello', market: { effectiveScope: 'local', city: 'Ahmedabad', countryCode: 'IN' } }, { config: cfg() });
    assert.equal(out.answerText.startsWith('ASG'), true);
    const [url, payload, options] = post.mock.calls[0].arguments;
    assert.equal(url, 'https://api.dataforseo.com/v3/ai_optimization/chat_gpt/llm_responses/live');
    assert.equal(Array.isArray(payload) && payload.length, 1);
    assert.equal(payload[0].web_search_city, 'Ahmedabad');
    assert.equal(options.headers.Authorization, `Basic ${Buffer.from('login-x:pw-x').toString('base64')}`);
    assert.equal(options.timeout, 5000);

    mock.method(axios, 'post', async () => ({ data: { status_code: 20000, tasks: [{ status_code: 40201, status_message: 'paused', result: null }] } }));
    await assert.rejects(DataForSeoService.postChatGptLlmResponse({}), (e) => e.isTaskError && e.taskStatusCode === 40201);
  });

  test('credentials and the prompt never appear in any thrown error', async () => {
    process.env.DATAFORSEO_LOGIN = 'login-secret-value'; process.env.DATAFORSEO_PASSWORD = 'password-secret-value';
    mock.method(axios, 'post', async () => { throw axiosError(500, { authorization: 'Basic login-secret-value:password-secret-value' }); });
    await assert.rejects(executeChatGptPrompt({ prompt: SECRET_PROMPT, market: {} }, { config: cfg({ maxRetries: 0 }) }), (e) => {
      const dump = JSON.stringify({ ...e, message: e.message, stack: undefined });
      assert.ok(!dump.includes('secret-value') && !dump.includes(SECRET_PROMPT) && !dump.includes('BODY'));
      return true;
    });
  });
});
