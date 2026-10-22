import { body } from 'express-validator';
import { normalizeAuthEmail } from '../utils/authEmail.js';
import { PASSWORD_MIN_LENGTH } from '../../../config/passwordPolicy.js';

// bcrypt (bcryptjs, the app's hasher — User.js pre-save hook) silently
// ignores every byte past the 72nd. Accepting a longer password and then
// hashing only its first 72 bytes means the extra characters the user
// typed do nothing — a real correctness/security trap. Reject instead of
// truncating.
export const PASSWORD_MAX_BYTES = 72;
const NAME_MAX = 100;

const byteLength = (v) => Buffer.byteLength(String(v ?? ''), 'utf8');

/**
 * POST /api/auth/register — route-level validation that previously did not
 * exist. Everything the service's `register()` reads is checked here so a
 * malformed body can never reach it and produce a raw
 * "Cannot read properties of undefined (reading 'toLowerCase')".
 *
 * `email` is canonicalised in place with the SAME normalizer the service
 * and every lookup path uses (normalizeAuthEmail) — this is the write side
 * of the H3 fix.
 */
export const registerValidator = [
  body('firstName')
    .trim()
    .notEmpty().withMessage('First name is required')
    .bail()
    .isLength({ max: NAME_MAX }).withMessage(`First name must be at most ${NAME_MAX} characters`),

  body('lastName')
    .trim()
    .notEmpty().withMessage('Last name is required')
    .bail()
    .isLength({ max: NAME_MAX }).withMessage(`Last name must be at most ${NAME_MAX} characters`),

  body('email')
    .exists({ values: 'falsy' }).withMessage('Email is required')
    .bail()
    .trim() // so surrounding whitespace doesn't make isEmail() fail
    .isEmail().withMessage('A valid email address is required')
    .bail()
    .customSanitizer(normalizeAuthEmail),

  body('password')
    .exists({ values: 'falsy' }).withMessage('Password is required')
    .bail()
    .isString().withMessage('Password must be a string')
    .bail()
    .isLength({ min: PASSWORD_MIN_LENGTH })
      .withMessage(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
    .bail()
    .custom((value) => byteLength(value) <= PASSWORD_MAX_BYTES)
      .withMessage(`Password must be at most ${PASSWORD_MAX_BYTES} bytes long`),

  body('termsAccepted')
    .custom((value) => value === true)
      .withMessage('You must accept the Terms of Service and Privacy Policy'),
];

/**
 * POST /api/auth/login — route-level validation that previously did not
 * exist. Format only: it must NOT leak whether an account exists, and it
 * must NOT change the existing security ordering (authService.login()
 * still verifies the password before any account-state check, and still
 * returns the generic "Invalid email or password." for both a wrong
 * password and an unknown email).
 *
 * `email` is canonicalised with the same normalizer as register/lookup.
 * `password` is only required-and-a-string here — no length/complexity
 * check, so a legacy sub-8-char password can still be used to log in and
 * the endpoint never advertises the password policy.
 */
export const loginValidator = [
  body('email')
    .exists({ values: 'falsy' }).withMessage('Email is required')
    .bail()
    .trim()
    .isEmail().withMessage('A valid email address is required')
    .bail()
    .customSanitizer(normalizeAuthEmail),

  body('password')
    .exists({ values: 'falsy' }).withMessage('Password is required')
    .bail()
    .isString().withMessage('Password is required'),

  body('rememberMe')
    .optional()
    .isBoolean().withMessage('rememberMe must be true or false'),
];

export default { registerValidator, loginValidator, PASSWORD_MAX_BYTES };
