import metaApiService, { graphApiBaseUrl, oauthDialogBaseUrl } from './metaApiService.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * MetaOAuthService — the Meta-specific half of the OAuth flow: building
 * the consent URL and exchanging an authorization code for an access
 * token. Graph API HTTP mechanics (base URL, version, timeout, error
 * normalization) are metaApiService.js's job; this file only knows the
 * OAuth-specific endpoints and parameters.
 *
 * Phase 1 scope: token EXCHANGE only. Nothing here persists a token —
 * that's explicitly deferred to Phase 2 (SocialAccount model) per the
 * spec for this phase. The exchanged token is handed back to the
 * controller, which currently does nothing with it but confirm the
 * exchange succeeded.
 */

// Permissions required for the Page + Instagram connection, analytics
// read, AND publishing flows. Facebook/Page permissions first, Instagram
// permissions grouped afterward.
//
// pages_manage_posts / instagram_content_publish were added when the
// Social Publishing feature (SocialPublication, platformAdapters/) was
// built — this scope list previously only covered the read/analytics
// flows and deliberately left publishing for "later." That "later" was
// never done: every Facebook Page connected under the OLD scope list has
// a token that can read but cannot post, which live-testing against the
// real Graph API confirmed directly (POST /{pageId}/feed on an existing
// connection fails with OAuthException code 200, "requires ...
// pages_manage_posts permission"). Adding the scope here only affects
// NEW connections — every account connected before this change must be
// disconnected and reconnected for its token to actually carry the new
// permission; this file cannot retroactively upgrade an already-issued
// token's grants.
//
// ROOT CAUSE of the "Invalid Scopes: instagram_business_basic,
// instagram_business_manage_insights" rejection this app hit: Meta splits
// Instagram integration into two entirely separate products, each with its
// OWN authorization host and its OWN scope namespace —
//   - "Instagram API with FACEBOOK Login" (Instagram professional account
//     must be linked to a Facebook Page — this is Odito's whole Phase 1-3
//     architecture: Page discovery via /me/accounts, Page token reused for
//     Instagram) -> authorization host www.facebook.com/{version}/dialog/oauth
//     -> scope namespace: instagram_basic, instagram_manage_insights,
//     instagram_manage_comments, instagram_content_publish (classic
//     "instagram_" prefix, NOT "instagram_business_").
//   - "Instagram API with INSTAGRAM Login" (no Facebook Page at all —
//     Instagram accounts connect directly) -> authorization host
//     www.instagram.com/oauth/authorize -> scope namespace: the
//     "instagram_business_*" names.
// instagram_business_basic / instagram_business_manage_insights are ONLY
// ever valid on www.instagram.com/oauth/authorize — never on
// www.facebook.com/dialog/oauth, which is the endpoint buildAuthorizationUrl()
// below actually calls. That's why the previous change to the
// "instagram_business_*" names was rejected: it wasn't a typo, it was the
// wrong product's namespace for this app's flow. Confirmed against Meta's
// current official documentation (developers.facebook.com/docs/instagram-
// platform/instagram-api-with-facebook-login/business-login-for-instagram/),
// not assumed. Do not reintroduce the instagram_business_* names unless
// Odito's OAuth flow is deliberately migrated to Instagram Login (a much
// larger change — different host, different token-exchange endpoint, and
// no Facebook Page in the flow at all — not something to do silently by
// renaming scopes).
//
// read_insights is also deliberately absent — it does not appear in Meta's
// documented scope list for this flow either.
export const META_OAUTH_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'business_management',
  'instagram_basic',
  'instagram_manage_insights',
  'instagram_content_publish',
];

/**
 * `reconnect: true` appends Meta's own documented
 * `auth_type=rerequest` parameter (Facebook Login for the Web —
 * "re-asking for declined permissions"), which forces Meta to show the
 * permissions dialog again even for a user with an existing, valid
 * session/grant. Without it, a user who already authorized this app once
 * will often be silently redirected straight back with a fresh code and
 * NO new consent screen at all — meaning a scope added to
 * META_OAUTH_SCOPES after the fact (like pages_manage_posts) can
 * silently never actually be granted no matter how many times "Connect"
 * is clicked. This is a real, live-confirmed root cause: every
 * previously-connected Page's token in this system still lacks
 * pages_manage_posts even after the scope list was fixed, because
 * nothing ever forced Meta to re-prompt for it.
 *
 * Deliberately opt-in, not the default — forcing re-consent on every
 * normal "Connect" would be a needless extra click for a brand-new
 * connection that was never going to skip the dialog anyway.
 * `auth_type` is a genuine, Meta-documented parameter (not invented) —
 * only 'rerequest' is supported here, the exact value Meta's own docs
 * specify for this scenario.
 */
export function buildAuthorizationUrl({ redirectUri, state, scopes = META_OAUTH_SCOPES, reconnect = false }) {
  // The authorization DIALOG (browser consent screen) lives on
  // www.facebook.com, NOT graph.facebook.com — a real, documented Meta
  // architecture split, not a typo-fixable path issue. Using
  // graphApiBaseUrl() here was the root cause of the "Unsupported get
  // request. Object with ID 'dialog' does not exist" error: Meta's Graph
  // API host genuinely has no /dialog/oauth resource. See
  // oauthDialogBaseUrl()'s own comment in metaApiService.js.
  const url = new URL(`${oauthDialogBaseUrl()}/dialog/oauth`);
  url.searchParams.set('client_id', process.env.META_APP_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', scopes.join(','));
  url.searchParams.set('response_type', 'code');
  if (reconnect) url.searchParams.set('auth_type', 'rerequest');
  return url.toString();
}

/**
 * Exchanges an authorization code for a Meta user access token.
 * client_secret is attached here only (never sent to the browser, never
 * part of the frontend-facing consent URL above). Returns the same
 * { success, status, data, message } shape metaApiService normalizes
 * everything to — data.access_token is the caller's responsibility to
 * never log or return to the frontend.
 */
export async function exchangeCodeForToken({ code, redirectUri }) {
  LoggerUtil.service('MetaOAuth', 'token_exchange', 'started');

  const result = await metaApiService.requestAbsolute({
    method: 'GET',
    url: `${graphApiBaseUrl()}/oauth/access_token`,
    params: {
      client_id: process.env.META_APP_ID,
      client_secret: process.env.META_APP_SECRET,
      redirect_uri: redirectUri,
      code,
    },
    context: 'meta_token_exchange',
  });

  // Deliberately logs only success/failure, never the token itself, never
  // the authorization code, never the client secret.
  LoggerUtil.service('MetaOAuth', 'token_exchange', result.success ? 'completed' : 'failed');

  return result;
}

/**
 * Exchanges the SHORT-lived user token the authorization-code exchange
 * returns (valid ~1–2 hours) for a LONG-lived one (~60 days) using Meta's
 * documented `grant_type=fb_exchange_token` on the same /oauth/access_token
 * endpoint (same Graph host + version as exchangeCodeForToken above, so it
 * honors META_GRAPH_API_VERSION identically).
 *
 * This is what makes the Page tokens obtained next durable: per Meta's
 * documentation a Page access token fetched via /me/accounts with a
 * long-lived user token does not expire, whereas one fetched with a
 * short-lived user token is itself short-lived — which would silently break
 * every post scheduled more than an hour or two ahead.
 *
 * Returns the same normalized { success, status, data, message } shape as
 * exchangeCodeForToken; data.access_token / data.expires_in are the
 * caller's responsibility to never log or return to the frontend. Only
 * success/failure is logged here.
 */
export async function exchangeForLongLivedToken(shortLivedToken) {
  LoggerUtil.service('MetaOAuth', 'long_lived_exchange', 'started');

  const result = await metaApiService.requestAbsolute({
    method: 'GET',
    url: `${graphApiBaseUrl()}/oauth/access_token`,
    params: {
      grant_type: 'fb_exchange_token',
      client_id: process.env.META_APP_ID,
      client_secret: process.env.META_APP_SECRET,
      fb_exchange_token: shortLivedToken,
    },
    context: 'meta_long_lived_exchange',
  });

  // A 200 without an access_token is as unusable as an error: report it as
  // a failure so no caller can persist an undefined/empty token.
  const usable = result.success && typeof result.data?.access_token === 'string' && result.data.access_token !== '';
  LoggerUtil.service('MetaOAuth', 'long_lived_exchange', usable ? 'completed' : 'failed');
  if (result.success && !usable) {
    return { success: false, kind: 'http', status: result.status, data: null, message: 'Meta returned no long-lived access token' };
  }
  return result;
}

/**
 * Fetches the ACTUALLY GRANTED permissions for a Meta user access token
 * via GET /me/permissions — requesting a scope in the authorization URL
 * does not guarantee Meta granted it (the user can decline individual
 * permissions on the consent screen, and Advanced Access permissions
 * like pages_manage_posts/instagram_content_publish are not guaranteed
 * even when requested). Never throws and never assumes the requested
 * scopes were granted on failure — returns an empty array instead, which
 * correctly leaves any dependent SocialAccount looking read-only-only
 * rather than falsely publish-ready.
 */
export async function fetchGrantedScopes(userAccessToken) {
  // metaApiService.request (the default export's property), not a named
  // import — this is the mockable form every other testable Graph-API
  // caller in this module already uses (metaPageService.js,
  // platformAdapters/*), which is what makes this function unit-testable
  // by substituting metaApiService.request for the duration of a test.
  const result = await metaApiService.request({
    method: 'GET',
    path: '/me/permissions',
    accessToken: userAccessToken,
    context: 'meta_fetch_granted_permissions',
  });

  if (!result.success) {
    LoggerUtil.service('MetaOAuth', 'fetch_granted_scopes', 'failed', { status: result.status });
    return [];
  }

  const granted = (result.data?.data || [])
    .filter((entry) => entry.status === 'granted')
    .map((entry) => entry.permission);

  LoggerUtil.service('MetaOAuth', 'fetch_granted_scopes', 'completed', { count: granted.length });
  return granted;
}

export default { META_OAUTH_SCOPES, buildAuthorizationUrl, exchangeCodeForToken, exchangeForLongLivedToken, fetchGrantedScopes };
