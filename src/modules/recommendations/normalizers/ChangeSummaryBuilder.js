/**
 * ChangeSummaryBuilder
 *
 * Generates a structured ChangeSummary deterministically from
 * BeforeState and AfterState.
 *
 * DESIGN RULE — Claude does NOT generate the structured diff.
 * Claude provides recommendedVersion (the content).
 * This builder extracts the before → after comparison from the
 * BeforeState/AfterState pair, which are themselves derived
 * deterministically from the RecommendationContext and Claude's output.
 *
 * Max 6 ChangeSummaryItems.  If an issue affects more than 6 fields
 * (e.g. 14 H1 tags), extras are collapsed into a single summary item.
 *
 * ChangeSummaryItem {
 *   field:       string           — the specific element that changes
 *   changeType:  add|modify|remove|fix
 *   before:      string           — human-readable current value
 *   after:       string           — human-readable target value
 *   reason:      string           — one sentence why this change matters
 *   priority:    critical|high|medium|low
 * }
 */

const MAX_ITEMS = 6;

// Map severity → priority
const SEVERITY_PRIORITY = {
  critical: 'critical',
  high:     'high',
  medium:   'medium',
  low:      'low',
};

export class ChangeSummaryBuilder {

  /**
   * Build a ChangeSummary from BeforeState and AfterState.
   *
   * @param {object} beforeState           — from BeforeAfterBuilder
   * @param {object} afterState            — from BeforeAfterBuilder
   * @param {object} recommendationContext — for issue metadata + objective
   * @returns {{ items: object[] }}
   */
  build(beforeState, afterState, rc) {
    if (!beforeState || !afterState) return { items: [] };

    const dT       = beforeState.displayType || 'absent';
    const severity = rc?.identity?.severity || 'medium';
    const priority = SEVERITY_PRIORITY[severity] || 'medium';

    let items;

    switch (dT) {
      case 'text':    items = this._textItems(beforeState, afterState, rc, priority);    break;
      case 'metric':  items = this._metricItems(beforeState, afterState, rc, priority);  break;
      case 'table':   items = this._tableItems(beforeState, afterState, rc, priority);   break;
      case 'list':    items = this._listItems(beforeState, afterState, rc, priority);    break;
      case 'chain':
      case 'tree':    items = this._chainItems(beforeState, afterState, rc, priority);   break;
      case 'code':    items = this._codeItems(beforeState, afterState, rc, priority);    break;
      case 'absent':  items = this._absentItems(beforeState, afterState, rc, priority);  break;
      default:        items = this._genericItems(beforeState, afterState, rc, priority); break;
    }

    return { items: items.slice(0, MAX_ITEMS) };
  }

  // ── Per-displayType item builders ─────────────────────────────────────────

  _textItems(beforeState, afterState, rc, priority) {
    const label  = beforeState.label || rc?.recommendationObjective?.target || 'content';
    const bText  = beforeState.rawText;
    const aText  = afterState.rawText;
    const bMeas  = beforeState.measurement;
    const aMeas  = afterState.measurement;
    const unit   = bMeas?.unit || 'chars';

    const changeType = beforeState.isAbsent ? 'add' : 'modify';

    const before = beforeState.isAbsent
      ? '(absent — not present on page)'
      : bText
        ? `"${_preview(bText, 70)}" (${bMeas?.value} ${unit})`
        : `${bMeas?.value ?? '?'} ${unit}`;

    const after = afterState.isAbsent
      ? '(unable to generate — see implementation notes)'
      : aText
        ? `"${_preview(aText, 70)}" (${aMeas?.value} ${unit})`
        : afterState.summary || 'See recommended version';

    return [{
      field:       label,
      changeType,
      before,
      after,
      reason:      rc?.recommendationObjective?.successCriteria || rc?.expectedState?.description || '',
      priority,
    }];
  }

  _metricItems(beforeState, afterState, rc, priority) {
    const label     = beforeState.label || rc?.recommendationObjective?.target || 'metric';
    const bVal      = beforeState.measurement?.value;
    const unit      = beforeState.measurement?.unit || '';
    const threshold = rc?.expectedState?.targetRange || rc?.expectedState?.description || 'target';

    return [{
      field:       label,
      changeType:  'fix',
      before:      bVal != null ? `${bVal} ${unit}` : 'current value',
      after:       threshold,
      reason:      rc?.recommendationObjective?.successCriteria || '',
      priority,
    }];
  }

  _tableItems(beforeState, afterState, rc, priority) {
    const beforeRows = beforeState.tableRows || [];
    const afterRows  = afterState.tableRows  || [];

    // Find rows that were missing/broken in BeforeState
    const missingRows = beforeRows.filter(r => {
      const s = String(r.status || r.Status || '');
      return s === '✗' || String(r.value || r.Value || '').toLowerCase() === 'missing';
    });

    if (missingRows.length === 0) {
      // Nothing explicitly missing — generic fix item
      return [{
        field:       rc?.recommendationObjective?.target || 'configuration',
        changeType:  'fix',
        before:      beforeState.summary || 'see current state',
        after:       afterState.summary  || 'see recommended fix',
        reason:      rc?.recommendationObjective?.successCriteria || '',
        priority,
      }];
    }

    // One item per missing row (capped at MAX_ITEMS - 1 to allow a summary item)
    const itemsFromRows = missingRows.slice(0, MAX_ITEMS - 1).map(row => {
      const field     = row.field || row.Field || row.property || row.Property || 'field';
      const afterRow  = afterRows.find(r => (r.field || r.Field) === field);
      const afterVal  = afterRow?.value || afterRow?.Value || '(to be added per implementation)';
      return {
        field,
        changeType: 'add',
        before:     'Missing',
        after:      String(afterVal).toLowerCase() !== '(to be added per implementation)'
          ? `"${_preview(String(afterVal), 80)}"`
          : afterVal,
        reason:     `${field} is required for complete configuration`,
        priority,
      };
    });

    // Collapse extras
    const remaining = missingRows.length - itemsFromRows.length;
    if (remaining > 0) {
      itemsFromRows.push({
        field:       `+${remaining} more field${remaining !== 1 ? 's' : ''}`,
        changeType:  'add',
        before:      'Missing',
        after:       'See implementation notes',
        reason:      'Additional fields required for full compliance',
        priority:    'medium',
      });
    }

    return itemsFromRows;
  }

  _listItems(beforeState, afterState, rc, priority) {
    const bItems = beforeState.listItems || [];
    const label  = beforeState.label    || rc?.recommendationObjective?.target || 'items';
    const after  = afterState.summary   || 'See implementation notes';

    const changeType = beforeState.isAbsent ? 'add' : 'fix';

    if (bItems.length === 0) {
      return [{
        field:       label,
        changeType,
        before:      beforeState.isAbsent ? '(absent)' : 'No items detected',
        after,
        reason:      rc?.recommendationObjective?.successCriteria || '',
        priority,
      }];
    }

    // One item per listed entry (capped)
    const mainItems = bItems.slice(0, MAX_ITEMS - 1).map(item => ({
      field:       _preview(String(item), 80),
      changeType,
      before:      changeType === 'fix' ? `${item} (broken/redirecting)` : 'Missing',
      after:       'Fix per implementation notes',
      reason:      rc?.expectedState?.description || '',
      priority,
    }));

    const remaining = bItems.length - mainItems.length;
    if (remaining > 0) {
      mainItems.push({
        field:       `+${remaining} more item${remaining !== 1 ? 's' : ''}`,
        changeType,
        before:      'See issue details',
        after:       'See implementation notes',
        reason:      '',
        priority:    'low',
      });
    }

    return mainItems;
  }

  _chainItems(beforeState, afterState, rc, priority) {
    const bHops = beforeState.chainHops || [];
    const aHops = afterState.chainHops  || [];
    const bDepth = beforeState.measurement?.value ?? (bHops.length > 0 ? bHops.length - 1 : null);
    const threshold = rc?.currentState?.measurement?.threshold ?? 3;

    return [{
      field:       'navigation depth',
      changeType:  'fix',
      before:      bHops.length > 0
        ? `${bHops.join(' → ')} (${bDepth} click${bDepth !== 1 ? 's' : ''})`
        : `${bDepth ?? '?'} clicks from homepage`,
      after:       aHops.length > 0
        ? `${aHops.join(' → ')} (${aHops.length - 1} clicks)`
        : `Restructure to ≤${threshold} clicks`,
      reason:      rc?.recommendationObjective?.successCriteria || `Pages should be reachable in ≤${threshold} clicks from homepage`,
      priority,
    }];
  }

  _codeItems(beforeState, afterState, rc, priority) {
    const bCode = beforeState.codeContent;
    const aCode = afterState.codeContent;

    return [{
      field:       beforeState.label || rc?.recommendationObjective?.target || 'code',
      changeType:  bCode ? 'modify' : 'add',
      before:      bCode ? _preview(bCode, 100) : '(absent)',
      after:       aCode ? _preview(aCode, 100) : 'See implementation example',
      reason:      rc?.recommendationObjective?.successCriteria || '',
      priority,
    }];
  }

  _absentItems(beforeState, afterState, rc, priority) {
    const checkedFor = beforeState.rawText || beforeState.label || rc?.recommendationObjective?.target || 'element';
    const after      = afterState.rawText
      ? `"${_preview(afterState.rawText, 80)}"`
      : afterState.summary || 'See implementation notes';

    return [{
      field:       checkedFor,
      changeType:  'add',
      before:      `(absent — ${checkedFor} not present on page)`,
      after,
      reason:      rc?.recommendationObjective?.successCriteria || rc?.expectedState?.description || '',
      priority,
    }];
  }

  _genericItems(beforeState, afterState, rc, priority) {
    return [{
      field:       rc?.recommendationObjective?.target || rc?.identity?.issueId || 'issue',
      changeType:  'fix',
      before:      beforeState.summary || 'see current state',
      after:       afterState.summary  || 'see recommended fix',
      reason:      rc?.recommendationObjective?.successCriteria || '',
      priority,
    }];
  }
}

function _preview(text, max) {
  if (!text) return '';
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

export default new ChangeSummaryBuilder();
