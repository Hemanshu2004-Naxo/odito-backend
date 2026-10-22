import crypto from 'crypto';
import { randomUUID } from 'crypto';
import RefreshToken from '../model/RefreshToken.js';
import User from '../model/User.js';
import {
  signAccessToken,
  resolveUserTokenVersion,
  parseDurationToMs,
  ACCESS_TOKEN_TTL_SECONDS,
} from './tokenService.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * The opaque, rotating, server-stored refresh token (Phase 2).
 *
 *   authController -> authService -> tokenService
 *                                 -> refreshTokenService -> RefreshToken model
 *
 * No HTTP here, no Mongo logic in controllers. Every function is unit /
 * integration testable on its own.
 *
 * Concurrency: rotation claims the presented token with a single atomic
 * `findOneAndUpdate({ tokenHash, revokedAt:null, expiresAt:{$gt:now} }, ...)`.
 * MongoDB serialises writes to one document, so exactly one of N concurrent
 * refreshes wins the claim. The rest fall through to the reuse path.
 *
 * Reuse vs. race: presenting an already-rotated token is reuse. But a
 * well-behaved client that accidentally fires two refreshes at once would
 * also land here. We only treat it as an ATTACK (and revoke the whole
 * family) if the replay happens OUTSIDE a short grace window after the
 * legitimate rotation — a real attacker replays a stolen token later, not
 * within a few seconds of the client's own rotation.
 *
 * Transactions: this deployment runs standalone MongoDB (see
 * userCascadeDeleteService.js), so no multi-doc transactions. The claim is
 * atomic; if creating the replacement fails after the claim, the old token
 * is already dead and the client simply re-authenticates — we fail toward
 * "must log in again", never toward "two live tokens".
 */

const REFRESH_TOKEN_BYTES = 32; // 256-bit opaque token
// Benign concurrent double-submit tolerance. Replaying an already-rotated
// token WITHIN this window of its rotation is treated as a client race
// (refuse the one request, family untouched); OUTSIDE it, as token theft
// (revoke the whole family). Not an env var — a security-behaviour constant.
export const ROTATION_GRACE_MS = 10_000;

// rememberMe === true -> long session; false -> shorter. The old
// rememberMe->access-token-lifetime coupling is gone (Phase 2 §15): the
// access token is always short-lived; rememberMe now only sizes the
// refresh (session) lifetime.
export const REFRESH_TTL_MS = parseDurationToMs(process.env.REFRESH_TOKEN_EXPIRES_IN, 60 * 86400 * 1000); // 60d
export const REFRESH_TTL_SHORT_MS = parseDurationToMs(process.env.REFRESH_TOKEN_EXPIRES_IN_SHORT, 7 * 86400 * 1000); // 7d

const DEVICE_LABEL_MAX = 120;
const USER_AGENT_MAX = 400;
const IP_MAX = 64;

function refreshError(code, httpStatus, message) {
  const err = new Error(message || code);
  err.code = code;
  err.httpStatus = httpStatus;
  err.expose = true; // safe to surface code+message to the client
  return err;
}

/** 256-bit URL-safe random string. Returned to the caller exactly once. */
export function generateOpaqueToken() {
  return crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

/** SHA-256 hex. The token is already high-entropy, so bcrypt would only add latency. */
export function hashRefreshToken(plaintext) {
  return crypto.createHash('sha256').update(String(plaintext)).digest('hex');
}

export function sanitizeDeviceLabel(label) {
  if (typeof label !== 'string') return null;
  const t = label.trim().slice(0, DEVICE_LABEL_MAX);
  return t.length ? t : null;
}
function sanitizeUserAgent(ua) {
  if (typeof ua !== 'string' || !ua.trim()) return null;
  return ua.slice(0, USER_AGENT_MAX);
}
function sanitizeIp(ip) {
  if (typeof ip !== 'string' || !ip.trim()) return null;
  return ip.slice(0, IP_MAX);
}

/** A token that was superseded by rotation and is now being presented again. */
export function detectReuse(record) {
  return Boolean(record && record.revokedAt && record.revokedReason === 'rotation');
}

/**
 * Create a refresh-token row. Used by initial login (no familyId -> a new
 * family) and by rotation (familyId + absolute expiresAt carried forward).
 * @returns {Promise<{ plaintext: string, record: object }>}
 */
export async function issueRefreshToken({
  userId,
  familyId,
  deviceLabel,
  userAgent,
  ipAddress,
  rememberMe = false,
  tokenVersionAtIssue = 0,
  expiresAt,
}) {
  const plaintext = generateOpaqueToken();
  const tokenHash = hashRefreshToken(plaintext);
  const resolvedExpiry =
    expiresAt instanceof Date
      ? expiresAt
      : new Date(Date.now() + (rememberMe ? REFRESH_TTL_MS : REFRESH_TTL_SHORT_MS));

  const record = await RefreshToken.create({
    userId,
    tokenHash,
    familyId: familyId || randomUUID(),
    deviceLabel: sanitizeDeviceLabel(deviceLabel),
    userAgent: sanitizeUserAgent(userAgent),
    ipAddress: sanitizeIp(ipAddress),
    tokenVersionAtIssue: Number.isFinite(tokenVersionAtIssue) ? tokenVersionAtIssue : 0,
    expiresAt: resolvedExpiry,
    lastUsedAt: new Date(),
  });

  return { plaintext, record };
}

/**
 * Issue the full session bundle at LOGIN: a short mobile access token + a
 * fresh refresh-token family. The caller (authService) separately returns
 * the legacy long-lived `data.token` for the web.
 *
 * Returns ONLY the four client-facing fields — no `familyId` / row id / any
 * other DB detail (§10/§11).
 * @returns {Promise<{ accessToken, refreshToken, tokenType, expiresIn }>}
 */
export async function issueSessionBundle(user, { rememberMe = false, deviceLabel, userAgent, ipAddress } = {}) {
  const { plaintext } = await issueRefreshToken({
    userId: user._id,
    deviceLabel,
    userAgent,
    ipAddress,
    rememberMe,
    tokenVersionAtIssue: resolveUserTokenVersion(user),
  });
  return {
    accessToken: signAccessToken(user),
    refreshToken: plaintext,
    tokenType: 'Bearer',
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  };
}

/**
 * POST /api/auth/refresh. Atomically rotate the presented refresh token and
 * mint a new access token. Throws a coded error (err.code / err.httpStatus)
 * on any failure.
 * @returns {Promise<{ accessToken, refreshToken, tokenType, expiresIn }>}
 */
export async function rotateRefreshToken({ presentedToken, userAgent, ipAddress, deviceLabel } = {}) {
  if (typeof presentedToken !== 'string' || presentedToken.length < 16) {
    throw refreshError('REFRESH_TOKEN_INVALID', 401, 'Invalid refresh token.');
  }

  const presentedHash = hashRefreshToken(presentedToken);
  const now = new Date();

  // Atomic claim — only one concurrent caller flips an active, unexpired
  // token to revoked. `new:false` returns the pre-update doc (familyId,
  // userId, deviceLabel, absolute expiresAt, tokenVersionAtIssue).
  const claimed = await RefreshToken.findOneAndUpdate(
    { tokenHash: presentedHash, revokedAt: null, expiresAt: { $gt: now } },
    { $set: { revokedAt: now, revokedReason: 'rotation', lastUsedAt: now } },
    { new: false }
  );

  if (!claimed) {
    const existing = await RefreshToken.findOne({ tokenHash: presentedHash }).lean();
    if (!existing) throw refreshError('REFRESH_TOKEN_INVALID', 401, 'Invalid refresh token.');

    if (!existing.revokedAt && existing.expiresAt <= now) {
      throw refreshError('REFRESH_TOKEN_EXPIRED', 401, 'Your session has expired. Please sign in again.');
    }

    if (detectReuse(existing)) {
      const sinceRotationMs = now.getTime() - new Date(existing.revokedAt).getTime();
      if (sinceRotationMs <= ROTATION_GRACE_MS) {
        // Benign concurrent double-submit — the winning request already
        // rotated this token moments ago. Don't punish the family; just
        // refuse this one. The client should use the pair it already got.
        throw refreshError('REFRESH_TOKEN_INVALID', 401, 'Invalid refresh token.');
      }
      // Replayed well after rotation -> treat as theft: kill the whole family.
      const revoked = await revokeFamily(existing.familyId, 'reuse_detected');
      LoggerUtil.security('refresh_token_reuse_detected', String(existing.userId), {
        familyId: existing.familyId,
        familyTokensRevoked: revoked,
      });
      throw refreshError('REFRESH_TOKEN_REUSE', 401, 'This session has been revoked. Please sign in again.');
    }

    // Revoked for some other reason (logout / logout_all / password_changed /
    // password_reset / account_suspended / reuse_detected on a sibling).
    throw refreshError('REFRESH_TOKEN_REVOKED', 401, 'This session has been revoked. Please sign in again.');
  }

  const user = await User.findById(claimed.userId).select('-password');
  if (!user) {
    await revokeFamily(claimed.familyId, 'account_deleted');
    throw refreshError('REFRESH_TOKEN_INVALID', 401, 'Invalid refresh token.');
  }
  if (!user.isActive) {
    await revokeFamily(claimed.familyId, 'account_suspended');
    throw refreshError('ACCOUNT_SUSPENDED', 403, 'Your account has been suspended.');
  }
  // Defence in depth: a password change/reset both bumps tokenVersion AND
  // revokes every refresh token; this catches the theoretical gap where a
  // token was created in the same instant the revoke-all ran.
  if (resolveUserTokenVersion(user) !== (claimed.tokenVersionAtIssue || 0)) {
    await revokeFamily(claimed.familyId, 'password_changed');
    throw refreshError('REFRESH_TOKEN_REVOKED', 401, 'This session has been revoked. Please sign in again.');
  }

  // Replacement in the SAME family, carrying the family's ABSOLUTE expiry
  // (no sliding — a session has a hard maximum lifetime).
  const { plaintext: newPlaintext, record: next } = await issueRefreshToken({
    userId: user._id,
    familyId: claimed.familyId,
    deviceLabel: deviceLabel != null ? deviceLabel : claimed.deviceLabel,
    userAgent: userAgent != null ? userAgent : claimed.userAgent,
    ipAddress: ipAddress != null ? ipAddress : claimed.ipAddress,
    tokenVersionAtIssue: resolveUserTokenVersion(user),
    expiresAt: claimed.expiresAt,
  });

  try {
    await RefreshToken.updateOne({ _id: claimed._id }, { $set: { replacedBy: next._id } });
  } catch (e) {
    LoggerUtil.warn('refreshTokenService: failed to link replacedBy (non-fatal)', { error: e.message });
  }

  return {
    accessToken: signAccessToken(user),
    refreshToken: newPlaintext,
    tokenType: 'Bearer',
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  };
}

/**
 * POST /api/auth/logout — revoke ONE refresh token, but only if it belongs
 * to the authenticated user.
 * @returns {Promise<{ revoked: boolean, reason: string }>}
 * @throws coded REFRESH_TOKEN_MISMATCH (403) if the token belongs to someone else
 */
export async function revokeRefreshTokenForUser({ presentedToken, userId }) {
  if (typeof presentedToken !== 'string' || !presentedToken) {
    return { revoked: false, reason: 'no_token' };
  }
  const record = await RefreshToken.findOne({ tokenHash: hashRefreshToken(presentedToken) });
  if (!record) return { revoked: false, reason: 'not_found' }; // idempotent, no enumeration
  if (String(record.userId) !== String(userId)) {
    throw refreshError('REFRESH_TOKEN_MISMATCH', 403, 'That session does not belong to this account.');
  }
  if (record.revokedAt) return { revoked: false, reason: 'already_revoked' };

  await RefreshToken.updateOne(
    { _id: record._id, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: 'logout' } }
  );
  return { revoked: true, reason: 'logout' };
}

/** Revoke every active refresh token in a rotation family. */
export async function revokeFamily(familyId, reason) {
  if (!familyId) return 0;
  const res = await RefreshToken.updateMany(
    { familyId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } }
  );
  return res.modifiedCount ?? res.nModified ?? 0;
}

/**
 * Revoke every active refresh session for a user — logout-all, and the
 * password-change / password-reset / suspension hooks.
 */
export async function revokeUserRefreshTokens(userId, reason) {
  if (!userId) return 0;
  const res = await RefreshToken.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } }
  );
  return res.modifiedCount ?? res.nModified ?? 0;
}

export default {
  generateOpaqueToken,
  hashRefreshToken,
  detectReuse,
  sanitizeDeviceLabel,
  issueRefreshToken,
  issueSessionBundle,
  rotateRefreshToken,
  revokeRefreshTokenForUser,
  revokeFamily,
  revokeUserRefreshTokens,
  REFRESH_TTL_MS,
  REFRESH_TTL_SHORT_MS,
  ROTATION_GRACE_MS,
};
