import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mapFacebookPost, mapInstagramMedia } from './socialPostMapper.js';

function fakeAccount(overrides = {}) {
  return {
    _id: 'acct-1',
    platform: overrides.platform || 'facebook',
    platformAccountId: overrides.platformAccountId || 'page-123',
    platformAccountName: overrides.platformAccountName ?? 'Test Account',
    metadata: overrides.metadata ?? {},
  };
}

describe('mapFacebookPost — pure normalization, no network/DB', () => {
  test('maps a full post (photo attachment, all engagement summaries present)', () => {
    const account = fakeAccount();
    const raw = {
      id: 'post-1',
      message: 'Hello world',
      createdTime: '2026-08-01T12:00:00+0000',
      permalink: 'https://facebook.com/post-1',
      attachmentType: 'photo',
      mediaUrl: 'https://example.com/img.jpg',
      likesCount: 10,
      commentsCount: 2,
      sharesCount: 3,
    };
    const mapped = mapFacebookPost(account, raw);

    assert.equal(mapped.platform, 'facebook');
    assert.equal(mapped.externalPostId, 'post-1');
    assert.equal(mapped.accountId, 'page-123');
    assert.equal(mapped.accountName, 'Test Account');
    assert.equal(mapped.type, 'image');
    assert.equal(mapped.text, 'Hello world');
    assert.equal(mapped.mediaUrl, 'https://example.com/img.jpg');
    assert.equal(mapped.permalink, 'https://facebook.com/post-1');
    assert.equal(mapped.status, 'published');
    assert.ok(mapped.publishedAt instanceof Date);
    assert.deepEqual(mapped.metrics, { likes: 10, comments: 2, shares: 3, views: null });
  });

  test('a post with no message and no attachment maps to type "other", never crashes', () => {
    const mapped = mapFacebookPost(fakeAccount(), { id: 'post-2', createdTime: null });
    assert.equal(mapped.type, 'other');
    assert.equal(mapped.text, null);
    assert.equal(mapped.publishedAt, null);
  });

  test('a text-only post with no attachment maps to type "post"', () => {
    const mapped = mapFacebookPost(fakeAccount(), { id: 'post-3', message: 'Just text', createdTime: '2026-08-01T00:00:00+0000' });
    assert.equal(mapped.type, 'post');
  });

  test('missing likes/comments summaries stay null (unavailable), never fabricated as 0', () => {
    const mapped = mapFacebookPost(fakeAccount(), { id: 'post-4', likesCount: null, commentsCount: null, sharesCount: 0 });
    assert.equal(mapped.metrics.likes, null);
    assert.equal(mapped.metrics.comments, null);
    // sharesCount:0 IS a real, Meta-confirmed zero (see facebookPageDataService.js) — must render as 0, not null.
    assert.equal(mapped.metrics.shares, 0);
  });

  test('an unrecognized attachment type falls back to "other" rather than throwing', () => {
    const mapped = mapFacebookPost(fakeAccount(), { id: 'post-5', attachmentType: 'native_templates' });
    assert.equal(mapped.type, 'other');
  });

  // The exact getPagePosts() output shape captured LIVE from the real
  // connected "Nashik City Guide" Page during the investigation into
  // "Overview shows 6 posts but Feeds shows 0" — proves the mapper
  // correctly handles a genuine, real Meta response end to end, not just
  // synthetic fixtures.
  test('maps the real getPagePosts() output shape captured live from a connected Page, unchanged', () => {
    const account = fakeAccount({ platformAccountId: '934617193060229', platformAccountName: 'Nashik City Guide' });
    const raw = {
      id: '934617193060229_122142978651150961',
      message: 'Proud to be Indian. Proud to be Nashikkar.',
      createdTime: '2026-08-15T04:30:15+0000',
      updatedTime: '2026-08-15T04:30:15+0000',
      permalink: 'https://www.facebook.com/122143560045150961/posts/122142978651150961',
      fullPicture: 'https://scontent.fpnq7-2.fna.fbcdn.net/v/t51.82787-15/example.jpg',
      attachmentType: 'photo',
      mediaUrl: 'https://scontent.fpnq7-2.fna.fbcdn.net/v/t51.82787-15/example.jpg',
      likesCount: 3,
      commentsCount: 0,
      sharesCount: 0,
    };
    const mapped = mapFacebookPost(account, raw);
    assert.equal(mapped.externalPostId, '934617193060229_122142978651150961');
    assert.equal(mapped.type, 'image');
    assert.equal(mapped.status, 'published');
    assert.ok(mapped.publishedAt instanceof Date);
    assert.equal(mapped.permalink, raw.permalink);
    assert.deepEqual(mapped.metrics, { likes: 3, comments: 0, shares: 0, views: null });
  });
});

describe('mapInstagramMedia — pure normalization, no network/DB', () => {
  test('maps an IMAGE item', () => {
    const account = fakeAccount({ platform: 'instagram', platformAccountId: 'ig-1', metadata: { username: 'test_biz' } });
    const raw = {
      id: 'media-1',
      caption: 'Nice photo',
      mediaType: 'IMAGE',
      mediaUrl: 'https://example.com/photo.jpg',
      permalink: 'https://instagram.com/p/media-1',
      timestamp: '2026-08-01T12:00:00+0000',
      likeCount: 20,
      commentsCount: 5,
    };
    const mapped = mapInstagramMedia(account, raw);

    assert.equal(mapped.platform, 'instagram');
    assert.equal(mapped.externalPostId, 'media-1');
    assert.equal(mapped.username, 'test_biz');
    assert.equal(mapped.type, 'image');
    assert.equal(mapped.text, 'Nice photo');
    assert.equal(mapped.mediaUrl, 'https://example.com/photo.jpg');
    assert.deepEqual(mapped.metrics, { likes: 20, comments: 5, shares: null, views: null });
  });

  test('maps a CAROUSEL_ALBUM item', () => {
    const mapped = mapInstagramMedia(fakeAccount({ platform: 'instagram' }), { id: 'media-2', mediaType: 'CAROUSEL_ALBUM' });
    assert.equal(mapped.type, 'carousel_album');
  });

  test('a VIDEO item still processing (no media_url yet) maps safely with null mediaUrl, never throws', () => {
    const mapped = mapInstagramMedia(fakeAccount({ platform: 'instagram' }), { id: 'media-3', mediaType: 'VIDEO', mediaUrl: null, thumbnailUrl: null });
    assert.equal(mapped.type, 'video');
    assert.equal(mapped.mediaUrl, null);
  });

  test('a missing caption/likeCount/commentsCount all map to null, never fabricated', () => {
    const mapped = mapInstagramMedia(fakeAccount({ platform: 'instagram' }), { id: 'media-4', mediaType: 'IMAGE' });
    assert.equal(mapped.text, null);
    assert.equal(mapped.metrics.likes, null);
    assert.equal(mapped.metrics.comments, null);
  });

  test('an unrecognized media type falls back to "other" rather than throwing', () => {
    const mapped = mapInstagramMedia(fakeAccount({ platform: 'instagram' }), { id: 'media-5', mediaType: 'STORY' });
    assert.equal(mapped.type, 'other');
  });
});
