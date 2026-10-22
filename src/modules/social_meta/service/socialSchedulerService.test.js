import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startSocialScheduler, stopSocialScheduler } from './socialSchedulerService.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Root-cause regression coverage for the "scheduled posts never publish in
// production" bug: SOCIAL_SCHEDULER_ENABLED used to be read as a
// module-top-level `const ENABLED = process.env.SOCIAL_SCHEDULER_ENABLED
// === 'true'` — frozen the moment this file was first imported. Because
// this app is native ESM, server.js's own dotenv.config() call (in ITS
// top-level body) always runs AFTER every module it statically imports
// (this one included) has already been fully evaluated — so that constant
// always observed `undefined`, regardless of what .env actually said,
// permanently disabling the scheduler. The fix reads process.env fresh
// inside startSocialScheduler() itself, at call time (long after
// dotenv.config() has run in the real server), instead of at import time.
//
// Test isolation: `task` is a module-level singleton and
// SOCIAL_SCHEDULER_ENABLED/SOCIAL_SCHEDULER_CRON are real process.env
// mutations — every test cleans both up so nothing leaks into another
// test in this file or beyond it.
afterEach(() => {
  stopSocialScheduler();
  delete process.env.SOCIAL_SCHEDULER_ENABLED;
  delete process.env.SOCIAL_SCHEDULER_CRON;
});

describe('startSocialScheduler — SOCIAL_SCHEDULER_ENABLED gating', () => {
  test('1: SOCIAL_SCHEDULER_ENABLED undefined -> does not register cron, returns null, and no task exists', () => {
    delete process.env.SOCIAL_SCHEDULER_ENABLED;
    const task = startSocialScheduler();
    assert.equal(task, null);
  });

  test('2: SOCIAL_SCHEDULER_ENABLED="false" -> remains disabled', () => {
    process.env.SOCIAL_SCHEDULER_ENABLED = 'false';
    const task = startSocialScheduler();
    assert.equal(task, null);
  });

  test('3: SOCIAL_SCHEDULER_ENABLED="true" -> registers a real cron task', () => {
    process.env.SOCIAL_SCHEDULER_ENABLED = 'true';
    const task = startSocialScheduler();
    assert.ok(task, 'expected a real scheduled task when enabled');
    assert.equal(typeof task.getPattern, 'function', 'expected the real node-cron task object, not a stub');
  });
});

describe('startSocialScheduler — cron configuration', () => {
  test('4: the default cron expression remains "* * * * *" when SOCIAL_SCHEDULER_CRON is not set', () => {
    process.env.SOCIAL_SCHEDULER_ENABLED = 'true';
    delete process.env.SOCIAL_SCHEDULER_CRON;
    const task = startSocialScheduler();
    assert.equal(task.getPattern(), '* * * * *');
  });

  test('a custom SOCIAL_SCHEDULER_CRON is still honored when provided (unchanged behavior)', () => {
    process.env.SOCIAL_SCHEDULER_ENABLED = 'true';
    process.env.SOCIAL_SCHEDULER_CRON = '*/5 * * * *';
    const task = startSocialScheduler();
    assert.equal(task.getPattern(), '*/5 * * * *');
  });

  // node-cron v4's Runner class stores `noOverlap` internally with no
  // public getter (verified against node_modules/node-cron/dist/scheduler/
  // runner.js) — so this asserts directly against the source that the
  // schedule() call still passes { noOverlap: true }, rather than
  // reintroducing a node-cron mock this codebase's other scheduler tests
  // (staleLockScheduler.test.js) don't use either.
  test('5: schedule() is still called with noOverlap:true', () => {
    const source = readFileSync(join(__dirname, 'socialSchedulerService.js'), 'utf8');
    assert.match(source, /noOverlap:\s*true/, 'expected schedule() to still be called with { noOverlap: true }');
  });
});

describe('startSocialScheduler — duplicate registration / stop', () => {
  test('6: calling startSocialScheduler() twice does not register two cron tasks', () => {
    process.env.SOCIAL_SCHEDULER_ENABLED = 'true';
    const first = startSocialScheduler();
    const second = startSocialScheduler();
    assert.ok(first);
    assert.equal(second, first, 'a second call while already running must return the SAME task, never a new one');
  });

  test('7: stopSocialScheduler() stops the task, and a subsequent start creates a fresh one', () => {
    process.env.SOCIAL_SCHEDULER_ENABLED = 'true';
    const first = startSocialScheduler();

    stopSocialScheduler();
    assert.equal(first.getStatus(), 'stopped');

    const second = startSocialScheduler();
    assert.ok(second);
    assert.notEqual(second, first, 'after stopping, starting again must schedule a brand new task');
  });
});

// ★ THE KEY REGRESSION TEST ★ — reproduces the exact original failure
// mode, in the exact shape it happens in production: this test file's own
// `import { startSocialScheduler } from './socialSchedulerService.js'` at
// the top already ran with SOCIAL_SCHEDULER_ENABLED unset. The env var
// only becomes available INSIDE this test, strictly after that import
// already completed — exactly mirroring server.js's real dotenv.config()
// running after socialSchedulerService.js has already been evaluated.
//
// This test MUST fail against the old implementation
// (`const ENABLED = process.env.SOCIAL_SCHEDULER_ENABLED === 'true'` at
// module top level), because that constant is frozen the moment the
// module is first imported — setting the env var afterward could never
// change it, so `enabledTask` would incorrectly be `null`. It passes here
// specifically because startSocialScheduler() now reads
// process.env.SOCIAL_SCHEDULER_ENABLED fresh on every call.
describe('startSocialScheduler — KEY REGRESSION: env var set AFTER module import must still be honored', () => {
  test('starts once the env var is set, even though it was unavailable when this module was first imported', () => {
    delete process.env.SOCIAL_SCHEDULER_ENABLED;
    const disabledTask = startSocialScheduler();
    assert.equal(disabledTask, null, 'sanity check: genuinely disabled before the env var is set');

    process.env.SOCIAL_SCHEDULER_ENABLED = 'true';
    const enabledTask = startSocialScheduler();
    assert.ok(enabledTask, 'the scheduler MUST start now that the env var is set — this is the exact bug that shipped to production');
  });
});
