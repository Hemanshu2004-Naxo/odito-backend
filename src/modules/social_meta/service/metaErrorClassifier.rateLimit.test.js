import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAuthenticationFailure, isRateLimited } from './metaErrorClassifier.js';

// Live incident (Nov 2026): Meta answered "(#4) Application request limit reached" as HTTP 403 and Odito
// reported "Meta access token is invalid or expired" — and the same rule could expire healthy connections.
const fail = (status, code, extra = {}) => ({ success: false, status, data: { error: { type: 'OAuthException', code, ...extra } } });

test('rate limits are not authentication failures, whatever the HTTP status', () => {
  for (const code of [4, 17, 32, 613, 80001]) {
    assert.equal(isAuthenticationFailure(fail(403, code)), false, `code ${code}`);
    assert.equal(isRateLimited(fail(403, code)), true, `code ${code}`);
  }
  assert.equal(isRateLimited({ success: false, status: 429, data: null }), true);
});

test('transient Meta errors (1, 2) on a 403 are not authentication failures', () => {
  assert.equal(isAuthenticationFailure(fail(403, 2)), false);
});

test('real dead-token answers are still authentication failures', () => {
  assert.equal(isAuthenticationFailure(fail(400, 190)), true);
  assert.equal(isAuthenticationFailure(fail(400, 100, { error_subcode: 463 })), true);
  assert.equal(isAuthenticationFailure({ success: false, status: 401, data: null }), true);
  assert.equal(isAuthenticationFailure({ success: false, status: 403, data: { error: { code: 999 } } }), true);
  assert.equal(isRateLimited(fail(400, 190)), false);
});
