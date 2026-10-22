import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { TechnicalChecksService } from './technicalChecks.service.js';

// Root-cause regression coverage: getSSLCertificateCheck() used to treat any
// falsy `sslValid` as CRITICAL "SSL certificate not found or invalid",
// including cases where the Python checker simply couldn't verify the cert
// on that run (missing dependency, DNS hiccup, timeout, blocked crawler) --
// producing a false positive for every project regardless of the site's
// actual certificate. These tests pin the corrected sslStatus -> UI status
// mapping so that regression can't come back silently.

describe('TechnicalChecksService.getSSLCertificateCheck', () => {
  test('VALID with plenty of days remaining -> OK', () => {
    const check = TechnicalChecksService.getSSLCertificateCheck({
      sslStatus: 'VALID',
      sslValid: true,
      sslDaysRemaining: 67,
      sslMessage: 'SSL certificate is valid (expires 2026-11-25)'
    });
    assert.equal(check.status, 'OK');
    assert.equal(check.message, 'SSL certificate is valid (expires 2026-11-25)');
  });

  test('VALID with < 30 days remaining -> Warning (expiring soon)', () => {
    const check = TechnicalChecksService.getSSLCertificateCheck({
      sslStatus: 'VALID',
      sslValid: true,
      sslDaysRemaining: 12
    });
    assert.equal(check.status, 'Warning');
    assert.match(check.message, /expires in 12 days/);
  });

  test('EXPIRED_CERTIFICATE -> Critical with specific message', () => {
    const check = TechnicalChecksService.getSSLCertificateCheck({
      sslStatus: 'EXPIRED_CERTIFICATE',
      sslValid: false,
      sslMessage: 'Certificate expired on 2024-01-01'
    });
    assert.equal(check.status, 'Critical');
    assert.equal(check.message, 'Certificate expired on 2024-01-01');
  });

  test('HOSTNAME_MISMATCH -> Critical with specific message', () => {
    const check = TechnicalChecksService.getSSLCertificateCheck({
      sslStatus: 'HOSTNAME_MISMATCH',
      sslValid: false,
      sslMessage: 'Certificate hostname does not match www.example.com (certificate is valid for: example.com)'
    });
    assert.equal(check.status, 'Critical');
    assert.match(check.message, /hostname does not match/);
  });

  test('CERTIFICATE_CHAIN_ERROR -> Critical', () => {
    const check = TechnicalChecksService.getSSLCertificateCheck({
      sslStatus: 'CERTIFICATE_CHAIN_ERROR',
      sslValid: false,
      sslMessage: 'Certificate chain could not be verified (issuer: self-signed)'
    });
    assert.equal(check.status, 'Critical');
  });

  test('NO_HTTPS -> Critical', () => {
    const check = TechnicalChecksService.getSSLCertificateCheck({
      sslStatus: 'NO_HTTPS',
      sslValid: false,
      sslMessage: 'No service listening on example.com:443 (HTTPS unavailable)'
    });
    assert.equal(check.status, 'Critical');
  });

  test('DNS_ERROR -> Warning (not Critical) — unable to verify, not proven broken', () => {
    const check = TechnicalChecksService.getSSLCertificateCheck({
      sslStatus: 'DNS_ERROR',
      sslValid: false,
      sslMessage: 'Could not resolve hostname example.com (DNS lookup failed)'
    });
    assert.equal(check.status, 'Warning');
    assert.notEqual(check.status, 'Critical');
  });

  test('TIMEOUT -> Warning (not Critical)', () => {
    const check = TechnicalChecksService.getSSLCertificateCheck({
      sslStatus: 'TIMEOUT',
      sslValid: false
    });
    assert.equal(check.status, 'Warning');
  });

  test('BLOCKED -> Warning (not Critical)', () => {
    const check = TechnicalChecksService.getSSLCertificateCheck({
      sslStatus: 'BLOCKED',
      sslValid: false
    });
    assert.equal(check.status, 'Warning');
  });

  test('missing sslStatus + missing dependency (UNKNOWN) -> Warning, never Critical', () => {
    // This is the exact shape a report had while the `cryptography` package
    // was missing from requirements.txt: sslValid=false with no further
    // detail. It must NOT collapse to the old generic Critical message.
    const check = TechnicalChecksService.getSSLCertificateCheck({
      sslStatus: 'UNKNOWN',
      sslValid: false,
      sslMessage: 'SSL verification unavailable (missing server dependency)'
    });
    assert.equal(check.status, 'Warning');
    assert.equal(check.message, 'SSL verification unavailable (missing server dependency)');
  });

  test('legacy report with only sslValid=true (no sslStatus field) -> OK', () => {
    const check = TechnicalChecksService.getSSLCertificateCheck({
      sslValid: true,
      sslDaysRemaining: 90
    });
    assert.equal(check.status, 'OK');
  });

  test('legacy report with only sslValid=false (no sslStatus field) -> Warning, not Critical', () => {
    // Before this fix, this exact shape produced CRITICAL "SSL certificate
    // not found or invalid" unconditionally. Now that we can't distinguish
    // "verified broken" from "not verified" for legacy data, we must not
    // default to accusing the site of a security problem.
    const check = TechnicalChecksService.getSSLCertificateCheck({
      sslValid: false
    });
    assert.equal(check.status, 'Warning');
  });

  test('no domain report at all -> Warning, not Critical', () => {
    const check = TechnicalChecksService.getSSLCertificateCheck(null);
    assert.equal(check.status, 'Warning');
  });

  test('sapphiredigitalagency.com reproduction: VALID report -> OK, not the old false-positive Critical', () => {
    const check = TechnicalChecksService.getSSLCertificateCheck({
      sslStatus: 'VALID',
      sslValid: true,
      sslExpiryDate: new Date('2026-11-25T08:02:42Z'),
      sslDaysRemaining: 67,
      sslMessage: 'SSL certificate is valid (expires 2026-11-25)',
      sslDetails: {
        subject: 'sapphiredigitalagency.com',
        issuer: "Let's Encrypt",
        san: ['sapphiredigitalagency.com', 'www.sapphiredigitalagency.com'],
        tls_version: 'TLSv1.3'
      }
    });
    assert.equal(check.status, 'OK');
    assert.equal(check.id, 'ssl_certificate');
  });
});
