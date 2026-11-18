import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { assessImageModel, runImageModelStartupCheck, SHUTDOWN_SOON_DAYS } from './imageModelCheck.js';
import { IMAGE_MODEL_SHUTDOWNS, DEFAULT_DESIGN_MODEL } from './designConfig.js';

const KEY_MODELS = ['gpt-4.1', 'gpt-image-2', 'gpt-image-2.6-flare', 'gpt-image-2.6-sunburst', 'dall-e-3'];
const NOW = new Date('2026-11-17T09:00:00Z');

describe('image model startup check', () => {
  test('1: a model the key cannot see is an ERROR that names the models it can use (image models only)', () => {
    const v = assessImageModel({ model: 'gpt-image-1', available: KEY_MODELS, now: NOW });
    assert.equal(v.ok, false);
    const missing = v.problems.find((p) => p.code === 'IMAGE_MODEL_NOT_AVAILABLE');
    assert.equal(missing.level, 'error');
    assert.match(missing.message, /Set SOCIAL_AI_DESIGN_MODEL to one of: dall-e-3, gpt-image-2, gpt-image-2\.6-flare, gpt-image-2\.6-sunburst\./);
    assert.equal(missing.message.includes('gpt-4.1'), false, 'text models are not offered');
    assert.ok(v.problems.some((p) => p.code === 'IMAGE_MODEL_SHUT_DOWN' && p.level === 'error'), 'its shutdown date has passed');
  });

  test('2: a model with a shutdown date ahead is a WARN within the window (an INFO further out), with the date and the replacement', () => {
    const soon = assessImageModel({ model: 'gpt-image-2', available: KEY_MODELS, now: NOW });
    assert.equal(soon.ok, true, 'still usable today');
    const p = soon.problems.find((x) => x.code === 'IMAGE_MODEL_SHUTDOWN_SCHEDULED');
    assert.equal(p.level, 'warn');
    assert.match(p.message, /shuts down on 2027-02-10 \(in 85 days\)\. Replacement: gpt-image-2\.6-flare/);
    const far = assessImageModel({ model: 'gpt-image-2', available: KEY_MODELS, now: new Date(Date.parse('2027-02-10T00:00:00Z') - (SHUTDOWN_SOON_DAYS + 10) * 86_400_000) });
    assert.equal(far.problems.find((x) => x.code === 'IMAGE_MODEL_SHUTDOWN_SCHEDULED').level, 'info');
  });

  test('3: an available model with no shutdown date has no problems; without a model list only the date rule applies', () => {
    assert.deepEqual(assessImageModel({ model: 'gpt-image-2.6-flare', available: KEY_MODELS, now: NOW }).problems, []);
    const unknownList = assessImageModel({ model: 'gpt-image-2.6-flare', available: null, now: NOW });
    assert.equal(unknownList.ok, true);
    assert.equal(unknownList.imageModels, null);
  });

  test('4: the shutdown list is well formed and the default model is not already shut down', () => {
    for (const s of IMAGE_MODEL_SHUTDOWNS) {
      assert.match(s.shutdown, /^\d{4}-\d{2}-\d{2}$/, s.model);
      assert.ok(s.replacement, s.model);
    }
    const v = assessImageModel({ model: DEFAULT_DESIGN_MODEL, available: null, now: NOW });
    assert.equal(v.problems.some((p) => p.code === 'IMAGE_MODEL_SHUT_DOWN'), false);
  });

  test('5: the boot check never throws: a failing model list is only a warning, and the verdict still applies the dates', async () => {
    const v = await runImageModelStartupCheck({ model: 'gpt-image-2', now: NOW, listModels: async () => { throw new Error('ECONNRESET'); } });
    assert.equal(v.ok, true);
    assert.equal(v.imageModels, null);
    assert.ok(v.problems.some((p) => p.code === 'IMAGE_MODEL_SHUTDOWN_SCHEDULED'));
    const missing = await runImageModelStartupCheck({ model: 'gpt-image-9', now: NOW, listModels: async () => KEY_MODELS });
    assert.equal(missing.ok, false);
  });
});
