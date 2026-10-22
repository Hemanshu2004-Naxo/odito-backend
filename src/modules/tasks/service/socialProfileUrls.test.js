import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SOCIAL_PROFILE_ERRORS as E,
  SOCIAL_PROFILE_LIMITS,
  sameAsComparisonKey,
  validateSocialProfileList,
  validateSocialProfileUrl,
} from './socialProfileUrls.js';

/**
 * These vectors are MIRRORED in frontend/lib/socialProfileUrl.test.js — the
 * frontend validates for convenience, this module is the enforcement, and the
 * two must never disagree about what a valid profile URL is.
 */
const VALID = [
  ['https://www.linkedin.com/company/example', 'https://www.linkedin.com/company/example'],
  ['https://www.facebook.com/example', 'https://www.facebook.com/example'],
  ['https://www.instagram.com/example', 'https://www.instagram.com/example'],
  ['https://x.com/example', 'https://x.com/example'],
  ['https://www.youtube.com/@example', 'https://www.youtube.com/@example'],
  ['http://example.com/profile', 'http://example.com/profile'],
  ['https://www.facebook.com/profile.php?id=12345', 'https://www.facebook.com/profile.php?id=12345'],
  // normalization
  ['  https://x.com/example  ', 'https://x.com/example'],
  ['https://X.COM/Example', 'https://x.com/Example'], // host lower-cased, path case preserved
  ['HTTPS://x.com/example', 'https://x.com/example'],
  ['https://x.com/example/', 'https://x.com/example'],
  ['https://x.com/example///', 'https://x.com/example'],
  ['https://example.com/', 'https://example.com'],
  ['https://example.com', 'https://example.com'],
  ['https://x.com/example#section', 'https://x.com/example'],
  ['https://sub.domain.co.uk/a/b', 'https://sub.domain.co.uk/a/b'],
  ['https://münchen.de/profil', 'https://xn--mnchen-3ya.de/profil'],
];

const INVALID = [
  ['javascript:alert(1)', E.NOT_HTTP],
  ['JaVaScRiPt:alert(1)', E.NOT_HTTP],
  ['data:text/html,<script>alert(1)</script>', E.INVALID_CHARACTERS], // markup is caught first; either way it is refused
  ['data:text/plain;base64,QUJD', E.NOT_HTTP],
  ['vbscript:x', E.NOT_HTTP],
  ['ftp://example.com/file', E.NOT_HTTP],
  ['mailto:someone@example.com', E.NOT_HTTP],
  ['/relative/path', E.NOT_HTTP],
  ['//example.com/profile', E.NOT_HTTP],
  ['www.linkedin.com/company/example', E.NOT_HTTP],
  ['linkedin.com/company/example', E.NOT_HTTP],
  ['', E.EMPTY],
  ['   ', E.EMPTY],
  ['\t\n', E.EMPTY],
  ['<a href="https://x.com/a">x</a>', E.INVALID_CHARACTERS],
  ['https://x.com/<b>', E.INVALID_CHARACTERS],
  ['https://x.com/a"onmouseover=x', E.INVALID_CHARACTERS],
  ['https://x.com/back\\slash', E.INVALID_CHARACTERS],
  ['https://x.com/a b', E.INVALID_CHARACTERS],
  ['https://x.com/a\nhttps://evil.com', E.INVALID_CHARACTERS], // would inject a second stored profile
  ['https://x.com/a\r\nhttps://evil.com', E.INVALID_CHARACTERS],
  ['https://x.com/a\u0000', E.INVALID_CHARACTERS],
  ['https://user:pass@example.com/a', E.CREDENTIALS],
  ['https://user@example.com/a', E.CREDENTIALS],
  ['https://example.com:8080/a', E.PORT],
  ['https://localhost/a', E.INVALID_HOST],
  ['https://intranet/a', E.INVALID_HOST],
  ['https://127.0.0.1/a', E.INVALID_HOST],
  ['https://192.168.1.10/a', E.INVALID_HOST],
  ['https://[::1]/a', E.INVALID_HOST],
  ['https://-bad.example.com/a', E.INVALID_HOST],
  ['https://', E.INVALID_URL],
  ['http://', E.INVALID_URL],
];

describe('validateSocialProfileUrl', () => {
  for (const [input, expected] of VALID) {
    test(`accepts and normalizes ${JSON.stringify(input)} -> ${expected}`, () => {
      assert.deepEqual(validateSocialProfileUrl(input), { ok: true, url: expected });
    });
  }

  for (const [input, code] of INVALID) {
    test(`rejects ${JSON.stringify(input)} (${code})`, () => {
      const result = validateSocialProfileUrl(input);
      assert.equal(result.ok, false);
      assert.equal(result.code, code);
      assert.ok(result.message.length > 0);
    });
  }

  test('rejects non-strings', () => {
    for (const bad of [null, undefined, 42, {}, [], true]) {
      assert.equal(validateSocialProfileUrl(bad).code, E.NOT_A_STRING);
    }
  });

  test('rejects a URL over the length limit', () => {
    const long = `https://example.com/${'a'.repeat(SOCIAL_PROFILE_LIMITS.maxUrlLength)}`;
    assert.equal(validateSocialProfileUrl(long).code, E.TOO_LONG);
  });

  test('is idempotent: normalizing a normalized URL changes nothing', () => {
    for (const [, normalized] of VALID) {
      assert.deepEqual(validateSocialProfileUrl(normalized), { ok: true, url: normalized });
    }
  });
});

describe('sameAsComparisonKey — lenient, scheme- and trailing-slash-insensitive', () => {
  test('treats http/https and a trailing slash as the same profile', () => {
    const key = sameAsComparisonKey('https://www.linkedin.com/company/example');
    assert.equal(sameAsComparisonKey('http://www.linkedin.com/company/example/'), key);
    assert.equal(sameAsComparisonKey('HTTPS://WWW.LINKEDIN.COM/company/example'), key);
  });

  test('different paths (or path case) are different profiles', () => {
    assert.notEqual(sameAsComparisonKey('https://x.com/Example'), sameAsComparisonKey('https://x.com/example'));
    assert.notEqual(sameAsComparisonKey('https://x.com/a'), sameAsComparisonKey('https://x.com/b'));
  });

  test('never throws on values that were not validated by us — yields null', () => {
    for (const junk of [null, undefined, 5, '', 'not a url', 'javascript:alert(1)', { a: 1 }]) {
      assert.equal(sameAsComparisonKey(junk), null);
    }
  });
});

describe('validateSocialProfileList', () => {
  test('one valid URL', () => {
    const r = validateSocialProfileList(['https://www.linkedin.com/company/example'], { min: 1 });
    assert.deepEqual(r, { valid: true, urls: ['https://www.linkedin.com/company/example'], keys: ['www.linkedin.com/company/example'] });
  });

  test('several valid URLs keep their order', () => {
    const r = validateSocialProfileList(['https://x.com/a', 'https://www.youtube.com/@a', 'https://www.instagram.com/a'], { min: 1 });
    assert.equal(r.valid, true);
    assert.deepEqual(r.urls, ['https://x.com/a', 'https://www.youtube.com/@a', 'https://www.instagram.com/a']);
  });

  test('a duplicate — even one differing only by trailing slash, scheme or host case — is rejected, naming the second entry', () => {
    for (const dup of ['https://x.com/a', 'https://x.com/a/', 'http://X.com/a', '  https://x.com/a  ']) {
      const r = validateSocialProfileList(['https://x.com/a', dup], { min: 1 });
      assert.equal(r.valid, false, dup);
      assert.deepEqual(r.errors.map((e) => [e.index, e.code]), [[1, E.DUPLICATE]]);
    }
  });

  test('one bad entry rejects the whole list, and every bad entry is reported with its index', () => {
    const r = validateSocialProfileList(['https://x.com/a', 'javascript:alert(1)', '', 'https://x.com/b'], { min: 1 });
    assert.equal(r.valid, false);
    assert.deepEqual(r.errors.map((e) => [e.index, e.code]), [[1, E.NOT_HTTP], [2, E.EMPTY]]);
  });

  test('an empty list fails a min:1 requirement but is fine at min:0', () => {
    assert.equal(validateSocialProfileList([], { min: 1 }).valid, false);
    assert.deepEqual(validateSocialProfileList([], { min: 0 }), { valid: true, urls: [], keys: [] });
  });

  test('a non-array is rejected', () => {
    for (const bad of ['https://x.com/a', { 0: 'https://x.com/a' }, null, undefined]) {
      assert.equal(validateSocialProfileList(bad).valid, false);
    }
  });

  test('too many profiles in one request is rejected', () => {
    const many = Array.from({ length: SOCIAL_PROFILE_LIMITS.maxProfilesPerRequest + 1 }, (_, i) => `https://example.com/p${i}`);
    const r = validateSocialProfileList(many, { min: 1 });
    assert.equal(r.valid, false);
    assert.equal(r.errors[0].code, 'TOO_MANY');
  });
});
