import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { CanonicalReportService } from './canonicalReportService.js';
import { STATUS } from './reportContract.js';

const PID = '64b000000000000000000001';
const T0 = new Date('2026-05-01T10:00:00Z');
const T1 = new Date('2026-05-01T10:30:00Z');

const project = { _id: PID, user_id: 'u1', project_name: 'Acme', main_url: 'https://www.acme.test/', website_score: 71, audit_started_at: T0, pages_crawled: 40 };
const run = { _id: 'r2', projectId: PID, auditNumber: 2, startedAt: T0, completedAt: T1, websiteScore: 80, performanceScore: 60, technicalHealthScore: 70, aiVisibilityScore: 50 };

const notRun = async (req, res) => res.json({ success: true, data: null });
const ok = (key, score) => async (req, res) => res.json({ success: true, data: { job_id: 'j', pages_scored: 10, computed_at: T1, [key]: score } });

const aeoFull = async (req, res) => res.json({ success: true, data: {
  job_id: 'j', pages_scored: 10, computed_at: T1, aeo_score: 31,
  cards: { faq_coverage: { score: 0, rule_count: 0, total_failed: 14, status: 'CRITICAL' } },
  signals: { direct_answer: { rule_id: 'AEO-046', pages_failing: 22, applicable_pages: 28, score: 21, status: 'fail' } },
  structure: { question_coverage: { total_h2_sum: 442, question_h2_sum: 42 } },
  issue_distribution: { total: 5, critical: 1, high: 1, medium: 2, low: 1 },
  faq_opportunities: [{ question: 'Q?', status: 'missing_schema', recommendation: 'Add FAQ schema', impact: 'high', affected_url_count: 3 }],
  huge_raw_blob: 'x'.repeat(50000),
} });
const aeoIssues = async (req, res) => res.json({ success: true, data: { issues: [
  { rule_id: 'AEO-054', card: 'snippet_score', issue_title: 'No sources cited', issue_description: 'desc', recommendation: 'Cite sources.', severity: 'medium', pages_affected: 28, affected_urls: ['https://a/1', 'https://a/2'] },
  { rule_id: 'AEO-001', card: 'answer_readiness', issue_title: 'Critical thing', issue_description: 'd', recommendation: 'Fix it.', severity: 'high', pages_affected: 3, affected_urls: [] },
] } });

function deps(over = {}) {
  return {
    loadProject: async () => ({ ...project }),
    loadLatestRun: async () => ({ ...run }),
    loadRunByNumber: async () => null,
    issues: {
      getIssueSummary: async () => ({ totalIssues: 12, critical: 3, warnings: 5, informational: 4, resolved: 2 }),
      getCategoryCounts: async () => [],
    },
    getOnPageIssues: async () => ({
      issues: [
        { issue_code: 'TITLE_MISSING', title: 'Title missing', severity: 'high', category: 'Meta', pages_affected: 4, impact_percentage: 10, difficulty: 'easy' },
        { issue_code: 'H1_MULTI', title: 'Multiple H1', severity: 'low', category: 'Meta', pages_affected: 3, impact_percentage: 7, difficulty: 'easy' },
      ],
      summary: { total_issue_types: 2, total_issues_found: 7, total_pages_analyzed: 38 },
    }),
    getIssueUrls: async (p, code) => [{ url: `https://acme.test/${code}`, detected_value: 'x' }],
    getAccessibilityIssues: async () => ({ issues: [], summary: { total_issues_found: 0, total_issue_types: 0, total_pages_analyzed: 38 } }),
    getTechnicalChecks: async () => ({ success: true, data: { checks: [{ name: 'SSL', status: 'OK' }], summary: { healthScore: 100 } } }),
    getCrawlability: async () => ({ metrics: { totalPages: 40, indexedPages: 40, blockedPages: 0, indexRate: 100 }, blockedReasons: [] }),
    getStructuredData: async () => ({ success: true, data: { withSchema: 30, withoutSchema: 10, coverage: 75, errors: 0, schemaTypes: [] } }),
    getProjectPerformance: async () => ({ success: true, data: { summary: { performanceScore: 60 }, mobile: { performance_score: 55, metrics: { lcp: { value: 3 } } }, desktop: null } }),
    loadCurrentRankings: async () => null,
    deriveHistoricalRanks: async () => ({ weekByKeyword: new Map(), monthByKeyword: new Map() }),
    loadLegacyRankings: async () => null,
    findSearchConsoleConnection: async () => null,
    getSearchConsoleAggregates: async () => ({}),
    hubHandlers: { getAEOHubData: aeoFull, getAEOHubIssues: aeoIssues, getGEOHubData: notRun, getAISOHubData: notRun },
    loadIssueGuidance: async () => new Map([['TITLE_MISSING', { recommendation: 'Add a unique title tag.', impact: 'Titles are the main search snippet.', expected: null }]]),
    loadAiOverallScore: async () => 55,
    countTasksByStatus: async () => ({}),
    compareLatest: async () => ({ available: false, reason: 'only_one_audit' }),
    ...over,
  };
}
const build = (over) => CanonicalReportService.build(PID, { deps: deps(over) });

describe('hub view models', () => {
  test('trimmed view model: no raw blobs, rule findings sorted by severity', async () => {
    const r = await build();
    const aeo = r.sections.aeo;
    assert.equal(aeo.status, STATUS.AVAILABLE);
    assert.equal(aeo.data.score, 31);
    assert.equal(aeo.data.cards.faq_coverage.score, 0);
    assert.equal(aeo.data.signals[0].ruleId, 'AEO-046');
    assert.equal(aeo.data.issues[0].ruleId, 'AEO-001');
    assert.equal(aeo.data.issues[1].totalUrls, 2);
    assert.equal(aeo.data.details, undefined);
    assert.equal(JSON.stringify(r).includes('huge_raw_blob'), false);
    assert.ok(JSON.stringify(r).length < 60000);
  });

  test('AEO / GEO / AISO stay separate; a failing hub issues call only degrades that hub', async () => {
    const r = await build({ hubHandlers: {
      getAEOHubData: ok('aeo_score', 31), getAEOHubIssues: async (q, s) => s.status(500).json({ success: false }),
      getGEOHubData: ok('geo_score', 14), getAISOHubData: ok('aiso_score', 89),
    } });
    assert.equal(r.sections.aeo.status, STATUS.PARTIAL);
    assert.equal(r.sections.aeo.reason, 'issues_failed');
    assert.equal(r.sections.aeo.data.score, 31);
    assert.equal(r.sections.geo.status, STATUS.AVAILABLE);
    assert.equal(r.sections.geo.data.score, 14);
    assert.equal(r.sections.aiso.data.score, 89);
  });
});

describe('accessibility', () => {
  test('titled findings with evidence; no score or WCAG mapping is invented', async () => {
    const r = await build({ getAccessibilityIssues: async () => ({
      issues: [{ issue_code: 'form_labels', issue_message: 'Form field missing label: input#a', severity: 'high', pages_affected: 4, total_occurrences: 6, impact_percentage: 11, difficulty: 'hard' }],
      summary: { total_issues_found: 4, total_issue_types: 1, total_pages_analyzed: 35 },
    }) });
    const a = r.sections.accessibility.data;
    assert.equal(a.topIssues[0].title, 'Form field missing label');
    assert.equal(a.score, null);
    assert.equal(a.wcagMapping, null);
    assert.ok(a.affectedUrls.form_labels.sample.length > 0);
  });

  test('zero issues is available; a failed query is unavailable', async () => {
    const zero = await build();
    assert.equal(zero.sections.accessibility.status, STATUS.AVAILABLE);
    assert.equal(zero.sections.accessibility.data.totalIssues, 0);
    const failed = await build({ getAccessibilityIssues: async () => { throw new Error('x'); } });
    assert.equal(failed.sections.accessibility.status, STATUS.UNAVAILABLE);
  });
});

describe('recommendations', () => {
  test('grounded in findings + stored guidance, ordered by severity, nothing invented', async () => {
    const r = await build();
    const rec = r.sections.recommendations;
    assert.equal(rec.status, STATUS.AVAILABLE);
    const items = rec.data.items;
    assert.equal(items[0].severity, 'high');
    const title = items.find((i) => i.ruleId === 'TITLE_MISSING');
    assert.equal(title.action, 'Add a unique title tag.');
    assert.equal(title.actionBasis, 'stored_recommendation');
    assert.equal(title.whyItMatters, 'Titles are the main search snippet.');
    const none = items.find((i) => i.ruleId === 'H1_MULTI');
    assert.equal(none.action, null);
    assert.equal(none.actionBasis, 'none');
    assert.equal(items.find((i) => i.ruleId === 'AEO-054').actionBasis, 'hub_recommendation');
    const rank = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
    for (let i = 1; i < items.length; i++) assert.ok((rank[items[i - 1].severity] || 0) >= (rank[items[i].severity] || 0));
    const json = JSON.stringify(rec).toLowerCase();
    for (const banned of ['traffic', 'revenue', 'verified']) assert.equal(json.includes(banned), false, banned);
  });

  test('failed guidance source -> partial, findings kept without action text', async () => {
    const r = await build({ loadIssueGuidance: async () => { throw new Error('x'); } });
    assert.equal(r.sections.recommendations.status, STATUS.PARTIAL);
    assert.equal(r.sections.recommendations.reason, 'guidance_failed');
    assert.ok(r.sections.recommendations.data.items.filter((i) => i.source === 'on-page').every((i) => i.action === null));
  });

  test('no findings source -> unavailable; other sections unaffected', async () => {
    const r = await build({
      getOnPageIssues: async () => { throw new Error('x'); },
      getAccessibilityIssues: async () => { throw new Error('x'); },
      hubHandlers: { getAEOHubData: notRun, getGEOHubData: notRun, getAISOHubData: notRun },
    });
    assert.equal(r.sections.recommendations.status, STATUS.UNAVAILABLE);
    assert.equal(r.sections.recommendations.reason, 'no_findings_source');
    assert.equal(r.sections.pageSpeed.status, STATUS.PARTIAL);
  });
});
