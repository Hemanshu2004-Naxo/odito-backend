import SocialAccount from '../model/SocialAccount.js';
// Called through the default-exported object (not named imports) so tests
// can substitute getPageInstagramAccount/getInstagramProfile for the
// duration of a single test (restored in a finally, same discipline as the
// console.log-capture technique Phase 1's own tests already use) — this
// repo has no mocking library, and Meta will never return a genuine
// "linked Instagram account" payload for a fake token, so the success-path
// tests (Section 11, cases 1/3/9/10) have no other way to exist as
// automated tests. metaPageService.js's own named exports are unaffected
// and still used directly wherever real Graph calls are wanted.
import metaPageService from './metaPageService.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * MetaInstagramService — Phase 3 orchestration: Facebook Page -> Instagram
 * Business/Professional Account discovery, profile retrieval, and
 * SocialAccount persistence. This is the ONLY place that ties the Graph
 * API layer (metaPageService.js) to the database (SocialAccount model) for
 * Instagram — controllers call this function and nothing lower-level.
 *
 * Deliberately takes only { projectId, pageId } — never a token. The Page
 * access token is always loaded fresh from the already-persisted, encrypted
 * Facebook SocialAccount row, never accepted as a parameter, so this
 * function structurally cannot be driven by a client-supplied token no
 * matter what calls it (the current caller: selectMetaPage right after
 * creating the Facebook connection; a possible future caller: a manual
 * "retry Instagram discovery" endpoint — both go through the same,
 * DB-sourced trust boundary).
 */

const REASON = {
  NOT_CONNECTED: 'NOT_CONNECTED',
  ACCESS_DENIED: 'ACCESS_DENIED',
  DISCOVERY_FAILED: 'DISCOVERY_FAILED',
  PROFILE_FETCH_FAILED: 'PROFILE_FETCH_FAILED',
  INVALID_PAGE_CONNECTION: 'INVALID_PAGE_CONNECTION',
};

const ERROR_CODE_TO_REASON = {
  META_INSTAGRAM_ACCESS_DENIED: REASON.ACCESS_DENIED,
  META_INSTAGRAM_DISCOVERY_FAILED: REASON.DISCOVERY_FAILED,
};

/**
 * Runs Facebook Page -> Instagram discovery for a project's connected
 * Page and persists the result. Never throws — every failure path (no
 * linked account, access denied, Meta API error, malformed response,
 * timeout, missing/inactive Page connection) resolves to
 * { connected: false, reason }, since Instagram discovery is a best-effort
 * step layered on top of an already-successful Facebook connection and
 * must never surface as a hard failure of that connection.
 */
export async function discoverInstagramForPage({ projectId, pageId }) {
  const fbAccount = await SocialAccount.findOne({ project_id: projectId, platform: 'facebook', pageId, status: 'active' });
  if (!fbAccount) {
    LoggerUtil.service('MetaInstagram', 'discover', 'invalid_page_connection', { projectId, pageId });
    return { connected: false, reason: REASON.INVALID_PAGE_CONNECTION };
  }

  // Decrypted via the schema's own getter — the ONLY source of this token;
  // never accepted as an argument to this function (see file header).
  const pageAccessToken = fbAccount.accessToken;

  const linkResult = await metaPageService.getPageInstagramAccount(pageId, pageAccessToken);
  if (!linkResult.success) {
    LoggerUtil.service('MetaInstagram', 'discover', 'link_lookup_failed', { projectId, pageId, code: linkResult.error?.code });
    return { connected: false, reason: ERROR_CODE_TO_REASON[linkResult.error?.code] || REASON.DISCOVERY_FAILED };
  }

  if (!linkResult.instagramBusinessAccountId) {
    // A genuinely normal outcome (Section 1: "do not treat 'no Instagram
    // account connected' as a server error"). If a previously-connected
    // Instagram account exists for this Page and has since been unlinked
    // on Meta's side, mark it revoked rather than leaving a stale "active"
    // row behind (Section 5: "previously revoked Instagram account").
    await SocialAccount.updateMany(
      { project_id: projectId, platform: 'instagram', pageId, status: 'active' },
      { $set: { status: 'revoked' } },
    );
    LoggerUtil.service('MetaInstagram', 'discover', 'not_connected', { projectId, pageId });
    return { connected: false, reason: REASON.NOT_CONNECTED };
  }

  const instagramBusinessAccountId = linkResult.instagramBusinessAccountId;

  // The Page's linked Instagram account changed since a prior connection —
  // revoke any other active Instagram row under this same Page that is NOT
  // the currently-linked account (Section 5: "Instagram account changed").
  await SocialAccount.updateMany(
    { project_id: projectId, platform: 'instagram', pageId, platformAccountId: { $ne: instagramBusinessAccountId }, status: 'active' },
    { $set: { status: 'revoked' } },
  );

  const profileResult = await metaPageService.getInstagramProfile(instagramBusinessAccountId, pageAccessToken);
  if (!profileResult.success) {
    LoggerUtil.service('MetaInstagram', 'discover', 'profile_fetch_failed', { projectId, pageId, instagramBusinessAccountId });
    return { connected: false, reason: REASON.PROFILE_FETCH_FAILED };
  }

  const profile = profileResult.profile;

  let igAccount = await SocialAccount.findOne({ project_id: projectId, platform: 'instagram', platformAccountId: instagramBusinessAccountId });
  if (!igAccount) {
    igAccount = new SocialAccount({
      user_id: fbAccount.user_id,
      project_id: projectId,
      platform: 'instagram',
      platformAccountId: instagramBusinessAccountId,
      // Meta's own field name (instagram_business_account) is the closest
      // thing to a real "account type" this discovery path exposes — the
      // Graph API does not return a Business/Creator distinction through
      // this endpoint without additional permissions Phase 3 does not
      // request. 'business' is a real, non-invented classification, not a
      // placeholder default (see SocialAccount.js's ACCOUNT_TYPES).
      accountType: 'business',
    });
  }
  igAccount.platformAccountName = profile.username || profile.name || null;
  igAccount.pageId = pageId;
  igAccount.instagramBusinessAccountId = instagramBusinessAccountId;
  // Assigning through the document so the schema's `set: encryptToken`
  // transform runs (same reasoning as selectMetaPage's own Facebook save —
  // findOneAndUpdate-style queries do not apply Mongoose setters).
  // IMPORTANT: this is the SAME Page token already stored on fbAccount —
  // Meta does not issue a separate Instagram-specific token for a Page's
  // linked IG Business Account; inventing one here would be a fabricated
  // credential Meta was never asked for.
  igAccount.accessToken = pageAccessToken;
  // Same token => same real expiry/verification facts as its Page row.
  igAccount.tokenExpiresAt = fbAccount.tokenExpiresAt || null;
  igAccount.dataAccessExpiresAt = fbAccount.dataAccessExpiresAt || null;
  igAccount.lastVerifiedAt = fbAccount.lastVerifiedAt || null;
  igAccount.statusReason = null;
  igAccount.scopes = fbAccount.scopes;
  igAccount.status = 'active';
  igAccount.metadata = {
    username: profile.username || null,
    name: profile.name || null,
    profilePicture: profile.profilePictureUrl || null,
  };
  igAccount.lastSyncedAt = new Date();

  try {
    await igAccount.save();
  } catch (saveError) {
    if (saveError?.code === 11000) {
      // Same race-recovery pattern as selectMetaPage's Facebook save — a
      // concurrent discovery run already created this exact
      // (project, platform, platformAccountId) row.
      LoggerUtil.service('MetaInstagram', 'discover', 'duplicate_race_recovered', { projectId, pageId });
      igAccount = await SocialAccount.findOne({ project_id: projectId, platform: 'instagram', platformAccountId: instagramBusinessAccountId });
    } else {
      throw saveError;
    }
  }

  LoggerUtil.service('MetaInstagram', 'discover', 'completed', { projectId, pageId, instagramBusinessAccountId });

  return { connected: true, accountId: instagramBusinessAccountId, username: profile.username || null };
}

export default { discoverInstagramForPage };
