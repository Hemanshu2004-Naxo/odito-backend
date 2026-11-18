import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import metaApiService from '../metaApiService.js';
import { publish, planPublish } from './instagramAdapter.js';

async function withMockedRequest(request, fn) {
  const original = metaApiService.request;
  metaApiService.request = request;
  try {
    return await fn();
  } finally {
    metaApiService.request = original;
  }
}

const account = { instagramBusinessAccountId: 'ig_1', accessToken: 'token_1' };

// Keep the container-status poll fast for these tests — production default
// stays 1500ms (see instagramAdapter.js's pollIntervalMs()).
before(() => { process.env.INSTAGRAM_CONTAINER_POLL_INTERVAL_MS = '1'; });
after(() => { delete process.env.INSTAGRAM_CONTAINER_POLL_INTERVAL_MS; });

describe('instagramAdapter.publish — validation', () => {
  test('no media at all is rejected with MEDIA_REQUIRED, never sent to Meta', async () => {
    let called = false;
    const result = await withMockedRequest(async () => { called = true; return { success: true, data: {} }; }, () => publish({ account, content: 'x', media: [] }));
    assert.equal(called, false);
    assert.equal(result.error.code, 'MEDIA_REQUIRED');
  });

  test('a carousel of more than 10 items, or with a video, is rejected with MEDIA_NOT_SUPPORTED, never sent to Meta', async () => {
    let called = false;
    const eleven = Array.from({ length: 11 }, (_, i) => ({ url: `https://cdn.example.com/s${i}.jpg`, type: 'image' }));
    const r1 = await withMockedRequest(async () => { called = true; return { success: true, data: {} }; }, () => publish({ account, content: '', media: eleven }));
    const r2 = await withMockedRequest(async () => { called = true; return { success: true, data: {} }; }, () => publish({ account, content: '', media: [{ url: 'https://cdn.example.com/a.jpg', type: 'image' }, { url: 'https://cdn.example.com/b.mp4', type: 'video' }] }));
    assert.equal(called, false);
    assert.equal(r1.error.code, 'MEDIA_NOT_SUPPORTED');
    assert.equal(r2.error.code, 'MEDIA_NOT_SUPPORTED');
  });
});

describe('instagramAdapter.publish — CAROUSEL (child containers, then the parent, then media_publish)', () => {
  const slides = [1, 2, 3].map((n) => ({ url: `https://cdn.example.com/slide-${n}.jpg`, type: 'image' }));
  const scripted = (overrides = {}) => {
    const calls = [];
    let child = 0;
    const fn = async (req) => {
      calls.push(req);
      if (overrides[req.context]) return overrides[req.context](req, calls);
      if (req.context === 'instagram_create_carousel_item') { child += 1; return { success: true, data: { id: `child_${child}` } }; }
      if (req.context === 'instagram_check_container_status') return { success: true, data: { status_code: 'FINISHED' } };
      if (req.context === 'instagram_create_carousel_container') return { success: true, data: { id: 'parent_1' } };
      if (req.context === 'instagram_publish_media') return { success: true, data: { id: 'ig_media_99' } };
      throw new Error(`unexpected ${req.context}`);
    };
    return { calls, fn };
  };

  test('one child container per image (is_carousel_item, in order), the parent CAROUSEL with the children and the caption, then media_publish of the parent', async () => {
    const { calls, fn } = scripted();
    const result = await withMockedRequest(fn, () => publish({ account, content: 'Five signs...', media: slides }));
    assert.deepEqual(result, { success: true, externalPostId: 'ig_media_99', error: null });
    const children = calls.filter((c) => c.context === 'instagram_create_carousel_item');
    assert.deepEqual(children.map((c) => c.params), slides.map((s) => ({ image_url: s.url, is_carousel_item: true })));
    assert.ok(children.every((c) => c.path === '/ig_1/media' && c.method === 'POST' && c.accessToken === 'token_1'));
    const parent = calls.find((c) => c.context === 'instagram_create_carousel_container');
    assert.deepEqual(parent.params, { media_type: 'CAROUSEL', children: 'child_1,child_2,child_3', caption: 'Five signs...' });
    const pub = calls.filter((c) => c.context === 'instagram_publish_media');
    assert.equal(pub.length, 1);
    assert.deepEqual(pub[0].params, { creation_id: 'parent_1' });
    // every container is checked ready before it is used (3 children + the parent)
    assert.equal(calls.filter((c) => c.context === 'instagram_check_container_status').length, 4);
    assert.ok(calls.indexOf(parent) > calls.lastIndexOf(children[2]));
  });

  test('a failed child container stops BEFORE the parent and media_publish: nothing published, not an unknown outcome', async () => {
    const { calls, fn } = scripted({ instagram_create_carousel_item: (req, all) => (all.filter((c) => c.context === 'instagram_create_carousel_item').length === 2 ? { success: false, kind: 'http', status: 400, data: { error: { code: 100, message: 'bad image' } } } : { success: true, data: { id: 'c' } }) });
    const result = await withMockedRequest(fn, () => publish({ account, content: 'x', media: slides }));
    assert.equal(result.success, false);
    assert.notEqual(result.error.outcome, 'unknown');
    assert.equal(calls.some((c) => c.context === 'instagram_create_carousel_container' || c.context === 'instagram_publish_media'), false);
  });

  test('a lost answer from media_publish is an UNKNOWN outcome (it may exist): never a plain failure', async () => {
    const { fn } = scripted({ instagram_publish_media: () => ({ success: false, kind: 'timeout', status: null, data: null }) });
    const result = await withMockedRequest(fn, () => publish({ account, content: 'x', media: slides }));
    assert.equal(result.success, false);
    assert.equal(result.error.outcome, 'unknown');
  });

  test('planPublish (dry run) lists the same calls in order without calling Meta', async () => {
    let called = false;
    const plan = await withMockedRequest(async () => { called = true; return {}; }, () => planPublish({ account, media: slides }));
    assert.equal(called, false);
    assert.deepEqual(plan.map((s) => s.step), ['carousel_item_1', 'carousel_item_2', 'carousel_item_3', 'wait_item_1', 'wait_item_2', 'wait_item_3', 'carousel_container', 'wait_container', 'publish']);
    assert.equal(JSON.stringify(plan).includes('token_1'), false);
  });
});

describe('instagramAdapter.publish — media URL reachability (root-cause regression)', () => {
  // Root cause of a real production failure: a genuine Instagram
  // container-creation call against "http://localhost:5000/storage/..."
  // was rejected by the ACTUAL Meta Graph API as OAuthException code 9004
  // ("Only photo or video can be accepted as media type") for an image
  // that was already a valid, sharp-decoded JPEG — Meta simply cannot
  // reach localhost. This must now be caught before ever calling Meta.
  test('a localhost media URL is rejected with INSTAGRAM_MEDIA_URL_UNREACHABLE, and Meta is never called', async () => {
    let called = false;
    const result = await withMockedRequest(async () => { called = true; return { success: true, data: {} }; },
      () => publish({ account, content: '', media: [{ url: 'http://localhost:5000/storage/social_media/p1/img.jpg', type: 'image' }] }));
    assert.equal(called, false);
    assert.equal(result.error.code, 'INSTAGRAM_MEDIA_URL_UNREACHABLE');
    assert.equal(result.externalPostId, null);
  });

  test('a private-network media URL is also rejected before calling Meta', async () => {
    let called = false;
    const result = await withMockedRequest(async () => { called = true; return { success: true, data: {} }; },
      () => publish({ account, content: '', media: [{ url: 'https://192.168.1.50/storage/img.jpg', type: 'image' }] }));
    assert.equal(called, false);
    assert.equal(result.error.code, 'INSTAGRAM_MEDIA_URL_UNREACHABLE');
  });

  // The exact real Meta error body captured live for publication
  // 6a8962b62ac0f80eae886931 — reproduced here so the classification is
  // tested against Meta's REAL response shape, not an invented one. This
  // fires only for a URL that WAS publicly reachable but that Meta itself
  // still rejected (a genuinely different case than the two tests above,
  // which never reach Meta at all).
  test('a real Meta "wrong media type" rejection (OAuthException code 9004) maps to INSTAGRAM_MEDIA_INVALID, not the generic fallback', async () => {
    const result = await withMockedRequest(async () => ({
      success: false, status: 400,
      data: { error: { message: 'Only photo or video can be accepted as media type', type: 'OAuthException', code: 9004 } },
    }), () => publish({ account, content: '', media: [{ url: 'https://cdn.example.com/photo.jpg', type: 'image' }] }));
    assert.equal(result.error.code, 'INSTAGRAM_MEDIA_INVALID');
  });
});

describe('instagramAdapter.publish — image, container finishes immediately', () => {
  test('creates a container, confirms FINISHED, publishes, and returns the real media id', async () => {
    const calls = [];
    const result = await withMockedRequest(async (req) => {
      calls.push(req);
      if (req.path === '/ig_1/media') return { success: true, status: 200, data: { id: 'container_1' } };
      if (req.path === '/container_1') return { success: true, status: 200, data: { status_code: 'FINISHED' } };
      if (req.path === '/ig_1/media_publish') return { success: true, status: 200, data: { id: 'ig_post_1' } };
      throw new Error(`unexpected path ${req.path}`);
    }, () => publish({ account, content: 'Caption', media: [{ url: 'https://x/photo.png', type: 'image' }] }));

    assert.equal(result.success, true);
    assert.equal(result.externalPostId, 'ig_post_1');
    assert.equal(calls[0].params.image_url, 'https://x/photo.png');
    assert.equal(calls[2].params.creation_id, 'container_1');
  });
});

describe('instagramAdapter.publish — video/reel container needs polling', () => {
  test('polls IN_PROGRESS -> IN_PROGRESS -> FINISHED before publishing (never publishes an unready container)', async () => {
    let statusChecks = 0;
    const result = await withMockedRequest(async (req) => {
      if (req.path === '/ig_1/media') {
        assert.equal(req.params.media_type, 'REELS');
        assert.equal(req.params.video_url, 'https://x/video.mp4');
        return { success: true, status: 200, data: { id: 'container_video_1' } };
      }
      if (req.path === '/container_video_1') {
        statusChecks += 1;
        if (statusChecks < 3) return { success: true, status: 200, data: { status_code: 'IN_PROGRESS' } };
        return { success: true, status: 200, data: { status_code: 'FINISHED' } };
      }
      if (req.path === '/ig_1/media_publish') return { success: true, status: 200, data: { id: 'ig_reel_1' } };
      throw new Error(`unexpected path ${req.path}`);
    }, () => publish({ account, content: '', media: [{ url: 'https://x/video.mp4', type: 'video' }] }));

    assert.equal(statusChecks, 3);
    assert.equal(result.success, true);
    assert.equal(result.externalPostId, 'ig_reel_1');
  });

  test('a container that reports ERROR is failed cleanly, never published', async () => {
    const result = await withMockedRequest(async (req) => {
      if (req.path === '/ig_1/media') return { success: true, status: 200, data: { id: 'container_bad' } };
      if (req.path === '/container_bad') return { success: true, status: 200, data: { status_code: 'ERROR' } };
      throw new Error('media_publish should never be called for an ERROR container');
    }, () => publish({ account, content: '', media: [{ url: 'https://x/video.mp4', type: 'video' }] }));

    assert.equal(result.success, false);
    assert.equal(result.error.code, 'INSTAGRAM_PUBLISH_FAILED');
  });

  test('a container stuck IN_PROGRESS past the poll ceiling times out cleanly (retryable, never hangs forever)', async () => {
    const result = await withMockedRequest(async (req) => {
      if (req.path === '/ig_1/media') return { success: true, status: 200, data: { id: 'container_stuck' } };
      if (req.path === '/container_stuck') return { success: true, status: 200, data: { status_code: 'IN_PROGRESS' } };
      throw new Error('media_publish should never be called for a container that never finished');
    }, () => publish({ account, content: '', media: [{ url: 'https://x/video.mp4', type: 'video' }] }));

    assert.equal(result.success, false);
    assert.equal(result.error.code, 'INSTAGRAM_PROCESSING_TIMEOUT');
  });
});

describe('instagramAdapter.publish — failure mapping', () => {
  test('a missing-permission OAuthException maps to INSTAGRAM_PERMISSION_MISSING, not TOKEN_INVALID', async () => {
    const result = await withMockedRequest(async () => ({
      success: false, status: 403,
      data: { error: { message: '(#200) requires instagram_content_publish permission', type: 'OAuthException', code: 200 } },
    }), () => publish({ account, content: '', media: [{ url: 'https://x/a.png', type: 'image' }] }));
    assert.equal(result.error.code, 'INSTAGRAM_PERMISSION_MISSING');
  });

  test('a 401 creating the container maps to INSTAGRAM_TOKEN_INVALID', async () => {
    const result = await withMockedRequest(async () => ({ success: false, status: 401, data: null, message: 'bad token' }), () => publish({ account, content: '', media: [{ url: 'https://x/a.png', type: 'image' }] }));
    assert.equal(result.error.code, 'INSTAGRAM_TOKEN_INVALID');
    assert.equal(result.externalPostId, null);
  });

  test('an unclassified Meta rejection (not OAuthException, not 401/403/429) falls back to the generic INSTAGRAM_PUBLISH_FAILED, never a false success', async () => {
    const result = await withMockedRequest(async () => ({
      success: false, status: 500,
      data: { error: { message: 'An unknown error occurred', type: 'FacebookApiException', code: 1 } },
    }), () => publish({ account, content: '', media: [{ url: 'https://x/a.png', type: 'image' }] }));
    assert.equal(result.error.code, 'INSTAGRAM_PUBLISH_FAILED');
    assert.equal(result.externalPostId, null);
  });
});
