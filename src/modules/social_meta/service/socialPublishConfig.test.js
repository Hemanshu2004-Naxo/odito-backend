import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getPublishConfig, computeRetryDelayMs, computeNextRetryAt, shouldAutoRetry } from './socialPublishConfig.js';

const KEYS = [
  'SOCIAL_PUBLISH_MAX_ATTEMPTS', 'SOCIAL_PUBLISH_RETRY_BASE_MS', 'SOCIAL_PUBLISH_RATE_LIMIT_BASE_MS', 'SOCIAL_PUBLISH_RETRY_MAX_DELAY_MS',
  'SOCIAL_PUBLISH_STALE_MS', 'SOCIAL_SCHEDULER_MAX_LATENESS_MINUTES', 'SOCIAL_PUBLISH_RECONCILE_SETTLE_MS',
  'SOCIAL_PUBLISH_RECONCILE_GIVE_UP_MINUTES', 'SOCIAL_PUBLISH_TIMEOUT_MS',
];
afterEach(() => { for (const k of KEYS) delete process.env[k]; });

describe('socialPublishConfig — defaults and call-time env', () => {
  test('safe defaults: 4 attempts, 1m base, 5m rate-limit base, 15m cap, 10m stale, 60m lateness', () => {
    const c = getPublishConfig();
    assert.equal(c.maxAttempts, 4);
    assert.equal(c.retryBaseMs, 60_000);
    assert.equal(c.rateLimitRetryBaseMs, 300_000);
    assert.equal(c.retryMaxDelayMs, 900_000);
    assert.equal(c.staleMs, 600_000);
    assert.equal(c.maxLatenessMs, 60 * 60_000);
  });

  test('env is read AT CALL TIME, never frozen at import (the ESM/dotenv ordering bug)', () => {
    const before = getPublishConfig().maxLatenessMs;
    process.env.SOCIAL_SCHEDULER_MAX_LATENESS_MINUTES = '15';
    const after = getPublishConfig().maxLatenessMs;
    assert.equal(before, 60 * 60_000);
    assert.equal(after, 15 * 60_000);
  });

  test('invalid / non-positive env values fall back to the default instead of disabling a safety mechanism', () => {
    for (const bad of ['abc', '0', '-5', '1.5', '']) {
      process.env.SOCIAL_PUBLISH_MAX_ATTEMPTS = bad;
      process.env.SOCIAL_SCHEDULER_MAX_LATENESS_MINUTES = bad;
      const c = getPublishConfig();
      assert.equal(c.maxAttempts, 4, `"${bad}"`);
      assert.equal(c.maxLatenessMs, 60 * 60_000, `"${bad}"`);
    }
  });
});

describe('socialPublishConfig — bounded exponential backoff', () => {
  test('delay = base * 2^(n-1): 1m, 2m, 4m, 8m, then capped at 15m', () => {
    const c = getPublishConfig();
    assert.equal(computeRetryDelayMs(1, 'TRANSIENT', c), 60_000);
    assert.equal(computeRetryDelayMs(2, 'TRANSIENT', c), 120_000);
    assert.equal(computeRetryDelayMs(3, 'TRANSIENT', c), 240_000);
    assert.equal(computeRetryDelayMs(4, 'TRANSIENT', c), 480_000);
    assert.equal(computeRetryDelayMs(5, 'TRANSIENT', c), 900_000, 'capped');
    assert.equal(computeRetryDelayMs(50, 'TRANSIENT', c), 900_000, 'stays capped, never overflows');
  });

  test('rate limiting uses its own, longer base (5m, 10m, capped 15m)', () => {
    const c = getPublishConfig();
    assert.equal(computeRetryDelayMs(1, 'RATE_LIMIT', c), 300_000);
    assert.equal(computeRetryDelayMs(2, 'RATE_LIMIT', c), 600_000);
    assert.equal(computeRetryDelayMs(3, 'RATE_LIMIT', c), 900_000);
  });

  test('computeNextRetryAt is now + the computed delay', () => {
    const now = new Date('2026-10-01T10:00:00.000Z');
    assert.equal(computeNextRetryAt(2, 'TRANSIENT', now, getPublishConfig()).toISOString(), '2026-10-01T10:02:00.000Z');
  });

  test('base and cap are configurable', () => {
    process.env.SOCIAL_PUBLISH_RETRY_BASE_MS = '1000';
    process.env.SOCIAL_PUBLISH_RETRY_MAX_DELAY_MS = '3000';
    const c = getPublishConfig();
    assert.equal(computeRetryDelayMs(1, 'TRANSIENT', c), 1000);
    assert.equal(computeRetryDelayMs(2, 'TRANSIENT', c), 2000);
    assert.equal(computeRetryDelayMs(3, 'TRANSIENT', c), 3000);
  });
});

describe('socialPublishConfig — what may be retried automatically', () => {
  const c = getPublishConfig();

  test('retryable + definite not_published + attempts left => retry', () => {
    assert.equal(shouldAutoRetry({ retryable: true, outcome: 'not_published' }, 1, c), true);
    assert.equal(shouldAutoRetry({ retryable: true, outcome: 'not_published' }, 3, c), true);
  });

  test('max attempts reached => no retry (permanent failure handling takes over)', () => {
    assert.equal(shouldAutoRetry({ retryable: true, outcome: 'not_published' }, 4, c), false);
    assert.equal(shouldAutoRetry({ retryable: true, outcome: 'not_published' }, 9, c), false);
  });

  test('non-retryable (invalid content, missing media/permission, expired auth, permanent rejection) => never retried', () => {
    assert.equal(shouldAutoRetry({ retryable: false, outcome: 'not_published' }, 1, c), false);
  });

  test('an UNKNOWN outcome is never auto-retried — it must be reconciled first', () => {
    assert.equal(shouldAutoRetry({ retryable: true, outcome: 'unknown' }, 1, c), false);
  });
});
