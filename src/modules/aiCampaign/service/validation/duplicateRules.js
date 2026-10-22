/**
 * Duplicate-content rule (Phase 5, spec §16). Case-insensitive,
 * whitespace-normalized comparison. Never blocks readiness on its own —
 * duplicates are wasteful, not invalid, so every finding is a WARNING.
 */

import { warning } from './issueHelpers.js';

const norm = (v) => (typeof v === 'string' ? v : v?.text || '').trim().toLowerCase();

function findDuplicateIndices(items, keyFn) {
  const seen = new Map();
  const dups = [];
  items.forEach((item, i) => {
    const key = keyFn(item);
    if (!key) return;
    if (seen.has(key)) dups.push({ index: i, firstIndex: seen.get(key), key });
    else seen.set(key, i);
  });
  return dups;
}

/**
 * @param {object} draftPlain - { campaign, adGroups }
 * @returns {object[]} issues
 */
export function runDuplicateRule(draftPlain) {
  const issues = [];
  const adGroups = Array.isArray(draftPlain?.adGroups) ? draftPlain.adGroups : [];
  const campaign = draftPlain?.campaign || {};

  // Duplicate ad group names across the whole campaign.
  for (const dup of findDuplicateIndices(adGroups, (ag) => norm(ag.name))) {
    issues.push(warning({
      code: 'DUPLICATE_AD_GROUP_NAME',
      category: 'ad_groups',
      path: `adGroups[${dup.index}].name`,
      message: `Ad group "${adGroups[dup.index].name}" has the same name as adGroups[${dup.firstIndex}].`,
      recommendation: 'Rename one of these ad groups so they are easy to tell apart in Google Ads.',
    }));
  }

  adGroups.forEach((ag, gi) => {
    for (const dup of findDuplicateIndices(ag.keywords || [], (k) => `${norm(k.text)}|${k.matchType}`)) {
      issues.push(warning({
        code: 'DUPLICATE_KEYWORD',
        category: 'keywords',
        path: `adGroups[${gi}].keywords[${dup.index}]`,
        message: `Duplicate keyword "${ag.keywords[dup.index].text}" (${ag.keywords[dup.index].matchType}) in ad group "${ag.name}".`,
        recommendation: 'Remove the duplicate keyword.',
      }));
    }
    for (const dup of findDuplicateIndices(ag.negativeKeywords || [], (k) => `${norm(k.text)}|${k.matchType}`)) {
      issues.push(warning({
        code: 'DUPLICATE_NEGATIVE_KEYWORD',
        category: 'negative_keywords',
        path: `adGroups[${gi}].negativeKeywords[${dup.index}]`,
        message: `Duplicate negative keyword "${ag.negativeKeywords[dup.index].text}" in ad group "${ag.name}".`,
        recommendation: 'Remove the duplicate negative keyword.',
      }));
    }

    (ag.ads || []).forEach((ad, ai) => {
      for (const dup of findDuplicateIndices(ad.headlines || [], norm)) {
        issues.push(warning({
          code: 'DUPLICATE_HEADLINE',
          category: 'ads',
          path: `adGroups[${gi}].ads[${ai}].headlines[${dup.index}]`,
          message: `Duplicate headline "${norm(ad.headlines[dup.index]) ? ad.headlines[dup.index].text : ''}" in this ad.`,
          recommendation: 'Vary this headline so Google Ads has more distinct combinations to test.',
        }));
      }
      for (const dup of findDuplicateIndices(ad.descriptions || [], norm)) {
        issues.push(warning({
          code: 'DUPLICATE_DESCRIPTION',
          category: 'ads',
          path: `adGroups[${gi}].ads[${ai}].descriptions[${dup.index}]`,
          message: `Duplicate description in this ad.`,
          recommendation: 'Vary this description so Google Ads has more distinct combinations to test.',
        }));
      }
    });
  });

  // Campaign-level extension assets (Phase 9, RSA/Ad-Strength quality work).
  const sitelinks = Array.isArray(campaign.sitelinks) ? campaign.sitelinks : [];
  for (const dup of findDuplicateIndices(sitelinks, (sl) => norm(sl.text))) {
    issues.push(warning({
      code: 'DUPLICATE_SITELINK',
      category: 'assets',
      path: `campaign.sitelinks[${dup.index}]`,
      message: `Sitelink "${sitelinks[dup.index].text}" has the same text as campaign.sitelinks[${dup.firstIndex}].`,
      recommendation: 'Give each sitelink a distinct label.',
    }));
  }

  const callouts = Array.isArray(campaign.callouts) ? campaign.callouts : [];
  for (const dup of findDuplicateIndices(callouts, (co) => norm(co.text))) {
    issues.push(warning({
      code: 'DUPLICATE_CALLOUT',
      category: 'assets',
      path: `campaign.callouts[${dup.index}]`,
      message: `Callout "${callouts[dup.index].text}" has the same text as campaign.callouts[${dup.firstIndex}].`,
      recommendation: 'Give each callout a distinct selling point.',
    }));
  }

  const structuredSnippets = Array.isArray(campaign.structuredSnippets) ? campaign.structuredSnippets : [];
  for (const dup of findDuplicateIndices(structuredSnippets, (sn) => norm(sn.header))) {
    issues.push(warning({
      code: 'DUPLICATE_STRUCTURED_SNIPPET_HEADER',
      category: 'assets',
      path: `campaign.structuredSnippets[${dup.index}]`,
      message: `Structured snippet header "${structuredSnippets[dup.index].header}" is used more than once.`,
      recommendation: 'Use each structured snippet header only once.',
    }));
  }
  structuredSnippets.forEach((sn, si) => {
    for (const dup of findDuplicateIndices(sn.values || [], (v) => (typeof v === 'string' ? v.trim().toLowerCase() : ''))) {
      issues.push(warning({
        code: 'DUPLICATE_STRUCTURED_SNIPPET_VALUE',
        category: 'assets',
        path: `campaign.structuredSnippets[${si}].values[${dup.index}]`,
        message: `Structured snippet "${sn.header}" has the duplicate value "${sn.values[dup.index]}".`,
        recommendation: 'Remove the duplicate value.',
      }));
    }
  });

  return issues;
}

export default { runDuplicateRule };
