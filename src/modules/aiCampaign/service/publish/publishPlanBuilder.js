/**
 * publishPlanBuilder — Phase 6 (spec §11-§14).
 *
 * Pure, deterministic, synchronous. Turns a trusted, already-Phase-1-through-5
 * -validated draft (plus a resolved Google Ads account + already-resolved
 * geo/language targeting — see targetingResolver.js) into a plan describing
 * exactly what to create in Google Ads and in what order. Builds NO GAQL,
 * makes NO network call, and never talks to Google Ads directly — that is
 * providers/googleAdsPublishProvider.js's job.
 *
 * "Deterministic-or-fail" (spec §12): every mapping either has one obvious,
 * correct answer, or this throws a `PublishPlanError` BEFORE returning a
 * plan — never a partial/best-guess plan. In particular:
 *   - TARGET_CPA / TARGET_ROAS bidding strategies are rejected: Odito's
 *     campaign schema (aiCampaignEnums.js) has never captured a numeric
 *     target CPA/ROAS value, so mapping either strategy to a real Google Ads
 *     campaign would require inventing a number Odito was never told. This
 *     is a genuine, documented mapping gap (spec §43) — not something Phase
 *     6 silently works around.
 *   - A campaign whose ad groups would collide on name, or whose keywords/
 *     negative keywords would collide on (text, matchType) WITHIN one ad
 *     group, is rejected. Phase 5 only WARNS about these (duplicateRules.js)
 *     because they are not invalid for an Odito draft — but Google Ads
 *     itself rejects a same-named ad group in one campaign and a duplicate
 *     (text, matchType) criterion in one ad group outright, so Phase 6 adds
 *     its own, additive, publish-only precondition rather than weakening
 *     Phase 5's severity.
 */

import { inspectFinalUrl } from '../../validator/campaignStructureValidator.js';

export class PublishPlanError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'PublishPlanError';
    this.type = 'PLAN_INVALID';
    this.details = details;
  }
}

const BIDDING_STRATEGY_FIELD = {
  MAXIMIZE_CONVERSIONS: 'maximize_conversions',
  MAXIMIZE_CONVERSION_VALUE: 'maximize_conversion_value',
  MAXIMIZE_CLICKS: 'target_spend',
};

/** @returns {{field: string, value: object}} the campaign-resource bidding oneof to set */
function mapBiddingStrategy(biddingStrategy) {
  const field = BIDDING_STRATEGY_FIELD[biddingStrategy];
  if (!field) {
    throw new PublishPlanError(
      `Bidding strategy "${biddingStrategy}" cannot be published automatically — it requires a numeric target this campaign never captured. Switch to Maximize Conversions, Maximize Conversion Value, or Maximize Clicks, or contact support.`,
      { biddingStrategy },
    );
  }
  return { field, value: {} };
}

const norm = (v) => String(v ?? '').trim().toLowerCase();

function assertNoDuplicates(items, keyFn, describe) {
  const seen = new Set();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    if (seen.has(key)) {
      throw new PublishPlanError(`${describe(item)} — Google Ads does not allow duplicates here. Fix this before publishing.`, { key });
    }
    seen.add(key);
  }
}

/**
 * @param {object} draft - plain object: { campaign, adGroups }
 * @param {object} account - { customerId, loginCustomerId }
 * @param {object} resolvedTargeting - { locations: [{resourceName}], languages: [{resourceName}] } from targetingResolver
 * @returns {object} the deterministic publish plan
 */
export function buildGoogleAdsPublishPlan(draft, account, resolvedTargeting) {
  const { campaign, adGroups } = draft;
  const { customerId, loginCustomerId = null } = account || {};

  if (!customerId || !/^\d+$/.test(String(customerId))) {
    throw new PublishPlanError('A valid numeric Google Ads customer id is required to build a publish plan.');
  }
  if (!campaign) {
    throw new PublishPlanError('campaign is required to build a publish plan.');
  }
  if (!Array.isArray(adGroups) || adGroups.length === 0) {
    throw new PublishPlanError('A campaign must have at least one ad group to publish.');
  }

  const micros = campaign.dailyBudgetMicros;
  if (!Number.isInteger(micros) || micros < 1) {
    throw new PublishPlanError('campaign.dailyBudgetMicros must be a positive integer.');
  }

  const bidding = mapBiddingStrategy(campaign.biddingStrategy);

  if (!resolvedTargeting?.locations?.length) {
    throw new PublishPlanError('At least one resolved target location is required to build a publish plan.');
  }

  assertNoDuplicates(adGroups, (ag) => norm(ag.name), (ag) => `Two ad groups are both named "${ag.name}"`);

  const planAdGroups = adGroups.map((ag) => {
    if (!Array.isArray(ag.keywords) || ag.keywords.length === 0) {
      throw new PublishPlanError(`Ad group "${ag.name}" has no keywords.`, { adGroupId: ag.id });
    }
    if (!Array.isArray(ag.ads) || ag.ads.length === 0) {
      throw new PublishPlanError(`Ad group "${ag.name}" has no ads.`, { adGroupId: ag.id });
    }
    assertNoDuplicates(
      ag.keywords,
      (k) => `${norm(k.text)}|${k.matchType}`,
      (k) => `Ad group "${ag.name}" has the duplicate keyword "${k.text}" (${k.matchType})`,
    );
    assertNoDuplicates(
      ag.negativeKeywords || [],
      (k) => `${norm(k.text)}|${k.matchType}`,
      (k) => `Ad group "${ag.name}" has the duplicate negative keyword "${k.text}"`,
    );

    for (const ad of ag.ads) {
      if (!ad.finalUrl) {
        throw new PublishPlanError(`An ad in ad group "${ag.name}" has no landing page URL.`, { adGroupId: ag.id, adId: ad.id });
      }
      if (!Array.isArray(ad.headlines) || ad.headlines.length < 3) {
        throw new PublishPlanError(`An ad in ad group "${ag.name}" needs at least 3 headlines.`, { adGroupId: ag.id, adId: ad.id });
      }
      if (!Array.isArray(ad.descriptions) || ad.descriptions.length < 2) {
        throw new PublishPlanError(`An ad in ad group "${ag.name}" needs at least 2 descriptions.`, { adGroupId: ag.id, adId: ad.id });
      }
    }

    return {
      oditoId: ag.id,
      name: ag.name,
      keywords: ag.keywords.map((k) => ({ text: k.text, matchType: k.matchType })),
      negativeKeywords: (ag.negativeKeywords || []).map((k) => ({ text: k.text, matchType: k.matchType || 'BROAD' })),
      ads: ag.ads.map((ad) => ({
        oditoId: ad.id,
        finalUrl: ad.finalUrl,
        path1: ad.path1 || null,
        path2: ad.path2 || null,
        headlines: ad.headlines.map((h) => ({ text: h.text, pinnedField: h.pinnedField || null })),
        descriptions: ad.descriptions.map((d) => ({ text: d.text, pinnedField: d.pinnedField || null })),
      })),
    };
  });

  const assets = buildCampaignAssetsPlan(campaign);

  return {
    customerId: String(customerId),
    loginCustomerId: loginCustomerId ? String(loginCustomerId) : null,
    budget: {
      name: `${campaign.name} Budget`,
      amountMicros: micros,
    },
    campaign: {
      name: campaign.name,
      biddingField: bidding.field,
      biddingValue: bidding.value,
    },
    targeting: {
      locations: resolvedTargeting.locations.map((l) => ({ resourceName: l.resourceName })),
      languages: (resolvedTargeting.languages || []).map((l) => ({ resourceName: l.resourceName })),
    },
    adGroups: planAdGroups,
    assets,
  };
}

/**
 * Campaign-level extension assets (sitelinks / callouts / structured
 * snippets — Phase 9, RSA/Ad-Strength quality work). All OPTIONAL: a
 * campaign with none of these is still a fully valid publish. But every
 * asset that IS present must be genuinely well-formed — spec §23 requires
 * re-running deterministic validation at publish time rather than trusting
 * whatever campaignGenerationService.js (or a later manual edit) already
 * wrote to the draft, so a corrupted/hand-edited asset fails the publish
 * loudly instead of silently reaching Google Ads incomplete or malformed.
 */
function buildCampaignAssetsPlan(campaign) {
  const sitelinks = Array.isArray(campaign.sitelinks) ? campaign.sitelinks : [];
  assertNoDuplicates(sitelinks, (sl) => norm(sl.text), (sl) => `Two sitelinks are both labeled "${sl.text}"`);
  assertNoDuplicates(sitelinks, (sl) => norm(sl.finalUrl), (sl) => `Two sitelinks both point at "${sl.finalUrl}"`);
  const planSitelinks = sitelinks.map((sl) => {
    if (!sl.text || !String(sl.text).trim()) {
      throw new PublishPlanError('A sitelink has no text.', { sitelinkId: sl.id });
    }
    if (!sl.finalUrl || !inspectFinalUrl(sl.finalUrl).ok) {
      throw new PublishPlanError(`Sitelink "${sl.text}" has no valid destination URL.`, { sitelinkId: sl.id });
    }
    return {
      oditoId: sl.id,
      text: sl.text,
      description1: sl.description1 || null,
      description2: sl.description2 || null,
      finalUrl: sl.finalUrl,
    };
  });

  const callouts = Array.isArray(campaign.callouts) ? campaign.callouts : [];
  assertNoDuplicates(callouts, (co) => norm(co.text), (co) => `Two callouts are both "${co.text}"`);
  const planCallouts = callouts.map((co) => {
    if (!co.text || !String(co.text).trim()) {
      throw new PublishPlanError('A callout has no text.', { calloutId: co.id });
    }
    return { oditoId: co.id, text: co.text };
  });

  const structuredSnippets = Array.isArray(campaign.structuredSnippets) ? campaign.structuredSnippets : [];
  assertNoDuplicates(structuredSnippets, (sn) => norm(sn.header), (sn) => `Two structured snippets both use the header "${sn.header}"`);
  const planStructuredSnippets = structuredSnippets.map((sn) => {
    if (!sn.header || !String(sn.header).trim()) {
      throw new PublishPlanError('A structured snippet has no header.', { structuredSnippetId: sn.id });
    }
    const values = (Array.isArray(sn.values) ? sn.values : []).map((v) => String(v || '').trim()).filter(Boolean);
    if (values.length === 0) {
      throw new PublishPlanError(`Structured snippet "${sn.header}" has no values.`, { structuredSnippetId: sn.id });
    }
    return { oditoId: sn.id, header: sn.header, values };
  });

  return { sitelinks: planSitelinks, callouts: planCallouts, structuredSnippets: planStructuredSnippets };
}

/** Rough, stable size counters — used for logging + the "bounded plan" scalability review (spec §33/§46). */
export function summarizePlan(plan) {
  const adGroupCount = plan.adGroups.length;
  const keywordCount = plan.adGroups.reduce((n, ag) => n + ag.keywords.length, 0);
  const negativeKeywordCount = plan.adGroups.reduce((n, ag) => n + ag.negativeKeywords.length, 0);
  const adCount = plan.adGroups.reduce((n, ag) => n + ag.ads.length, 0);
  const sitelinkCount = plan.assets?.sitelinks?.length || 0;
  const calloutCount = plan.assets?.callouts?.length || 0;
  const structuredSnippetCount = plan.assets?.structuredSnippets?.length || 0;
  return { adGroupCount, keywordCount, negativeKeywordCount, adCount, sitelinkCount, calloutCount, structuredSnippetCount };
}

export default { buildGoogleAdsPublishPlan, summarizePlan, PublishPlanError };
