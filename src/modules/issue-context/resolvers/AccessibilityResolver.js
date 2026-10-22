import { BaseResolver } from './BaseResolver.js';
import { buildAccessibilityAudit, findingTableRows } from '../accessibilityAudit.js';

/**
 * AccessibilityResolver
 *
 * Handles accessibility issue types sourced from seo_headless_data:
 *   contrast, form labels, keyboard, focus, tap targets, axe violations,
 *   page language, video captions.
 */
export class AccessibilityResolver extends BaseResolver {
  resolve(issueId, _displayType, extracted, _issueDoc) {
    const { pageData, issuesByCode, headlessData } = extracted;
    const onPageIssue = issuesByCode?.[issueId];
    const detectedFromDoc = onPageIssue?.detected_value ?? null;

    switch (issueId) {

      case 'form_labels':
      case 'form_inputs_labels': {
        // The label violations axe-core stored for THIS page (a page can have several: label,
        // select-name, aria-input-field-name...). The single issue document only carries one of
        // them, so the headless audit is the source of truth.
        const audit = buildFormLabelAudit(headlessData);
        if (audit.violations.length) {
          const rows = audit.violations.flatMap((v) => {
            if (v.elements.length) {
              return v.elements.map((e) => ({
                'Input Element': e.selector,
                Type: e.type,
                Problem: v.description,
                'Label Status': 'Missing',
                // Not a table column: a clipped snippet the recommendation prompt can use.
                HTML: e.html,
              }));
            }
            // Older scans stored only a count, not the nodes. Say so rather than invent rows.
            return [{
              'Input Element': `${v.nodes} element${v.nodes === 1 ? '' : 's'} (exact elements not captured — re-run the accessibility audit)`,
              Type: '—',
              Problem: v.description,
              'Label Status': 'Missing',
            }];
          });
          return {
            currentState: this._tableState(['Input Element', 'Type', 'Problem', 'Label Status'], rows),
            expectedState: this._expectedState('Every form input has an associated <label>, aria-label or aria-labelledby'),
            contextExtras: { formLabelAudit: audit },
          };
        }
        const inputs = headlessData?.unlabeled_inputs || _parseArray(detectedFromDoc);
        const rows = inputs.map((i) => ({
          'Input Element': i.selector || i.element || String(i),
          Type: i.type || 'input',
          Problem: '—',
          'Label Status': 'Missing',
        }));
        return {
          currentState: this._tableState(['Input Element', 'Type', 'Problem', 'Label Status'], rows),
          expectedState: this._expectedState('Every form input has an associated <label> element'),
        };
      }

      case 'keyboard_accessibility': {
        // The audit (not the single issue document) is the source of truth: one page can
        // have several keyboard findings under this one issue code, and only the audit
        // knows WHICH elements are affected.
        const audit = buildAccessibilityAudit({
          pageUrl: extracted.pageData?.url || onPageIssue?.page_url || null,
          headlessData,
          cms: extracted.cms,
          framework: extracted.framework,
        });

        if (audit.available && audit.findings.some((f) => !f.informational)) {
          const primary = audit.findings.find((f) => f.type === 'missing_focus_indicator')
            || audit.findings.find((f) => !f.informational);
          const rows = findingTableRows(primary);
          return {
            currentState: this._tableState(['Element', 'Selector', 'Role', 'Focus style', 'Container'], rows),
            expectedState: this._expectedState('Every interactive element shows a visible focus indicator (:focus-visible) and focus can always leave a component'),
            contextExtras: { accessibilityAudit: audit },
          };
        }

        // Audit present but nothing failing (fixed / intentional trap only), or the page was
        // not audited at v2 yet: say exactly that instead of showing a diagnostic sentence.
        const legacy = _parseArray(detectedFromDoc);
        return {
          currentState: this._listState(audit.available ? [] : legacy),
          expectedState: this._expectedState('All interactive elements reachable via keyboard Tab key'),
          contextExtras: { accessibilityAudit: audit },
        };
      }

      case 'focus_indicators': {
        const missing = headlessData?.missing_focus_indicators || _parseArray(detectedFromDoc);
        const items = missing.map(m => m.selector || m.element || String(m));
        return {
          currentState: this._listState(items),
          expectedState: this._expectedState('Visible CSS :focus styles on all interactive elements'),
        };
      }

      case 'tap_target_size': {
        const small = headlessData?.keyboard_analysis?.small_click_targets_list || headlessData?.small_tap_targets || _parseArray(detectedFromDoc);
        const rows = small.map(t => ({
          'Element': t.selector || t.element || String(t),
          'Width':   t.width ? `${t.width}px` : '—',
          'Height':  t.height ? `${t.height}px` : '—',
          'Minimum': '24×24px',
        }));
        return {
          currentState: this._tableState(
            ['Element', 'Width', 'Height', 'Minimum'],
            rows
          ),
          expectedState: this._expectedState('All interactive elements at least 24×24px touch target'),
        };
      }

      case 'axe_violations': {
        const violations = headlessData?.axeViolations || headlessData?.axe_violations || _parseArray(detectedFromDoc);
        const rows = violations.slice(0, 20).map(v => ({
          'Axe Rule': v.id || v.rule || String(v),
          'Impact':   v.impact || '—',
          'Element':  _firstNodeSelector(v),
          'WCAG':     v.tags?.find(t => t.startsWith('wcag')) || '—',
        }));
        return {
          currentState: this._tableState(
            ['Axe Rule', 'Impact', 'Element', 'WCAG'],
            rows
          ),
          expectedState: this._expectedState('Zero axe-core accessibility violations'),
        };
      }

      case 'page_language': {
        const detected = detectedFromDoc || pageData?.language || null;
        if (detected) {
          return {
            currentState: this._textState(String(detected), null, null, null),
            expectedState: this._expectedState('html lang attribute set to the correct language code (e.g., "en")'),
          };
        }
        return {
          currentState: this._absentState('lang attribute on <html>'),
          expectedState: this._expectedState('html lang="en" (or correct language code)'),
        };
      }

      case 'video_captions': {
        const videos = headlessData?.video_elements || pageData?.videos || _parseArray(detectedFromDoc);
        const items = videos.map(v => v.src || v.url || String(v));
        return {
          currentState: this._listState(items),
          expectedState: this._expectedState('All <video> elements have a <track> element with captions'),
        };
      }

      default: {
        return {
          currentState: this._listState(_parseArray(detectedFromDoc)),
          expectedState: this._expectedState('See issue description'),
        };
      }
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _parseArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return [val];
}

const LABEL_AXE_IDS = new Set(['label', 'label-title-only', 'label-content-name-mismatch', 'form-field-multiple-labels', 'aria-input-field-name', 'select-name']);

/**
 * Structured form-label findings from the axe violations stored on the headless document —
 * the same rule ids FormLabelsRule (Python) reports on. Elements come from axe's stored
 * nodeDetails (target selector + a clipped html snippet); scans made before those were
 * persisted have only a node count, and are reported as such.
 */
export function buildFormLabelAudit(headlessData) {
  const violations = (headlessData?.axeViolations || [])
    .filter((v) => LABEL_AXE_IDS.has(v.id))
    .map((v) => ({
      id: v.id,
      impact: v.impact || null,
      description: v.description || v.id,
      helpUrl: v.helpUrl || null,
      nodes: v.nodes ?? (v.nodeDetails || []).length,
      elements: (v.nodeDetails || []).map((n) => {
        const html = String(n.html || '');
        const tag = /^<\s*([a-z0-9-]+)/i.exec(html)?.[1]?.toLowerCase() || 'input';
        const type = /\btype=["']([^"']+)["']/i.exec(html)?.[1];
        return {
          selector: (n.target || []).join(' ') || '—',
          tag,
          type: type ? `${tag} [${type}]` : tag,
          html: html.slice(0, 200),
        };
      }),
    }));
  return {
    available: violations.length > 0,
    detailsCaptured: violations.some((v) => v.elements.length > 0),
    violations,
  };
}

function _firstNodeSelector(violation) {
  const nodes = violation.nodeDetails || violation.nodes || violation.elements || [];
  if (nodes.length === 0) return '—';
  const first = nodes[0];
  if (typeof first === 'number') return '—';
  return first.target?.[0] || first.selector || String(first);
}

export default new AccessibilityResolver();
