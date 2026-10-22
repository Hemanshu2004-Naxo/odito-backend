/**
 * PDF Data Aggregation Service
 * Fetches all required database data in optimized queries
 */

import mongoose from 'mongoose';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import IssueAggregationService from '../../../services/issueAggregationService.js';

export class PDFAggregationService {
  
  /**
   * Fetch all data required for PDF generation
   * @param {string} projectId - Project ID
   * @returns {Object} Aggregated data from all collections
   */
  static async fetchAllPDFData(projectId) {
    const startTime = Date.now();

    let db, ObjectId;
    try {
      const connection = this.getDbConnection();
      db = connection.db;
      ObjectId = connection.ObjectId;
    } catch (error) {
      LoggerUtil.error('PDF aggregation DB connection failed', error);
      throw new Error(`Database connection failed: ${error.message}`);
    }
    
    const projectIdObj = new ObjectId(projectId);

    try {
      // Execute all queries in parallel for maximum performance
      const [
        projectData,
        aiVisibilityData,
        aiPageScoresData,
        aiEntitiesData,
        domainTechnicalData,
        pageIssuesData,
        pageData,
        internalLinksData,
        socialLinksData,
        onpageIssuesData,
        performanceData
      ] = await Promise.all([
        // 1. Basic project information
        this.fetchProjectData(db, projectIdObj),

        // 2. AI visibility data
        this.fetchAIVisibilityData(db, projectIdObj),

        // 3. AI page scores
        this.fetchAIPageScoresData(db, projectIdObj),

        // 5. AI entities
        this.fetchAIEntitiesData(db, projectIdObj),

        // 6. Domain technical report
        this.fetchDomainTechnicalData(db, projectIdObj),

        // 7. Page issues
        this.fetchPageIssuesData(db, projectIdObj),

        // 8. Onpage issues (NEW - for executive summary)
        this.fetchOnpageIssuesData(db, projectIdObj),

        // 9. Page data
        this.fetchPageData(db, projectIdObj),

        // 10. Link data (external links disabled)
        this.fetchInternalLinksData(db, projectIdObj),
        this.fetchSocialLinksData(db, projectIdObj),

        // 11. Performance data (for Core Web Vitals)
        this.fetchPerformanceData(db, projectIdObj)
      ]);

      const aggregatedData = {
        project: projectData,
        ai: {
          visibility: aiVisibilityData,
          pageScores: aiPageScoresData,
          entities: aiEntitiesData
        },
        technical: domainTechnicalData,
        pages: {
          issues: pageIssuesData,
          onpageIssues: onpageIssuesData,
          data: pageData
        },
        links: {
          internal: internalLinksData,
          external: { total: 0, sourcePages: 0, uniqueDomains: 0, targetUrls: 0 },  // External links disabled
          social: socialLinksData
        },
        performance: performanceData,
        metadata: {
          fetchedAt: new Date(),
          projectId,
          queryTime: Date.now() - startTime
        }
      };

      LoggerUtil.database('aggregate', 'pdf_all_data', Date.now() - startTime, {
        projectId,
        collections: 11
      });

      return aggregatedData;

    } catch (error) {
      LoggerUtil.error('PDF aggregation query failed', error);

      const fallbackData = {
        project: { project_name: "Unknown", main_url: "N/A" },
        ai: {
          visibility: { summary: null, pageData: [] },
          pageScores: { scoreStats: null },
          entities: { entityStats: null, entityTypes: null, relationshipStats: null }
        },
        technical: { domain: null, robotsStatus: null },
        pages: {
          issues: null,
          onpageIssues: null,
          data: null
        },
        links: {
          internal: { totalLinks: 0, uniqueSourcePages: 0, platforms: [] },
          external: { totalLinks: 0, uniqueSourcePages: 0, platforms: [] },
          social: { totalLinks: 0, uniqueSourcePages: 0, platforms: [] }
        },
        performance: { mobile: null, desktop: null },
        metadata: {
          fetchedAt: new Date(),
          projectId,
          queryTime: Date.now() - startTime,
          error: error.message
        }
      };

      LoggerUtil.database('aggregate', 'pdf_all_data_error', Date.now() - startTime, {
        projectId,
        error: error.message,
        fallbackUsed: true
      });

      return fallbackData;
    }
  }

  /**
   * Fetch basic project data
   */
  static async fetchProjectData(db, projectId) {
    const project = await db.collection('seoprojects')
      .findOne({ _id: projectId }, {
        project_name: 1,
        main_url: 1,
        status: 1,
        createdAt: 1,
        last_scraped: 1,
        user_id: 1
      });

    return project || {};
  }

  /**
   * Fetch AI visibility summary data
   */
  static async fetchAIVisibilityData(db, projectId) {
    const [summary, pageData] = await Promise.all([
      // AI visibility project summary
      db.collection('seo_ai_visibility_project')
        .findOne({ projectId }, {
          'summary.overallScore': 1,
          'summary.grade': 1,
          'summary.totalIssues': 1,
          'summary.highSeverityIssues': 1,
          'summary.mediumSeverityIssues': 1,
          'summary.lowSeverityIssues': 1,
          'summary.pagesScored': 1,
          'summary.totalPages': 1,
          'summary.categoryAverages': 1,
          'aiStatus': 1,
          'completedAt': 1
        }),
      
      // AI visibility page-level data
      db.collection('seo_ai_visibility')
        .aggregate([
          { $match: { projectId } },
          {
            $group: {
              _id: null,
              totalPages: { $sum: 1 },
              avgVisibilityScore: { $avg: '$overall_page_score' },
              minScore: { $min: '$overall_page_score' },
              maxScore: { $max: '$overall_page_score' },
              totalEntities: { $sum: '$entity_count' },
              avgEntities: { $avg: '$entity_count' },
              pagesWithSchema: {
                $sum: {
                  $cond: {
                    if: { $gt: ['$schema_count', 0] },
                    then: 1,
                    else: 0
                  }
                }
              }
            }
          }
        ]).toArray()
    ]);

    return {
      summary: summary?.summary || {},
      status: summary?.aiStatus || 'pending',
      completedAt: summary?.completedAt,
      aggregates: pageData[0] || {}
    };
  }

  /**
   * Fetch AI page scores data
   */
  static async fetchAIPageScoresData(db, projectId) {
    const scoreStats = await db.collection('seo_ai_page_scores')
      .aggregate([
        { $match: { projectId } },
        {
          $group: {
            _id: null,
            totalScored: { $sum: 1 },
            avgBlocking: { $avg: '$blocking' },
            avgCompleteness: { $avg: '$completeness' },
            avgQuality: { $avg: '$quality_score' },
            minBlocking: { $min: '$blocking' },
            maxBlocking: { $max: '$blocking' },
            minCompleteness: { $min: '$completeness' },
            maxCompleteness: { $max: '$completeness' }
          }
        }
      ]).toArray();

    return scoreStats[0] || {};
  }

  /**
   * Fetch AI entities data
   */
  static async fetchAIEntitiesData(db, projectId) {
    const [entityStats, entityTypes, relationshipStats] = await Promise.all([
      // Overall entity statistics
      db.collection('ai_visibility_entities')
        .aggregate([
          { $match: { projectId } },
          {
            $group: {
              _id: null,
              totalEntities: { $sum: 1 },
              avgImportance: { $avg: '$importance' },
              avgConfidence: { $avg: '$confidence' },
              uniqueTypes: { $addToSet: '$type' }
            }
          }
        ]).toArray(),
      
      // Entity type distribution
      db.collection('ai_visibility_entities')
        .aggregate([
          { $match: { projectId } },
          {
            $group: {
              _id: '$type',
              count: { $sum: 1 },
              avgImportance: { $avg: '$importance' },
              avgConfidence: { $avg: '$confidence' }
            }
          },
          {
            $project: {
              type: '$_id',
              count: 1,
              avgImportance: { $round: ['$avgImportance', 2] },
              avgConfidence: { $round: ['$avgConfidence', 2] },
              _id: 0
            }
          }
        ]).toArray(),
      
      // Relationship statistics
      db.collection('ai_visibility_relationships')
        .aggregate([
          { $match: { projectId } },
          {
            $group: {
              _id: null,
              totalRelationships: { $sum: 1 },
              avgStrength: { $avg: '$strength' },
              uniqueTypes: { $addToSet: '$relationship_type' }
            }
          }
        ]).toArray()
    ]);

    return {
      summary: entityStats[0] || {},
      byType: entityTypes,
      relationships: relationshipStats[0] || {}
    };
  }

  /**
   * Fetch domain technical report data
   */
  static async fetchDomainTechnicalData(db, projectId) {
    const technical = await db.collection('domain_technical_reports')
      .findOne({ projectId }, {
        domain: 1,
        robotsStatus: 1,
        robotsExists: 1,
        robotsContent: 1,
        sitemapStatus: 1,
        sitemapExists: 1,
        sitemapContent: 1,
        parsedSitemapUrlCount: 1,
        sslValid: 1,
        sslExpiryDate: 1,
        sslDaysRemaining: 1,
        httpsRedirect: 1,
        redirectChain: 1,
        finalUrl: 1,
        sitemapDeepValidation: 1,
        createdAt: 1
      });

    return technical || {};
  }

  /**
   * Fetch page issues data
   */
  static async fetchPageIssuesData(db, projectId) {
    const [issueStats, issuesByType] = await Promise.all([
      // Overall issue statistics
      db.collection('seo_page_issues')
        .aggregate([
          { $match: { projectId, status: 'open' } },
          {
            $group: {
              _id: null,
              totalIssues: { $sum: 1 },
              uniquePages: { $addToSet: '$page_url' },
              avgSeverity: { $avg: {
                $cond: {
                  if: { $eq: ['$severity', 'critical'] },
                  then: 4,
                  else: {
                    $cond: {
                      if: { $eq: ['$severity', 'high'] },
                      then: 3,
                      else: {
                        $cond: {
                          if: { $eq: ['$severity', 'medium'] },
                          then: 2,
                          else: 1
                        }
                      }
                    }
                  }
                }
              }}
            }
          }
        ]).toArray(),
      
      // Issues by type/category
      db.collection('seo_page_issues')
        .aggregate([
          { $match: { projectId, status: 'open' } },
          {
            $group: {
              _id: '$issue_type',
              count: { $sum: 1 },
              severity: { $first: '$severity' },
              pagesAffected: { $addToSet: '$page_url' }
            }
          },
          {
            $project: {
              issueType: '$_id',
              count: 1,
              severity: 1,
              pagesAffected: { $size: '$pagesAffected' },
              _id: 0
            }
          },
          { $sort: { count: -1 } },
          { $limit: 15 }
        ]).toArray()
    ]);

    return {
      summary: issueStats[0] || {},
      byType: issuesByType
    };
  }

  /**
   * Fetch page data
   */
  static async fetchPageData(db, projectId) {
    const pageStats = await db.collection('seo_page_data')
      .aggregate([
        { $match: { projectId } },
        {
          $group: {
            _id: null,
            totalPages: { $sum: 1 },
            indexedPages: { 
              $sum: {
                $cond: {
                  if: '$indexed',
                  then: 1,
                  else: 0
                }
              }
            },
            pagesWithH1: { 
              $sum: {
                $cond: {
                  if: { $gt: ['$h1_count', 0] },
                  then: 1,
                  else: 0
                }
              }
            },
            pagesWithCanonical: { 
              $sum: {
                $cond: {
                  if: { $ne: ['$canonical_url', null] },
                  then: 1,
                  else: 0
                }
              }
            },
            pagesWithMetaDesc: { 
              $sum: {
                $cond: {
                  if: { $ne: ['$meta_description', null] },
                  then: 1,
                  else: 0
                }
              }
            },
            pagesWithTitle: { 
              $sum: {
                $cond: {
                  if: { $ne: ['$title', null] },
                  then: 1,
                  else: 0
                }
              }
            },
            avgWordCount: { $avg: '$word_count' },
            totalWordCount: { $sum: '$word_count' }
          }
        }
      ]).toArray();

    return pageStats[0] || {};
  }

  /**
   * Fetch internal links data
   */
  static async fetchInternalLinksData(db, projectId) {
    const stats = await db.collection('seo_ai_internal_links')
      .aggregate([
        { $match: { projectId } },
        {
          $group: {
            _id: null,
            totalLinks: { $sum: 1 },
            uniqueSourcePages: { $addToSet: '$source_url' },
            uniqueTargetPages: { $addToSet: '$target_url' },
            avgLinksPerPage: { $avg: { $size: { $ifNull: ['$links', []] } } }
          }
        }
      ]).toArray();

    const result = stats[0] || {};
    return {
      total: result.totalLinks || 0,
      sourcePages: result.uniqueSourcePages ? result.uniqueSourcePages.length : 0,
      targetPages: result.uniqueTargetPages ? result.uniqueTargetPages.length : 0,
      avgPerPage: result.avgLinksPerPage || 0
    };
  }

  /**
   * Fetch external links data
   */
  static async fetchExternalLinksData(db, projectId) {
    // External links disabled - return empty data
    return {
      total: 0,
      sourcePages: 0,
      uniqueDomains: 0,
      targetUrls: 0
    };
  }

  /**
   * Fetch onpage issues data for executive summary
   */
  static async fetchOnpageIssuesData(db, projectId) {
    try {
      return await this.queryOnpageIssueCounts(db, projectId);
    } catch (error) {
      LoggerUtil.error('Failed to fetch onpage issues', error);
      return { 
        totalIssues: 0,
        critical: 0,
        warnings: 0,
        informational: 0
      };
    }
  }

  /**
   * Open-issue severity counts. Throws on failure so callers that report to
   * customers (Executive Summary) can surface an error instead of "0 issues".
   * critical = critical+high severity, warnings = medium, informational = low+info.
   */
  static async queryOnpageIssueCounts(db, projectId) {
    {
      const issueCounts = await db.collection('seo_page_issues')
        .aggregate([
          { $match: { projectId, status: 'open' } },
          {
            $group: {
              _id: null,
              critical: {
                $sum: {
                  $cond: [{ $in: ['$severity', ['critical', 'high']] }, 1, 0]
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
              totalIssues: { $sum: 1 }
            }
          },
          {
            $project: {
              _id: 0,
              totalIssues: 1,
              critical: 1,
              warnings: 1,
              informational: 1
            }
          }
        ]).toArray();

      const result = issueCounts[0] || {
        totalIssues: 0,
        critical: 0,
        warnings: 0,
        informational: 0
      };

      return result;
    }
  }

  /**
   * Get onpage issue counts - standalone function as requested
   * @param {string} projectId - Project ID
   * @returns {Object} Issue counts with exact mapping
   */
  static async getOnPageIssueCounts(projectId) {
    try {
      // Canonical counts: identical to the dashboard Overview total
      // (IssueCountsService -> IssueAggregationService.getIssueSummary):
      // open issues, distinct dedup_key, all categories.
      const summary = await IssueAggregationService.getIssueSummary(projectId, { excludeCategories: [] });
      return {
        totalIssues: summary.totalIssues,
        critical: summary.critical,
        warnings: summary.warnings,
        informational: summary.informational
      };
    } catch (error) {
      // Do not convert a failure into zero counts; callers must surface it.
      LoggerUtil.error('Failed to get onpage issue counts', error);
      throw error;
    }
  }

  /**
   * Fetch performance data from seo_domain_performance collection
   */
  static async fetchPerformanceData(db, projectId) {
    try {
      const collection = db.collection('seo_domain_performance');
      const performance = await collection.findOne({ project_id: projectId }, {
        mobile: 1,
        desktop: 1,
        domain: 1,
        tested_at: 1
      });

      if (!performance) {
        return { mobile: null, desktop: null };
      }

      // Format device data similar to projectPerformance.service.js
      const formatDeviceData = (deviceData) => {
        if (!deviceData) return null;
        
        // Extract TTFB from diagnostics if available
        let ttfb = null;
        if (deviceData.diagnostics && Array.isArray(deviceData.diagnostics)) {
          const serverResponseTime = deviceData.diagnostics.find(d => d.id === 'server-response-time');
          if (serverResponseTime && serverResponseTime.details && serverResponseTime.details.items && serverResponseTime.details.items.length > 0) {
            const responseTime = serverResponseTime.details.items[0].responseTime;
            if (responseTime !== undefined) {
              ttfb = { value: responseTime, unit: 'ms', display_value: `${responseTime} ms` };
            }
          }
        }

        return {
          performance: deviceData.performance_score || 0,
          accessibility: deviceData.accessibility_score || 0,
          best_practices: deviceData.best_practices_score || 0,
          seo: deviceData.seo_score || 0,
          metrics: deviceData.metrics || {},
          fcp: deviceData.fcp,
          lcp: deviceData.lcp,
          cls: deviceData.cls,
          tbt: deviceData.tbt,
          ttfb: ttfb,
          opportunities: deviceData.opportunities || [],
          diagnostics: deviceData.diagnostics || []
        };
      };

      return {
        mobile: formatDeviceData(performance.mobile),
        desktop: formatDeviceData(performance.desktop),
        domain: performance.domain,
        tested_at: performance.tested_at
      };
    } catch (error) {
      LoggerUtil.error('Failed to fetch performance data', error);
      return { mobile: null, desktop: null };
    }
  }

  /**
   * Fetch social links data
   */
  static async fetchSocialLinksData(db, projectId) {
    const stats = await db.collection('seo_social_links')
      .aggregate([
        { $match: { projectId } },
        {
          $group: {
            _id: null,
            totalLinks: { $sum: 1 },
            uniqueSourcePages: { $addToSet: '$source_url' },
            platforms: { $addToSet: '$platform' }
          }
        }
      ]).toArray();

    const result = stats[0] || {};
    return {
      total: result.totalLinks || 0,
      sourcePages: result.uniqueSourcePages ? result.uniqueSourcePages.length : 0,
      platforms: result.platforms ? result.platforms.length : 0
    };
  }

  /**
   * Get database connection helper
   */
  static getDbConnection() {
    const db = mongoose.connection.db;
    if (!db) {
      const fallbackDb = mongoose.connections[0]?.db;
      if (!fallbackDb) {
        throw new Error("Database connection not available");
      }
      const { ObjectId } = mongoose.Types;
      return { db: fallbackDb, ObjectId };
    }
    const { ObjectId } = mongoose.Types;
    return { db, ObjectId };
  }
}
