/**
 * Content-completeness + informational rules (Phase 5).
 *
 * Fills a gap the Phase 1 structure validator deliberately leaves open: it
 * only checks the CROSS-relationship "keywords but no ads" in strict mode —
 * an ad group with BOTH zero keywords and zero ads (nothing wrong from
 * Phase 1's point of view — an empty group is not internally inconsistent)
 * is still useless at publish time, so Phase 5 catches it here as its own
 * rule rather than a third opt-in flag on the shared Phase 1 validator.
 *
 * Also emits INFO issues summarising the campaign (spec §5's example:
 * "Campaign contains 18 keywords") — never blocking, purely descriptive.
 */

import { error, info } from './issueHelpers.js';
import { formatBudgetMajorUnits } from './budgetRules.js';

export function runContentRule(draftPlain) {
  const issues = [];
  const adGroups = Array.isArray(draftPlain?.adGroups) ? draftPlain.adGroups : [];

  adGroups.forEach((ag, i) => {
    const hasKeywords = (ag.keywords || []).length > 0;
    const hasAds = (ag.ads || []).length > 0;
    if (!hasKeywords && !hasAds) {
      issues.push(error({
        code: 'EMPTY_AD_GROUP',
        category: 'ad_groups',
        path: `adGroups[${i}]`,
        message: `Ad group "${ag.name || `#${i + 1}`}" has no keywords and no ads.`,
        recommendation: 'Add at least one keyword and one ad, or remove this ad group.',
      }));
    }
  });

  const totalKeywords = adGroups.reduce((n, ag) => n + (ag.keywords?.length || 0), 0);
  const totalNegatives = adGroups.reduce((n, ag) => n + (ag.negativeKeywords?.length || 0), 0);
  const totalAds = adGroups.reduce((n, ag) => n + (ag.ads?.length || 0), 0);

  issues.push(info({
    code: 'CAMPAIGN_SUMMARY',
    category: 'structure',
    message: `Campaign contains ${adGroups.length} ad group${adGroups.length === 1 ? '' : 's'}, ${totalKeywords} keyword${totalKeywords === 1 ? '' : 's'}, ${totalNegatives} negative keyword${totalNegatives === 1 ? '' : 's'}, and ${totalAds} ad${totalAds === 1 ? '' : 's'}.`,
  }));

  if (draftPlain?.campaign) {
    issues.push(info({
      code: 'BUDGET_SUMMARY',
      category: 'budget',
      message: `Daily budget: ${formatBudgetMajorUnits(draftPlain.campaign)}.`,
    }));
  }

  // Sitelink/callout/structured-snippet coverage (Phase 9, RSA/Ad-Strength
  // quality work) — informational only, never blocking: these assets are
  // optional at the Google Ads API level, and Odito's own generation-time
  // quality gate (creativeQualityValidator.js) already governs whether a
  // FRESH AI generation is allowed to reach `ready` with too few of them; a
  // manually-edited or intentionally-trimmed draft is never re-litigated
  // here (same principle as headline/description counts above).
  const sitelinkCount = (draftPlain?.campaign?.sitelinks || []).length;
  const calloutCount = (draftPlain?.campaign?.callouts || []).length;
  const structuredSnippetCount = (draftPlain?.campaign?.structuredSnippets || []).length;
  issues.push(info({
    code: 'ASSET_SUMMARY',
    category: 'assets',
    message: `Campaign assets: ${sitelinkCount} sitelink${sitelinkCount === 1 ? '' : 's'}, ${calloutCount} callout${calloutCount === 1 ? '' : 's'}, ${structuredSnippetCount} structured snippet${structuredSnippetCount === 1 ? '' : 's'}.`,
  }));

  return issues;
}

export default { runContentRule };
