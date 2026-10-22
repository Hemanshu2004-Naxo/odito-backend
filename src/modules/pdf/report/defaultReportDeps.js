/**
 * Production wiring for the canonical report: binds each adapter dependency to
 * the existing service / model it must reuse. Kept separate from the service
 * so the service and adapters stay testable without a database.
 *
 * Every query here is scoped by projectId; ownership of the project is
 * enforced by validateProjectAccess() on the route before this runs.
 */

import mongoose from 'mongoose';

import SeoProject from '../../app_user/model/SeoProject.js';
import SeoRankingCurrent from '../../app_user/model/SeoRankingCurrent.js';
import SeoRanking from '../../app_user/model/SeoRanking.js';
import GoogleConnection from '../../app_user/model/GoogleConnection.js';
import SearchConsoleData from '../../app_user/model/SearchConsoleData.js';
import AuditRun from '../../audit_history/model/AuditRun.js';
import Task from '../../tasks/model/Task.js';

import IssueAggregationService from '../../../services/issueAggregationService.js';
import { getOnPageIssues, getIssueUrls } from '../../../services/onPageIssuesService.js';
import { getAccessibilityIssues } from '../../../services/accessibilityIssuesService.js';
import { deriveHistoricalRanksForProject } from '../../../services/rankingHistoryService.js';
import { ProjectPerformanceService } from '../../app_user/service/projectPerformance.service.js';
import { TechnicalChecksService } from '../../app_user/service/technicalChecks.service.js';
import AuditComparisonService from '../../audit_history/service/AuditComparisonService.js';
import { Page09Service } from '../service/page09Service.js';
import { Page11Service } from '../service/page11Service.js';
import { getAEOHubData, getGEOHubData, getAISOHubData, getAEOHubIssues, getGEOHubIssues, getAISOHubIssues } from '../../ai_hub/controller/aiHubController.js';

const oid = (id) => new mongoose.Types.ObjectId(id);

export const defaultReportDeps = {
  // project + audit runs
  loadProject: (projectId) =>
    SeoProject.findOne({ _id: projectId, is_deleted: { $ne: true } }).lean(),
  loadLatestRun: (projectId) =>
    AuditRun.findOne({ projectId }).sort({ completedAt: -1, createdAt: -1 }).lean(),
  loadRunByNumber: (projectId, auditNumber) =>
    AuditRun.findOne({ projectId, auditNumber }).lean(),

  // issues (canonical)
  issues: IssueAggregationService,
  getOnPageIssues,
  getIssueUrls,
  getAccessibilityIssues,

  // technical / performance
  getTechnicalChecks: (project) => TechnicalChecksService.getTechnicalChecks(project),
  getCrawlability: (projectId) => Page11Service.getPage11Data(projectId),
  getStructuredData: (projectId) => Page09Service.getPage09Data(projectId),
  getProjectPerformance: (project) => ProjectPerformanceService.getProjectPerformance(project),

  // keywords
  loadCurrentRankings: (projectId) => SeoRankingCurrent.findOne({ project_id: projectId }).lean(),
  deriveHistoricalRanks: (projectId) => deriveHistoricalRanksForProject(projectId),
  loadLegacyRankings: (projectId) =>
    SeoRanking.findOne({ project_id: projectId }).sort({ created_at: -1 }).lean(),

  // Search Console (stored data only - never a live Google call)
  findSearchConsoleConnection: (userId, projectId) =>
    GoogleConnection.findActiveConnection(userId, projectId, 'search_console'),
  getSearchConsoleAggregates: (projectId) => SearchConsoleData.getProjectAggregates(projectId),

  // AI hubs: reuse the dashboard handlers so scores/rules are never re-derived
  hubHandlers: { getAEOHubData, getGEOHubData, getAISOHubData, getAEOHubIssues, getGEOHubIssues, getAISOHubIssues },
  // Stored remediation guidance saved with the audit's issues (one entry per issue_code).
  loadIssueGuidance: async (projectId) => {
    const rows = await mongoose.connection.db.collection('seo_page_issues').aggregate([
      { $match: { projectId: oid(projectId), status: 'open' } },
      { $group: { _id: '$issue_code', recommendation: { $max: '$recommendation' }, impact: { $max: '$impact' }, expected: { $max: '$expected_value' } } },
    ]).toArray();
    return new Map(rows.map((r) => [r._id, { recommendation: r.recommendation || null, impact: r.impact || null, expected: typeof r.expected === 'string' ? r.expected : null }]));
  },
  loadAiOverallScore: async (projectId) => {
    const doc = await mongoose.connection.db
      .collection('ai_projects')
      .find({ project_id: oid(projectId) })
      .sort({ computed_at: -1 })
      .limit(1)
      .next();
    return doc?.overall_score ?? null;
  },

  // progress
  countTasksByStatus: async (projectId) => {
    const rows = await Task.aggregate([
      { $match: { projectId: oid(projectId), isDeleted: { $ne: true } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    return Object.fromEntries(rows.map((r) => [r._id, r.count]));
  },
  compareLatest: (projectId) => AuditComparisonService.compareLatest(projectId),
};

export default defaultReportDeps;
