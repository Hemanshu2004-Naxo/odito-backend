/**
 * Normalize a URL to a consistent cache key.
 *
 * Rules applied:
 *   - http:  → https:
 *   - Lowercase entire URL
 *   - Strip trailing slash
 *
 * Used by: HomepageAudit snapshot save, PageSpeedCache lookup, pre-audit linking.
 */
export function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return '';
  let cleanUrl = url.trim().toLowerCase();
  cleanUrl = cleanUrl.replace(/^(https?:\/\/)/, '');
  cleanUrl = cleanUrl.replace(/^(www\.)/, '');
  cleanUrl = cleanUrl.replace(/\/$/, '');
  return cleanUrl;
}

