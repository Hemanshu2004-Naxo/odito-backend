/**
 * Score-Only Response Service
 * Enforces strict score-only data structure for all API responses
 * Blocks any script or narration content from being returned
 */

export class ScoreOnlyResponseService {
  /**
   * Validate that response contains only structured data (no scripts)
   * @param {Object} data - Response data to validate
   * @throws {Error} If script/narration content is found
   */
  static validateScoreOnlyResponse(data) {
    const forbiddenFields = [
      'script',
      'narration', 
      'generatedText',
      'aiScript',
      'text',
      'content',
      'description'
    ];

    const checkObject = (obj, path = '') => {
      if (!obj || typeof obj !== 'object') return;

      for (const [key, value] of Object.entries(obj)) {
        const currentPath = path ? `${path}.${key}` : key;
        
        // Check if this is a forbidden field
        if (forbiddenFields.includes(key.toLowerCase())) {
          throw new Error(
            `🚨 FORBIDDEN CONTENT DETECTED: Field "${currentPath}" contains script/narration content. ` +
            `Only structured scores, metrics, and issues are allowed.`
          );
        }

        // Recursively check nested objects
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          checkObject(value, currentPath);
        }

        // Check arrays for forbidden content
        if (Array.isArray(value)) {
          value.forEach((item, index) => {
            if (item && typeof item === 'object') {
              checkObject(item, `${currentPath}[${index}]`);
            }
          });
        }
      }
    };

    checkObject(data);
  }

  /**
   * Create a standardized score-only response
   * @param {string} page - Page identifier
   * @param {Object} scores - Score data
   * @param {Array} issues - Issues array
   * @param {Object} metrics - Additional metrics
   * @returns {Object} Sanitized response object
   */
  static createScoreOnlyResponse(page, scores, issues = [], metrics = {}) {
    const response = {
      page,
      scores: this.normalizeScores(scores),
      issues: this.normalizeIssues(issues),
      metrics: this.normalizeMetrics(metrics),
      timestamp: new Date().toISOString()
    };

    // Validate the response before returning
    this.validateScoreOnlyResponse(response);
    
    return response;
  }

  /**
   * Normalize scores to ensure consistent structure
   * @param {Object} scores - Raw scores
   * @returns {Object} Normalized scores
   */
  static normalizeScores(scores) {
    return {
      overall: Math.round(Number(scores.overall || scores.seo || 0)),
      performance: Math.round(Number(scores.performance || 0)),
      seo: Math.round(Number(scores.seo || scores.seoHealth || 0)),
      aiVisibility: Math.round(Number(scores.aiVisibility || 0)),
      accessibility: Math.round(Number(scores.accessibility || 0)),
      // Add any additional scores, ensuring they're numbers
      ...Object.fromEntries(
        Object.entries(scores || {})
          .filter(([key, value]) => !['overall', 'performance', 'seo', 'aiVisibility', 'accessibility'].includes(key))
          .map(([key, value]) => [key, Math.round(Number(value) || 0)])
      )
    };
  }

  /**
   * Normalize issues to ensure consistent structure
   * @param {Array} issues - Raw issues
   * @returns {Array} Normalized issues
   */
  static normalizeIssues(issues) {
    if (!Array.isArray(issues)) return [];

    return issues.map(issue => ({
      title: issue.title || issue.issue || issue.name || 'Unknown issue',
      severity: issue.severity || issue.priority || 'medium',
      category: issue.category || 'general',
      impact: issue.impact || 'medium',
      // Remove any description/text content
      ...(issue.url && { url: issue.url }),
      ...(issue.ruleId && { ruleId: issue.ruleId })
    }));
  }

  /**
   * Normalize metrics to ensure consistent structure
   * @param {Object} metrics - Raw metrics
   * @returns {Object} Normalized metrics
   */
  static normalizeMetrics(metrics) {
    const normalized = {};
    
    for (const [key, value] of Object.entries(metrics || {})) {
      // Skip any text-based metrics
      if (typeof value === 'string' && value.length > 100) continue;
      
      normalized[key] = value;
    }

    return normalized;
  }

  /**
   * Middleware function to validate API responses
   * @param {Object} req - Express request
   * @param {Object} res - Express response  
   * @param {Function} next - Express next function
   */
  static scoreOnlyMiddleware(req, res, next) {
    const originalJson = res.json;

    res.json = function(data) {
      try {
        // Validate response before sending
        ScoreOnlyResponseService.validateScoreOnlyResponse(data);
        
        // If validation passes, send original response
        return originalJson.call(this, data);
      } catch (error) {
        console.error('🚨 SCORE-ONLY VALIDATION FAILED:', error.message);
        
        // Override with error response
        return originalJson.call(this, {
          success: false,
          error: 'Response validation failed',
          message: error.message,
          timestamp: new Date().toISOString()
        });
      }
    };

    next();
  }
}

export default ScoreOnlyResponseService;
