import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import metaApiService from '../metaApiService.js';
import facebookAdapter from './facebookAdapter.js';
import instagramAdapter from './instagramAdapter.js';

/**
 * Adapter-level reliability behavior (no database): how each adapter labels a
 * failure (definite vs unknown outcome, retryable, account action) and how
 * `reconcile` decides "found / not found / unknown". The Graph HTTP layer is
 * the only thing replaced.
 */

const MIN = 60_000;
const account = { pageId: 'pg_1', platformAccountId: 'pg_1', instagramBusinessAccountId: 'ig_1', accessToken: 'tok' };
const TIMEOUT = { success: false, kind: 'timeout', status: null, data: null, message: 'timed out' };
const http = (status, error) => ({ success: false, kind: 'http', status, data: error ? { error } : null, message: 'x' });
const list = (...items) => ({ success: true, status: 200, data: { data: items } });
const fbItem = (id, message, at) => ({ id, message, created_time: new Date(at).toISOString() });
const igItem = (id, caption, at) => ({ id, caption, timestamp: new Date(at).toISOString() });

const original = metaApiService.request;
afterEach(() => { metaApiService.request = original; delete process.env.SOCIAL_PUBLISH_TIMEOUT_MS; });
function stub(handler) { const calls = []; metaApiService.request = async (o) => { calls.push(o); return handler(o); }; return calls; }

describe('facebookAdapter.publish — failure labelling', () => {
  test('the publish call gets the longer configured timeout (default 30s, env-overridable at call time)', async () => {
    let calls = stub(() => ({ success: true, status: 200, data: { id: 'p1' } }));
    await facebookAdapter.publish({ account, content: 'x', media: [] });
    assert.equal(calls[0].timeoutMs, 30_000);
    process.env.SOCIAL_PUBLISH_TIMEOUT_MS = '45000';
    calls = stub(() => ({ success: true, status: 200, data: { id: 'p1' } }));
    await facebookAdapter.publish({ account, content: 'x', media: [] });
    assert.equal(calls[0].timeoutMs, 45_000);
  });

  test('timeout / reset / 5xx / no-id are UNKNOWN outcomes; a 4xx rejection is a definite failure', async () => {
    const cases = [
      [TIMEOUT, 'unknown'],
      [{ success: false, kind: 'network_unknown', status: null, data: null, message: 'r' }, 'unknown'],
      [http(502, null), 'unknown'],
      [{ success: true, status: 200, data: {} }, 'unknown'],
      [http(400, { type: 'GraphMethodException', code: 100, message: 'bad' }), 'not_published'],
      [http(400, { type: 'OAuthException', code: 4, message: 'limit' }), 'not_published'],
    ];
    for (const [response, outcome] of cases) {
      stub(() => response);
      const r = await facebookAdapter.publish({ account, content: 'x', media: [] });
      assert.equal(r.success, false);
      assert.equal(r.error.outcome, outcome, JSON.stringify(response));
    }
  });

  test('code 190 (HTTP 400) => token invalid + accountAction:expire + requiresReconnect', async () => {
    stub(() => http(400, { type: 'OAuthException', code: 190, message: 'Error validating access token' }));
    const r = await facebookAdapter.publish({ account, content: 'x', media: [] });
    assert.equal(r.error.code, 'FACEBOOK_TOKEN_INVALID');
    assert.equal(r.error.accountAction, 'expire');
    assert.equal(r.error.requiresReconnect, true);
    assert.equal(r.error.retryable, false);
  });

  test('rate limit codes are retryable and do not touch the account', async () => {
    for (const code of [4, 17, 32, 613]) {
      stub(() => http(400, { type: 'OAuthException', code, message: 'limit' }));
      const r = await facebookAdapter.publish({ account, content: 'x', media: [] });
      assert.equal(r.error.code, 'FACEBOOK_RATE_LIMITED');
      assert.equal(r.error.retryable, true);
      assert.equal(r.error.accountAction, 'none');
    }
  });

  test('delete (remove) also recognizes code 190 and rate limits, and says the post was NOT deleted', async () => {
    stub(() => http(400, { type: 'OAuthException', code: 190, message: 'expired' }));
    let r = await facebookAdapter.remove({ account, externalPostId: 'pg_1_9' });
    assert.equal(r.error.code, 'FACEBOOK_TOKEN_INVALID');
    assert.match(r.error.message, /NOT deleted/);
    stub(() => http(400, { type: 'OAuthException', code: 32, message: 'limit' }));
    r = await facebookAdapter.remove({ account, externalPostId: 'pg_1_9' });
    assert.equal(r.error.code, 'FACEBOOK_RATE_LIMITED');
  });
});

describe('facebookAdapter.reconcile', () => {
  const since = new Date('2026-10-01T10:00:00.000Z');
  const at = (offsetMs) => since.getTime() + offsetMs;

  test('found: same text, created after the attempt began', async () => {
    stub(() => list(fbItem('p_9', 'Hello', at(5_000))));
    assert.deepEqual(await facebookAdapter.reconcile({ account, content: 'Hello', media: [], since }), { status: 'found', externalPostId: 'p_9' });
  });

  test('found tolerates clock skew (a post stamped up to 2 minutes before the attempt)', async () => {
    stub(() => list(fbItem('p_9', 'Hello', at(-90_000))));
    assert.equal((await facebookAdapter.reconcile({ account, content: 'Hello', media: [], since })).status, 'found');
  });

  test('not_found: lookup succeeded, window covered (older posts exist), nothing matches', async () => {
    stub(() => list(fbItem('old', 'Hello', at(-3 * 60 * MIN)), fbItem('other', 'Different', at(1000))));
    assert.deepEqual(await facebookAdapter.reconcile({ account, content: 'Hello', media: [], since }), { status: 'not_found' });
  });

  test('a same-text post from long BEFORE the attempt is not a match', async () => {
    stub(() => list(fbItem('old', 'Hello', at(-3 * 60 * MIN))));
    assert.equal((await facebookAdapter.reconcile({ account, content: 'Hello', media: [], since })).status, 'not_found');
  });

  test('unknown (never "not_found") when the answer is not trustworthy', async () => {
    stub(() => list());
    assert.equal((await facebookAdapter.reconcile({ account, content: '', media: [], since })).reason, 'NO_FINGERPRINT');
    assert.equal((await facebookAdapter.reconcile({ account, content: 'x', media: [{ url: 'https://c/v.mp4', type: 'video' }], since })).reason, 'VIDEO_NOT_FINGERPRINTABLE');
    assert.equal((await facebookAdapter.reconcile({ account, content: 'x', media: [], since: null })).reason, 'NO_ATTEMPT_TIME');

    stub(() => http(503, null));
    assert.equal((await facebookAdapter.reconcile({ account, content: 'x', media: [], since })).reason, 'LOOKUP_FAILED');

    // 25 posts, all newer than the attempt, none matching: the window may extend further back
    stub(() => list(...Array.from({ length: 25 }, (_, i) => fbItem(`n${i}`, `post ${i}`, at(1000 + i)))));
    assert.equal((await facebookAdapter.reconcile({ account, content: 'x', media: [], since })).reason, 'WINDOW_NOT_COVERED');
  });

  test('a dead token during the lookup is flagged so the caller can expire the account', async () => {
    stub(() => http(400, { type: 'OAuthException', code: 190, message: 'expired' }));
    const r = await facebookAdapter.reconcile({ account, content: 'x', media: [], since });
    assert.equal(r.status, 'unknown');
    assert.equal(r.authFailure, true);
  });

  test('excludeIds: a post already owned by another publication is skipped', async () => {
    stub(() => list(fbItem('owned', 'Hello', at(1000)), fbItem('old', 'x', at(-3 * 60 * MIN))));
    const r = await facebookAdapter.reconcile({ account, content: 'Hello', media: [], since, excludeIds: new Set(['owned']) });
    assert.equal(r.status, 'not_found');
  });
});

describe('instagramAdapter — step-aware outcome + reconcile', () => {
  const media = [{ url: 'https://cdn.example.com/a.jpg', type: 'image' }];

  test('timeout creating the container is a DEFINITE, retryable failure (nothing can have been published)', async () => {
    stub((o) => (o.path === '/ig_1/media' ? TIMEOUT : list()));
    const r = await instagramAdapter.publish({ account, content: 'c', media });
    assert.equal(r.error.outcome, 'not_published');
    assert.equal(r.error.retryable, true);
  });

  test('timeout on media_publish is an UNKNOWN outcome', async () => {
    stub((o) => {
      if (o.method === 'POST' && o.path === '/ig_1/media') return { success: true, status: 200, data: { id: 'c1' } };
      if (o.path === '/c1') return { success: true, status: 200, data: { status_code: 'FINISHED' } };
      return TIMEOUT;
    });
    const r = await instagramAdapter.publish({ account, content: 'c', media });
    assert.equal(r.error.code, 'PUBLISH_OUTCOME_UNKNOWN');
    assert.equal(r.error.outcome, 'unknown');
  });

  test('container still processing after the poll window: definite + retryable, media_publish was never called', async () => {
    process.env.INSTAGRAM_CONTAINER_POLL_INTERVAL_MS = '1';
    try {
      const calls = stub((o) => {
        if (o.method === 'POST' && o.path === '/ig_1/media') return { success: true, status: 200, data: { id: 'c1' } };
        if (o.path === '/c1') return { success: true, status: 200, data: { status_code: 'IN_PROGRESS' } };
        return list();
      });
      const r = await instagramAdapter.publish({ account, content: 'c', media });
      assert.equal(r.error.code, 'INSTAGRAM_PROCESSING_TIMEOUT');
      assert.equal(r.error.outcome, 'not_published');
      assert.equal(r.error.retryable, true);
      assert.ok(!calls.some((c) => c.path === '/ig_1/media_publish'));
    } finally { delete process.env.INSTAGRAM_CONTAINER_POLL_INTERVAL_MS; }
  });

  test('code 190 on Instagram => INSTAGRAM_TOKEN_INVALID, accountAction expire', async () => {
    stub(() => http(400, { type: 'OAuthException', code: 190, message: 'expired' }));
    const r = await instagramAdapter.publish({ account, content: 'c', media });
    assert.equal(r.error.code, 'INSTAGRAM_TOKEN_INVALID');
    assert.equal(r.error.accountAction, 'expire');
  });

  test('reconcile matches by caption within the attempt window; not_found only when the window is covered; unknown with no caption', async () => {
    const since = new Date('2026-10-01T10:00:00.000Z');
    stub(() => list(igItem('m1', 'My caption', since.getTime() + 5000)));
    assert.deepEqual(await instagramAdapter.reconcile({ account, content: 'My caption', since }), { status: 'found', externalPostId: 'm1' });
    stub(() => list(igItem('old', 'My caption', since.getTime() - 5 * 60 * MIN)));
    assert.equal((await instagramAdapter.reconcile({ account, content: 'My caption', since })).status, 'not_found');
    assert.equal((await instagramAdapter.reconcile({ account, content: '', since })).reason, 'NO_FINGERPRINT');
    stub(() => http(500, null));
    assert.equal((await instagramAdapter.reconcile({ account, content: 'x', since })).reason, 'LOOKUP_FAILED');
  });
});
