import { body, param } from 'express-validator';
import { INSTRUCTION_MAX_LENGTH } from '../constants/editingConfig.js';

/**
 * Request-SHAPE validation for the Phase 4 conversational-editing HTTP
 * edge. Deep validation of the instruction happens in
 * campaignProposalService (before any Claude call); this is the cheap
 * HTTP-edge gate, same split as campaignDraftValidator.js.
 */

export const draftIdParamValidator = [
  param('draftId').isMongoId().withMessage('draftId must be a valid id'),
];

export const proposalIdParamValidator = [
  param('draftId').isMongoId().withMessage('draftId must be a valid id'),
  param('proposalId').isMongoId().withMessage('proposalId must be a valid id'),
];

export const generateProposalValidator = [
  param('draftId').isMongoId().withMessage('draftId must be a valid id'),
  body('instruction')
    .exists({ checkFalsy: true }).withMessage('instruction is required')
    .bail()
    .isString().trim()
    .isLength({ min: 1, max: INSTRUCTION_MAX_LENGTH })
    .withMessage(`instruction must be at most ${INSTRUCTION_MAX_LENGTH} characters`),
  // Mass-assignment guard — a generate-proposal request carries only the
  // instruction. Nothing else is honoured.
  body(['changes', 'status', 'aiMetadata', 'baseVersion', 'draftId', 'projectId', 'createdBy'])
    .not().exists().withMessage('This field cannot be set on an assistant request'),
];

export default { draftIdParamValidator, proposalIdParamValidator, generateProposalValidator };
