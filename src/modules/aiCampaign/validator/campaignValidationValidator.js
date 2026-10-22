import { param } from 'express-validator';

/**
 * Request-SHAPE validation for the Phase 5 validation HTTP edge. Both
 * routes take nothing but :draftId — there is no request body to validate
 * (validation always runs against the draft's own current, persisted
 * state; it never accepts client-supplied campaign data to validate).
 */

export const draftIdParamValidator = [
  param('draftId').isMongoId().withMessage('draftId must be a valid id'),
];

export default { draftIdParamValidator };
