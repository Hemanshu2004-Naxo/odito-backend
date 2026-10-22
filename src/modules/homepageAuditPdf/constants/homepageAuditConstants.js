// Homepage Audit — shared scoring/severity/CWV constants.
// Canonical source of truth for: scoreBands, severityMap, cwvThresholds.
//
// This file is intentionally mirrored in three places (this repo has no
// shared npm workspace across its independent packages):
//   - frontend/lib/homepageAudit/constants.js
//   - video/shared/homepageAuditConstants.js
//   - odito_backend/src/modules/homepageAuditPdf/constants/homepageAuditConstants.js (this file)
// Keep all three byte-identical when changing values.
//
// scoreBands were reconciled 2026-07 to match the backend's canonical grade
// formula (python_workers/scraper/workers/homepage_audit/mapper.py:
// A >= 85, B >= 70, C >= 50, else F). Some dashboard components previously
// used their own thresholds (e.g. 90/75/60 A-D); those are now derived from
// this single source instead.

// ---------------------------------------------------------------------------
// scoreBands — canonical 0-100 score -> letter grade / tier / label
// ---------------------------------------------------------------------------
export const SCORE_BANDS = [
  { min: 85, grade: "A", tier: "excellent", label: "Excellent" },
  { min: 70, grade: "B", tier: "good", label: "Good" },
  { min: 50, grade: "C", tier: "needs-improvement", label: "Needs Improvement" },
  { min: 0, grade: "F", tier: "poor", label: "Needs Work" },
];

export function getScoreBand(score) {
  const s = typeof score === "number" && !Number.isNaN(score) ? score : 0;
  return SCORE_BANDS.find((b) => s >= b.min) || SCORE_BANDS[SCORE_BANDS.length - 1];
}

export function getGrade(score) {
  return getScoreBand(score).grade;
}

export function getScoreLabel(score) {
  return getScoreBand(score).label;
}

export function getScoreTier(score) {
  return getScoreBand(score).tier;
}

// Text color for grade-colored headings/labels (hex), keyed by letter grade.
export const GRADE_TEXT_COLOR = { A: "#059669", B: "#2563eb", C: "#d97706", F: "#dc2626" };

// Ring/accent color for grade-colored rings/badges (hex), keyed by letter grade.
export const GRADE_RING_COLOR = { A: "#1d4ed8", B: "#2563eb", C: "#7c3aed", F: "#dc2626" };

// ---------------------------------------------------------------------------
// severityMap — canonical critical/high/medium/low -> color/badge/impact
// ---------------------------------------------------------------------------
export const SEVERITY_COLOR_HEX = {
  critical: "#ef4444",
  high: "#ef4444",
  medium: "#f59e0b",
  low: "#22c55e",
};

// Dashboard (Tailwind) 3-tier vocabulary: Critical / Warning / Optimized
export const SEVERITY_DASHBOARD_BADGE = {
  critical: { color: "red", text: "Critical" },
  high: { color: "red", text: "Critical" },
  medium: { color: "yellow", text: "Warning" },
  low: { color: "green", text: "Optimized" },
};

// Video 4-tier vocabulary: Critical / High / Medium / Low
export const SEVERITY_VIDEO_BADGE = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
export const SEVERITY_VIDEO_IMPACT = {
  critical: "High Impact",
  high: "High Impact",
  medium: "Medium Impact",
  low: "Low Impact",
};

export function getSeverityColorHex(severity) {
  return SEVERITY_COLOR_HEX[severity] || SEVERITY_COLOR_HEX.medium;
}

export function getSeverityDashboardBadge(severity) {
  return SEVERITY_DASHBOARD_BADGE[severity] || SEVERITY_DASHBOARD_BADGE.medium;
}

export function getSeverityVideoBadge(severity) {
  return SEVERITY_VIDEO_BADGE[severity] || SEVERITY_VIDEO_BADGE.medium;
}

export function getSeverityVideoImpact(severity) {
  return SEVERITY_VIDEO_IMPACT[severity] || SEVERITY_VIDEO_IMPACT.medium;
}

// ---------------------------------------------------------------------------
// cwvThresholds — canonical Core Web Vitals rating bands.
// All values in milliseconds except `cls`, which is unitless.
// ---------------------------------------------------------------------------
export const CWV_THRESHOLDS_MS = {
  fcp: { good: 1800, needsImprovement: 3000 },
  lcp: { good: 2500, needsImprovement: 4000 },
  cls: { good: 0.1, needsImprovement: 0.25 },
  tbt: { good: 200, needsImprovement: 600 },
  inp: { good: 200, needsImprovement: 500 },
  speedIndex: { good: 3400, needsImprovement: 5800 },
};

// Returns 'good' | 'needs-improvement' | 'poor' | null
export function rateCwvMetric(metric, value) {
  const thresholds = CWV_THRESHOLDS_MS[metric];
  if (!thresholds || value === null || value === undefined || Number.isNaN(value)) return null;
  if (value <= thresholds.good) return "good";
  if (value <= thresholds.needsImprovement) return "needs-improvement";
  return "poor";
}

// Dashboard 3-tier vocabulary mapping for a CWV rating: pass / warning / fail
export function cwvRatingToDashboardStatus(rating) {
  if (rating === "good") return "pass";
  if (rating === "needs-improvement") return "warning";
  if (rating === "poor") return "fail";
  return "info";
}

// Dashboard Tailwind text-color class for a CWV rating.
export function cwvRatingToTailwindClass(rating) {
  if (rating === "good") return "text-green-400";
  if (rating === "needs-improvement") return "text-yellow-400";
  if (rating === "poor") return "text-red-400";
  return "text-slate-400";
}

// Parses a metric string like "1.2s", "850ms", "0.05" into a millisecond
// number (cls stays unitless/as-is). Returns null if unparseable.
export function parseCwvValueToMs(metric, raw) {
  if (raw === null || raw === undefined || raw === "" || raw === "N/A") return null;
  const str = String(raw).trim();
  if (metric === "cls") {
    const n = parseFloat(str);
    return Number.isNaN(n) ? null : n;
  }
  if (str.endsWith("ms")) {
    const n = parseFloat(str);
    return Number.isNaN(n) ? null : n;
  }
  if (str.endsWith("s")) {
    const n = parseFloat(str);
    return Number.isNaN(n) ? null : n * 1000;
  }
  const n = parseFloat(str);
  return Number.isNaN(n) ? null : n;
}
