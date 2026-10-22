import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { ExecutiveMapper } from '../mapper/sections/executive.mapper.js';
import { CoverPageService } from './coverPageService.js';
import { PDFAggregationService } from './pdfAggregationService.js';
import { Page08Service } from './page08Service.js';
import { Page09Service } from './page09Service.js';
import IssueAggregationService from '../../../services/issueAggregationService.js';

// Phase 0: a failed or unavailable data source must never be reported to the
// PDF as a successful result with zero issues / zero scores.

const failingDb = {
  collection: () => ({
    aggregate: () => ({ toArray: async () => { throw new Error('db down'); } }),
    countDocuments: async () => { throw new Error('db down'); },
    distinct: async () => { throw new Error('db down'); },
  }),
};

const dbReturning = (rows) => ({
  collection: () => ({ aggregate: () => ({ toArray: async () => rows }) }),
});

describe('ExecutiveMapper failure handling', () => {
  test('getSafeFallback is a failure, not a zero-issue success', () => {
    const r = ExecutiveMapper.getSafeFallback('boom');
    assert.equal(r.success, false);
    assert.equal(r.error.code, 'EXECUTIVE_SUMMARY_UNAVAILABLE');
    assert.equal(r.data, undefined);
  });

  test('missing inputs yield a failure', async () => {
    assert.equal((await ExecutiveMapper.mapExecutiveSummary(null, { scores: {} })).success, false);
    assert.equal((await ExecutiveMapper.mapExecutiveSummary({ project: { _id: 'x' } }, null)).success, false);
  });

  test('an issue-count query failure yields a failure, not zero counts', async () => {
    const original = PDFAggregationService.getOnPageIssueCounts;
    PDFAggregationService.getOnPageIssueCounts = async () => { throw new Error('count failed'); };
    try {
      const r = await ExecutiveMapper.mapExecutiveSummary(
        { project: { _id: '64b000000000000000000001' } },
        { scores: { seoHealth: 80 } }
      );
      assert.equal(r.success, false);
    } finally {
      PDFAggregationService.getOnPageIssueCounts = original;
    }
  });

  test('unavailable scores stay null and "passed" is not invented', async () => {
    const original = PDFAggregationService.getOnPageIssueCounts;
    PDFAggregationService.getOnPageIssueCounts = async () => ({ totalIssues: 0, critical: 0, warnings: 0, informational: 0 });
    try {
      const r = await ExecutiveMapper.mapExecutiveSummary(
        { project: { _id: '64b000000000000000000001' } },
        { scores: { seoHealth: 72, aiVisibility: null, performance: null, technicalHealth: 0 } }
      );
      assert.equal(r.success, true);
      assert.equal(r.data.scores.seoHealth, 72);
      assert.equal(r.data.scores.aiVisibility, null);
      assert.equal(r.data.scores.performance, null);
      assert.equal(r.data.scores.technicalHealth, 0); // a real 0 is preserved
      assert.equal(r.data.issues.passed, null);
      // a genuine zero-issue project is a legitimate success
      assert.equal(r.data.metadata.totalIssues, 0);
    } finally {
      PDFAggregationService.getOnPageIssueCounts = original;
    }
  });
});

describe('Issue counting', () => {
  const withIssueStubs = async (summaryImpl, rowsImpl, fn) => {
    const origS = IssueAggregationService.getIssueSummary;
    const origR = IssueAggregationService.getOpenIssues;
    IssueAggregationService.getIssueSummary = summaryImpl;
    IssueAggregationService.getOpenIssues = rowsImpl || (async () => []);
    try { return await fn(); } finally {
      IssueAggregationService.getIssueSummary = origS;
      IssueAggregationService.getOpenIssues = origR;
    }
  };

  test('cover issue statistics come from the canonical aggregation (dashboard parity)', async () => {
    await withIssueStubs(
      async () => ({ totalIssues: 10, critical: 3, warnings: 4, informational: 3, resolved: 2 }),
      async () => [{ severity: 'high' }, { severity: 'critical' }, { severity: 'High' }, { severity: 'medium' }],
      async () => {
        const stats = await CoverPageService.getIssueStatistics({}, 'pid');
        assert.deepEqual(stats, { totalIssues: 10, critical: 3, high: 2, warnings: 4, informational: 3 });
      }
    );
  });

  test('cover issue statistics propagate failure instead of returning zeros', async () => {
    await withIssueStubs(async () => { throw new Error('db down'); }, null, async () => {
      await assert.rejects(() => CoverPageService.getIssueStatistics({}, 'pid'), /db down/);
    });
  });

  test('a project with genuinely zero issues returns zeros (success)', async () => {
    await withIssueStubs(
      async () => ({ totalIssues: 0, critical: 0, warnings: 0, informational: 0, resolved: 0 }),
      async () => [],
      async () => {
        const stats = await CoverPageService.getIssueStatistics({}, 'pid');
        assert.equal(stats.totalIssues, 0);
      }
    );
  });

  test('getOnPageIssueCounts uses canonical counts and rejects on failure', async () => {
    await withIssueStubs(
      async () => ({ totalIssues: 7, critical: 1, warnings: 2, informational: 4, resolved: 0 }),
      null,
      async () => {
        assert.deepEqual(await PDFAggregationService.getOnPageIssueCounts('64b000000000000000000001'),
          { totalIssues: 7, critical: 1, warnings: 2, informational: 4 });
      }
    );
    await withIssueStubs(async () => { throw new Error('count failed'); }, null, async () => {
      await assert.rejects(() => PDFAggregationService.getOnPageIssueCounts('64b000000000000000000001'), /count failed/);
    });
  });

  test('query core rejects on DB failure; tolerant wrapper keeps legacy behaviour for other callers', async () => {
    await assert.rejects(() => PDFAggregationService.queryOnpageIssueCounts(failingDb, 'pid'), /db down/);
    const legacy = await PDFAggregationService.fetchOnpageIssuesData(failingDb, 'pid');
    assert.equal(legacy.totalIssues, 0);
  });

  test('page 8 / page 9 helpers propagate failures', async () => {
    await assert.rejects(() => Page08Service.getSeverityBreakdown(failingDb, 'pid'), /db down/);
    await assert.rejects(() => Page08Service.getTopIssues(failingDb, 'pid'), /db down/);
    await assert.rejects(() => Page09Service.getSchemaCoverage(failingDb, 'pid'), /db down/);
    await assert.rejects(() => Page09Service.getSchemaErrors(failingDb, 'pid'), /db down/);
  });
});

describe('Cover score derivation', () => {
  test('unavailable categories are null, excluded from the overall mean, and listed', async () => {
    const { ProjectPerformanceService } = await import('../../app_user/service/projectPerformance.service.js');
    const { TechnicalChecksService } = await import('../../app_user/service/technicalChecks.service.js');
    const origPerf = ProjectPerformanceService.getProjectPerformance;
    const origTech = TechnicalChecksService.getTechnicalChecks;
    ProjectPerformanceService.getProjectPerformance = async () => { throw new Error('perf failed'); };
    TechnicalChecksService.getTechnicalChecks = async () => ({ success: true, data: { summary: { healthScore: 60 } } });
    try {
      const r = await CoverPageService.calculateDerivedMetrics(
        { website_score: 80 }, // no ai_visibility on the project
        { totalIssues: 5, critical: 1, high: 1, warnings: 2, informational: 2 },
        {}, null, null
      );
      assert.equal(r.performance, null);
      assert.equal(r.aiVisibility, null);
      assert.equal(r.seoHealth, 80);
      assert.equal(r.technicalHealth, 60);
      assert.deepEqual(r.unavailableScores.sort(), ['aiVisibility', 'performance']);
      assert.equal(r.overallScore, 70); // mean of 80 and 60 only; not (80+0+60+0)/4
    } finally {
      ProjectPerformanceService.getProjectPerformance = origPerf;
      TechnicalChecksService.getTechnicalChecks = origTech;
    }
  });

  test('no available scores gives a null overall score', async () => {
    const { ProjectPerformanceService } = await import('../../app_user/service/projectPerformance.service.js');
    const { TechnicalChecksService } = await import('../../app_user/service/technicalChecks.service.js');
    const origPerf = ProjectPerformanceService.getProjectPerformance;
    const origTech = TechnicalChecksService.getTechnicalChecks;
    ProjectPerformanceService.getProjectPerformance = async () => ({ success: false });
    TechnicalChecksService.getTechnicalChecks = async () => ({ success: false });
    try {
      const r = await CoverPageService.calculateDerivedMetrics(
        { website_score: 'not-a-number' }, { totalIssues: 0 }, {}, null, null
      );
      assert.equal(r.performance, null);
      assert.equal(r.technicalHealth, null);
      assert.equal(r.aiVisibility, null);
    } finally {
      ProjectPerformanceService.getProjectPerformance = origPerf;
      TechnicalChecksService.getTechnicalChecks = origTech;
    }
  });
});
