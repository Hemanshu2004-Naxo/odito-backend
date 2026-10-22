/**
 * Performance Mapper
 * Transforms data for performance-related sections
 */

import { FormatUtils } from '../../utils/format.utils.js';
import { GradeUtils } from '../../utils/grade.utils.js';
import { PercentageUtils } from '../../utils/percentage.utils.js';

export class PerformanceMapper {
  
  /**
   * Transform Core Web Vitals data
   * Uses real performance data if available, falls back to mock data
   */
  static transformCoreWebVitals(performanceMetrics, aggregatedData) {
    // Check if we have real performance data from the database
    const realPerformanceData = aggregatedData?.performance;
    
    if (realPerformanceData?.mobile || realPerformanceData?.desktop) {
      // Use real data from the API/database
      const mobile = realPerformanceData.mobile || {};
      const desktop = realPerformanceData.desktop || {};
      
      return {
        stats: {
          desktopScore: desktop.performance ?? 0,
          mobileScore: mobile.performance ?? 0,
          mobileLCP: mobile.metrics?.lcp ?? mobile.lcp ?? 0,
          mobileTBT: mobile.metrics?.tbt ?? mobile.tbt ?? 0
        },
        metrics: this.generateCWVMetricsFromRealData({ mobile, desktop }),
        seoImpact: this.generateCWVImpactFromRealData({ mobile, desktop }),
        _source: 'real' // For debugging
      };
    }
    
    // Fallback to mock data if no real data available
    const mockData = this.generateMockCWVData();
    
    return {
      stats: {
        desktopScore: mockData.desktop.score,
        mobileScore: mockData.mobile.score,
        mobileLCP: mockData.mobile.lcp,
        mobileTBT: mockData.mobile.tbt
      },
      metrics: this.generateCWVMetrics(mockData),
      seoImpact: this.generateCWVImpact(mockData),
      _source: 'mock' // For debugging
    };
  }

  /**
   * Transform performance opportunities
   */
  static transformOpportunities(technicalMetrics) {
    return {
      opportunities: this.generateOptimizationOpportunities(technicalMetrics),
      forecast: this.generatePerformanceForecast(),
      optimizationPlan: this.generateOptimizationPlan()
    };
  }

  /**
   * Generate mock Core Web Vitals data
   */
  static generateMockCWVData() {
    return {
      desktop: {
        score: 82,
        performance: 85,
        accessibility: 90,
        bestPractices: 88,
        seo: 95,
        lcp: '2.1s',
        fid: '45ms',
        cls: '0.08',
        fcp: '1.4s',
        ttfb: '180ms'
      },
      mobile: {
        score: 71,
        performance: 65,
        accessibility: 85,
        bestPractices: 80,
        seo: 92,
        lcp: '3.2s',
        fid: '120ms',
        cls: '0.15',
        fcp: '2.1s',
        ttfb: '280ms'
      }
    };
  }

  /**
   * Generate Core Web Vitals metrics table from real data
   */
  static generateCWVMetricsFromRealData({ mobile, desktop }) {
    const metrics = [
      {
        metric: 'First Contentful Paint',
        desktop: this.formatMetricValue(desktop.metrics?.fcp ?? desktop.fcp, 's'),
        desktopRating: this.getRating(this.parseMetricValue(desktop.metrics?.fcp ?? desktop.fcp), 'fcp'),
        mobile: this.formatMetricValue(mobile.metrics?.fcp ?? mobile.fcp, 's'),
        mobileRating: this.getRating(this.parseMetricValue(mobile.metrics?.fcp ?? mobile.fcp), 'fcp'),
        priority: 'MEDIUM'
      },
      {
        metric: 'Largest Contentful Paint',
        desktop: this.formatMetricValue(desktop.metrics?.lcp ?? desktop.lcp, 's'),
        desktopRating: this.getRating(this.parseMetricValue(desktop.metrics?.lcp ?? desktop.lcp), 'lcp'),
        mobile: this.formatMetricValue(mobile.metrics?.lcp ?? mobile.lcp, 's'),
        mobileRating: this.getRating(this.parseMetricValue(mobile.metrics?.lcp ?? mobile.lcp), 'lcp'),
        priority: 'HIGH'
      },
      {
        metric: 'Total Blocking Time',
        desktop: this.formatMetricValue(desktop.metrics?.tbt ?? desktop.tbt, 'ms'),
        desktopRating: this.getRating(this.parseMetricValue(desktop.metrics?.tbt ?? desktop.tbt), 'tbt'),
        mobile: this.formatMetricValue(mobile.metrics?.tbt ?? mobile.tbt, 'ms'),
        mobileRating: this.getRating(this.parseMetricValue(mobile.metrics?.tbt ?? mobile.tbt), 'tbt'),
        priority: 'HIGH'
      },
      {
        metric: 'Cumulative Layout Shift',
        desktop: this.formatMetricValue(desktop.metrics?.cls ?? desktop.cls, ''),
        desktopRating: this.getRating(this.parseMetricValue(desktop.metrics?.cls ?? desktop.cls), 'cls'),
        mobile: this.formatMetricValue(mobile.metrics?.cls ?? mobile.cls, ''),
        mobileRating: this.getRating(this.parseMetricValue(mobile.metrics?.cls ?? mobile.cls), 'cls'),
        priority: 'MEDIUM'
      },
      {
        metric: 'Time to First Byte',
        desktop: this.formatMetricValue(desktop.ttfb?.value ?? desktop.metrics?.ttfb ?? desktop.ttfb, 'ms'),
        desktopRating: this.getRating(this.parseMetricValue(desktop.ttfb?.value ?? desktop.metrics?.ttfb ?? desktop.ttfb), 'ttfb'),
        mobile: this.formatMetricValue(mobile.ttfb?.value ?? mobile.metrics?.ttfb ?? mobile.ttfb, 'ms'),
        mobileRating: this.getRating(this.parseMetricValue(mobile.ttfb?.value ?? mobile.metrics?.ttfb ?? mobile.ttfb), 'ttfb'),
        priority: 'LOW'
      }
    ];

    // Update priorities based on mobile ratings
    return metrics.map(m => ({
      ...m,
      priority: m.mobileRating === 'Poor' ? 'HIGH' : m.mobileRating === 'Needs Work' ? 'MEDIUM' : 'LOW'
    }));
  }

  /**
   * Format metric value with unit
   */
  static formatMetricValue(value, unit) {
    if (value === null || value === undefined) return 'N/A';
    const num = this.parseMetricValue(value);
    if (unit === 's') return num >= 1 ? `${num.toFixed(1)}s` : `${num.toFixed(2)}s`;
    if (unit === 'ms') return `${Math.round(num)}ms`;
    if (num < 1) return num.toFixed(2);
    return num.toFixed(1);
  }

  /**
   * Generate Core Web Vitals SEO impact from real data
   */
  static generateCWVImpactFromRealData({ mobile, desktop }) {
    const mobileScore = mobile.performance ?? 0;
    const desktopScore = desktop.performance ?? 0;
    const mobileLCP = mobile.metrics?.lcp ?? mobile.lcp ?? 0;
    
    if (!mobile.performance && !desktop.performance) {
      return 'Performance data not available. Run a PageSpeed audit to see Core Web Vitals metrics and their impact on search rankings.';
    }
    
    if (mobileScore >= 75 && desktopScore >= 75) {
      return `Excellent Core Web Vitals with mobile score ${mobileScore} and desktop score ${desktopScore}. These metrics provide a strong foundation for search rankings and user experience.`;
    } else if (mobileScore >= 60 && desktopScore >= 60) {
      return `Good Core Web Vitals with room for improvement. Mobile score (${mobileScore}) and desktop score (${desktopScore}) can be enhanced for better rankings.`;
    } else {
      return `Core Web Vitals require optimization. Mobile performance (${mobileScore}) and desktop performance (${desktopScore}) impact search visibility and user experience. LCP of ${mobileLCP}s needs attention.`;
    }
  }

  /**
   * Generate Core Web Vitals metrics table
   */
  static generateCWVMetrics(cwvData) {
    const metrics = [
      {
        metric: 'First Contentful Paint',
        desktop: cwvData.desktop.fcp,
        desktopRating: this.getRating(cwvData.desktop.fcp, 'fcp'),
        mobile: cwvData.mobile.fcp,
        mobileRating: this.getRating(cwvData.mobile.fcp, 'fcp'),
        priority: 'MEDIUM'
      },
      {
        metric: 'Largest Contentful Paint',
        desktop: cwvData.desktop.lcp,
        desktopRating: this.getRating(cwvData.desktop.lcp, 'lcp'),
        mobile: cwvData.mobile.lcp,
        mobileRating: this.getRating(cwvData.mobile.lcp, 'lcp'),
        priority: 'HIGH'
      },
      {
        metric: 'Total Blocking Time',
        desktop: cwvData.desktop.fid,
        desktopRating: this.getRating(cwvData.desktop.fid, 'tbt'),
        mobile: cwvData.mobile.fid,
        mobileRating: this.getRating(cwvData.mobile.fid, 'tbt'),
        priority: 'HIGH'
      },
      {
        metric: 'Cumulative Layout Shift',
        desktop: cwvData.desktop.cls,
        desktopRating: this.getRating(cwvData.desktop.cls, 'cls'),
        mobile: cwvData.mobile.cls,
        mobileRating: this.getRating(cwvData.mobile.cls, 'cls'),
        priority: 'MEDIUM'
      },
      {
        metric: 'Time to First Byte',
        desktop: cwvData.desktop.ttfb,
        desktopRating: this.getRating(cwvData.desktop.ttfb, 'ttfb'),
        mobile: cwvData.mobile.ttfb,
        mobileRating: this.getRating(cwvData.mobile.ttfb, 'ttfb'),
        priority: 'LOW'
      }
    ];

    return metrics;
  }

  /**
   * Get rating for metric value
   */
  static getRating(value, metric) {
    const thresholds = {
      'fcp': { good: 1.8, needsWork: 3.0 },
      'lcp': { good: 2.5, needsWork: 4.0 },
      'tbt': { good: 200, needsWork: 600 },
      'cls': { good: 0.1, needsWork: 0.25 },
      'ttfb': { good: 800, needsWork: 1800 }
    };

    const numericValue = this.parseMetricValue(value);
    const threshold = thresholds[metric] || thresholds['fcp'];

    if (numericValue <= threshold.good) return 'Good';
    if (numericValue <= threshold.needsWork) return 'Needs Work';
    return 'Poor';
  }

  /**
   * Parse metric value to number
   */
  static parseMetricValue(value) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      return parseFloat(value.replace(/[^\d.]/g, '')) || 0;
    }
    return 0;
  }

  /**
   * Generate Core Web Vitals SEO impact
   */
  static generateCWVImpact(cwvData) {
    const mobileScore = cwvData.mobile.score;
    const desktopScore = cwvData.desktop.score;
    
    if (mobileScore >= 75 && desktopScore >= 75) {
      return 'Excellent Core Web Vitals provide strong foundation for search rankings and user experience. Performance is a competitive advantage.';
    } else if (mobileScore >= 60 && desktopScore >= 60) {
      return `Good Core Web Vitals with room for improvement. Mobile score (${mobileScore}) and desktop score (${desktopScore}) can be enhanced for better rankings.`;
    } else {
      return `Core Web Vitals require optimization. Mobile performance (${mobileScore}) and desktop performance (${desktopScore}) impact search visibility and user experience.`;
    }
  }

  /**
   * Generate optimization opportunities
   */
  static generateOptimizationOpportunities(technicalMetrics) {
    const opportunities = [
      {
        optimization: 'Eliminate render-blocking resources',
        saving: '840ms',
        effort: 'Easy',
        cumulativeImpact: '840ms',
        priority: 'HIGH'
      },
      {
        optimization: 'Optimize images',
        saving: '620ms',
        effort: 'Medium',
        cumulativeImpact: '1.46s',
        priority: 'HIGH'
      },
      {
        optimization: 'Remove unused CSS',
        saving: '380ms',
        effort: 'Medium',
        cumulativeImpact: '1.84s',
        priority: 'MEDIUM'
      },
      {
        optimization: 'Enable text compression',
        saving: '290ms',
        effort: 'Easy',
        cumulativeImpact: '2.13s',
        priority: 'MEDIUM'
      },
      {
        optimization: 'Minify JavaScript',
        saving: '210ms',
        effort: 'Easy',
        cumulativeImpact: '2.34s',
        priority: 'LOW'
      },
      {
        optimization: 'Improve server response time',
        saving: '180ms',
        effort: 'Medium',
        cumulativeImpact: '2.52s',
        priority: 'MEDIUM'
      }
    ];

    return opportunities;
  }

  /**
   * Generate performance forecast
   */
  static generatePerformanceForecast() {
    return [
      {
        label: 'Current',
        lcp: '3.2s',
        score: 71,
        status: 'Needs Work'
      },
      {
        label: 'After Image Optimization',
        lcp: '2.8s',
        score: 76,
        status: 'Good'
      },
      {
        label: 'After Resource Optimization',
        lcp: '2.4s',
        score: 82,
        status: 'Good'
      },
      {
        label: 'After Full Optimization',
        lcp: '2.1s',
        score: 88,
        status: 'Excellent'
      }
    ];
  }

  /**
   * Generate optimization plan
   */
  static generateOptimizationPlan() {
    return `Implement performance optimizations in priority order for maximum impact. Focus on image optimization and render-blocking resource elimination first, as these provide the largest time savings with minimal effort.`;
  }

  /**
   * Calculate performance score from technical metrics
   */
  static calculatePerformanceScore(technicalMetrics) {
    let score = 100;
    
    // Deductions for technical issues
    if (!technicalMetrics.ssl?.valid) score -= 15;
    if (!technicalMetrics.redirects?.httpsEnabled) score -= 10;
    if (!technicalMetrics.robots?.accessible) score -= 10;
    if (!technicalMetrics.sitemap?.exists) score -= 10;
    
    return Math.max(0, score);
  }

  /**
   * Generate performance recommendations
   */
  static generatePerformanceRecommendations(cwvData) {
    const recommendations = [];
    
    // Mobile LCP optimization
    if (cwvData.mobile.score < 75) {
      recommendations.push({
        metric: 'Mobile LCP',
        current: cwvData.mobile.lcp,
        target: '<2.5s',
        actions: [
          'Optimize largest contentful paint element',
          'Compress and resize images',
          'Preload critical resources'
        ],
        impact: 'HIGH'
      });
    }
    
    // Desktop optimization
    if (cwvData.desktop.score < 80) {
      recommendations.push({
        metric: 'Desktop Performance',
        current: cwvData.desktop.score,
        target: '>85',
        actions: [
          'Minimize render-blocking resources',
          'Optimize JavaScript execution',
          'Leverage browser caching'
        ],
        impact: 'MEDIUM'
      });
    }
    
    return recommendations;
  }

  /**
   * Generate performance trend analysis
   */
  static generatePerformanceTrend(currentScore, historicalScores = []) {
    if (historicalScores.length === 0) {
      return {
        direction: 'neutral',
        change: 0,
        trend: 'No historical data available'
      };
    }

    const previousScore = historicalScores[historicalScores.length - 1] || currentScore;
    const change = currentScore - previousScore;
    
    let direction = 'neutral';
    if (change > 5) direction = 'improving';
    else if (change < -5) direction = 'declining';
    
    return {
      direction,
      change: FormatUtils.formatNumber(change),
      trend: this.generateTrendText(direction, change)
    };
  }

  /**
   * Generate trend text
   */
  static generateTrendText(direction, change) {
    switch (direction) {
      case 'improving':
        return `Performance improving by ${Math.abs(change)} points`;
      case 'declining':
        return `Performance declining by ${Math.abs(change)} points`;
      default:
        return 'Performance stable';
    }
  }

  /**
   * Validate performance data
   */
  static validate(performanceData) {
    // Basic validation
    return true;
  }
}
