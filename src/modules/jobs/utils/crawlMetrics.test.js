import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import { computeCrawlMetrics, msToSeconds, describeDurationMs, resolveSnapshotIssueTotal } from './crawlMetrics.js';
import IssueAggregationService from '../../../services/issueAggregationService.js';

describe('crawl success rate vs discovery coverage', () => {
  test('the observed crawl: 20/20 succeeded, 20 of 35 internal URLs reached -> 100% success, 57% coverage (not 53%)', () => {
    // discovered_links.total was 38 = 35 internal + 3 social; the old formula gave round(20/38*100) = 53.
    const m = computeCrawlMetrics({ attempted: 20, successful: 20, discoveredCrawlable: 35 });
    assert.equal(m.crawlSuccessRate, 100);
    assert.equal(m.crawlCoverageRate, 57);
    assert.equal(Math.round((20 / 38) * 100), 53);
  });

  test('all pages crawled and all succeeded -> 100 / 100', () => {
    const m = computeCrawlMetrics({ attempted: 12, successful: 12, discoveredCrawlable: 12 });
    assert.deepEqual([m.crawlSuccessRate, m.crawlCoverageRate], [100, 100]);
  });

  test('partial failure lowers success rate but not coverage (attempted pages are what was reached)', () => {
    const m = computeCrawlMetrics({ attempted: 20, successful: 15, discoveredCrawlable: 40 });
    assert.deepEqual([m.crawlSuccessRate, m.crawlCoverageRate], [75, 50]);
  });

  test('zero attempted / zero discovered never divides by zero', () => {
    for (const input of [{}, { attempted: 0, successful: 0, discoveredCrawlable: 0 }, { attempted: 0, successful: 5, discoveredCrawlable: 10 }, { attempted: null, successful: undefined, discoveredCrawlable: 'x' }]) {
      const m = computeCrawlMetrics(input);
      assert.ok(Number.isFinite(m.crawlSuccessRate) && Number.isFinite(m.crawlCoverageRate));
      assert.equal(m.crawlSuccessRate, 0);
    }
    assert.equal(computeCrawlMetrics({ attempted: 5, successful: 5, discoveredCrawlable: 0 }).crawlCoverageRate, 0);
  });

  test('rates are clamped to 0-100 and successes cannot exceed attempts', () => {
    const m = computeCrawlMetrics({ attempted: 10, successful: 14, discoveredCrawlable: 4 });
    assert.equal(m.crawlSuccessRate, 100);
    assert.equal(m.crawlCoverageRate, 100);
  });

  test('discovered-versus-crawled: coverage is never reported as 100% when only part of the discovered URLs were crawled', () => {
    assert.ok(computeCrawlMetrics({ attempted: 20, successful: 20, discoveredCrawlable: 35 }).crawlCoverageRate < 100);
  });
});

describe('crawl duration units', () => {
  test('stored value is milliseconds; seconds only when displayed', () => {
    assert.equal(msToSeconds(88343), 88);
    assert.equal(describeDurationMs(88343), '88343ms (88s)');
    assert.equal(msToSeconds(999), 1);
    assert.equal(msToSeconds(0), 0);
    assert.equal(msToSeconds(null), 0);
    assert.equal(msToSeconds(-5), 0);
    assert.equal(describeDurationMs(1500), '1500ms (2s)');
  });

  test('the old bug is gone: no log labels a millisecond value with an "s" suffix', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../routes/jobRoutes.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /crawl_duration\}s/);
    assert.match(src, /describeDurationMs\(projectUpdateData\.crawl_duration\)/);
  });
});

describe('snapshot issue total source', () => {
  test('canonical total wins over the crawl-stage count (143 vs 168 case)', () => {
    assert.deepEqual(resolveSnapshotIssueTotal({ canonicalTotal: 168, crawlStageTotal: 143, severitySum: 168 }), { total: 168, source: 'canonical_open_dedup_key' });
  });
  test('falls back to the crawl-stage count, then the severity sum, when the canonical query failed', () => {
    assert.deepEqual(resolveSnapshotIssueTotal({ canonicalTotal: null, crawlStageTotal: 143, severitySum: 168 }), { total: 143, source: 'crawl_stage_code_page' });
    assert.deepEqual(resolveSnapshotIssueTotal({ canonicalTotal: undefined, crawlStageTotal: undefined, severitySum: 7 }), { total: 7, source: 'severity_sum' });
  });
  test('a genuine canonical zero is kept as zero', () => {
    assert.equal(resolveSnapshotIssueTotal({ canonicalTotal: 0, crawlStageTotal: 5, severitySum: 5 }).total, 0);
  });
});

// ── Verified cause of 143 vs 168 (needs local MongoDB) ───────────────────────

let mongoOk = false;
before(async () => {
  try { await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 }); mongoOk = true; } catch { mongoOk = false; }
});
after(async () => { if (mongoOk) await mongoose.connection.close(); });

describe('issue counts: crawl stage (143) vs canonical (168)', () => {
  test('several findings on one page under one issue_code count once at crawl stage (issue_code + page_url) but separately in the canonical count (dedup_key)', async (t) => {
    if (!mongoOk) return t.skip('local MongoDB not reachable');
    const pid = new mongoose.Types.ObjectId();
    const col = mongoose.connection.db.collection('seo_page_issues');
    const mk = (n, code, url, path) => ({ projectId: pid, dedup_key: `${pid}-${n}`, issue_code: code, page_url: url, data_path: path, severity: 'high', status: 'open', category: 'Images' });
    try {
      await col.insertMany([
        mk(1, 'images_missing_alt_text', 'https://t/a', 'images.a.alt'),
        mk(2, 'images_missing_alt_text', 'https://t/a', 'images.b.alt'), // same code + page, different element
        mk(3, 'images_missing_alt_text', 'https://t/a', 'images.c.alt'),
        mk(4, 'title_too_long', 'https://t/a', 'title'),
        mk(5, 'title_too_long', 'https://t/b', 'title'),
      ]);
      // Exactly the pipeline the Python PAGE_ANALYSIS summary uses for issues_found:
      const crawlStage = (await col.aggregate([
        { $match: { projectId: pid } },
        { $group: { _id: { issue_code: '$issue_code', page_url: '$page_url' } } },
        { $count: 'total' },
      ]).toArray())[0].total;
      const canonical = (await IssueAggregationService.getIssueSummary(String(pid), { excludeCategories: [] })).totalIssues;
      assert.equal(crawlStage, 3);
      assert.equal(canonical, 5);
      assert.ok(crawlStage < canonical);
      // and the snapshot would record the canonical value
      assert.equal(resolveSnapshotIssueTotal({ canonicalTotal: canonical, crawlStageTotal: crawlStage, severitySum: 5 }).total, 5);
    } finally {
      await col.deleteMany({ projectId: pid });
    }
  });
});
