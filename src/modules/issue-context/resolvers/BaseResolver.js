/**
 * BaseResolver
 *
 * Abstract base class for all context resolvers.
 * Each subclass handles a domain group of issue types.
 *
 * resolve() returns:
 *   { currentState, expectedState }
 *
 * Both shapes follow the IssueContext contract.
 */
export class BaseResolver {
  /**
   * @param {string} issueId      - issue_code or rule_id
   * @param {string} displayType  - from DISPLAY_TYPE enum
   * @param {object} extracted    - merged output from all extractors
   * @param {object} issueDoc     - raw issue document from DB (has detected_value etc.)
   * @returns {{ currentState, expectedState }}
   */
  resolve(_issueId, _displayType, _extracted, _issueDoc) {
    throw new Error(`${this.constructor.name} must implement resolve()`);
  }

  // ─── Shared helpers ────────────────────────────────────────────────────

  /** Safely get a value; return null if undefined/null */
  _safe(val) {
    return val !== undefined && val !== null ? val : null;
  }

  /** Return char length of a string, or null */
  _charLength(str) {
    return typeof str === 'string' ? str.length : null;
  }

  /** Build a standard absent currentState */
  _absentState(checkedFor) {
    return {
      displayType: 'absent',
      rawValue: null,
      formattedValue: null,
      measurement: { value: null, unit: null, threshold: null },
      affectedItems: [],
      isAbsent: true,
      checkedFor,
    };
  }

  /**
   * Build a standard text currentState.
   *
   * @param rawValue       The actual text to display (never a diagnostic message).
   * @param measurementValue The numeric measurement (char count, word count, etc.).
   * @param unit           Unit label: 'characters', 'words', etc.
   * @param minThreshold   Minimum acceptable value (triggers "too short").
   * @param maxThreshold   Maximum acceptable value (triggers "too long"). Optional.
   * @param label          Human label shown as section header: 'Meta Description', 'Title', etc.
   */
  _textState(rawValue, measurementValue, unit, minThreshold, maxThreshold = null, label = null) {
    return {
      displayType: 'text',
      rawValue: rawValue || null,
      formattedValue: rawValue || null,
      label,
      measurement: {
        value: measurementValue,
        unit: unit || null,
        threshold: minThreshold || null,
        maxThreshold: maxThreshold || null,
      },
      affectedItems: [],
      isAbsent: rawValue === null || rawValue === undefined || rawValue === '',
    };
  }

  /** Build a standard metric currentState */
  _metricState(rawValue, unit, threshold, label) {
    return {
      displayType: 'metric',
      rawValue,
      formattedValue: rawValue,
      measurement: {
        value: typeof rawValue === 'number' ? rawValue : parseFloat(rawValue) || 0,
        unit: unit || null,
        threshold: threshold || null,
        label: label || null,
      },
      affectedItems: [],
      isAbsent: rawValue === null || rawValue === undefined,
    };
  }

  /** Build a standard list currentState */
  _listState(items) {
    return {
      displayType: 'list',
      rawValue: items,
      formattedValue: items,
      measurement: { value: items.length, unit: 'items', threshold: null },
      affectedItems: items,
      isAbsent: items.length === 0,
    };
  }

  /** Build a standard table currentState */
  _tableState(columns, rows) {
    return {
      displayType: 'table',
      rawValue: rows,
      formattedValue: { columns, rows },
      measurement: { value: rows.length, unit: 'rows', threshold: null },
      affectedItems: rows,
      isAbsent: rows.length === 0,
    };
  }

  /** Build a standard code currentState */
  _codeState(code, language) {
    return {
      displayType: 'code',
      rawValue: code,
      formattedValue: { code, language: language || 'json' },
      measurement: { value: null, unit: null, threshold: null },
      affectedItems: [],
      isAbsent: !code,
    };
  }

  /** Build a chain currentState */
  _chainState(hops) {
    return {
      displayType: 'chain',
      rawValue: hops,
      formattedValue: hops,
      measurement: { value: hops.length, unit: 'hops', threshold: null },
      affectedItems: hops,
      isAbsent: hops.length === 0,
    };
  }

  /** Build a tree currentState */
  _treeState(nodes) {
    return {
      displayType: 'tree',
      rawValue: nodes,
      formattedValue: nodes,
      measurement: { value: nodes.length, unit: 'nodes', threshold: null },
      affectedItems: nodes,
      isAbsent: nodes.length === 0,
    };
  }

  /** Standard expected state */
  _expectedState(description, min, max, unit) {
    return {
      description,
      measurement: {
        min: min !== undefined ? min : null,
        max: max !== undefined ? max : null,
        unit: unit || null,
      },
    };
  }
}
