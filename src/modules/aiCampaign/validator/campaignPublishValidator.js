import { param } from 'express-validator';

/**
 * Request-SHAPE validation for the Phase 6 publish HTTP edge. The publish
 * request itself carries no body — everything a publish needs is derived
 * server-side from the draft, its latest Phase 5 validation result, and the
 * project's own Google Ads connection (spec §30 — "the request is `{}`").
 */

export const draftIdParamValidator = [
  param('draftId').isMongoId().withMessage('draftId must be a valid id'),
];

export default { draftIdParamValidator };
