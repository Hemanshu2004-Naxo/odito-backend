import { body, query } from 'express-validator';

// ── Odito-dashboard-authenticated routes (JWT) ──────────────────────────

export const projectIdBodyValidator = [
  body('projectId')
    .notEmpty().withMessage('projectId is required')
    .isMongoId().withMessage('projectId must be a valid id'),
];

export const projectIdQueryValidator = [
  query('projectId')
    .notEmpty().withMessage('projectId is required')
    .isMongoId().withMessage('projectId must be a valid id'),
];

// ── Plugin-authenticated / pairing routes (no JWT) ──────────────────────

export const pairPluginValidator = [
  body('token')
    .trim()
    .notEmpty().withMessage('token is required')
    .isLength({ min: 20, max: 200 }).withMessage('token has an unexpected length'),
  body('siteUrl')
    .trim()
    .notEmpty().withMessage('siteUrl is required')
    .isURL({ require_protocol: true }).withMessage('siteUrl must be a valid URL'),
  body('wordpressVersion')
    .optional({ checkFalsy: true }).trim().isLength({ max: 20 }),
  body('pluginVersion')
    .optional({ checkFalsy: true }).trim().isLength({ max: 20 }),
];

export const heartbeatValidator = [
  body('wordpressVersion')
    .optional({ checkFalsy: true }).trim().isLength({ max: 20 }),
  body('pluginVersion')
    .optional({ checkFalsy: true }).trim().isLength({ max: 20 }),
];

export const formsSyncValidator = [
  body('forms')
    .isArray().withMessage('forms must be an array'),
  body('forms.*.externalId')
    .isString().withMessage('each form requires a string externalId')
    .isLength({ min: 1, max: 200 }),
  body('forms.*.provider')
    .isIn(['contact_form_7', 'divi', 'generic']).withMessage('each form requires a valid provider'),
  body('forms.*.name')
    .optional({ checkFalsy: true }).isString().isLength({ max: 200 }),
  body('forms.*.pageUrl')
    .optional({ checkFalsy: true }).isString().isLength({ max: 2000 }),
  body('forms.*.fields')
    .optional().isArray(),
];
