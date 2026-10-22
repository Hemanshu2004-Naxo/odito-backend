/**
 * PDF Data Service
 * Main service orchestrator for PDF data generation
 */

import { PDFAggregationService } from './pdfAggregationService.js';
import { PDFCalculationService } from './pdfCalculationService.js';
import { PDFDataMapper } from '../mapper/pdfDataMapper.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

export class PDFDataService {
  
  /**
   * Generate complete PDF data for a project
   * @param {string} projectId - Project ID
   * @param {Object} options - Generation options
   * @returns {Object} Complete PDF data structure
   */
  static async generatePDFData(projectId, options = {}) {
    const startTime = Date.now();
    
    try {
      LoggerUtil.info('PDF data generation started', { projectId, options });
      
      // Step 1: Fetch all aggregated data from database
      const aggregatedData = await PDFAggregationService.fetchAllPDFData(projectId);
      
      // Step 2: Calculate all metrics and scores
      const calculatedMetrics = PDFCalculationService.calculateAllMetrics(aggregatedData);
      
      // Step 3: Transform to PDF-ready structure
      const pdfData = PDFDataMapper.transformToPDFData(aggregatedData, calculatedMetrics);
      
      // Step 4: Validate final data structure
      PDFDataMapper.validatePDFData(pdfData);
      
      const totalTime = Date.now() - startTime;
      
      LoggerUtil.info('PDF data generation completed', {
        projectId,
        totalTime,
        sections: Object.keys(pdfData).length
      });
      
      return {
        success: true,
        data: pdfData,
        metadata: {
          generatedAt: new Date(),
          generationTime: totalTime,
          projectId,
          sections: Object.keys(pdfData).length,
          dataFreshness: pdfData.metadata?.dataFreshness || 'unknown'
        }
      };
      
    } catch (error) {
      LoggerUtil.error('PDF data generation failed', error, { projectId });
      
      return {
        success: false,
        error: {
          message: error.message,
          code: 'PDF_GENERATION_FAILED',
          details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        }
      };
    }
  }

  /**
   * Generate specific PDF section data
   * @param {string} projectId - Project ID
   * @param {string} section - Section name
   * @returns {Object} Section data
   */
  static async generateSectionData(projectId, section) {
    const startTime = Date.now();
    
    try {
      LoggerUtil.info('PDF section generation started', { projectId, section });
      
      // For section-specific generation, we could optimize to fetch less data
      // For now, generate full data and extract section
      const fullData = await this.generatePDFData(projectId);
      
      if (!fullData.success) {
        return fullData;
      }
      
      const sectionData = fullData.data[section];
      
      if (!sectionData) {
        throw new Error(`Section '${section}' not found`);
      }
      
      LoggerUtil.info('PDF section generation completed', {
        projectId,
        section,
        totalTime: Date.now() - startTime
      });
      
      return {
        success: true,
        data: sectionData,
        section,
        metadata: fullData.metadata
      };
      
    } catch (error) {
      LoggerUtil.error('PDF section generation failed', error, { projectId, section });
      
      return {
        success: false,
        error: {
          message: error.message,
          code: 'PDF_SECTION_GENERATION_FAILED',
          section
        }
      };
    }
  }

  /**
   * Get PDF data summary (metadata only)
   * @param {string} projectId - Project ID
   * @returns {Object} PDF data summary
   */
  static async getPDFDataSummary(projectId) {
    try {
      // Quick summary without full data generation
      const aggregatedData = await PDFAggregationService.fetchAllPDFData(projectId);
      const calculatedMetrics = PDFCalculationService.calculateAllMetrics(aggregatedData);
      
      return {
        success: true,
        summary: {
          projectId,
          projectName: aggregatedData.project?.project_name,
          domain: aggregatedData.project?.main_url,
          overallScore: calculatedMetrics.scores.overall,
          overallGrade: calculatedMetrics.grades.overall.grade,
          totalIssues: calculatedMetrics.issues.total,
          pagesCrawled: calculatedMetrics.pageMetrics.total,
          dataFreshness: PDFDataMapper.calculateDataFreshness(aggregatedData),
          lastUpdated: aggregatedData.metadata?.fetchedAt
        }
      };
      
    } catch (error) {
      LoggerUtil.error('PDF summary generation failed', error, { projectId });
      
      return {
        success: false,
        error: {
          message: error.message,
          code: 'PDF_SUMMARY_GENERATION_FAILED'
        }
      };
    }
  }

  /**
   * Validate project for PDF generation
   * @param {string} projectId - Project ID
   * @returns {Object} Validation result
   */
  static async validateProjectForPDF(projectId) {
    try {
      const aggregatedData = await PDFAggregationService.fetchAllPDFData(projectId);
      
      const validation = {
        hasProjectData: !!aggregatedData.project,
        hasAIData: !!(aggregatedData.ai?.visibility?.summary),
        hasTechnicalData: !!aggregatedData.technical,
        hasPageData: !!(aggregatedData.pages?.data),
        minimumData: false,
        warnings: [],
        ready: false
      };
      
      // Check minimum data requirements
      validation.minimumData = validation.hasProjectData && validation.hasPageData;
      
      // Add warnings for missing data
      if (!validation.hasAIData) {
        validation.warnings.push('AI visibility data not available - some sections will show placeholder data');
      }
      
      if (!validation.hasTechnicalData) {
        validation.warnings.push('Technical SEO data not available - technical sections will be limited');
      }
      
      // Determine readiness
      validation.ready = validation.minimumData && validation.warnings.length <= 2;
      
      return {
        success: true,
        validation
      };
      
    } catch (error) {
      LoggerUtil.error('PDF validation failed', error, { projectId });
      
      return {
        success: false,
        error: {
          message: error.message,
          code: 'PDF_VALIDATION_FAILED'
        }
      };
    }
  }

  /**
   * Get PDF generation status
   * @param {string} projectId - Project ID
   * @returns {Object} Generation status
   */
  static async getPDFGenerationStatus(projectId) {
    try {
      const validation = await this.validateProjectForPDF(projectId);
      
      if (!validation.success) {
        return validation;
      }
      
      const { hasProjectData, hasAIData, hasTechnicalData, hasPageData } = validation.validation;
      
      return {
        success: true,
        status: {
          ready: validation.validation.ready,
          dataCompleteness: {
            project: hasProjectData,
            ai: hasAIData,
            technical: hasTechnicalData,
            pages: hasPageData
          },
          estimatedGenerationTime: this.estimateGenerationTime(validation.validation),
          recommendations: this.getRecommendations(validation.validation)
        }
      };
      
    } catch (error) {
      LoggerUtil.error('PDF status check failed', error, { projectId });
      
      return {
        success: false,
        error: {
          message: error.message,
          code: 'PDF_STATUS_CHECK_FAILED'
        }
      };
    }
  }

  /**
   * Estimate PDF generation time based on data availability
   */
  static estimateGenerationTime(validation) {
    let baseTime = 500; // 500ms base
    
    if (validation.hasAIData) baseTime += 200;
    if (validation.hasTechnicalData) baseTime += 100;
    if (validation.hasPageData) baseTime += 150;
    
    return baseTime;
  }

  /**
   * Get recommendations based on validation
   */
  static getRecommendations(validation) {
    const recommendations = [];
    
    if (!validation.hasAIData) {
      recommendations.push('Run AI visibility audit to complete PDF data');
    }
    
    if (!validation.hasTechnicalData) {
      recommendations.push('Run technical SEO audit for complete analysis');
    }
    
    if (!validation.hasPageData) {
      recommendations.push('Complete website crawling for page-level data');
    }
    
    if (validation.ready) {
      recommendations.push('Project ready for full PDF generation');
    } else {
      recommendations.push('Address missing data sources before PDF generation');
    }
    
    return recommendations;
  }

  /**
   * Cache PDF data (placeholder for future caching implementation)
   * @param {string} projectId - Project ID
   * @param {Object} pdfData - PDF data to cache
   * @param {number} ttl - Time to live in seconds
   */
  static async cachePDFData(projectId, pdfData, ttl = 3600) {
    // Placeholder for Redis or in-memory caching
    LoggerUtil.info('PDF data caching (not implemented)', { projectId, ttl });
    
    return {
      success: true,
      cached: false,
      message: 'Caching not implemented - data generated fresh each time'
    };
  }

  /**
   * Get cached PDF data (placeholder)
   * @param {string} projectId - Project ID
   */
  static async getCachedPDFData(projectId) {
    // Placeholder for Redis or in-memory caching
    LoggerUtil.info('PDF cache check (not implemented)', { projectId });
    
    return {
      success: true,
      cached: false,
      data: null,
      message: 'Caching not implemented'
    };
  }

  /**
   * Invalidate PDF cache (placeholder)
   * @param {string} projectId - Project ID
   */
  static async invalidatePDFCache(projectId) {
    // Placeholder for cache invalidation
    LoggerUtil.info('PDF cache invalidation (not implemented)', { projectId });
    
    return {
      success: true,
      invalidated: false,
      message: 'Caching not implemented'
    };
  }

  /**
   * Get PDF generation metrics
   * @param {string} projectId - Project ID
   */
  static async getPDFGenerationMetrics(projectId) {
    try {
      const startTime = Date.now();
      const aggregatedData = await PDFAggregationService.fetchAllPDFData(projectId);
      const calculatedMetrics = PDFCalculationService.calculateAllMetrics(aggregatedData);
      
      return {
        success: true,
        metrics: {
          dataFetchTime: aggregatedData.metadata?.queryTime || 0,
          calculationTime: Date.now() - startTime,
          totalSections: 30, // Fixed number of PDF sections
          dataPoints: this.countDataPoints(aggregatedData),
          memoryUsage: this.estimateMemoryUsage(aggregatedData),
          complexity: this.assessComplexity(calculatedMetrics)
        }
      };
      
    } catch (error) {
      LoggerUtil.error('PDF metrics generation failed', error, { projectId });
      
      return {
        success: false,
        error: {
          message: error.message,
          code: 'PDF_METRICS_GENERATION_FAILED'
        }
      };
    }
  }

  /**
   * Count total data points in aggregated data
   */
  static countDataPoints(aggregatedData) {
    let count = 0;
    
    // Simple estimation based on collection sizes
    if (aggregatedData.pages?.data?.totalPages) count += aggregatedData.pages.data.totalPages;
    if (aggregatedData.ai?.issues?.byRule) count += aggregatedData.ai.issues.byRule.length;
    if (aggregatedData.issues?.pages?.byType) count += aggregatedData.issues.pages.byType.length;
    if (aggregatedData.ai?.entities?.byType) count += aggregatedData.ai.entities.byType.length;
    
    return count;
  }

  /**
   * Estimate memory usage for PDF data
   */
  static estimateMemoryUsage(aggregatedData) {
    // Rough estimation in KB
    let sizeKB = 50; // Base size
    
    if (aggregatedData.pages?.data?.totalPages) sizeKB += aggregatedData.pages.data.totalPages * 0.5;
    if (aggregatedData.ai?.issues?.byRule) sizeKB += aggregatedData.ai.issues.byRule.length * 2;
    if (aggregatedData.ai?.entities?.byType) sizeKB += aggregatedData.ai.entities.byType.length * 1;
    
    return sizeKB;
  }

  /**
   * Assess data complexity
   */
  static assessComplexity(calculatedMetrics) {
    const { issues, pageMetrics, aiMetrics } = calculatedMetrics;
    
    let complexity = 'low';
    
    if (issues.total > 50) complexity = 'medium';
    if (issues.total > 100 || pageMetrics.total > 500) complexity = 'high';
    if (aiMetrics.entities?.total > 100) complexity = 'very_high';
    
    return complexity;
  }
}
