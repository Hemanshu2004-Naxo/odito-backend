import { getProjectFeeds } from '../service/socialFeedService.js';
import { syncProjectSocialFeeds } from '../service/socialSyncService.js';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

const VALID_PLATFORMS = new Set(['facebook', 'instagram']);
const VALID_STATUSES = new Set(['published']);
const VALID_SORTS = new Set(['newest', 'oldest']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/social/feeds?projectId=&platform=&status=&search=&from=&to=&sort=&page=&limit=&allAccounts=
 * Only ever reads from MongoDB (socialFeedService.js) — never calls Meta,
 * so this endpoint is always fast and never rate-limited by Meta's API,
 * matching Phase 14's "background sync, not a Meta call on every page
 * load". `projectId` is already validated by validateProjectAccess()
 * before this handler runs; every other input here is untrusted and
 * whitelisted/parsed defensively before reaching the query layer.
 *
 * `allAccounts` is a boolean-shaped flag only ('true' to disable account
 * scoping) — never an account id. There is no `socialAccountId` (or
 * similar) parameter anywhere on this endpoint: which account(s) to scope
 * to is always resolved server-side from the project's own persisted
 * active-account state (socialFeedService.js -> facebookAccountService.js),
 * so there is nothing here a client could tamper with to reach another
 * account's or another project's posts.
 */
export async function getFeedsHandler(req, res) {
  const projectId = req.projectId;
  const { platform, status, search, from, to, sort, page, limit, allAccounts } = req.query;

  if (platform && !VALID_PLATFORMS.has(platform)) {
    return res.status(400).json(ResponseUtil.error('Invalid platform filter', 400, { code: 'INVALID_PLATFORM' }));
  }
  if (status && !VALID_STATUSES.has(status)) {
    return res.status(400).json(ResponseUtil.error('Invalid status filter', 400, { code: 'INVALID_STATUS' }));
  }
  if (sort && !VALID_SORTS.has(sort)) {
    return res.status(400).json(ResponseUtil.error('Invalid sort value', 400, { code: 'INVALID_SORT' }));
  }
  if (from && !DATE_RE.test(from)) {
    return res.status(400).json(ResponseUtil.error('Invalid "from" date', 400, { code: 'INVALID_DATE' }));
  }
  if (to && !DATE_RE.test(to)) {
    return res.status(400).json(ResponseUtil.error('Invalid "to" date', 400, { code: 'INVALID_DATE' }));
  }
  if (search && typeof search === 'string' && search.length > 200) {
    return res.status(400).json(ResponseUtil.error('Search term is too long', 400, { code: 'INVALID_SEARCH' }));
  }

  try {
    const result = await getProjectFeeds(projectId, {
      platform: platform || undefined,
      status: status || undefined,
      search: search ? String(search).trim() : undefined,
      from: from || undefined,
      to: to || undefined,
      sort: sort || 'newest',
      page,
      limit,
      // Default (no ?allAccounts=true): scoped to whichever Facebook Page
      // + Instagram account are currently active — see
      // socialFeedService.js's own header comment. ?allAccounts=true is
      // the Feeds page's explicit "All Feeds" tile, restoring the
      // original every-connected-account view.
      scopeToActiveAccounts: allAccounts !== 'true',
    });
    return res.json(ResponseUtil.success(result));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_FEEDS] Failed to load feeds', { message: error.message }, { projectId });
    return res.status(500).json(ResponseUtil.error('Failed to load feeds', 500, { code: 'SOCIAL_FEEDS_FAILED' }));
  }
}

/**
 * POST /api/social/feeds/sync — body: { projectId }. Runs a synchronous,
 * controlled sync of the project's CURRENTLY ACTIVE Facebook Page and its
 * linked Instagram account (the Feeds page Refresh button) — matching
 * exactly what Feeds itself reads by default, and required for
 * performance now that per-account sync depth is much deeper (see
 * socialSyncService.js's SYNC_BATCH_LIMIT comment): syncing every
 * connected account unconditionally was confirmed live to make a single
 * Refresh exceed 3 minutes on a project with ~19 connected Pages. One
 * account's Meta API/token failure never fails the whole request.
 */
export async function syncFeedsHandler(req, res) {
  const projectId = req.projectId;

  try {
    const result = await syncProjectSocialFeeds(projectId);
    return res.json(ResponseUtil.success(result));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_FEEDS] Sync failed', { message: error.message }, { projectId });
    return res.status(500).json(ResponseUtil.error('Failed to sync feeds', 500, { code: 'SOCIAL_FEEDS_SYNC_FAILED' }));
  }
}

export default { getFeedsHandler, syncFeedsHandler };
