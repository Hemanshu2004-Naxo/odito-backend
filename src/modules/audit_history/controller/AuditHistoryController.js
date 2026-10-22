import AuditComparisonService from '../service/AuditComparisonService.js';
import TrendAnalyticsService from '../service/TrendAnalyticsService.js';
import AiImpactService from '../service/AiImpactService.js';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';

export async function getAuditHistory(req, res) {
  const { projectId } = req.params;
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));

  const { runs, pagination } = await AuditComparisonService.getHistory(projectId, { page, limit });
  return res.json(ResponseUtil.paginated(runs, pagination, 'Audit history retrieved'));
}

export async function getLatestComparison(req, res) {
  const { projectId } = req.params;
  const result = await AuditComparisonService.compareLatest(projectId);

  if (!result.available) {
    return res.json(ResponseUtil.success(result, 'Not enough audit history for comparison'));
  }
  return res.json(ResponseUtil.success(result, 'Latest comparison retrieved'));
}

export async function getAuditComparison(req, res) {
  const { projectId } = req.params;
  const { from, to, fromAuditId, toAuditId } = req.query;

  if (!from && !to && !fromAuditId && !toAuditId) {
    return res.status(400).json(
      ResponseUtil.error('Provide from+to (audit numbers) or fromAuditId+toAuditId query parameters', 400)
    );
  }

  const result = await AuditComparisonService.compareAudits(projectId, { from, to, fromAuditId, toAuditId });
  return res.json(ResponseUtil.success(result, 'Audit comparison retrieved'));
}

export async function getProjectTrends(req, res) {
  const { projectId } = req.params;
  const limit = Math.min(50, Math.max(2, parseInt(req.query.limit) || 20));
  const result = await TrendAnalyticsService.getTrends(projectId, { limit });
  return res.json(ResponseUtil.success(result, 'Trend analytics retrieved'));
}

export async function getAiImpact(req, res) {
  const { projectId } = req.params;
  const result = await AiImpactService.getAiImpact(projectId);
  return res.json(ResponseUtil.success(result, 'AI impact metrics retrieved'));
}

