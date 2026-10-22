// Child process for tls.integration.test.js. Trusts ONLY the test CA (via NODE_EXTRA_CA_CERTS set by the parent).
import https from 'node:https';
import fs from 'node:fs';
import { __transportForTests as transport } from '../ssrfGuard.js';

const { key, cert } = JSON.parse(process.env.TLS_FIXTURE);
let seenSni = null;
const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert), SNICallback: (name, cb) => { seenSni = name; cb(null, undefined); } }, (req, res) => {
  res.setHeader('content-type', 'text/html'); res.end(`<html>host=${req.headers.host}</html>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const opts = { timeoutMs: 3000, maxBytes: 10000, headers: {}, method: 'GET' };
const pinned = (host) => ({ url: new URL(`https://${host}:${port}/`), address: '127.0.0.1', family: 4 });
const out = {};
try { const r = await transport(pinned('victim.example'), opts); out.good = { status: r.status, body: r.body, sni: seenSni }; } catch (e) { out.good = { error: e.code, message: e.message }; }
try { await transport(pinned('other.example'), opts); out.mismatch = { unexpectedSuccess: true }; } catch (e) { out.mismatch = { error: e.code, message: e.message }; }
server.close();
console.log(JSON.stringify(out));
