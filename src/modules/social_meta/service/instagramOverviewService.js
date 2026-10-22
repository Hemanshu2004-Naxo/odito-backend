import mongoose from 'mongoose';
import SocialAccount from '../model/SocialAccount.js';
import SocialPost from '../model/SocialPost.js';
// Called through the default-exported object (not named imports) — same
// reason as every other *OverviewService.js file in this module: this
// repo has no mocking library, and Meta will never return a
// deterministic fixture for a fake token, so tests substitute these
// functions for the duration of one test, restored in a finally.
import instagramMediaService from './instagramMediaService.js';
import instagramInsightsService from './instagramInsightsService.js';
import { getActiveInstagramAccount } from './facebookAccountService.js';
import { resolveRange, resolveRangeWindow } from './dateRangeUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { markAccountExpired } from './metaTokenService.js';

/**
 * InstagramOverviewService — orchestration for the Social Overview
 * dashboard's Instagram card, mirroring facebookOverviewService.js's
 * exact role for Facebook.
 *
 * Instagram has no independent "Switch Account" UI of its own — there is
 * only ONE switcher in this app (Facebook Pages), and an Instagram
 * Business Account is only ever discovered/linked through a SPECIFIC
 * Facebook Page (see metaInstagramService.js's discoverInstagramForPage,
 * which stores the linking Page's id as `pageId` on the Instagram
 * SocialAccount row). So "the active Instagram account" is not an
 * independent concept — it is, by construction, whichever Instagram row
 * is linked to the CURRENTLY ACTIVE Facebook Page.
 *
 * FIXED BUG: this used to resolve the Instagram account with a bare
 * `{project_id, platform:'instagram', status:'active'}` findOne — no
 * `pageId` filter at all. Because Instagram discovery only ever runs for
 * whichever Page was selected at connect time (or via a manual retry),
 * that query always returned the SAME Instagram row regardless of which
 * Facebook Page was later made active via Switch Account — so switching
 * Facebook Pages silently kept showing the original Page's Instagram
 * data (or none, if the original Page had none), never the newly active
 * Page's own linked Instagram account. socialAccountController.js's
 * "Instagram connected" status badge had the exact same unscoped query
 * and has been fixed the same way, so the badge and this data source can
 * never disagree about which Instagram account is "connected".
 */

export async function getInstagramOverview({ projectId, range }) {
  // Resolve via the ACTIVE Facebook Page first — this is the real,
  // single source of truth for "which Instagram account", not a
  // separate/duplicated Instagram-active flag (SocialAccount's own
  // `isActive` field is explicitly unused for platform:'instagram').
  const account = await getActiveInstagramAccount(projectId);
  if (!account) {
    // A real, common, non-error outcome: either there's no active
    // Facebook Page at all, or the active Page genuinely has no linked
    // Instagram Business Account yet — never fall back to a different
    // Page's Instagram data to fill this in.
    LoggerUtil.info('INSTAGRAM_DATA_FETCH_START', { projectId, igAccountId: null });
    return { connected: false, reason: 'NOT_LINKED_TO_ACTIVE_PAGE' };
  }

  const igAccountId = account.instagramBusinessAccountId || account.platformAccountId;
  // Decrypted via the schema's own getter — never accepted as a
  // parameter, never logged, same trust boundary as every other Meta
  // data path in this module. The SAME Page token — Instagram never had
  // its own separate credential (see SocialAccount.js's own comment).
  const pageAccessToken = account.accessToken;

  LoggerUtil.info('INSTAGRAM_DATA_FETCH_START', { projectId, igAccountId });

  const accountInfoResult = await instagramMediaService.getInstagramAccountInfo(igAccountId, pageAccessToken);
  if (!accountInfoResult.success) {
    LoggerUtil.info('INSTAGRAM_DATA_FETCH_ERROR', { projectId, igAccountId, endpoint: 'account_info', errorType: accountInfoResult.error?.code });
    if (accountInfoResult.error?.code === 'INSTAGRAM_TOKEN_INVALID') {
      await markAccountExpired(account);
      return { connected: false, reason: 'TOKEN_EXPIRED' };
    }
    return { connected: false, reason: 'FETCH_FAILED' };
  }
  LoggerUtil.info('INSTAGRAM_DATA_FETCH_RESULT', { projectId, igAccountId, endpoint: 'account_info', success: true });

  const { since, until } = resolveRangeWindow(range);

  const insights = await instagramInsightsService.getInstagramInsightsSummary({
    projectId, igAccountId, pageAccessToken,
    since: Math.floor(since.getTime() / 1000),
    until: Math.floor(until.getTime() / 1000),
  });
  LoggerUtil.info(
    Object.values(insights).every((r) => r.unavailableReason === null) ? 'INSTAGRAM_DATA_FETCH_RESULT' : 'INSTAGRAM_DATA_FETCH_ERROR',
    { projectId, igAccountId, endpoint: 'instagram_insights', success: Object.values(insights).every((r) => r.unavailableReason === null) },
  );

  // The chart ("Total Comments vs Total Likes" per day) cannot come from
  // Insights any more — confirmed live, `likes`/`comments` are only
  // available as a single 30-day aggregate now (metric_type=total_value
  // has no per-day breakdown), not the daily series the chart needs. It
  // is instead derived from already-synced SocialPost documents (the
  // Feeds page's own real, per-post like/comment counts — see
  // socialSyncService.js) grouped by real publish day. If nothing has
  // been synced yet, this is honestly empty, never fabricated.
  const chart = await buildCommentsLikesChart(projectId, since, until);

  account.lastSyncedAt = new Date();
  await account.save();

  return {
    connected: true,
    platform: 'instagram',
    range: resolveRange(range),
    since: since.toISOString(),
    until: until.toISOString(),
    account: {
      id: accountInfoResult.account.id,
      username: accountInfoResult.account.username,
      name: accountInfoResult.account.name,
      picture: accountInfoResult.account.profilePictureUrl,
    },
    metrics: {
      posts: accountInfoResult.account.mediaCount,
      engagements: insights.engagements.value,
      followersGained: insights.followersGained.value,
      likes: insights.likes.value,
    },
    chart,
    postsUnavailableReason: accountInfoResult.account.mediaCount === null ? 'INSTAGRAM_ACCOUNT_INFO_INCOMPLETE' : null,
    engagementsUnavailableReason: insights.engagements.unavailableReason,
    followersGainedUnavailableReason: insights.followersGained.unavailableReason,
    likesUnavailableReason: insights.likes.unavailableReason,
    lastSyncedAt: account.lastSyncedAt.toISOString(),
  };
}

async function buildCommentsLikesChart(projectId, since, until) {
  const projectObjectId = mongoose.Types.ObjectId.isValid(projectId) ? new mongoose.Types.ObjectId(projectId) : projectId;
  const rows = await SocialPost.aggregate([
    {
      $match: {
        project_id: projectObjectId,
        platform: 'instagram',
        publishedAt: { $gte: since, $lte: until },
      },
    },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$publishedAt' } },
        comments: { $sum: { $ifNull: ['$metrics.comments', 0] } },
        likes: { $sum: { $ifNull: ['$metrics.likes', 0] } },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  return rows.map((r) => ({ date: r._id, comments: r.comments, likes: r.likes }));
}

export default { getInstagramOverview };
