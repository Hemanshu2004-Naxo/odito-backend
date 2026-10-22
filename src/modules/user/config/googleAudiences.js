/**
 * Single source of truth for the set of Google OAuth client IDs this backend
 * will accept as the `aud` claim of an ID token on the "Sign in with Google"
 * endpoints (GET/POST /api/auth/oauth/google/callback).
 *
 * Historically only two were accepted:
 *   - GOOGLE_CLIENT_ID          — this backend's own Web OAuth client
 *   - GOOGLE_NEXTAUTH_CLIENT_ID — the frontend's NextAuth Web OAuth client
 *
 * A native Google Sign-In SDK mints an ID token whose `aud` is the platform
 * OAuth client ID (iOS / Android), which is neither of the above, so the
 * mobile app could never authenticate. These are additive: existing web
 * flows are unchanged, mobile client IDs are simply also honoured when set.
 *
 * Nothing is hardcoded — every value comes from the environment. Unset /
 * blank vars are filtered out, so this is safe to call even in a deployment
 * that has no mobile client configured yet.
 *
 * Recognised env vars (all optional except GOOGLE_CLIENT_ID, which the
 * OAuth flow already required):
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_NEXTAUTH_CLIENT_ID
 *   GOOGLE_ANDROID_CLIENT_ID
 *   GOOGLE_IOS_CLIENT_ID
 *   GOOGLE_OAUTH_AUDIENCES   — optional comma-separated list of any additional
 *                              client IDs, for deployments that need more than
 *                              the four named slots without a code change.
 *
 * @returns {string[]} de-duplicated, non-empty client IDs
 */
export function buildGoogleAudiences() {
  const named = [
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_NEXTAUTH_CLIENT_ID,
    process.env.GOOGLE_ANDROID_CLIENT_ID,
    process.env.GOOGLE_IOS_CLIENT_ID,
  ];

  const extra = (process.env.GOOGLE_OAUTH_AUDIENCES || '')
    .split(',')
    .map((v) => v.trim());

  return [...new Set([...named, ...extra].map((v) => (v || '').trim()).filter(Boolean))];
}

export default buildGoogleAudiences;
