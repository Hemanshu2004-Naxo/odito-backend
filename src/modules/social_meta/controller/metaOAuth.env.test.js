import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// NOTE: no dotenv here and no top-level env setup — these tests control
// process.env themselves AFTER the controller is imported, which is exactly
// the ordering that used to freeze FRONTEND_URL.
import { handleMetaCallback } from './metaOAuthController.js';
import { getFrontendUrl, getSocialSchedulerState } from '../../../config/env.js';
import { startSocialScheduler, stopSocialScheduler, getSchedulerStatus } from '../service/socialSchedulerService.js';

/**
 * Production environment regression tests (P0 #8). The Meta OAuth callback
 * used to capture `process.env.CORS_ORIGIN` in a module-level constant that
 * ES-module evaluation order could freeze to http://localhost:3000 before
 * dotenv ran, so with env supplied by .env EVERY post-OAuth redirect in
 * production went to localhost. These tests set the environment AFTER the
 * module has already been imported (the failing order) and prove the redirect
 * follows it.
 */

const SAVED = { CORS_ORIGIN: process.env.CORS_ORIGIN, NODE_ENV: process.env.NODE_ENV, SOCIAL_SCHEDULER_ENABLED: process.env.SOCIAL_SCHEDULER_ENABLED };
afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  stopSocialScheduler();
});

function mockRes() {
  return { redirectedTo: null, statusCode: null, sent: null, redirect(u) { this.redirectedTo = u; return this; }, status(c) { this.statusCode = c; return this; }, send(t) { this.sent = t; return this; }, json(p) { this.body = p; return this; } };
}
// Meta's own consent-denial path — needs no DB, no Meta call, still redirects to the frontend.
const denied = () => ({ query: { error: 'access_denied' } });

describe('Meta OAuth callback redirects to the CONFIGURED frontend (read per request, never frozen at import)', () => {
  test('production: CORS_ORIGIN set AFTER the controller was imported => redirect goes to the production URL, never localhost', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ORIGIN = 'https://app.odito.example';
    const res = mockRes();
    await handleMetaCallback(denied(), res);
    assert.ok(res.redirectedTo.startsWith('https://app.odito.example/app/social'), res.redirectedTo);
    assert.ok(!res.redirectedTo.includes('localhost'));
    assert.ok(res.redirectedTo.includes('meta_error=access_denied'));
  });

  test('the value is re-read on every call (a config change is honored without re-import)', async () => {
    process.env.CORS_ORIGIN = 'https://one.example';
    const a = mockRes(); await handleMetaCallback(denied(), a);
    process.env.CORS_ORIGIN = 'https://two.example';
    const b = mockRes(); await handleMetaCallback(denied(), b);
    assert.ok(a.redirectedTo.startsWith('https://one.example/'));
    assert.ok(b.redirectedTo.startsWith('https://two.example/'));
  });

  test('production with CORS_ORIGIN MISSING is a hard configuration error (500) — never a silent redirect to localhost', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.CORS_ORIGIN;
    const res = mockRes();
    await handleMetaCallback(denied(), res);
    assert.equal(res.redirectedTo, null, 'must not redirect anywhere');
    assert.equal(res.statusCode, 500);
  });

  test('development with CORS_ORIGIN missing still falls back to the local dev server (convenience preserved)', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.CORS_ORIGIN;
    const res = mockRes();
    await handleMetaCallback(denied(), res);
    assert.ok(res.redirectedTo.startsWith('http://localhost:3000/app/social'));
  });

  test('getFrontendUrl: first of a comma-separated list, trailing slashes trimmed', () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ORIGIN = 'https://app.odito.example/, https://admin.odito.example';
    assert.equal(getFrontendUrl(), 'https://app.odito.example');
  });

  test('import-order independence: a fresh process that imports the controller with NO CORS_ORIGIN, then sets it, redirects to it', () => {
    const controllerUrl = new URL('./metaOAuthController.js', import.meta.url).href;
    const script = `
      delete process.env.CORS_ORIGIN;
      const { handleMetaCallback } = await import(${JSON.stringify(controllerUrl)});
      process.env.NODE_ENV = 'production';
      process.env.CORS_ORIGIN = 'https://later.example';
      const res = { redirect(u) { console.log('REDIRECT=' + u); }, status() { return this; }, send() {} };
      await handleMetaCallback({ query: { error: 'access_denied' } }, res);
      process.exit(0);
    `;
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..'), timeout: 60_000 });
    assert.match(out.stdout, /REDIRECT=https:\/\/later\.example\/app\/social/, `stdout=${out.stdout} stderr=${out.stderr.slice(0, 400)}`);
  });
});

describe('SOCIAL_SCHEDULER_ENABLED — one explicit, observable rule', () => {
  test('only the exact string "true" enables it; unset/false/TRUE/1 are all disabled, each with a reason', () => {
    process.env.SOCIAL_SCHEDULER_ENABLED = 'true';
    assert.deepEqual(getSocialSchedulerState(), { enabled: true, reason: null });
    for (const v of ['false', 'TRUE', 'True', '1', 'yes', ' true']) {
      process.env.SOCIAL_SCHEDULER_ENABLED = v;
      const s = getSocialSchedulerState();
      assert.equal(s.enabled, false, `"${v}"`);
      assert.match(s.reason, /SOCIAL_SCHEDULER_ENABLED/);
    }
    delete process.env.SOCIAL_SCHEDULER_ENABLED;
    const unset = getSocialSchedulerState();
    assert.equal(unset.enabled, false);
    assert.match(unset.reason, /not set/);
  });

  test('a DISABLED scheduler is observable: no cron task, and getSchedulerStatus() says why', () => {
    delete process.env.SOCIAL_SCHEDULER_ENABLED;
    const task = startSocialScheduler();
    assert.equal(task, null);
    const status = getSchedulerStatus();
    assert.equal(status.enabled, false);
    assert.equal(status.running, false);
    assert.match(status.disabledReason, /not set/);
  });

  test('an ENABLED scheduler reports running with its cron expression, and stop() flips it back', () => {
    process.env.SOCIAL_SCHEDULER_ENABLED = 'true';
    const task = startSocialScheduler();
    assert.ok(task);
    let status = getSchedulerStatus();
    assert.equal(status.enabled, true);
    assert.equal(status.running, true);
    assert.equal(status.disabledReason, null);
    assert.equal(status.cronExpression, '* * * * *');
    stopSocialScheduler();
    status = getSchedulerStatus();
    assert.equal(status.running, false);
  });

  test('.env.example no longer contradicts the code: it ships the scheduler DISABLED and documents the new settings', () => {
    const example = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../.env.example'), 'utf8');
    assert.match(example, /^SOCIAL_SCHEDULER_ENABLED=false$/m, 'must not ship the scheduler enabled');
    for (const key of ['SOCIAL_SCHEDULER_MAX_LATENESS_MINUTES', 'SOCIAL_PUBLISH_MAX_ATTEMPTS', 'SOCIAL_PUBLISH_RETRY_BASE_MS', 'SOCIAL_PUBLISH_STALE_MS', 'SOCIAL_PUBLISH_RECONCILE_SETTLE_MS']) {
      assert.match(example, new RegExp(`^${key}=`, 'm'), `${key} must be documented`);
    }
  });
});
