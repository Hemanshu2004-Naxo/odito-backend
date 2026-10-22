import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * Centralized signing/verification for the app's authentication JWTs.
 *
 * There are now TWO shapes of session JWT, both signed with the same
 * `JWT_SECRET` and both accepted by the `auth` middleware:
 *
 *   1. LEGACY web session token — `signAuthToken()`.
 *      Payload `{ id, roleId, tokenVersion }`, lifetime 1d (or 7d with
 *      "remember me" / Google). This is what `data.token` in the login and
 *      Google-callback responses has always been, and the existing web
 *      frontend consumes it directly with no refresh logic. UNCHANGED in
 *      Phase 2 — touching it would log every web user out.
 *
 *   2. NEW mobile ACCESS token — `signAccessToken()`.
 *      Payload adds `sub`, `type:'access'`, `iss`, `aud:'odito-mobile'`,
 *      `jti`; short lifetime (ACCESS_TOKEN_EXPIRES_IN, default 30m). Paired
 *      with an opaque rotating refresh token (refreshTokenService.js) and
 *      returned as `data.tokens.accessToken`. A mobile client uses the
 *      `data.tokens.*` bundle exclusively and calls POST /auth/refresh when
 *      the access token expires.
 *
 * Backwards compatibility rules the `auth` middleware enforces:
 *   - `id` is still the primary claim (also mirrored as `sub`) — Socket.IO
 *     and every other consumer read `decoded.id`.
 *   - A token with NO `type` claim is a legacy token and is accepted.
 *   - A token with `type` present MUST be `'access'` (a refresh token is
 *     opaque and can't `jwt.verify` anyway; this is defence in depth).
 *   - `iss` / `aud`, when present, must match; when absent (legacy), skipped.
 *   - `tokenVersion` absent == 0 on both sides, so deploying this logs
 *     nobody out.
 */

// Legacy web session lifetimes — DO NOT change (see note above).
export const SHORT_SESSION_EXPIRY = '1d';
export const LONG_SESSION_EXPIRY = process.env.JWT_EXPIRY || '7d';

export const TOKEN_VERSION_CLAIM = 'tokenVersion';

// ── Mobile access token ──────────────────────────────────────────────────
export const ACCESS_TOKEN_TYPE = 'access';
export const TOKEN_ISSUER = process.env.TOKEN_ISSUER || 'odito';
export const TOKEN_AUDIENCE_MOBILE = process.env.TOKEN_AUDIENCE || 'odito-mobile';

// jsonwebtoken accepts the string form ('30m') directly for `expiresIn`; we
// only sanity-check the format so a typo in env can't silently become NaN.
const DURATION_RE = /^\s*\d+(\.\d+)?\s*(ms|s|m|h|d|w|y)?\s*$/i;
function safeExpiresIn(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && DURATION_RE.test(value)) return value.trim();
  LoggerUtil.warn('tokenService: invalid duration env value, using fallback', { value, fallback });
  return fallback;
}

export const ACCESS_TOKEN_EXPIRES_IN = safeExpiresIn(process.env.ACCESS_TOKEN_EXPIRES_IN, '30m');

/**
 * Parse a duration string ('30m', '60d', '1800s', '2h', '12w') or a raw
 * number of seconds into milliseconds. Invalid input -> fallbackMs (+ warn).
 * Needed for refresh-token `expiresAt` Date math.
 */
export function parseDurationToMs(value, fallbackMs) {
  // Unset / blank -> use the fallback silently (that's the normal case).
  if (value == null || value === '') return fallbackMs;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value * 1000;
  if (typeof value === 'string') {
    const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w|y)?$/i);
    if (m) {
      const n = parseFloat(m[1]);
      const unit = (m[2] || 's').toLowerCase();
      const mult = { ms: 1, s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3, y: 31536000e3 }[unit];
      if (Number.isFinite(n) && n > 0 && mult) return Math.round(n * mult);
    }
  }
  LoggerUtil.warn('tokenService: invalid duration, using fallback ms', { value, fallbackMs });
  return fallbackMs;
}

export const ACCESS_TOKEN_TTL_MS = parseDurationToMs(ACCESS_TOKEN_EXPIRES_IN, 30 * 60 * 1000);
export const ACCESS_TOKEN_TTL_SECONDS = Math.round(ACCESS_TOKEN_TTL_MS / 1000);

/**
 * @param {{ _id?: any, id?: any, roleId?: number, tokenVersion?: number }} user
 *   A User document (or a plain object with the same fields).
 * @param {{ rememberMe?: boolean }} [opts]
 * @returns {string} signed JWT
 */
export function signAuthToken(user, { rememberMe = false } = {}) {
  if (!user || (user._id == null && user.id == null)) {
    throw new Error('signAuthToken: a user with an id is required');
  }

  const payload = {
    id: String(user._id ?? user.id),
    roleId: user.roleId,
    [TOKEN_VERSION_CLAIM]: resolveUserTokenVersion(user),
  };

  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: rememberMe ? LONG_SESSION_EXPIRY : SHORT_SESSION_EXPIRY,
  });
}

/**
 * Sign a short-lived mobile ACCESS token. Paired with an opaque rotating
 * refresh token issued by refreshTokenService. Minimal claims — no email,
 * phone, subscription, or any refresh material.
 *
 * @param {{ _id?: any, id?: any, roleId?: number, tokenVersion?: number }} user
 * @returns {string} signed JWT
 */
export function signAccessToken(user) {
  if (!user || (user._id == null && user.id == null)) {
    throw new Error('signAccessToken: a user with an id is required');
  }
  const id = String(user._id ?? user.id);
  return jwt.sign(
    {
      id,                 // kept for every existing consumer (middleware, Socket.IO)
      sub: id,            // standard subject claim (same value)
      roleId: user.roleId,
      [TOKEN_VERSION_CLAIM]: resolveUserTokenVersion(user),
      type: ACCESS_TOKEN_TYPE,
    },
    process.env.JWT_SECRET,
    {
      expiresIn: ACCESS_TOKEN_EXPIRES_IN,
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE_MOBILE,
      jwtid: randomUUID(),
    }
  );
}

/**
 * Verify a session token. Throws (like `jwt.verify`) on a bad signature,
 * malformed token, or expiry — the `auth` middleware catches that and
 * returns 401. Deliberately does NOT pass `issuer`/`audience` options here,
 * so a LEGACY token (which has neither) still verifies; the middleware does
 * the "if present, must match" checks itself.
 * @param {string} token
 * @returns {object} decoded payload
 */
export function verifyAuthToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

/**
 * The token-version rule, in one place so the signer, the middleware and
 * the tests can't drift: a token minted before `tokenVersion` existed has
 * no such claim and counts as version 0.
 */
export function resolveTokenVersion(decoded) {
  const v = decoded?.[TOKEN_VERSION_CLAIM];
  return Number.isFinite(v) ? v : 0;
}

/**
 * Same rule for the User side: a document created before the field existed
 * reads back `undefined` and counts as version 0.
 */
export function resolveUserTokenVersion(user) {
  const v = user?.tokenVersion;
  return Number.isFinite(v) ? v : 0;
}

export default {
  signAuthToken,
  signAccessToken,
  verifyAuthToken,
  resolveTokenVersion,
  resolveUserTokenVersion,
  parseDurationToMs,
  SHORT_SESSION_EXPIRY,
  LONG_SESSION_EXPIRY,
  TOKEN_VERSION_CLAIM,
  ACCESS_TOKEN_TYPE,
  TOKEN_ISSUER,
  TOKEN_AUDIENCE_MOBILE,
  ACCESS_TOKEN_EXPIRES_IN,
  ACCESS_TOKEN_TTL_MS,
  ACCESS_TOKEN_TTL_SECONDS,
};
