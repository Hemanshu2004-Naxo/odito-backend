import express from "express";
import { OAuth2Client } from "google-auth-library";
import User from "../model/User.js";
import GoogleConnection, { encryptToken } from "../../app_user/model/GoogleConnection.js";
import SeoProject from "../../app_user/model/SeoProject.js";
import { formatSubscriptionForResponse } from "../service/authService.js";
import { signAuthToken } from "../service/tokenService.js";
import { issueSessionBundle } from "../service/refreshTokenService.js";
import { normalizeAuthEmail } from "../utils/authEmail.js";
import { buildGoogleAudiences } from "../config/googleAudiences.js";
import { googleCallbackLimiter } from "../middleware/authRateLimiters.js";
import { AuthUtil } from "../../../utils/AuthUtil.js";
import { LoggerUtil } from "../../../utils/LoggerUtil.js";
import auth from "../middleware/auth.js";
import { signGoogleVisibilityState, verifyGoogleVisibilityState } from "../../../utils/oauthState.js";
import {
  getAccountConnectionStatus,
  disconnectAccountGoogleConnections,
  getProjectGoogleServiceConnections,
  disconnectProjectGoogleConnection,
} from "../../app_user/service/googleAccountConnectionService.js";
import { clearCacheForConnection } from "../../../services/businessProfileService.js";
import { clearAnalyticsCacheForConnection } from "../../../services/analyticsService.js";
import { clearCacheForGoogleAdsConnection } from "../../../services/googleAdsService.js";

const router = express.Router();

for (const key of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_OAUTH_REDIRECT", "JWT_SECRET"]) {
  if (!process.env[key]) {
    console.warn(`[GOOGLE_OAUTH] Missing required env var: ${key}`);
  }
}

const googleClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_OAUTH_REDIRECT
);

// Legacy bundle scopes — no longer requested by any route (kept only so the
// history/intent below stays legible; new connections always use one of the
// three per-service scope lists further down). One GoogleConnection used to
// be shared across Search Console, Analytics and Business Profile (see
// GoogleConnection.service_type), requesting all three scopes in a single
// consent screen. Each service now gets its own scope list and its own
// consent screen instead, exactly like google_ads already did below.
const GOOGLE_VISIBILITY_SCOPES = [
  "openid",
  "profile",
  "email",
  "https://www.googleapis.com/auth/business.manage",
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/analytics.readonly"
];

// Per-service scope lists — deliberately independent of each other and of
// GOOGLE_ADS_SCOPES below (least-privilege OAuth): connecting Analytics must
// never also request Search Console's or Business Profile's scope, and vice
// versa, so each has its own consent screen and its own GoogleConnection row
// (purpose: 'search_console' | 'analytics' | 'business_profile').
const GOOGLE_SEARCH_CONSOLE_SCOPES = [
  "openid",
  "profile",
  "email",
  "https://www.googleapis.com/auth/webmasters.readonly"
];

const GOOGLE_ANALYTICS_SCOPES = [
  "openid",
  "profile",
  "email",
  "https://www.googleapis.com/auth/analytics.readonly"
];

const GOOGLE_BUSINESS_PROFILE_SCOPES = [
  "openid",
  "profile",
  "email",
  "https://www.googleapis.com/auth/business.manage"
];

// Scopes for the separate "google_ads" connection (purpose: 'google_ads' on
// GoogleConnection). Deliberately its own consent screen rather than folded
// into GOOGLE_VISIBILITY_SCOPES above: the `adwords` scope is requested by
// only a subset of users, and bundling it in would force every existing
// Search Console/Analytics/Business Profile connection to re-consent the
// next time it refreshes. Same OAuth2Client, same client ID/secret, same
// redirect URI — only the scope list and the resulting GoogleConnection
// row (purpose: 'google_ads') differ.
const GOOGLE_ADS_SCOPES = [
  "openid",
  "profile",
  "email",
  "https://www.googleapis.com/auth/adwords"
];

// Signing/verification of the short-lived state token now lives in
// utils/oauthState.js so it can be unit tested without pulling in this
// route's full dependency graph (User/GoogleConnection/SeoProject/mailers).
const signState = signGoogleVisibilityState;
const verifyState = verifyGoogleVisibilityState;

const FRONTEND_URL = process.env.CORS_ORIGIN || "http://localhost:3000";

// The google_visibility flow is reached by the browser navigating directly to
// this backend's callback URL (Google redirects here, not to the frontend),
// so success/error must be communicated via an HTTP redirect back into the
// app rather than a JSON body the browser would otherwise just display raw.
//
// `returnTo` is never interpolated directly into the redirect target — it's
// only ever a key into this fixed map, so a tampered/arbitrary value can
// never turn this into an open redirect. Default (no returnTo, or an
// unrecognized one) lands on the Google Visibility Overview page.
// Route moved from /googleVisibility to /google-visibility as part of the
// navigation-group refactor (Google Visibility now has its own sidebar
// section with Overview/Business Profile/Search Console/Analytics pages) -
// this must stay in sync with app/(dashboard)/google-visibility/page.jsx.
const RETURN_TARGETS = {
  settings: "/settings/profile",
};

function redirectToVisibilityPage(res, { connected, error, projectId, returnTo } = {}) {
  const path = RETURN_TARGETS[returnTo] || "/google-visibility";
  const url = new URL(path, FRONTEND_URL);
  if (connected) url.searchParams.set("google_connected", "1");
  if (error) url.searchParams.set("google_error", error);
  if (projectId) url.searchParams.set("projectId", projectId);
  return res.redirect(url.toString());
}

/**
 * STEP 1: Start the Google Visibility connection flow.
 *
 * Requires an authenticated Odito session (Bearer token) and a projectId the
 * caller owns. Returns the Google consent URL as JSON - the dashboard is
 * expected to call this via an authenticated fetch() and then navigate the
 * browser to `data.url` itself, since a bare <a href> navigation cannot carry
 * an Authorization header.
 */
router.get("/google/start", auth, async (req, res) => {
  try {
    const { projectId, returnTo } = req.query;

    if (!projectId) {
      return res.status(400).json({ success: false, message: "projectId is required" });
    }

    const project = await SeoProject.findById(projectId);
    if (!project) {
      return res.status(404).json({ success: false, message: "Project not found" });
    }
    if (project.user_id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const state = signState({
      purpose: "google_visibility",
      projectId: project._id.toString(),
      userId: req.user._id.toString(),
      // Optional — only ever read back through RETURN_TARGETS' fixed map
      // (see redirectToVisibilityPage), never used as a raw redirect target.
      ...(returnTo ? { returnTo } : {}),
    });

    const url = googleClient.generateAuthUrl({
      redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT,
      response_type: "code",
      access_type: "offline",
      scope: GOOGLE_VISIBILITY_SCOPES,
      // "consent" guarantees Google re-issues a refresh_token even on a repeat
      // connection (Google only issues one on the very first grant otherwise).
      prompt: "consent select_account",
      state
    });

    return res.json({ success: true, data: { url } });
  } catch (error) {
    console.error("[GOOGLE_OAUTH] Failed to build consent URL:", error.message);
    return res.status(500).json({ success: false, message: "Failed to start Google connection" });
  }
});

/**
 * STEP 1 (Google Ads variant): Start the Google Ads connection flow.
 *
 * Identical shape to /google/start above — same auth requirement, same
 * project-ownership check, same signed-state mechanism — differing only in
 * the scope list (GOOGLE_ADS_SCOPES) and the `purpose` embedded in the
 * state token ("google_ads" instead of "google_visibility"). The callback
 * is NOT duplicated: both flows land on the same /google/callback below,
 * which branches on state.purpose exactly like it already does for
 * "user_login" vs "google_visibility".
 */
router.get("/google-ads/start", auth, async (req, res) => {
  try {
    const { projectId, returnTo } = req.query;

    if (!projectId) {
      return res.status(400).json({ success: false, message: "projectId is required" });
    }

    const project = await SeoProject.findById(projectId);
    if (!project) {
      return res.status(404).json({ success: false, message: "Project not found" });
    }
    if (project.user_id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const state = signState({
      purpose: "google_ads",
      projectId: project._id.toString(),
      userId: req.user._id.toString(),
      ...(returnTo ? { returnTo } : {}),
    });

    const url = googleClient.generateAuthUrl({
      redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT,
      response_type: "code",
      access_type: "offline",
      scope: GOOGLE_ADS_SCOPES,
      prompt: "consent select_account",
      state
    });

    return res.json({ success: true, data: { url } });
  } catch (error) {
    console.error("[GOOGLE_OAUTH] Failed to build Google Ads consent URL:", error.message);
    return res.status(500).json({ success: false, message: "Failed to start Google Ads connection" });
  }
});

/**
 * STEP 1 (per-service variants): Search Console / Analytics / Business
 * Profile each get their own start route, identical in shape to
 * /google-ads/start above — same auth requirement, same project-ownership
 * check, same signed-state mechanism — differing only in scope list and the
 * `purpose` embedded in the state token. Callback handling for all three
 * lives in the shared /google/callback below, branching on state.purpose
 * exactly like google_ads already does.
 */
function buildServiceStartHandler(purpose, scopes) {
  return async (req, res) => {
    try {
      const { projectId, returnTo } = req.query;

      if (!projectId) {
        return res.status(400).json({ success: false, message: "projectId is required" });
      }

      const project = await SeoProject.findById(projectId);
      if (!project) {
        return res.status(404).json({ success: false, message: "Project not found" });
      }
      if (project.user_id.toString() !== req.user._id.toString()) {
        return res.status(403).json({ success: false, message: "Access denied" });
      }

      const state = signState({
        purpose,
        projectId: project._id.toString(),
        userId: req.user._id.toString(),
        ...(returnTo ? { returnTo } : {}),
      });

      const url = googleClient.generateAuthUrl({
        redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT,
        response_type: "code",
        access_type: "offline",
        scope: scopes,
        // "select_account" forces Google's account chooser even when the
        // browser already has an active Google session — this is also what
        // "Change Account" reuses (same route, no separate endpoint).
        prompt: "consent select_account",
        state
      });

      return res.json({ success: true, data: { url } });
    } catch (error) {
      console.error(`[GOOGLE_OAUTH] Failed to build ${purpose} consent URL:`, error.message);
      return res.status(500).json({ success: false, message: `Failed to start ${purpose} connection` });
    }
  };
}

router.get("/google-search-console/start", auth, buildServiceStartHandler("search_console", GOOGLE_SEARCH_CONSOLE_SCOPES));
router.get("/google-analytics/start", auth, buildServiceStartHandler("analytics", GOOGLE_ANALYTICS_SCOPES));
router.get("/google-business-profile/start", auth, buildServiceStartHandler("business_profile", GOOGLE_BUSINESS_PROFILE_SCOPES));

// STEP 2: Google callback (GET - browser redirect flow)
router.get("/google/callback", async (req, res) => {
  // Hoisted so the outer catch block knows whether to respond with a
  // redirect (google_visibility, a browser-driven flow) or JSON
  // (user_login, a legacy direct-hit path with no frontend page to land on).
  let purpose = "user_login";
  let decodedState = null;

  try {
    const { code, state } = req.query;

    if (!code) {
      return res.status(400).json({ success: false, message: "Authorization code is required" });
    }

    // A state is only present for flows this backend itself initiated
    // (/google/start). If present, it MUST verify - a tampered or expired
    // state is rejected outright rather than silently falling back to
    // "user_login", which previously allowed an attacker-controlled purpose.
    if (state) {
      try {
        decodedState = verifyState(state);
        purpose = decodedState?.purpose || "user_login";
      } catch (stateError) {
        console.warn("[GOOGLE_OAUTH] Rejected callback: invalid or expired state:", stateError.message);
        return redirectToVisibilityPage(res, { error: "expired_or_invalid_request" });
      }
    }

    const exchangeClient = new OAuth2Client(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_OAUTH_REDIRECT
    );

    let tokens;
    try {
      const tokenResponse = await exchangeClient.getToken(code);
      tokens = tokenResponse.tokens;
    } catch (tokenError) {
      console.error("[GOOGLE_OAUTH] Token exchange failed:", tokenError.message);
      throw tokenError;
    }

    const getAud = buildGoogleAudiences();
    const ticket = await exchangeClient.verifyIdToken({
      idToken: tokens.id_token,
      // Configured -> strict allow-list (now incl. mobile client IDs).
      // Nothing configured (a broken deploy: GOOGLE_CLIENT_ID also unset) ->
      // undefined, i.e. the same permissive behaviour this line had before.
      audience: getAud.length ? getAud : undefined
    });
    const googleUser = ticket.getPayload();

    if (purpose === "google_visibility") {
      const { projectId, userId, returnTo } = decodedState;

      // Defense in depth: re-validate project ownership at callback time even
      // though /google/start already checked it when the state was minted.
      const project = await SeoProject.findById(projectId);
      if (!project || project.user_id.toString() !== userId) {
        console.warn("[GOOGLE_OAUTH] Rejected callback: project/user mismatch", { projectId, userId });
        return redirectToVisibilityPage(res, { error: "access_denied", projectId, returnTo });
      }

      if (!tokens.refresh_token) {
        return redirectToVisibilityPage(res, { error: "no_refresh_token", projectId, returnTo });
      }

      try {
        const connection = await GoogleConnection.findOneAndUpdate(
          { user_id: userId, project_id: projectId, purpose: "google_visibility" },
          {
            $set: {
              refresh_token: encryptToken(tokens.refresh_token),
              access_token: encryptToken(tokens.access_token),
              token_expires_at: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
              google_email: googleUser.email,
              google_name: googleUser.name,
              google_avatar: googleUser.picture,
              status: "active",
              last_used_at: new Date(),
              connected_at: new Date()
            }
          },
          { upsert: true, new: true, runValidators: true }
        );

        // Reconnecting reuses the same GoogleConnection._id even when the
        // underlying Google account is different (matched on
        // user_id+project_id+purpose, not Google identity) - without this,
        // Business Profile's and Analytics' in-memory caches would keep
        // serving data cached under the previous Google account. Each
        // service clears only its own cache prefixes (see
        // clearAnalyticsCacheForConnection's own doc comment) rather than
        // one function reaching into another service's cache namespace.
        if (connection?._id) {
          const connectionId = connection._id.toString();
          clearCacheForConnection(connectionId);
          clearAnalyticsCacheForConnection(connectionId);
        }

        return redirectToVisibilityPage(res, { connected: true, projectId, returnTo });
      } catch (dbError) {
        if (dbError.code === 11000) {
          return redirectToVisibilityPage(res, { connected: true, projectId, returnTo });
        }
        console.error("[GOOGLE_OAUTH] Database error saving connection:", dbError.message);
        return redirectToVisibilityPage(res, { error: "save_failed", projectId, returnTo });
      }
    }

    if (purpose === "google_ads") {
      const { projectId, userId, returnTo } = decodedState;

      // Defense in depth: re-validate project ownership at callback time even
      // though /google-ads/start already checked it when the state was minted.
      const project = await SeoProject.findById(projectId);
      if (!project || project.user_id.toString() !== userId) {
        console.warn("[GOOGLE_OAUTH] Rejected Google Ads callback: project/user mismatch", { projectId, userId });
        return redirectToVisibilityPage(res, { error: "access_denied", projectId, returnTo });
      }

      if (!tokens.refresh_token) {
        return redirectToVisibilityPage(res, { error: "no_refresh_token", projectId, returnTo });
      }

      try {
        // service_type is deliberately left untouched here (defaults to []
        // on first insert) — same reasoning as the google_visibility branch
        // above: it's populated once the customer/account selection step
        // ships, not at token-exchange time.
        const adsConnection = await GoogleConnection.findOneAndUpdate(
          { user_id: userId, project_id: projectId, purpose: "google_ads" },
          {
            $set: {
              refresh_token: encryptToken(tokens.refresh_token),
              access_token: encryptToken(tokens.access_token),
              token_expires_at: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
              google_email: googleUser.email,
              google_name: googleUser.name,
              google_avatar: googleUser.picture,
              status: "active",
              last_used_at: new Date(),
              connected_at: new Date()
            }
          },
          { upsert: true, new: true, runValidators: true }
        );

        // Same reasoning as the google_visibility branch above: reconnecting
        // reuses this GoogleConnection._id even if the underlying Google
        // identity changed, so any cached accounts/campaigns keyed by that
        // _id must be dropped rather than silently served under a new identity.
        if (adsConnection?._id) {
          clearCacheForGoogleAdsConnection(adsConnection._id.toString());
        }

        return redirectToVisibilityPage(res, { connected: true, projectId, returnTo });
      } catch (dbError) {
        if (dbError.code === 11000) {
          return redirectToVisibilityPage(res, { connected: true, projectId, returnTo });
        }
        console.error("[GOOGLE_OAUTH] Database error saving Google Ads connection:", dbError.message);
        return redirectToVisibilityPage(res, { error: "save_failed", projectId, returnTo });
      }
    }

    if (purpose === "search_console" || purpose === "analytics" || purpose === "business_profile") {
      const { projectId, userId, returnTo } = decodedState;

      // Defense in depth: re-validate project ownership at callback time even
      // though the /google-<service>/start route already checked it when the
      // state was minted.
      const project = await SeoProject.findById(projectId);
      if (!project || project.user_id.toString() !== userId) {
        console.warn(`[GOOGLE_OAUTH] Rejected ${purpose} callback: project/user mismatch`, { projectId, userId });
        return redirectToVisibilityPage(res, { error: "access_denied", projectId, returnTo });
      }

      if (!tokens.refresh_token) {
        return redirectToVisibilityPage(res, { error: "no_refresh_token", projectId, returnTo });
      }

      try {
        // service_type is deliberately left untouched here (defaults to []
        // on first insert, or keeps whatever it already was on a Change
        // Account reconnect) — same reasoning as the google_ads/
        // google_visibility branches above: it's populated by the
        // service's own /select-* endpoint ($addToSet: {service_type:
        // purpose}, alongside the actual site/property/account selection),
        // not at token-exchange time. Setting it here early would make
        // status endpoints report "fully configured" before the user has
        // actually picked a site/property/location.
        const connection = await GoogleConnection.findOneAndUpdate(
          { user_id: userId, project_id: projectId, purpose },
          {
            $set: {
              refresh_token: encryptToken(tokens.refresh_token),
              access_token: encryptToken(tokens.access_token),
              token_expires_at: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
              google_email: googleUser.email,
              google_name: googleUser.name,
              google_avatar: googleUser.picture,
              status: "active",
              last_used_at: new Date(),
              connected_at: new Date()
            }
          },
          { upsert: true, new: true, runValidators: true }
        );

        // Reconnecting/changing account reuses the same GoogleConnection._id
        // even when the underlying Google account changed (matched on
        // user_id+project_id+purpose, not Google identity) - each service
        // clears only its own cache namespace, same reasoning as the
        // google_ads/google_visibility branches above.
        if (connection?._id) {
          const connectionId = connection._id.toString();
          if (purpose === "business_profile") clearCacheForConnection(connectionId);
          if (purpose === "analytics") clearAnalyticsCacheForConnection(connectionId);
          // search_console has no connection-keyed in-memory cache to clear.
        }

        return redirectToVisibilityPage(res, { connected: true, projectId, returnTo });
      } catch (dbError) {
        if (dbError.code === 11000) {
          return redirectToVisibilityPage(res, { connected: true, projectId, returnTo });
        }
        console.error(`[GOOGLE_OAUTH] Database error saving ${purpose} connection:`, dbError.message);
        return redirectToVisibilityPage(res, { error: "save_failed", projectId, returnTo });
      }
    }

    // user_login purpose (legacy direct-hit path; the primary "Sign in with
    // Google" entry point is NextAuth, which uses the POST route below).
    const googleEmail = normalizeAuthEmail(googleUser.email);
    let user = await User.findOne({ oauthProvider: "google", oauthProviderId: googleUser.sub });

    if (!user) {
      // Only link to a pre-existing local account when Google has verified
      // the email - otherwise an attacker could register the victim's email
      // first and then "verify" it via an unverified Google identity.
      user = googleUser.email_verified
        ? await User.findOne({ email: googleEmail })
        : null;

      if (user) {
        user.oauthProvider = "google";
        user.oauthProviderId = googleUser.sub;
        user.isEmailVerified = true;
        if (googleUser.picture && !user.avatar) {
          user.avatar = googleUser.picture;
        }
        await user.save();
      } else {
        user = await User.create({
          email: googleEmail,
          firstName: googleUser.given_name || googleUser.name?.split(" ")[0] || "",
          lastName: googleUser.family_name || googleUser.name?.split(" ").slice(1).join(" ") || "",
          avatar: googleUser.picture,
          oauthProvider: "google",
          oauthProviderId: googleUser.sub,
          isEmailVerified: !!googleUser.email_verified,
          roleId: 5
        });
      }
    }

    // Google must not be a way around account suspension — same check
    // password login has always done (authService.login).
    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        message: "Your account has been suspended.",
        code: "ACCOUNT_SUSPENDED",
      });
    }

    const jwtToken = signAuthToken(user, { rememberMe: true });

    const landingPage = await AuthUtil.determineUserLandingPage(user._id);

    return res.status(200).json({
      success: true,
      message: "Google login successful",
      data: {
        token: jwtToken,
        user: {
          id: user._id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          avatar: user.avatar,
          roleId: user.roleId,
          subscription: formatSubscriptionForResponse(user),
          isEmailVerified: user.isEmailVerified,
          hasProjects: landingPage.hasProjects,
          redirectTo: landingPage.redirectTo
        }
      }
    });
  } catch (err) {
    // Full diagnostics server-side only — never in the HTTP response.
    LoggerUtil.error("[GOOGLE_OAUTH] GET callback error", err, { purpose });

    if (["google_visibility", "google_ads", "search_console", "analytics", "business_profile"].includes(purpose)) {
      const projectId = decodedState?.projectId;
      const returnTo = decodedState?.returnTo;
      if (err.code === 11000) {
        return redirectToVisibilityPage(res, { connected: true, projectId, returnTo });
      }
      return redirectToVisibilityPage(res, { error: "connection_failed", projectId, returnTo });
    }

    if (err.code === 11000) {
      return res.json({
        success: true,
        message: "Google account already connected"
      });
    }

    // Generic, non-revealing — no err.message, no Google library / Mongo
    // internals, no OAuth error_description.
    return res.status(400).json({
      success: false,
      message: "Authentication failed"
    });
  }
});

// STEP 2b: Google callback (POST - NextAuth JWT flow)
//
// The frontend uses a separate NextAuth Google OAuth client (different
// client_id from this backend's own). This route trusts nothing from the
// request body except a Google-issued ID token, which is cryptographically
// verified (signature, issuer, audience, expiry) before any user is looked
// up or created. Previously this route minted app JWTs directly from raw
// {email, googleId} body fields with no verification at all.
router.post("/google/callback", googleCallbackLimiter, async (req, res) => {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({ success: false, message: "Google ID token is required" });
    }

    // Web (this backend + NextAuth) AND native (Android/iOS) client IDs — a
    // native Google Sign-In SDK issues an ID token whose `aud` is the
    // platform client ID, which the previous two-entry list rejected. All
    // sourced from env, empty slots filtered. See config/googleAudiences.js.
    const validAudiences = buildGoogleAudiences();

    let ticket;
    try {
      const verifierClient = new OAuth2Client();
      ticket = await verifierClient.verifyIdToken({
        idToken,
        // `undefined` only in a broken deploy with zero Google client IDs
        // set — same effect the old `[...].filter(Boolean)` had when empty.
        audience: validAudiences.length ? validAudiences : undefined
      });
    } catch (verifyError) {
      console.warn("[GOOGLE_OAUTH] Rejected POST callback: invalid ID token:", verifyError.message);
      return res.status(401).json({ success: false, message: "Invalid Google credential" });
    }

    const payload = ticket.getPayload();

    if (!["accounts.google.com", "https://accounts.google.com"].includes(payload.iss)) {
      return res.status(401).json({ success: false, message: "Invalid token issuer" });
    }

    if (!payload.email || !payload.email_verified) {
      return res.status(401).json({ success: false, message: "Google account email is not verified" });
    }

    const email = normalizeAuthEmail(payload.email);
    const googleId = payload.sub;
    const name = payload.name;
    const avatar = payload.picture;
    const firstName = payload.given_name;
    const lastName = payload.family_name;

    let user = await User.findOne({ oauthProvider: "google", oauthProviderId: googleId });
    let isNewUser = false;

    if (!user) {
      user = await User.findOne({ email });

      if (user) {
        user.oauthProvider = "google";
        user.oauthProviderId = googleId;
        user.isEmailVerified = true;
        if (avatar && !user.avatar) user.avatar = avatar;
        if (firstName && !user.firstName) user.firstName = firstName;
        if (lastName && !user.lastName) user.lastName = lastName;
        await user.save();
      } else {
        isNewUser = true;
        user = await User.create({
          email,
          firstName: firstName || name?.split(" ")[0] || "",
          lastName: lastName || name?.split(" ").slice(1).join(" ") || "",
          avatar,
          oauthProvider: "google",
          oauthProviderId: googleId,
          isEmailVerified: true,
          roleId: 5
        });
      }
    }

    // Google is not a bypass for account suspension (parity with password
    // login — this check was missing here).
    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        message: "Your account has been suspended.",
        code: "ACCOUNT_SUSPENDED",
      });
    }

    // LEGACY web session token (`data.token`, 7d) — unchanged.
    const jwtToken = signAuthToken(user, { rememberMe: true });

    // Phase 2 mobile bundle (`data.tokens`) — short access token + rotating
    // refresh token. A native app sends `{ idToken, deviceLabel? }` and
    // consumes `data.tokens.*`; the web NextAuth flow ignores it.
    const tokens = await issueSessionBundle(user, {
      rememberMe: true,
      deviceLabel: typeof req.body?.deviceLabel === "string" ? req.body.deviceLabel : undefined,
      userAgent: req.get("user-agent") || undefined,
      ipAddress: req.ip || undefined,
    });

    const landingPage = await AuthUtil.determineUserLandingPage(user._id);

    return res.status(200).json({
      success: true,
      message: "Google login successful",
      data: {
        token: jwtToken,
        tokens,
        user: {
          id: user._id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          avatar: user.avatar,
          roleId: user.roleId,
          subscription: formatSubscriptionForResponse(user),
          isEmailVerified: user.isEmailVerified,
          isNewUser,
          hasProjects: landingPage.hasProjects,
          redirectTo: landingPage.redirectTo
        }
      }
    });
  } catch (err) {
    // Full detail server-side only; response is generic (no err.message,
    // no Mongo/Google-library internals).
    LoggerUtil.error("[GOOGLE_OAUTH] POST callback error", err);
    return res.status(500).json({ success: false, message: "Authentication failed" });
  }
});

/**
 * Settings → Connected Accounts. Account-level (not project-scoped, unlike
 * every route above) — business logic lives in
 * googleAccountConnectionService.js, this handler only shapes the response.
 */
router.get("/google/status", auth, async (req, res) => {
  try {
    const status = await getAccountConnectionStatus(req.user._id);
    return res.json({ success: true, data: status });
  } catch (error) {
    console.error("[GOOGLE_OAUTH] Failed to load account connection status:", error.message);
    return res.status(500).json({ success: false, message: "Failed to load Google connection status" });
  }
});

/**
 * Disconnects every Google connection this user has, account-wide — revokes
 * real tokens with Google (googleTokenRevocationService, the same helper
 * account deletion uses) and marks each row 'revoked' rather than deleting
 * it. See googleAccountConnectionService.js for the full behavior.
 */
router.post("/google/disconnect", auth, async (req, res) => {
  try {
    const result = await disconnectAccountGoogleConnections(req.user._id);
    return res.json({
      success: true,
      message: result.total === 0 ? "No active Google connection to disconnect." : "Google account disconnected.",
      data: result,
    });
  } catch (error) {
    console.error("[GOOGLE_OAUTH] Failed to disconnect Google account:", error.message);
    return res.status(500).json({ success: false, message: "Failed to disconnect Google account" });
  }
});

const VALID_PROJECT_SERVICES = ["google_ads", "search_console", "analytics", "business_profile"];

/**
 * Settings → Google Services. Project-scoped (unlike /google/status above,
 * which rolls up across every project) - one independent status per
 * service, for whichever project the caller asks about. DB-only, no live
 * Google API calls (see getProjectGoogleServiceConnections's own doc
 * comment).
 */
router.get("/google/connections", auth, async (req, res) => {
  try {
    const { projectId } = req.query;
    if (!projectId) {
      return res.status(400).json({ success: false, message: "projectId is required" });
    }

    const project = await SeoProject.findById(projectId);
    if (!project) {
      return res.status(404).json({ success: false, message: "Project not found" });
    }
    if (project.user_id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const connections = await getProjectGoogleServiceConnections(req.user._id, projectId);
    return res.json({ success: true, data: connections });
  } catch (error) {
    console.error("[GOOGLE_OAUTH] Failed to load project Google connections:", error.message);
    return res.status(500).json({ success: false, message: "Failed to load Google connection status" });
  }
});

/**
 * Disconnects exactly one Google service's connection for one project.
 * `service` is restricted to the four independently-connectable purposes -
 * 'google_visibility' is a frozen legacy value and is never a valid target
 * here.
 */
router.post("/google/:service/disconnect", auth, async (req, res) => {
  try {
    const { service } = req.params;
    const { projectId } = req.body;

    if (!VALID_PROJECT_SERVICES.includes(service)) {
      return res.status(400).json({ success: false, message: "Invalid Google service" });
    }
    if (!projectId) {
      return res.status(400).json({ success: false, message: "projectId is required" });
    }

    const result = await disconnectProjectGoogleConnection(req.user._id, projectId, service);
    return res.json({
      success: true,
      message: result.alreadyDisconnected ? "No active connection to disconnect." : "Disconnected.",
      data: result,
    });
  } catch (error) {
    if (error.statusCode === 403) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }
    console.error("[GOOGLE_OAUTH] Failed to disconnect Google service:", error.message);
    return res.status(500).json({ success: false, message: "Failed to disconnect" });
  }
});

export default router;
