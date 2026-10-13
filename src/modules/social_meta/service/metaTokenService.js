import SocialAccount from '../model/SocialAccount.js';
// Called through the default-exported object (not a named import) so tests
// can substitute `request` for one test — same convention as every other
// Graph-calling service in this module (see metaPageService.js).
import metaApiService from './metaApiService.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { recordConnectionExpired } from '../../../monitoring/socialAiMetrics.js';

/**
 * MetaTokenService — the single, reusable place that answers "is this
 * connection's token still good?" and the ONLY place that moves a
 * SocialAccount to status:'expired'. Controllers/adapters/sync code call
 * these functions; none of them implements its own token checking.
 *
 * Token inspection uses Meta's documented GET /debug_token endpoint,
 * authenticated with the APP access token ("{app-id}|{app-secret}"). It
 * reports, for any user/Page token: validity, the real expiry
 * (`expires_at`; 0 means the token never expires — typical for a Page token
 * derived from a long-lived user token), the separate `data_access_expires_at`
 * (when Meta cuts off access to the user's data, ~90 days after they last
 * authorized the app), the granted scopes, and which app/user it belongs to.
 *
 * No function here ever logs, returns, or persists a token; the app-secret
 * access token is built per call and handed straight to metaApiService.
 */

const STATUS_EXPIRED = 'expired';
export const REASON_TOKEN_INVALID = 'META_TOKEN_INVALID';

function epochSecondsToDate(value) {
  const n = Number(value);
  // Meta uses 0 (or an absent field) for "does not expire".
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : null;
}

function appAccessToken() {
  const id = process.env.META_APP_ID;
  const secret = process.env.META_APP_SECRET;
  return id && secret ? `${id}|${secret}` : null;
}

/**
 * Inspects one token with Meta.
 *
 * Never throws. Resolves to either
 *   { success: true, valid, expiresAt, neverExpires, dataAccessExpiresAt,
 *     scopes, appId, userId, type, reason }
 * where `valid:false` means Meta CONFIRMED the token is unusable (reason is a
 * stable code), or
 *   { success: false, reason }
 * when the check itself could not be completed (Meta unreachable, app
 * credentials not configured) — which must never be mistaken for "invalid".
 */
export async function inspectToken(token) {
  if (!token) return { success: true, valid: false, reason: 'NO_TOKEN', expiresAt: null, neverExpires: false, dataAccessExpiresAt: null, scopes: [] };

  const appToken = appAccessToken();
  if (!appToken) {
    LoggerUtil.service('MetaToken', 'inspect', 'not_configured');
    return { success: false, reason: 'META_APP_NOT_CONFIGURED' };
  }

  const result = await metaApiService.request({
    method: 'GET',
    path: '/debug_token',
    params: { input_token: token },
    accessToken: appToken,
    context: 'meta_debug_token',
  });

  if (!result.success) {
    // Meta answers a malformed/expired *input* token with HTTP 400 code 190
    // on some versions — that is a definitive "invalid", not an outage.
    const code = result.data?.error?.code;
    if (code === 190) {
      LoggerUtil.service('MetaToken', 'inspect', 'invalid', { via: 'http_error' });
      return { success: true, valid: false, reason: REASON_TOKEN_INVALID, expiresAt: null, neverExpires: false, dataAccessExpiresAt: null, scopes: [] };
    }
    LoggerUtil.service('MetaToken', 'inspect', 'failed', { status: result.status, kind: result.kind || null });
    return { success: false, reason: 'DEBUG_TOKEN_REQUEST_FAILED' };
  }

  const data = result.data?.data;
  if (!data || typeof data.is_valid !== 'boolean') {
    LoggerUtil.service('MetaToken', 'inspect', 'malformed_response');
    return { success: false, reason: 'DEBUG_TOKEN_MALFORMED' };
  }

  const expiresAt = epochSecondsToDate(data.expires_at);
  const dataAccessExpiresAt = epochSecondsToDate(data.data_access_expires_at);
  const now = Date.now();

  // A token for a different app can never be used by this one, whatever
  // Meta says about its validity.
  const appMismatch = data.app_id && process.env.META_APP_ID && String(data.app_id) !== String(process.env.META_APP_ID);
  const expired = (expiresAt && expiresAt.getTime() <= now) || (dataAccessExpiresAt && dataAccessExpiresAt.getTime() <= now);
  const valid = data.is_valid === true && !appMismatch && !expired;

  LoggerUtil.service('MetaToken', 'inspect', valid ? 'valid' : 'invalid', { type: data.type || null });
  return {
    success: true,
    valid,
    reason: valid ? null : (appMismatch ? 'APP_MISMATCH' : REASON_TOKEN_INVALID),
    expiresAt,
    neverExpires: expiresAt === null,
    dataAccessExpiresAt,
    scopes: Array.isArray(data.scopes) ? data.scopes : [],
    appId: data.app_id ? String(data.app_id) : null,
    userId: data.user_id ? String(data.user_id) : null,
    type: data.type || null,
  };
}

/**
 * Marks an account — and every other row that shares its token — expired.
 *
 * A Facebook Page and the Instagram Business Account linked through it are
 * two SocialAccount rows holding the SAME Page token (see
 * metaInstagramService.js), so a dead token kills both; leaving the sibling
 * `active` would report a connection that can no longer do anything.
 * updateMany (not per-doc save) so it is a single atomic write and never
 * races a concurrent save into resurrecting a stale status. Only rows still
 * `active` are touched — a user-revoked row stays revoked.
 */
export async function markAccountExpired(account, { reason = REASON_TOKEN_INVALID } = {}) {
  if (!account) return { modifiedCount: 0 };

  const pageId = account.platform === 'facebook' ? account.platformAccountId : account.pageId;
  const sharesToken = [{ _id: account._id }];
  if (pageId) {
    sharesToken.push({ platform: 'facebook', platformAccountId: pageId });
    sharesToken.push({ platform: 'instagram', pageId });
  }

  const res = await SocialAccount.updateMany(
    { project_id: account.project_id, status: 'active', $or: sharesToken },
    { $set: { status: STATUS_EXPIRED, statusReason: reason } },
  );

  // Keep the in-memory document the caller is holding consistent (the write
  // above already happened; a later save() just re-writes the same values).
  account.status = STATUS_EXPIRED;
  account.statusReason = reason;

  if (res.modifiedCount > 0) recordConnectionExpired();
  LoggerUtil.info('SOCIAL_ACCOUNT_EXPIRED', {
    projectId: String(account.project_id),
    socialAccountId: String(account._id),
    platform: account.platform,
    reason,
    rowsExpired: res.modifiedCount,
  });
  return { modifiedCount: res.modifiedCount };
}

/** Normalized, token-free health shape shared by every caller / API response. */
function toHealth(account, inspection) {
  const isExpired = account.status === STATUS_EXPIRED;
  return {
    status: account.status,
    valid: inspection?.success ? inspection.valid : null, // null = could not be verified
    requiresReconnect: isExpired,
    expiresAt: account.tokenExpiresAt || null,
    dataAccessExpiresAt: account.dataAccessExpiresAt || null,
    lastVerifiedAt: account.lastVerifiedAt || null,
  };
}

/**
 * Persists an inspection result onto an account row (and its token-sharing
 * siblings): expiry fields + lastVerifiedAt when Meta confirmed the token is
 * valid, status:'expired' when Meta confirmed it is not, and NOTHING when the
 * check itself failed (an outage must never expire or "verify" a connection).
 */
export async function applyInspection(account, inspection) {
  if (!inspection?.success) return toHealth(account, inspection);

  if (!inspection.valid) {
    await markAccountExpired(account, { reason: inspection.reason || REASON_TOKEN_INVALID });
    return toHealth(account, inspection);
  }

  const now = new Date();
  const pageId = account.platform === 'facebook' ? account.platformAccountId : account.pageId;
  const sharesToken = [{ _id: account._id }];
  if (pageId) {
    sharesToken.push({ platform: 'facebook', platformAccountId: pageId });
    sharesToken.push({ platform: 'instagram', pageId });
  }
  await SocialAccount.updateMany(
    { project_id: account.project_id, $or: sharesToken },
    { $set: { tokenExpiresAt: inspection.expiresAt, dataAccessExpiresAt: inspection.dataAccessExpiresAt, lastVerifiedAt: now } },
  );
  account.tokenExpiresAt = inspection.expiresAt;
  account.dataAccessExpiresAt = inspection.dataAccessExpiresAt;
  account.lastVerifiedAt = now;
  return toHealth(account, inspection);
}

/** Inspects one account's stored token with Meta and applies the result. */
export async function verifyAccount(account) {
  const inspection = await inspectToken(account.accessToken); // decrypted by the schema getter
  return applyInspection(account, inspection);
}

/**
 * Verifies every ACTIVE Facebook/Instagram connection of a project with ONE
 * Meta call per distinct token (an Instagram row shares its Page's token, so
 * it is verified through the same inspection). Returns safe per-account
 * health only.
 */
export async function verifyProjectAccounts(projectId) {
  const accounts = await SocialAccount.find({ project_id: projectId, platform: { $in: ['facebook', 'instagram'] }, status: 'active' });

  const groups = new Map(); // pageId -> accounts sharing that Page token
  for (const account of accounts) {
    const key = (account.platform === 'facebook' ? account.platformAccountId : account.pageId) || String(account._id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(account);
  }

  const out = [];
  for (const members of groups.values()) {
    const owner = members.find((m) => m.platform === 'facebook') || members[0];
    const inspection = await inspectToken(owner.accessToken);
    for (const member of members) {
      const health = await applyInspection(member, inspection);
      out.push({ platform: member.platform, socialAccountId: member._id.toString(), ...health });
    }
  }
  return out;
}

export default { inspectToken, markAccountExpired, applyInspection, verifyAccount, verifyProjectAccounts, REASON_TOKEN_INVALID };
