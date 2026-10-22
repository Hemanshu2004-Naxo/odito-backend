/**
 * Percentage Calculation Utilities
 * Handles all percentage calculations and distributions
 */

import { ScoreUtils } from './score.utils.js';
import { FormatUtils } from './format.utils.js';

export class PercentageUtils {
  
  /**
   * Calculate percentage with safe division
   * @param {number} value - Current value
   * @param {number} total - Total value
   * @param {number} decimals - Decimal places
   * @returns {number} Percentage (0-100)
   */
  static calculatePercentage(value, total, decimals = 0) {
    if (!total || total === 0) return 0;
    if (value == null || isNaN(value)) return 0;
    
    const percentage = (value / total) * 100;
    return FormatUtils.formatNumber(percentage, decimals);
  }

  /**
   * Calculate percentage change between two values
   * @param {number} current - Current value
   * @param {number} previous - Previous value
   * @param {number} decimals - Decimal places
   * @returns {number} Percentage change
   */
  static calculatePercentageChange(current, previous, decimals = 0) {
    if (previous == null || previous === 0) return 0;
    if (current == null) return 0;
    
    const change = ((current - previous) / Math.abs(previous)) * 100;
    return FormatUtils.formatNumber(change, decimals);
  }

  /**
   * Calculate percentage distribution across categories
   * @param {Object} counts - Object with category counts
   * @param {number} decimals - Decimal places
   * @returns {Object} Percentage distribution
   */
  static calculateDistribution(counts, decimals = 0) {
    const total = Object.values(counts).reduce((sum, count) => sum + ScoreUtils.safeNumber(count), 0);
    
    if (total === 0) {
      // Return zero percentages for all categories
      return Object.keys(counts).reduce((acc, key) => {
        acc[key] = 0;
        return acc;
      }, {});
    }
    
    const distribution = {};
    Object.entries(counts).forEach(([category, count]) => {
      distribution[category] = this.calculatePercentage(count, total, decimals);
    });
    
    return distribution;
  }

  /**
   * Calculate percentage breakdown for issues by severity
   * @param {Object} issues - Issue counts by severity
   * @returns {Object} Percentage breakdown
   */
  static calculateIssueBreakdown(issues) {
    const safeIssues = {
      critical: ScoreUtils.safeNumber(issues?.critical),
      high: ScoreUtils.safeNumber(issues?.high),
      medium: ScoreUtils.safeNumber(issues?.medium),
      low: ScoreUtils.safeNumber(issues?.low),
      info: ScoreUtils.safeNumber(issues?.info),
      warning: ScoreUtils.safeNumber(issues?.warning),
      informational: ScoreUtils.safeNumber(issues?.informational)
    };

    const total = Object.values(safeIssues).reduce((sum, count) => sum + count, 0);
    
    if (total === 0) {
      return {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        info: 0,
        warning: 0,
        informational: 0,
        total: 0
      };
    }

    return {
      critical: this.calculatePercentage(safeIssues.critical, total),
      high: this.calculatePercentage(safeIssues.high, total),
      medium: this.calculatePercentage(safeIssues.medium, total),
      low: this.calculatePercentage(safeIssues.low, total),
      info: this.calculatePercentage(safeIssues.info, total),
      warning: this.calculatePercentage(safeIssues.warning, total),
      informational: this.calculatePercentage(safeIssues.informational, total),
      total: 100
    };
  }

  /**
   * Calculate page coverage percentage
   * @param {number} covered - Number of covered pages
   * @param {number} total - Total pages
   * @returns {number} Coverage percentage
   */
  static calculateCoverage(covered, total) {
    return this.calculatePercentage(covered, total, 1);
  }

  /**
   * Calculate index rate percentage
   * @param {number} indexed - Number of indexed pages
   * @param {number} crawled - Number of crawled pages
   * @returns {number} Index rate percentage
   */
  static calculateIndexRate(indexed, crawled) {
    return this.calculatePercentage(indexed, crawled, 1);
  }

  /**
   * Calculate success rate
   * @param {number} successful - Number of successful items
   * @param {number} total - Total items
   * @returns {number} Success rate percentage
   */
  static calculateSuccessRate(successful, total) {
    return this.calculatePercentage(successful, total, 1);
  }

  /**
   * Calculate failure rate
   * @param {number} failed - Number of failed items
   * @param {number} total - Total items
   * @returns {number} Failure rate percentage
   */
  static calculateFailureRate(failed, total) {
    return this.calculatePercentage(failed, total, 1);
  }

  /**
   * Calculate gap percentage to target
   * @param {number} current - Current value
   * @param {number} target - Target value
   * @returns {number} Gap percentage
   */
  static calculateGapToTarget(current, target) {
    if (target == null || target === 0) return 0;
    
    const gap = Math.max(0, target - current);
    return this.calculatePercentage(gap, target, 1);
  }

  /**
   * Calculate completion percentage
   * @param {number} completed - Number of completed items
   * @param {number} total - Total items
   * @returns {number} Completion percentage
   */
  static calculateCompletion(completed, total) {
    return this.calculatePercentage(completed, total, 1);
  }

  /**
   * Calculate percentage for score ranges
   * @param {Array} scores - Array of scores
   * @param {Object} ranges - Score ranges configuration
   * @returns {Object} Percentage distribution across ranges
   */
  static calculateScoreRangeDistribution(scores, ranges) {
    const total = scores.length;
    if (total === 0) {
      return Object.keys(ranges).reduce((acc, key) => {
        acc[key] = 0;
        return acc;
      }, {});
    }

    const distribution = {};
    Object.entries(ranges).forEach(([rangeName, { min, max }]) => {
      const count = scores.filter(score => score >= min && score <= max).length;
      distribution[rangeName] = this.calculatePercentage(count, total, 1);
    });

    return distribution;
  }

  /**
   * Calculate weighted percentage
   * @param {Object} values - Values with weights
   * @returns {number} Weighted percentage
   */
  static calculateWeightedPercentage(values) {
    let totalWeight = 0;
    let weightedSum = 0;

    Object.entries(values).forEach(([value, weight]) => {
      const numValue = ScoreUtils.safeNumber(value);
      const numWeight = ScoreUtils.safeNumber(weight);
      
      weightedSum += numValue * numWeight;
      totalWeight += numWeight;
    });

    return totalWeight > 0 ? FormatUtils.formatNumber(weightedSum / totalWeight, 1) : 0;
  }

  /**
   * Calculate percentile rank
   * @param {number} value - Value to find percentile for
   * @param {Array} values - Array of values to compare against
   * @returns {number} Percentile rank (0-100)
   */
  static calculatePercentile(value, values) {
    if (!values || values.length === 0) return 0;
    
    const sorted = [...values].sort((a, b) => a - b);
    const index = sorted.findIndex(v => v >= value);
    
    if (index === -1) return 100;
    if (index === 0) return 0;
    
    return this.calculatePercentage(index, values.length, 1);
  }

  /**
   * Calculate percentage of items meeting threshold
   * @param {Array} values - Array of values
   * @param {number} threshold - Threshold value
   * @param {string} operator - Comparison operator ('>=', '<=', '>', '<')
   * @returns {number} Percentage meeting threshold
   */
  static calculateThresholdPercentage(values, threshold, operator = '>=') {
    if (!values || values.length === 0) return 0;
    
    const meeting = values.filter(value => {
      const numValue = ScoreUtils.safeNumber(value);
      switch (operator) {
        case '>=': return numValue >= threshold;
        case '<=': return numValue <= threshold;
        case '>': return numValue > threshold;
        case '<': return numValue < threshold;
        default: return numValue >= threshold;
      }
    }).length;
    
    return this.calculatePercentage(meeting, values.length, 1);
  }

  /**
   * Format percentage for display
   * @param {number} value - Percentage value
   * @param {boolean} showSymbol - Include % symbol
   * @param {number} decimals - Decimal places
   * @returns {string} Formatted percentage
   */
  static formatPercentage(value, showSymbol = true, decimals = 0) {
    const formatted = FormatUtils.formatNumber(value, decimals);
    return showSymbol ? `${formatted}%` : formatted;
  }

  /**
   * Get percentage color based on value
   * @param {number} percentage - Percentage value (0-100)
   * @returns {string} Color code
   */
  static getPercentageColor(percentage) {
    const safePercentage = ScoreUtils.safeNumber(percentage, 0);
    
    if (safePercentage >= 80) return '#10B981'; // Green
    if (safePercentage >= 60) return '#F59E0B'; // Yellow
    if (safePercentage >= 40) return '#F97316'; // Orange
    return '#EF4444'; // Red
  }

  /**
   * Get percentage status text
   * @param {number} percentage - Percentage value (0-100)
   * @returns {string} Status text
   */
  static getPercentageStatus(percentage) {
    const safePercentage = ScoreUtils.safeNumber(percentage, 0);
    
    if (safePercentage >= 90) return 'Excellent';
    if (safePercentage >= 80) return 'Very Good';
    if (safePercentage >= 70) return 'Good';
    if (safePercentage >= 60) return 'Fair';
    if (safePercentage >= 40) return 'Poor';
    return 'Very Poor';
  }
}
