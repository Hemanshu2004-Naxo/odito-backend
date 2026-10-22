import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { ProjectLinksService } from '../service/projectLinks.service.js';
import { ProjectPagesService } from '../service/projectPages.service.js';
import { ProjectPerformanceService } from '../service/projectPerformance.service.js';
import { ProjectSummaryService } from '../service/projectSummary.service.js';
import { TechnicalChecksService } from '../service/technicalChecks.service.js';
import { ProjectIssuesService } from '../service/projectIssues.service.js';
import { AIVisibilityService } from '../service/aiVisibility.service.js';
import { PreAuditService } from '../service/preAudit.service.js';

import GoogleConnection from '../model/GoogleConnection.js';
import mongoose from 'mongoose';
import { getOnPageIssues as getOnPageIssuesService, getIssueUrls as getIssueUrlsService } from '../../../services/onPageIssuesService.js';

// Get project links data
// REFACTORED: Now uses service layer - Phase 2 Refactoring
// Original logic moved to ProjectLinksService.getProjectLinks()
export const getProjectLinks = async (req, res) => {
  try {
    const { id: projectId } = req.params;
    const result = await ProjectLinksService.getProjectLinks(req.project, req.query);
    return res.json(ResponseUtil.success(result.data, 'Project links retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error getting project links', error, { projectId: req.params.id });
    return res.status(error.statusCode || 500).json(
      error.response || ResponseUtil.error('Failed to get project links', error.statusCode || 500)
    );
  }
};

// Get project pages data
// REFACTORED: Now uses service layer - Phase 2 Refactoring
// Original logic moved to ProjectPagesService.getProjectPages()
export const getProjectPages = async (req, res) => {
  try {
    const result = await ProjectPagesService.getProjectPages(req.project, req.query);
    return res.json(ResponseUtil.success(result.data, 'Project pages retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error getting project pages', error, { projectId: req.params.id });
    return res.status(error.statusCode || 500).json(
      error.response || ResponseUtil.error('Failed to get project pages', error.statusCode || 500)
    );
  }
};

// Get project performance data
// REFACTORED: Now uses service layer - Phase 2 Refactoring
// Original logic moved to ProjectPerformanceService.getProjectPerformance()
export const getProjectPerformance = async (req, res) => {
  try {
    const result = await ProjectPerformanceService.getProjectPerformance(req.project);
    return res.json(ResponseUtil.success(result.data, 'Project performance retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error getting project performance', error, { projectId: req.params.id });
    return res.status(error.statusCode || 500).json(
      error.response || ResponseUtil.error('Failed to get project performance', error.statusCode || 500)
    );
  }
};

// Get project summary for dashboard
// REFACTORED: Now uses service layer - Phase 2 Refactoring
// Original logic moved to ProjectSummaryService.getProjectSummary()
export const getProjectSummary = async (req, res) => {
  try {
    const result = await ProjectSummaryService.getProjectSummary(req.project);
    return res.json(ResponseUtil.success(result.data, 'Project summary retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error getting project summary', error, { projectId: req.params.id });
    return res.status(error.statusCode || 500).json(
      error.response || ResponseUtil.error('Failed to get project summary', error.statusCode || 500)
    );
  }
};

// Get comprehensive technical checks for all pages
// REFACTORED: Now uses service layer - Phase 2 Refactoring
// Original logic moved to TechnicalChecksService.getTechnicalChecks()
export const getTechnicalChecks = async (req, res) => {
  try {
    const result = await TechnicalChecksService.getTechnicalChecks(req.project);
    return res.json(ResponseUtil.success(result.data, 'Technical checks retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error getting technical checks', error, { projectId: req.params.id });
    return res.status(error.statusCode || 500).json(
      error.response || ResponseUtil.error('Failed to get technical checks', error.statusCode || 500)
    );
  }
};

// Get detailed information for a specific technical check
// REFACTORED: Now uses service layer - Phase 2 Refactoring
// Original logic moved to TechnicalChecksService.getTechnicalCheckDetail()
export const getTechnicalCheckDetail = async (req, res) => {
  try {
    const { checkId } = req.params;
    const result = await TechnicalChecksService.getTechnicalCheckDetail(req.project, checkId);
    return res.json(ResponseUtil.success(result.data, 'Technical check detail retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error getting technical check detail', error, { projectId: req.params.id, checkId: req.params.checkId });
    return res.status(error.statusCode || 500).json(
      error.response || ResponseUtil.error('Failed to get technical check detail', error.statusCode || 500)
    );
  }
};

// Get project issues grouped by page URL
// REFACTORED: Now uses service layer - Phase 2 Refactoring
// Original logic moved to ProjectIssuesService.getProjectIssuesByPage()
export const getProjectIssuesByPage = async (req, res) => {
  try {
    const result = await ProjectIssuesService.getProjectIssuesByPage(req.project);
    return res.json(ResponseUtil.success(result.data, 'Project issues by page retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error getting project issues by page', error, { projectId: req.params.id });
    return res.status(error.statusCode || 500).json(
      error.response || ResponseUtil.error('Failed to get project issues by page', error.statusCode || 500)
    );
  }
};

// Get issues for a specific page URL
// REFACTORED: Now uses service layer - Phase 2 Refactoring
// Original logic moved to ProjectIssuesService.getPageIssues()
export const getPageIssues = async (req, res) => {
  try {
    const { page_url } = req.query;

    if (!page_url) {
      return res.status(400).json(ResponseUtil.validationError('page_url parameter is required'));
    }

    const result = await ProjectIssuesService.getPageIssues(req.project, page_url);
    return res.json(ResponseUtil.success(result.data, 'Page issues retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error getting page issues', error, { projectId: req.params.id, page_url: req.query.page_url });
    return res.status(error.statusCode || 500).json(
      error.response || ResponseUtil.error('Failed to get page issues', error.statusCode || 500)
    );
  }
};

// Get project issues
// REFACTORED: Now uses service layer - Phase 2 Refactoring
// Original logic moved to ProjectIssuesService.getProjectIssues()
export const getProjectIssues = async (req, res) => {
  try {
    const result = await ProjectIssuesService.getProjectIssues(req.project, req.query);
    return res.json(ResponseUtil.success(result.data, 'Project issues retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error getting project issues', error, { projectId: req.params.id });
    return res.status(error.statusCode || 500).json(
      error.response || ResponseUtil.error('Failed to get project issues', error.statusCode || 500)
    );
  }
};

// Get AI Visibility Entity Graph
// REFACTORED: Now uses service layer - Phase 2 Refactoring
// Original logic moved to AIVisibilityService.getAIVisibilityEntityGraph()
export const getAIVisibilityEntityGraph = async (req, res) => {
  try {
    const result = await AIVisibilityService.getAIVisibilityEntityGraph(req.project);
    return res.json(ResponseUtil.success(result.data, 'AI visibility entity graph retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error getting AI visibility entity graph', error, { projectId: req.params.id });
    return res.status(error.statusCode || 500).json(
      error.response || ResponseUtil.error('Failed to get AI visibility entity graph', error.statusCode || 500)
    );
  }
};

// Get AI Visibility Page
// REFACTORED: Now uses service layer - Phase 2 Refactoring
// Original logic moved to AIVisibilityService.getAIVisibilityPage()
export const getAIVisibilityPage = async (req, res) => {
  try {
    const { page_url } = req.query;
    const result = await AIVisibilityService.getAIVisibilityPage(req.project, page_url);
    return res.json(ResponseUtil.success(result.data, 'AI visibility page retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error getting AI visibility page', error, { projectId: req.params.id, page_url: req.query.page_url });
    return res.status(error.statusCode || 500).json(
      error.response || ResponseUtil.error('Failed to get AI visibility page', error.statusCode || 500)
    );
  }
};

// Get AI Visibility Pages
// REFACTORED: Now uses service layer - Phase 2 Refactoring
// Original logic moved to AIVisibilityService.getAIVisibilityPages()
export const getAIVisibilityPages = async (req, res) => {
  try {
    const result = await AIVisibilityService.getAIVisibilityPages(req.project, req.query);
    return res.json(ResponseUtil.success(result.data, 'AI visibility pages retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error getting AI visibility pages', error, { projectId: req.params.id });
    return res.status(error.statusCode || 500).json(
      error.response || ResponseUtil.error('Failed to get AI visibility pages', error.statusCode || 500)
    );
  }
};

// Get AI Visibility Worst Pages
// REFACTORED: Now uses service layer - Phase 2 Refactoring
// Original logic moved to AIVisibilityService.getAIVisibilityWorstPages()
export const getAIVisibilityWorstPages = async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    const result = await AIVisibilityService.getAIVisibilityWorstPages(req.project, limit);
    return res.json(ResponseUtil.success(result.data, 'AI visibility worst pages retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error getting AI visibility worst pages', error, { projectId: req.params.id, limit: req.query.limit });
    return res.status(error.statusCode || 500).json(
      error.response || ResponseUtil.error('Failed to get AI visibility worst pages', error.statusCode || 500)
    );
  }
};

// Get Standalone AI Visibility Pages
// REFACTORED: Now uses service layer - Phase 2 Refactoring
// Original logic moved to AIVisibilityService.getStandaloneAIVisibilityPages()
export const getStandaloneAIVisibilityPages = async (req, res) => {
  try {
    const result = await AIVisibilityService.getStandaloneAIVisibilityPages(req.user._id, req.query);
    return res.json(ResponseUtil.success(result.data, 'Standalone AI visibility pages retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error getting standalone AI visibility pages', error);
    return res.status(error.statusCode || 500).json(
      error.response || ResponseUtil.error('Failed to get standalone AI visibility pages', error.statusCode || 500)
    );
  }
};

// Get Page Score
// REFACTORED: Now uses service layer - Phase 2 Refactoring
// Original logic moved to AIVisibilityService.getPageScore()
export const getPageScore = async (req, res) => {
  try {
    const { page_url } = req.query;
    const result = await AIVisibilityService.getPageScore(req.project, page_url);
    return res.json(ResponseUtil.success(result.data, 'Page score retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error getting page score', error, { projectId: req.params.id, page_url: req.query.page_url });
    return res.status(error.statusCode || 500).json(
      error.response || ResponseUtil.error('Failed to get page score', error.statusCode || 500)
    );
  }
};

// Get issue URLs
// REFACTORED: Now uses service layer - Phase 2 Refactoring  
// Original logic moved to getIssueUrlsService()
export const getIssueUrls = async (req, res) => {
  try {
    const { issueCode } = req.params;
    const urls = await getIssueUrlsService(req.project._id.toString(), issueCode);
    return res.json(ResponseUtil.success(urls, 'Issue URLs retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error getting issue URLs', error, { projectId: req.params.id, issueCode: req.params.issueCode });
    return res.status(500).json(ResponseUtil.error('Failed to get issue URLs', 500));
  }
};

// Get on-page issues (aggregated by issue_code)
// Uses the onPageIssuesService to get aggregated issues with summary metrics
export const getOnPageIssues = async (req, res) => {
  try {
    const result = await getOnPageIssuesService(req.project._id.toString());
    return res.json(ResponseUtil.success(result, 'On-page issues retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error getting on-page issues', error, { projectId: req.params.id });
    return res.status(500).json(ResponseUtil.error('Failed to get on-page issues', 500));
  }
};

// Get pre-audit snapshot linked to this project
export const getProjectPreAudit = async (req, res) => {
  try {
    const service = new PreAuditService();
    const result = await service.getPreAudit(req.params.id, req.user._id);

    if (!result) {
      return res.status(404).json(ResponseUtil.error('Project not found', 404));
    }

    return res.json(ResponseUtil.success(result, 'Pre-audit retrieved successfully'));
  } catch (error) {
    LoggerUtil.error('Error getting pre-audit', error, { projectId: req.params.id });
    return res.status(500).json(ResponseUtil.error('Failed to get pre-audit', 500));
  }
};
