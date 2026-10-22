/**
 * SocialPostMapper — pure functions only, no Graph API calls, no DB
 * access. Normalizes one already-fetched Facebook post
 * (facebookPageDataService.getPagePosts) or Instagram media item
 * (instagramMediaService.getInstagramMedia) into the shared SocialPost
 * shape socialSyncService.js upserts. Kept separate from both the
 * provider fetchers and the sync/persistence layer so the normalization
 * rules themselves — the part most likely to need a small fix as real
 * Meta responses are seen in production — are trivially unit-testable
 * without a network call or a database.
 */

const FACEBOOK_ATTACHMENT_TYPE_MAP = {
  photo: 'image',
  video_inline: 'video',
  video_autoplay: 'video',
  album: 'carousel_album',
  link: 'link',
  share: 'link',
  status: 'status',
};

const INSTAGRAM_MEDIA_TYPE_MAP = {
  IMAGE: 'image',
  VIDEO: 'video',
  CAROUSEL_ALBUM: 'carousel_album',
  REELS: 'reel',
};

/**
 * `account` is the Mongoose SocialAccount document this post came from —
 * only its safe, already-decrypted-getter fields are read here
 * (platformAccountId/platformAccountName), never its accessToken.
 */
export function mapFacebookPost(account, rawPost) {
  return {
    social_account_id: account._id,
    platform: 'facebook',
    externalPostId: rawPost.id,
    accountId: account.platformAccountId,
    accountName: account.platformAccountName || null,
    accountPicture: account.metadata?.picture || null,
    username: null, // Facebook Pages have no separate @username surfaced by this edge
    type: rawPost.attachmentType ? (FACEBOOK_ATTACHMENT_TYPE_MAP[rawPost.attachmentType] || 'other') : (rawPost.message ? 'post' : 'other'),
    text: rawPost.message || null,
    mediaUrl: rawPost.mediaUrl || null,
    thumbnailUrl: rawPost.mediaUrl || null,
    permalink: rawPost.permalink || null,
    status: 'published',
    publishedAt: rawPost.createdTime ? new Date(rawPost.createdTime) : null,
    metrics: {
      // Defensive fallback (?? not ||, so a real 0 is never coerced to
      // null): the real caller (facebookPageDataService.js) always
      // supplies these already-normalized, but the mapper must not
      // silently produce `undefined` if it's ever fed a raw object that
      // omits a field, since `undefined` would serialize as if the field
      // never existed rather than as an explicit "unavailable" null.
      likes: rawPost.likesCount ?? null,
      comments: rawPost.commentsCount ?? null,
      // sharesCount defaults to 0 upstream (Meta's own "absent means
      // zero" behavior for this specific field) — mirrored here.
      shares: rawPost.sharesCount ?? 0,
      views: null, // Meta does not expose a view/reach count on this edge
    },
    rawData: rawPost,
  };
}

export function mapInstagramMedia(account, rawMedia) {
  return {
    social_account_id: account._id,
    platform: 'instagram',
    externalPostId: rawMedia.id,
    accountId: account.platformAccountId,
    accountName: account.platformAccountName || null,
    accountPicture: account.metadata?.profilePicture || null,
    username: account.metadata?.username || null,
    type: rawMedia.mediaType ? (INSTAGRAM_MEDIA_TYPE_MAP[rawMedia.mediaType] || 'other') : 'other',
    text: rawMedia.caption || null,
    mediaUrl: rawMedia.mediaUrl || null,
    thumbnailUrl: rawMedia.thumbnailUrl || rawMedia.mediaUrl || null,
    permalink: rawMedia.permalink || null,
    status: 'published',
    publishedAt: rawMedia.timestamp ? new Date(rawMedia.timestamp) : null,
    metrics: {
      likes: rawMedia.likeCount ?? null,
      comments: rawMedia.commentsCount ?? null,
      shares: null, // not exposed by the Instagram media edge
      views: null, // only present for VIDEO/REELS via insights, out of scope here
    },
    rawData: rawMedia,
  };
}

export default { mapFacebookPost, mapInstagramMedia };
