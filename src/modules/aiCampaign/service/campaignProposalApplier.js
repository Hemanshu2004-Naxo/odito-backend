/**
 * Change-proposal applier (Phase 4, spec §11 step 9 / §48 "Apply In Memory").
 *
 * Pure function: takes a draft snapshot (plain object) and a list of
 * ALREADY-VALIDATED, ALREADY-RESOLVED changes (from proposalValidator.js —
 * never raw Claude output) and returns a NEW `{ campaign, adGroups }` plain
 * object with every change applied. Does not touch MongoDB. Does not
 * re-validate (the caller, campaignProposalService, re-normalizes and
 * re-runs the strict structure validator on the result — spec §12).
 *
 * Each `target` is handled by hand-written, hardcoded logic — there is no
 * dynamic property access, no path parsing, no `eval`, and nothing from a
 * change is ever used as an object key (spec §7/§51/§52).
 */

function cloneCampaign(campaign) {
  const c = { ...campaign };
  // Always work from the major-unit `dailyBudget` from here on — Phase 1's
  // normalizeCampaignInput prefers `dailyBudgetMicros` when present, which
  // would silently ignore a CAMPAIGN_DAILY_BUDGET change if the stale
  // micros field were left on the object. Re-derived once here regardless
  // of whether this proposal touches the budget.
  if (c.dailyBudget == null && typeof c.dailyBudgetMicros === 'number') {
    c.dailyBudget = c.dailyBudgetMicros / 1_000_000;
  }
  delete c.dailyBudgetMicros;
  c.locations = Array.isArray(c.locations) ? c.locations.map((l) => ({ ...l })) : [];
  c.languages = Array.isArray(c.languages) ? c.languages.map((l) => ({ ...l })) : [];
  return c;
}

function cloneAdGroups(adGroups) {
  return (adGroups || []).map((ag) => ({
    ...ag,
    keywords: (ag.keywords || []).map((k) => ({ ...k })),
    negativeKeywords: (ag.negativeKeywords || []).map((k) => ({ ...k })),
    ads: (ag.ads || []).map((ad) => ({
      ...ad,
      headlines: (ad.headlines || []).map((h) => ({ ...h })),
      descriptions: (ad.descriptions || []).map((d) => ({ ...d })),
    })),
  }));
}

function mapAdGroup(adGroups, adGroupId, fn) {
  return adGroups.map((ag) => (ag.id === adGroupId ? fn(ag) : ag));
}
function mapAdInGroups(adGroups, adId, fn) {
  return adGroups.map((ag) => ({
    ...ag,
    ads: ag.ads.map((ad) => (ad.id === adId ? fn(ad) : ad)),
  }));
}
function removeByTextCI(list, text) {
  const target = (text || '').trim().toLowerCase();
  const idx = list.findIndex((item) => (item.text || '').trim().toLowerCase() === target);
  if (idx === -1) return list; // caller already proved this exists at validation time
  return [...list.slice(0, idx), ...list.slice(idx + 1)];
}
function replaceByTextCI(list, beforeText, afterAsset) {
  const target = (beforeText || '').trim().toLowerCase();
  const idx = list.findIndex((item) => (item.text || '').trim().toLowerCase() === target);
  if (idx === -1) return list;
  return [...list.slice(0, idx), afterAsset, ...list.slice(idx + 1)];
}

/**
 * @param {object} draftPlain     `{ campaign, adGroups }` (or a whole draft — extra fields are ignored)
 * @param {object[]} changes      normalizedChanges from proposalValidator.validateProposedChanges
 * @returns {{ campaign: object, adGroups: object[] }}
 */
export function applyProposedChanges(draftPlain, changes) {
  let campaign = cloneCampaign(draftPlain.campaign || {});
  let adGroups = cloneAdGroups(draftPlain.adGroups || []);

  for (const change of changes) {
    switch (change.target) {
      case 'CAMPAIGN_NAME':
        campaign = { ...campaign, name: change.after };
        break;

      case 'CAMPAIGN_DAILY_BUDGET':
        campaign = { ...campaign, dailyBudget: change.after };
        break;

      case 'CAMPAIGN_BIDDING_STRATEGY':
        campaign = { ...campaign, biddingStrategy: change.after };
        break;

      case 'CAMPAIGN_LOCATION':
        campaign = { ...campaign, locations: [change.after] };
        break;

      case 'CAMPAIGN_LANGUAGE':
        campaign = { ...campaign, languages: [change.after] };
        break;

      case 'AD_GROUP':
        adGroups = change.operation === 'add'
          ? [...adGroups, change.after]
          : adGroups.filter((ag) => ag.id !== change.adGroupId);
        break;

      case 'AD_GROUP_NAME':
        adGroups = mapAdGroup(adGroups, change.adGroupId, (ag) => ({ ...ag, name: change.after }));
        break;

      case 'KEYWORD':
        adGroups = mapAdGroup(adGroups, change.adGroupId, (ag) => ({
          ...ag,
          keywords: change.operation === 'add'
            ? [...ag.keywords, change.after]
            : removeByTextCI(ag.keywords, change.before.text),
        }));
        break;

      case 'NEGATIVE_KEYWORD':
        adGroups = mapAdGroup(adGroups, change.adGroupId, (ag) => ({
          ...ag,
          negativeKeywords: change.operation === 'add'
            ? [...ag.negativeKeywords, change.after]
            : removeByTextCI(ag.negativeKeywords, change.before.text),
        }));
        break;

      case 'AD':
        adGroups = mapAdGroup(adGroups, change.adGroupId, (ag) => ({
          ...ag,
          ads: change.operation === 'add'
            ? [...ag.ads, change.after]
            : ag.ads.filter((ad) => ad.id !== change.adId),
        }));
        break;

      case 'AD_HEADLINE':
        adGroups = mapAdInGroups(adGroups, change.adId, (ad) => ({
          ...ad,
          headlines:
            change.operation === 'add' ? [...ad.headlines, change.after]
            : change.operation === 'remove' ? removeByTextCI(ad.headlines, change.before)
            : replaceByTextCI(ad.headlines, change.before, change.after),
        }));
        break;

      case 'AD_DESCRIPTION':
        adGroups = mapAdInGroups(adGroups, change.adId, (ad) => ({
          ...ad,
          descriptions:
            change.operation === 'add' ? [...ad.descriptions, change.after]
            : change.operation === 'remove' ? removeByTextCI(ad.descriptions, change.before)
            : replaceByTextCI(ad.descriptions, change.before, change.after),
        }));
        break;

      case 'AD_FINAL_URL':
        adGroups = mapAdInGroups(adGroups, change.adId, (ad) => ({ ...ad, finalUrl: change.after }));
        break;

      default:
        // Unreachable — proposalValidator only ever emits known targets.
        throw new Error(`campaignProposalApplier: unknown target "${change.target}"`);
    }
  }

  return { campaign, adGroups };
}

export default { applyProposedChanges };
