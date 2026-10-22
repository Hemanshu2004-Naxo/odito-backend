import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveTrustedSitelinkUrls } from './sitelinkResolver.js';

describe('resolveTrustedSitelinkUrls', () => {
  test('returns both URLs when the landing page and project website differ', () => {
    const { urls, reason } = resolveTrustedSitelinkUrls({
      brief: { landingPageUrl: 'https://acme.example.com/landing' },
      context: { project: { websiteUrl: 'https://www.acme.example.com/' } },
    });
    assert.deepEqual(urls, ['https://acme.example.com/landing', 'https://www.acme.example.com/']);
    assert.equal(reason, 'insufficient_verified_pages');
  });

  test('de-duplicates when the landing page IS the project website', () => {
    const { urls, reason } = resolveTrustedSitelinkUrls({
      brief: { landingPageUrl: 'https://acme.example.com/' },
      context: { project: { websiteUrl: 'https://acme.example.com/' } },
    });
    assert.deepEqual(urls, ['https://acme.example.com/']);
    assert.equal(reason, 'insufficient_verified_pages');
  });

  test('returns a single URL when only the project website is known', () => {
    const { urls } = resolveTrustedSitelinkUrls({
      brief: {},
      context: { project: { websiteUrl: 'https://acme.example.com/' } },
    });
    assert.deepEqual(urls, ['https://acme.example.com/']);
  });

  test('returns zero URLs and a distinct reason when nothing is available', () => {
    const { urls, reason } = resolveTrustedSitelinkUrls({ brief: {}, context: {} });
    assert.deepEqual(urls, []);
    assert.equal(reason, 'no_verified_urls_available');
  });

  test('rejects a non-http(s) landing page URL rather than trusting it', () => {
    const { urls } = resolveTrustedSitelinkUrls({
      brief: { landingPageUrl: 'javascript:alert(1)' },
      context: { project: { websiteUrl: 'https://acme.example.com/' } },
    });
    assert.deepEqual(urls, ['https://acme.example.com/']);
  });

  test('handles missing brief/context gracefully', () => {
    const { urls, reason } = resolveTrustedSitelinkUrls();
    assert.deepEqual(urls, []);
    assert.equal(reason, 'no_verified_urls_available');
  });
});
