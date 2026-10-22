import { validationResult } from 'express-validator';
import { register, login, updateProfile as updateProfileService, uploadAvatar as uploadAvatarService, removeAvatar as removeAvatarService, changePassword as changePasswordService, verifyEmailOTP, generateEmailOTP, resendVerificationEmail, forgotPassword, verifyResetOtp, validateResetToken, resetPasswordWithToken, formatSubscriptionForResponse } from '../service/authService.js';
import { requestAccountDeletion, verifyAccountDeletion, verifyDeletionToken } from '../service/accountDeletionService.js';
import { deleteUserCascade } from '../service/userCascadeDeleteService.js';
import { rotateRefreshToken, revokeRefreshTokenForUser, revokeUserRefreshTokens } from '../service/refreshTokenService.js';
import User from '../model/User.js';
import { AuthUtil } from '../../../utils/AuthUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * Per-device metadata for the refresh-token record (Phase 2). All optional;
 * `deviceLabel` is the only client-supplied field and the service
 * length-bounds it.
 */
const deviceContextFromRequest = (req) => ({
  deviceLabel: typeof req.body?.deviceLabel === 'string' ? req.body.deviceLabel : undefined,
  userAgent: req.get('user-agent') || undefined,
  ipAddress: req.ip || undefined,
});

const getRoleName = (roleId) => {
  const roleMap = {
    1: 'systemadmin',
    2: 'superadmin', 
    3: 'admin',
    4: 'agency admin',
    5: 'user'
  };
  return roleMap[roleId] || 'user';
};

const registerUser = async (req, res) => {
  try {
    const result = await register(req.body);
    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      data: result,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

const loginUser = async (req, res) => {
  try {
    const { email, password, rememberMe = false } = req.body;
    const result = await login(email, password, rememberMe, deviceContextFromRequest(req));
    // `data.token` (legacy, web) + `data.tokens` (Phase 2 mobile bundle:
    // short access token + rotating refresh token). Both present; web
    // ignores `data.tokens`, mobile ignores `data.token`.
    res.status(200).json({
      success: true,
      message: 'Login successful',
      data: result,
    });
  } catch (error) {
    // Detect if error is due to unverified email
    const isUnverifiedError = error.message === 'Please verify your email before logging in';
    // Suspended accounts are detected by .code (set in authService.js's
    // login()), not by message string — .code is what apiService.js's
    // handleResponse() actually forwards onto the thrown Error on the
    // frontend, unlike the requiresVerification/email fields below.
    const isSuspendedError = error.code === 'ACCOUNT_SUSPENDED';
    const statusCode = isUnverifiedError || isSuspendedError ? 403 : 401;
    const response = {
      success: false,
      message: error.message,
    };

    // Add extra info for frontend to handle unverified case
    if (isUnverifiedError) {
      response.requiresVerification = true;
      response.email = req.body.email;
    }

    // Deliberately minimal — no admin id, no reason, no internal status, no
    // timestamps. Just the code the frontend branches on for its own
    // "Account Suspended" copy, and the same generic message as a fallback.
    if (isSuspendedError) {
      response.code = 'ACCOUNT_SUSPENDED';
    }

    res.status(statusCode).json(response);
  }
};

const verifyEmailOTPController = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errors: errors.array() });
    }
    const { email, otp } = req.body;
    const result = await verifyEmailOTP(email, otp);
    res.status(200).json({
      success: true,
      message: result.message,
      data: result.user,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

const generateEmailOTPController = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errors: errors.array() });
    }
    const { email } = req.body;
    const result = await generateEmailOTP(email);
    res.status(200).json({
      success: true,
      message: result.message,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

const resendVerificationEmailController = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errors: errors.array() });
    }
    const { email } = req.body;
    const result = await resendVerificationEmail(email);
    res.status(200).json({
      success: true,
      message: result.message,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

const forgotPasswordController = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errors: errors.array() });
    }
    const { email } = req.body;
    const result = await forgotPassword(email);
    res.status(200).json({
      success: true,
      message: result.message,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * Step 2 — POST /auth/verify-reset-otp
 * Body: { email, otp }. On success returns a short-lived resetToken; the
 * frontend uses it to build /reset-password?token=... — never ?email=...
 */
const verifyResetOtpController = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errors: errors.array() });
    }
    const { email, otp } = req.body;
    const result = await verifyResetOtp(email, otp, {
      ipAddress: req.ip || req.socket?.remoteAddress || null,
      userAgent: req.get('user-agent') || null,
    });
    res.status(200).json({
      success: true,
      message: result.message,
      data: { resetToken: result.resetToken },
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

/**
 * Step 3a — GET /auth/validate-reset-token?token=...
 * Read-only, side-effect-free — safe to call on every reset-password page
 * load/refresh to decide whether to show the form or an error state.
 */
const validateResetTokenController = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, code: 'RESET_TOKEN_INVALID' });
    }
    const { token } = req.query;
    await validateResetToken(token);
    res.status(200).json({ success: true, data: { valid: true } });
  } catch (error) {
    const statusCode = error.code === 'RESET_TOKEN_EXPIRED' || error.code === 'RESET_TOKEN_USED' ? 410 : 400;
    res.status(statusCode).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

/**
 * Step 3b — POST /auth/reset-password
 * Body: { token, newPassword, confirmPassword }. Never accepts email or
 * OTP — the token alone (already tied to a verified OTP + a specific user)
 * is the sole credential.
 */
const resetPasswordController = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errors: errors.array() });
    }
    const { token, newPassword } = req.body;
    const result = await resetPasswordWithToken(token, newPassword);
    res.status(200).json({
      success: true,
      message: result.message,
    });
  } catch (error) {
    const statusCode = error.code === 'RESET_TOKEN_EXPIRED' || error.code === 'RESET_TOKEN_USED' ? 410 : 400;
    res.status(statusCode).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

// One shared field list + response shape for both GET and PUT /auth/profile
// — the PUT response must be a superset-safe match of the GET response
// shape, since the frontend replaces its entire AuthContext user object
// with whatever either endpoint returns (see AuthContext.setUser usage).
const PROFILE_SELECT = 'subscription roleId firstName lastName email isActive avatar isEmailVerified lastLogin phone organization website country timezone language createdAt oauthProvider';

/**
 * Shared response shape for GET and PUT /auth/profile. `hasProjects`/
 * `redirectTo` are recomputed fresh (not cached) so a profile update never
 * carries stale onboarding-routing state.
 */
const serializeProfile = async (user) => {
  const landingPage = await AuthUtil.determineUserLandingPage(user._id);
  return {
    id: user._id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    roleId: user.roleId,
    roleName: getRoleName(user.roleId),
    isEmailVerified: user.isEmailVerified,
    avatar: user.avatar,
    lastLogin: user.lastLogin,
    isActive: user.isActive,
    // Previously missing from this response entirely — ConnectedAccountsCard
    // (frontend/components/settings/profile/ConnectedAccountsCard.jsx) reads
    // user.oauthProvider to decide "Connected"/"Not Connected" for Google,
    // and was silently always seeing `undefined` (always "Not Connected")
    // as a result. Fixed here since it's the same response shape.
    oauthProvider: user.oauthProvider ?? null,
    // `?? null` (not just `user.phone`) — documents created before this
    // field existed never had it written to Mongo, so a .lean() read
    // returns `undefined` for them (schema defaults only apply to hydrated
    // documents, not lean reads). Without the coalesce, JSON.stringify
    // would drop the key entirely instead of returning it as null.
    phone: user.phone ?? null,
    organization: user.organization ?? null,
    website: user.website ?? null,
    country: user.country ?? null,
    timezone: user.timezone ?? null,
    language: user.language ?? null,
    createdAt: user.createdAt,
    subscription: formatSubscriptionForResponse(user),
    hasProjects: landingPage.hasProjects,
    redirectTo: landingPage.redirectTo,
  };
};

const getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .select(PROFILE_SELECT)
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const data = await serializeProfile(user);

    res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error('Get profile failed:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
    });
  }
};

/**
 * PUT /auth/profile — explicit allow-list, built by hand from req.body
 * rather than passing req.body straight through. email/roleId/subscription/
 * isActive/avatar/isEmailVerified/lastLogin are never read from the body at
 * all here, so there is no field to "reject" for them — they simply cannot
 * reach the service layer no matter what a client sends.
 */
const updateProfile = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errors: errors.array() });
    }

    const { firstName, lastName, phone, organization, website, country, timezone, language } = req.body;
    const updates = {};
    if (firstName !== undefined) updates.firstName = firstName;
    if (lastName !== undefined) updates.lastName = lastName;
    if (phone !== undefined) updates.phone = phone || null;
    if (organization !== undefined) updates.organization = organization || null;
    if (website !== undefined) updates.website = website || null;
    if (country !== undefined) updates.country = country || null;
    if (timezone !== undefined) updates.timezone = timezone || null;
    if (language !== undefined) updates.language = language || null;

    const user = await updateProfileService(req.user._id, updates);
    const data = await serializeProfile(user);

    res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      data,
    });
  } catch (error) {
    if (error.code === 'USER_NOT_FOUND') {
      return res.status(404).json({ success: false, message: error.message });
    }
    console.error('Update profile failed:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
    });
  }
};

/**
 * POST /auth/change-password — authenticated Change Password, deliberately
 * separate from the OTP-based forgot/reset flow. Never logs req.body or
 * any password value; only error.message (never the raw error object, and
 * never a password) reaches console.error.
 */
/**
 * POST /auth/avatar — multipart/form-data, field name "avatar". The actual
 * multer parsing + type/size rejection happens in avatarUpload.js's
 * handleAvatarUpload middleware (mounted on the route before this
 * controller runs); by the time this executes, req.file is either a valid
 * in-memory buffer or absent entirely.
 */
const uploadAvatarController = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image file was provided.' });
    }

    const user = await uploadAvatarService(req.user._id, req.file.buffer);
    const data = await serializeProfile(user);

    res.status(200).json({
      success: true,
      message: 'Avatar updated successfully.',
      data,
      avatarUrl: data.avatar,
    });
  } catch (error) {
    if (error.code === 'INVALID_IMAGE_FORMAT') {
      return res.status(400).json({ success: false, message: error.message, code: error.code });
    }
    if (error.code === 'USER_NOT_FOUND') {
      return res.status(404).json({ success: false, message: error.message });
    }
    console.error('Avatar upload failed:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to upload avatar.',
    });
  }
};

/**
 * DELETE /auth/avatar — removes any uploaded avatar and restores the
 * ui-avatars.com default. Idempotent: calling it when the user already has
 * the default avatar just re-saves the same default, no error.
 */
const removeAvatarController = async (req, res) => {
  try {
    const user = await removeAvatarService(req.user._id);
    const data = await serializeProfile(user);

    res.status(200).json({
      success: true,
      message: 'Avatar removed successfully.',
      data,
      avatarUrl: data.avatar,
    });
  } catch (error) {
    if (error.code === 'USER_NOT_FOUND') {
      return res.status(404).json({ success: false, message: error.message });
    }
    console.error('Avatar removal failed:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to remove avatar.',
    });
  }
};

const changePasswordController = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errors: errors.array() });
    }

    const { currentPassword, newPassword } = req.body;
    const result = await changePasswordService(req.user._id, currentPassword, newPassword);

    res.status(200).json({
      success: true,
      message: result.message,
    });
  } catch (error) {
    const knownCodes = ['INVALID_CURRENT_PASSWORD', 'PASSWORD_UNCHANGED', 'NO_PASSWORD_SET'];
    if (knownCodes.includes(error.code)) {
      return res.status(400).json({ success: false, message: error.message, code: error.code });
    }
    if (error.code === 'USER_NOT_FOUND') {
      return res.status(404).json({ success: false, message: error.message });
    }
    console.error('Change password failed:', error.message);
    res.status(500).json({
      success: false,
      message: 'Server error',
    });
  }
};

/**
 * POST /auth/account/delete/request — thin: figures out the account's auth
 * method and, for OAuth-only accounts, sends the DELETE_ACCOUNT OTP. All
 * business logic lives in accountDeletionService.js.
 */
const requestAccountDeletionController = async (req, res) => {
  try {
    const result = await requestAccountDeletion(req.user._id);
    res.status(200).json({
      success: true,
      message: result.authMethod === 'otp'
        ? 'A verification code has been sent to your email.'
        : 'Please confirm your password to continue.',
      data: result,
    });
  } catch (error) {
    // issueOtp()'s own resend-cooldown guard, surfaced by name — a "Resend
    // code" click within the cooldown window is an expected user action,
    // not a server error.
    if (error.code === 'OTP_COOLDOWN') {
      return res.status(429).json({ success: false, message: error.message, code: error.code });
    }
    if (error.code === 'EMAIL_SEND_FAILED') {
      return res.status(502).json({ success: false, message: error.message, code: error.code });
    }
    if (error.code === 'USER_NOT_FOUND') {
      return res.status(404).json({ success: false, message: error.message });
    }
    console.error('Request account deletion failed:', error.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * POST /auth/account/delete/verify — verifies password or OTP (whichever
 * this account actually uses) and returns a short-lived deletion
 * authorization token. Never logs the submitted password/otp value.
 */
const verifyAccountDeletionController = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errors: errors.array() });
    }

    const { password, otp } = req.body;
    const result = await verifyAccountDeletion(req.user._id, { password, otp });

    res.status(200).json({
      success: true,
      message: 'Identity verified. You may now confirm account deletion.',
      data: result,
    });
  } catch (error) {
    const knownCodes = [
      'PASSWORD_REQUIRED', 'INVALID_PASSWORD', 'OTP_REQUIRED',
      'OTP_NOT_FOUND', 'OTP_EXPIRED', 'OTP_MAX_ATTEMPTS', 'OTP_INVALID',
    ];
    if (knownCodes.includes(error.code)) {
      return res.status(400).json({ success: false, message: error.message, code: error.code });
    }
    if (error.code === 'USER_NOT_FOUND') {
      return res.status(404).json({ success: false, message: error.message });
    }
    console.error('Verify account deletion failed:', error.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * DELETE /auth/account — the actual, irreversible deletion. Requires a
 * valid deletionToken from the verify step above; a Bearer JWT alone is
 * never sufficient. Delegates every bit of cascade logic to
 * userCascadeDeleteService.deleteUserCascade() — this controller only
 * checks authorization and shapes the response.
 */
const deleteAccountController = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errors: errors.array() });
    }

    verifyDeletionToken(req.body.deletionToken, req.user._id);

    const summary = await deleteUserCascade(req.user._id);

    LoggerUtil.info('User account permanently deleted', {
      userId: req.user._id,
      projectsDeleted: summary.projectsDeleted,
      failureCount: summary.failures.length,
    });

    res.status(200).json({
      success: true,
      message: 'Your account has been permanently deleted.',
    });
  } catch (error) {
    if (error.code === 'DELETION_TOKEN_INVALID') {
      return res.status(401).json({ success: false, message: error.message, code: error.code });
    }
    if (error.code === 'DELETION_ALREADY_IN_PROGRESS') {
      return res.status(409).json({ success: false, message: error.message, code: error.code });
    }
    console.error('Account deletion failed:', error.message);
    res.status(500).json({ success: false, message: 'Server error. Please try again or contact support.' });
  }
};

/**
 * POST /api/auth/logout — now authenticated (Bearer access token). Revokes
 * the supplied refresh token IF it belongs to the caller. Kept at HTTP 200
 * with the original body: the existing web client sends no refresh token
 * and its `apiService.logout()` reads `response.json()` unconditionally (a
 * 204 would make it throw). A web logout is therefore a no-op server-side
 * and still returns 200; a mobile logout revokes its session.
 */
const logoutUser = async (req, res) => {
  try {
    const refreshToken = req.body?.refreshToken;
    if (refreshToken) {
      await revokeRefreshTokenForUser({ presentedToken: refreshToken, userId: req.user._id });
    }
    res.status(200).json({
      success: true,
      message: 'Logout successful',
    });
  } catch (error) {
    if (error.code === 'REFRESH_TOKEN_MISMATCH') {
      return res.status(error.httpStatus || 403).json({ success: false, code: error.code, message: error.message });
    }
    LoggerUtil.error('Logout failed', error);
    res.status(500).json({
      success: false,
      message: 'Server error during logout',
    });
  }
};

/**
 * POST /api/auth/logout-all — revoke every active refresh session for the
 * authenticated user. Does not touch the user, projects, subscription, or
 * Google connections.
 */
const logoutAllController = async (req, res) => {
  try {
    const revokedCount = await revokeUserRefreshTokens(req.user._id, 'logout_all');
    res.status(200).json({
      success: true,
      message: 'Signed out of all sessions.',
      data: { revokedCount },
    });
  } catch (error) {
    LoggerUtil.error('Logout-all failed', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * POST /api/auth/refresh — NOT behind the Bearer `auth` middleware; the
 * opaque refresh token in the body is the credential. Atomically rotates it
 * and returns a fresh { accessToken, refreshToken } pair.
 */
const refreshTokenController = async (req, res) => {
  try {
    const refreshToken = req.body?.refreshToken;
    if (!refreshToken || typeof refreshToken !== 'string') {
      return res.status(400).json({
        success: false,
        code: 'REFRESH_TOKEN_REQUIRED',
        message: 'A refresh token is required.',
      });
    }

    const result = await rotateRefreshToken({
      presentedToken: refreshToken,
      userAgent: req.get('user-agent') || null,
      ipAddress: req.ip || null,
      deviceLabel: typeof req.body?.deviceLabel === 'string' ? req.body.deviceLabel : undefined,
    });

    res.status(200).json({
      success: true,
      data: {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        tokenType: result.tokenType,
        expiresIn: result.expiresIn,
      },
    });
  } catch (error) {
    if (error.code && error.httpStatus) {
      return res.status(error.httpStatus).json({
        success: false,
        code: error.code,
        message: error.message,
      });
    }
    LoggerUtil.error('Refresh token rotation failed', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export { registerUser, loginUser, getProfile, updateProfile, uploadAvatarController, removeAvatarController, changePasswordController, requestAccountDeletionController, verifyAccountDeletionController, deleteAccountController, logoutUser, logoutAllController, refreshTokenController, verifyEmailOTPController, generateEmailOTPController, resendVerificationEmailController, forgotPasswordController, verifyResetOtpController, validateResetTokenController, resetPasswordController };
