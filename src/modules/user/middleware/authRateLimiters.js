import crypto from 'crypto';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { normalizeAuthEmail } from '../utils/authEmail.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * Centralized rate limiting for the authentication surface (audit C1).
 *
 * Design goals:
 *   - One place to tune every auth limiter — routes just import a name.
 *   - Combined IP + account key where an account identifier exists, so a
 *     shared carrier-grade-NAT / office IP can't lock out every mobile user
 *     at once, and an attacker rotating IPs still can't hammer one account.
 *   - Stable machine-readable failure: HTTP 429 + `code: "RATE_LIMITED"` +
 *     `Retry-After`. No internal detail in the body.
 *   - Single swap point for a distributed store: `makeAuthLimiter()` is the
 *     only function that constructs a limiter, so introducing a shared store
 *     (Redis/Memcached) for multi-instance deploys is a one-line change
 *     there — no route touched. Left on the default in-process MemoryStore
 *     for now (single-instance today; do not add Redis speculatively).
 *
 * Kill switch / tuning (all optional, sensible production defaults):
 *   AUTH_RATE_LIMIT_ENABLED        default "true"  ("false" disables every auth limiter)
 *   AUTH_RATE_LIMIT_WINDOW_MS      default 900000  (15 min) — shared window
 *   AUTH_LOGIN_MAX                 default 10      (failed logins / window / IP+email)
 *   AUTH_OTP_VERIFY_MAX           default 20      (verify-email-otp / verify-reset-otp)
 *   AUTH_OTP_REQUEST_MAX          default 5       (generate/resend/forgot — each send costs an email)
 *   AUTH_REGISTER_MAX             default 20      (registrations / window / IP)
 *   AUTH_REGISTER_EMAIL_MAX      default 5       (registrations / window / email)
 *   AUTH_GOOGLE_MAX               default 20      (google id-token callback / window / IP)
 */

const num = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

const WINDOW_MS = num(process.env.AUTH_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000);

const LIMITS = {
  login: num(process.env.AUTH_LOGIN_MAX, 10),
  otpVerify: num(process.env.AUTH_OTP_VERIFY_MAX, 20),
  otpRequest: num(process.env.AUTH_OTP_REQUEST_MAX, 5),
  registerIp: num(process.env.AUTH_REGISTER_MAX, 20),
  registerEmail: num(process.env.AUTH_REGISTER_EMAIL_MAX, 5),
  google: num(process.env.AUTH_GOOGLE_MAX, 20),
  // Generous — a legit client auto-refreshes only when its ~30m access
  // token lapses (a few times an hour at most), but a looping/compromised
  // client is still bounded. Keyed per IP + refresh-token identity.
  refresh: num(process.env.AUTH_REFRESH_MAX, 30),
};

// Read per-request (not captured at module load) so the kill switch can be
// toggled without a restart, and so tests can flip it around a single case.
const rateLimitingDisabled = () => process.env.AUTH_RATE_LIMIT_ENABLED === 'false';

/** IP component, IPv6-safe (express-rate-limit v8 requires ipKeyGenerator). */
const ipKey = (req) => ipKeyGenerator(req.ip);

/** IP + canonical email — falls back to IP-only for a body with no usable email. */
const ipEmailKey = (req) => {
  const email = normalizeAuthEmail(req.body?.email);
  return email ? `${ipKey(req)}:${email}` : ipKey(req);
};

/** Email-only (canonical), IP fallback — for the per-account register cap. */
const emailKey = (req) => normalizeAuthEmail(req.body?.email) || ipKey(req);

/** IP + a short, non-reversible fingerprint of the presented refresh token,
 *  so one leaking/looping token is throttled without locking a shared IP. */
const ipRefreshKey = (req) => {
  const rt = req.body?.refreshToken;
  if (typeof rt !== 'string' || !rt) return ipKey(req);
  const fp = crypto.createHash('sha256').update(rt).digest('hex').slice(0, 16);
  return `${ipKey(req)}:${fp}`;
};

/**
 * Shared 429 handler. `standardHeaders: 'draft-7'` already emits
 * `RateLimit-*`; we set `Retry-After` explicitly too so a client never has
 * to guess. Body is intentionally minimal and stable.
 */
const rateLimitHandler = (req, res, _next, options) => {
  const resetMs = req.rateLimit?.resetTime instanceof Date
    ? req.rateLimit.resetTime.getTime() - Date.now()
    : options.windowMs;
  const retryAfterSec = Math.max(1, Math.ceil(resetMs / 1000));
  res.setHeader('Retry-After', String(retryAfterSec));

  LoggerUtil.security('auth_rate_limit_exceeded', null, {
    path: req.originalUrl || req.url,
    method: req.method,
    // IP only — never the attempted email/password.
    ip: req.ip,
  });

  res.status(options.statusCode).json({
    success: false,
    code: 'RATE_LIMITED',
    message: 'Too many attempts. Please try again later.',
    retryAfter: retryAfterSec,
  });
};

/**
 * THE single constructor for every auth limiter. Add a `store:` here to go
 * multi-instance; nothing else changes.
 */
function makeAuthLimiter({ limit, keyGenerator, skipSuccessfulRequests = false }) {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests,
    keyGenerator,
    handler: rateLimitHandler,
    skip: (req) => rateLimitingDisabled() || req.method === 'OPTIONS',
    // store: <shared store here for multi-instance>,
  });
}

// ── Exported limiters — one per protected action ──────────────────────────

/** POST /auth/login — only FAILED attempts count (a user who knows their
 *  password is never throttled), keyed per IP + account. */
export const loginLimiter = makeAuthLimiter({
  limit: LIMITS.login,
  keyGenerator: ipEmailKey,
  skipSuccessfulRequests: true,
});

/** POST /auth/register — bound account-creation abuse per source IP … */
export const registerIpLimiter = makeAuthLimiter({
  limit: LIMITS.registerIp,
  keyGenerator: ipKey,
});

/** … and per target email (an attacker rotating IPs can't spam one address). */
export const registerEmailLimiter = makeAuthLimiter({
  limit: LIMITS.registerEmail,
  keyGenerator: emailKey,
});

/** POST /auth/forgot-password, /generate-email-otp, /resend-verification —
 *  each one sends an email, so throttle tightly per IP + account. */
export const otpRequestLimiter = makeAuthLimiter({
  limit: LIMITS.otpRequest,
  keyGenerator: ipEmailKey,
});

/** POST /auth/verify-email-otp, /verify-reset-otp — bounds the
 *  request-new-code-then-guess loop (each code already self-locks after 5
 *  wrong tries). A correct code doesn't burn budget. */
export const otpVerifyLimiter = makeAuthLimiter({
  limit: LIMITS.otpVerify,
  keyGenerator: ipEmailKey,
  skipSuccessfulRequests: true,
});

/** POST /auth/oauth/google/callback — no pre-verified account identifier
 *  here, so IP-keyed. */
export const googleCallbackLimiter = makeAuthLimiter({
  limit: LIMITS.google,
  keyGenerator: ipKey,
});

/** POST /auth/refresh — the opaque token is the credential (no Bearer auth
 *  on this route), keyed per IP + token fingerprint. */
export const refreshLimiter = makeAuthLimiter({
  limit: LIMITS.refresh,
  keyGenerator: ipRefreshKey,
});

export default {
  loginLimiter,
  registerIpLimiter,
  registerEmailLimiter,
  otpRequestLimiter,
  otpVerifyLimiter,
  googleCallbackLimiter,
  refreshLimiter,
};
