import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  AUDIT_UNAVAILABLE,
  buildAccessibilityAudit,
  findingOf,
  findingTableRows,
  resolveTechnology,
  slimElement,
} from './accessibilityAudit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// A REAL audit captured from https://naxonify.com/ by the v2 worker audit.
const naxonify = JSON.parse(fs.readFileSync(path.join(__dirname, '__fixtures__/naxonify-home-keyboard-audit.json'), 'utf8'));
const PAGE = 'https://naxonify.com/';

const el = (over = {}) => ({
  tag: 'a', role: 'link', accessibleName: 'About', text: 'About', selector: '#nav > li:nth-of-type(1) > a', selectorUnique: true,
  domPath: 'nav > ul > li > a', href: '/about', classes: ['nav-link'], tabindex: null, container: { selector: 'nav', role: 'nav' },
  rect: { x: 1, y: 2, w: 3, h: 4 }, visible: true,
  focusIndicator: { status: 'missing', reason: 'no_visual_change_on_focus', signals: [], before: { outline: 'none' }, after: { outline: 'none' }, focusRuleFound: false, focusRules: [], suppressingRule: null },
  computed: { effectiveBackground: 'rgb(255, 255, 255)' },
  ...over,
});

const v2 = (over = {}) => ({
  keyboard_navigation_checked: true, audit_version: 2, audit_method: 'x', tested_at: '2026-09-26T05:55:51.558Z',
  focusable_total: 10, focusable_visible: 8, tab_stops_visited: 8, focus_trap_detected: false,
  traversal: { completed: true, truncated: false },
  affected_elements: { missing_focus_indicator: [], missing_focus_indicator_total: 0, unreachable: [], weak_focus_indicator: [] },
  trap_details: { detected: false, intentional: false, verdict: 'none' },
  technology: {}, ...over,
});

const build = (keyboard, extra = {}) => buildAccessibilityAudit({ pageUrl: PAGE, headlessData: { keyboard_analysis: keyboard }, ...extra });

describe('buildAccessibilityAudit — the real Naxonify homepage audit', () => {
  const audit = build(naxonify, { cms: 'WordPress' });

  test('exposes the 40 exact elements, not a diagnostic sentence', () => {
    assert.equal(audit.available, true);
    const f = findingOf(audit, 'missing_focus_indicator');
    assert.equal(f.count, 40);
    assert.equal(f.elements.length, 40);
    assert.equal(f.testedCount, 44);
    assert.equal(f.listTruncated, false);
    for (const e of f.elements) {
      assert.ok(e.selector, 'every element has a selector');
      assert.equal(e.focusIndicator.status, 'missing');
    }
    assert.deepEqual(f.elements[0].accessibleName, 'Naxonify Transform Grow Lead');
  });

  test('there is NO focus-trap finding — the v1 trap was a tag+id artifact', () => {
    assert.equal(findingOf(audit, 'focus_trap'), null);
  });

  test('records how the audit ran', () => {
    assert.deepEqual(audit.tested, { focusableTotal: 79, focusableVisible: 44, tabStopsVisited: 44, completed: true, truncated: false });
    assert.equal(audit.auditVersion, 2);
    assert.ok(audit.testedAt);
  });

  test('detects WordPress + Divi with the child theme', () => {
    assert.equal(audit.technology.kind, 'wordpress-divi');
    assert.equal(audit.technology.theme, 'divi-child');
    assert.equal(audit.technology.label, 'WordPress · Divi');
  });

  test('carries the page CSS that removes the outline, per element', () => {
    const e = findingOf(audit, 'missing_focus_indicator').elements[0];
    assert.equal(e.focusIndicator.suppressingRule.stylesheet, 'inline <style>');
    assert.match(e.focusIndicator.suppressingRule.selector, /^a, abbr/);
  });

  test('is JSON-serializable and small enough to send around', () => {
    const blob = JSON.stringify(audit);
    assert.doesNotThrow(() => JSON.parse(blob));
    assert.ok(blob.length < 150_000, `audit is ${blob.length} bytes`);
    assert.ok(!/<a\s|<div/i.test(blob.replace(/inline <style>/g, '')), 'no raw HTML');
  });

  test('table rows for the generic current-state view', () => {
    const rows = findingTableRows(findingOf(audit, 'missing_focus_indicator'));
    assert.equal(rows.length, 40);
    assert.deepEqual(Object.keys(rows[0]), ['Element', 'Selector', 'Role', 'Focus style', 'Container']);
    assert.match(rows[0].Element, /^A "Naxonify Transform Grow Lead"$/);
    assert.equal(rows[0]['Focus style'], 'none (no visible change on focus)');
  });
});

describe('buildAccessibilityAudit — availability', () => {
  test('no headless data / never audited', () => {
    for (const headlessData of [null, undefined, {}, { keyboard_analysis: null }, { keyboard_analysis: { keyboard_navigation_checked: false } }]) {
      const a = buildAccessibilityAudit({ pageUrl: PAGE, headlessData });
      assert.equal(a.available, false);
      assert.equal(a.reason, AUDIT_UNAVAILABLE.NOT_SCANNED);
      assert.deepEqual(a.findings, []);
    }
  });

  test('a v1 (counts-only) audit is reported as legacy with its counters, never turned into fake elements', () => {
    const a = build({ keyboard_navigation_checked: true, focus_trap_detected: true, missing_focus_outline: 10, total_tab_presses: 10, focus_order: [{ tag: 'a', id: '', selector: 'a' }] });
    assert.equal(a.available, false);
    assert.equal(a.reason, AUDIT_UNAVAILABLE.LEGACY_AUDIT);
    assert.deepEqual(a.legacyCounts, { missingFocusOutline: 10, unreachableElements: null, totalTabPresses: 10 });
    assert.deepEqual(a.findings, []);
  });

  test('a v2 audit that found nothing has no findings', () => {
    const a = build(v2());
    assert.equal(a.available, true);
    assert.deepEqual(a.findings, []);
  });
});

describe('buildAccessibilityAudit — findings', () => {
  test('missing indicators beyond the stored list are flagged as truncated, with the true total', () => {
    const els = Array.from({ length: 50 }, (_, i) => el({ selector: `#e${i}` }));
    const a = build(v2({ affected_elements: { missing_focus_indicator: els, missing_focus_indicator_total: 133 } }));
    const f = findingOf(a, 'missing_focus_indicator');
    assert.equal(f.count, 133);
    assert.equal(f.elements.length, 50);
    assert.equal(f.listTruncated, true);
  });

  test('an UNINTENDED trap is a finding with its container, cycle and first/last elements', () => {
    const a = build(v2({
      focus_trap_detected: true,
      trap_details: {
        detected: true, intentional: false, verdict: 'hidden_container_trap', suspectedCause: 'a closed drawer is still in the tab order', trapType: 'cycle', cycleLength: 2,
        container: { selector: 'div.mobile-menu', role: 'div', visible: false },
        firstElement: { selector: '#logo', tag: 'a' }, lastElement: { selector: 'div.mobile-menu a:nth-of-type(2)', tag: 'a' },
        cycle: [{ selector: 'div.mobile-menu a:nth-of-type(1)', tag: 'a', accessibleName: 'Home' }, { selector: 'div.mobile-menu a:nth-of-type(2)', tag: 'a', accessibleName: 'About' }],
      },
      focus_sequence: [{ step: 1, from: 'document start', to: '#logo' }],
    }));
    const f = findingOf(a, 'focus_trap');
    assert.equal(f.verdict, 'hidden_container_trap');
    assert.equal(f.container.selector, 'div.mobile-menu');
    assert.equal(f.count, 2);
    assert.equal(f.cycle.length, 2);
    assert.equal(f.firstElement.selector, '#logo');
    assert.equal(f.focusSequence.length, 1);
    assert.equal(a.intentionalTrap, null);
  });

  test('an INTENTIONAL modal trap is not a finding — it is reported separately for transparency', () => {
    const a = build(v2({
      focus_trap_detected: false,
      trap_details: { detected: true, intentional: true, verdict: 'intentional_modal', suspectedCause: 'visible closable modal', container: { selector: '#dlg', role: 'dialog' } },
    }));
    assert.equal(findingOf(a, 'focus_trap'), null);
    assert.equal(a.intentionalTrap.verdict, 'intentional_modal');
    assert.equal(a.intentionalTrap.container.selector, '#dlg');
  });

  test('unreachable elements and weak indicators', () => {
    const a = build(v2({ affected_elements: { missing_focus_indicator: [], missing_focus_indicator_total: 0, unreachable: [el({ selector: '#lost' })], weak_focus_indicator: [el({ selector: '#faint' })] } }));
    assert.equal(findingOf(a, 'unreachable_elements').count, 1);
    const weak = findingOf(a, 'weak_focus_indicator');
    assert.equal(weak.informational, true);
  });
});

describe('slimElement', () => {
  test('clips long text, drops raw extras, keeps the measured background', () => {
    const s = slimElement(el({ accessibleName: 'x'.repeat(300), classes: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], html: '<div>raw</div>' }));
    assert.ok(s.accessibleName.length <= 80);
    assert.equal(s.classes.length, 6);
    assert.equal(s.html, undefined);
    assert.equal(s.computedBackground, 'rgb(255, 255, 255)');
  });

  test('a selector that is not unique says so and carries an xpath fallback', () => {
    const s = slimElement(el({ selectorUnique: false, xpath: '/html/body/a[1]' }));
    assert.equal(s.selectorUnique, false);
    assert.equal(s.xpath, '/html/body/a[1]');
  });

  test('junk input', () => {
    assert.equal(slimElement(null), null);
    assert.equal(slimElement('x'), null);
  });
});

describe('resolveTechnology — the recommendation targets the stack the page uses', () => {
  const kind = (t, c) => resolveTechnology(t, c).kind;

  test('WordPress + Divi / Elementor / plain WordPress', () => {
    assert.equal(kind({ cms: 'WordPress', builder: 'Divi' }), 'wordpress-divi');
    assert.equal(kind({ cms: 'WordPress', builder: 'Elementor' }), 'wordpress-elementor');
    assert.equal(kind({ cms: 'WordPress' }), 'wordpress');
    assert.equal(kind({}, { cms: 'WordPress' }), 'wordpress', 'the crawler CMS fills a gap the audit could not see');
  });

  test('Tailwind and Bootstrap', () => {
    assert.equal(kind({ cssFramework: 'Tailwind', jsFramework: 'Next.js' }), 'tailwind');
    assert.equal(kind({ cssFramework: 'Bootstrap' }), 'bootstrap');
  });

  test('React/Next without a CSS framework and unknown stacks are plain CSS — never component code', () => {
    assert.equal(kind({ jsFramework: 'React' }), 'plain-css');
    assert.equal(kind({ jsFramework: 'Next.js' }), 'plain-css');
    assert.equal(kind({}, { cms: 'unknown', framework: 'unknown' }), 'plain-css');
    assert.equal(resolveTechnology({}, {}).detected, false);
    assert.match(resolveTechnology({}, {}).label, /Unknown/);
  });

  test('WordPress wins over a JS framework label from the crawler', () => {
    assert.equal(resolveTechnology({ cms: 'WordPress' }, { framework: 'React' }).kind, 'wordpress');
  });
});
