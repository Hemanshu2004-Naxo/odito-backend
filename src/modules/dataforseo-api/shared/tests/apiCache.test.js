import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getOrFetch, getCachedOnly, cacheKey, MIN_REFRESH_INTERVAL_MS, __resetInFlightForTests } from '../apiCache.js';

/** An in-memory store with the same read/write contract as the MongoDB one. */
function memoryStore() {
  const rows = new Map();
  return { rows, read: async (key) => rows.get(key) ?? null, write: async (entry) => { rows.set(entry.key, { ...entry }); } };
}

const HOUR = 3_600_000;
let store; let clock; let calls;
const now = () => clock;
const fetcherFor = (payload, { cost = 0.5, delayMs = 0, fail } = {}) => async () => {
  calls += 1;
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  if (fail) throw fail;
  return { payload: { ...payload, n: calls }, cost };
};
const base = { endpoint: 'labs/x', target: 'a.com', location: 'India', language: 'English', ttlMs: 24 * HOUR };

beforeEach(() => { store = memoryStore(); clock = Date.parse('2026-10-27T10:00:00Z'); calls = 0; __resetInFlightForTests(); });

describe('getOrFetch', () => {
  test('a miss calls the provider once and stores the result with its cost and expiry', async () => {
    const r = await getOrFetch({ ...base, fetcher: fetcherFor({ v: 1 }) }, { store, now });
    assert.equal(calls, 1);
    assert.deepEqual([r.cached, r.refreshThrottled, r.payload.v], [false, false, 1]);
    assert.equal(r.fetchedAt.toISOString(), '2026-10-27T10:00:00.000Z');
    const row = store.rows.get(cacheKey(base));
    assert.equal(row.cost, 0.5);
    assert.equal(row.expiresAt.toISOString(), '2026-10-28T10:00:00.000Z');
    assert.equal(row.target, 'a.com');
  });

  test('a fresh entry is served without calling the provider, and keeps its original fetch time', async () => {
    await getOrFetch({ ...base, fetcher: fetcherFor({ v: 1 }) }, { store, now });
    clock += 23 * HOUR;
    const r = await getOrFetch({ ...base, fetcher: fetcherFor({ v: 2 }) }, { store, now });
    assert.equal(calls, 1);
    assert.equal(r.cached, true);
    assert.equal(r.payload.v, 1);
    assert.equal(r.fetchedAt.toISOString(), '2026-10-27T10:00:00.000Z');
  });

  test('an expired entry is fetched again', async () => {
    await getOrFetch({ ...base, fetcher: fetcherFor({ v: 1 }) }, { store, now });
    clock += 24 * HOUR + 1;
    const r = await getOrFetch({ ...base, fetcher: fetcherFor({ v: 2 }) }, { store, now });
    assert.equal(calls, 2);
    assert.equal(r.cached, false);
  });

  test('refresh skips the cache once the entry is older than the minimum interval', async () => {
    await getOrFetch({ ...base, fetcher: fetcherFor({ v: 1 }) }, { store, now });
    clock += MIN_REFRESH_INTERVAL_MS;
    const r = await getOrFetch({ ...base, refresh: true, fetcher: fetcherFor({ v: 2 }) }, { store, now });
    assert.equal(calls, 2);
    assert.deepEqual([r.cached, r.refreshThrottled], [false, false]);
    assert.equal(store.rows.get(cacheKey(base)).fetchedAt.getTime(), clock, 'the new response replaces the old entry');
  });

  test('refresh inside the minimum interval does NOT buy the same data again', async () => {
    await getOrFetch({ ...base, fetcher: fetcherFor({ v: 1 }) }, { store, now });
    clock += MIN_REFRESH_INTERVAL_MS - 1;
    const r = await getOrFetch({ ...base, refresh: true, fetcher: fetcherFor({ v: 2 }) }, { store, now });
    assert.equal(calls, 1);
    assert.deepEqual([r.cached, r.refreshThrottled, r.payload.v], [true, true, 1]);
  });

  test('refresh with nothing cached just fetches', async () => {
    const r = await getOrFetch({ ...base, refresh: true, fetcher: fetcherFor({ v: 1 }) }, { store, now });
    assert.equal(calls, 1);
    assert.equal(r.cached, false);
  });

  test('overlapping identical misses share ONE provider call', async () => {
    const results = await Promise.all([1, 2, 3].map(() => getOrFetch({ ...base, fetcher: fetcherFor({ v: 1 }, { delayMs: 20 }) }, { store, now })));
    assert.equal(calls, 1);
    assert.deepEqual(results.map((r) => r.payload.n), [1, 1, 1]);
  });

  test('different target / location / language / variant are different entries', async () => {
    for (const patch of [{}, { target: 'b.com' }, { location: 'United States' }, { language: 'Hindi' }, { variant: '2025-10-01' }]) {
      await getOrFetch({ ...base, ...patch, fetcher: fetcherFor({ v: 1 }) }, { store, now });
    }
    assert.equal(calls, 5);
    assert.equal(store.rows.size, 5);
  });

  test('keys are case-insensitive and trimmed', () => {
    assert.equal(cacheKey({ ...base, target: ' A.com ', location: 'INDIA' }), cacheKey(base));
  });

  test('a failed call is not cached, is rethrown, and does not poison later calls', async () => {
    const boom = new Error('provider down');
    await assert.rejects(getOrFetch({ ...base, fetcher: fetcherFor({}, { fail: boom }) }, { store, now }), (e) => e === boom);
    assert.equal(store.rows.size, 0);
    const r = await getOrFetch({ ...base, fetcher: fetcherFor({ v: 1 }) }, { store, now });
    assert.equal(r.cached, false);
    assert.equal(calls, 2);
  });

  test('a broken cache never blocks or loses a fetch', async () => {
    const broken = { read: async () => { throw new Error('mongo read'); }, write: async () => { throw new Error('mongo write'); } };
    const r = await getOrFetch({ ...base, fetcher: fetcherFor({ v: 1 }) }, { store: broken, now });
    assert.equal(r.payload.v, 1);
    assert.equal(calls, 1);
  });
});

describe('getCachedOnly (peek)', () => {
  const key = { endpoint: base.endpoint, target: base.target, location: base.location, language: base.language };

  test('a miss is null and NEVER fetches (nothing is stored either)', async () => {
    assert.equal(await getCachedOnly(key, { store, now }), null);
    assert.equal(calls, 0);
    assert.equal(store.rows.size, 0);
  });

  test('a fresh entry written by getOrFetch is returned as cached, with its timestamp, without a fetch', async () => {
    await getOrFetch({ ...base, fetcher: fetcherFor({ v: 1 }) }, { store, now });
    const hit = await getCachedOnly(key, { store, now });
    assert.equal(hit.payload.v, 1);
    assert.equal(hit.cached, true);
    assert.equal(hit.fetchedAt.getTime(), clock);
    assert.equal(calls, 1);
  });

  test('uses exactly the key getOrFetch uses: another variant, target or market is a miss', async () => {
    await getOrFetch({ ...base, variant: 'a', fetcher: fetcherFor({ v: 1 }) }, { store, now });
    assert.notEqual(await getCachedOnly({ ...key, variant: 'a' }, { store, now }), null);
    assert.equal(await getCachedOnly({ ...key, variant: 'b' }, { store, now }), null);
    assert.equal(await getCachedOnly({ ...key, variant: 'a', target: 'b.com' }, { store, now }), null);
    assert.equal(await getCachedOnly({ ...key, variant: 'a', location: 'Spain' }, { store, now }), null);
  });

  test('an expired entry is a miss (and is not refreshed)', async () => {
    await getOrFetch({ ...base, fetcher: fetcherFor({ v: 1 }) }, { store, now });
    clock += 25 * HOUR;
    assert.equal(await getCachedOnly(key, { store, now }), null);
    assert.equal(calls, 1);
  });

  test('a store that cannot be read is a miss, not an error', async () => {
    const broken = { read: async () => { throw new Error('mongo read'); }, write: async () => {} };
    assert.equal(await getCachedOnly(key, { store: broken, now }), null);
  });
});
