// Homepage Audit PDF — data mapper.
//
// Pure function: HomepageAudit document -> normalized PDF data contract.
// No rendering logic, no Puppeteer, no HTTP/route concerns. This is the
// single place that decides what a "Homepage Audit PDF" is made of, so the
// eventual renderer (frontend/pdf-homepage/, Phase 4) never has to inspect
// raw snapshot fields — it only ever reads the shape documented below.
//
// CRITICAL: snapshot.score, HomepageAudit.score and snapshot.grade are never
// read here. They are known to go stale after async PATCH operations (see
// the Homepage Audit PDF verification audit, 2026-07) — PATCH merges
// sub-objects (performance, accessibility) without recomputing the overall
// score/grade. Overall score/grade are always recomputed from the CURRENT
// per-category scores instead (see _computeOverallScore below).

import {
  getGrade,
  rateCwvMetric,
  parseCwvValueToMs,
} from '../constants/homepageAuditConstants.js';

// Weights for the recomputed overall score. Matches the same formula Python
// uses at audit-creation time (python_workers/scraper/workers/homepage_audit/
// mapper.py) — security and accessibility are intentionally excluded, same
// as the backend's own weighting.
const OVERALL_WEIGHTS = {
  onPage: 0.4,
  technical: 0.2,
  ai: 0.2,
  performance: 0.2,
};

/**
 * @param {object} homepageAuditDoc - A HomepageAudit mongoose document or
 *   plain object: { _id, url, snapshot, score, user_id, video, created_at }.
 * @returns {object} Normalized PDF data contract (see module doc above).
 */
function mapHomepageAuditToPdfData(homepageAuditDoc) {
  if (!homepageAuditDoc) {
    throw new Error('homepageAuditPdfMapper: homepageAuditDoc is required');
  }

  const doc = typeof homepageAuditDoc.toObject === 'function'
    ? homepageAuditDoc.toObject()
    : homepageAuditDoc;

  const snapshot = doc.snapshot;
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('homepageAuditPdfMapper: snapshot is required on the HomepageAudit document');
  }

  const pageInfo = snapshot.page_info || {};
  const sections = snapshot.sections || {};
  const perf = snapshot.performance || {};

  const readiness = _buildReadiness(snapshot);
  const scores = _buildScores(snapshot, sections, perf, readiness);

  // Collected once, shared by issueSummary AND recommendations — both are
  // derived facts about "every check currently in the sections object",
  // never from snapshot's own derived/cached fields (sections.summary,
  // rules_summary, top_issues), which can lag behind the checks they're
  // supposed to summarize depending on exactly when async PATCHes landed.
  const allChecks = _collectAllChecks(sections);
  const issueSummary = _buildIssueSummary(allChecks);

  return {
    metadata: _buildMetadata(doc, snapshot),
    scores,
    readiness,
    issueSummary,
    sections: {
      executiveSummary: _buildExecutiveSummary(scores, issueSummary),
      onPageSeo: _buildChecksSection(sections.on_page, scores.onPage),
      technicalSeo: _buildChecksSection(sections.technical, scores.technical),
      security: _buildChecksSection(sections.security, scores.security),
      aiVisibility: _buildAiVisibilitySection(sections.ai, scores.ai, pageInfo),
      performance: _buildPerformanceSection(perf, scores.performance, readiness, pageInfo),
      accessibility: _buildAccessibilitySection(sections.accessibility, scores.accessibility, readiness),
      socialPresence: _buildSocialSection(pageInfo),
      localSeo: _buildLocalSeoSection(pageInfo, readiness),
    },
    recommendations: _buildRecommendations(allChecks),
  };
}

// ── metadata ────────────────────────────────────────────────────────────────

function _buildMetadata(doc, snapshot) {
  return {
    auditId: doc._id ? String(doc._id) : null,
    url: snapshot.url || doc.url || '',
    domain: _domainFromUrl(snapshot.url || doc.url || ''),
    auditedAt: doc.created_at ? new Date(doc.created_at).toISOString() : null,
    generatedAt: new Date().toISOString(),
  };
}

// ── scores (with recomputed overall) ──────────────────────────────────────

function _buildScores(snapshot, sections, perf, readiness) {
  const onPage = _scoreAndGrade(snapshot.on_page_score);
  const technical = _scoreAndGrade(snapshot.technical_score);
  const ai = _scoreAndGrade(snapshot.ai_score);
  const security = _scoreAndGrade(snapshot.security_score);

  // Accessibility: only trust the score if the async analysis has completed;
  // otherwise expose null rather than a misleading default-0 value (the raw
  // snapshot defaults accessibility_metrics.score to 0 while processing).
  const accessibilityRaw = readiness.accessibilityReady
    ? (sections.accessibility?.score ?? snapshot.accessibility_metrics?.score ?? null)
    : null;
  const accessibility = _scoreAndGrade(accessibilityRaw);

  // Performance: prefer the completed PageSpeed score. If not ready, fall
  // back to whatever numeric value is currently on the snapshot (the
  // synchronous response-time heuristic Python computes before PageSpeed
  // lands) so the recomputed overall score still has a number to weight —
  // readiness.performanceReady tells the renderer whether to label it
  // "preliminary". Only if truly no numeric value exists does this fall to 0.
  const performanceCompletedScore = readiness.performanceReady ? (perf.score ?? null) : null;
  const performanceFallbackScore = perf.score ?? snapshot.performance_score ?? null;
  const performanceForDisplay = _scoreAndGrade(performanceCompletedScore);
  const performanceForFormula = performanceFallbackScore ?? 0;

  const overallScore = _computeOverallScore({
    onPage: onPage.value ?? 0,
    technical: technical.value ?? 0,
    ai: ai.value ?? 0,
    performance: performanceForFormula,
  });

  // OPTION A (per 2026-07 architecture hardening pass): keep the weighted
  // overallScore calculation as-is (it already uses the best currently-known
  // performance number, completed or heuristic-fallback), but tag it with a
  // scoreState so the renderer can visually distinguish "final" from
  // "preliminary" instead of silently presenting a score that's 20%-weighted
  // on data that hasn't landed yet. Rejected OPTION B (excluding performance
  // from the weighting until ready) because it would produce a DIFFERENT
  // number once performance lands — same audit, two different overallScore
  // values depending purely on generation timing, which is worse for user
  // trust than one stable number with an honest "preliminary" label.
  const scoreState = readiness.performanceReady ? 'final' : 'preliminary';

  return {
    onPage,
    technical,
    ai,
    security,
    performance: performanceForDisplay,
    accessibility,
    computed: {
      overallScore,
      overallGrade: getGrade(overallScore),
      scoreState,
    },
  };
}

function _scoreAndGrade(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return { value: null, grade: null };
  }
  return { value, grade: getGrade(value) };
}

function _computeOverallScore({ onPage, technical, ai, performance }) {
  const raw =
    onPage * OVERALL_WEIGHTS.onPage +
    technical * OVERALL_WEIGHTS.technical +
    ai * OVERALL_WEIGHTS.ai +
    performance * OVERALL_WEIGHTS.performance;
  return Math.round(raw);
}

// ── readiness flags ────────────────────────────────────────────────────────

function _buildReadiness(snapshot) {
  const performanceReady = snapshot.performance?.status === 'completed';
  const accessibilityReady =
    snapshot.accessibility_metrics?.status === 'completed' ||
    snapshot.sections?.accessibility?.status === 'completed';
  const gbpAvailable = Boolean(snapshot.page_info?.google_business_presence);

  return { performanceReady, accessibilityReady, gbpAvailable };
}

// ── check collection + issue summary (recomputed from the actual check
// arrays, not the stored sections.summary/rules_summary — those fields are
// themselves written client-side (QuickAuditHero.jsx) at PATCH time and can
// lag behind the checks they're supposed to summarize, e.g. if generated
// between the performance PATCH and the accessibility PATCH landing) ───────

function _collectAllChecks(sections) {
  const allChecks = [];
  Object.entries(sections).forEach(([key, section]) => {
    if (key === 'summary') return;
    const checks = section?.checks;
    if (Array.isArray(checks)) allChecks.push(...checks);
  });
  return allChecks;
}

function _buildIssueSummary(allChecks) {
  const total = allChecks.length;
  const passed = allChecks.filter((c) => c.status === 'pass').length;
  const failed = total - passed;
  const critical = allChecks.filter(
    (c) => c.status !== 'pass' && (c.severity === 'critical' || c.severity === 'high')
  ).length;
  const warnings = failed - critical;

  return { total, critical, warnings, passed };
}

// ── section builders (structural data only — no copy elaboration, no color/
// icon assignment; that presentation logic belongs to the future renderer) ─

function _buildExecutiveSummary(scores, issueSummary) {
  return {
    overallScore: scores.computed.overallScore,
    overallGrade: scores.computed.overallGrade,
    categoryScores: {
      onPage: scores.onPage,
      technical: scores.technical,
      ai: scores.ai,
      performance: scores.performance,
      accessibility: scores.accessibility,
      security: scores.security,
    },
    issueSummary,
  };
}

function _buildChecksSection(sectionData, scoreAndGrade) {
  const checks = _mapChecks(sectionData?.checks);
  return {
    score: scoreAndGrade.value,
    grade: scoreAndGrade.grade,
    checks,
    issueCount: checks.filter((c) => c.status !== 'pass').length,
    checksCount: checks.length,
  };
}

function _buildAiVisibilitySection(sectionData, scoreAndGrade, pageInfo) {
  const base = _buildChecksSection(sectionData, scoreAndGrade);
  return {
    ...base,
    llmReadabilityScore: pageInfo.llm_readability?.score ?? null,
  };
}

function _buildPerformanceSection(perf, scoreAndGrade, readiness, pageInfo) {
  return {
    ready: readiness.performanceReady,
    score: scoreAndGrade.value,
    grade: scoreAndGrade.grade,
    responseTimeMs: pageInfo.response_time_ms ?? null,
    mobile: readiness.performanceReady ? _buildCwvMetrics(perf.mobile) : null,
    desktop: readiness.performanceReady ? _buildCwvMetrics(perf.desktop) : null,
  };
}

function _buildCwvMetrics(deviceMetrics) {
  if (!deviceMetrics) return null;
  const metrics = ['fcp', 'lcp', 'cls', 'tbt', 'inp'];
  const out = { score: deviceMetrics.score ?? null };
  for (const m of metrics) {
    const raw = deviceMetrics[m];
    const ms = parseCwvValueToMs(m, raw);
    out[m] = {
      raw: raw ?? null,
      rating: ms !== null ? rateCwvMetric(m, ms) : null,
    };
  }
  return out;
}

function _buildAccessibilitySection(sectionData, scoreAndGrade, readiness) {
  const base = _buildChecksSection(sectionData, scoreAndGrade);
  return {
    ready: readiness.accessibilityReady,
    ...base,
  };
}

function _buildSocialSection(pageInfo) {
  const social = pageInfo.social_signals || {};
  const platforms = ['facebook', 'twitter', 'instagram', 'linkedin', 'youtube'].map((key) => ({
    platform: key,
    connected: social[key]?.found === true,
  }));
  return {
    platforms,
    connectedCount: platforms.filter((p) => p.connected).length,
    missingCount: platforms.filter((p) => !p.connected).length,
  };
}

function _buildLocalSeoSection(pageInfo, readiness) {
  const gbp = pageInfo.google_business_presence || {};
  if (!readiness.gbpAvailable) {
    return { available: false };
  }
  return {
    available: true,
    found: gbp.found === true,
    businessName: gbp.business_name || null,
    category: gbp.category || null,
    rating: gbp.rating ?? null,
    reviewCount: gbp.review_count ?? null,
    address: gbp.address || null,
    phone: gbp.phone || null,
    website: gbp.website || null,
    mapsUrl: gbp.maps_url || null,
    status: gbp.status || null,
  };
}

// Recomputed from the same allChecks the mapper already collected for
// issueSummary — deliberately NOT read from snapshot.top_issues, which has
// the identical staleness problem as sections.summary/rules_summary: it's a
// derived value written once by Python (before accessibility exists) and
// then possibly overwritten client-side once accessibility lands, so its
// contents depend on exactly when it was last computed relative to
// generation time. Recomputing here guarantees recommendations always
// reflect every check currently in the mapped sections, and are ordered
// deterministically (severity rank, then stable original section order —
// Array.prototype.sort is stable, and section iteration order is fixed by
// object key order, so re-running the mapper on the same snapshot always
// produces the same ordering).
const SEVERITY_RANK = { critical: 3, high: 3, medium: 2, warning: 2, low: 1 };

function _normalizeSeverity(value) {
  const v = (value || '').toLowerCase();
  if (v === 'critical' || v === 'high') return 'critical';
  if (v === 'medium' || v === 'warning') return 'medium';
  return 'low';
}

function _buildRecommendations(allChecks) {
  const failed = allChecks.filter((c) => c.status !== 'pass');
  const ranked = failed
    .map((c) => ({ check: c, rank: SEVERITY_RANK[(c.severity || '').toLowerCase()] ?? 1 }))
    .sort((a, b) => b.rank - a.rank);

  const topIssues = ranked.slice(0, 10).map(({ check }, idx) => ({
    priority: idx + 1,
    ruleId: check.rule_id || null,
    severity: _normalizeSeverity(check.severity),
    message: check.message || '',
    category: check.category || null,
  }));

  return { topIssues };
}

// ── general helpers ────────────────────────────────────────────────────────

function _mapChecks(checks) {
  if (!Array.isArray(checks)) return [];
  return checks.map((c) => ({
    name: c.name || null,
    ruleId: c.rule_id || null,
    status: c.status || null,
    severity: c.severity || null,
    message: c.message || null,
    category: c.category || null,
  }));
}

function _domainFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export { mapHomepageAuditToPdfData };
