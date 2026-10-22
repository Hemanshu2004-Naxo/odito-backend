import { getFacebookOverview } from '../service/facebookOverviewService.js';
import { listFacebookAccounts, setActiveFacebookAccount } from '../service/facebookAccountService.js';
// Default-exported object (not a named import) — same reason as every
// other cross-service call in this module: tests substitute this function
// for the duration of one test (restored in a finally) since this repo
// has no mocking library and Meta will never return a deterministic
// fixture for a fake token.
import metaInstagramService from '../service/metaInstagramService.js';
import { resolveRange } from '../service/dateRangeUtil.js';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * FacebookController — HTTP only. All Graph API calls and persistence
 * live in facebookOverviewService.js / facebookAccountService.js /
 * facebookPageDataService.js / the SocialAccount model — same layering as
 * every other controller in this module.
 */
export async function getFacebookOverviewHandler(req, res) {
  const projectId = req.projectId;
  const range = resolveRange(req.query?.range);

  try {
    const overview = await getFacebookOverview({ projectId, range });
    return res.json(ResponseUtil.success(overview));
  } catch (error) {
    LoggerUtil.error('[FACEBOOK_OVERVIEW] Failed to load Facebook overview', { message: error.message }, { projectId });
    return res.status(500).json(ResponseUtil.error('Failed to load Facebook data', 500, { code: 'FACEBOOK_OVERVIEW_FAILED' }));
  }
}

/**
 * GET /api/social/facebook/accounts?projectId= — every connected Facebook
 * Page for the project (Switch Account feature), safe metadata only.
 */
export async function getFacebookAccountsHandler(req, res) {
  const projectId = req.projectId;

  try {
    const accounts = await listFacebookAccounts(projectId);
    return res.json(ResponseUtil.success({ accounts }));
  } catch (error) {
    LoggerUtil.error('[FACEBOOK_ACCOUNTS] Failed to list Facebook accounts', { message: error.message }, { projectId });
    return res.status(500).json(ResponseUtil.error('Failed to load Facebook Pages', 500, { code: 'FACEBOOK_ACCOUNTS_FAILED' }));
  }
}

const SWITCH_ERROR_STATUS = {
  SOCIAL_ACCOUNT_NOT_FOUND: 404,
  SOCIAL_PLATFORM_UNSUPPORTED: 400,
  SOCIAL_ACCOUNT_NOT_CONNECTED: 409,
};

/**
 * POST /api/social/facebook/switch — body: { projectId, socialAccountId }.
 * Never accepts or returns a token. This is NOT an OAuth flow — it only
 * changes which already-connected, already-persisted Page the dashboard
 * reads from.
 */
export async function switchFacebookAccountHandler(req, res) {
  const projectId = req.projectId;
  const { socialAccountId } = req.body;

  if (!socialAccountId || typeof socialAccountId !== 'string') {
    return res.status(400).json(ResponseUtil.error('socialAccountId is required.', 400, { code: 'SOCIAL_ACCOUNT_ID_REQUIRED' }));
  }

  try {
    const result = await setActiveFacebookAccount({ projectId, socialAccountId });
    if (!result.success) {
      const status = SWITCH_ERROR_STATUS[result.error.code] || 400;
      LoggerUtil.service('FacebookAccount', 'switch', 'rejected', { projectId, socialAccountId, code: result.error.code });
      return res.status(status).json(ResponseUtil.error(result.error.message, status, { code: result.error.code }));
    }

    // Root-cause fix: discoverInstagramForPage previously only ran ONCE,
    // for the single Page selected at initial OAuth connect
    // (selectMetaPage) — even though persistDiscoveredFacebookPages
    // persists EVERY returned Page as switchable. So switching to any
    // OTHER, never-discovered Page always resolved Instagram as "not
    // connected" even when that Page genuinely has a linked Instagram
    // Business Account on Meta's side — confirmed live: 13 of 19 real
    // connected Pages on the account this was diagnosed against had a
    // real linked Instagram account our own database had simply never
    // recorded. Running discovery again here, for the NEWLY active Page,
    // on every switch closes that gap (idempotent — safe to re-run even
    // if already discovered; self-heals if the Page's Instagram link
    // changes later, matching discoverInstagramForPage's own revocation
    // logic). Never lets a discovery failure fail the switch itself — the
    // Facebook switch is already real and already persisted by this
    // point, same reasoning selectMetaPage's own equivalent call uses.
    try {
      await metaInstagramService.discoverInstagramForPage({ projectId, pageId: result.account.providerAccountId });
    } catch (discoveryError) {
      LoggerUtil.error('[FACEBOOK_SWITCH] Instagram discovery failed after switch (non-fatal)', { message: discoveryError.message }, { projectId, pageId: result.account.providerAccountId });
    }

    return res.json(ResponseUtil.success({ account: result.account }));
  } catch (error) {
    LoggerUtil.error('[FACEBOOK_SWITCH] Failed to switch Facebook account', { message: error.message }, { projectId, socialAccountId });
    return res.status(500).json(ResponseUtil.error('Failed to switch Facebook Page', 500, { code: 'FACEBOOK_SWITCH_FAILED' }));
  }
}

export default { getFacebookOverviewHandler, getFacebookAccountsHandler, switchFacebookAccountHandler };
