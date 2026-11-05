import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDataForSeoError, computeBackoffMs, parseEnvelope, readRetryConfig, resolveMaxAttempts } from './dataForSeoRetry.js';

/**
 * Pure retry-policy rules. Run from backend/:  node --test src/modules/ranking/services/dataForSeoRetry.test.js
 */

const taskError = (code, message) => Object.assign(new Error(`DataForSEO task error: ${message} (code ${code})`), {
  isApiError: true, isTaskError: true, taskStatusCode: code, taskStatusMessage: message,
});
const http = (status, headers) => Object.assign(new Error(`http ${status}`), { response: { status, headers } });

describe('classifyDataForSeoError', () => {
  test('the production failure — task 40101 "Internal SE Server Error" — is a transient provider error, not an auth error', () => {
    const v = classifyDataForSeoError(taskError(40101, 'Internal SE Server Error.'));
    assert.equal(v.retryable, true);
    assert.equal(v.kind, 'provider_transient');
    assert.equal(v.providerCode, 40101);
  });

  test('a provider error is judged by its message and code range, never by the numeric code alone', () => {
    // Same 40101 code, but an authentication message: permanent.
    assert.equal(classifyDataForSeoError(taskError(40101, 'Authentication failed. Check your credentials.')).retryable, false);
    assert.equal(classifyDataForSeoError(taskError(50000, 'Something broke')).retryable, true);   // 5xxxx range
    assert.equal(classifyDataForSeoError(taskError(40501, 'Invalid Field: depth')).retryable, false);
    assert.equal(classifyDataForSeoError(taskError(40201, 'Account paused for unusual activity')).retryable, false);
    assert.equal(classifyDataForSeoError(taskError(40402, 'Something unlisted')).retryable, false); // unknown => not repeated
  });

  test('operator-configured extra codes are retried', () => {
    assert.equal(classifyDataForSeoError(taskError(40999, 'Unlisted'), { extraRetryableCodes: new Set([40999]) }).retryable, true);
  });

  test('HTTP statuses', () => {
    assert.deepEqual(['auth', false], [classifyDataForSeoError(http(401)).kind, classifyDataForSeoError(http(401)).retryable]);
    assert.equal(classifyDataForSeoError(http(402)).kind, 'credits');
    assert.equal(classifyDataForSeoError(http(400)).retryable, false);
    assert.equal(classifyDataForSeoError(http(404)).retryable, false);
    assert.equal(classifyDataForSeoError(http(429)).retryable, true);
    assert.equal(classifyDataForSeoError(http(503)).retryable, true);
  });

  test('429 Retry-After is surfaced in ms', () => {
    assert.equal(classifyDataForSeoError(http(429, { 'retry-after': '3' })).retryAfterMs, 3000);
  });

  test('network and timeout errors without a response are retryable; malformed bodies too', () => {
    assert.equal(classifyDataForSeoError(Object.assign(new Error('timeout of 90000ms exceeded'), { code: 'ECONNABORTED' })).kind, 'timeout');
    assert.equal(classifyDataForSeoError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })).kind, 'network');
    assert.equal(classifyDataForSeoError(Object.assign(new Error('x'), { isMalformedResponse: true })).retryable, true);
  });
});

describe('computeBackoffMs', () => {
  test('grows exponentially, is jittered within [exp/2, exp], and respects the cap', () => {
    const lo = (a, o = {}) => computeBackoffMs(a, { baseDelayMs: 1000, maxDelayMs: 10_000, random: () => 0, ...o });
    const hi = (a, o = {}) => computeBackoffMs(a, { baseDelayMs: 1000, maxDelayMs: 10_000, random: () => 1, ...o });
    assert.deepEqual([lo(1), lo(2), lo(3)], [500, 1000, 2000]);
    assert.deepEqual([hi(1), hi(2), hi(3)], [1000, 2000, 4000]);
    assert.equal(hi(10), 10_000);
    assert.equal(lo(10), 5000);
  });

  test('real randomness stays inside the band', () => {
    for (let i = 0; i < 200; i++) {
      const d = computeBackoffMs(2, { baseDelayMs: 1000, maxDelayMs: 10_000 });
      assert.ok(d >= 1000 && d <= 2000, `delay ${d}`);
    }
  });

  test('Retry-After is a floor, still capped', () => {
    assert.equal(computeBackoffMs(1, { baseDelayMs: 1000, maxDelayMs: 10_000, retryAfterMs: 6000, random: () => 0 }), 6000);
    assert.equal(computeBackoffMs(1, { baseDelayMs: 1000, maxDelayMs: 4000, retryAfterMs: 60_000, random: () => 0 }), 4000);
  });
});

describe('config + envelope parsing', () => {
  test('env limits: attempts cap only ever lowers the caller\'s request', () => {
    assert.equal(resolveMaxAttempts(3, null), 3);
    assert.equal(resolveMaxAttempts(3, 2), 2);
    assert.equal(resolveMaxAttempts(2, 5), 2);
    assert.equal(resolveMaxAttempts(undefined, null), 1);
    const cfg = readRetryConfig({ DATAFORSEO_MAX_ATTEMPTS: '2', DATAFORSEO_RETRYABLE_CODES: '40999, 40998', DATAFORSEO_RETRY_BASE_DELAY_MS: '50', DATAFORSEO_RETRY_MAX_DELAY_MS: 'x' });
    assert.equal(cfg.maxAttemptsCap, 2);
    assert.equal(cfg.baseDelayMs, 50);
    assert.ok(cfg.extraRetryableCodes.has(40999) && cfg.extraRetryableCodes.has(40998));
    assert.equal(cfg.maxDelayMs, 30_000); // garbage falls back to the default
  });

  test('parseEnvelope accepts objects and JSON strings, rejects HTML / empty / arrays as malformed', () => {
    assert.deepEqual(parseEnvelope({ status_code: 20000 }), { status_code: 20000 });
    assert.deepEqual(parseEnvelope('{"status_code":20000}'), { status_code: 20000 });
    for (const bad of ['<html>502 Bad Gateway</html>', '', null, undefined, [1], 5]) {
      assert.throws(() => parseEnvelope(bad), { isMalformedResponse: true });
    }
  });
});
