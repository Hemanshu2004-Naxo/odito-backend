import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import Otp from '../model/Otp.js';
import { normalizeAuthEmail } from '../../user/utils/authEmail.js';

const OTP_MIN = 100000;
const OTP_MAX = 1000000; // exclusive — crypto.randomInt(min, max) always yields exactly 6 digits
const DEFAULT_OTP_EXPIRY_MINUTES = 10;
// FORGOT_PASSWORD gets a tighter window than the default — password reset
// is higher-stakes than email verification, and this is purpose-specific
// so it never affects EMAIL_VERIFICATION's existing 10-minute UX.
const OTP_EXPIRY_MINUTES_BY_PURPOSE = {
  FORGOT_PASSWORD: 5,
};
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_ATTEMPTS = 5;
const BCRYPT_SALT_ROUNDS = 10;

function otpError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function expiryMinutesFor(purpose) {
  return OTP_EXPIRY_MINUTES_BY_PURPOSE[purpose] ?? DEFAULT_OTP_EXPIRY_MINUTES;
}

/**
 * Issue a new OTP for (email, purpose). Invalidates any previous unused
 * code for the same pair first, so only the newest code is ever valid.
 * Enforces the resend cooldown before issuing.
 * @returns {Promise<string>} the plaintext 6-digit code — hand this
 *   directly to a mail template, never persist or return it from an API.
 */
export async function issueOtp({ userId = null, email, purpose }) {
  const normalizedEmail = normalizeAuthEmail(email);

  const latest = await Otp.findOne({ email: normalizedEmail, purpose, isUsed: false }).sort({ createdAt: -1 });
  if (latest?.cooldownUntil && latest.cooldownUntil > new Date()) {
    const secondsLeft = Math.ceil((latest.cooldownUntil.getTime() - Date.now()) / 1000);
    throw otpError(`Please wait ${secondsLeft}s before requesting another code`, 'OTP_COOLDOWN');
  }

  const code = crypto.randomInt(OTP_MIN, OTP_MAX).toString();
  const otpHash = await bcrypt.hash(code, BCRYPT_SALT_ROUNDS);
  const now = Date.now();

  // Invalidate any still-unused prior code for this email+purpose — an old
  // leaked or superseded code must never remain valid alongside a new one.
  await Otp.updateMany({ email: normalizedEmail, purpose, isUsed: false }, { $set: { isUsed: true } });

  await Otp.create({
    userId,
    email: normalizedEmail,
    purpose,
    otpHash,
    expiresAt: new Date(now + expiryMinutesFor(purpose) * 60 * 1000),
    cooldownUntil: new Date(now + RESEND_COOLDOWN_SECONDS * 1000),
    attempts: 0,
    isUsed: false,
  });

  return code;
}

/**
 * Verify a submitted code for (email, purpose). Throws on any failure —
 * not found, expired, max attempts exceeded, or mismatch — with a
 * `.code` on the error so callers/controllers can branch on it. Marks the
 * record used on success so it can never be replayed.
 */
export async function verifyOtp({ email, purpose, code }) {
  const normalizedEmail = normalizeAuthEmail(email);

  const record = await Otp.findOne({ email: normalizedEmail, purpose, isUsed: false }).sort({ createdAt: -1 });

  if (!record) {
    throw otpError('No verification code found. Please request a new one.', 'OTP_NOT_FOUND');
  }

  if (record.expiresAt < new Date()) {
    throw otpError('Verification code has expired. Please request a new one.', 'OTP_EXPIRED');
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    throw otpError('Too many incorrect attempts. Please request a new code.', 'OTP_MAX_ATTEMPTS');
  }

  const isMatch = await bcrypt.compare(String(code).trim(), record.otpHash);
  if (!isMatch) {
    record.attempts += 1;
    await record.save();
    throw otpError('Invalid verification code.', 'OTP_INVALID');
  }

  record.isUsed = true;
  await record.save();
  return true;
}
