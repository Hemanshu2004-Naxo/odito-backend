import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import AccessibilityResolver, { buildFormLabelAudit } from './AccessibilityResolver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const real = JSON.parse(fs.readFileSync(path.join(__dirname, '../__fixtures__/naxonify-home-keyboard-audit.json'), 'utf8'));
// REAL axe label violations captured from naxonify.com by the worker (with node details), and the
// legacy count-only shape actually stored in the dev DB for the same pages.
const liveLabels = JSON.parse(fs.readFileSync(path.join(__dirname, '../__fixtures__/naxonify-form-label-live.json'), 'utf8'));
const storedLabels = JSON.parse(fs.readFileSync(path.join(__dirname, '../__fixtures__/naxonify-form-label-violations.json'), 'utf8'));

const resolve = (issueId, extracted, issueDoc = null) => AccessibilityResolver.resolve(issueId, 'table', extracted, issueDoc);

describe('AccessibilityResolver — keyboard_accessibility', () => {
  test('real audit: a 40-row table of the exact elements + the structured audit as contextExtras', () => {
    const r = resolve('keyboard_accessibility', { headlessData: { keyboard_analysis: real }, cms: 'WordPress', pageData: { url: 'https://naxonify.com/' } });
    assert.equal(r.currentState.displayType, 'table');
    assert.equal(r.currentState.affectedItems.length, 40);
    assert.equal(r.currentState.formattedValue.columns.length, 5);
    assert.equal(r.contextExtras.accessibilityAudit.available, true);
    assert.equal(r.contextExtras.accessibilityAudit.pageUrl, 'https://naxonify.com/');
    assert.match(r.expectedState.description, /visible focus indicator/);
  });

  test('an unintended trap is shown (as a list of the cycle), not hidden behind the focus-indicator table', () => {
    const k = {
      keyboard_navigation_checked: true, audit_version: 2, tested_at: '2026-09-26T05:00:00Z', focus_trap_detected: true, traversal: { completed: false },
      affected_elements: { missing_focus_indicator: [], missing_focus_indicator_total: 0 },
      trap_details: { detected: true, intentional: false, verdict: 'unintended', cycleLength: 2, cycle: [{ tag: 'button', accessibleName: 'One', selector: '#one' }, { tag: 'button', accessibleName: 'Two', selector: '#two' }], container: { selector: '#w' } },
    };
    const r = resolve('keyboard_accessibility', { headlessData: { keyboard_analysis: k } });
    assert.equal(r.contextExtras.accessibilityAudit.findings[0].type, 'focus_trap');
    assert.equal(r.currentState.displayType, 'table');
    assert.equal(r.currentState.affectedItems.length, 2);
  });

  test('a legacy audit falls back to the stored diagnostic value and says the audit is outdated', () => {
    const r = resolve('keyboard_accessibility', {
      headlessData: { keyboard_analysis: { keyboard_navigation_checked: true, missing_focus_outline: 10 } },
      issuesByCode: { keyboard_accessibility: { detected_value: 'Keyboard navigation test found 10 elements without focus indicators' } },
    });
    assert.equal(r.contextExtras.accessibilityAudit.available, false);
    assert.equal(r.contextExtras.accessibilityAudit.reason, 'legacy_audit');
    assert.deepEqual(r.currentState.affectedItems, ['Keyboard navigation test found 10 elements without focus indicators']);
  });

  test('no headless data at all does not throw', () => {
    const r = resolve('keyboard_accessibility', {}, null);
    assert.equal(r.contextExtras.accessibilityAudit.available, false);
    assert.equal(r.currentState.isAbsent, true);
  });

  test('a page whose only trap is intentional shows an empty state, with the intentional trap recorded', () => {
    const k = {
      keyboard_navigation_checked: true, audit_version: 2, tested_at: '2026-09-26T05:00:00Z', focus_trap_detected: false, traversal: { completed: true },
      affected_elements: { missing_focus_indicator: [], missing_focus_indicator_total: 0 },
      trap_details: { detected: true, intentional: true, verdict: 'intentional_modal', container: { selector: '#dlg' } },
    };
    const r = resolve('keyboard_accessibility', { headlessData: { keyboard_analysis: k } });
    assert.equal(r.contextExtras.accessibilityAudit.intentionalTrap.verdict, 'intentional_modal');
    assert.equal(r.currentState.isAbsent, true);
  });
});

describe('AccessibilityResolver — data the extractor fix unblocked', () => {
  test('tap_target_size reads the persisted small-target list', () => {
    const r = resolve('tap_target_size', { headlessData: { keyboard_analysis: { small_click_targets_list: [{ selector: '#x', width: 10, height: 12 }] } } });
    assert.deepEqual(r.currentState.affectedItems, [{ Element: '#x', Width: '10px', Height: '12px', Minimum: '24×24px' }]);
  });

  test('axe_violations reads axeViolations and the first stored node target', () => {
    const r = resolve('axe_violations', { headlessData: { axeViolations: [{ id: 'color-contrast', impact: 'serious', tags: ['wcag2aa'], nodes: 46, nodeDetails: [{ target: ['.btn'], html: '<a>' }] }] } });
    assert.equal(r.currentState.affectedItems[0]['Axe Rule'], 'color-contrast');
    assert.equal(r.currentState.affectedItems[0].Element, '.btn');
  });
});

describe('AccessibilityResolver — form_labels (the id the analyzer really emits)', () => {
  const home = liveLabels['https://naxonify.com/'];
  const blog = liveLabels['https://naxonify.com/blog/ai-visibility/chatgpt-seo'];
  const resolveLabels = (headlessData, extra = {}) => resolve('form_labels', { headlessData, ...extra });

  test('REAL homepage: the exact select that has no accessible name, by selector', () => {
    const r = resolveLabels({ axeViolations: home });
    assert.equal(r.currentState.displayType, 'table');
    assert.equal(r.currentState.affectedItems.length, 1);
    const row = r.currentState.affectedItems[0];
    assert.equal(row['Input Element'], '#et_pb_contact_budget_range_0');
    assert.equal(row.Type, 'select');
    assert.equal(row.Problem, 'Ensures select element has an accessible name');
    assert.equal(row['Label Status'], 'Missing');
  });

  test('REAL blog page: every input of the comment form, across several axe rules', () => {
    const r = resolveLabels({ axeViolations: blog });
    const selectors = r.currentState.affectedItems.map((x) => x['Input Element']);
    assert.ok(selectors.includes('#comment'));
    assert.ok(selectors.includes('#author'));
    assert.ok(selectors.includes('#email'));
    const comment = r.currentState.affectedItems.find((x) => x['Input Element'] === '#comment');
    assert.equal(comment.Type, 'textarea');
    const author = r.currentState.affectedItems.find((x) => x['Input Element'] === '#author');
    assert.equal(author.Type, 'input [text]');
  });

  test('the table columns exclude the html snippet, which is still carried on each row for the recommendation prompt', () => {
    const r = resolveLabels({ axeViolations: home });
    assert.deepEqual(r.currentState.formattedValue.columns, ['Input Element', 'Type', 'Problem', 'Label Status']);
    assert.match(r.currentState.affectedItems[0].HTML, /^<select id="et_pb_contact_budget_range_0"/);
    assert.ok(r.currentState.affectedItems[0].HTML.length <= 200);
  });

  test('exposes the structured audit as contextExtras', () => {
    const { contextExtras } = resolveLabels({ axeViolations: blog });
    assert.equal(contextExtras.formLabelAudit.available, true);
    assert.equal(contextExtras.formLabelAudit.detailsCaptured, true);
    assert.deepEqual(contextExtras.formLabelAudit.violations.map((v) => v.id).sort(), ['label', 'label-title-only']);
  });

  test('LEGACY data actually stored in the dev DB (counts only): honest per-violation rows, no invented inputs', () => {
    const legacy = storedLabels.home.label.map(({ hasNodeDetails, ...v }) => v);
    const r = resolveLabels({ axeViolations: legacy });
    assert.equal(r.currentState.affectedItems.length, 1);
    assert.match(r.currentState.affectedItems[0]['Input Element'], /^1 element \(exact elements not captured — re-run the accessibility audit\)$/);
    assert.equal(r.currentState.affectedItems[0].Problem, 'Ensures select element has an accessible name');
    assert.equal(r.contextExtras.formLabelAudit.detailsCaptured, false);
  });

  test('only label-family axe rules are used — a colour-contrast violation is not a form-label finding', () => {
    const r = resolveLabels({ axeViolations: [{ id: 'color-contrast', nodes: 46, nodeDetails: [{ target: ['.x'], html: '<a>' }] }, ...home] });
    assert.equal(r.currentState.affectedItems.length, 1);
  });

  test('no axe data at all falls back to the stored issue value (older behaviour), never throws', () => {
    const r = resolveLabels({}, { issuesByCode: { form_labels: { detected_value: [{ selector: '#legacy', type: 'email' }] } } });
    assert.deepEqual(r.currentState.affectedItems[0]['Input Element'], '#legacy');
    assert.equal(resolveLabels(null).currentState.isAbsent, true);
  });

  test('the old registered name is an alias and resolves identically', () => {
    assert.deepEqual(resolve('form_inputs_labels', { headlessData: { axeViolations: home } }).currentState.affectedItems,
      resolveLabels({ axeViolations: home }).currentState.affectedItems);
  });

  test('buildFormLabelAudit: html is clipped, tag and type parsed, missing target tolerated', () => {
    const a = buildFormLabelAudit({ axeViolations: [{ id: 'label', nodes: 1, nodeDetails: [{ target: [], html: `<input type="email" ${'x'.repeat(400)}>` }] }] });
    assert.equal(a.violations[0].elements[0].selector, '—');
    assert.equal(a.violations[0].elements[0].type, 'input [email]');
    assert.ok(a.violations[0].elements[0].html.length <= 200);
    assert.deepEqual(buildFormLabelAudit(null), { available: false, detailsCaptured: false, violations: [] });
  });
});
