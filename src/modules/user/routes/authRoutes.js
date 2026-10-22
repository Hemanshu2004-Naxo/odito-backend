import express from 'express';
import {
  registerUser, loginUser, getProfile, updateProfile, uploadAvatarController, removeAvatarController, changePasswordController,
  requestAccountDeletionController, verifyAccountDeletionController, deleteAccountController, logoutUser, logoutAllController, refreshTokenController,
  verifyEmailOTPController, generateEmailOTPController, resendVerificationEmailController,
  forgotPasswordController, verifyResetOtpController, validateResetTokenController, resetPasswordController,
} from '../controller/authController.js';
import auth from '../middleware/auth.js';
import { emailValidator, emailAndOtpValidator, resetTokenValidator, resetPasswordTokenValidator } from '../../otp/validator/otpValidator.js';
import { updateProfileValidator } from '../validator/profileValidator.js';
import { changePasswordValidator } from '../validator/changePasswordValidator.js';
import { verifyAccountDeletionValidator, deleteAccountValidator } from '../validator/deleteAccountValidator.js';
import { registerValidator, loginValidator } from '../validator/authValidator.js';
import { validate } from '../../../middleware/validate.js';
import {
  loginLimiter,
  registerIpLimiter,
  registerEmailLimiter,
  otpRequestLimiter,
  otpVerifyLimiter,
  refreshLimiter,
} from '../middleware/authRateLimiters.js';
import { handleAvatarUpload } from '../middleware/avatarUpload.js';

const router = express.Router();

// Auth hardening: every unauthenticated entry point is now rate-limited
// (429 + Retry-After + `code: "RATE_LIMITED"`; see authRateLimiters.js) and
// register/login are request-validated (authValidator.js) before any
// service logic runs. Ordering is deliberate — limiter first (garbage still
// costs budget), then validation, then the controller.
router.post('/register', registerIpLimiter, registerEmailLimiter, registerValidator, validate, registerUser);
router.post('/login', loginLimiter, loginValidator, validate, loginUser);

// Phase 2 — mobile session management.
//   /refresh   : opaque refresh token in the body IS the credential (no
//                Bearer auth); rate-limited; atomically rotates the token.
//   /logout    : now Bearer-authenticated so a caller can only revoke a
//                refresh token that belongs to them. Still HTTP 200 (the
//                web client sends no body and reads the JSON response).
//   /logout-all: revoke every refresh session for the authenticated user.
router.post('/refresh', refreshLimiter, refreshTokenController);
router.post('/logout', auth, logoutUser);
router.post('/logout-all', auth, logoutAllController);
router.get('/profile', auth, getProfile);
router.put('/profile', auth, updateProfileValidator, updateProfile);
// Avatar management — multipart upload processed in-memory (see
// avatarUpload.js), never written to disk until authService.js's
// uploadAvatar() has resized/re-encoded it.
router.post('/avatar', auth, handleAvatarUpload, uploadAvatarController);
router.delete('/avatar', auth, removeAvatarController);
// Authenticated Change Password — deliberately distinct from the OTP-based
// forgot/reset flow below (never shares its validators, service, or
// session tokens).
router.post('/change-password', auth, changePasswordValidator, changePasswordController);
// Account deletion — 3-step flow, deliberately separate from every other
// auth mechanism. Step 1 determines/dispatches the verification method,
// step 2 verifies it and mints a short-lived deletion-authorization token,
// step 3 (the only genuinely destructive one) requires that token in
// addition to the normal Bearer JWT — being logged in is never, by itself,
// enough to delete an account.
router.post('/account/delete/request', auth, requestAccountDeletionController);
router.post('/account/delete/verify', auth, verifyAccountDeletionValidator, verifyAccountDeletionController);
router.delete('/account', auth, deleteAccountValidator, deleteAccountController);
router.post('/verify-email-otp', otpVerifyLimiter, emailAndOtpValidator, verifyEmailOTPController);
router.post('/generate-email-otp', otpRequestLimiter, emailValidator, generateEmailOTPController);
router.post('/resend-verification', otpRequestLimiter, emailValidator, resendVerificationEmailController);

// Password reset — 3-step flow. The OTP never authorizes a password change
// directly; only a verified OTP mints a resetToken (step 2), and only that
// token (never email) is ever accepted by /reset-password (step 3).
router.post('/forgot-password', otpRequestLimiter, emailValidator, forgotPasswordController);
router.post('/verify-reset-otp', otpVerifyLimiter, emailAndOtpValidator, verifyResetOtpController);
router.get('/validate-reset-token', resetTokenValidator, validateResetTokenController);
router.post('/reset-password', resetPasswordTokenValidator, resetPasswordController);

export default router;
