import mongoose from 'mongoose';
import SocialPost from '../model/SocialPost.js';
import { getActiveFacebookAccount, getActiveInstagramAccount } from './facebookAccountService.js';

/**
 * SocialFeedService — the read layer for GET /api/social/feeds. Never
 * calls Meta; only reads what socialSyncService.js already upserted into
 * MongoDB (Phase 14's "background sync, not a Meta call on every page
 * load"). Every query is scoped to `project_id` — the caller (the
 * controller) is responsible for having already resolved that ID through
 * validateProjectAccess(), the same authorization boundary every other
 * social_meta route already uses; this service trusts whatever
 * project_id it's given the same way every other *Service.js file here
 * trusts its caller.
 *
 * ACCOUNT SCOPING (default): a project can have several connected
 * Facebook Pages (Switch Account) plus one Instagram account derived from
 * whichever Page is active (see facebookAccountService.js's
 * getActiveInstagramAccount) — Feeds used to pool posts from EVERY
 * connected account of a platform, so switching accounts never changed
 * what Feeds showed. By default this now scopes to exactly the CURRENTLY
 * ACTIVE account(s) — the same resolution Overview already uses, never a
 * client-supplied account id (nothing here accepts one). Passing
 * `scopeToActiveAccounts: false` restores the original "everything, every
 * connected account" view as an explicit, opt-in choice (the Feeds page's
 * "All Feeds" tile).
 */

// Same tiny per-module escape helper leadService.js already uses — no
// shared regex-escape utility exists in this codebase to import instead.
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SORTABLE = {
  newest: { publishedAt: -1 },
  oldest: { publishedAt: 1 },
};

const DEFAULT_PAGE_SIZE = 20;
// Must stay >= the largest option the Feeds page's page-size selector
// offers (see frontend's FEED_PAGE_SIZE_OPTIONS, currently up to 100) —
// otherwise a user's own explicit "100 per page" choice would silently
// get clamped back down to whatever this was, with no error and no
// indication anything was capped.
const MAX_PAGE_SIZE = 100;

/**
 * `platform`/`status`/`search`/`from`/`to` narrow the returned page AND
 * its `pagination.total`. `summary` is deliberately computed from the
 * FULL project post set (platform/status/search/date-unfiltered) — the
 * top summary tiles are meant to answer "how many posts exist overall",
 * not "how many match the current filters", matching how the previous
 * dummy FeedStats tiles always counted the complete mock array regardless
 * of the active filter.
 */
export async function getProjectFeeds(projectId, { platform, status, search, from, to, sort = 'newest', page = 1, limit = DEFAULT_PAGE_SIZE, scopeToActiveAccounts = true } = {}) {
  // Cast explicitly rather than relying on Mongoose's automatic
  // string->ObjectId casting for `find`/`countDocuments` — that casting
  // does NOT happen for aggregate() pipelines, which talk to the raw
  // driver. Without this, `$match: { project_id: <string> }` below
  // silently matches zero documents (a string never equals a stored
  // ObjectId), which is exactly what produced the real bug this fixes:
  // the post list (via .find()) rendered correctly while every summary
  // tile showed 0.
  const projectObjectId = mongoose.Types.ObjectId.isValid(projectId) ? new mongoose.Types.ObjectId(projectId) : projectId;

  // `baseQuery` = project + (optionally) the active account(s) — used for
  // BOTH the summary tiles (never platform-filtered, same as before) and
  // as the starting point for the main `data` query below. Resolved
  // server-side only (getActiveFacebookAccount/getActiveInstagramAccount)
  // — never from a client-supplied account id, so there is nothing here
  // for a client to tamper with to reach another account's posts.
  const baseQuery = { project_id: projectObjectId };
  if (scopeToActiveAccounts) {
    const [activeFacebook, activeInstagram] = await Promise.all([
      getActiveFacebookAccount(projectId),
      getActiveInstagramAccount(projectId),
    ]);
    const activeAccountIds = [activeFacebook, activeInstagram].filter(Boolean).map((a) => a._id);
    if (activeAccountIds.length === 0) {
      // Scoped mode requested, but no account is active for either
      // platform right now — honestly empty, never someone else's posts.
      const emptyLimit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(limit, 10) || DEFAULT_PAGE_SIZE));
      return {
        data: [],
        pagination: { page: 1, limit: emptyLimit, total: 0, totalPages: 1, hasNextPage: false, hasPreviousPage: false },
        summary: { all: 0, facebook: 0, instagram: 0, x: 0, linkedin: 0, tiktok: 0 },
      };
    }
    baseQuery.social_account_id = { $in: activeAccountIds };
  }

  const query = { ...baseQuery };
  if (platform) query.platform = platform;
  if (status) query.status = status;
  if (search) {
    const re = { $regex: escapeRegex(search), $options: 'i' };
    query.text = re;
  }
  if (from || to) {
    query.publishedAt = {};
    if (from) query.publishedAt.$gte = new Date(`${from}T00:00:00.000Z`);
    if (to) query.publishedAt.$lte = new Date(`${to}T23:59:59.999Z`);
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(limit, 10) || DEFAULT_PAGE_SIZE));
  const sortSpec = SORTABLE[sort] || SORTABLE.newest;

  const [posts, total, platformCounts] = await Promise.all([
    SocialPost.find(query).sort(sortSpec).skip((pageNum - 1) * limitNum).limit(limitNum).lean(),
    SocialPost.countDocuments(query),
    SocialPost.aggregate([
      { $match: baseQuery },
      { $group: { _id: '$platform', count: { $sum: 1 } } },
    ]),
  ]);

  const countsByPlatform = Object.fromEntries(platformCounts.map((row) => [row._id, row.count]));
  const facebookCount = countsByPlatform.facebook || 0;
  const instagramCount = countsByPlatform.instagram || 0;

  return {
    data: posts.map(toApiPost),
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.max(1, Math.ceil(total / limitNum)),
      hasNextPage: pageNum * limitNum < total,
      hasPreviousPage: pageNum > 1,
    },
    // x/linkedin/tiktok are real zeros (no integration exists to produce
    // a post for them), never a placeholder/fabricated count — Phase 8's
    // explicit requirement.
    summary: {
      all: facebookCount + instagramCount,
      facebook: facebookCount,
      instagram: instagramCount,
      x: 0,
      linkedin: 0,
      tiktok: 0,
    },
  };
}

function toApiPost(post) {
  return {
    id: post._id.toString(),
    platform: post.platform,
    externalPostId: post.externalPostId,
    accountId: post.accountId,
    accountName: post.accountName,
    accountPicture: post.accountPicture,
    username: post.username,
    type: post.type,
    text: post.text,
    mediaUrl: post.mediaUrl,
    thumbnailUrl: post.thumbnailUrl,
    permalink: post.permalink,
    status: post.status,
    publishedAt: post.publishedAt,
    metrics: post.metrics,
    syncedAt: post.syncedAt,
  };
}

export default { getProjectFeeds };
