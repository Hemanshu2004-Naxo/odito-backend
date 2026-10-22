import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveTargetStatus, retryability, summarizeTargets } from './altTargetRollup.js';

const NOW = new Date('2026-10-15T12:00:00Z');
const rec = (status, extra = {}) => ({ status, updatedAt: new Date(NOW.getTime() - 1000), rollback: { status: 'none' }, ...extra });
const item = (src, targetStatus, extra = {}) => ({ src, targetStatus, inFindings: true, ...retryability(targetStatus), ...extra });

describe('deriveTargetStatus', () => {
  test('maps ledger statuses onto what a person needs to know', () => {
    assert.equal(deriveTargetStatus(null, NOW), 'not_started');
    assert.equal(deriveTargetStatus(rec('applied'), NOW), 'applied_pending_verification');
    assert.equal(deriveTargetStatus(rec('verified'), NOW), 'verified');
    assert.equal(deriveTargetStatus(rec('verification_failed'), NOW), 'verification_failed');
    for (const s of ['apply_failed', 'permission_denied', 'conflict_detected']) assert.equal(deriveTargetStatus(rec(s), NOW), 'failed', s);
  });

  test('an unknown outcome is recoverable, never "failed" and never "applied"', () => {
    assert.equal(deriveTargetStatus(rec('apply_uncertain'), NOW), 'needs_reconcile');
    assert.equal(deriveTargetStatus(rec('applying'), NOW), 'in_progress');
    const abandoned = rec('applying', { updatedAt: new Date(NOW.getTime() - 20 * 60 * 1000) });
    assert.equal(deriveTargetStatus(abandoned, NOW), 'needs_reconcile');
  });

  test('rollback stages: requested / partial are incomplete, applied / verified are rolled back', () => {
    assert.equal(deriveTargetStatus(rec('applied', { rollback: { status: 'requested' } }), NOW), 'rollback_incomplete');
    assert.equal(deriveTargetStatus(rec('applied', { rollback: { status: 'partial_conflict' } }), NOW), 'rollback_incomplete');
    assert.equal(deriveTargetStatus(rec('rolled_back', { rollback: { status: 'applied' } }), NOW), 'rolled_back');
    assert.equal(deriveTargetStatus(rec('rolled_back', { rollback: { status: 'verified' } }), NOW), 'rolled_back');
    assert.equal(deriveTargetStatus(rec('rolled_back', { rollback: { status: 'rolled_back' } }), NOW), 'rolled_back', 'legacy value stays readable');
  });
});

describe('retryability', () => {
  test('only a failed write is retryable; an unknown outcome or a half rollback is recoverable instead', () => {
    assert.deepEqual(retryability('failed'), { retryable: true, recoverable: false });
    assert.deepEqual(retryability('needs_reconcile'), { retryable: false, recoverable: true });
    assert.deepEqual(retryability('rollback_incomplete'), { retryable: false, recoverable: true });
    for (const s of ['verified', 'applied_pending_verification', 'verification_failed', 'rolled_back', 'not_started']) assert.deepEqual(retryability(s), { retryable: false, recoverable: false }, s);
  });
});

describe('summarizeTargets — never "verified" unless every changed target is', () => {
  const overall = (...statuses) => summarizeTargets(statuses.map((s, n) => item(`img${n}`, s))).overall;

  test('nothing attempted', () => assert.equal(overall('not_started', 'not_started'), 'not_started'));
  test('a write is running', () => assert.equal(overall('verified', 'in_progress'), 'in_progress'));
  test('some succeeded and some failed or are unknown: partially applied', () => {
    assert.equal(overall('verified', 'failed'), 'partially_applied');
    assert.equal(overall('applied_pending_verification', 'needs_reconcile'), 'partially_applied');
  });
  test('everything that was tried failed', () => assert.equal(overall('failed', 'failed'), 'failed'));
  test('only verification problems: needs attention, not "failed"', () => assert.equal(overall('verification_failed'), 'needs_attention'));
  test('one verified, one waiting for a recrawl: partially verified', () => assert.equal(overall('verified', 'applied_pending_verification'), 'partially_verified'));
  test('all applied, none confirmed yet', () => assert.equal(overall('applied_pending_verification', 'applied_pending_verification'), 'applied_pending_verification'));
  test('all verified and nothing else flagged: verified', () => assert.equal(overall('verified', 'verified'), 'verified'));
  test('all changed images verified but another flagged image was never touched: says so', () => {
    const s = summarizeTargets([item('a', 'verified'), item('b', 'not_started')]);
    assert.equal(s.overall, 'verified_images_remaining');
    assert.equal(s.remainingOpenImages, 1);
  });
  test('a rolled-back image does not count as a remaining open image when its finding is gone', () => {
    const s = summarizeTargets([item('a', 'rolled_back', { inFindings: false })]);
    assert.equal(s.overall, 'rolled_back');
    assert.equal(s.remainingOpenImages, 0);
  });
  test('lists exactly the retryable and the recoverable images', () => {
    const s = summarizeTargets([item('a', 'failed'), item('b', 'needs_reconcile'), item('c', 'verified'), item('d', 'rollback_incomplete')]);
    assert.deepEqual(s.retryable, ['a']);
    assert.deepEqual(s.recoverable, ['b', 'd']);
    assert.equal(s.targets, 4);
  });
});
