/**
 * Accessibility audit context — the structured, element-level view of a page's
 * keyboard/focus audit (seo_headless_data.keyboard_analysis, audit_version 2).
 *
 * Single module for turning stored audit data into the object that the
 * AccessibilityResolver exposes as `accessibilityAudit`, that the deterministic
 * recommendation is built from, and that verification re-tests. Pure functions,
 * no I/O — everything here is JSON-serializable and unit-tested.
 *
 * Nothing here decides pass/fail (the worker already did, from computed styles
 * and a real Tab traversal) and nothing here invents data: a finding only lists
 * elements the audit actually recorded.
 */

export const AUDIT_UNAVAILABLE = Object.freeze({
  NOT_SCANNED: 'not_scanned',
  LEGACY_AUDIT: 'legacy_audit',
});

const MAX_ELEMENTS = 50;

const clip = (value, n) => {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** Compact, UI/recommendation-safe copy of one audited element. */
export function slimElement(e) {
  if (!e || typeof e !== 'object') return null;
  const fi = e.focusIndicator || {};
  const out = {
    tag: e.tag || null,
    role: e.role || null,
    accessibleName: clip(e.accessibleName, 80),
    text: clip(e.text, 80),
    selector: clip(e.selector, 300),
    selectorUnique: e.selectorUnique !== false,
    domPath: clip(e.domPath, 200),
    href: clip(e.href, 200),
    classes: Array.isArray(e.classes) ? e.classes.slice(0, 6) : [],
    tabindex: e.tabindex ?? null,
    container: e.container || null,
    rect: e.rect || null,
    // Background the element sits on (measured), so a recommended focus colour can be checked against it.
    computedBackground: e.computed?.effectiveBackground || null,
  };
  if (e.xpath) out.xpath = clip(e.xpath, 300);
  if (e.focusIndicator) {
    out.focusIndicator = {
      status: fi.status || null,
      reason: fi.reason || null,
      signals: Array.isArray(fi.signals) ? fi.signals : [],
      before: fi.before || null,
      after: fi.after || null,
      focusRuleFound: fi.focusRuleFound ?? null,
      focusRules: Array.isArray(fi.focusRules) ? fi.focusRules.slice(0, 3) : [],
      suppressingRule: fi.suppressingRule || null,
    };
  }
  return out;
}

const list = (v) => (Array.isArray(v) ? v : []);

/**
 * Merges what the audit detected in the page with what the crawler knows about it
 * into one technology profile. The audit's DOM signals (builder, theme, CSS
 * framework) win because they come from the rendered page; the crawler's
 * cms/framework fill any gap.
 *
 * `kind` is what the recommendation targets: it decides whether the fix is
 * expressed as WordPress custom CSS, Tailwind utilities, or plain CSS — never
 * component code for a stack the page does not use.
 */
export function resolveTechnology(auditTechnology, { cms = null, framework = null } = {}) {
  const t = auditTechnology && typeof auditTechnology === 'object' ? auditTechnology : {};
  const known = (v) => (v && !['unknown', 'Unknown', 'none'].includes(v) ? String(v) : null);

  const detectedCms = known(t.cms) || known(cms);
  const builder = known(t.builder);
  const cssFramework = known(t.cssFramework);
  const jsFramework = known(t.jsFramework) || (known(framework) && !/^(wordpress)$/i.test(framework) ? known(framework) : null);
  const theme = known(t.theme);

  let kind = 'plain-css';
  if (/wordpress/i.test(detectedCms || '')) {
    kind = builder === 'Divi' ? 'wordpress-divi' : builder === 'Elementor' ? 'wordpress-elementor' : 'wordpress';
  } else if (cssFramework === 'Tailwind') {
    kind = 'tailwind';
  } else if (cssFramework === 'Bootstrap') {
    kind = 'bootstrap';
  }

  const parts = [detectedCms, builder && `${builder}`, cssFramework, jsFramework].filter(Boolean);
  return {
    kind,
    cms: detectedCms,
    builder,
    theme,
    cssFramework,
    jsFramework,
    label: parts.length ? parts.join(' · ') : 'Unknown (plain HTML/CSS assumed)',
    detected: parts.length > 0,
    signals: list(t.signals).slice(0, 6),
  };
}

/**
 * @param {object} params
 * @param {string} params.pageUrl
 * @param {object|null} params.headlessData  seo_headless_data document for the page
 * @param {string|null} [params.cms]         crawler-detected CMS
 * @param {string|null} [params.framework]   crawler-detected framework
 * @returns {object} accessibilityAudit
 */
export function buildAccessibilityAudit({ pageUrl, headlessData, cms = null, framework = null }) {
  const k = headlessData?.keyboard_analysis;
  const base = { pageUrl: pageUrl || null, findings: [], intentionalTrap: null };

  if (!k || !k.keyboard_navigation_checked) {
    return { ...base, available: false, reason: AUDIT_UNAVAILABLE.NOT_SCANNED };
  }

  const version = k.audit_version || 1;
  if (version < 2) {
    return {
      ...base,
      available: false,
      reason: AUDIT_UNAVAILABLE.LEGACY_AUDIT,
      auditVersion: version,
      legacyCounts: {
        missingFocusOutline: k.missing_focus_outline ?? null,
        unreachableElements: k.unreachable_elements ?? null,
        totalTabPresses: k.total_tab_presses ?? null,
      },
    };
  }

  const affected = k.affected_elements || {};
  const trap = k.trap_details || null;
  const findings = [];

  const missingTotal = affected.missing_focus_indicator_total ?? list(affected.missing_focus_indicator).length;
  if (missingTotal > 0) {
    const elements = list(affected.missing_focus_indicator).slice(0, MAX_ELEMENTS).map(slimElement).filter(Boolean);
    findings.push({
      type: 'missing_focus_indicator',
      count: missingTotal,
      testedCount: k.tab_stops_visited ?? null,
      elements,
      listTruncated: missingTotal > elements.length,
    });
  }

  if (k.focus_trap_detected && trap?.detected && !trap.intentional) {
    findings.push({
      type: 'focus_trap',
      count: trap.cycleLength || list(trap.cycle).length || 1,
      verdict: trap.verdict || 'unintended',
      suspectedCause: trap.suspectedCause || null,
      trapType: trap.trapType || null,
      container: trap.container || null,
      firstElement: trap.firstElement || null,
      lastElement: trap.lastElement || null,
      triggeringElement: trap.triggeringElement || null,
      cycle: list(trap.cycle).slice(0, 20),
      focusSequence: list(k.focus_sequence).slice(0, 40),
      elements: list(trap.cycle).slice(0, 20),
    });
  }

  const unreachable = list(affected.unreachable);
  if (unreachable.length) {
    findings.push({
      type: 'unreachable_elements',
      count: unreachable.length,
      elements: unreachable.slice(0, MAX_ELEMENTS).map(slimElement).filter(Boolean),
    });
  }

  const weak = list(affected.weak_focus_indicator);
  if (weak.length) {
    findings.push({
      type: 'weak_focus_indicator',
      informational: true,
      count: weak.length,
      elements: weak.slice(0, MAX_ELEMENTS).map(slimElement).filter(Boolean),
    });
  }

  const intentional = trap?.detected && trap.intentional
    ? { verdict: trap.verdict, suspectedCause: trap.suspectedCause, container: trap.container }
    : null;

  return {
    available: true,
    pageUrl: pageUrl || null,
    auditVersion: version,
    auditMethod: k.audit_method || null,
    testedAt: k.tested_at ? new Date(k.tested_at).toISOString() : null,
    tested: {
      focusableTotal: k.focusable_total ?? null,
      focusableVisible: k.focusable_visible ?? null,
      tabStopsVisited: k.tab_stops_visited ?? null,
      completed: k.traversal?.completed ?? null,
      truncated: k.traversal?.truncated ?? null,
    },
    technology: resolveTechnology(k.technology, { cms, framework }),
    cssRulesUnavailable: !!k.css_rules_unavailable,
    findings,
    intentionalTrap: intentional,
  };
}

/** The finding of a given type, or null. */
export const findingOf = (audit, type) => audit?.findings?.find((f) => f.type === type) || null;

const styleLabel = (fi) => {
  if (!fi) return '—';
  const after = fi.after || {};
  const bits = [];
  bits.push(after.outline && after.outline !== 'none' ? `outline ${after.outline}` : 'outline: none');
  if (after.boxShadow && after.boxShadow !== 'none') bits.push('box-shadow');
  return fi.status === 'missing' ? 'none (no visible change on focus)' : bits.join(', ');
};

/** Table rows for the generic `currentState` view of an audit finding. */
export function findingTableRows(finding) {
  return (finding?.elements || []).map((e) => ({
    Element: `${(e.tag || '').toUpperCase()}${e.accessibleName ? ` "${e.accessibleName}"` : ''}`,
    Selector: e.selector || '—',
    Role: e.role || '—',
    'Focus style': styleLabel(e.focusIndicator),
    Container: e.container?.role || e.container?.selector || '—',
  }));
}

export default { AUDIT_UNAVAILABLE, slimElement, resolveTechnology, buildAccessibilityAudit, findingOf, findingTableRows };
