import { body } from 'express-validator';

const MAX_FIELD_COUNT = 50;
const MAX_FIELD_VALUE_LENGTH = 5000;

/**
 * Note: there is deliberately NO `projectId` (or any tenant-identifying
 * field) accepted anywhere in this payload — see Section 4/26 of the Phase
 * 3B spec. The project is resolved exclusively from the authenticated
 * plugin credential (req.pluginInstallation.project_id, set by
 * pluginAuth.middleware.js). If a client sends one anyway, it is simply
 * never read — there is no code path that looks at req.body.projectId for
 * this route at all.
 */
export const submitFormValidator = [
  body('eventId')
    .trim()
    .notEmpty().withMessage('eventId is required')
    .isLength({ min: 8, max: 200 }).withMessage('eventId has an unexpected length'),

  body('form').isObject().withMessage('form is required'),
  body('form.externalId')
    .isString().withMessage('form.externalId is required')
    .isLength({ min: 1, max: 200 }),
  body('form.provider')
    .isIn(['contact_form_7', 'divi', 'generic']).withMessage('form.provider must be a supported provider'),
  body('form.name').optional({ checkFalsy: true }).isString().isLength({ max: 200 }),
  body('form.pageUrl').optional({ checkFalsy: true }).isString().isLength({ max: 2000 }),

  body('submission').isObject().withMessage('submission is required'),
  body('submission.fields')
    .custom((fields) => {
      if (fields === undefined || fields === null) return true; // a form with no fields is legal
      if (typeof fields !== 'object' || Array.isArray(fields)) {
        throw new Error('submission.fields must be an object');
      }
      const keys = Object.keys(fields);
      if (keys.length > MAX_FIELD_COUNT) {
        throw new Error(`submission.fields cannot have more than ${MAX_FIELD_COUNT} entries`);
      }
      for (const key of keys) {
        const value = fields[key];
        const asString = value === null || value === undefined
          ? ''
          : (Array.isArray(value) ? value.join(',') : String(value));
        if (asString.length > MAX_FIELD_VALUE_LENGTH) {
          throw new Error(`Field "${key}" exceeds the maximum allowed length`);
        }
      }
      return true;
    }),

  body('context').optional().isObject(),
  body('context.pageUrl').optional({ checkFalsy: true }).isString().isLength({ max: 2000 }),
  body('context.referrer').optional({ checkFalsy: true }).isString().isLength({ max: 2000 }),
  body('context.utmSource').optional({ checkFalsy: true }).isString().isLength({ max: 200 }),
  body('context.utmMedium').optional({ checkFalsy: true }).isString().isLength({ max: 200 }),
  body('context.utmCampaign').optional({ checkFalsy: true }).isString().isLength({ max: 200 }),
  body('context.utmTerm').optional({ checkFalsy: true }).isString().isLength({ max: 200 }),
  body('context.utmContent').optional({ checkFalsy: true }).isString().isLength({ max: 200 }),
];
