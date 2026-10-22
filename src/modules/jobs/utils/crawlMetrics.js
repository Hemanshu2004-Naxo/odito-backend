/**
 * Crawl summary metrics - one place that defines what each number means.
 *
 *  attempted            pages the scraper tried (seo_page_data rows: SUCCESS + FAILED)
 *  successful           attempted pages that scraped successfully
 *  discoveredCrawlable  internal page URLs found by link discovery. This is NOT
 *                       `discovered_links.total`, which also adds social-profile
 *                       links (not crawlable pages) and external links (disabled).
 *
 *  crawl_success_rate   successful / attempted        (how reliable crawling was)
 *  crawl_coverage_rate  attempted  / discoveredCrawlable (how much of the discovered
 *                       site was reached; < 100 when the page quota or selection
 *                       limited the crawl)
 *
 * Both are whole percentages 0-100. With nothing attempted / discovered the
 * rate is 0 (no division by zero); that means "no data", not a measured failure.
 */

const count = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);
const pct = (num, den) => (den > 0 ? Math.max(0, Math.min(100, Math.round((num / den) * 100))) : 0);

export function computeCrawlMetrics({ attempted, successful, discoveredCrawlable } = {}) {
  const a = count(attempted);
  const s = Math.min(count(successful), a || count(successful));
  const d = count(discoveredCrawlable);
  return {
    attempted: a,
    successful: s,
    discoveredCrawlable: d,
    crawlSuccessRate: pct(s, a),
    crawlCoverageRate: pct(a, d),
  };
}

/** The crawl duration is stored in MILLISECONDS (crawl_duration, audit_runs.crawlDuration). */
export function msToSeconds(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? Math.round(n / 1000) : 0;
}

/** Log/display text for a millisecond duration; the unit is always part of the string. */
export function describeDurationMs(ms) {
  const n = Number.isFinite(Number(ms)) && Number(ms) > 0 ? Math.round(Number(ms)) : 0;
  return `${n}ms (${msToSeconds(n)}s)`;
}

/**
 * The issue total an audit snapshot should record. `canonicalTotal` is the
 * dashboard/report count (open issues, distinct dedup_key); `crawlStageTotal`
 * is project.total_issues, which counts distinct (issue_code, page_url) and so
 * merges per-element findings on one page. The canonical value wins when known.
 */
export function resolveSnapshotIssueTotal({ canonicalTotal, crawlStageTotal, severitySum }) {
  if (Number.isFinite(canonicalTotal) && canonicalTotal >= 0) return { total: canonicalTotal, source: 'canonical_open_dedup_key' };
  if (Number.isFinite(crawlStageTotal) && crawlStageTotal >= 0) return { total: crawlStageTotal, source: 'crawl_stage_code_page' };
  return { total: Number.isFinite(severitySum) ? severitySum : 0, source: 'severity_sum' };
}
