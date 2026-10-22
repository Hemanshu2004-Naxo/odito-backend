/**
 * Campaign BRIEF validation + normalization (spec §8).
 *
 * Runs BEFORE any Claude call. Deterministic, synchronous, no network.
 * Returns a normalized brief object or throws the repo-standard
 * `ValidationError` (mapped to HTTP 400 by the controller). If this throws,
 * Claude is never called.
 *
 * Separate from:
 *   - campaignDraftValidator.generateCampaignValidator (express-validator
 *     request-shape checks at the HTTP edge), and
 *   - campaignStructureValidator (validates the GENERATED campaign).
 */

import { ValidationError } from '../../../utils/ErrorUtil.js';
import { inspectFinalUrl } from '../validator/campaignStructureValidator.js';
import {
  CAMPAIGN_OBJECTIVES,
  LOCATION_TYPES,
  CURRENCY_CODE_PATTERN,
  COUNTRY_CODE_PATTERN,
} from '../constants/aiCampaignEnums.js';
import { BRIEF_LIMITS } from '../constants/generationConfig.js';

function str(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function assertMaxLen(value, max, field) {
  if (value && value.length > max) {
    throw new ValidationError(`brief.${field} must be at most ${max} characters`);
  }
}

/**
 * @param {object} rawBrief
 * @returns {object} normalized brief:
 *   { businessName, businessDescription, campaignGoal, targetAudience,
 *     location: { name, countryCode, type }, dailyBudget (number, major units),
 *     currency, landingPageUrl (string|null), additionalInstructions }
 */
export function validateAndNormalizeBrief(rawBrief) {
  if (!rawBrief || typeof rawBrief !== 'object' || Array.isArray(rawBrief)) {
    throw new ValidationError('brief is required and must be an object');
  }

  // Guard against prompt-bloat / token abuse before doing anything else.
  let serializedLen = 0;
  try {
    serializedLen = Buffer.byteLength(JSON.stringify(rawBrief), 'utf8');
  } catch {
    throw new ValidationError('brief is not serializable');
  }
  if (serializedLen > BRIEF_LIMITS.totalSerializedMax) {
    throw new ValidationError(`brief is too large (${serializedLen} bytes; limit ${BRIEF_LIMITS.totalSerializedMax})`);
  }

  const businessName = str(rawBrief.businessName);
  const businessDescription = str(rawBrief.businessDescription);
  const targetAudience = str(rawBrief.targetAudience);
  const additionalInstructions = str(rawBrief.additionalInstructions);

  // ── Business ───────────────────────────────────────────────────────────
  assertMaxLen(businessName, BRIEF_LIMITS.businessNameMax, 'businessName');
  if (!businessDescription) {
    throw new ValidationError('brief.businessDescription is required');
  }
  assertMaxLen(businessDescription, BRIEF_LIMITS.businessDescriptionMax, 'businessDescription');
  assertMaxLen(targetAudience, BRIEF_LIMITS.targetAudienceMax, 'targetAudience');
  assertMaxLen(additionalInstructions, BRIEF_LIMITS.additionalInstructionsMax, 'additionalInstructions');

  // ── Goal / objective ──────────────────────────────────────────────────
  const campaignGoal = str(rawBrief.campaignGoal || rawBrief.campaignObjective).toUpperCase();
  if (!CAMPAIGN_OBJECTIVES.includes(campaignGoal)) {
    throw new ValidationError(`brief.campaignGoal must be one of: ${CAMPAIGN_OBJECTIVES.join(', ')}`);
  }

  // ── Budget + currency ─────────────────────────────────────────────────
  const dailyBudget = Number(rawBrief.dailyBudget);
  if (!Number.isFinite(dailyBudget) || dailyBudget <= 0) {
    throw new ValidationError('brief.dailyBudget must be a positive number');
  }
  if (dailyBudget > BRIEF_LIMITS.dailyBudgetMajorMax) {
    throw new ValidationError(`brief.dailyBudget must not exceed ${BRIEF_LIMITS.dailyBudgetMajorMax}`);
  }
  const currency = str(rawBrief.currency).toUpperCase();
  if (!currency) throw new ValidationError('brief.currency is required');
  if (!CURRENCY_CODE_PATTERN.test(currency)) {
    throw new ValidationError('brief.currency must be an ISO 4217 alpha-3 code (e.g. INR, USD)');
  }

  // ── Location (normalized Odito structure) ─────────────────────────────
  const loc = rawBrief.location;
  if (!loc || typeof loc !== 'object' || Array.isArray(loc)) {
    throw new ValidationError('brief.location is required and must be an object');
  }
  const location = {
    name: str(loc.name),
    countryCode: str(loc.countryCode).toUpperCase(),
    type: str(loc.type).toUpperCase(),
  };
  if (!location.name) throw new ValidationError('brief.location.name is required');
  if (!COUNTRY_CODE_PATTERN.test(location.countryCode)) {
    throw new ValidationError('brief.location.countryCode must be an ISO 3166-1 alpha-2 code');
  }
  if (!LOCATION_TYPES.includes(location.type)) {
    throw new ValidationError(`brief.location.type must be one of: ${LOCATION_TYPES.join(', ')}`);
  }

  // ── Landing page (optional) ──────────────────────────────────────────
  let landingPageUrl = null;
  if (rawBrief.landingPageUrl != null && str(rawBrief.landingPageUrl) !== '') {
    const raw = str(rawBrief.landingPageUrl);
    assertMaxLen(raw, BRIEF_LIMITS.landingPageUrlMax, 'landingPageUrl');
    const check = inspectFinalUrl(raw); // deterministic, no network request
    if (!check.ok) {
      throw new ValidationError('brief.landingPageUrl must be a valid absolute http(s) URL');
    }
    landingPageUrl = raw;
  }

  return {
    businessName: businessName || null,
    businessDescription,
    campaignGoal,
    targetAudience: targetAudience || null,
    location,
    dailyBudget,
    currency,
    landingPageUrl,
    additionalInstructions: additionalInstructions || null,
    // Non-blocking signal for observability / the prompt; never fails here.
    landingPageIsHttps: landingPageUrl ? inspectFinalUrl(landingPageUrl).https : null,
  };
}

export default { validateAndNormalizeBrief };
