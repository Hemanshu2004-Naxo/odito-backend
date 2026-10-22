import { getActiveFacebookAccount } from './facebookAccountService.js';
// Called through the default-exported object (not named imports) — same
// reason as metaInstagramService.js's own identical choice: this repo has
// no mocking library, and Meta will never return a deterministic fixture
// for a fake token, so tests substitute these three functions for the
// duration of one test, restored in a finally. See that file's header
// comment for the full rationale.
import facebookPageDataService from './facebookPageDataService.js';
import facebookInsightsService from './facebookInsightsService.js';
import { resolveRange, resolveRangeWindow } from './dateRangeUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { markAccountExpired } from './metaTokenService.js';

/**
 * FacebookOverviewService — orchestration: load the project's ACTIVE
 * Facebook Page connection (see facebookAccountService.js — a project can
 * have several connected Pages; this always follows whichever one is
 * currently active), call the Graph API data layer
 * (facebookPageDataService), normalize into the dashboard's stable
 * response shape. Same role as metaInstagramService.js for Instagram
 * discovery — the only place that ties the Graph API layer to the
 * database for Facebook dashboard data.
 *
 * `connected` in THIS response means something slightly different from
 * /api/social/accounts's `connected`: there, it means "a persisted,
 * active SocialAccount row exists". Here, it means "that connection is
 * actually usable right now" — a stored row with a token Meta now rejects
 * is reported as connected:false + reason here, without touching the
 * stored row's own status (a single failed fetch should not silently
 * un-connect the project; that's a separate decision for a disconnect/
 * reconnect flow, not this read path).
 */

export async function getFacebookOverview({ projectId, range }) {
  // The ACTIVE Facebook Page specifically (Switch Account feature — a
  // project can have several connected Pages; this must always follow
  // whichever one is currently active, never "the first one found").
  const account = await getActiveFacebookAccount(projectId);
  if (!account) {
    LoggerUtil.info('FACEBOOK_DATA_FETCH_START', { projectId, pageId: null });
    return { connected: false };
  }

  const pageId = account.pageId || account.platformAccountId;
  // Decrypted via the schema's own getter — never accepted as a parameter,
  // never logged, same trust boundary as every other Meta data path in
  // this module.
  const pageAccessToken = account.accessToken;

  LoggerUtil.info('FACEBOOK_DATA_FETCH_START', { projectId, pageId });

  const infoResult = await facebookPageDataService.getPageInfo(pageId, pageAccessToken);
  if (!infoResult.success) {
    LoggerUtil.info('FACEBOOK_DATA_FETCH_ERROR', { projectId, pageId, endpoint: 'page_info', errorType: infoResult.error?.code, message: infoResult.error?.message });
    if (infoResult.error?.code === 'FACEBOOK_TOKEN_INVALID') {
      // Meta confirmed the token is dead (code 190 / 401 / 403): record it,
      // so the status API reports "reconnect required" instead of leaving
      // the account 'active' forever.
      await markAccountExpired(account);
      return { connected: false, reason: 'TOKEN_EXPIRED' };
    }
    return { connected: false, reason: 'FETCH_FAILED' };
  }
  LoggerUtil.info('FACEBOOK_DATA_FETCH_RESULT', { projectId, pageId, endpoint: 'page_info', success: true });

  const { since, until } = resolveRangeWindow(range);

  const postsResult = await facebookPageDataService.getPagePosts(pageId, pageAccessToken, { limit: 25 });
  LoggerUtil.info(postsResult.success ? 'FACEBOOK_DATA_FETCH_RESULT' : 'FACEBOOK_DATA_FETCH_ERROR', {
    projectId, pageId, endpoint: 'page_posts', success: postsResult.success, errorType: postsResult.error?.code,
  });
  const recentPosts = postsResult.success
    ? postsResult.posts.filter((p) => p.createdTime && new Date(p.createdTime) >= since).length
    : null;

  // Delegates to the dedicated normalization layer — no raw Meta metric
  // name is written anywhere in this file (see facebookInsightsService.js
  // for the live-confirmed metric map and why "Page Impressions" has no
  // valid replacement while "Page Views" does). Each metric is fetched
  // and reported independently: one becoming unavailable in the future
  // can never take the other down with it.
  const insights = await facebookInsightsService.getFacebookInsights({
    projectId, pageId, pageAccessToken,
    since: Math.floor(since.getTime() / 1000),
    until: Math.floor(until.getTime() / 1000),
  });
  LoggerUtil.info(
    insights.pageViews.unavailableReason === null && insights.newFollowers.unavailableReason === null ? 'FACEBOOK_DATA_FETCH_RESULT' : 'FACEBOOK_DATA_FETCH_ERROR',
    { projectId, pageId, endpoint: 'page_insights', success: insights.pageViews.unavailableReason === null && insights.newFollowers.unavailableReason === null },
  );

  account.lastSyncedAt = new Date();
  await account.save();

  return {
    connected: true,
    platform: 'facebook',
    range: resolveRange(range),
    since: since.toISOString(),
    until: until.toISOString(),
    page: { id: infoResult.page.id, name: infoResult.page.name, picture: infoResult.page.picture },
    // "Page Views" (page_views_total) replaces the retired "Page
    // Impressions" — a real, currently-supported metric, but NOT the same
    // thing impressions used to measure (visits to the Page's own profile,
    // not content reach); see facebookInsightsService.js. "New Fans" is
    // unchanged — page_daily_follows was already valid, nothing to migrate.
    metrics: { pageViews: insights.pageViews.value, recentPosts, newFans: insights.newFollowers.value },
    chart: insights.pageViews.series.map((pt) => ({ date: pt.date, value: pt.value })),
    // Two independent reasons, surfaced separately — a frontend can tell
    // "Page Views failed/is unavailable for this Page" apart from "New
    // Fans failed this time", never collapsed into one generic flag.
    pageViewsUnavailableReason: insights.pageViews.unavailableReason,
    newFansUnavailableReason: insights.newFollowers.unavailableReason,
    lastSyncedAt: account.lastSyncedAt.toISOString(),
  };
}

export default { getFacebookOverview };
