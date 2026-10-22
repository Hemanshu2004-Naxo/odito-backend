/**
 * MetaErrorClassifier — the ONE place a failed Graph API call is turned into
 * a structured, actionable classification. Previously every adapter/service
 * decided "token invalid?" / "rate limited?" from the HTTP status alone
 * (401/403/429), but Meta reports most of these as HTTP 400 with a specific
 * `error.code` (190 = invalid/expired token; 4, 17, 32, 613 = throttling),
 * so an expired token surfaced as a generic "Meta rejected this post" while
 * the account stayed "active".
 *
 * Input is the normalized result from metaApiService.request()
 * ({ success:false, kind, status, data, message }) — `kind` may be absent
 * (older callers/tests); it is then inferred from `status`.
 *
 * Output (never contains Meta's raw message, a token, or an fbtrace_id):
 *   category        AUTHENTICATION | RATE_LIMIT | TRANSIENT | VALIDATION |
 *                   UNKNOWN_OUTCOME | PERMANENT
 *   code            stable internal code (platform-prefixed where the
 *                   existing UI already keys on it: FACEBOOK_TOKEN_INVALID,
 *                   INSTAGRAM_RATE_LIMITED, ...)
 *   message         safe, user-facing
 *   retryable       true  => a later attempt can succeed with no user action
 *   accountAction   'expire' (token dead: mark the SocialAccount expired) |
 *                   'none'
 *   outcome         'not_published' — Meta definitively rejected the request
 *                                      (or it provably never left Odito)
 *                   'unknown'       — the request may have been processed even
 *                                      though no usable answer came back
 *                                      (timeout / connection reset / 5xx)
 *   requiresReconnect  the user must re-authorize before anything can work
 *
 * `outcome:'unknown'` is only ever produced for the FINAL, state-changing
 * publish call (`finalPublishStep: true`). A timeout while merely reading a
 * container's status or creating an unpublished Instagram container cannot
 * have created a post, so those are plain retryable transient failures.
 */

export const CATEGORY = Object.freeze({
  AUTHENTICATION: 'AUTHENTICATION',
  RATE_LIMIT: 'RATE_LIMIT',
  TRANSIENT: 'TRANSIENT',
  VALIDATION: 'VALIDATION',
  UNKNOWN_OUTCOME: 'UNKNOWN_OUTCOME',
  PERMANENT: 'PERMANENT',
});

export const OUTCOME = Object.freeze({ NOT_PUBLISHED: 'not_published', UNKNOWN: 'unknown' });

/** Meta error.code 190 family: the access token itself is no longer usable. */
const TOKEN_ERROR_CODES = new Set([190, 102]);
/** error_subcode values Meta documents for an invalid/expired/revoked token or session. */
const TOKEN_ERROR_SUBCODES = new Set([458, 459, 460, 463, 464, 467]);
/** Throttling: app-level (4), user-level (17), page-level (32), generic (613). */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);
/** Meta Business Use Case / Marketing-style rate limit codes (80000–80014). */
function isBusinessUseCaseRateLimit(code) {
  return Number.isInteger(code) && code >= 80000 && code <= 80014;
}
/** "An unknown error occurred" (1) and "service temporarily unavailable" (2). */
const TRANSIENT_CODES = new Set([1, 2]);
const MEDIA_MESSAGE_RE = /media type|could not process|invalid image|invalid video/i;

function platformPrefix(platform) {
  return platform === 'instagram' ? 'INSTAGRAM' : 'FACEBOOK';
}

function platformLabel(platform) {
  return platform === 'instagram' ? 'Instagram' : 'Facebook';
}

function inferKind(result) {
  if (result?.kind) return result.kind;
  if (typeof result?.status === 'number') return 'http';
  // No status and no kind: an old-shape timeout/network result. Treat as
  // "no usable answer" — the safe (unknown) interpretation.
  return /timed out|timeout/i.test(result?.message || '') ? 'timeout' : 'network_unknown';
}

function isPermissionDenied(metaError) {
  return metaError?.type === 'OAuthException' && /permission/i.test(metaError.message || '');
}

/**
 * True when this failure means the access token itself is dead — Meta's own
 * code 190 family (returned as HTTP 400, which a status-only check misses),
 * or a bare 401/403. A 401/403 whose body is a named *permission* error is
 * NOT a dead token: that is a connected-but-not-authorized-to-post account
 * (see FACEBOOK_PERMISSION_MISSING), and must not expire the connection.
 */
export function isAuthenticationFailure(result) {
  const metaError = result?.data?.error || null;
  if (TOKEN_ERROR_CODES.has(metaError?.code) || TOKEN_ERROR_SUBCODES.has(metaError?.error_subcode)) return true;
  if (isPermissionDenied(metaError)) return false;
  return result?.status === 401 || result?.status === 403;
}

/**
 * @param {object} result  failed metaApiService result
 * @param {object} [opts]
 * @param {'facebook'|'instagram'} [opts.platform]
 * @param {boolean} [opts.finalPublishStep]  true for the call whose success
 *   creates the real post (a timeout there is an UNKNOWN outcome)
 */
export function classifyMetaFailure(result, { platform = 'facebook', finalPublishStep = false } = {}) {
  const P = platformPrefix(platform);
  const label = platformLabel(platform);
  const kind = inferKind(result);
  const metaError = result?.data?.error || null;
  const metaCode = Number.isInteger(metaError?.code) ? metaError.code : null;
  const metaSubcode = Number.isInteger(metaError?.error_subcode) ? metaError.error_subcode : null;
  const httpStatus = typeof result?.status === 'number' ? result.status : null;

  const base = { metaCode, metaSubcode, httpStatus, requiresReconnect: false, accountAction: 'none' };

  // ── No usable answer from Meta ─────────────────────────────────────────
  if (kind === 'network_unsent') {
    return { ...base, category: CATEGORY.TRANSIENT, code: 'META_UNREACHABLE', message: 'Could not reach Meta right now.', retryable: true, outcome: OUTCOME.NOT_PUBLISHED };
  }
  if (kind === 'timeout' || kind === 'network_unknown') {
    if (finalPublishStep) {
      return {
        ...base,
        category: CATEGORY.UNKNOWN_OUTCOME,
        code: 'PUBLISH_OUTCOME_UNKNOWN',
        message: `The connection to ${label} was interrupted while publishing, so Odito cannot confirm whether the post went out. It will not be re-sent until that is verified.`,
        retryable: true, // only AFTER reconciliation proves nothing was published
        outcome: OUTCOME.UNKNOWN,
      };
    }
    return { ...base, category: CATEGORY.TRANSIENT, code: 'META_TIMEOUT', message: 'Meta did not respond in time.', retryable: true, outcome: OUTCOME.NOT_PUBLISHED };
  }

  // ── Meta answered with an error ────────────────────────────────────────
  if (isAuthenticationFailure(result)) {
    return {
      ...base,
      category: CATEGORY.AUTHENTICATION,
      code: `${P}_TOKEN_INVALID`,
      message: `Meta denied this request — the ${label} connection has expired or was revoked and needs to be reconnected.`,
      retryable: false,
      accountAction: 'expire',
      requiresReconnect: true,
      outcome: OUTCOME.NOT_PUBLISHED,
    };
  }

  if (isPermissionDenied(metaError)) {
    return {
      ...base,
      category: CATEGORY.AUTHENTICATION,
      code: `${P}_PERMISSION_MISSING`,
      message: platform === 'instagram'
        ? 'This Instagram connection is missing publishing permission — disconnect and reconnect it, making sure to approve posting permission when Facebook asks.'
        : 'This Facebook Page is connected but missing posting permission — disconnect and reconnect it, making sure to approve posting permission when Facebook asks.',
      retryable: false,
      requiresReconnect: true,
      outcome: OUTCOME.NOT_PUBLISHED,
    };
  }

  if (RATE_LIMIT_CODES.has(metaCode) || isBusinessUseCaseRateLimit(metaCode) || httpStatus === 429) {
    return {
      ...base,
      category: CATEGORY.RATE_LIMIT,
      code: `${P}_RATE_LIMITED`,
      message: 'Meta is rate-limiting requests for this account right now. Try again shortly.',
      retryable: true,
      outcome: OUTCOME.NOT_PUBLISHED,
    };
  }

  if (metaError?.type === 'OAuthException' && (metaCode === 9004 || MEDIA_MESSAGE_RE.test(metaError.message || ''))) {
    return {
      ...base,
      category: CATEGORY.VALIDATION,
      code: `${P}_MEDIA_INVALID`,
      message: `${label} could not process this media — the file may be corrupt, in an unsupported format, or the URL may not be reachable from ${label}.`,
      retryable: false,
      outcome: OUTCOME.NOT_PUBLISHED,
    };
  }

  const serverError = httpStatus !== null && httpStatus >= 500;
  if (serverError || metaError?.is_transient === true || TRANSIENT_CODES.has(metaCode)) {
    return {
      ...base,
      category: CATEGORY.TRANSIENT,
      // Existing code kept on purpose: the UI/tests already key on it, and
      // retry decisions use `retryable`, not the code.
      code: `${P}_PUBLISH_FAILED`,
      message: 'Meta had a temporary problem handling this post.',
      retryable: true,
      // A 5xx (or code 1/2) on the publish call does not prove the post
      // wasn't created — treat it like a lost response.
      outcome: finalPublishStep && (serverError || TRANSIENT_CODES.has(metaCode)) ? OUTCOME.UNKNOWN : OUTCOME.NOT_PUBLISHED,
    };
  }

  return {
    ...base,
    category: CATEGORY.PERMANENT,
    code: `${P}_PUBLISH_FAILED`,
    message: 'Meta rejected this post.',
    retryable: false,
    outcome: OUTCOME.NOT_PUBLISHED,
  };
}

export default { CATEGORY, OUTCOME, classifyMetaFailure, isAuthenticationFailure };
