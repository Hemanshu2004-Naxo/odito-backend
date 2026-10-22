/**
 * Campaign draft STRUCTURE validator — the centralized domain validation
 * layer (spec §19).
 *
 * Pure, synchronous, deterministic, and dependency-free: no Express, no
 * Mongoose, no network. Given a plain draft-shaped object it returns
 *
 *   { valid: boolean, errors: string[], warnings: string[] }
 *
 * This is intentionally SEPARATE from:
 *   - campaignDraftValidator.js (express-validator request-shape checks at
 *     the HTTP edge), and
 *   - the Mongoose schema (persistence-level type/enum/required checks).
 *
 * It validates the campaign as a coherent whole — the cross-field rules a
 * schema can't express (RSA needs ≥3 headlines, an ad group with keywords
 * needs at least one ad, …).
 *
 * Full Google Ads POLICY validation (trademark terms, capitalisation rules,
 * destination-URL reachability, actual Ads policy-center compliance, …) is
 * explicitly NOT done here — real policy enforcement happens in Google Ads
 * itself at review time. `runPolicyValidators` (opt-in via `runPolicy:true`,
 * first used by Phase 5) runs only a small, conservative, deterministic
 * scan for common problem phrasing (unsupported guarantees, fabricated
 * certifications/awards, …) and only ever adds WARNINGS — see
 * validator/policyClaimsScanner.js.
 */

import {
  CAMPAIGN_OBJECTIVES,
  BIDDING_STRATEGIES,
  LOCATION_TYPES,
  KEYWORD_MATCH_TYPES,
  AD_TYPES,
  CURRENCY_CODE_PATTERN,
  COUNTRY_CODE_PATTERN,
  LANGUAGE_CODE_PATTERN,
  RSA_LIMITS,
  ASSET_LIMITS,
  STRUCTURED_SNIPPET_HEADERS,
} from '../constants/aiCampaignEnums.js';
import { scanCampaignForPolicyConcerns } from './policyClaimsScanner.js';

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Deterministic, network-free URL check. Requires an absolute http(s) URL.
 * Returns { ok, https } so the caller can warn (not fail) on plain http.
 */
export function inspectFinalUrl(value) {
  if (!isNonEmptyString(value)) return { ok: false, https: false };
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, https: false };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, https: false };
  }
  return { ok: true, https: url.protocol === 'https:' };
}

// ── Campaign ───────────────────────────────────────────────────────────────
function validateCampaign(campaign, errors, { requireLocation = false } = {}) {
  if (!campaign || typeof campaign !== 'object') {
    errors.push('campaign is required');
    return;
  }

  if (!isNonEmptyString(campaign.name)) {
    errors.push('campaign.name is required');
  }

  if (!CAMPAIGN_OBJECTIVES.includes(campaign.objective)) {
    errors.push(`campaign.objective must be one of: ${CAMPAIGN_OBJECTIVES.join(', ')}`);
  }

  if (!BIDDING_STRATEGIES.includes(campaign.biddingStrategy)) {
    errors.push(`campaign.biddingStrategy must be one of: ${BIDDING_STRATEGIES.join(', ')}`);
  }

  // Budget: an integer number of micros, strictly positive. No float money.
  const micros = campaign.dailyBudgetMicros;
  if (typeof micros !== 'number' || !Number.isInteger(micros) || micros < 1) {
    errors.push('campaign.dailyBudgetMicros must be a positive integer (micros)');
  }

  if (!isNonEmptyString(campaign.currency) || !CURRENCY_CODE_PATTERN.test(campaign.currency)) {
    errors.push('campaign.currency must be an ISO 4217 alpha-3 code (e.g. INR, USD)');
  }

  // requireLocation=false (Phase 1-4's exact existing call shape, and the
  // default here): an empty/absent locations array is allowed — a draft
  // can be built incrementally with no target location yet. Phase 5's
  // pre-publish check is the first caller to pass requireLocation:true,
  // since Google Ads cannot serve a campaign with zero target locations.
  if (requireLocation && (!Array.isArray(campaign.locations) || campaign.locations.length === 0)) {
    errors.push('campaign.locations must include at least one location');
  }
  validateLocations(campaign.locations, errors);
  validateLanguages(campaign.languages, errors);
  validateSitelinks(campaign.sitelinks, errors);
  validateCallouts(campaign.callouts, errors);
  validateStructuredSnippets(campaign.structuredSnippets, errors);
}

// ── Campaign extension assets — SHAPE only (char limits, required fields,
// header enum). Cross-cutting quality concerns (duplicates, trusted-URL
// enforcement, target counts) live in creativeQualityValidator.js — this
// file's job, as documented in the header above, is "is this well-formed",
// not "is this good". ──────────────────────────────────────────────────────
function validateSitelinks(sitelinks, errors) {
  if (sitelinks == null) return; // optional
  if (!Array.isArray(sitelinks)) { errors.push('campaign.sitelinks must be an array'); return; }
  sitelinks.forEach((sl, i) => {
    const at = `campaign.sitelinks[${i}]`;
    if (!sl || typeof sl !== 'object') { errors.push(`${at} must be an object`); return; }
    if (!isNonEmptyString(sl.text)) errors.push(`${at}.text is required`);
    else if (sl.text.trim().length > ASSET_LIMITS.SITELINK_TEXT_MAX_CHARS) errors.push(`${at}.text must be at most ${ASSET_LIMITS.SITELINK_TEXT_MAX_CHARS} characters`);
    for (const field of ['description1', 'description2']) {
      if (sl[field] != null && String(sl[field]).length > ASSET_LIMITS.SITELINK_DESCRIPTION_MAX_CHARS) {
        errors.push(`${at}.${field} must be at most ${ASSET_LIMITS.SITELINK_DESCRIPTION_MAX_CHARS} characters`);
      }
    }
    if (!isNonEmptyString(sl.finalUrl) || !inspectFinalUrl(sl.finalUrl).ok) errors.push(`${at}.finalUrl must be a valid absolute http(s) URL`);
  });
}

function validateCallouts(callouts, errors) {
  if (callouts == null) return;
  if (!Array.isArray(callouts)) { errors.push('campaign.callouts must be an array'); return; }
  callouts.forEach((co, i) => {
    const at = `campaign.callouts[${i}]`;
    if (!co || typeof co !== 'object') { errors.push(`${at} must be an object`); return; }
    if (!isNonEmptyString(co.text)) errors.push(`${at}.text is required`);
    else if (co.text.trim().length > ASSET_LIMITS.CALLOUT_TEXT_MAX_CHARS) errors.push(`${at}.text must be at most ${ASSET_LIMITS.CALLOUT_TEXT_MAX_CHARS} characters`);
  });
}

function validateStructuredSnippets(snippets, errors) {
  if (snippets == null) return;
  if (!Array.isArray(snippets)) { errors.push('campaign.structuredSnippets must be an array'); return; }
  snippets.forEach((sn, i) => {
    const at = `campaign.structuredSnippets[${i}]`;
    if (!sn || typeof sn !== 'object') { errors.push(`${at} must be an object`); return; }
    if (!STRUCTURED_SNIPPET_HEADERS.includes(sn.header)) errors.push(`${at}.header must be one of: ${STRUCTURED_SNIPPET_HEADERS.join(', ')}`);
    if (!Array.isArray(sn.values)) { errors.push(`${at}.values must be an array`); return; }
    sn.values.forEach((v, vi) => {
      if (!isNonEmptyString(v)) errors.push(`${at}.values[${vi}] cannot be empty`);
      else if (v.trim().length > ASSET_LIMITS.SNIPPET_VALUE_MAX_CHARS) errors.push(`${at}.values[${vi}] must be at most ${ASSET_LIMITS.SNIPPET_VALUE_MAX_CHARS} characters`);
    });
  });
}

function validateLocations(locations, errors) {
  if (locations == null) return; // optional
  if (!Array.isArray(locations)) {
    errors.push('campaign.locations must be an array');
    return;
  }
  locations.forEach((loc, i) => {
    const at = `campaign.locations[${i}]`;
    if (!loc || typeof loc !== 'object') {
      errors.push(`${at} must be an object`);
      return;
    }
    if (!isNonEmptyString(loc.name)) errors.push(`${at}.name is required`);
    if (!isNonEmptyString(loc.countryCode) || !COUNTRY_CODE_PATTERN.test(String(loc.countryCode).toUpperCase())) {
      errors.push(`${at}.countryCode must be an ISO 3166-1 alpha-2 code`);
    }
    if (!LOCATION_TYPES.includes(loc.type)) {
      errors.push(`${at}.type must be one of: ${LOCATION_TYPES.join(', ')}`);
    }
  });
}

function validateLanguages(languages, errors) {
  if (languages == null) return; // optional
  if (!Array.isArray(languages)) {
    errors.push('campaign.languages must be an array');
    return;
  }
  languages.forEach((lang, i) => {
    const at = `campaign.languages[${i}]`;
    if (!lang || typeof lang !== 'object') {
      errors.push(`${at} must be an object`);
      return;
    }
    if (!isNonEmptyString(lang.code) || !LANGUAGE_CODE_PATTERN.test(lang.code)) {
      errors.push(`${at}.code must look like "en" or "en-US"`);
    }
    if (!isNonEmptyString(lang.name)) errors.push(`${at}.name is required`);
  });
}

// ── Keywords ───────────────────────────────────────────────────────────────
function validateKeyword(kw, at, errors, { matchTypeRequired }) {
  if (!kw || typeof kw !== 'object') {
    errors.push(`${at} must be an object`);
    return;
  }
  if (!isNonEmptyString(kw.text)) {
    errors.push(`${at}.text cannot be empty`);
  }
  if (matchTypeRequired || kw.matchType !== undefined) {
    if (!KEYWORD_MATCH_TYPES.includes(kw.matchType)) {
      errors.push(`${at}.matchType must be one of: ${KEYWORD_MATCH_TYPES.join(', ')}`);
    }
  }
}

// ── Ads ────────────────────────────────────────────────────────────────────
function validateAd(ad, at, errors, warnings, strictRsa) {
  if (!ad || typeof ad !== 'object') {
    errors.push(`${at} must be an object`);
    return;
  }

  if (!AD_TYPES.includes(ad.type)) {
    errors.push(`${at}.type must be one of: ${AD_TYPES.join(', ')}`);
    return; // per-type rules below assume a known type
  }

  if (ad.type === 'RESPONSIVE_SEARCH_AD') {
    // strictRsa=false (Phase 1 create/update): only the assets that ARE
    // present are checked (non-empty, within char limits) so a Phase 2/3
    // draft can be built up incrementally. strictRsa=true (Phase 5 "ready
    // to validate"): the ≥3 headline / ≥2 description minimums are enforced.
    validateRsaAssets(ad.headlines, `${at}.headlines`, errors, {
      min: strictRsa ? RSA_LIMITS.HEADLINES_MIN : 0,
      max: RSA_LIMITS.HEADLINES_MAX,
      maxChars: RSA_LIMITS.HEADLINE_MAX_CHARS,
    });
    validateRsaAssets(ad.descriptions, `${at}.descriptions`, errors, {
      min: strictRsa ? RSA_LIMITS.DESCRIPTIONS_MIN : 0,
      max: RSA_LIMITS.DESCRIPTIONS_MAX,
      maxChars: RSA_LIMITS.DESCRIPTION_MAX_CHARS,
    });
  }

  const urlCheck = inspectFinalUrl(ad.finalUrl);
  if (!urlCheck.ok) {
    errors.push(`${at}.finalUrl must be a valid absolute http(s) URL`);
  } else if (!urlCheck.https) {
    warnings.push(`${at}.finalUrl uses http — https is strongly preferred`);
  }

  for (const p of ['path1', 'path2']) {
    if (ad[p] != null && String(ad[p]).length > RSA_LIMITS.PATH_MAX_CHARS) {
      errors.push(`${at}.${p} must be at most ${RSA_LIMITS.PATH_MAX_CHARS} characters`);
    }
  }
}

function validateRsaAssets(assets, at, errors, { min, max, maxChars }) {
  if (assets == null && min === 0) return; // lenient mode, nothing to check
  if (!Array.isArray(assets)) {
    errors.push(`${at} must be an array`);
    return;
  }
  if (min > 0 && assets.length < min) {
    errors.push(`${at} requires at least ${min} entries`);
  }
  if (assets.length > max) {
    errors.push(`${at} allows at most ${max} entries`);
  }
  assets.forEach((asset, i) => {
    const text = asset && typeof asset === 'object' ? asset.text : asset;
    if (!isNonEmptyString(text)) {
      errors.push(`${at}[${i}].text cannot be empty`);
      return;
    }
    if (text.trim().length > maxChars) {
      errors.push(`${at}[${i}].text must be at most ${maxChars} characters`);
    }
  });
}

// ── Ad groups ──────────────────────────────────────────────────────────────
function validateAdGroups(adGroups, errors, warnings, strictRsa) {
  if (adGroups == null) return; // an empty draft is allowed to persist
  if (!Array.isArray(adGroups)) {
    errors.push('adGroups must be an array');
    return;
  }

  adGroups.forEach((ag, i) => {
    const at = `adGroups[${i}]`;
    if (!ag || typeof ag !== 'object') {
      errors.push(`${at} must be an object`);
      return;
    }
    if (!isNonEmptyString(ag.name)) errors.push(`${at}.name is required`);

    const keywords = ag.keywords ?? [];
    const ads = ag.ads ?? [];
    const negatives = ag.negativeKeywords ?? [];

    if (!Array.isArray(keywords)) errors.push(`${at}.keywords must be an array`);
    else keywords.forEach((kw, k) => validateKeyword(kw, `${at}.keywords[${k}]`, errors, { matchTypeRequired: true }));

    if (!Array.isArray(negatives)) errors.push(`${at}.negativeKeywords must be an array`);
    else negatives.forEach((nk, n) => validateKeyword(nk, `${at}.negativeKeywords[${n}]`, errors, { matchTypeRequired: false }));

    if (!Array.isArray(ads)) errors.push(`${at}.ads must be an array`);
    else ads.forEach((ad, a) => validateAd(ad, `${at}.ads[${a}]`, errors, warnings, strictRsa));

    // Cross-field coherence: an ad group that targets keywords should have
    // at least one ad to serve for them, and vice versa. A hard error only
    // in strict mode (Phase 5); a warning while a draft is still being
    // assembled.
    if (Array.isArray(keywords) && Array.isArray(ads)) {
      if (keywords.length > 0 && ads.length === 0) {
        (strictRsa ? errors : warnings).push(`${at} has keywords but no ads`);
      }
      if (ads.length > 0 && keywords.length === 0) {
        warnings.push(`${at} has ads but no keywords`);
      }
    }
  });
}

/**
 * Phase 5: deterministic, conservative ad-copy policy-concern scan (spec
 * §15). Only ever pushes WARNINGS — a keyword match is not proof of a
 * policy violation, so this never fails `valid`. See
 * validator/policyClaimsScanner.js for the actual patterns and the
 * rationale for keeping this intentionally small/conservative.
 * `_errors` is unused (kept in the signature so this remains a drop-in
 * seam for anything a future phase adds that DOES need to block).
 */
function runPolicyValidators(draft, _errors, warnings) {
  scanCampaignForPolicyConcerns(draft, warnings);
}

/**
 * Validate a full draft-shaped object.
 *
 * @param {object} draft - plain object with { campaign, adGroups } at least.
 * @param {object} [opts]
 * @param {boolean} [opts.requireAdGroups=false] - when true, a draft with
 *        zero ad groups is an error (used by later "ready to validate"
 *        checks; Phase 1 create/update leaves this false so partial drafts
 *        persist).
 * @param {boolean} [opts.strictRsa=false] - when true, enforce the RSA
 *        ≥3-headline / ≥2-description minimums and the "keywords but no ads"
 *        coherence rule. Phase 1 create/update leaves this false so a draft
 *        can be built incrementally; Phase 5 turns it on.
 * @param {boolean} [opts.runPolicy=false] - when true, also runs the
 *        conservative deterministic policy-concern scan (warnings only —
 *        see policyClaimsScanner.js). First used by Phase 5.
 * @param {boolean} [opts.requireLocation=false] - when true, a campaign
 *        with zero target locations is an error. Phase 1-4 leave this
 *        false (a draft can be built incrementally with no location yet);
 *        Phase 5's pre-publish check turns it on, since Google Ads cannot
 *        serve a campaign with no target location.
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateCampaignDraftStructure(draft, opts = {}) {
  const { requireAdGroups = false, strictRsa = false, runPolicy = false, requireLocation = false } = opts;
  const errors = [];
  const warnings = [];

  if (!draft || typeof draft !== 'object') {
    return { valid: false, errors: ['draft payload must be an object'], warnings };
  }

  validateCampaign(draft.campaign, errors, { requireLocation });

  if (requireAdGroups && (!Array.isArray(draft.adGroups) || draft.adGroups.length === 0)) {
    errors.push('at least one ad group is required');
  }
  validateAdGroups(draft.adGroups, errors, warnings, strictRsa);

  if (runPolicy) runPolicyValidators(draft, errors, warnings);

  return { valid: errors.length === 0, errors, warnings };
}

export default validateCampaignDraftStructure;
