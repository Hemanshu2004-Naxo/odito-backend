import crypto from 'crypto';
import { RecommendationRefusedError } from './recommendationRefusal.js';
import { AUDIT_UNAVAILABLE, findingOf } from '../../issue-context/accessibilityAudit.js';

/**
 * Deterministic recommendation for the `keyboard_accessibility` issue.
 *
 * WHY NOT A BARE PROMPT: the model used to receive one diagnostic sentence
 * ("Keyboard navigation test found 10 elements without focus indicators") and
 * nothing else, so it had no elements, no selectors and no stack — and the
 * pipeline answered "No implementation example available". The audit now records
 * the exact elements; this builds the recommendation from THAT data.
 *
 * Like faq_schema / aggregate_rating this is generated without the LLM on
 * purpose: a fix that names selectors, class names and files must contain only
 * selectors the audit actually saw. Every selector, name, background colour,
 * stylesheet and container below is copied from the audit record; the only things
 * chosen here are standards-based (a focus colour that clears 3:1 against the
 * measured backgrounds, :focus-visible, a dual ring where no single colour works).
 *
 * Thrown as AccessibilityRecommendationError when there is nothing safe to build —
 * the message says precisely what is missing (Phase 15: never a generic
 * "no example available"); nothing is stored.
 */

export class AccessibilityRecommendationError extends RecommendationRefusedError {
  constructor(code, message, statusCode = 422) {
    super(code, message, statusCode);
    this.name = 'AccessibilityRecommendationError';
  }
}

/** @throws {AccessibilityRecommendationError} */
export function assertAccessibilityAuditUsable(audit) {
  if (!audit || audit.available === false) {
    if (audit?.reason === AUDIT_UNAVAILABLE.LEGACY_AUDIT) {
      const n = audit.legacyCounts?.missingFocusOutline;
      throw new AccessibilityRecommendationError(
        'ACCESSIBILITY_AUDIT_OUTDATED',
        `This page was audited with an earlier version that only recorded counts${n != null ? ` (${n} elements)` : ''}, not WHICH elements are affected, so a specific fix cannot be written without guessing selectors. Re-run the accessibility audit for this project to capture the exact elements, then generate the recommendation again.`,
        409
      );
    }
    throw new AccessibilityRecommendationError(
      'ACCESSIBILITY_AUDIT_UNAVAILABLE',
      'No keyboard accessibility audit is stored for this page yet, so the affected elements are unknown. Run the accessibility audit, then generate the recommendation again.',
      409
    );
  }
  if (!audit.findings?.some((f) => !f.informational)) {
    throw new AccessibilityRecommendationError(
      'ACCESSIBILITY_NOTHING_TO_FIX',
      audit.intentionalTrap
        ? 'The latest audit found no keyboard failure on this page. Its focus trap is inside a visible, closable modal — an intentional trap is not an accessibility failure.'
        : 'The latest audit found no keyboard or focus failure on this page.',
      409
    );
  }
}

/** Fingerprint keyed to the exact affected elements: a re-audit that changed them never serves a stale recommendation. */
export function accessibilityFingerprint(projectId, pageUrl, audit) {
  const material = (audit.findings || [])
    .filter((f) => !f.informational)
    .map((f) => `${f.type}:${(f.elements || []).map((e) => e.selector).join(',')}:${f.verdict || ''}`)
    .join('|');
  return crypto
    .createHash('sha256')
    .update(`keyboard_accessibility|${projectId}|${pageUrl}|${audit.technology?.kind || ''}|${audit.testedAt || ''}|${material}`)
    .digest('hex');
}

// ── colour maths (WCAG relative luminance) ──────────────────────────────────

export function parseRgb(value) {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(value || '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
const luminance = ([r, g, b]) => {
  const c = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
};
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

const CANDIDATES = ['#005fcc', '#b30000', '#000000', '#ffffff', '#ffbf47'];

/**
 * A single focus colour that keeps >= 3:1 (WCAG 1.4.11 / 2.4.11) against EVERY
 * background the audit measured. When no one colour works (a page that mixes
 * light and dark areas) a dual ring — white inner + black outer — is used, which
 * stays distinguishable on any background.
 * @returns {{ mode: 'single'|'dual', color?: string, backgrounds: number }}
 */
export function pickFocusStyle(backgrounds) {
  const rgbs = [...new Set(backgrounds.filter(Boolean))].map(parseRgb).filter(Boolean);
  if (!rgbs.length) return { mode: 'single', color: '#005fcc', backgrounds: 0 };
  const ok = CANDIDATES.find((hex) => rgbs.every((bg) => contrast(hexToRgb(hex), bg) >= 3));
  return ok ? { mode: 'single', color: ok, backgrounds: rgbs.length } : { mode: 'dual', backgrounds: rgbs.length };
}

// ── helpers ─────────────────────────────────────────────────────────────────

const q = (s) => `\`${s}\``;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const uniq = (arr) => [...new Set(arr)];

function describeElement(e) {
  const label = e.accessibleName ? ` "${e.accessibleName}"` : '';
  return `${(e.tag || 'element').toUpperCase()}${label} — ${q(e.selector)}`;
}

/**
 * A long selector list (typically a CSS reset such as `a, abbr, acronym, …`) reduced to
 * its first few complete selectors. The audit stores the rule text clipped, so a
 * trailing partial selector (ending in "…") is dropped rather than shown cut mid-word.
 */
export function summarizeSelectorList(selectorText, keep = 4) {
  const parts = String(selectorText || '').split(',').map((x) => x.trim()).filter(Boolean);
  const clipped = parts.length && parts[parts.length - 1].endsWith('…');
  const complete = clipped ? parts.slice(0, -1) : parts;
  const shown = complete.slice(0, keep).join(', ');
  return complete.length > keep || clipped ? `${shown}, …` : shown;
}

function listElements(elements, limit = 8) {
  const shown = elements.slice(0, limit).map((e) => `   - ${describeElement(e)}`);
  const rest = elements.length - shown.length;
  return [...shown, ...(rest > 0 ? [`   - …and ${rest} more (the full list is shown in the issue detail)`] : [])].join('\n');
}

const TAG_SELECTORS = {
  a: 'a', button: 'button', input: 'input', select: 'select', textarea: 'textarea', summary: 'summary', area: 'area',
};

function tagSelectors(elements) {
  const out = [];
  for (const e of elements) {
    if (TAG_SELECTORS[e.tag]) out.push(TAG_SELECTORS[e.tag]);
    else if (e.role === 'button') out.push('[role="button"]');
    else if (e.tabindex != null) out.push('[tabindex]:not([tabindex="-1"])');
  }
  return uniq(out);
}

// Where the CSS goes, per detected stack. `null` location = the stack is unknown.
function cssLocation(tech) {
  switch (tech.kind) {
    case 'wordpress-divi':
      return `In WordPress, put it under Divi → Theme Options → Custom CSS${tech.theme ? `, or in the active theme's stylesheet (wp-content/themes/${tech.theme}/style.css)` : ''}. Appearance → Customize → Additional CSS also works.`;
    case 'wordpress-elementor':
      return 'In WordPress, put it under Elementor → Custom CSS (Site Settings), or Appearance → Customize → Additional CSS.';
    case 'wordpress':
      return `In WordPress, put it under Appearance → Customize → Additional CSS${tech.theme ? `, or in the active theme's stylesheet (wp-content/themes/${tech.theme}/style.css)` : ''}.`;
    case 'bootstrap':
      return 'Put it in your project\'s own stylesheet, loaded AFTER Bootstrap so it overrides the framework\'s focus styles.';
    default:
      return 'Put it in your global stylesheet (loaded after any reset or framework CSS).';
  }
}

function ringDeclarations(style, indent = '  ') {
  return style.mode === 'dual'
    ? `${indent}outline: 2px solid #ffffff;\n${indent}outline-offset: 0;\n${indent}box-shadow: 0 0 0 4px #000000; /* white + black ring: visible on light AND dark backgrounds */`
    : `${indent}outline: 3px solid ${style.color};\n${indent}outline-offset: 2px;`;
}

// ── finding: missing focus indicator ────────────────────────────────────────

function focusIndicatorParts(finding, audit) {
  const tech = audit.technology;
  const els = finding.elements;
  const total = finding.count;
  const tested = finding.testedCount;
  const style = pickFocusStyle(els.map((e) => e.computedBackground).filter(Boolean));

  // What is actually removing the focus style (from the page's own CSS), if we saw it.
  const suppress = els.map((e) => e.focusIndicator?.suppressingRule).find(Boolean);
  const suppressLine = suppress
    ? `The page's own CSS removes the outline: a rule on ${q(summarizeSelectorList(suppress.selector))} in ${suppress.stylesheet === 'inline <style>' ? 'an inline <style> block' : suppress.stylesheet} sets ${q('outline: 0')} (or ${q('none')}), and no :focus-visible rule gives these elements another indicator. Your new rule must not be overridden by it — ${q(':focus-visible')} on the element is more specific than the reset, so it wins.`
    : null;
  const noRule = els.every((e) => e.focusIndicator?.focusRuleFound === false);

  const tags = tagSelectors(els);
  const groupSel = tags.map((t) => `${t}:focus-visible`).join(',\n');
  const targetable = els.filter((e) => e.selectorUnique !== false && e.selector).slice(0, 12);
  const targetedSel = targetable.map((e) => `${e.selector}:focus-visible`).join(',\n');

  const steps = [];
  steps.push(
    `${plural(total, 'keyboard-focusable element', 'keyboard-focusable elements')}${tested ? ` (of ${tested} tested on this page)` : ''} show no visible change when they receive keyboard focus — measured by comparing each element's computed style unfocused vs focused (outline, box-shadow, border, background, colour, underline, transform).\n${listElements(els)}`
  );
  if (suppressLine) steps.push(suppressLine);
  else if (noRule) steps.push('No :focus / :focus-visible rule in the page\'s CSS targets these elements.');

  let code;
  let codeType = 'css';
  if (tech.kind === 'tailwind') {
    codeType = 'html';
    const ring = style.mode === 'dual'
      ? 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-white focus-visible:ring-4 focus-visible:ring-black'
      : `focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[${style.color}]`;
    steps.push(`This page uses Tailwind, so add the utilities to each affected element's class list (or to a shared component). Classes to add: ${q(ring)}. Do not add ${q('outline-none')} without a replacement ring.`);
    const rows = els.slice(0, 10).map((e) => `<!-- ${e.selector}${e.accessibleName ? `  ("${e.accessibleName}")` : ''} -->`).join('\n');
    code = `<!-- Add these classes to each affected element -->\n${rows}${els.length > 10 ? `\n<!-- …and ${els.length - 10} more -->` : ''}\n\nclass="… ${ring}"`;
  } else {
    steps.push(`Add the CSS below. ${cssLocation(tech)}`);
    const grouped = `/* Visible keyboard focus for ${tags.join(', ') || 'interactive elements'} (WCAG 2.4.7 Focus Visible) */\n${groupSel || 'a:focus-visible,\nbutton:focus-visible'} {\n${ringDeclarations(style)}\n}`;
    const targeted = targetable.length && els.length <= 12
      ? `\n\n/* Or, to change only the ${targetable.length} audited element${targetable.length === 1 ? '' : 's'}: */\n${targetedSel} {\n${ringDeclarations(style)}\n}`
      : '';
    code = grouped + targeted;
  }
  steps.push(
    style.mode === 'dual'
      ? 'The audited elements sit on both light and dark backgrounds, so no single colour reaches 3:1 on all of them — the style uses a white + black ring, which stays visible on any background.'
      : `The colour ${q(style.color)} keeps at least 3:1 contrast against ${style.backgrounds ? `the ${plural(style.backgrounds, 'background', 'backgrounds')} measured on these elements` : 'typical page backgrounds'} (WCAG 1.4.11 / 2.4.11) — check it against your brand palette.`
  );
  steps.push('Use :focus-visible (not :focus) so the ring shows for keyboard users without appearing on every mouse click. Never remove outlines without a replacement.');

  return { steps, code, codeType, style, tags };
}

// ── finding: focus trap ─────────────────────────────────────────────────────

function trapParts(finding) {
  const c = finding.container;
  const where = c?.selector ? q(c.selector) : 'a container the audit could not identify';
  const cycle = (finding.cycle || []).map((e) => `   - ${describeElement(e)}`).join('\n');
  const steps = [];
  const first = finding.firstElement;
  steps.push(
    `Keyboard focus is trapped ${c?.selector ? `inside ${where}` : 'on this page'}: pressing Tab keeps cycling among ${plural(finding.count, 'element', 'elements')} and never reaches the rest of the page.${cycle ? `\n${cycle}` : ''}`
  );
  if (finding.suspectedCause) steps.push(`Likely cause: ${finding.suspectedCause}.`);
  if (first?.selector) steps.push(`The traversal started at ${q(first.selector)} and had not left the loop after ${finding.focusSequence?.length || 'several'} Tab presses.`);

  let code;
  const sel = c?.selector || '.your-component';
  switch (finding.verdict) {
    case 'hidden_container_trap':
      steps.push(
        `Take the container out of the tab order while it is closed: hide it with ${q('hidden')}/${q('display:none')}/${q('visibility:hidden')} or ${q('inert')} (not only by moving it off-screen or fading it), set ${q('aria-hidden="true"')} while closed, and move focus back to the button that opened it when it closes.`,
        'Only trap focus while the dialog or drawer is actually open. Do not remove focus trapping from components that are genuine modals.'
      );
      code = `const panel = document.querySelector(${JSON.stringify(sel)});\n\nfunction closePanel(trigger) {\n  panel.hidden = true;            // removes it from layout, the tab order and the accessibility tree\n  panel.inert = true;             // belt and braces for older CSS-only hiding\n  panel.setAttribute('aria-hidden', 'true');\n  trigger.focus();                // return focus to the control that opened it\n}\n\nfunction openPanel(trigger) {\n  panel.hidden = false;\n  panel.inert = false;\n  panel.removeAttribute('aria-hidden');\n  panel.querySelector('a, button, input, [tabindex]:not([tabindex="-1"])')?.focus();\n}`;
      break;
    case 'modal_without_exit':
      steps.push(
        'This is a visible dialog, so trapping focus inside it is correct — but it has no way out. Add a visible close button, close it on Escape, and return focus to the element that opened it.',
        'Give the dialog role="dialog" (or use <dialog>), aria-modal="true" and an accessible name (aria-labelledby).'
      );
      code = `const dialog = document.querySelector(${JSON.stringify(sel)});\nconst opener = document.activeElement; // remember what opened it\n\ndialog.addEventListener('keydown', (e) => {\n  if (e.key === 'Escape') {\n    dialog.hidden = true;\n    opener.focus();               // focus returns to the trigger\n  }\n});\n\n// and add a visible control inside the dialog:\n// <button type="button" class="dialog-close" aria-label="Close dialog">×</button>`;
      break;
    default:
      steps.push(
        'Find the script that handles the Tab key (or repeatedly calls .focus()) for this component and remove it, or restrict it to the moment the component is open.',
        'A component that must trap focus (a modal) should trap only while open, close on Escape, and return focus to its trigger. Everything else must let Tab move on to the next element.'
      );
      code = `// Wrong: a Tab handler that keeps focus inside ${sel} all the time\n// document.addEventListener('keydown', (e) => { if (e.key === 'Tab') { e.preventDefault(); /* ... */ } });\n\n// Right: trap only while the dialog is open, otherwise let the browser move focus\nfunction onKeydown(e) {\n  if (e.key !== 'Tab' || dialog.hidden) return;   // not open -> do nothing\n  // ...wrap focus between the first and last focusable element INSIDE the open dialog\n}`;
  }
  return { steps, code, codeType: 'html' };
}

// ── finding: unreachable ────────────────────────────────────────────────────

function unreachableParts(finding) {
  const steps = [
    `${plural(finding.count, 'visible interactive element', 'visible interactive elements')} could not be reached with the Tab key even though the traversal completed:\n${listElements(finding.elements)}`,
    'Check for a positive tabindex on other elements (it reorders navigation), for elements that are visually shown but inside an inert/aria-hidden region, and for click handlers on non-interactive elements (use a real <button> or <a href>).',
  ];
  const first = finding.elements[0];
  const code = `/* Inspect ${first?.selector ? first.selector : 'the listed elements'}: */\n/* - remove tabindex values greater than 0 */\n/* - make click-only elements real <button>/<a href> controls */\n/* - ensure they are not inside [inert] or [aria-hidden="true"] */`;
  return { steps, code, codeType: 'css' };
}

// ── assembly ────────────────────────────────────────────────────────────────

const WCAG = {
  missing_focus_indicator: 'WCAG 2.4.7 Focus Visible (AA); WCAG 2.2 2.4.11 Focus Appearance',
  focus_trap: 'WCAG 2.1.2 No Keyboard Trap (A)',
  unreachable_elements: 'WCAG 2.1.1 Keyboard (A)',
};

/**
 * @param {object} audit a usable accessibilityAudit (see assertAccessibilityAuditUsable)
 * @returns {object} sections in the shape Recommendation.sections expects
 */
export function buildAccessibilitySections(audit) {
  const findings = audit.findings.filter((f) => !f.informational);
  const focus = findingOf(audit, 'missing_focus_indicator');
  const trap = findingOf(audit, 'focus_trap');
  const unreachable = findingOf(audit, 'unreachable_elements');

  const parts = [];
  if (trap) parts.push({ type: 'focus_trap', ...trapParts(trap) });
  if (focus) parts.push({ type: 'missing_focus_indicator', ...focusIndicatorParts(focus, audit) });
  if (unreachable) parts.push({ type: 'unreachable_elements', ...unreachableParts(unreachable) });

  // Numbered steps across all findings, each finding introduced by a heading step.
  const stepLines = [];
  for (const p of parts) {
    const heading = { focus_trap: 'Fix the focus trap', missing_focus_indicator: 'Restore visible focus indicators', unreachable_elements: 'Make the unreachable controls keyboard-operable' }[p.type];
    stepLines.push(`${heading}. ${p.steps[0]}`, ...p.steps.slice(1));
  }
  stepLines.push('Re-run the accessibility audit (or the next crawl): Odito re-tests the same elements — each must be focusable and show a visible indicator, and focus must be able to leave every component.');
  const recommendedFix = stepLines.map((s, i) => `${i + 1}. ${s}`).join('\n');

  const multiple = parts.length > 1;
  const codeBlocks = parts.map((p) => (multiple ? `${p.codeType === 'css' ? '/* ── CSS ── */' : '// ── JavaScript / HTML ──'}\n${p.code}` : p.code));
  const implementationExample = { type: multiple ? 'text' : parts[0].codeType, content: codeBlocks.join('\n\n') };

  const tech = audit.technology;
  const elementsAll = findings.flatMap((f) => f.elements || []);
  const why = uniq(findings.map((f) => f.type)).map((t) => WCAG[t]).join('; ');

  const beforeState = {
    type: 'keyboard_accessibility',
    pageUrl: audit.pageUrl,
    testedAt: audit.testedAt,
    findings: findings.map((f) => ({
      type: f.type,
      count: f.count,
      elements: (f.elements || []).map((e) => ({ selector: e.selector, tag: e.tag, accessibleName: e.accessibleName })),
    })),
  };
  const afterState = {
    type: 'keyboard_accessibility',
    expect: {
      focusIndicatorVisibleOn: (focus?.elements || []).map((e) => e.selector),
      noUnintendedFocusTrap: !!trap,
      allReachableByKeyboard: !!unreachable,
    },
  };

  return {
    whyThisMatters:
      `Keyboard-only and screen-magnifier users need to see where they are on the page and to be able to move on from any component. ` +
      `The audit found ${findings.map((f) => `${plural(f.count, 'affected element', 'affected elements')} (${f.type.replace(/_/g, ' ')})`).join(' and ')} on this page. Relevant criteria: ${why}.`,
    recommendedFix,
    implementationExample,
    expectedImpact: [
      'Keyboard users can see which control has focus on every audited element.',
      trap ? 'Focus can leave the affected component, so keyboard users are no longer stuck.' : 'Passes the WCAG focus-visible checks Odito re-tests after the next crawl.',
    ],
    difficulty: trap ? 'medium' : 'easy',
    estimatedFixTime: trap ? '30 minutes' : '10 minutes',
    recommendedVersion: implementationExample.content.split('\n\n')[0],
    beforeState,
    afterState,
    changeSummary: {
      items: findings.map((f) => ({
        field: { missing_focus_indicator: 'Focus indicator', focus_trap: 'Keyboard focus behaviour', unreachable_elements: 'Keyboard reachability' }[f.type],
        changeType: f.type === 'missing_focus_indicator' ? 'add' : 'fix',
        before: `${plural(f.count, 'element', 'elements')} affected: ${(f.elements || []).slice(0, 3).map((e) => e.selector).join(', ')}${f.count > 3 ? ', …' : ''}`,
        after: f.type === 'missing_focus_indicator' ? 'Every listed element shows a visible :focus-visible indicator' : f.type === 'focus_trap' ? 'Focus can leave the component (or it traps only while an intentional modal is open)' : 'Every listed element is reachable with Tab',
        reason: WCAG[f.type],
        priority: 'high',
      })),
    },
    sourceAttribution: {
      generatedBy: 'template',
      promptPath: 'deterministic_accessibility_audit',
      promptGroup: null,
      contextSources: {
        auditedElements: elementsAll.length,
        auditVersion: audit.auditVersion,
        technology: tech.label,
        llmUsed: false,
      },
      modelUsed: null,
      cacheStatus: 'miss',
    },
  };
}

export default { AccessibilityRecommendationError, assertAccessibilityAuditUsable, accessibilityFingerprint, buildAccessibilitySections, pickFocusStyle, summarizeSelectorList };
