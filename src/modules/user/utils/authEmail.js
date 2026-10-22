/**
 * The ONE canonical email normalization for every authentication lookup and
 * write path (register, login, OTP issue/verify, forgot/reset, Google
 * account matching).
 *
 * Deliberately `trim()` + `toLowerCase()` and NOTHING else:
 *
 *  - This is byte-for-byte what `authService.js` and `otpService.js` already
 *    did (`email.toLowerCase().trim()`), and therefore exactly how every
 *    existing `users` document and `otps` record was already stored. Adopting
 *    it as the single canonical form changes ZERO existing data semantics.
 *
 *  - It does NOT do what express-validator's `.normalizeEmail()` was doing on
 *    the OTP routes: stripping dots and `+tags` from Gmail addresses. That
 *    transform was the H3 bug — a user who registered `jane.doe@gmail.com`
 *    (stored verbatim, lowercased) could never verify or reset, because the
 *    OTP routes normalized their input to `janedoe@gmail.com` before the
 *    lookup. The fix is to make reads and writes agree, not to add more
 *    transformation.
 *
 * @param {unknown} email
 * @returns {string} canonical form, or '' for nullish/blank input
 */
export function normalizeAuthEmail(email) {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

export default normalizeAuthEmail;
