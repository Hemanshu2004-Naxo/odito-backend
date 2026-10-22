import { body, param, query } from 'express-validator';
import { DRAFT_STATUSES, CAMPAIGN_OBJECTIVES, LOCATION_TYPES } from '../constants/aiCampaignEnums.js';
import { BRIEF_LIMITS } from '../constants/generationConfig.js';

/**
 * Request-SHAPE validation for the AI Campaign Draft HTTP edge
 * (express-validator chains). Mirrors modules/lead/validator/leadValidator.js:
 * this layer only checks that the request is well-formed — deep campaign
 * coherence is campaignStructureValidator.js, and ownership is
 * validateProjectAccess()/AuthUtil at the route/service layer.
 *
 * `firstValidationError(req, res)` in the controller turns any failure here
 * into the repo-standard 400 body.
 */

// projectId as a query param — list route. Ownership is re-checked against
// the authenticated user by validateProjectAccess(); this is shape only.
export const projectIdQueryValidator = [
  query('projectId')
    .notEmpty().withMessage('projectId is required')
    .isMongoId().withMessage('projectId must be a valid id'),
];

export const listDraftsValidator = [
  ...projectIdQueryValidator,
  query('status')
    .optional()
    .isIn(DRAFT_STATUSES).withMessage(`status must be one of: ${DRAFT_STATUSES.join(', ')}`),
  query('page').optional().isInt({ min: 1 }).withMessage('page must be a positive integer'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('limit must be between 1 and 100'),
  query('sort').optional().isIn(['createdAt', 'updatedAt']).withMessage('sort must be createdAt or updatedAt'),
  query('sortOrder').optional().isIn(['asc', 'desc']).withMessage('sortOrder must be asc or desc'),
];

export const draftIdParamValidator = [
  param('draftId').isMongoId().withMessage('draftId must be a valid id'),
];

// Fields a client may never set/override on create or update — identity,
// audit, AI-owned, versioning, and post-publish Google Ads identifiers.
// Rejected explicitly (400) rather than silently stripped, so a client
// relying on them gets a clear signal. `campaign`/`adGroups` deep shape is
// checked by campaignStructureValidator.js in the service.
const PROTECTED_FIELDS = [
  'createdBy', 'updatedBy', 'createdAt', 'updatedAt',
  'aiMetadata', 'version', 'changes',
  'googleAdsCampaignId', 'googleAdsAdGroupIds', 'googleAdsAdIds', 'publishedAt',
  'isDeleted', 'deletedAt', '_id', '__v',
];

export const createDraftValidator = [
  body('projectId')
    .notEmpty().withMessage('projectId is required')
    .isMongoId().withMessage('projectId must be a valid id'),
  body('googleAdsCustomerId')
    .notEmpty().withMessage('googleAdsCustomerId is required')
    .bail()
    .customSanitizer((v) => String(v).replace(/[\s-]/g, ''))
    .matches(/^\d{10}$/).withMessage('googleAdsCustomerId must be a 10-digit Google Ads customer ID'),
  body('campaign')
    .exists().withMessage('campaign is required')
    .bail()
    .isObject().withMessage('campaign must be an object'),
  body('adGroups')
    .optional()
    .isArray().withMessage('adGroups must be an array'),
  // status can't be chosen at creation time — it is always 'draft'.
  body('status').not().exists().withMessage('status cannot be set on create'),
  ...PROTECTED_FIELDS.map((f) =>
    body(f).not().exists().withMessage(`${f} cannot be set by the client`)),
];

export const updateDraftValidator = [
  ...draftIdParamValidator,
  body('campaign').optional().isObject().withMessage('campaign must be an object'),
  body('adGroups').optional().isArray().withMessage('adGroups must be an array'),
  body('googleAdsCustomerId')
    .optional()
    .customSanitizer((v) => String(v).replace(/[\s-]/g, ''))
    .matches(/^\d{10}$/).withMessage('googleAdsCustomerId must be a 10-digit Google Ads customer ID'),
  // Phase 1 exposes no status-transition endpoint — status is immutable via
  // PATCH (see campaignDraftService.updateDraft and the status machine in
  // aiCampaignEnums.js).
  body('status').not().exists().withMessage('status cannot be changed through this endpoint'),
  body('projectId').not().exists().withMessage('projectId cannot be changed after creation'),
  ...PROTECTED_FIELDS.map((f) =>
    body(f).not().exists().withMessage(`${f} cannot be modified by the client`)),
];

/**
 * POST /generate — request-shape validation for AI campaign generation
 * (Phase 2). Deep semantic validation of the brief is
 * campaignBriefValidator.validateAndNormalizeBrief (runs in the service,
 * before any Claude call); this is the cheap HTTP-edge gate. Bodies that
 * pass here still go through the brief validator.
 */
export const generateCampaignValidator = [
  body('projectId')
    .notEmpty().withMessage('projectId is required')
    .isMongoId().withMessage('projectId must be a valid id'),
  body('brief')
    .exists().withMessage('brief is required')
    .bail()
    .isObject().withMessage('brief must be an object'),
  body('brief.businessDescription')
    .exists({ checkFalsy: true }).withMessage('brief.businessDescription is required')
    .bail()
    .isString().trim()
    .isLength({ max: BRIEF_LIMITS.businessDescriptionMax })
    .withMessage(`brief.businessDescription must be at most ${BRIEF_LIMITS.businessDescriptionMax} characters`),
  body('brief.businessName')
    .optional({ checkFalsy: true }).isString().trim()
    .isLength({ max: BRIEF_LIMITS.businessNameMax })
    .withMessage(`brief.businessName must be at most ${BRIEF_LIMITS.businessNameMax} characters`),
  body('brief.campaignGoal')
    .exists({ checkFalsy: true }).withMessage('brief.campaignGoal is required')
    .bail()
    .customSanitizer((v) => String(v).toUpperCase())
    .isIn(CAMPAIGN_OBJECTIVES).withMessage(`brief.campaignGoal must be one of: ${CAMPAIGN_OBJECTIVES.join(', ')}`),
  body('brief.targetAudience')
    .optional({ checkFalsy: true }).isString().trim()
    .isLength({ max: BRIEF_LIMITS.targetAudienceMax })
    .withMessage(`brief.targetAudience must be at most ${BRIEF_LIMITS.targetAudienceMax} characters`),
  body('brief.dailyBudget')
    .exists().withMessage('brief.dailyBudget is required')
    .bail()
    .isFloat({ gt: 0, max: BRIEF_LIMITS.dailyBudgetMajorMax })
    .withMessage(`brief.dailyBudget must be a positive number not exceeding ${BRIEF_LIMITS.dailyBudgetMajorMax}`),
  body('brief.currency')
    .exists({ checkFalsy: true }).withMessage('brief.currency is required')
    .bail()
    .customSanitizer((v) => String(v).toUpperCase())
    .matches(/^[A-Z]{3}$/).withMessage('brief.currency must be an ISO 4217 alpha-3 code'),
  body('brief.location')
    .exists().withMessage('brief.location is required')
    .bail()
    .isObject().withMessage('brief.location must be an object'),
  body('brief.location.name')
    .exists({ checkFalsy: true }).withMessage('brief.location.name is required')
    .bail()
    .isString().trim().isLength({ min: 1, max: 200 }),
  body('brief.location.countryCode')
    .exists({ checkFalsy: true }).withMessage('brief.location.countryCode is required')
    .bail()
    .customSanitizer((v) => String(v).toUpperCase())
    .matches(/^[A-Z]{2}$/).withMessage('brief.location.countryCode must be an ISO 3166-1 alpha-2 code'),
  body('brief.location.type')
    .exists({ checkFalsy: true }).withMessage('brief.location.type is required')
    .bail()
    .customSanitizer((v) => String(v).toUpperCase())
    .isIn(LOCATION_TYPES).withMessage(`brief.location.type must be one of: ${LOCATION_TYPES.join(', ')}`),
  body('brief.landingPageUrl')
    .optional({ checkFalsy: true }).isString().trim()
    .isLength({ max: BRIEF_LIMITS.landingPageUrlMax })
    .withMessage(`brief.landingPageUrl must be at most ${BRIEF_LIMITS.landingPageUrlMax} characters`)
    .bail()
    .isURL({ require_protocol: true, protocols: ['http', 'https'] })
    .withMessage('brief.landingPageUrl must be a valid absolute http(s) URL'),
  body('brief.additionalInstructions')
    .optional({ checkFalsy: true }).isString().trim()
    .isLength({ max: BRIEF_LIMITS.additionalInstructionsMax })
    .withMessage(`brief.additionalInstructions must be at most ${BRIEF_LIMITS.additionalInstructionsMax} characters`),
  // Optional explicit account override. When absent the service falls back
  // to the project's connected Google Ads account.
  body('googleAdsCustomerId')
    .optional({ checkFalsy: true })
    .customSanitizer((v) => String(v).replace(/[\s-]/g, ''))
    .matches(/^\d{10}$/).withMessage('googleAdsCustomerId must be a 10-digit Google Ads customer ID'),
  // Mass-assignment guard — a generation request carries only projectId +
  // brief (+ optional googleAdsCustomerId). Nothing else is honoured.
  body(['status', 'campaign', 'adGroups', 'aiMetadata', 'version', 'changes', 'createdBy', '_id'])
    .not().exists().withMessage('This field cannot be set on a generation request'),
];

export default {
  projectIdQueryValidator,
  listDraftsValidator,
  draftIdParamValidator,
  createDraftValidator,
  updateDraftValidator,
  generateCampaignValidator,
};
