import axios from 'axios';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * MetaApiService — the single, reusable low-level client for every call
 * this backend ever makes to Meta's Graph API (OAuth token exchange today;
 * /me/accounts, Page insights, Instagram insights in later phases).
 *
 * Phase 1 scope: only what OAuth/token exchange needs. Deliberately
 * generic (method/path/params/accessToken, not "getPages()" etc.) so
 * Phase 2 can add authenticated calls (e.g. GET /me/accounts) by calling
 * `request()` with an access token, without touching this file's shape.
 *
 * Every response is normalized to the same
 * { success, status, data, message } shape wordPressService.js's own
 * external-API pattern already uses in this codebase — never throws for
 * an ordinary API-level failure, only for a genuine programming error.
 */

const DEFAULT_TIMEOUT_MS = 10000;

function graphApiVersion() {
  // Single source of truth — every caller gets the version from here,
  // never a literal string embedded in a URL elsewhere in the codebase.
  // Both base URLs below derive from this same function so there is only
  // ever one place the version literal is written.
  return process.env.META_GRAPH_API_VERSION || 'v21.0';
}

/**
 * META_GRAPH_BASE_URL — the Graph API host. Used for every authenticated
 * data call (request()/requestAbsolute() below) AND for the OAuth token
 * EXCHANGE endpoint (/oauth/access_token), which — unlike the
 * authorization dialog — really does live on graph.facebook.com per
 * Meta's own documentation. Do not use this for the authorization dialog;
 * see oauthDialogBaseUrl() below.
 */
export function graphApiBaseUrl() {
  return `https://graph.facebook.com/${graphApiVersion()}`;
}

/**
 * META_OAUTH_BASE_URL — the browser-facing OAuth host. Meta's
 * authorization DIALOG (the consent screen a real user's browser is sent
 * to) lives on www.facebook.com, not graph.facebook.com — a genuinely
 * different host, not just a different path on the same one. Hitting
 * graph.facebook.com/{version}/dialog/oauth returns Meta's real error
 * "Unsupported get request. Object with ID 'dialog' does not exist"
 * (GraphMethodException, code 100, subcode 33) because the Graph API host
 * has no concept of an HTML dialog at all — that's a completely separate
 * product surface Meta hosts elsewhere. Used ONLY by
 * metaOAuthService.js's buildAuthorizationUrl(); never for an actual data
 * request (those always go through graphApiBaseUrl() above).
 */
export function oauthDialogBaseUrl() {
  return `https://www.facebook.com/${graphApiVersion()}`;
}

/**
 * Normalizes any axios outcome (success, Meta API error envelope, network
 * error, timeout) into one shape. Meta's error envelope is
 * { error: { message, type, code, error_subcode, fbtrace_id } } — the
 * `message` is surfaced only in the SERVER-SIDE log, via a caller-supplied
 * safe log context; callers of this service must map `message` to a
 * stable internal code before it ever reaches an HTTP response, exactly
 * like the WordPress module's own error-code standardization.
 */
function normalizeResponse(response) {
  return {
    success: true,
    status: response.status,
    data: response.data,
    message: null,
  };
}

// Node/axios error codes that can only occur BEFORE a request body is on
// the wire (DNS failure, refused connection) — Meta provably never saw the
// request. Every other transport failure (timeout awaiting the response,
// ECONNRESET, EPIPE, socket hang up, unrecognized codes) is deliberately
// NOT in this set: the request may well have reached Meta and been acted on
// even though no response made it back, so callers must treat those as an
// UNKNOWN outcome rather than a definite failure (see metaErrorClassifier.js).
const REQUEST_NEVER_SENT_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ERR_INVALID_URL']);

/**
 * Failure `kind` is how callers tell "Meta answered with an error" (definite)
 * apart from "no answer arrived" (the request may or may not have been
 * processed):
 *   'http'            — Meta responded (any status); `status`/`data` are set
 *   'timeout'         — request sent, no response before the deadline
 *   'network_unsent'  — failed before the request could be sent
 *   'network_unknown' — transport failed after/while sending (e.g. reset)
 */
function normalizeError(error, context) {
  if (error.response) {
    const metaError = error.response.data?.error;
    // type/code/fbtrace_id only — never the raw metaError.message at this
    // log level (see the debug-level line below for that, gated the same
    // way LoggerUtil.debug always is: NODE_ENV=development or explicit
    // LOG_LEVEL=debug only).
    LoggerUtil.error('[META_API] Graph API error response', {
      status: error.response.status,
      type: metaError?.type,
      code: metaError?.code,
      fbtrace_id: metaError?.fbtrace_id,
    }, { context });
    if (metaError?.message) {
      LoggerUtil.debug('[META_API] Graph API error detail', { message: metaError.message, context });
    }
    return {
      success: false,
      kind: 'http',
      status: error.response.status,
      data: error.response.data || null,
      message: metaError?.message || 'Meta API request failed',
    };
  }

  if (error.code === 'ECONNABORTED' || /timeout/i.test(error.message || '')) {
    LoggerUtil.error('[META_API] Graph API request timed out', {}, { context });
    return { success: false, kind: 'timeout', status: null, data: null, message: 'Meta API request timed out', networkCode: error.code || null };
  }

  LoggerUtil.error('[META_API] Graph API network error', { message: error.message, code: error.code || null }, { context });
  return {
    success: false,
    kind: REQUEST_NEVER_SENT_CODES.has(error.code) ? 'network_unsent' : 'network_unknown',
    status: null,
    data: null,
    message: 'Could not reach Meta API',
    networkCode: error.code || null,
  };
}

/**
 * Generic authenticated Graph API request. `params.access_token` (or an
 * explicit `accessToken` option) is the ONLY form of auth Graph API
 * accepts on these calls — never logged (see normalizeError, which never
 * includes request params).
 */
export async function request({ method = 'GET', path, params = {}, accessToken, timeoutMs = DEFAULT_TIMEOUT_MS, context = 'graph_api_call' } = {}) {
  try {
    const response = await axios({
      method,
      url: `${graphApiBaseUrl()}${path}`,
      params: accessToken ? { ...params, access_token: accessToken } : params,
      timeout: timeoutMs,
    });
    return normalizeResponse(response);
  } catch (error) {
    return normalizeError(error, context);
  }
}

/**
 * Unauthenticated request to a full, caller-supplied Graph URL — used
 * specifically for the OAuth token-exchange endpoints (client_id/secret
 * based, not a Bearer/access_token call), which live on the same graph
 * host/version but aren't "authenticated" in the request() sense above.
 */
export async function requestAbsolute({ method = 'GET', url, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS, context = 'graph_api_oauth_call' } = {}) {
  try {
    const response = await axios({ method, url, params, timeout: timeoutMs });
    return normalizeResponse(response);
  } catch (error) {
    return normalizeError(error, context);
  }
}

export default { graphApiBaseUrl, oauthDialogBaseUrl, request, requestAbsolute };
