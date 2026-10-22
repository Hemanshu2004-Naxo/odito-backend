import path from 'path';
import { randomUUID } from 'crypto';
import { writeFile, unlink, mkdir } from 'fs/promises';
import sharp from 'sharp';
import User from '../model/User.js';
import { AuthUtil } from '../../../utils/AuthUtil.js';
import { summarizeQuota } from '../../../utils/creditService.js';
import { normalizeAuthEmail } from '../utils/authEmail.js';
import { signAuthToken } from './tokenService.js';
import { issueSessionBundle, revokeUserRefreshTokens } from './refreshTokenService.js';
import { issueOtp, verifyOtp } from '../../otp/service/otpService.js';
import { createResetSession, validateResetSession, consumeResetSession } from '../../password_reset/service/passwordResetSessionService.js';
import { sendMail } from '../../mail/services/mailService.js';
import { MAIL_TYPES } from '../../mail/constants/emailTypes.js';
import { getServiceUrls } from '../../../config/env.js';
import { buildDefaultAvatarUrl } from '../utils/defaultAvatar.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * Build the `subscription` block every auth response returns: plan, status,
 * and the credits/pages quota breakdown (limit/used/remaining). `remaining`
 * is calculated by summarizeQuota() — never stored, never duplicated here.
 * @param {Object} user - User document with `subscription`
 * @returns {{plan:string, status:string, credits:object, pages:object}}
 */
const formatSubscriptionForResponse = (user) => {
  const { plan, status } = user.subscription;
  return {
    plan,
    status,
    ...summarizeQuota(user),
  };
};

// JWT signing now lives in one place (tokenService.signAuthToken) so
// password login and the two Google callbacks stop drifting apart. Lifetime
// is unchanged: rememberMe -> LONG_SESSION_EXPIRY (JWT_EXPIRY || '7d'),
// otherwise SHORT_SESSION_EXPIRY ('1d').

const register = async (userData) => {
  const { firstName, lastName, email, password, termsAccepted } = userData;

  // Validate terms acceptance
  if (!termsAccepted || termsAccepted !== true) {
    throw new Error('You must accept the Terms of Service and Privacy Policy');
  }

  // Normalize email to lowercase for case-insensitive comparison
  const normalizedEmail = normalizeAuthEmail(email);

  const existingUser = await User.findOne({ email: normalizedEmail });
  if (existingUser) {
    throw new Error('User already exists');
  }

  const user = await User.create({
    firstName,
    lastName,
    email: normalizedEmail,
    password,
    // roleId is deliberately NEVER read from client input (userData/req.body).
    // Every self-registered account is a normal user; promotion to any admin
    // role only ever happens through the existing admin tools
    // (adminSubscriptionController.js-style server-side overrides), never at
    // registration.
    roleId: 5,
  });

  const otp = await issueOtp({ userId: user._id, email: normalizedEmail, purpose: 'EMAIL_VERIFICATION' });
  const emailSent = await sendMail(MAIL_TYPES.VERIFY_EMAIL, normalizedEmail, { firstName: user.firstName, otp });
  if (!emailSent) {
    console.warn('Failed to send OTP email, but user was created');
  }

  // DO NOT issue token for unverified users - they must verify email first
  const token = null; // No token until email is verified

  return {
    user: {
      id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      roleId: user.roleId,
      isEmailVerified: user.isEmailVerified,
      avatar: user.avatar,
      subscription: formatSubscriptionForResponse(user)
    },
    token, // null until email verified
    message: 'Registration successful. Please check your email for OTP verification.',
  };
};

const verifyEmailOTP = async (email, otp) => {
  // Normalize email to lowercase for case-insensitive comparison
  const normalizedEmail = normalizeAuthEmail(email);
  
  // Trim and validate OTP
  const trimmedOTP = otp.trim();
  if (!trimmedOTP || trimmedOTP.length !== 6) {
    throw new Error('Invalid OTP format');
  }
  
  // First check if user exists
  const user = await User.findOne({ email: normalizedEmail });
  
  if (!user) {
    throw new Error('User not found');
  }
  
  // Check if already verified
  if (user.isEmailVerified) {
    throw new Error('Email is already verified');
  }
  
  // Throws with a .code (OTP_NOT_FOUND/OTP_EXPIRED/OTP_MAX_ATTEMPTS/OTP_INVALID)
  // on any failure — propagated by the controller same as before.
  await verifyOtp({ email: normalizedEmail, purpose: 'EMAIL_VERIFICATION', code: trimmedOTP });

  // Use the new markEmailVerified method
  await user.markEmailVerified();

  const landingPage = await AuthUtil.determineUserLandingPage(user._id);

  return {
    message: 'Email verified successfully',
    user: {
      id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      roleId: user.roleId,
      isEmailVerified: user.isEmailVerified,
      subscription: formatSubscriptionForResponse(user),
      hasProjects: landingPage.hasProjects,
      redirectTo: landingPage.redirectTo
    },
  };
};

const generateEmailOTP = async (email) => {
  // Normalize email to lowercase for case-insensitive comparison
  const normalizedEmail = normalizeAuthEmail(email);
  
  const user = await User.findOne({ email: normalizedEmail });
  
  if (!user) {
    throw new Error('User not found');
  }

  if (user.isEmailVerified) {
    throw new Error('Email is already verified');
  }

  const otp = await issueOtp({ userId: user._id, email: normalizedEmail, purpose: 'EMAIL_VERIFICATION' });
  const emailSent = await sendMail(MAIL_TYPES.VERIFY_EMAIL, normalizedEmail, { firstName: user.firstName, otp });
  if (!emailSent) {
    throw new Error('Failed to send OTP email');
  }

  return {
    message: 'OTP sent successfully',
  };
};

const resendVerificationEmail = async (email) => {
  // This is the same as generateEmailOTP for consistency
  return await generateEmailOTP(email);
};

const forgotPassword = async (email) => {
  const normalizedEmail = normalizeAuthEmail(email);
  const user = await User.findOne({ email: normalizedEmail });

  // Deliberately generic regardless of whether the account exists — a
  // password-reset endpoint must never let a caller distinguish "no such
  // account" from "code sent" via response content, timing, or errors.
  if (user) {
    try {
      const otp = await issueOtp({ userId: user._id, email: normalizedEmail, purpose: 'FORGOT_PASSWORD' });
      await sendMail(MAIL_TYPES.FORGOT_PASSWORD, normalizedEmail, { firstName: user.firstName, otp });
    } catch (error) {
      // OTP_COOLDOWN means a valid code was already issued recently — do
      // not re-send, but still return the same generic response below.
      if (error.code !== 'OTP_COOLDOWN') {
        console.error('forgotPassword: failed to issue/send OTP:', error.message);
      }
    }
  }

  return {
    message: 'If an account exists for this email, a password reset code has been sent.',
  };
};

/**
 * Step 2 of the reset flow. Verifies the FORGOT_PASSWORD OTP and, only on
 * success, mints a short-lived, single-use reset session — the OTP itself
 * never authorizes a password change directly. The returned token is the
 * only thing the reset-password page will ever accept; email is never
 * part of that page's contract (no `?email=` query param, ever).
 */
const verifyResetOtp = async (email, otp, { ipAddress = null, userAgent = null } = {}) => {
  const normalizedEmail = normalizeAuthEmail(email);
  const trimmedOTP = otp.trim();

  const user = await User.findOne({ email: normalizedEmail });
  if (!user) {
    // Same shape as an invalid code — never confirm/deny account existence.
    const error = new Error('Invalid or expired code.');
    error.code = 'OTP_INVALID';
    throw error;
  }

  // Throws with a .code (OTP_NOT_FOUND/OTP_EXPIRED/OTP_MAX_ATTEMPTS/OTP_INVALID)
  // on any failure — propagated by the controller.
  await verifyOtp({ email: normalizedEmail, purpose: 'FORGOT_PASSWORD', code: trimmedOTP });

  const resetToken = await createResetSession({ userId: user._id, ipAddress, userAgent });

  return {
    message: 'Code verified.',
    resetToken,
  };
};

/**
 * Step 3a — read-only. Called on the reset-password page's initial load
 * (and safe on refresh) to decide whether to show the password form or an
 * error state, without consuming the session.
 */
const validateResetToken = async (token) => {
  await validateResetSession(token);
  return { valid: true };
};

/**
 * Step 3b — the only path that may actually change a password. Consumes
 * the reset session (single-use: marked used, then deleted) before ever
 * touching the password, so a replayed token can never succeed twice.
 */
const resetPasswordWithToken = async (token, newPassword) => {
  const userId = await consumeResetSession(token);

  // `+password` so the pre-save hook's `isModified('password')` check and
  // this doc are working from the same field state; harmless if unset.
  const user = await User.findById(userId).select('+password');
  if (!user) {
    const error = new Error('Account not found.');
    error.code = 'RESET_TOKEN_INVALID';
    throw error;
  }

  // Reuses the existing pre-save hook (User.js) that hashes `password`
  // whenever it's modified — no separate hashing logic here.
  user.password = newPassword;
  // A reset is the "I may be locked out / compromised" path — kill every
  // still-valid ACCESS token (tokenVersion bump — Phase 1) …
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  await user.save();

  // … and every server-stored REFRESH session across all devices (Phase 2).
  await revokeUserRefreshTokens(user._id, 'password_reset');

  return {
    message: 'Password reset successfully. Please log in with your new password.',
  };
};

/**
 * Applies a partial profile update — only the keys present in `updates` are
 * touched, so a caller can send just `{ phone: '...' }` without clobbering
 * every other field. The caller (authController.js) is the allow-list
 * boundary: this function trusts whatever object it's given, so it must
 * never be called with raw req.body — only with an already-filtered subset
 * of the editable fields (firstName, lastName, phone, organization,
 * website, country, timezone, language). email/roleId/subscription/
 * isActive/avatar/isEmailVerified are never accepted here.
 *
 * Uses `user.save()` (not findByIdAndUpdate) so the schema's own validators
 * — including the firstName/lastName `required` constraints — still run.
 */
const updateProfile = async (userId, updates) => {
  const user = await User.findById(userId);
  if (!user) {
    const error = new Error('User not found');
    error.code = 'USER_NOT_FOUND';
    throw error;
  }

  Object.assign(user, updates);
  await user.save();

  return user;
};

// ==================== AVATAR (Phase 3) ====================
//
// Reuses the exact static-serving setup screenshots/reports already use
// (server.js's `app.use('/storage', express.static(...))`, resolved from
// the same `path.resolve(process.cwd(), 'storage')` root) — avatars just
// get their own subfolder under it. No new express.static() call, no new
// storage provider.

const AVATARS_DIR = path.resolve(process.cwd(), 'storage', 'avatars');
const ALLOWED_AVATAR_FORMATS = new Set(['jpeg', 'png', 'webp']);

function getAvatarUrlPrefix() {
  // Computed lazily (not at module load) so it always reads BACKEND_URL
  // from whatever env state exists at call time, not import time.
  const { backend } = getServiceUrls();
  return `${backend}/storage/avatars/`;
}

/**
 * True only for a URL this application itself wrote to storage/avatars/ —
 * never true for the ui-avatars.com default, a Google profile picture, or
 * any other external URL. The one and only thing that gates whether a file
 * delete is ever attempted.
 */
function isOwnedAvatarFile(avatarUrl) {
  return typeof avatarUrl === 'string' && avatarUrl.startsWith(getAvatarUrlPrefix());
}

/**
 * Best-effort cleanup of a previous avatar file — failures are logged, not
 * thrown, because the caller's own avatar change has already succeeded by
 * the time this runs; an orphaned old file is a cleanup nuisance, not a
 * reason to fail the request. ENOENT (already gone) is not even logged.
 */
async function deleteOwnedAvatarFile(avatarUrl) {
  if (!isOwnedAvatarFile(avatarUrl)) return;

  const filename = avatarUrl.slice(getAvatarUrlPrefix().length);
  // Defense in depth: even though this filename only ever originates from
  // a UUID this same service generated (see uploadAvatar below), never
  // resolve a path that isn't a single flat segment — a strict guard
  // against path traversal on the delete path too.
  if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return;
  }

  const filePath = path.join(AVATARS_DIR, filename);
  const RETRYABLE_CODES = new Set(['EBUSY', 'EPERM']);
  const MAX_ATTEMPTS = 6;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await unlink(filePath);
      return;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return; // already gone — not an error
      }
      // A file that's still open elsewhere (a client mid-download of the
      // old <img src>, or — confirmed via local testing — antivirus/
      // indexing briefly locking a just-written file on Windows, where a
      // busy scan queue can hold a lock for upward of ten seconds) can
      // block unlink() outright. This is a non-issue on Linux (unlink
      // succeeds immediately regardless of open readers there), which is
      // this app's actual deployment target. Retried with capped backoff
      // over roughly 20 seconds total — free to be generous here since
      // this whole function is called fire-and-forget (see
      // uploadAvatar/removeAvatar below), so retrying longer never adds
      // latency to the actual HTTP response.
      if (RETRYABLE_CODES.has(error.code) && attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(attempt * 500, 3000)));
        continue;
      }
      LoggerUtil.error('Failed to delete previous avatar file', error, { filename, attempt });
      return;
    }
  }
}

/**
 * POST /auth/avatar's service. `fileBuffer` is the raw upload (already
 * mimetype/extension-checked by avatarUpload.js's multer fileFilter, but
 * that check is client-suppliable and never trusted alone) — the
 * authoritative check is sharp actually decoding it and reporting a real
 * format from ALLOWED_AVATAR_FORMATS. The original buffer is never written
 * to disk; only the processed 256x256 WebP output is.
 *
 * Order matters: write the new file → update the DB → delete the old file
 * last. A failure at any earlier step never leaves the user without a
 * working avatar.
 */
const uploadAvatar = async (userId, fileBuffer) => {
  const user = await User.findById(userId);
  if (!user) {
    const error = new Error('User not found');
    error.code = 'USER_NOT_FOUND';
    throw error;
  }

  const image = sharp(fileBuffer, { failOn: 'error' });
  let metadata;
  try {
    metadata = await image.metadata();
  } catch {
    const error = new Error('The uploaded file is not a valid image.');
    error.code = 'INVALID_IMAGE_FORMAT';
    throw error;
  }

  // The authoritative type check — sharp reports the format it actually
  // decoded from the file's real bytes, not whatever the client claimed via
  // mimetype/extension. Rejects SVG, GIF, and anything else outside the
  // allow-list even if it was relabeled as a .png.
  if (!ALLOWED_AVATAR_FORMATS.has(metadata.format)) {
    const error = new Error('Only JPEG, PNG, or WEBP images are allowed.');
    error.code = 'INVALID_IMAGE_FORMAT';
    throw error;
  }

  const processedBuffer = await image
    .rotate() // auto-orient from EXIF, then strip all metadata on output (sharp's default) — no GPS/EXIF data survives into the stored avatar
    .resize(256, 256, { fit: 'cover', position: 'centre' }) // crop-to-square, not letterboxed
    .webp({ quality: 82 })
    .toBuffer();

  await mkdir(AVATARS_DIR, { recursive: true });
  // A cryptographically random filename — the original filename is never
  // read or reused anywhere in this path, which incidentally also means
  // there is no user-controlled string to sanitize or path-traverse with.
  const filename = `${randomUUID()}.webp`;
  await writeFile(path.join(AVATARS_DIR, filename), processedBuffer);

  const previousAvatar = user.avatar;
  user.avatar = `${getAvatarUrlPrefix()}${filename}`;
  await user.save();

  // Fire-and-forget — the new avatar is already live (file written, DB
  // saved) by this point, so cleanup of the old file must never add
  // latency to this response. deleteOwnedAvatarFile() never throws (it
  // logs internally), so no unhandled rejection risk here.
  deleteOwnedAvatarFile(previousAvatar);

  return user;
};

/**
 * DELETE /auth/avatar's service — restores the same ui-avatars.com default
 * the schema itself would generate for a brand-new user (buildDefaultAvatarUrl,
 * shared with User.js's own schema default), then cleans up the previous
 * uploaded file if there was one.
 */
const removeAvatar = async (userId) => {
  const user = await User.findById(userId);
  if (!user) {
    const error = new Error('User not found');
    error.code = 'USER_NOT_FOUND';
    throw error;
  }

  const previousAvatar = user.avatar;
  user.avatar = buildDefaultAvatarUrl(user.firstName, user.lastName);
  await user.save();

  // Fire-and-forget — same reasoning as uploadAvatar() above.
  deleteOwnedAvatarFile(previousAvatar);

  return user;
};

/**
 * Authenticated Change Password — deliberately separate from the OTP-based
 * forgot/reset flow (passwordResetSessionService.js), which stays
 * untouched. Requires the caller to already know their current password;
 * no OTP, no email round-trip, no re-login afterward (the existing JWT
 * stays valid — nothing here touches token issuance).
 *
 * Reuses comparePassword() (User.js) for both checks below and the same
 * `user.password = newPassword; await user.save()` pattern
 * resetPasswordWithToken() already uses — the pre-save hook (User.js) does
 * the actual hashing either way; no hashing logic is duplicated here.
 */
const changePassword = async (userId, currentPassword, newPassword) => {
  const user = await User.findById(userId).select('+password');
  if (!user) {
    const error = new Error('User not found');
    error.code = 'USER_NOT_FOUND';
    throw error;
  }

  // OAuth-only accounts (Google, no local password ever set) have no hash
  // to compare against — reject with a distinct, actionable message rather
  // than letting bcrypt.compare fail against `undefined`.
  if (!user.password) {
    const error = new Error('This account signs in with Google and has no password to change.');
    error.code = 'NO_PASSWORD_SET';
    throw error;
  }

  const isCurrentPasswordValid = await user.comparePassword(currentPassword);
  if (!isCurrentPasswordValid) {
    const error = new Error('Current password is incorrect.');
    error.code = 'INVALID_CURRENT_PASSWORD';
    throw error;
  }

  const isSameAsCurrent = await user.comparePassword(newPassword);
  if (isSameAsCurrent) {
    const error = new Error('New password cannot be the same as your current password.');
    error.code = 'PASSWORD_UNCHANGED';
    throw error;
  }

  user.password = newPassword;
  // Invalidate every previously-issued ACCESS token for this account,
  // including the one that made this request (tokenVersion bump — Phase 1).
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  await user.save();

  // Phase 2: also revoke every server-stored refresh session, so a stolen
  // refresh token cannot mint fresh access tokens after the password
  // changed. Complete session invalidation across web + mobile.
  await revokeUserRefreshTokens(user._id, 'password_changed');

  return { message: 'Password updated successfully.' };
};

/**
 * @param {string} email
 * @param {string} password
 * @param {boolean} [rememberMe]
 * @param {{ deviceLabel?: string, userAgent?: string, ipAddress?: string }} [deviceContext]
 *   Optional per-device metadata for the refresh-token record (Phase 2).
 */
const login = async (email, password, rememberMe = false, deviceContext = {}) => {
  // Normalize email to lowercase for case-insensitive comparison
  const normalizedEmail = normalizeAuthEmail(email);

  const user = await User.findOne({ email: normalizedEmail }).select('+password');

  if (!user) {
    throw new Error('Invalid email or password.');
  }

  // Password is checked BEFORE the suspended/isActive check (and before any
  // other account-state check below) so a wrong password never reveals
  // account state — a suspended account with an incorrect password gets the
  // exact same generic response as a nonexistent email, never a hint that
  // the account exists or is suspended.
  const isPasswordValid = await user.comparePassword(password);
  if (!isPasswordValid) {
    throw new Error('Invalid email or password.');
  }

  // Suspended accounts get a dedicated, deliberately minimal error — only
  // the fact that the account is suspended, never who suspended it, why,
  // internal admin notes, or timestamps. The controller maps this specific
  // .code to its own response shape; the frontend owns the actual
  // "Account Suspended" copy/UI, not this message string.
  if (!user.isActive) {
    const error = new Error('Your account has been suspended.');
    error.code = 'ACCOUNT_SUSPENDED';
    throw error;
  }

  // Check email verification
  if (!user.isEmailVerified) {
    throw new Error('Please verify your email before logging in');
  }

  // Update last login using the new method
  await user.updateLastLogin();

  // LEGACY web session token — `data.token`. Unchanged 1d/7d lifetime; the
  // existing web frontend consumes this directly and has no refresh logic.
  const token = signAuthToken(user, { rememberMe });

  // NEW mobile bundle — `data.tokens`. Short-lived access token + opaque
  // rotating refresh token (see refreshTokenService). A mobile client uses
  // this bundle exclusively and calls POST /auth/refresh; it ignores
  // `data.token`. `tokens.accessToken` is deliberately a DIFFERENT token
  // from `data.token` (different lifetime, different purpose).
  const tokens = await issueSessionBundle(user, {
    rememberMe,
    deviceLabel: deviceContext.deviceLabel,
    userAgent: deviceContext.userAgent,
    ipAddress: deviceContext.ipAddress,
  });

  const landingPage = await AuthUtil.determineUserLandingPage(user._id);

  return {
    user: {
      id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      roleId: user.roleId,
      isEmailVerified: user.isEmailVerified,
      avatar: user.avatar,
      lastLogin: user.lastLogin,
      subscription: formatSubscriptionForResponse(user),
      hasProjects: landingPage.hasProjects,
      redirectTo: landingPage.redirectTo
    },
    token,
    tokens,
  };
};

export { register, login, updateProfile, uploadAvatar, removeAvatar, deleteOwnedAvatarFile, changePassword, verifyEmailOTP, generateEmailOTP, resendVerificationEmail, forgotPassword, verifyResetOtp, validateResetToken, resetPasswordWithToken, formatSubscriptionForResponse };
