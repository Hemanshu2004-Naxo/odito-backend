import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGoogleAioRequest, buildSerpSettings, requestMetadata, RequestConfigError } from '../provider/requestBuilder.js';
import { parseGoogleAioResponse, extractAiOverview, parseProviderDatetime } from '../provider/responseParser.js';
import { classifyProviderError, GoogleAioProviderError, GOOGLE_AIO_ERROR } from '../provider/providerErrors.js';
import { fetchGoogleAiOverview, computeRetryDelayMs } from '../provider/googleAioProvider.js';
import { getGoogleAioConfig, GOOGLE_AIO_ENDPOINT, QUESTIONS_PER_RUN } from '../config/googleAioConfig.js';
import { DataForSeoService } from '../../../ranking/services/DataForSeoService.js';

import { aioItem, organic, serpResponse } from './fixtures.js';

const serp = buildSerpSettings({ locationCode: 1007740, languageCode: 'en', device: 'desktop' }, getGoogleAioConfig({}));

describe('request construction', () => {
  test('the endpoint is the Google Organic SERP live/advanced URL', () => {
    assert.equal(GOOGLE_AIO_ENDPOINT, 'https://api.dataforseo.com/v3/serp/google/organic/live/advanced');
  });
  test('transport posts ONE task to the organic live/advanced endpoint', async () => {
    // postOnce is not exported: assert the method exists and is wired to the SERP_ORGANIC endpoint by a stubbed axios-free check of its source
    assert.equal(typeof DataForSeoService.postGoogleOrganicLiveAdvanced, 'function');
    assert.match(DataForSeoService.postGoogleOrganicLiveAdvanced.toString(), /ENDPOINTS\.SERP_ORGANIC/);
  });
  test('body contains exactly the documented Google fields and no ChatGPT field', () => {
    const body = buildGoogleAioRequest({ question: '  Which eye hospitals in Nashik offer LASIK?  ', serp, tag: 'odito-gaio:r:q' });
    assert.deepEqual(Object.keys(body).sort(), ['depth', 'device', 'keyword', 'language_code', 'load_async_ai_overview', 'location_code', 'os', 'tag']);
    assert.deepEqual(body, { keyword: 'Which eye hospitals in Nashik offer LASIK?', location_code: 1007740, language_code: 'en', device: 'desktop', os: 'windows', depth: 10, load_async_ai_overview: true, tag: 'odito-gaio:r:q' });
    for (const k of ['user_prompt', 'model_name', 'web_search', 'max_output_tokens']) assert.ok(!(k in body));
  });
  test('mobile keeps its own os; unsupported device is refused before any request', () => {
    assert.deepEqual([buildSerpSettings({ locationCode: 1, languageCode: 'en', device: 'mobile' }).device, buildSerpSettings({ locationCode: 1, languageCode: 'en', device: 'mobile' }).os], ['mobile', 'android']);
    assert.throws(() => buildSerpSettings({ locationCode: 1, languageCode: 'en', device: 'tablet' }), { code: 'UNSUPPORTED_SERP_DEVICE' });
  });
  test('a missing location code or an empty / oversized question is a configuration error', () => {
    assert.throws(() => buildSerpSettings({ locationCode: null, languageCode: 'en' }), RequestConfigError);
    assert.throws(() => buildGoogleAioRequest({ question: '   ', serp }), { code: 'EMPTY_QUESTION' });
    assert.throws(() => buildGoogleAioRequest({ question: 'x'.repeat(701), serp }), { code: 'QUESTION_TOO_LONG' });
  });
  test('tag is capped at 255 chars and stored request metadata carries no keyword and no credential', () => {
    const body = buildGoogleAioRequest({ question: 'Which eye hospitals in Nashik?', serp, tag: 't'.repeat(400) });
    assert.equal(body.tag.length, 255);
    const meta = requestMetadata(body);
    assert.ok(!('keyword' in meta));
    assert.ok(!JSON.stringify(meta).toLowerCase().includes('authorization'));
  });
  test('five questions per run is a constant, not configuration', () => {
    assert.equal(QUESTIONS_PER_RUN, 5);
    assert.equal(getGoogleAioConfig({ GOOGLE_AIO_VISIBILITY_QUESTIONS_PER_RUN: '50' }).questionsPerRun, undefined);
  });
});

describe('response parsing', () => {
  test('extracts the AI Overview: text, elements, references (deduped, normalised) and metadata', () => {
    const r = parseGoogleAioResponse(serpResponse([organic, aioItem()]));
    assert.equal(r.cost, 0.0112);
    assert.equal(r.requestId, '10281234-1234-0000-0000-abcdef012345');
    assert.equal(r.checkUrl, 'https://www.google.com/search?q=x');
    assert.equal(r.datetime.toISOString(), '2026-10-28T10:15:30.000Z');
    assert.deepEqual(r.itemTypes, { organic: 1, ai_overview: 1 });
    const a = r.aiOverview;
    assert.match(a.text, /ASG Eye Hospital is a well known option/);
    assert.equal(a.asynchronous, true);
    assert.equal(a.hasContent, true);
    assert.deepEqual(a.references.map((x) => x.normalizedUrl), ['https://sankaraeye.example/nashik', 'https://asgeye.example/cataract', 'https://practo.example/nashik/eye']);
    assert.equal(a.references.find((x) => x.kind === 'link').host, 'asgeye.example');
    assert.equal(a.rejectedReferences, 1); // javascript: URL dropped, never kept
    assert.ok(a.elements.length >= 2);
  });
  test('no ai_overview item is a SUCCESSFUL observation, not an error', () => {
    const r = parseGoogleAioResponse(serpResponse([organic, { type: 'people_also_ask' }]));
    assert.equal(r.aiOverview, null);
    assert.deepEqual(r.itemTypes, { organic: 1, people_also_ask: 1 });
  });
  test('empty or null items is a valid SERP without an overview', () => {
    assert.equal(parseGoogleAioResponse(serpResponse([])).aiOverview, null);
    const data = serpResponse([]); data.tasks[0].result[0].items = null;
    assert.equal(parseGoogleAioResponse(data).aiOverview, null);
  });
  test('an overview without references keeps its text and reports no references', () => {
    const r = parseGoogleAioResponse(serpResponse([aioItem({ references: [], items: [{ type: 'ai_overview_element', text: 'Just text about eye care.' }] })]));
    assert.equal(r.aiOverview.hasContent, true);
    assert.deepEqual(r.aiOverview.references, []);
  });
  test('an overview element with neither text nor references has no content', () => {
    const a = extractAiOverview({ type: 'ai_overview', items: [], references: [] });
    assert.equal(a.hasContent, false);
  });
  test('missing cost stays null, never 0', () => {
    const data = serpResponse([organic]); delete data.tasks[0].cost;
    assert.equal(parseGoogleAioResponse(data).cost, null);
  });
  test('malformed responses throw MALFORMED_RESPONSE', () => {
    for (const bad of [null, {}, { tasks: [] }, { tasks: [{ result: null }] }, { tasks: [{ result: [] }] }, { tasks: [{ result: ['x'] }] }, { tasks: [{ result: [{ items: 'nope' }] }] }]) {
      assert.throws(() => parseGoogleAioResponse(bad), { code: GOOGLE_AIO_ERROR.MALFORMED_RESPONSE });
    }
  });
  test('provider datetime parsing', () => {
    assert.equal(parseProviderDatetime('2026-10-28 10:15:30 +00:00').toISOString(), '2026-10-28T10:15:30.000Z');
    assert.equal(parseProviderDatetime('nonsense'), null);
  });
});

describe('error classification', () => {
  const axiosErr = (status, extra = {}) => Object.assign(new Error('x'), { isAxiosError: true, response: { status, headers: extra.headers || {} }, ...extra });
  test('HTTP statuses', () => {
    assert.equal(classifyProviderError(axiosErr(401)).code, GOOGLE_AIO_ERROR.AUTH);
    assert.equal(classifyProviderError(axiosErr(401)).fatal, true);
    assert.equal(classifyProviderError(axiosErr(402)).code, GOOGLE_AIO_ERROR.INSUFFICIENT_CREDITS);
    const rl = classifyProviderError(axiosErr(429, { headers: { 'retry-after': '7' } }));
    assert.deepEqual([rl.code, rl.retryable, rl.retryAfterMs], [GOOGLE_AIO_ERROR.RATE_LIMITED, true, 7000]);
    assert.equal(classifyProviderError(axiosErr(503)).code, GOOGLE_AIO_ERROR.UNAVAILABLE);
    assert.equal(classifyProviderError(axiosErr(400)).retryable, false);
  });
  test('task-level failures follow the documented DataForSEO code table', () => {
    const task = (code, message = '') => Object.assign(new Error(message), { isApiError: true, isTaskError: true, taskStatusCode: code, taskStatusMessage: message });
    const c = (code) => classifyProviderError(task(code));
    assert.equal(c(40501).retryable, false);
    assert.equal(c(40201).fatal, true);
    // 40100 is the credentials error; 40101 is "internal se server error" (the search engine failed): transient, per question, NEVER fatal.
    assert.deepEqual([c(40100).code, c(40100).fatal], [GOOGLE_AIO_ERROR.AUTH, true]);
    assert.deepEqual([c(40101).code, c(40101).fatal, c(40101).retryable], [GOOGLE_AIO_ERROR.SEARCH_ENGINE_ERROR, false, true]);
    assert.deepEqual([c(40103).code, c(40103).fatal, c(40103).retryable], [GOOGLE_AIO_ERROR.TASK_EXECUTION_FAILED, false, true]);
    assert.deepEqual([c(40102).code, c(40102).fatal, c(40102).retryable], [GOOGLE_AIO_ERROR.NO_SEARCH_RESULTS, false, false]);
    for (const code of [40200, 40210]) assert.deepEqual([c(code).code, c(code).fatal], [GOOGLE_AIO_ERROR.INSUFFICIENT_CREDITS, true]);
    assert.deepEqual([c(40203).code, c(40203).fatal], [GOOGLE_AIO_ERROR.COST_LIMIT_EXCEEDED, true]);
    for (const code of [40202, 40209]) assert.deepEqual([c(code).code, c(code).retryable, c(code).fatal], [GOOGLE_AIO_ERROR.RATE_LIMITED, true, false]);
    for (const code of [40205, 40206]) assert.deepEqual([c(code).code, c(code).retryable, c(code).fatal], [GOOGLE_AIO_ERROR.DUPLICATE_TASK_LIMIT, false, false]);
    for (const code of [50401, 50402]) assert.deepEqual([c(code).code, c(code).retryable], [GOOGLE_AIO_ERROR.TIMEOUT, true]);
    assert.equal(c(50000).retryable, true);
  });
  test('the provider message and task id are kept as diagnostics (message trimmed, never a body or header)', () => {
    const e = classifyProviderError(Object.assign(new Error('x'), { isApiError: true, isTaskError: true, taskStatusCode: 40101, taskStatusMessage: ' Internal  SE\nserver error. ', taskId: '12345678-0000' }));
    assert.deepEqual([e.providerCode, e.providerMessage, e.taskIdReturned, e.httpStatus], [40101, 'Internal SE server error.', true, null]);
  });
  test('timeouts and network errors are retryable; unknown non-HTTP errors are not', () => {
    assert.equal(classifyProviderError(Object.assign(new Error('timeout of 90000ms exceeded'), { code: 'ECONNABORTED' })).code, GOOGLE_AIO_ERROR.TIMEOUT);
    assert.equal(classifyProviderError(Object.assign(new Error('x'), { code: 'ECONNRESET' })).retryable, true);
    assert.equal(classifyProviderError(new Error('bug')).retryable, false);
  });
  test('errors never carry the request or response body', () => {
    const e = classifyProviderError(axiosErr(500, { config: { data: 'SECRET-QUESTION' }, response: { status: 500, data: 'SECRET-BODY', headers: {} } }));
    assert.ok(!JSON.stringify(Object.entries(e)).includes('SECRET'));
  });
});

describe('provider: bounded retries, one request per question', () => {
  const cfg = getGoogleAioConfig({ GOOGLE_AIO_VISIBILITY_MAX_RETRIES: '1' });
  const input = { question: 'Which eye hospitals in Nashik offer LASIK?', serp, tag: 'odito-gaio:r:q' };
  const deps = (send) => ({ config: cfg, send, sleep: async () => {}, random: () => 0.5 });

  test('success: one request, the body sent is the built body', async () => {
    const calls = [];
    const out = await fetchGoogleAiOverview(input, deps(async (body, opts) => { calls.push({ body, opts }); return serpResponse([organic, aioItem()]); }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.location_code, 1007740);
    assert.equal(calls[0].opts.timeoutMs, cfg.timeoutMs);
    assert.equal(out.attempts, 1);
    assert.ok(out.aiOverview);
  });
  test('NO AI Overview is returned as a result and is NEVER retried', async () => {
    let n = 0;
    const out = await fetchGoogleAiOverview(input, deps(async () => { n += 1; return serpResponse([organic]); }));
    assert.equal(n, 1);
    assert.equal(out.aiOverview, null);
  });
  test('transient failure is retried at most maxRetries times, then surfaces with the attempt count', async () => {
    let n = 0;
    await assert.rejects(() => fetchGoogleAiOverview(input, deps(async () => { n += 1; throw Object.assign(new Error('x'), { isAxiosError: true, response: { status: 503, headers: {} } }); })), (e) => e.code === GOOGLE_AIO_ERROR.UNAVAILABLE && e.attempts === 2);
    assert.equal(n, 2);
  });
  test('transient failure followed by success returns the result with attempts=2', async () => {
    let n = 0;
    const out = await fetchGoogleAiOverview(input, deps(async () => { n += 1; if (n === 1) throw Object.assign(new Error('t'), { code: 'ECONNABORTED' }); return serpResponse([organic]); }));
    assert.equal(out.attempts, 2);
  });
  test('auth, rejected and malformed responses are never retried', async () => {
    for (const send of [
      async () => { throw Object.assign(new Error('x'), { isAxiosError: true, response: { status: 401, headers: {} } }); },
      async () => { throw Object.assign(new Error('Invalid Field'), { isApiError: true, isTaskError: true, taskStatusCode: 40501 }); },
      async () => ({ tasks: [{ result: null }] }),
    ]) {
      let n = 0;
      await assert.rejects(() => fetchGoogleAiOverview(input, deps(async (...a) => { n += 1; return send(...a); })), GoogleAioProviderError);
      assert.equal(n, 1);
    }
  });
  test('retry delay honours Retry-After (capped) and otherwise backs off with jitter', () => {
    assert.equal(computeRetryDelayMs({ retryAfterMs: 500 }, 1, cfg), 500);
    assert.equal(computeRetryDelayMs({ retryAfterMs: 10_000_000 }, 1, cfg), cfg.retryMaxDelayMs);
    assert.equal(computeRetryDelayMs({ retryAfterMs: null }, 1, cfg, () => 1), cfg.retryBaseDelayMs);
  });
});
