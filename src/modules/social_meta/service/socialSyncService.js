import SocialAccount from '../model/SocialAccount.js';
import SocialPost from '../model/SocialPost.js';
// Called through the default-exported objects (not named imports) so
// tests can substitute getPagePosts/getInstagramMedia for the duration of
// one test — same discipline as every other *Service.js file in this
// module that talks to Meta (see metaPageService.js's own header comment
// for the full rationale: no mocking library exists in this repo, and
// Meta will never return a deterministic fixture for a fake token).
import facebookPageDataService from './facebookPageDataService.js';
import instagramMediaService from './instagramMediaService.js';
import { mapFacebookPost, mapInstagramMedia } from './socialPostMapper.js';
import { getActiveFacebookAccount, getActiveInstagramAccount } from './facebookAccountService.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { markAccountExpired } from './metaTokenService.js';

/**
 * SocialSyncService — orchestration for the Feeds page: for every
 * connected Facebook/Instagram account on a project, fetch real posts/
 * media from Meta, normalize, and upsert into SocialPost. This is a plain
 * async function with no Express/job-queue dependency, callable directly
 * from the sync HTTP endpoint (feedController.js's Refresh handler)
 * today, and trivially wrappable by a future scheduler/queue exactly the
 * way weeklyRecheckScheduler.js/staleLockScheduler.js already wrap other
 * plain service functions in this codebase — without this file changing.
 * Deliberately NOT wired into the existing jobs/chainingEngine pipeline
 * (Job/JobGroup/pipelineConfig): that pipeline is purpose-built for the
 * page-audit domain (PAGE_SCRAPING/HEADLESS/SEO_SCORING chaining) and
 * forcing an unrelated domain into it would be exactly the kind of
 * unrelated-module rewrite this task was told not to do.
 *
 * One failed account (expired token, Meta API error, network failure)
 * never aborts sync for the project's other accounts — each account is
 * processed and any error caught individually.
 */

// Per-account, per-sync-run SAFETY CEILING, not a target — real accounts
// (even active, long-running Pages) overwhelmingly have far fewer than
// this many posts, so in practice a sync now imports the account's FULL
// real history. This exists only to bound a truly pathological account
// (tens of thousands of historical posts) so one Refresh click can never
// run unboundedly long. Previously 50 — a real, reported bug: an account
// with 112 real Instagram posts (or hundreds of real Facebook posts) was
// permanently capped at 50 forever, with every subsequent Refresh
// re-importing the same first 50 and never reaching the rest, because
// nothing continued the pagination past one batch.
const SYNC_BATCH_LIMIT = 1000;

// Shared per-request page size for BOTH platforms' pagination loops
// below. Facebook-confirmed LIVE against a real connected Page: requesting
// this module's full post field expansion (likes.summary(true) +
// comments.summary(true) + attachments{...}) at limit:50 in one call makes
// Meta reject the ENTIRE request — real error: status 500, error.code 1,
// "Please reduce the amount of data you're asking for, then retry your
// request" (Meta's own request-complexity ceiling, not a token/permission/
// network problem); limit:25 with the identical field set succeeded.
// Instagram's media fields (flat like_count/comments_count scalars, no
// nested summary edges) are cheaper and have not shown this failure, but
// the same conservative page size is used for both rather than assuming a
// higher untested ceiling — this only affects how many round trips a sync
// takes, not how many posts end up stored.
const SYNC_PAGE_FETCH_LIMIT = 25;

const TOKEN_INVALID_CODES = new Set(['FACEBOOK_TOKEN_INVALID', 'INSTAGRAM_TOKEN_INVALID']);

async function upsertPost(projectId, mapped) {
  await SocialPost.findOneAndUpdate(
    { platform: mapped.platform, social_account_id: mapped.social_account_id, externalPostId: mapped.externalPostId },
    { $set: { ...mapped, project_id: projectId, syncedAt: new Date() } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

/**
 * A Meta-confirmed dead token (code 190 family, or a bare 401/403 — see
 * metaErrorClassifier.isAuthenticationFailure) marks the connection as
 * needing reauthorization; any other failure is left for the next sync
 * attempt, never crashing this one. Goes through metaTokenService so the
 * linked Instagram/Facebook rows sharing the same token are expired too.
 */
async function markReauthIfTokenInvalid(account, errorCode) {
  if (!TOKEN_INVALID_CODES.has(errorCode)) return;
  await markAccountExpired(account);
}

async function syncFacebookAccount(account) {
  const pageId = account.pageId || account.platformAccountId;

  const posts = [];
  let after;

  while (posts.length < SYNC_BATCH_LIMIT) {
    const pageLimit = Math.min(SYNC_PAGE_FETCH_LIMIT, SYNC_BATCH_LIMIT - posts.length);
    // eslint-disable-next-line no-await-in-loop -- each page depends on the previous page's cursor, must be sequential
    const result = await facebookPageDataService.getPagePosts(pageId, account.accessToken, { limit: pageLimit, after });

    if (!result.success) {
      if (posts.length > 0) {
        // A later page failed after earlier pages already succeeded —
        // keep the real posts already fetched rather than discarding
        // them; the next sync run will pick up where this left off.
        LoggerUtil.info('FACEBOOK_SYNC_PARTIAL_PAGE_FAILURE', { socialAccountId: account._id.toString(), postsFetchedBeforeFailure: posts.length, errorCode: result.error?.code });
        break;
      }
      await markReauthIfTokenInvalid(account, result.error?.code);
      return { success: false, postsSynced: 0, errorCode: result.error?.code || 'SYNC_FAILED' };
    }

    posts.push(...result.posts);
    if (!result.nextCursor || result.posts.length === 0) break;
    after = result.nextCursor;
  }

  for (const rawPost of posts) {
    await upsertPost(account.project_id, mapFacebookPost(account, rawPost));
  }

  account.lastSyncedAt = new Date();
  await account.save();
  return { success: true, postsSynced: posts.length };
}

async function syncInstagramAccount(account) {
  const igAccountId = account.instagramBusinessAccountId || account.platformAccountId;

  const media = [];
  let after;

  // Same "follow the cursor until exhausted or the safety ceiling" shape
  // as syncFacebookAccount below — previously this made exactly ONE call
  // (`limit: SYNC_BATCH_LIMIT`), which never actually reached more than
  // whatever Meta chose to return for a single page, so an account with
  // more real media than that page size was permanently stuck.
  while (media.length < SYNC_BATCH_LIMIT) {
    const pageLimit = Math.min(SYNC_PAGE_FETCH_LIMIT, SYNC_BATCH_LIMIT - media.length);
    // eslint-disable-next-line no-await-in-loop -- each page depends on the previous page's cursor, must be sequential
    const result = await instagramMediaService.getInstagramMedia(igAccountId, account.accessToken, { limit: pageLimit, after });

    if (!result.success) {
      if (media.length > 0) {
        LoggerUtil.info('INSTAGRAM_SYNC_PARTIAL_PAGE_FAILURE', { socialAccountId: account._id.toString(), mediaFetchedBeforeFailure: media.length, errorCode: result.error?.code });
        break;
      }
      await markReauthIfTokenInvalid(account, result.error?.code);
      return { success: false, postsSynced: 0, errorCode: result.error?.code || 'SYNC_FAILED' };
    }

    media.push(...result.media);
    if (!result.nextCursor || result.media.length === 0) break;
    after = result.nextCursor;
  }

  for (const rawMedia of media) {
    await upsertPost(account.project_id, mapInstagramMedia(account, rawMedia));
  }

  account.lastSyncedAt = new Date();
  await account.save();
  return { success: true, postsSynced: media.length };
}

/**
 * Syncs a project's connected Facebook/Instagram account(s). Never
 * throws — an unexpected per-account error is caught and reported in that
 * account's own result entry so any other account being synced still gets
 * processed.
 *
 * Default (scopeToActiveAccounts: true, what the Feeds page's Refresh
 * button calls): syncs ONLY the currently active Facebook Page + its
 * linked Instagram account — the same account(s) Feeds now reads by
 * default (see socialFeedService.js). This is both correct (Refresh
 * should refresh what you're looking at, not silently re-import every
 * connected Page) and a real, confirmed PERFORMANCE requirement: with the
 * per-account depth raised (SYNC_BATCH_LIMIT), syncing every connected
 * Page unconditionally was measured live to make a single Refresh click
 * exceed 3 minutes on a project with ~19 connected Pages — clearly not
 * production-safe as a synchronous HTTP request. Pass
 * `scopeToActiveAccounts: false` to restore the original "every connected
 * account" behavior.
 */
export async function syncProjectSocialFeeds(projectId, { scopeToActiveAccounts = true } = {}) {
  let accounts;
  if (scopeToActiveAccounts) {
    const [activeFacebook, activeInstagram] = await Promise.all([
      getActiveFacebookAccount(projectId),
      getActiveInstagramAccount(projectId),
    ]);
    accounts = [activeFacebook, activeInstagram].filter(Boolean);
  } else {
    accounts = await SocialAccount.find({ project_id: projectId, platform: { $in: ['facebook', 'instagram'] }, status: 'active' });
  }

  const results = [];
  for (const account of accounts) {
    try {
      const outcome = account.platform === 'facebook' ? await syncFacebookAccount(account) : await syncInstagramAccount(account);
      results.push({ socialAccountId: account._id.toString(), platform: account.platform, accountName: account.platformAccountName, ...outcome });
    } catch (error) {
      LoggerUtil.error('[SOCIAL_SYNC] Unexpected error syncing account', { message: error.message }, { projectId: String(projectId), socialAccountId: account._id.toString(), platform: account.platform });
      results.push({ socialAccountId: account._id.toString(), platform: account.platform, accountName: account.platformAccountName, success: false, postsSynced: 0, errorCode: 'SYNC_FAILED' });
    }
  }

  const totalPostsSynced = results.reduce((sum, r) => sum + (r.postsSynced || 0), 0);
  LoggerUtil.info('SOCIAL_SYNC_COMPLETED', {
    projectId: String(projectId),
    accountsSynced: results.length,
    totalPostsSynced,
    failures: results.filter((r) => !r.success).length,
  });

  return { accounts: results, totalPostsSynced };
}

export default { syncProjectSocialFeeds };
