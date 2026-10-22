import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { computeVerificationDelta } from './computeVerificationDelta.js';

const snap = (overrides = {}) => ({
  pageScore: null,
  aisoScore: null,
  aeoScore: null,
  geoScore: null,
  criticalIssues: 0,
  warningIssues: 0,
  infoIssues: 0,
  ...overrides,
});

describe('computeVerificationDelta — score changes', () => {
  test('no score change: identical before/after produces zero deltas', () => {
    const before = snap({ pageScore: 80, aisoScore: 70, aeoScore: 60, geoScore: 50 });
    const after = snap({ pageScore: 80, aisoScore: 70, aeoScore: 60, geoScore: 50 });
    const delta = computeVerificationDelta(before, after);
    assert.equal(delta.pageScoreChange, 0);
    assert.equal(delta.aisoScoreChange, 0);
    assert.equal(delta.aeoScoreChange, 0);
    assert.equal(delta.geoScoreChange, 0);
  });

  test('score increase: positive delta', () => {
    const before = snap({ pageScore: 50, aisoScore: 40 });
    const after = snap({ pageScore: 75, aisoScore: 60 });
    const delta = computeVerificationDelta(before, after);
    assert.equal(delta.pageScoreChange, 25);
    assert.equal(delta.aisoScoreChange, 20);
  });

  test('score decrease: negative delta', () => {
    const before = snap({ pageScore: 90, geoScore: 80 });
    const after = snap({ pageScore: 70, geoScore: 55 });
    const delta = computeVerificationDelta(before, after);
    assert.equal(delta.pageScoreChange, -20);
    assert.equal(delta.geoScoreChange, -25);
  });

  test('rounds to 2 decimal places to avoid floating point noise', () => {
    const before = snap({ pageScore: 50.1 });
    const after = snap({ pageScore: 50.2 });
    const delta = computeVerificationDelta(before, after);
    assert.equal(delta.pageScoreChange, 0.1);
  });

  test('null score handling: before null, after a number -> null change (not treated as 0)', () => {
    const before = snap({ aeoScore: null });
    const after = snap({ aeoScore: 65 });
    const delta = computeVerificationDelta(before, after);
    assert.equal(delta.aeoScoreChange, null);
  });

  test('null score handling: after null, before a number -> null change', () => {
    const before = snap({ aeoScore: 65 });
    const after = snap({ aeoScore: null });
    const delta = computeVerificationDelta(before, after);
    assert.equal(delta.aeoScoreChange, null);
  });

  test('null score handling: both null -> null change', () => {
    const before = snap({ geoScore: null });
    const after = snap({ geoScore: null });
    const delta = computeVerificationDelta(before, after);
    assert.equal(delta.geoScoreChange, null);
  });
});

describe('computeVerificationDelta — issue changes', () => {
  test('issue additions: new criticals introduced, none fixed', () => {
    const before = snap({ criticalIssues: 0, warningIssues: 0, infoIssues: 0 });
    const after = snap({ criticalIssues: 3, warningIssues: 0, infoIssues: 0 });
    const delta = computeVerificationDelta(before, after);
    assert.equal(delta.issuesIntroduced, 3);
    assert.equal(delta.issuesFixed, 0);
    assert.equal(delta.issuesUnchanged, 0);
  });

  test('issue removals: all issues fixed, none introduced', () => {
    const before = snap({ criticalIssues: 2, warningIssues: 3, infoIssues: 1 });
    const after = snap({ criticalIssues: 0, warningIssues: 0, infoIssues: 0 });
    const delta = computeVerificationDelta(before, after);
    assert.equal(delta.issuesFixed, 6);
    assert.equal(delta.issuesIntroduced, 0);
    assert.equal(delta.issuesUnchanged, 0);
  });

  test('mixed issue changes: some fixed, some introduced, some unchanged, in the same run', () => {
    const before = snap({ criticalIssues: 3, warningIssues: 2, infoIssues: 1 });
    const after = snap({ criticalIssues: 1, warningIssues: 4, infoIssues: 1 });
    const delta = computeVerificationDelta(before, after);
    // critical: fixed 2, unchanged 1
    // warning: introduced 2, unchanged 2
    // info: unchanged 1
    assert.equal(delta.issuesFixed, 2);
    assert.equal(delta.issuesIntroduced, 2);
    assert.equal(delta.issuesUnchanged, 4);
  });

  test('a severity shift with an equal total is NOT silently netted to zero', () => {
    // 5 warnings become 5 criticals — totals are equal (5 -> 5), but this
    // is a real regression, not "no change".
    const before = snap({ criticalIssues: 0, warningIssues: 5, infoIssues: 0 });
    const after = snap({ criticalIssues: 5, warningIssues: 0, infoIssues: 0 });
    const delta = computeVerificationDelta(before, after);
    assert.equal(delta.issuesFixed, 5);
    assert.equal(delta.issuesIntroduced, 5);
    assert.equal(delta.issuesUnchanged, 0);
  });

  test('no issue change: identical counts produce zero fixed/introduced, full unchanged', () => {
    const before = snap({ criticalIssues: 2, warningIssues: 1, infoIssues: 3 });
    const after = snap({ criticalIssues: 2, warningIssues: 1, infoIssues: 3 });
    const delta = computeVerificationDelta(before, after);
    assert.equal(delta.issuesFixed, 0);
    assert.equal(delta.issuesIntroduced, 0);
    assert.equal(delta.issuesUnchanged, 6);
  });
});

describe('computeVerificationDelta — missing data handling', () => {
  test('missing before object entirely defaults every field safely', () => {
    const after = snap({ pageScore: 80, criticalIssues: 1 });
    const delta = computeVerificationDelta(undefined, after);
    assert.equal(delta.pageScoreChange, null);
    assert.equal(delta.issuesIntroduced, 1);
  });

  test('missing after object entirely defaults every field safely', () => {
    const before = snap({ pageScore: 80, criticalIssues: 1 });
    const delta = computeVerificationDelta(before, undefined);
    assert.equal(delta.pageScoreChange, null);
    assert.equal(delta.issuesFixed, 1);
  });

  test('both missing produces an all-zero/null delta without throwing', () => {
    const delta = computeVerificationDelta();
    assert.equal(delta.pageScoreChange, null);
    assert.equal(delta.aisoScoreChange, null);
    assert.equal(delta.aeoScoreChange, null);
    assert.equal(delta.geoScoreChange, null);
    assert.equal(delta.issuesFixed, 0);
    assert.equal(delta.issuesIntroduced, 0);
    assert.equal(delta.issuesUnchanged, 0);
  });
});

describe('computeVerificationDelta — determinism', () => {
  test('is a pure function: same inputs always produce the same output', () => {
    const before = snap({ pageScore: 60, criticalIssues: 2 });
    const after = snap({ pageScore: 85, criticalIssues: 0 });
    const first = computeVerificationDelta(before, after);
    const second = computeVerificationDelta(before, after);
    assert.deepEqual(first, second);
  });
});
