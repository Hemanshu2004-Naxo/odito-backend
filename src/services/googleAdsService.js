import { GoogleAdsApi, enums as googleAdsEnums } from 'google-ads-api';
import { getValidAccessToken } from './googleApiService.js';
import {
  getCacheKey,
  getCachedData,
  setCachedData,
  clearCacheEntries,
  withRetry
} from './businessProfileService.js';
import { LoggerUtil } from '../utils/LoggerUtil.js';
import { ErrorUtil } from '../utils/ErrorUtil.js';

/**
 * Google Ads API Service
 *
 * Foundation layer for the Google Ads integration (Phase 6.2). Reuses every
 * cross-product Google primitive that already exists rather than
 * reintroducing them:
 * - Token refresh/expiry: googleApiService.getValidAccessToken (same helper
 *   GA/GSC/GBP already call).
 * - Caching: the shared in-memory Map + TTL primitives defined in
 *   businessProfileService.js (getCacheKey/getCachedData/setCachedData/
 *   clearCacheEntries) - the same Map every other Google service already
 *   writes into, just with an `ads_` key prefix so entries never collide.
 * - Retry: businessProfileService.withRetry, unmodified - see
 *   withGoogleAdsRetry() below for how a differently-shaped Google Ads
 *   error is taught to trigger it without a second backoff implementation.
 *
 * One real difference from GA/GSC/GBP: those call Google's REST APIs
 * directly via axios + getAuthenticatedHttpClient(). Google Ads has no such
 * hand-rollable option here - Google does not publish an official Node.js
 * client for this API (only Java/.NET/PHP/Python/Ruby/Perl), so this file
 * uses `google-ads-api` (the de-facto standard community client, ~unofficial
 * but what production Node apps use for this API) rather than manually
 * constructing GAQL/REST calls by hand. That library owns its own OAuth2
 * token exchange internally (it accepts a refresh_token, not a pre-fetched
 * access token) - see ensureConnectionAlive()'s doc comment for how this
 * file still routes every call through the existing token-refresh flow
 * first, even though the Ads client re-derives its own access token per call.
 */

const SERVICE = 'GoogleAds';

// GOOGLE_ADS_DEVELOPER_TOKEN's presence is validated once, at boot, by the
// centralized src/config/env.js (validateEnvironment's `recommended` list,
// logged via logConfiguration) - the same pattern every other optional
// third-party integration (Stripe/Resend/Anthropic) uses. Not re-checked
// here at import time; a second, duplicate boot-time check would drift from
// that one over time. getGoogleAdsClient() below still guards at call time
// (env.js's check is warn-only, not fail-fast, so the process keeps running
// without it) and throws a typed, clearly-worded error the controller layer
// already knows how to turn into a clean 503 - see respondWithGoogleAdsError
// in googleAdsController.js.

// ─────────────────────────────────────────────────────────────────────────
// Client construction
// ─────────────────────────────────────────────────────────────────────────

let _client = null;

/** Singleton GoogleAdsApi client - holds only app-level credentials (client
 * id/secret/developer token), never anything per-user. Per-connection state
 * (refresh_token, customer_id) is supplied per call via buildCustomer(). */
export function getGoogleAdsClient() {
  if (_client) return _client;

  if (!process.env.GOOGLE_ADS_DEVELOPER_TOKEN) {
    // 503, not 500: this is a known, diagnosed configuration gap (see
    // src/config/env.js's boot-time warning), not an unexpected internal
    // failure - ErrorUtil.unavailable() is the typed error this codebase
    // already uses for exactly that distinction (see ErrorUtil.js).
    throw ErrorUtil.unavailable('Google Ads is not configured: GOOGLE_ADS_DEVELOPER_TOKEN is missing. Obtain a Developer Token from the Google Ads API Center and set it in the environment.');
  }

  _client = new GoogleAdsApi({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN
  });

  return _client;
}

/**
 * Build a Customer handle for one Google Ads API call. `googleConnection`
 * must be the `purpose: 'google_ads'` GoogleConnection document -
 * `.refresh_token` here reads through the same Mongoose getter/decryptToken
 * pair every other Google integration relies on (see GoogleConnection.js).
 */
export function buildCustomer(googleConnection, { customerId, loginCustomerId } = {}) {
  const client = getGoogleAdsClient();
  return client.Customer({
    customer_id: customerId,
    login_customer_id: loginCustomerId || undefined,
    refresh_token: googleConnection.refresh_token
  });
}

/**
 * Decodes a Google Ads enum field to its readable string name.
 *
 * Bug fix (found while building Phase 6.3's normalization layer, applies
 * retroactively to every enum field this file already returned in Phase
 * 6.2): `google-ads-api` decodes REST responses through its own
 * `enums.<EnumName>` lookup tables, which are bidirectional
 * (`enums.CampaignStatus.ENABLED === 2` AND `enums.CampaignStatus[2] ===
 * 'ENABLED'`) - and the library's own response parser resolves every enum
 * field to the NUMBER, not the string name (verified directly against the
 * installed package: `decamelizeKeys({campaign:{status:'ENABLED'}})`
 * returns `{campaign:{status: 2}}`). Every "status"/"channel type"/etc.
 * value this file hands to a controller or to googleAdsSyncService must be
 * decoded back to its name through this helper - Mongoose's `status` enum
 * validators on GoogleAdsCampaign would otherwise reject every write.
 */
function decodeEnum(enumName, value) {
  if (value === null || value === undefined) return null;
  const table = googleAdsEnums[enumName];
  const decoded = table ? table[value] : undefined;
  return decoded !== undefined ? decoded : String(value);
}

/**
 * Normalizes one `FROM campaign` row (with the extended field set - status,
 * serving status, channel type/sub-type, bidding strategy, dates,
 * optimization score, full budget) into a single shape shared by
 * getGoogleAdsCampaignMetadata (a single campaign, live) and
 * getGoogleAdsCampaignsForSync (every campaign, for persistence) - one
 * mapping implementation instead of two copies that could drift apart.
 */
/**
 * v24 removed the plain-date `campaign.start_date`/`campaign.end_date` fields
 * (confirmed against the installed google-ads-node@24 proto: resources/campaign.proto
 * no longer declares them, only `start_date_time`/`end_date_time` - a
 * `"yyyy-MM-dd HH:mm:ss"` datetime string, not a bare date) - querying the old
 * field names now fails server-side with `UNRECOGNIZED_FIELD`. Slicing to the
 * first 10 characters recovers the same `YYYY-MM-DD` shape the
 * GoogleAdsCampaign.start_date/end_date schema fields and bulkUpsertCampaigns
 * already store (both explicitly documented/typed as a plain date string) -
 * so this is a query-level fix only, no DB schema or downstream consumer
 * needs to change.
 */
function extractDateOnly(dateTimeStr) {
  return typeof dateTimeStr === 'string' && dateTimeStr.length >= 10
    ? dateTimeStr.slice(0, 10)
    : null;
}

function mapCampaignRow(row) {
  return {
    campaignId: String(row.campaign.id),
    name: row.campaign.name,
    status: decodeEnum('CampaignStatus', row.campaign.status),
    servingStatus: decodeEnum('CampaignServingStatus', row.campaign.serving_status),
    channelType: decodeEnum('AdvertisingChannelType', row.campaign.advertising_channel_type),
    channelSubType: decodeEnum('AdvertisingChannelSubType', row.campaign.advertising_channel_sub_type),
    biddingStrategyType: decodeEnum('BiddingStrategyType', row.campaign.bidding_strategy_type),
    startDate: extractDateOnly(row.campaign.start_date_time),
    endDate: extractDateOnly(row.campaign.end_date_time),
    optimizationScore: typeof row.campaign.optimization_score === 'number' ? row.campaign.optimization_score : null,
    budget: {
      id: row.campaign_budget?.id != null ? String(row.campaign_budget.id) : null,
      amountMicros: row.campaign_budget?.amount_micros ?? null,
      amount: row.campaign_budget?.amount_micros != null
        ? Number(row.campaign_budget.amount_micros) / 1_000_000
        : null,
      deliveryMethod: decodeEnum('BudgetDeliveryMethod', row.campaign_budget?.delivery_method),
      period: decodeEnum('BudgetPeriod', row.campaign_budget?.period)
    }
  };
}

/**
 * Proactively validates/refreshes the connection's access token through the
 * exact same shared flow GA/GSC/GBP use (5-minute expiry buffer, persists a
 * refreshed token, marks the connection 'expired' on failure) before any
 * Google Ads call. The google-ads-api client does its own internal token
 * exchange from refresh_token per request (it has no hook to accept a
 * pre-fetched access token), so this call's *return value* is unused here -
 * it's invoked purely for its side effects, so a dead refresh_token is
 * caught with the same error semantics and the same GoogleConnection.status
 * bookkeeping as every other Google product, instead of only surfacing deep
 * inside a Google Ads-specific error shape.
 */
export async function ensureConnectionAlive(googleConnection) {
  await getValidAccessToken(googleConnection);
}

// ─────────────────────────────────────────────────────────────────────────
// Error classification
// ─────────────────────────────────────────────────────────────────────────

/**
 * Normalizes a Google Ads API failure into { category, httpStatus, message,
 * retryable }. Google Ads errors are NOT shaped like the axios errors
 * withRetry/logAxiosError were built for - a rejected call usually throws an
 * `errors.GoogleAdsFailure` (an `errors[]` array of `{ error_code, message }`,
 * where `error_code` is a oneof carrying exactly one populated key such as
 * `authentication_error` / `authorization_error` / `quota_error` /
 * `internal_error` / `customer_not_enabled_error`) rather than an HTTP status.
 * Classified by matching on that populated key's own name (Google names
 * these ~100 oneof fields descriptively and consistently), with an HTTP
 * status fallback for failures that never made it that deep (a rejected
 * developer token or a disabled Ads API surfaces as a plain 401/403 before
 * Google ever returns Ads-specific diagnostics).
 */
export function classifyGoogleAdsError(error) {
  const adsErrors = error?.errors;

  if (Array.isArray(adsErrors) && adsErrors.length > 0) {
    const first = adsErrors[0];
    const code = first?.error_code || {};
    const message = first?.message || error.message || 'Google Ads API error';
    const codeKey = Object.keys(code).find((k) => code[k] !== undefined && code[k] !== null && code[k] !== 0);

    const category = categorizeErrorCodeKey(codeKey);
    return {
      category,
      httpStatus: CATEGORY_HTTP_STATUS[category],
      message,
      retryable: category === 'quota' || category === 'internal',
      detail: codeKey ? { [codeKey]: code[codeKey] } : code
    };
  }

  const status = error?.response?.status;
  if (status === 401) {
    return { category: 'authentication', httpStatus: 401, message: 'Google authentication failed - please reconnect Google Ads.', retryable: false };
  }
  if (status === 403) {
    return { category: 'authorization', httpStatus: 403, message: 'Access denied by Google Ads. Verify the developer token and that the Google Ads API is enabled.', retryable: false };
  }
  if (status === 429) {
    return { category: 'quota', httpStatus: 429, message: 'Google Ads API quota exceeded. Please try again shortly.', retryable: true };
  }
  if (status >= 500) {
    return { category: 'internal', httpStatus: 502, message: 'Google Ads API is temporarily unavailable.', retryable: true };
  }

  return { category: 'unknown', httpStatus: 500, message: error?.message || 'Unknown Google Ads error', retryable: false };
}

const CATEGORY_HTTP_STATUS = {
  authentication: 401,
  authorization: 403,
  quota: 429,
  internal: 502,
  invalid_customer: 400,
  invalid_request: 400,
  ads_api_error: 400,
  unknown: 500
};

function categorizeErrorCodeKey(key) {
  if (!key) return 'ads_api_error';
  if (key.includes('authentication')) return 'authentication';
  if (key.includes('authorization') || key.includes('manager') || key.includes('billing') || key.includes('access_invitation')) return 'authorization';
  if (key.includes('quota') || key.includes('resource_exhausted') || key.includes('rate')) return 'quota';
  if (key.includes('internal') || key.includes('transient')) return 'internal';
  if (key.includes('customer')) return 'invalid_customer';
  if (key.includes('request') || key.includes('query') || key.includes('field')) return 'invalid_request';
  return 'ads_api_error';
}

/**
 * Routes a Google Ads call through the existing withRetry (1s/2s/4s
 * exponential backoff, businessProfileService.js) without reimplementing
 * backoff logic. withRetry only recognizes axios-shaped errors
 * (`err.response.status` 429/5xx) - retryable Google Ads failures (quota,
 * internal/transient) are given a synthetic `.response.status` so withRetry
 * retries them exactly as it already does for every other Google product;
 * everything else (auth/permission/invalid-request) is left alone so
 * withRetry rethrows immediately instead of wasting attempts on a
 * deterministic failure.
 */
export async function withGoogleAdsRetry(fn, context) {
  return withRetry(async () => {
    try {
      return await fn();
    } catch (err) {
      const classified = classifyGoogleAdsError(err);
      if (classified.retryable && !err.response) {
        err.response = { status: classified.httpStatus === 429 ? 429 : 500 };
      }
      LoggerUtil.warn(`${SERVICE}: ${context} attempt failed`, {
        category: classified.category,
        message: classified.message,
        retryable: classified.retryable
      });
      throw err;
    }
  });
}

/** Wraps a failure from the functions below into a plain Error carrying
 * .category/.httpStatus/.response, mirroring validateBusinessProfileAccess's
 * "preserve the real diagnostics on a rethrown error" pattern. */
export function wrapGoogleAdsError(err, context, extra = {}) {
  if (err?.type && err?.statusCode) {
    // Already a typed ErrorUtil error (e.g. a validation failure raised
    // before any Google call was made) - pass it through unchanged.
    return err;
  }
  const classified = classifyGoogleAdsError(err);
  LoggerUtil.error(`${SERVICE}: ${context} failed`, err, { ...extra, category: classified.category });
  const wrapped = new Error(classified.message);
  wrapped.category = classified.category;
  wrapped.httpStatus = classified.httpStatus;
  wrapped.response = err?.response;
  return wrapped;
}

// ─────────────────────────────────────────────────────────────────────────
// Account discovery + selection
// ─────────────────────────────────────────────────────────────────────────

/**
 * Extracts the `resource_names` array out of a raw ListAccessibleCustomersResponse.
 *
 * Root cause of the historical `(resourceNames || []).map is not a function`
 * crash: `client.listAccessibleCustomers()` does NOT resolve to the array of
 * customer resource names directly - it resolves to the response *envelope*
 * `{ resource_names: string[] }` (confirmed against the installed
 * google-ads-api@24.1.0 / google-ads-node's compiled protobufjs message -
 * the field is genuinely `resource_names`, snake_case, not `resourceNames`;
 * `google-ads-api`'s client.js even destructures this same call's grpc
 * tuple with a `@ts-expect-error Type definition is incorrect` comment of
 * its own). A prior version of this function assigned that whole envelope
 * to a variable named `resourceNames` and called `.map()` on it directly -
 * the envelope is a plain object, not an array, so `.map` was never a
 * function. This is the one and only place in this file that consumes a
 * raw gax/protobuf response envelope; every other Google Ads call in this
 * file goes through `customer.query()` / `customer.report()`, which the
 * installed library's own source (customer.js `query()`/`search()`)
 * guarantees always resolves to a plain, already-unwrapped array - so no
 * equivalent unwrapping is needed anywhere else.
 *
 * Throws rather than silently defaulting to `[]` on a genuinely malformed
 * shape (Google Ads response format changed, envelope corrupted, etc.) -
 * silently coercing bad data to an empty account list would surface as a
 * confusing "you have zero Google Ads accounts" to the user instead of the
 * real, diagnosable integration failure. An entirely absent field (an
 * account with zero accessible customers legitimately omits it rather than
 * sending `[]`) is not an error and resolves to `[]`.
 */
function extractAccessibleCustomerResourceNames(listAccessibleCustomersResponse) {
  const resourceNames = listAccessibleCustomersResponse?.resource_names;

  if (resourceNames === undefined || resourceNames === null) {
    return [];
  }
  if (!Array.isArray(resourceNames)) {
    throw ErrorUtil.internal(
      `Google Ads listAccessibleCustomers returned an unexpected response shape ` +
      `(resource_names was ${typeof resourceNames}, not an array). This usually means ` +
      `the google-ads-api package version changed its response format.`
    );
  }
  return resourceNames;
}

/**
 * Full accessible-accounts flow for the account picker: lists every
 * customer directly accessible to this connection's refresh token, and for
 * any that is a manager (MCC), expands its direct child accounts in the
 * same pass - the frontend receives one flat, selectable list rather than
 * having to walk the hierarchy itself. Deliberately does not recurse into
 * nested sub-managers (children-of-children) in this phase: unbounded
 * recursion here is exactly the kind of fan-out that trips Google Ads'
 * quota limits, and no UI in this phase needs more than one level.
 *
 * @param {Object} googleConnection - the `purpose: 'google_ads'` GoogleConnection
 * @returns {Promise<Array<{customerId, name, isManager, loginCustomerId, status, currencyCode, timeZone}>>}
 */
export async function getGoogleAdsAccessibleAccounts(googleConnection) {
  const cacheKey = getCacheKey('ads_accounts', googleConnection._id);
  const cached = getCachedData(cacheKey);
  if (cached) return cached;

  await ensureConnectionAlive(googleConnection);

  const client = getGoogleAdsClient();
  let listResponse;
  try {
    listResponse = await withGoogleAdsRetry(
      () => client.listAccessibleCustomers(googleConnection.refresh_token),
      'listAccessibleCustomers'
    );
  } catch (err) {
    throw wrapGoogleAdsError(err, 'listAccessibleCustomers', { connectionId: googleConnection._id.toString() });
  }

  const resourceNames = extractAccessibleCustomerResourceNames(listResponse);
  const topLevelIds = resourceNames.map((rn) => rn.replace('customers/', ''));
  LoggerUtil.service(SERVICE, 'listAccessibleCustomers', 'completed', { count: topLevelIds.length });

  const accounts = [];

  for (const customerId of topLevelIds) {
    try {
      const customer = buildCustomer(googleConnection, { customerId, loginCustomerId: customerId });
      const rows = await withGoogleAdsRetry(
        () => customer.query(`
          SELECT
            customer_client.client_customer,
            customer_client.descriptive_name,
            customer_client.manager,
            customer_client.level,
            customer_client.status,
            customer_client.currency_code,
            customer_client.time_zone
          FROM customer_client
          WHERE customer_client.level <= 1
        `),
        `customerClient:${customerId}`
      );

      const self = rows.find((r) => r.customer_client?.level === 0);

      if (self?.customer_client?.manager) {
        for (const row of rows) {
          const cc = row.customer_client;
          if (cc.level === 0 || cc.manager) continue; // skip the manager row itself + nested sub-managers
          accounts.push({
            customerId: (cc.client_customer || '').replace('customers/', ''),
            name: cc.descriptive_name || null,
            isManager: false,
            loginCustomerId: customerId,
            status: decodeEnum('CustomerStatus', cc.status),
            currencyCode: cc.currency_code || null,
            timeZone: cc.time_zone || null
          });
        }
      } else if (self) {
        accounts.push({
          customerId,
          name: self.customer_client.descriptive_name || null,
          isManager: false,
          loginCustomerId: null,
          status: decodeEnum('CustomerStatus', self.customer_client.status),
          currencyCode: self.customer_client.currency_code || null,
          timeZone: self.customer_client.time_zone || null
        });
      }
    } catch (err) {
      // One inaccessible/misconfigured top-level customer must not break
      // the rest of the list - same "one failure can't block the batch"
      // philosophy already used by disconnectAccountGoogleConnections.
      const classified = classifyGoogleAdsError(err);
      LoggerUtil.warn(`${SERVICE}: skipping inaccessible top-level customer`, {
        customerId,
        category: classified.category,
        message: classified.message
      });
    }
  }

  setCachedData(cacheKey, accounts);
  return accounts;
}

/**
 * Live re-validation of one specific (customerId, loginCustomerId) pair
 * against Google - the server-side source of truth the /select and
 * /validate endpoints both call. Never trusts that a customerId came from a
 * previous getGoogleAdsAccessibleAccounts() response; re-derives it from
 * Google on every call.
 */
export async function validateGoogleAdsAccountAccess(googleConnection, customerId, loginCustomerId) {
  if (!customerId || !/^\d+$/.test(String(customerId))) {
    throw ErrorUtil.validation('A valid numeric Google Ads customerId is required');
  }
  if (loginCustomerId && !/^\d+$/.test(String(loginCustomerId))) {
    throw ErrorUtil.validation('loginCustomerId must be numeric');
  }

  await ensureConnectionAlive(googleConnection);

  const customer = buildCustomer(googleConnection, { customerId, loginCustomerId });

  try {
    const rows = await withGoogleAdsRetry(
      () => customer.query(`
        SELECT
          customer.id,
          customer.descriptive_name,
          customer.manager,
          customer.status,
          customer.currency_code,
          customer.time_zone
        FROM customer
        LIMIT 1
      `),
      `validateAccount:${customerId}`
    );

    const info = rows?.[0]?.customer;
    if (!info) {
      throw ErrorUtil.validation(`Google Ads account ${customerId} returned no data`);
    }

    LoggerUtil.service(SERVICE, 'validateAccount', 'completed', {
      customerId,
      loginCustomerId: loginCustomerId || null
    });

    return {
      customerId: String(info.id),
      name: info.descriptive_name || null,
      isManager: !!info.manager,
      status: decodeEnum('CustomerStatus', info.status),
      currencyCode: info.currency_code || null,
      timeZone: info.time_zone || null
    };
  } catch (err) {
    throw wrapGoogleAdsError(err, 'validateAccount', { customerId, loginCustomerId: loginCustomerId || null });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Campaigns (metadata only - no metrics/keywords/search terms in this phase)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Lightweight campaign list for the account once selected - id/name/status/
 * channel type/budget only. Deliberately excludes metrics.* fields: that's
 * out of scope for this phase (see googleAdsMapper/sync work planned for
 * Phase 6.3+).
 */
export async function getGoogleAdsCampaigns(googleConnection) {
  const customerId = googleConnection.google_ads_customer_id;
  const loginCustomerId = googleConnection.google_ads_login_customer_id;

  if (!customerId) {
    throw ErrorUtil.validation('No Google Ads account has been selected for this project yet');
  }

  const cacheKey = getCacheKey('ads_campaigns', googleConnection._id, customerId);
  const cached = getCachedData(cacheKey);
  if (cached) return cached;

  await ensureConnectionAlive(googleConnection);
  const customer = buildCustomer(googleConnection, { customerId, loginCustomerId });

  try {
    const rows = await withGoogleAdsRetry(
      () => customer.query(`
        SELECT
          campaign.id,
          campaign.name,
          campaign.status,
          campaign.advertising_channel_type,
          campaign_budget.amount_micros
        FROM campaign
        ORDER BY campaign.id
      `),
      `campaigns:${customerId}`
    );

    const campaigns = rows.map((row) => ({
      campaignId: String(row.campaign.id),
      name: row.campaign.name,
      status: decodeEnum('CampaignStatus', row.campaign.status),
      channelType: decodeEnum('AdvertisingChannelType', row.campaign.advertising_channel_type),
      budgetMicros: row.campaign_budget?.amount_micros ?? null,
      budgetAmount: row.campaign_budget?.amount_micros != null
        ? Number(row.campaign_budget.amount_micros) / 1_000_000
        : null
    }));

    setCachedData(cacheKey, campaigns);
    LoggerUtil.service(SERVICE, 'getCampaigns', 'completed', { customerId, count: campaigns.length });
    return campaigns;
  } catch (err) {
    throw wrapGoogleAdsError(err, 'getCampaigns', { customerId });
  }
}

/**
 * Extended single-campaign detail - mirrors the
 * getBusinessProfileLocations()/getBusinessProfileLocationDetails() split in
 * businessProfileService.js (a lightweight list + a richer single-resource
 * detail fetch using a wider field set), applied here to campaigns instead
 * of locations.
 */
export async function getGoogleAdsCampaignMetadata(googleConnection, campaignId) {
  const customerId = googleConnection.google_ads_customer_id;
  const loginCustomerId = googleConnection.google_ads_login_customer_id;

  if (!customerId) {
    throw ErrorUtil.validation('No Google Ads account has been selected for this project yet');
  }
  if (!campaignId || !/^\d+$/.test(String(campaignId))) {
    // GAQL has no parameter binding in this client - campaignId is
    // interpolated into the query string below, so it must be validated as
    // strictly numeric first (defense against GAQL injection via a
    // client-supplied route param).
    throw ErrorUtil.validation('A valid numeric campaignId is required');
  }

  const cacheKey = getCacheKey('ads_campaign_metadata', googleConnection._id, customerId, campaignId);
  const cached = getCachedData(cacheKey);
  if (cached) return cached;

  await ensureConnectionAlive(googleConnection);
  const customer = buildCustomer(googleConnection, { customerId, loginCustomerId });

  try {
    const rows = await withGoogleAdsRetry(
      () => customer.query(`
        SELECT
          campaign.id,
          campaign.name,
          campaign.status,
          campaign.serving_status,
          campaign.advertising_channel_type,
          campaign.advertising_channel_sub_type,
          campaign.bidding_strategy_type,
          campaign.start_date_time,
          campaign.end_date_time,
          campaign.optimization_score,
          campaign_budget.id,
          campaign_budget.amount_micros,
          campaign_budget.delivery_method,
          campaign_budget.period
        FROM campaign
        WHERE campaign.id = ${Number(campaignId)}
        LIMIT 1
      `),
      `campaignMetadata:${customerId}:${campaignId}`
    );

    const row = rows?.[0];
    if (!row) {
      throw ErrorUtil.validation(`Campaign ${campaignId} was not found on this Google Ads account`);
    }

    const metadata = mapCampaignRow(row);

    setCachedData(cacheKey, metadata);
    LoggerUtil.service(SERVICE, 'getCampaignMetadata', 'completed', { customerId, campaignId });
    return metadata;
  } catch (err) {
    throw wrapGoogleAdsError(err, 'getCampaignMetadata', { customerId, campaignId });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Sync-purpose fetches (Phase 6.3) - raw Google reads only, no persistence.
// Consumed exclusively by googleAdsSyncService.js; getGoogleAdsCampaigns/
// getGoogleAdsCampaignMetadata above are unchanged and still available for
// a live (uncached-write) single lookup.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Single combined query covering every field the Campaign list AND detail
 * endpoints need - one Google Ads API call per sync instead of a list call
 * plus N per-campaign detail calls (GAQL has no per-field cost difference
 * within one request, so widening this one query is strictly cheaper than
 * fetching detail separately for every campaign).
 */
export async function getGoogleAdsCampaignsForSync(googleConnection) {
  const customerId = googleConnection.google_ads_customer_id;
  const loginCustomerId = googleConnection.google_ads_login_customer_id;

  if (!customerId) {
    throw ErrorUtil.validation('No Google Ads account has been selected for this project yet');
  }

  await ensureConnectionAlive(googleConnection);
  const customer = buildCustomer(googleConnection, { customerId, loginCustomerId });

  try {
    const rows = await withGoogleAdsRetry(
      () => customer.query(`
        SELECT
          campaign.id,
          campaign.name,
          campaign.status,
          campaign.serving_status,
          campaign.advertising_channel_type,
          campaign.advertising_channel_sub_type,
          campaign.bidding_strategy_type,
          campaign.start_date_time,
          campaign.end_date_time,
          campaign.optimization_score,
          campaign_budget.id,
          campaign_budget.amount_micros,
          campaign_budget.delivery_method,
          campaign_budget.period
        FROM campaign
        ORDER BY campaign.id
      `),
      `campaignsForSync:${customerId}`
    );

    const campaigns = rows.map(mapCampaignRow);
    LoggerUtil.service(SERVICE, 'getCampaignsForSync', 'completed', { customerId, count: campaigns.length });
    return campaigns;
  } catch (err) {
    throw wrapGoogleAdsError(err, 'getCampaignsForSync', { customerId });
  }
}

/**
 * Daily, per-campaign metric rows for a date range (GAQL's segments.date
 * naturally explodes the result into one row per (campaign, day) pair).
 * This is the source query for both Campaign Metrics Synchronization and
 * the Daily historical snapshot grain - the sync orchestrator decides the
 * date window (full backfill vs. trailing reconciliation window), this
 * function just executes whatever range it's given.
 */
export async function getGoogleAdsDailyCampaignMetrics(googleConnection, startDate, endDate) {
  const customerId = googleConnection.google_ads_customer_id;
  const loginCustomerId = googleConnection.google_ads_login_customer_id;

  if (!customerId) {
    throw ErrorUtil.validation('No Google Ads account has been selected for this project yet');
  }

  await ensureConnectionAlive(googleConnection);
  const customer = buildCustomer(googleConnection, { customerId, loginCustomerId });

  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);

  try {
    const rows = await withGoogleAdsRetry(
      () => customer.query(`
        SELECT
          campaign.id,
          segments.date,
          metrics.impressions,
          metrics.clicks,
          metrics.cost_micros,
          metrics.conversions,
          metrics.conversions_value
        FROM campaign
        WHERE segments.date BETWEEN '${startStr}' AND '${endStr}'
        ORDER BY segments.date, campaign.id
      `),
      `dailyMetrics:${customerId}:${startStr}:${endStr}`
    );

    LoggerUtil.service(SERVICE, 'getDailyCampaignMetrics', 'completed', { customerId, range: `${startStr}..${endStr}`, rowCount: rows.length });
    return rows;
  } catch (err) {
    throw wrapGoogleAdsError(err, 'getDailyCampaignMetrics', { customerId, range: `${startStr}..${endStr}` });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Keyword / Search Term / Optimization Score / Recommendation fetches
// (Phase 6.4) - raw Google reads only, no persistence. Consumed exclusively
// by googleAdsSyncService.js, same "pure fetch layer" role as the Phase 6.3
// functions above.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Keyword performance for a date range, one row per (ad group, criterion) -
 * NOT selecting segments.date means Google Ads aggregates metrics across
 * the whole WHERE date range server-side (standard GAQL behavior when no
 * segmenting dimension is selected), so this is already the rolling-window
 * snapshot GoogleAdsKeyword expects - no client-side day-by-day summing
 * needed. Excludes REMOVED criteria (soft-removal is tracked via
 * markMissingAsRemoved instead, same as campaigns).
 */
export async function getGoogleAdsKeywordsForSync(googleConnection, startDate, endDate) {
  const customerId = googleConnection.google_ads_customer_id;
  const loginCustomerId = googleConnection.google_ads_login_customer_id;

  if (!customerId) {
    throw ErrorUtil.validation('No Google Ads account has been selected for this project yet');
  }

  await ensureConnectionAlive(googleConnection);
  const customer = buildCustomer(googleConnection, { customerId, loginCustomerId });

  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);

  try {
    const rows = await withGoogleAdsRetry(
      () => customer.query(`
        SELECT
          ad_group_criterion.criterion_id,
          ad_group_criterion.keyword.text,
          ad_group_criterion.keyword.match_type,
          ad_group_criterion.status,
          ad_group_criterion.quality_info.quality_score,
          ad_group.id,
          ad_group.name,
          campaign.id,
          campaign.name,
          metrics.impressions,
          metrics.clicks,
          metrics.cost_micros,
          metrics.conversions,
          metrics.conversions_value
        FROM keyword_view
        WHERE segments.date BETWEEN '${startStr}' AND '${endStr}'
          AND ad_group_criterion.status != 'REMOVED'
        ORDER BY metrics.cost_micros DESC
      `),
      `keywordsForSync:${customerId}`
    );

    const keywords = rows.map((row) => ({
      criterionId: String(row.ad_group_criterion.criterion_id),
      keywordText: row.ad_group_criterion.keyword?.text || '',
      matchType: decodeEnum('KeywordMatchType', row.ad_group_criterion.keyword?.match_type),
      status: decodeEnum('AdGroupCriterionStatus', row.ad_group_criterion.status),
      qualityScore: typeof row.ad_group_criterion.quality_info?.quality_score === 'number'
        ? row.ad_group_criterion.quality_info.quality_score
        : null,
      adGroupId: String(row.ad_group.id),
      adGroupName: row.ad_group.name,
      campaignId: String(row.campaign.id),
      campaignName: row.campaign.name,
      metrics: buildMetricsBlock(row.metrics)
    }));

    LoggerUtil.service(SERVICE, 'getKeywordsForSync', 'completed', { customerId, range: `${startStr}..${endStr}`, count: keywords.length });
    return keywords;
  } catch (err) {
    throw wrapGoogleAdsError(err, 'getKeywordsForSync', { customerId, range: `${startStr}..${endStr}` });
  }
}

// Search terms can vastly outnumber keywords - capped to the highest-cost
// rows per sync ("Minimize Google API requests" / keep the write batch and
// response payload bounded), not because Google itself limits the report.
const SEARCH_TERM_SYNC_ROW_LIMIT = 2000;

/**
 * Search term report for a date range, one row per (campaign, ad group,
 * search term), aggregated across the range the same way keywords are
 * (no segments.date selected). Ordered by cost so the highest-spend terms
 * are always included even when the account exceeds the row cap.
 */
export async function getGoogleAdsSearchTermsForSync(googleConnection, startDate, endDate) {
  const customerId = googleConnection.google_ads_customer_id;
  const loginCustomerId = googleConnection.google_ads_login_customer_id;

  if (!customerId) {
    throw ErrorUtil.validation('No Google Ads account has been selected for this project yet');
  }

  await ensureConnectionAlive(googleConnection);
  const customer = buildCustomer(googleConnection, { customerId, loginCustomerId });

  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);

  try {
    const rows = await withGoogleAdsRetry(
      () => customer.query(`
        SELECT
          search_term_view.search_term,
          search_term_view.status,
          campaign.id,
          campaign.name,
          ad_group.id,
          ad_group.name,
          metrics.impressions,
          metrics.clicks,
          metrics.cost_micros,
          metrics.conversions,
          metrics.conversions_value
        FROM search_term_view
        WHERE segments.date BETWEEN '${startStr}' AND '${endStr}'
        ORDER BY metrics.cost_micros DESC
        LIMIT ${SEARCH_TERM_SYNC_ROW_LIMIT}
      `),
      `searchTermsForSync:${customerId}`
    );

    const searchTerms = rows.map((row) => {
      const metricsBlock = buildMetricsBlock(row.metrics);
      const targetingStatus = decodeEnum('SearchTermTargetingStatus', row.search_term_view.status);
      return {
        searchTerm: row.search_term_view.search_term,
        targetingStatus,
        campaignId: String(row.campaign.id),
        campaignName: row.campaign.name,
        adGroupId: String(row.ad_group.id),
        adGroupName: row.ad_group.name,
        metrics: metricsBlock,
        suggestedAction: suggestSearchTermAction(targetingStatus, metricsBlock)
      };
    });

    LoggerUtil.service(SERVICE, 'getSearchTermsForSync', 'completed', { customerId, range: `${startStr}..${endStr}`, count: searchTerms.length });
    return searchTerms;
  } catch (err) {
    throw wrapGoogleAdsError(err, 'getSearchTermsForSync', { customerId, range: `${startStr}..${endStr}` });
  }
}

/**
 * Heuristic negative-keyword-workflow suggestion (schema-readiness only -
 * see GoogleAdsSearchTerm.js's doc comment; no apply/mutate endpoint exists
 * yet). Already-targeted terms get no suggestion; spend with zero
 * conversions suggests a negative; a handful of clicks with no conversions
 * yet suggests watching; a clean converting term with real volume suggests
 * promoting it to an actual keyword.
 */
function suggestSearchTermAction(targetingStatus, metrics) {
  if (targetingStatus === 'ADDED' || targetingStatus === 'EXCLUDED' || targetingStatus === 'ADDED_EXCLUDED') return null;
  if (metrics.cost > 5 && metrics.conversions === 0) return 'negative';
  if (metrics.clicks >= 3 && metrics.conversions === 0) return 'watch';
  if (metrics.conversions > 0 && metrics.clicks >= 5) return 'add';
  return null;
}

/** Account-level optimization score + weight - a single row, always exactly one result. */
export async function getGoogleAdsOptimizationScore(googleConnection) {
  const customerId = googleConnection.google_ads_customer_id;
  const loginCustomerId = googleConnection.google_ads_login_customer_id;

  if (!customerId) {
    throw ErrorUtil.validation('No Google Ads account has been selected for this project yet');
  }

  await ensureConnectionAlive(googleConnection);
  const customer = buildCustomer(googleConnection, { customerId, loginCustomerId });

  try {
    const rows = await withGoogleAdsRetry(
      () => customer.query(`SELECT customer.optimization_score, customer.optimization_score_weight FROM customer`),
      `optimizationScore:${customerId}`
    );

    const row = rows?.[0]?.customer;
    const result = {
      optimizationScore: typeof row?.optimization_score === 'number' ? row.optimization_score : null,
      optimizationScoreWeight: typeof row?.optimization_score_weight === 'number' ? row.optimization_score_weight : null
    };

    LoggerUtil.service(SERVICE, 'getOptimizationScore', 'completed', { customerId, score: result.optimizationScore });
    return result;
  } catch (err) {
    throw wrapGoogleAdsError(err, 'getOptimizationScore', { customerId });
  }
}

// The handful of recommendation types this phase extracts type-specific
// detail for, matching the examples explicitly called out in the Phase 6.4
// brief (Increase Budget, Add Keywords). Every other type still syncs with
// its base fields (title, impact) - `details` is simply null for those,
// not a sync failure.
const RECOMMENDATION_TYPE_LABELS = {
  CAMPAIGN_BUDGET: 'Increase Budget',
  FORECASTING_CAMPAIGN_BUDGET: 'Increase Budget (Forecast)',
  MARGINAL_ROI_CAMPAIGN_BUDGET: 'Increase Budget',
  MOVE_UNUSED_BUDGET: 'Reallocate Unused Budget',
  KEYWORD: 'Add Keywords',
  KEYWORD_MATCH_TYPE: 'Broaden Keyword Match Type',
  USE_BROAD_MATCH_KEYWORD: 'Use Broad Match Keywords',
  TEXT_AD: 'Add Text Ads',
  RESPONSIVE_SEARCH_AD: 'Add Responsive Search Ads',
  RESPONSIVE_SEARCH_AD_ASSET: 'Add Responsive Search Ad Assets',
  RESPONSIVE_SEARCH_AD_IMPROVE_AD_STRENGTH: 'Improve Ad Strength',
  IMPROVE_PERFORMANCE_MAX_AD_STRENGTH: 'Improve Ad Strength',
  IMPROVE_DEMAND_GEN_AD_STRENGTH: 'Improve Ad Strength',
  TARGET_CPA_OPT_IN: 'Target CPA',
  SET_TARGET_CPA: 'Target CPA',
  RAISE_TARGET_CPA: 'Target CPA',
  RAISE_TARGET_CPA_BID_TOO_LOW: 'Target CPA',
  FORECASTING_SET_TARGET_CPA: 'Target CPA',
  TARGET_ROAS_OPT_IN: 'Target ROAS',
  SET_TARGET_ROAS: 'Target ROAS',
  LOWER_TARGET_ROAS: 'Target ROAS',
  FORECASTING_SET_TARGET_ROAS: 'Target ROAS',
  MAXIMIZE_CONVERSIONS_OPT_IN: 'Maximize Conversions',
  MAXIMIZE_CONVERSION_VALUE_OPT_IN: 'Maximize Conversion Value',
  MAXIMIZE_CLICKS_OPT_IN: 'Maximize Clicks',
  ENHANCED_CPC_OPT_IN: 'Enable Enhanced CPC',
  SEARCH_PARTNERS_OPT_IN: 'Expand to Search Partners',
  DISPLAY_EXPANSION_OPT_IN: 'Expand to Display Network',
  OPTIMIZE_AD_ROTATION: 'Optimize Ad Rotation',
  CALLOUT_ASSET: 'Add Callout Extensions',
  SITELINK_ASSET: 'Add Sitelink Extensions',
  CALL_ASSET: 'Add Call Extensions',
  LEAD_FORM_ASSET: 'Add Lead Form Extensions',
  PERFORMANCE_MAX_OPT_IN: 'Add a Performance Max Campaign',
  IMPROVE_GOOGLE_TAG_COVERAGE: 'Improve Conversion Tracking'
};

function labelForRecommendationType(type) {
  return RECOMMENDATION_TYPE_LABELS[type] || type
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function buildImpactMetrics(metrics) {
  if (!metrics) return { impressions: null, clicks: null, cost_micros: null, cost: null, conversions: null };
  return {
    impressions: typeof metrics.impressions === 'number' ? metrics.impressions : null,
    clicks: typeof metrics.clicks === 'number' ? metrics.clicks : null,
    cost_micros: typeof metrics.cost_micros === 'number' ? metrics.cost_micros : null,
    cost: typeof metrics.cost_micros === 'number' ? metrics.cost_micros / 1_000_000 : null,
    conversions: typeof metrics.conversions === 'number' ? metrics.conversions : null
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Recommendation presentation layer (Gap #4, frontend integration audit) -
// "never make React derive these": priority/severity/category/description/
// statLabel/statValue are all computed here, server-side, once per sync,
// and persisted alongside the raw fields - the frontend renders, it never
// transforms.
// ─────────────────────────────────────────────────────────────────────────

// Groups the ~58 RecommendationType values into a small set of display
// categories. Deliberately NOT exhaustive (mirrors RECOMMENDATION_TYPE_LABELS'
// own "cover the common cases, fall back gracefully" approach) - any type
// not listed here falls back to 'Other' rather than the sync failing.
const RECOMMENDATION_TYPE_CATEGORY = {
  CAMPAIGN_BUDGET: 'Budget', FORECASTING_CAMPAIGN_BUDGET: 'Budget', MARGINAL_ROI_CAMPAIGN_BUDGET: 'Budget', MOVE_UNUSED_BUDGET: 'Budget',
  KEYWORD: 'Keywords', KEYWORD_MATCH_TYPE: 'Keywords', USE_BROAD_MATCH_KEYWORD: 'Keywords',
  TEXT_AD: 'Ads', RESPONSIVE_SEARCH_AD: 'Ads', RESPONSIVE_SEARCH_AD_ASSET: 'Ads',
  RESPONSIVE_SEARCH_AD_IMPROVE_AD_STRENGTH: 'Ads', IMPROVE_PERFORMANCE_MAX_AD_STRENGTH: 'Ads', IMPROVE_DEMAND_GEN_AD_STRENGTH: 'Ads',
  TARGET_CPA_OPT_IN: 'Bidding', SET_TARGET_CPA: 'Bidding', RAISE_TARGET_CPA: 'Bidding', RAISE_TARGET_CPA_BID_TOO_LOW: 'Bidding', FORECASTING_SET_TARGET_CPA: 'Bidding',
  TARGET_ROAS_OPT_IN: 'Bidding', SET_TARGET_ROAS: 'Bidding', LOWER_TARGET_ROAS: 'Bidding', FORECASTING_SET_TARGET_ROAS: 'Bidding',
  MAXIMIZE_CONVERSIONS_OPT_IN: 'Bidding', MAXIMIZE_CONVERSION_VALUE_OPT_IN: 'Bidding', MAXIMIZE_CLICKS_OPT_IN: 'Bidding', ENHANCED_CPC_OPT_IN: 'Bidding',
  SEARCH_PARTNERS_OPT_IN: 'Targeting', DISPLAY_EXPANSION_OPT_IN: 'Targeting', OPTIMIZE_AD_ROTATION: 'Targeting', PERFORMANCE_MAX_OPT_IN: 'Targeting',
  CALLOUT_ASSET: 'Extensions', SITELINK_ASSET: 'Extensions', CALL_ASSET: 'Extensions', LEAD_FORM_ASSET: 'Extensions',
  IMPROVE_GOOGLE_TAG_COVERAGE: 'Tracking'
};

function categoryForRecommendationType(type) {
  return RECOMMENDATION_TYPE_CATEGORY[type] || 'Other';
}

/** Synthesizes a human-readable sentence from whatever impact/details data this recommendation actually has - never a generic placeholder when real numbers are available. */
function buildRecommendationDescription(category, details, impact) {
  if (category === 'Budget' && details?.recommendedBudget != null && details?.currentBudget != null) {
    return `Increasing the daily budget from $${details.currentBudget.toFixed(2)} to $${details.recommendedBudget.toFixed(2)} could help this campaign capture more of its available traffic.`;
  }
  if (category === 'Keywords' && details?.keywordText) {
    const matchLabel = details.matchType ? details.matchType.toLowerCase() : 'broad';
    return `Adding "${details.keywordText}" as a ${matchLabel} match keyword could help this ad group reach more relevant searches.`;
  }

  const baseConversions = impact.base_metrics.conversions;
  const potentialConversions = impact.potential_metrics.conversions;
  if (baseConversions != null && potentialConversions != null && potentialConversions !== baseConversions) {
    const delta = potentialConversions - baseConversions;
    return delta > 0
      ? `Applying this recommendation could generate an estimated ${delta.toFixed(1)} additional conversions per month based on recent performance.`
      : `Applying this recommendation is estimated to reduce conversions by ${Math.abs(delta).toFixed(1)} per month - review before applying.`;
  }

  const baseCost = impact.base_metrics.cost;
  const potentialCost = impact.potential_metrics.cost;
  if (baseCost != null && potentialCost != null && potentialCost !== baseCost) {
    const delta = potentialCost - baseCost;
    return delta < 0
      ? `Applying this recommendation could reduce spend by an estimated $${Math.abs(delta).toFixed(2)} per month without a proportional drop in performance.`
      : `Applying this recommendation is estimated to increase spend by $${delta.toFixed(2)} per month.`;
  }

  return `Google Ads has identified an opportunity to improve performance in the ${category.toLowerCase()} area of this account.`;
}

/** Picks whichever impact delta is most meaningful for this recommendation and formats it as a {statLabel, statValue} pair - never both null when any impact data exists. */
function buildRecommendationStat(impact) {
  const baseConversions = impact.base_metrics.conversions;
  const potentialConversions = impact.potential_metrics.conversions;
  if (baseConversions != null && potentialConversions != null && potentialConversions !== baseConversions) {
    const delta = potentialConversions - baseConversions;
    return { statLabel: delta >= 0 ? 'Est. extra conversions' : 'Est. fewer conversions', statValue: `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}/mo` };
  }

  const baseCost = impact.base_metrics.cost;
  const potentialCost = impact.potential_metrics.cost;
  if (baseCost != null && potentialCost != null && potentialCost !== baseCost) {
    const delta = potentialCost - baseCost;
    return { statLabel: delta < 0 ? 'Potential savings' : 'Additional spend', statValue: `$${Math.abs(delta).toFixed(0)}/mo` };
  }

  const baseImpressions = impact.base_metrics.impressions;
  const potentialImpressions = impact.potential_metrics.impressions;
  if (baseImpressions != null && potentialImpressions != null && potentialImpressions !== baseImpressions) {
    const delta = potentialImpressions - baseImpressions;
    return { statLabel: 'Est. additional impressions', statValue: `${delta >= 0 ? '+' : ''}${Math.round(delta)}/mo` };
  }

  return { statLabel: null, statValue: null };
}

/** Magnitude used only to RANK recommendations against each other within one sync batch - never shown to the user directly. */
function recommendationImpactMagnitude(rec) {
  const baseConversions = rec.impact.base_metrics.conversions;
  const potentialConversions = rec.impact.potential_metrics.conversions;
  if (baseConversions != null && potentialConversions != null) return Math.abs(potentialConversions - baseConversions);

  const baseCost = rec.impact.base_metrics.cost;
  const potentialCost = rec.impact.potential_metrics.cost;
  if (baseCost != null && potentialCost != null) return Math.abs(potentialCost - baseCost);

  return 0;
}

/**
 * Assigns priority/severity by RELATIVE rank within this sync's own batch
 * of recommendations, not a fixed absolute threshold - an account spending
 * $500/month and one spending $500,000/month have very different ideas of
 * "high impact", and a percentile split self-adjusts to whatever scale this
 * particular account operates at rather than needing a hand-tuned dollar
 * cutoff that would be wrong for most accounts.
 */
function assignRecommendationPriorities(recommendations) {
  if (!recommendations.length) return recommendations;

  const magnitudes = recommendations.map(recommendationImpactMagnitude);
  const sorted = [...magnitudes].sort((a, b) => a - b);

  return recommendations.map((rec, i) => {
    const magnitude = magnitudes[i];
    let priority = 'low';
    if (magnitude > 0) {
      const rank = sorted.findIndex((v) => v >= magnitude) / sorted.length;
      priority = rank >= 0.66 ? 'high' : rank >= 0.33 ? 'medium' : 'low';
    }
    const severity = priority === 'high' ? 'critical' : priority === 'medium' ? 'warning' : 'info';
    return { ...rec, priority, severity };
  });
}

/** Every active (non-dismissed-in-a-way-Google-stops-returning) recommendation for the account. */
export async function getGoogleAdsRecommendationsForSync(googleConnection) {
  const customerId = googleConnection.google_ads_customer_id;
  const loginCustomerId = googleConnection.google_ads_login_customer_id;

  if (!customerId) {
    throw ErrorUtil.validation('No Google Ads account has been selected for this project yet');
  }

  await ensureConnectionAlive(googleConnection);
  const customer = buildCustomer(googleConnection, { customerId, loginCustomerId });

  try {
    const rows = await withGoogleAdsRetry(
      () => customer.query(`
        SELECT
          recommendation.resource_name,
          recommendation.type,
          recommendation.campaign,
          recommendation.dismissed,
          recommendation.impact.base_metrics.impressions,
          recommendation.impact.base_metrics.clicks,
          recommendation.impact.base_metrics.cost_micros,
          recommendation.impact.base_metrics.conversions,
          recommendation.impact.potential_metrics.impressions,
          recommendation.impact.potential_metrics.clicks,
          recommendation.impact.potential_metrics.cost_micros,
          recommendation.impact.potential_metrics.conversions,
          recommendation.campaign_budget_recommendation.current_budget_amount_micros,
          recommendation.campaign_budget_recommendation.recommended_budget_amount_micros,
          recommendation.keyword_recommendation.keyword.text,
          recommendation.keyword_recommendation.keyword.match_type
        FROM recommendation
      `),
      `recommendationsForSync:${customerId}`
    );

    const recommendations = rows.map((row) => {
      const rec = row.recommendation;
      const type = decodeEnum('RecommendationType', rec.type);

      let details = null;
      if (rec.campaign_budget_recommendation?.current_budget_amount_micros != null) {
        details = {
          currentBudget: rec.campaign_budget_recommendation.current_budget_amount_micros / 1_000_000,
          recommendedBudget: rec.campaign_budget_recommendation.recommended_budget_amount_micros != null
            ? rec.campaign_budget_recommendation.recommended_budget_amount_micros / 1_000_000
            : null
        };
      } else if (rec.keyword_recommendation?.keyword?.text) {
        details = {
          keywordText: rec.keyword_recommendation.keyword.text,
          matchType: decodeEnum('KeywordMatchType', rec.keyword_recommendation.keyword.match_type)
        };
      }

      const category = categoryForRecommendationType(type);
      const impact = {
        base_metrics: buildImpactMetrics(rec.impact?.base_metrics),
        potential_metrics: buildImpactMetrics(rec.impact?.potential_metrics)
      };
      const { statLabel, statValue } = buildRecommendationStat(impact);

      return {
        resourceName: rec.resource_name,
        type,
        title: labelForRecommendationType(type),
        category,
        description: buildRecommendationDescription(category, details, impact),
        statLabel,
        statValue,
        campaignId: rec.campaign ? rec.campaign.replace(/^customers\/\d+\/campaigns\//, '') : null,
        campaignName: null, // resolved by the sync orchestrator via the already-synced GoogleAdsCampaign collection
        dismissed: !!rec.dismissed,
        impact,
        details
      };
    });

    // Priority/severity are RELATIVE across this batch (see
    // assignRecommendationPriorities' doc comment) so must be computed
    // after every row's impact is known, not per-row in isolation.
    const prioritized = assignRecommendationPriorities(recommendations);

    LoggerUtil.service(SERVICE, 'getRecommendationsForSync', 'completed', { customerId, count: prioritized.length });
    return prioritized;
  } catch (err) {
    throw wrapGoogleAdsError(err, 'getRecommendationsForSync', { customerId });
  }
}

/** Shared metrics-block normalizer for keyword/search-term rows (both use the same 5 raw metrics fields). */
function buildMetricsBlock(metrics) {
  const impressions = metrics?.impressions || 0;
  const clicks = metrics?.clicks || 0;
  const costMicros = metrics?.cost_micros || 0;
  const cost = costMicros / 1_000_000;
  const conversions = metrics?.conversions || 0;
  const conversionsValue = metrics?.conversions_value || 0;

  return {
    impressions,
    clicks,
    cost_micros: costMicros,
    cost,
    conversions,
    conversions_value: conversionsValue,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    avg_cpc: clicks > 0 ? cost / clicks : 0,
    cost_per_conversion: conversions > 0 ? cost / conversions : 0
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Device / Geographic / Audience / Ad / Attribution fetches (Phase 6.5) -
// raw Google reads only, no persistence. Consumed exclusively by
// googleAdsSyncService.js.
// ─────────────────────────────────────────────────────────────────────────

/** Account-wide device breakdown for a date range - no campaign.id selected, so Google aggregates across every campaign automatically (same principle as the keyword/search-term fetches). */
export async function getGoogleAdsDevicePerformanceForSync(googleConnection, startDate, endDate) {
  const customerId = googleConnection.google_ads_customer_id;
  const loginCustomerId = googleConnection.google_ads_login_customer_id;
  if (!customerId) throw ErrorUtil.validation('No Google Ads account has been selected for this project yet');

  await ensureConnectionAlive(googleConnection);
  const customer = buildCustomer(googleConnection, { customerId, loginCustomerId });
  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);

  try {
    // segments.date IS selected here (unlike the keyword/search-term
    // fetches) - GoogleAdsDevicePerformance is genuine daily grain (needed
    // for "Support historical snapshots"), so each (device, day) pair must
    // arrive as its own row rather than one row aggregated across the
    // whole window.
    const rows = await withGoogleAdsRetry(
      () => customer.query(`
        SELECT segments.device, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value
        FROM campaign
        WHERE segments.date BETWEEN '${startStr}' AND '${endStr}'
      `),
      `devicePerformance:${customerId}`
    );

    const devices = rows.map((row) => ({
      device: decodeEnum('Device', row.segments.device),
      date: row.segments.date,
      metrics: buildMetricsBlock(row.metrics)
    }));

    LoggerUtil.service(SERVICE, 'getDevicePerformanceForSync', 'completed', { customerId, range: `${startStr}..${endStr}`, count: devices.length });
    return devices;
  } catch (err) {
    throw wrapGoogleAdsError(err, 'getDevicePerformanceForSync', { customerId, range: `${startStr}..${endStr}` });
  }
}

/**
 * Resolves geo target constant IDs (extracted from segments.geo_target_*
 * resource-name strings, or geographic_view.country_criterion_id) to
 * human-readable names in ONE batched query - never one lookup per row.
 * Google's own documented pattern for this resource is filtering by
 * resource_name, not raw id, hence building "geoTargetConstants/{id}"
 * strings here.
 */
async function resolveGeoTargetNames(googleConnection, ids) {
  if (!ids.length) return new Map();
  const customerId = googleConnection.google_ads_customer_id;
  const loginCustomerId = googleConnection.google_ads_login_customer_id;
  const customer = buildCustomer(googleConnection, { customerId, loginCustomerId });

  const resourceNames = [...new Set(ids)].map((id) => `'geoTargetConstants/${id}'`).join(',');

  try {
    const rows = await withGoogleAdsRetry(
      () => customer.query(`SELECT geo_target_constant.id, geo_target_constant.name, geo_target_constant.country_code FROM geo_target_constant WHERE geo_target_constant.resource_name IN (${resourceNames})`),
      `resolveGeoTargetNames:${customerId}`
    );

    const map = new Map();
    for (const row of rows) {
      map.set(String(row.geo_target_constant.id), { name: row.geo_target_constant.name, countryCode: row.geo_target_constant.country_code });
    }
    return map;
  } catch (err) {
    // Non-fatal - geo performance rows are still useful with a null name
    // (the sync's normalizer falls back to the raw ID as the label).
    LoggerUtil.warn(`${SERVICE}: geo target name resolution failed (non-fatal)`, { customerId, message: err.message });
    return new Map();
  }
}

function extractGeoTargetId(resourceNameOrId) {
  if (resourceNameOrId === null || resourceNameOrId === undefined) return null;
  const match = String(resourceNameOrId).match(/(\d+)$/);
  return match ? match[1] : String(resourceNameOrId);
}

/**
 * Geographic performance at one of three levels. Country uses the
 * dedicated geographic_view resource (cheap, always meaningful); region/
 * city use segments.geo_target_region/city on campaign (no dedicated view
 * resource exposes sub-country metrics directly - confirmed against the
 * field registry before writing this). City rows are capped, same
 * "Minimize Google API requests" reasoning as search terms.
 */
const GEO_CITY_ROW_LIMIT = 1000;

export async function getGoogleAdsGeoPerformanceForSync(googleConnection, geoLevel, startDate, endDate) {
  const customerId = googleConnection.google_ads_customer_id;
  const loginCustomerId = googleConnection.google_ads_login_customer_id;
  if (!customerId) throw ErrorUtil.validation('No Google Ads account has been selected for this project yet');

  await ensureConnectionAlive(googleConnection);
  const customer = buildCustomer(googleConnection, { customerId, loginCustomerId });
  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);

  const queryByLevel = {
    country: `
      SELECT geographic_view.country_criterion_id, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value
      FROM geographic_view
      WHERE segments.date BETWEEN '${startStr}' AND '${endStr}' AND geographic_view.location_type = 'LOCATION_OF_PRESENCE'
    `,
    region: `
      SELECT segments.geo_target_region, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value
      FROM campaign
      WHERE segments.date BETWEEN '${startStr}' AND '${endStr}'
      ORDER BY metrics.cost_micros DESC
      LIMIT ${GEO_CITY_ROW_LIMIT}
    `,
    city: `
      SELECT segments.geo_target_city, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value
      FROM campaign
      WHERE segments.date BETWEEN '${startStr}' AND '${endStr}'
      ORDER BY metrics.cost_micros DESC
      LIMIT ${GEO_CITY_ROW_LIMIT}
    `
  };

  try {
    const rows = await withGoogleAdsRetry(() => customer.query(queryByLevel[geoLevel]), `geoPerformance:${geoLevel}:${customerId}`);

    const extracted = rows.map((row) => {
      const rawId = geoLevel === 'country' ? row.geographic_view.country_criterion_id
        : geoLevel === 'region' ? row.segments.geo_target_region
        : row.segments.geo_target_city;
      return { geoTargetId: extractGeoTargetId(rawId), metrics: buildMetricsBlock(row.metrics) };
    }).filter((r) => r.geoTargetId);

    const nameMap = await resolveGeoTargetNames(googleConnection, extracted.map((r) => r.geoTargetId));

    const results = extracted.map((r) => ({
      geoLevel,
      geoTargetId: r.geoTargetId,
      name: nameMap.get(r.geoTargetId)?.name || null,
      countryCode: nameMap.get(r.geoTargetId)?.countryCode || null,
      metrics: r.metrics
    }));

    LoggerUtil.service(SERVICE, 'getGeoPerformanceForSync', 'completed', { customerId, geoLevel, count: results.length });
    return results;
  } catch (err) {
    throw wrapGoogleAdsError(err, 'getGeoPerformanceForSync', { customerId, geoLevel });
  }
}

/**
 * Demographic audience performance (age/gender/household income) via their
 * three dedicated view resources - high confidence, standard reporting
 * pattern. Affinity/In-Market/Audience-Segment performance is synced too
 * (see getGoogleAdsAudienceSegmentPerformanceForSync below) but only at the
 * criterion-TYPE level, not per-specific-category: resolving a
 * user_interest/custom_audience criterion's resource name to its actual
 * category display name would need a further per-category lookup query
 * this phase doesn't add, so category-level labels are intentionally not
 * fabricated - see the Phase 6.5 report's Production Hardening section.
 */
export async function getGoogleAdsDemographicPerformanceForSync(googleConnection, dimensionType, startDate, endDate) {
  const customerId = googleConnection.google_ads_customer_id;
  const loginCustomerId = googleConnection.google_ads_login_customer_id;
  if (!customerId) throw ErrorUtil.validation('No Google Ads account has been selected for this project yet');

  await ensureConnectionAlive(googleConnection);
  const customer = buildCustomer(googleConnection, { customerId, loginCustomerId });
  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);

  const config = {
    age: { view: 'age_range_view', field: 'ad_group_criterion.age_range.type', enumName: 'AgeRangeType' },
    gender: { view: 'gender_view', field: 'ad_group_criterion.gender.type', enumName: 'GenderType' },
    household_income: { view: 'income_range_view', field: 'ad_group_criterion.income_range.type', enumName: 'IncomeRangeType' }
  }[dimensionType];

  try {
    const rows = await withGoogleAdsRetry(
      () => customer.query(`
        SELECT ${config.field}, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value
        FROM ${config.view}
        WHERE segments.date BETWEEN '${startStr}' AND '${endStr}'
      `),
      `demographicPerformance:${dimensionType}:${customerId}`
    );

    const results = rows.map((row) => {
      const rawValue = row.ad_group_criterion[dimensionType === 'household_income' ? 'income_range' : dimensionType].type;
      const decoded = decodeEnum(config.enumName, rawValue);
      return {
        dimensionType,
        dimensionValue: decoded,
        label: humanizeEnumLabel(decoded),
        metrics: buildMetricsBlock(row.metrics)
      };
    });

    LoggerUtil.service(SERVICE, 'getDemographicPerformanceForSync', 'completed', { customerId, dimensionType, count: results.length });
    return results;
  } catch (err) {
    throw wrapGoogleAdsError(err, 'getDemographicPerformanceForSync', { customerId, dimensionType });
  }
}

const AUDIENCE_SEGMENT_CRITERION_CONFIG = {
  affinity: { criterionType: 'CUSTOM_AFFINITY', label: 'Affinity Audiences (aggregate)' },
  in_market: { criterionType: 'USER_INTEREST', label: 'In-Market Audiences (aggregate)' },
  audience_segment: { criterionType: 'CUSTOM_AUDIENCE', label: 'Custom Audience Segments (aggregate)' }
};

/** Type-level aggregate for affinity/in-market/custom-audience-segment - see doc comment above. */
export async function getGoogleAdsAudienceSegmentPerformanceForSync(googleConnection, dimensionType, startDate, endDate) {
  const customerId = googleConnection.google_ads_customer_id;
  const loginCustomerId = googleConnection.google_ads_login_customer_id;
  if (!customerId) throw ErrorUtil.validation('No Google Ads account has been selected for this project yet');

  const config = AUDIENCE_SEGMENT_CRITERION_CONFIG[dimensionType];
  await ensureConnectionAlive(googleConnection);
  const customer = buildCustomer(googleConnection, { customerId, loginCustomerId });
  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);

  try {
    const rows = await withGoogleAdsRetry(
      () => customer.query(`
        SELECT metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value
        FROM ad_group_criterion
        WHERE segments.date BETWEEN '${startStr}' AND '${endStr}' AND ad_group_criterion.type = '${config.criterionType}'
      `),
      `audienceSegmentPerformance:${dimensionType}:${customerId}`
    );

    // No non-metric dimension selected -> Google aggregates every matching
    // criterion into a single row, exactly the type-level total this
    // function is scoped to return.
    const row = rows[0];
    if (!row) return [];

    return [{ dimensionType, dimensionValue: config.criterionType, label: config.label, metrics: buildMetricsBlock(row.metrics) }];
  } catch (err) {
    throw wrapGoogleAdsError(err, 'getAudienceSegmentPerformanceForSync', { customerId, dimensionType });
  }
}

function humanizeEnumLabel(enumName) {
  if (!enumName) return enumName;
  return enumName
    .replace(/^AGE_RANGE_/, '').replace(/_UP$/, '+').replace(/_/g, '-')
    .replace(/^INCOME_RANGE_/, '');
}

/** Every non-removed ad, with an extended metadata + metrics set (RSA/PMax legacy ad/Display/Video/Shopping all share this one query - see GoogleAdsAd.js's doc comment). */
export async function getGoogleAdsAdsForSync(googleConnection, startDate, endDate) {
  const customerId = googleConnection.google_ads_customer_id;
  const loginCustomerId = googleConnection.google_ads_login_customer_id;
  if (!customerId) throw ErrorUtil.validation('No Google Ads account has been selected for this project yet');

  await ensureConnectionAlive(googleConnection);
  const customer = buildCustomer(googleConnection, { customerId, loginCustomerId });
  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);

  try {
    const rows = await withGoogleAdsRetry(
      () => customer.query(`
        SELECT
          ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type,
          ad_group_ad.status, ad_group_ad.ad_strength,
          ad_group_ad.policy_summary.approval_status, ad_group_ad.policy_summary.review_status,
          ad_group.id, ad_group.name, campaign.id, campaign.name, campaign.advertising_channel_type,
          metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value
        FROM ad_group_ad
        WHERE segments.date BETWEEN '${startStr}' AND '${endStr}' AND ad_group_ad.status != 'REMOVED'
        ORDER BY metrics.cost_micros DESC
      `),
      `adsForSync:${customerId}`
    );

    const ads = rows.map((row) => ({
      adId: String(row.ad_group_ad.ad.id),
      name: row.ad_group_ad.ad.name || null,
      adType: decodeEnum('AdType', row.ad_group_ad.ad.type),
      status: decodeEnum('AdGroupAdStatus', row.ad_group_ad.status),
      adStrength: decodeEnum('AdStrength', row.ad_group_ad.ad_strength),
      approvalStatus: decodeEnum('PolicyApprovalStatus', row.ad_group_ad.policy_summary?.approval_status),
      reviewStatus: decodeEnum('PolicyReviewStatus', row.ad_group_ad.policy_summary?.review_status),
      adGroupId: String(row.ad_group.id),
      adGroupName: row.ad_group.name,
      campaignId: String(row.campaign.id),
      campaignName: row.campaign.name,
      campaignChannelType: decodeEnum('AdvertisingChannelType', row.campaign.advertising_channel_type),
      metrics: buildMetricsBlock(row.metrics)
    }));

    LoggerUtil.service(SERVICE, 'getAdsForSync', 'completed', { customerId, count: ads.length });
    return ads;
  } catch (err) {
    throw wrapGoogleAdsError(err, 'getAdsForSync', { customerId });
  }
}

/**
 * Conversion action metadata (incl. configured attribution model) + per-
 * action click/view-through conversion metrics. Two queries: metadata has
 * no date dimension (it's account configuration, not a report); metrics
 * are fetched by segmenting `customer` by segments.conversion_action - see
 * this file's module-level doc comment for why "conversion paths" /
 * "assist conversions" are NOT part of this (no such GAQL resource exists).
 */
export async function getGoogleAdsConversionActionsForSync(googleConnection, startDate, endDate) {
  const customerId = googleConnection.google_ads_customer_id;
  const loginCustomerId = googleConnection.google_ads_login_customer_id;
  if (!customerId) throw ErrorUtil.validation('No Google Ads account has been selected for this project yet');

  await ensureConnectionAlive(googleConnection);
  const customer = buildCustomer(googleConnection, { customerId, loginCustomerId });
  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);

  try {
    const metadataRows = await withGoogleAdsRetry(
      () => customer.query(`
        SELECT
          conversion_action.id, conversion_action.name, conversion_action.category, conversion_action.status,
          conversion_action.attribution_model_settings.attribution_model,
          conversion_action.attribution_model_settings.data_driven_model_status
        FROM conversion_action
      `),
      `conversionActionsMetadata:${customerId}`
    );

    const metricsRows = await withGoogleAdsRetry(
      () => customer.query(`
        SELECT segments.conversion_action, metrics.conversions, metrics.conversions_value, metrics.view_through_conversions, metrics.all_conversions
        FROM customer
        WHERE segments.date BETWEEN '${startStr}' AND '${endStr}'
      `),
      `conversionActionsMetrics:${customerId}`
    );

    const metricsByActionId = new Map();
    for (const row of metricsRows) {
      const actionId = extractGeoTargetId(row.segments.conversion_action); // same "trailing numeric segment" extraction as geo target IDs
      if (!actionId) continue;
      metricsByActionId.set(actionId, row.metrics);
    }

    const conversionActions = metadataRows.map((row) => {
      const ca = row.conversion_action;
      const rawMetrics = metricsByActionId.get(String(ca.id));
      return {
        conversionActionId: String(ca.id),
        name: ca.name,
        category: decodeEnum('ConversionActionCategory', ca.category),
        status: decodeEnum('ConversionActionStatus', ca.status),
        attributionModel: decodeEnum('AttributionModel', ca.attribution_model_settings?.attribution_model),
        dataDrivenModelStatus: ca.attribution_model_settings?.data_driven_model_status != null
          ? decodeEnum('DataDrivenModelStatus', ca.attribution_model_settings.data_driven_model_status)
          : null,
        metrics: {
          conversions: rawMetrics?.conversions || 0,
          conversions_value: rawMetrics?.conversions_value || 0,
          view_through_conversions: rawMetrics?.view_through_conversions || 0,
          all_conversions: rawMetrics?.all_conversions || 0
        }
      };
    });

    LoggerUtil.service(SERVICE, 'getConversionActionsForSync', 'completed', { customerId, count: conversionActions.length });
    return conversionActions;
  } catch (err) {
    throw wrapGoogleAdsError(err, 'getConversionActionsForSync', { customerId });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Cache invalidation
// ─────────────────────────────────────────────────────────────────────────

/**
 * Clears every cached Google Ads entry for a specific GoogleConnection -
 * called on reconnect (see oauth.routes.js's "google_ads" callback branch),
 * same reasoning as clearCacheForConnection/clearAnalyticsCacheForConnection:
 * reconnecting reuses the same GoogleConnection._id even when the underlying
 * Google identity changes, so without this a switched account could keep
 * serving the previous identity's cached accounts/campaigns.
 */
export function clearCacheForGoogleAdsConnection(connectionId) {
  const cleared = clearCacheEntries({
    prefixes: [
      `ads_accounts:${connectionId}`,
      `ads_campaigns:${connectionId}:`,
      `ads_campaign_metadata:${connectionId}:`,
      // Phase 6.3 read-path caches (DB-backed controller endpoints) -
      // cleared both on OAuth reconnect (same call site as the prefixes
      // above) and at the end of every successful sync (see
      // googleAdsSyncService.runGoogleAdsSync), satisfying "invalidate
      // cache automatically after sync" without a second cache-clearing
      // mechanism.
      `ads_overview:${connectionId}:`,
      `ads_campaign_list:${connectionId}:`,
      `ads_campaign_detail:${connectionId}:`,
      `ads_trends:${connectionId}:`,
      // Phase 6.4 read-path caches - cleared on reconnect and at the end of
      // every sync (campaign, keyword, or recommendation), same
      // "invalidate everything for this connection" simplicity as the
      // Phase 6.3 prefixes above rather than tracking which sync touched
      // which prefix.
      `ads_keywords:${connectionId}:`,
      `ads_search_terms:${connectionId}:`,
      `ads_optimization:${connectionId}:`,
      `ads_recommendations:${connectionId}:`,
      `ads_health:${connectionId}:`,
      // Phase 6.5 read-path caches - same "invalidate everything for this
      // connection on any sync" simplicity.
      `ads_devices:${connectionId}:`,
      `ads_geo:${connectionId}:`,
      `ads_audience:${connectionId}:`,
      `ads_ads:${connectionId}:`,
      `ads_ads_grouped:${connectionId}`,
      `ads_budget:${connectionId}:`,
      `ads_forecast:${connectionId}:`,
      `ads_attribution:${connectionId}:`,
      `ads_capabilities:${connectionId}`,
      `ads_health_summary:${connectionId}:`,
      `ads_activity:${connectionId}:`
    ]
  });
  if (cleared > 0) {
    LoggerUtil.info(`${SERVICE}: cleared cache for connection`, { connectionId, cleared });
  }
}

export default {
  getGoogleAdsClient,
  buildCustomer,
  ensureConnectionAlive,
  withGoogleAdsRetry,
  wrapGoogleAdsError,
  getGoogleAdsAccessibleAccounts,
  validateGoogleAdsAccountAccess,
  getGoogleAdsCampaigns,
  getGoogleAdsCampaignMetadata,
  getGoogleAdsCampaignsForSync,
  getGoogleAdsDailyCampaignMetrics,
  getGoogleAdsKeywordsForSync,
  getGoogleAdsSearchTermsForSync,
  getGoogleAdsOptimizationScore,
  getGoogleAdsRecommendationsForSync,
  getGoogleAdsDevicePerformanceForSync,
  getGoogleAdsGeoPerformanceForSync,
  getGoogleAdsDemographicPerformanceForSync,
  getGoogleAdsAudienceSegmentPerformanceForSync,
  getGoogleAdsAdsForSync,
  getGoogleAdsConversionActionsForSync,
  classifyGoogleAdsError,
  clearCacheForGoogleAdsConnection
};
