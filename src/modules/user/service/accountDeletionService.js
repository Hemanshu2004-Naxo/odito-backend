import jwt from 'jsonwebtoken';
import User from '../model/User.js';
import { issueOtp, verifyOtp } from '../../otp/service/otpService.js';
import { sendMail } from '../../mail/services/mailService.js';
import { MAIL_TYPES } from '../../mail/constants/emailTypes.js';

// Reuses jsonwebtoken (already the app's only JWT library — see
// login()/changePassword() in authService.js) for a short-lived,
// purpose-scoped authorization token rather than a new persisted "session"
// collection. A signed token already gives exactly the lifecycle this
// needs (a hard 5-minute expiry, no revocation-on-demand requirement) for
// free — no new model, no new cleanup job.
const DELETION_TOKEN_TTL = '5m';
const DELETION_TOKEN_PURPOSE = 'account_deletion';

function deletionError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * POST /auth/account/delete/request — determines which verification method
 * this account actually has and, for OAuth-only accounts (no password —
 * see User.js's conditional `required`), issues and emails the
 * DELETE_ACCOUNT OTP (reusing otpService.js/mailService.js verbatim, the
 * exact same infrastructure Forgot Password already uses). Password
 * accounts need no server-side action here — the frontend goes straight to
 * a password prompt, checked by verifyAccountDeletion below.
 */
export const requestAccountDeletion = async (userId) => {
  const user = await User.findById(userId).select('+password');
  if (!user) {
    throw deletionError('User not found', 'USER_NOT_FOUND');
  }

  if (user.password) {
    return { authMethod: 'password' };
  }

  const otp = await issueOtp({ userId: user._id, email: user.email, purpose: 'DELETE_ACCOUNT' });
  const emailSent = await sendMail(MAIL_TYPES.DELETE_ACCOUNT_OTP, user.email, { firstName: user.firstName, otp });
  if (!emailSent) {
    throw deletionError('Failed to send verification email. Please try again.', 'EMAIL_SEND_FAILED');
  }

  return { authMethod: 'otp' };
};

/**
 * POST /auth/account/delete/verify — verifies whichever single credential
 * this account actually uses (reuses User.comparePassword() for password
 * accounts, otpService.verifyOtp() for OAuth-only ones — no hashing or
 * OTP-matching logic duplicated here), then mints the short-lived deletion
 * authorization token DELETE /auth/account requires.
 */
export const verifyAccountDeletion = async (userId, { password, otp } = {}) => {
  const user = await User.findById(userId).select('+password');
  if (!user) {
    throw deletionError('User not found', 'USER_NOT_FOUND');
  }

  if (user.password) {
    if (!password) {
      throw deletionError('Current password is required.', 'PASSWORD_REQUIRED');
    }
    const isValid = await user.comparePassword(password);
    if (!isValid) {
      throw deletionError('Incorrect password.', 'INVALID_PASSWORD');
    }
  } else {
    if (!otp) {
      throw deletionError('Verification code is required.', 'OTP_REQUIRED');
    }
    // Throws its own OTP_NOT_FOUND/OTP_EXPIRED/OTP_MAX_ATTEMPTS/OTP_INVALID
    // (with a `.code`) on failure — propagated to the controller as-is,
    // same convention as every other OTP-verifying flow in this app.
    await verifyOtp({ email: user.email, purpose: 'DELETE_ACCOUNT', code: otp });
  }

  const deletionToken = jwt.sign(
    { id: user._id.toString(), purpose: DELETION_TOKEN_PURPOSE },
    process.env.JWT_SECRET,
    { expiresIn: DELETION_TOKEN_TTL }
  );

  return { deletionToken };
};

/**
 * DELETE /auth/account calls this before ever touching
 * userCascadeDeleteService.deleteUserCascade() — a valid Bearer JWT alone
 * (i.e. just being logged in) must never be sufficient to delete an
 * account; this is the one gate that enforces "Password OR OTP
 * verification happened first, recently, for this exact user."
 * @throws {Error} with .code DELETION_TOKEN_INVALID on any failure
 *   (missing, expired, wrong purpose, or minted for a different user)
 */
export const verifyDeletionToken = (token, userId) => {
  if (!token) {
    throw deletionError('Deletion authorization is required. Please verify your identity first.', 'DELETION_TOKEN_INVALID');
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    throw deletionError('Deletion authorization has expired. Please verify your identity again.', 'DELETION_TOKEN_INVALID');
  }

  if (decoded.purpose !== DELETION_TOKEN_PURPOSE || decoded.id !== userId.toString()) {
    throw deletionError('Deletion authorization is invalid.', 'DELETION_TOKEN_INVALID');
  }
};
