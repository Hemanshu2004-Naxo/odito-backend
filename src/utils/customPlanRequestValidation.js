/**
 * Pure, DB-free validation for the Custom Plan request form (Phase 4).
 * Same convention as keywordValidation.js: a single throw-based validator
 * that returns a cleaned payload, never a scattered if/return chain. The
 * frontend mirrors these same rules for instant feedback (see
 * CustomPlanRequestForm.jsx's client-side checks) but this is the only
 * place they're actually enforced — never trust client-side alone.
 */

export const TEAM_SIZE_OPTIONS = ['1-10', '11-50', '51-200', '200+'];
export const BUDGET_RANGE_OPTIONS = ['not_sure', '500_1000', '1000_5000', '5000_plus'];
export const TIMELINE_OPTIONS = ['immediately', 'within_30_days', 'exploring'];
export const FEATURE_REQUIREMENT_OPTIONS = [
  'white_label',
  'api_access',
  'sso_saml',
  'dedicated_account_manager',
  'custom_integrations',
];

const MAX_COMPANY_NAME = 200;
const MAX_COMPANY_WEBSITE = 500;
const MAX_CONTACT_NAME = 150;
const MAX_CONTACT_EMAIL = 254;
const MAX_CONTACT_PHONE = 40;
const MAX_ADDITIONAL_REQUIREMENTS = 2000;
const MAX_PROJECT_COUNT = 100000;
const MAX_REQUIRED_CREDITS = 1000000;
const MAX_REQUIRED_PAGES = 100000000;

// Deliberately permissive (matches how this codebase already validates
// email elsewhere, e.g. websiteExtractionService.js) — this is a lead form,
// not an account-creation flow; rejecting a real but unusual address is a
// worse failure mode than accepting a slightly malformed one a human sales
// rep will read anyway.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_REGEX = /^https?:\/\/[^\s]+\.[^\s]+$/i;

function requestError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requiredString(value, fieldName, maxLength, code) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw requestError(`${fieldName} is required.`, code);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw requestError(`${fieldName} cannot exceed ${maxLength} characters.`, code);
  }
  return trimmed;
}

function optionalString(value, fieldName, maxLength, code) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw requestError(`${fieldName} must be text.`, code);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxLength) {
    throw requestError(`${fieldName} cannot exceed ${maxLength} characters.`, code);
  }
  return trimmed;
}

function optionalPositiveInt(value, fieldName, max, code) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num < 0) {
    throw requestError(`${fieldName} must be a whole number.`, code);
  }
  if (num > max) {
    throw requestError(`${fieldName} cannot exceed ${max}.`, code);
  }
  return num;
}

/**
 * @param {object} rawBody - untrusted req.body
 * @returns {object} a cleaned payload ready for CustomPlanRequest.create()
 *   (userId is NOT included — the caller/controller attaches that from
 *   req.user, never from client input)
 * @throws {Error} .code one of INVALID_COMPANY_NAME, INVALID_COMPANY_WEBSITE,
 *   INVALID_CONTACT_NAME, INVALID_CONTACT_EMAIL, INVALID_CONTACT_PHONE,
 *   INVALID_TEAM_SIZE, INVALID_PROJECT_COUNT, INVALID_REQUIRED_CREDITS,
 *   INVALID_REQUIRED_PAGES, INVALID_FEATURE_REQUIREMENTS,
 *   INVALID_BUDGET_RANGE, INVALID_TIMELINE, INVALID_ADDITIONAL_REQUIREMENTS
 */
export function validateCustomPlanRequestInput(rawBody) {
  const body = rawBody && typeof rawBody === 'object' ? rawBody : {};

  const companyName = requiredString(body.companyName, 'Company name', MAX_COMPANY_NAME, 'INVALID_COMPANY_NAME');

  let companyWebsite = optionalString(body.companyWebsite, 'Company website', MAX_COMPANY_WEBSITE, 'INVALID_COMPANY_WEBSITE');
  if (companyWebsite && !URL_REGEX.test(companyWebsite)) {
    throw requestError('Company website must be a valid URL starting with http:// or https://.', 'INVALID_COMPANY_WEBSITE');
  }

  const contactName = requiredString(body.contactName, 'Contact name', MAX_CONTACT_NAME, 'INVALID_CONTACT_NAME');

  const contactEmail = requiredString(body.contactEmail, 'Contact email', MAX_CONTACT_EMAIL, 'INVALID_CONTACT_EMAIL').toLowerCase();
  if (!EMAIL_REGEX.test(contactEmail)) {
    throw requestError('Contact email must be a valid email address.', 'INVALID_CONTACT_EMAIL');
  }

  const contactPhone = optionalString(body.contactPhone, 'Contact phone', MAX_CONTACT_PHONE, 'INVALID_CONTACT_PHONE');

  if (!TEAM_SIZE_OPTIONS.includes(body.teamSize)) {
    throw requestError('Please select a valid team size.', 'INVALID_TEAM_SIZE');
  }
  const teamSize = body.teamSize;

  const projectCountNum = Number(body.projectCount);
  if (!Number.isFinite(projectCountNum) || !Number.isInteger(projectCountNum) || projectCountNum < 1) {
    throw requestError('Number of projects must be at least 1.', 'INVALID_PROJECT_COUNT');
  }
  if (projectCountNum > MAX_PROJECT_COUNT) {
    throw requestError(`Number of projects cannot exceed ${MAX_PROJECT_COUNT}.`, 'INVALID_PROJECT_COUNT');
  }
  const projectCount = projectCountNum;

  const requiredCredits = optionalPositiveInt(body.requiredCredits, 'Required credits', MAX_REQUIRED_CREDITS, 'INVALID_REQUIRED_CREDITS');
  const requiredPages = optionalPositiveInt(body.requiredPages, 'Required pages', MAX_REQUIRED_PAGES, 'INVALID_REQUIRED_PAGES');

  let featureRequirements = [];
  if (body.featureRequirements !== undefined && body.featureRequirements !== null) {
    if (!Array.isArray(body.featureRequirements)) {
      throw requestError('Feature requirements must be a list.', 'INVALID_FEATURE_REQUIREMENTS');
    }
    featureRequirements = body.featureRequirements;
    if (!featureRequirements.every((v) => FEATURE_REQUIREMENT_OPTIONS.includes(v))) {
      throw requestError('Feature requirements contains an unknown value.', 'INVALID_FEATURE_REQUIREMENTS');
    }
  }

  let budgetRange = null;
  if (body.budgetRange !== undefined && body.budgetRange !== null && body.budgetRange !== '') {
    if (!BUDGET_RANGE_OPTIONS.includes(body.budgetRange)) {
      throw requestError('Please select a valid budget range.', 'INVALID_BUDGET_RANGE');
    }
    budgetRange = body.budgetRange;
  }

  let timeline = null;
  if (body.timeline !== undefined && body.timeline !== null && body.timeline !== '') {
    if (!TIMELINE_OPTIONS.includes(body.timeline)) {
      throw requestError('Please select a valid timeline.', 'INVALID_TIMELINE');
    }
    timeline = body.timeline;
  }

  const additionalRequirements = optionalString(
    body.additionalRequirements, 'Additional notes', MAX_ADDITIONAL_REQUIREMENTS, 'INVALID_ADDITIONAL_REQUIREMENTS'
  );

  return {
    companyName,
    companyWebsite,
    contactName,
    contactEmail,
    contactPhone,
    teamSize,
    projectCount,
    requiredCredits,
    requiredPages,
    featureRequirements,
    budgetRange,
    timeline,
    additionalRequirements,
  };
}
