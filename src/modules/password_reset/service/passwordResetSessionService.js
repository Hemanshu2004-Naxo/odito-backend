import crypto from 'crypto';
import PasswordResetSession from '../model/PasswordResetSession.js';

const TOKEN_BYTES = 32; // 256-bit random token
const SESSION_EXPIRY_MINUTES = 10;

function sessionError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// SHA-256, not bcrypt: the token is already a 256-bit cryptographically
// random value (unlike a 6-digit OTP or a password), so brute-forcing the
// hash is already computationally infeasible — bcrypt's deliberate slowness
// buys nothing here and only adds latency. This is the standard approach
// for hashing high-entropy tokens (same pattern GitHub/Rails/Django use for
// password-reset tokens).
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Mint a new reset session for a user who just passed OTP verification.
 * Invalidates any other still-active session for this user first — only
 * the newest session is ever valid, same single-active-credential
 * principle as otpService.issueOtp().
 * @returns {Promise<string>} the plaintext token — hand this to the HTTP
 *   response only, never persist or log it.
 */
export async function createResetSession({ userId, ipAddress = null, userAgent = null }) {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_EXPIRY_MINUTES * 60 * 1000);

  await PasswordResetSession.deleteMany({ userId, isUsed: false });

  await PasswordResetSession.create({
    userId,
    tokenHash,
    expiresAt,
    ipAddress,
    userAgent,
  });

  return token;
}

/**
 * Look up and validate a reset token without consuming it — safe to call
 * repeatedly (e.g. on every reset-password page load/refresh).
 * Throws with a `.code` (RESET_TOKEN_INVALID / RESET_TOKEN_USED /
 * RESET_TOKEN_EXPIRED) on any failure.
 * @returns {Promise<import('mongoose').Document>} the session document
 */
export async function validateResetSession(token) {
  if (!token || typeof token !== 'string' || !/^[0-9a-f]{64}$/i.test(token)) {
    throw sessionError('Invalid or missing reset token.', 'RESET_TOKEN_INVALID');
  }

  const tokenHash = hashToken(token);
  const session = await PasswordResetSession.findOne({ tokenHash });

  if (!session) {
    throw sessionError('Invalid or expired reset link.', 'RESET_TOKEN_INVALID');
  }
  if (session.isUsed) {
    throw sessionError('This reset link has already been used.', 'RESET_TOKEN_USED');
  }
  if (session.expiresAt < new Date()) {
    throw sessionError('This reset link has expired. Please request a new one.', 'RESET_TOKEN_EXPIRED');
  }

  return session;
}

/**
 * Validate AND permanently consume a reset token — the only path that may
 * actually change a password. Marks the session used, then deletes it
 * immediately (doesn't wait for the TTL index) so it can never be reused
 * even if somehow re-inserted.
 * @returns {Promise<string>} the userId the session was issued for
 */
export async function consumeResetSession(token) {
  const session = await validateResetSession(token);

  session.isUsed = true;
  session.usedAt = new Date();
  await session.save();
  await PasswordResetSession.deleteOne({ _id: session._id });

  return session.userId;
}
