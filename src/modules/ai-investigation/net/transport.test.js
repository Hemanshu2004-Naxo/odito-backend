import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { __transportForTests as transport, SSRF_ERROR } from './ssrfGuard.js';

// The transport is exercised against a real local server. Address validation is covered in ssrfGuard.test.js; here the
// target is built directly (as resolveSafeTarget would) to test pinning, decoding, caps and timeouts on a real socket.
async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const target = (path = '/', host = 'victim.example') => ({ url: new URL(`http://${host}:${port}${path}`), address: '127.0.0.1', family: 4 });
  try { await fn({ target, port }); } finally { await new Promise((r) => server.close(r)); }
}
const opts = (over = {}) => ({ timeoutMs: 1500, maxBytes: 10_000, headers: {}, method: 'GET', ...over });

test('transport: connects to the PINNED address even though the URL host would resolve elsewhere; sends the original Host header', async () => {
  let seenHost;
  await withServer((req, res) => { seenHost = req.headers.host; res.setHeader('content-type', 'text/html'); res.end('<html>pinned</html>'); }, async ({ target, port }) => {
    // 'victim.example' does not resolve in DNS at all: success proves the socket used the pinned address.
    const res = await transport(target('/x'), opts());
    assert.equal(res.status, 200);
    assert.equal(res.body, '<html>pinned</html>');
    assert.equal(seenHost, `victim.example:${port}`);
  });
});

test('transport: decodes gzip, deflate and brotli bodies', async () => {
  await withServer((req, res) => {
    const body = Buffer.from('<html>compressed ✓</html>');
    const enc = req.url.slice(1);
    const out = enc === 'gzip' ? zlib.gzipSync(body) : enc === 'deflate' ? zlib.deflateSync(body) : zlib.brotliCompressSync(body);
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': enc });
    res.end(out);
  }, async ({ target }) => {
    for (const enc of ['gzip', 'deflate', 'br']) assert.equal((await transport(target(`/${enc}`), opts())).body, '<html>compressed ✓</html>', enc);
  });
});

test('transport: a response larger than maxBytes is refused (also when it is a tiny compressed bomb)', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', ...(req.url === '/bomb' ? { 'content-encoding': 'gzip' } : {}) });
    res.end(req.url === '/bomb' ? zlib.gzipSync(Buffer.alloc(5_000_000, 'a')) : Buffer.alloc(50_000, 'a'));
  }, async ({ target }) => {
    await assert.rejects(transport(target('/big'), opts()), (e) => e.code === SSRF_ERROR.TOO_LARGE);
    await assert.rejects(transport(target('/bomb'), opts()), (e) => e.code === SSRF_ERROR.TOO_LARGE);
  });
});

test('transport: binary content types are not read', async () => {
  await withServer((req, res) => { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(Buffer.from([1, 2, 3])); }, async ({ target }) => {
    await assert.rejects(transport(target(), opts()), (e) => e.code === SSRF_ERROR.NON_TEXT);
  });
});

test('transport: redirects are returned to the caller (never followed here) and HTTP errors still carry a status', async () => {
  await withServer((req, res) => {
    if (req.url === '/r') { res.writeHead(302, { location: '/dest' }); return res.end(); }
    res.writeHead(503, { 'content-type': 'text/html' }); res.end('down');
  }, async ({ target }) => {
    const r = await transport(target('/r'), opts());
    assert.equal(r.redirectTo, '/dest');
    assert.equal((await transport(target('/e'), opts())).status, 503);
  });
});

test('transport: a server that never answers times out; an aborted signal cancels', async () => {
  await withServer(() => { /* never respond */ }, async ({ target }) => {
    await assert.rejects(transport(target(), opts({ timeoutMs: 150 })), (e) => e.code === SSRF_ERROR.TIMEOUT);
    const ac = new AbortController();
    const p = transport(target(), opts({ timeoutMs: 5000, signal: ac.signal }));
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(p, (e) => e.code === SSRF_ERROR.ABORTED);
    await assert.rejects(transport(target(), opts({ signal: AbortSignal.abort() })), (e) => e.code === SSRF_ERROR.ABORTED);
  });
});

test('transport: connection refused is a NETWORK error, not a crash', async () => {
  const t = { url: new URL('http://victim.example:9/'), address: '127.0.0.1', family: 4 };
  await assert.rejects(transport(t, opts()), (e) => e.code === SSRF_ERROR.NETWORK);
});
