import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import { CanonicalReportService, ReportError, resolveSnapshot } from './canonicalReportService.js';
import { REPORT_SCHEMA_VERSION, STATUS } from './reportContract.js';

// ── Fake collaborators ───────────────────────────────────────────────────────

const PID = '64b000000000000000000001';
const OTHER = '64b000000000000000000002';
const T0 = new Date('2026-05-01T10:00:00Z');
const T1 = new Date('2026-05-01T10:30:00Z');

const baseProject = {
  _id: PID,
  user_id: 'u1',
  project_name: 'Acme',
  main_url: 'https://www.acme.test/',
  website_score: 71,
  website_grade: 'B',
  audit_started_at: T0,
  pages_crawled: 40,
  pages_analyzed: 38,
};

const run = (over = {}) => ({
  _id: 'run2', projectId: PID, auditNumber: 2, startedAt: T0, completedAt: T1,
  websiteScore: 80, performanceScore: 60, technicalHealthScore: 70, aiVisibilityScore: 50,
  websiteGrade: 'B+', pagesCrawled: 40, pagesAnalyzed: 38, scoringVersion: '1.1', aiScoringVersion: 'v2',
  ...over,
});

const hubOk = (key, score) => async (req, res) =>
  res.json({ success: true, data: { [key]: score, job_id: 'j1', pages_scored: 10, computed_at: new Date('2026-05-01T10:10:00Z') } });
const hubNotRun = async (req, res) => res.json({ success: true, data: null });

function makeDeps(over = {}) {
  const calls = [];
  const rec = (name, fn) => async (...a) => { calls.push([name, a[0]]); return fn(...a); };
  const deps = {
    loadProject: rec('loadProject', async () => ({ ...baseProject })),
    loadLatestRun: rec('loadLatestRun', async () => run()),
    loadRunByNumber: rec('loadRunByNumber', async (p, n) => (n === 2 ? run() : n === 1 ? run({ _id: 'run1', auditNumber: 1, websiteScore: 55, performanceScore: 40, technicalHealthScore: 50, aiVisibilityScore: null, startedAt: new Date('2026-04-01T10:00:00Z'), completedAt: new Date('2026-04-01T10:30:00Z') }) : null)),
    issues: {
      getIssueSummary: rec('getIssueSummary', async () => ({ totalIssues: 12, critical: 3, warnings: 5, informational: 4, resolved: 2 })),
      getCategoryCounts: rec('getCategoryCounts', async () => [{ category: 'Meta', count: 7 }, { category: 'Accessibility', count: 5 }]),
    },
    getOnPageIssues: rec('getOnPageIssues', async () => ({
      issues: [
        { issue_code: 'TITLE_MISSING', title: 'Title missing', severity: 'high', category: 'Meta', pages_affected: 4 },
        { issue_code: 'H1_MULTI', title: 'Multiple H1', severity: 'low', category: 'Meta', pages_affected: 3 },
      ],
      summary: { total_issue_types: 2, total_issues_found: 7, total_pages_analyzed: 38 },
    })),
    getIssueUrls: rec('getIssueUrls', async (p, code) => [{ url: `https://acme.test/${code}`, detected_value: 'x' }]),
    getAccessibilityIssues: rec('getAccessibilityIssues', async () => ({
      issues: [{ issue_code: 'ALT', title: 'Alt', severity: 'medium', pages_affected: 5 }],
      summary: { total_issue_types: 1, total_issues_found: 5, total_pages_analyzed: 38 },
    })),
    getTechnicalChecks: rec('getTechnicalChecks', async () => ({ success: true, data: { checks: [{ name: 'SSL', status: 'PASS' }], summary: { healthScore: 70 } } })),
    getCrawlability: rec('getCrawlability', async () => ({ metrics: { totalPages: 40, indexedPages: 38, blockedPages: 2, indexRate: 95 }, blockedReasons: [] })),
    getStructuredData: rec('getStructuredData', async () => ({ success: true, data: { withSchema: 30, withoutSchema: 10, coverage: 75, errors: 1, schemaTypes: [] } })),
    getProjectPerformance: rec('getProjectPerformance', async () => ({
      success: true,
      data: {
        summary: { performanceScore: 60 },
        mobile: { performance_score: 55, metrics: { lcp: { value: 3.1 }, cls: { value: 0 } }, opportunities: [{ id: 'unused-js' }] },
        desktop: { performance_score: 75, metrics: { lcp: { value: 1.2 } }, opportunities: [] },
      },
    })),
    loadCurrentRankings: rec('loadCurrentRankings', async () => ({
      location: 'Austin', country: 'US', seo_scope: 'local', last_scanned_at: new Date('2026-05-02T00:00:00Z'),
      keywords: [
        { keyword: 'a', current_rank: 2, prev_scan_rank: 4, best_rank: 2, last_scan_status: 'ok' },
        { keyword: 'b', current_rank: null, last_scan_status: 'ok' },
        { keyword: 'c', current_rank: null, last_scan_status: 'error' },
      ],
    })),
    deriveHistoricalRanks: rec('deriveHistoricalRanks', async () => ({ weekByKeyword: new Map([['a', 5]]), monthByKeyword: new Map() })),
    loadLegacyRankings: rec('loadLegacyRankings', async () => null),
    findSearchConsoleConnection: rec('findSearchConsoleConnection', async () => null),
    getSearchConsoleAggregates: rec('getSearchConsoleAggregates', async () => ({})),
    hubHandlers: { getAEOHubData: hubOk('aeo_score', 64), getGEOHubData: hubOk('geo_score', 48), getAISOHubData: hubOk('aiso_score', 72) },
    loadAiOverallScore: rec('loadAiOverallScore', async () => 55),
    countTasksByStatus: rec('countTasksByStatus', async () => ({ verified_fixed: 2, task_created: 3 })),
    compareLatest: rec('compareLatest', async () => ({ available: false, reason: 'only_one_audit' })),
    ...over,
  };
  deps.calls = calls;
  return deps;
}

const build = (over, opts = {}) => CanonicalReportService.build(PID, { deps: makeDeps(over), ...opts });

// ── Unit tests (no database) ─────────────────────────────────────────────────

describe('canonical report: fully populated audit', () => {
  test('returns a versioned payload with every supported section available', async () => {
    const r = await build();
    assert.equal(r.schemaVersion, REPORT_SCHEMA_VERSION);
    assert.equal(r.metadata.domain, 'acme.test');
    assert.equal(r.metadata.audit.auditNumber, 2);
    assert.equal(r.metadata.snapshot.consistency, 'aligned');
    for (const k of ['executiveSummary', 'onPageSeo', 'technicalSeo', 'accessibility', 'pageSpeed', 'keywords', 'aeo', 'geo', 'aiso']) {
      assert.equal(r.sections[k].status, STATUS.AVAILABLE, k);
    }
    assert.equal(r.sections.searchConsole.status, STATUS.NOT_CONFIGURED);
    assert.notEqual(r.sections.recommendations.status, STATUS.UNAVAILABLE);
    assert.deepEqual(Object.keys(r.availability).sort(), Object.keys(r.sections).sort());
  });

  test('scores come from the selected audit run and the overall is the mean of the available ones', async () => {
    const r = await build();
    const s = r.sections.executiveSummary.data.scores;
    assert.equal(s.categories.seoHealth.value, 80);
    assert.equal(s.categories.seoHealth.source, 'audit_run');
    assert.equal(s.overall.value, Math.round((80 + 60 + 70 + 50) / 4));
    assert.equal(s.overall.complete, true);
  });

  test('issue counts are the canonical aggregation output', async () => {
    const deps = makeDeps();
    const r = await CanonicalReportService.build(PID, { deps });
    const i = r.sections.executiveSummary.data.issues.data;
    assert.equal(i.totalOpen, 12);
    assert.deepEqual(i.bySeverity, { critical: 3, medium: 5, low: 4 });
    assert.equal(deps.calls.filter(([n]) => n === 'getIssueSummary').length, 1, 'issue summary is queried once');
  });

  test('every adapter is scoped to the requested project', async () => {
    const deps = makeDeps();
    await CanonicalReportService.build(PID, { deps });
    const ids = deps.calls.map(([, a]) => (a && a._id) || a).filter((a) => typeof a === 'string' && a.startsWith('64b'));
    assert.ok(ids.length > 5);
    assert.ok(ids.every((id) => id === PID));
  });
});

describe('canonical report: issue states', () => {
  test('a completed audit with zero issues is available, not unavailable', async () => {
    const r = await build({ issues: { getIssueSummary: async () => ({ totalIssues: 0, critical: 0, warnings: 0, informational: 0, resolved: 0 }), getCategoryCounts: async () => [] } });
    const issues = r.sections.executiveSummary.data.issues;
    assert.equal(issues.status, STATUS.AVAILABLE);
    assert.equal(issues.data.totalOpen, 0);
  });

  test('zero issues with no audit run and no crawled pages is "no_audit_data", not a clean bill of health', async () => {
    const r = await build({
      loadLatestRun: async () => null,
      loadProject: async () => ({ ...baseProject, pages_crawled: 0, website_score: undefined }),
      issues: { getIssueSummary: async () => ({ totalIssues: 0, critical: 0, warnings: 0, informational: 0, resolved: 0 }), getCategoryCounts: async () => [] },
    });
    const issues = r.sections.executiveSummary.data.issues;
    assert.equal(issues.status, STATUS.UNAVAILABLE);
    assert.equal(issues.reason, 'no_audit_data');
    assert.equal(issues.data, null);
  });

  test('a failed issue query is "query_failed" and never zero counts; other sections still return', async () => {
    const r = await build({ issues: { getIssueSummary: async () => { throw new Error('db down'); }, getCategoryCounts: async () => [] } });
    const issues = r.sections.executiveSummary.data.issues;
    assert.equal(issues.status, STATUS.UNAVAILABLE);
    assert.equal(issues.reason, 'query_failed');
    assert.equal(issues.data, null);
    assert.equal(r.sections.pageSpeed.status, STATUS.AVAILABLE);
  });

  test('canonical total vs on-page + accessibility parity is reported', async () => {
    const r = await build(); // 7 + 5 = 12
    assert.equal(r.integrity.categoryParity.checked, true);
    assert.equal(r.integrity.categoryParity.match, true);
    const bad = await build({ getAccessibilityIssues: async () => ({ issues: [], summary: { total_issues_found: 1 } }) });
    assert.equal(bad.integrity.categoryParity.match, false);
    assert.ok(bad.integrity.warnings.length > 0);
  });
});

describe('canonical report: scores and partial failure', () => {
  test('a null category score is excluded from the overall, never counted as 0', async () => {
    const r = await build({ loadLatestRun: async () => run({ performanceScore: null, aiVisibilityScore: null, overall_ai_score: null }) });
    const s = r.sections.executiveSummary.data.scores;
    assert.equal(s.categories.performance.value, null);
    assert.equal(s.categories.performance.available, false);
    assert.equal(s.overall.value, Math.round((80 + 70) / 2));
    assert.deepEqual(s.overall.excluded.sort(), ['aiReadiness', 'performance']);
    assert.equal(s.overall.complete, false);
  });

  test('no available scores gives a null overall', async () => {
    const r = await build({ loadLatestRun: async () => run({ websiteScore: null, seoScore: null, performanceScore: null, technicalHealthScore: null, aiVisibilityScore: null }) });
    assert.equal(r.sections.executiveSummary.data.scores.overall.value, null);
  });

  test('one failing module does not prevent the others from being returned', async () => {
    const r = await build({
      getOnPageIssues: async () => { throw new Error('boom'); },
      getTechnicalChecks: async () => { throw new Error('boom'); },
    });
    assert.equal(r.sections.onPageSeo.status, STATUS.UNAVAILABLE);
    assert.equal(r.sections.onPageSeo.reason, 'adapter_error');
    assert.equal(r.sections.technicalSeo.status, STATUS.PARTIAL); // crawlability + structured data still present
    assert.ok(r.sections.technicalSeo.data.unavailableParts.includes('technicalChecks'));
    assert.equal(r.sections.keywords.status, STATUS.AVAILABLE);
  });

  test('when every technical source fails the section is unavailable', async () => {
    const r = await build({
      getTechnicalChecks: async () => { throw new Error('x'); },
      getCrawlability: async () => { throw new Error('x'); },
      getStructuredData: async () => { throw new Error('x'); },
    });
    assert.equal(r.sections.technicalSeo.status, STATUS.UNAVAILABLE);
  });

  test('without an audit run, scores fall back to live sources and say so', async () => {
    const r = await build({ loadLatestRun: async () => null });
    const c = r.sections.executiveSummary.data.scores.categories;
    assert.equal(r.metadata.snapshot.consistency, 'no_snapshot');
    assert.equal(c.seoHealth.source, 'live:project.website_score');
    assert.equal(c.aiReadiness.value, 55);
  });
});

describe('canonical report: PageSpeed', () => {
  test('missing PageSpeed data is unavailable and carries no zero scores', async () => {
    const r = await build({ getProjectPerformance: async () => ({ success: true, data: { mobile: null, desktop: null, summary: { performanceScore: 0, mobileScore: 0, desktopScore: 0 }, message: 'No PageSpeed data available.' } }) });
    assert.equal(r.sections.pageSpeed.status, STATUS.UNAVAILABLE);
    assert.equal(r.sections.pageSpeed.reason, 'no_data');
    assert.equal(r.sections.pageSpeed.data, null);
  });

  test('a device with defaulted zero scores and no metrics is "not measured", and the section is partial', async () => {
    const r = await build({ getProjectPerformance: async () => ({ success: true, data: { summary: { performanceScore: 55 }, mobile: { performance_score: 55, metrics: { lcp: { value: 2 } } }, desktop: { performance_score: 0, accessibility_score: 0, metrics: {} } } }) });
    assert.equal(r.sections.pageSpeed.status, STATUS.PARTIAL);
    assert.equal(r.sections.pageSpeed.data.desktop, null);
    assert.equal(r.sections.pageSpeed.data.mobile.scores.performance, 55);
  });

  test('real opportunities are passed through; a measured zero (CLS) is kept, an unmeasured value is null', async () => {
    const r = await build();
    const m = r.sections.pageSpeed.data.mobile;
    assert.deepEqual(m.opportunities, [{ id: 'unused-js' }]);
    assert.equal(m.coreWebVitals.cls, 0);
    assert.equal(m.coreWebVitals.tbt, null);
    assert.equal(m.coreWebVitals.ttfb, null);
  });
});

describe('canonical report: keywords and Search Console', () => {
  test('current rankings: scan errors are unknown (not "not ranking") and history is attached', async () => {
    const r = await build();
    const k = r.sections.keywords.data;
    assert.equal(k.origin, 'seo_rankings_current');
    assert.deepEqual(k.summary, { tracked: 3, ranking: 1, notInTop100: 1, scanErrors: 1, top3: 1, top10: 1, rank11to20: 0, rank21to100: 0 });
    const c = k.keywords.find((x) => x.keyword === 'c');
    assert.equal(c.rankState, 'scan_error');
    assert.equal(c.currentRank, null);
    assert.equal(k.keywords.find((x) => x.keyword === 'a').previousWeekRank, 5);
    assert.equal(r.sections.keywords.timeBasis, 'point_in_time');
  });

  test('legacy ranking data is used only when no current document exists, and is flagged partial', async () => {
    const legacy = { created_at: new Date('2026-01-01'), keywords: [{ keyword: 'old', rank: 9 }, { keyword: 'x', rank: null }] };
    const only = await build({ loadCurrentRankings: async () => null, loadLegacyRankings: async () => legacy });
    assert.equal(only.sections.keywords.status, STATUS.PARTIAL);
    assert.equal(only.sections.keywords.reason, 'legacy_source');
    assert.equal(only.sections.keywords.data.origin, 'seo_rankings_legacy');

    const deps = makeDeps({ loadLegacyRankings: async () => legacy });
    const both = await CanonicalReportService.build(PID, { deps });
    assert.equal(both.sections.keywords.data.origin, 'seo_rankings_current');
    assert.equal(deps.calls.some(([n]) => n === 'loadLegacyRankings'), false, 'legacy is not consulted when a current document exists');
  });

  test('no rankings at all is unavailable', async () => {
    const r = await build({ loadCurrentRankings: async () => null });
    assert.equal(r.sections.keywords.status, STATUS.UNAVAILABLE);
  });

  test('history failure degrades keywords to partial but keeps current ranks', async () => {
    const r = await build({ deriveHistoricalRanks: async () => { throw new Error('x'); } });
    assert.equal(r.sections.keywords.status, STATUS.PARTIAL);
    assert.equal(r.sections.keywords.data.summary.tracked, 3);
  });

  test('Search Console: not connected -> not_configured; connected without data -> unavailable; with data -> available and separate', async () => {
    const none = await build();
    assert.equal(none.sections.searchConsole.status, STATUS.NOT_CONFIGURED);
    assert.equal(none.sections.searchConsole.data, null);

    const conn = { service_type: ['search_console'] };
    const empty = await build({ findSearchConsoleConnection: async () => conn, getSearchConsoleAggregates: async () => ({ page_count: 0 }) });
    assert.equal(empty.sections.searchConsole.status, STATUS.UNAVAILABLE);
    assert.equal(empty.sections.searchConsole.reason, 'no_synced_data');

    const ok = await build({ findSearchConsoleConnection: async () => conn, getSearchConsoleAggregates: async () => ({ page_count: 9, totalClicks: 100, totalImpressions: 4000, avgCtr: 0.025, avgPosition: 12.4, lastFetched: T1 }) });
    assert.equal(ok.sections.searchConsole.status, STATUS.AVAILABLE);
    assert.equal(ok.sections.searchConsole.timeBasis, 'reporting_period');
    assert.equal(ok.sections.searchConsole.data.totalClicks, 100);
  });
});

describe('canonical report: AEO / GEO / AISO', () => {
  test('hubs that have not run are unavailable with reason not_run', async () => {
    const r = await build({ hubHandlers: { getAEOHubData: hubNotRun, getGEOHubData: hubNotRun, getAISOHubData: hubNotRun } });
    for (const k of ['aeo', 'geo', 'aiso']) {
      assert.equal(r.sections[k].status, STATUS.UNAVAILABLE);
      assert.equal(r.sections[k].reason, 'not_run');
    }
  });

  test('a failing hub handler is query_failed without affecting the others', async () => {
    const r = await build({ hubHandlers: { getAEOHubData: async (req, res) => res.status(500).json({ success: false }), getGEOHubData: hubOk('geo_score', 48), getAISOHubData: hubOk('aiso_score', 72) } });
    assert.equal(r.sections.aeo.reason, 'query_failed');
    assert.equal(r.sections.geo.data.score, 48);
  });

  test('readiness scores are labelled as on-site readiness and no AI-platform citation data exists in the payload', async () => {
    const r = await build();
    assert.equal(r.sections.aiso.data.score, 72);
    assert.match(r.sections.aeo.data.interpretation, /not measured AI-platform citations/);
    assert.match(r.methodology.aiReadiness, /does not query AI platforms/);
    const json = JSON.stringify(r);
    for (const banned of ['citationRate', 'chatgpt', 'perplexity', 'mentionCount', 'industryAverage']) {
      assert.equal(json.toLowerCase().includes(banned.toLowerCase()), false, banned);
    }
  });

  test('a missing hub score is partial, never 0', async () => {
    const r = await build({ hubHandlers: { getAEOHubData: async (req, res) => res.json({ success: true, data: { job_id: 'j' } }), getGEOHubData: hubNotRun, getAISOHubData: hubNotRun } });
    assert.equal(r.sections.aeo.status, STATUS.PARTIAL);
    assert.equal(r.sections.aeo.data.score, null);
  });
});

describe('canonical report: audit runs and project scoping', () => {
  test('a historical run uses that run\'s scores and flags live modules', async () => {
    const r = await build({}, { auditNumber: 1 });
    assert.equal(r.metadata.audit.auditNumber, 1);
    assert.equal(r.metadata.audit.isLatest, false);
    assert.equal(r.metadata.snapshot.consistency, 'historical_run_with_live_modules');
    assert.equal(r.sections.executiveSummary.data.scores.categories.seoHealth.value, 55);
    assert.equal(r.sections.executiveSummary.data.scores.categories.aiReadiness.available, false); // null in run 1
    assert.equal(r.sections.onPageSeo.snapshotRelation, 'after_run');
    assert.ok(r.integrity.warnings.length > 0);
  });

  test('an unknown audit number is a 404', async () => {
    await assert.rejects(() => build({}, { auditNumber: 99 }), (e) => e instanceof ReportError && e.statusCode === 404 && e.code === 'AUDIT_NOT_FOUND');
  });

  test('live data newer than the captured run is flagged', async () => {
    const r = await build({ loadProject: async () => ({ ...baseProject, audit_started_at: new Date('2026-05-03T00:00:00Z') }) });
    assert.equal(r.metadata.snapshot.consistency, 'live_newer_than_snapshot');
    assert.equal(r.sections.onPageSeo.snapshotRelation, 'after_run');
  });

  test('resolveSnapshot: aligned / no snapshot', () => {
    assert.equal(resolveSnapshot({ project: baseProject, run: run(), latestRun: run(), requestedAuditNumber: null }).consistency, 'aligned');
    assert.equal(resolveSnapshot({ project: baseProject, run: null, latestRun: null, requestedAuditNumber: null }).consistency, 'no_snapshot');
  });

  test('a run that belongs to another project is rejected', async () => {
    await assert.rejects(() => build({ loadLatestRun: async () => run({ projectId: OTHER }) }), (e) => e.code === 'RUN_PROJECT_MISMATCH');
  });

  test('a loader that returns another project\'s document is rejected', async () => {
    await assert.rejects(() => build({ loadProject: async () => ({ ...baseProject, _id: OTHER }) }), (e) => e.code === 'PROJECT_MISMATCH');
  });

  test('a missing or deleted project is a 404', async () => {
    await assert.rejects(() => build({ loadProject: async () => null }), (e) => e.statusCode === 404);
  });
});

describe('canonical report: progress', () => {
  test('task counts and comparison availability are reported with their scope', async () => {
    const r = await build();
    const p = r.sections.progress;
    assert.equal(p.status, STATUS.AVAILABLE);
    assert.equal(p.data.tasks.byStatus.verified_fixed, 2);
    assert.equal(p.data.tasks.total, 5);
    assert.deepEqual(p.data.comparison, { available: false, reason: 'only_one_audit' });
    assert.match(p.data.scope, /not run-scoped/);
  });

  test('both sources failing makes progress unavailable', async () => {
    const r = await build({ countTasksByStatus: async () => { throw new Error('x'); }, compareLatest: async () => { throw new Error('x'); } });
    assert.equal(r.sections.progress.status, STATUS.UNAVAILABLE);
  });
});

// ── Integration tests against the real canonical aggregation (local MongoDB) ─

let mongoAvailable = false;
before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch {
    mongoAvailable = false;
  }
});
after(async () => {
  if (mongoAvailable) await mongoose.connection.close();
});

describe('dashboard parity and ownership (requires local MongoDB)', () => {
  test('report issue counts equal the dashboard IssueCountsService for resolved issues and mixed categories (duplicate dedup_keys cannot exist: unique index)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { IssueCountsService } = await import('../../app_user/service/issueCounts.service.js');
    const { default: IssueAggregationService } = await import('../../../services/issueAggregationService.js');
    const { PDFAggregationService } = await import('../service/pdfAggregationService.js');

    const pid = new mongoose.Types.ObjectId();
    const col = mongoose.connection.db.collection('seo_page_issues');
    // dedup_key has a collection-wide unique index, so keys must be globally unique.
    const doc = (dk, severity, status, category) => ({ projectId: pid, dedup_key: `${pid}-${dk}`, issue_code: 'X', page_url: `https://t.test/${dk}`, severity, status, category });
    try {
      await col.insertMany([
        doc('a', 'critical', 'open', 'Meta'),
        doc('b', 'high', 'open', 'Meta'),
        doc('c', 'medium', 'open', 'Content'),
        doc('d', 'low', 'open', 'Accessibility'),
        doc('e', 'info', 'open', 'Accessibility'),
        doc('f', 'high', 'resolved', 'Meta'), // resolved: excluded
      ]);

      const dashboard = (await IssueCountsService.getIssueCounts(String(pid))).data;

      const deps = makeDeps({
        loadProject: async () => ({ ...baseProject, _id: String(pid) }),
        loadLatestRun: async () => run({ projectId: String(pid) }),
        issues: IssueAggregationService,
      });
      const report = await CanonicalReportService.build(String(pid), { deps });
      const i = report.sections.executiveSummary.data.issues.data;
      assert.equal(i.totalOpen, dashboard.totalIssues);
      assert.equal(i.bySeverity.critical, dashboard.critical);
      assert.equal(i.bySeverity.medium, dashboard.warnings);
      assert.equal(i.bySeverity.low, dashboard.informational);
      assert.equal(i.resolved, dashboard.passed);
      assert.equal(dashboard.totalIssues, 5);
      assert.equal(dashboard.critical, 2);

      // The existing Executive Summary endpoint's counts now come from the same source.
      const exec = await PDFAggregationService.getOnPageIssueCounts(String(pid));
      assert.deepEqual(exec, { totalIssues: 5, critical: 2, warnings: 1, informational: 2 });
    } finally {
      await col.deleteMany({ projectId: pid });
    }
  });

  test('a user cannot build or access another user\'s project report (validateProjectAccess)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { AuthMiddleware } = await import('../../../middleware/auth.middleware.js');
    const projects = mongoose.connection.db.collection('seoprojects');
    const owner = new mongoose.Types.ObjectId();
    const intruder = new mongoose.Types.ObjectId();
    const _id = new mongoose.Types.ObjectId();
    await projects.insertOne({ _id, user_id: owner, project_name: 'x', main_url: 'https://x.test' });
    try {
      const run = async (userId) => {
        let status = null;
        let nextCalled = false;
        const res = { status(c) { status = c; return res; }, json() { return res; } };
        await AuthMiddleware.validateProjectAccess()({ user: { id: String(userId) }, params: { projectId: String(_id) }, body: {}, query: {}, path: '/report', method: 'GET' }, res, () => { nextCalled = true; });
        return { status, nextCalled };
      };
      assert.deepEqual(await run(intruder), { status: 403, nextCalled: false });
      assert.deepEqual(await run(owner), { status: null, nextCalled: true });
    } finally {
      await projects.deleteOne({ _id });
    }
  });
});

// ── Phase 2 contract corrections ─────────────────────────────────────────────

describe('canonical report: verified service shapes (Phase 2)', () => {
  const realChecks = [
    { id: 'ssl_certificate', name: 'SSL Certificate', status: 'OK', severity: 'none', affected_pages: 0, impact_percentage: 0, impact_basis: 'severity_tier', difficulty: 'easy', message: 'SSL certificate is valid' },
    { id: 'security_headers', name: 'Security Headers', status: 'Critical', severity: 'high', affected_pages: 35, impact_percentage: 100, impact_basis: 'pages_affected_ratio', difficulty: 'hard', message: '35 pages missing critical security headers' },
  ];

  test('technical checks are mapped from the real TechnicalChecksService fields', async () => {
    const r = await build({ getTechnicalChecks: async () => ({ success: true, data: { checks: realChecks, summary: { total: 2, passed: 1, warnings: 0, critical: 1, healthScore: 50 } } }) });
    const c = r.sections.technicalSeo.data.checks;
    assert.deepEqual(c[1], {
      id: 'security_headers', name: 'Security Headers', status: 'Critical', severity: 'high',
      affectedPages: 35, impactPercentage: 100, impactBasis: 'pages_affected_ratio', difficulty: 'hard',
      message: '35 pages missing critical security headers',
    });
    assert.equal(c[0].impactBasis, 'severity_tier'); // tier weight, not a % of pages
    assert.equal(r.sections.technicalSeo.data.healthScore, 50);
  });

  test('an empty checks list yields a null health score, not the service\'s 0', async () => {
    const r = await build({ getTechnicalChecks: async () => ({ success: true, data: { checks: [], summary: { healthScore: 0 } } }) });
    assert.equal(r.sections.technicalSeo.data.healthScore, null);
  });

  test('Search Console fields state their aggregation and the section is separate from keywords', async () => {
    const conn = { service_type: ['search_console'] };
    const r = await build({ findSearchConsoleConnection: async () => conn, getSearchConsoleAggregates: async () => ({ page_count: 9, totalClicks: 100, totalImpressions: 4000, avgCtr: 0.025, avgPosition: 12.4, lastFetched: T1 }) });
    const d = r.sections.searchConsole.data;
    assert.equal(d.averageCtrAcrossPages, 0.025);
    assert.equal(d.averagePositionAcrossPages, 12.4);
    assert.equal(d.avgCtr, undefined);
    assert.match(d.aggregation, /unweighted means of per-page values/);
    assert.equal(r.sections.keywords.data.origin, 'seo_rankings_current');
    assert.equal(JSON.stringify(r.sections.keywords).includes('totalClicks'), false);
  });

  test('not_configured / unavailable sections have no snapshot relation', async () => {
    const r = await build();
    assert.equal(r.sections.searchConsole.snapshotRelation, 'not_applicable');
  });

  test('a differing AuditRun issue total is reported next to the canonical count, which is the one used', async () => {
    const r = await build({ loadLatestRun: async () => run({ totalIssues: 9 }) });
    assert.equal(r.integrity.snapshotIssueTotal.match, false);
    assert.equal(r.integrity.snapshotIssueTotal.canonicalTotal, 12);
    assert.equal(r.sections.executiveSummary.data.issues.data.totalOpen, 12);
    assert.ok(r.integrity.warnings.some((w) => /stored audit-run issue total/.test(w)));

    const same = await build({ loadLatestRun: async () => run({ totalIssues: 12 }) });
    assert.equal(same.integrity.snapshotIssueTotal.match, true);
    assert.equal(same.integrity.warnings.length, 0);
  });

  test('progress comparison carries deltas, not raw run documents', async () => {
    const r = await build({ compareLatest: async () => ({ available: true, current: { auditNumber: 2, completedAt: T1, websiteScore: 80, secret: 'x' }, previous: { auditNumber: 1, completedAt: T0, websiteScore: 70 }, delta: { websiteScore: { change: 10 } } }) });
    const c = r.sections.progress.data.comparison;
    assert.deepEqual(Object.keys(c).sort(), ['available', 'currentAuditNumber', 'currentCompletedAt', 'delta', 'previousAuditNumber', 'previousCompletedAt', 'scope']);
    assert.equal(JSON.stringify(r).includes('secret'), false);
  });

  test('on-page top issues carry data path, occurrences and difficulty from the dashboard service', async () => {
    const r = await build({ getOnPageIssues: async () => ({ issues: [{ issue_code: 'X', title: 'T', severity: 'high', category: 'c', data_path: 'a.b', pages_affected: 2, total_occurrences: 2, impact_percentage: 5, difficulty: 'easy' }], summary: { total_issues_found: 2, total_issue_types: 1, total_pages_analyzed: 40 } }) });
    assert.deepEqual(r.sections.onPageSeo.data.topIssues[0], { issueCode: 'X', title: 'T', severity: 'high', category: 'c', dataPath: 'a.b', pagesAffected: 2, occurrences: 2, impactPercentage: 5, difficulty: 'easy' });
  });
});
