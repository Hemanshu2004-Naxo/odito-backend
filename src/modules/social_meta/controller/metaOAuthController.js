import { issueMetaOAuthState, consumeMetaOAuthState, readCookie, bindingCookieOptions, BINDING_COOKIE, BINDING_COOKIE_PATH } from '../service/metaOAuthStateService.js';
import { buildAuthorizationUrl, exchangeCodeForToken, exchangeForLongLivedToken, fetchGrantedScopes } from '../service/metaOAuthService.js';
import { inspectToken } from '../service/metaTokenService.js';
import { getFrontendUrl } from '../../../config/env.js';
import { getUserPages } from '../service/metaPageService.js';
import { discoverInstagramForPage } from '../service/metaInstagramService.js';
import { persistDiscoveredFacebookPages, enrichPagesWithConnectionState } from '../service/facebookAccountService.js';
import PendingMetaConnection, { PENDING_TTL_MS } from '../model/PendingMetaConnection.js';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { AuthUtil } from '../../../utils/AuthUtil.js';

/**
 * Meta OAuth controller — HTTP request/response handling only; all Graph
 * API/business logic lives in metaOAuthService.js / metaPageService.js /
 * metaInstagramService.js, all persistence logic in the model files
 * themselves (SocialAccount, PendingMetaConnection), matching
 * GoogleConnection.js's own precedent of controllers calling models
 * directly for straightforward CRUD rather than an extra service layer.
 *
 * Phase 1: /start, /callback — OAuth round-trip only, nothing persisted.
 * Phase 2: /callback persists the exchanged USER token into a short-lived
 * PendingMetaConnection (never the browser); /pages lists the user's
 * Facebook Pages; /pages/:pageId/select persists the selected Page's own
 * token into SocialAccount.
 * Phase 3 (this): /pages/:pageId/select now also runs Facebook -> Instagram
 * discovery immediately after the Facebook connection succeeds (best-effort
 * — its own failure never fails the Facebook connection), returning both
 * results together. /pages/:pageId/instagram/retry re-runs just the
 * Instagram half without requiring a fresh OAuth round-trip.
 */

const PROVIDER = 'meta';
const PURPOSE = 'social_meta';
const STATE_TTL_SECONDS = 10 * 60; // must match oauthState.js's STATE_TOKEN_TTL ('10m')

// Same fixed-map pattern as oauth.routes.js's RETURN_TARGETS — returnTo is
// NEVER interpolated directly into the redirect target, only ever used as
// a key into this map, so a tampered/arbitrary value can never produce an
// open redirect. 'profile' added so Settings -> Profile can be a second
// entry point into the exact same OAuth flow (Odito's own real-Google-
// equivalent, oauth.routes.js's RETURN_TARGETS, already supports a
// 'settings' target this way).
const RETURN_TARGETS = {
  social: '/app/social',
  profile: '/app/settings/profile',
  // Social Media AI module's Connect Accounts screen — it runs the same
  // Meta OAuth flow and then opens the Page selector there.
  'social-media': '/app/social-media/connect-accounts',
};
const DEFAULT_RETURN_PATH = '/app/social';


function metaRedirectUri() {
  return process.env.META_REDIRECT_URI;
}

/**
 * The frontend origin is resolved PER CALL via config/env.js's
 * getFrontendUrl() — never captured at import time. A module-level
 * `process.env.CORS_ORIGIN` here used to be evaluated before dotenv ran, so
 * with env supplied by .env every post-OAuth redirect went to
 * http://localhost:3000. In production a missing CORS_ORIGIN throws (no
 * silent localhost fallback), which this turns into a 500 rather than
 * redirecting a real user to localhost.
 */
function redirectToSocialPage(res, { connected, error, returnTo } = {}) {
  let frontendUrl;
  try {
    frontendUrl = getFrontendUrl();
  } catch (configError) {
    LoggerUtil.error('[META_OAUTH] Frontend URL is not configured', { message: configError.message }, {});
    return res.status(500).send('Server configuration error: the frontend URL is not configured.');
  }
  const path = RETURN_TARGETS[returnTo] || DEFAULT_RETURN_PATH;
  const url = new URL(path, frontendUrl);
  if (connected) url.searchParams.set('meta_connected', '1');
  if (error) url.searchParams.set('meta_error', error);
  return res.redirect(url.toString());
}

/**
 * STEP 1: GET /api/social/meta/start
 * Requires auth + validateProjectAccess() (applied in the route, not
 * here) — req.project/req.projectId are already verified by the time this
 * runs, matching the validateProjectAccess() middleware's contract used
 * elsewhere in this codebase rather than re-implementing Google's own
 * inline ownership check.
 */
export async function startMetaConnection(req, res) {
  try {
    if (!metaRedirectUri()) {
      LoggerUtil.error('[META_OAUTH] META_REDIRECT_URI is not configured', {}, {});
      return res.status(500).json(ResponseUtil.error('Meta connection is not configured on this server'));
    }

    const { returnTo } = req.query;
    const userId = req.user._id.toString();
    // Explicit opt-in only — see buildAuthorizationUrl's own comment for
    // why this must never be the default for a normal Connect.
    const reconnect = req.query.reconnect === 'true';

    // A one-time, unpredictable state whose owner / project / return target live on the server (metaOAuthStateService.js), plus a secret for
    // the initiating browser's httpOnly cookie that the callback must present when the browser sends it.
    const { state, bindingSecret } = await issueMetaOAuthState({
      userId,
      projectId: req.projectId,
      returnTo: returnTo && Object.prototype.hasOwnProperty.call(RETURN_TARGETS, returnTo) ? returnTo : null,
    });
    if (typeof res.cookie === 'function') res.cookie(BINDING_COOKIE, bindingSecret, bindingCookieOptions());

    const url = buildAuthorizationUrl({ redirectUri: metaRedirectUri(), state, reconnect });

    // Safe diagnostic — parsed back out of the URL just built, so this can
    // never drift from what's actually sent to Meta. appId is not a
    // secret (it's already public in this same URL, visible in any
    // browser network tab); never client_secret/access_token/code/state's
    // signed contents. Lets a real "does the request Meta received match
    // what Odito intended to send" question be answered from logs alone —
    // e.g. confirming appId/redirectUri/scopes were unchanged across a
    // "used to work, now doesn't" report like Meta's "App not active".
    const parsedUrl = new URL(url);
    LoggerUtil.info('META_OAUTH_START', {
      userId,
      projectId: req.projectId,
      appId: parsedUrl.searchParams.get('client_id'),
      redirectUri: parsedUrl.searchParams.get('redirect_uri'),
      apiVersion: parsedUrl.pathname.split('/')[1] || null,
      scopes: parsedUrl.searchParams.get('scope'),
      authType: parsedUrl.searchParams.get('auth_type'),
      reconnect,
    });

    LoggerUtil.service('MetaOAuth', 'start', 'completed', { projectId: req.projectId });

    return res.json(ResponseUtil.success({ url }));
  } catch (error) {
    LoggerUtil.error('[META_OAUTH] Failed to build Meta consent URL', { message: error.message }, {});
    return res.status(500).json(ResponseUtil.error('Failed to start Meta connection'));
  }
}

/**
 * STEP 2: GET /api/social/meta/callback — PUBLIC (Meta redirects the
 * browser here directly; no Authorization header is available).
 */
export async function handleMetaCallback(req, res) {
  let decodedState = null;

  try {
    const { code, state, error, error_reason: errorReason, error_description: errorDescription } = req.query;

    // Meta's own consent-denial path: the user clicked "Cancel" on the
    // Facebook dialog. This is a normal, expected outcome, not a bug —
    // logged at info level, never treated as a server error.
    if (error) {
      LoggerUtil.service('MetaOAuth', 'callback', 'denied', { error, errorReason });
      // error_description is Meta's own free-text explanation — never
      // forwarded to the frontend query string (Section 5's explicit
      // "never send the raw Meta error message" requirement); only a
      // stable internal code.
      void errorDescription;
      return redirectToSocialPage(res, { error: 'access_denied' });
    }

    if (!code || !state) {
      LoggerUtil.service('MetaOAuth', 'callback', 'rejected', { reason: 'missing_code_or_state' });
      return redirectToSocialPage(res, { error: 'invalid_request' });
    }

    // Validate AND consume the state BEFORE the code is ever exchanged (Section 5, requirement #2): a tampered, expired, unknown, already-used
    // (replayed) or wrong-browser state is refused outright and never silently degrades. It can be used exactly once.
    const consumed = await consumeMetaOAuthState(state, { bindingSecret: readCookie(req, BINDING_COOKIE) });
    if (typeof res.clearCookie === 'function') res.clearCookie(BINDING_COOKIE, { path: BINDING_COOKIE_PATH });
    if (!consumed.ok) {
      LoggerUtil.service('MetaOAuth', 'callback', 'rejected', { reason: `state_${consumed.reason}` });
      const code = ['wrong_provider', 'binding_mismatch', 'binding_missing'].includes(consumed.reason) ? 'invalid_request' : 'expired_or_invalid_request';
      return redirectToSocialPage(res, { error: code });
    }
    decodedState = { projectId: consumed.projectId, userId: consumed.userId, returnTo: consumed.returnTo };
    const { projectId, userId, returnTo } = decodedState;

    // Re-check ownership at callback time too (Section 5, requirement #4)
    // — mirrors oauth.routes.js's own "defense in depth" comment exactly:
    // /start already checked this when the state was minted, but the
    // state is a bearer token for the next ~10 minutes, so a project
    // deleted, transferred, or soft-deleted in between must still be
    // caught here.
    //
    // Reuses AuthUtil.validateProjectAccess(userId, projectId) — the exact
    // same centralized helper validateProjectAccess() middleware calls for
    // /start — rather than a second, weaker ad hoc query. It's a plain
    // (userId, projectId) -> project function with no dependency on
    // req/res, so it's safe to call directly from this public callback
    // route. It excludes soft-deleted projects
    // (SeoProject.findOne({ _id, is_deleted: { $ne: true } })) the same
    // way /start already does — a security fix: the previous
    // SeoProject.findById(projectId) here did NOT exclude soft-deleted
    // projects, so a project soft-deleted in the ~10-minute window between
    // /start and this callback could still complete the flow. Any
    // rejection here (not found, soft-deleted, wrong owner, or a
    // malformed projectId that fails to cast) happens BEFORE
    // exchangeCodeForToken() is ever called.
    try {
      await AuthUtil.validateProjectAccess(userId, projectId);
    } catch (ownershipError) {
      LoggerUtil.service('MetaOAuth', 'callback', 'rejected', {
        reason: 'project_ownership_check_failed',
        errorType: ownershipError.type || 'UNKNOWN',
      });
      return redirectToSocialPage(res, { error: 'access_denied', returnTo });
    }

    // Safe diagnostic — the projectId/userId THIS callback is about to
    // persist against, decoded straight from the signed state (never from
    // req.body/req.query). Cross-check against META_OAUTH_START's log line
    // for the same OAuth attempt if a connection ever appears "successful"
    // but isn't retrievable afterward.
    LoggerUtil.info('META_OAUTH_CALLBACK', { userId, projectId });

    const exchangeResult = await exchangeCodeForToken({ code, redirectUri: metaRedirectUri() });

    if (!exchangeResult.success) {
      // exchangeCodeForToken already logged the real reason server-side
      // (via metaApiService's normalizeError) — never forward Meta's raw
      // error text to the frontend query string.
      LoggerUtil.service('MetaOAuth', 'callback', 'token_exchange_failed', { projectId });
      return redirectToSocialPage(res, { error: 'connection_failed', returnTo });
    }

    // Trade the short-lived (~1–2h) user token for a long-lived (~60d) one
    // BEFORE anything is discovered or persisted: Page tokens fetched later
    // with a long-lived user token don't expire, while ones fetched with a
    // short-lived token do — which would break any post scheduled further
    // out than an hour or two. A failed exchange fails the whole connection
    // (never silently continues with the short-lived token).
    const longLived = await exchangeForLongLivedToken(exchangeResult.data.access_token);
    if (!longLived.success) {
      LoggerUtil.service('MetaOAuth', 'callback', 'long_lived_exchange_failed', { projectId });
      return redirectToSocialPage(res, { error: 'connection_failed', returnTo });
    }
    const userAccessToken = longLived.data.access_token;

    // The exchange succeeded — hold the USER access token server-side only
    // (Section 2: never the redirect URL, frontend JSON, or React state)
    // until the user finishes Page selection. Upserting on the
    // (user_id, project_id) unique index means a repeat OAuth attempt for
    // the same project simply replaces any prior pending record rather
    // than accumulating stale ones; `pages` is reset to [] here
    // deliberately — a fresh token may carry different permissions than
    // whatever was cached before, so Page List must re-discover rather
    // than trust an old cache.
    const expiresInSeconds = Number(longLived.data?.expires_in);
    const tokenExpiresAt = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
      ? new Date(Date.now() + expiresInSeconds * 1000)
      : null;

    // The ACTUALLY granted permissions, not the requested list —
    // requesting pages_manage_posts/instagram_content_publish never
    // guarantees Meta granted them (see fetchGrantedScopes's own
    // comment). Falls back to an empty array on failure, never to
    // META_OAUTH_SCOPES — an empty/partial grant must never be silently
    // treated as a full one.
    const grantedScopes = await fetchGrantedScopes(userAccessToken);

    await PendingMetaConnection.findOneAndUpdate(
      { user_id: userId, project_id: projectId },
      {
        $set: {
          user_id: userId,
          project_id: projectId,
          userAccessToken,
          tokenExpiresAt,
          scopes: grantedScopes,
          pages: [],
          expiresAt: new Date(Date.now() + PENDING_TTL_MS),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
    );

    LoggerUtil.service('MetaOAuth', 'callback', 'completed', { projectId });

    return redirectToSocialPage(res, { connected: true, returnTo });
  } catch (err) {
    LoggerUtil.error('[META_OAUTH] Callback error', { message: err.message }, {});
    return redirectToSocialPage(res, { error: 'connection_failed', returnTo: decodedState?.returnTo });
  }
}

/**
 * Loads the caller's pending Meta connection, treating an
 * already-past-expiry record the same as "none exists" (the TTL index
 * purges these in the background, but that deletion isn't instantaneous,
 * so this check must not rely on it having already happened). Returns
 * null — never throws — when there is nothing usable; callers turn that
 * into a stable METHOD-level error response.
 */
async function loadActivePendingConnection(userId, projectId) {
  const pending = await PendingMetaConnection.findOne({ user_id: userId, project_id: projectId });
  if (!pending) return null;
  if (pending.expiresAt.getTime() <= Date.now()) {
    await PendingMetaConnection.deleteOne({ _id: pending._id });
    return null;
  }
  return pending;
}

/**
 * STEP 3: GET /api/social/meta/pages?projectId=
 * Requires auth + validateProjectAccess() (applied in the route). Lists
 * the Facebook Pages available to the pending connection's USER token,
 * discovering them via metaPageService.getUserPages on first call and
 * caching the result on the pending record so Page Selection never needs
 * a second Graph API round-trip. Only ever returns safe display fields —
 * `accessToken` is never present on the response, whether zero, one, or
 * many Pages are found (zero Pages is a normal result, not an error).
 */
export async function getMetaPages(req, res) {
  const userId = req.user._id.toString();
  const projectId = req.projectId;

  try {
    const pending = await loadActivePendingConnection(userId, projectId);
    if (!pending) {
      LoggerUtil.service('MetaPages', 'list', 'no_pending_connection', { projectId });
      return res.status(409).json(
        ResponseUtil.error('No active Meta connection found for this project. Please connect again.', 409, { code: 'META_CONNECTION_FAILED' }),
      );
    }

    if (pending.pages.length === 0) {
      const result = await getUserPages(pending.userAccessToken);
      if (!result.success) {
        LoggerUtil.service('MetaPages', 'list', 'discovery_failed', { projectId, code: result.error?.code });
        return res.status(502).json(ResponseUtil.error(result.error.message, 502, { code: result.error.code }));
      }

      pending.pages = result.pages;
      await pending.save();
    }

    const safePages = pending.pages.map((page) => ({
      id: page.id,
      name: page.name,
      category: page.category,
      picture: page.picture,
    }));

    // Cross-referenced against this project's already-persisted
    // SocialAccount rows in one $in query (see enrichPagesWithConnectionState's
    // own comment) — never a per-Page lookup, so this stays a single extra
    // query regardless of whether Meta returned 1 or 19 Pages. `safePages`
    // already has accessToken stripped before this ever runs.
    const enrichedPages = await enrichPagesWithConnectionState({ projectId, pages: safePages });

    LoggerUtil.service('MetaPages', 'list', 'completed', { projectId, pageCount: enrichedPages.length });
    return res.json(ResponseUtil.success({ pages: enrichedPages }));
  } catch (error) {
    LoggerUtil.error('[META_PAGES] Failed to list Pages', { message: error.message }, { projectId });
    return res.status(500).json(ResponseUtil.error('Failed to load Facebook Pages', 500, { code: 'META_PAGES_FETCH_FAILED' }));
  }
}

/**
 * STEP 4: POST /api/social/meta/pages/:pageId/select
 * Body: { projectId } only — the client NEVER sends an access token here.
 * The requested pageId is validated against the pending connection's own
 * cached /me/accounts result (never trusted as an arbitrary ID), so this
 * can never be used to connect a Page belonging to a different Meta user
 * than the one who completed this OAuth flow. Persists the PAGE token
 * (never the user token) into SocialAccount, then discards the pending
 * connection.
 */
export async function selectMetaPage(req, res) {
  const userId = req.user._id.toString();
  const projectId = req.projectId;
  const { pageId } = req.params;

  try {
    const pending = await loadActivePendingConnection(userId, projectId);
    if (!pending) {
      LoggerUtil.service('MetaPageSelect', 'select', 'no_pending_connection', { projectId });
      return res.status(409).json(
        ResponseUtil.error('No active Meta connection found for this project. Please connect again.', 409, { code: 'META_CONNECTION_FAILED' }),
      );
    }

    const selectedPage = pending.pages.find((page) => page.id === pageId);
    if (!selectedPage) {
      // Covers both "typo'd/unknown Page ID" and "a real Page ID the
      // client supplied that this Meta user's /me/accounts never
      // returned" — both are indistinguishable from here, and both must
      // be rejected identically.
      LoggerUtil.service('MetaPageSelect', 'select', 'page_not_in_connection', { projectId, pageId });
      return res.status(404).json(
        ResponseUtil.error('That Page is not available to this Meta connection.', 404, { code: 'META_PAGE_NOT_FOUND' }),
      );
    }

    const pageAccessToken = selectedPage.accessToken;
    if (!pageAccessToken) {
      LoggerUtil.service('MetaPageSelect', 'select', 'page_missing_token', { projectId, pageId });
      return res.status(502).json(
        ResponseUtil.error('Meta did not provide access for that Page.', 502, { code: 'META_PAGE_ACCESS_DENIED' }),
      );
    }

    // Ask Meta (debug_token) about the Page token we're about to store: this
    // is where the REAL expiry is learned (a Page token derived from a
    // long-lived user token reports expires_at 0 = never) and where a token
    // Meta already considers dead is refused instead of being persisted as
    // "connected". If the check itself can't complete (Meta unreachable) the
    // connection still proceeds — an outage must not block connecting — and
    // lastVerifiedAt simply stays null until a later verification.
    const inspection = await inspectToken(pageAccessToken);
    if (inspection.success && !inspection.valid) {
      LoggerUtil.service('MetaPageSelect', 'select', 'page_token_invalid', { projectId, pageId, reason: inspection.reason });
      return res.status(502).json(
        ResponseUtil.error('Meta did not provide valid access for that Page.', 502, { code: 'META_PAGE_ACCESS_DENIED' }),
      );
    }

    // Switch Account feature: persist EVERY Page this OAuth grant
    // discovered (not just the one clicked) — the others become instantly
    // switchable later without a second OAuth round-trip. The clicked
    // Page becomes the project's active Facebook Page; any pre-existing
    // Pages from an earlier, separate connection that aren't part of THIS
    // batch are left completely untouched (union, not replace — see
    // persistDiscoveredFacebookPages's own comment).
    const { savedCount, activeAccount } = await persistDiscoveredFacebookPages({
      userId,
      projectId,
      pages: pending.pages,
      selectedPageId: selectedPage.id,
      inspection: inspection.success ? inspection : null,
      // The scopes ACTUALLY granted for this connection (fetched from
      // Meta at callback time — see handleMetaCallback), never the
      // requested META_OAUTH_SCOPES list.
      scopes: pending.scopes,
    });

    if (!activeAccount) {
      LoggerUtil.error('[META_PAGE_SELECT] Failed to activate the selected Page after persisting', {}, { projectId, pageId });
      return res.status(500).json(ResponseUtil.error('Failed to connect that Page', 500, { code: 'META_CONNECTION_FAILED' }));
    }

    await PendingMetaConnection.deleteOne({ _id: pending._id });

    LoggerUtil.service('MetaPageSelect', 'select', 'completed', { projectId, pageId, pagesPersisted: savedCount });
    // Safe diagnostic — confirms, independent of the HTTP response the
    // frontend receives, that the write this request just performed is
    // actually the document a later status lookup will find (same
    // project_id, same connectionId). Never the token.
    LoggerUtil.info('META_CONNECTION_PERSISTED', {
      connectionId: activeAccount.id,
      userId,
      projectId,
      pageId: activeAccount.providerAccountId,
      provider: 'facebook',
      status: activeAccount.status,
    });

    // Phase 3: Instagram discovery runs automatically right after a
    // successful Facebook connection, but is deliberately best-effort —
    // its own failures (no linked account, access denied, a Meta API
    // error) never turn this response into a failure. The Facebook
    // connection above is already real and already persisted by this
    // point regardless of what happens next.
    const instagramResult = await discoverInstagramForPage({ projectId, pageId: selectedPage.id });

    return res.json(ResponseUtil.success({
      facebook: {
        connected: true,
        accountId: activeAccount.providerAccountId,
        accountName: activeAccount.name,
      },
      instagram: instagramResult.connected
        ? { connected: true, accountId: instagramResult.accountId, username: instagramResult.username }
        : { connected: false, reason: instagramResult.reason },
    }));
  } catch (error) {
    LoggerUtil.error('[META_PAGE_SELECT] Failed to select Page', { message: error.message }, { projectId, pageId });
    return res.status(500).json(ResponseUtil.error('Failed to connect that Page', 500, { code: 'META_CONNECTION_FAILED' }));
  }
}

/**
 * POST /api/social/meta/pages/:pageId/instagram/retry
 * Body: { projectId } only. Re-runs Instagram discovery for an already-
 * connected Facebook Page without touching the Facebook connection or
 * requiring a fresh OAuth round-trip — needed because a successful
 * selectMetaPage call discards its PendingMetaConnection regardless of
 * whether Instagram discovery succeeded, so a frontend "Retry" action
 * after a discovery failure has nothing pending left to reuse.
 * discoverInstagramForPage re-derives the Page token from the already-
 * persisted, encrypted Facebook SocialAccount, so this call carries no
 * token of its own — same trust boundary as the automatic run above.
 */
export async function retryInstagramDiscovery(req, res) {
  const projectId = req.projectId;
  const { pageId } = req.params;

  try {
    const instagramResult = await discoverInstagramForPage({ projectId, pageId });

    return res.json(ResponseUtil.success({
      instagram: instagramResult.connected
        ? { connected: true, accountId: instagramResult.accountId, username: instagramResult.username }
        : { connected: false, reason: instagramResult.reason },
    }));
  } catch (error) {
    LoggerUtil.error('[META_INSTAGRAM_RETRY] Failed to retry Instagram discovery', { message: error.message }, { projectId, pageId });
    return res.status(500).json(ResponseUtil.error('Failed to check for a linked Instagram account', 500, { code: 'META_INSTAGRAM_DISCOVERY_FAILED' }));
  }
}

export default { startMetaConnection, handleMetaCallback, getMetaPages, selectMetaPage, retryInstagramDiscovery };
