import { OAuth2Client } from 'google-auth-library';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

const SERVICE = 'GoogleTokenRevocation';

/**
 * Revokes a single Google OAuth token (refresh or access — Google's revoke
 * endpoint accepts either, and revoking either one invalidates the whole
 * grant) via google-auth-library, the same package oauth.routes.js already
 * uses for every other Google OAuth operation in this codebase. No new
 * dependency, no raw fetch() to Google's revoke endpoint hand-rolled here.
 *
 * Never throws — a revocation failure (token already revoked, network
 * blip, Google outage) must not block account deletion; it's logged and
 * treated as best-effort, same philosophy as
 * projectCascadeDeleteService.js's file-cleanup steps.
 * @param {string} token - a decrypted refresh_token or access_token
 * @returns {Promise<boolean>} whether the revocation call succeeded
 */
export async function revokeGoogleToken(token) {
  if (!token) return false;

  try {
    const client = new OAuth2Client();
    await client.revokeToken(token);
    return true;
  } catch (error) {
    // Google returns an error for an already-invalid/expired/revoked
    // token too — from account deletion's perspective that's already the
    // desired end state, not a failure worth surfacing loudly.
    LoggerUtil.warn(`${SERVICE}: token revocation failed (treated as non-fatal)`, {
      error: error.message,
    });
    return false;
  }
}
