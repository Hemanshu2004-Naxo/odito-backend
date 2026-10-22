/**
 * Executive Summary Mapper
 * Maps aggregated data to executive summary format with optimized data reuse
 */

import { FormatUtils } from '../../utils/format.utils.js';
import { GradeUtils } from '../../utils/grade.utils.js';
import { PercentageUtils } from '../../utils/percentage.utils.js';
import { PDFCalculationService } from '../../service/pdfCalculationService.js';
import { PDFAggregationService } from '../../service/pdfAggregationService.js';

export class ExecutiveMapper {
  
  /**
   * Map executive summary data from aggregated sources
   * @param {Object} aggregatedData - Data from PDF aggregation service
   * @param {Object} coverData - Cover page scores (reused)
   * @returns {Object} Executive summary data
   */
  static async mapExecutiveSummary(aggregatedData, coverData) {
    try {
      console.log("EXECUTIVE MAPPER: Starting mapping with data:", {
        aggregatedDataKeys: Object.keys(aggregatedData || {}),
        coverDataKeys: Object.keys(coverData || {}),
        hasPages: !!(aggregatedData?.pages),
        hasOnpageIssues: !!(aggregatedData?.pages?.onpageIssues)
      });
      
      // Safe input validation
      if (!aggregatedData) {
        console.error("EXECUTIVE MAPPER: No aggregated data provided");
        return this.getSafeFallback("No aggregated data");
      }
      
      if (!coverData) {
        console.error("EXECUTIVE MAPPER: No cover data provided");
        return this.getSafeFallback("No cover data");
      }
      
      // Step 1: REUSE scores from cover data (DO NOT RECOMPUTE)
      const scores = {
        // null = unavailable (never coerced to 0)
        seoHealth: coverData?.scores?.seoHealth ?? null,
        aiVisibility: coverData?.scores?.aiVisibility ?? null,
        performance: coverData?.scores?.performance ?? null,
        technicalHealth: coverData?.scores?.technicalHealth ?? null
      };
      
      console.log("EXECUTIVE MAPPER: Extracted scores:", scores);
      
      // Step 2: Get projectId from aggregated data
      const projectId = aggregatedData?.project?._id?.toString() || aggregatedData?.project?.id;
      
      if (!projectId) {
        console.error("EXECUTIVE MAPPER: No projectId found");
        return this.getSafeFallback("No projectId found");
      }
      
      // Step 3: Use NEW aggregation function directly
      const counts = await PDFAggregationService.getOnPageIssueCounts(projectId);
      
      console.log("EXECUTIVE MAPPER: Got counts from aggregation:", counts);
      
      // Step 4: Build issues object using new aggregation results
      const issues = {
        critical: counts.critical,
        warnings: counts.warnings,
        informational: counts.informational,
        // No verified source for a 'passed' count; previously this was the
        // invented value max(0, 100 - totalIssues).
        passed: null
      };
      
      console.log("EXECUTIVE MAPPER: Final issues object:", issues);
      console.log("EXECUTIVE MAPPER: Critical issues count:", issues.critical);
      console.log("EXECUTIVE MAPPER: Raw counts from aggregation:", counts);
      
      // Step 5: Build issue distribution with correct structure
      const issueDistribution = {
        total: counts.totalIssues,
        critical: issues.critical,
        medium: issues.warnings,  // Map warnings to medium
        info: issues.informational  // Map informational to info
      };
      
      // Step 6: FIX TOP ISSUES - Use detailed on-page issues from helper methods
      console.log("ON PAGE ISSUES:", aggregatedData?.pages?.onpageIssues?.length || 0);
      const topIssues = await this.getTopIssues(projectId);
      console.log("TOP ISSUES FINAL:", topIssues);
      
      // Step 7: FIX TECHNICAL HIGHLIGHTS - Use technical checks from helper methods
      console.log("TECHNICAL DATA:", aggregatedData?.technical);
      const technicalHighlights = await this.getTechnicalHighlights(projectId);
      console.log("TECH CHECKS FINAL:", technicalHighlights);
      
      // Step 8: FIX PERFORMANCE METRICS - Use performance scores from helper methods
      console.log("PERFORMANCE DATA:", aggregatedData?.performance);
      const performanceMetrics = await this.getPerformanceMetrics(projectId);
      console.log("PERFORMANCE FINAL:", performanceMetrics);
      
      // Step 9: Build final response with exact required structure
      const executiveSummary = {
        scores,
        issues,
        issueDistribution,
        topIssues,
        technicalHighlights,
        performanceMetrics,
        metadata: {
          totalIssues: counts.totalIssues,
          pagesAnalyzed: 0, // Not needed for new approach
          generatedAt: new Date()
        }
      };
      
      console.log("EXECUTIVE MAPPER: Final executive summary:", executiveSummary);
      
      return {
        success: true,
        data: executiveSummary
      };
      
    } catch (error) {
      console.error('EXECUTIVE MAPPER ERROR:', error.stack);
      return this.getSafeFallback(error.message);
    }
  }
  
  /**
   * Get top issues from aggregated data
   * @param {string} projectId - Project ID
   * @returns {Object} Top issues grouped by severity
   */
  static async getTopIssues(projectId) {
    try {
      console.log("GETTING TOP ISSUES from aggregated data for projectId:", projectId);
      
      // Get top issues from aggregatedData directly (not via API call)
      const { db, ObjectId } = PDFAggregationService.getDbConnection();
      const projectIdObj = new ObjectId(projectId);
      
      // Fetch top issues directly from database
      const issues = await db.collection('seo_page_issues')
        .find({ projectId: projectIdObj, status: { $ne: 'excluded' } })
        .sort({ severity: -1, page_url: 1 })
        .limit(50)
        .toArray();
      
      console.log("AGGREGATED TOP ISSUES COUNT:", issues.length);
      
      // Group by severity
      const high = issues.filter(i => i.severity === 'high').slice(0, 3);
      const medium = issues.filter(i => i.severity === 'medium').slice(0, 2);
      const low = issues.filter(i => i.severity === 'low').slice(0, 1);
      
      const topIssues = {
        high,
        medium,
        low
      };
      
      console.log("TOP ISSUES MAPPED:", topIssues);
      return topIssues;
      
    } catch (error) {
      console.error("ERROR GETTING TOP ISSUES:", error);
      return {
        high: [],
        medium: [],
        low: []
      };
    }
  }

  /**
   * Get technical highlights from aggregated data
   * @param {string} projectId - Project ID
   * @returns {Object} Technical highlights with checks
   */
  static async getTechnicalHighlights(projectId) {
    try {
      console.log("GETTING TECHNICAL HIGHLIGHTS from aggregated data for projectId:", projectId);
      
      // Get technical data from aggregatedData directly (not via API call)
      const { db, ObjectId } = PDFAggregationService.getDbConnection();
      const projectIdObj = new ObjectId(projectId);
      
      // Fetch technical data directly from database
      const technicalData = await db.collection('domain_technical_reports')
        .findOne({ projectId: projectIdObj });
      
      console.log("AGGREGATED TECHNICAL DATA:", technicalData);
      
      // Extract checks from technical data
      const checks = technicalData?.checks || technicalData?.results || [];
      const technicalHighlights = {
        checks: checks.slice(0, 12)
      };
      
      console.log("TECHNICAL HIGHLIGHTS MAPPED:", technicalHighlights);
      return technicalHighlights;
      
    } catch (error) {
      console.error("ERROR GETTING TECHNICAL HIGHLIGHTS:", error);
      return {
        checks: []
      };
    }
  }

  /**
   * Get performance metrics from aggregated data
   * @param {string} projectId - Project ID
   * @returns {Object} Performance metrics with mobile and desktop scores
   */
  static async getPerformanceMetrics(projectId) {
    try {
      console.log("GETTING PERFORMANCE METRICS from aggregated data for projectId:", projectId);
      
      // Get performance metrics from aggregatedData directly (not via API call)
      const { db, ObjectId } = PDFAggregationService.getDbConnection();
      const projectIdObj = new ObjectId(projectId);
      
      // Fetch performance data directly from database
      const performanceData = await db.collection('seo_domain_performance')
        .findOne({ project_id: projectIdObj }, {
          mobile: 1,
          desktop: 1
        });
      
      console.log("AGGREGATED PERFORMANCE DATA:", performanceData);
      
      // Map only scores as requested
      const performanceMetrics = {
        mobileScore: performanceData?.mobile?.performance_score ?? performanceData?.mobile?.score ?? null,
        desktopScore: performanceData?.desktop?.performance_score ?? performanceData?.desktop?.score ?? null
      };
      
      console.log("PERFORMANCE METRICS MAPPED:", performanceMetrics);
      return performanceMetrics;
      
    } catch (error) {
      console.error("ERROR GETTING PERFORMANCE METRICS:", error);
      return {
        mobileScore: null,
        desktopScore: null
      };
    }
  }

  /**
   * Get safe fallback response
   */
  static getSafeFallback(errorReason = 'Unknown error') {
    console.error('EXECUTIVE MAPPER: summary unavailable:', errorReason);

    // A failure must not look like a successful, zero-issue audit.
    return {
      success: false,
      error: {
        message: 'Executive summary data is unavailable',
        code: 'EXECUTIVE_SUMMARY_UNAVAILABLE',
        details: errorReason
      }
    };
  }

  /**
   * Calculate passed checks estimate
   */
  static calculatePassedChecks(issues) {
    // Estimate based on total issues vs potential checks
    const totalIssues = issues.total || 0;
    const estimatedPotentialChecks = Math.max(100, totalIssues * 3);
    const passedChecks = Math.max(0, estimatedPotentialChecks - totalIssues);
    
    return FormatUtils.formatNumber(passedChecks);
  }

  /**
   * Calculate issue distribution percentages
   */
  static calculateIssueDistribution(issues) {
    const combined = issues.combined || {};
    const total = combined.critical + combined.high + combined.medium + combined.low;
    
    if (total === 0) {
      return {
        critical: { count: 0, percentage: 0 },
        warnings: { count: 0, percentage: 0 },
        info: { count: 0, percentage: 0 },
        passed: { count: 100, percentage: 100 }
      };
    }

    return {
      critical: {
        count: combined.critical || 0,
        percentage: PercentageUtils.calculatePercentage(combined.critical, total, 1)
      },
      warnings: {
        count: combined.high || 0,
        percentage: PercentageUtils.calculatePercentage(combined.high, total, 1)
      },
      info: {
        count: (combined.medium || 0) + (combined.low || 0),
        percentage: PercentageUtils.calculatePercentage(
          (combined.medium || 0) + (combined.low || 0), 
          total, 
          1
        )
      },
      passed: {
        count: this.calculatePassedChecks(issues),
        percentage: PercentageUtils.calculatePercentage(
          this.calculatePassedChecks(issues),
          total + this.calculatePassedChecks(issues),
          1
        )
      }
    };
  }

  /**
   * Generate key insights
   */
  static generateKeyInsights(scores, issues, grades) {
    const insights = [];
    
    // Overall performance insight
    if (scores.overall >= 80) {
      insights.push({
        type: 'positive',
        title: 'Strong Overall Performance',
        description: `Site achieves ${grades.overall.status} status with ${scores.overall}/100 overall score.`
      });
    } else if (scores.overall < 50) {
      insights.push({
        type: 'critical',
        title: 'Requires Immediate Attention',
        description: `Overall score of ${scores.overall}/100 indicates critical optimization needs.`
      });
    }
    
    // AI visibility insight
    const aiGap = 100 - scores.aiVisibility;
    if (aiGap > 30) {
      insights.push({
        type: 'opportunity',
        title: 'Significant AI Opportunity',
        description: `${aiGap}-point AI visibility gap represents major growth potential in AI search.`
      });
    }
    
    // Issue severity insight
    const criticalIssues = issues.combined?.critical || 0;
    if (criticalIssues > 0) {
      insights.push({
        type: 'warning',
        title: 'Critical Issues Detected',
        description: `${criticalIssues} critical issue${criticalIssues > 1 ? 's' : ''} require immediate resolution.`
      });
    }
    
    // Performance insight
    if (scores.performance >= 85) {
      insights.push({
        type: 'positive',
        title: 'Excellent Performance',
        description: 'Performance metrics exceed industry standards, providing competitive advantage.'
      });
    } else if (scores.performance < 60) {
      insights.push({
        type: 'critical',
        title: 'Performance Optimization Needed',
        description: 'Performance improvements could significantly impact user experience and rankings.'
      });
    }
    
    // Authority insight
    if (scores.authority >= 75) {
      insights.push({
        type: 'positive',
        title: 'Strong Domain Authority',
        description: 'Link profile and authority metrics indicate strong competitive positioning.'
      });
    } else if (scores.authority < 50) {
      insights.push({
        type: 'opportunity',
        title: 'Authority Building Opportunity',
        description: 'Link building and authority enhancement could provide significant ranking benefits.'
      });
    }
    
    return insights.slice(0, 4); // Limit to top 4 insights
  }

  /**
   * Generate trend indicators
   */
  static generateTrendIndicators(currentScores, previousScores = null) {
    if (!previousScores) {
      // Return neutral trends if no previous data
      return {
        overall: { direction: 'neutral', change: 0, percentage: 0 },
        seoHealth: { direction: 'neutral', change: 0, percentage: 0 },
        aiVisibility: { direction: 'neutral', change: 0, percentage: 0 },
        performance: { direction: 'neutral', change: 0, percentage: 0 },
        authority: { direction: 'neutral', change: 0, percentage: 0 }
      };
    }

    return {
      overall: this.calculateTrend(currentScores.overall, previousScores.overall),
      seoHealth: this.calculateTrend(currentScores.seoHealth, previousScores.seoHealth),
      aiVisibility: this.calculateTrend(currentScores.aiVisibility, previousScores.aiVisibility),
      performance: this.calculateTrend(currentScores.performance, previousScores.performance),
      authority: this.calculateTrend(currentScores.authority, previousScores.authority)
    };
  }

  /**
   * Calculate trend for a single metric
   */
  static calculateTrend(current, previous) {
    if (previous == null || previous === 0) {
      return { direction: 'neutral', change: 0, percentage: 0 };
    }

    const change = current - previous;
    const percentage = PercentageUtils.calculatePercentageChange(current, previous, 1);
    
    let direction = 'neutral';
    if (change > 2) direction = 'positive';
    else if (change < -2) direction = 'negative';

    return {
      direction,
      change: FormatUtils.formatNumber(change),
      percentage
    };
  }

  /**
   * Generate executive summary highlights
   */
  static generateHighlights(scores, issues, grades) {
    return {
      topScore: Math.max(scores.seoHealth, scores.aiVisibility, scores.performance, scores.authority),
      lowestScore: Math.min(scores.seoHealth, scores.aiVisibility, scores.performance, scores.authority),
      totalIssues: issues.total || 0,
      criticalIssues: issues.combined?.critical || 0,
      overallGrade: grades.overall.grade,
      performanceStatus: GradeUtils.getPerformanceRating(scores.overall)
    };
  }

  /**
   * Validate executive summary data
   */
  static validate(executiveData) {
    const required = ['scores', 'issues', 'issueDistribution'];
    const missing = required.filter(field => executiveData[field] == null);
    
    if (missing.length > 0) {
      throw new Error(`Executive mapper missing required fields: ${missing.join(', ')}`);
    }
    
    return true;
  }
}
