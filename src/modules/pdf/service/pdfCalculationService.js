/**
 * PDF Data Calculation Service
 * Handles all score calculations, aggregations, and derived metrics
 */

import { ScoreUtils } from '../utils/score.utils.js';
import { GradeUtils } from '../utils/grade.utils.js';
import { PercentageUtils } from '../utils/percentage.utils.js';
import { FormatUtils } from '../utils/format.utils.js';

export class PDFCalculationService {
  
  /**
   * Calculate all scores and metrics from aggregated data
   * @param {Object} aggregatedData - Raw data from aggregation service
   * @returns {Object} Calculated metrics and scores
   */
  static calculateAllMetrics(aggregatedData) {
    const { project, ai, technical, pages, links } = aggregatedData;

    return {
      // Core scores
      scores: this.calculateCoreScores(ai, technical, pages),
      
      // Issue calculations
      issues: this.calculateIssueMetrics(ai.issues, pages.issues),
      
      // Page metrics
      pageMetrics: this.calculatePageMetrics(pages.data, pages.issues),
      
      // Technical metrics
      technicalMetrics: this.calculateTechnicalMetrics(technical),
      
      // Link metrics
      linkMetrics: this.calculateLinkMetrics(links),
      
      // AI visibility metrics
      aiMetrics: this.calculateAIMetrics(ai),
      
      // Performance metrics
      performanceMetrics: this.calculatePerformanceMetrics(technical),
      
      // Grade information
      grades: this.calculateAllGrades(ai, technical, pages),
      
      // Percentages and distributions
      percentages: this.calculateAllPercentages(pages, ai, technical),
      
      // Trend data (placeholder for future implementation)
      trends: this.calculateTrends(aggregatedData)
    };
  }

  /**
   * Calculate core scores for the main dashboard
   */
  static calculateCoreScores(ai, technical, pages) {
    // Extract individual component scores
    const aiVisibility = ScoreUtils.safeExtractScore(ai, 'summary.overallScore', 0);
    const seoHealth = this.calculateSEOHealthScore(pages);
    const performance = this.calculatePerformanceScore(technical);
    const authority = this.calculateAuthorityScore(links);

    // Calculate overall score
    const overall = ScoreUtils.calculateOverallScore({
      seoHealth,
      aiVisibility,
      performance,
      authority
    });

    return {
      overall,
      seoHealth,
      aiVisibility,
      performance,
      authority,
      
      // Additional score breakdowns
      componentScores: {
        technical: this.calculateTechnicalScore(technical),
        content: this.calculateContentScore(pages),
        entities: this.calculateEntityScore(ai.entities),
        schema: this.calculateSchemaScore(ai)
      }
    };
  }

  /**
   * Calculate SEO Health score from page data
   */
  static calculateSEOHealthScore(pages) {
    const pageData = pages?.data || {};
    const issueData = pages?.issues || {};
    
    let healthScore = 100;
    let totalWeight = 0;
    let weightedScore = 0;

    // Page optimization factors (40% weight)
    if (pageData.totalPages > 0) {
      const optimizationScore = PercentageUtils.calculateSuccessRate(
        (pageData.pagesWithH1 || 0) + 
        (pageData.pagesWithCanonical || 0) + 
        (pageData.pagesWithMetaDesc || 0),
        pageData.totalPages * 3
      );
      weightedScore += optimizationScore * 0.4;
      totalWeight += 0.4;
    }

    // Issue ratio (30% weight)
    if (pageData.totalPages > 0) {
      const issueRatio = Math.max(0, 100 - PercentageUtils.calculateFailureRate(
        issueData.summary?.totalIssues || 0,
        pageData.totalPages
      ));
      weightedScore += issueRatio * 0.3;
      totalWeight += 0.3;
    }

    // Index coverage (30% weight)
    if (pageData.totalPages > 0) {
      const indexCoverage = PercentageUtils.calculateIndexRate(
        pageData.indexedPages || 0,
        pageData.totalPages
      );
      weightedScore += indexCoverage * 0.3;
      totalWeight += 0.3;
    }

    return totalWeight > 0 ? Math.round(weightedScore) : 0;
  }

  /**
   * Calculate Performance score from technical data
   */
  static calculatePerformanceScore(technical) {
    let score = 100;
    let deductions = 0;

    // SSL certificate (20%)
    if (!technical?.sslValid) deductions += 20;

    // HTTPS redirect (15%)
    if (!technical?.httpsRedirect) deductions += 15;

    // Robots.txt (15%)
    if (!technical?.robotsExists) deductions += 15;

    // Sitemap (15%)
    if (!technical?.sitemapExists) deductions += 15;

    // Sitemap validation (10%)
    if (technical?.sitemapDeepValidation?.non_200_urls > 0) {
      deductions += 10;
    }

    // SSL expiry (10%)
    if (technical?.sslDaysRemaining < 30) deductions += 10;

    // Final score
    return Math.max(0, 100 - deductions);
  }

  /**
   * Calculate Authority score from link data
   * External links disabled - redistributed weight to internal/social links
   */
  static calculateAuthorityScore(links) {
    const internal = links?.internal || {};
    const external = links?.external || {};
    const social = links?.social || {};

    // Base score from link diversity
    let score = 0;

    // Internal links (60% of authority - increased from 40%)
    if (internal.total > 0) {
      score += Math.min(60, internal.total / 6.67);
    }

    // External links disabled (0% of authority)
    // External link analysis disabled to improve data quality and reduce processing time

    // Social links (40% of authority - increased from 20%)
    if (social.total > 0) {
      score += Math.min(40, social.platforms * 10);
    }

    return Math.round(Math.min(100, score));
  }

  /**
   * Calculate technical score components
   */
  static calculateTechnicalScore(technical) {
    const checks = [
      { name: 'ssl', value: technical?.sslValid, weight: 20 },
      { name: 'robots', value: technical?.robotsExists, weight: 15 },
      { name: 'sitemap', value: technical?.sitemapExists, weight: 15 },
      { name: 'https', value: technical?.httpsRedirect, weight: 15 },
      { name: 'sitemapValid', value: (technical?.sitemapDeepValidation?.non_200_urls || 0) === 0, weight: 10 },
      { name: 'sslExpiry', value: (technical?.sslDaysRemaining || 0) > 30, weight: 10 },
      { name: 'redirectChain', value: (technical?.redirectChain?.length || 0) <= 3, weight: 15 }
    ];

    let totalScore = 0;
    let totalWeight = 0;

    checks.forEach(check => {
      if (check.value) {
        totalScore += check.weight;
      }
      totalWeight += check.weight;
    });

    return totalWeight > 0 ? Math.round((totalScore / totalWeight) * 100) : 0;
  }

  /**
   * Calculate content score from page data
   */
  static calculateContentScore(pages) {
    const pageData = pages?.data || {};
    
    if (!pageData.totalPages) return 0;

    const factors = {
      titleCoverage: {
        value: PercentageUtils.calculateSuccessRate(pageData.pagesWithTitle, pageData.totalPages),
        weight: 30
      },
      metaDescriptionCoverage: {
        value: PercentageUtils.calculateSuccessRate(pageData.pagesWithMetaDesc, pageData.totalPages),
        weight: 25
      },
      h1Coverage: {
        value: PercentageUtils.calculateSuccessRate(pageData.pagesWithH1, pageData.totalPages),
        weight: 25
      },
      contentLength: {
        value: Math.min(100, (pageData.avgWordCount || 0) / 5), // 500 words = 100%
        weight: 20
      }
    };

    return ScoreUtils.calculateHealthScore(factors);
  }

  /**
   * Calculate entity score from AI entity data
   */
  static calculateEntityScore(entities) {
    const entitySummary = entities?.summary || {};
    
    if (!entitySummary.totalEntities) return 0;

    const factors = {
      entityCount: {
        value: Math.min(100, entitySummary.totalEntities / 2), // 50 entities = 100%
        weight: 30
      },
      avgImportance: {
        value: entitySummary.avgImportance || 0,
        weight: 40
      },
      avgConfidence: {
        value: entitySummary.avgConfidence || 0,
        weight: 30
      }
    };

    return ScoreUtils.calculateHealthScore(factors);
  }

  /**
   * Calculate schema score from AI visibility data
   */
  static calculateSchemaScore(ai) {
    const aggregates = ai?.visibility?.aggregates || {};
    
    if (!aggregates.totalPages) return 0;

    const schemaCoverage = PercentageUtils.calculateCoverage(
      aggregates.pagesWithSchema || 0,
      aggregates.totalPages
    );

    // Factor in entity count as schema quality indicator
    const entityFactor = Math.min(100, (aggregates.avgEntities || 0) * 10);

    return Math.round((schemaCoverage * 0.7) + (entityFactor * 0.3));
  }

  /**
   * Calculate comprehensive issue metrics
   */
  static calculateIssueMetrics(aiIssues, pageIssues) {
    // AI visibility issues
    const aiSeverityBreakdown = this.processSeverityBreakdown(aiIssues?.bySeverity || []);
    const aiCategoryBreakdown = aiIssues?.byCategory || [];
    const aiRuleBreakdown = aiIssues?.byRule || [];

    // Page issues
    const pageIssueStats = pageIssues?.summary || {};
    const pageIssueTypes = pageIssues?.byType || [];

    // Combine and normalize
    const totalAIIssues = aiSeverityBreakdown.total;
    const totalPageIssues = pageIssueStats.totalIssues || 0;

    return {
      total: totalAIIssues + totalPageIssues,
      ai: {
        total: totalAIIssues,
        bySeverity: aiSeverityBreakdown,
        byCategory: aiCategoryBreakdown,
        byRule: aiRuleBreakdown
      },
      pages: {
        total: totalPageIssues,
        summary: pageIssueStats,
        byType: pageIssueTypes
      },
      combined: {
        critical: (aiSeverityBreakdown.critical || 0) + (pageIssueStats.criticalIssues || 0),
        high: (aiSeverityBreakdown.high || 0) + (pageIssueStats.highIssues || 0),
        medium: (aiSeverityBreakdown.medium || 0) + (pageIssueStats.mediumIssues || 0),
        low: (aiSeverityBreakdown.low || 0) + (pageIssueStats.lowIssues || 0)
      }
    };
  }

  /**
   * Process severity breakdown into consistent format
   */
  static processSeverityBreakdown(severityArray) {
    const breakdown = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      total: 0
    };

    severityArray.forEach(item => {
      const severity = item.severity?.toLowerCase();
      const count = item.count || 0;
      
      if (breakdown.hasOwnProperty(severity)) {
        breakdown[severity] += count;
        breakdown.total += count;
      }
    });

    return breakdown;
  }

  /**
   * Calculate page-level metrics
   */
  static calculatePageMetrics(pageData, pageIssues) {
    const data = pageData || {};
    const issues = pageIssues || {};

    return {
      total: data.totalPages || 0,
      indexed: data.indexedPages || 0,
      withIssues: issues.summary?.totalIssues || 0,
      healthy: Math.max(0, (data.totalPages || 0) - (issues.summary?.totalIssues || 0)),
      
      optimization: {
        withTitle: data.pagesWithTitle || 0,
        withMetaDesc: data.pagesWithMetaDesc || 0,
        withH1: data.pagesWithH1 || 0,
        withCanonical: data.pagesWithCanonical || 0
      },
      
      content: {
        avgWordCount: Math.round(data.avgWordCount || 0),
        totalWordCount: data.totalWordCount || 0
      },
      
      coverage: {
        titleCoverage: PercentageUtils.calculateCoverage(data.pagesWithTitle, data.totalPages),
        metaDescCoverage: PercentageUtils.calculateCoverage(data.pagesWithMetaDesc, data.totalPages),
        h1Coverage: PercentageUtils.calculateCoverage(data.pagesWithH1, data.totalPages),
        canonicalCoverage: PercentageUtils.calculateCoverage(data.pagesWithCanonical, data.totalPages)
      }
    };
  }

  /**
   * Calculate technical metrics
   */
  static calculateTechnicalMetrics(technical) {
    return {
      ssl: {
        valid: technical?.sslValid || false,
        expiryDate: technical?.sslExpiryDate,
        daysRemaining: technical?.sslDaysRemaining || 0
      },
      robots: {
        exists: technical?.robotsExists || false,
        status: technical?.robotsStatus,
        accessible: (technical?.robotsStatus || 0) === 200
      },
      sitemap: {
        exists: technical?.sitemapExists || false,
        status: technical?.sitemapStatus,
        urlCount: technical?.parsedSitemapUrlCount || 0,
        validation: technical?.sitemapDeepValidation || {}
      },
      redirects: {
        httpsEnabled: technical?.httpsRedirect || false,
        redirectChain: technical?.redirectChain || [],
        finalUrl: technical?.finalUrl
      }
    };
  }

  /**
   * Calculate link metrics (external links disabled)
   */
  static calculateLinkMetrics(links) {
    const internal = links?.internal || {};
    const external = { total: 0, uniqueDomains: 0 };  // External links disabled
    const social = links?.social || {};

    return {
      total: (internal.total || 0) + (social.total || 0),  // External excluded
      internal,
      external,
      social,
      
      diversity: {
        internalSourcePages: internal.sourcePages || 0,
        internalTargetPages: internal.targetPages || 0,
        externalDomains: 0,  // External links disabled
        socialPlatforms: social.platforms || 0
      }
    };
  }

  /**
   * Calculate AI visibility metrics
   */
  static calculateAIMetrics(ai) {
    const visibility = ai?.visibility || {};
    const issues = ai?.issues || {};
    const entities = ai?.entities || {};
    const pageScores = ai?.pageScores || {};

    return {
      overall: {
        score: visibility.summary?.overallScore || 0,
        grade: visibility.summary?.grade || 'F',
        status: visibility.status || 'pending',
        completedAt: visibility.completedAt
      },
      
      aggregates: visibility.aggregates || {},
      
      entities: {
        total: entities.summary?.totalEntities || 0,
        avgImportance: Math.round(entities.summary?.avgImportance || 0),
        avgConfidence: Math.round(entities.summary?.avgConfidence || 0),
        typeDistribution: entities.byType || []
      },
      
      scoring: {
        pagesScored: pageScores.totalScored || 0,
        avgBlocking: Math.round(pageScores.avgBlocking || 0),
        avgCompleteness: Math.round(pageScores.avgCompleteness || 0),
        avgQuality: Math.round(pageScores.avgQuality || 0)
      }
    };
  }

  /**
   * Calculate performance metrics
   */
  static calculatePerformanceMetrics(technical) {
    // Placeholder for Core Web Vitals and performance data
    // This would be enhanced when performance data is available
    return {
      overall: this.calculatePerformanceScore(technical),
      technical: this.calculateTechnicalScore(technical),
      
      // Placeholder metrics for future implementation
      coreWebVitals: {
        lcp: { value: 0, rating: 'unknown' },
        fid: { value: 0, rating: 'unknown' },
        cls: { value: 0, rating: 'unknown' }
      },
      
      lighthouse: {
        desktop: { score: 0, performance: 0, accessibility: 0, bestPractices: 0, seo: 0 },
        mobile: { score: 0, performance: 0, accessibility: 0, bestPractices: 0, seo: 0 }
      }
    };
  }

  /**
   * Calculate all grades for different sections
   */
  static calculateAllGrades(ai, technical, pages) {
    const scores = this.calculateCoreScores(ai, technical, pages);
    
    return {
      overall: GradeUtils.getGrade(scores.overall),
      seoHealth: GradeUtils.getGrade(scores.seoHealth),
      aiVisibility: GradeUtils.getGrade(scores.aiVisibility),
      performance: GradeUtils.getGrade(scores.performance),
      authority: GradeUtils.getGrade(scores.authority),
      technical: GradeUtils.getGrade(scores.componentScores.technical),
      content: GradeUtils.getGrade(scores.componentScores.content),
      entities: GradeUtils.getGrade(scores.componentScores.entities),
      schema: GradeUtils.getGrade(scores.componentScores.schema)
    };
  }

  /**
   * Calculate all percentages and distributions
   */
  static calculateAllPercentages(pages, ai, technical) {
    const pageData = pages?.data || {};
    const aiData = ai?.visibility?.aggregates || {};
    
    return {
      pageCoverage: {
        indexed: PercentageUtils.calculateIndexRate(pageData.indexedPages, pageData.totalPages),
        withIssues: PercentageUtils.calculateFailureRate(pages?.issues?.summary?.totalIssues, pageData.totalPages),
        healthy: PercentageUtils.calculateSuccessRate(
          (pageData.totalPages || 0) - (pages?.issues?.summary?.totalIssues || 0),
          pageData.totalPages
        )
      },
      
      optimization: {
        title: PercentageUtils.calculateCoverage(pageData.pagesWithTitle, pageData.totalPages),
        metaDesc: PercentageUtils.calculateCoverage(pageData.pagesWithMetaDesc, pageData.totalPages),
        h1: PercentageUtils.calculateCoverage(pageData.pagesWithH1, pageData.totalPages),
        canonical: PercentageUtils.calculateCoverage(pageData.pagesWithCanonical, pageData.totalPages)
      },
      
      ai: {
        schemaCoverage: PercentageUtils.calculateCoverage(aiData.pagesWithSchema, aiData.totalPages),
        entityCoverage: PercentageUtils.calculateCoverage(
          aiData.totalEntities || 0,
          (aiData.totalPages || 0) * 5 // Assume 5 entities per page is ideal
        )
      },
      
      technical: {
        sslValid: technical?.sslValid ? 100 : 0,
        robotsAccessible: technical?.robotsExists ? 100 : 0,
        sitemapAccessible: technical?.sitemapExists ? 100 : 0,
        httpsEnabled: technical?.httpsRedirect ? 100 : 0
      }
    };
  }

  /**
   * Calculate trend data (placeholder for future implementation)
   */
  static calculateTrends(aggregatedData) {
    // This would be implemented when historical data is available
    return {
      overall: { direction: 'neutral', change: 0, percentage: 0 },
      seoHealth: { direction: 'neutral', change: 0, percentage: 0 },
      aiVisibility: { direction: 'neutral', change: 0, percentage: 0 },
      performance: { direction: 'neutral', change: 0, percentage: 0 },
      authority: { direction: 'neutral', change: 0, percentage: 0 }
    };
  }

  /**
   * Calculate forecast projections (placeholder)
   */
  static calculateForecastProjections(currentScores, timeframe = 90) {
    const projections = {};
    
    Object.entries(currentScores).forEach(([metric, currentScore]) => {
      // Simple projection based on improvement potential
      const improvementPotential = Math.max(0, 100 - currentScore);
      const projectedImprovement = improvementPotential * 0.3; // Assume 30% of gap can be closed
      
      projections[metric] = {
        current: currentScore,
        projected: Math.min(100, Math.round(currentScore + projectedImprovement)),
        potential: Math.min(100, Math.round(currentScore + improvementPotential))
      };
    });
    
    return projections;
  }

  /**
   * Calculate Executive Summary data with correct mapping
   * Uses direct aggregation from seo_page_issues collection
   */
  static calculateExecutiveSummary(aggregatedData) {
    try {
      console.log("CALCULATION LAYER: Starting executive summary calculation");
      
      const onpageData = aggregatedData?.pages?.onpageIssues || {};
      
      console.log("CALCULATION INPUT: Onpage data:", onpageData);
      
      // Direct mapping from aggregation results
      const totalIssues = onpageData?.totalIssues || 0;
      const critical = onpageData?.critical || 0;      // severity = "high"
      const warnings = onpageData?.warnings || 0;      // severity = "medium"  
      const informational = onpageData?.informational || 0; // severity = "low" OR "info"
      
      console.log("CALCULATION EXTRACTION: ", { totalIssues, critical, warnings, informational });
      
      // Return the exact structure required by executive mapper
      const result = {
        critical: critical,              // Critical issues (high severity)
        warnings: warnings,              // Warning issues (medium severity)
        informational: informational,    // Informational issues (low/info severity)
        passed: Math.max(0, 100 - totalIssues) // Passed checks estimate
      };
      
      console.log("CALCULATION MAPPING:", result);
      
      return result;
      
    } catch (error) {
      console.error("CALCULATION ERROR:", error);
      // Safe fallback
      return {
        critical: 0,
        warnings: 0,
        informational: 0,
        passed: 0
      };
    }
  }
}
