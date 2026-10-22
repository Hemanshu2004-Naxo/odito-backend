/**
 * Score Calculation Utilities
 * Reusable scoring logic for all PDF sections
 */

export class ScoreUtils {
  
  /**
   * Calculate overall score using weighted components
   * @param {Object} scores - Individual component scores
   * @returns {number} Overall score (0-100)
   */
  static calculateOverallScore(scores = {}) {
    const {
      seoHealth = 0,
      aiVisibility = 0, 
      performance = 0,
      authority = 0
    } = scores;

    // Weighted formula: SEO (25%), AI (30%), Performance (25%), Authority (20%)
    const weighted = (
      seoHealth * 0.25 +
      aiVisibility * 0.30 +
      performance * 0.25 +
      authority * 0.20
    );

    return Math.round(Math.min(100, Math.max(0, weighted)));
  }

  /**
   * Calculate health score based on multiple factors
   * @param {Object} factors - Health factors with weights
   * @returns {number} Health score (0-100)
   */
  static calculateHealthScore(factors = {}) {
    let totalScore = 0;
    let totalWeight = 0;

    Object.entries(factors).forEach(([factor, { value, weight }]) => {
      totalScore += (value / 100) * weight;
      totalWeight += weight;
    });

    return totalWeight > 0 ? Math.round((totalScore / totalWeight) * 100) : 0;
  }

  /**
   * Normalize score to 0-100 range
   * @param {number} value - Raw score value
   * @param {number} min - Minimum possible value
   * @param {number} max - Maximum possible value
   * @returns {number} Normalized score (0-100)
   */
  static normalizeScore(value, min = 0, max = 100) {
    if (value == null || isNaN(value)) return 0;
    
    const normalized = ((value - min) / (max - min)) * 100;
    return Math.round(Math.min(100, Math.max(0, normalized)));
  }

  /**
   * Calculate percentage score
   * @param {number} value - Current value
   * @param {number} total - Total value
   * @returns {number} Percentage (0-100)
   */
  static calculatePercentage(value, total) {
    if (!total || total === 0) return 0;
    if (value == null || isNaN(value)) return 0;
    
    return Math.round((value / total) * 100);
  }

  /**
   * Calculate trend (positive/negative/neutral)
   * @param {number} current - Current value
   * @param {number} previous - Previous value
   * @returns {Object} Trend information
   */
  static calculateTrend(current, previous) {
    if (current == null || previous == null || previous === 0) {
      return {
        direction: 'neutral',
        change: 0,
        percentage: 0
      };
    }

    const change = current - previous;
    const percentage = Math.round((change / Math.abs(previous)) * 100);
    
    let direction = 'neutral';
    if (change > 0) direction = 'positive';
    else if (change < 0) direction = 'negative';

    return {
      direction,
      change,
      percentage
    };
  }

  /**
   * Calculate score distribution across ranges
   * @param {Array} scores - Array of score values
   * @param {Array} ranges - Score ranges [{min, max, label}]
   * @returns {Object} Distribution counts
   */
  static calculateDistribution(scores, ranges) {
    const distribution = {};
    
    ranges.forEach(range => {
      distribution[range.label] = scores.filter(score => 
        score >= range.min && score <= range.max
      ).length;
    });

    return distribution;
  }

  /**
   * Safe score extraction with fallback
   * @param {Object} obj - Object containing score
   * @param {string} path - Dot notation path to score
   * @param {number} fallback - Default value if not found
   * @returns {number} Score value
   */
  static safeExtractScore(obj, path, fallback = 0) {
    try {
      const value = path.split('.').reduce((current, key) => current?.[key], obj);
      return this.safeNumber(value, fallback);
    } catch {
      return fallback;
    }
  }

  /**
   * Ensure number is safe for calculations
   * @param {*} value - Value to check
   * @param {number} fallback - Default value
   * @returns {number} Safe number
   */
  static safeNumber(value, fallback = 0) {
    if (value == null || isNaN(value) || !isFinite(value)) {
      return fallback;
    }
    return Number(value);
  }
}
