import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import metaApiService from '../metaApiService.js';
import { publish, remove } from './facebookAdapter.js';

/**
 * metaApiService.request is substituted on its shared default-exported
 * object for the duration of each test — the same technique
 * metaPageService.test.js already uses — so these tests exercise the REAL
 * facebookAdapter.publish() logic (which endpoint/params it builds for
 * text vs. image vs. video, how it extracts the id, how it maps failures)
 * without ever making a real Meta API call.
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

const account = { pageId: 'pg_1', accessToken: 'token_1' };

describe('facebookAdapter.publish — text', () => {
  test('a text-only post calls /{pageId}/feed and returns the real Meta post id', async () => {
    let calledPath;
    const result = await withMockedRequest(async ({ path, params }) => {
      calledPath = path;
      assert.equal(params.message, 'Hello world');
      return { success: true, status: 200, data: { id: 'pg_1_post_1' } };
    }, () => publish({ account, content: 'Hello world', media: [] }));

    assert.equal(calledPath, '/pg_1/feed');
    assert.equal(result.success, true);
    assert.equal(result.externalPostId, 'pg_1_post_1');
  });

  test('empty text with no media is rejected with CONTENT_REQUIRED, never sent to Meta', async () => {
    let called = false;
    const result = await withMockedRequest(async () => { called = true; return { success: true, data: {} }; }, () => publish({ account, content: '  ', media: [] }));
    assert.equal(called, false);
    assert.equal(result.error.code, 'CONTENT_REQUIRED');
  });
});

describe('facebookAdapter.publish — image', () => {
  test('an image post calls /{pageId}/photos with the real media URL, and prefers post_id over id', async () => {
    let calledPath, calledParams;
    const result = await withMockedRequest(async ({ path, params }) => {
      calledPath = path; calledParams = params;
      return { success: true, status: 200, data: { id: 'photo_1', post_id: 'pg_1_post_2' } };
    }, () => publish({ account, content: 'Caption', media: [{ url: 'https://backend.example.com/storage/social_media/p1/img.png', type: 'image' }] }));

    assert.equal(calledPath, '/pg_1/photos');
    assert.equal(calledParams.url, 'https://backend.example.com/storage/social_media/p1/img.png');
    assert.equal(calledParams.caption, 'Caption');
    assert.equal(calledParams.published, true);
    assert.equal(result.success, true);
    assert.equal(result.externalPostId, 'pg_1_post_2'); // post_id, not the photo id
  });

  test('an image post with NO caption is still allowed (Facebook photo posts do not require text)', async () => {
    const result = await withMockedRequest(async () => ({ success: true, status: 200, data: { id: 'photo_2', post_id: 'pg_1_post_3' } }), () => publish({ account, content: '', media: [{ url: 'https://x/img.png', type: 'image' }] }));
    assert.equal(result.success, true);
  });

  test('falls back to `id` when Meta omits post_id', async () => {
    const result = await withMockedRequest(async () => ({ success: true, status: 200, data: { id: 'photo_only' } }), () => publish({ account, content: '', media: [{ url: 'https://x/img.png', type: 'image' }] }));
    assert.equal(result.externalPostId, 'photo_only');
  });

  test('a multi-photo post with more than 10 images, or with a video, is rejected with MEDIA_NOT_SUPPORTED, never sent to Meta', async () => {
    let called = false;
    const eleven = Array.from({ length: 11 }, (_, i) => ({ url: `https://cdn.example.com/s${i}.jpg`, type: 'image' }));
    const r1 = await withMockedRequest(async () => { called = true; return { success: true, data: {} }; }, () => publish({ account, content: '', media: eleven }));
    const r2 = await withMockedRequest(async () => { called = true; return { success: true, data: {} }; }, () => publish({ account, content: '', media: [{ url: 'https://cdn.example.com/a.jpg', type: 'image' }, { url: 'https://cdn.example.com/b.mp4', type: 'video' }] }));
    assert.equal(called, false);
    assert.equal(r1.error.code, 'MEDIA_NOT_SUPPORTED');
    assert.equal(r2.error.code, 'MEDIA_NOT_SUPPORTED');
  });
});

describe('facebookAdapter.publish — MULTI-PHOTO post (unpublished photos, then one /feed post)', () => {
  const slides = [1, 2, 3].map((n) => ({ url: `https://cdn.example.com/slide-${n}.jpg`, type: 'image' }));
  test('every image uploaded UNPUBLISHED in order, then ONE /feed post with the caption and attached_media in the same order', async () => {
    const calls = [];
    let n = 0;
    const result = await withMockedRequest(async (req) => {
      calls.push(req);
      if (req.context === 'facebook_upload_unpublished_photo') { n += 1; return { success: true, data: { id: `photo_${n}` } }; }
      if (req.context === 'facebook_publish_multi_photo') return { success: true, data: { id: 'page_1_post_7' } };
      throw new Error(req.context);
    }, () => publish({ account, content: 'Five signs...', media: slides }));
    assert.deepEqual(result, { success: true, externalPostId: 'page_1_post_7', error: null });
    const uploads = calls.filter((c) => c.context === 'facebook_upload_unpublished_photo');
    assert.deepEqual(uploads.map((c) => c.params), slides.map((s) => ({ url: s.url, published: false })));
    const feed = calls.filter((c) => c.context === 'facebook_publish_multi_photo');
    assert.equal(feed.length, 1);
    assert.match(feed[0].path, /\/feed$/);
    assert.deepEqual(feed[0].params, { message: 'Five signs...', 'attached_media[0]': '{"media_fbid":"photo_1"}', 'attached_media[1]': '{"media_fbid":"photo_2"}', 'attached_media[2]': '{"media_fbid":"photo_3"}' });
  });

  test('a failed upload stops before the /feed post (nothing visible was published, not unknown); a lost /feed answer IS unknown', async () => {
    const calls = [];
    const r1 = await withMockedRequest(async (req) => { calls.push(req); return req.context === 'facebook_upload_unpublished_photo' && calls.length === 2 ? { success: false, kind: 'http', status: 400, data: { error: { code: 324, message: 'bad' } } } : { success: true, data: { id: 'p' } }; }, () => publish({ account, content: 'x', media: slides }));
    assert.equal(r1.success, false);
    assert.notEqual(r1.error.outcome, 'unknown');
    assert.equal(calls.some((c) => c.context === 'facebook_publish_multi_photo'), false);
    const r2 = await withMockedRequest(async (req) => (req.context === 'facebook_publish_multi_photo' ? { success: false, kind: 'timeout', status: null, data: null } : { success: true, data: { id: 'p' } }), () => publish({ account, content: 'x', media: slides }));
    assert.equal(r2.error.outcome, 'unknown');
  });
});

describe('facebookAdapter.publish — media URL reachability', () => {
  test('a localhost media URL is rejected with FACEBOOK_MEDIA_URL_UNREACHABLE before ever calling Meta', async () => {
    let called = false;
    const result = await withMockedRequest(async () => { called = true; return { success: true, data: {} }; },
      () => publish({ account, content: '', media: [{ url: 'http://localhost:5000/storage/social_media/p1/img.jpg', type: 'image' }] }));
    assert.equal(called, false);
    assert.equal(result.error.code, 'FACEBOOK_MEDIA_URL_UNREACHABLE');
  });

  test('a plain-http (non-HTTPS) media URL is also rejected before calling Meta', async () => {
    let called = false;
    const result = await withMockedRequest(async () => { called = true; return { success: true, data: {} }; },
      () => publish({ account, content: '', media: [{ url: 'http://not-https.example.com/img.jpg', type: 'image' }] }));
    assert.equal(called, false);
    assert.equal(result.error.code, 'FACEBOOK_MEDIA_URL_UNREACHABLE');
  });
});

describe('facebookAdapter.publish — video', () => {
  test('a video post calls /{pageId}/videos with file_url and description', async () => {
    let calledPath, calledParams;
    const result = await withMockedRequest(async ({ path, params }) => {
      calledPath = path; calledParams = params;
      return { success: true, status: 200, data: { id: 'video_1' } };
    }, () => publish({ account, content: 'A real video', media: [{ url: 'https://backend.example.com/storage/social_media/p1/v.mp4', type: 'video' }] }));

    assert.equal(calledPath, '/pg_1/videos');
    assert.equal(calledParams.file_url, 'https://backend.example.com/storage/social_media/p1/v.mp4');
    assert.equal(calledParams.description, 'A real video');
    assert.equal(result.success, true);
    assert.equal(result.externalPostId, 'video_1');
  });
});

describe('facebookAdapter.publish — failure mapping', () => {
  // Both of these are REAL error bodies captured live against the actual
  // Graph API (a Page token connected before pages_manage_posts was added
  // to metaOAuthService.js's scope list) — not invented shapes.
  test('a missing-permission OAuthException on /feed (403, code 200) maps to FACEBOOK_PERMISSION_MISSING, not TOKEN_INVALID', async () => {
    const result = await withMockedRequest(async () => ({
      success: false, status: 403,
      data: { error: { message: '(#200) If posting to a page, requires both pages_read_engagement and pages_manage_posts as an admin with sufficient administrative permission', type: 'OAuthException', code: 200 } },
    }), () => publish({ account, content: 'x', media: [] }));
    assert.equal(result.error.code, 'FACEBOOK_PERMISSION_MISSING');
  });

  test('a missing-permission OAuthException on /videos (400, code 100) ALSO maps to FACEBOOK_PERMISSION_MISSING, not the generic fallback', async () => {
    const result = await withMockedRequest(async () => ({
      success: false, status: 400,
      data: { error: { message: '(#100) No permission to publish the video', type: 'OAuthException', code: 100 } },
    }), () => publish({ account, content: '', media: [{ url: 'https://x/v.mp4', type: 'video' }] }));
    assert.equal(result.error.code, 'FACEBOOK_PERMISSION_MISSING');
  });

  test('a 401/403 from Meta maps to FACEBOOK_TOKEN_INVALID, never a false success', async () => {
    const result = await withMockedRequest(async () => ({ success: false, status: 401, data: null, message: 'Invalid token' }), () => publish({ account, content: 'x', media: [] }));
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'FACEBOOK_TOKEN_INVALID');
    assert.equal(result.externalPostId, null);
  });

  test('a 429 from Meta maps to FACEBOOK_RATE_LIMITED', async () => {
    const result = await withMockedRequest(async () => ({ success: false, status: 429, data: null, message: 'Rate limited' }), () => publish({ account, content: 'x', media: [] }));
    assert.equal(result.error.code, 'FACEBOOK_RATE_LIMITED');
  });

  test('a malformed success response (no id at all) is never a fabricated success — it is an UNKNOWN outcome (Meta said OK, so the post may exist)', async () => {
    const result = await withMockedRequest(async () => ({ success: true, status: 200, data: {} }), () => publish({ account, content: 'x', media: [] }));
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'PUBLISH_OUTCOME_UNKNOWN');
    assert.equal(result.error.outcome, 'unknown');
  });

  test('a Meta "wrong media type" OAuthException maps to FACEBOOK_MEDIA_INVALID, not the generic fallback', async () => {
    const result = await withMockedRequest(async () => ({
      success: false, status: 400,
      data: { error: { message: 'Only photo or video can be accepted as media type', type: 'OAuthException', code: 9004 } },
    }), () => publish({ account, content: '', media: [{ url: 'https://cdn.example.com/photo.jpg', type: 'image' }] }));
    assert.equal(result.error.code, 'FACEBOOK_MEDIA_INVALID');
  });
});

describe('facebookAdapter.remove — real external deletion of a published Page post', () => {
  test('calls DELETE /{externalPostId} with the Page access token, never the pageId or any Odito id', async () => {
    let calledMethod, calledPath, calledToken;
    const result = await withMockedRequest(async ({ method, path, accessToken }) => {
      calledMethod = method; calledPath = path; calledToken = accessToken;
      return { success: true, status: 200, data: { success: true } };
    }, () => remove({ account, externalPostId: 'pg_1_post_2' }));

    assert.equal(calledMethod, 'DELETE');
    assert.equal(calledPath, '/pg_1_post_2');
    assert.equal(calledToken, 'token_1');
    assert.equal(result.success, true);
    assert.equal(result.alreadyDeleted, false);
  });

  test('a real Meta "object does not exist" error (GraphMethodException, code 100, subcode 33) is treated as an idempotent success', async () => {
    const result = await withMockedRequest(async () => ({
      success: false, status: 400,
      data: { error: { message: 'Unsupported get request. Object with ID \'pg_1_post_2\' does not exist, cannot be loaded due to missing permissions, or does not support this operation.', type: 'GraphMethodException', code: 100, error_subcode: 33, fbtrace_id: 'AbC123' } },
    }), () => remove({ account, externalPostId: 'pg_1_post_2' }));

    assert.equal(result.success, true);
    assert.equal(result.alreadyDeleted, true);
    assert.equal(result.error, null);
  });

  test('GraphMethodException with code 100 but NO error_subcode is still treated as idempotent (subcode is documentation context, not the actual match condition)', async () => {
    const result = await withMockedRequest(async () => ({
      success: false, status: 400,
      data: { error: { message: 'Unsupported get request.', type: 'GraphMethodException', code: 100 } },
    }), () => remove({ account, externalPostId: 'pg_1_post_2' }));
    assert.equal(result.success, true);
    assert.equal(result.alreadyDeleted, true);
  });

  test('a GraphMethodException with a DIFFERENT code is NOT treated as idempotent — a real failure', async () => {
    const result = await withMockedRequest(async () => ({
      success: false, status: 400,
      data: { error: { message: 'Some other graph method problem', type: 'GraphMethodException', code: 200 } },
    }), () => remove({ account, externalPostId: 'pg_1_post_2' }));
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'FACEBOOK_DELETE_FAILED');
  });

  test('a missing-permission OAuthException maps to FACEBOOK_PERMISSION_MISSING', async () => {
    const result = await withMockedRequest(async () => ({
      success: false, status: 403,
      data: { error: { message: '(#200) If posting to a page, requires both pages_read_engagement and pages_manage_posts as an admin with sufficient administrative permission', type: 'OAuthException', code: 200 } },
    }), () => remove({ account, externalPostId: 'pg_1_post_2' }));
    assert.equal(result.error.code, 'FACEBOOK_PERMISSION_MISSING');
  });

  test('a 401/403 from Meta maps to FACEBOOK_TOKEN_INVALID, never a false success', async () => {
    const result = await withMockedRequest(async () => ({ success: false, status: 401, data: null, message: 'Invalid token' }), () => remove({ account, externalPostId: 'pg_1_post_2' }));
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'FACEBOOK_TOKEN_INVALID');
  });

  test('a 429 from Meta maps to FACEBOOK_RATE_LIMITED', async () => {
    const result = await withMockedRequest(async () => ({ success: false, status: 429, data: null, message: 'Rate limited' }), () => remove({ account, externalPostId: 'pg_1_post_2' }));
    assert.equal(result.error.code, 'FACEBOOK_RATE_LIMITED');
  });

  test('an unrecognized failure falls back to FACEBOOK_DELETE_FAILED, never a fabricated success', async () => {
    const result = await withMockedRequest(async () => ({ success: false, status: 500, data: null, message: 'Unexpected' }), () => remove({ account, externalPostId: 'pg_1_post_2' }));
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'FACEBOOK_DELETE_FAILED');
  });
});
