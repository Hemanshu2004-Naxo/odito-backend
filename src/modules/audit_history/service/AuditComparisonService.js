import AuditRun from '../model/AuditRun.js';
import { NotFoundError, ValidationError } from '../../../utils/ErrorUtil.js';

class AuditComparisonService {

  // ── History ────────────────────────────────────────────────────────────────

  async getHistory(projectId, { page = 1, limit = 10 } = {}) {
    const skip = (page - 1) * limit;
    const [runs, total] = await Promise.all([
      AuditRun.find({ projectId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AuditRun.countDocuments({ projectId })
    ]);

    const pages = Math.ceil(total / limit) || 1;
    return {
      runs,
      pagination: {
        page,
        limit,
        total,
        pages,
        hasNext: page < pages,
        hasPrev: page > 1
      }
    };
  }

  // ── Comparison ─────────────────────────────────────────────────────────────

  async compareLatest(projectId) {
    const runs = await AuditRun.find({ projectId })
      .sort({ createdAt: -1 })
      .limit(2)
      .lean();

    if (runs.length === 0) {
      return { available: false, reason: 'no_audits' };
    }
    if (runs.length === 1) {
      return { available: false, reason: 'only_one_audit', latest: runs[0] };
    }

    // runs[0] = newest (current), runs[1] = second-newest (previous)
    return this._buildComparison(runs[0], runs[1]);
  }

  async compareAudits(projectId, { from, to, fromAuditId, toAuditId } = {}) {
    let current, previous;

    if (fromAuditId && toAuditId) {
      [previous, current] = await Promise.all([
        AuditRun.findOne({ _id: fromAuditId, projectId }).lean(),
        AuditRun.findOne({ _id: toAuditId, projectId }).lean()
      ]);
    } else if (from != null && to != null) {
      [previous, current] = await Promise.all([
        AuditRun.findOne({ projectId, auditNumber: Number(from) }).lean(),
        AuditRun.findOne({ projectId, auditNumber: Number(to) }).lean()
      ]);
    } else {
      throw new ValidationError('Provide either from+to (audit numbers) or fromAuditId+toAuditId');
    }

    if (!previous) {
      throw new NotFoundError(`Audit not found: from=${from ?? fromAuditId}`);
    }
    if (!current) {
      throw new NotFoundError(`Audit not found: to=${to ?? toAuditId}`);
    }

    return this._buildComparison(current, previous);
  }

  // ── Delta Helpers ──────────────────────────────────────────────────────────

  // Higher value = better (scores). Returns direction: improved | declined | unchanged.
  calculateScoreDelta(current, previous) {
    if (current == null || previous == null) {
      return { current: current ?? null, previous: previous ?? null, change: null, direction: 'unchanged', percentage: null };
    }
    const change = current - previous;
    const percentage = this.calculatePercentageChange(current, previous);
    const direction = change > 0 ? 'improved' : change < 0 ? 'declined' : 'unchanged';
    return { current, previous, change, direction, percentage };
  }

  // Lower value = better (issue counts). Fewer issues → improved.
  calculateIssueDelta(current, previous) {
    if (current == null || previous == null) {
      return { current: current ?? null, previous: previous ?? null, change: null, direction: 'unchanged', percentage: null };
    }
    const change = current - previous;
    const percentage = this.calculatePercentageChange(current, previous);
    const direction = change < 0 ? 'improved' : change > 0 ? 'declined' : 'unchanged';
    return { current, previous, change, direction, percentage };
  }

  // Handles null AI scores — if either side is null, no meaningful comparison.
  calculateVisibilityDelta(current, previous) {
    if (current == null && previous == null) {
      return { current: null, previous: null, change: null, direction: 'unchanged', percentage: null };
    }
    if (current == null || previous == null) {
      return { current: current ?? null, previous: previous ?? null, change: null, direction: 'unchanged', percentage: null };
    }
    return this.calculateScoreDelta(current, previous);
  }

  // Returns percentage change rounded to 2 decimal places. Null if undefinable.
  calculatePercentageChange(current, previous) {
    if (current == null || previous == null) return null;
    if (previous === 0) return current === 0 ? 0 : null;
    return Math.round(((current - previous) / previous) * 10000) / 100;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _buildComparison(current, previous) {
    return {
      available: true,
      current,
      previous,
      delta: {
        websiteScore:      this.calculateScoreDelta(current.websiteScore, previous.websiteScore),
        seoScore:          this.calculateScoreDelta(current.seoScore, previous.seoScore),
        aiVisibilityScore: this.calculateVisibilityDelta(current.aiVisibilityScore, previous.aiVisibilityScore),
        overall_ai_score:  this.calculateVisibilityDelta(current.overall_ai_score, previous.overall_ai_score),
        aiso_score:        this.calculateVisibilityDelta(current.aiso_score, previous.aiso_score),
        aeo_score:         this.calculateVisibilityDelta(current.aeo_score, previous.aeo_score),
        geo_score:         this.calculateVisibilityDelta(current.geo_score, previous.geo_score),
        ai_issue_count:    this.calculateIssueDelta(current.ai_issue_count, previous.ai_issue_count),
        performanceScore:  this.calculateScoreDelta(current.performanceScore, previous.performanceScore),
        technicalHealthScore: this.calculateScoreDelta(current.technicalHealthScore, previous.technicalHealthScore),
        totalIssues:       this.calculateIssueDelta(current.totalIssues, previous.totalIssues),
        criticalIssues:    this.calculateIssueDelta(current.criticalIssues, previous.criticalIssues),
        warningIssues:     this.calculateIssueDelta(current.warningIssues, previous.warningIssues),
        infoIssues:        this.calculateIssueDelta(current.infoIssues, previous.infoIssues),
        pagesAnalyzed:     this.calculateScoreDelta(current.pagesAnalyzed, previous.pagesAnalyzed),
        aiVisibilityIssueCount:         this.calculateIssueDelta(current.aiVisibilityIssueCount, previous.aiVisibilityIssueCount),
        aiVisibilityCriticalIssueCount: this.calculateIssueDelta(current.aiVisibilityCriticalIssueCount, previous.aiVisibilityCriticalIssueCount),
      }
    };
  }
}

export default new AuditComparisonService();
