import AuditRun from '../model/AuditRun.js';

class TrendAnalyticsService {

  // ── Public API ─────────────────────────────────────────────────────────────

  async getTrends(projectId, { limit = 20 } = {}) {
    // Oldest-first so chart data reads left → right chronologically
    const runs = await AuditRun.find({ projectId })
      .sort({ auditNumber: 1 })
      .limit(limit)
      .select('auditNumber completedAt websiteScore aiVisibilityScore totalIssues criticalIssues performanceScore technicalHealthScore aiVisibilityIssueCount aiVisibilityCriticalIssueCount')
      .lean();

    if (runs.length === 0) {
      return { available: false, reason: 'no_audits', totalAudits: 0 };
    }

    if (runs.length === 1) {
      return { available: false, reason: 'only_one_audit', totalAudits: 1 };
    }

    const labels         = runs.map(r => `Audit ${r.auditNumber}`);
    const auditNumbers   = runs.map(r => r.auditNumber);
    const dates          = runs.map(r =>
      r.completedAt ? new Date(r.completedAt).toISOString().split('T')[0] : null
    );
    const websiteScore      = runs.map(r => r.websiteScore      ?? null);
    const aiVisibilityScore = runs.map(r => r.aiVisibilityScore ?? null);
    const totalIssues       = runs.map(r => r.totalIssues       ?? null);
    const criticalIssues    = runs.map(r => r.criticalIssues    ?? null);
    const performanceScore          = runs.map(r => r.performanceScore          ?? null);
    const technicalHealthScore      = runs.map(r => r.technicalHealthScore      ?? null);
    const aiVisibilityIssueCount    = runs.map(r => r.aiVisibilityIssueCount    ?? null);
    const aiVisibilityCriticalIssueCount = runs.map(r => r.aiVisibilityCriticalIssueCount ?? null);

    const growth   = this._computeGrowth(runs);
    const insights = this._generateInsights(growth, runs.length);

    return {
      available: true,
      totalAudits: runs.length,
      labels,
      auditNumbers,
      dates,
      websiteScore,
      aiVisibilityScore,
      totalIssues,
      criticalIssues,
      performanceScore,
      technicalHealthScore,
      aiVisibilityIssueCount,
      aiVisibilityCriticalIssueCount,
      growth,
      insights,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  _computeGrowth(runs) {
    const first = runs[0];
    const last  = runs[runs.length - 1];

    return {
      websiteScore:      this._growthEntry(first.websiteScore,      last.websiteScore,      false),
      aiVisibilityScore: this._growthEntry(first.aiVisibilityScore, last.aiVisibilityScore, false),
      totalIssues:       this._growthEntry(first.totalIssues,       last.totalIssues,       true),
      performanceScore:  this._growthEntry(first.performanceScore,  last.performanceScore,  false),
      technicalHealthScore:      this._growthEntry(first.technicalHealthScore,      last.technicalHealthScore,      false),
      aiVisibilityIssueCount:    this._growthEntry(first.aiVisibilityIssueCount,    last.aiVisibilityIssueCount,    true),
      aiVisibilityCriticalIssueCount: this._growthEntry(first.aiVisibilityCriticalIssueCount, last.aiVisibilityCriticalIssueCount, true),
    };
  }

  // isLowerBetter=true → fewer = improved (issue counts)
  _growthEntry(first, last, isLowerBetter) {
    if (first == null || last == null) {
      return { first: first ?? null, last: last ?? null, change: null, percentage: null, direction: 'unchanged' };
    }

    const change = last - first;
    const percentage = first === 0
      ? (change === 0 ? 0 : null)
      : Math.round((change / first) * 10000) / 100;

    let direction;
    if (change === 0) {
      direction = 'unchanged';
    } else {
      direction = isLowerBetter
        ? (change < 0 ? 'improved' : 'declined')
        : (change > 0 ? 'improved' : 'declined');
    }

    return { first, last, change, percentage, direction };
  }

  _generateInsights(growth, auditCount) {
    const insights = [];
    const { websiteScore, aiVisibilityScore, totalIssues } = growth;

    if (websiteScore.percentage != null && websiteScore.direction !== 'unchanged') {
      const pct  = Math.abs(websiteScore.percentage);
      const verb = websiteScore.direction === 'improved' ? 'improved' : 'declined';
      insights.push(`Website score ${verb} by ${pct}% since first audit`);
    }

    if (
      aiVisibilityScore.first != null &&
      aiVisibilityScore.percentage != null &&
      aiVisibilityScore.direction !== 'unchanged'
    ) {
      const pct  = Math.abs(aiVisibilityScore.percentage);
      const verb = aiVisibilityScore.direction === 'improved' ? 'increased' : 'decreased';
      insights.push(`AI visibility ${verb} by ${pct}%`);
    }

    if (totalIssues.percentage != null && totalIssues.direction !== 'unchanged') {
      const pct = Math.abs(totalIssues.percentage);
      if (totalIssues.direction === 'improved') {
        insights.push(`${pct}% of issues have been resolved`);
      } else {
        insights.push(`Total issues increased by ${pct}%`);
      }
    }

    if (insights.length === 0 && auditCount >= 2) {
      insights.push('No significant changes detected between audits yet');
    }

    return insights;
  }
}

export default new TrendAnalyticsService();
