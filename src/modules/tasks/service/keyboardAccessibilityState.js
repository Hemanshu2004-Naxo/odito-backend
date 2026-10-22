/**
 * The frozen, element-level before/after state of a keyboard_accessibility fix.
 *
 * Kept in one light, dependency-free module because three places must agree on it:
 * the deterministic recommendation (which writes `afterState`), TaskHistoryService (which
 * freezes it onto a fix attempt) and TaskVerificationService (which re-tests it).
 */

/**
 * The verification expectation for a fix, derived from a recommendation's / task's
 * `afterState`. Selectors are the audited elements that must show a visible focus
 * indicator; the flags say whether a trap / unreachable elements must be gone.
 * Returns null when there is nothing checkable (so verification falls back to presence).
 */
export function expectedAfterFromAfterState(afterState) {
  if (afterState?.type !== 'keyboard_accessibility') return null;
  const expect = afterState.expect || {};
  const selectors = (Array.isArray(expect.focusIndicatorVisibleOn) ? expect.focusIndicatorVisibleOn : [])
    .filter((sel) => typeof sel === 'string' && sel);
  if (!selectors.length && !expect.noUnintendedFocusTrap && !expect.allReachableByKeyboard) return null;
  return {
    type: 'keyboard_accessibility',
    selectors,
    requireNoUnintendedTrap: !!expect.noUnintendedFocusTrap,
    requireReachable: !!expect.allReachableByKeyboard,
  };
}

export default { expectedAfterFromAfterState };
