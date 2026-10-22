import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeRow } from './bulkImportNormalizer.js';
import { validateRow } from './bulkImportValidator.js';
import { BULK_ERROR } from './bulkImportConstants.js';

/**
 * Bulk Upload — Phase 2 per-row business validation. Pure: the account
 * context is a plain stub (the real service pre-resolves it once from the
 * DB). No network, no media fetching.
 */

const IDX = { platform: 0, content: 1, media_urls: 2, scheduled_at: 3, timezone: 4, action: 5 };
const FUTURE = '2099-01-02 10:00';
const NOW = new Date('2026-09-07T00:00:00Z');

function fakeAccount({ ready = true } = {}) {
  return { _id: 'acc-1', platform: 'facebook', scopes: ready ? ['pages_manage_posts'] : ['pages_read_engagement'] };
}
function ctx({ facebook = null, instagram = null } = {}) {
  return { now: NOW, accounts: { facebook: { account: facebook }, instagram: { account: instagram } } };
}
function run(cells, context) {
  const norm = normalizeRow(cells, IDX);
  const verdict = validateRow(norm, context);
  return { norm, verdict };
}

describe('validateRow — happy paths', () => {
  test('valid Facebook text draft', () => {
    const { verdict, norm } = run(['facebook', 'Hello world', '', '', '', 'draft'], ctx({ facebook: fakeAccount() }));
    assert.equal(verdict.status, 'valid');
    assert.equal(norm.normalized.socialAccountId, 'acc-1');
  });

  test('valid Instagram row with media', () => {
    const { verdict } = run(['instagram', 'Look!', 'https://cdn.example.com/a.jpg', '', '', 'draft'],
      ctx({ instagram: { ...fakeAccount(), platform: 'instagram', scopes: ['instagram_content_publish'] } }));
    assert.equal(verdict.status, 'valid');
  });

  test('valid scheduled Facebook row resolves scheduledAt', () => {
    const { verdict, norm } = run(['facebook', 'Later', '', FUTURE, 'Asia/Kolkata', 'schedule'], ctx({ facebook: fakeAccount() }));
    assert.equal(verdict.status, 'valid');
    assert.equal(norm.normalized.scheduledAt.toISOString(), '2099-01-02T04:30:00.000Z');
  });
});

describe('validateRow — platform / account', () => {
  test('unsupported platform', () => {
    const { verdict } = run(['tiktok', 'Hi', '', '', '', 'draft'], ctx());
    assert.ok(verdict.errors.some((e) => e.code === BULK_ERROR.UNSUPPORTED_PLATFORM));
    assert.equal(verdict.status, 'invalid');
  });

  test('platform supported but not connected to the project', () => {
    const { verdict } = run(['facebook', 'Hi', '', '', '', 'draft'], ctx({ facebook: null }));
    assert.ok(verdict.errors.some((e) => e.code === BULK_ERROR.ACCOUNT_NOT_CONNECTED));
  });

  test('draft on a read-only account is allowed; schedule/publish is not', () => {
    const draft = run(['facebook', 'Hi', '', '', '', 'draft'], ctx({ facebook: fakeAccount({ ready: false }) }));
    assert.equal(draft.verdict.status, 'valid');

    const sched = run(['facebook', 'Hi', '', FUTURE, 'Asia/Kolkata', 'schedule'], ctx({ facebook: fakeAccount({ ready: false }) }));
    assert.ok(sched.verdict.errors.some((e) => e.code === BULK_ERROR.ACCOUNT_NOT_PUBLISH_READY));
  });
});

describe('validateRow — content / media', () => {
  test('content required when there is no media', () => {
    const { verdict } = run(['facebook', '   ', '', '', '', 'draft'], ctx({ facebook: fakeAccount() }));
    assert.ok(verdict.errors.some((e) => e.code === BULK_ERROR.CONTENT_REQUIRED));
  });

  test('a media-only Facebook row (no content) is fine', () => {
    const { verdict } = run(['facebook', '', 'https://cdn.example.com/a.jpg', '', '', 'draft'], ctx({ facebook: fakeAccount() }));
    assert.equal(verdict.status, 'valid');
  });

  test('Instagram requires media', () => {
    const { verdict } = run(['instagram', 'text only', '', '', '', 'draft'],
      ctx({ instagram: { _id: 'ig', platform: 'instagram', scopes: ['instagram_content_publish'] } }));
    assert.ok(verdict.errors.some((e) => e.code === BULK_ERROR.MEDIA_REQUIRED));
  });

  test('non-https media URL is rejected (INVALID_MEDIA_URL)', () => {
    const { verdict } = run(['facebook', 'x', 'http://cdn.example.com/a.jpg', '', '', 'draft'], ctx({ facebook: fakeAccount() }));
    assert.ok(verdict.errors.some((e) => e.code === BULK_ERROR.INVALID_MEDIA_URL));
  });

  test('SSRF-sensitive media URL (localhost / private) is rejected without any fetch', () => {
    for (const url of ['https://localhost/a.jpg', 'https://127.0.0.1/a.jpg', 'https://169.254.169.254/latest/meta-data', 'https://10.0.0.5/a.png']) {
      const { verdict } = run(['facebook', 'x', url, '', '', 'draft'], ctx({ facebook: fakeAccount() }));
      assert.ok(verdict.errors.some((e) => e.code === BULK_ERROR.INVALID_MEDIA_URL), `expected rejection for ${url}`);
    }
  });

  test('unsupported media type', () => {
    const { verdict } = run(['facebook', 'x', 'https://cdn.example.com/a.gif', '', '', 'draft'], ctx({ facebook: fakeAccount() }));
    assert.ok(verdict.errors.some((e) => e.code === BULK_ERROR.INVALID_MEDIA_TYPE));
  });

  test('more than one media URL is rejected (adapters accept a single item today)', () => {
    const { verdict } = run(['facebook', 'x', 'https://cdn.example.com/a.jpg;https://cdn.example.com/b.jpg', '', '', 'draft'], ctx({ facebook: fakeAccount() }));
    assert.ok(verdict.errors.some((e) => e.code === BULK_ERROR.TOO_MANY_MEDIA));
  });
});

describe('validateRow — schedule / timezone / action', () => {
  test('schedule action requires scheduled_at', () => {
    const { verdict } = run(['facebook', 'x', '', '', 'Asia/Kolkata', 'schedule'], ctx({ facebook: fakeAccount() }));
    assert.ok(verdict.errors.some((e) => e.code === BULK_ERROR.INVALID_SCHEDULE));
  });

  test('schedule action requires a timezone', () => {
    const { verdict } = run(['facebook', 'x', '', FUTURE, '', 'schedule'], ctx({ facebook: fakeAccount() }));
    assert.ok(verdict.errors.some((e) => e.code === BULK_ERROR.INVALID_TIMEZONE));
  });

  test('a past scheduled time is PAST_SCHEDULE', () => {
    const { verdict } = run(['facebook', 'x', '', '2020-01-01 10:00', 'Asia/Kolkata', 'schedule'], ctx({ facebook: fakeAccount() }));
    assert.ok(verdict.errors.some((e) => e.code === BULK_ERROR.PAST_SCHEDULE));
  });

  test('an invalid timezone on a scheduled row is INVALID_TIMEZONE', () => {
    const { verdict } = run(['facebook', 'x', '', FUTURE, 'Mars/Olympus', 'schedule'], ctx({ facebook: fakeAccount() }));
    assert.ok(verdict.errors.some((e) => e.code === BULK_ERROR.INVALID_TIMEZONE));
  });

  test('unknown action is INVALID_ACTION', () => {
    const { verdict } = run(['facebook', 'x', '', '', '', 'yeet'], ctx({ facebook: fakeAccount() }));
    assert.ok(verdict.errors.some((e) => e.code === BULK_ERROR.INVALID_ACTION));
  });

  test('a draft may carry a (even past) planned time without failing', () => {
    const { verdict, norm } = run(['facebook', 'x', '', '2020-01-01 10:00', 'Asia/Kolkata', 'draft'], ctx({ facebook: fakeAccount() }));
    assert.equal(verdict.status, 'valid');
    assert.ok(norm.normalized.scheduledAt instanceof Date);
  });

  test('a stray invalid timezone on a non-scheduled row is still flagged', () => {
    const { verdict } = run(['facebook', 'x', '', '', 'Nope/Nope', 'draft'], ctx({ facebook: fakeAccount() }));
    assert.ok(verdict.errors.some((e) => e.code === BULK_ERROR.INVALID_TIMEZONE));
  });
});

describe('validateRow — multiple problems in one row', () => {
  test('every independent problem is reported, not just the first', () => {
    const { verdict } = run(['pinterest', '   ', 'http://localhost/a.gif', 'not-a-date', 'Bad/Zone', 'schedule'], ctx());
    const codes = verdict.errors.map((e) => e.code);
    assert.ok(codes.includes(BULK_ERROR.UNSUPPORTED_PLATFORM));
    assert.ok(codes.includes(BULK_ERROR.INVALID_MEDIA_URL));
    assert.ok(codes.includes(BULK_ERROR.CONTENT_REQUIRED));
    assert.ok(codes.includes(BULK_ERROR.INVALID_SCHEDULE) || codes.includes(BULK_ERROR.INVALID_TIMEZONE));
  });
});
