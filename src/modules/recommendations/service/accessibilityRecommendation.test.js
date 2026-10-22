import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { buildAccessibilityAudit } from '../../issue-context/accessibilityAudit.js';
import {
  AccessibilityRecommendationError,
  accessibilityFingerprint,
  assertAccessibilityAuditUsable,
  buildAccessibilitySections,
  contrast,
  parseRgb,
  pickFocusStyle,
  summarizeSelectorList,
} from './accessibilityRecommendation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const naxonifyAudit = JSON.parse(fs.readFileSync(path.join(__dirname, '../../issue-context/__fixtures__/naxonify-home-keyboard-audit.json'), 'utf8'));
const PAGE = 'https://naxonify.com/';

const el = (over = {}) => ({
  tag: 'a', role: 'link', accessibleName: 'About', text: 'About', selector: '.nav a.about', selectorUnique: true, domPath: 'nav > a',
  href: '/about', classes: ['about'], tabindex: null, container: { selector: 'nav', role: 'nav' }, rect: { x: 1, y: 2, w: 30, h: 20 }, visible: true,
  focusIndicator: { status: 'missing', signals: [], before: { outline: 'none' }, after: { outline: 'none' }, focusRuleFound: false, focusRules: [], suppressingRule: null },
  computed: { effectiveBackground: 'rgb(255, 255, 255)' }, ...over,
});

const kb = (over = {}) => ({
  keyboard_navigation_checked: true, audit_version: 2, tested_at: '2026-09-26T05:00:00Z', focusable_total: 5, focusable_visible: 5, tab_stops_visited: 5,
  focus_trap_detected: false, traversal: { completed: true }, technology: {},
  affected_elements: { missing_focus_indicator: [], missing_focus_indicator_total: 0, unreachable: [], weak_focus_indicator: [] },
  trap_details: { detected: false, verdict: 'none' }, ...over,
});

const auditOf = (keyboard, extra = {}) => buildAccessibilityAudit({ pageUrl: PAGE, headlessData: { keyboard_analysis: keyboard }, ...extra });
const missingAudit = (elements, technology = {}, extra = {}) => auditOf(kb({
  technology, affected_elements: { missing_focus_indicator: elements, missing_focus_indicator_total: elements.length, unreachable: [], weak_focus_indicator: [] },
}), extra);

const allText = (s) => `${s.whyThisMatters}\n${s.recommendedFix}\n${s.implementationExample.content}\n${s.expectedImpact.join('\n')}\n${JSON.stringify(s.changeSummary)}`;

describe('the recommendation for the REAL Naxonify audit', () => {
  const audit = auditOf(naxonifyAudit, { cms: 'WordPress' });
  assertAccessibilityAuditUsable(audit);
  const s = buildAccessibilitySections(audit);
  const selectors = new Set(audit.findings[0].elements.map((e) => e.selector));

  test('names the elements it found, with counts from the audit', () => {
    assert.match(s.recommendedFix, /40 keyboard-focusable elements \(of 44 tested/);
    assert.match(s.recommendedFix, /A "Home" — `#menu-main-menu > li:nth-of-type\(1\) > a`/);
    assert.match(s.recommendedFix, /…and 32 more/);
  });

  test('identifies the real cause: the page\'s own reset rule, and readably', () => {
    assert.match(s.recommendedFix, /a rule on `a, abbr, acronym, address, …` in an inline <style> block sets `outline: 0`/);
    assert.ok(!/fieldse…/.test(s.recommendedFix), 'no selector cut mid-word');
  });

  test('is specific to WordPress + Divi: where the CSS goes, using the detected child theme', () => {
    assert.match(s.recommendedFix, /Divi → Theme Options → Custom CSS/);
    assert.match(s.recommendedFix, /wp-content\/themes\/divi-child\/style\.css/);
  });

  test('implementation is CSS with :focus-visible — never outline:none, never React code for a WordPress page', () => {
    assert.equal(s.implementationExample.type, 'css');
    const css = s.implementationExample.content;
    assert.match(css, /a:focus-visible,\nbutton:focus-visible \{/);
    assert.doesNotMatch(css, /outline:\s*(none|0)\b/);
    assert.doesNotMatch(allText(s), /useState|className=|jsx|import React|focus-visible:outline-2/);
  });

  test('the colour decision rests on the backgrounds actually measured (light + dark + blue -> a dual ring)', () => {
    assert.match(s.recommendedFix, /both light and dark backgrounds/);
    assert.match(s.implementationExample.content, /white \+ black ring/);
  });

  test('NEVER shows the "no implementation example" placeholder', () => {
    assert.doesNotMatch(allText(s), /No implementation example available/i);
    assert.ok(s.implementationExample.content.length > 40);
  });

  test('every element selector anywhere in the text came from the audit — none fabricated', () => {
    const text = allText(s);
    const cited = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((t) => /[>#]|\.|\[/.test(t) && !/^:|outline|focus-visible|hidden|display|visibility|inert|aria|tabindex|Divi|\s→/.test(t) && !/^a, abbr/.test(t));
    assert.ok(cited.length >= 8);
    for (const c of cited) assert.ok(selectors.has(c), `selector "${c}" is not in the audit`);
  });

  test('freezes the exact affected elements as before/after state for the task', () => {
    assert.equal(s.beforeState.type, 'keyboard_accessibility');
    assert.equal(s.beforeState.findings[0].elements.length, 40);
    assert.equal(s.afterState.expect.focusIndicatorVisibleOn.length, 40);
    assert.equal(s.afterState.expect.noUnintendedFocusTrap, false);
    assert.ok(s.afterState.expect.focusIndicatorVisibleOn.every((sel) => selectors.has(sel)));
  });

  test('is deterministic and says so (no LLM)', () => {
    assert.deepEqual(buildAccessibilitySections(audit), s);
    assert.equal(s.sourceAttribution.contextSources.llmUsed, false);
    assert.equal(s.sourceAttribution.promptPath, 'deterministic_accessibility_audit');
    assert.equal(s.sourceAttribution.contextSources.auditedElements, 40);
  });

  test('has every field Recommendation.sections requires', () => {
    for (const k of ['whyThisMatters', 'recommendedFix', 'implementationExample', 'expectedImpact', 'difficulty', 'estimatedFixTime', 'recommendedVersion', 'changeSummary']) {
      assert.ok(s[k] !== undefined && s[k] !== null, k);
    }
    assert.ok(['html', 'jsx', 'json', 'text', 'css'].includes(s.implementationExample.type));
    assert.ok(['easy', 'medium', 'hard'].includes(s.difficulty));
  });
});

describe('technology-specific output', () => {
  const els = [el({ selector: '#a' }), el({ selector: '#b', accessibleName: 'Blog' })];

  test('Tailwind: utilities per element, no <style>, no site-wide CSS location talk', () => {
    const s = buildAccessibilitySections(missingAudit(els, { cssFramework: 'Tailwind' }));
    assert.equal(s.implementationExample.type, 'html');
    assert.match(s.implementationExample.content, /focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-\[#005fcc\]/);
    assert.match(s.recommendedFix, /uses Tailwind/);
    assert.doesNotMatch(s.implementationExample.content, /<style>|:focus-visible \{/);
    assert.match(s.implementationExample.content, /<!-- #a/);
  });

  test('plain WordPress: Additional CSS / theme stylesheet', () => {
    const s = buildAccessibilitySections(missingAudit(els, { cms: 'WordPress', theme: 'astra' }));
    assert.match(s.recommendedFix, /Appearance → Customize → Additional CSS/);
    assert.match(s.recommendedFix, /themes\/astra\/style\.css/);
  });

  test('Elementor: Site Settings custom CSS', () => {
    const s = buildAccessibilitySections(missingAudit(els, { cms: 'WordPress', builder: 'Elementor' }));
    assert.match(s.recommendedFix, /Elementor → Custom CSS/);
  });

  test('Bootstrap: stylesheet loaded after Bootstrap', () => {
    const s = buildAccessibilitySections(missingAudit(els, { cssFramework: 'Bootstrap' }));
    assert.match(s.recommendedFix, /AFTER Bootstrap/);
  });

  test('unknown stack: standards-compliant CSS from the exact selectors, no framework code', () => {
    const s = buildAccessibilitySections(missingAudit(els));
    assert.equal(s.implementationExample.type, 'css');
    assert.match(s.recommendedFix, /global stylesheet/);
    assert.doesNotMatch(allText(s), /wp-content|Divi|Tailwind/);
  });

  test('React/Next without a CSS framework gets CSS, not component code', () => {
    const s = buildAccessibilitySections(missingAudit(els, { jsFramework: 'Next.js' }));
    assert.equal(s.implementationExample.type, 'css');
    assert.doesNotMatch(allText(s), /useState|className|jsx/);
  });
});

describe('the CSS itself', () => {
  test('only tags that actually failed are targeted', () => {
    const s = buildAccessibilitySections(missingAudit([el({ tag: 'button', role: 'button', selector: '#go' }), el({ tag: 'input', role: 'textbox', selector: '#q' })]));
    assert.match(s.implementationExample.content, /button:focus-visible,\ninput:focus-visible \{/);
    assert.doesNotMatch(s.implementationExample.content, /\na:focus-visible/);
  });

  test('a handful of elements also get a targeted variant using ONLY their real, unique selectors', () => {
    const s = buildAccessibilitySections(missingAudit([el({ selector: '#one' }), el({ selector: '#two' }), el({ selector: 'a.dup', selectorUnique: false })]));
    const css = s.implementationExample.content;
    assert.match(css, /#one:focus-visible,\n#two:focus-visible \{/);
    assert.doesNotMatch(css, /a\.dup:focus-visible/, 'a selector that matches several elements is never presented as targeting one');
  });

  test('a long list gets the grouped rule, not a wall of selectors', () => {
    const many = Array.from({ length: 30 }, (_, i) => el({ selector: `#e${i}` }));
    const css = buildAccessibilitySections(missingAudit(many)).implementationExample.content;
    assert.doesNotMatch(css, /#e0:focus-visible/);
  });

  test('never recommends removing focus styles', () => {
    for (const bg of ['rgb(255, 255, 255)', 'rgb(0, 0, 0)']) {
      const s = buildAccessibilitySections(missingAudit([el({ computed: { effectiveBackground: bg } })]));
      assert.doesNotMatch(s.implementationExample.content, /outline:\s*(none|0)\b/);
    }
  });
});

describe('focus colour selection keeps >= 3:1 on the measured backgrounds', () => {
  test('light page -> a dark single colour', () => {
    const s = pickFocusStyle(['rgb(255, 255, 255)', 'rgb(245, 245, 245)']);
    assert.equal(s.mode, 'single');
    assert.equal(s.color, '#005fcc');
  });

  test('dark page -> a light single colour that clears 3:1', () => {
    const s = pickFocusStyle(['rgb(15, 22, 40)']);
    assert.equal(s.mode, 'single');
    assert.ok(contrast([...Array(3)].map((_, i) => parseInt(s.color.slice(1 + 2 * i, 3 + 2 * i), 16)), parseRgb('rgb(15, 22, 40)')) >= 3);
  });

  test('white + black alone still has a single colour that clears 3:1 on both (the mid-tone blue)', () => {
    const s = pickFocusStyle(['rgb(255, 255, 255)', 'rgb(0, 0, 0)']);
    assert.equal(s.mode, 'single');
    assert.equal(s.color, '#005fcc');
  });

  test('white + black + a vivid blue (the measured Naxonify mix) has no single colour -> a dual ring', () => {
    assert.equal(pickFocusStyle(['rgb(255, 255, 255)', 'rgb(0, 0, 0)', 'rgb(1, 97, 244)']).mode, 'dual');
    assert.equal(pickFocusStyle(['rgb(15, 22, 40)', 'rgb(1, 97, 244)', 'rgb(255, 255, 255)']).mode, 'dual');
  });

  test('whatever is chosen really clears 3:1 against every background it was picked for', () => {
    for (const set of [['rgb(255,255,255)'], ['rgb(20,20,20)'], ['rgb(1, 97, 244)'], ['rgb(200, 200, 200)', 'rgb(30, 30, 30)']]) {
      const s = pickFocusStyle(set);
      if (s.mode === 'single') {
        const c = [1, 3, 5].map((i) => parseInt(s.color.slice(i, i + 2), 16));
        for (const bg of set) assert.ok(contrast(c, parseRgb(bg)) >= 3, `${s.color} on ${bg}`);
      }
    }
  });

  test('no measured backgrounds -> a safe default, never a crash', () => {
    assert.equal(pickFocusStyle([]).mode, 'single');
    assert.equal(pickFocusStyle([null, undefined, 'transparent']).mode, 'single');
  });
});

describe('focus traps', () => {
  const trapAudit = (trap, technology = {}) => auditOf(kb({
    technology, focus_trap_detected: true, tab_stops_visited: 12,
    trap_details: {
      detected: true, intentional: false, cycleLength: 2, trapType: 'cycle',
      firstElement: { selector: '#logo', tag: 'a' },
      cycle: [{ tag: 'a', accessibleName: 'Home', selector: '.mobile-menu a.home' }, { tag: 'a', accessibleName: 'About', selector: '.mobile-menu a.about' }],
      container: { selector: '.mobile-menu', role: 'div', visible: false },
      ...trap,
    },
    focus_sequence: [{ step: 1 }, { step: 2 }, { step: 3 }],
  }));

  test('a closed drawer still in the tab order: names the container, the cause, and the remedy — without removing all trapping', () => {
    const s = buildAccessibilitySections(trapAudit({ verdict: 'hidden_container_trap', suspectedCause: 'focus cycles inside a container that is not visible' }));
    assert.match(s.recommendedFix, /Fix the focus trap\. Keyboard focus is trapped inside `\.mobile-menu`/);
    assert.match(s.recommendedFix, /Likely cause: focus cycles inside a container that is not visible/);
    assert.match(s.recommendedFix, /hidden.*inert/);
    assert.match(s.recommendedFix, /move focus back to the button that opened it/);
    assert.match(s.recommendedFix, /Do not remove focus trapping from components that are genuine modals/);
    assert.match(s.implementationExample.content, /document\.querySelector\("\.mobile-menu"\)/);
    assert.match(s.implementationExample.content, /trigger\.focus\(\)/);
  });

  test('a visible modal with no exit: add a close button, Escape and focus return, plus dialog semantics', () => {
    const s = buildAccessibilitySections(trapAudit({ verdict: 'modal_without_exit', container: { selector: '#promo', role: 'dialog', visible: true } }));
    assert.match(s.recommendedFix, /visible dialog, so trapping focus inside it is correct — but it has no way out/);
    assert.match(s.recommendedFix, /aria-modal="true"/);
    assert.match(s.implementationExample.content, /e\.key === 'Escape'/);
    assert.match(s.implementationExample.content, /opener\.focus\(\)/);
  });

  test('scripted Tab handler in a plain container: trap only while open', () => {
    const s = buildAccessibilitySections(trapAudit({ verdict: 'unintended', trapType: 'stuck' }));
    assert.match(s.recommendedFix, /trap only while open|only while open/);
    assert.match(s.implementationExample.content, /if \(e\.key !== 'Tab' \|\| dialog\.hidden\) return/);
  });

  test('an unidentifiable container is stated as such, not invented', () => {
    const s = buildAccessibilitySections(trapAudit({ verdict: 'unintended', container: null }));
    assert.match(s.recommendedFix, /trapped on this page/);
    assert.doesNotMatch(s.recommendedFix, /inside `/);
  });
});

describe('several findings on one page', () => {
  test('numbered steps for each, and a labelled multi-part example', () => {
    const audit = auditOf(kb({
      focus_trap_detected: true,
      trap_details: { detected: true, intentional: false, verdict: 'unintended', cycleLength: 2, cycle: [{ tag: 'a', selector: '#x' }, { tag: 'a', selector: '#y' }], container: { selector: '#w', role: 'div', visible: true } },
      affected_elements: { missing_focus_indicator: [el({ selector: '#m' })], missing_focus_indicator_total: 1, unreachable: [el({ selector: '#lost' })], weak_focus_indicator: [] },
    }));
    const s = buildAccessibilitySections(audit);
    assert.match(s.recommendedFix, /1\. Fix the focus trap/);
    assert.match(s.recommendedFix, /Restore visible focus indicators/);
    assert.match(s.recommendedFix, /Make the unreachable controls keyboard-operable/);
    assert.equal(s.implementationExample.type, 'text');
    assert.match(s.implementationExample.content, /── CSS ──/);
    assert.match(s.implementationExample.content, /── JavaScript \/ HTML ──/);
    assert.equal(s.changeSummary.items.length, 3);
  });

  test('unreachable elements are named with concrete checks', () => {
    const s = buildAccessibilitySections(auditOf(kb({ affected_elements: { missing_focus_indicator: [], missing_focus_indicator_total: 0, unreachable: [el({ selector: '#lost', accessibleName: 'Lost' })], weak_focus_indicator: [] } })));
    assert.match(s.recommendedFix, /1 visible interactive element could not be reached/);
    assert.match(s.recommendedFix, /"Lost" — `#lost`/);
    assert.match(s.recommendedFix, /positive tabindex/);
  });
});

describe('refusals say precisely what is missing (never "no example available")', () => {
  const refusal = (audit) => { try { assertAccessibilityAuditUsable(audit); return null; } catch (e) { return e; } };

  test('page never audited', () => {
    const e = refusal(buildAccessibilityAudit({ pageUrl: PAGE, headlessData: null }));
    assert.ok(e instanceof AccessibilityRecommendationError);
    assert.equal(e.code, 'ACCESSIBILITY_AUDIT_UNAVAILABLE');
    assert.equal(e.statusCode, 409);
    assert.equal(e.userFacing, true);
    assert.match(e.message, /Run the accessibility audit/);
  });

  test('legacy counts-only audit: says elements are unknown and to re-run, with the old count', () => {
    const e = refusal(auditOf({ keyboard_navigation_checked: true, missing_focus_outline: 10 }));
    assert.equal(e.code, 'ACCESSIBILITY_AUDIT_OUTDATED');
    assert.match(e.message, /only recorded counts \(10 elements\)/);
    assert.match(e.message, /Re-run the accessibility audit/);
    assert.match(e.message, /without guessing selectors/);
  });

  test('nothing to fix', () => {
    assert.equal(refusal(auditOf(kb())).code, 'ACCESSIBILITY_NOTHING_TO_FIX');
  });

  test('only an intentional modal trap: explains it is not a failure', () => {
    const e = refusal(auditOf(kb({ trap_details: { detected: true, intentional: true, verdict: 'intentional_modal', container: { selector: '#dlg' } } })));
    assert.equal(e.code, 'ACCESSIBILITY_NOTHING_TO_FIX');
    assert.match(e.message, /intentional trap is not an accessibility failure/);
  });

  test('only weak (informational) indicators is nothing to fix', () => {
    const e = refusal(auditOf(kb({ affected_elements: { missing_focus_indicator: [], missing_focus_indicator_total: 0, unreachable: [], weak_focus_indicator: [el()] } })));
    assert.equal(e.code, 'ACCESSIBILITY_NOTHING_TO_FIX');
  });
});

describe('fingerprint', () => {
  const a = missingAudit([el({ selector: '#a' })]);
  test('stable for identical audits', () => assert.equal(accessibilityFingerprint('p', PAGE, a), accessibilityFingerprint('p', PAGE, missingAudit([el({ selector: '#a' })]))));
  test('changes when the affected elements change', () => assert.notEqual(accessibilityFingerprint('p', PAGE, a), accessibilityFingerprint('p', PAGE, missingAudit([el({ selector: '#b' })]))));
  test('changes with the project and page', () => {
    assert.notEqual(accessibilityFingerprint('p', PAGE, a), accessibilityFingerprint('q', PAGE, a));
    assert.notEqual(accessibilityFingerprint('p', PAGE, a), accessibilityFingerprint('p', 'https://x.com/', a));
  });
});

describe('summarizeSelectorList', () => {
  test('keeps the first complete selectors and marks the rest', () => {
    assert.equal(summarizeSelectorList('a, abbr, acronym, address, applet, b'), 'a, abbr, acronym, address, …');
  });
  test('drops a selector the audit clipped mid-word', () => {
    assert.equal(summarizeSelectorList('a, b, fieldse…'), 'a, b, …');
  });
  test('short lists are shown whole', () => assert.equal(summarizeSelectorList('a, button'), 'a, button'));
});
