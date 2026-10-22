import { body } from 'express-validator';
import { PASSWORD_MIN_LENGTH } from '../../../config/passwordPolicy.js';

/**
 * POST /auth/change-password — purely syntactic checks only (required,
 * length, confirm-matches-new). Whether currentPassword is actually
 * correct, and whether newPassword differs from it, both require a bcrypt
 * comparison against the authenticated user's real hash — that happens in
 * authService.js's changePassword(), not here, same split
 * resetPasswordTokenValidator/resetPasswordWithToken() already uses for the
 * OTP reset flow (token format validated here, session/hash logic in the
 * service).
 */
export const changePasswordValidator = [
  body('currentPassword')
    .notEmpty()
    .withMessage('Current password is required'),
  body('newPassword')
    .notEmpty()
    .withMessage('New password is required')
    .bail()
    .isLength({ min: PASSWORD_MIN_LENGTH })
    .withMessage(`New password must be at least ${PASSWORD_MIN_LENGTH} characters`),
  body('confirmPassword')
    .notEmpty()
    .withMessage('Confirm password is required')
    .bail()
    .custom((value, { req }) => value === req.body.newPassword)
    .withMessage('New passwords do not match'),
];
