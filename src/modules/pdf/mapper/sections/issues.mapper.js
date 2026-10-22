/**
 * Issues Mapper
 * Transforms data for all issue-related sections
 */

import { FormatUtils } from '../../utils/format.utils.js';
import { GradeUtils } from '../../utils/grade.utils.js';
import { PercentageUtils } from '../../utils/percentage.utils.js';

export class IssuesMapper {
  
  /**
   * Transform key strengths vs issues
   */
  static transformStrengths(issues, scores) {
    const strengths = this.identifyStrengths(scores);
    const issueList = this.identifyTopIssues(issues);
    
    return {
      strengths,
      issues: issueList,
      priorityAssessment: this.generatePriorityAssessment(issues, scores)
    };
  }

  /**
   * Transform priority fix roadmap
   */
  static transformRoadmap(issues, scores) {
    const actions = this.generateRoadmapActions(issues, scores);
    
    return {
      actions,
      impactForecast: this.generateRoadmapForecast(actions)
    };
  }

  /**
   * Transform on-page SEO audit
   */
  static transformOnPageSEO(issues, pageMetrics) {
    const stats = this.calculateOnPageStats(issues);
    const issueList = this.generateOnPageIssues(issues);
    
    return {
      stats,
      issues: issueList,
      priorityRecommendation: this.generateOnPageRecommendation(issues, pageMetrics)
    };
  }

  /**
   * Identify key strengths from scores
   */
  static identifyStrengths(scores) {
    const strengths = [];
    
    // Check each component for strengths
    if (scores.performance >= 75) {
      strengths.push('Strong performance metrics');
    }
    
    if (scores.authority >= 70) {
      strengths.push('Solid domain authority');
    }
    
    if (scores.seoHealth >= 70) {
      strengths.push('Good SEO foundation');
    }
    
    if (scores.aiVisibility >= 60) {
      strengths.push('AI visibility optimization');
    }
    
    // Add technical strengths
    if (scores.componentScores?.technical >= 80) {
      strengths.push('Valid SSL certificate');
      strengths.push('XML sitemap accessible');
      strengths.push('Mobile-responsive design');
    }
    
    if (scores.componentScores?.content >= 70) {
      strengths.push('Content optimization');
    }
    
    // Ensure minimum strengths
    if (strengths.length < 3) {
      strengths.push('Active website monitoring');
      strengths.push('Regular SEO audits');
      strengths.push('Data-driven optimization');
    }
    
    return strengths.slice(0, 6); // Limit to 6 strengths
  }

  /**
   * Identify top issues from issue data
   */
  static identifyTopIssues(issues) {
    const issueList = [];
    
    // AI visibility issues
    if (issues.ai?.byRule) {
      issues.ai.byRule.slice(0, 5).forEach(rule => {
        issueList.push({
          category: 'AI Visibility',
          issue: rule.message || `Missing ${rule.category} optimization`,
          severity: rule.severity || 'medium',
          pages: rule.pagesAffected || 0
        });
      });
    }
    
    // Page issues
    if (issues.pages?.byType) {
      issues.pages.byType.slice(0, 3).forEach(issue => {
        issueList.push({
          category: 'Technical SEO',
          issue: issue.issueType || 'SEO optimization needed',
          severity: issue.severity || 'medium',
          pages: issue.pagesAffected || 0
        });
      });
    }
    
    // Ensure minimum issues
    if (issueList.length < 4) {
      issueList.push(
        { category: 'AI Visibility', issue: 'Missing JSON-LD schema', severity: 'high', pages: 0 },
        { category: 'Knowledge Graph', issue: 'Knowledge Graph not claimed', severity: 'high', pages: 0 },
        { category: 'Performance', issue: 'Mobile LCP optimization needed', severity: 'medium', pages: 0 }
      );
    }
    
    return issueList.slice(0, 6);
  }

  /**
   * Generate priority assessment text
   */
  static generatePriorityAssessment(issues, scores) {
    const totalIssues = issues.total || 0;
    const criticalIssues = issues.combined?.critical || 0;
    
    if (criticalIssues > 0) {
      return `${criticalIssues} critical issue${criticalIssues > 1 ? 's' : ''} require immediate attention. Focus on technical foundations before advanced optimizations.`;
    } else if (totalIssues > 15) {
      return `${totalIssues} issues detected - systematic approach recommended. Prioritize high-impact fixes for maximum ROI.`;
    } else if (totalIssues > 5) {
      return `${totalIssues} moderate issues identified. Quick wins available through targeted optimizations.`;
    } else {
      return 'Strong technical foundation with minimal issues. Focus on advanced optimizations and competitive advantages.';
    }
  }

  /**
   * Generate roadmap actions
   */
  static generateRoadmapActions(issues, scores) {
    const actions = [];
    let id = 1;
    
    // Critical fixes first
    if (issues.combined?.critical > 0) {
      actions.push({
        id: id++,
        issue: 'Fix critical technical issues',
        impact: 'High',
        effort: 'Medium',
        estimatedGain: `+${Math.min(15, issues.combined.critical * 3)} pts`,
        timeline: 'Day 1-3'
      });
    }
    
    // AI visibility improvements
    if (scores.aiVisibility < 70) {
      const aiGain = Math.min(20, Math.round((70 - scores.aiVisibility) * 0.7));
      actions.push({
        id: id++,
        issue: 'Implement AI visibility optimizations',
        impact: 'High',
        effort: 'Medium',
        estimatedGain: `+${aiGain} pts`,
        timeline: 'Day 4-7'
      });
    }
    
    // Schema implementation
    actions.push({
      id: id++,
      issue: 'Add comprehensive schema markup',
      impact: 'High',
      effort: 'Easy',
      estimatedGain: '+12 pts',
      timeline: 'Day 8-10'
    });
    
    // Performance optimization
    if (scores.performance < 75) {
      const perfGain = Math.min(15, Math.round((75 - scores.performance) * 0.5));
      actions.push({
        id: id++,
        issue: 'Optimize page performance',
        impact: 'Medium',
        effort: 'Medium',
        estimatedGain: `+${perfGain} pts`,
        timeline: 'Day 11-14'
      });
    }
    
    // Content optimization
    actions.push({
      id: id++,
      issue: 'Enhance content structure',
      impact: 'Medium',
      effort: 'Easy',
      estimatedGain: '+8 pts',
      timeline: 'Day 15-18'
    });
    
    // Authority building
    if (scores.authority < 60) {
      actions.push({
        id: id++,
        issue: 'Build domain authority',
        impact: 'Medium',
        effort: 'Hard',
        estimatedGain: '+10 pts',
        timeline: 'Day 19-30'
      });
    }
    
    return actions.slice(0, 8); // Limit to 8 actions
  }

  /**
   * Generate roadmap forecast
   */
  static generateRoadmapForecast(actions) {
    const totalGain = actions.reduce((sum, action) => {
      const gain = parseInt(action.estimatedGain.replace(/[^\d]/g, '')) || 0;
      return sum + gain;
    }, 0);
    
    return `Implementing all ${actions.length} recommended actions is projected to improve overall score by ${totalGain} points within 30 days, with most significant gains in the first two weeks.`;
  }

  /**
   * Calculate on-page SEO statistics
   */
  static calculateOnPageStats(issues) {
    const pageIssues = issues.pages || {};
    const aiIssues = issues.ai || {};
    
    return {
      critical: (pageIssues.summary?.criticalIssues || 0) + (aiIssues.bySeverity?.critical || 0),
      high: (pageIssues.summary?.highIssues || 0) + (aiIssues.bySeverity?.high || 0),
      medium: (pageIssues.summary?.mediumIssues || 0) + (aiIssues.bySeverity?.medium || 0),
      low: (pageIssues.summary?.lowIssues || 0) + (aiIssues.bySeverity?.low || 0)
    };
  }

  /**
   * Generate on-page SEO issues list
   */
  static generateOnPageIssues(issues) {
    const issueList = [];
    let id = 1;
    
    // Combine AI and page issues
    const allIssues = [];
    
    // Add AI issues
    if (issues.ai?.byRule) {
      issues.ai.byRule.forEach(rule => {
        allIssues.push({
          id: id++,
          issue: rule.message || `AI: ${rule.category} optimization`,
          severity: this.mapSeverity(rule.severity),
          pages: rule.pagesAffected || 0,
          impact: this.calculateImpact(rule.severity, rule.pagesAffected),
          recommendedFix: this.generateAIFix(rule.category, rule.severity)
        });
      });
    }
    
    // Add page issues
    if (issues.pages?.byType) {
      issues.pages.byType.forEach(issue => {
        allIssues.push({
          id: id++,
          issue: issue.issueType || 'SEO optimization needed',
          severity: this.mapSeverity(issue.severity),
          pages: issue.pagesAffected || 0,
          impact: this.calculateImpact(issue.severity, issue.pagesAffected),
          recommendedFix: this.generatePageFix(issue.issueType, issue.severity)
        });
      });
    }
    
    // Sort by impact and pages affected
    return allIssues
      .sort((a, b) => (b.pagesAffected * this.getImpactWeight(b.impact)) - (a.pagesAffected * this.getImpactWeight(a.impact)))
      .slice(0, 10); // Limit to top 10 issues
  }

  /**
   * Generate on-page SEO recommendation
   */
  static generateOnPageRecommendation(issues, pageMetrics) {
    const totalIssues = issues.total || 0;
    const totalPages = pageMetrics.total || 1;
    const issueRatio = (totalIssues / totalPages) * 100;
    
    if (issueRatio > 50) {
      return `High issue density (${issueRatio.toFixed(1)}% of pages affected). Prioritize technical fixes affecting multiple pages for maximum impact.`;
    } else if (totalIssues > 10) {
      return `${totalIssues} issues across ${totalPages} pages. Focus on schema implementation and AI visibility optimizations for quick wins.`;
    } else if (totalIssues > 0) {
      return `${totalIssues} minor issues identified. Address through routine optimization and content enhancement.`;
    } else {
      return 'Excellent on-page optimization with minimal issues. Focus on advanced AI visibility and competitive advantages.';
    }
  }

  /**
   * Map severity to standard format
   */
  static mapSeverity(severity) {
    const mapping = {
      'critical': 'CRITICAL',
      'high': 'HIGH',
      'medium': 'MEDIUM',
      'low': 'LOW'
    };
    
    return mapping[severity?.toLowerCase()] || 'MEDIUM';
  }

  /**
   * Calculate impact level
   */
  static calculateImpact(severity, pagesAffected) {
    if (severity === 'critical' || pagesAffected > 50) return 'High';
    if (severity === 'high' || pagesAffected > 20) return 'Medium';
    return 'Low';
  }

  /**
   * Get impact weight for sorting
   */
  static getImpactWeight(impact) {
    const weights = { 'High': 3, 'Medium': 2, 'Low': 1 };
    return weights[impact] || 1;
  }

  /**
   * Generate AI issue fix recommendation
   */
  static generateAIFix(category, severity) {
    const fixes = {
      'schema': 'Add comprehensive JSON-LD schema markup',
      'entities': 'Enhance entity coverage and topical authority',
      'content': 'Optimize content for AI search visibility',
      'structure': 'Improve content structure and formatting',
      'default': 'Implement AI visibility best practices'
    };
    
    return fixes[category?.toLowerCase()] || fixes.default;
  }

  /**
   * Generate page issue fix recommendation
   */
  static generatePageFix(issueType, severity) {
    const fixes = {
      'title': 'Optimize page titles for SEO',
      'meta': 'Add compelling meta descriptions',
      'h1': 'Ensure proper H1 tag usage',
      'canonical': 'Implement canonical URLs',
      'redirect': 'Fix redirect chains',
      'default': 'Apply SEO best practices'
    };
    
    const type = issueType?.toLowerCase() || 'default';
    return fixes[type] || fixes.default;
  }

  /**
   * Validate issues data
   */
  static validate(issuesData) {
    // Basic validation - issues data can be empty
    return true;
  }
}
