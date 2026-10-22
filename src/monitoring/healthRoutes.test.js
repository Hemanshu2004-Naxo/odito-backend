import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import healthRoutes, { markStartupComplete, resetStartupState, setReadinessProbe, metricsAccess } from './healthRoutes.js';
import { recordRunOutcome, recordProviderError, recordQuotaEvent } from './socialAiMetrics.js';

/**
 * HTTP tests for liveness / readiness / metrics. The router is mounted on a bare Express app (no database is connected in this process), so
 * "the database is down" is the real state here, and "the database is up" is a probe the test supplies.
 */

const TOKEN = 'a-long-random-metrics-token-1234567890';
let server; let base; let envBackup;

before(async () => {
  const app = express();
  app.use('/api', healthRoutes);
  app.use('/', healthRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => { envBackup = { NODE_ENV: process.env.NODE_ENV, METRICS_TOKEN: process.env.METRICS_TOKEN }; resetStartupState(); setReadinessProbe(null); });
afterEach(() => {
  for (const [k, v] of Object.entries(envBackup)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  setReadinessProbe(null);
});

const get = async (path, headers = {}) => {
  const res = await fetch(base + path, { headers });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: res.headers, text, json };
};

describe('liveness', () => {
  test('1: /healthz answers 200 with no database at all, at the root and under /api, and is never cached', async () => {
    for (const path of ['/healthz', '/api/healthz']) {
      const r = await get(path);
      assert.equal(r.status, 200, path);
      assert.equal(r.json.status, 'ok');
      assert.equal(typeof r.json.uptimeSeconds, 'number');
      assert.equal(r.headers.get('cache-control'), 'no-store');
    }
  });

  test('2: liveness does not depend on the readiness probe: a dead database does not make a healthy process "dead"', async () => {
    setReadinessProbe(async () => { throw new Error('mongo is down'); });
    assert.equal((await get('/healthz')).status, 200);
  });
});

describe('readiness', () => {
  test('3: not ready while the database is unreachable (this process has no connection): 503 naming only the failing checks', async () => {
    markStartupComplete();
    const r = await get('/readyz');
    assert.equal(r.status, 503);
    assert.deepEqual(r.json, { status: 'not_ready', checks: { database: 'fail', startup: 'ok' } });
  });

  test('4: not ready until startup has finished, even if the database answers', async () => {
    setReadinessProbe(async () => true);
    const r = await get('/readyz');
    assert.equal(r.status, 503);
    assert.deepEqual(r.json.checks, { database: 'ok', startup: 'pending' });
  });

  test('5: ready (200) when startup is complete and the database answers', async () => {
    setReadinessProbe(async () => true);
    markStartupComplete();
    const r = await get('/api/readyz');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { status: 'ready', checks: { database: 'ok', startup: 'ok' } });
  });

  test('6: a probe that throws is a plain 503 - the error text, host and stack never reach the response', async () => {
    setReadinessProbe(async () => { throw new Error('connect ECONNREFUSED 10.20.30.40:27017 user=admin password=hunter2'); });
    markStartupComplete();
    const r = await get('/readyz');
    assert.equal(r.status, 503);
    assert.doesNotMatch(r.text, /ECONNREFUSED|10\.20|hunter2|admin|stack|27017/);
    assert.deepEqual(Object.keys(r.json).sort(), ['checks', 'status']);
  });
});

describe('metrics access', () => {
  test('7: in production there is no /metrics without a token, and none with one that is too short to protect anything (404, not 401)', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.METRICS_TOKEN;
    assert.equal((await get('/metrics')).status, 404);
    process.env.METRICS_TOKEN = 'short';
    assert.equal((await get('/metrics', { authorization: 'Bearer short' })).status, 404);
  });

  test('8: with a proper token: no header, a wrong token and a malformed header are 401 (with a challenge); the right one is 200 text/plain', async () => {
    process.env.NODE_ENV = 'production';
    process.env.METRICS_TOKEN = TOKEN;
    for (const headers of [{}, { authorization: 'Bearer nope' }, { authorization: TOKEN }, { authorization: `Basic ${TOKEN}` }, { authorization: `Bearer ${TOKEN}x` }, { authorization: 'Bearer ' }]) {
      const r = await get('/metrics', headers);
      assert.equal(r.status, 401, JSON.stringify(headers));
      assert.equal(r.headers.get('www-authenticate'), 'Bearer realm="metrics"');
      assert.doesNotMatch(r.text, /odito_/, 'no metric leaks to an unauthorised caller');
    }
    const ok = await get('/metrics', { authorization: `Bearer ${TOKEN}` });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type'), /^text\/plain/);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(ok.text, new RegExp(TOKEN), 'the token is never echoed');
    assert.equal((await get('/api/metrics', { authorization: `Bearer ${TOKEN}` })).status, 200);
  });

  test('9: outside production an unset token leaves /metrics open for local use, but a configured one is still enforced', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.METRICS_TOKEN;
    assert.equal((await get('/metrics')).status, 200);
    process.env.METRICS_TOKEN = 'dev-token';
    assert.equal((await get('/metrics')).status, 401);
    assert.equal((await get('/metrics', { authorization: 'Bearer dev-token' })).status, 200);
  });

  test('10: metricsAccess is a pure decision (disabled / open / denied / allowed)', () => {
    const req = (authorization) => ({ get: (h) => (h.toLowerCase() === 'authorization' ? authorization : undefined) });
    assert.equal(metricsAccess(req(), { NODE_ENV: 'production' }), 'disabled');
    assert.equal(metricsAccess(req(), { NODE_ENV: 'test' }), 'open');
    assert.equal(metricsAccess(req('Bearer abc'), { NODE_ENV: 'test', METRICS_TOKEN: 'abc' }), 'allowed');
    assert.equal(metricsAccess(req('bearer abc'), { NODE_ENV: 'test', METRICS_TOKEN: 'abc' }), 'allowed', 'the scheme is case-insensitive');
    assert.equal(metricsAccess(req('Bearer abd'), { NODE_ENV: 'test', METRICS_TOKEN: 'abc' }), 'denied');
  });
});

describe('metrics content', () => {
  test('11: the Social AI series exist from the first scrape, recorded events show up, and no id or message is ever a label', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.METRICS_TOKEN;
    recordRunOutcome('ready', 42_000);
    recordProviderError('AI_BUSY');
    recordProviderError('Error: 6acdc368dfdd3468860b6348 timed out'); // a message is not a code
    recordQuotaEvent('settle_failed');
    const r = await get('/metrics');
    assert.equal(r.status, 200);
    for (const series of ['odito_social_calendar_runs_total{outcome="ready"}', 'odito_social_calendar_runs_total{outcome="failed"}', 'odito_social_calendar_takeovers_total{result="resumed"}', 'odito_social_calendar_recovery_sweeps_total{result="error"}', 'odito_social_quota_events_total{event="settle_failed"}', 'odito_social_publish_total{outcome="failed"}', 'odito_social_cleanup_failures_total{step="credentials"}', 'odito_social_calendar_provider_errors_total{code="AI_BUSY"}', 'odito_social_calendar_run_duration_seconds_count']) {
      assert.ok(r.text.includes(series), `missing ${series}`);
    }
    assert.match(r.text, /odito_social_calendar_runs_total\{outcome="ready"\} [1-9]/);
    assert.match(r.text, /odito_social_calendar_provider_errors_total\{code="other"\} [1-9]/);
    const sampleLines = r.text.split('\n').filter((l) => l && !l.startsWith('#'));
    assert.doesNotMatch(sampleLines.join('\n'), /6acdc368|timed out|project_id|projectId|calendar_id|calendarId/);
    // every sample line is name{label="value"} number, with only the single bounded label
    for (const line of sampleLines) assert.match(line, /^[a-z_:]+(\{[a-z_]+="[^"]*"\})? [-+0-9.eEInf]+$/);
  });
});
