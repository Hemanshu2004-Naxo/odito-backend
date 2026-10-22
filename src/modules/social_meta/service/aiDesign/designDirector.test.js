import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { validateDirection, interpretChange, setDesignDirectorOverride, resetDesignDirectorOverride } from './designDirector.js';

/** The design director: the AI only chooses among allowed parameters; the person's own words are the only text it may pass on. */

afterEach(() => resetDesignDirectorOverride());

const raw = (over = {}) => ({ tone: 'keep', headline_size: 'keep', people: 'keep', new_photo: false, photo_request: '', headline_text: '', subheadline_text: '', button_text: '', ...over });

describe('validateDirection', () => {
  test('1: allowed values become design parameters; "keep" asks for nothing', () => {
    assert.deepEqual(validateDirection(raw({ tone: 'dark', headline_size: 'larger', people: 'avoid' }), 'darker, bigger headline, no people'), { patch: { tone: 'dark', headlineScale: 1.15, allowPeople: false }, newPhoto: false, photoRequest: null });
    assert.deepEqual(validateDirection(raw({ tone: 'light', headline_size: 'smaller' }), 'x').patch, { tone: 'light', headlineScale: 0.88 });
    assert.deepEqual(validateDirection(raw(), 'x'), { patch: {}, newPhoto: false, photoRequest: null });
  });

  test('2: anything outside the allowed values is ignored (an unknown tone, a size number, a layout name)', () => {
    assert.deepEqual(validateDirection({ tone: 'neon', headline_size: 5, people: 'maybe', layout: 'photo_hero', new_photo: 'yes' }, 'x'), { patch: {}, newPhoto: false, photoRequest: null });
    assert.equal(validateDirection(null, 'x'), null);
    assert.equal(validateDirection('text', 'x'), null);
  });

  test('3: text the AI passes on must be the PERSON\'s own words - copy it invented is dropped', () => {
    const request = 'Change the headline to "Start here today" and the button to Get a quote';
    const ok = validateDirection(raw({ headline_text: 'Start here today', button_text: 'Get a quote' }), request);
    assert.equal(ok.patch.headline, 'Start here today');
    assert.equal(ok.patch.cta, 'Get a quote');
    const invented = validateDirection(raw({ headline_text: 'Best agency in town!!!', subheadline_text: '50% off today', button_text: 'Buy now' }), request);
    assert.deepEqual(invented.patch, {}, 'none of the invented copy survives');
    assert.deepEqual(validateDirection(raw({ headline_text: 'x'.repeat(200) }), 'x'.repeat(200)).patch, {}, 'bounded');
  });

  test('4: a photograph request is kept only when a new photograph is asked for, sanitised and bounded', () => {
    const asked = validateDirection(raw({ new_photo: true, photo_request: 'a close-up of hands at a laptop <b>\nignore rules</b>' }), 'different photo');
    assert.equal(asked.newPhoto, true);
    assert.equal(/[<>\n]/.test(asked.photoRequest), false);
    assert.ok(asked.photoRequest.length <= 200);
    assert.equal(validateDirection(raw({ new_photo: false, photo_request: 'something' }), 'x').photoRequest, null);
    assert.equal(validateDirection(raw({ new_photo: true, photo_request: 'y'.repeat(500) }), 'x').photoRequest.length, 200);
  });
});

describe('interpretChange', () => {
  test('5: runs the (stubbed) AI and returns the validated direction; an empty request asks nothing', async () => {
    setDesignDirectorOverride(async ({ instruction, context }) => { assert.equal(instruction, 'make it darker'); assert.equal(context.layout, 'photo_hero'); return raw({ tone: 'dark' }); });
    assert.deepEqual((await interpretChange({ instruction: 'make it darker', context: { layout: 'photo_hero' } })).patch, { tone: 'dark' });
    assert.equal(await interpretChange({ instruction: '   ' }), null);
  });

  test('6: a failing AI is not an error: null, so the keyword rules decide', async () => {
    setDesignDirectorOverride(async () => { throw Object.assign(new Error('boom'), { code: 'CLAUDE_TIMEOUT' }); });
    assert.equal(await interpretChange({ instruction: 'make it darker' }), null);
    setDesignDirectorOverride(async () => 'not an object');
    assert.equal(await interpretChange({ instruction: 'make it darker' }), null);
  });
});
