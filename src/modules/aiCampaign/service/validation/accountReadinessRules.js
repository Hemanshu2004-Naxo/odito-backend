/**
 * Google Ads account readiness rule (Phase 5, spec §11/§12).
 *
 * The ONLY rule in this module that touches the database beyond the draft
 * itself (spec §8 — kept separate from the pure rules so tests for the rest
 * of the validator never need Mongo). Reuses the EXISTING Google Ads
 * connection model — no new OAuth, no new authorization, and critically:
 * this makes ZERO calls to the Google Ads API. It only reads Odito's own
 * already-persisted connection state (`GoogleConnection`), so it can never
 * mutate anything and never depends on Google's API being reachable.
 *
 * A live re-check against the real Google Ads API already exists —
 * `services/googleAdsService.js`'s `validateGoogleAdsAccountAccess` — and
 * is reachable through the existing POST .../google-ads/validate endpoint
 * if a user wants to double-check connectivity. Phase 5 deliberately does
 * NOT call it here: a pre-publish validation run must stay fast,
 * deterministic, and available even if Google's API is briefly degraded
 * (spec §13's landing-URL guidance — "avoid making validation dependent on
 * an external website being temporarily available" — applies just as much
 * to a third-party API as to a landing page).
 */

import GoogleConnection from '../../../app_user/model/GoogleConnection.js';
import { error, warning } from './issueHelpers.js';

const GOOGLE_ADS_PURPOSE = 'google_ads';

/**
 * @param {object} draftPlain - needs draftPlain.googleAdsCustomerId + campaign.currency
 * @param {object} ctx
 * @param {string} ctx.userId
 * @param {string} ctx.projectId
 * @returns {Promise<object[]>} issues
 */
export async function runAccountReadinessRule(draftPlain, { userId, projectId }) {
  const issues = [];

  const connection = await GoogleConnection.findActiveConnection(userId, projectId, GOOGLE_ADS_PURPOSE);

  if (!connection) {
    issues.push(error({
      code: 'GOOGLE_ADS_NOT_CONNECTED',
      category: 'google_ads',
      message: 'No active Google Ads connection for this project.',
      recommendation: 'Connect a Google Ads account on the Google Ads page before publishing.',
    }));
    return issues;
  }

  if (!connection.google_ads_customer_id) {
    issues.push(error({
      code: 'GOOGLE_ADS_NO_ACCOUNT_SELECTED',
      category: 'google_ads',
      message: 'Google Ads is connected, but no account has been selected for this project yet.',
      recommendation: 'Select a Google Ads account on the Google Ads page before publishing.',
    }));
    return issues;
  }

  if (connection.google_ads_customer_id !== draftPlain.googleAdsCustomerId) {
    issues.push(error({
      code: 'GOOGLE_ADS_ACCOUNT_MISMATCH',
      category: 'google_ads',
      message: 'The connected Google Ads account has changed since this campaign was drafted.',
      recommendation: 'Regenerate or update this draft so it targets the currently connected Google Ads account.',
    }));
  }

  if (connection.google_ads_currency_code && draftPlain?.campaign?.currency
      && connection.google_ads_currency_code !== draftPlain.campaign.currency) {
    issues.push(warning({
      code: 'GOOGLE_ADS_CURRENCY_MISMATCH',
      category: 'google_ads',
      message: `This campaign's currency (${draftPlain.campaign.currency}) does not match the connected account's billing currency (${connection.google_ads_currency_code}).`,
      recommendation: 'Update the campaign currency to match the connected Google Ads account before publishing.',
    }));
  }

  return issues;
}

export default { runAccountReadinessRule };
