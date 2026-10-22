/**
 * Structure rule (Phase 5) — the FIRST rule that runs (spec §49 order).
 *
 * Does not reimplement anything: it calls the existing Phase 1
 * campaignStructureValidator with every strictness flag Phase 5 needs
 * (requireAdGroups, strictRsa, requireLocation, runPolicy — the last two
 * added BY Phase 5, both opt-in and false everywhere else in the codebase)
 * and converts its plain string errors/warnings into typed Issue objects,
 * inferring a category from each message's own path prefix.
 *
 * This is the single source of truth for "is this campaign structurally
 * complete" — every other Phase 5 rule assumes this one already ran and
 * adds checks Phase 1's validator does not (and should not) know about:
 * account state, duplicates, policy phrasing quality summaries.
 */

import { validateCampaignDraftStructure } from '../../validator/campaignStructureValidator.js';
import { error, warning } from './issueHelpers.js';

/** Best-effort category from a Phase 1 validator message's own path prefix. */
function categorize(message) {
  if (message.startsWith('Potential policy concern')) return 'policy';
  if (/^campaign\.(name|objective)\b/.test(message) || message === 'campaign is required') return 'campaign';
  if (/^campaign\.(dailyBudget|currency)/.test(message)) return 'budget';
  if (/^campaign\.biddingStrategy/.test(message)) return 'bidding';
  if (/^campaign\.locations/.test(message)) return 'location';
  if (/^campaign\.languages/.test(message)) return 'language';
  if (/^campaign\.(sitelinks|callouts|structuredSnippets)\b/.test(message)) return 'assets';
  // finalUrl/path1/path2 are landing-page concerns even though they live
  // under `adGroups[i].ads[j]` — checked before the generic `.ads` bucket.
  if (/^adGroups\[\d+\]\.ads\[\d+\]\.(finalUrl|path1|path2)/.test(message)) return 'landing_page';
  if (/^adGroups\[\d+\]\.keywords/.test(message)) return 'keywords';
  if (/^adGroups\[\d+\]\.negativeKeywords/.test(message)) return 'negative_keywords';
  if (/^adGroups\[\d+\]\.ads/.test(message)) return 'ads';
  if (/^adGroups/.test(message) || message.includes('ad group')) return 'ad_groups';
  return 'structure';
}

/**
 * @param {object} draftPlain - { campaign, adGroups }
 * @returns {{ issues: object[], structurallyValid: boolean }}
 */
export function runStructureRule(draftPlain) {
  const result = validateCampaignDraftStructure(draftPlain, {
    requireAdGroups: true,
    strictRsa: true,
    requireLocation: true,
    runPolicy: true,
  });

  const issues = [
    ...result.errors.map((message) => error({
      code: 'STRUCTURE_ERROR',
      category: categorize(message),
      message,
      recommendation: 'Fix this in the campaign workspace, then re-run validation.',
    })),
    ...result.warnings.map((message) => warning({
      code: message.startsWith('Potential policy concern') ? 'POLICY_CONCERN' : 'STRUCTURE_WARNING',
      category: categorize(message),
      message,
      recommendation: message.startsWith('Potential policy concern')
        ? 'Review this claim for supporting evidence, or remove it, before publishing.'
        : null,
    })),
  ];

  return { issues, structurallyValid: result.valid };
}

export default { runStructureRule };
