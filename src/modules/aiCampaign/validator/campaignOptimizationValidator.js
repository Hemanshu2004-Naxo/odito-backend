import { param, body } from 'express-validator';

/**
 * Request-SHAPE validation for the Phase 7 performance/optimization HTTP
 * edge. `targets` (spec §11 — explicit business targets, never assumed) is
 * the ONLY body field any of these routes accept; everything else (draft
 * id, project id, customer id, Google resource ids) is derived server-side
 * from trusted state, never the client (spec §36).
 */

export const draftIdParamValidator = [
  param('draftId').isMongoId().withMessage('draftId must be a valid id'),
];

export const recommendationIdParamValidator = [
  param('draftId').isMongoId().withMessage('draftId must be a valid id'),
  param('recommendationId').isMongoId().withMessage('recommendationId must be a valid id'),
];

const numericOrAbsent = (field) => body(field).optional({ nullable: true }).isFloat({ min: 0 }).withMessage(`${field} must be a non-negative number`);

export const analyzeValidator = [
  param('draftId').isMongoId().withMessage('draftId must be a valid id'),
  numericOrAbsent('targets.targetCPA'),
  numericOrAbsent('targets.targetROAS'),
  numericOrAbsent('targets.minCTR'),
  numericOrAbsent('targets.maxCPA'),
  body('targets.minConversions').optional({ nullable: true }).isInt({ min: 0 }).withMessage('targets.minConversions must be a non-negative integer'),
  // Mass-assignment guard — nothing else is honoured from the body.
  body(['draftId', 'projectId', 'customerId', 'campaignId']).not().exists().withMessage('This field cannot be set on an analyze request'),
];

export default { draftIdParamValidator, recommendationIdParamValidator, analyzeValidator };
