import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { OpenAIImageProvider, pinImageModelSnapshot } from './openAIImageProvider.js';
import { DEFAULT_DESIGN_MODEL, DEFAULT_FALLBACK_DESIGN_MODEL, CONCEPT_SIZES } from '../designConfig.js';
import { openAIErrorResponse, okResponse, scriptedFetch, clientFactoryFor } from '../../../testSupport/openAIFixtures.js';
import { imagesResponseBody, makeImage } from '../../../testSupport/designFixtures.js';

/**
 * The model rules the user set: default gpt-image-2.6-flare; the fallback gpt-image-2.5-flare ONLY for "model not available" or a
 * 5xx; never for a content / safety refusal; a dated snapshot is pinned when one appears; every result records the model the
 * response reported.
 */
const KEYS = ['OPENAI_IMAGE_API_KEY', 'OPENAI_POST_API_KEY', 'OPENAI_API_KEY'];
const saved = {};
beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } process.env.OPENAI_API_KEY = 'sk-test-FALLBACK-0000000000'; });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } pinImageModelSnapshot(DEFAULT_DESIGN_MODEL, null); });

let png;
const ok = async (model) => okResponse({ ...imagesResponseBody(png ||= await makeImage({ width: 64, height: 64 })), ...(model ? { model } : {}) });
const make = (responder, options = {}) => {
  const fetchFn = scriptedFetch(responder);
  return { provider: new OpenAIImageProvider({ clientFactory: clientFactoryFor(fetchFn), sleep: async () => {}, retries: 0, ...options }), fetchFn };
};
const gen = (p) => p.generateImage({ prompt: 'A quiet studio desk, no text', size: CONCEPT_SIZES.portrait.request });

describe('image model defaults', () => {
  test('1: default gpt-image-2.6-flare, fallback gpt-image-2.5-flare, sizes are multiples of 16 that scale to the platform size', () => {
    assert.equal(DEFAULT_DESIGN_MODEL, 'gpt-image-2.6-flare');
    assert.equal(DEFAULT_FALLBACK_DESIGN_MODEL, 'gpt-image-2.5-flare');
    assert.deepEqual(CONCEPT_SIZES.portrait, { request: '1088x1360', width: 1080, height: 1350 });
    assert.deepEqual(CONCEPT_SIZES.square, { request: '1088x1088', width: 1080, height: 1080 });
    for (const s of Object.values(CONCEPT_SIZES)) for (const n of s.request.split('x').map(Number)) assert.equal(n % 16, 0);
  });
});

describe('the fallback model', () => {
  test('2: "model not found" -> one call to the fallback, flagged fallbackUsed, the reported model recorded', async () => {
    const { provider, fetchFn } = make(async (n) => (n === 1 ? openAIErrorResponse(404, 'The model gpt-image-2.6-flare does not exist', { code: 'model_not_found', param: 'model' }) : ok('gpt-image-2.5-flare-2026-08-01')));
    const r = await gen(provider);
    assert.equal(fetchFn.requests.length, 2);
    assert.equal(fetchFn.requests[0].body.model, 'gpt-image-2.6-flare');
    assert.equal(fetchFn.requests[1].body.model, 'gpt-image-2.5-flare');
    assert.equal(r.fallbackUsed, true);
    assert.equal(r.model, 'gpt-image-2.5-flare');
    assert.equal(r.modelReturned, 'gpt-image-2.5-flare-2026-08-01');
  });

  test('3: a 5xx (after the retries) -> the fallback', async () => {
    const { provider, fetchFn } = make(async (n) => (n === 1 ? openAIErrorResponse(503, 'Service unavailable', { type: 'server_error' }) : ok()));
    const r = await gen(provider);
    assert.equal(fetchFn.requests.length, 2);
    assert.equal(r.fallbackUsed, true);
  });

  test('4: a content / safety refusal is NEVER answered by the fallback', async () => {
    const { provider, fetchFn } = make(async () => openAIErrorResponse(400, 'Your request was rejected by the safety system.', { code: 'moderation_blocked' }));
    await assert.rejects(gen(provider));
    assert.equal(fetchFn.requests.length, 1);
  });

  test('5: a bad request (not the model) is not answered by the fallback either', async () => {
    const { provider, fetchFn } = make(async () => openAIErrorResponse(400, 'Invalid size', { code: 'invalid_value', param: 'size' }));
    await assert.rejects(gen(provider));
    assert.equal(fetchFn.requests.length, 1);
  });

  test('6: the fallback can be switched off ("none"), and is never the model itself', async () => {
    const off = make(async () => openAIErrorResponse(503, 'down', { type: 'server_error' }), { fallbackModel: null });
    await assert.rejects(gen(off.provider));
    assert.equal(off.fetchFn.requests.length, 1);
    assert.equal(new OpenAIImageProvider({ model: 'gpt-image-2.5-flare', fallbackModel: 'gpt-image-2.5-flare' }).fallbackModel, null);
  });

  test('7: a normal success records the model, the reported model (null when the response has none), no fallback', async () => {
    const { provider } = make(async () => ok());
    const r = await gen(provider);
    assert.equal(r.model, 'gpt-image-2.6-flare');
    assert.equal(r.modelReturned, null);
    assert.equal(r.fallbackUsed, false);
  });
});

describe('snapshot pinning', () => {
  test('8: a pinned dated snapshot is what is requested', async () => {
    pinImageModelSnapshot('gpt-image-2.6-flare', 'gpt-image-2.6-flare-2026-11-01');
    const { provider, fetchFn } = make(async () => ok());
    assert.equal(provider.requestModel, 'gpt-image-2.6-flare-2026-11-01');
    await gen(provider);
    assert.equal(fetchFn.requests[0].body.model, 'gpt-image-2.6-flare-2026-11-01');
  });
});
