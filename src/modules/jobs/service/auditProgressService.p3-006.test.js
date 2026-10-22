import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import auditProgressService from './auditProgressService.js';

// P3-006: URL Verification realtime events — emitVerificationStarted/
// Progress/Completed/Failed. Reuses global.io + the existing project room,
// same as emitCompleted already does. A fake io captures every to(room).emit
// call so payload shape and room routing can be asserted without a real
// socket server.

function fakeIo() {
  const calls = [];
  return {
    calls,
    to(room) {
      return {
        emit(event, payload) {
          calls.push({ room, event, payload });
        },
      };
    },
  };
}

describe('auditProgressService — URL Verification events (P3-006)', () => {
  let originalIo;

  beforeEach(() => {
    originalIo = global.io;
  });

  afterEach(() => {
    global.io = originalIo;
  });

  test('emitVerificationStarted emits to project-{projectId} with the expected payload shape', () => {
    const io = fakeIo();
    global.io = io;

    auditProgressService.emitVerificationStarted({
      runId: 'run-1', verificationRunId: 'vr-1', projectId: 'proj-1', pageUrl: 'https://a.com/x', currentJob: 'job-1',
    });

    assert.equal(io.calls.length, 1);
    assert.equal(io.calls[0].room, 'project-proj-1');
    assert.equal(io.calls[0].event, 'verification:started');
    const p = io.calls[0].payload;
    assert.equal(p.runId, 'run-1');
    assert.equal(p.verificationRunId, 'vr-1');
    assert.equal(p.projectId, 'proj-1');
    assert.equal(p.pageUrl, 'https://a.com/x');
    assert.equal(p.status, 'started');
    assert.equal(p.progress, 0);
    assert.equal(p.currentStage, 'Queued');
    assert.equal(p.currentJob, 'job-1');
    assert.ok(p.timestamp instanceof Date);
  });

  test('emitVerificationProgress emits the given stage/progress', () => {
    const io = fakeIo();
    global.io = io;

    auditProgressService.emitVerificationProgress({
      runId: 'run-1', verificationRunId: 'vr-1', projectId: 'proj-1', pageUrl: 'https://a.com/x',
      progress: 50, currentStage: 'Page Analysis', currentJob: 'job-3',
    });

    assert.equal(io.calls[0].room, 'project-proj-1');
    assert.equal(io.calls[0].event, 'verification:progress');
    assert.equal(io.calls[0].payload.status, 'processing');
    assert.equal(io.calls[0].payload.progress, 50);
    assert.equal(io.calls[0].payload.currentStage, 'Page Analysis');
  });

  test('emitVerificationCompleted emits status=completed, progress=100, stage=Completed', () => {
    const io = fakeIo();
    global.io = io;

    auditProgressService.emitVerificationCompleted({
      runId: 'run-1', verificationRunId: 'vr-1', projectId: 'proj-1', pageUrl: 'https://a.com/x',
    });

    assert.equal(io.calls[0].event, 'verification:completed');
    assert.equal(io.calls[0].payload.status, 'completed');
    assert.equal(io.calls[0].payload.progress, 100);
    assert.equal(io.calls[0].payload.currentStage, 'Completed');
  });

  test('emitVerificationFailed emits status=failed with errorMessage', () => {
    const io = fakeIo();
    global.io = io;

    auditProgressService.emitVerificationFailed({
      runId: 'run-1', verificationRunId: 'vr-1', projectId: 'proj-1', pageUrl: 'https://a.com/x',
      currentStage: 'SEO Scoring', errorMessage: 'worker crashed',
    });

    assert.equal(io.calls[0].event, 'verification:failed');
    assert.equal(io.calls[0].payload.status, 'failed');
    assert.equal(io.calls[0].payload.currentStage, 'SEO Scoring');
    assert.equal(io.calls[0].payload.errorMessage, 'worker crashed');
  });

  test('no-op (does not throw) when global.io is unavailable', () => {
    global.io = undefined;
    assert.doesNotThrow(() => {
      auditProgressService.emitVerificationStarted({ runId: 'r', verificationRunId: 'v', projectId: 'p', pageUrl: 'u' });
      auditProgressService.emitVerificationProgress({ runId: 'r', verificationRunId: 'v', projectId: 'p', pageUrl: 'u', progress: 1, currentStage: 's' });
      auditProgressService.emitVerificationCompleted({ runId: 'r', verificationRunId: 'v', projectId: 'p', pageUrl: 'u' });
      auditProgressService.emitVerificationFailed({ runId: 'r', verificationRunId: 'v', projectId: 'p', pageUrl: 'u' });
    });
  });

  test('warns (does not silently vanish) when global.io is unavailable — diagnostic for the "modal stuck at Running" bug class', () => {
    global.io = undefined;
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (msg) => warnings.push(msg);

    try {
      auditProgressService.emitVerificationStarted({ runId: 'r1', verificationRunId: 'v1', projectId: 'p1', pageUrl: 'u1' });
      auditProgressService.emitVerificationProgress({ runId: 'r2', verificationRunId: 'v2', projectId: 'p2', pageUrl: 'u2', progress: 1, currentStage: 's' });
      auditProgressService.emitVerificationCompleted({ runId: 'r3', verificationRunId: 'v3', projectId: 'p3', pageUrl: 'u3' });
      auditProgressService.emitVerificationFailed({ runId: 'r4', verificationRunId: 'v4', projectId: 'p4', pageUrl: 'u4' });
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(warnings.length, 4);
    assert.match(warnings[0], /verification:started dropped/);
    assert.match(warnings[0], /runId=r1/);
    assert.match(warnings[1], /verification:progress dropped/);
    assert.match(warnings[2], /verification:completed dropped/);
    assert.match(warnings[2], /runId=r3/);
    assert.match(warnings[3], /verification:failed dropped/);
  });

  test('all four events route to the SAME existing project room naming convention, no new room architecture', () => {
    const io = fakeIo();
    global.io = io;

    auditProgressService.emitVerificationStarted({ runId: 'r', verificationRunId: 'v', projectId: 'proj-x', pageUrl: 'u' });
    auditProgressService.emitVerificationProgress({ runId: 'r', verificationRunId: 'v', projectId: 'proj-x', pageUrl: 'u', progress: 1, currentStage: 's' });
    auditProgressService.emitVerificationCompleted({ runId: 'r', verificationRunId: 'v', projectId: 'proj-x', pageUrl: 'u' });
    auditProgressService.emitVerificationFailed({ runId: 'r', verificationRunId: 'v', projectId: 'proj-x', pageUrl: 'u' });

    assert.ok(io.calls.every((c) => c.room === 'project-proj-x'));
  });
});
