// Syntactic check for "a customer website we may later fetch server-side".
//
// Performs NO network I/O and therefore proves nothing about reachability, and
// cannot see what a hostname resolves to. DNS-level and redirect-level SSRF
// protection must happen at the fetcher itself (see
// python_workers/api/website_extraction.py); this just rejects, up front,
// everything that is obviously internal: non-http(s) schemes, credentials in the
// URL, non-standard ports (which turn the fetcher into a port scanner), loopback /
// private / link-local / metadata addresses, and internal-looking hostnames.
//
// Distinct from utils/publicUrlCheck.js, which answers a different question
// ("can Meta fetch this HTTPS media URL?") and is HTTPS-only.

const ALLOWED_PORTS = new Set(['', '80', '443']);
const MAX_URL_LENGTH = 2048;

const INTERNAL_HOST_SUFFIX_RE = /\.(local|localhost|internal|intranet|lan|home|corp|home\.arpa)$/i;
const METADATA_HOSTS = new Set(['metadata', 'metadata.google.internal', 'instance-data']);
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
// loopback, 0/8, RFC1918, link-local (incl. 169.254.169.254 metadata), CGNAT 100.64/10, 192.0.0/24, TEST-NETs, multicast/reserved
const PRIVATE_IPV4_RE = /^(127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|192\.0\.0\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|198\.1[89]\.|2(2[4-9]|[3-5]\d)\.)/;
// ::1, ::, unique-local fc00::/7, link-local fe80::/10, IPv4-mapped (::ffff:), and the documentation range
const PRIVATE_IPV6_RE = /^(::1?$|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:|::ffff:|2001:db8:|64:ff9b:)/i;

/**
 * @param {unknown} input
 * @param {{ allowPublicIp?: boolean, allowCustomPorts?: boolean }} [options]
 *   allowPublicIp: accept a *public* IP literal (legacy project creation); the website
 *   extractor keeps rejecting every IP literal.
 *   allowCustomPorts: project creation accepts e.g. staging sites on :8443 - the port rule
 *   only matters to a server-side fetcher, and internal hosts are rejected regardless.
 * @returns {{ ok: true, url: URL } | { ok: false, reason: string }}
 */
export function checkPublicWebsiteUrl(input, { allowPublicIp = false, allowCustomPorts = false } = {}) {
  if (typeof input !== 'string') return { ok: false, reason: 'URL is required' };
  const raw = input.trim();
  if (!raw) return { ok: false, reason: 'URL is required' };
  if (raw.length > MAX_URL_LENGTH) return { ok: false, reason: 'URL is too long' };
  if (/[\u0000-\u001f\s]/.test(raw)) return { ok: false, reason: 'Invalid URL format' };
  if (!/^https?:\/\//i.test(raw)) return { ok: false, reason: 'URL must start with http:// or https://' };

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'Invalid URL format' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'Only HTTP and HTTPS URLs are allowed' };
  if (url.username || url.password) return { ok: false, reason: 'URLs with credentials are not allowed' };
  if (!allowCustomPorts && !ALLOWED_PORTS.has(url.port)) return { ok: false, reason: 'Custom ports are not allowed' };

  // WHATWG URL already canonicalises decimal/octal/hex IPv4 ("2130706433", "0x7f.1") to dotted quad.
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const bare = host.replace(/^\[|\]$/g, '');

  if (!host) return { ok: false, reason: 'Invalid hostname' };
  if (host === 'localhost' || METADATA_HOSTS.has(host) || INTERNAL_HOST_SUFFIX_RE.test(host)) {
    return { ok: false, reason: 'This URL is not allowed for security reasons' };
  }

  if (bare.includes(':')) {
    if (PRIVATE_IPV6_RE.test(bare) || !allowPublicIp) return { ok: false, reason: 'This URL is not allowed for security reasons' };
    return { ok: true, url };
  }
  if (IPV4_RE.test(bare)) {
    if (PRIVATE_IPV4_RE.test(bare)) return { ok: false, reason: 'This URL is not allowed for security reasons' };
    if (!allowPublicIp) return { ok: false, reason: 'IP addresses are not allowed — use a domain name' };
    return { ok: true, url };
  }

  if (!bare.includes('.')) return { ok: false, reason: 'Invalid hostname — must include a domain extension (e.g., .com)' };
  return { ok: true, url };
}

export default { checkPublicWebsiteUrl };
