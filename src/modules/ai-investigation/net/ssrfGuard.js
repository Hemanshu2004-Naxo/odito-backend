/**
 * ssrfGuard — the only way the investigation engine touches the network.
 *
 * Every request (and every redirect hop) is validated BEFORE connecting:
 *   - scheme must be http/https, port 80/443 only, no embedded credentials
 *   - the hostname is resolved here and ALL resolved addresses must be public
 *   - the connection is then pinned to the validated address (custom `lookup`), so a second
 *     DNS answer cannot redirect the socket to an internal host (DNS rebinding)
 *   - redirects are followed manually, max 4 hops, each hop re-validated
 *   - response size and total time are capped; only textual content types are read
 *
 * Nothing here accepts a URL from a model: callers pass URLs derived from the project's own
 * pages and `restrictToHost` keeps investigations on the audited site.
 */

import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

export const SSRF_ERROR = Object.freeze({
  INVALID_URL: 'INVALID_URL',
  BLOCKED_SCHEME: 'BLOCKED_SCHEME',
  BLOCKED_PORT: 'BLOCKED_PORT',
  BLOCKED_CREDENTIALS: 'BLOCKED_CREDENTIALS',
  BLOCKED_HOST: 'BLOCKED_HOST',
  BLOCKED_ADDRESS: 'BLOCKED_ADDRESS',
  DNS_FAILED: 'DNS_FAILED',
  CROSS_HOST: 'CROSS_HOST',
  TOO_MANY_REDIRECTS: 'TOO_MANY_REDIRECTS',
  TOO_LARGE: 'TOO_LARGE',
  TIMEOUT: 'TIMEOUT',
  NON_TEXT: 'NON_TEXT',
  NETWORK: 'NETWORK',
  ABORTED: 'ABORTED',
});

export class SafeFetchError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SafeFetchError';
    this.code = code;
    this.details = details;
  }
}

const ALLOWED_PORTS = new Set([80, 443]);
const BLOCKED_HOSTNAMES = new Set([
  'localhost', 'metadata', 'metadata.google.internal', 'metadata.goog', 'instance-data', 'instance-data.ec2.internal',
]);
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home.arpa'];

// [base, prefix] — everything that is not public unicast IPv4.
const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

const v4ToInt = (ip) => ip.split('.').reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0);

function isBlockedV4(ip) {
  const n = v4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((v4ToInt(base) & mask) >>> 0);
  });
}

/** Expands any IPv6 text form into 8 numeric hextets (embedded dotted-quad supported). */
function ipv6Hextets(ip) {
  let text = ip.toLowerCase().split('%')[0];
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const v4 = dotted[1].split('.').map(Number);
    text = text.replace(dotted[1], `${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`);
  }
  const [head, tail] = text.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail !== undefined && tail ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - headParts.length - tailParts.length;
  const parts = [...headParts, ...Array(Math.max(0, fill)).fill('0'), ...tailParts];
  return parts.map((p) => parseInt(p || '0', 16));
}

const v4FromHextets = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

function isBlockedV6(ip) {
  const h = ipv6Hextets(ip);
  if (h.length !== 8 || h.some((x) => Number.isNaN(x))) return true; // unparseable → refuse
  const allZeroUntil = (n) => h.slice(0, n).every((x) => x === 0);
  if (allZeroUntil(7) && (h[7] === 0 || h[7] === 1)) return true;          // :: and ::1
  if (allZeroUntil(5) && h[5] === 0xffff) return isBlockedV4(v4FromHextets(h[6], h[7])); // ::ffff:a.b.c.d (mapped)
  if (allZeroUntil(6)) return isBlockedV4(v4FromHextets(h[6], h[7]));       // ::a.b.c.d (deprecated compatible)
  if (h[0] === 0x64 && h[1] === 0xff9b) return isBlockedV4(v4FromHextets(h[6], h[7])); // NAT64
  if (h[0] === 0x2002) return isBlockedV4(v4FromHextets(h[1], h[2]));       // 6to4
  if ((h[0] & 0xfe00) === 0xfc00) return true;                              // unique local
  if ((h[0] & 0xffc0) === 0xfe80) return true;                              // link-local
  if ((h[0] & 0xff00) === 0xff00) return true;                              // multicast
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true;                      // documentation
  if (h[0] === 0x2001 && h[1] === 0) return true;                           // Teredo tunnelling (embeds an IPv4 server + client)
  if ((h[0] & 0xffc0) === 0xfec0) return true;                              // deprecated site-local
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 1) return true;          // local-use NAT64 (64:ff9b:1::/48)
  if (h[0] === 0x0100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return true; // discard prefix
  return false;
}

/** True when an IP literal is not a public unicast address (or cannot be parsed). */
export function isBlockedIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedV4(ip);
  if (family === 6) return isBlockedV6(ip);
  return true;
}

function parseUrl(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { throw new SafeFetchError(SSRF_ERROR.INVALID_URL, 'The URL is not valid.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SafeFetchError(SSRF_ERROR.BLOCKED_SCHEME, 'Only http(s) URLs can be inspected.');
  if (url.username || url.password) throw new SafeFetchError(SSRF_ERROR.BLOCKED_CREDENTIALS, 'URLs with embedded credentials are not allowed.');
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  if (!ALLOWED_PORTS.has(port)) throw new SafeFetchError(SSRF_ERROR.BLOCKED_PORT, 'Only ports 80 and 443 can be inspected.');
  return url;
}

/**
 * Validates a URL and resolves it to a vetted address. Throws SafeFetchError when anything is unsafe.
 * @returns {Promise<{ url: URL, address: string, family: 4|6 }>}
 */
export async function resolveSafeTarget(raw, { resolver = dns.lookup } = {}) {
  const url = parseUrl(raw);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) throw new SafeFetchError(SSRF_ERROR.INVALID_URL, 'The URL has no host.');
  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new SafeFetchError(SSRF_ERROR.BLOCKED_HOST, 'This host is not allowed.');
  }
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new SafeFetchError(SSRF_ERROR.BLOCKED_ADDRESS, 'This address is not publicly routable.');
    return { url, address: host, family: net.isIP(host) };
  }
  let records;
  try {
    records = await resolver(host, { all: true, verbatim: true });
  } catch (error) {
    throw new SafeFetchError(SSRF_ERROR.DNS_FAILED, `The host could not be resolved (${error.code || error.message}).`);
  }
  if (!Array.isArray(records) || records.length === 0) throw new SafeFetchError(SSRF_ERROR.DNS_FAILED, 'The host did not resolve.');
  // ALL answers must be public: one internal record is enough to refuse (split-horizon / rebinding tricks).
  const bad = records.find((r) => isBlockedIp(r.address));
  if (bad) throw new SafeFetchError(SSRF_ERROR.BLOCKED_ADDRESS, 'The host resolves to a non-public address.');
  return { url, address: records[0].address, family: records[0].family };
}

const TEXT_TYPE = /^(text\/|application\/(xhtml\+xml|xml|json|ld\+json|rss\+xml|atom\+xml)|image\/svg\+xml)/i;
const sameHost = (a, b) => a.hostname.toLowerCase().replace(/^www\./, '') === b.hostname.toLowerCase().replace(/^www\./, '');

function requestOnce(target, { timeoutMs, maxBytes, headers, signal, method }) {
  return new Promise((resolve, reject) => {
    const { url, address, family } = target;
    const lib = url.protocol === 'https:' ? https : http;
    let settled = false;
    const done = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    if (signal?.aborted) return done(reject, new SafeFetchError(SSRF_ERROR.ABORTED, 'The investigation was cancelled.'));

    const req = lib.request({
      method,
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      // SNI / certificate-name check use the ORIGINAL host name (never the pinned IP); IP literals send no SNI.
      servername: net.isIP(url.hostname.replace(/^\[|\]$/g, '')) ? undefined : url.hostname,
      headers: { Host: url.host, 'Accept-Encoding': 'gzip, deflate, br', ...headers },
      // Pin the socket to the address that was validated above.
      lookup: (_host, _opts, cb) => (_opts?.all ? cb(null, [{ address, family }]) : cb(null, address, family)),
      timeout: timeoutMs,
    }, (res) => {
      const status = res.statusCode || 0;
      const resHeaders = res.headers;
      if (status >= 300 && status < 400 && resHeaders.location) {
        res.resume();
        return done(resolve, { status, headers: resHeaders, redirectTo: resHeaders.location, body: '' });
      }
      const type = String(resHeaders['content-type'] || '');
      if (method !== 'HEAD' && type && !TEXT_TYPE.test(type)) {
        res.destroy();
        return done(reject, new SafeFetchError(SSRF_ERROR.NON_TEXT, `Non-text content type (${type.split(';')[0]}).`, { status }));
      }
      let stream = res;
      const enc = String(resHeaders['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = []; let size = 0;
      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) { res.destroy(); req.destroy(); done(reject, new SafeFetchError(SSRF_ERROR.TOO_LARGE, 'The response is too large to inspect.', { status })); return; }
        chunks.push(chunk);
      });
      stream.on('end', () => done(resolve, { status, headers: resHeaders, redirectTo: null, body: Buffer.concat(chunks).toString('utf8') }));
      stream.on('error', (error) => done(reject, new SafeFetchError(SSRF_ERROR.NETWORK, `The response could not be read (${error.code || error.message}).`)));
    });
    req.on('timeout', () => { req.destroy(); done(reject, new SafeFetchError(SSRF_ERROR.TIMEOUT, 'The page took too long to respond.')); });
    req.on('error', (error) => done(reject, error instanceof SafeFetchError ? error : new SafeFetchError(SSRF_ERROR.NETWORK, `The page could not be fetched (${error.code || error.message}).`)));
    signal?.addEventListener?.('abort', () => { req.destroy(); done(reject, new SafeFetchError(SSRF_ERROR.ABORTED, 'The investigation was cancelled.')); }, { once: true });
    req.end();
  });
}

/**
 * SSRF-safe GET. Returns the final response plus the full redirect chain.
 *
 * @param {string} rawUrl
 * @param {{ timeoutMs?: number, maxBytes?: number, maxRedirects?: number, restrictToHost?: string|null,
 *           signal?: AbortSignal, resolver?: Function, transport?: Function, method?: 'GET'|'HEAD' }} [options]
 * @returns {Promise<{ finalUrl: string, status: number, headers: object, body: string, redirects: Array<{from:string,to:string,status:number}> }>}
 */
export async function safeFetch(rawUrl, options = {}) {
  const {
    timeoutMs = 15_000, maxBytes = 2 * 1024 * 1024, maxRedirects = 4, restrictToHost = null, signal, resolver, transport = requestOnce, method = 'GET',
  } = options;
  const restrict = restrictToHost ? new URL(restrictToHost.includes('://') ? restrictToHost : `https://${restrictToHost}`) : null;
  const redirects = [];
  let current = String(rawUrl);
  const deadline = Date.now() + timeoutMs * 2;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (Date.now() > deadline) throw new SafeFetchError(SSRF_ERROR.TIMEOUT, 'The page took too long to respond.');
    const target = await resolveSafeTarget(current, { resolver });
    if (restrict && !sameHost(target.url, restrict)) {
      throw new SafeFetchError(SSRF_ERROR.CROSS_HOST, 'The request leaves the audited website.', { to: target.url.origin });
    }
    const res = await transport(target, {
      timeoutMs, maxBytes, signal, method,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OditoInvestigator/1.0)', Accept: 'text/html,application/xhtml+xml,application/xml,text/plain,application/json;q=0.9,*/*;q=0.5' },
    });
    if (res.redirectTo) {
      let next;
      try { next = new URL(res.redirectTo, target.url).toString(); } catch { throw new SafeFetchError(SSRF_ERROR.INVALID_URL, 'The redirect target is not a valid URL.'); }
      redirects.push({ from: target.url.toString(), to: next, status: res.status });
      current = next;
      continue;
    }
    return { finalUrl: target.url.toString(), status: res.status, headers: res.headers, body: res.body, redirects };
  }
  throw new SafeFetchError(SSRF_ERROR.TOO_MANY_REDIRECTS, 'The page redirected too many times.', { redirects });
}

/** Exposed for tests only: the raw transport, which assumes its target was already validated by resolveSafeTarget. */
export const __transportForTests = requestOnce;

export default { safeFetch, resolveSafeTarget, isBlockedIp, SafeFetchError, SSRF_ERROR };
