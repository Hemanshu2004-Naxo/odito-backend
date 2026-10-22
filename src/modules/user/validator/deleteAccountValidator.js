import { body } from 'express-validator';

/**
 * POST /auth/account/delete/verify — format-level checks only. Whether
 * `password` or `otp` is actually required (and against what) depends on
 * the account's real auth method, which only accountDeletionService.js can
 * determine (it needs to load the User document) — this validator only
 * rejects an obviously-malformed value if one is present, same split
 * changePasswordValidator.js/otpValidator.js already use elsewhere.
 */
export const verifyAccountDeletionValidator = [
  body('password')
    .optional({ checkFalsy: true })
    .isString()
    .trim()
    .notEmpty(),
  body('otp')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ min: 6, max: 6 })
    .isNumeric(),
];

/**
 * DELETE /auth/account — the deletion-authorization token minted by
 * POST /auth/account/delete/verify. Format only; validity/expiry/purpose
 * are checked by accountDeletionService.verifyDeletionToken().
 */
export const deleteAccountValidator = [
  body('deletionToken')
    .isString()
    .trim()
    .notEmpty()
    .withMessage('Deletion authorization is required. Please verify your identity first.'),
];
