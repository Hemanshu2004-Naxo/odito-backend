/**
 * Provider-neutral error vocabulary for single-post content generation.
 *
 * A content provider (today: OpenAI) never throws its SDK's errors outward - those can carry
 * request details or a fragment of the API key in their message. It throws an error that has ONLY
 * one of these codes, and the generation service turns the code into Odito's own user-safe failure.
 * Adding another provider later means mapping its errors onto these same codes.
 */

export const PROVIDER_ERROR = Object.freeze({
  NOT_CONFIGURED: 'AI_PROVIDER_NOT_CONFIGURED', // no key / unusable configuration
  AUTH: 'AI_PROVIDER_AUTH',                     // key rejected / no permission (never retried)
  QUOTA: 'AI_PROVIDER_QUOTA',                   // account out of quota / billing (never retried)
  MISCONFIGURED: 'AI_PROVIDER_MISCONFIGURED',   // unknown model etc. (never retried)
  RATE_LIMITED: 'AI_PROVIDER_RATE_LIMITED',     // transient 429 (retried once)
  UNAVAILABLE: 'AI_PROVIDER_UNAVAILABLE',       // 5xx / overloaded (retried once)
  TIMEOUT: 'AI_PROVIDER_TIMEOUT',               // request timed out (retried once)
  NETWORK: 'AI_PROVIDER_NETWORK',               // could not reach the provider (retried once)
  BAD_OUTPUT: 'AI_PROVIDER_BAD_OUTPUT',         // truncated / refused / not the schema (never retried here)
  FAILED: 'AI_PROVIDER_FAILED',                 // anything else (never retried)
});

/** Provider codes that are worth ONE more attempt. Everything else fails at once. */
export const RETRYABLE_PROVIDER_ERRORS = Object.freeze(new Set([
  PROVIDER_ERROR.RATE_LIMITED, PROVIDER_ERROR.UNAVAILABLE, PROVIDER_ERROR.TIMEOUT, PROVIDER_ERROR.NETWORK,
]));

/** provider code -> the Odito failure code the user-safe message table is keyed by (see FAILURE_MESSAGES). */
export const PROVIDER_FAILURE_CODE = Object.freeze({
  [PROVIDER_ERROR.NOT_CONFIGURED]: 'AI_UNAVAILABLE',
  [PROVIDER_ERROR.AUTH]: 'AI_UNAVAILABLE',
  [PROVIDER_ERROR.QUOTA]: 'AI_UNAVAILABLE',
  [PROVIDER_ERROR.MISCONFIGURED]: 'AI_UNAVAILABLE',
  [PROVIDER_ERROR.RATE_LIMITED]: 'AI_BUSY',
  [PROVIDER_ERROR.UNAVAILABLE]: 'AI_BUSY',
  [PROVIDER_ERROR.TIMEOUT]: 'AI_TIMEOUT',
  [PROVIDER_ERROR.NETWORK]: 'AI_UNREACHABLE',
  [PROVIDER_ERROR.BAD_OUTPUT]: 'AI_BAD_OUTPUT',
  [PROVIDER_ERROR.FAILED]: 'GENERATION_FAILED',
});

/** A safe provider error: a code and nothing else (no provider message, body, headers or cause). */
export function providerError(code, extra = {}) {
  const err = new Error(code);
  err.code = code;
  err.provider = 'OPENAI';
  if (extra.status != null) err.status = extra.status;
  if (extra.reason) err.reason = extra.reason;
  return err;
}
