/**
 * Pure delta calculation between a PageVerificationRun's before/after
 * metric snapshots. No I/O, no side effects — owned by the Verification
 * module, separate from AuditComparisonService (untouched, not called).
 */

function round2(value) {
  return Math.round(value * 100) / 100;
}

// Score fields: null if either side is missing (can't diff an unknown
// value) — preserves null semantics rather than treating missing as 0.
function scoreChange(before, after, key) {
  const b = before?.[key];
  const a = after?.[key];
  if (typeof b !== 'number' || typeof a !== 'number') {
    return null;
  }
  return round2(a - b);
}

// Per-severity-bucket fixed/introduced/unchanged, so a severity shift
// (e.g. 5 warnings becoming 5 criticals) is visible as both issuesFixed
// and issuesIntroduced, not silently net to zero.
function severityDelta(before, after, key) {
  const b = before?.[key] ?? 0;
  const a = after?.[key] ?? 0;
  return {
    fixed: Math.max(0, b - a),
    introduced: Math.max(0, a - b),
    unchanged: Math.min(b, a),
  };
}

export function computeVerificationDelta(before = {}, after = {}) {
  const critical = severityDelta(before, after, 'criticalIssues');
  const warning = severityDelta(before, after, 'warningIssues');
  const info = severityDelta(before, after, 'infoIssues');

  return {
    pageScoreChange: scoreChange(before, after, 'pageScore'),
    aisoScoreChange: scoreChange(before, after, 'aisoScore'),
    aeoScoreChange: scoreChange(before, after, 'aeoScore'),
    geoScoreChange: scoreChange(before, after, 'geoScore'),
    issuesFixed: critical.fixed + warning.fixed + info.fixed,
    issuesIntroduced: critical.introduced + warning.introduced + info.introduced,
    issuesUnchanged: critical.unchanged + warning.unchanged + info.unchanged,
  };
}

export default computeVerificationDelta;
