/**
 * Section adapters for the canonical report.
 *
 * Each adapter wraps an EXISTING service / controller / model and maps its
 * output into the report contract. They contain no scoring or aggregation
 * logic of their own: counts come from IssueAggregationService, scores from
 * the existing score producers, rankings from SeoRankingCurrent, and so on.
 *
 * Adapters receive their collaborators through `deps` so they can be tested
 * without a database, and they never convert a missing value into 0.
 */

import {
  STATUS,
  TIME_BASIS,
  section,
  unavailable,
  notConfigured,
  relationToRun,
  num,
} from './reportContract.js';
import { HUB_VIEWS, trimHubIssues } from './hubViews.js';
import { CANONICAL_ISSUE_TITLES } from '../../../config/issueMetadata.js';

const SEVERITY_RANK = { critical: 5, high: 4, medium: 3, warning: 3, low: 2, info: 1 };
const sevRank = (s) => SEVERITY_RANK[String(s || '').toLowerCase()] || 0;

/** Invoke an Express handler (res.json) and capture its JSON body. */
export async function callHandler(handler, { params = {}, query = {} } = {}) {
  let statusCode = 200;
  let body;
  const res = {
    status(c) { statusCode = c; return res; },
    json(b) { body = b; return res; },
  };
  await handler({ params, query }, res);
  return { statusCode, body };
}

// ─── Issues (shared, loaded once) ───────────────────────────────────────────

/**
 * Canonical issue totals — the same IssueAggregationService call the
 * dashboard Overview uses (IssueCountsService.getIssueCounts): all
 * categories, open issues, distinct dedup_key.
 */
export async function loadCanonicalIssues(ctx, deps) {
  const [summary, categories] = await Promise.all([
    deps.issues.getIssueSummary(ctx.projectId, { excludeCategories: [] }),
    deps.issues.getCategoryCounts(ctx.projectId),
  ]);
  return {
    totalOpen: summary.totalIssues,
    resolved: summary.resolved,
    bySeverity: {
      critical: summary.critical, // critical + high severity (dashboard definition)
      medium: summary.warnings,
      low: summary.informational, // low + info
    },
    byCategory: categories,
    definition: 'open issues, distinct dedup_key, all categories (IssueAggregationService.getIssueSummary)',
  };
}

// ─── On-page SEO ─────────────────────────────────────────────────────────────

export async function onPageSeoAdapter(ctx, deps) {
  const SOURCE = 'services/onPageIssuesService.getOnPageIssues';
  const result = await deps.getOnPageIssues(ctx.projectId);
  const issues = Array.isArray(result?.issues) ? result.issues : null;
  if (!issues) return unavailable(SOURCE, 'invalid_response', 'On-page issue service returned no issue list.');

  const ranked = [...issues].sort(
    (a, b) => sevRank(b.severity) - sevRank(a.severity) || (b.pages_affected || 0) - (a.pages_affected || 0)
  );
  const top = ranked.slice(0, 10).map((i) => ({
    issueCode: i.issue_code,
    title: i.title,
    severity: i.severity,
    category: i.category,
    dataPath: i.data_path ?? null,
    pagesAffected: i.pages_affected,
    occurrences: num(i.total_occurrences),
    impactPercentage: i.impact_percentage ?? null,
    difficulty: i.difficulty ?? null,
  }));

  // Affected-URL evidence for the top few issues. A failure here degrades the
  // section to `partial`; it never hides the issue itself.
  let evidenceFailed = false;
  const evidence = {};
  for (const t of top.slice(0, 5)) {
    try {
      const urls = await deps.getIssueUrls(ctx.projectId, t.issueCode);
      evidence[t.issueCode] = {
        totalUrls: urls.length,
        sample: urls.slice(0, 25).map((u) => ({ url: u.url, detectedValue: u.detected_value ?? null })),
      };
    } catch {
      evidenceFailed = true;
    }
  }

  const bySeverity = {};
  for (const i of issues) {
    const k = String(i.severity || 'unknown').toLowerCase();
    bySeverity[k] = (bySeverity[k] || 0) + (i.pages_affected || 0);
  }

  return section(evidenceFailed ? STATUS.PARTIAL : STATUS.AVAILABLE, {
    reason: evidenceFailed ? 'evidence_failed' : null,
    message: evidenceFailed ? 'Affected-URL evidence could not be loaded for some issues.' : null,
    source: SOURCE,
    timeBasis: TIME_BASIS.LIVE_CURRENT,
    snapshotRelation: ctx.liveRelation,
    data: {
      totalIssues: result.summary?.total_issues_found ?? null,
      issueTypes: result.summary?.total_issue_types ?? issues.length,
      pagesAnalyzed: result.summary?.total_pages_analyzed ?? null,
      bySeverity,
      topIssues: top,
      affectedUrls: evidence,
      scope: 'non-Accessibility categories, open issues',
    },
  });
}

// ─── Accessibility ───────────────────────────────────────────────────────────

/** Display title for an issue: canonical title, else the message up to the evidence suffix. */
export function issueTitle(code, message) {
  const e = CANONICAL_ISSUE_TITLES[code];
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && e.default) return e.default;
  if (!message || typeof message !== 'string') return code || 'Unknown issue';
  const i = message.indexOf(': ');
  const base = i > 0 ? message.slice(0, i) : message;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

export async function accessibilityAdapter(ctx, deps) {
  const SOURCE = 'services/accessibilityIssuesService.getAccessibilityIssues';
  const result = await deps.getAccessibilityIssues(ctx.projectId);
  const issues = Array.isArray(result?.issues) ? result.issues : null;
  if (!issues) return unavailable(SOURCE, 'invalid_response', 'Accessibility service returned no issue list.');

  const ranked = [...issues].sort(
    (a, b) => sevRank(b.severity) - sevRank(a.severity) || (b.pages_affected || 0) - (a.pages_affected || 0)
  );
  const bySeverity = {};
  for (const i of issues) {
    const k = String(i.severity || 'unknown').toLowerCase();
    bySeverity[k] = (bySeverity[k] || 0) + (i.pages_affected || 0);
  }

  // Affected-URL evidence for the distinct top issue codes; failure degrades to partial.
  let evidenceFailed = false;
  const evidence = {};
  const codes = [...new Set(ranked.map((i) => i.issue_code))].slice(0, 6);
  if (deps.getIssueUrls) {
    for (const code of codes) {
      try {
        const urls = await deps.getIssueUrls(ctx.projectId, code);
        evidence[code] = { totalUrls: urls.length, sample: urls.slice(0, 15).map((u) => ({ url: u.url })) };
      } catch {
        evidenceFailed = true;
      }
    }
  }

  return section(evidenceFailed ? STATUS.PARTIAL : STATUS.AVAILABLE, {
    reason: evidenceFailed ? 'evidence_failed' : null,
    message: evidenceFailed ? 'Affected-URL evidence could not be loaded for some issues.' : null,
    source: SOURCE,
    timeBasis: TIME_BASIS.LIVE_CURRENT,
    snapshotRelation: ctx.liveRelation,
    data: {
      totalIssues: result.summary?.total_issues_found ?? null,
      issueTypes: result.summary?.total_issue_types ?? issues.length,
      pagesAnalyzed: result.summary?.total_pages_analyzed ?? null,
      bySeverity,
      topIssues: ranked.slice(0, 25).map((i) => ({
        issueCode: i.issue_code,
        title: issueTitle(i.issue_code, i.issue_message),
        severity: i.severity,
        pagesAffected: i.pages_affected,
        occurrences: num(i.total_occurrences),
        impactPercentage: i.impact_percentage ?? null,
        difficulty: i.difficulty ?? null,
      })),
      affectedUrls: evidence,
      // Odito's accessibility scan reports findings only; it does not produce a score or WCAG mapping.
      score: null,
      wcagMapping: null,
      scope: 'Accessibility category, open issues',
    },
  });
}

// ─── Technical SEO (checks + crawlability + structured data) ────────────────

export async function technicalSeoAdapter(ctx, deps) {
  const SOURCE = 'TechnicalChecksService + Page11Service + Page09Service';
  const [tech, crawl, schema] = await Promise.allSettled([
    deps.getTechnicalChecks(ctx.project),
    deps.getCrawlability(ctx.projectId),
    deps.getStructuredData(ctx.projectId),
  ]);

  const parts = {};
  const missing = [];

  if (tech.status === 'fulfilled' && tech.value?.success && Array.isArray(tech.value.data?.checks)) {
    const { checks, summary } = tech.value.data;
    // Real TechnicalChecksService fields: id, name, status ('OK'|'Warning'|'Critical'),
    // severity, affected_pages, impact_percentage, impact_basis, difficulty, message.
    parts.checks = checks.map((c) => ({
      id: c.id ?? null,
      name: c.name,
      status: c.status,
      severity: c.severity ?? null,
      affectedPages: num(c.affected_pages),
      impactPercentage: num(c.impact_percentage),
      // 'severity_tier' means impactPercentage is a fixed tier weight, not a % of pages
      impactBasis: c.impact_basis ?? null,
      difficulty: c.difficulty ?? null,
      message: c.message ?? null,
    }));
    // healthScore is reported only when there were checks to score; the
    // service itself returns 0 for an empty list.
    parts.healthScore = checks.length > 0 ? num(summary?.healthScore) : null;
    parts.summary = summary ?? null;
  } else {
    missing.push('technicalChecks');
  }

  if (crawl.status === 'fulfilled' && crawl.value?.metrics && crawl.value.metrics.totalPages > 0) {
    parts.crawlability = {
      totalPages: crawl.value.metrics.totalPages,
      indexedPages: crawl.value.metrics.indexedPages,
      blockedPages: crawl.value.metrics.blockedPages,
      indexRate: crawl.value.metrics.indexRate,
      blockedReasons: crawl.value.blockedReasons ?? [],
    };
  } else {
    missing.push('crawlability');
  }

  if (schema.status === 'fulfilled' && schema.value?.success && schema.value.data) {
    const d = schema.value.data;
    parts.structuredData = {
      pagesWithSchema: d.withSchema,
      pagesWithoutSchema: d.withoutSchema,
      coveragePercent: d.coverage,
      schemaIssueCount: d.errors,
      schemaTypes: d.schemaTypes ?? [],
    };
  } else {
    missing.push('structuredData');
  }

  if (missing.length === 3) {
    return unavailable(SOURCE, 'query_failed', 'No technical SEO data could be loaded.');
  }
  return section(missing.length ? STATUS.PARTIAL : STATUS.AVAILABLE, {
    reason: missing.length ? 'partial_modules' : null,
    message: missing.length ? `Unavailable: ${missing.join(', ')}.` : null,
    source: SOURCE,
    timeBasis: TIME_BASIS.LIVE_CURRENT,
    snapshotRelation: ctx.liveRelation,
    data: { ...parts, unavailableParts: missing },
  });
}

// ─── PageSpeed ───────────────────────────────────────────────────────────────

/** A device counts as measured only if Lighthouse produced metrics for it. */
function deviceMeasured(d) {
  return !!d && ((d.metrics && Object.keys(d.metrics).length > 0) || d.lcp != null || d.fcp != null);
}

function mapDevice(d) {
  if (!deviceMeasured(d)) return null;
  const metric = (k) => num(d.metrics?.[k]?.value ?? d[k]?.value ?? d[k]);
  return {
    scores: {
      performance: num(d.performance_score ?? d.performance),
      accessibility: num(d.accessibility_score ?? d.accessibility),
      bestPractices: num(d.best_practices_score ?? d.best_practices),
      seo: num(d.seo_score ?? d.seo),
    },
    coreWebVitals: {
      lcp: metric('lcp'),
      cls: metric('cls'),
      tbt: metric('tbt'),
      fcp: metric('fcp'),
      ttfb: num(d.ttfb?.value ?? d.metrics?.ttfb?.value),
    },
    opportunities: Array.isArray(d.opportunities) ? d.opportunities : [],
  };
}

export async function pageSpeedAdapter(ctx, deps) {
  const SOURCE = 'ProjectPerformanceService.getProjectPerformance (seo_domain_performance)';
  const res = await deps.getProjectPerformance(ctx.project);
  if (!res?.success) return unavailable(SOURCE, 'query_failed', 'Performance service reported a failure.');
  const mobile = mapDevice(res.data?.mobile);
  const desktop = mapDevice(res.data?.desktop);
  if (!mobile && !desktop) {
    return unavailable(SOURCE, 'no_data', res.data?.message || 'No PageSpeed measurements are available.', {
      timeBasis: TIME_BASIS.LIVE_CURRENT,
    });
  }
  const missing = [!mobile && 'mobile', !desktop && 'desktop'].filter(Boolean);
  return section(missing.length ? STATUS.PARTIAL : STATUS.AVAILABLE, {
    reason: missing.length ? 'device_not_measured' : null,
    message: missing.length ? `Not measured: ${missing.join(', ')}.` : null,
    source: SOURCE,
    // seo_domain_performance is overwritten on every recrawl (see AuditHistoryService).
    timeBasis: TIME_BASIS.LIVE_CURRENT,
    snapshotRelation: ctx.liveRelation,
    data: {
      // The service's own weighted score (70% mobile / 30% desktop, or the single measured device).
      performanceScore: num(res.data?.summary?.performanceScore) || null,
      mobile,
      desktop,
    },
  });
}

// ─── Keywords ────────────────────────────────────────────────────────────────

const KEYWORD_CAP = 200;

export async function keywordsAdapter(ctx, deps) {
  const current = await deps.loadCurrentRankings(ctx.projectId);

  if (current && Array.isArray(current.keywords) && current.keywords.length > 0) {
    let history = { weekByKeyword: new Map(), monthByKeyword: new Map() };
    let historyFailed = false;
    try {
      history = await deps.deriveHistoricalRanks(ctx.projectId);
    } catch {
      historyFailed = true;
    }
    const norm = (k) => String(k || '').toLowerCase().trim();
    const rows = current.keywords.map((k) => {
      const n = norm(k.keyword);
      const scanOk = (k.last_scan_status || 'ok') === 'ok';
      return {
        keyword: k.keyword,
        // A failed scan means "unknown", not "not ranking".
        currentRank: scanOk ? num(k.current_rank) : null,
        rankState: !scanOk ? 'scan_error' : k.current_rank == null ? 'not_in_top_100' : 'ranking',
        previousScanRank: num(k.prev_scan_rank),
        previousWeekRank: history.weekByKeyword.has(n) ? num(history.weekByKeyword.get(n)) : null,
        previousMonthRank: history.monthByKeyword.has(n) ? num(history.monthByKeyword.get(n)) : null,
        bestRank: num(k.best_rank),
        mapsRank: num(k.maps_rank),
        lastScanStatus: k.last_scan_status || 'ok',
      };
    });
    const ranked = rows.filter((r) => r.rankState === 'ranking');
    const summary = {
      tracked: rows.length,
      ranking: ranked.length,
      notInTop100: rows.filter((r) => r.rankState === 'not_in_top_100').length,
      scanErrors: rows.filter((r) => r.rankState === 'scan_error').length,
      top3: ranked.filter((r) => r.currentRank <= 3).length,
      top10: ranked.filter((r) => r.currentRank <= 10).length,
      rank11to20: ranked.filter((r) => r.currentRank >= 11 && r.currentRank <= 20).length,
      rank21to100: ranked.filter((r) => r.currentRank >= 21).length,
    };
    return section(historyFailed ? STATUS.PARTIAL : STATUS.AVAILABLE, {
      reason: historyFailed ? 'history_unavailable' : null,
      message: historyFailed ? 'Previous-week/month ranks could not be derived.' : null,
      source: 'SeoRankingCurrent + KeywordRankingHistory (rankingHistoryService)',
      asOf: current.last_scanned_at,
      timeBasis: TIME_BASIS.POINT_IN_TIME,
      snapshotRelation: relationToRun(current.last_scanned_at, ctx.run),
      data: {
        origin: 'seo_rankings_current',
        location: current.location ?? null,
        country: current.country ?? null,
        scope: current.seo_scope ?? null,
        summary,
        keywords: rows.slice(0, KEYWORD_CAP),
        truncated: rows.length > KEYWORD_CAP,
        note: 'Odito-tracked search rankings; not Google Search Console data.',
      },
    });
  }

  // Legacy archive: only when no canonical document exists (same rule as the dashboard).
  if (!current) {
    const legacy = await deps.loadLegacyRankings(ctx.projectId);
    if (legacy && Array.isArray(legacy.keywords) && legacy.keywords.length > 0) {
      const rows = legacy.keywords.map((k) => ({
        keyword: k.keyword,
        currentRank: num(k.rank),
        rankState: k.rank == null ? 'not_in_top_100' : 'ranking',
      }));
      return section(STATUS.PARTIAL, {
        reason: 'legacy_source',
        message: 'Only the legacy onboarding ranking snapshot exists; it is not kept up to date.',
        source: 'SeoRanking (legacy seo_rankings)',
        asOf: legacy.created_at,
        timeBasis: TIME_BASIS.POINT_IN_TIME,
        snapshotRelation: relationToRun(legacy.created_at, ctx.run),
        data: {
          origin: 'seo_rankings_legacy',
          summary: {
            tracked: rows.length,
            ranking: rows.filter((r) => r.rankState === 'ranking').length,
            notInTop100: rows.filter((r) => r.rankState === 'not_in_top_100').length,
          },
          keywords: rows.slice(0, KEYWORD_CAP),
          truncated: rows.length > KEYWORD_CAP,
        },
      });
    }
  }
  return unavailable('SeoRankingCurrent', 'no_data', 'No tracked keywords with ranking data exist for this project.');
}

// ─── Search Console (stored data only; never a live Google call) ────────────

export async function searchConsoleAdapter(ctx, deps) {
  const SOURCE = 'GoogleConnection + SearchConsoleData (stored)';
  const conn = await deps.findSearchConsoleConnection(ctx.project.user_id, ctx.projectId);
  if (!conn || !(conn.service_type || []).includes('search_console')) {
    return notConfigured(SOURCE, 'not_connected', 'Google Search Console is not connected for this project.');
  }
  const agg = await deps.getSearchConsoleAggregates(ctx.projectId);
  if (!agg || !agg.page_count) {
    return unavailable(SOURCE, 'no_synced_data', 'Search Console is connected but no data has been synced yet.', {
      timeBasis: TIME_BASIS.REPORTING_PERIOD,
    });
  }
  return section(STATUS.AVAILABLE, {
    source: SOURCE,
    asOf: agg.lastFetched,
    timeBasis: TIME_BASIS.REPORTING_PERIOD,
    snapshotRelation: 'not_applicable',
    data: {
      // Same aggregation the dashboard uses (SearchConsoleData.getProjectAggregates):
      // one row per page (its most recently fetched row), clicks/impressions summed
      // over pages, CTR and position are simple means of the per-page values.
      totalClicks: num(agg.totalClicks),
      totalImpressions: num(agg.totalImpressions),
      averageCtrAcrossPages: num(agg.avgCtr),
      averagePositionAcrossPages: num(agg.avgPosition),
      pagesWithData: agg.page_count,
      lastSyncedAt: agg.lastFetched ?? null,
      aggregation: 'per-page latest fetched row; clicks and impressions summed; CTR and position are unweighted means of per-page values (not site-level figures)',
      note: 'Google Search Console data (separate from Odito-tracked rankings). Each page row covers its own fetch date range, which differs from the audit.',
    },
  });
}

// ─── AEO / GEO / AISO hubs (reuse the dashboard controllers) ────────────────

export function hubAdapter(hubName, handlerKey, scoreKey, viewKey, issuesKey) {
  return async function adapter(ctx, deps) {
    const SOURCE = `ai_hub/aiHubController.${handlerKey} (ai_projects, ai_pages, ai_issues)`;
    const { statusCode, body } = await callHandler(deps.hubHandlers[handlerKey], {
      params: { projectId: ctx.projectId },
    });
    if (statusCode >= 400 || !body?.success) {
      return unavailable(SOURCE, 'query_failed', `${hubName} hub could not be loaded.`);
    }
    if (!body.data) {
      return unavailable(SOURCE, 'not_run', `The ${hubName} analysis has not run for this project.`);
    }
    const d = body.data;
    const score = num(d[scoreKey]);

    // Rule-level findings (with the hub's own recommendation text). Optional: a
    // failure here degrades this hub to partial and never affects another hub.
    let issues = null;
    let issuesFailed = false;
    const issuesHandler = deps.hubHandlers[issuesKey];
    if (issuesHandler) {
      try {
        const r = await callHandler(issuesHandler, { params: { projectId: ctx.projectId } });
        if (r.statusCode >= 400 || !r.body?.success) issuesFailed = true;
        else issues = trimHubIssues(Array.isArray(r.body.data) ? r.body.data : r.body.data?.issues);
        if (issues === null && !issuesFailed) issuesFailed = true;
      } catch {
        issuesFailed = true;
      }
    }

    const missing = [score === null && 'score', issuesFailed && 'rule findings'].filter(Boolean);
    return section(missing.length ? STATUS.PARTIAL : STATUS.AVAILABLE, {
      reason: missing.length ? (score === null ? 'score_missing' : 'issues_failed') : null,
      message: missing.length ? `${hubName}: ${missing.join(' and ')} unavailable.` : null,
      source: SOURCE,
      asOf: d.computed_at,
      timeBasis: TIME_BASIS.LIVE_CURRENT,
      snapshotRelation: relationToRun(d.computed_at, ctx.run),
      data: {
        ...HUB_VIEWS[viewKey](d),
        score,
        jobId: d.job_id ?? null,
        issues,
        interpretation:
          'On-site readiness checks. These are not measured AI-platform citations or mentions.',
      },
    });
  };
}

// ─── Progress (tasks + audit comparison) ─────────────────────────────────────

export async function progressAdapter(ctx, deps) {
  const SOURCE = 'Task model + AuditComparisonService.compareLatest';
  const [tasks, comparison] = await Promise.allSettled([
    deps.countTasksByStatus(ctx.projectId),
    deps.compareLatest(ctx.projectId),
  ]);
  const data = {};
  const missing = [];

  if (tasks.status === 'fulfilled') {
    const byStatus = { task_created: 0, implemented: 0, verified_fixed: 0, reopened: 0, ...tasks.value };
    data.tasks = { total: Object.values(byStatus).reduce((a, b) => a + b, 0), byStatus };
  } else {
    missing.push('tasks');
  }

  if (comparison.status === 'fulfilled') {
    const c = comparison.value;
    if (c && c.available === false) {
      data.comparison = { available: false, reason: c.reason };
    } else if (c) {
      // Deltas only; the raw run documents are not needed in the report.
      // Issue-count deltas use AuditRun snapshot totals, which can differ in basis
      // from the live canonical issue count (see integrity.snapshotIssueTotal).
      data.comparison = {
        available: true,
        currentAuditNumber: c.current?.auditNumber ?? null,
        previousAuditNumber: c.previous?.auditNumber ?? null,
        currentCompletedAt: c.current?.completedAt ?? null,
        previousCompletedAt: c.previous?.completedAt ?? null,
        delta: c.delta ?? null,
        scope: 'two most recent audit runs',
      };
    }
  } else {
    missing.push('comparison');
  }

  if (missing.length === 2) return unavailable(SOURCE, 'query_failed', 'Progress data could not be loaded.');
  return section(missing.length ? STATUS.PARTIAL : STATUS.AVAILABLE, {
    reason: missing.length ? 'partial_modules' : null,
    message: missing.length ? `Unavailable: ${missing.join(', ')}.` : null,
    source: SOURCE,
    timeBasis: TIME_BASIS.LIVE_CURRENT,
    snapshotRelation: 'not_applicable',
    data: {
      ...data,
      scope: 'Tasks are project-wide (not run-scoped); comparison is between the two most recent audit runs.',
    },
  });
}

// ─── Recommendations (derived from real findings; nothing generated) ────────

const DIFFICULTY_RANK = { easy: 0, medium: 1, hard: 2 };
const RECOMMENDATION_CAP = 25;

/**
 * Prioritised recommendations built ONLY from findings already in the report
 * sections plus stored guidance (`recommendation` / `impact` / `expected_value`
 * saved on seo_page_issues, and the hubs' own recommendation text).
 *
 * Priority = the finding's own severity, then pages affected, then easier fixes
 * first. No traffic, ranking or score-gain estimates. Nothing is marked fixed:
 * verification state is not part of this section.
 */
export async function recommendationsAdapter(ctx, deps, sections) {
  const SOURCE = 'report findings + seo_page_issues stored guidance + AI hub rule findings';
  let guidance = new Map();
  let guidanceFailed = false;
  try {
    guidance = await deps.loadIssueGuidance(ctx.projectId);
  } catch {
    guidanceFailed = true;
  }

  const items = [];
  const seen = new Set();
  const push = (it) => {
    const key = `${it.source}|${it.ruleId || it.title}`;
    if (seen.has(key)) return; // same issue code at several data paths: keep the first (highest-ranked)
    seen.add(key);
    items.push(it);
  };
  const usable = (s) => s && (s.status === STATUS.AVAILABLE || s.status === STATUS.PARTIAL) && s.data;

  const fromIssues = (sec, source, label) => {
    if (!usable(sec)) return;
    for (const i of sec.data.topIssues || []) {
      const g = guidance.get(i.issueCode) || {};
      push({
        source,
        sourceLabel: label,
        ruleId: i.issueCode,
        category: i.category ?? null,
        title: i.title,
        severity: i.severity ?? null,
        pagesAffected: num(i.pagesAffected),
        impactPercentage: num(i.impactPercentage),
        difficulty: i.difficulty ?? null,
        whyItMatters: g.impact ?? null,
        action: g.recommendation ?? null,
        expectedValue: g.recommendation ? null : g.expected ?? null,
        actionBasis: g.recommendation ? 'stored_recommendation' : g.expected ? 'expected_value' : 'none',
      });
    }
  };
  fromIssues(sections.onPageSeo, 'on-page', 'On-page SEO');
  fromIssues(sections.accessibility, 'accessibility', 'Accessibility');

  for (const [key, label] of [['aeo', 'AEO'], ['geo', 'GEO'], ['aiso', 'AISO']]) {
    const sec = sections[key];
    if (!usable(sec)) continue;
    for (const i of sec.data.issues || []) {
      push({
        source: key,
        sourceLabel: label,
        ruleId: i.ruleId,
        category: i.card ?? null,
        title: i.title,
        severity: i.severity ?? null,
        pagesAffected: num(i.pagesAffected),
        impactPercentage: null,
        difficulty: null,
        whyItMatters: i.description ?? null,
        action: i.recommendation ?? null,
        expectedValue: null,
        actionBasis: i.recommendation ? 'hub_recommendation' : 'none',
      });
    }
  }

  const total = items.length;
  items.sort(
    (a, b) =>
      sevRank(b.severity) - sevRank(a.severity) ||
      (b.pagesAffected || 0) - (a.pagesAffected || 0) ||
      (DIFFICULTY_RANK[a.difficulty] ?? 1) - (DIFFICULTY_RANK[b.difficulty] ?? 1)
  );

  const sourceSections = [sections.onPageSeo, sections.accessibility, sections.aeo, sections.geo, sections.aiso];
  if (total === 0) {
    const anyAvailable = sourceSections.some(usable);
    return anyAvailable
      ? section(STATUS.AVAILABLE, {
          source: SOURCE,
          timeBasis: TIME_BASIS.LIVE_CURRENT,
          snapshotRelation: ctx.liveRelation,
          data: { items: [], totalCandidates: 0, shown: 0, basis: 'No open findings were available to derive recommendations from.' },
        })
      : unavailable(SOURCE, 'no_findings_source', 'No findings were available, so no recommendations can be derived.');
  }

  // A hub that simply has not run is not a failure; a partial or failed source is.
  const FAILED = new Set(['query_failed', 'adapter_error', 'invalid_response']);
  const degraded = guidanceFailed || sourceSections.some((s) => s && (s.status === STATUS.PARTIAL || (s.status === STATUS.UNAVAILABLE && FAILED.has(s.reason))));
  return section(degraded ? STATUS.PARTIAL : STATUS.AVAILABLE, {
    reason: degraded ? (guidanceFailed ? 'guidance_failed' : 'sources_partial') : null,
    message: degraded
      ? guidanceFailed
        ? 'Stored remediation guidance could not be loaded; recommendations show findings without action text.'
        : 'Some finding sources were unavailable, so this list may be incomplete.'
      : null,
    source: SOURCE,
    timeBasis: TIME_BASIS.LIVE_CURRENT,
    snapshotRelation: ctx.liveRelation,
    data: {
      items: items.slice(0, RECOMMENDATION_CAP),
      totalCandidates: total,
      shown: Math.min(total, RECOMMENDATION_CAP),
      basis: 'Ordered by the finding\'s own severity, then pages affected, then easier fixes first. Action text is stored guidance from the audit; where none is stored, none is shown.',
    },
  });
}
