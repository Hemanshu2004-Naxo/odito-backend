/**
 * PDF Data Mapper - Main Orchestrator
 * Transforms raw data into frontend-ready PDF structure
 */

import { CoverMapper } from './sections/cover.mapper.js';
import { ExecutiveMapper } from './sections/executive.mapper.js';
import { IssuesMapper } from './sections/issues.mapper.js';
import { PerformanceMapper } from './sections/performance.mapper.js';
import { AIMapper } from './sections/ai.mapper.js';
import { TechnicalMapper } from './sections/technical.mapper.js';
import { KeywordsMapper } from './sections/keywords.mapper.js';
import { ContentMapper } from './sections/content.mapper.js';
import { FormatUtils } from '../utils/format.utils.js';

export class PDFDataMapper {
  
  /**
   * Transform all aggregated data into PDF-ready structure
   * @param {Object} aggregatedData - Raw data from aggregation service
   * @param {Object} calculatedMetrics - Calculated metrics from calculation service
   * @returns {Object} Complete PDF data structure
   */
  static transformToPDFData(aggregatedData, calculatedMetrics) {
    try {
      const { project, ai, technical, pages, links } = aggregatedData;
      const { scores, issues, pageMetrics, technicalMetrics, linkMetrics, aiMetrics, grades, percentages } = calculatedMetrics;

      // Main PDF structure matching frontend contract
      const pdfData = {
        // Cover Page
        cover: CoverMapper.transform(project, scores, issues, pageMetrics),
        
        // Executive Summary
        executiveSummary: ExecutiveMapper.transform(scores, issues, grades, aiMetrics),
        
        // Key Strengths vs Issues
        keyStrengths: IssuesMapper.transformStrengths(issues, scores),
        
        // Priority Fix Roadmap
        roadmap: IssuesMapper.transformRoadmap(issues, scores),
        
        // SEO Health Overview
        seoHealth: TechnicalMapper.transformSEOHealth(scores, grades, percentages),
        
        // On-Page SEO Audit
        onPageSEO: IssuesMapper.transformOnPageSEO(issues, pageMetrics),
        
        // Structured Data Analysis
        structuredData: AIMapper.transformStructuredData(ai, percentages),
        
        // Technical SEO Health
        technicalSEO: TechnicalMapper.transformTechnicalSEO(technicalMetrics, grades),
        
        // Crawlability Analysis
        crawlability: TechnicalMapper.transformCrawlability(pageMetrics, percentages),
        
        // Core Web Vitals
        coreWebVitals: PerformanceMapper.transformCoreWebVitals(calculatedMetrics.performanceMetrics, aggregatedData),
        
        // Performance Opportunities
        performance: PerformanceMapper.transformOpportunities(technicalMetrics),
        
        // Keyword Rankings
        keywords: KeywordsMapper.transformRankings(links, pageMetrics),
        
        // Keyword Opportunities
        keywordOpportunities: KeywordsMapper.transformOpportunities(),
        
        // AI Visibility Overview
        aiVisibility: AIMapper.transformVisibility(aiMetrics, scores, grades),
        
        // LLM Visibility Analysis
        llmVisibility: AIMapper.transformLLMVisibility(aiMetrics, percentages),
        
        // AI Content Readiness
        contentReadiness: ContentMapper.transformReadiness(aiMetrics, percentages),
        
        // Knowledge Graph Analysis
        knowledgeGraph: AIMapper.transformKnowledgeGraph(ai, percentages),
        
        // AI Optimization Recommendations
        aiOptimization: AIMapper.transformOptimization(issues, aiMetrics),
        
        // Growth Forecast
        growthForecast: this.transformGrowthForecast(scores, grades),
        
        // 30-Day Action Plan
        actionPlan: this.transformActionPlan(issues, scores),
        
        // Audit Methodology
        methodology: this.transformMethodology(),
        
        // About Odito AI
        about: this.transformAbout()
      };

      // Add metadata
      pdfData.metadata = {
        generatedAt: new Date(),
        projectId: project._id?.toString(),
        projectName: project.project_name,
        domain: project.main_url,
        dataFreshness: this.calculateDataFreshness(aggregatedData),
        version: '1.0.0'
      };

      return pdfData;

    } catch (error) {
      console.error('PDF Data Mapping Error:', error);
      throw new Error(`Failed to transform PDF data: ${error.message}`);
    }
  }

  /**
   * Transform growth forecast data
   */
  static transformGrowthForecast(scores, grades) {
    const current = {
      seo: scores.seoHealth,
      ai: scores.aiVisibility,
      performance: scores.performance,
      overall: scores.overall
    };

    // Calculate 30, 60, 90 day projections
    const projections = {
      current,
      day30: this.calculateProjection(current, 0.15), // 15% improvement potential
      day60: this.calculateProjection(current, 0.25), // 25% improvement potential
      day90: this.calculateProjection(current, 0.35)  // 35% improvement potential
    };

    return {
      projections: this.formatProjections(projections),
      milestones: this.formatMilestones(projections),
      projection: this.generateProjectionText(projections)
    };
  }

  /**
   * Calculate score projections
   */
  static calculateProjection(current, improvementFactor) {
    const projected = {};
    Object.entries(current).forEach(([key, value]) => {
      const gap = 100 - value;
      const improvement = gap * improvementFactor;
      projected[key] = Math.min(100, Math.round(value + improvement));
    });
    return projected;
  }

  /**
   * Format projections for charts
   */
  static formatProjections(projections) {
    return [
      { label: 'Current', seo: projections.current.seo, ai: projections.current.ai, performance: projections.current.performance },
      { label: '30 Days', seo: projections.day30.seo, ai: projections.day30.ai, performance: projections.day30.performance },
      { label: '60 Days', seo: projections.day60.seo, ai: projections.day60.ai, performance: projections.day60.performance },
      { label: '90 Days', seo: projections.day90.seo, ai: projections.day90.ai, performance: projections.day90.performance }
    ];
  }

  /**
   * Format milestone data
   */
  static formatMilestones(projections) {
    return [
      {
        milestone: 'Current',
        seo: projections.current.seo,
        ai: projections.current.ai,
        performance: projections.current.performance,
        overall: projections.current.overall
      },
      {
        milestone: '30 Days',
        seo: projections.day30.seo,
        ai: projections.day30.ai,
        performance: projections.day30.performance,
        overall: projections.day30.overall
      },
      {
        milestone: '60 Days',
        seo: projections.day60.seo,
        ai: projections.day60.ai,
        performance: projections.day60.performance,
        overall: projections.day60.overall
      },
      {
        milestone: '90 Days',
        seo: projections.day90.seo,
        ai: projections.day90.ai,
        performance: projections.day90.performance,
        overall: projections.day90.overall
      }
    ];
  }

  /**
   * Generate projection narrative text
   */
  static generateProjectionText(projections) {
    const overallImprovement = projections.day90.overall - projections.current.overall;
    const aiImprovement = projections.day90.ai - projections.current.ai;
    
    return `Projected ${overallImprovement}-point overall improvement in 90 days, with AI Visibility leading gains at +${aiImprovement} points through enhanced entity coverage and schema optimization.`;
  }

  /**
   * Transform 30-day action plan
   */
  static transformActionPlan(issues, scores) {
    return {
      weeks: [
        {
          week: 1,
          title: 'Technical Quick Wins',
          days: 'Days 1-7',
          tasks: [
            'Fix SSL certificate issues',
            'Implement HTTPS redirects',
            'Optimize robots.txt file',
            'Submit XML sitemap to search engines'
          ]
        },
        {
          week: 2,
          title: 'Schema Rollout',
          days: 'Days 8-14',
          tasks: [
            'Add Organization schema to homepage',
            'Implement Article schema on blog posts',
            'Add FAQPage schema to service pages',
            'Create Product/Service schema'
          ]
        },
        {
          week: 3,
          title: 'Content Optimization',
          days: 'Days 15-21',
          tasks: [
            'Optimize page titles and meta descriptions',
            'Add missing H1 tags to key pages',
            'Improve content length and quality',
            'Add internal linking structure'
          ]
        },
        {
          week: 4,
          title: 'AI Entity & Authority',
          days: 'Days 22-30',
          tasks: [
            'Claim and optimize Google Business Profile',
            'Build entity hub pages',
            'Enhance topical authority content',
            'Implement AI-optimized content structure'
          ]
        }
      ],
      impactForecast: this.generateActionPlanImpact(issues, scores)
    };
  }

  /**
   * Generate action plan impact text
   */
  static generateActionPlanImpact(issues, scores) {
    const issueReduction = Math.min(issues.total, Math.round(issues.total * 0.7));
    const scoreImprovement = Math.min(25, Math.round((100 - scores.overall) * 0.4));
    
    return `Expected to resolve ${issueReduction} issues and improve overall score by ${scoreImprovement} points within 30 days through systematic optimization approach.`;
  }

  /**
   * Transform methodology section
   */
  static transformMethodology() {
    return {
      steps: [
        {
          id: 1,
          title: 'Crawler Engine',
          description: 'Advanced web crawler analyzes site structure, content, and technical implementation across all pages.'
        },
        {
          id: 2,
          title: 'AI Entity Detection',
          description: 'Machine learning identifies entities, topics, and semantic relationships within content.'
        },
        {
          id: 3,
          title: 'Structured Data Validation',
          description: 'Comprehensive schema markup validation and optimization recommendations.'
        },
        {
          id: 4,
          title: 'LLM Citation Analysis',
          description: 'Analysis of brand visibility across AI platforms and language models.'
        },
        {
          id: 5,
          title: 'Core Web Vitals',
          description: 'Real-user and lab-based performance metrics analysis and optimization.'
        },
        {
          id: 6,
          title: 'Score Calculation',
          description: 'Weighted algorithm combines technical, content, AI visibility, and authority factors.'
        }
      ]
    };
  }

  /**
   * Transform about section
   */
  static transformAbout() {
    return {
      features: [
        {
          title: 'SEO Audit Engine',
          description: 'Comprehensive technical SEO analysis with actionable recommendations and priority scoring.'
        },
        {
          title: 'AI Visibility Suite',
          description: 'Advanced AI search optimization including entity analysis, schema validation, and LLM citation tracking.'
        },
        {
          title: 'Knowledge Graph Audit',
          description: 'Brand entity analysis and optimization for enhanced search engine understanding.'
        },
        {
          title: 'Core Web Vitals',
          description: 'Performance monitoring and optimization for user experience and search rankings.'
        },
        {
          title: 'Keyword Intelligence',
          description: 'Comprehensive keyword tracking, opportunity analysis, and competitive insights.'
        },
        {
          title: 'White-Label Reports',
          description: 'Professional, customizable reports for agencies and in-house teams.'
        }
      ]
    };
  }

  /**
   * Calculate data freshness indicator
   */
  static calculateDataFreshness(aggregatedData) {
    const timestamps = [
      aggregatedData.ai?.visibility?.completedAt,
      aggregatedData.technical?.createdAt,
      aggregatedData.metadata?.fetchedAt
    ].filter(Boolean);

    if (timestamps.length === 0) return 'unknown';

    const mostRecent = new Date(Math.max(...timestamps.map(ts => new Date(ts).getTime())));
    const hoursOld = (Date.now() - mostRecent.getTime()) / (1000 * 60 * 60);

    if (hoursOld < 1) return 'fresh';
    if (hoursOld < 24) return 'recent';
    if (hoursOld < 168) return 'week-old';
    return 'stale';
  }

  /**
   * Validate transformed data structure
   */
  static validatePDFData(pdfData) {
    const requiredSections = [
      'cover', 'executiveSummary', 'keyStrengths', 'roadmap',
      'seoHealth', 'onPageSEO', 'structuredData', 'technicalSEO',
      'crawlability', 'coreWebVitals', 'performance', 'keywords',
      'aiVisibility', 'methodology', 'about'
    ];

    const missing = requiredSections.filter(section => !pdfData[section]);
    
    if (missing.length > 0) {
      throw new Error(`Missing required PDF sections: ${missing.join(', ')}`);
    }

    return true;
  }

  /**
   * Get section summary for debugging
   */
  static getSectionSummary(pdfData) {
    return Object.keys(pdfData).reduce((summary, key) => {
      const value = pdfData[key];
      if (typeof value === 'object' && value !== null) {
        summary[key] = {
          type: Array.isArray(value) ? 'array' : 'object',
          keys: Object.keys(value).length,
          hasData: Object.keys(value).length > 0
        };
      } else {
        summary[key] = {
          type: typeof value,
          hasData: value != null
        };
      }
      return summary;
    }, {});
  }
}
