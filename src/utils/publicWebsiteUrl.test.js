import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { checkPublicWebsiteUrl } from './publicWebsiteUrl.js';

const ok = (u, opts) => checkPublicWebsiteUrl(u, opts).ok;
const reason = (u, opts) => checkPublicWebsiteUrl(u, opts).reason;

describe('checkPublicWebsiteUrl', () => {
  test('accepts ordinary public websites', () => {
    for (const u of ['https://naxonify.com', 'https://naxonify.com/', 'http://example.com/path?q=1', 'https://www.shop.example.co.uk/a/b', 'https://xn--bcher-kva.example']) {
      assert.equal(ok(u), true, u);
    }
  });

  test('rejects anything that is not http(s) - javascript:, file:, ftp:, data:, scheme-less', () => {
    for (const u of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://example.com', 'data:text/html,hi', 'naxonify.com', '//evil.com', 'gopher://example.com']) {
      assert.equal(ok(u), false, u);
    }
  });

  test('rejects loopback, private, link-local and cloud-metadata destinations', () => {
    for (const u of [
      'http://localhost', 'https://localhost/admin', 'http://foo.localhost', 'http://127.0.0.1', 'http://127.1.2.3',
      'http://10.0.0.1', 'http://172.16.0.1', 'http://172.31.255.255', 'http://192.168.1.1',
      'http://169.254.169.254/latest/meta-data/', 'http://0.0.0.0', 'http://100.64.0.1',
      'http://[::1]/', 'http://[fe80::1]/', 'http://[fc00::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/',
      'http://metadata.google.internal/computeMetadata/v1/', 'http://svc.internal', 'http://printer.local', 'http://corp-intranet.corp',
    ]) {
      assert.equal(ok(u, { allowPublicIp: true, allowCustomPorts: true }), false, u);
    }
  });

  test('catches obfuscated IPv4 spellings (decimal, hex, octal, short form) because the URL parser canonicalises them', () => {
    for (const u of ['http://2130706433/', 'http://0x7f000001/', 'http://017700000001/', 'http://127.1/', 'http://0177.0.0.1/']) {
      assert.equal(ok(u, { allowPublicIp: true }), false, u);
    }
  });

  test('rejects credentials in the URL (userinfo is a classic parser-confusion vector)', () => {
    assert.equal(ok('https://user:pw@example.com'), false);
    assert.equal(ok('https://example.com@127.0.0.1/'), false);
    assert.equal(ok('https://good.com@evil.internal/'), false);
  });

  test('custom ports are rejected by default and allowed only when asked (project creation)', () => {
    assert.equal(ok('https://example.com:8443'), false);
    assert.equal(ok('https://example.com:443'), true);
    assert.equal(ok('http://example.com:80'), true);
    assert.equal(ok('https://example.com:8443', { allowCustomPorts: true }), true);
    // ... but never at the cost of reaching an internal host
    assert.equal(ok('http://127.0.0.1:5000', { allowCustomPorts: true, allowPublicIp: true }), false);
  });

  test('IP literals: rejected for the extractor, public ones allowed for legacy project creation', () => {
    assert.equal(ok('http://93.184.216.34'), false);
    assert.equal(reason('http://93.184.216.34'), 'IP addresses are not allowed — use a domain name');
    assert.equal(ok('http://93.184.216.34', { allowPublicIp: true }), true);
  });

  test('rejects a single-label hostname, empty / whitespace / control characters, and over-long input', () => {
    for (const u of ['http://intranet', 'https://', '', '   ', 'https://exa mple.com', 'https://example.com/\u0000', `https://example.com/${'a'.repeat(2100)}`]) {
      assert.equal(ok(u), false, JSON.stringify(u).slice(0, 40));
    }
    assert.equal(ok(undefined), false);
    assert.equal(ok(null), false);
    assert.equal(ok({}), false);
  });

  test('reasons never echo the input back (no reflected content in error messages)', () => {
    const r = reason('https://user:SECRETPW@example.com');
    assert.ok(!r.includes('SECRETPW'));
  });
});
