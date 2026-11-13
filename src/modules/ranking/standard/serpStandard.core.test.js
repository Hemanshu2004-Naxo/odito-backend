import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupeKeyOf, buildTaskPostItem, classifyPostItem, classifyTaskGet, envelopeFromTask, retryDelayMs, directPollDelayMs, nextPollIntervalMs, breakerShouldOpen,
} from './serpStandardCore.js';
import { providerFor, resolveSerpMode, rolloutBucket, fallbackToLive, readStandardConfig } from './config.js';
import { createStandardClient } from './serpStandardClient.js';
import { summarizeOrganicResponse, assessOrganicOutcome } from '../services/serpResponseOutcome.js';

/** Pure rules + request building. No MongoDB, no network. */

const task = (over = {}) => ({ _id: '65f000000000000000000001', keyword: 'asg eye center near me', locationCode: 1007785, languageCode: 'en', depth: 100, device: 'desktop', ...over });

describe('task_post items', () => {
  test('desktop: device=desktop os=windows with location, language, depth and OUR id as tag (exact documented fields only)', () => {
    assert.deepEqual(buildTaskPostItem(task()), {
      keyword: 'asg eye center near me', location_code: 1007785, language_code: 'en', depth: 100, device: 'desktop', os: 'windows', tag: '65f000000000000000000001',
    });
  });
  test('mobile: device=mobile os=android', () => {
    const item = buildTaskPostItem(task({ device: 'mobile' }));
    assert.equal(item.device, 'mobile');
    assert.equal(item.os, 'android');
  });
  test('priority is only sent when explicitly high (the normal queue is the cheapest and the default)', () => {
    assert.equal('priority' in buildTaskPostItem(task(), { priority: 1 }), false);
    assert.equal(buildTaskPostItem(task(), { priority: 2 }).priority, 2);
  });
  test('pingback_url only with both a base URL and a secret, with the $id / $tag placeholders', () => {
    assert.equal('pingback_url' in buildTaskPostItem(task(), { pingbackBaseUrl: 'https://api.example.com' }), false);
    const u = buildTaskPostItem(task(), { pingbackBaseUrl: 'https://api.example.com', pingbackSecret: 's e/c' }).pingback_url;
    assert.match(u, /^https:\/\/api\.example\.com\/api\/serp-standard\/pingback\?id=\$id&tag=\$tag&token=s%20e%2Fc$/);
  });
  test('an unsupported device is refused before anything is built', () => {
    assert.throws(() => buildTaskPostItem(task({ device: 'tablet' })), { code: 'UNSUPPORTED_SERP_DEVICE' });
  });
});

describe('identity of a request', () => {
  test('same keyword/market/device/depth -> same key (case and spacing of the keyword do not matter); any difference -> a different key', () => {
    const a = dedupeKeyOf(task());
    assert.equal(a, dedupeKeyOf(task({ keyword: '  ASG Eye Center near me ' })));
    for (const over of [{ device: 'mobile' }, { depth: 50 }, { locationCode: 2840 }, { languageCode: 'hi' }, { keyword: 'other' }]) assert.notEqual(a, dedupeKeyOf(task(over)));
  });
});

describe('provider responses', () => {
  test('task_post item: 20100 + id is accepted with its cost; throttling, account and rejection are told apart', () => {
    assert.deepEqual(classifyPostItem({ status_code: 20100, id: 'abc', cost: 0.006 }), { kind: 'accepted', id: 'abc', cost: 0.006 });
    assert.equal(classifyPostItem({ status_code: 20100 }).kind, 'rejected', 'no id -> nothing to track');
    assert.equal(classifyPostItem({ status_code: 40209 }).kind, 'throttled');
    assert.equal(classifyPostItem({ status_code: 40202 }).kind, 'throttled');
    assert.equal(classifyPostItem({ status_code: 40200 }).kind, 'account');
    assert.equal(classifyPostItem({ status_code: 50000 }).kind, 'retryable');
    assert.equal(classifyPostItem({ status_code: 40501, status_message: 'Invalid Field: depth' }).kind, 'rejected');
  });
  test('task_get: ready (20000 / 40102 / 40106), pending (40601 / 40602), retryable (40101 / 40103), gone, permanent', () => {
    for (const code of [20000, 40102, 40106]) assert.equal(classifyTaskGet({ status_code: code }).kind, 'ready', String(code));
    for (const code of [40601, 40602]) assert.equal(classifyTaskGet({ status_code: code }).kind, 'pending', String(code));
    for (const code of [40101, 40103, 50001]) assert.equal(classifyTaskGet({ status_code: code }).kind, 'retryable', String(code));
    for (const code of [40401, 40403, 40105]) assert.equal(classifyTaskGet({ status_code: code }).kind, 'gone', String(code));
    assert.equal(classifyTaskGet({ status_code: 40501 }).kind, 'permanent');
    assert.equal(classifyTaskGet(null).kind, 'permanent');
  });
  test('the stored task becomes a Live-shaped envelope the existing outcome code reads unchanged', () => {
    const t = { status_code: 20000, result: [{ items: [{ type: 'organic', rank_group: 3, rank_absolute: 4 }] }] };
    const env = envelopeFromTask(t, { attempts: 2 });
    assert.equal(env.dfsAttempts, 2);
    const summary = summarizeOrganicResponse(env, { requestedDepth: 100 });
    assert.equal(summary.organicCount, 1);
    assert.equal(assessOrganicOutcome(summary), 'complete');
    assert.equal(assessOrganicOutcome(summarizeOrganicResponse(envelopeFromTask({ status_code: 40106, result: [{ items: [{ type: 'organic', rank_group: 1 }] }] }))), 'partial');
    assert.equal(assessOrganicOutcome(summarizeOrganicResponse(envelopeFromTask({ status_code: 40106, result: [{ items: [] }] }))), 'partial_without_results');
    assert.equal(assessOrganicOutcome(summarizeOrganicResponse(envelopeFromTask({ status_code: 40102, result: [{ items: [] }] }))), 'no_results');
  });
});

describe('timing and breaker', () => {
  const cfg = { retryBaseMs: 300_000, retryMaxMs: 7_200_000, directPollMaxMs: 300_000, pollBaseMs: 5000, pollMaxMs: 60_000, breakerWindow: 20, breakerMinFailures: 10 };
  test('recovery delay doubles per attempt, is capped, and is jittered (+/-25%) so a whole outage does not retry together', () => {
    assert.equal(retryDelayMs(1, cfg, () => 0.5), 300_000);
    assert.equal(retryDelayMs(2, cfg, () => 0.5), 600_000);
    assert.equal(retryDelayMs(10, cfg, () => 0.5), 7_200_000);
    assert.equal(retryDelayMs(1, cfg, () => 0), 225_000);
    assert.equal(retryDelayMs(1, cfg, () => 1), 375_000);
    const spread = new Set(Array.from({ length: 30 }, () => retryDelayMs(3, cfg)));
    assert.ok(spread.size > 5);
  });
  test('direct polling backs off exponentially up to its cap', () => {
    const d = (n) => directPollDelayMs(n, cfg, 15_000, () => 0.5);
    assert.ok(d(0) < d(1) && d(1) < d(2));
    assert.ok(d(20) <= 300_000 * 1.15);
  });
  test('ready-list polling never goes below its base, doubles while nothing is ready, and resets when something is', () => {
    assert.equal(nextPollIntervalMs(0, false, cfg), 5000);
    assert.equal(nextPollIntervalMs(5000, false, cfg), 10_000);
    assert.equal(nextPollIntervalMs(50_000, false, cfg), 60_000);
    assert.equal(nextPollIntervalMs(60_000, true, cfg), 5000);
  });
  test('breaker opens only on enough failures that are also at least half of the recent outcomes', () => {
    const f = (n) => Array(n).fill(false);
    const t = (n) => Array(n).fill(true);
    assert.equal(breakerShouldOpen(f(9), cfg), false);
    assert.equal(breakerShouldOpen(f(10), cfg), true);
    assert.equal(breakerShouldOpen([...t(10), ...f(10)], cfg), true);
    assert.equal(breakerShouldOpen([...t(30), ...f(10)], { ...cfg, breakerWindow: 40 }), false, 'a healthy majority keeps it closed');
  });
});

describe('mode and rollout', () => {
  const env = (o) => o;
  test('live is the default and anything but "standard" is live', () => {
    assert.equal(resolveSerpMode(env({})), 'live');
    assert.equal(resolveSerpMode(env({ DATAFORSEO_SERP_MODE: 'LIVE' })), 'live');
    assert.equal(resolveSerpMode(env({ DATAFORSEO_SERP_MODE: ' Standard ' })), 'standard');
    assert.equal(providerFor({ keyword: 'k', locationCode: 1, languageCode: 'en' }, env({})), 'live');
  });
  test('rollout is a stable percentage: 0 = nobody, 100 = everybody, the same keyword always lands on the same side', () => {
    const k = { keyword: 'asg eye center', locationCode: 1007785, languageCode: 'en' };
    assert.equal(providerFor(k, env({ DATAFORSEO_SERP_MODE: 'standard', DATAFORSEO_SERP_STANDARD_ROLLOUT_PERCENT: '0' })), 'live');
    assert.equal(providerFor(k, env({ DATAFORSEO_SERP_MODE: 'standard', DATAFORSEO_SERP_STANDARD_ROLLOUT_PERCENT: '100' })), 'standard');
    assert.equal(providerFor(k, env({ DATAFORSEO_SERP_MODE: 'standard' })), 'standard');
    const half = env({ DATAFORSEO_SERP_MODE: 'standard', DATAFORSEO_SERP_STANDARD_ROLLOUT_PERCENT: '50' });
    assert.equal(providerFor(k, half), providerFor(k, half));
    const share = Array.from({ length: 1000 }, (_, i) => providerFor({ ...k, keyword: `kw ${i}` }, half)).filter((p) => p === 'standard').length;
    assert.ok(share > 400 && share < 600, `about half: ${share}`);
    assert.equal(rolloutBucket('A K', 1, 'en'), rolloutBucket('a k', 1, 'en'));
  });
  test('Live fallback is off unless explicitly enabled', () => {
    assert.equal(fallbackToLive({}), false);
    assert.equal(fallbackToLive({ DATAFORSEO_SERP_FALLBACK_TO_LIVE: 'true' }), true);
    assert.equal(fallbackToLive({ DATAFORSEO_SERP_FALLBACK_TO_LIVE: 'nope' }), false);
  });
  test('limits respect the provider: batches <= 100, ready-list polling >= 3 s, normal priority by default', () => {
    const c = readStandardConfig({ DATAFORSEO_SERP_STANDARD_BATCH_SIZE: '500', DATAFORSEO_SERP_STANDARD_POLL_BASE_MS: '10' });
    assert.equal(c.batchSize, 100);
    assert.equal(c.pollBaseMs, 3000);
    assert.equal(c.priority, 1);
  });
});

describe('client', () => {
  test('task_post refuses 0 or more than 100 tasks before any request; tasks_ready flattens the ready list; task_get returns tasks[0]', async () => {
    const seen = [];
    const http = {
      post: async (url, body) => { seen.push(['post', url, body.length]); return { data: { status_code: 20000, cost: 0.012, tasks: body.map((_, i) => ({ id: `id${i}`, status_code: 20100, cost: 0.006 })) } }; },
      get: async (url) => { seen.push(['get', url]); return { data: url.endsWith('tasks_ready') ? { status_code: 20000, tasks: [{ result: [{ id: 'a', tag: 't1' }, { id: 'b', tag: null }] }] } : { status_code: 20000, tasks: [{ id: 'a', status_code: 20000 }] } }; },
    };
    const c = createStandardClient({ http });
    await assert.rejects(() => c.postTasks([]), RangeError);
    await assert.rejects(() => c.postTasks(Array(101).fill({})), RangeError);
    const posted = await c.postTasks(Array(100).fill({ keyword: 'k' }));
    assert.equal(posted.tasks.length, 100);
    assert.equal(posted.cost, 0.012);
    assert.deepEqual(await c.tasksReady(), [{ id: 'a', tag: 't1' }, { id: 'b', tag: null }]);
    assert.equal((await c.taskGet('a')).status_code, 20000);
    assert.deepEqual(seen.map((s) => s[1]), [
      'https://api.dataforseo.com/v3/serp/google/organic/task_post',
      'https://api.dataforseo.com/v3/serp/google/organic/tasks_ready',
      'https://api.dataforseo.com/v3/serp/google/organic/task_get/advanced/a',
    ]);
  });
  test('an envelope-level error is thrown with the provider code; a non-JSON body is a malformed response', async () => {
    const c = createStandardClient({ http: { get: async () => ({ data: { status_code: 40200, status_message: 'Payment Required.' } }) } });
    await assert.rejects(() => c.tasksReady(), (e) => e.apiStatusCode === 40200 && e.isApiError === true);
    const bad = createStandardClient({ http: { get: async () => ({ data: '<html>502</html>' }) } });
    await assert.rejects(() => bad.taskGet('x'), (e) => e.isMalformedResponse === true);
  });
});
