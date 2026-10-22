import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import metaApiService from './metaApiService.js';
import { getPagePosts } from './facebookPageDataService.js';

/**
 * Added while debugging a real report: "Facebook posts are not appearing
 * in the Feeds page while Instagram syncs correctly." Traced live against
 * the actual connected Page/token (not guessed): a direct Graph API call
 * with this file's exact field set at limit:25 returned 16 real posts
 * (200 OK); the SAME call at limit:50 (socialSyncService.js's old
 * SYNC_BATCH_LIMIT) failed outright — status 500, Meta error code 1,
 * "Please reduce the amount of data you're asking for, then retry your
 * request". `normalizeFailure` was collapsing that specific, actionable
 * Meta error into a generic FACEBOOK_DATA_FETCH_FAILED, which is what
 * these tests exist to prevent from happening silently again. Instagram
 * was never affected — its media fields are flat scalars
 * (like_count/comments_count), not nested summary-edge expansions, so it
 * never hits this complexity ceiling.
 *
 * No mocking library exists in this repo — metaApiService.request is
 * substituted on its shared default-exported object for the duration of
 * each test (same technique metaPageService.test.js already uses),
 * always restored in a finally.
 */

async function withMockedRequest(request, fn) {
  const original = metaApiService.request;
  metaApiService.request = request;
  try {
    return await fn();
  } finally {
    metaApiService.request = original;
  }
}

function fbPostEntry(overrides = {}) {
  return {
    id: overrides.id || 'pg_1_post_1',
    message: overrides.message ?? 'Hello world',
    created_time: overrides.created_time ?? '2026-08-01T00:00:00+0000',
    updated_time: overrides.updated_time ?? '2026-08-01T00:00:00+0000',
    permalink_url: overrides.permalink_url ?? 'https://facebook.com/post/1',
    full_picture: overrides.full_picture ?? 'https://example.com/pic.jpg',
    attachments: overrides.attachments ?? { data: [{ media_type: 'photo', type: 'photo', url: 'https://facebook.com/photo.php?fbid=1' }] },
    likes: overrides.likes ?? { summary: { total_count: 5 } },
    comments: overrides.comments ?? { summary: { total_count: 2 } },
    shares: overrides.shares,
  };
}

describe('getPagePosts', () => {
  test('1: a successful fetch returns real posts with likes/comments summaries mapped through', async () => {
    await withMockedRequest(async () => ({
      success: true, status: 200,
      data: { data: [fbPostEntry({ id: 'p1' })], paging: { cursors: { after: 'CURSOR_1' } } },
      message: null,
    }), async () => {
      const result = await getPagePosts('pg_1', 'token', { limit: 25 });
      assert.equal(result.success, true);
      assert.equal(result.posts.length, 1);
      assert.equal(result.posts[0].id, 'p1');
      assert.equal(result.posts[0].likesCount, 5);
      assert.equal(result.posts[0].commentsCount, 2);
      assert.equal(result.nextCursor, 'CURSOR_1');
    });
  });

  test('2: an empty response (a Page with zero posts) is a normal success, not an error', async () => {
    await withMockedRequest(async () => ({ success: true, status: 200, data: { data: [], paging: null }, message: null }), async () => {
      const result = await getPagePosts('pg_1', 'token');
      assert.equal(result.success, true);
      assert.deepEqual(result.posts, []);
      assert.equal(result.nextCursor, null);
    });
  });

  test('3: a 401 is classified as FACEBOOK_TOKEN_INVALID', async () => {
    await withMockedRequest(async () => ({ success: false, status: 401, data: { error: { message: 'denied', code: 190, type: 'OAuthException' } }, message: 'denied' }), async () => {
      const result = await getPagePosts('pg_1', 'token');
      assert.equal(result.success, false);
      assert.equal(result.error.code, 'FACEBOOK_TOKEN_INVALID');
      assert.deepEqual(result.posts, []);
    });
  });

  test('4: a 403 is also classified as FACEBOOK_TOKEN_INVALID', async () => {
    await withMockedRequest(async () => ({ success: false, status: 403, data: { error: { message: 'forbidden', code: 200, type: 'OAuthException' } }, message: 'forbidden' }), async () => {
      const result = await getPagePosts('pg_1', 'token');
      assert.equal(result.error.code, 'FACEBOOK_TOKEN_INVALID');
    });
  });

  test('5: an invalid Page ID (Meta "Unsupported get request" / unknown object) is a real failure, not silently zero posts', async () => {
    await withMockedRequest(async () => ({
      success: false, status: 400,
      data: { error: { message: 'Unsupported get request. Object with ID \'bad_id\' does not exist', code: 100, type: 'GraphMethodException' } },
      message: 'Unsupported get request.',
    }), async () => {
      const result = await getPagePosts('bad_id', 'token');
      assert.equal(result.success, false);
      assert.equal(result.error.code, 'FACEBOOK_DATA_FETCH_FAILED');
    });
  });

  test('6: Meta\'s real "reduce the amount of data" complexity-limit error is classified distinctly (FACEBOOK_REQUEST_TOO_LARGE), not collapsed into a generic failure — this is the exact bug that hid Facebook posts', async () => {
    await withMockedRequest(async () => ({
      success: false, status: 500,
      data: { error: { message: "Please reduce the amount of data you're asking for, then retry your request", code: 1, type: 'OAuthException' } },
      message: "Please reduce the amount of data you're asking for, then retry your request",
    }), async () => {
      const result = await getPagePosts('pg_1', 'token', { limit: 50 });
      assert.equal(result.success, false);
      assert.equal(result.error.code, 'FACEBOOK_REQUEST_TOO_LARGE');
      assert.deepEqual(result.posts, []);
    });
  });

  test('7: a generic/unrecognized Meta error still classifies as FACEBOOK_DATA_FETCH_FAILED, never crashes', async () => {
    await withMockedRequest(async () => ({ success: false, status: 500, data: { error: { message: 'Something else', code: 2, type: 'APIException' } }, message: 'Something else' }), async () => {
      const result = await getPagePosts('pg_1', 'token');
      assert.equal(result.error.code, 'FACEBOOK_DATA_FETCH_FAILED');
    });
  });

  test('8: a post missing every optional field (no message, no attachments, no likes/comments summary, no shares) is still mapped, never dropped', async () => {
    await withMockedRequest(async () => ({
      success: true, status: 200,
      data: { data: [{ id: 'p_minimal', created_time: '2026-08-01T00:00:00+0000' }] },
      message: null,
    }), async () => {
      const result = await getPagePosts('pg_1', 'token');
      assert.equal(result.success, true);
      assert.equal(result.posts.length, 1);
      const post = result.posts[0];
      assert.equal(post.id, 'p_minimal');
      assert.equal(post.message, null);
      assert.equal(post.attachmentType, null);
      assert.equal(post.mediaUrl, null);
      assert.equal(post.likesCount, null);
      assert.equal(post.commentsCount, null);
      // sharesCount is the one field where "absent" is a real, confirmed 0, not "unavailable" — see the field's own comment.
      assert.equal(post.sharesCount, 0);
    });
  });

  test('9: the `after` cursor is passed through as a request param when paginating', async () => {
    let capturedParams = null;
    await withMockedRequest(async ({ params }) => {
      capturedParams = params;
      return { success: true, status: 200, data: { data: [] }, message: null };
    }, () => getPagePosts('pg_1', 'token', { limit: 25, after: 'CURSOR_ABC' }));
    assert.equal(capturedParams.after, 'CURSOR_ABC');
    assert.equal(capturedParams.limit, 25);
  });

  test('10: the access token is never present anywhere in a returned result', async () => {
    await withMockedRequest(async () => ({ success: true, status: 200, data: { data: [fbPostEntry()] } }), async () => {
      const result = await getPagePosts('pg_1', 'super-secret-real-token-value');
      assert.ok(!JSON.stringify(result).includes('super-secret-real-token-value'));
    });
  });
});
