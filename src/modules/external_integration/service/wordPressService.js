import axios from 'axios';
import { resolveWordPressResourceByUrl } from './wordPressUrlResolver.js';
import WordPressConnection from '../model/WordPressConnection.js';
import { validateUrl, normalizeUrl } from '../../../services/websiteExtractionService.js';
import wordPressPluginService from './wordPressPluginService.js';

/**
 * WordPress Connection Service
 *
 * Owns everything WordPress-specific: talking to the WordPress REST API
 * (verification, site info, plugin detection) and the connection's DB
 * lifecycle (connect/verify/status/disconnect). Controllers stay thin —
 * they authenticate, authorize, validate, and call these functions.
 *
 * Uses WordPress Application Passwords (HTTP Basic auth), not OAuth —
 * WordPress core has no OAuth flow of its own, and Application Passwords
 * are the standard, host-portable connection mechanism (available on any
 * WP ≥ 5.6 site over HTTPS, no third-party plugin required).
 *
 * IMPORTANT — the connection lifecycle functions in this file (connect/
 * verify/status/disconnect) remain read-only: nothing they do installs,
 * activates, or modifies anything on the customer's WordPress site, and
 * every outbound call they make is a GET.
 *
 * SEO field reads/writes (Phase 4) are NOT implemented in this file — they
 * live in the provider adapters (../adapters/) and wordPressSeoDataService.js
 * / wordPressSeoFixService.js, which call the authenticated, SSRF-hardened
 * `wpRequest()` helper exported below instead of duplicating the auth
 * header / maxRedirects:0 / error-classification logic a second time.
 */

const WP_ROOT_TIMEOUT_MS = 8000;
const WP_AUTH_TIMEOUT_MS = 8000;
const WP_VERSION_TIMEOUT_MS = 5000;
const WP_PLUGIN_TIMEOUT_MS = 6000;
const WP_SEO_READ_TIMEOUT_MS = 8000;
const WP_SEO_WRITE_TIMEOUT_MS = 10000;
const MAX_PLUGINS_STORED = 200;
const MAX_VERSION_SCAN_BYTES = 200 * 1024; // generator meta tag always lives well within this

// Slug -> provider, matched against plugin_summary.plugins[].slug (already
// fetched by detectInstalledPlugins() below — no extra request). Kept here
// rather than in the adapters/ directory since it's consumed by the
// connect/verify flow itself, before any adapter is selected.
const SEO_PROVIDER_PLUGIN_SLUGS = {
  'seo-by-rank-math': 'rank_math',
  'wordpress-seo': 'yoast',
  'all-in-one-seo-pack': 'aioseo',
  'all-in-one-seo-pack-pro': 'aioseo',
  'wp-seopress': 'seopress',
  'wp-seopress-pro': 'seopress',
};

// REST namespace -> provider, read from the SAME /wp-json/ root response
// checkWordPressRoot() already fetches to confirm wp/v2 support — a second
// signal for sites where plugin listing is unavailable (no activate_plugins
// capability on the connected account, or a security plugin hiding it) but
// the SEO plugin still registers its own namespace.
const SEO_PROVIDER_REST_NAMESPACES = {
  'rankmath/v1': 'rank_math',
  'yoast/v1': 'yoast',
  'aioseo/v1': 'aioseo',
  'seopress/v1': 'seopress',
};

export class WordPressConnectionError extends Error {
  constructor(code, message, statusCode = 502, wpCode = null) {
    super(message);
    this.name = 'WordPressConnectionError';
    this.code = code;
    this.statusCode = statusCode;
    // WordPress's own REST error code (e.g. "incorrect_password"), already
    // sanitized by extractWpErrorCode() — safe to log and to show.
    this.wpCode = wpCode;
  }
}

/**
 * The WordPress REST error `code` from a response body ("rest_not_logged_in",
 * "incorrect_password", "invalid_username", ...) — only ever a short
 * [a-z0-9_-] token, so nothing attacker- or credential-shaped can pass
 * through it. Null when the body isn't a WP_Error JSON object.
 */
function extractWpErrorCode(response) {
  const code = response?.data?.code;
  if (typeof code !== 'string') return null;
  return /^[a-z0-9_-]{1,64}$/i.test(code) ? code : null;
}

// ═══════════════════════════════════════════════════════════════════════
//  TEMPORARY per-domain diagnostics. Active only for hostnames listed in
//  WP_DIAGNOSTIC_HOSTS (comma-separated; default: krishnaeyecentre.com) —
//  every other site logs nothing. Logs ONLY: step, requested/final URL
//  (origin+path, never query or userinfo), status, redirect target
//  (origin+path), WordPress error code + a tag-stripped/truncated message,
//  and a boolean for "Authorization header attached". Never the header, the
//  Base64 token, the username, the password, or cookies. Remove once the
//  krishnaeyecentre.com investigation is closed.
// ═══════════════════════════════════════════════════════════════════════
function diagnosticHosts() {
  return (process.env.WP_DIAGNOSTIC_HOSTS ?? 'krishnaeyecentre.com')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function safeUrlForLog(raw) {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`; // drops userinfo, query and hash
  } catch {
    return null;
  }
}

function logWordPressDiagnostic(step, requestedUrl, { response, error, authAttached = false } = {}) {
  try {
    const safeRequested = safeUrlForLog(requestedUrl);
    if (!safeRequested) return;
    const host = new URL(safeRequested).hostname.toLowerCase().replace(/^www\./, '');
    if (!diagnosticHosts().includes(host)) return;

    const location = response?.headers?.location;
    const message = typeof response?.data?.message === 'string'
      ? response.data.message.replace(/<[^>]*>/g, '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200)
      : null;
    console.log('[WORDPRESS-DIAG]', JSON.stringify({
      step,
      requestedUrl: safeRequested,
      finalUrl: safeUrlForLog(response?.request?.res?.responseUrl) || safeRequested,
      status: response?.status ?? null,
      networkError: error?.code || null,
      redirectTo: location ? safeUrlForLog(new URL(location, safeRequested).href) : null,
      wpErrorCode: extractWpErrorCode(response),
      wpErrorMessage: message,
      authorizationAttached: Boolean(authAttached),
      wwwAuthenticatePresent: Boolean(response?.headers?.['www-authenticate']),
      server: String(response?.headers?.server || '').slice(0, 40) || null,
    }));
  } catch {
    // diagnostics must never affect the real request
  }
}

function buildAuthHeader(username, applicationPassword) {
  const token = Buffer.from(`${username}:${applicationPassword}`).toString('base64');
  return `Basic ${token}`;
}

function wpApiUrl(siteUrl, path) {
  // siteUrl is always already normalized (https, no trailing slash) by the
  // time this is called — plain concatenation is safe and avoids the
  // "accidentally mangles the path" risk of ad hoc string surgery elsewhere.
  return `${siteUrl}${path}`;
}

/**
 * Classify a failed WordPress REST call into a safe, typed error. Never
 * includes credentials, raw Authorization headers, or stack traces in the
 * resulting message — only what's safe to show a user.
 */
function classifyError(error, { authAttached = false } = {}) {
  if (error instanceof WordPressConnectionError) return error;

  if (error.code === 'ECONNABORTED') {
    return new WordPressConnectionError('TIMEOUT', 'The WordPress site took too long to respond.', 504);
  }
  if (['ENOTFOUND', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN'].includes(error.code)) {
    return new WordPressConnectionError('SITE_UNREACHABLE', 'Could not reach this WordPress site. Check the URL and try again.', 502);
  }
  if (error.code === 'EPROTO' || error.code === 'CERT_HAS_EXPIRED' || /ssl|certificate/i.test(error.message || '')) {
    return new WordPressConnectionError('SSL_ERROR', 'This site has an SSL/TLS certificate problem.', 502);
  }

  const status = error.response?.status;
  const wpCode = extractWpErrorCode(error.response);
  if (status === 401) {
    // A real credential mismatch is answered by WordPress itself with
    // `incorrect_password` / `invalid_username`. `rest_not_logged_in` to a
    // request that DID carry an Authorization header means WordPress never
    // evaluated those credentials at all (header stripped by the web server /
    // CDN / firewall, or Application Passwords blocked) — telling the user
    // their password is wrong in that case is wrong and unfixable by them.
    if (authAttached && wpCode === 'rest_not_logged_in') {
      return new WordPressConnectionError(
        'AUTH_NOT_RECEIVED',
        'The site answered "not logged in" even though Odito sent the Application Password, so WordPress did not evaluate it. ' +
          'This usually means the server, CDN or a security plugin is dropping the Authorization header, or Application Passwords are blocked. ' +
          'The credentials themselves have not been judged invalid.',
        401,
        wpCode
      );
    }
    return new WordPressConnectionError('INVALID_CREDENTIALS', 'Invalid WordPress username or Application Password.', 401, wpCode);
  }
  if (status === 403) {
    return new WordPressConnectionError('INSUFFICIENT_PERMISSIONS', 'This WordPress account does not have permission to complete this action.', 403, wpCode);
  }
  if (status === 404) {
    return new WordPressConnectionError('REST_API_DISABLED', 'The WordPress REST API could not be found at this URL.', 422);
  }
  if (status === 429) {
    return new WordPressConnectionError('RATE_LIMITED', 'WordPress is rate-limiting requests from Odito. Please try again shortly.', 429);
  }
  if (status >= 300 && status < 400) {
    return new WordPressConnectionError('SITE_REDIRECTS', 'This URL redirects to a different address. Please enter the exact final website URL.', 422);
  }
  if (status >= 500) {
    return new WordPressConnectionError('SITE_UNREACHABLE', 'The WordPress site returned a server error. Please try again shortly.', 502);
  }

  return new WordPressConnectionError('UNKNOWN_ERROR', 'Could not connect to this WordPress site.', 502);
}

/**
 * Same classification as classifyError(), but for calls made ON BEHALF OF a
 * write attempt (Phase 4 adapters/wordPressSeoFixService.js) — distinguishes
 * a handful of write-specific outcomes that a read-only connect/verify call
 * never produces, without duplicating the network-error/SSL/redirect
 * branches classifyError() already handles correctly. Always call this
 * (never classifyError directly) from adapter write paths.
 */
function classifyWriteError(error) {
  if (error instanceof WordPressConnectionError) return error;

  const status = error.response?.status;
  // A write-specific 403 is reported distinctly from the read-path's
  // INSUFFICIENT_PERMISSIONS (used today only for plugin-listing) — the
  // connected WordPress account authenticated fine and can read, but its
  // role/capability doesn't extend to editing this particular field.
  if (status === 403) {
    return new WordPressConnectionError('PERMISSION_DENIED', 'This WordPress account does not have permission to edit this field.', 403);
  }
  if (status === 404) {
    return new WordPressConnectionError('FIELD_NOT_WRITABLE', 'This field is not exposed for editing by the WordPress REST API on this site.', 422);
  }
  if (status === 400 || status === 422) {
    return new WordPressConnectionError('WRITE_FAILED', 'WordPress rejected this change.', 422);
  }

  const classified = classifyError(error);
  // A generic UNKNOWN_ERROR from the shared classifier is under-specific for
  // a write attempt — callers care whether the write itself failed, not just
  // "something went wrong."
  if (classified.code === 'UNKNOWN_ERROR') {
    return new WordPressConnectionError('WRITE_FAILED', 'Failed to write this change to WordPress.', 502);
  }
  return classified;
}

// ═══════════════════════════════════════════════════════════════════════
//  WordPress REST API calls
// ═══════════════════════════════════════════════════════════════════════

/**
 * Confirms the site is reachable AND is really WordPress with the REST API
 * enabled — not just "returned HTTP 200". `validateStatus: () => true` lets
 * us classify the status ourselves instead of relying on axios's default
 * 2xx-only success behavior; `maxRedirects: 0` means a redirecting URL is
 * surfaced as a clear "enter the exact final URL" error rather than silently
 * followed into wherever the redirect chain ends (SSRF hardening — see
 * validateUrl()/isBlockedUrl() below for the pre-flight check on the
 * starting URL itself).
 */
async function checkWordPressRoot(siteUrl) {
  let response;
  const url = wpApiUrl(siteUrl, '/wp-json/');
  try {
    response = await axios.get(url, {
      timeout: WP_ROOT_TIMEOUT_MS,
      maxRedirects: 0,
      validateStatus: () => true,
    });
  } catch (error) {
    logWordPressDiagnostic('root-check', url, { error });
    throw classifyError(error);
  }

  logWordPressDiagnostic('root-check', url, { response });
  if (response.status !== 200) {
    throw classifyError({ response });
  }

  const data = response.data;
  const namespaces = Array.isArray(data?.namespaces) ? data.namespaces : [];
  if (!namespaces.includes('wp/v2')) {
    throw new WordPressConnectionError(
      'NOT_WORDPRESS',
      'This URL does not appear to be a WordPress site with the REST API enabled.',
      422
    );
  }

  return {
    siteName: typeof data.name === 'string' ? data.name.slice(0, 200) : null,
    // Returned so detectSeoProvider() below can probe for an SEO plugin's
    // own REST namespace (rankmath/v1, yoast/v1, ...) without a second
    // request to /wp-json/ — this root document already lists every
    // registered namespace.
    namespaces,
  };
}

/**
 * Resolves which SEO plugin (if any) is active from two independent,
 * already-fetched signals — never a fresh request of its own:
 *   1. plugin_summary.plugins[].slug (from detectInstalledPlugins(), only
 *      available when the connected account has activate_plugins).
 *   2. The /wp-json/ root's own `namespaces` list (from checkWordPressRoot()
 *      above), available regardless of the connected account's capabilities.
 *
 * Deliberately a union, not "prefer plugin list over namespaces" — a site
 * can plausibly report a namespace but hide its plugin list (restricted
 * account), or vice versa in a still-initializing REST cache. If the two
 * signals disagree or multiple SEO plugins are simultaneously active,
 * 'multiple' is returned rather than silently preferring one — callers
 * (the frontend capability display) must surface that ambiguity, never
 * resolve it silently.
 */
function detectSeoProvider({ pluginSummary, namespaces }) {
  const detected = new Set();

  if (pluginSummary?.status === 'available' && Array.isArray(pluginSummary.plugins)) {
    for (const plugin of pluginSummary.plugins) {
      const provider = plugin?.slug && SEO_PROVIDER_PLUGIN_SLUGS[plugin.slug];
      if (provider) detected.add(provider);
    }
  }

  if (Array.isArray(namespaces)) {
    for (const namespace of namespaces) {
      const provider = SEO_PROVIDER_REST_NAMESPACES[namespace];
      if (provider) detected.add(provider);
    }
  }

  if (detected.size === 0) return { provider: 'none', providers: [] };
  if (detected.size > 1) return { provider: 'multiple', providers: Array.from(detected) };
  const only = Array.from(detected)[0];
  return { provider: only, providers: [only] };
}

/**
 * The standard identity-check endpoint for WordPress Application Passwords
 * — a 200 here proves both "these credentials are valid" and "this account
 * can actually use the REST API" in one call, which is why it's used
 * instead of just checking /wp-json/ returns 200 (that alone proves
 * nothing about the supplied credentials).
 */
async function verifyCredentials(siteUrl, username, applicationPassword) {
  let response;
  const url = wpApiUrl(siteUrl, '/wp-json/wp/v2/users/me');
  try {
    response = await axios.get(url, {
      timeout: WP_AUTH_TIMEOUT_MS,
      maxRedirects: 0,
      validateStatus: () => true,
      headers: { Authorization: buildAuthHeader(username, applicationPassword) },
    });
  } catch (error) {
    logWordPressDiagnostic('verify-credentials', url, { error, authAttached: true });
    throw classifyError(error);
  }

  logWordPressDiagnostic('verify-credentials', url, { response, authAttached: true });
  if (response.status !== 200) {
    throw classifyError({ response }, { authAttached: true });
  }

  return { wpUserId: response.data?.id ?? null };
}

/**
 * Best-effort only — never throws, never fails the connection. Many hosts
 * and security plugins deliberately strip the generator meta tag, and
 * WordPress core's REST API root does not expose the version number by
 * design (removed for security reasons some releases ago), so `null` here
 * is a common, legitimate outcome, not a bug.
 */
async function detectWordPressVersion(siteUrl) {
  try {
    const response = await axios.get(siteUrl, {
      timeout: WP_VERSION_TIMEOUT_MS,
      maxRedirects: 0,
      validateStatus: () => true,
      responseType: 'text',
      maxContentLength: MAX_VERSION_SCAN_BYTES,
      headers: { Accept: 'text/html' },
    });
    if (response.status !== 200 || typeof response.data !== 'string') return null;

    const match = response.data
      .slice(0, 50000)
      .match(/<meta\s+name=["']generator["']\s+content=["']WordPress\s+([\d.]+)["']/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort only — never throws. Plugin visibility depends entirely on
 * the connected account's WordPress capabilities (activate_plugins,
 * typically Administrator-only) and on whether a security plugin has
 * disabled the endpoint outright, so "unavailable" is a normal, expected
 * outcome that must not fail the overall connection (see Section 11 of the
 * Phase 2 spec).
 */
async function detectInstalledPlugins(siteUrl, username, applicationPassword) {
  const checked_at = new Date();
  const unavailable = (reason) => ({ status: 'unavailable', reason, count: null, plugins: [], checked_at });

  try {
    const response = await axios.get(wpApiUrl(siteUrl, '/wp-json/wp/v2/plugins'), {
      timeout: WP_PLUGIN_TIMEOUT_MS,
      maxRedirects: 0,
      validateStatus: () => true,
      headers: { Authorization: buildAuthHeader(username, applicationPassword) },
    });

    if (response.status === 401 || response.status === 403) return unavailable('insufficient_permissions');
    if (response.status === 404) return unavailable('endpoint_unavailable');
    if (response.status !== 200 || !Array.isArray(response.data)) return unavailable('unknown_error');

    const raw = response.data;
    const plugins = raw.slice(0, MAX_PLUGINS_STORED).map((p) => ({
      name: typeof p.name === 'string' ? p.name.slice(0, 200) : (p.plugin || 'Unknown plugin'),
      slug: typeof p.plugin === 'string' ? p.plugin.split('/')[0] : null,
      status: typeof p.status === 'string' ? p.status : null,
      version: typeof p.version === 'string' ? p.version.slice(0, 50) : null,
    }));

    return { status: 'available', reason: null, count: raw.length, plugins, checked_at };
  } catch {
    return unavailable('unknown_error');
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  Shared authenticated request helper (Phase 4) — every adapter and
//  wordPressSeoDataService.js/wordPressSeoFixService.js call THIS instead of
//  building their own axios call, so the auth header, SSRF guards
//  (maxRedirects: 0 — the site URL itself was already validated at
//  connect-time by normalizeAndValidateSiteUrl/validateUrl, never re-taken
//  from user input here), and error classification are defined in exactly
//  one place for every WordPress REST call this feature makes, read or
//  write. This is the ONLY function in this file that issues a non-GET
//  request.
// ═══════════════════════════════════════════════════════════════════════

/**
 * @param {{site_url: string, username: string, application_password: string}} connection
 *   A hydrated WordPressConnection (application_password already decrypted
 *   via the schema getter) or an equivalent plain object with the same
 *   three fields — never accepts a raw URL/credential pair from a
 *   controller, only ever a persisted connection.
 * @param {{method?: string, path: string, data?: object, timeout?: number, skipErrorClassification?: boolean}} options
 *   `skipErrorClassification` (default false — every existing caller keeps
 *   today's exact behavior): when true, a non-2xx HTTP response is returned
 *   as `{status, data}` instead of being thrown as a classified error. This
 *   exists for oditoSeoBridgeService.js, which talks to a REST API with its
 *   own well-defined error vocabulary (distinct WP_Error `code`s per
 *   condition, e.g. "multiple SEO plugins active") that this function's
 *   generic classifyError/classifyWriteError — tuned for arbitrary
 *   third-party REST fields — would otherwise flatten into a handful of
 *   generic codes. A genuine network-level failure (no HTTP response at
 *   all — DNS, timeout, connection refused, SSL) is unaffected by this flag
 *   and always goes through the normal classification, since there is no
 *   response body to inspect either way.
 * @returns {Promise<{status: number, data: any}>} — throws a classified
 *   WordPressConnectionError on a network failure always, and on any
 *   non-2xx response unless `skipErrorClassification` is true.
 */
async function wpRequest(connection, { method = 'GET', path, data, timeout, skipErrorClassification = false } = {}) {
  const isWrite = method !== 'GET';
  let response;
  try {
    response = await axios.request({
      url: wpApiUrl(connection.site_url, path),
      method,
      data,
      timeout: timeout || (isWrite ? WP_SEO_WRITE_TIMEOUT_MS : WP_SEO_READ_TIMEOUT_MS),
      maxRedirects: 0,
      validateStatus: () => true,
      headers: {
        Authorization: buildAuthHeader(connection.username, connection.application_password),
        ...(isWrite ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  } catch (error) {
    throw isWrite ? classifyWriteError(error) : classifyError(error);
  }

  if (response.status < 200 || response.status >= 300) {
    if (skipErrorClassification) {
      return { status: response.status, data: response.data };
    }
    throw isWrite ? classifyWriteError({ response }) : classifyError({ response });
  }

  return { status: response.status, data: response.data };
}

/**
 * Resolves a full page URL (as stored on a Task/issue) to the WordPress post/page the REST API
 * needs. ALL of the logic lives in wordPressUrlResolver.js (URL normalization, the static front
 * page from WordPress's own settings, canonical-permalink matching, nested pages, posts, redirects,
 * unsupported content types) — this is only the long-standing entry point every adapter and service
 * already calls.
 *
 * Returns { postId, postType ('pages'|'posts' REST base), postTypeName, slug, permalink,
 * isFrontPage, status, matchedBy } or null when the URL is not a page/post Odito can work with —
 * a normal, expected outcome, not a connection failure. Callers that need to say WHY use
 * resolveWordPressResource(), which returns the resolver's reason.
 */
async function resolvePostIdFromUrl(connection, pageUrl, options) {
  const result = await resolveWordPressResourceByUrl(connection, pageUrl, options);
  if (!result.resolved) return null;
  const { resolved, ...resource } = result; // eslint-disable-line no-unused-vars
  return resource;
}

/** The full resolution result, including the reason a URL could not be resolved. Never throws for "not found". */
async function resolveWordPressResource(connection, pageUrl, options) {
  return resolveWordPressResourceByUrl(connection, pageUrl, options);
}

// ═══════════════════════════════════════════════════════════════════════
//  Response shaping — the ONLY place a WordPressConnection document is
//  turned into API-facing data. application_password never appears in the
//  object this returns, by construction — not by relying on the model's
//  toJSON transform (which only protects hydrated-document serialization,
//  not the .lean() reads used elsewhere in this file).
// ═══════════════════════════════════════════════════════════════════════
function toStatusShape(connection) {
  if (!connection) {
    return { connected: false, status: 'not_connected' };
  }
  return {
    connected: connection.status === 'connected',
    status: connection.status,
    siteUrl: connection.site_url,
    siteName: connection.site_name,
    wordpressVersion: connection.wordpress_version,
    pluginDetection: {
      status: connection.plugin_summary?.status || 'unavailable',
      reason: connection.plugin_summary?.reason || null,
      count: connection.plugin_summary?.count ?? null,
    },
    // Pre-existing connections (created before this field existed) never
    // got a schema-default backfilled into storage — a `.lean()` read of one
    // returns `undefined` here, not 'none' (Mongoose only applies schema
    // defaults when hydrating a full document, not on lean reads of a
    // document that predates the field). Defaulted explicitly so every
    // caller of this shape, old connection or new, sees a real value.
    seoProvider: connection.detected_seo_provider || 'none',
    seoProviders: connection.detected_seo_providers || [],
    seoProviderDetectedAt: connection.seo_provider_detected_at || null,
    lastVerifiedAt: connection.last_verified_at,
    lastError: connection.last_error,
    connectedAt: connection.connected_at,
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  Public service functions
// ═══════════════════════════════════════════════════════════════════════

/**
 * Validate + normalize a user-supplied WordPress site URL. Reuses the
 * existing SSRF blocklist/URL-format checks from websiteExtractionService
 * (the same "narrowly scoped, already-proven" utility the onboarding
 * fallback flow uses to validate a user-supplied URL before a server-side
 * fetch) rather than inventing a parallel validation system.
 */
function normalizeAndValidateSiteUrl(rawUrl) {
  const normalized = normalizeUrl(rawUrl);
  const validation = validateUrl(normalized);
  if (!validation.valid) {
    throw new WordPressConnectionError('INVALID_URL', validation.error, 400);
  }
  return normalized;
}

/**
 * Connect a WordPress site to a project. Nothing is persisted unless
 * verification against the live WordPress REST API succeeds first (see
 * Section 7, step 11 of the spec) — an invalid URL or bad credentials never
 * reach the database.
 */
async function connectWordPress({ projectId, userId, siteUrl, username, applicationPassword }) {
  const normalizedUrl = normalizeAndValidateSiteUrl(siteUrl);

  // 1. Confirm this is really WordPress before ever sending credentials.
  const rootInfo = await checkWordPressRoot(normalizedUrl);

  // 2. Verify the supplied Application Password actually authenticates.
  await verifyCredentials(normalizedUrl, username, applicationPassword);

  // 3. Best-effort metadata — failures here never fail the connection.
  const wordpressVersion = await detectWordPressVersion(normalizedUrl);
  const pluginSummary = await detectInstalledPlugins(normalizedUrl, username, applicationPassword);
  const seoProvider = detectSeoProvider({ pluginSummary, namespaces: rootInfo.namespaces });

  // 4. Only now, after verification succeeded, encrypt + persist. Upsert on
  // project_id (the unique key) so reconnecting with new credentials
  // replaces the existing row instead of erroring on the duplicate key.
  const now = new Date();
  const connection = await WordPressConnection.findOneAndUpdate(
    { project_id: projectId },
    {
      $set: {
        user_id: userId,
        project_id: projectId,
        site_url: normalizedUrl,
        username,
        application_password: applicationPassword, // encrypted by the schema setter
        status: 'connected',
        wordpress_version: wordpressVersion,
        site_name: rootInfo.siteName,
        plugin_summary: pluginSummary,
        detected_seo_provider: seoProvider.provider,
        detected_seo_providers: seoProvider.providers,
        seo_provider_detected_at: now,
        connected_at: now,
        last_verified_at: now,
        last_error: null,
      },
    },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
  );

  return toStatusShape(connection);
}

/**
 * Re-verify an existing connection against the live WordPress site. On
 * failure, the stored (still-encrypted) credential is left untouched — only
 * `status`/`last_error` change — so a transient WordPress outage doesn't
 * force the user to re-enter their Application Password.
 */
async function verifyWordPressConnection(projectId) {
  // Hydrated (non-lean) document — needed so the application_password
  // getter transparently decrypts it for the outbound WordPress call below.
  const connection = await WordPressConnection.findOne({ project_id: projectId });
  if (!connection) {
    throw new WordPressConnectionError('NOT_CONNECTED', 'No WordPress connection exists for this project.', 404);
  }

  const siteUrl = connection.site_url;
  const username = connection.username;
  const applicationPassword = connection.application_password; // decrypted via getter

  try {
    const rootInfo = await checkWordPressRoot(siteUrl);
    await verifyCredentials(siteUrl, username, applicationPassword);
    const wordpressVersion = await detectWordPressVersion(siteUrl);
    const pluginSummary = await detectInstalledPlugins(siteUrl, username, applicationPassword);
    const seoProvider = detectSeoProvider({ pluginSummary, namespaces: rootInfo.namespaces });

    connection.status = 'connected';
    connection.wordpress_version = wordpressVersion;
    connection.plugin_summary = pluginSummary;
    connection.detected_seo_provider = seoProvider.provider;
    connection.detected_seo_providers = seoProvider.providers;
    connection.seo_provider_detected_at = new Date();
    connection.last_verified_at = new Date();
    connection.last_error = null;
    await connection.save();

    return toStatusShape(connection);
  } catch (error) {
    const classified = classifyError(error);
    connection.status = 'verification_failed';
    connection.last_error = classified.message; // safe, non-secret message only
    await connection.save();
    throw classified;
  }
}

/** Status read — never touches WordPress, purely a DB read. */
async function getConnectionStatus(projectId) {
  const connection = await WordPressConnection.findOne({ project_id: projectId })
    .select('-application_password')
    .lean();
  return toStatusShape(connection);
}

/**
 * Hydrated (non-lean) connection lookup for callers that need to make an
 * authenticated outbound call (application_password must be decrypted via
 * the schema getter, which only fires on a hydrated document) — the
 * adapters/wordPressSeoDataService.js/wordPressSeoFixService.js all go
 * through this instead of querying WordPressConnection directly, so "how a
 * connected project is loaded" stays defined in exactly one place.
 */
async function getHydratedConnectionOrThrow(projectId) {
  const connection = await WordPressConnection.findOne({ project_id: projectId });
  if (!connection) {
    throw new WordPressConnectionError('NOT_CONNECTED', 'No WordPress connection exists for this project.', 404);
  }
  if (connection.status !== 'connected') {
    throw new WordPressConnectionError(
      'NOT_CONNECTED',
      'The WordPress connection for this project is not currently active. Re-verify or reconnect first.',
      409
    );
  }
  return connection;
}

/**
 * Removes Odito's own stored connection record only. No outbound request
 * to WordPress is made — disconnecting cannot delete WordPress data,
 * disable plugins, or modify anything on the customer's site, because
 * nothing here ever talks to the site at all.
 */
async function disconnectWordPress(projectId) {
  const result = await WordPressConnection.deleteOne({ project_id: projectId });

  // Phase 3A: disconnecting the WordPress Application Password connection
  // also revokes any paired plugin credential (Section 27) — the plugin
  // must stop being able to call heartbeat/forms-sync once the underlying
  // WordPress connection is gone. Best-effort: a missing/already-revoked
  // installation is a no-op, and this must never block or fail the
  // disconnect itself (the user's intent — "disconnect WordPress" — is
  // already satisfied by the WordPressConnection delete above).
  try {
    await wordPressPluginService.revokePluginForProject(projectId);
  } catch (error) {
    console.error('[WORDPRESS] Failed to revoke plugin installation on disconnect:', error.message);
  }

  return { deleted: result.deletedCount > 0 };
}

export default {
  connectWordPress,
  verifyWordPressConnection,
  getConnectionStatus,
  disconnectWordPress,
  // Phase 4 additions — consumed by adapters/, wordPressSeoDataService.js,
  // and wordPressSeoFixService.js. Not used by the Phase 2 connection
  // lifecycle routes themselves.
  getHydratedConnectionOrThrow,
  resolvePostIdFromUrl,
  resolveWordPressResource,
  wpRequest,
  detectSeoProvider,
};
