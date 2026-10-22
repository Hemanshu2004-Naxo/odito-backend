/**
 * googleAdsOptimizationProvider — Phase 7. The ONLY file in this codebase
 * that issues a Google Ads mutation for an OPTIMIZATION action (pause/
 * enable a keyword or ad, add a negative keyword, update a campaign
 * budget). Sibling of Phase 6's providers/googleAdsPublishProvider.js — the
 * same reuse of the existing client/auth/retry/error infrastructure
 * (`buildCustomer`/`withGoogleAdsRetry`/`wrapGoogleAdsError`/
 * `classifyGoogleAdsError`, all from services/googleAdsService.js), the
 * same "one file owns this kind of mutation" boundary.
 *
 * Keyword/ad resource names are built DETERMINISTICALLY from the customer
 * id + Google's own ad_group_id/criterion_id/ad_id (already known from the
 * already-synced GoogleAdsKeyword/GoogleAdsAd rows — see
 * performanceDataService.js) via `ResourceNames`, exactly the same
 * well-known `customers/{id}/adGroupCriteria/{adGroupId}~{criterionId}` /
 * `.../adGroupAds/{adGroupId}~{adId}` format Google Ads always uses — no
 * extra lookup call needed. The campaign BUDGET resource name is the one
 * exception: Phase 6's own AiCampaignPublishAttempt already recorded it at
 * publish time, so campaignOptimizationService passes it straight through
 * rather than this file re-deriving or re-fetching it.
 */

import { enums, ResourceNames } from 'google-ads-api';
import {
  buildCustomer, ensureConnectionAlive, withGoogleAdsRetry, wrapGoogleAdsError,
} from '../../../services/googleAdsService.js';

export async function buildOptimizationCustomer(googleConnection, { customerId, loginCustomerId }) {
  await ensureConnectionAlive(googleConnection);
  return buildCustomer(googleConnection, { customerId, loginCustomerId });
}

/** Live re-read of one ad_group_criterion's (keyword's) current status — Layer 2 staleness check (spec §18). `customerId` is passed explicitly (never introspected off the Customer handle — that property isn't part of this library's public/documented surface). */
export async function readKeywordCurrentState(customer, { customerId, adGroupId, criterionId }) {
  if (!/^\d+$/.test(String(adGroupId)) || !/^\d+$/.test(String(criterionId))) {
    throw new Error('readKeywordCurrentState: adGroupId/criterionId must be numeric');
  }
  try {
    const rows = await withGoogleAdsRetry(
      () => customer.query(`SELECT ad_group_criterion.status FROM ad_group_criterion WHERE ad_group_criterion.ad_group = '${escapeGaql(ResourceNames.adGroup(customerId, adGroupId))}' AND ad_group_criterion.criterion_id = ${Number(criterionId)}`),
      'readKeywordCurrentState',
    );
    return rows?.[0]?.ad_group_criterion?.status || null;
  } catch (err) {
    throw wrapGoogleAdsError(err, 'readKeywordCurrentState', { adGroupId, criterionId });
  }
}

/** Live re-read of one ad's current status. */
export async function readAdCurrentState(customer, { customerId, adGroupId, adId }) {
  if (!/^\d+$/.test(String(adGroupId)) || !/^\d+$/.test(String(adId))) {
    throw new Error('readAdCurrentState: adGroupId/adId must be numeric');
  }
  try {
    const rows = await withGoogleAdsRetry(
      () => customer.query(`SELECT ad_group_ad.status FROM ad_group_ad WHERE ad_group_ad.ad_group = '${escapeGaql(ResourceNames.adGroup(customerId, adGroupId))}' AND ad_group_ad.ad.id = ${Number(adId)}`),
      'readAdCurrentState',
    );
    return rows?.[0]?.ad_group_ad?.status || null;
  } catch (err) {
    throw wrapGoogleAdsError(err, 'readAdCurrentState', { adGroupId, adId });
  }
}

/** Live re-read of a campaign budget's current amount_micros. */
export async function readCampaignBudgetCurrentState(customer, { campaignBudgetResourceName }) {
  try {
    const rows = await withGoogleAdsRetry(
      () => customer.query(`SELECT campaign_budget.amount_micros FROM campaign_budget WHERE campaign_budget.resource_name = '${escapeGaql(campaignBudgetResourceName)}'`),
      'readCampaignBudgetCurrentState',
    );
    return rows?.[0]?.campaign_budget?.amount_micros ?? null;
  } catch (err) {
    throw wrapGoogleAdsError(err, 'readCampaignBudgetCurrentState', { campaignBudgetResourceName });
  }
}

function escapeGaql(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

const STATUS_ENUM = {
  ENABLED: enums.AdGroupCriterionStatus?.ENABLED,
  PAUSED: enums.AdGroupCriterionStatus?.PAUSED,
};
const AD_STATUS_ENUM = {
  ENABLED: enums.AdGroupAdStatus?.ENABLED,
  PAUSED: enums.AdGroupAdStatus?.PAUSED,
};

export async function updateKeywordStatus(customer, { customerId, adGroupId, criterionId, status }) {
  const resourceName = ResourceNames.adGroupCriterion(customerId, adGroupId, criterionId);
  try {
    const response = await withGoogleAdsRetry(
      () => customer.adGroupCriteria.update([{ resource_name: resourceName, status: STATUS_ENUM[status] }]),
      'updateKeywordStatus',
    );
    return { resourceName: response?.results?.[0]?.resource_name || resourceName };
  } catch (err) {
    throw wrapGoogleAdsError(err, 'updateKeywordStatus', { adGroupId, criterionId, status });
  }
}

export async function createNegativeKeyword(customer, { customerId, adGroupId, text, matchType }) {
  try {
    const response = await withGoogleAdsRetry(
      () => customer.adGroupCriteria.create([{
        ad_group: ResourceNames.adGroup(customerId, adGroupId),
        negative: true,
        status: enums.AdGroupCriterionStatus.ENABLED,
        keyword: { text, match_type: enums.KeywordMatchType[matchType] },
      }]),
      'createNegativeKeyword',
    );
    return { resourceName: response?.results?.[0]?.resource_name || null };
  } catch (err) {
    throw wrapGoogleAdsError(err, 'createNegativeKeyword', { adGroupId, text });
  }
}

export async function updateAdStatus(customer, { customerId, adGroupId, adId, status }) {
  const resourceName = ResourceNames.adGroupAd(customerId, adGroupId, adId);
  try {
    const response = await withGoogleAdsRetry(
      () => customer.adGroupAds.update([{ resource_name: resourceName, status: AD_STATUS_ENUM[status] }]),
      'updateAdStatus',
    );
    return { resourceName: response?.results?.[0]?.resource_name || resourceName };
  } catch (err) {
    throw wrapGoogleAdsError(err, 'updateAdStatus', { adGroupId, adId, status });
  }
}

export async function updateCampaignBudget(customer, { campaignBudgetResourceName, amountMicros }) {
  try {
    const response = await withGoogleAdsRetry(
      () => customer.campaignBudgets.update([{ resource_name: campaignBudgetResourceName, amount_micros: amountMicros }]),
      'updateCampaignBudget',
    );
    return { resourceName: response?.results?.[0]?.resource_name || campaignBudgetResourceName };
  } catch (err) {
    throw wrapGoogleAdsError(err, 'updateCampaignBudget', { campaignBudgetResourceName, amountMicros });
  }
}

export default {
  buildOptimizationCustomer,
  readKeywordCurrentState,
  readAdCurrentState,
  readCampaignBudgetCurrentState,
  updateKeywordStatus,
  createNegativeKeyword,
  updateAdStatus,
  updateCampaignBudget,
};
