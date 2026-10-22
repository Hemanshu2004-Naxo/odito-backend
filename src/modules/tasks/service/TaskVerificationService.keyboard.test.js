import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import taskVerificationService from './TaskVerificationService.js';
import taskHistoryService from './TaskHistoryService.js';
import { inferSnapshotType } from './issueSnapshotTypes.js';

/**
 * keyboard_accessibility verification: re-test the EXACT elements a fix targeted against a
 * fresh v2 audit. Never "does the CSS contain outline" and never "the issue vanished".
 * Pure logic — the Mongo-backed chain is in issue-context/accessibility.pipeline.integration.test.js.
 */

const FIX_TIME = '2026-09-26T10:00:00.000Z';
const AFTER = '2026-09-26T11:00:00.000Z';

const expected = (over = {}) => ({
  type: 'keyboard_accessibility', selectors: ['#a', '#b', '#c'], requireNoUnintendedTrap: false, requireReachable: false, notBefore: FIX_TIME, ...over,
});

const audit = (over = {}, keyboard = {}) => taskVerificationService._resolveAfterValue({
  url: 'https://x.com/',
  keyboard_analysis: {
    keyboard_navigation_checked: true, audit_version: 2, tested_at: AFTER, focus_trap_detected: false, unreachable_elements: 0,
    traversal: { completed: true }, missing_focus_outline: 0,
    affected_elements: { missing_focus_indicator_total: 0 },
    element_results: [{ selector: '#a', status: 'present' }, { selector: '#b', status: 'present' }, { selector: '#c', status: 'present' }],
    ...keyboard,
  },
  ...over,
}, 'keyboard_accessibility');

const match = (exp, actual) => taskVerificationService._valuesMatch(exp, actual);

describe('_resolveAfterValue(keyboard_accessibility)', () => {
  test('a v2 audit yields per-selector results (compact)', () => {
    const a = audit();
    assert.equal(a.auditable, true);
    assert.equal(a.completed, true);
    assert.deepEqual(a.results, [{ selector: '#a', status: 'present' }, { selector: '#b', status: 'present' }, { selector: '#c', status: 'present' }]);
    assert.equal(a.testedAt, AFTER);
  });

  test('a counts-only (v1) audit, or no audit, is not auditable', () => {
    assert.equal(taskVerificationService._resolveAfterValue({ keyboard_analysis: { keyboard_navigation_checked: true, missing_focus_outline: 0 } }, 'keyboard_accessibility').auditable, false);
    assert.equal(taskVerificationService._resolveAfterValue({}, 'keyboard_accessibility').auditable, false);
    assert.equal(taskVerificationService._resolveAfterValue({ keyboard_analysis: { keyboard_navigation_checked: false, audit_version: 2 } }, 'keyboard_accessibility').auditable, false);
  });
});

describe('_valuesMatch(keyboard_accessibility) — re-testing the exact elements', () => {
  test('every targeted element shows a visible indicator -> fixed', () => {
    assert.equal(match(expected(), audit()), true);
  });

  test('one targeted element still has no indicator -> not fixed', () => {
    const a = audit({}, { element_results: [{ selector: '#a', status: 'present' }, { selector: '#b', status: 'missing' }, { selector: '#c', status: 'present' }], affected_elements: { missing_focus_indicator_total: 1 } });
    assert.equal(match(expected(), a), false);
  });

  test('a WEAK (low-contrast) indicator is not "distinguishable" -> not fixed', () => {
    const a = audit({}, { element_results: [{ selector: '#a', status: 'present' }, { selector: '#b', status: 'weak' }, { selector: '#c', status: 'present' }] });
    assert.equal(match(expected(), a), false);
  });

  test('an element that is no longer visible / is unknown is not confirmed', () => {
    for (const status of ['not_visible', 'unknown']) {
      const a = audit({}, { element_results: [{ selector: '#a', status: 'present' }, { selector: '#b', status }, { selector: '#c', status: 'present' }] });
      assert.equal(match(expected(), a), false, status);
    }
  });

  test('a selector the new audit does not contain: accepted ONLY if the audit completed and found no missing indicator anywhere (renamed element)', () => {
    const renamed = audit({}, { element_results: [{ selector: '#a', status: 'present' }, { selector: '#c', status: 'present' }] });
    assert.equal(match(expected(), renamed), true);

    const stillFailingElsewhere = audit({}, { element_results: [{ selector: '#a', status: 'present' }, { selector: '#c', status: 'present' }], affected_elements: { missing_focus_indicator_total: 2 } });
    assert.equal(match(expected(), stillFailingElsewhere), false);

    const incomplete = audit({}, { element_results: [{ selector: '#a', status: 'present' }, { selector: '#c', status: 'present' }], traversal: { completed: false } });
    assert.equal(match(expected(), incomplete), false, 'a truncated traversal may simply not have reached it');
  });

  test('an audit older than the fix cannot confirm it', () => {
    assert.equal(match(expected(), audit({}, { tested_at: '2026-09-26T09:00:00.000Z' })), false);
    assert.equal(match(expected(), audit({}, { tested_at: null })), false);
  });

  test('no notBefore (older attempts): freshness is not enforced', () => {
    assert.equal(match(expected({ notBefore: undefined }), audit({}, { tested_at: '2020-01-01T00:00:00Z' })), true);
  });

  test('a page that was only counted (v1) cannot verify a keyboard fix', () => {
    const a = taskVerificationService._resolveAfterValue({ keyboard_analysis: { keyboard_navigation_checked: true, missing_focus_outline: 0 } }, 'keyboard_accessibility');
    assert.equal(match(expected(), a), false);
  });

  test('a trap fix: focus must be able to leave — an unintended trap still present -> not fixed', () => {
    const exp = expected({ selectors: [], requireNoUnintendedTrap: true });
    assert.equal(match(exp, audit()), true);
    assert.equal(match(exp, audit({}, { focus_trap_detected: true })), false);
  });

  test('an INTENTIONAL modal trap is stored as focus_trap_detected:false, so it never blocks verification', () => {
    const exp = expected({ selectors: [], requireNoUnintendedTrap: true });
    assert.equal(match(exp, audit({}, { focus_trap_detected: false, trap_details: { detected: true, intentional: true } })), true);
  });

  test('unreachable elements must be reachable when the fix targeted them', () => {
    const exp = expected({ selectors: [], requireReachable: true });
    assert.equal(match(exp, audit()), true);
    assert.equal(match(exp, audit({}, { unreachable_elements: 2 })), false);
  });

  test('an expectation with nothing to check never verifies', () => {
    assert.equal(match(expected({ selectors: [] }), audit()), false);
  });

  test('missing inputs', () => {
    assert.equal(match(null, audit()), false);
    assert.equal(match(expected(), null), false);
  });
});

describe('snapshot type registration', () => {
  test('keyboard_accessibility is a known snapshot type', () => {
    assert.equal(inferSnapshotType('keyboard_accessibility'), 'keyboard_accessibility');
  });

  test('every other issue keeps its mapping', () => {
    assert.equal(inferSnapshotType('title_missing'), 'title');
    assert.equal(inferSnapshotType('faq_schema'), 'faq_schema');
    assert.equal(inferSnapshotType('tap_target_size'), null);
    assert.equal(inferSnapshotType('focus_indicators'), null);
  });
});

describe('TaskHistoryService._deriveExpectedAfterValue(keyboard_accessibility)', () => {
  const rec = (afterState) => ({ sections: { recommendedVersion: 'css', afterState } });
  const derive = (r) => taskHistoryService._deriveExpectedAfterValue(r, 'keyboard_accessibility');

  test('selectors and trap/reachability requirements are copied from the deterministic afterState', () => {
    const v = derive(rec({ type: 'keyboard_accessibility', expect: { focusIndicatorVisibleOn: ['#a', '#b'], noUnintendedFocusTrap: true, allReachableByKeyboard: false } }));
    assert.deepEqual(v, { type: 'keyboard_accessibility', selectors: ['#a', '#b'], requireNoUnintendedTrap: true, requireReachable: false });
  });

  test('a recommendation without a usable afterState (e.g. an old LLM one) yields no value-diff, falling back to presence', () => {
    assert.equal(derive(rec(null)), null);
    assert.equal(derive(rec({ type: 'something_else' })), null);
    assert.equal(derive(rec({ type: 'keyboard_accessibility', expect: {} })), null);
    assert.equal(derive({ sections: {} }), null);
  });

  test('non-string selectors are dropped, never trusted', () => {
    const v = derive(rec({ type: 'keyboard_accessibility', expect: { focusIndicatorVisibleOn: ['#ok', 5, null, '', { a: 1 }] } }));
    assert.deepEqual(v.selectors, ['#ok']);
  });
});
