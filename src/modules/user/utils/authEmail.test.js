import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAuthEmail } from './authEmail.js';

describe('normalizeAuthEmail — the single canonical auth-email form (H3 fix)', () => {
  test('trims surrounding whitespace and lowercases', () => {
    assert.equal(normalizeAuthEmail('  Jane.Doe@Example.COM  '), 'jane.doe@example.com');
  });

  test('preserves Gmail dots and +tags — it must NOT do what express-validator normalizeEmail() did', () => {
    // This is the whole point of the fix: the value stored at registration
    // (lowercase + trim only) has to be exactly what every later lookup
    // computes, or a dotted Gmail address can never verify or reset.
    assert.equal(normalizeAuthEmail('jane.doe+news@gmail.com'), 'jane.doe+news@gmail.com');
    assert.equal(normalizeAuthEmail('J.A.N.E@googlemail.com'), 'j.a.n.e@googlemail.com');
  });

  test('is idempotent (safe to apply on both write and read paths, and twice)', () => {
    const once = normalizeAuthEmail('  Foo@Bar.com ');
    assert.equal(normalizeAuthEmail(once), once);
  });

  test('nullish / non-string input yields an empty string, never throws', () => {
    assert.equal(normalizeAuthEmail(undefined), '');
    assert.equal(normalizeAuthEmail(null), '');
    assert.equal(normalizeAuthEmail(123), '');
    assert.equal(normalizeAuthEmail({}), '');
  });

  test('matches the exact legacy behaviour it replaces (email.toLowerCase().trim())', () => {
    for (const raw of ['A@B.COM', '  x@y.z', 'Mixed.Case@Domain.io  ', 'no-change@example.com']) {
      assert.equal(normalizeAuthEmail(raw), raw.toLowerCase().trim());
    }
  });
});
