/**
 * Cover Page Mapper
 * Transforms data for the PDF cover page
 */

import { FormatUtils } from '../../utils/format.utils.js';
import { GradeUtils } from '../../utils/grade.utils.js';

export class CoverMapper {
  
  /**
   * Transform data for cover page
   * @param {Object} project - Project data
   * @param {Object} scores - Calculated scores
   * @param {Object} issues - Issue metrics
   * @param {Object} pageMetrics - Page metrics
   * @returns {Object} Cover page data
   */
  static transform(project, scores, issues, pageMetrics) {
    return {
      // Basic information
      domain: this.extractDomain(project.main_url),
      companyName: this.extractCompanyName(project),
      auditDate: FormatUtils.formatDate(new Date(), 'long'),
      engine: 'Odito AI Engine v2',
      pagesCrawled: pageMetrics.total || 0,
      preparedFor: this.extractCompanyName(project),
      
      // Scores and grades
      overallScore: scores.overall,
      overallGrade: GradeUtils.getGrade(scores.overall).grade,
      scores: {
        performance: scores.performance,
        authority: scores.authority,
        seoHealth: scores.seoHealth,
        aiVisibility: scores.aiVisibility
      },
      
      // Issue breakdown
      issues: {
        critical: issues.combined?.critical || 0,
        warnings: issues.combined?.high || 0,
        informational: issues.combined?.low || 0,
        checksPassed: this.calculatePassedChecks(pageMetrics, issues),
        pagesCrawled: pageMetrics.total || 0
      },
      
      // Metadata
      reportInfo: {
        title: 'SEO & AI Visibility Audit Report',
        date: FormatUtils.formatDate(new Date(), 'short'),
        domain: this.extractDomain(project.main_url)
      }
    };
  }

  /**
   * Extract domain from URL
   */
  static extractDomain(url) {
    if (!url) return 'Unknown Domain';
    
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.replace('www.', '');
    } catch {
      return FormatUtils.formatUrl(url, 30);
    }
  }

  /**
   * Extract company name from project data
   */
  static extractCompanyName(project) {
    // Try various fields for company name
    return (
      project.company_name ||
      project.project_name ||
      project.name ||
      'Your Company'
    );
  }

  /**
   * Calculate number of passed checks
   */
  static calculatePassedChecks(pageMetrics, issues) {
    const totalPages = pageMetrics.total || 0;
    const totalIssues = issues.total || 0;
    
    // Estimate passed checks based on issue-free pages
    const passedPages = Math.max(0, totalPages - (issues.pages?.uniquePages || totalIssues));
    
    // Rough estimate: 3 checks per page, minus issues
    const estimatedChecks = Math.max(0, (totalPages * 3) - totalIssues);
    
    return Math.round(estimatedChecks);
  }

  /**
   * Generate cover page title
   */
  static generateTitle(project, scores) {
    const domain = this.extractDomain(project.main_url);
    const grade = GradeUtils.getGrade(scores.overall).grade;
    
    return `${domain} - SEO Audit Report (${grade})`;
  }

  /**
   * Generate subtitle
   */
  static generateSubtitle(scores) {
    const performance = GradeUtils.getPerformanceRating(scores.performance);
    const aiVisibility = GradeUtils.getPerformanceRating(scores.aiVisibility);
    
    return `${performance} Performance · ${aiVisibility} AI Visibility`;
  }

  /**
   * Get score color for visualization
   */
  static getScoreColor(score) {
    return GradeUtils.getColor(score);
  }

  /**
   * Format score display
   */
  static formatScore(score, showGrade = true) {
    const formatted = FormatUtils.formatNumber(score);
    const grade = showGrade ? GradeUtils.getGrade(score).grade : '';
    
    return showGrade ? `${formatted}/100 (${grade})` : `${formatted}/100`;
  }

  /**
   * Calculate score breakdown percentages
   */
  static calculateScoreBreakdown(scores) {
    const total = scores.overall || 1;
    
    return {
      performance: {
        value: scores.performance,
        percentage: FormatUtils.formatNumber((scores.performance / total) * 100, 1),
        color: this.getScoreColor(scores.performance)
      },
      authority: {
        value: scores.authority,
        percentage: FormatUtils.formatNumber((scores.authority / total) * 100, 1),
        color: this.getScoreColor(scores.authority)
      },
      seoHealth: {
        value: scores.seoHealth,
        percentage: FormatUtils.formatNumber((scores.seoHealth / total) * 100, 1),
        color: this.getScoreColor(scores.seoHealth)
      },
      aiVisibility: {
        value: scores.aiVisibility,
        percentage: FormatUtils.formatNumber((scores.aiVisibility / total) * 100, 1),
        color: this.getScoreColor(scores.aiVisibility)
      }
    };
  }

  /**
   * Generate issue summary text
   */
  static generateIssueSummary(issues) {
    const total = issues.total || 0;
    const critical = issues.combined?.critical || 0;
    
    if (total === 0) {
      return 'Excellent! No issues found.';
    } else if (critical > 0) {
      return `${critical} critical issue${critical > 1 ? 's' : ''} require immediate attention.`;
    } else if (total > 10) {
      return `${total} issues found - systematic optimization recommended.`;
    } else {
      return `${total} minor issues - quick wins available.`;
    }
  }

  /**
   * Validate cover data
   */
  static validate(coverData) {
    const required = ['domain', 'overallScore', 'scores', 'issues'];
    const missing = required.filter(field => coverData[field] == null);
    
    if (missing.length > 0) {
      throw new Error(`Cover mapper missing required fields: ${missing.join(', ')}`);
    }
    
    return true;
  }
}
