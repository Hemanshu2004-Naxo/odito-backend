import { describe, test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import WordPressCoreAdapter from './wordpressCoreAdapter.js';
import wordPressService from '../service/wordPressService.js';

/**
 * The exact-target media methods of the core adapter (used by the typed image-alt fix) and the unchanged legacy writeAltText.
 * wpRequest is replaced, so nothing here touches a network.
 */

const connection = { site_url: 'https://clinic.example', username: 'u', application_password: 'p' };
let calls;
let respond;
beforeEach(() => {
  mock.restoreAll();
  calls = [];
  respond = async () => ({ status: 200, data: {} });
  mock.method(wordPressService, 'wpRequest', async (_c, req) => { calls.push(req); return respond(req); });
});
const adapter = () => new WordPressCoreAdapter(connection);

describe('readMediaById', () => {
  test('reads exactly one attachment, in edit context (which needs edit rights), asking only for the fields the fix uses', async () => {
    respond = async () => ({ status: 200, data: { id: 42, alt_text: 'x' } });
    const m = await adapter().readMediaById(42);
    assert.equal(m.id, 42);
    assert.equal(calls[0].method, 'GET');
    assert.match(calls[0].path, /^\/wp-json\/wp\/v2\/media\/42\?context=edit&_fields=/);
    assert.equal(calls[0].skipErrorClassification, true);
  });
  test('a missing attachment is null, not an error', async () => {
    respond = async () => ({ status: 404, data: {} });
    assert.equal(await adapter().readMediaById(9), null);
  });
  test('403 -> PERMISSION_DENIED, 401 -> INVALID_CREDENTIALS, 500 -> a typed 502', async () => {
    for (const [status, code, http] of [[403, 'PERMISSION_DENIED', 403], [401, 'INVALID_CREDENTIALS', 401], [500, 'UNKNOWN_ERROR', 502]]) {
      respond = async () => ({ status, data: {} });
      await assert.rejects(adapter().readMediaById(1), (e) => e.code === code && e.statusCode === http, String(status));
    }
  });
  test('an invalid id never reaches WordPress', async () => {
    for (const bad of [0, -1, 1.5, 'abc', null, undefined, '../../users']) assert.equal(await adapter().readMediaById(bad), null);
    assert.equal(calls.length, 0);
  });
});

describe('searchMedia and readPostRawContent', () => {
  test('the search term is URL-encoded; a page past the end (400) is an empty list', async () => {
    respond = async () => ({ status: 200, data: [{ id: 1 }] });
    assert.deepEqual(await adapter().searchMedia('dr rao&x=1', 2), [{ id: 1 }]);
    assert.match(calls[0].path, /search=dr%20rao%26x%3D1&per_page=100&page=2/);
    respond = async () => ({ status: 400, data: {} });
    assert.deepEqual(await adapter().searchMedia('a', 99), []);
    assert.deepEqual(await adapter().searchMedia('', 1), []);
  });
  test('raw content is read only for a plausible post type + integer id; unreadable -> null', async () => {
    respond = async () => ({ status: 200, data: { content: { raw: '<p>hi</p>' } } });
    assert.equal(await adapter().readPostRawContent('pages', 10), '<p>hi</p>');
    const n = calls.length;
    assert.equal(await adapter().readPostRawContent('pages/../users', 10), null);
    assert.equal(await adapter().readPostRawContent('pages', 'x'), null);
    assert.equal(calls.length, n, 'a malformed path is never requested');
    respond = async () => ({ status: 403, data: {} });
    assert.equal(await adapter().readPostRawContent('pages', 10), null);
  });
});

describe('writeAltTextForAttachment — one field of one attachment', () => {
  test('PUTs only { alt_text } to the media item it was given', async () => {
    const r = await adapter().writeAltTextForAttachment(42, 'A surgeon at work');
    assert.deepEqual(calls[0], { method: 'PUT', path: '/wp-json/wp/v2/media/42', data: { alt_text: 'A surgeon at work' } });
    assert.deepEqual(r, { httpStatus: 200, wordpressPostId: 42 });
    assert.deepEqual(Object.keys(calls[0].data), ['alt_text'], 'no caption, description, title or file is ever sent');
  });
  test('an invalid attachment id or non-text alt is refused before any request', async () => {
    for (const [id, alt] of [[0, 'x'], [-3, 'x'], [1.2, 'x'], ['4; DROP', 'x'], [5, null], [5, { a: 1 }]]) {
      await assert.rejects(adapter().writeAltTextForAttachment(id, alt), (e) => e.code === 'FIELD_NOT_WRITABLE');
    }
    assert.equal(calls.length, 0);
  });
});

describe('the legacy filename-search writeAltText is unchanged (and still not offered by the generic capability table)', () => {
  test('finds the media item by exact source_url and PUTs alt_text', async () => {
    respond = async (req) => (req.method === 'GET'
      ? { status: 200, data: [{ id: 5, source_url: 'https://clinic.example/wp-content/uploads/2024/10/a.jpg' }] }
      : { status: 200, data: {} });
    const r = await adapter().writeAltText('https://clinic.example/wp-content/uploads/2024/10/a.jpg', 'Alt');
    assert.deepEqual(r, { httpStatus: 200, wordpressPostId: 5 });
    assert.deepEqual(calls[1], { method: 'PUT', path: '/wp-json/wp/v2/media/5', data: { alt_text: 'Alt' } });
  });
  test('the generic single-value capability table still reports altText as not writable', () => {
    assert.deepEqual(adapter().getCapabilities().altText, { read: true, write: false });
  });
});
