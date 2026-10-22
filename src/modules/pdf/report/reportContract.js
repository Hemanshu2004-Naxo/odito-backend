/**
 * Canonical report contract (Phase 1).
 *
 * One versioned, normalized payload describing a single audit of a project.
 * Every section carries an explicit availability state so "no issues" can
 * never be confused with "the query failed" or "the module never ran".
 *
 * Section envelope:
 *   {
 *     status:  'available' | 'partial' | 'unavailable' | 'not_configured',
 *     reason:  null | string          // machine-readable, set unless fully available
 *     message: null | string          // short human-readable explanation
 *     source:  string                 // existing service / collection the data came from
 *     asOf:    null | ISO date string // when the underlying data was produced, if known
 *     timeBasis: 'audit_snapshot' | 'live_current' | 'point_in_time' | 'reporting_period'
 *     snapshotRelation: 'within_run' | 'after_run' | 'before_run' | 'not_applicable' | 'unknown'
 *     data:    object | null
 *   }
 *
 * Status semantics:
 *   available      the module produced complete data (a genuine zero is still "available")
 *   partial        some of the module's data is present, some missing/stale (see `message`)
 *   unavailable    the module should have data but it is missing, failed or never ran;
 *                  `reason` says which (query_failed, not_run, no_data, no_audit_data, ...)
 *   not_configured the customer has not enabled/connected the feature (e.g. Search Console)
 */

// 1.1.0: technical checks use the real TechnicalChecksService fields; Search Console
// fields renamed to state their aggregation; on-page topIssues gain difficulty/occurrences.
// 1.2.0: hub `details` replaced by trimmed view models (+ rule findings); accessibility titles/evidence;
// recommendations section derived from findings.
export const REPORT_SCHEMA_VERSION = '1.2.0';

export const STATUS = Object.freeze({
  AVAILABLE: 'available',
  PARTIAL: 'partial',
  UNAVAILABLE: 'unavailable',
  NOT_CONFIGURED: 'not_configured',
});

export const TIME_BASIS = Object.freeze({
  AUDIT_SNAPSHOT: 'audit_snapshot', // immutable AuditRun values
  LIVE_CURRENT: 'live_current', // current database state; not run-keyed
  POINT_IN_TIME: 'point_in_time', // own timestamp (e.g. last keyword scan)
  REPORTING_PERIOD: 'reporting_period', // external reporting window (Search Console)
});

export const SECTION_KEYS = Object.freeze([
  'executiveSummary',
  'onPageSeo',
  'technicalSeo',
  'accessibility',
  'pageSpeed',
  'keywords',
  'searchConsole',
  'aeo',
  'geo',
  'aiso',
  'progress',
  'recommendations',
]);

const toIso = (d) => {
  if (!d) return null;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
};

/**
 * Build a section envelope.
 */
export function section(status, {
  data = null,
  reason = null,
  message = null,
  source,
  asOf = null,
  timeBasis = TIME_BASIS.LIVE_CURRENT,
  snapshotRelation = 'unknown',
} = {}) {
  // A section with no data has no meaningful relation to the audit run.
  if ((status === STATUS.UNAVAILABLE || status === STATUS.NOT_CONFIGURED) && snapshotRelation === 'unknown') {
    snapshotRelation = 'not_applicable';
  }
  return {
    status,
    reason: status === STATUS.AVAILABLE ? null : reason,
    message: status === STATUS.AVAILABLE ? null : message,
    source: source || null,
    asOf: toIso(asOf),
    timeBasis,
    snapshotRelation,
    data: status === STATUS.UNAVAILABLE || status === STATUS.NOT_CONFIGURED ? null : data,
  };
}

export const unavailable = (source, reason, message, extra = {}) =>
  section(STATUS.UNAVAILABLE, { source, reason, message, ...extra });

export const notConfigured = (source, reason, message, extra = {}) =>
  section(STATUS.NOT_CONFIGURED, { source, reason, message, ...extra });

/**
 * Where does a timestamp sit relative to the selected audit run's window?
 * Used to flag live module data that is newer than the snapshot.
 */
export function relationToRun(asOf, run) {
  if (!run) return 'not_applicable';
  const t = asOf ? new Date(asOf).getTime() : NaN;
  const start = run.startedAt ? new Date(run.startedAt).getTime() : NaN;
  const end = run.completedAt ? new Date(run.completedAt).getTime() : NaN;
  if (Number.isNaN(t) || Number.isNaN(start) || Number.isNaN(end)) return 'unknown';
  if (t < start) return 'before_run';
  if (t > end) return 'after_run';
  return 'within_run';
}

/** A finite number, else null. Never coerces missing values to 0. */
export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
