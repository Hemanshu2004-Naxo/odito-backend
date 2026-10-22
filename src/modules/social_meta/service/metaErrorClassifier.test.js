import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMetaFailure, isAuthenticationFailure, CATEGORY, OUTCOME } from './metaErrorClassifier.js';

/**
 * Regression coverage for the audit finding "Meta errors are classified by
 * HTTP status only": Meta reports an invalid/expired token as HTTP 400 with
 * error.code 190, throttling as HTTP 400 with codes 4/17/32/613, etc. Every
 * case here is a real Graph API response shape, fed to the one shared
 * classifier the adapters and sync/overview services now use.
 */

const http = (status, error) => ({ success: false, kind: 'http', status, data: error ? { error } : null, message: error?.message || 'x' });

describe('metaErrorClassifier — authentication (code 190 family)', () => {
  test('HTTP 400 + code 190 is an expired/invalid token (the case a status-only check missed)', () => {
    const c = classifyMetaFailure(http(400, { type: 'OAuthException', code: 190, message: 'Error validating access token: Session has expired' }), { platform: 'facebook', finalPublishStep: true });
    assert.equal(c.category, CATEGORY.AUTHENTICATION);
    assert.equal(c.code, 'FACEBOOK_TOKEN_INVALID');
    assert.equal(c.accountAction, 'expire');
    assert.equal(c.requiresReconnect, true);
    assert.equal(c.retryable, false);
    assert.equal(c.outcome, OUTCOME.NOT_PUBLISHED);
  });

  test('error_subcode 463 (expired) and 467 (invalid) classify as token failures even without code 190', () => {
    for (const sub of [458, 459, 460, 463, 464, 467]) {
      const c = classifyMetaFailure(http(400, { type: 'OAuthException', code: 999, error_subcode: sub, message: 'x' }), { platform: 'instagram' });
      assert.equal(c.code, 'INSTAGRAM_TOKEN_INVALID', `subcode ${sub}`);
      assert.equal(c.accountAction, 'expire');
    }
  });

  test('a bare 401 or 403 is still a token failure (existing behavior preserved)', () => {
    assert.equal(classifyMetaFailure(http(401, null)).code, 'FACEBOOK_TOKEN_INVALID');
    assert.equal(classifyMetaFailure(http(403, null)).code, 'FACEBOOK_TOKEN_INVALID');
  });

  test('a 403 whose body is a named PERMISSION error is NOT an expired token (must not expire a working connection)', () => {
    const c = classifyMetaFailure(http(403, { type: 'OAuthException', code: 200, message: '(#200) requires pages_manage_posts permission' }), { platform: 'facebook' });
    assert.equal(c.code, 'FACEBOOK_PERMISSION_MISSING');
    assert.equal(c.accountAction, 'none', 'a missing permission does not expire the token');
    assert.equal(c.requiresReconnect, true);
    assert.equal(c.retryable, false);
    assert.equal(isAuthenticationFailure(http(403, { type: 'OAuthException', code: 200, message: 'needs permission' })), false);
  });

  test('code 190 wins even if its message happens to mention a permission', () => {
    const c = classifyMetaFailure(http(400, { type: 'OAuthException', code: 190, message: 'The user has not authorized application permission' }));
    assert.equal(c.code, 'FACEBOOK_TOKEN_INVALID');
  });
});

describe('metaErrorClassifier — rate limiting', () => {
  test('codes 4, 17, 32 and 613 (returned as HTTP 400) are RATE_LIMIT and retryable', () => {
    for (const code of [4, 17, 32, 613]) {
      const c = classifyMetaFailure(http(400, { type: 'OAuthException', code, message: 'Calls to this api have exceeded the rate limit' }), { platform: 'instagram', finalPublishStep: true });
      assert.equal(c.category, CATEGORY.RATE_LIMIT, `code ${code}`);
      assert.equal(c.code, 'INSTAGRAM_RATE_LIMITED');
      assert.equal(c.retryable, true);
      assert.equal(c.outcome, OUTCOME.NOT_PUBLISHED, 'Meta explicitly rejected the call, so nothing was published');
      assert.equal(c.accountAction, 'none');
    }
  });

  test('Business Use Case limit codes (80000–80014) and HTTP 429 are RATE_LIMIT too', () => {
    assert.equal(classifyMetaFailure(http(400, { code: 80001, message: 'x' })).category, CATEGORY.RATE_LIMIT);
    assert.equal(classifyMetaFailure(http(429, null)).category, CATEGORY.RATE_LIMIT);
  });
});

describe('metaErrorClassifier — transient server errors', () => {
  test('a 5xx on a NON-final call is a retryable TRANSIENT failure with a definite not_published outcome', () => {
    const c = classifyMetaFailure(http(503, null), { platform: 'facebook', finalPublishStep: false });
    assert.equal(c.category, CATEGORY.TRANSIENT);
    assert.equal(c.retryable, true);
    assert.equal(c.outcome, OUTCOME.NOT_PUBLISHED);
    assert.equal(c.code, 'FACEBOOK_PUBLISH_FAILED', 'existing code kept so current UI/tests keep working');
  });

  test('a 5xx on the FINAL publish call is an UNKNOWN outcome (the post may have been created)', () => {
    const c = classifyMetaFailure(http(500, null), { platform: 'facebook', finalPublishStep: true });
    assert.equal(c.category, CATEGORY.TRANSIENT);
    assert.equal(c.retryable, true);
    assert.equal(c.outcome, OUTCOME.UNKNOWN);
  });

  test('error.is_transient:true and codes 1/2 are transient and retryable', () => {
    assert.equal(classifyMetaFailure(http(400, { code: 368, is_transient: true, message: 'x' })).category, CATEGORY.TRANSIENT);
    assert.equal(classifyMetaFailure(http(400, { code: 2, message: 'Service temporarily unavailable' })).retryable, true);
    assert.equal(classifyMetaFailure(http(500, { code: 1, message: 'An unknown error occurred' })).retryable, true);
  });
});

describe('metaErrorClassifier — no usable answer from Meta (timeout / network)', () => {
  test('a timeout on the FINAL publish call is UNKNOWN_OUTCOME — never a plain failure', () => {
    const c = classifyMetaFailure({ success: false, kind: 'timeout', status: null, data: null, message: 'timed out' }, { platform: 'facebook', finalPublishStep: true });
    assert.equal(c.category, CATEGORY.UNKNOWN_OUTCOME);
    assert.equal(c.code, 'PUBLISH_OUTCOME_UNKNOWN');
    assert.equal(c.outcome, OUTCOME.UNKNOWN);
  });

  test('a connection reset on the final call is also UNKNOWN_OUTCOME', () => {
    const c = classifyMetaFailure({ success: false, kind: 'network_unknown', status: null, data: null, message: 'reset' }, { platform: 'instagram', finalPublishStep: true });
    assert.equal(c.category, CATEGORY.UNKNOWN_OUTCOME);
    assert.equal(c.outcome, OUTCOME.UNKNOWN);
  });

  test('a timeout on a NON-final call (e.g. creating an unpublished Instagram container) cannot have published anything — retryable, definite', () => {
    const c = classifyMetaFailure({ success: false, kind: 'timeout', status: null, data: null, message: 'timed out' }, { platform: 'instagram', finalPublishStep: false });
    assert.equal(c.category, CATEGORY.TRANSIENT);
    assert.equal(c.outcome, OUTCOME.NOT_PUBLISHED);
    assert.equal(c.retryable, true);
  });

  test('a request that provably never left Odito (DNS/refused) is a definite, retryable failure even on the final call', () => {
    const c = classifyMetaFailure({ success: false, kind: 'network_unsent', status: null, data: null, message: 'x' }, { platform: 'facebook', finalPublishStep: true });
    assert.equal(c.outcome, OUTCOME.NOT_PUBLISHED);
    assert.equal(c.retryable, true);
  });

  test('an old-shape result with no `kind` and no status is treated as the SAFE interpretation (unknown on the final call)', () => {
    const c = classifyMetaFailure({ success: false, status: null, data: null, message: 'Meta API request timed out' }, { finalPublishStep: true });
    assert.equal(c.outcome, OUTCOME.UNKNOWN);
  });
});

describe('metaErrorClassifier — validation / permanent', () => {
  test('media problems are VALIDATION and never retryable', () => {
    const c = classifyMetaFailure(http(400, { type: 'OAuthException', code: 9004, message: 'Only photo or video can be accepted as media type' }), { platform: 'instagram' });
    assert.equal(c.category, CATEGORY.VALIDATION);
    assert.equal(c.code, 'INSTAGRAM_MEDIA_INVALID');
    assert.equal(c.retryable, false);
  });

  test('an unrecognized 4xx is PERMANENT, not retryable, and keeps the generic code', () => {
    const c = classifyMetaFailure(http(400, { type: 'GraphMethodException', code: 100, message: 'Invalid parameter' }), { platform: 'facebook', finalPublishStep: true });
    assert.equal(c.category, CATEGORY.PERMANENT);
    assert.equal(c.code, 'FACEBOOK_PUBLISH_FAILED');
    assert.equal(c.retryable, false);
    assert.equal(c.outcome, OUTCOME.NOT_PUBLISHED);
  });

  test('the classification never carries Meta\'s raw message, fbtrace_id or anything token-like', () => {
    const c = classifyMetaFailure(http(400, { type: 'OAuthException', code: 190, message: 'EAAB-secret-token-123 is invalid', fbtrace_id: 'TRACE123' }));
    const serialized = JSON.stringify(c);
    assert.ok(!serialized.includes('EAAB-secret-token-123'));
    assert.ok(!serialized.includes('TRACE123'));
  });
});
