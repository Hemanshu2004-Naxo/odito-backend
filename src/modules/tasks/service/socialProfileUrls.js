/**
 * Social-profile URL validation/normalization for Organization `sameAs`.
 *
 * The site owner types these URLs themselves; nothing here (or anywhere) ever
 * invents one. The URL itself is the source of truth — there is no allowlist
 * of social networks — but it MUST be a plain, absolute, public http(s) URL,
 * because it ends up as one line of Rank Math's newline-delimited
 * `social_additional_profiles` option and then as JSON-LD on every page.
 *
 * Used by BOTH the write path (wordPressSeoFixService.js — never trust the
 * frontend's own validation, which mirrors these rules in
 * frontend/lib/socialProfileUrl.js) and the verification path
 * (TaskVerificationService.js — so "the URL Odito wrote" and "the URL found in
 * the rendered Organization schema" are compared the same way).
 */

export const SOCIAL_PROFILE_LIMITS = Object.freeze({
  maxUrlLength: 2048,
  // Per request. A site owner adding more than this in one go is almost
  // certainly pasting something that is not a list of profiles.
  maxProfilesPerRequest: 10,
});

/** Machine-readable reasons a URL can be rejected (also the frontend's vocabulary). */
export const SOCIAL_PROFILE_ERRORS = Object.freeze({
  NOT_A_STRING: 'NOT_A_STRING',
  EMPTY: 'EMPTY',
  TOO_LONG: 'TOO_LONG',
  INVALID_CHARACTERS: 'INVALID_CHARACTERS',
  NOT_HTTP: 'NOT_HTTP',
  INVALID_URL: 'INVALID_URL',
  CREDENTIALS: 'CREDENTIALS',
  PORT: 'PORT',
  INVALID_HOST: 'INVALID_HOST',
  DUPLICATE: 'DUPLICATE',
});

const MESSAGES = {
  NOT_A_STRING: 'Each profile must be a text URL.',
  EMPTY: 'Enter a URL.',
  TOO_LONG: `URL is too long (maximum ${SOCIAL_PROFILE_LIMITS.maxUrlLength} characters).`,
  INVALID_CHARACTERS: 'URL contains spaces, line breaks, HTML or other characters that are not allowed.',
  NOT_HTTP: 'URL must start with http:// or https://.',
  INVALID_URL: 'This is not a valid URL.',
  CREDENTIALS: 'URL must not contain a username or password.',
  PORT: 'URL must not specify a port.',
  INVALID_HOST: 'URL must point to a public website address (for example https://www.linkedin.com/company/example).',
  DUPLICATE: 'This URL is listed more than once.',
};

// Whitespace and control characters (a newline here would inject an extra
// line — i.e. an extra profile — into a newline-delimited WordPress option),
// HTML/markup delimiters, backslash (URL parsers silently rewrite it to "/")
// and backtick.
const FORBIDDEN_CHARACTERS = /[\s\u0000-\u001f\u007f-\u009f<>"\\`]/;
// A registrable-looking hostname: dotted labels ending in an alphabetic TLD
// (or an IDN "xn--" TLD). Rejects "localhost", bare words and IP literals.
const PUBLIC_HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{2,59})$/i;

/**
 * @typedef {{ok: true, url: string}|{ok: false, code: string, message: string}} SocialProfileCheck
 */

/**
 * Validates and normalizes ONE profile URL.
 * Normalization: trimmed; scheme + host lower-cased; fragment dropped; trailing
 * slashes removed from the path (a bare origin has no trailing slash at all);
 * query string kept (some profile URLs need it, e.g. profile.php?id=…).
 * @param {unknown} raw
 * @returns {SocialProfileCheck}
 */
export function validateSocialProfileUrl(raw) {
  const fail = (code) => ({ ok: false, code, message: MESSAGES[code] });

  if (typeof raw !== 'string') return fail(SOCIAL_PROFILE_ERRORS.NOT_A_STRING);
  const trimmed = raw.trim();
  if (!trimmed) return fail(SOCIAL_PROFILE_ERRORS.EMPTY);
  if (trimmed.length > SOCIAL_PROFILE_LIMITS.maxUrlLength) return fail(SOCIAL_PROFILE_ERRORS.TOO_LONG);
  if (FORBIDDEN_CHARACTERS.test(trimmed)) return fail(SOCIAL_PROFILE_ERRORS.INVALID_CHARACTERS);
  // Checked textually BEFORE parsing: javascript:, data:, mailto:, ftp:, "//host"
  // (protocol-relative), "/path" (relative) and "www.example.com" (no scheme)
  // are all refused here rather than being "helpfully" interpreted.
  if (!/^https?:\/\//i.test(trimmed)) return fail(SOCIAL_PROFILE_ERRORS.NOT_HTTP);

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return fail(SOCIAL_PROFILE_ERRORS.INVALID_URL);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fail(SOCIAL_PROFILE_ERRORS.NOT_HTTP);
  if (parsed.username || parsed.password) return fail(SOCIAL_PROFILE_ERRORS.CREDENTIALS);
  if (parsed.port) return fail(SOCIAL_PROFILE_ERRORS.PORT);
  if (!PUBLIC_HOSTNAME.test(parsed.hostname)) return fail(SOCIAL_PROFILE_ERRORS.INVALID_HOST);

  const path = parsed.pathname.replace(/\/+$/, '');
  return { ok: true, url: `${parsed.protocol}//${parsed.host}${path}${parsed.search}` };
}

/**
 * Comparison key: the normalized URL without its scheme, so http://x.com/a and
 * https://x.com/a/ are the same profile. Path/query case is preserved (paths
 * can be case-sensitive). Lenient by design — used on values that were NOT
 * validated by us (the rendered page's sameAs entries), so it never throws:
 * anything that isn't a parseable http(s) URL yields null.
 * @param {unknown} raw
 * @returns {string|null}
 */
export function sameAsComparisonKey(raw) {
  if (typeof raw !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return `${parsed.host}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`;
}

/**
 * Validates a whole list (as sent by the client): every entry must be valid and
 * no two entries may be the same profile. Nothing is silently dropped or
 * "fixed" — a bad list is rejected with per-entry reasons so the caller can
 * report exactly which line is wrong.
 *
 * @param {unknown} list
 * @param {{ min?: number, max?: number }} [options]
 * @returns {{ valid: true, urls: string[], keys: string[] } | { valid: false, errors: Array<{index: number|null, input: unknown, code: string, message: string}> }}
 */
export function validateSocialProfileList(list, { min = 0, max = SOCIAL_PROFILE_LIMITS.maxProfilesPerRequest } = {}) {
  if (!Array.isArray(list)) {
    return { valid: false, errors: [{ index: null, input: list, code: SOCIAL_PROFILE_ERRORS.NOT_A_STRING, message: 'Profiles must be sent as a list of URLs.' }] };
  }
  if (list.length > max) {
    return { valid: false, errors: [{ index: null, input: null, code: 'TOO_MANY', message: `At most ${max} profiles can be sent at once.` }] };
  }
  if (list.length < min) {
    return { valid: false, errors: [{ index: null, input: null, code: 'TOO_FEW', message: 'At least one profile URL is required.' }] };
  }

  const errors = [];
  const urls = [];
  const keys = [];
  const seen = new Set();
  list.forEach((raw, index) => {
    const checked = validateSocialProfileUrl(raw);
    if (!checked.ok) {
      errors.push({ index, input: typeof raw === 'string' ? raw : null, code: checked.code, message: checked.message });
      return;
    }
    const key = sameAsComparisonKey(checked.url);
    if (seen.has(key)) {
      errors.push({ index, input: raw, code: SOCIAL_PROFILE_ERRORS.DUPLICATE, message: MESSAGES.DUPLICATE });
      return;
    }
    seen.add(key);
    urls.push(checked.url);
    keys.push(key);
  });

  return errors.length ? { valid: false, errors } : { valid: true, urls, keys };
}
