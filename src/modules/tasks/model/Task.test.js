import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Task from './Task.js';

// Pure static transition-table checks — no DB needed. Covers the fix for
// the Optimization Center workflow consistency update: REOPENED must be
// re-verifiable directly to VERIFIED_FIXED (not routed back through
// IMPLEMENTED first), since Bulk URL Verification/TaskVerificationService
// now re-checks REOPENED tasks the same way it already re-checks
// IMPLEMENTED ones.

describe('Task.isValidTransition', () => {
  test('task_created can only move to implemented', () => {
    assert.equal(Task.isValidTransition('task_created', 'implemented'), true);
    assert.equal(Task.isValidTransition('task_created', 'verified_fixed'), false);
    assert.equal(Task.isValidTransition('task_created', 'reopened'), false);
  });

  test('implemented can resolve to verified_fixed or reopened', () => {
    assert.equal(Task.isValidTransition('implemented', 'verified_fixed'), true);
    assert.equal(Task.isValidTransition('implemented', 'reopened'), true);
    assert.equal(Task.isValidTransition('implemented', 'task_created'), false);
  });

  test('verified_fixed is terminal', () => {
    assert.equal(Task.isValidTransition('verified_fixed', 'implemented'), false);
    assert.equal(Task.isValidTransition('verified_fixed', 'reopened'), false);
    assert.equal(Task.isValidTransition('verified_fixed', 'task_created'), false);
  });

  test('reopened can re-implement OR re-verify directly to verified_fixed', () => {
    assert.equal(Task.isValidTransition('reopened', 'implemented'), true);
    assert.equal(Task.isValidTransition('reopened', 'verified_fixed'), true);
    assert.equal(Task.isValidTransition('reopened', 'task_created'), false);
  });
});

// fixHistory schema validation — pure validateSync(), no DB needed.
// Regression coverage for a real production bug: Mongoose's enum validator
// checks `null` against the enum list too (it only skips `undefined`), so
// `enum: [...values]` + `default: null` on verification.method/result meant
// EVERY fresh attempt (method/result legitimately null until a verification
// pass runs) failed `.save()` with "`null` is not a valid enum value" —
// this fired on every real "Mark as Implemented" click in production.
function makeAttempt(overrides = {}) {
  return {
    attemptNumber: 1,
    attemptKind: 'fix_attempt',
    origin: 'ai_fix',
    status: 'pending_verification',
    before: { capturedAt: new Date(), source: 'diagnostic_string', dataPath: 'meta_tags.description', value: 'Description length: 177 characters (maximum: 160)' },
    fixApplied: { capturedAt: new Date(), recommendationId: null, recommendationVersion: 1, snapshot: { recommendedFix: 'x' }, expectedAfterValue: null },
    implementedAt: new Date(),
    verification: { verifiedAt: null, method: null, result: null, matched: null, after: { source: 'unavailable', value: null }, triggerJobId: null },
    ...overrides,
  };
}

function makeTask(fixHistory) {
  return new Task({
    projectId: '507f1f77bcf86cd799439011',
    issueKey: 'meta_description_too_long',
    pageUrl: 'https://naxonify.com/seo-reseller',
    status: 'implemented',
    origin: 'ai_fix',
    fixHistory,
  });
}

describe('Task.fixHistory schema validation', () => {
  test('a freshly-implemented attempt (method/result still null, unverified) passes validation', () => {
    const task = makeTask([makeAttempt()]);
    assert.equal(task.validateSync(), undefined);
  });

  test('a verified attempt (method/result populated) passes validation', () => {
    const task = makeTask([makeAttempt({
      status: 'verified_fixed',
      verification: {
        verifiedAt: new Date(),
        method: 'value_diff',
        result: 'verified_fixed',
        matched: true,
        after: { source: 'structured_snapshot', value: { type: 'meta_description', metaDescription: 'x' } },
        triggerJobId: null,
      },
    })]);
    assert.equal(task.validateSync(), undefined);
  });

  test('a reopened attempt via presence_fallback passes validation', () => {
    const task = makeTask([makeAttempt({
      status: 'reopened',
      verification: {
        verifiedAt: new Date(),
        method: 'presence_fallback',
        result: 'reopened',
        matched: null,
        after: { source: 'unavailable', value: null },
        triggerJobId: null,
      },
    })]);
    assert.equal(task.validateSync(), undefined);
  });

  test('a reverify_only attempt (fixApplied all-null, no new fix) passes validation', () => {
    const task = makeTask([makeAttempt({
      attemptKind: 'reverify_only',
      fixApplied: { capturedAt: null, recommendationId: null, recommendationVersion: null, snapshot: null, expectedAfterValue: null },
      implementedAt: null,
    })]);
    assert.equal(task.validateSync(), undefined);
  });

  test('an invalid method/result value is still rejected (enum isn\'t just wide open)', () => {
    const task = makeTask([makeAttempt({ verification: { verifiedAt: new Date(), method: 'guesswork', result: 'verified_fixed', matched: null, after: { source: 'unavailable', value: null }, triggerJobId: null } })]);
    const err = task.validateSync();
    assert.ok(err, 'expected a validation error for an unrecognized method value');
    assert.match(err.message, /verification\.method/);
  });
});
