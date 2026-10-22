import test from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedIp, resolveSafeTarget, safeFetch, SSRF_ERROR } from './ssrfGuard.js';

const resolverTo = (...addresses) => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
const rejects = (promise, code) => assert.rejects(promise, (e) => e.code === code, `expected ${code}`);

test('isBlockedIp: private, loopback, link-local, metadata and reserved IPv4 are blocked; public is allowed', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1']) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '11.0.0.1']) assert.equal(isBlockedIp(ip), false, ip);
});

test('isBlockedIp: IPv6 loopback, ULA, link-local, mapped/NAT64/6to4 wrappers of private IPv4 are blocked', () => {
  for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1', '2002:7f00:1::1', '2001:db8::1']) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
  assert.equal(isBlockedIp('2606:4700:4700::1111'), false);
  assert.equal(isBlockedIp('::ffff:8.8.8.8'), false);
  assert.equal(isBlockedIp('not-an-ip'), true);
});

test('resolveSafeTarget: rejects bad schemes, ports, credentials and internal host names before any DNS', async () => {
  const resolver = async () => { throw new Error('DNS must not be consulted'); };
  await rejects(resolveSafeTarget('file:///etc/passwd', { resolver }), SSRF_ERROR.BLOCKED_SCHEME);
  await rejects(resolveSafeTarget('gopher://example.com', { resolver }), SSRF_ERROR.BLOCKED_SCHEME);
  await rejects(resolveSafeTarget('https://example.com:6379/', { resolver }), SSRF_ERROR.BLOCKED_PORT);
  await rejects(resolveSafeTarget('https://user:pw@example.com/', { resolver }), SSRF_ERROR.BLOCKED_CREDENTIALS);
  await rejects(resolveSafeTarget('http://localhost/', { resolver }), SSRF_ERROR.BLOCKED_HOST);
  await rejects(resolveSafeTarget('http://app.localhost/', { resolver }), SSRF_ERROR.BLOCKED_HOST);
  await rejects(resolveSafeTarget('http://metadata.google.internal/computeMetadata/v1/', { resolver }), SSRF_ERROR.BLOCKED_HOST);
  await rejects(resolveSafeTarget('http://169.254.169.254/latest/meta-data/', { resolver }), SSRF_ERROR.BLOCKED_ADDRESS);
  await rejects(resolveSafeTarget('http://[::1]/', { resolver }), SSRF_ERROR.BLOCKED_ADDRESS);
  await rejects(resolveSafeTarget('not a url', { resolver }), SSRF_ERROR.INVALID_URL);
});

test('resolveSafeTarget: decimal / hex / octal IPv4 spellings are normalised by URL parsing and still blocked', async () => {
  const resolver = async () => { throw new Error('no DNS'); };
  for (const u of ['http://2130706433/', 'http://0x7f.0.0.1/', 'http://0177.0.0.1/', 'http://127.1/']) {
    await rejects(resolveSafeTarget(u, { resolver }), SSRF_ERROR.BLOCKED_ADDRESS);
  }
});

test('resolveSafeTarget: a hostname that resolves to ANY internal address is refused (split-horizon / rebinding answers)', async () => {
  await rejects(resolveSafeTarget('https://evil.example/', { resolver: resolverTo('93.184.216.34', '10.0.0.5') }), SSRF_ERROR.BLOCKED_ADDRESS);
  await rejects(resolveSafeTarget('https://evil.example/', { resolver: resolverTo('127.0.0.1') }), SSRF_ERROR.BLOCKED_ADDRESS);
  await rejects(resolveSafeTarget('https://evil.example/', { resolver: resolverTo('::ffff:169.254.169.254') }), SSRF_ERROR.BLOCKED_ADDRESS);
  await rejects(resolveSafeTarget('https://nx.example/', { resolver: async () => { const e = new Error('x'); e.code = 'ENOTFOUND'; throw e; } }), SSRF_ERROR.DNS_FAILED);
  const ok = await resolveSafeTarget('https://good.example/', { resolver: resolverTo('93.184.216.34') });
  assert.equal(ok.address, '93.184.216.34');
});

test('safeFetch: connects to the VALIDATED address (pinned) and returns body + redirect chain', async () => {
  const seen = [];
  const transport = async (target) => {
    seen.push({ url: target.url.toString(), address: target.address });
    if (target.url.pathname === '/a') return { status: 301, headers: {}, redirectTo: '/b', body: '' };
    return { status: 200, headers: { 'content-type': 'text/html' }, redirectTo: null, body: '<html>ok</html>' };
  };
  const res = await safeFetch('https://good.example/a', { resolver: resolverTo('93.184.216.34'), transport });
  assert.equal(res.status, 200);
  assert.equal(res.finalUrl, 'https://good.example/b');
  assert.deepEqual(res.redirects.map((r) => r.status), [301]);
  assert.ok(seen.every((s) => s.address === '93.184.216.34'));
});

test('safeFetch: every redirect hop is re-validated (redirect to metadata IP / localhost is blocked)', async () => {
  for (const evil of ['http://169.254.169.254/latest/meta-data/', 'http://localhost:80/admin', 'http://[::1]/', 'file:///etc/passwd']) {
    let hops = 0;
    const transport = async () => { hops += 1; return { status: 302, headers: {}, redirectTo: evil, body: '' }; };
    await assert.rejects(safeFetch('https://good.example/', { resolver: resolverTo('93.184.216.34'), transport }), (e) => [SSRF_ERROR.BLOCKED_ADDRESS, SSRF_ERROR.BLOCKED_HOST, SSRF_ERROR.BLOCKED_SCHEME].includes(e.code), evil);
    assert.equal(hops, 1, 'must not follow the unsafe hop');
  }
});

test('safeFetch: redirect to a hostname that RESOLVES to a private IP is blocked at the hop', async () => {
  const resolver = async (host) => (host === 'good.example' ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '192.168.0.9', family: 4 }]);
  const transport = async (t) => (t.url.hostname === 'good.example'
    ? { status: 302, headers: {}, redirectTo: 'https://sneaky.example/', body: '' }
    : { status: 200, headers: {}, redirectTo: null, body: 'secret' });
  await rejects(safeFetch('https://good.example/', { resolver, transport }), SSRF_ERROR.BLOCKED_ADDRESS);
});

test('safeFetch: restrictToHost keeps the investigation on the audited site (www-insensitive) and bounds redirects', async () => {
  const resolver = resolverTo('93.184.216.34');
  const ok = async () => ({ status: 200, headers: {}, redirectTo: null, body: 'x' });
  await safeFetch('https://www.site.test/p', { resolver, transport: ok, restrictToHost: 'https://site.test' });
  await rejects(safeFetch('https://other.test/p', { resolver, transport: ok, restrictToHost: 'https://site.test' }), SSRF_ERROR.CROSS_HOST);
  const crossRedirect = async (t) => (t.url.hostname === 'site.test' ? { status: 302, headers: {}, redirectTo: 'https://other.test/', body: '' } : { status: 200, headers: {}, redirectTo: null, body: '' });
  await rejects(safeFetch('https://site.test/', { resolver, transport: crossRedirect, restrictToHost: 'https://site.test' }), SSRF_ERROR.CROSS_HOST);
  const loop = async () => ({ status: 302, headers: {}, redirectTo: '/again', body: '' });
  await rejects(safeFetch('https://site.test/', { resolver, transport: loop, maxRedirects: 3 }), SSRF_ERROR.TOO_MANY_REDIRECTS);
});

test('safeFetch against the real transport refuses loopback without opening a socket', async () => {
  await rejects(safeFetch('http://127.0.0.1:80/'), SSRF_ERROR.BLOCKED_ADDRESS);
  await rejects(safeFetch('http://127.0.0.1:8080/'), SSRF_ERROR.BLOCKED_PORT);
});
