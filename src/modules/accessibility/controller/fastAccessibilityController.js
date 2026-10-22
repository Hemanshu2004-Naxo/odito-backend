import { validationResult } from 'express-validator';
import FastAccessibilityService from '../../../services/fastAccessibilityService.js';

const accessibilityService = new FastAccessibilityService();

/**
 * Fast Accessibility Audit Controller
 * Handles POST /api/accessibility/fast-audit
 * No authentication required (public endpoint)
 */
export const fastAccessibilityAuditController = async (req, res) => {
  try {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array(),
      });
    }

    const { url } = req.body;

    console.log('[FAST_A11Y_CTRL] Processing audit request for:', url);

    // Run audit
    const result = await accessibilityService.runAudit(url);

    // Return appropriate status code
    if (!result.success) {
      const statusCode = getErrorStatusCode(result.error);
      return res.status(statusCode).json(result);
    }

    res.status(200).json(result);

  } catch (error) {
    console.error('[FAST_A11Y_CTRL] Unhandled error:', error);
    res.status(500).json({
      success: false,
      error: 'server_error',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error',
    });
  }
};

/**
 * Map error codes to HTTP status codes
 */
function getErrorStatusCode(errorCode) {
  const statusMap = {
    invalid_domain: 400,
    connection_refused: 502,
    timeout: 408,
    audit_failed: 500,
    server_error: 500,
  };
  return statusMap[errorCode] || 500;
}
