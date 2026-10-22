import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// REAL TLS handshake on a local socket (integration, no external service). The certificate is valid ONLY for victim.example and is trusted
// only inside the child process. The socket is pinned to 127.0.0.1, so a pass proves: the certificate name and SNI come from the original
// hostname (not the pinned IP), the Host header is the original host, and a certificate for a different name is rejected.
const here = path.dirname(fileURLToPath(import.meta.url));
const hasOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('pinned TLS: certificate + SNI are validated against the ORIGINAL hostname; a mismatching name is refused', { skip: !hasOpenssl && 'openssl not available' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odito-tls-'));
  try {
    const key = path.join(dir, 'k.pem'); const cert = path.join(dir, 'c.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=victim.example', '-addext', 'subjectAltName=DNS:victim.example'], { stdio: 'ignore', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    const child = spawnSync(process.execPath, [path.join(here, '__fixtures__', 'tlsChild.mjs')], {
      encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, NODE_EXTRA_CA_CERTS: cert, TLS_FIXTURE: JSON.stringify({ key, cert }) },
    });
    assert.equal(child.status, 0, child.stderr);
    const out = JSON.parse(child.stdout.trim().split('\n').pop());
    assert.equal(out.good.status, 200, JSON.stringify(out));
    assert.match(out.good.body, /host=victim\.example:\d+/);
    assert.equal(out.good.sni, 'victim.example');
    assert.equal(out.mismatch.error, 'NETWORK', 'a certificate that is not valid for the requested name must not be accepted');
    assert.match(out.mismatch.message, /ERR_TLS_CERT_ALTNAME_INVALID|altnames|Hostname\/IP/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
