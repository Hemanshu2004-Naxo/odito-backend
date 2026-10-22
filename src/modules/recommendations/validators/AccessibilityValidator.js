/**
 * AccessibilityValidator — GROUP 5 (Accessibility)
 *
 * Validates recommendations for accessibility issues:
 *   text contrast, form labels, keyboard navigation, focus indicators,
 *   video captions, tap targets, ARIA violations, image alt text.
 *
 * Key rules:
 *   - Alt text: non-empty, under 125 chars, not filename-only
 *   - ARIA attributes: use valid ARIA role/property names
 *   - Code fixes: must be copy-paste ready HTML/JSX
 *   - No placeholder text in fixes
 */

import { BaseValidator } from './BaseValidator.js';

// Issues where alt text is the primary concern
const ALT_TEXT_ISSUES = new Set(['images_missing_alt_text', 'broken_images']);

// Max recommended alt text length (WCAG best practice)
const ALT_TEXT_MAX = 125;

// Patterns that indicate a filename being used as alt text
const FILENAME_ALT_RE = /\.(jpe?g|png|gif|svg|webp|avif|bmp)["'\s]/i;

// Known valid ARIA role names (partial list of most common)
const VALID_ARIA_ROLES = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'button',
  'cell', 'checkbox', 'columnheader', 'combobox', 'complementary',
  'contentinfo', 'definition', 'dialog', 'directory', 'document',
  'feed', 'figure', 'form', 'grid', 'gridcell', 'group', 'heading',
  'img', 'link', 'list', 'listbox', 'listitem', 'log', 'main',
  'marquee', 'math', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'navigation', 'none', 'note', 'option', 'presentation',
  'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup',
  'rowheader', 'scrollbar', 'search', 'searchbox', 'separator',
  'slider', 'spinbutton', 'status', 'switch', 'tab', 'table',
  'tablist', 'tabpanel', 'term', 'textbox', 'timer', 'toolbar',
  'tooltip', 'tree', 'treegrid', 'treeitem',
]);

export class AccessibilityValidator extends BaseValidator {

  validate(sections, rc) {
    const errors   = [];
    const warnings = [];

    this._validateCoreSections(sections, errors);
    this._checkNoPlaceholders(sections, errors);

    const issueId  = rc?.identity?.issueId || '';
    const recommended = sections.recommendedVersion || '';
    const implCode    = sections.implementationExample?.content || '';

    let satisfiesConstraint = true;

    // ── Alt text validation ───────────────────────────────────────────────
    if (ALT_TEXT_ISSUES.has(issueId)) {
      if (!recommended && !implCode) {
        warnings.push('Alt text: no recommended alt text provided');
        satisfiesConstraint = false;
      } else {
        const altContent = recommended || implCode;

        if (altContent.length > ALT_TEXT_MAX) {
          warnings.push(`Alt text may be too long (${altContent.length} chars, max ${ALT_TEXT_MAX})`);
        }

        if (FILENAME_ALT_RE.test(altContent)) {
          warnings.push('Alt text appears to contain a filename — use descriptive text instead');
        }

        // Check for alt="" (empty alt) being used — valid for decorative images
        // but Claude should not recommend it for content images
        if (/alt=""/.test(altContent) || /alt=''/.test(altContent)) {
          warnings.push('Alt text is empty (alt="") — only valid for decorative images; verify intent');
        }
      }
    }

    // ── ARIA role validation ──────────────────────────────────────────────
    if (issueId === 'axe_violations' || issueId === 'keyboard_accessibility') {
      const ariaRoleMatches = (recommended + implCode).match(/role="([^"]+)"/gi) || [];
      for (const match of ariaRoleMatches) {
        const role = match.replace(/role="/i, '').replace('"', '');
        if (role && !VALID_ARIA_ROLES.has(role.toLowerCase())) {
          warnings.push(`Potentially invalid ARIA role: "${role}" — verify against ARIA spec`);
        }
      }
    }

    // ── form_labels (alias form_inputs_labels): must reference for= or aria-labelledby ────────
    if (issueId === 'form_labels' || issueId === 'form_inputs_labels') {
      if (implCode && !implCode.includes('for=') && !implCode.includes('aria-labelledby') && !implCode.includes('aria-label')) {
        warnings.push('Form label fix should use for=, aria-labelledby, or aria-label');
      }
    }

    // ── Generic: non-empty and non-placeholder satisfies ─────────────────
    if (!ALT_TEXT_ISSUES.has(issueId)) {
      satisfiesConstraint = this._absentSatisfiesConstraint(sections) || Boolean(implCode);
      if (!satisfiesConstraint) {
        warnings.push(`${issueId}: no actionable fix produced`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      satisfiesConstraint,
    };
  }
}

export default new AccessibilityValidator();
