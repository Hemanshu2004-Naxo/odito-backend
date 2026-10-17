/**
 * Cover Page Service
 * Handles cover page data generation for PDF reports
 */

import mongoose from 'mongoose';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { ProjectPerformanceService } from '../../app_user/service/projectPerformance.service.js';
import { TechnicalChecksService } from '../../app_user/service/technicalChecks.service.js';

export class CoverPageService {
  
  /**
   * Get cover page data for a project
   * @param {string} projectId - Project ID
   * @returns {Object} Cover page data structure
   */
  static async getCoverPageData(projectId) {
    const startTime = Date.now();
    
    try {
      LoggerUtil.info('Cover page data generation started', { projectId });
      
      // Validate projectId
      if (!projectId) {
        throw new Error('Project ID is required');
      }
      
      const db = mongoose.connection.db;
      const { ObjectId } = mongoose.Types;
      const projectIdObj = new ObjectId(projectId);
      
      // Step 1: Fetch project from seoprojects collection
      const project = await db.collection('seoprojects')
        .findOne({ _id: projectIdObj });
      
      if (!project) {
        throw new Error('Project not found');
      }
      
      LoggerUtil.debug('Project found', { 
        projectId: project._id,
        projectName: project.project_name,
        mainUrl: project.main_url
      });
      
      // Step 2: Fetch issue statistics
      const issueStats = await this.getIssueStatistics(db, projectIdObj);
      
      // Step 3: Fetch performance metrics (placeholder - will be computed)
      const performanceMetrics = await this.getPerformanceMetrics(db, projectIdObj, project);
      
      // Step 4: Calculate derived metrics
      const calculatedData = await this.calculateDerivedMetrics(
        project,
        issueStats,
        performanceMetrics,
        db,
        projectIdObj
      );
      
      // Step 5: Build final response structure
      const coverPageData = {
        domain: this.extractDomain(project.main_url) || '',
        companyName: project.project_name || '',
        auditDate: this.formatDate(project.last_analysis_at || project.created_at),
        engine: 'Odito AI',
        pagesCrawled: project.pages_crawled || 0,
        preparedFor: project.project_name || '',
        overallScore: calculatedData.overallScore,
        overallGrade: project.website_grade || 'N/A',
        scores: {
          performance: calculatedData.performance,
          seoHealth: calculatedData.seoHealth,
          aiVisibility: calculatedData.aiVisibility,
          technicalHealth: calculatedData.technicalHealth
        },
        issues: {
          critical: issueStats.totalIssues,       // Total Issues → totalIssues
          warnings: issueStats.critical,           // Critical Issues → high severity
          informational: issueStats.warnings,      // Medium Issues → medium severity
          passed: issueStats.informational         // Info Issues → low + info
        },
        pagesCrawled: project.pages_crawled || 0
      };
      
      // Validate no undefined values
      this.validateCoverPageData(coverPageData);
      
      const totalTime = Date.now() - startTime;
      
      LoggerUtil.info('Cover page data generation completed', {
        projectId,
        totalTime,
        domain: coverPageData.domain,
        overallScore: coverPageData.overallScore
      });
      
      return {
        success: true,
        data: coverPageData,
        metadata: {
          generatedAt: new Date(),
          generationTime: totalTime,
          projectId
        }
      };
      
    } catch (error) {
      LoggerUtil.error('Cover page data generation failed', error, { projectId });
      
      return {
        success: false,
        error: {
          message: error.message,
          code: 'COVER_PAGE_GENERATION_FAILED',
          details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        }
      };
    }
  }
  
  /**
   * Row-level severity counts for unified JSON / AI scripts (matches DB totals, e.g. 848).
   * Page 08 "top issues" is aggregated by issue type — do not use that list for totals.
   */
  static async getFullIssueSeverityCounts(db, projectIdObj) {
    try {
      const rows = await db
        .collection('seo_page_issues')
        .aggregate([
          { $match: { projectId: projectIdObj, status: { $ne: 'excluded' } } },
          {
            $group: {
              _id: null,
              totalIssues: { $sum: 1 },
              critical: { $sum: { $cond: [{ $eq: ['$severity', 'critical'] }, 1, 0] } },
              high: { $sum: { $cond: [{ $eq: ['$severity', 'high'] }, 1, 0] } },
              medium: { $sum: { $cond: [{ $eq: ['$severity', 'medium'] }, 1, 0] } },
              low: { $sum: { $cond: [{ $eq: ['$severity', 'low'] }, 1, 0] } },
              info: { $sum: { $cond: [{ $eq: ['$severity', 'info'] }, 1, 0] } }
            }
          }
        ])
        .toArray();

      const c = rows[0] || {};
      const lowInfo = (c.low || 0) + (c.info || 0);
      const total = c.totalIssues || 0;
      return {
        critical: c.critical || 0,
        high: c.high || 0,
        medium: c.medium || 0,
        low: lowInfo,
        total
      };
    } catch (e) {
      LoggerUtil.warn('CoverPageService.getFullIssueSeverityCounts failed', { message: e?.message });
      return { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
    }
  }

  /**
   * Get issue statistics from seo_page_issues collection
   * Updated with new business logic mapping
   */
  static async getIssueStatistics(db, projectIdObj) {
    try {
      console.log("COVER COUNTS: Fetching issue statistics for projectId:", projectIdObj);
      
      // Use correct aggregation pipeline matching executive summary
      const issueCounts = await db.collection('seo_page_issues')
        .aggregate([
          { $match: { projectId: projectIdObj, status: { $ne: 'excluded' } } },
          {
            $group: {
              _id: null,
              totalIssues: { $sum: 1 },
              critical: {
                $sum: {
                  $cond: [{ $eq: ['$severity', 'high'] }, 1, 0]
                }
              },
              warnings: {
                $sum: {
                  $cond: [{ $eq: ['$severity', 'medium'] }, 1, 0]
                }
              },
              informational: {
                $sum: {
                  $cond: [
                    { $in: ['$severity', ['low', 'info']] },
                    1,
                    0
                  ]
                }
              },
              low: {
                $sum: {
                  $cond: [{ $eq: ['$severity', 'low'] }, 1, 0]
                }
              },
              info: {
                $sum: {
                  $cond: [{ $eq: ['$severity', 'info'] }, 1, 0]
                }
              }
            }
          },
          {
            $project: {
              _id: 0,
              totalIssues: 1,
              critical: 1,
              warnings: 1,
              informational: 1,
              low: 1,
              info: 1
            }
          }
        ]).toArray();

      const counts = issueCounts[0] || {
        totalIssues: 0,
        critical: 0,
        warnings: 0,
        informational: 0,
        low: 0,
        info: 0
      };
      
      console.log("COVER COUNTS:", counts);
      
      // Apply new business logic mapping
      const stats = {
        totalIssues: counts.totalIssues,        // For total issues display
        critical: counts.critical,              // Critical Issues → high severity
        warnings: counts.warnings,              // Medium Issues → medium severity
        informational: counts.low + counts.info, // Info Issues → low + info
        passed: counts.low + counts.info        // Keep passed for validation compatibility
      };
      
      console.log("COVER MAPPED STATS:", stats);
      LoggerUtil.debug('Issue statistics calculated', stats);
      return stats;
      
    } catch (error) {
      LoggerUtil.error('Failed to get issue statistics', error);
      return { 
        totalIssues: 0,
        critical: 0, 
        warnings: 0, 
        informational: 0,
        passed: 0
      };
    }
  }
  
  /**
   * Get performance metrics (placeholder implementation)
   */
  static async getPerformanceMetrics(db, projectIdObj, project) {
    try {
      console.log("GETTING PERFORMANCE METRICS for project:", projectIdObj);
      
      // Use the project._id directly if it's already an ObjectId
      let projectIdForQuery;
      if (typeof project._id === 'object' && project._id._bsize === 12) {
        projectIdForQuery = project._id;
      } else if (typeof project._id === 'string') {
        const { ObjectId } = mongoose.Types;
        projectIdForQuery = new ObjectId(project._id);
      } else {
        console.error("Invalid project._id type:", typeof project._id);
        projectIdForQuery = null;
      }
      
      if (projectIdForQuery) {
        // For now, use available data and reasonable defaults
        const baseMetrics = {
          crawlSuccessRate: project.crawl_status === 'completed' ? 100 : 0,
          pagesAnalyzed: project.pages_analyzed || 0,
          totalIssues: project.total_issues || 0
        };
        
        console.log("PERFORMANCE METRICS CALCULATED:", baseMetrics);
        LoggerUtil.debug('Performance metrics calculated', baseMetrics);
        return baseMetrics;
      } else {
        return { crawlSuccessRate: 0, pagesAnalyzed: 0, totalIssues: 0 };
      }
    } catch (error) {
      LoggerUtil.error('Failed to get performance metrics', error);
      return { crawlSuccessRate: 0, pagesAnalyzed: 0, totalIssues: 0 };
    }
  }

  /**
   * Derive composite scores from cover inputs. Never throws — missing inputs yield 0 for that field.
   */
  static async calculateDerivedMetrics(project, issueStats, performanceMetrics, db, projectIdObj) {
    const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

    // Get Performance score from the SAME service as Dashboard
    let performanceScore = 0;
    try {
      console.log("COVER: Getting performance from ProjectPerformanceService for project:", projectIdObj);
      const performanceResult = await ProjectPerformanceService.getProjectPerformance(project);
      if (performanceResult.success && performanceResult.data?.summary?.performanceScore !== undefined) {
        performanceScore = performanceResult.data.summary.performanceScore;
        console.log("COVER: Performance score from service:", performanceScore);
      }
    } catch (e) {
      LoggerUtil.warn('CoverPageService: ProjectPerformanceService call failed', { message: e?.message });
    }

    // Get Technical Health from the SAME service as Dashboard
    let technicalHealth = 0;
    try {
      console.log("COVER: Getting technical health from TechnicalChecksService for project:", projectIdObj);
      const technicalResult = await TechnicalChecksService.getTechnicalChecks(project);
      if (technicalResult.success && technicalResult.data?.summary?.healthScore !== undefined) {
        technicalHealth = technicalResult.data.summary.healthScore;
        console.log("COVER: Technical health from service:", technicalHealth);
      }
    } catch (e) {
      LoggerUtil.warn('CoverPageService: TechnicalChecksService call failed', { message: e?.message });
    }

    const total = issueStats?.totalIssues || 0;
    const critical = issueStats?.critical || 0;
    const warnings = issueStats?.warnings || 0;
    const informational = issueStats?.informational || 0;

    let seoHealth = 0;
    try {
      if (project?.website_score != null && !Number.isNaN(Number(project.website_score))) {
        seoHealth = clamp(project.website_score);
      } else if (total === 0) {
        seoHealth = 90;
      } else {
        const weighted = critical * 2.5 + warnings * 1.5 + informational * 0.4;
        const penalty = Math.min(85, (weighted / Math.max(total, 1)) * 38);
        seoHealth = clamp(100 - penalty);
      }
    } catch (e) {
      LoggerUtil.warn('CoverPageService: seoHealth derivation failed', { message: e?.message });
      seoHealth = 0;
    }

    let aiVisibilityRaw = Math.round(project?.ai_visibility?.score || 0);
    try {
      const schemaHint = Number(project?.schema_types_count ?? project?.schema_markup_count ?? 0) || 0;
      if (schemaHint > 0 && aiVisibilityRaw < 95) {
        aiVisibilityRaw = Math.min(100, aiVisibilityRaw + Math.min(12, schemaHint));
      }
      if (project?.knowledge_graph?.present || project?.knowledge_graph?.exists) {
        aiVisibilityRaw = Math.min(100, aiVisibilityRaw + 5);
      }
    } catch (e) {
      LoggerUtil.warn('CoverPageService: aiVisibility adjustment failed', { message: e?.message });
    }

    const aiVis = clamp(aiVisibilityRaw);
    const overallScore = Math.round((seoHealth + performanceScore + technicalHealth + aiVis) / 4);

    return {
      seoHealth,
      performance: performanceScore,
      technicalHealth,
      aiVisibility: aiVis,
      overallScore
    };
  }
  
  /**
   * Extract domain from URL
   */
  static extractDomain(url) {
    if (!url) return '';
    
    try {
      // Remove protocol and www, then get domain
      const cleanUrl = url.replace(/^https?:\/\//, '').replace(/^www\./, '');
      const domain = cleanUrl.split('/')[0];
      return domain || '';
    } catch (error) {
      LoggerUtil.error('Failed to extract domain', error, { url });
      return '';
    }
  }
  
  /**
   * Format date for display
   */
  static formatDate(date) {
    if (!date) return '';
    
    try {
      const d = new Date(date);
      if (isNaN(d.getTime())) return '';
      
      return d.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
    } catch (error) {
      LoggerUtil.error('Failed to format date', error, { date });
      return '';
    }
  }
  
  /**
   * Validate cover page data has no undefined values
   */
  static validateCoverPageData(data) {
    const checkValue = (value, path) => {
      if (value === undefined) {
        throw new Error(`Undefined value found at: ${path}`);
      }
    };
    
    // Check all top-level fields
    Object.keys(data).forEach(key => {
      checkValue(data[key], key);
    });
    
    // Check nested objects
    if (data.scores) {
      Object.keys(data.scores).forEach(key => {
        checkValue(data.scores[key], `scores.${key}`);
      });
    }
    
    if (data.issues) {
      Object.keys(data.issues).forEach(key => {
        checkValue(data.issues[key], `issues.${key}`);
      });
    }
    
    LoggerUtil.debug('Cover page data validation passed');
  }
}
