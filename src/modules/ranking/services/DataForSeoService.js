import axios from 'axios';
import { SERP_DEPTH, DEFAULT_SERP_DEVICE, resolveSerpDevice, createLimiter } from './serpDevices.js';

const BASE_URL = 'https://api.dataforseo.com/v3';

const ENDPOINTS = {
  KEYWORD_SUGGESTIONS: `${BASE_URL}/dataforseo_labs/google/keyword_suggestions/live`,
  KEYWORD_IDEAS:       `${BASE_URL}/dataforseo_labs/google/keyword_ideas/live`,
  RELATED_KEYWORDS:    `${BASE_URL}/dataforseo_labs/google/related_keywords/live`,
  // Live ADVANCED (not regular): same request body, but the response also carries SERP features
  // (local pack, featured snippet, AI overview, ...) alongside the organic items. Only items with
  // type === 'organic' count toward a ranking (RankingParserService.parseOrganic).
  SERP_ORGANIC:        `${BASE_URL}/serp/google/organic/live/advanced`,
  MAPS:                `${BASE_URL}/serp/google/maps/live/advanced`,
};

function getAuthHeader() {
  const login    = process.env.DATAFORSEO_LOGIN    || '';
  const password = process.env.DATAFORSEO_PASSWORD || '';
  if (!login || !password) {
    console.warn('[DATAFORSEO] DATAFORSEO_LOGIN or DATAFORSEO_PASSWORD is not set');
  }
  return `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`;
}

function makeHeaders() {
  return { Authorization: getAuthHeader(), 'Content-Type': 'application/json' };
}

// Bounds how many organic SERP requests Odito has in flight at once. A scan of
// N keywords now issues 2N organic requests (desktop + mobile); this keeps that
// from becoming an unbounded burst against the provider.
const serpLimiter = createLimiter(parseInt(process.env.DATAFORSEO_SERP_MAX_CONCURRENT, 10) || 6);

/**
 * Build the organic SERP request body for one device. Pure — exported for tests.
 * Throws UNSUPPORTED_SERP_DEVICE for anything other than "desktop" | "mobile".
 */
export function buildSerpOrganicPayload(keyword, locationCode, languageCode, device = DEFAULT_SERP_DEVICE) {
  const config = resolveSerpDevice(device);
  return [{
    keyword,
    location_code: locationCode,
    language_code: languageCode,
    depth:         SERP_DEPTH,
    device:        config.device,
    os:            config.os,
  }];
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * POST with flat retry and configurable delay.
 *
 * Retries on network/timeout errors only.
 * Throws immediately on: 401, 402, and DataForSEO API-level errors (status_code !== 20000).
 */
async function post(url, payload, { timeoutMs = 60_000, maxRetries = 3, retryDelayMs = 2_000 } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[DATAFORSEO] POST attempt ${attempt}/${maxRetries} | ${url.split('/v3/')[1]}`);

      const response = await axios.post(url, payload, {
        headers: makeHeaders(),
        timeout: timeoutMs,
      });

      const data = response.data;

      if (data?.status_code !== 20000) {
        throw Object.assign(
          new Error(`DataForSEO API error: ${data?.status_message ?? 'unknown'} (code ${data?.status_code})`),
          { isApiError: true }
        );
      }

      // The envelope's own status_code can be 20000 ("Ok.") while the
      // individual task still failed — every caller in this codebase sends
      // exactly one task per request, so tasks[0] is checked directly
      // (matches actual usage; no need to iterate). A task-level failure
      // (e.g. 40201 "temporarily paused for unusual activity" on the
      // account) carries result: null. Without this check, that null was
      // silently treated as a successful-but-empty response — downstream,
      // RankingParserService._collectAllItems() turns a non-array `result`
      // into `[]`, which is indistinguishable from "the keyword was
      // searched and the target domain genuinely wasn't found". Caught
      // here instead, before any parsing happens.
      const task = data?.tasks?.[0];
      if (task && task.status_code !== 20000) {
        throw Object.assign(
          new Error(`DataForSEO task error: ${task.status_message ?? 'unknown'} (code ${task.status_code})`),
          { isApiError: true, isTaskError: true }
        );
      }

      return data;

    } catch (err) {
      lastError = err;

      if (err.isApiError) throw err;

      const httpStatus = err.response?.status;
      if (httpStatus === 401) throw new Error('DataForSEO authentication failed — check DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD');
      if (httpStatus === 402) throw new Error('DataForSEO account has insufficient credits');
      if (httpStatus && httpStatus < 500) throw err;

      if (attempt < maxRetries) {
        console.warn(`[DATAFORSEO] Attempt ${attempt}/${maxRetries} failed — retrying in ${retryDelayMs}ms | ${err.message}`);
        await sleep(retryDelayMs);
      }
    }
  }

  throw new Error(`DataForSEO failed after ${maxRetries} attempts: ${lastError?.message}`);
}

export const DataForSeoService = {
  /**
   * Keyword suggestions for a seed query (legacy — kept for backward compatibility).
   */
  getKeywordSuggestions(keyword, locationCode, languageCode) {
    console.log(`[DATAFORSEO] getKeywordSuggestions | keyword="${keyword}" | loc=${locationCode}`);
    const payload = [{
      keyword,
      location_code:        locationCode,
      language_code:        languageCode,
      limit:                10,
      include_seed_keyword: true,
      include_serp_info:    false,
    }];
    return post(ENDPOINTS.KEYWORD_SUGGESTIONS, payload, { timeoutMs: 30_000, maxRetries: 2, retryDelayMs: 2_000 });
  },

  /**
   * Keyword ideas for onboarding generate-keywords flow.
   * Uses dataforseo_labs/google/keyword_ideas/live — combines suggestions,
   * related keywords, and co-occurrence data for broader, higher-intent results.
   * Handles city-prefixed seeds ("software company Nashik") better than
   * keyword_suggestions/live which degrades on specific phrases.
   */
  getKeywordIdeas(keyword, locationCode, languageCode) {
    console.log(`[DATAFORSEO] getKeywordIdeas | keyword="${keyword}" | loc=${locationCode}`);
    const payload = [{
      keyword,
      location_code:        locationCode,
      language_code:        languageCode,
      limit:                50,
      include_seed_keyword: true,
      include_serp_info:    false,
    }];
    return post(ENDPOINTS.KEYWORD_IDEAS, payload, { timeoutMs: 30_000, maxRetries: 2, retryDelayMs: 2_000 });
  },

  /**
   * Related keywords (keyword research async job pipeline).
   */
  getRelatedKeywords(keyword, locationCode, languageCode, depth = 2, limit = 50) {
    console.log(`[DATAFORSEO] getRelatedKeywords | keyword="${keyword}" | loc=${locationCode}`);
    const payload = [{
      keyword,
      location_code: locationCode,
      language_code: languageCode,
      depth,
      limit,
    }];
    return post(ENDPOINTS.RELATED_KEYWORDS, payload, { timeoutMs: 60_000, maxRetries: 3, retryDelayMs: 2_000 });
  },

  /**
   * Google organic SERP for domain ranking check.
   * 90s timeout, 3 attempts, 8s between retries — matches Python production config.
   *
   * @param {string} keyword
   * @param {number} locationCode
   * @param {string} languageCode
   * @param {{ device?: 'desktop'|'mobile' }} [options] defaults to desktop so
   *        every pre-existing caller keeps its exact previous behaviour.
   * @throws UNSUPPORTED_SERP_DEVICE for any other device value (no request sent).
   *
   * TEMPORARY structured logging (organic-call-flow investigation): logs the
   * exact request parameters immediately before the HTTP call, and the
   * response shape (or the exact thrown error — never swallowed) immediately
   * after. Safe to remove once the investigation is closed; no credentials,
   * no full response body.
   */
  async getSerpOrganic(keyword, locationCode, languageCode, { device = DEFAULT_SERP_DEVICE } = {}) {
    const endpointPath = ENDPOINTS.SERP_ORGANIC.split('/v3/')[1];
    const payload = buildSerpOrganicPayload(keyword, locationCode, languageCode, device);
    const { depth, os } = payload[0];

    console.log(`[DATAFORSEO] getSerpOrganic | keyword="${keyword}" | loc=${locationCode} | device=${device}`);
    console.log(
      `[DATAFORSEO_ORGANIC_REQUEST] keyword="${keyword}" | locationCode=${locationCode} | ` +
      `endpoint=${endpointPath} | device=${device} | os=${os} | language=${languageCode} | depth=${depth}`
    );
    console.log(`[DATAFORSEO_CALL] type=organic | device=${device} | keyword="${keyword}" | timestamp=${new Date().toISOString()}`);

    const startedAt = Date.now();
    try {
      const data = await serpLimiter(() =>
        post(ENDPOINTS.SERP_ORGANIC, payload, { timeoutMs: 90_000, maxRetries: 3, retryDelayMs: 8_000 })
      );
      const responseTimeMs = Date.now() - startedAt;
      const task = data?.tasks?.[0];
      const resultCount = Array.isArray(task?.result) ? task.result.length : 0;

      console.log(
        `[DATAFORSEO_ORGANIC_RESPONSE] device=${device} | status=${data?.status_code} | success=true | ` +
        `responseTimeMs=${responseTimeMs} | tasksCount=${data?.tasks?.length ?? 0} | resultCount=${resultCount}`
      );

      return data;
    } catch (err) {
      const responseTimeMs = Date.now() - startedAt;
      // Never swallowed — logged for visibility, then rethrown unchanged so
      // the caller (processKeyword, seoOnboardingController.js) still sees
      // the real failure and records it as scan_error rather than silently
      // deriving rank=null from an empty result.
      console.error(
        `[DATAFORSEO_ORGANIC_ERROR] device=${device} | message="${err.message}" | ` +
        `status=${err.response?.status ?? (err.isTaskError ? 'task_error' : 'unknown')} | ` +
        `responseTimeMs=${responseTimeMs} | ` +
        `responseBodySummary="${JSON.stringify(err.response?.data ?? {}).slice(0, 200)}"`
      );
      throw err;
    }
  },

  /**
   * Google Maps SERP for local business rank. Completely separate endpoint/
   * request from getSerpOrganic above — see the "STEP 6" call-flow
   * investigation notes for why the two must never be conflated.
   */
  async getMapsResults(keyword, locationCode, languageCode) {
    const endpointPath = ENDPOINTS.MAPS.split('/v3/')[1];

    console.log(`[DATAFORSEO] getMapsResults | keyword="${keyword}" | loc=${locationCode}`);
    console.log(
      `[DATAFORSEO_MAPS_REQUEST] keyword="${keyword}" | locationCode=${locationCode} | endpoint=${endpointPath}`
    );
    console.log(`[DATAFORSEO_CALL] type=maps | keyword="${keyword}" | timestamp=${new Date().toISOString()}`);

    const payload = [{
      keyword,
      location_code: locationCode,
      language_code: languageCode,
      depth:         100,
    }];
    return post(ENDPOINTS.MAPS, payload, { timeoutMs: 60_000, maxRetries: 3, retryDelayMs: 5_000 });
  },
};
