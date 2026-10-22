import { NotFoundError, AccessDeniedError } from '../../../utils/ErrorUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import mongoose from 'mongoose';
import { resolveIssueDifficulty } from '../../../config/issueMetadata.js';

/**
 * Technical Checks Service
 * Extracted from projectDataController.js - Phase 2 Refactoring
 * 
 * Handles all technical SEO checks business logic
 * Maintains EXACT same behavior as original controller
 */
export class TechnicalChecksService {
  
  /**
   * Get comprehensive technical checks for all pages
   * Extracted from getTechnicalChecks controller function
   */
  static async getTechnicalChecks(project) {
    // Add null checks to prevent crashes
    if (!project || !project._id) {
      throw new Error('Project ID is required');
    }
    
    const projectId = project._id.toString();
    const userId = project.user_id ? project.user_id.toString() : 'unknown';
    
    LoggerUtil.info('Technical Checks API called', { projectId, userId });

    const db = mongoose.connection.db;
    const { ObjectId } = mongoose.Types;
    const projectIdObj = new ObjectId(projectId);

    // Run domain and page checks in parallel for performance
    const [domainReport, pageAggregations] = await Promise.all([
      // Domain-level checks
      db.collection('domain_technical_reports').findOne({ projectId: projectIdObj }),
      // Page-level aggregations
      this.getPageLevelAggregations(db, projectIdObj)
    ]);

    // Generate all 12 technical checks
    const checks = [];

    // 1. SSL Certificate Check (Domain-level)
    checks.push(this.getSSLCertificateCheck(domainReport));

    // 2. Security Headers Check (Page-level)
    checks.push(this.getSecurityHeadersCheck(pageAggregations));

    // 3. Canonical Tags Check (Page-level)
    checks.push(this.getCanonicalTagsCheck(pageAggregations));

    // 4. Robots.txt Check (Domain-level)
    checks.push(this.getRobotsTxtCheck(domainReport));

    // 5. Noindex on Key Pages Check (Page-level)
    checks.push(this.getNoindexCheck(pageAggregations));

    // 6. H1 Tags Check (Page-level)
    checks.push(this.getH1TagsCheck(pageAggregations));

    // 7. Structured Data Check (Page-level)
    checks.push(this.getStructuredDataCheck(pageAggregations));

    // 8. Mobile Friendliness Check (Page-level)
    checks.push(this.getMobileFriendlinessCheck(pageAggregations));

    // 9. XML Sitemap Check (Domain-level)
    checks.push(this.getXMLSitemapCheck(domainReport));

    // 10. OG/Social Tags Check (Page-level)
    checks.push(this.getSocialTagsCheck(pageAggregations));

    // Generate summary with healthScore calculation
    const total = checks.length;
    const passed = checks.filter(check => check.status === 'OK').length;
    const warnings = checks.filter(check => check.status === 'Warning').length;
    const critical = checks.filter(check => check.status === 'Critical').length;
    
    // Calculate healthScore using same logic as frontend
    const healthScore = total > 0 ? Math.round((passed / total) * 100) : 0;
    
    const summary = {
      total,
      passed,
      passing: passed, // Backward compatibility for StatusBreakdown component
      warnings,
      critical,
      healthScore
    };

    LoggerUtil.info('Technical checks summary with healthScore', summary);

    // Return EXACT same response structure as controller
    return {
      success: true,
      data: {
        checks,
        summary
      }
    };
  }

  /**
   * Get detailed information for a specific technical check
   * Extracted from getTechnicalCheckDetail controller function
   */
  static async getTechnicalCheckDetail(project, checkId) {
    // Add null checks to prevent crashes
    if (!project || !project._id) {
      throw new Error('Project ID is required');
    }
    
    const projectId = project._id.toString();
    const userId = project.user_id ? project.user_id.toString() : 'unknown';
    
    LoggerUtil.info('Technical Check Detail API called', { projectId, checkId, userId });

    const db = mongoose.connection.db;
    const { ObjectId } = mongoose.Types;
    const projectIdObj = new ObjectId(projectId);

    // Get page-level aggregations (same data as summary API)
    const pageAggregations = await this.getPageLevelAggregations(db, projectIdObj);
    
    // Get domain report for domain-level checks
    const domainReport = await db.collection('domain_technical_reports').findOne({ projectId: projectIdObj });

    // Find the specific check and get its affected pages
    let checkDetail = null;
    let affectedPages = [];

    switch (checkId) {
      case 'h1_tags':
        checkDetail = this.getH1TagsCheck(pageAggregations);
        affectedPages = this.getH1AffectedPages(pageAggregations.pageStats);
        break;
      case 'canonical_tags':
        checkDetail = this.getCanonicalTagsCheck(pageAggregations);
        affectedPages = this.getCanonicalAffectedPages(pageAggregations.pageStats);
        break;
      case 'security_headers':
        checkDetail = this.getSecurityHeadersCheck(pageAggregations);
        affectedPages = this.getSecurityHeadersAffectedPages(pageAggregations.pageStats);
        break;
      case 'noindex_key_pages':
      case 'noindex_tags':
        checkDetail = this.getNoindexCheck(pageAggregations);
        affectedPages = this.getNoindexAffectedPages(pageAggregations.pageStats);
        break;
      case 'structured_data':
        checkDetail = this.getStructuredDataCheck(pageAggregations);
        affectedPages = this.getStructuredDataAffectedPages(pageAggregations.pageStats);
        break;
      case 'mobile_friendliness':
        checkDetail = this.getMobileFriendlinessCheck(pageAggregations);
        affectedPages = this.getMobileAffectedPages(pageAggregations.pageStats);
        break;
      case 'social_tags':
      case 'og_social_tags':
        checkDetail = this.getSocialTagsCheck(pageAggregations);
        affectedPages = this.getSocialTagsAffectedPages(pageAggregations.pageStats);
        break;
      case 'ssl_certificate':
        checkDetail = this.getSSLCertificateCheck(domainReport);
        // SSL is domain-level, no specific pages
        break;
      case 'robots_txt':
        checkDetail = this.getRobotsTxtCheck(domainReport);
        // Robots.txt is domain-level, no specific pages
        break;
      case 'xml_sitemap':
        checkDetail = this.getXMLSitemapCheck(domainReport);
        // XML Sitemap is domain-level, no specific pages
        break;
      default:
        throw new NotFoundError('Technical check not found');
    }

    if (!checkDetail) {
      throw new NotFoundError('Technical check not found');
    }

    LoggerUtil.info(`${checkId} detail retrieved`, {
      affectedPagesCount: affectedPages.length,
      checkStatus: checkDetail.status
    });

    // Return EXACT same response structure as controller
    return {
      success: true,
      data: {
        check: checkDetail,
        pages: affectedPages
      }
    };
  }

  // ==========================================
  // Helper function to get page-level aggregations
  // ==========================================
  static async getPageLevelAggregations(db, projectIdObj) {
    const results = {};

    // Aggregate pages by various technical metrics
    const pageStats = await db.collection('seo_page_data').aggregate([
      { $match: { projectId: projectIdObj } },
      {
        $project: {
          url: 1,
          http_status_code: 1,
          canonical: 1,
          meta_tags: 1,
          'content.headings.h1': 1,
          'content.heading_analysis.h1_count': 1,
          structured_data: 1,
          'seo_intelligence.schema_validation.schemas': 1,
          'seo_intelligence.security.security_headers': 1,
          'social.open_graph': 1,
          'social.twitter': 1
        }
      }
    ]).toArray();

    results.totalPages = pageStats.length;
    results.pageStats = pageStats; // Store raw page data for detail queries
    
    // Calculate various metrics
    results.canonicalStats = this.calculateCanonicalStats(pageStats);
    results.noindexStats = this.calculateNoindexStats(pageStats);
    results.h1Stats = this.calculateH1Stats(pageStats);
    results.schemaStats = this.calculateSchemaStats(pageStats);
    results.mobileStats = this.calculateMobileStats(pageStats);
    results.securityHeadersStats = this.calculateSecurityHeadersStats(pageStats);
    results.socialTagsStats = this.calculateSocialTagsStats(pageStats);

    return results;
  }

  // ==========================================
  // Check generation functions
  // ==========================================
  // SSL statuses that indicate an actual, verified certificate/HTTPS problem
  // on the audited site -- these are the only ones that should ever be
  // CRITICAL. Everything else (DNS/timeout/blocked/unknown) means the
  // checker could not verify the certificate on this run, which is not
  // evidence that the site's SSL is broken.
  static SSL_CRITICAL_STATUSES = new Set([
    'EXPIRED_CERTIFICATE',
    'HOSTNAME_MISMATCH',
    'CERTIFICATE_CHAIN_ERROR',
    'INVALID_CERTIFICATE',
    'NO_HTTPS'
  ]);

  static getSSLCertificateCheck(domainReport) {
    // sslStatus is the source of truth (set by the Python ssl_checker -- see
    // scraper/workers/seo/technical_domain/ssl_checker.py). Older reports
    // predating that field only have the sslValid boolean; derive a status
    // from it so they still render correctly.
    const sslStatus = domainReport?.sslStatus || (domainReport?.sslValid ? 'VALID' : 'UNKNOWN');
    const daysRemaining = domainReport?.sslDaysRemaining;
    const storedMessage = domainReport?.sslMessage;

    let status;
    let message;
    let affectedPages = 0;

    if (sslStatus === 'VALID') {
      if (typeof daysRemaining === 'number' && daysRemaining < 30) {
        status = 'Warning';
        message = `SSL certificate expires in ${daysRemaining} days`;
      } else {
        status = 'OK';
        message = storedMessage || 'SSL certificate is valid and properly configured';
      }
    } else if (this.SSL_CRITICAL_STATUSES.has(sslStatus)) {
      status = 'Critical';
      message = storedMessage || 'SSL certificate not found or invalid';
    } else {
      // DNS_ERROR / TIMEOUT / BLOCKED / TLS_CONNECTION_ERROR / UNKNOWN:
      // the last audit run couldn't verify the certificate (network blip,
      // crawler blocked, missing scan yet, etc). Flag it for a retry
      // without accusing the site of having broken SSL.
      status = 'Warning';
      message = storedMessage || 'Unable to verify SSL certificate on the last scan — will retry';
    }

    // For domain-level checks, impact is based on status severity
    let impact_percentage = 0;
    if (status === 'Critical') {
      impact_percentage = 100; // SSL issues affect entire site
    } else if (status === 'Warning') {
      impact_percentage = 50; // Warning level impact
    }

    // Difficulty: single shared resolver (issueMetadata.js) — previously an
    // identical if/else was hand-duplicated in every one of this file's 10
    // check functions.
    const difficulty = resolveIssueDifficulty({ severity: status === 'Critical' ? 'high' : status === 'Warning' ? 'medium' : 'none' });

    return {
      id: 'ssl_certificate',
      name: 'SSL Certificate',
      status,
      severity: status === 'Critical' ? 'high' : status === 'Warning' ? 'medium' : 'none',
      affected_pages: affectedPages,
      impact_percentage,
      // Domain-level check: there's no "% of pages affected" here (SSL is a
      // whole-site property), so impact_percentage is a fixed severity-tier
      // weight (100/50/0), not a computed ratio. Flagged explicitly so the
      // frontend never captions it as "% of pages affected" the way the
      // page-level checks below correctly can.
      impact_basis: 'severity_tier',
      difficulty,
      message,
      sslStatus
    };
  }

  static getSecurityHeadersCheck(pageAggregations) {
    const stats = pageAggregations.securityHeadersStats;
    
    let status = 'OK';
    let message = 'Security headers properly configured';
    
    if (stats.pagesWithMissingHeaders > 0) {
      if (stats.pagesWithMissingHeaders / pageAggregations.totalPages > 0.5) {
        status = 'Critical';
        message = `${stats.pagesWithMissingHeaders} pages missing critical security headers`;
      } else {
        status = 'Warning';
        message = `${stats.pagesWithMissingHeaders} pages have missing security headers`;
      }
    }

    // Calculate dynamic impact percentage (same as on-page issues)
    const impact_percentage = pageAggregations.totalPages > 0
      ? Math.round(((stats.pagesWithMissingHeaders / pageAggregations.totalPages) * 100) * 10) / 10
      : 0;

    // Difficulty: single shared resolver (issueMetadata.js) — previously an
    // identical if/else was hand-duplicated in every one of this file's 10
    // check functions.
    const difficulty = resolveIssueDifficulty({ severity: status === 'Critical' ? 'high' : status === 'Warning' ? 'medium' : 'none' });

    return {
      id: 'security_headers',
      name: 'Security Headers',
      status,
      severity: status === 'Critical' ? 'high' : status === 'Warning' ? 'medium' : 'none',
      affected_pages: stats.pagesWithMissingHeaders,
      impact_percentage,
      // Page-level check: impact_percentage is a real computed ratio
      // (affected pages / total pages analyzed), safe to caption as
      // "% of pages affected" — unlike the domain-level checks above.
      impact_basis: 'pages_affected_ratio',
      difficulty,
      message
    };
  }

  static getCanonicalTagsCheck(pageAggregations) {
    const stats = pageAggregations.canonicalStats;
    
    let status = 'OK';
    let message = 'Canonical tags properly configured';
    
    if (stats.pagesWithoutCanonical > 0) {
      if (stats.pagesWithoutCanonical / pageAggregations.totalPages > 0.3) {
        status = 'Critical';
        message = `${stats.pagesWithoutCanonical} pages missing canonical tags`;
      } else {
        status = 'Warning';
        message = `${stats.pagesWithoutCanonical} pages missing canonical tags`;
      }
    }

    // Calculate dynamic impact percentage
    const impact_percentage = pageAggregations.totalPages > 0
      ? Math.round(((stats.pagesWithoutCanonical / pageAggregations.totalPages) * 100) * 10) / 10
      : 0;

    // Difficulty: single shared resolver (issueMetadata.js) — previously an
    // identical if/else was hand-duplicated in every one of this file's 10
    // check functions.
    const difficulty = resolveIssueDifficulty({ severity: status === 'Critical' ? 'high' : status === 'Warning' ? 'medium' : 'none' });

    return {
      id: 'canonical_tags',
      name: 'Canonical Tags',
      status,
      severity: status === 'Critical' ? 'high' : status === 'Warning' ? 'medium' : 'none',
      affected_pages: stats.pagesWithoutCanonical,
      impact_percentage,
      // Page-level check: impact_percentage is a real computed ratio
      // (affected pages / total pages analyzed), safe to caption as
      // "% of pages affected" — unlike the domain-level checks above.
      impact_basis: 'pages_affected_ratio',
      difficulty,
      message
    };
  }

  static getRobotsTxtCheck(domainReport) {
    const exists = domainReport?.robotsExists;
    const status = domainReport?.robotsStatus;

    let checkStatus = 'Critical';
    let message = 'Robots.txt file not found';
    let affectedPages = 0;

    if (exists) {
      if (status === 200) {
        checkStatus = 'OK';
        message = 'Robots.txt is accessible and properly configured';
      } else {
        checkStatus = 'Warning';
        message = `Robots.txt returns status ${status}`;
      }
    }

    // For domain-level checks, impact is based on status severity
    let impact_percentage = 0;
    if (checkStatus === 'Critical') {
      impact_percentage = 100; // Missing robots.txt affects entire site
    } else if (checkStatus === 'Warning') {
      impact_percentage = 30; // Access issues have moderate impact
    }

    // Difficulty: single shared resolver (issueMetadata.js) — previously an
    // identical if/else was hand-duplicated in every one of this file's 10
    // check functions.
    const difficulty = resolveIssueDifficulty({ severity: checkStatus === 'Critical' ? 'high' : checkStatus === 'Warning' ? 'medium' : 'none' });

    return {
      id: 'robots_txt',
      name: 'Robots.txt',
      status: checkStatus,
      severity: checkStatus === 'Critical' ? 'high' : checkStatus === 'Warning' ? 'medium' : 'none',
      affected_pages: affectedPages,
      impact_percentage,
      // Domain-level check — see the identical note on ssl_certificate above.
      impact_basis: 'severity_tier',
      difficulty,
      message
    };
  }

  static getNoindexCheck(pageAggregations) {
    const stats = pageAggregations.noindexStats;
    
    let status = 'OK';
    let message = 'All important pages are indexable';
    
    if (stats.noindexPages > 0) {
      if (stats.noindexPages / pageAggregations.totalPages > 0.2) {
        status = 'Critical';
        message = `${stats.noindexPages} pages have noindex directive`;
      } else {
        status = 'Warning';
        message = `${stats.noindexPages} pages have noindex directive`;
      }
    }

    // Calculate dynamic impact percentage
    const impact_percentage = pageAggregations.totalPages > 0
      ? Math.round(((stats.noindexPages / pageAggregations.totalPages) * 100) * 10) / 10
      : 0;

    // Difficulty: single shared resolver (issueMetadata.js) — previously an
    // identical if/else was hand-duplicated in every one of this file's 10
    // check functions.
    const difficulty = resolveIssueDifficulty({ severity: status === 'Critical' ? 'high' : status === 'Warning' ? 'medium' : 'none' });

    return {
      id: 'noindex_tags',
      name: 'Noindex on Key Pages',
      status,
      severity: status === 'Critical' ? 'high' : status === 'Warning' ? 'medium' : 'none',
      affected_pages: stats.noindexPages,
      impact_percentage,
      // Page-level check: impact_percentage is a real computed ratio
      // (affected pages / total pages analyzed), safe to caption as
      // "% of pages affected" — unlike the domain-level checks above.
      impact_basis: 'pages_affected_ratio',
      difficulty,
      message
    };
  }

  static getH1TagsCheck(pageAggregations) {
    const stats = pageAggregations.h1Stats;
    
    let status = 'OK';
    let message = 'H1 tags properly configured';
    let affectedPages = stats.pagesWithoutH1 + stats.pagesWithMultipleH1;
    
    if (affectedPages > 0) {
      if (affectedPages / pageAggregations.totalPages > 0.3) {
        status = 'Critical';
        message = `${stats.pagesWithoutH1} pages missing H1, ${stats.pagesWithMultipleH1} with multiple H1s`;
      } else {
        status = 'Warning';
        message = `${stats.pagesWithoutH1} pages missing H1, ${stats.pagesWithMultipleH1} with multiple H1s`;
      }
    }

    // Calculate dynamic impact percentage
    const impact_percentage = pageAggregations.totalPages > 0
      ? Math.round(((affectedPages / pageAggregations.totalPages) * 100) * 10) / 10
      : 0;

    // Difficulty: single shared resolver (issueMetadata.js) — previously an
    // identical if/else was hand-duplicated in every one of this file's 10
    // check functions.
    const difficulty = resolveIssueDifficulty({ severity: status === 'Critical' ? 'high' : status === 'Warning' ? 'medium' : 'none' });

    return {
      id: 'h1_tags',
      name: 'H1 Tags',
      status,
      severity: status === 'Critical' ? 'high' : status === 'Warning' ? 'medium' : 'none',
      affected_pages: affectedPages,
      impact_percentage,
      // Page-level check: impact_percentage is a real computed ratio
      // (affected pages / total pages analyzed), safe to caption as
      // "% of pages affected" — unlike the domain-level checks above.
      impact_basis: 'pages_affected_ratio',
      difficulty,
      message
    };
  }

  static getStructuredDataCheck(pageAggregations) {
    const stats = pageAggregations.schemaStats;
    
    let status = 'Critical';
    let message = 'No structured data found';
    let affectedPages = pageAggregations.totalPages - stats.pagesWithValidSchema;
    
    if (stats.pagesWithSchema > 0) {
      if (stats.pagesWithSchema / pageAggregations.totalPages > 0.7) {
        status = 'OK';
        message = `${stats.pagesWithValidSchema} pages with valid structured data`;
        affectedPages = 0;
      } else {
        status = 'Warning';
        message = `${stats.pagesWithSchema} pages have structured data (${stats.pagesWithValidSchema} valid)`;
        affectedPages = pageAggregations.totalPages - stats.pagesWithValidSchema;
      }
    }

    // Calculate dynamic impact percentage
    const impact_percentage = pageAggregations.totalPages > 0
      ? Math.round(((affectedPages / pageAggregations.totalPages) * 100) * 10) / 10
      : 0;

    // Difficulty: single shared resolver (issueMetadata.js) — previously an
    // identical if/else was hand-duplicated in every one of this file's 10
    // check functions.
    const difficulty = resolveIssueDifficulty({ severity: status === 'Critical' ? 'high' : status === 'Warning' ? 'medium' : 'none' });

    return {
      id: 'structured_data',
      name: 'Structured Data / Schema',
      status,
      severity: status === 'Critical' ? 'high' : status === 'Warning' ? 'medium' : 'none',
      affected_pages: affectedPages,
      impact_percentage,
      // Page-level check: impact_percentage is a real computed ratio
      // (affected pages / total pages analyzed), safe to caption as
      // "% of pages affected" — unlike the domain-level checks above.
      impact_basis: 'pages_affected_ratio',
      difficulty,
      message
    };
  }

  static getMobileFriendlinessCheck(pageAggregations) {
    const stats = pageAggregations.mobileStats;
    
    let status = 'OK';
    let message = 'Mobile-friendly configuration detected';
    
    if (stats.pagesWithoutViewport > 0) {
      if (stats.pagesWithoutViewport / pageAggregations.totalPages > 0.5) {
        status = 'Critical';
        message = `${stats.pagesWithoutViewport} pages missing viewport meta tag`;
      } else {
        status = 'Warning';
        message = `${stats.pagesWithoutViewport} pages missing viewport meta tag`;
      }
    }

    // Calculate dynamic impact percentage
    const impact_percentage = pageAggregations.totalPages > 0
      ? Math.round(((stats.pagesWithoutViewport / pageAggregations.totalPages) * 100) * 10) / 10
      : 0;

    // Difficulty: single shared resolver (issueMetadata.js) — previously an
    // identical if/else was hand-duplicated in every one of this file's 10
    // check functions.
    const difficulty = resolveIssueDifficulty({ severity: status === 'Critical' ? 'high' : status === 'Warning' ? 'medium' : 'none' });

    return {
      id: 'mobile_friendliness',
      name: 'Mobile Friendliness',
      status,
      severity: status === 'Critical' ? 'high' : status === 'Warning' ? 'medium' : 'none',
      affected_pages: stats.pagesWithoutViewport,
      impact_percentage,
      // Page-level check: impact_percentage is a real computed ratio
      // (affected pages / total pages analyzed), safe to caption as
      // "% of pages affected" — unlike the domain-level checks above.
      impact_basis: 'pages_affected_ratio',
      difficulty,
      message
    };
  }

  static getXMLSitemapCheck(domainReport) {
    const exists = domainReport?.sitemapExists;
    const status = domainReport?.sitemapStatus;
    const urlCount = domainReport?.parsedSitemapUrlCount || 0;

    let checkStatus = 'Critical';
    let message = 'XML sitemap not found';
    let affectedPages = 0;

    if (exists) {
      if (status === 200) {
        checkStatus = 'OK';
        message = `XML sitemap accessible with ${urlCount} URLs`;
      } else {
        checkStatus = 'Warning';
        message = `XML sitemap returns status ${status}`;
      }
    }

    // For domain-level checks, impact is based on status severity
    let impact_percentage = 0;
    if (checkStatus === 'Critical') {
      impact_percentage = 100; // Missing sitemap affects entire site
    } else if (checkStatus === 'Warning') {
      impact_percentage = 40; // Access issues have moderate impact
    }

    // Difficulty: single shared resolver (issueMetadata.js) — previously an
    // identical if/else was hand-duplicated in every one of this file's 10
    // check functions.
    const difficulty = resolveIssueDifficulty({ severity: checkStatus === 'Critical' ? 'high' : checkStatus === 'Warning' ? 'medium' : 'none' });

    return {
      id: 'xml_sitemap',
      name: 'XML Sitemap',
      status: checkStatus,
      severity: checkStatus === 'Critical' ? 'high' : checkStatus === 'Warning' ? 'medium' : 'none',
      affected_pages: affectedPages,
      impact_percentage,
      // Domain-level check — see the identical note on ssl_certificate above.
      impact_basis: 'severity_tier',
      difficulty,
      message
    };
  }

  static getSocialTagsCheck(pageAggregations) {
    const stats = pageAggregations.socialTagsStats;
    
    let status = 'OK';
    let message = 'Social media tags properly configured';
    
    if (stats.pagesMissingOGTags > 0) {
      if (stats.pagesMissingOGTags / pageAggregations.totalPages > 0.5) {
        status = 'Critical';
        message = `${stats.pagesMissingOGTags} pages missing Open Graph tags`;
      } else {
        status = 'Warning';
        message = `${stats.pagesMissingOGTags} pages missing Open Graph tags`;
      }
    }

    // Calculate dynamic impact percentage
    const impact_percentage = pageAggregations.totalPages > 0
      ? Math.round(((stats.pagesMissingOGTags / pageAggregations.totalPages) * 100) * 10) / 10
      : 0;

    // Difficulty: single shared resolver (issueMetadata.js) — previously an
    // identical if/else was hand-duplicated in every one of this file's 10
    // check functions.
    const difficulty = resolveIssueDifficulty({ severity: status === 'Critical' ? 'high' : status === 'Warning' ? 'medium' : 'none' });

    return {
      id: 'og_social_tags',
      name: 'OG / Social Tags',
      status,
      severity: status === 'Critical' ? 'high' : status === 'Warning' ? 'medium' : 'none',
      affected_pages: stats.pagesMissingOGTags,
      impact_percentage,
      // Page-level check: impact_percentage is a real computed ratio
      // (affected pages / total pages analyzed), safe to caption as
      // "% of pages affected" — unlike the domain-level checks above.
      impact_basis: 'pages_affected_ratio',
      difficulty,
      message
    };
  }

  // ==========================================
  // Statistics calculation functions
  // ==========================================
  static calculateCanonicalStats(pages) {
    const pagesWithoutCanonical = pages.filter(page => !page.canonical).length;
    return { pagesWithoutCanonical };
  }

  static calculateNoindexStats(pages) {
    const noindexPages = pages.filter(page => {
      const robots = page.meta_tags?.robots || [];
      return robots.some(tag => tag.toLowerCase().includes('noindex'));
    }).length;
    return { noindexPages };
  }

  static calculateH1Stats(pages) {
    const pagesWithoutH1 = pages.filter(page => {
      const h1s = page.content?.headings?.h1 || [];
      const h1Count = page.content?.heading_analysis?.h1_count;
      if (h1Count !== undefined) {
        return h1Count === 0;
      }
      return h1s.length === 0;
    }).length;
    
    const pagesWithMultipleH1 = pages.filter(page => {
      const h1s = page.content?.headings?.h1 || [];
      const h1Count = page.content?.heading_analysis?.h1_count;
      if (h1Count !== undefined) {
        return h1Count > 1;
      }
      return h1s.length > 1;
    }).length;
    
    return { pagesWithoutH1, pagesWithMultipleH1 };
  }

  static calculateSchemaStats(pages) {
    const pagesWithSchema = pages.filter(page => {
      const schemas = page.seo_intelligence?.schema_validation?.schemas || [];
      return schemas.length > 0;
    }).length;
    
    const pagesWithValidSchema = pages.filter(page => {
      const schemas = page.seo_intelligence?.schema_validation?.schemas || [];
      return schemas.some(schema => schema.is_valid);
    }).length;
    
    return { pagesWithSchema, pagesWithValidSchema };
  }

  static calculateMobileStats(pages) {
    const pagesWithoutViewport = pages.filter(page => {
      const viewport = page.meta_tags?.viewport || [];
      return viewport.length === 0;
    }).length;
    
    return { pagesWithoutViewport };
  }

  static calculateSecurityHeadersStats(pages) {
    const requiredHeaders = ['csp', 'hsts', 'x_frame_options', 'x_content_type_options'];
    
    const pagesWithMissingHeaders = pages.filter(page => {
      const headers = page.seo_intelligence?.security?.security_headers || {};
      return requiredHeaders.some(header => !headers[header]);
    }).length;
    
    return { pagesWithMissingHeaders };
  }

  static calculateSocialTagsStats(pages) {
    const requiredOGTags = ['og:title', 'og:description', 'og:image', 'og:url'];
    
    const pagesMissingOGTags = pages.filter(page => {
      // Check meta_tags for OG tags (primary source where scraper stores them)
      const metaTags = page.meta_tags || {};
      const ogTags = {};
      
      // Extract OG tags from meta_tags with correct prefix
      Object.keys(metaTags).forEach(key => {
        if (key.startsWith('og:')) {
          const values = metaTags[key];
          if (Array.isArray(values) && values.length > 0) {
            ogTags[key] = values[0]; // Take first value
          } else if (values) {
            ogTags[key] = values;
          }
        }
      });
      
      // Fallback to social.open_graph if meta_tags empty (for backward compatibility)
      const fallbackOgTags = page.social?.open_graph || {};
      const finalOgTags = Object.keys(ogTags).length > 0 ? ogTags : fallbackOgTags;
      
      return requiredOGTags.some(tag => !finalOgTags[tag]);
    }).length;
    
    return { pagesMissingOGTags };
  }

  // ==========================================
  // Helper functions to get affected pages
  // ==========================================
  static getH1AffectedPages(pageStats) {
    return pageStats.filter(page => {
      const h1s = page.content?.headings?.h1 || [];
      const h1Count = page.content?.heading_analysis?.h1_count;
      if (h1Count !== undefined) {
        return h1Count === 0 || h1Count > 1;
      }
      return h1s.length === 0 || h1s.length > 1;
    }).map(page => {
      const h1s = page.content?.headings?.h1 || [];
      const h1Count = page.content?.heading_analysis?.h1_count;
      const actualCount = h1Count !== undefined ? h1Count : h1s.length;
      
      let issue = 'Missing H1';
      if (actualCount === 0) {
        issue = 'Missing H1';
      } else if (actualCount > 1) {
        issue = `Multiple H1 tags (${actualCount} found)`;
      }
      
      return {
        url: page.url,
        issue: issue,
        h1_count: actualCount,
        h1_tags: h1s
      };
    });
  }

  static getCanonicalAffectedPages(pageStats) {
    return pageStats.filter(page => {
      const canonical = page.canonical;
      return !canonical || canonical.length === 0;
    }).map(page => ({
      url: page.url,
      issue: 'Missing canonical tag',
      canonical: page.canonical
    }));
  }

  static getSecurityHeadersAffectedPages(pageStats) {
    const requiredHeaders = ['csp', 'hsts', 'x_frame_options', 'x_content_type_options'];
    
    return pageStats.filter(page => {
      const headers = page.seo_intelligence?.security?.security_headers || {};
      return requiredHeaders.some(header => !headers[header]);
    }).map(page => {
      const headers = page.seo_intelligence?.security?.security_headers || {};
      const missingHeaders = requiredHeaders.filter(header => !headers[header]);
      
      return {
        url: page.url,
        issue: `Missing security headers: ${missingHeaders.join(', ')}`,
        missing_headers: missingHeaders,
        present_headers: Object.keys(headers)
      };
    });
  }

  static getNoindexAffectedPages(pageStats) {
    return pageStats.filter(page => {
      const robots = page.meta_tags?.robots || [];
      return robots.some(tag => tag.toLowerCase().includes('noindex'));
    }).map(page => ({
      url: page.url,
      issue: 'Page has noindex directive',
      robots_tags: page.meta_tags?.robots || []
    }));
  }

  static getStructuredDataAffectedPages(pageStats) {
    return pageStats.filter(page => {
      const schemas = page.seo_intelligence?.schema_validation?.schemas || [];
      return schemas.length === 0 || !schemas.some(schema => schema.is_valid);
    }).map(page => {
      const schemas = page.seo_intelligence?.schema_validation?.schemas || [];
      const validSchemas = schemas.filter(schema => schema.is_valid);
      
      return {
        url: page.url,
        issue: schemas.length === 0 ? 'Missing structured data' : 'Invalid structured data',
        schema_count: schemas.length,
        valid_schemas: validSchemas.length,
        schemas: schemas
      };
    });
  }

  static getMobileAffectedPages(pageStats) {
    return pageStats.filter(page => {
      const viewport = page.meta_tags?.viewport || [];
      return viewport.length === 0;
    }).map(page => ({
      url: page.url,
      issue: 'Missing viewport meta tag',
      viewport: page.meta_tags?.viewport || []
    }));
  }

  static getSocialTagsAffectedPages(pageStats) {
    const requiredOGTags = ['og:title', 'og:description', 'og:image', 'og:url'];
    
    return pageStats.filter(page => {
      const ogTags = page.social?.open_graph || {};
      return requiredOGTags.some(tag => !ogTags[tag]);
    }).map(page => {
      const ogTags = page.social?.open_graph || {};
      const missingTags = requiredOGTags.filter(tag => !ogTags[tag]);
      
      return {
        url: page.url,
        issue: `Missing OG tags: ${missingTags.join(', ')}`,
        missing_tags: missingTags,
        present_tags: Object.keys(ogTags)
      };
    });
  }
}
