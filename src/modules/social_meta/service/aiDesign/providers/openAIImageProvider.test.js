import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { OpenAIImageProvider, classifyImageError, extractImage, IMAGE_REFUSED } from './openAIImageProvider.js';
import { getDefaultImageProvider } from './index.js';
import { PROVIDER_ERROR } from '../../aiContent/providers/contentProviderErrors.js';
import { DEFAULT_DESIGN_MODEL, DESIGN_QUALITY } from '../designConfig.js';
import { openAIErrorResponse, okResponse, scriptedFetch, clientFactoryFor } from '../../../testSupport/openAIFixtures.js';
import { imagesResponseBody, makeImage } from '../../../testSupport/designFixtures.js';

/**
 * The REAL OpenAIImageProvider with the REAL OpenAI SDK, `fetch` scripted (no network, no real key): the request is
 * the documented Images API call, the key travels only in the Authorization header, a remote URL in a response is
 * never fetched, and every failure becomes a code-only error with bounded, transient-only retries.
 */
const KEYS = ['OPENAI_IMAGE_API_KEY', 'OPENAI_POST_API_KEY', 'OPENAI_API_KEY'];
const saved = {};
const KEY = 'sk-test-IMAGE-KEY-1234567890';
const noSleep = async () => {};

beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } process.env.OPENAI_API_KEY = KEY; });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const make = (responder, options = {}) => {
  const fetchFn = scriptedFetch(responder);
  const provider = new OpenAIImageProvider({ clientFactory: clientFactoryFor(fetchFn, options.timeoutMs), sleep: noSleep, ...options });
  return { provider, fetchFn };
};
let png;
const okImage = async (opts) => okResponse(imagesResponseBody(png ||= await makeImage({ width: 64, height: 64 }), opts));
const gen = (provider) => provider.generateImage({ prompt: 'A calm dental clinic, no text', size: '1024x1024' });

describe('OpenAIImageProvider - the request', () => {
  test('1: ONE Images API call: configured model + quality, n=1, JPEG, safety moderation on, the server-built prompt - and nothing else', async () => {
    const { provider, fetchFn } = make(okImage);
    const r = await gen(provider);
    assert.equal(fetchFn.requests.length, 1);
    const { url, body } = fetchFn.requests[0];
    assert.equal(url, 'https://api.openai.com/v1/images/generations');
    assert.deepEqual(body, { model: DEFAULT_DESIGN_MODEL, prompt: 'A calm dental clinic, no text', size: '1024x1024', quality: DESIGN_QUALITY, n: 1, output_format: 'jpeg', moderation: 'auto' });
    assert.equal('response_format' in body, false, 'GPT Image models reject response_format');
    assert.equal('user' in body, false, 'no user/project id is sent to the provider');
    assert.ok(Buffer.isBuffer(r.buffer) && r.buffer.length > 0);
    assert.deepEqual(r.usage, { inputTokens: 60, outputTokens: 1056 });
    assert.equal(r.model, DEFAULT_DESIGN_MODEL);
    assert.equal(r.attempts, 1);
  });

  test('2: the key is only in the Authorization header - never in the body or the URL', async () => {
    const { provider, fetchFn } = make(okImage);
    await gen(provider);
    const { init, url } = fetchFn.requests[0];
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${KEY}`);
    assert.equal(init.body.includes(KEY), false);
    assert.equal(url.includes(KEY), false);
  });

  test('3: key lookup is OPENAI_IMAGE_API_KEY -> OPENAI_POST_API_KEY -> OPENAI_API_KEY, blanks ignored; no key = unavailable and NO request', async () => {
    const used = async () => { const { provider, fetchFn } = make(okImage); await gen(provider); return new Headers(fetchFn.requests[0].init.headers).get('authorization'); };
    assert.equal(await used(), `Bearer ${KEY}`);
    process.env.OPENAI_POST_API_KEY = 'sk-test-POST';
    assert.equal(await used(), 'Bearer sk-test-POST');
    process.env.OPENAI_IMAGE_API_KEY = 'sk-test-IMAGE-SPECIFIC';
    assert.equal(await used(), 'Bearer sk-test-IMAGE-SPECIFIC');
    process.env.OPENAI_IMAGE_API_KEY = '   ';
    assert.equal(await used(), 'Bearer sk-test-POST');

    for (const k of KEYS) delete process.env[k];
    const { provider, fetchFn } = make(okImage);
    assert.equal(provider.isAvailable(), false);
    await assert.rejects(() => gen(provider), (e) => e.code === PROVIDER_ERROR.NOT_CONFIGURED);
    assert.equal(fetchFn.requests.length, 0);
  });

  test('4: only GPT Image models are supported: a text/other model name makes the provider unavailable, never a wrong call', async () => {
    for (const model of ['gpt-4.1-mini', 'claude-sonnet-4-6', 'dall-e-3', '']) {
      const { provider, fetchFn } = make(okImage, { model: model || 'dall-e-2' });
      assert.equal(provider.isAvailable(), false, model);
      await assert.rejects(() => gen(provider), (e) => e.code === PROVIDER_ERROR.MISCONFIGURED);
      assert.equal(fetchFn.requests.length, 0);
    }
    assert.equal(make(okImage, { model: 'gpt-image-1-mini' }).provider.isAvailable(), true);
  });

  test('5: the default provider is OpenAI images', () => {
    assert.ok(getDefaultImageProvider() instanceof OpenAIImageProvider);
    assert.equal(getDefaultImageProvider(), getDefaultImageProvider());
  });
});

describe('OpenAIImageProvider - responses and failures', () => {
  test('6: a response that only carries a remote URL is REFUSED and the URL is never fetched (no SSRF)', async () => {
    const { provider, fetchFn } = make(() => okResponse({ created: 1, data: [{ url: 'http://169.254.169.254/latest/meta-data/' }] }));
    await assert.rejects(() => gen(provider), (e) => e.code === PROVIDER_ERROR.BAD_OUTPUT && e.reason === 'url_only_not_fetched');
    assert.equal(fetchFn.requests.length, 1, 'only the generation request - nothing was downloaded');
    assert.equal(fetchFn.requests.some((r) => r.url.includes('169.254')), false);
  });

  const bad = [
    ['no data', () => okResponse({ created: 1, data: [] })],
    ['empty b64', () => okResponse({ created: 1, data: [{ b64_json: '' }] })],
    ['b64 of the wrong type', () => okResponse({ created: 1, data: [{ b64_json: 12345 }] })],
    ['an oversized payload', () => okResponse({ created: 1, data: [{ b64_json: 'A'.repeat(17 * 1024 * 1024) }] })],
    ['no body fields', () => okResponse({})],
  ];
  for (const [label, responder] of bad) {
    test(`7: ${label} -> BAD_OUTPUT, NOT retried`, async () => {
      const { provider, fetchFn } = make(responder);
      await assert.rejects(() => gen(provider), (e) => e.code === PROVIDER_ERROR.BAD_OUTPUT && e.message === e.code);
      assert.equal(fetchFn.requests.length, 1);
    });
  }

  const cases = [
    ['401 invalid key', () => openAIErrorResponse(401, `Incorrect API key provided: ${KEY}`, { code: 'invalid_api_key' }), PROVIDER_ERROR.AUTH, 1],
    ['403 org not verified', () => openAIErrorResponse(403, 'Your organization must be verified to use the model gpt-image-1', { code: 'unsupported_country_region_territory' }), PROVIDER_ERROR.AUTH, 1],
    ['404 unknown model', () => openAIErrorResponse(404, 'The model does not exist', { code: 'model_not_found' }), PROVIDER_ERROR.MISCONFIGURED, 1],
    ['429 quota', () => openAIErrorResponse(429, 'You exceeded your current quota', { code: 'insufficient_quota' }), PROVIDER_ERROR.QUOTA, 1],
    ['400 safety refusal', () => openAIErrorResponse(400, 'Your request was rejected by the safety system. safety_violations=[sexual]', { code: 'moderation_blocked' }), IMAGE_REFUSED, 1],
    ['400 other', () => openAIErrorResponse(400, 'Invalid value: size'), PROVIDER_ERROR.FAILED, 1],
    ['429 rate limit (one retry)', () => openAIErrorResponse(429, 'Rate limit reached', { code: 'rate_limit_exceeded' }), PROVIDER_ERROR.RATE_LIMITED, 2],
    ['500 (one retry)', () => openAIErrorResponse(500, 'The server had an error'), PROVIDER_ERROR.UNAVAILABLE, 2],
    ['503 (one retry)', () => openAIErrorResponse(503, 'overloaded'), PROVIDER_ERROR.UNAVAILABLE, 2],
  ];
  for (const [label, responder, code, requests] of cases) {
    test(`8: ${label} -> ${code} after ${requests} request(s); the error carries no provider text, prompt or key`, async () => {
      const { provider, fetchFn } = make(responder);
      await assert.rejects(() => gen(provider), (e) => {
        assert.equal(e.code, code);
        assert.equal(e.message, code);
        assert.equal(e.cause, undefined);
        const dump = JSON.stringify({ ...e, message: e.message });
        for (const leak of [KEY, 'sk-', 'Incorrect API key', 'verified', 'quota', 'safety', 'sexual', 'Invalid value', 'dental clinic']) assert.equal(dump.includes(leak), false, leak);
        return true;
      });
      assert.equal(fetchFn.requests.length, requests);
    });
  }

  test('9: a transient failure then success = ONE retry (2 requests, attempts 2); retries=0 means one request; Retry-After is capped', async () => {
    const one = make(async (n) => (n === 1 ? openAIErrorResponse(429, 'slow', { code: 'rate_limit_exceeded' }) : okImage()));
    const r = await gen(one.provider);
    assert.equal(one.fetchFn.requests.length, 2);
    assert.equal(r.attempts, 2);

    const none = make(() => openAIErrorResponse(503, 'x'), { retries: 0 });
    await assert.rejects(() => gen(none.provider), (e) => e.code === PROVIDER_ERROR.UNAVAILABLE);
    assert.equal(none.fetchFn.requests.length, 1);

    const waits = [];
    const capped = make(async (n) => (n === 1 ? openAIErrorResponse(429, 'x', { headers: { 'retry-after': '600' } }) : okImage()), { sleep: async (ms) => { waits.push(ms); } });
    await gen(capped.provider);
    assert.deepEqual(waits, [5_000]);
  });

  test('10: timeout -> TIMEOUT and network failure -> NETWORK, each retried once', async () => {
    const hang = (_n, { init }) => new Promise((_, reject) => { init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
    const t = make(hang, { timeoutMs: 30 });
    await assert.rejects(() => gen(t.provider), (e) => e.code === PROVIDER_ERROR.TIMEOUT);
    assert.equal(t.fetchFn.requests.length, 2);
    const n = make(() => { throw new TypeError('fetch failed'); });
    await assert.rejects(() => gen(n.provider), (e) => e.code === PROVIDER_ERROR.NETWORK);
    assert.equal(n.fetchFn.requests.length, 2);
  });

  test('11: helpers: classifyImageError never forwards text; extractImage decodes only inline base64', async () => {
    const c = classifyImageError(Object.assign(new Error(`weird ${KEY}`), { status: 400, code: 'moderation_blocked' }));
    assert.equal(c.code, IMAGE_REFUSED);
    assert.equal(c.message.includes(KEY), false);
    assert.equal(classifyImageError(new Error('x')).code, PROVIDER_ERROR.FAILED);
    const bytes = Buffer.from('hello-bytes');
    assert.deepEqual(extractImage({ data: [{ b64_json: bytes.toString('base64') }] }), bytes);
    assert.throws(() => extractImage({ data: [{ url: 'https://evil.example/x.png' }] }), (e) => e.code === PROVIDER_ERROR.BAD_OUTPUT);
  });
});

describe('OpenAIImageProvider - building on the real product photo', () => {
  // the SDK sends a harmless data: probe before a multipart upload; only the Images API requests matter here
  const imageRequests = (fetchFn) => fetchFn.requests.filter((q) => q.url.includes('/images/'));
  const photo = async (n = 1) => ({ buffer: await makeImage({ width: 64, height: 64, format: 'jpeg' }), mimeType: 'image/jpeg', n });

  test('12: with reference photos the call is the Images API EDIT endpoint, same model / quality / size, the photos as image parts, and high input fidelity', async () => {
    const { provider, fetchFn } = make(okImage);
    const r = await provider.generateImage({ prompt: 'Build on the real product', size: '1024x1024', referenceImages: [await photo(), await photo()] });
    assert.ok(Buffer.isBuffer(r.buffer) && r.buffer.length > 0);
    assert.equal(imageRequests(fetchFn).length, 1);
    const { url, body } = imageRequests(fetchFn)[0];
    assert.equal(url, 'https://api.openai.com/v1/images/edits');
    assert.equal(typeof body.getAll, 'function', 'a multipart request');
    assert.equal(body.get('model'), DEFAULT_DESIGN_MODEL);
    assert.equal(body.get('prompt'), 'Build on the real product');
    assert.equal(body.get('size'), '1024x1024');
    assert.equal(body.get('quality'), DESIGN_QUALITY);
    assert.equal(body.get('output_format'), 'jpeg');
    assert.equal(body.get('n'), '1');
    assert.equal(body.get('input_fidelity'), 'high');
    const images = [...body.getAll('image'), ...body.getAll('image[]')];
    assert.equal(images.length, 2);
    for (const file of images) { assert.ok(file.size > 0); assert.match(file.name, /^reference-\d\.jpg$/); }
    assert.equal(body.has('user'), false, 'no user/project id is sent');
  });

  test('13: the key is still only in the Authorization header on an edit; the photo bytes are not in the URL or any text field', async () => {
    const { provider, fetchFn } = make(okImage);
    await provider.generateImage({ prompt: 'p', size: '1024x1024', referenceImages: [await photo()] });
    const { init, url } = imageRequests(fetchFn)[0];
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${KEY}`);
    assert.equal(url.includes(KEY), false);
    for (const [, value] of init.body.entries()) if (typeof value === 'string') assert.equal(value.includes(KEY), false);
  });

  test('14: at most MAX_REFERENCE_IMAGES photos are sent; anything that is not a buffer is ignored; no usable photo means the normal generate call', async () => {
    const { MAX_REFERENCE_IMAGES } = await import('../designConfig.js');
    const many = make(okImage);
    await many.provider.generateImage({ prompt: 'p', size: '1024x1024', referenceImages: await Promise.all(Array.from({ length: MAX_REFERENCE_IMAGES + 3 }, () => photo())) });
    assert.equal([...imageRequests(many.fetchFn)[0].body.getAll('image'), ...imageRequests(many.fetchFn)[0].body.getAll('image[]')].length, MAX_REFERENCE_IMAGES);
    const none = make(okImage);
    await none.provider.generateImage({ prompt: 'p', size: '1024x1024', referenceImages: [{ buffer: 'not a buffer' }, { buffer: Buffer.alloc(0) }, null] });
    assert.equal(imageRequests(none.fetchFn)[0].url, 'https://api.openai.com/v1/images/generations');
    const plain = make(okImage);
    await plain.provider.generateImage({ prompt: 'p', size: '1024x1024' });
    assert.equal(imageRequests(plain.fetchFn)[0].url, 'https://api.openai.com/v1/images/generations');
  });

  test('15: an edit has the same failure handling: refusals are code-only, transient failures are retried once', async () => {
    const refused = make(() => openAIErrorResponse(400, 'Your request was rejected by the safety system', { code: 'moderation_blocked' }));
    const ref = [await photo()];
    await assert.rejects(() => refused.provider.generateImage({ prompt: 'p', size: '1024x1024', referenceImages: ref }), (e) => e.code === IMAGE_REFUSED && !String(e.message).includes('safety'));
    assert.equal(imageRequests(refused.fetchFn).length, 1);
    let hits = 0;
    const flaky = make(async (_n, { url }) => { if (!url.includes('/images/')) return okResponse({}); hits += 1; return hits === 1 ? openAIErrorResponse(503, 'overloaded') : okImage(); });
    const r = await flaky.provider.generateImage({ prompt: 'p', size: '1024x1024', referenceImages: [await photo()] });
    assert.equal(r.attempts, 2);
    assert.ok(imageRequests(flaky.fetchFn).length === 2 && imageRequests(flaky.fetchFn).every((q) => q.url.endsWith('/images/edits')));
  });
});
