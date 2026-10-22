import { body, query } from 'express-validator';
import mongoose from 'mongoose';
import { LEAD_STATUSES, LEAD_PRIORITIES } from '../model/Lead.js';

// Shared by every route that expects projectId as a query param (list,
// stats) — projectId itself is re-validated against the authenticated
// user's ownership by validateProjectAccess() at the route layer; this only
// checks shape.
export const projectIdQueryValidator = [
  query('projectId')
    .notEmpty().withMessage('projectId is required')
    .isMongoId().withMessage('projectId must be a valid id'),
];

export const createLeadValidator = [
  body('projectId')
    .notEmpty().withMessage('projectId is required')
    .isMongoId().withMessage('projectId must be a valid id'),
  body('name')
    .optional({ checkFalsy: true }).trim()
    .isLength({ max: 200 }).withMessage('name must be at most 200 characters'),
  body('email')
    .optional({ checkFalsy: true }).trim()
    .isEmail().withMessage('email must be a valid email address')
    .normalizeEmail(),
  body('phone')
    .optional({ checkFalsy: true }).trim()
    .isLength({ max: 30 }).withMessage('phone must be at most 30 characters'),
  body('company')
    .optional({ checkFalsy: true }).trim()
    .isLength({ max: 200 }).withMessage('company must be at most 200 characters'),
  body('message')
    .optional({ checkFalsy: true }).trim()
    .isLength({ max: 5000 }).withMessage('message must be at most 5000 characters'),
  body('formName')
    .optional({ checkFalsy: true }).trim()
    .isLength({ max: 200 }).withMessage('formName must be at most 200 characters'),
  body('pageUrl')
    .optional({ checkFalsy: true }).trim()
    .isURL({ require_protocol: true }).withMessage('pageUrl must be a valid URL'),
  body('referrer')
    .optional({ checkFalsy: true }).trim()
    .isURL({ require_protocol: true }).withMessage('referrer must be a valid URL'),
  body('source')
    .optional({ checkFalsy: true }).trim()
    .isLength({ max: 50 }).withMessage('source must be at most 50 characters'),
  body(['utmSource', 'utmMedium', 'utmCampaign', 'utmTerm', 'utmContent'])
    .optional({ checkFalsy: true }).trim()
    .isLength({ max: 200 }).withMessage('UTM fields must be at most 200 characters'),
  body('status')
    .optional()
    .isIn(LEAD_STATUSES).withMessage(`status must be one of: ${LEAD_STATUSES.join(', ')}`),
  body('priority')
    .optional()
    .isIn(LEAD_PRIORITIES).withMessage(`priority must be one of: ${LEAD_PRIORITIES.join(', ')}`),
  body('assignedTo')
    .optional({ checkFalsy: true })
    .isMongoId().withMessage('assignedTo must be a valid user id'),
  body('note')
    .optional({ checkFalsy: true }).trim()
    .isLength({ max: 2000 }).withMessage('note must be at most 2000 characters'),
];

export const updateLeadValidator = [
  body('name')
    .optional({ checkFalsy: true }).trim()
    .isLength({ max: 200 }).withMessage('name must be at most 200 characters'),
  body('email')
    .optional({ checkFalsy: true }).trim()
    .isEmail().withMessage('email must be a valid email address')
    .normalizeEmail(),
  body('phone')
    .optional({ checkFalsy: true }).trim()
    .isLength({ max: 30 }).withMessage('phone must be at most 30 characters'),
  body('company')
    .optional({ checkFalsy: true }).trim()
    .isLength({ max: 200 }).withMessage('company must be at most 200 characters'),
  body('message')
    .optional({ checkFalsy: true }).trim()
    .isLength({ max: 5000 }).withMessage('message must be at most 5000 characters'),
  body('status')
    .optional()
    .isIn(LEAD_STATUSES).withMessage(`status must be one of: ${LEAD_STATUSES.join(', ')}`),
  body('priority')
    .optional()
    .isIn(LEAD_PRIORITIES).withMessage(`priority must be one of: ${LEAD_PRIORITIES.join(', ')}`),
  // Explicit null is allowed (unassign) — checkFalsy would also swallow "",
  // which is fine here since an empty string isn't a valid id either.
  body('assignedTo')
    .optional({ nullable: true })
    .custom((value) => value === null || mongoose.isValidObjectId(value))
    .withMessage('assignedTo must be a valid user id or null'),
  body('note')
    .optional({ checkFalsy: true }).trim()
    .isLength({ max: 2000 }).withMessage('note must be at most 2000 characters'),
  // Explicitly rejected rather than silently ignored, so a client relying on
  // these actually changing gets a clear 400 instead of a silent no-op —
  // formName/pageUrl/source/referrer/utm*/projectId/createdBy are capture
  // context or identity fields, not editable sales-workflow fields.
  body(['projectId', 'createdBy', 'updatedBy', 'formName', 'pageUrl', 'source', 'referrer', 'utmSource', 'utmMedium', 'utmCampaign', 'utmTerm', 'utmContent'])
    .not().exists().withMessage('This field cannot be modified after lead creation'),
];

export const listLeadsValidator = [
  ...projectIdQueryValidator,
  query('status').optional().isIn(LEAD_STATUSES).withMessage(`status must be one of: ${LEAD_STATUSES.join(', ')}`),
  query('priority').optional().isIn(LEAD_PRIORITIES).withMessage(`priority must be one of: ${LEAD_PRIORITIES.join(', ')}`),
  query('search').optional().trim().isLength({ max: 200 }).withMessage('search must be at most 200 characters'),
  query('page').optional().isInt({ min: 1 }).withMessage('page must be a positive integer'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('limit must be between 1 and 100'),
  query('sort').optional().isIn(['createdAt', 'updatedAt', 'name', 'status', 'priority', 'lastContactAt', 'nextFollowUpAt']),
  query('sortOrder').optional().isIn(['asc', 'desc']),
];
