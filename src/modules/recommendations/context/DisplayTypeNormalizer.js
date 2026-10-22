/**
 * DisplayTypeNormalizer
 *
 * Extracts a normalized `currentState` and `expectedState` section from a raw
 * IssueContext based on the resolved displayType.
 *
 * Each normalizer reads the IssueContext shape produced by the BaseResolver
 * state helpers (_textState, _metricState, _tableState, etc.) and maps it to
 * the flat, prompt-friendly RecommendationContext.currentState contract.
 *
 * No AI calls.  No DB queries.  Pure transformation.
 */

import { DISPLAY_TYPE, CONTEXT_LIMITS } from './RecommendationContextSchema.js';

/**
 * Normalize a raw IssueContext into RecommendationContext currentState + expectedState.
 *
 * @param {object} issueContext   — Full IssueContext from IssueContextEngine
 * @returns {{ currentState, expectedState }}
 */
export function normalizeDisplayType(issueContext) {
  if (!issueContext) {
    return { currentState: _emptyCurrentState(), expectedState: _emptyExpectedState() };
  }

  const cs  = issueContext.currentState  || {};
  const es  = issueContext.expectedState || {};
  const dT  = (cs.displayType || '').toLowerCase();

  let currentState;

  switch (dT) {
    case DISPLAY_TYPE.TEXT:    currentState = _normalizeText(cs);    break;
    case DISPLAY_TYPE.METRIC:  currentState = _normalizeMetric(cs);  break;
    case DISPLAY_TYPE.TABLE:   currentState = _normalizeTable(cs);   break;
    case DISPLAY_TYPE.LIST:    currentState = _normalizeList(cs);    break;
    case DISPLAY_TYPE.CHAIN:
    case DISPLAY_TYPE.TREE:    currentState = _normalizeChain(cs);   break;
    case DISPLAY_TYPE.CODE:    currentState = _normalizeCode(cs);    break;
    case DISPLAY_TYPE.ABSENT:  currentState = _normalizeAbsent(cs);  break;
    default:                   currentState = _normalizeGeneric(cs); break;
  }

  // Preserve displayType so downstream consumers (BeforeAfterBuilder, ChangeSummaryBuilder)
  // can dispatch to the correct renderer path. The individual normalizer functions intentionally
  // do not set this — it is always injected here from the resolved dT.
  currentState.displayType = dT || DISPLAY_TYPE.ABSENT;

  const expectedState = _normalizeExpected(es);
  return { currentState, expectedState };
}

// ── Per-displayType normalizers ───────────────────────────────────────────────

function _normalizeText(cs) {
  const raw     = cs.rawValue ?? cs.formattedValue ?? null;
  const text    = typeof raw === 'string' ? _truncate(raw, CONTEXT_LIMITS.RAW_TEXT) : null;
  const meas    = cs.measurement || {};
  const value   = meas.value != null ? Number(meas.value) : (text ? text.length : null);
  const thresh  = meas.threshold   != null ? Number(meas.threshold)   : null;
  const maxThr  = meas.maxThreshold != null ? Number(meas.maxThreshold) : null;
  const shortfall = _computeShortfall(value, thresh, maxThr);

  const summary = _buildTextSummary(cs.label, text, value, meas.unit, thresh, maxThr, shortfall);

  return {
    summary,
    rawText:       text,
    measurement:  { value, unit: meas.unit || null, threshold: thresh, maxThreshold: maxThr, shortfall },
    tableRows:    null,
    listItems:    null,
    chainHops:    null,
    codeContent:  null,
    label:        cs.label || null,
    isAbsent:     !text,
    checkedFor:   null,
    // Pass-through for enrichment downstream
    _relatedContent: cs.relatedContent || null,
  };
}

function _normalizeMetric(cs) {
  const meas   = cs.measurement || {};
  const raw    = cs.rawValue;
  const value  = meas.value != null ? Number(meas.value) : (typeof raw === 'number' ? raw : null);
  const thresh = meas.threshold   != null ? Number(meas.threshold)   : null;
  const maxThr = meas.maxThreshold != null ? Number(meas.maxThreshold) : null;
  const shortfall = _computeShortfall(value, thresh, maxThr);

  const label  = meas.label || cs.label || null;
  const summary = value != null
    ? `Current ${label || 'measurement'}: ${value} ${meas.unit || ''}${shortfall != null ? ` (${shortfall > 0 ? shortfall + ' below target' : Math.abs(shortfall) + ' above limit'})` : ''}`
    : `${label || 'Metric'} not detected`;

  return {
    summary:     summary.trim(),
    rawText:     label || null,
    measurement: { value, unit: meas.unit || null, threshold: thresh, maxThreshold: maxThr, shortfall },
    tableRows:   null,
    listItems:   null,
    chainHops:   null,
    codeContent: null,
    label:       label,
    isAbsent:    value == null,
    checkedFor:  null,
    _relatedContent: null,
  };
}

function _normalizeTable(cs) {
  const raw    = cs.formattedValue || cs.rawValue;
  const rows   = (raw?.rows || (Array.isArray(cs.rawValue) ? cs.rawValue : null) || [])
    .slice(0, CONTEXT_LIMITS.TABLE_ROWS);
  const cols   = raw?.columns || null;
  const count  = rows.length;

  // Infer which rows are missing vs present based on status-like fields
  const missingRows  = rows.filter(r => _isMissing(r));
  const presentRows  = rows.filter(r => !_isMissing(r));

  const summary = count > 0
    ? `${presentRows.length} field${presentRows.length !== 1 ? 's' : ''} present, ${missingRows.length} missing`
    : 'No data found';

  return {
    summary,
    rawText:     null,
    measurement: { value: count, unit: 'rows', threshold: null, maxThreshold: null, shortfall: null },
    tableRows:   rows,
    listItems:   null,
    chainHops:   null,
    codeContent: null,
    label:       cols ? cols.join(' | ') : null,
    isAbsent:    count === 0,
    checkedFor:  null,
    _columns:    cols,
    _relatedContent: null,
  };
}

function _normalizeList(cs) {
  const raw   = cs.formattedValue || cs.rawValue;
  const items = (Array.isArray(raw) ? raw : [])
    .map(i => String(i))
    .slice(0, CONTEXT_LIMITS.LIST_ITEMS);
  const count = cs.measurement?.value ?? items.length;

  const contextLabel = cs.contextLabel || null;
  const summary = contextLabel
    ? `${contextLabel}: ${items.length} item${items.length !== 1 ? 's' : ''}`
    : `${items.length} item${items.length !== 1 ? 's' : ''} detected`;

  return {
    summary,
    rawText:     null,
    measurement: { value: count, unit: cs.measurement?.unit || 'items', threshold: cs.measurement?.threshold ?? null, maxThreshold: null, shortfall: null },
    tableRows:   null,
    listItems:   items,
    chainHops:   null,
    codeContent: null,
    label:       contextLabel,
    isAbsent:    items.length === 0,
    checkedFor:  null,
    // Extra fields that some list states carry (orphan_pages, topic_clusters)
    _inboundLinkCount: cs.inboundLinkCount ?? null,
    _isOrphan:         cs.isOrphan ?? false,
    _relatedContent:   null,
  };
}

function _normalizeChain(cs) {
  const raw   = cs.formattedValue || cs.rawValue;
  const hops  = (Array.isArray(raw) ? raw : [])
    .map(h => String(h))
    .slice(0, CONTEXT_LIMITS.CHAIN_HOPS);
  const meas  = cs.measurement || {};
  const depth = meas.value != null ? Number(meas.value) : hops.length - 1;
  const thresh= meas.threshold != null ? Number(meas.threshold) : null;
  const shortfall = thresh != null && depth > thresh ? depth - thresh : null;

  const summary = hops.length > 1
    ? `Path: ${hops.join(' → ')} (${depth} click${depth !== 1 ? 's' : ''} from homepage)`
    : `${depth != null ? depth : '?'} click${depth !== 1 ? 's' : ''} from homepage`;

  return {
    summary,
    rawText:     null,
    measurement: { value: depth, unit: meas.unit || 'clicks', threshold: thresh, maxThreshold: null, shortfall },
    tableRows:   null,
    listItems:   null,
    chainHops:   hops,
    codeContent: null,
    label:       null,
    isAbsent:    hops.length === 0,
    checkedFor:  null,
    _relatedContent: null,
  };
}

function _normalizeCode(cs) {
  const raw   = cs.formattedValue || cs.rawValue;
  const code  = typeof raw === 'object' ? (raw?.code || null) : (typeof raw === 'string' ? raw : null);
  const lang  = typeof raw === 'object' ? (raw?.language || 'text') : 'text';
  const snippet = code ? _truncate(code, CONTEXT_LIMITS.CODE_SNIPPET) : null;

  const summary = snippet ? `Code detected (${lang}, ${snippet.length} chars)` : 'No code detected';

  return {
    summary,
    rawText:     null,
    measurement: { value: snippet ? snippet.length : null, unit: 'chars', threshold: null, maxThreshold: null, shortfall: null },
    tableRows:   null,
    listItems:   null,
    chainHops:   null,
    codeContent: snippet,
    label:       lang,
    isAbsent:    !snippet,
    checkedFor:  null,
    _relatedContent: null,
  };
}

function _normalizeAbsent(cs) {
  const checkedFor = cs.checkedFor || null;
  const summary = checkedFor ? `${checkedFor} is absent — not found on this page` : 'Element not detected';

  return {
    summary,
    rawText:     null,
    measurement: { value: null, unit: null, threshold: null, maxThreshold: null, shortfall: null },
    tableRows:   null,
    listItems:   null,
    chainHops:   null,
    codeContent: null,
    label:       null,
    isAbsent:    true,
    checkedFor,
    _relatedContent: null,
  };
}

function _normalizeGeneric(cs) {
  const raw  = cs.rawValue ?? cs.formattedValue;
  const text = raw != null ? _truncate(String(raw), CONTEXT_LIMITS.RAW_TEXT) : null;
  return {
    summary:     text ? `Detected: ${text.slice(0, 100)}` : 'No data detected',
    rawText:     text,
    measurement: { value: null, unit: null, threshold: null, maxThreshold: null, shortfall: null },
    tableRows:   null,
    listItems:   null,
    chainHops:   null,
    codeContent: null,
    label:       null,
    isAbsent:    !text,
    checkedFor:  null,
    _relatedContent: null,
  };
}

// ── Expected state normalizer ─────────────────────────────────────────────────

function _normalizeExpected(es) {
  if (!es) return _emptyExpectedState();

  const meas   = es.measurement || {};
  const min    = meas.min  != null ? Number(meas.min)  : null;
  const max    = meas.max  != null ? Number(meas.max)  : null;
  const unit   = meas.unit || null;

  let targetRange = null;
  if (min != null && max != null) {
    targetRange = `${min}–${max} ${unit || ''}`.trim();
  } else if (min != null) {
    targetRange = `at least ${min} ${unit || ''}`.trim();
  } else if (max != null) {
    targetRange = `at most ${max} ${unit || ''}`.trim();
  }

  return {
    description:  es.description  || '',
    targetMin:    min,
    targetMax:    max,
    unit,
    targetRange,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _buildTextSummary(label, text, value, unit, thresh, maxThr, shortfall) {
  const lbl  = label || 'Content';
  if (!text && value == null) return `${lbl} not detected`;

  const lenPart = value != null ? `${value} ${unit || 'chars'}` : null;
  const valPart = lenPart ? ` (${lenPart})` : '';

  if (shortfall == null) return `Current ${lbl}: "${_preview(text, 80)}"${valPart}`;

  if (shortfall > 0) {
    return `Current ${lbl}: "${_preview(text, 80)}"${valPart} — ${shortfall} ${unit || 'chars'} below target (min ${thresh})`;
  }
  return `Current ${lbl}: "${_preview(text, 80)}"${valPart} — ${Math.abs(shortfall)} ${unit || 'chars'} over limit (max ${maxThr})`;
}

function _computeShortfall(value, thresh, maxThr) {
  if (value == null) return null;
  // Positive shortfall → below minimum; negative → above maximum
  if (thresh != null && value < thresh) return thresh - value;
  if (maxThr  != null && value > maxThr)  return maxThr - value;    // negative
  return null;
}

function _isMissing(row) {
  if (!row || typeof row !== 'object') return false;
  const status = row.status || row.Status || '';
  const value  = row.value  || row.Value  || '';
  return status === '✗' || String(value).toLowerCase() === 'missing' || String(status).toLowerCase() === 'missing';
}

function _truncate(str, max) {
  if (!str || typeof str !== 'string') return str;
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}

function _preview(text, max) {
  if (!text) return '';
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

function _emptyCurrentState() {
  return {
    summary: '', rawText: null,
    measurement: { value: null, unit: null, threshold: null, maxThreshold: null, shortfall: null },
    tableRows: null, listItems: null, chainHops: null, codeContent: null,
    label: null, isAbsent: true, checkedFor: null, _relatedContent: null,
  };
}

function _emptyExpectedState() {
  return { description: '', targetMin: null, targetMax: null, unit: null, targetRange: null };
}
