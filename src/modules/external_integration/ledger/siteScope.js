/**
 * siteScope — a fix may only be planned and applied for a page that belongs to the WordPress site the project is connected to.
 * Compared by host (case-insensitive, a leading "www." ignored); never by substring, never by path.
 */

export function hostKey(url) {
  try {
    const u = new URL(String(url));
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** true only when both URLs parse and share a host. A missing or unparsable URL on either side is NOT in scope. */
export function pageBelongsToSite(pageUrl, siteUrl) {
  const a = hostKey(pageUrl);
  const b = hostKey(siteUrl);
  return Boolean(a && b && a === b);
}

export default { hostKey, pageBelongsToSite };
