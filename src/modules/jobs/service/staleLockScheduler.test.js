import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JobService } from './jobService.js';
import { runOnce, startStaleLockScheduler, stopStaleLockScheduler } from './staleLockScheduler.js';

// P0-001: cleanupStaleLocks() existed but was never called from anywhere.
// These tests cover the scheduler that now activates it.
describe('staleLockScheduler.runOnce', () => {
  let originalCleanupStaleLocks;
  let originalRecoverOrphaned;

  afterEach(() => {
    if (originalCleanupStaleLocks) {
      JobService.prototype.cleanupStaleLocks = originalCleanupStaleLocks;
      originalCleanupStaleLocks = undefined;
    }
    if (originalRecoverOrphaned) {
      JobService.prototype.recoverOrphanedUrlVerificationJobs = originalRecoverOrphaned;
      originalRecoverOrphaned = undefined;
    }
    stopStaleLockScheduler();
  });

  // H2: recoverOrphanedUrlVerificationJobs is now also called every tick,
  // alongside cleanupStaleLocks — stubbed to a harmless no-op by default so
  // these tests (which never connect to a real DB) keep testing only
  // cleanupStaleLocks' own delegation/error-isolation, unaffected by the
  // new call.
  function stubRecoverOrphaned(impl = async () => ({ modifiedCount: 0 })) {
    originalRecoverOrphaned = JobService.prototype.recoverOrphanedUrlVerificationJobs;
    JobService.prototype.recoverOrphanedUrlVerificationJobs = impl;
  }

  test('delegates to JobService.cleanupStaleLocks and returns its result on success', async () => {
    originalCleanupStaleLocks = JobService.prototype.cleanupStaleLocks;
    let capturedTimeoutMs;
    JobService.prototype.cleanupStaleLocks = async function (lockTimeoutMs) {
      capturedTimeoutMs = lockTimeoutMs;
      return { modifiedCount: 4 };
    };
    stubRecoverOrphaned();

    const result = await runOnce();

    assert.equal(result.modifiedCount, 4);
    // Default STALE_LOCK_TIMEOUT_MS (no env override in this test run) is 10 minutes.
    assert.equal(capturedTimeoutMs, 10 * 60 * 1000);
  });

  test('failure case: a thrown error from cleanupStaleLocks is caught and does not propagate, so the process/cron never crashes', async () => {
    originalCleanupStaleLocks = JobService.prototype.cleanupStaleLocks;
    JobService.prototype.cleanupStaleLocks = async () => {
      throw new Error('Mongo connection lost');
    };
    stubRecoverOrphaned();

    const result = await runOnce();

    assert.deepEqual(result, { modifiedCount: 0 });
  });

  test('edge case: a run with zero modified jobs resolves cleanly', async () => {
    originalCleanupStaleLocks = JobService.prototype.cleanupStaleLocks;
    JobService.prototype.cleanupStaleLocks = async () => ({ modifiedCount: 0 });
    stubRecoverOrphaned();

    const result = await runOnce();

    assert.equal(result.modifiedCount, 0);
  });

  test('H2: recoverOrphanedUrlVerificationJobs is invoked every tick, with the same timeout', async () => {
    originalCleanupStaleLocks = JobService.prototype.cleanupStaleLocks;
    JobService.prototype.cleanupStaleLocks = async () => ({ modifiedCount: 0 });
    let capturedTimeoutMs;
    stubRecoverOrphaned(async (timeoutMs) => {
      capturedTimeoutMs = timeoutMs;
      return { modifiedCount: 2 };
    });

    await runOnce();

    assert.equal(capturedTimeoutMs, 10 * 60 * 1000);
  });

  test('H2: a thrown error from recoverOrphanedUrlVerificationJobs does not propagate and does not affect cleanupStaleLocks\' own result', async () => {
    originalCleanupStaleLocks = JobService.prototype.cleanupStaleLocks;
    JobService.prototype.cleanupStaleLocks = async () => ({ modifiedCount: 7 });
    stubRecoverOrphaned(async () => {
      throw new Error('orphan recovery blew up');
    });

    let result;
    await assert.doesNotReject(async () => {
      result = await runOnce();
    });

    assert.equal(result.modifiedCount, 7);
  });
});

describe('staleLockScheduler start/stop', () => {
  afterEach(() => {
    stopStaleLockScheduler();
  });

  test('startStaleLockScheduler schedules a task and is a no-op on a second call', () => {
    const first = startStaleLockScheduler();
    assert.ok(first, 'expected a scheduled task when enabled');

    const second = startStaleLockScheduler();
    assert.equal(second, first, 'calling start twice must return the existing task, not create a duplicate');
  });

  test('stopStaleLockScheduler stops the task so subsequent starts create a fresh one', () => {
    const first = startStaleLockScheduler();
    stopStaleLockScheduler();

    const second = startStaleLockScheduler();
    assert.notEqual(second, first, 'after stopping, start should schedule a new task');
  });

  test('does not schedule when STALE_LOCK_CLEANUP_ENABLED=false (module re-evaluated with the flag set)', async () => {
    process.env.STALE_LOCK_CLEANUP_ENABLED = 'false';
    try {
      // Cache-bust the ESM module cache so the module-level ENABLED constant
      // is re-evaluated against the env var set above.
      const mod = await import(`./staleLockScheduler.js?disabled-test=${Date.now()}`);
      const task = mod.startStaleLockScheduler();
      assert.equal(task, null);
    } finally {
      delete process.env.STALE_LOCK_CLEANUP_ENABLED;
    }
  });
});
