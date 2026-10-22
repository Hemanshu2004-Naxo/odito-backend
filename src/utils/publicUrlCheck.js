// Single, dependency-free source of truth for "is this a URL Meta's
// servers (or any external provider) could actually be expected to
// fetch?" — HTTPS, and a hostname that isn't loopback/private. Used by
// mediaStorageService.js (adapter pre-flight, before ever calling Meta)
// AND src/config/env.js (startup validation, so production can't
// silently run with a BACKEND_URL Meta can never reach). Kept as its own
// tiny module with zero imports specifically to avoid a circular
// dependency: mediaStorageService.js already imports getServiceUrls from
// config/env.js, so env.js importing FROM mediaStorageService.js would
// create a cycle.
//
// Live-verified need for this exact check: a real Instagram
// container-creation call against a `http://localhost:5000/...` media URL
// was rejected by the real Meta Graph API with OAuthException code 9004
// ("Only photo or video can be accepted as media type") for a genuinely
// valid, already-validated JPEG — rejected purely because Meta's servers
// cannot reach localhost.
//
// Performs no network I/O of its own — it only parses the URL string;
// never fetches anything, so it introduces no SSRF surface.

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '::']);
// Not routable from Meta's infrastructure, so exactly as unreachable as localhost even though not literally "localhost":
// the whole 127/8 loopback block, 0/8, RFC 1918 private ranges, link-local 169.254/16 and carrier-grade NAT 100.64/10.
// (The URL parser already normalises decimal / octal / hex IPv4 spellings to dotted form, so they land here too.)
const PRIVATE_HOST_RE = /^(127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
// IPv6 literals: unique-local fc00::/7, link-local fe80::/10, and IPv4-mapped addresses (::ffff:a.b.c.d / ::ffff:7f00:1), which
// can name a private or loopback IPv4 host. A public IPv6 address is allowed; these ranges are not.
const PRIVATE_IPV6_RE = /^(f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:|::ffff:)/i;

export function isPubliclyReachableUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    // new URL keeps the brackets of an IPv6 literal in .hostname ("[::1]"): compare the bare address.
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (LOOPBACK_HOSTS.has(host)) return false;
    if (host === 'localhost' || host.endsWith('.localhost')) return false;
    if (PRIVATE_HOST_RE.test(host)) return false;
    if (host.includes(':') && PRIVATE_IPV6_RE.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

export default { isPubliclyReachableUrl };
