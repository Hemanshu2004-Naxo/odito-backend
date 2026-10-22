/**
 * Shared sensitive-field-name filter — used by both wordPressFormService.js
 * (Phase 3A structure sync) and wordPressSubmissionNormalizer.js (Phase 3B
 * submission values), so this one Node-side implementation isn't
 * duplicated a third time. Still intentionally mirrored (not shared) in
 * the WordPress plugin's own PHP filter
 * (odito-wordpress-plugin/includes/class-odito-security.php) — see that
 * file's comment for why the Node/PHP boundary isn't bridged.
 *
 * Boundary-aware for short keywords via a custom (?:^|[^a-z0-9])... wrapper
 * rather than \b — plain \b treats `_` as a word character, so `\btoken\b`
 * does NOT match "csrf_token". This was a real bug caught during Phase 3A
 * testing (regex verified against realistic sample field names before
 * being trusted). Longer/lower-collision keywords (password, secret,
 * token) use plain substring matching, deliberately broad: over-filtering
 * a legitimate field name is a safe failure, under-filtering a sensitive
 * one is not.
 */

function boundaryPattern(keyword) {
  return new RegExp(`(?:^|[^a-z0-9])${keyword}(?:$|[^a-z0-9])`, 'i');
}

export const SENSITIVE_FIELD_PATTERNS = [
  boundaryPattern('pwd'),
  boundaryPattern('ssn'),
  boundaryPattern('cvv2?'),
  boundaryPattern('cvc'),
  boundaryPattern('otp'),
  /password/i,
  /passwd/i,
  /secret/i,
  /token/i,
  /credit[\s_-]?card/i,
  /card[\s_-]?number/i,
  /social[\s_-]?security/i,
  /security[\s_-]?code/i,
  /\bapi[\s_-]?key\b/i,
  /\bcsrf\b/i,
  /\bnonce\b/i,
  /\bauth(?:orization)?\b/i,
  /bank[\s_-]?account/i,
  /account[\s_-]?number/i,
];

export function isSensitiveField(fieldName) {
  if (!fieldName) return false;
  return SENSITIVE_FIELD_PATTERNS.some((re) => re.test(fieldName));
}
