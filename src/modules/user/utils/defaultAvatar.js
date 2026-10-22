/**
 * Single source of truth for the ui-avatars.com fallback URL — extracted
 * from User.js's schema `default` function (unchanged logic, just now
 * reusable) so DELETE /auth/avatar (authService.js's removeAvatar()) can
 * regenerate the exact same default without duplicating the URL format.
 * @param {string} [firstName]
 * @param {string} [lastName]
 * @returns {string|null}
 */
export function buildDefaultAvatarUrl(firstName, lastName) {
  if (firstName && lastName) {
    return `https://ui-avatars.com/api/?name=${encodeURIComponent(firstName + ' ' + lastName)}&background=random&color=fff`;
  }
  return null;
}
