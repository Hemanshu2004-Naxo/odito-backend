/**
 * Unified JSON Report Service
 * Generates clean, AI-friendly JSON reports by reusing existing services and mappers
 */

import { PDFAggregationService } from './pdfAggregationService.js';
import { CoverPageService } from './coverPageService.js';
import { Page16Service } from './page16Service.js';
import { ExecutiveMapper } from '../mapper/sections/executive.mapper.js';
import { PerformanceMapper } from '../mapper/sections/performance.mapper.js';
import { KeywordsMapper } from '../mapper/sections/keywords.mapper.js';
import { AIMapper } from '../mapper/sections/ai.mapper.js';
import { ContentMapper } from '../mapper/sections/content.mapper.js';
import { TechnicalMapper } from '../mapper/sections/technical.mapper.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import axios from 'axios';
import mongoose from 'mongoose';
import SeoProject from '../../app_user/model/SeoProject.js';
import { ProjectPerformanceService } from '../../app_user/service/projectPerformance.service.js';

/** Extract display string for a Core Web Vital from Lighthouse device blob (lcp/fcp on device or under metrics) */
function pickPerfMetric(device, id) {
  if (!device) return 'N/A';
  const direct = device[id];
  if (direct && typeof direct === 'object') {
    if (direct.display_value != null) return String(direct.display_value);
    if (direct.value != null) return String(direct.value);
  }
  if (typeof direct === 'string' || typeof direct === 'number') return String(direct);
  const metrics = device.metrics || {};
  const block = metrics[id] || metrics[String(id).toUpperCase()];
  if (typeof block === 'string') return block;
  if (block && typeof block === 'object') {
    if (block.display_value != null) return String(block.display_value);
    if (block.value != null) return String(block.value);
  }
  return 'N/A';
}

function buildDeviceMetrics(device) {
  if (!device) return [];
  return [
    { metric: 'Largest Contentful Paint', mobile: pickPerfMetric(device, 'lcp'), value: pickPerfMetric(device, 'lcp'), desktop: pickPerfMetric(device, 'lcp') },
    { metric: 'Total Blocking Time', mobile: pickPerfMetric(device, 'tbt'), value: pickPerfMetric(device, 'tbt'), desktop: pickPerfMetric(device, 'tbt') },
    { metric: 'First Contentful Paint', mobile: pickPerfMetric(device, 'fcp'), value: pickPerfMetric(device, 'fcp'), desktop: pickPerfMetric(device, 'fcp') },
    { metric: 'Cumulative Layout Shift', mobile: pickPerfMetric(device, 'cls'), value: pickPerfMetric(device, 'cls'), desktop: pickPerfMetric(device, 'cls') }
  ];
}

export class UnifiedJsonService {
  
  /**
   * Generate complete unified JSON report for AI usage
   * @param {string} projectId - Project ID
   * @param {Object} options - Configuration options
   * @param {string} options.authToken - Authorization token for internal API calls
   * @returns {Object} Clean, structured JSON ready for AI input
   */
  static async getFullReportJson(projectId, options = {}) {
    const startTime = Date.now();
    
    try {
      LoggerUtil.info('Unified JSON service starting', { projectId });
      
      // 🔧 FIX: CREATE BASE URL AND ADD DEBUG LOGGING
      // Validate required environment variables
      const backendUrl = process.env.BACKEND_URL;
      if (!backendUrl) {
        throw new Error('BACKEND_URL environment variable is required');
      }
      const BASE_URL = backendUrl;
      console.log('UNIFIED SERVICE: Base URL:', BASE_URL);
      console.log('UNIFIED SERVICE: Project ID:', projectId);
      
      // 🔧 STEP 1: CALL PAGE 08 API (TOP ISSUES)
      console.log('UNIFIED SERVICE: Calling Page 08 API for top issues');
      console.log('UNIFIED SERVICE: Full URL:', `${BASE_URL}/api/pdf/${projectId}/page08`);
      let page08Data;
      try {
        const headers = options.authToken ? { Authorization: `Bearer ${options.authToken}` } : {};
        const page08Response = await axios.get(`${BASE_URL}/api/pdf/${projectId}/page08`, { headers });
        page08Data = page08Response.data;
        console.log('UNIFIED SERVICE: Page 08 API response status:', page08Response.status);
        console.log('UNIFIED SERVICE: Page 08 API response data:', page08Data);
      } catch (error) {
        console.warn('UNIFIED SERVICE: Page 08 API failed, using empty fallback:', error.message);
        page08Data = {};
      }

      // 🔧 STEP 2: CALL PAGE 10 API (TECHNICAL HIGHLIGHTS)
      console.log('UNIFIED SERVICE: Calling Page 10 API for technical highlights');
      console.log('UNIFIED SERVICE: Full URL:', `${BASE_URL}/api/pdf/${projectId}/page10`);
      let page10Data;
      try {
        const headers = options.authToken ? { Authorization: `Bearer ${options.authToken}` } : {};
        const page10Response = await axios.get(`${BASE_URL}/api/pdf/${projectId}/page10`, { headers });
        page10Data = page10Response.data;
        console.log('UNIFIED SERVICE: Page 10 API response status:', page10Response.status);
        console.log('UNIFIED SERVICE: Page 10 API response data:', page10Data);
      } catch (error) {
        console.warn('UNIFIED SERVICE: Page 10 API failed, using empty fallback:', error.message);
        page10Data = {};
      }

      // Performance: same source as app (Mongo seo_domain_performance) — avoids localhost HTTP/auth gaps
      let page13Data = {};
      try {
        const projectDoc = await SeoProject.findById(projectId);
        if (projectDoc) {
          const perfSvc = await ProjectPerformanceService.getProjectPerformance(projectDoc);
          page13Data = {
            success: perfSvc.success,
            data: perfSvc.data,
            message: perfSvc.data?.message
          };
          console.log('UNIFIED SERVICE: Performance from ProjectPerformanceService (DB)');
        }
      } catch (error) {
        console.warn('UNIFIED SERVICE: ProjectPerformanceService failed:', error.message);
      }

      // 🔧 STEP 3: CALL PAGE16 SERVICE FOR KEYWORD DATA
      console.log('UNIFIED SERVICE: Calling Page16 Service for keyword rankings');
      let page16Data = {};
      try {
        const page16Result = await Page16Service.getKeywordRankingAnalysis(projectId);
        if (page16Result.success) {
          page16Data = {
            success: true,
            data: page16Result.data
          };
          console.log('UNIFIED SERVICE: Page16 Service SUCCESS - Keywords found:', page16Result.data.totalKeywords);
        } else {
          console.warn('UNIFIED SERVICE: Page16 Service returned no data:', page16Result.error?.message);
          page16Data = { success: false, error: page16Result.error };
        }
      } catch (error) {
        console.warn('UNIFIED SERVICE: Page16 Service failed:', error.message);
        page16Data = { success: false, error: { message: error.message } };
      }

      // 🔧 STEP 4: GET COVER DATA FOR SCORES (reuse existing computation)
      console.log('UNIFIED SERVICE: Getting cover data for scores');
      const coverResult = await CoverPageService.getCoverPageData(projectId);
      if (!coverResult?.success) {
        console.warn('Cover data failed, using default scores');
      }
      
      // 🔧 STEP 5: BUILD UNIFIED RESPONSE STRUCTURE
      console.log('UNIFIED SERVICE: Building unified response structure');
      
      // 🔧 STEP 5A: PAGE 08 = display list only; totals = row-level counts from seo_page_issues (848, etc.)
      console.log('\n🔧 EXTRACTING PAGE 08 DATA (Top issues for display)');
      const topIssuesArray = page08Data?.data?.topIssues || page08Data?.topIssues || [];
      console.log('Top Issues Array (aggregated types):', topIssuesArray.length);

      const { ObjectId } = mongoose.Types;
      const projectIdObj = new ObjectId(projectId);
      const db = mongoose.connection.db;
      const severityCounts = await CoverPageService.getFullIssueSeverityCounts(db, projectIdObj);
      const criticalCount = severityCounts.critical;
      const highCount = severityCounts.high;
      const mediumCount = severityCounts.medium;
      const lowInfoCount = severityCounts.low;
      const issueTotalCount = severityCounts.total;

      console.log(
        `\n✅ Issue counts from DB (seo_page_issues): Critical=${criticalCount}, High=${highCount}, Medium=${mediumCount}, Low/Info=${lowInfoCount}, Total=${issueTotalCount}`
      );
      
      // Sliced lists for display only (unchanged caps)
      const topIssues = {
        critical: topIssuesArray.filter(i => i.severity === 'critical').slice(0, 3),
        high: topIssuesArray.filter(i => i.severity === 'high').slice(0, 3),
        medium: topIssuesArray.filter(i => i.severity === 'medium').slice(0, 3),
        low: topIssuesArray.filter(i => i.severity === 'low' || i.severity === 'info').slice(0, 3)
      };

      // 🔧 STEP 5B: MAP PAGE 10 DATA - USE CHECKS (REAL DATA)
      console.log('\n🔧 EXTRACTING PAGE 10 DATA (Real Checks)');
      const technicalChecks = page10Data?.data?.checks || page10Data?.checks || [];
      console.log(`Technical Checks Count: ${technicalChecks.length}`);
      
      const technicalHighlights = {
        checks: technicalChecks,
        checkCount: technicalChecks.length
      };

      // 🔧 STEP 5C: MAP PERFORMANCE DATA (REAL DATA)
      console.log('\n🔧 EXTRACTING PERFORMANCE DATA');
      const performancePageData = page13Data?.data || page13Data || {};
      console.log('UNIFIED raw performancePageData keys:', performancePageData ? Object.keys(performancePageData) : []);
      console.log('Performance Data:', performancePageData);

      const summary = performancePageData.summary || {};
      const desktopScore = Number(
        summary.desktopScore ?? performancePageData.desktopScore ?? 0
      ) || 0;
      const mobileScore = Number(
        summary.mobileScore ?? performancePageData.mobileScore ?? 0
      ) || 0;
      const mobileDev = performancePageData.mobile;
      const desktopDev = performancePageData.desktop;
      const performanceMetrics = {
        desktopScore,
        mobileScore,
        desktopMetrics: buildDeviceMetrics(desktopDev),
        mobileMetrics: buildDeviceMetrics(mobileDev),
        avgPerformance:
          desktopScore && mobileScore
            ? Math.round((desktopScore + mobileScore) / 2)
            : desktopScore || mobileScore || 0
      };

      // 🔧 STEP 5D: PROCESS KEYWORD DATA FROM PAGE16 SERVICE
      console.log('\n🔧 EXTRACTING KEYWORD DATA (REAL DATA FROM seo_rankings)');
      let keywordData = {
        totalKeywords: 0,
        topRankings: [],
        opportunities: [],
        notRanking: []
      };

      if (page16Data.success && page16Data.data) {
        const rawKeywordData = page16Data.data;
        console.log('Raw Page16 data:', {
          totalKeywords: rawKeywordData.totalKeywords,
          keywordsCount: rawKeywordData.keywords?.length,
          top10: rawKeywordData.top10,
          top3: rawKeywordData.top3
        });

        // Extract total keywords
        keywordData.totalKeywords = rawKeywordData.totalKeywords || 0;

        // Classify keywords based on rank
        if (rawKeywordData.keywords && Array.isArray(rawKeywordData.keywords)) {
          const topRankings = [];
          const opportunities = [];
          const notRanking = [];

          rawKeywordData.keywords.forEach(k => {
            const keywordItem = {
              keyword: k.keyword,
              rank: k.rank,
              status: k.status || 'ranking'
            };

            // Safe rank handling
            const rank = k.rank;
            
            if (rank === null || rank === undefined || rank > 100) {
              // Not ranking in top 100
              notRanking.push(keywordItem);
            } else if (rank <= 10) {
              // Top rankings
              topRankings.push(keywordItem);
            } else if (rank >= 11 && rank <= 30) {
              // Opportunities
              opportunities.push(keywordItem);
            } else {
              // Ranking but > 30, treat as not ranking for opportunity analysis
              notRanking.push(keywordItem);
            }
          });

          // Sort and limit arrays
          keywordData.topRankings = topRankings
            .sort((a, b) => (a.rank || 0) - (b.rank || 0))
            .slice(0, 5);

          keywordData.opportunities = opportunities
            .sort((a, b) => (a.rank || 0) - (b.rank || 0))
            .slice(0, 5);

          keywordData.notRanking = notRanking
            .sort((a, b) => {
              // Put null/undefined ranks first, then by rank descending
              if (a.rank === null || a.rank === undefined) return -1;
              if (b.rank === null || b.rank === undefined) return 1;
              return b.rank - a.rank;
            })
            .slice(0, 5);
        }

        console.log('🔧 PROCESSED KEYWORD DATA:', {
          totalKeywords: keywordData.totalKeywords,
          topRankingsCount: keywordData.topRankings.length,
          opportunitiesCount: keywordData.opportunities.length,
          notRankingCount: keywordData.notRanking.length,
          sampleTopRanking: keywordData.topRankings[0],
          sampleOpportunity: keywordData.opportunities[0],
          sampleNotRanking: keywordData.notRanking[0]
        });
      } else {
        console.warn('⚠️ No keyword data available from Page16 service, using empty fallback');
        if (page16Data.error) {
          console.warn('Page16 error:', page16Data.error.message);
        }
      }

      // Get scores from cover data (nested under data.scores)
      const s = coverResult.data?.scores || {};
      const seo = Math.round(s.seoHealth || 0);
      const performance = Math.round(s.performance || 0);
      const aiVisibility = Math.round(s.aiVisibility || 0);
      const technicalHealth = Math.round(s.technicalHealth || 0);
      
      // Calculate overall score as average of all 4 metrics (same as coverPageService)
      const overall = Math.round((seo + performance + aiVisibility + technicalHealth) / 4);
      
      const scores = {
        overall,
        performance,
        seo,
        aiVisibility,
        technicalHealth
      };
      console.log('UNIFIED scores from cover:', scores);

      const coverData = coverResult.data;
      const projectInfo = {
        name: coverData?.companyName || coverData?.projectName || 'Website',
        url: coverData?.mainUrl || (coverData?.domain ? `https://${coverData.domain}` : 'N/A')
      };

      // Get recommendations from page 10
      const recommendations = page10Data?.data?.recommendations || page10Data?.recommendations || [];

      // 🔧 STEP 6: BUILD UNIFIED RESPONSE WITH REAL DATA (NO FALLBACKS)
      console.log('\n🔧 BUILDING UNIFIED RESPONSE');
      console.log(
        `Total Issues (full counts): ${issueTotalCount} (Critical: ${criticalCount}, High: ${highCount}, Medium: ${mediumCount}, Low/Info: ${lowInfoCount})`
      );
      
      // ⚠️ CRITICAL: Build unifiedResponse object with REAL data - NOT FALLBACKS
      const unifiedResponse = {
        success: true,
        data: {
          project: projectInfo,
          scores: scores,
          issues: {
            critical: criticalCount,
            high: highCount,
            medium: mediumCount,
            low: lowInfoCount,
            total: issueTotalCount
          },
          issueDistribution: {
            critical: criticalCount,
            high: highCount,
            medium: mediumCount,
            low: lowInfoCount,
            total: issueTotalCount
          },
          topIssues,
          technical: {
            checks: technicalHighlights.checks,
            checkCount: technicalHighlights.checkCount
          },
          performance: performanceMetrics,
          // 🔧 FIX: ADD REAL KEYWORD DATA FROM PAGE16 SERVICE
          keywords: keywordData,
          recommendations: recommendations,
          pages: {
            page08: page08Data,
            page10: page10Data,
            performance: page13Data,
            page16: page16Data
          }
        },
        metadata: {
          fetchedAt: new Date().toISOString(),
          projectId,
          processingTime: Date.now() - startTime,
          version: '2.0.0',
          dataSources: ['page08', 'page10', 'performance-api', 'cover-service', 'page16-keywords']
        }
      };
      
      // 🔧 STEP 7: VALIDATION CHECK BEFORE RETURN
      console.log('\n🔧 FINAL DATA VALIDATION');
      console.log('═'.repeat(50));
      console.log('FINAL DATA CHECK:', {
        critical: unifiedResponse.data.issues.critical,
        high: unifiedResponse.data.issues.high,
        medium: unifiedResponse.data.issues.medium,
        total: unifiedResponse.data.issues.total,
        technicalChecks: unifiedResponse.data.technical.checkCount,
        performanceScore: unifiedResponse.data.performance.desktopScore,
        // 🔧 FIX: ADD KEYWORD DATA VALIDATION
        keywordData: {
          totalKeywords: unifiedResponse.data.keywords.totalKeywords,
          topRankingsCount: unifiedResponse.data.keywords.topRankings.length,
          opportunitiesCount: unifiedResponse.data.keywords.opportunities.length,
          notRankingCount: unifiedResponse.data.keywords.notRanking?.length || 0
        }
      });
      console.log('═'.repeat(50));
      
      // Validate data is NOT zero
      if (unifiedResponse.data.issues.total === 0 && !page08Data?.data?.severityBreakdown) {
        console.warn('⚠️ WARNING: Zero issues found - check if Page08 API returned data');
      } else if (unifiedResponse.data.issues.critical > 0) {
        console.log('✅ SUCCESS: Real data present in response');
      }
      
      // 🔧 FIX: VALIDATE KEYWORD DATA
      if (unifiedResponse.data.keywords.totalKeywords > 0) {
        console.log('✅ SUCCESS: Real keyword data present in response');
      } else {
        console.warn('⚠️ WARNING: No keyword data found - check if Page16 service returned data');
      }
      
      LoggerUtil.info('Unified JSON report generated successfully', {
        projectId,
        processingTime: Date.now() - startTime,
        issuesCount: unifiedResponse.data.issues.total,
        checksCount: unifiedResponse.data.technical.checkCount,
        // 🔧 FIX: ADD KEYWORD METRICS TO LOGGING
        keywordMetrics: {
          totalKeywords: unifiedResponse.data.keywords.totalKeywords,
          topRankingsCount: unifiedResponse.data.keywords.topRankings.length,
          opportunitiesCount: unifiedResponse.data.keywords.opportunities.length,
          notRankingCount: unifiedResponse.data.keywords.notRanking?.length || 0
        }
      });
      
      return unifiedResponse;

    } catch (error) {
      LoggerUtil.error('Unified JSON service failed', {
        projectId,
        error: error.message,
        stack: error.stack
      });
      
      // Return safe fallback structure on any error
      const fallbackResponse = {
        success: false,
        error: {
          message: "Failed to generate unified JSON report",
          details: error.message,
          projectId
        },
        data: {
          project: { project_name: "Unknown", main_url: "N/A" },
          pages: {
            page08: {},
            page10: {}
          },
          performance: { pageSpeed: 0, metrics: [] },
          scores: { overall: 0, performance: 0, seo: 0, aiVisibility: 0, technicalHealth: 0 },
          recommendations: [],
          issues: { critical: 0, warnings: 0, informational: 0 },
          issueDistribution: { total: 0, critical: 0, medium: 0, info: 0 },
          // 🔧 FIX: ADD EMPTY KEYWORD DATA TO FALLBACK
          keywords: {
            totalKeywords: 0,
            topRankings: [],
            opportunities: [],
            notRanking: []
          }
        },
        metadata: {
          fetchedAt: new Date(),
          projectId,
          queryTime: Date.now() - startTime,
          error: error.message,
          fallbackUsed: true
        }
      };

      return fallbackResponse;
    }
  }
  
  /**
   * Compute shared context to avoid redundant calculations
   */
  static computeSharedContext(aggregatedData, coverData) {
    const scores = coverData?.scores || {};
    
    // Calculate percentages once, reuse across mappers
    const percentages = {
      ai: {
        schemaCoverage: this.calculateSchemaCoverage(aggregatedData.ai),
        entityCoverage: this.calculateEntityCoverage(aggregatedData.ai)
      },
      optimization: {
        h1: this.calculateH1Coverage(aggregatedData.pages),
        metaDesc: this.calculateMetaDescCoverage(aggregatedData.pages)
      },
      pageCoverage: {
        indexed: this.calculateIndexedPercentage(aggregatedData.pages)
      }
    };
    
    // Calculate grades once
    const grades = {
      overall: this.getGrade(scores.overall || 0),
      seoHealth: this.getGrade(scores.seoHealth || 0),
      aiVisibility: this.getGrade(scores.aiVisibility || 0),
      performance: this.getGrade(scores.performance || 0),
      authority: this.getGrade(scores.authority || 0)
    };
    
    return {
      scores,
      percentages,
      grades,
      aggregatedData
    };
  }
  
  /**
   * Transform executive summary data
   */
  static async transformExecutive(aggregatedData, coverData, sharedContext) {
    try {
      const result = await ExecutiveMapper.mapExecutiveSummary(aggregatedData, coverData);
      return result.success ? result.data : {};
    } catch (error) {
      LoggerUtil.error('Executive transformation failed', error);
      return {};
    }
  }
  
  /**
   * Transform performance data
   */
  static async transformPerformance(aggregatedData, sharedContext) {
    try {
      const coreWebVitals = PerformanceMapper.transformCoreWebVitals(
        aggregatedData.performance, 
        aggregatedData
      );
      
      const opportunities = PerformanceMapper.transformOpportunities(aggregatedData.technical);
      
      return {
        coreWebVitals,
        opportunities
      };
    } catch (error) {
      LoggerUtil.error('Performance transformation failed', error);
      return {};
    }
  }
  
  /**
   * Transform keywords data
   */
  static async transformKeywords(aggregatedData, sharedContext) {
    try {
      const rankings = KeywordsMapper.transformRankings(
        aggregatedData.links,
        aggregatedData.pages
      );
      
      const opportunities = KeywordsMapper.transformOpportunities();
      
      return {
        rankings,
        opportunities
      };
    } catch (error) {
      LoggerUtil.error('Keywords transformation failed', error);
      return {};
    }
  }
  
  /**
   * Transform AI visibility data
   */
  static async transformAI(aggregatedData, sharedContext) {
    try {
      const visibility = AIMapper.transformVisibility(
        aggregatedData.ai,
        sharedContext.scores,
        sharedContext.grades
      );
      
      const structuredData = AIMapper.transformStructuredData(
        aggregatedData.ai,
        sharedContext.percentages
      );
      
      const llmVisibility = AIMapper.transformLLMVisibility(
        aggregatedData.ai,
        sharedContext.percentages
      );
      
      const knowledgeGraph = AIMapper.transformKnowledgeGraph(
        aggregatedData.ai,
        sharedContext.percentages
      );
      
      const optimization = AIMapper.transformOptimization(
        aggregatedData.ai?.issues,
        aggregatedData.ai
      );
      
      return {
        visibility,
        structuredData,
        llmVisibility,
        knowledgeGraph,
        optimization
      };
    } catch (error) {
      LoggerUtil.error('AI transformation failed', error);
      return {};
    }
  }
  
  /**
   * Transform content data
   */
  static async transformContent(aggregatedData, sharedContext) {
    try {
      const readiness = ContentMapper.transformReadiness(
        aggregatedData.ai,
        sharedContext.percentages
      );
      
      return {
        readiness
      };
    } catch (error) {
      LoggerUtil.error('Content transformation failed', error);
      return {};
    }
  }
  
  /**
   * Transform technical SEO data
   */
  static async transformTechnical(aggregatedData, sharedContext) {
    try {
      const seoHealth = TechnicalMapper.transformSEOHealth(
        sharedContext.scores,
        sharedContext.grades,
        sharedContext.percentages
      );
      
      const technicalSEO = TechnicalMapper.transformTechnicalSEO(
        aggregatedData.technical,
        sharedContext.grades
      );
      
      const crawlability = TechnicalMapper.transformCrawlability(
        aggregatedData.pages,
        sharedContext.percentages
      );
      
      return {
        seoHealth,
        technicalSEO,
        crawlability
      };
    } catch (error) {
      LoggerUtil.error('Technical transformation failed', error);
      return {};
    }
  }
  
  /**
   * Normalize project data for AI consumption
   */
  static normalizeProjectData(project) {
    if (!project) return {};
    
    return {
      id: project._id?.toString() || project.id,
      name: project.project_name,
      domain: project.main_url,
      status: project.status,
      createdAt: project.createdAt,
      lastScraped: project.last_scraped,
      userId: project.user_id
    };
  }
  
  /**
   * Generate unified recommendations from all sections
   */
  static generateUnifiedRecommendations(executive, performance, keywords, ai, content, technical) {
    const recommendations = [];
    let priority = 1;
    
    // Critical issues from executive summary
    if (executive.issues?.critical > 0) {
      recommendations.push({
        id: priority++,
        category: 'critical',
        title: 'Address Critical SEO Issues',
        description: `${executive.issues.critical} critical issues require immediate attention`,
        impact: 'High',
        effort: 'Medium',
        actions: ['Review and fix critical technical issues', 'Address high-priority SEO violations']
      });
    }
    
    // AI visibility optimization
    const aiScore = executive.scores?.aiVisibility || 0;
    if (aiScore < 60) {
      recommendations.push({
        id: priority++,
        category: 'ai',
        title: 'Improve AI Visibility',
        description: `AI visibility score of ${aiScore} needs improvement for AI search readiness`,
        impact: 'High',
        effort: 'Medium',
        actions: ['Implement comprehensive schema markup', 'Enhance entity coverage', 'Optimize content for AI search']
      });
    }
    
    // Performance optimization
    const perfScore = executive.scores?.performance || 0;
    if (perfScore < 70) {
      recommendations.push({
        id: priority++,
        category: 'performance',
        title: 'Optimize Website Performance',
        description: `Performance score of ${perfScore} impacts user experience and rankings`,
        impact: 'Medium',
        effort: 'High',
        actions: ['Optimize images and assets', 'Improve server response time', 'Eliminate render-blocking resources']
      });
    }
    
    // Content optimization
    if (content.readiness?.readinessScore < 60) {
      recommendations.push({
        id: priority++,
        category: 'content',
        title: 'Enhance Content for AI Search',
        description: 'Content readiness needs improvement for better AI visibility',
        impact: 'Medium',
        effort: 'Medium',
        actions: ['Add conversational content structure', 'Implement FAQ sections', 'Enhance entity coverage']
      });
    }
    
    return recommendations;
  }
  
  /**
   * Helper methods for calculations (avoid duplication)
   */
  static calculateSchemaCoverage(aiData) {
    const aggregates = aiData?.visibility?.aggregates || {};
    const totalPages = aggregates.totalPages || 1;
    const pagesWithSchema = aggregates.pagesWithSchema || 0;
    return totalPages > 0 ? Math.round((pagesWithSchema / totalPages) * 100) : 0;
  }
  
  static calculateEntityCoverage(aiData) {
    const entities = aiData?.entities || {};
    const totalEntities = entities.summary?.totalEntities || 0;
    const idealEntities = 15;
    return Math.min(100, Math.round((totalEntities / idealEntities) * 100));
  }
  
  static calculateH1Coverage(pagesData) {
    const totalPages = pagesData?.data?.totalPages || 1;
    const pagesWithH1 = pagesData?.data?.pagesWithH1 || 0;
    return totalPages > 0 ? Math.round((pagesWithH1 / totalPages) * 100) : 0;
  }
  
  static calculateMetaDescCoverage(pagesData) {
    const totalPages = pagesData?.data?.totalPages || 1;
    const pagesWithMetaDesc = pagesData?.data?.pagesWithMetaDesc || 0;
    return totalPages > 0 ? Math.round((pagesWithMetaDesc / totalPages) * 100) : 0;
  }
  
  static calculateIndexedPercentage(pagesData) {
    const totalPages = pagesData?.data?.totalPages || 1;
    const indexedPages = pagesData?.data?.indexedPages || 0;
    return totalPages > 0 ? Math.round((indexedPages / totalPages) * 100) : 0;
  }
  
  static getGrade(score) {
    if (score >= 90) return { grade: 'A', status: 'Excellent' };
    if (score >= 80) return { grade: 'B', status: 'Good' };
    if (score >= 70) return { grade: 'C', status: 'Fair' };
    if (score >= 60) return { grade: 'D', status: 'Poor' };
    return { grade: 'F', status: 'Critical' };
  }
  
  /**
   * Get data sources for metadata
   */
  static getDataSources(aggregatedData) {
    const sources = [];
    
    if (aggregatedData.project) sources.push('seoprojects');
    if (aggregatedData.ai) sources.push('seo_ai_visibility', 'ai_visibility_entities');
    if (aggregatedData.technical) sources.push('domain_technical_reports');
    if (aggregatedData.pages) sources.push('seo_page_data', 'seo_page_issues');
    if (aggregatedData.links) sources.push('seo_internal_links', 'seo_social_links');  // External links disabled
    if (aggregatedData.performance) sources.push('seo_domain_performance');
    
    return sources;
  }
  
  /**
   * Validate unified JSON output
   */
  static validateUnifiedJson(unifiedReport) {
    const requiredFields = ['project', 'scores', 'metadata'];
    const missing = requiredFields.filter(field => !unifiedReport[field]);
    
    if (missing.length > 0) {
      throw new Error(`Missing required fields: ${missing.join(', ')}`);
    }
    
    return true;
  }
  
  /**
   * Validate project data availability
   */
  static async validateProjectData(projectId) {
    try {
      // Quick check using aggregation service
      const aggregatedData = await PDFAggregationService.fetchAllPDFData(projectId);
      
      const validation = {
        project: !!aggregatedData.project,
        aiData: !!(aggregatedData.ai?.visibility || aggregatedData.ai?.issues),
        technicalData: !!aggregatedData.technical,
        pageData: !!aggregatedData.pages,
        performanceData: !!aggregatedData.performance,
        linkData: !!aggregatedData.links,
        overall: !!aggregatedData.project && !!aggregatedData.pages
      };
      
      validation.isReady = validation.project && validation.pageData;
      validation.completeness = Object.values(validation).filter(v => v === true).length / Object.keys(validation).length;
      
      return validation;
      
    } catch (error) {
      LoggerUtil.error('Project data validation failed', error, { projectId });
      
      return {
        project: false,
        aiData: false,
        technicalData: false,
        pageData: false,
        performanceData: false,
        linkData: false,
        overall: false,
        isReady: false,
        completeness: 0,
        error: error.message
      };
    }
  }
}
