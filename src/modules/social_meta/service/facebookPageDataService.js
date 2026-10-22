// Called through the default-exported object (not a named import) so
// tests can substitute request() for the duration of one test — same
// reasoning as metaPageService.js's/metaInstagramService.js's identical
// choice: this repo has no mocking library, and Meta will never
// deterministically reproduce a specific error (like the "reduce the
// amount of data" complexity-limit error this file's own tests exist to
// cover) for a fake token.
import metaApiService from './metaApiService.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { isAuthenticationFailure } from './metaErrorClassifier.js';

/**
 * FacebookPageDataService — the Graph-API-only layer for a connected
 * Page's own data (profile info, posts, insights). Kept separate from
 * metaPageService.js (Page DISCOVERY — /me/accounts, the Page->Instagram
 * link) since this is a different concern: reading data FROM an
 * already-connected Page, using that Page's own stored token. No DB
 * access here at all, same discipline as every other *Service.js file in
 * this module — the orchestration/persistence layer
 * (facebookOverviewService.js) is what calls these and talks to Mongo.
 */

const PAGE_INFO_FIELDS = 'id,name,followers_count,fan_count,picture{url}';
// Extended for the Feeds page (full_picture/attachments/engagement
// summaries) beyond what facebookOverviewService.js's own use of this
// function needs (it only reads id/createdTime) — a strict superset, so
// that existing caller is unaffected. likes.summary(true) and
// comments.summary(true) each ask Meta for a total_count alongside the
// edge; `shares` is Meta's own field for share count and — a real,
// documented Graph API quirk, not a bug — is entirely ABSENT from the
// response when a post has zero shares, present only when count > 0.
const PAGE_POSTS_FIELDS = 'id,message,created_time,updated_time,permalink_url,full_picture,attachments{media_type,type,url},likes.summary(true),comments.summary(true),shares';

/** Safe profile fields for the connected Page. */
export async function getPageInfo(pageId, pageAccessToken) {
  try {
    const result = await metaApiService.request({
      method: 'GET',
      path: `/${pageId}`,
      params: { fields: PAGE_INFO_FIELDS },
      accessToken: pageAccessToken,
      context: 'facebook_get_page_info',
    });

    if (!result.success) return { ...normalizeFailure(result, 'get_page_info'), page: null };

    const data = result.data || {};
    if (!data.id) {
      return { success: false, page: null, error: { code: 'FACEBOOK_PAGE_INFO_FAILED', message: 'Page info response was malformed' } };
    }

    return {
      success: true,
      page: {
        id: data.id,
        name: data.name || null,
        picture: data.picture?.data?.url || null,
        followersCount: typeof data.followers_count === 'number' ? data.followers_count : null,
        fanCount: typeof data.fan_count === 'number' ? data.fan_count : null,
      },
      error: null,
    };
  } catch (error) {
    LoggerUtil.error('[FACEBOOK_DATA] Unexpected error fetching Page info', { message: error.message }, {});
    return { success: false, page: null, error: { code: 'FACEBOOK_PAGE_INFO_FAILED', message: 'Failed to retrieve Page info' } };
  }
}

/**
 * Recent posts for the connected Page. `limit` caps how many are
 * requested per call; `after` (Meta's own opaque paging cursor, from a
 * previous call's `paging.next`) lets a caller (socialSyncService.js)
 * page through more than one batch for a fuller sync than the dashboard's
 * own 25-post lookback needs. Every engagement field is left `null` (not
 * 0) when Meta's response omits it — only `shares` defaults to 0 when
 * absent, because Meta's own documented behavior for that specific field
 * is "absent means zero", not "unavailable" (see PAGE_POSTS_FIELDS above).
 */
export async function getPagePosts(pageId, pageAccessToken, { limit = 25, after } = {}) {
  try {
    const params = { fields: PAGE_POSTS_FIELDS, limit };
    if (after) params.after = after;

    const result = await metaApiService.request({
      method: 'GET',
      path: `/${pageId}/posts`,
      params,
      accessToken: pageAccessToken,
      context: 'facebook_get_page_posts',
    });

    if (!result.success) return { ...normalizeFailure(result, 'get_page_posts'), posts: [], nextCursor: null };

    const posts = (Array.isArray(result.data?.data) ? result.data.data : []).map((entry) => {
      const attachment = Array.isArray(entry.attachments?.data) ? entry.attachments.data[0] : null;
      return {
        id: entry.id,
        message: entry.message || null,
        createdTime: entry.created_time || null,
        updatedTime: entry.updated_time || null,
        permalink: entry.permalink_url || null,
        fullPicture: entry.full_picture || null,
        attachmentType: attachment?.media_type || attachment?.type || null,
        mediaUrl: attachment?.media?.image?.src || entry.full_picture || null,
        likesCount: typeof entry.likes?.summary?.total_count === 'number' ? entry.likes.summary.total_count : null,
        commentsCount: typeof entry.comments?.summary?.total_count === 'number' ? entry.comments.summary.total_count : null,
        // Real Graph API behavior: this field is entirely absent for zero
        // shares, never present-with-value-0 — so "absent" is a genuine 0
        // here, unlike likes/comments summaries which report null on
        // failure rather than omission.
        sharesCount: typeof entry.shares?.count === 'number' ? entry.shares.count : 0,
      };
    });

    return { success: true, posts, error: null, nextCursor: result.data?.paging?.cursors?.after || null };
  } catch (error) {
    LoggerUtil.error('[FACEBOOK_DATA] Unexpected error fetching Page posts', { message: error.message }, {});
    return { success: false, posts: [], nextCursor: null, error: { code: 'FACEBOOK_PAGE_POSTS_FAILED', message: 'Failed to retrieve Page posts' } };
  }
}

/**
 * Page Insights for one or more metrics over a date range. Meta returns
 * daily buckets for period=day — this does NOT aggregate into week/month
 * itself, callers get the raw daily series back and decide.
 *
 * Explicitly does NOT fabricate a fallback value when Meta rejects the
 * request (e.g. missing read_insights permission, Page below Meta's own
 * minimum-follower threshold for Insights data) — returns
 * { success:false, error } so the caller can surface a real "unavailable"
 * state instead of a fake zero.
 */
export async function getPageInsights(pageId, pageAccessToken, { metrics, since, until, period = 'day' } = {}) {
  try {
    const result = await metaApiService.request({
      method: 'GET',
      path: `/${pageId}/insights`,
      params: { metric: metrics.join(','), period, since, until },
      accessToken: pageAccessToken,
      context: 'facebook_get_page_insights',
    });

    if (!result.success) return normalizeInsightsFailure(result);

    // Meta's insights response is one entry per requested metric, each
    // with its own `values` array of { value, end_time }.
    const byMetric = {};
    for (const entry of Array.isArray(result.data?.data) ? result.data.data : []) {
      byMetric[entry.name] = (Array.isArray(entry.values) ? entry.values : []).map((v) => ({
        date: (v.end_time || '').slice(0, 10) || null,
        value: typeof v.value === 'number' ? v.value : null,
      }));
    }

    return { success: true, metrics: byMetric, error: null };
  } catch (error) {
    LoggerUtil.error('[FACEBOOK_DATA] Unexpected error fetching Page insights', { message: error.message }, {});
    return { success: false, metrics: {}, error: { code: 'FACEBOOK_INSIGHTS_FAILED', message: 'Failed to retrieve Page insights' } };
  }
}

function normalizeFailure(result, operation) {
  const metaError = result.data?.error;
  // Safe diagnostics only — Meta's error code/type, never any request
  // param or the token. This is what proved the real Facebook Feeds sync
  // bug: every failure was being collapsed into one generic
  // FACEBOOK_DATA_FETCH_FAILED code, hiding the actual, actionable Meta
  // error underneath it.
  LoggerUtil.service('FacebookData', operation, 'failed', { status: result.status, metaCode: metaError?.code, metaType: metaError?.type });
  if (isAuthenticationFailure(result)) {
    return { success: false, error: { code: 'FACEBOOK_TOKEN_INVALID', message: 'Meta denied access to this Page' } };
  }
  // Meta's own request-complexity limit — confirmed live against a real
  // connected Page: requesting this module's full post-posts field
  // expansion (likes.summary/comments.summary/attachments) at too high a
  // `limit` returns exactly this error (status 500, error.code 1,
  // "Please reduce the amount of data you're asking for, then retry your
  // request"). Distinct from a generic fetch failure so a caller (and a
  // future diagnosis) can tell "the request itself was too heavy" apart
  // from "Meta/the network is unreachable" — see socialSyncService.js's
  // FACEBOOK_PAGE_FETCH_LIMIT for the actual fix (smaller pages).
  if (metaError?.code === 1 && /reduce the amount of data/i.test(metaError?.message || '')) {
    return { success: false, error: { code: 'FACEBOOK_REQUEST_TOO_LARGE', message: 'Meta rejected this request for asking for too much data in one call.' } };
  }
  return { success: false, error: { code: 'FACEBOOK_DATA_FETCH_FAILED', message: 'Failed to reach Meta for this Page' } };
}

function normalizeInsightsFailure(result) {
  LoggerUtil.service('FacebookData', 'get_page_insights', 'failed', { status: result.status });
  if (isAuthenticationFailure(result)) {
    return { success: false, metrics: {}, error: { code: 'FACEBOOK_TOKEN_INVALID', message: 'Meta denied access to Page insights' } };
  }
  // Meta returns 400 for both "unknown metric for this API version" and
  // "insights unavailable for this Page" (e.g. below the follower
  // threshold) — neither is a token problem, so this is classified
  // separately from the 401/403 branch above.
  return { success: false, metrics: {}, error: { code: 'FACEBOOK_INSIGHTS_UNAVAILABLE', message: 'Page insights are not available for this Page' } };
}

export default { getPageInfo, getPagePosts, getPageInsights };
