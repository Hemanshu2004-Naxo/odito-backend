/**
 * Response Utility - Standard API Responses
 * Eliminates response format duplication across all services
 */
export class ResponseUtil {
  
  /**
   * Create success response
   * @param {*} data - Response data
   * @param {string} message - Success message
   * @param {Object} meta - Additional metadata (pagination, etc.)
   * @returns {Object} Standardized success response
   */
  static success(data = null, message = 'Success', meta = null) {
    const response = {
      success: true,
      message: message
    };

    if (data !== null) {
      response.data = data;
    }

    if (meta) {
      response.meta = meta;
    }

    return response;
  }

  /**
   * Create error response
   * @param {string} message - Error message
   * @param {number} statusCode - HTTP status code
   * @param {Object} details - Additional error details
   * @returns {Object} Standardized error response
   */
  static error(message, statusCode = 500, details = null) {
    const response = {
      success: false,
      message: message
    };

    if (details) {
      response.details = details;
    }

    return response;
  }

  /**
   * Create paginated response
   * @param {Array} data - Response data array
   * @param {Object} pagination - Pagination info
   * @param {string} message - Success message
   * @returns {Object} Paginated response
   */
  static paginated(data, pagination, message = 'Data retrieved successfully') {
    return {
      success: true,
      message: message,
      data: data,
      pagination: {
        page: pagination.page || 1,
        limit: pagination.limit || 10,
        total: pagination.total || 0,
        pages: pagination.pages || 1,
        hasNext: pagination.hasNext || false,
        hasPrev: pagination.hasPrev || false
      }
    };
  }

  /**
   * Create created response (for POST operations)
   * @param {*} data - Created resource data
   * @param {string} message - Creation message
   * @returns {Object} Creation response
   */
  static created(data, message = 'Resource created successfully') {
    return {
      success: true,
      message: message,
      data: data
    };
  }

  /**
   * Create updated response (for PUT/PATCH operations)
   * @param {*} data - Updated resource data
   * @param {string} message - Update message
   * @returns {Object} Update response
   */
  static updated(data, message = 'Resource updated successfully') {
    return {
      success: true,
      message: message,
      data: data
    };
  }

  /**
   * Create deleted response (for DELETE operations)
   * @param {string} message - Deletion message
   * @returns {Object} Deletion response
   */
  static deleted(message = 'Resource deleted successfully') {
    return {
      success: true,
      message: message
    };
  }

  /**
   * Create no content response (for operations with no data return)
   * @param {string} message - Success message
   * @returns {Object} No content response
   */
  static noContent(message = 'Operation completed successfully') {
    return {
      success: true,
      message: message
    };
  }

  /**
   * Create validation error response
   * @param {Array|Object} errors - Validation errors
   * @param {string} message - Error message
   * @returns {Object} Validation error response
   */
  static validationError(errors, message = 'Validation failed') {
    return {
      success: false,
      message: message,
      errors: errors
    };
  }

  /**
   * Create not found response
   * @param {string} message - Not found message
   * @returns {Object} Not found response
   */
  static notFound(message = 'Resource not found') {
    return {
      success: false,
      message: message
    };
  }

  /**
   * Create access denied response
   * @param {string} message - Access denied message
   * @returns {Object} Access denied response
   */
  static accessDenied(message = 'Access denied') {
    return {
      success: false,
      message: message
    };
  }

  /**
   * Create conflict response
   * @param {string} message - Conflict message
   * @returns {Object} Conflict response
   */
  static conflict(message = 'Resource conflict') {
    return {
      success: false,
      message: message
    };
  }

  /**
   * Create service unavailable response
   * @param {string} message - Unavailable message
   * @returns {Object} Service unavailable response
   */
  static unavailable(message = 'Service temporarily unavailable') {
    return {
      success: false,
      message: message
    };
  }
}
