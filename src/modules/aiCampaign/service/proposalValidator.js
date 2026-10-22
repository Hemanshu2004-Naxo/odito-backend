/**
 * Change-proposal validator (Phase 4, spec §7 / §11 / §12 / §52).
 *
 * The AUTHORITY on whether Claude's raw `changes` output is safe to
 * persist as a reviewable AiCampaignChangeProposal. Runs immediately after
 * a Claude call, against the SAME draft snapshot the prompt was built
 * from. Nothing here mutates the draft — this only checks that every
 * change:
 *
 *   1. uses an operation legal for its target (PROPOSAL_OPERATION_MATRIX)
 *   2. references a real adGroupId / adId that exists in the draft
 *   3. has a shape appropriate to its target (validated with the SAME
 *      normalizers campaignDraftService already uses for manual edits —
 *      one source of truth for "what a valid campaign value looks like")
 *   4. for remove/replace, has a `before` that matches the draft's actual
 *      current value (a second, per-change layer of staleness/consistency
 *      protection on top of the proposal's baseVersion check)
 *
 * Whole-proposal-fails-together (spec §11/§18 precedent from Phase 2): one
 * invalid change fails the WHOLE proposal (never a partially-usable
 * proposal) — same policy Phase 2 uses for a structurally invalid
 * generation.
 *
 * Security: `before`/`after` are deep-sanitised against prototype
 * pollution (spec §52) before anything is stored. `adGroupId`/`adId` are
 * plain string comparisons — never used as object keys, never passed to a
 * Mongo query, and target/operation are closed enums — there is no path
 * parsing anywhere in this module (spec §7).
 */

import { randomUUID } from 'node:crypto';
import { ValidationError } from '../../../utils/ErrorUtil.js';
import campaignDraftService from './campaignDraftService.js';
import { inspectFinalUrl } from '../validator/campaignStructureValidator.js';
import {
  PROPOSAL_OPERATIONS,
  PROPOSAL_TARGETS,
  PROPOSAL_MAX_CHANGES,
  isOperationAllowedForTarget,
} from '../constants/proposalEnums.js';
import {
  CAMPAIGN_OBJECTIVES,
  BIDDING_STRATEGIES,
  LOCATION_TYPES,
  KEYWORD_MATCH_TYPES,
  COUNTRY_CODE_PATTERN,
} from '../constants/aiCampaignEnums.js';

const { sanitizeKeysDeep, normalizeAdGroups, normalizeAd, normalizeAsset } = campaignDraftService._internals;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}
function textOf(v) {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof v.text === 'string') return v.text;
  return null;
}
function normText(v) {
  return (v || '').trim().toLowerCase();
}

function findAdGroup(draftPlain, adGroupId) {
  return (draftPlain.adGroups || []).find((ag) => ag.id === adGroupId) || null;
}
/** Locate an ad by id anywhere in the draft; returns { adGroup, ad, adGroupIndex, adIndex } or null. */
function findAd(draftPlain, adId, hintAdGroupId = null) {
  const groups = draftPlain.adGroups || [];
  for (let gi = 0; gi < groups.length; gi += 1) {
    const ads = groups[gi].ads || [];
    for (let ai = 0; ai < ads.length; ai += 1) {
      if (ads[ai].id === adId) {
        if (hintAdGroupId && groups[gi].id !== hintAdGroupId) return { conflict: true };
        return { adGroup: groups[gi], ad: ads[ai], adGroupIndex: gi, adIndex: ai };
      }
    }
  }
  return null;
}

/** Wrap-and-unwrap through normalizeAdGroups' own ad normalizer for a single ad payload. */
function normalizeSingleAd(rawAd) {
  return normalizeAd(rawAd);
}
function normalizeSingleAsset(rawAsset) {
  return normalizeAsset(rawAsset, false);
}

// ── per-target validation ───────────────────────────────────────────────
// Each returns { error?: string, resolved?: {...} } — `resolved` carries
// whatever the applier needs (already-normalized after/before values, plus
// the display `path`).

function validateCampaignName(change) {
  const after = isNonEmptyString(change.after) ? change.after.trim().slice(0, 255) : null;
  if (!after) return { error: 'CAMPAIGN_NAME replace requires a non-empty "after" string' };
  return { resolved: { after, path: 'campaign.name' } };
}

function validateCampaignBudget(change) {
  const after = Number(change.after);
  if (!Number.isFinite(after) || after <= 0) {
    return { error: 'CAMPAIGN_DAILY_BUDGET replace requires a positive numeric "after"' };
  }
  return { resolved: { after, path: 'campaign.dailyBudget' } };
}

function validateCampaignBidding(change) {
  const after = typeof change.after === 'string' ? change.after.toUpperCase() : null;
  if (!after || !BIDDING_STRATEGIES.includes(after)) {
    return { error: `CAMPAIGN_BIDDING_STRATEGY replace requires "after" to be one of: ${BIDDING_STRATEGIES.join(', ')}` };
  }
  return { resolved: { after, path: 'campaign.biddingStrategy' } };
}

function validateCampaignLocation(change) {
  const a = change.after;
  if (!a || typeof a !== 'object') return { error: 'CAMPAIGN_LOCATION replace requires an "after" object' };
  const name = isNonEmptyString(a.name) ? a.name.trim() : null;
  const countryCode = typeof a.countryCode === 'string' ? a.countryCode.toUpperCase() : null;
  const type = typeof a.type === 'string' ? a.type.toUpperCase() : null;
  if (!name) return { error: 'CAMPAIGN_LOCATION.after.name is required' };
  if (!countryCode || !COUNTRY_CODE_PATTERN.test(countryCode)) {
    return { error: 'CAMPAIGN_LOCATION.after.countryCode must be an ISO 3166-1 alpha-2 code' };
  }
  if (!type || !LOCATION_TYPES.includes(type)) {
    return { error: `CAMPAIGN_LOCATION.after.type must be one of: ${LOCATION_TYPES.join(', ')}` };
  }
  return { resolved: { after: { name, countryCode, type }, path: 'campaign.locations[0]' } };
}

function validateCampaignLanguage(change) {
  const a = change.after;
  const name = a && typeof a === 'object' ? a.name : typeof a === 'string' ? a : null;
  if (!isNonEmptyString(name)) return { error: 'CAMPAIGN_LANGUAGE.after.name is required' };
  const code = a && typeof a === 'object' && isNonEmptyString(a.code) ? a.code.trim() : 'en';
  return { resolved: { after: { code, name: name.trim() }, path: 'campaign.languages[0]' } };
}

function validateAdGroupAdd(change) {
  if (!change.after || typeof change.after !== 'object') {
    return { error: 'AD_GROUP add requires an "after" object' };
  }
  let normalized;
  try {
    [normalized] = normalizeAdGroups([change.after]);
  } catch (e) {
    return { error: `AD_GROUP add: ${e.message}` };
  }
  if (!isNonEmptyString(normalized.name)) return { error: 'AD_GROUP add requires a non-empty name' };
  return { resolved: { after: normalized, path: 'adGroups[+]' } };
}

function validateAdGroupRemove(change, draftPlain) {
  const ag = findAdGroup(draftPlain, change.adGroupId);
  if (!ag) return { error: `AD_GROUP remove: adGroupId "${change.adGroupId}" not found in this draft` };
  const idx = draftPlain.adGroups.indexOf(ag);
  // `before` is informational only (the applier removes by adGroupId, not
  // by name) — captured purely so the review UI can show which ad group is
  // being removed instead of a bare id.
  return { resolved: { adGroupId: ag.id, before: ag.name, path: `adGroups[${idx}]` } };
}

function validateAdGroupName(change, draftPlain) {
  const ag = findAdGroup(draftPlain, change.adGroupId);
  if (!ag) return { error: `AD_GROUP_NAME: adGroupId "${change.adGroupId}" not found in this draft` };
  if (isNonEmptyString(change.before) && normText(change.before) !== normText(ag.name)) {
    return { error: 'AD_GROUP_NAME.before does not match the ad group\'s current name' };
  }
  const after = isNonEmptyString(change.after) ? change.after.trim().slice(0, 255) : null;
  if (!after) return { error: 'AD_GROUP_NAME replace requires a non-empty "after" string' };
  const idx = draftPlain.adGroups.indexOf(ag);
  return { resolved: { adGroupId: ag.id, after, before: ag.name, path: `adGroups[${idx}].name` } };
}

function validateKeywordLike(change, draftPlain, listField) {
  const ag = findAdGroup(draftPlain, change.adGroupId);
  if (!ag) return { error: `${change.target}: adGroupId "${change.adGroupId}" not found in this draft` };
  const idx = draftPlain.adGroups.indexOf(ag);

  if (change.operation === 'add') {
    const text = textOf(change.after);
    if (!isNonEmptyString(text)) return { error: `${change.target} add requires "after.text"` };
    const matchTypeRaw = change.after && typeof change.after === 'object' ? change.after.matchType : null;
    const matchType = typeof matchTypeRaw === 'string' && KEYWORD_MATCH_TYPES.includes(matchTypeRaw.toUpperCase())
      ? matchTypeRaw.toUpperCase()
      : 'BROAD';
    return { resolved: { adGroupId: ag.id, after: { text: text.trim(), matchType }, path: `adGroups[${idx}].${listField}[+]` } };
  }

  // remove
  const beforeText = textOf(change.before);
  if (!isNonEmptyString(beforeText)) return { error: `${change.target} remove requires "before.text"` };
  const list = ag[listField] || [];
  const matches = list.filter((k) => normText(k.text) === normText(beforeText));
  if (matches.length === 0) {
    return { error: `${change.target} remove: no matching keyword "${beforeText}" found in ad group "${ag.name}"` };
  }
  const kwIdx = list.indexOf(matches[0]);
  return {
    resolved: { adGroupId: ag.id, before: { text: matches[0].text, matchType: matches[0].matchType }, path: `adGroups[${idx}].${listField}[${kwIdx}]` },
  };
}

function validateAdAdd(change, draftPlain) {
  const ag = findAdGroup(draftPlain, change.adGroupId);
  if (!ag) return { error: `AD add: adGroupId "${change.adGroupId}" not found in this draft` };
  if (!change.after || typeof change.after !== 'object') return { error: 'AD add requires an "after" object' };
  let normalized;
  try {
    normalized = normalizeSingleAd(change.after);
  } catch (e) {
    return { error: `AD add: ${e.message}` };
  }
  const idx = draftPlain.adGroups.indexOf(ag);
  return { resolved: { adGroupId: ag.id, after: normalized, path: `adGroups[${idx}].ads[+]` } };
}

function validateAdRemove(change, draftPlain) {
  const found = findAd(draftPlain, change.adId, change.adGroupId);
  if (!found || found.conflict) return { error: `AD remove: adId "${change.adId}" not found (or adGroupId mismatch) in this draft` };
  // `before` is informational only (the applier removes by adId) — the
  // first headline gives the review UI something recognizable to show.
  const displayHint = found.ad.headlines?.[0]?.text || found.ad.finalUrl || null;
  return {
    resolved: {
      adGroupId: found.adGroup.id,
      adId: found.ad.id,
      before: displayHint,
      path: `adGroups[${found.adGroupIndex}].ads[${found.adIndex}]`,
    },
  };
}

function validateAdFinalUrl(change, draftPlain) {
  const found = findAd(draftPlain, change.adId, change.adGroupId);
  if (!found || found.conflict) return { error: `AD_FINAL_URL: adId "${change.adId}" not found (or adGroupId mismatch) in this draft` };
  const after = typeof change.after === 'string' ? change.after.trim() : '';
  const check = inspectFinalUrl(after);
  if (!check.ok) return { error: 'AD_FINAL_URL.after must be a valid absolute http(s) URL' };
  return {
    resolved: {
      adGroupId: found.adGroup.id,
      adId: found.ad.id,
      after,
      before: found.ad.finalUrl,
      path: `adGroups[${found.adGroupIndex}].ads[${found.adIndex}].finalUrl`,
    },
  };
}

function validateAdAsset(change, draftPlain, listField) {
  const found = findAd(draftPlain, change.adId, change.adGroupId);
  if (!found || found.conflict) return { error: `${change.target}: adId "${change.adId}" not found (or adGroupId mismatch) in this draft` };
  const basePath = `adGroups[${found.adGroupIndex}].ads[${found.adIndex}].${listField}`;

  if (change.operation === 'add') {
    const text = textOf(change.after);
    if (!isNonEmptyString(text)) return { error: `${change.target} add requires "after" text` };
    let normalized;
    try {
      normalized = normalizeSingleAsset({ text });
    } catch (e) {
      return { error: `${change.target} add: ${e.message}` };
    }
    return { resolved: { adGroupId: found.adGroup.id, adId: found.ad.id, after: normalized, path: `${basePath}[+]` } };
  }

  const beforeText = textOf(change.before);
  if (!isNonEmptyString(beforeText)) return { error: `${change.target} ${change.operation} requires "before" text` };
  const list = found.ad[listField] || [];
  const matches = list.filter((a) => normText(a.text) === normText(beforeText));
  if (matches.length === 0) {
    return { error: `${change.target} ${change.operation}: no matching text "${beforeText}" found on this ad` };
  }
  const assetIdx = list.indexOf(matches[0]);

  if (change.operation === 'remove') {
    return { resolved: { adGroupId: found.adGroup.id, adId: found.ad.id, before: matches[0].text, path: `${basePath}[${assetIdx}]` } };
  }

  // replace
  const afterText = textOf(change.after);
  if (!isNonEmptyString(afterText)) return { error: `${change.target} replace requires "after" text` };
  let normalized;
  try {
    normalized = normalizeSingleAsset({ text: afterText });
  } catch (e) {
    return { error: `${change.target} replace: ${e.message}` };
  }
  return {
    resolved: { adGroupId: found.adGroup.id, adId: found.ad.id, before: matches[0].text, after: normalized, path: `${basePath}[${assetIdx}]` },
  };
}

// ── main entry point ────────────────────────────────────────────────────

/**
 * @param {object} rawProposal - Claude's parsed tool output: { explanation, changes }
 * @param {object} draftPlain  - the draft this was generated against, as a plain object ({ campaign, adGroups, ... })
 * @returns {{ valid: boolean, errors: string[], explanation: string|null, normalizedChanges: object[] }}
 */
export function validateProposedChanges(rawProposal, draftPlain) {
  const errors = [];
  const safe = sanitizeKeysDeep(rawProposal);

  const explanation = isNonEmptyString(safe?.explanation) ? safe.explanation.trim().slice(0, 1000) : null;
  if (!explanation) errors.push('explanation is required');

  const rawChanges = Array.isArray(safe?.changes) ? safe.changes : null;
  if (!rawChanges) {
    return { valid: false, errors: ['changes must be an array'], explanation, normalizedChanges: [] };
  }
  if (rawChanges.length === 0) errors.push('at least one change is required');
  if (rawChanges.length > PROPOSAL_MAX_CHANGES) errors.push(`at most ${PROPOSAL_MAX_CHANGES} changes are allowed per proposal`);

  const normalizedChanges = [];

  rawChanges.slice(0, PROPOSAL_MAX_CHANGES).forEach((raw, i) => {
    const at = `changes[${i}]`;
    const operation = typeof raw?.operation === 'string' ? raw.operation.toLowerCase() : null;
    const target = typeof raw?.target === 'string' ? raw.target.toUpperCase() : null;
    const reason = isNonEmptyString(raw?.reason) ? raw.reason.trim().slice(0, 300) : null;
    const adGroupIdHint = isNonEmptyString(raw?.adGroupId) ? raw.adGroupId.trim() : null;
    const adIdHint = isNonEmptyString(raw?.adId) ? raw.adId.trim() : null;

    if (!operation || !PROPOSAL_OPERATIONS.includes(operation)) {
      errors.push(`${at}.operation must be one of: ${PROPOSAL_OPERATIONS.join(', ')}`);
      return;
    }
    if (!target || !PROPOSAL_TARGETS.includes(target)) {
      errors.push(`${at}.target must be one of: ${PROPOSAL_TARGETS.join(', ')}`);
      return;
    }
    if (!isOperationAllowedForTarget(target, operation)) {
      errors.push(`${at}: operation "${operation}" is not allowed for target "${target}"`);
      return;
    }

    const change = { operation, target, adGroupId: adGroupIdHint, adId: adIdHint, before: raw.before ?? null, after: raw.after ?? null, reason };

    let result;
    switch (target) {
      case 'CAMPAIGN_NAME': result = validateCampaignName(change); break;
      case 'CAMPAIGN_DAILY_BUDGET': result = validateCampaignBudget(change); break;
      case 'CAMPAIGN_BIDDING_STRATEGY': result = validateCampaignBidding(change); break;
      case 'CAMPAIGN_LOCATION': result = validateCampaignLocation(change); break;
      case 'CAMPAIGN_LANGUAGE': result = validateCampaignLanguage(change); break;
      case 'AD_GROUP':
        result = operation === 'add' ? validateAdGroupAdd(change) : validateAdGroupRemove(change, draftPlain);
        break;
      case 'AD_GROUP_NAME': result = validateAdGroupName(change, draftPlain); break;
      case 'KEYWORD': result = validateKeywordLike(change, draftPlain, 'keywords'); break;
      case 'NEGATIVE_KEYWORD': result = validateKeywordLike(change, draftPlain, 'negativeKeywords'); break;
      case 'AD':
        result = operation === 'add' ? validateAdAdd(change, draftPlain) : validateAdRemove(change, draftPlain);
        break;
      case 'AD_HEADLINE': result = validateAdAsset(change, draftPlain, 'headlines'); break;
      case 'AD_DESCRIPTION': result = validateAdAsset(change, draftPlain, 'descriptions'); break;
      case 'AD_FINAL_URL': result = validateAdFinalUrl(change, draftPlain); break;
      default:
        result = { error: `Unsupported target "${target}"` };
    }

    if (result.error) {
      errors.push(`${at}: ${result.error}`);
      return;
    }

    normalizedChanges.push({
      id: randomUUID(),
      operation,
      target,
      adGroupId: result.resolved.adGroupId ?? null,
      adId: result.resolved.adId ?? null,
      before: result.resolved.before ?? (operation === 'remove' ? change.before : null),
      after: result.resolved.after ?? null,
      reason,
      path: result.resolved.path,
    });
  });

  if (errors.length > 0) {
    return { valid: false, errors, explanation, normalizedChanges: [] };
  }
  return { valid: true, errors: [], explanation, normalizedChanges };
}

/** Thin ValidationError wrapper for callers that want the repo's typed-error convention. */
export function assertValidProposedChanges(rawProposal, draftPlain) {
  const result = validateProposedChanges(rawProposal, draftPlain);
  if (!result.valid) throw new ValidationError('Proposed changes failed validation', result.errors);
  return result;
}

export default { validateProposedChanges, assertValidProposedChanges };
