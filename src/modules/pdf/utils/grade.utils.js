/**
 * Grade Mapping Utilities
 * Converts numeric scores to letter grades and status indicators
 */

export class GradeUtils {
  
  /**
   * Grade mapping configuration
   */
  static GRADE_MAP = {
    'A+': { min: 97, max: 100, status: 'Excellent', color: '#10B981' },
    'A': { min: 93, max: 96.99, status: 'Excellent', color: '#10B981' },
    'A-': { min: 90, max: 92.99, status: 'Very Good', color: '#10B981' },
    'B+': { min: 87, max: 89.99, status: 'Good', color: '#10B981' },
    'B': { min: 83, max: 86.99, status: 'Good', color: '#F59E0B' },
    'B-': { min: 80, max: 82.99, status: 'Good', color: '#F59E0B' },
    'C+': { min: 77, max: 79.99, status: 'Fair', color: '#F59E0B' },
    'C': { min: 73, max: 76.99, status: 'Fair', color: '#F59E0B' },
    'C-': { min: 70, max: 72.99, status: 'Fair', color: '#F97316' },
    'D+': { min: 67, max: 69.99, status: 'Poor', color: '#F97316' },
    'D': { min: 63, max: 66.99, status: 'Poor', color: '#F97316' },
    'D-': { min: 60, max: 62.99, status: 'Poor', color: '#EF4444' },
    'F': { min: 0, max: 59.99, status: 'Very Poor', color: '#EF4444' }
  };

  /**
   * Simplified grade mapping for quick lookups
   */
  static SIMPLE_GRADE_MAP = {
    'A+': { min: 90, max: 100, status: 'Excellent', color: '#10B981' },
    'A': { min: 85, max: 89.99, status: 'Very Good', color: '#10B981' },
    'B+': { min: 80, max: 84.99, status: 'Good', color: '#10B981' },
    'B': { min: 75, max: 79.99, status: 'Good', color: '#F59E0B' },
    'C+': { min: 70, max: 74.99, status: 'Fair', color: '#F59E0B' },
    'C': { min: 65, max: 69.99, status: 'Fair', color: '#F97316' },
    'D+': { min: 60, max: 64.99, status: 'Poor', color: '#F97316' },
    'D': { min: 50, max: 59.99, status: 'Poor', color: '#EF4444' },
    'F': { min: 0, max: 49.99, status: 'Very Poor', color: '#EF4444' }
  };

  /**
   * Get grade from numeric score
   * @param {number} score - Numeric score (0-100)
   * @param {boolean} detailed - Use detailed grading (default: false)
   * @returns {Object} Grade information
   */
  static getGrade(score, detailed = false) {
    const safeScore = this.safeNumber(score, 0);
    const gradeMap = detailed ? this.GRADE_MAP : this.SIMPLE_GRADE_MAP;

    for (const [grade, config] of Object.entries(gradeMap)) {
      if (safeScore >= config.min && safeScore <= config.max) {
        return {
          grade,
          status: config.status,
          color: config.color,
          score: safeScore
        };
      }
    }

    // Fallback to F if no match found
    return {
      grade: 'F',
      status: 'Very Poor',
      color: '#EF4444',
      score: safeScore
    };
  }

  /**
   * Get simple grade (A, B, C, D, F)
   * @param {number} score - Numeric score (0-100)
   * @returns {string} Simple grade
   */
  static getSimpleGrade(score) {
    const safeScore = this.safeNumber(score, 0);
    
    if (safeScore >= 90) return 'A';
    if (safeScore >= 80) return 'B';
    if (safeScore >= 70) return 'C';
    if (safeScore >= 60) return 'D';
    return 'F';
  }

  /**
   * Get status from score
   * @param {number} score - Numeric score (0-100)
   * @returns {string} Status text
   */
  static getStatus(score) {
    const grade = this.getGrade(score);
    return grade.status;
  }

  /**
   * Get color for score visualization
   * @param {number} score - Numeric score (0-100)
   * @returns {string} Hex color code
   */
  static getColor(score) {
    const grade = this.getGrade(score);
    return grade.color;
  }

  /**
   * Get performance rating
   * @param {number} score - Numeric score (0-100)
   * @returns {string} Performance rating
   */
  static getPerformanceRating(score) {
    const safeScore = this.safeNumber(score, 0);
    
    if (safeScore >= 90) return 'Excellent';
    if (safeScore >= 80) return 'Very Good';
    if (safeScore >= 70) return 'Good';
    if (safeScore >= 60) return 'Fair';
    if (safeScore >= 50) return 'Poor';
    return 'Very Poor';
  }

  /**
   * Get grade reference table
   * @param {boolean} detailed - Use detailed grading
   * @returns {Array} Grade reference data
   */
  static getGradeReference(detailed = false) {
    const gradeMap = detailed ? this.GRADE_MAP : this.SIMPLE_GRADE_MAP;
    
    return Object.entries(gradeMap)
      .map(([grade, config]) => ({
        range: `${config.min}-${config.max}`,
        grade,
        status: config.status,
        color: config.color,
        meaning: this.getGradeMeaning(grade)
      }))
      .reverse(); // Highest grades first
  }

  /**
   * Get descriptive meaning for grade
   * @param {string} grade - Grade letter
   * @returns {string} Descriptive meaning
   */
  static getGradeMeaning(grade) {
    const meanings = {
      'A+': 'Top percentile — elite signals across all categories',
      'A': 'Excellent — minor improvements reach elite tier',
      'A-': 'Very Good — strong performance with small gaps',
      'B+': 'Good — solid base, focused fixes move needle',
      'B': 'Good — above average with room for growth',
      'B-': 'Good — decent performance, needs optimization',
      'C+': 'Fair — prioritized action plan recommended',
      'C': 'Fair — structured improvement plan needed',
      'C-': 'Fair — below average, requires attention',
      'D+': 'Poor — significant issues across multiple dimensions',
      'D': 'Poor — major improvements needed',
      'D-': 'Poor — critical issues require immediate action',
      'F': 'Very Poor — complete overhaul recommended'
    };

    return meanings[grade] || 'Performance not adequately measured';
  }

  /**
   * Compare two scores and return comparison result
   * @param {number} current - Current score
   * @param {number} previous - Previous score
   * @returns {Object} Comparison result
   */
  static compareScores(current, previous) {
    const currentGrade = this.getGrade(current);
    const previousGrade = this.getGrade(previous);
    
    const gradeOrder = ['F', 'D', 'C', 'B', 'A'];
    const currentIndex = gradeOrder.indexOf(currentGrade.grade[0]);
    const previousIndex = gradeOrder.indexOf(previousGrade.grade[0]);

    let trend = 'unchanged';
    if (currentIndex > previousIndex) trend = 'improved';
    else if (currentIndex < previousIndex) trend = 'declined';

    return {
      current: currentGrade,
      previous: previousGrade,
      trend,
      change: current - previous
    };
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
