import { body } from 'express-validator';

// IANA timezone names — Node's own Intl carries the canonical list, so no
// separate timezone-data dependency is needed (same "reuse what the
// runtime/library already provides" approach as isISO31661Alpha2/isURL/
// isLocale below, which are validator.js's own built-in checks, not
// hand-rolled here).
const VALID_TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'));

/**
 * PUT /auth/profile — every field optional (a partial update only touches
 * what's provided), but whatever IS provided must be valid. `checkFalsy`
 * lets a field be cleared with an empty string without tripping the format
 * check. firstName/lastName have no checkFalsy — the User schema requires
 * both, so clearing either to empty is rejected here rather than failing
 * later at Mongoose's own required-field validation.
 */
export const updateProfileValidator = [
  body('firstName')
    .optional()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('First name must be between 1 and 100 characters'),
  body('lastName')
    .optional()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Last name must be between 1 and 100 characters'),
  body('phone')
    .optional({ checkFalsy: true })
    .trim()
    .isMobilePhone('any')
    .withMessage('A valid phone number is required'),
  body('organization')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 200 })
    .withMessage('Organization must be at most 200 characters'),
  body('website')
    .optional({ checkFalsy: true })
    .trim()
    .isURL({ require_protocol: false })
    .withMessage('A valid website URL is required'),
  body('country')
    .optional({ checkFalsy: true })
    .trim()
    .isISO31661Alpha2()
    .withMessage('A valid ISO 3166-1 country code is required (e.g. US)'),
  body('timezone')
    .optional({ checkFalsy: true })
    .trim()
    .custom((value) => VALID_TIMEZONES.has(value))
    .withMessage('A valid IANA timezone is required (e.g. America/New_York)'),
  body('language')
    .optional({ checkFalsy: true })
    .trim()
    .isLocale()
    .withMessage('A valid language/locale code is required (e.g. en or en-US)'),
];
