import { param, body } from 'express-validator';
import { AUTOMATION_MODES } from '../constants/automationEnums.js';

/**
 * Request-SHAPE validation for the Phase 8 automation HTTP edge. Every
 * trusted field (projectId, draftId's own campaign association) is derived
 * server-side from the already-owned draft, never the client — same
 * convention as every prior phase's validator in this module.
 */

export const draftIdParamValidator = [
  param('draftId').isMongoId().withMessage('draftId must be a valid id'),
];

export const policyIdParamValidator = [
  param('draftId').isMongoId().withMessage('draftId must be a valid id'),
  param('policyId').isMongoId().withMessage('policyId must be a valid id'),
];

const mongoIdGuard = body(['draftId', 'projectId', 'policyId', 'createdBy']).not().exists().withMessage('This field cannot be set on this request');

export const createPolicyValidator = [
  param('draftId').isMongoId().withMessage('draftId must be a valid id'),
  body('name').optional({ nullable: true }).isString().isLength({ max: 150 }),
  body('rules').optional({ nullable: true }).isArray({ max: 10 }).withMessage('rules must be an array of at most 10 entries'),
  body('allowedOperations').optional({ nullable: true }).isArray().withMessage('allowedOperations must be an array'),
  body('highRiskOperationsEnabled').optional({ nullable: true }).isBoolean(),
  body('limits').optional({ nullable: true }).isObject(),
  body('schedule').optional({ nullable: true }).isObject(),
  body('dateRangePreset').optional({ nullable: true }).isString().isLength({ max: 20 }),
  mongoIdGuard,
];

export const updatePolicyValidator = [
  param('draftId').isMongoId().withMessage('draftId must be a valid id'),
  param('policyId').isMongoId().withMessage('policyId must be a valid id'),
  body('name').optional({ nullable: true }).isString().isLength({ max: 150 }),
  body('rules').optional({ nullable: true }).isArray({ max: 10 }),
  body('allowedOperations').optional({ nullable: true }).isArray(),
  body('highRiskOperationsEnabled').optional({ nullable: true }).isBoolean(),
  body('limits').optional({ nullable: true }).isObject(),
  body('schedule').optional({ nullable: true }).isObject(),
  body('dateRangePreset').optional({ nullable: true }).isString().isLength({ max: 20 }),
  mongoIdGuard,
];

export const setEnabledValidator = [
  param('draftId').isMongoId().withMessage('draftId must be a valid id'),
  param('policyId').isMongoId().withMessage('policyId must be a valid id'),
  body('enabled').isBoolean().withMessage('enabled must be a boolean'),
];

export const setModeValidator = [
  param('draftId').isMongoId().withMessage('draftId must be a valid id'),
  param('policyId').isMongoId().withMessage('policyId must be a valid id'),
  body('mode').isIn(AUTOMATION_MODES).withMessage(`mode must be one of ${AUTOMATION_MODES.join(', ')}`),
];

export default {
  draftIdParamValidator, policyIdParamValidator, createPolicyValidator, updatePolicyValidator, setEnabledValidator, setModeValidator,
};
