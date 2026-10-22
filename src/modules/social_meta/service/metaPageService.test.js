import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';

dotenv.config();

import metaApiService from './metaApiService.js';
import { getUserPages } from './metaPageService.js';

/**
 * Facebook Page discovery — added after a real report of "the Page
 * selection modal only shows one Page even though my account manages
 * several". Root-cause investigation found NO filtering, deduplication,
 * or pagination bug anywhere in getUserPages()/getMetaPages() — every
 * Page Meta's /me/accounts response contains is passed through unchanged.
 * These tests prove that precisely: pagination is followed correctly,
 * multiple Pages all survive, and the one genuinely new guard added here
 * (Page-ID deduplication) never drops a real, distinct Page.
 *
 * Same conventions as the rest of this module: real function under test,
 * no mocking library — Meta's real API can't be made to deterministically
 * return "3 Pages across 2 pages of pagination" for a fake token, so
 * metaApiService.request/requestAbsolute are substituted on the shared
 * default-exported object for the duration of each test, always restored
 * in a finally (same technique metaInstagramService.js's own tests use).
 */

async function withMockedMetaApi({ request, requestAbsolute }, fn) {
  const original = { request: metaApiService.request, requestAbsolute: metaApiService.requestAbsolute };
  if (request) metaApiService.request = request;
  if (requestAbsolute) metaApiService.requestAbsolute = requestAbsolute;
  try {
    return await fn();
  } finally {
    metaApiService.request = original.request;
    metaApiService.requestAbsolute = original.requestAbsolute;
  }
}

function fbPage(overrides = {}) {
  return {
    id: overrides.id || 'pg_default',
    name: overrides.name ?? 'Test Page',
    category: overrides.category ?? 'Business',
    access_token: overrides.access_token ?? 'real-page-token',
    tasks: overrides.tasks ?? ['MANAGE'],
    picture: overrides.picture ?? { data: { url: 'https://example.com/pic.jpg' } },
  };
}

describe('getUserPages — Facebook Page discovery', () => {
  test('1: multiple Pages in a single response are ALL returned, none dropped', async () => {
    const result = await withMockedMetaApi(
      { request: async () => ({ success: true, status: 200, data: { data: [fbPage({ id: 'pg_1', name: 'Page One' }), fbPage({ id: 'pg_2', name: 'Page Two' }), fbPage({ id: 'pg_3', name: 'Page Three' })], paging: {} } }) },
      () => getUserPages('fake-user-token'),
    );
    assert.equal(result.success, true);
    assert.equal(result.pages.length, 3);
    assert.deepEqual(result.pages.map((p) => p.id), ['pg_1', 'pg_2', 'pg_3']);
  });

  test('2: pagination is followed — Pages across multiple paging.next responses are all collected', async () => {
    let secondCallUrl = null;
    const result = await withMockedMetaApi(
      {
        request: async () => ({
          success: true,
          status: 200,
          data: { data: [fbPage({ id: 'pg_page1_a' }), fbPage({ id: 'pg_page1_b' })], paging: { next: 'https://graph.facebook.com/v21.0/me/accounts?after=CURSOR1' } },
        }),
        requestAbsolute: async ({ url }) => {
          secondCallUrl = url;
          return { success: true, status: 200, data: { data: [fbPage({ id: 'pg_page2_a' })], paging: {} } };
        },
      },
      () => getUserPages('fake-user-token'),
    );
    assert.equal(result.success, true);
    assert.equal(result.pages.length, 3, 'Pages from BOTH the first response and the paginated follow-up must be present');
    assert.deepEqual(result.pages.map((p) => p.id), ['pg_page1_a', 'pg_page1_b', 'pg_page2_a']);
    assert.equal(secondCallUrl, 'https://graph.facebook.com/v21.0/me/accounts?after=CURSOR1', 'pagination must follow the exact paging.next URL Meta returned, not a reconstructed one');
  });

  test('3: exactly one Page in the response is a normal result, not treated as an error or truncated further', async () => {
    const result = await withMockedMetaApi(
      { request: async () => ({ success: true, status: 200, data: { data: [fbPage({ id: 'pg_only_one', name: 'Nashik City Guide' })], paging: {} } }) },
      () => getUserPages('fake-user-token'),
    );
    assert.equal(result.success, true);
    assert.equal(result.pages.length, 1);
    assert.equal(result.pages[0].name, 'Nashik City Guide');
  });

  test('4: an empty Page list is a normal, successful result — never an error', async () => {
    const result = await withMockedMetaApi(
      { request: async () => ({ success: true, status: 200, data: { data: [], paging: {} } }) },
      () => getUserPages('fake-user-token'),
    );
    assert.equal(result.success, true);
    assert.deepEqual(result.pages, []);
    assert.equal(result.error, null);
  });

  test('5: a duplicate Page ID across pagination responses is de-duplicated, not shown twice', async () => {
    const result = await withMockedMetaApi(
      {
        request: async () => ({
          success: true,
          status: 200,
          data: { data: [fbPage({ id: 'pg_dup', name: 'Duplicate Page' })], paging: { next: 'https://graph.facebook.com/v21.0/me/accounts?after=CURSOR' } },
        }),
        requestAbsolute: async () => ({
          success: true,
          status: 200,
          // The same Page ID reachable a second time (e.g. via an
          // overlapping Business Portfolio grant) — a real Meta behavior,
          // not a hypothetical.
          data: { data: [fbPage({ id: 'pg_dup', name: 'Duplicate Page' }), fbPage({ id: 'pg_unique', name: 'Unique Page' })], paging: {} },
        }),
      },
      () => getUserPages('fake-user-token'),
    );
    assert.equal(result.success, true);
    assert.equal(result.pages.length, 2, 'the duplicate must collapse to one entry, the genuinely different Page must still be present');
    assert.deepEqual(result.pages.map((p) => p.id).sort(), ['pg_dup', 'pg_unique']);
  });

  test('6: a missing-permissions (401/403) response is classified as META_PAGE_ACCESS_DENIED, not a generic failure', async () => {
    const result = await withMockedMetaApi(
      { request: async () => ({ success: false, status: 403, data: null, message: 'simulated permission error' }) },
      () => getUserPages('fake-user-token'),
    );
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'META_PAGE_ACCESS_DENIED');
    assert.deepEqual(result.pages, []);
  });

  test('7: a generic Meta API error (e.g. 500/network) is classified as META_PAGES_FETCH_FAILED, never silently returns partial/fake data', async () => {
    const result = await withMockedMetaApi(
      { request: async () => ({ success: false, status: 500, data: null, message: 'simulated server error' }) },
      () => getUserPages('fake-user-token'),
    );
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'META_PAGES_FETCH_FAILED');
  });

  test('8: the Page access token is never exposed in the raw discovery log (accessToken presence is logged as a boolean only)', async () => {
    const realToken = 'super-secret-page-token-value';
    const originalLog = console.log;
    const captured = [];
    console.log = (...args) => { captured.push(args.join(' ')); };
    try {
      await withMockedMetaApi(
        { request: async () => ({ success: true, status: 200, data: { data: [fbPage({ id: 'pg_log_check', access_token: realToken })], paging: {} } }) },
        () => getUserPages('fake-user-token'),
      );
    } finally {
      console.log = originalLog;
    }
    const logText = captured.join('\n');
    assert.ok(logText.includes('META_PAGES_DISCOVERED'), 'the diagnostic log must fire');
    assert.ok(!logText.includes(realToken), 'the real Page token must never appear in the discovery log');
    assert.ok(logText.includes('"hasAccessToken":true'), 'presence must be logged as a boolean, not the value');
  });

  test('9: a Page with an empty tasks array is still returned (limited task-based access is not the same as "no access")', async () => {
    const result = await withMockedMetaApi(
      { request: async () => ({ success: true, status: 200, data: { data: [fbPage({ id: 'pg_limited_tasks', tasks: [] })], paging: {} } }) },
      () => getUserPages('fake-user-token'),
    );
    assert.equal(result.success, true);
    assert.equal(result.pages.length, 1);
    assert.deepEqual(result.pages[0].tasks, []);
  });
});
