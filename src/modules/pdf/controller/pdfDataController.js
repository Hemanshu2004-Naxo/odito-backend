/**
 * PDF Data Controller
 * Handles HTTP requests for PDF data generation
 */

import { PDFDataService } from '../service/pdfDataService.js';
import { CoverPageService } from '../service/coverPageService.js';
import { PDFAggregationService } from '../service/pdfAggregationService.js';
import { Page08Service } from '../service/page08Service.js';
import { Page09Service } from '../service/page09Service.js';
import { Page10Service } from '../service/page10Service.js';
import { Page11Service } from '../service/page11Service.js';
import { Page16Service } from '../service/page16Service.js';
import { ExecutiveMapper } from '../mapper/sections/executive.mapper.js';
import { CanonicalReportService, ReportError } from '../report/canonicalReportService.js';
import { defaultReportDeps } from '../report/defaultReportDeps.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

export class PDFDataController {
  
  /**
   * Generate complete PDF data for a project
   */
  static async generatePDFData(req, res) {
    try {
      const { projectId } = req.params;
      const options = req.query || {};
      
      LoggerUtil.info('PDF data request received', {
        projectId,
        options,
        userId: req.user?.id
      });
      
      // Validate projectId
      if (!projectId) {
        return res.status(400).json({
          success: false,
          error: {
            message: 'Project ID is required',
            code: 'MISSING_PROJECT_ID'
          }
        });
      }
      
      // Generate PDF data
      const result = await PDFDataService.generatePDFData(projectId, options);
      
      if (!result.success) {
        return res.status(500).json(result);
      }
      
      res.json(result);
      
    } catch (error) {
      LoggerUtil.error('PDF data controller error', error, {
        projectId: req.params.projectId,
        userId: req.user?.id
      });
      
      res.status(500).json({
        success: false,
        error: {
          message: 'Internal server error',
          code: 'CONTROLLER_ERROR'
        }
      });
    }
  }

  /**
   * Generate specific PDF section data
   */
  static async generateSectionData(req, res) {
    try {
      const { projectId, section } = req.params;
      
      if (!projectId || !section) {
        return res.status(400).json({
          success: false,
          error: {
            message: 'Project ID and section are required',
            code: 'MISSING_PARAMETERS'
          }
        });
      }
      
      // Validate section name
      const validSections = [
        'cover', 'executiveSummary', 'keyStrengths', 'roadmap',
        'seoHealth', 'onPageSEO', 'structuredData', 'technicalSEO',
        'crawlability', 'coreWebVitals', 'performance', 'keywords',
        'keywordOpportunities', 'aiVisibility', 'llmVisibility',
        'contentReadiness', 'knowledgeGraph', 'aiOptimization',
        'growthForecast', 'actionPlan', 'methodology', 'about'
      ];
      
      if (!validSections.includes(section)) {
        return res.status(400).json({
          success: false,
          error: {
            message: `Invalid section: ${section}`,
            code: 'INVALID_SECTION',
            validSections
          }
        });
      }
      
      const result = await PDFDataService.generateSectionData(projectId, section);
      
      if (!result.success) {
        return res.status(500).json(result);
      }
      
      res.json(result);
      
    } catch (error) {
      LoggerUtil.error('PDF section controller error', error, {
        projectId: req.params.projectId,
        section: req.params.section,
        userId: req.user?.id
      });
      
      res.status(500).json({
        success: false,
        error: {
          message: 'Internal server error',
          code: 'CONTROLLER_ERROR'
        }
      });
    }
  }

  /**
   * Get PDF data summary
   */
  static async getPDFDataSummary(req, res) {
    try {
      const { projectId } = req.params;
      
      if (!projectId) {
        return res.status(400).json({
          success: false,
          error: {
            message: 'Project ID is required',
            code: 'MISSING_PROJECT_ID'
          }
        });
      }
      
      const result = await PDFDataService.getPDFDataSummary(projectId);
      
      if (!result.success) {
        return res.status(500).json(result);
      }
      
      res.json(result);
      
    } catch (error) {
      LoggerUtil.error('PDF summary controller error', error, {
        projectId: req.params.projectId,
        userId: req.user?.id
      });
      
      res.status(500).json({
        success: false,
        error: {
          message: 'Internal server error',
          code: 'CONTROLLER_ERROR'
        }
      });
    }
  }

  /**
   * Validate project for PDF generation
   */
  static async validateProject(req, res) {
    try {
      const { projectId } = req.params;
      
      if (!projectId) {
        return res.status(400).json({
          success: false,
          error: {
            message: 'Project ID is required',
            code: 'MISSING_PROJECT_ID'
          }
        });
      }
      
      const result = await PDFDataService.validateProjectForPDF(projectId);
      
      if (!result.success) {
        return res.status(500).json(result);
      }
      
      res.json(result);
      
    } catch (error) {
      LoggerUtil.error('PDF validation controller error', error, {
        projectId: req.params.projectId,
        userId: req.user?.id
      });
      
      res.status(500).json({
        success: false,
        error: {
          message: 'Internal server error',
          code: 'CONTROLLER_ERROR'
        }
      });
    }
  }

  /**
   * Get PDF generation status
   */
  static async getGenerationStatus(req, res) {
    try {
      const { projectId } = req.params;
      
      if (!projectId) {
        return res.status(400).json({
          success: false,
          error: {
            message: 'Project ID is required',
            code: 'MISSING_PROJECT_ID'
          }
        });
      }
      
      const result = await PDFDataService.getPDFGenerationStatus(projectId);
      
      if (!result.success) {
        return res.status(500).json(result);
      }
      
      res.json(result);
      
    } catch (error) {
      LoggerUtil.error('PDF status controller error', error, {
        projectId: req.params.projectId,
        userId: req.user?.id
      });
      
      res.status(500).json({
        success: false,
        error: {
          message: 'Internal server error',
          code: 'CONTROLLER_ERROR'
        }
      });
    }
  }

  /**
   * Get PDF generation metrics
   */
  static async getGenerationMetrics(req, res) {
    try {
      const { projectId } = req.params;
      
      if (!projectId) {
        return res.status(400).json({
          success: false,
          error: {
            message: 'Project ID is required',
            code: 'MISSING_PROJECT_ID'
          }
        });
      }
      
      const result = await PDFDataService.getPDFGenerationMetrics(projectId);
      
      if (!result.success) {
        return res.status(500).json(result);
      }
      
      res.json(result);
      
    } catch (error) {
      LoggerUtil.error('PDF metrics controller error', error, {
        projectId: req.params.projectId,
        userId: req.user?.id
      });
      
      res.status(500).json({
        success: false,
        error: {
          message: 'Internal server error',
          code: 'CONTROLLER_ERROR'
        }
      });
    }
  }

  /**
   * Health check endpoint
   */
  static async healthCheck(req, res) {
    try {
      res.json({
        success: true,
        status: 'healthy',
        service: 'PDF Data Service',
        timestamp: new Date(),
        version: '1.0.0'
      });
      
    } catch (error) {
      LoggerUtil.error('PDF health check error', error);
      
      res.status(500).json({
        success: false,
        error: {
          message: 'Health check failed',
          code: 'HEALTH_CHECK_ERROR'
        }
      });
    }
  }

  /**
   * Get available PDF sections
   */
  static async getAvailableSections(req, res) {
    try {
      const sections = [
        {
          id: 'cover',
          name: 'Cover Page',
          description: 'Main cover with scores and branding'
        },
        {
          id: 'executiveSummary',
          name: 'Executive Summary',
          description: 'Performance snapshot and analysis'
        },
        {
          id: 'keyStrengths',
          name: 'Key Strengths vs Issues',
          description: 'What\'s working and what needs fixing'
        },
        {
          id: 'roadmap',
          name: 'Priority Fix Roadmap',
          description: 'Action plan ordered by impact and effort'
        },
        {
          id: 'seoHealth',
          name: 'SEO Health Overview',
          description: 'Score breakdown by category'
        },
        {
          id: 'onPageSEO',
          name: 'On-Page SEO Audit',
          description: 'Page-level SEO issues analysis'
        },
        {
          id: 'structuredData',
          name: 'Structured Data Analysis',
          description: 'JSON-LD coverage and AI search impact'
        },
        {
          id: 'technicalSEO',
          name: 'Technical SEO Health',
          description: 'Server and crawlability audit'
        },
        {
          id: 'crawlability',
          name: 'Crawlability Analysis',
          description: 'Indexation status and crawl budget'
        },
        {
          id: 'coreWebVitals',
          name: 'Core Web Vitals',
          description: 'Desktop and mobile performance metrics'
        },
        {
          id: 'performance',
          name: 'Performance Opportunities',
          description: 'Speed improvements and savings'
        },
        {
          id: 'keywords',
          name: 'Keyword Rankings',
          description: 'Keyword position tracking and analysis'
        },
        {
          id: 'keywordOpportunities',
          name: 'Keyword Opportunities',
          description: 'Near top-10 keywords analysis'
        },
        {
          id: 'aiVisibility',
          name: 'AI Visibility Overview',
          description: 'GEO, AEO, and AISEO readiness'
        },
        {
          id: 'llmVisibility',
          name: 'LLM Visibility Analysis',
          description: 'Brand citation rates across AI platforms'
        },
        {
          id: 'contentReadiness',
          name: 'AI Content Readiness',
          description: 'Conversational content optimization'
        },
        {
          id: 'knowledgeGraph',
          name: 'Knowledge Graph Analysis',
          description: 'Brand entity presence and coverage'
        },
        {
          id: 'aiOptimization',
          name: 'AI Optimization Recommendations',
          description: 'Prioritized AI visibility actions'
        },
        {
          id: 'growthForecast',
          name: 'AI Growth Forecast',
          description: 'Projected score improvements'
        },
        {
          id: 'actionPlan',
          name: '30-Day Action Plan',
          description: 'Structured implementation roadmap'
        },
        {
          id: 'methodology',
          name: 'Audit Methodology',
          description: 'How Odito AI performs audits'
        },
        {
          id: 'about',
          name: 'About Odito AI',
          description: 'Platform features and capabilities'
        }
      ];
      
      res.json({
        success: true,
        sections,
        total: sections.length
      });
      
    } catch (error) {
      LoggerUtil.error('PDF sections controller error', error);
      
      res.status(500).json({
        success: false,
        error: {
          message: 'Internal server error',
          code: 'CONTROLLER_ERROR'
        }
      });
    }
  }

  /**
   * Generate executive summary data
   */
  static async generateExecutiveSummaryData(req, res) {
    try {
      const { projectId } = req.params;
      
      console.log("CONTROLLER HIT", projectId);
      
      if (!projectId) {
        return res.status(400).json({
          success: false,
          error: {
            message: 'Project ID is required',
            code: 'MISSING_PROJECT_ID'
          }
        });
      }
      
      // Step 1: Get cover page data (reuse scores)
      console.log("SERVICE START - Cover Page");
      let coverResult;
      try {
        coverResult = await CoverPageService.getCoverPageData(projectId);
        if (!coverResult?.success) {
          console.error("Cover page service failed:", coverResult);
          return res.status(500).json({
            success: false,
            error: {
              message: 'Failed to fetch cover page data',
              code: 'COVER_PAGE_ERROR',
              details: coverResult?.error
            }
          });
        }
      } catch (error) {
        console.error("Cover page service exception:", error);
        return res.status(500).json({
          success: false,
          error: {
            message: 'Cover page service crashed',
            code: 'COVER_PAGE_CRASH',
            details: error.message
          }
        });
      }
      
      const coverData = coverResult.data;
      console.log("COVER DATA:", JSON.stringify(coverData, null, 2));
      
      // Step 2: Get aggregated data (includes onpage issues)
      console.log("AGGREGATION START");
      let aggregatedData;
      try {
        aggregatedData = await PDFAggregationService.fetchAllPDFData(projectId);
        console.log("AGG DATA:", JSON.stringify(aggregatedData, null, 2));
      } catch (error) {
        console.error("Aggregation service exception:", error);
        return res.status(500).json({
          success: false,
          error: {
            message: 'Data aggregation failed',
            code: 'AGGREGATION_CRASH',
            details: error.message
          }
        });
      }
      
      // Step 3: Map to executive summary format
      console.log("MAPPER START");
      console.log("MAPPER INPUT:", { 
        hasAggregatedData: !!aggregatedData, 
        hasCoverData: !!coverData,
        aggregatedDataKeys: Object.keys(aggregatedData || {}),
        coverDataKeys: Object.keys(coverData || {})
      });
      
      let executiveResult;
      try {
        executiveResult = await ExecutiveMapper.mapExecutiveSummary(aggregatedData, coverData);
        console.log("MAPPER OUTPUT:", JSON.stringify(executiveResult, null, 2));
      } catch (error) {
        console.error("Executive mapper exception:", error);
        return res.status(500).json({
          success: false,
          error: {
            message: 'Executive mapping failed',
            code: 'MAPPER_CRASH',
            details: error.message
          }
        });
      }
      
      // Final validation
      if (!executiveResult?.success) {
        console.error("Executive mapper returned failure:", executiveResult);
        return res.status(500).json({
          success: false,
          error: {
            message: 'Executive mapping failed',
            code: 'MAPPER_FAILURE',
            details: executiveResult?.error
          }
        });
      }
      
      console.log("EXECUTIVE SUMMARY SUCCESS: Returning data");
      res.json(executiveResult);
      
    } catch (error) {
      console.error("FULL ERROR STACK:", error.stack);
      LoggerUtil.error('Executive summary controller error', error, {
        projectId: req.params.projectId
      });
      
      // A controller failure is an error, never a successful zero-issue report.
      res.status(500).json({
        success: false,
        error: {
          message: 'Executive summary is unavailable',
          code: 'EXECUTIVE_CONTROLLER_ERROR'
        }
      });
    }
  }

  /**
   * Canonical, versioned report payload (Phase 1).
   * GET /api/pdf/:projectId/report[?auditNumber=N]
   * Project ownership is enforced by validateProjectAccess() on the route.
   */
  static async getCanonicalReport(req, res) {
    try {
      const { projectId } = req.params;
      let auditNumber = null;
      if (req.query?.auditNumber !== undefined) {
        auditNumber = Number(req.query.auditNumber);
        if (!Number.isInteger(auditNumber) || auditNumber < 1) {
          return res.status(400).json({
            success: false,
            error: { message: 'auditNumber must be a positive integer', code: 'INVALID_AUDIT_NUMBER' }
          });
        }
      }

      const report = await CanonicalReportService.build(projectId, {
        auditNumber,
        deps: defaultReportDeps
      });
      return res.json({ success: true, data: report });
    } catch (error) {
      if (error instanceof ReportError && error.statusCode < 500) {
        return res.status(error.statusCode).json({
          success: false,
          error: { message: error.message, code: error.code }
        });
      }
      LoggerUtil.error('Canonical report controller error', error, {
        projectId: req.params.projectId,
        userId: req.user?.id
      });
      return res.status(500).json({
        success: false,
        error: { message: 'Report is unavailable', code: 'CANONICAL_REPORT_ERROR' }
      });
    }
  }

  /**
   * Generate cover page data
   */
  static async generateCoverPageData(req, res) {
    try {
      const { projectId } = req.params;
      
      if (!projectId) {
        return res.status(400).json({
          success: false,
          error: {
            message: 'Project ID is required',
            code: 'MISSING_PROJECT_ID'
          }
        });
      }
      
      const result = await CoverPageService.getCoverPageData(projectId);
      
      if (!result.success) {
        return res.status(500).json(result);
      }
      
      res.json(result);
      
    } catch (error) {
      LoggerUtil.error('Cover page controller error', error, {
        projectId: req.params.projectId,
        userId: req.user?.id
      });
      
      res.status(500).json({
        success: false,
        error: {
          message: 'Internal server error',
          code: 'CONTROLLER_ERROR'
        }
      });
    }
  }

  /**
   * Generate Page 08 - On-Page SEO Audit data
   */
  static async getPage08Data(req, res) {
    try {
      const { projectId } = req.params;
      
      if (!projectId) {
        return res.status(400).json({
          success: false,
          error: {
            message: 'Project ID is required',
            code: 'MISSING_PROJECT_ID'
          }
        });
      }
      
      const result = await Page08Service.getPage08Data(projectId);
      
      if (!result.success) {
        return res.status(500).json(result);
      }
      
      res.json(result);
      
    } catch (error) {
      LoggerUtil.error('Page 08 controller error', error, {
        projectId: req.params.projectId,
        userId: req.user?.id
      });
      
      res.status(500).json({
        success: false,
        error: {
          message: 'Internal server error',
          code: 'CONTROLLER_ERROR'
        }
      });
    }
  }

  /**
   * Generate Page 09 - Structured Data Analysis data
   */
  static async getPage09Data(req, res) {
    try {
      const { projectId } = req.params;
      
      if (!projectId) {
        return res.status(400).json({
          success: false,
          error: {
            message: 'Project ID is required',
            code: 'MISSING_PROJECT_ID'
          }
        });
      }
      
      const result = await Page09Service.getPage09Data(projectId);
      
      if (!result.success) {
        return res.status(500).json(result);
      }
      
      res.json(result);
      
    } catch (error) {
      LoggerUtil.error('Page 09 controller error', error, {
        projectId: req.params.projectId,
        userId: req.user?.id
      });
      
      res.status(500).json({
        success: false,
        error: {
          message: 'Internal server error',
          code: 'CONTROLLER_ERROR'
        }
      });
    }
  }

  /**
   * Generate Page 10 - Technical SEO Health data
   */
  static async getPage10Data(req, res) {
    try {
      const { projectId } = req.params;
      
      if (!projectId) {
        return res.status(400).json({
          success: false,
          error: {
            message: 'Project ID is required',
            code: 'MISSING_PROJECT_ID'
          }
        });
      }
      
      const result = await Page10Service.getPage10Data(projectId);
      
      if (!result) {
        return res.status(500).json({
          success: false,
          error: {
            message: 'Failed to generate Page 10 data',
            code: 'SERVICE_ERROR'
          }
        });
      }
      
      res.json({
        success: true,
        data: result
      });
      
    } catch (error) {
      LoggerUtil.error('Page 10 controller error', error, {
        projectId: req.params.projectId,
        userId: req.user?.id
      });
      
      res.status(500).json({
        success: false,
        error: {
          message: 'Internal server error',
          code: 'CONTROLLER_ERROR'
        }
      });
    }
  }

  /**
   * Generate Page 11 - Crawlability Analysis data
   */
  static async getPage11Data(req, res) {
    try {
      const { projectId } = req.params;
      
      if (!projectId) {
        return res.status(400).json({
          success: false,
          error: {
            message: 'Project ID is required',
            code: 'MISSING_PROJECT_ID'
          }
        });
      }
      
      const result = await Page11Service.getPage11Data(projectId);
      
      if (!result) {
        return res.status(500).json({
          success: false,
          error: {
            message: 'Failed to generate Page 11 data',
            code: 'SERVICE_ERROR'
          }
        });
      }
      
      res.json({
        success: true,
        data: result
      });
      
    } catch (error) {
      LoggerUtil.error('Page 11 controller error', error, {
        projectId: req.params.projectId,
        userId: req.user?.id
      });
      
      res.status(500).json({
        success: false,
        error: {
          message: 'Internal server error',
          code: 'CONTROLLER_ERROR'
        }
      });
    }
  }

  /**
   * Generate Page 16 - Keyword Ranking Analysis data
   */
  static async getPage16Data(req, res) {
    try {
      const { projectId } = req.params;
      
      console.log("Page16 controller hit - projectId:", projectId);
      
      if (!projectId) {
        return res.status(400).json({
          success: false,
          error: {
            message: 'Project ID is required',
            code: 'MISSING_PROJECT_ID'
          }
        });
      }
      
      // Use Page16Service to get keyword ranking analysis
      const result = await Page16Service.getKeywordRankingAnalysis(projectId);
      
      if (!result.success) {
        return res.status(500).json(result);
      }
      
      console.log("Page16 controller success - returning keyword ranking analysis");
      res.json(result);
      
    } catch (error) {
      console.error("Page16 controller error:", error);
      LoggerUtil.error('Page 16 controller error', error, {
        projectId: req.params.projectId,
        userId: req.user?.id
      });
      
      res.status(500).json({
        success: false,
        error: {
          message: 'Internal server error',
          code: 'CONTROLLER_ERROR'
        }
      });
    }
  }

}
