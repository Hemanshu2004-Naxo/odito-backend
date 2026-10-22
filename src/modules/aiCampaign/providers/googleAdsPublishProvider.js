/**
 * googleAdsPublishProvider — Phase 6. The ONLY file in this codebase that
 * issues a Google Ads MUTATION call. Every other Phase 6 file either builds
 * data for this one to send (publishPlanBuilder.js, targetingResolver.js)
 * or persists what this one reports back (campaignPublishService.js).
 *
 * Reuses the EXISTING Google Ads client/auth/error infrastructure exactly —
 * `buildCustomer`/`withGoogleAdsRetry`/`wrapGoogleAdsError`/
 * `classifyGoogleAdsError` all come from services/googleAdsService.js
 * (exported for this reuse in Phase 6; see that file's header). No second
 * Google Ads client, no second OAuth flow, no second retry/backoff.
 *
 * DUPLICATE-SAFE BY CONSTRUCTION (spec §8/§18) at the two levels Google Ads
 * itself enforces a unique name on: before creating a CAMPAIGN or an
 * AD_GROUP, this always checks (by name) whether one already exists first —
 * on a first-ever publish this is one harmless extra read; on a retry after
 * an ambiguous network failure (we sent a create, never got a response) it
 * is what prevents a second, duplicate campaign/ad group from ever being
 * created. Keywords/negative keywords/ads are not globally unique in Google
 * Ads, so they are NOT re-checked by name — protected instead by the
 * publish-attempt's own persisted `resources[]` (campaignPublishService
 * never re-submits a resource it already recorded as created). A genuinely
 * ambiguous failure at the keyword/negative/ad level stops the whole
 * attempt (`partially_published`) rather than guessing — see
 * campaignPublishService.js's header for the full reconciliation policy.
 */

import { enums, ResourceNames } from 'google-ads-api';
import {
  buildCustomer,
  ensureConnectionAlive,
  withGoogleAdsRetry,
  wrapGoogleAdsError,
  classifyGoogleAdsError,
} from '../../../services/googleAdsService.js';
import { escapeGaqlStringLiteral } from '../service/publish/targetingResolver.js';

/** Build the Customer handle this whole publish attempt will use. Thin wrapper kept here so campaignPublishService never imports googleAdsService directly for mutation purposes. */
export async function buildPublishCustomer(googleConnection, { customerId, loginCustomerId }) {
  await ensureConnectionAlive(googleConnection);
  return buildCustomer(googleConnection, { customerId, loginCustomerId });
}

/**
 * True when a Google Ads call failed with NO usable diagnosis at all — no
 * Ads-specific `errors[]`, no HTTP response. This is `classifyGoogleAdsError`'s
 * own final fallback bucket (category 'unknown'); reused here, not
 * reimplemented, as the exact definition of "ambiguous" for this pipeline
 * (spec §18): Google may or may not have processed the mutation before the
 * connection was lost.
 */
export function isAmbiguousGoogleAdsFailure(err) {
  const classified = classifyGoogleAdsError(err);
  return classified.category === 'unknown';
}

async function findExistingResourceByQuery(customer, gaql, resultPath) {
  const rows = await withGoogleAdsRetry(() => customer.query(gaql), 'reconcileExistingResource');
  if (!rows || rows.length === 0) return null;
  if (rows.length > 1) return null; // ambiguous match — let the caller create/fail normally rather than guess
  return resultPath(rows[0]);
}

/** Look up an existing campaign by exact name (Google enforces campaign-name uniqueness per account). */
export async function findExistingCampaignByName(customer, name) {
  const gaql = `SELECT campaign.resource_name FROM campaign WHERE campaign.name = '${escapeGaqlStringLiteral(name)}' AND campaign.status != 'REMOVED' LIMIT 2`;
  return findExistingResourceByQuery(customer, gaql, (row) => row.campaign.resource_name);
}

/** Look up an existing ad group by exact name within one campaign (Google enforces ad-group-name uniqueness per campaign). */
export async function findExistingAdGroupByName(customer, campaignResourceName, name) {
  const gaql = `SELECT ad_group.resource_name FROM ad_group WHERE ad_group.campaign = '${escapeGaqlStringLiteral(campaignResourceName)}' AND ad_group.name = '${escapeGaqlStringLiteral(name)}' AND ad_group.status != 'REMOVED' LIMIT 2`;
  return findExistingResourceByQuery(customer, gaql, (row) => row.ad_group.resource_name);
}

/**
 * Step 1 (spec §14): campaign budget + campaign, created atomically in one
 * mutateResources batch (Google Ads' own cross-entity temp-resource-name
 * pattern — never two separate calls that could leave an orphaned budget).
 */
export async function createCampaignBudgetAndCampaign(customer, plan) {
  const tempBudgetName = ResourceNames.campaignBudget(plan.customerId, '-1');

  const operations = [
    {
      entity: 'campaign_budget',
      operation: 'create',
      resource: {
        resource_name: tempBudgetName,
        name: plan.budget.name,
        amount_micros: plan.budget.amountMicros,
        delivery_method: enums.BudgetDeliveryMethod.STANDARD,
        explicitly_shared: false,
      },
    },
    {
      entity: 'campaign',
      operation: 'create',
      resource: {
        name: plan.campaign.name,
        advertising_channel_type: enums.AdvertisingChannelType.SEARCH,
        status: enums.CampaignStatus.PAUSED, // never auto-enabled — spec §31/§32, no autonomous spend
        campaign_budget: tempBudgetName,
        [plan.campaign.biddingField]: plan.campaign.biddingValue,
        network_settings: {
          target_google_search: true,
          target_search_network: true,
          target_content_network: false,
          target_partner_search_network: false,
        },
        geo_target_type_setting: {
          positive_geo_target_type: enums.PositiveGeoTargetType.PRESENCE_OR_INTEREST,
        },
        // Google Ads now REQUIRES every newly created campaign to explicitly
        // self-declare EU political advertising status (FieldError.REQUIRED
        // on `campaign_operation.create.contains_eu_political_advertising`
        // otherwise). Odito's AI Campaign Builder has no concept of
        // political advertising anywhere in its brief/schema and Claude
        // never controls this field — every campaign Odito creates is
        // declared as NOT EU political advertising, server-side, always.
        contains_eu_political_advertising: enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
      },
    },
  ];

  try {
    const response = await withGoogleAdsRetry(() => customer.mutateResources(operations), 'createCampaignBudgetAndCampaign');
    const results = response?.mutate_operation_responses || [];
    const budgetResourceName = results[0]?.campaign_budget_result?.resource_name || tempBudgetName;
    const campaignResourceName = results[1]?.campaign_result?.resource_name;
    if (!campaignResourceName) {
      throw new Error('Google Ads did not return a campaign resource name.');
    }
    return { budgetResourceName, campaignResourceName };
  } catch (err) {
    throw wrapGoogleAdsError(err, 'createCampaignBudgetAndCampaign', { customerId: plan.customerId });
  }
}

/** Step 2: location + language campaign criteria, one batched call. */
export async function createCampaignCriteria(customer, campaignResourceName, plan) {
  const operations = [
    ...plan.targeting.locations.map((l) => ({ campaign: campaignResourceName, location: { geo_target_constant: l.resourceName } })),
    ...plan.targeting.languages.map((l) => ({ campaign: campaignResourceName, language: { language_constant: l.resourceName } })),
  ];
  if (operations.length === 0) return [];
  try {
    const response = await withGoogleAdsRetry(() => customer.campaignCriteria.create(operations), 'createCampaignCriteria');
    return (response?.results || []).map((r) => r.resource_name);
  } catch (err) {
    throw wrapGoogleAdsError(err, 'createCampaignCriteria', { campaignResourceName });
  }
}

/** Step 3: every ad group, one batched call. Returns [{oditoId, resourceName}] in input order. */
export async function createAdGroups(customer, campaignResourceName, plan) {
  const operations = plan.adGroups.map((ag) => ({
    name: ag.name,
    campaign: campaignResourceName,
    status: enums.AdGroupStatus.ENABLED,
    type: enums.AdGroupType.SEARCH_STANDARD,
  }));
  try {
    const response = await withGoogleAdsRetry(() => customer.adGroups.create(operations), 'createAdGroups');
    const results = response?.results || [];
    return plan.adGroups.map((ag, i) => ({ oditoId: ag.oditoId, resourceName: results[i]?.resource_name }));
  } catch (err) {
    throw wrapGoogleAdsError(err, 'createAdGroups', { campaignResourceName, count: operations.length });
  }
}

/**
 * Step 4: every keyword + negative keyword across every ad group, one
 * batched call. `adGroupResourceNameByOditoId` maps this draft's own ad
 * group ids to the real resource names Step 3 just created.
 * Returns [{ adGroupOditoId, key, isNegative, resourceName }].
 */
export async function createKeywordsAndNegatives(customer, adGroupResourceNameByOditoId, plan) {
  const items = [];
  const operations = [];
  for (const ag of plan.adGroups) {
    const adGroupResourceName = adGroupResourceNameByOditoId.get(ag.oditoId);
    for (const kw of ag.keywords) {
      items.push({ adGroupOditoId: ag.oditoId, key: `${kw.text}|${kw.matchType}`, isNegative: false });
      operations.push({
        ad_group: adGroupResourceName,
        status: enums.AdGroupCriterionStatus.ENABLED,
        keyword: { text: kw.text, match_type: enums.KeywordMatchType[kw.matchType] },
      });
    }
    for (const kw of ag.negativeKeywords) {
      items.push({ adGroupOditoId: ag.oditoId, key: `${kw.text}|${kw.matchType}`, isNegative: true });
      operations.push({
        ad_group: adGroupResourceName,
        negative: true,
        keyword: { text: kw.text, match_type: enums.KeywordMatchType[kw.matchType] },
      });
    }
  }
  if (operations.length === 0) return [];
  try {
    const response = await withGoogleAdsRetry(() => customer.adGroupCriteria.create(operations), 'createKeywordsAndNegatives');
    const results = response?.results || [];
    return items.map((item, i) => ({ ...item, resourceName: results[i]?.resource_name }));
  } catch (err) {
    throw wrapGoogleAdsError(err, 'createKeywordsAndNegatives', { count: operations.length });
  }
}

/**
 * Step 5: every Responsive Search Ad across every ad group, one batched
 * call. Returns [{ adGroupOditoId, oditoId, resourceName }].
 */
export async function createAds(customer, adGroupResourceNameByOditoId, plan) {
  const items = [];
  const operations = [];
  for (const ag of plan.adGroups) {
    const adGroupResourceName = adGroupResourceNameByOditoId.get(ag.oditoId);
    for (const ad of ag.ads) {
      items.push({ adGroupOditoId: ag.oditoId, oditoId: ad.oditoId });
      operations.push({
        ad_group: adGroupResourceName,
        status: enums.AdGroupAdStatus.PAUSED, // matches the campaign's own PAUSED default — spec §31/§32
        ad: {
          final_urls: [ad.finalUrl],
          responsive_search_ad: {
            headlines: ad.headlines.map((h) => ({ text: h.text, ...(h.pinnedField ? { pinned_field: h.pinnedField } : {}) })),
            descriptions: ad.descriptions.map((d) => ({ text: d.text, ...(d.pinnedField ? { pinned_field: d.pinnedField } : {}) })),
            ...(ad.path1 ? { path1: ad.path1 } : {}),
            ...(ad.path2 ? { path2: ad.path2 } : {}),
          },
        },
      });
    }
  }
  if (operations.length === 0) return [];
  try {
    const response = await withGoogleAdsRetry(() => customer.adGroupAds.create(operations), 'createAds');
    const results = response?.results || [];
    return items.map((item, i) => ({ ...item, resourceName: results[i]?.resource_name }));
  } catch (err) {
    throw wrapGoogleAdsError(err, 'createAds', { count: operations.length });
  }
}

/**
 * Step 6 (spec §17-19, Phase 9 RSA/Ad-Strength quality work): campaign-level
 * extension assets — sitelinks, callouts, structured snippets. Every asset
 * (`entity: 'asset'`) is created AND linked to the campaign
 * (`entity: 'campaign_asset'`, `field_type` per AssetFieldTypeEnum) in ONE
 * atomic mutateResources batch, the same cross-entity temp-resource-name
 * pattern createCampaignBudgetAndCampaign already uses — never a create call
 * whose link could fail separately and leave an orphaned, unlinked asset.
 * All-optional: a campaign with none of these still publishes normally.
 *
 * Google requires a sitelink's description1/description2 to be both-set or
 * both-absent (asset_types.proto) — enforced here, not upstream, since it is
 * a Google Ads wire-format constraint, not an Odito shape rule.
 */
export async function createCampaignAssets(customer, campaignResourceName, plan) {
  const { sitelinks = [], callouts = [], structuredSnippets = [] } = plan.assets || {};
  if (sitelinks.length === 0 && callouts.length === 0 && structuredSnippets.length === 0) return [];

  const items = []; // { oditoId, assetType, tempResourceName }
  const operations = [];
  let tempId = -1;

  const addAssetPair = (oditoId, assetType, assetResourceFields, fieldType) => {
    const tempResourceName = ResourceNames.asset(plan.customerId, String(tempId));
    tempId -= 1;
    items.push({ oditoId, assetType, tempResourceName });
    operations.push({
      entity: 'asset',
      operation: 'create',
      resource: { resource_name: tempResourceName, ...assetResourceFields },
    });
    operations.push({
      entity: 'campaign_asset',
      operation: 'create',
      resource: { campaign: campaignResourceName, asset: tempResourceName, field_type: fieldType },
    });
  };

  for (const sl of sitelinks) {
    const sitelink_asset = { link_text: sl.text };
    if (sl.description1 && sl.description2) {
      sitelink_asset.description1 = sl.description1;
      sitelink_asset.description2 = sl.description2;
    }
    addAssetPair(sl.oditoId, 'SITELINK', { final_urls: [sl.finalUrl], sitelink_asset }, enums.AssetFieldType.SITELINK);
  }
  for (const co of callouts) {
    addAssetPair(co.oditoId, 'CALLOUT', { callout_asset: { callout_text: co.text } }, enums.AssetFieldType.CALLOUT);
  }
  for (const sn of structuredSnippets) {
    addAssetPair(
      sn.oditoId,
      'STRUCTURED_SNIPPET',
      { structured_snippet_asset: { header: sn.header, values: sn.values } },
      enums.AssetFieldType.STRUCTURED_SNIPPET,
    );
  }

  try {
    const response = await withGoogleAdsRetry(() => customer.mutateResources(operations), 'createCampaignAssets');
    const results = response?.mutate_operation_responses || [];
    // Operations (and therefore results) alternate [asset, campaign_asset, asset, campaign_asset, ...] in push order.
    return items.map((item, i) => {
      const assetResult = results[i * 2]?.asset_result;
      const campaignAssetResult = results[i * 2 + 1]?.campaign_asset_result;
      return {
        oditoId: item.oditoId,
        assetType: item.assetType,
        assetResourceName: assetResult?.resource_name || item.tempResourceName,
        campaignAssetResourceName: campaignAssetResult?.resource_name || null,
      };
    });
  } catch (err) {
    throw wrapGoogleAdsError(err, 'createCampaignAssets', { campaignResourceName, count: operations.length });
  }
}

export default {
  buildPublishCustomer,
  isAmbiguousGoogleAdsFailure,
  findExistingCampaignByName,
  findExistingAdGroupByName,
  createCampaignBudgetAndCampaign,
  createCampaignCriteria,
  createAdGroups,
  createKeywordsAndNegatives,
  createAds,
  createCampaignAssets,
};
