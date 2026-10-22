/**
 * CanonicalReportService (Phase 1)
 *
 * Builds the versioned canonical report payload for one project and one audit
 * run. It orchestrates adapters over existing services; it adds no scoring,
 * aggregation or ranking logic of its own (the only arithmetic is the overall
 * score, which reproduces the existing definition: the mean of the category
 * scores, here restricted to the categories that are actually available).
 *
 * Audit-run consistency
 * ---------------------
 * `audit_runs` (AuditRun) is the only immutable per-audit record. It stores the
 * website, performance, technical-health and AI scores of one completed audit.
 * Issues (seo_page_issues), PageSpeed, technical checks and the AI hubs are
 * NOT keyed to a run: they hold the project's current state. So:
 *   - scores come from the selected AuditRun (latest by default);
 *   - every other section is labelled `live_current` and carries a
 *     `snapshotRelation` / top-level `snapshot.consistency` flag saying
 *     whether it can be assumed to describe that same run;
 *   - keywords and Search Console keep their own time semantics.
 * Nothing is silently mixed: if live data may be newer than the snapshot the
 * payload says so.
 */

import {
  REPORT_SCHEMA_VERSION,
  STATUS,
  TIME_BASIS,
  section,
  unavailable,
  num,
} from './reportContract.js';
import {
  loadCanonicalIssues,
  onPageSeoAdapter,
  accessibilityAdapter,
  technicalSeoAdapter,
  pageSpeedAdapter,
  keywordsAdapter,
  searchConsoleAdapter,
  hubAdapter,
  progressAdapter,
  recommendationsAdapter,
} from './reportAdapters.js';

const sameInstant = (a, b) => {
  if (!a || !b) return false;
  return new Date(a).getTime() === new Date(b).getTime();
};

export class ReportError extends Error {
  constructor(message, statusCode = 500, code = 'REPORT_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function extractDomain(url) {
  if (!url || typeof url !== 'string') return null;
  const host = url.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  return host || null;
}

/** Decide how the selected run relates to the live (non run-keyed) data. */
export function resolveSnapshot({ project, run, latestRun, requestedAuditNumber }) {
  if (!run) {
    return {
      source: 'live',
      consistency: 'no_snapshot',
      liveRelation: 'not_applicable',
      note: 'No completed audit run exists for this project; scores and data are the current live state.',
    };
  }
  const isLatest = !!latestRun && String(latestRun._id) === String(run._id);
  if (requestedAuditNumber != null && !isLatest) {
    return {
      source: 'audit_run',
      consistency: 'historical_run_with_live_modules',
      liveRelation: 'after_run',
      note: 'A historical run was requested. Scores are from that run; issues, PageSpeed, technical and AI sections show the current state of the project.',
    };
  }
  const projectStart = project?.audit_started_at;
  if (projectStart && run.startedAt && !sameInstant(projectStart, run.startedAt)) {
    return {
      source: 'audit_run',
      consistency: 'live_newer_than_snapshot',
      liveRelation: 'after_run',
      note: 'A newer audit has started since this run was captured. Scores are from the captured run; issues, PageSpeed, technical and AI sections may reflect the newer, possibly incomplete audit.',
    };
  }
  return {
    source: 'audit_run',
    consistency: 'aligned',
    liveRelation: 'within_run',
    note: 'The latest completed audit run is also the project\'s current audit; live sections describe the same audit.',
  };
}

async function safe(source, fn) {
  try {
    return await fn();
  } catch (err) {
    console.warn('[CANONICAL_REPORT] section failed:', source, err?.message);
    return unavailable(source, 'adapter_error', 'This section failed to load.', {
      // Keep detail out of customer-facing text; the code is enough to trace.
      asOf: null,
      timeBasis: TIME_BASIS.LIVE_CURRENT,
    });
  }
}

function buildScores({ run, project, sections, aiOverall }) {
  const cats = {};
  const add = (key, value, source, asOf) => {
    const v = num(value);
    cats[key] = v === null
      ? { value: null, available: false, source }
      : { value: Math.round(v), available: true, source, asOf: asOf ?? null };
  };

  if (run) {
    // Snapshot scores only; a null in the run stays unavailable (not filled from live data).
    add('seoHealth', run.websiteScore ?? run.seoScore, 'audit_run', run.completedAt);
    add('performance', run.performanceScore, 'audit_run', run.completedAt);
    add('technicalHealth', run.technicalHealthScore, 'audit_run', run.completedAt);
    add('aiReadiness', run.aiVisibilityScore ?? run.overall_ai_score, 'audit_run', run.completedAt);
  } else {
    add('seoHealth', project?.website_score, 'live:project.website_score');
    add('performance', sections.pageSpeed?.data?.performanceScore, 'live:pageSpeed');
    add('technicalHealth', sections.technicalSeo?.data?.healthScore, 'live:technicalChecks');
    add('aiReadiness', aiOverall, 'live:ai_projects.overall_score');
  }

  const available = Object.entries(cats).filter(([, c]) => c.available);
  const overall = available.length
    ? Math.round(available.reduce((s, [, c]) => s + c.value, 0) / available.length)
    : null;

  return {
    categories: cats,
    overall: {
      value: overall,
      method: 'mean_of_available_categories',
      basis: available.map(([k]) => k),
      excluded: Object.keys(cats).filter((k) => !cats[k].available),
      complete: available.length === Object.keys(cats).length,
    },
  };
}

function importantFindings(sections) {
  const rank = { critical: 5, high: 4, medium: 3, warning: 3, low: 2, info: 1 };
  const all = [];
  for (const [key, label] of [['onPageSeo', 'On-page SEO'], ['accessibility', 'Accessibility']]) {
    for (const i of sections[key]?.data?.topIssues || []) {
      all.push({ module: label, ...i });
    }
  }
  return all
    .sort((a, b) => (rank[String(b.severity).toLowerCase()] || 0) - (rank[String(a.severity).toLowerCase()] || 0)
      || (b.pagesAffected || 0) - (a.pagesAffected || 0))
    .slice(0, 5);
}

export class CanonicalReportService {
  /**
   * @param {string} projectId
   * @param {object} opts
   * @param {number} [opts.auditNumber] request a specific run (default: latest)
   * @param {object} opts.deps  collaborators (see defaultReportDeps.js)
   */
  static async build(projectId, { auditNumber = null, deps } = {}) {
    if (!deps) throw new ReportError('Report dependencies are required', 500, 'NO_DEPS');
    const pid = String(projectId);

    const project = await deps.loadProject(pid);
    if (!project) throw new ReportError('Project not found', 404, 'PROJECT_NOT_FOUND');
    if (String(project._id) !== pid) {
      // Defence in depth against a mis-scoped loader.
      throw new ReportError('Project mismatch', 500, 'PROJECT_MISMATCH');
    }

    // ── Audit run selection ───────────────────────────────────────────────
    const latestRun = await deps.loadLatestRun(pid);
    let run = latestRun;
    if (auditNumber != null) {
      run = await deps.loadRunByNumber(pid, Number(auditNumber));
      if (!run) throw new ReportError(`Audit #${auditNumber} not found for this project`, 404, 'AUDIT_NOT_FOUND');
    }
    if (run && String(run.projectId) !== pid) {
      throw new ReportError('Audit run does not belong to this project', 500, 'RUN_PROJECT_MISMATCH');
    }

    const snap = resolveSnapshot({ project, run, latestRun, requestedAuditNumber: auditNumber });
    const ctx = { projectId: pid, project, run, liveRelation: snap.liveRelation };

    // ── Load everything once, in parallel ─────────────────────────────────
    const [issuesRes, onPage, accessibility, technical, pageSpeed, keywords, searchConsole, aeo, geo, aiso, progress, aiOverall] =
      await Promise.all([
        loadCanonicalIssues(ctx, deps).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })),
        safe('onPageIssuesService', () => onPageSeoAdapter(ctx, deps)),
        safe('accessibilityIssuesService', () => accessibilityAdapter(ctx, deps)),
        safe('technicalSeo', () => technicalSeoAdapter(ctx, deps)),
        safe('ProjectPerformanceService', () => pageSpeedAdapter(ctx, deps)),
        safe('SeoRankingCurrent', () => keywordsAdapter(ctx, deps)),
        safe('SearchConsoleData', () => searchConsoleAdapter(ctx, deps)),
        safe('aeo-hub', () => hubAdapter('AEO', 'getAEOHubData', 'aeo_score', 'aeo', 'getAEOHubIssues')(ctx, deps)),
        safe('geo-hub', () => hubAdapter('GEO', 'getGEOHubData', 'geo_score', 'geo', 'getGEOHubIssues')(ctx, deps)),
        safe('aiso-hub', () => hubAdapter('AISO', 'getAISOHubData', 'aiso_score', 'aiso', 'getAISOHubIssues')(ctx, deps)),
        safe('progress', () => progressAdapter(ctx, deps)),
        run ? Promise.resolve(null) : deps.loadAiOverallScore(pid).catch(() => null),
      ]);

    const sections = {
      onPageSeo: onPage,
      technicalSeo: technical,
      accessibility,
      pageSpeed,
      keywords,
      searchConsole,
      aeo,
      geo,
      aiso,
      progress,
      recommendations: null, // derived below from the other sections
    };

    sections.recommendations = await safe('recommendations', () => recommendationsAdapter(ctx, deps, sections));

    // ── Executive summary ─────────────────────────────────────────────────
    const pagesCrawled = num(run?.pagesCrawled) ?? num(project.pages_crawled);
    let issues;
    if (!issuesRes.ok) {
      issues = unavailable('IssueAggregationService', 'query_failed', 'Issue counts could not be loaded.', {
        timeBasis: TIME_BASIS.LIVE_CURRENT,
      });
    } else if (issuesRes.v.totalOpen === 0 && !run && !(pagesCrawled > 0)) {
      issues = unavailable('IssueAggregationService', 'no_audit_data', 'No audit has produced data for this project yet.', {
        timeBasis: TIME_BASIS.LIVE_CURRENT,
      });
    } else {
      issues = section(STATUS.AVAILABLE, {
        source: 'IssueAggregationService.getIssueSummary / getCategoryCounts',
        timeBasis: TIME_BASIS.LIVE_CURRENT,
        snapshotRelation: snap.liveRelation,
        data: issuesRes.v, // a genuine zero is a successful "available" result
      });
    }

    const scores = buildScores({ run, project, sections, aiOverall });
    sections.executiveSummary = section(STATUS.AVAILABLE, {
      source: run ? 'AuditRun + IssueAggregationService' : 'live project state + IssueAggregationService',
      asOf: run?.completedAt ?? project.last_analysis_at ?? null,
      timeBasis: run ? TIME_BASIS.AUDIT_SNAPSHOT : TIME_BASIS.LIVE_CURRENT,
      snapshotRelation: run ? 'within_run' : 'not_applicable',
      data: {
        scores,
        websiteGrade: run?.websiteGrade ?? project.website_grade ?? null,
        websiteGradeBasis: 'grade of the website (SEO) score, as stored by the scoring pipeline',
        issues,
        importantFindings: importantFindings(sections),
      },
    });

    // ── Integrity checks ──────────────────────────────────────────────────
    const warnings = [];
    if (snap.consistency !== 'aligned' && snap.consistency !== 'no_snapshot') warnings.push(snap.note);
    if (snap.consistency === 'no_snapshot') warnings.push(snap.note);
    const nonZero = (s) => s.status !== STATUS.UNAVAILABLE && s.status !== STATUS.NOT_CONFIGURED;
    let categoryParity = { checked: false };
    if (issues.status === STATUS.AVAILABLE && nonZero(onPage) && nonZero(accessibility)) {
      const sum = (onPage.data.totalIssues ?? 0) + (accessibility.data.totalIssues ?? 0);
      categoryParity = {
        checked: true,
        canonicalTotal: issues.data.totalOpen,
        onPagePlusAccessibility: sum,
        match: sum === issues.data.totalOpen,
        note: 'On-page (non-Accessibility) + Accessibility should equal the all-category canonical total; a difference means other categories exist or the data changed between queries.',
      };
      if (!categoryParity.match) warnings.push('On-page + accessibility totals differ from the canonical all-category total.');
    }

    // AuditRun stores its own issue total (project.total_issues basis). Report it next
    // to the canonical live count so any difference is visible rather than silent.
    let snapshotIssueTotal = { checked: false };
    if (run && issues.status === STATUS.AVAILABLE && num(run.totalIssues) !== null) {
      snapshotIssueTotal = {
        checked: true,
        auditRunTotal: num(run.totalIssues),
        canonicalTotal: issues.data.totalOpen,
        match: num(run.totalIssues) === issues.data.totalOpen,
        note: 'Runs captured before the fix stored the crawl-stage count (project.total_issues: distinct issue_code + page_url, which merges several findings on one page). The canonical total counts each finding separately (distinct dedup_key). Report issue counts use the canonical total.',
      };
      if (!snapshotIssueTotal.match && snap.consistency === 'aligned') {
        warnings.push('The stored audit-run issue total differs from the canonical live count (the stored value merges per-element findings on one page); the canonical count is reported.');
      }
    }

    const availability = {};
    for (const [k, v] of Object.entries(sections)) availability[k] = v.status;

    return {
      schemaVersion: REPORT_SCHEMA_VERSION,
      metadata: {
        projectId: pid,
        projectName: project.project_name ?? null,
        domain: extractDomain(project.main_url),
        audit: run
          ? {
              runId: String(run._id),
              auditNumber: run.auditNumber,
              startedAt: run.startedAt ?? null,
              completedAt: run.completedAt ?? null,
              source: run.source ?? null,
              isLatest: !!latestRun && String(latestRun._id) === String(run._id),
            }
          : null,
        auditDate: run?.completedAt ?? project.last_analysis_at ?? null,
        generatedAt: new Date().toISOString(),
        scoringVersion: run?.scoringVersion ?? null,
        aiScoringVersion: run?.aiScoringVersion ?? null,
        coverage: {
          pagesDiscovered: num(run?.pagesDiscovered),
          pagesCrawled,
          pagesAnalyzed: num(run?.pagesAnalyzed) ?? num(project.pages_analyzed),
        },
        snapshot: {
          source: snap.source,
          consistency: snap.consistency,
          note: snap.note,
          requestedAuditNumber: auditNumber,
          latestAuditNumber: latestRun?.auditNumber ?? null,
          projectAuditStartedAt: project.audit_started_at ?? null,
        },
      },
      sections,
      methodology: {
        overallScore:
          'Mean of the available category scores (SEO health, performance, technical health, AI readiness). Unavailable categories are excluded, never counted as 0. The category scores are produced by the existing scoring pipeline and are not recomputed here.',
        issueCounts:
          'Open issues, counted once per distinct dedup_key across all categories (IssueAggregationService), identical to the dashboard Overview. Critical bucket = critical + high severity; medium; low bucket = low + info.',
        aiReadiness:
          'AEO, GEO and AISO are on-site readiness assessments. Odito does not query AI platforms; no citation, mention or platform-ranking data is included.',
        timeSemantics:
          'Scores come from the selected audit run. Issues, PageSpeed, technical and AI-hub data reflect the current project state (see snapshot.consistency). Keyword rankings carry their own scan timestamps. Search Console data is a separate reporting period.',
      },
      availability,
      integrity: { warnings, categoryParity, snapshotIssueTotal },
    };
  }
}

export default CanonicalReportService;
