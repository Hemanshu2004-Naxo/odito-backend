// Called through the default-exported object (not named imports) so
// tests can substitute request() for the duration of one test — same
// reasoning as facebookPageDataService.js's/metaPageService.js's
// identical choice: this repo has no mocking library, and Meta will
// never deterministically reproduce a specific response for a fake token.
import metaApiService from './metaApiService.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { isAuthenticationFailure } from './metaErrorClassifier.js';

/**
 * InstagramMediaService — the Graph-API-only layer for a connected
 * Instagram Business/Creator account's own data: media (the Feeds page),
 * account fields, and Insights (the Overview dashboard). Kept separate
 * from metaPageService.js (Instagram DISCOVERY — the Page -> Instagram
 * link and initial profile lookup) for the same reason
 * facebookPageDataService.js is kept separate from metaPageService.js's
 * Facebook Page discovery: this reads FROM an already-discovered account
 * using its already-stored token, no DB access here. Mirrors
 * facebookPageDataService.js's exact role, one file per platform.
 */

// children{...} is only populated for CAROUSEL_ALBUM items and is the
// only way to get at each individual slide's own media_url — the parent
// item's own media_url for a carousel is not a real image and should not
// be used as one.
const MEDIA_FIELDS = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count,children{media_type,media_url,thumbnail_url}';

/**
 * Fetches recent media for the given Instagram Business/Creator account.
 * `limit` caps how many are requested per call; `after` is Meta's own
 * opaque paging cursor from a previous call's `paging.cursors.after`.
 * A successful call with zero items is a normal outcome (an account with
 * no posts yet), never an error.
 */
export async function getInstagramMedia(igAccountId, pageAccessToken, { limit = 25, after } = {}) {
  try {
    const params = { fields: MEDIA_FIELDS, limit };
    if (after) params.after = after;

    const result = await metaApiService.request({
      method: 'GET',
      path: `/${igAccountId}/media`,
      params,
      accessToken: pageAccessToken,
      context: 'instagram_get_media',
    });

    if (!result.success) return { ...normalizeFailure(result, 'get_media'), media: [], nextCursor: null };

    const media = (Array.isArray(result.data?.data) ? result.data.data : []).map((entry) => {
      // A VIDEO item can still be processing on Meta's side and briefly
      // have no media_url yet — never assumed present.
      const mediaType = entry.media_type || null;
      let mediaUrl = entry.media_url || null;
      let thumbnailUrl = entry.thumbnail_url || null;
      if (mediaType === 'CAROUSEL_ALBUM') {
        const firstChild = Array.isArray(entry.children?.data) ? entry.children.data[0] : null;
        mediaUrl = firstChild?.media_url || null;
        thumbnailUrl = firstChild?.thumbnail_url || mediaUrl || null;
      }

      return {
        id: entry.id,
        caption: entry.caption || null,
        mediaType,
        mediaUrl,
        thumbnailUrl: thumbnailUrl || (mediaType === 'VIDEO' ? entry.thumbnail_url || null : mediaUrl),
        permalink: entry.permalink || null,
        timestamp: entry.timestamp || null,
        likeCount: typeof entry.like_count === 'number' ? entry.like_count : null,
        commentsCount: typeof entry.comments_count === 'number' ? entry.comments_count : null,
        childrenCount: Array.isArray(entry.children?.data) ? entry.children.data.length : null,
      };
    });

    return { success: true, media, error: null, nextCursor: result.data?.paging?.cursors?.after || null };
  } catch (error) {
    LoggerUtil.error('[INSTAGRAM_DATA] Unexpected error fetching Instagram media', { message: error.message }, {});
    return { success: false, media: [], nextCursor: null, error: { code: 'INSTAGRAM_MEDIA_FAILED', message: 'Failed to retrieve Instagram media' } };
  }
}

// Real, reliable totals living directly on the IG user object — not an
// Insights metric at all (no since/until/period, no availability
// ambiguity). Used for "Total Posts" on the Overview dashboard.
const ACCOUNT_INFO_FIELDS = 'id,username,name,media_count,followers_count,follows_count,profile_picture_url';

/** Safe profile/count fields for the connected Instagram account. */
export async function getInstagramAccountInfo(igAccountId, pageAccessToken) {
  try {
    const result = await metaApiService.request({
      method: 'GET',
      path: `/${igAccountId}`,
      params: { fields: ACCOUNT_INFO_FIELDS },
      accessToken: pageAccessToken,
      context: 'instagram_get_account_info',
    });

    if (!result.success) return { ...normalizeFailure(result, 'get_account_info'), account: null };

    const data = result.data || {};
    if (!data.id) {
      return { success: false, account: null, error: { code: 'INSTAGRAM_ACCOUNT_INFO_FAILED', message: 'Instagram account info response was malformed' } };
    }

    return {
      success: true,
      account: {
        id: data.id,
        username: data.username || null,
        name: data.name || null,
        mediaCount: typeof data.media_count === 'number' ? data.media_count : null,
        followersCount: typeof data.followers_count === 'number' ? data.followers_count : null,
        followsCount: typeof data.follows_count === 'number' ? data.follows_count : null,
        profilePictureUrl: data.profile_picture_url || null,
      },
      error: null,
    };
  } catch (error) {
    LoggerUtil.error('[INSTAGRAM_DATA] Unexpected error fetching Instagram account info', { message: error.message }, {});
    return { success: false, account: null, error: { code: 'INSTAGRAM_ACCOUNT_INFO_FAILED', message: 'Failed to retrieve Instagram account info' } };
  }
}

/**
 * Instagram Insights for ONE metric. `metricType: 'total_value'` is
 * required by several current Instagram metrics (accounts_engaged,
 * total_interactions, likes, comments, profile_views, website_clicks —
 * confirmed live: omitting it returns Meta's own actionable error "should
 * be specified with parameter metric_type=total_value") and changes the
 * response shape from a per-day `values[]` series to a single
 * `total_value: {value}` for the whole window; other metrics
 * (reach, follower_count) still support the classic per-day series
 * without it. Returns BOTH possible shapes (`values` and `totalValue`,
 * one of them null) so the caller decides which one a given metric
 * actually uses — this layer stays generic, same discipline as
 * facebookPageDataService.js's getPageInsights.
 */
export async function getInstagramInsights(igAccountId, pageAccessToken, { metric, since, until, period = 'day', metricType } = {}) {
  try {
    const params = { metric, period };
    if (since) params.since = since;
    if (until) params.until = until;
    if (metricType) params.metric_type = metricType;

    const result = await metaApiService.request({
      method: 'GET',
      path: `/${igAccountId}/insights`,
      params,
      accessToken: pageAccessToken,
      context: 'instagram_get_insights',
    });

    if (!result.success) return normalizeInsightsFailure(result);

    const entry = Array.isArray(result.data?.data) ? result.data.data[0] : null;
    if (!entry) {
      return { success: true, values: [], totalValue: null, error: null };
    }

    return {
      success: true,
      values: Array.isArray(entry.values) ? entry.values.map((v) => ({ date: (v.end_time || '').slice(0, 10) || null, value: typeof v.value === 'number' ? v.value : null })) : [],
      totalValue: typeof entry.total_value?.value === 'number' ? entry.total_value.value : null,
      error: null,
    };
  } catch (error) {
    LoggerUtil.error('[INSTAGRAM_DATA] Unexpected error fetching Instagram insights', { message: error.message }, {});
    return { success: false, values: [], totalValue: null, error: { code: 'INSTAGRAM_INSIGHTS_FAILED', message: 'Failed to retrieve Instagram insights' } };
  }
}

function normalizeFailure(result, operation) {
  LoggerUtil.service('InstagramData', operation, 'failed', { status: result.status });
  if (isAuthenticationFailure(result)) {
    return { success: false, error: { code: 'INSTAGRAM_TOKEN_INVALID', message: 'Meta denied access to this Instagram account' } };
  }
  return { success: false, error: { code: 'INSTAGRAM_DATA_FETCH_FAILED', message: 'Failed to reach Meta for this Instagram account' } };
}

function normalizeInsightsFailure(result) {
  LoggerUtil.service('InstagramData', 'get_insights', 'failed', { status: result.status });
  if (isAuthenticationFailure(result)) {
    return { success: false, values: [], totalValue: null, error: { code: 'INSTAGRAM_TOKEN_INVALID', message: 'Meta denied access to this Instagram account' } };
  }
  return { success: false, values: [], totalValue: null, error: { code: 'INSTAGRAM_INSIGHTS_UNAVAILABLE', message: 'Instagram insights are not available for this account' } };
}

export default { getInstagramMedia, getInstagramAccountInfo, getInstagramInsights };
